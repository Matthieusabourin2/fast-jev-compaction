"""Convertit un transcript Claude Code (.jsonl) en liste SessionMessage, la forme qu'un hook session.compact reçoit.

usage : python3 to_session_messages.py <transcript.jsonl> <sortie.json> [--until-boundary N]
Règles (calibrées sur l'entrée réelle observée par compaction-probe) :
- seules les lignes user/assistant de la conversation principale comptent ; pièces jointes, lignes isMeta,
  notices système et lignes de sous-agent sont exclues (le hook ne les voit pas) ;
- une ligne de transcript = un message (le moteur ne regroupe pas les blocs d'un même message.id) ;
- text = blocs texte joints ; tool_use → toolUses, avec le texte du résultat correspondant ; tool_result → toolResults.
"""
import json, sys

src, out = sys.argv[1], sys.argv[2]
stop = int(sys.argv[sys.argv.index("--until-boundary") + 1]) if "--until-boundary" in sys.argv else None
rows = [json.loads(l) for l in open(src, encoding="utf-8") if l.strip()]
if stop is not None:
    rows = rows[:stop]
# ne garder que ce qui suit la dernière frontière de compaction
last_b = max([i for i, d in enumerate(rows) if d.get("subtype") == "compact_boundary"] or [-1])
rows = rows[last_b + 1:]

def rtext(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    return ""

results = {}
for d in rows:
    if d.get("type") == "user" and isinstance(d.get("message", {}).get("content"), list):
        for b in d["message"]["content"]:
            if isinstance(b, dict) and b.get("type") == "tool_result":
                results[b.get("tool_use_id")] = (rtext(b.get("content")), bool(b.get("is_error")))

msgs, last_mid = [], None
for d in rows:
    t = d.get("type")
    if t not in ("user", "assistant") or d.get("isSidechain") or d.get("isMeta") or d.get("isCompactSummary"):
        continue
    m = d.get("message") or {}
    c = m.get("content")
    if t == "assistant":
        cur = {"role": "assistant", "text": "", "toolUses": []}  # une ligne de transcript = un message
        msgs.append(cur)
        for b in c if isinstance(c, list) else []:
            if b.get("type") == "text":
                cur["text"] = (cur["text"] + "\n" + b.get("text", "")).strip("\n") if cur["text"] else b.get("text", "")
            elif b.get("type") == "tool_use":
                txt, err = results.get(b.get("id"), ("", False))
                u = {"tool_use_id": b.get("id"), "tool": b.get("name"), "input": b.get("input", {}), "text": txt}
                if err:
                    u["isError"] = True
                cur["toolUses"].append(u)
    else:
        last_mid = None
        tr = [b for b in c if isinstance(b, dict) and b.get("type") == "tool_result"] if isinstance(c, list) else []
        msg = {"role": "user", "text": rtext(c), "toolUses": []}
        if tr:
            msg["toolResults"] = [{"tool_use_id": b.get("tool_use_id"), "text": rtext(b.get("content")), "isError": bool(b.get("is_error"))} for b in tr]
        if not msg["text"] and not tr:
            continue
        msgs.append(msg)
json.dump(msgs, open(out, "w"), ensure_ascii=False)
print(len(msgs), "messages", sum(len(m["toolUses"]) for m in msgs), "tool_use")
