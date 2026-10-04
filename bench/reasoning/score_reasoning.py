"""Scores the reasoning test (probes_reasoning.json): the expected value must appear at the head of the answer
(before the " - " / " — " / ": " that starts the justification). R00 (integrity) is checked by reading it.

usage: score_reasoning.py <run dir> [<run dir> ...]   reads rep_*.json; trial suffixes _b, _c... are pooled
"""
import json
import os
import re
import sys
from collections import defaultdict

SP = r'[\s,  ]?'  # thousands separator: comma, space, no-break space, or none
EXPECTED = {'R01': r'5' + SP + '940', 'R02': r'2' + SP + '400',
            'R03': r'£\s?0(\.00)?\b|\b0(\.00)?\s?(£|GBP|pounds?)\b|^\W*(nothing|none|zero)\b', 'R04': r'4' + SP + '653',
            'R05': r'Nina', 'R06': r'4' + SP + '800', 'R07': r'3' + SP + '600', 'R08': r'Marden', 'R09': r'4' + SP + '150',
            'R10': r'31(st)?\s+(of\s+)?Dec|Dec(ember)?\.?\s+31', 'R11': r'480', 'R12': r'21' + SP + '493'}
tot = defaultdict(lambda: [0, 0])
for d in sys.argv[1:]:
    for f in sorted(os.listdir(d)):
        if not (f.startswith('rep_') and f.endswith('.json')):
            continue
        cond = f[4:-5]
        m = re.search(r'\{.*\}', json.load(open(os.path.join(d, f))).get('result', ''), re.S)
        a = json.loads(m.group(0)) if m else {}
        ok, fails = 0, []
        for q, pat in EXPECTED.items():
            head = re.split(r'\s[—–-]\s|:\s|\s—', a.get(q, ''), maxsplit=1)[0]
            good = bool(re.search(pat, head, re.I)) and not head.lower().replace('’', "'").startswith("i don't know")
            if q == 'R08':
                good = good and not re.search(r'Marlow|Marston|Marley|Marbury|Marbleton|\bnone\b', head, re.I)
            ok += good
            if not good:
                fails.append(q)
        key = re.sub(r'_[b-z]$', '', cond)
        tot[key][0] += ok
        tot[key][1] += len(EXPECTED)
        print(f'{d} {cond:26s} {ok}/{len(EXPECTED)}  failed: {" ".join(fails) or "none"}')
print('\ntotal per condition:')
for k, (ok, n) in sorted(tot.items()):
    print(f'  {k:26s} {ok}/{n} ({100 * ok / n:.0f} %)')
