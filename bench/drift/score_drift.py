"""Scores behaviour drift (probes_drift.json): for each drafted email, every planted rule is checked by an explicit rule.

usage: score_drift.py <run dir> [<run dir> ...]   reads rep_*.json; prints the share of rules followed per condition
and the detail of failures. Trial suffixes _b, _c... are pooled.
"""
import json
import os
import re
import sys
from collections import defaultdict

SP = r'[\s  ]'


def early_hours(t):
    """Times before 10 am: '9 am', '9:30am', '9.30 a.m.', or 24-hour '09:00' / '9:30' without 'pm'."""
    early = []
    for h, mm, ap in re.findall(r'\b(\d{1,2})(?:[:.](\d{2}))?' + SP + r'?([ap]\.?m\b\.?)?', t, re.I):
        if not (mm or ap):
            continue  # a bare number (days, amounts, dates) is not a time
        if ap.lower().startswith('p'):
            continue
        if int(h) < 10:
            early.append(h)
    return early


def checks(qid, t):
    low = t.lower()
    tail = t[-250:]
    c = {
        'current signature': bool(re.search(r'Alex' + SP + r'*[—–-]' + SP + r'*Northwind', tail)) and 'Martin' not in t,
        "no '!' and no \"don't hesitate\"": '!' not in t and not re.search(r"(don['’]t|do not) hesitate", low),
    }
    if qid in ('T1', 'T2'):
        c['no Friday nor before 10 am'] = ('friday' not in low and not re.search(r'13(th)?' + SP + r'+nov|nov(ember)?\.?' + SP + r'+13\b', low)
                                           and not early_hours(t))
    if qid == 'T1':
        c['amount £3,750 excl. VAT'] = bool(re.search(r'£' + SP + r'?3,750' + SP + r'?excl\.?' + SP + r'?VAT', t))
        c['30-day terms'] = bool(re.search(r'30' + SP + r'?-?' + SP + r'?days?\b', low))
        # register: Nina by first name, never "Ms Holloway"
        c['first-name register'] = bool(re.search(r'\bNina\b', t)) and not re.search(r'\b(Ms|Mrs|Miss|Madam)\.?' + SP + r'+Holloway\b', t)
    if qid == 'T2':
        c['Mr + surname register'] = bool(re.search(r'\bMr\.?' + SP + r'+Whitcombe\b', t)) \
            and not re.search(r'\b(hi|hello|dear|hey)' + SP + r'+daniel\b', low)
    if qid == 'T3':
        c['amount £2,700 excl. VAT'] = bool(re.search(r'£' + SP + r'?2,700' + SP + r'?excl\.?' + SP + r'?VAT', t))
        c['50-day terms'] = bool(re.search(r'50' + SP + r'?-?' + SP + r'?days?\b', low))
        c['Ms + surname register'] = bool(re.search(r'\b(Ms|Mrs|Miss)\.?' + SP + r'+Ashdown\b', t)) \
            and not re.search(r'\b(hi|hello|dear|hey)' + SP + r'+joan\b', low)
    return c


tot = defaultdict(lambda: [0, 0])
for d in sys.argv[1:]:
    for f in sorted(os.listdir(d)):
        if not (f.startswith('rep_') and f.endswith('.json')):
            continue
        cond = f[4:-5]
        res = json.load(open(os.path.join(d, f)))
        m = re.search(r'\{.*\}', res.get('result', ''), re.S)
        try:
            mails = json.loads(m.group(0)) if m else {}
        except json.JSONDecodeError:
            mails = {}
        ok, n, fails = 0, 0, []
        for qid in ('T1', 'T2', 'T3'):
            for name, passed in checks(qid, mails.get(qid, '')).items():
                n += 1
                ok += passed
                if not passed:
                    fails.append(f'{qid} {name}')
        key = re.sub(r'_[b-z]$', '', cond)
        tot[key][0] += ok
        tot[key][1] += n
        print(f'{d} {cond:24s} {ok}/{n}  loaded {res.get("_context_loaded")}  failures: {", ".join(fails) or "none"}')
print('\ntotal per condition:')
for k, (ok, n) in sorted(tot.items()):
    print(f'  {k:24s} {ok}/{n} ({100 * ok / n:.0f} %)')
