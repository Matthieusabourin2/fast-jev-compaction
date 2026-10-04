"""Prépare l'entrée de multipass.ts : messages du segment d'une vraie session, avec le contexte d'origine avant chacun.

usage : multipass_input.py <transcript.jsonl> <bi> <sortie.json> [PASS] [CEIL]
Même conversion que to_session_messages.py (une ligne de transcript = un message), du dernier compact_boundary avant bi
jusqu'à bi exclu.
"""
import json, sys

src, bi, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
PASS = int(sys.argv[4]) if len(sys.argv) > 4 else 300000
CEIL = int(sys.argv[5]) if len(sys.argv) > 5 else 210000
rows = [json.loads(l) for l in open(src, encoding="utf-8") if l.strip()][:bi]
s0 = max([i for i, d in enumerate(rows) if d.get("subtype") == "compact_boundary"] or [-1]) + 1

def ctx(d):
    u = (d.get("message") or {}).get("usage") if d.get("type") == "assistant" else None
    return u and u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)

# partie fixe (système, outils, mémoire) : le premier appel de la session, pas celui qui suit une compaction
# précédente, qui porte aussi ce que cette compaction a gardé
over = next(ctx(r) for r in rows if ctx(r))
post = next(ctx(rows[i]) for i in range(s0, bi) if ctx(rows[i]))
octx, last = [], 0
for i, d in enumerate(rows):
    if i == s0:
        last = post  # après une compaction précédente, le contexte repart de sa taille réelle
    last = ctx(d) or last
    octx.append(last)

def rtext(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    return ""

seg = rows[s0:]
results = {}
for d in seg:
    if d.get("type") == "user" and isinstance(d.get("message", {}).get("content"), list):
        for b in d["message"]["content"]:
            if isinstance(b, dict) and b.get("type") == "tool_result":
                results[b.get("tool_use_id")] = (rtext(b.get("content")), bool(b.get("is_error")))
msgs, octx_prev, is_prompt = [], [], []
for k, d in enumerate(seg):
    i = s0 + k
    t = d.get("type")
    if t not in ("user", "assistant") or d.get("isSidechain") or d.get("isMeta") or d.get("isCompactSummary"):
        continue
    c = (d.get("message") or {}).get("content")
    if t == "assistant":
        cur = {"role": "assistant", "text": "", "toolUses": []}
        for b in c if isinstance(c, list) else []:
            if b.get("type") == "text":
                cur["text"] = (cur["text"] + "\n" + b.get("text", "")).strip("\n") if cur["text"] else b.get("text", "")
            elif b.get("type") == "tool_use":
                txt, err = results.get(b.get("id"), ("", False))
                u = {"tool_use_id": b.get("id"), "tool": b.get("name"), "input": b.get("input", {}), "text": txt}
                if err:
                    u["isError"] = True
                cur["toolUses"].append(u)
        msg, prompt = cur, False
    else:
        tr = [b for b in c if isinstance(b, dict) and b.get("type") == "tool_result"] if isinstance(c, list) else []
        msg = {"role": "user", "text": rtext(c), "toolUses": []}
        if tr:
            msg["toolResults"] = [{"tool_use_id": b.get("tool_use_id"), "text": rtext(b.get("content")), "isError": bool(b.get("is_error"))} for b in tr]
        if not msg["text"] and not tr:
            continue
        prompt = bool(msg["text"].strip()) and not tr
    msgs.append(msg)
    octx_prev.append(octx[i - 1] if i > 0 else 0)
    is_prompt.append(prompt)
json.dump({"msgs": msgs, "octxPrev": octx_prev, "isPrompt": is_prompt, "over": over, "pass": PASS, "ceil": CEIL,
           "octxEnd": octx[bi - 1], "s0": s0}, open(out, "w"), ensure_ascii=False)
print(len(msgs), "messages ; préfixe", over, "; contexte d'origine en fin de segment", octx[bi - 1])
