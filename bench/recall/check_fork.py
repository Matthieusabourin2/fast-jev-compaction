"""Compares what the Jev answering session loaded with the segment the plugin really kept.

For sessions whose cut point is a compaction made by the plugin itself (prepare.py --plugin-copy, answers_jev.json).
usage: check_fork.py <run dir>
Lines before the question in the fork = loaded context. They are compared (by uuid) with the segment rewritten after
the boundary.
"""
import glob
import json
import os
import sys
from collections import Counter

d = sys.argv[1]
m = json.load(open(os.path.join(d, "meta.json")))
src = [json.loads(l) for l in open(m["file"]) if l.strip()]
bi, end = m["bi"], m.get("end")
if end is None:
    bt = src[bi]["timestamp"]
    end = next(j for j in range(bi + 1, len(src)) if src[j].get("timestamp", "0") >= bt or src[j].get("subtype") == "compact_boundary")
seg = {x["uuid"] for x in src[bi + 1:end] if x.get("uuid") and x.get("type") in ("user", "assistant", "attachment")}
pre = {x["uuid"] for x in src[:bi] if x.get("uuid")}
sid = json.load(open(os.path.join(d, "answers_jev.json")))["session_id"]
f = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{sid}.jsonl"))[0]
fork = [json.loads(l) for l in open(f) if l.strip()]
qi = next(i for i, x in enumerate(fork) if x.get("type") == "user" and "Memory test" in str(x.get("message", {}).get("content")))
loaded = [x for x in fork[:qi] if x.get("uuid") and x.get("type") in ("user", "assistant", "attachment")]
ids = {x["uuid"] for x in loaded}
segrows = {x["uuid"]: x for x in src[bi + 1:end] if x.get("uuid")}
missing = Counter("+".join(b.get("type") for b in segrows[u].get("message", {}).get("content", []) if isinstance(b, dict))
                  or segrows[u].get("type") for u in seg - ids)
print(os.path.basename(d), "segment", len(seg), "| fork loaded", len(ids), "| in segment", len(ids & seg),
      "| outside segment (before boundary)", len(ids - seg & pre), "| unknown", len(ids - seg - pre),
      "| segment missing", len(seg - ids), dict(missing), "| tokens", json.load(open(os.path.join(d, "answers_jev.json"))).get("_context_loaded"))
