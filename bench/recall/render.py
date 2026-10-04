"""Renders the pre-compaction state of a session as readable text, for the question generator.

usage: render.py <transcript.jsonl> <cut index> <output.md>
Each block is prefixed with a marker [Lnnn TYPE]. Tool results are cut at 2,500 characters.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common.bench import load  # noqa: E402

src, bi, dst = sys.argv[1], int(sys.argv[2]), sys.argv[3]
rows = load(src)
prev = max((j for j in range(bi) if rows[j].get("subtype") == "compact_boundary"), default=-1)
out = []
for i in range(prev + 1, bi):
    d = rows[i]
    if d.get("isSidechain"):
        continue
    t = d.get("type")
    if t == "attachment":
        a = d.get("attachment", {})
        if a.get("type") == "queued_command":
            p = a.get("prompt")
            p = p if isinstance(p, str) else json.dumps(p, ensure_ascii=False)
            kind = "NOTIFICATION" if p.lstrip().startswith("<task-notification") else "USER-QUEUED"
            out.append(f"[L{i} {kind}] {p[:4000]}")
        continue
    if t not in ("user", "assistant"):
        continue
    c = d["message"].get("content")
    if isinstance(c, str):
        if not d.get("isMeta"):
            out.append(f"[L{i} {t.upper()}] {c}")
        continue
    for b in c or []:
        bt = b.get("type")
        if bt == "text" and not d.get("isMeta"):
            out.append(f"[L{i} {t.upper()}] {b['text']}")
        elif bt == "tool_use":
            out.append(f"[L{i} TOOL-CALL {b.get('name')}] {json.dumps(b.get('input'), ensure_ascii=False)[:800]}")
        elif bt == "tool_result":
            rc = b.get("content")
            txt = "".join(x.get("text", "") for x in rc if x.get("type") == "text") if isinstance(rc, list) else str(rc or "")
            cut = f" […{len(txt) - 2500} chars cut]" if len(txt) > 2500 else ""
            out.append(f"[L{i} TOOL-RESULT] {txt[:2500]}{cut}")
open(dst, "w", encoding="utf-8").write("\n\n".join(out))
print(len(out), "blocks,", sum(map(len, out)), "characters")
