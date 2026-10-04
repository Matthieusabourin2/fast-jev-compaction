"""Tokens re-read over the session segment, in three worlds: original (Claude summary at bi), Claude alone at 300k, plugin.

Offline, no Claude call. Reads, in each run dir, the files written by recall/replay.py: mp_input.json, jev_state.json,
jev_state_final.json.
One call = an assistant message that follows a user message; it re-reads the original context before it (octxPrev).
Plugin: after pass k at message p, context = fixed prefix + kept_k x R (real/estimated ratio, measured) + original
growth since p (floored at 0: the original session's drops do not lower the replayed world).
Claude alone at 300k: at every call where the world reaches 300k, a summary (reads the world, writes OUT tokens),
then prefix + B.
Final summary at the original cut point: the original reads its context; the plugin reads the cleaned history
(prefix + input x R).
usage: tokens_reread.py <run dir> [<run dir> ...]   (a bare name is looked up in bench/runs/)
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common.bench import RUNS  # noqa: E402

# R: real/estimated token ratio measured on loaded contexts; B: context right after a native summary (prefix excluded);
# OUT: tokens written by a summary; T: threshold of the "Claude alone" world
R, B, OUT, T = 1.4, 22451, 11000, 300000
tot = {'orig': 0, 'n30': 0, 'plugin': 0}
for s in sys.argv[1:]:
    d = s if os.path.isdir(s) else os.path.join(RUNS, s)
    inp = json.load(open(os.path.join(d, 'mp_input.json')))
    st = json.load(open(os.path.join(d, 'jev_state.json')))
    fin = json.load(open(os.path.join(d, 'jev_state_final.json')))
    msgs, o, over = inp['msgs'], inp['octxPrev'], inp['over']
    calls = [i for i in range(1, len(msgs)) if msgs[i]['role'] == 'assistant' and msgs[i - 1]['role'] == 'user']
    passes = {p['message']: p['keptEstimate'] for p in st['passes'] if 'keptEstimate' in p}
    orig = sum(o[i] for i in calls) + o[-1]
    n30, w0, base, nsum = 0, None, None, 0
    plug, kept, at = 0, None, None
    for i in calls:
        g = lambda a: max(0, o[i] - o[a])
        # Claude alone at 300k
        w = o[i] if w0 is None else base + g(w0)
        if w >= T:
            n30 += w + OUT; nsum += 1; w0, base = i, over + B; w = base
        n30 += w
        # plugin
        if i in passes or any(at is None or p > at for p in passes if p <= i):
            p = max(p for p in passes if p <= i) if any(p <= i for p in passes) else None
            if p is not None and p != at:
                at, kept = p, passes[p]
        plug += o[i] if at is None else over + kept * R + g(at)
    n30 += o[-1] if w0 is None else base + max(0, o[-1] - o[w0])
    plug += over + fin['finalEstimate'] * R
    for k, v in (('orig', orig), ('n30', n30), ('plugin', plug)):
        tot[k] += v
    print(f"{os.path.basename(os.path.normpath(d))}: {len(calls)} calls; original {orig/1e6:.1f} M; Claude at 300k {n30/1e6:.1f} M ({nsum} summaries, {100*(n30/orig-1):+.0f} %); plugin {plug/1e6:.1f} M ({100*(plug/orig-1):+.0f} %); final summary input {o[-1]/1e3:.0f}k -> {(over + fin['finalEstimate']*R)/1e3:.0f}k")
print(f"total: original {tot['orig']/1e6:.0f} M; Claude at 300k {tot['n30']/1e6:.0f} M ({100*(tot['n30']/tot['orig']-1):+.0f} %); plugin {tot['plugin']/1e6:.0f} M ({100*(tot['plugin']/tot['orig']-1):+.0f} %)")
