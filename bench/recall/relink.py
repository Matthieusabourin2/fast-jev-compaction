"""Recreates the Jev copy of a session by relinking the segment the plugin kept, in file order.

Claude Code rewrites the kept messages with their original parentUuid; when the plugin removed an intermediate message,
the chain breaks and a resume only reloads a fragment. Here only parentUuid (and the segment's message ids) change: the
content is identical.
usage: relink.py <run dir>   writes jev_copy_id (the previous one is kept as jev_copy_id.broken)
"""
import json
import os
import sys
import uuid

d = sys.argv[1]
m = json.load(open(os.path.join(d, "meta.json")))
src = m["file"]
lines = [l for l in open(src, encoding="utf-8") if l.strip()]
rows = [json.loads(l) for l in lines]
bi = m["bi"]
bt = rows[bi]["timestamp"]
end = next((j for j in range(bi + 1, len(rows))
            if rows[j].get("timestamp", "0") >= bt or rows[j].get("subtype") == "compact_boundary"), len(rows))
out = lines[:bi + 1]
parent = rows[bi]["uuid"]
# on resume, Claude Code groups the lines of one API message (message.id) across the whole file, which re-injects the
# blocks the plugin removed: the segment gets its own message.id values (same grouping inside the segment)
new_ids = {}
for j in range(bi + 1, end):
    r = rows[j]
    if r.get("uuid") and r.get("type") in ("user", "assistant", "attachment", "system") and not r.get("isSidechain"):
        r = dict(r, parentUuid=parent)
        if r.get("type") == "assistant" and r.get("message", {}).get("id"):
            mid = r["message"]["id"]
            r["message"] = dict(r["message"], id=new_ids.setdefault(mid, mid + "_seg"))
        parent = r["uuid"]
        out.append(json.dumps(r, ensure_ascii=False) + "\n")
    else:
        out.append(lines[j])
new = str(uuid.uuid4())
dst = os.path.join(os.path.dirname(src), new + ".jsonl")
open(dst, "w", encoding="utf-8").writelines(out)
old = os.path.join(d, "jev_copy_id")
if os.path.exists(old) and not os.path.exists(old + ".broken"):
    os.rename(old, old + ".broken")
open(old, "w").write(new)
open(os.path.join(d, "created_sessions.txt"), "a").write(dst + "\n")
m["end"] = end
json.dump(m, open(os.path.join(d, "meta.json"), "w"), indent=1)
print(os.path.basename(d), "relinked copy", new, "segment", end - bi - 1, "lines")
