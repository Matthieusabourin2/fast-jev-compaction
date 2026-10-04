"""Inserts the fictitious probe thread into a copy of a real session and finds the cut points.

Each exchange becomes one user line and one assistant line, chained (parentUuid) just before a real user request, at
the first turn whose measured context (usage of the previous call) reaches the wanted position. Cuts fall just before
a user request, at the first turn whose context reaches the target. The original transcript is never modified.

usage: insert_probes.py <run dir> <positions k, one per exchange, e.g. 40,60,80,100,120,140,160,180>
                        <targets k, e.g. 300,600,900> [suffix] [--probes FILE]
writes <run dir>/aug<suffix>.jsonl and <run dir>/cuts<suffix>.json ({target: {"rows": n, "octx": measured context}})
--probes defaults to probes_reasoning.json next to this script (drift: ../drift/probes_drift.json).
"""
import argparse
import copy
import json
import os
import sys
import uuid

ap = argparse.ArgumentParser()
ap.add_argument('run_dir')
ap.add_argument('positions')
ap.add_argument('targets')
ap.add_argument('suffix', nargs='?', default='')
ap.add_argument('--probes', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'probes_reasoning.json'))
a = ap.parse_args()

d = os.path.abspath(a.run_dir)
suffix = a.suffix
positions = [int(x) * 1000 for x in a.positions.split(',')]
targets = [int(x) * 1000 for x in a.targets.split(',')]
m = json.load(open(os.path.join(d, 'meta.json')))
probes = json.load(open(a.probes, encoding='utf-8'))
if len(positions) < len(probes['exchanges']):
    sys.exit(f"{len(probes['exchanges'])} exchanges in the probe file: give as many positions")
rows = [json.loads(l) for l in open(m['file'], encoding='utf-8') if l.strip()][:m['bi']]
s0 = max([i for i, r in enumerate(rows) if r.get('subtype') == 'compact_boundary'] or [-1]) + 1


def ctx(r):
    u = (r.get('message') or {}).get('usage') if r.get('type') == 'assistant' else None
    return u and u.get('input_tokens', 0) + u.get('cache_read_input_tokens', 0) + u.get('cache_creation_input_tokens', 0)


def prompt(r):
    if r.get('type') != 'user' or r.get('isSidechain') or r.get('isMeta') or r.get('isCompactSummary') or not r.get('uuid'):
        return False
    c = (r.get('message') or {}).get('content')
    if isinstance(c, str):
        return bool(c.strip()) and not c.lstrip().startswith('<')
    return isinstance(c, list) and any(isinstance(b, dict) and b.get('type') == 'text' and b.get('text', '').strip()
                                        and not b['text'].lstrip().startswith('<') for b in c) \
        and not any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in c)


# measured context before each line (last assistant call of the segment)
before, last = [], 0
for i, r in enumerate(rows):
    before.append(last if i >= s0 else 0)
    last = ctx(r) or last
template = next(r for r in reversed(rows) if r.get('type') == 'assistant' and r.get('uuid'))

out, inserted, todo = [], [], list(zip(positions, probes['exchanges']))
for i, r in enumerate(rows):
    if todo and i > s0 and prompt(r) and before[i] >= todo[0][0]:
        _, ex = todo.pop(0)
        u_id, a_id = str(uuid.uuid4()), str(uuid.uuid4())
        u = {k: v for k, v in r.items() if k in ('isSidechain', 'userType', 'cwd', 'sessionId', 'version', 'gitBranch', 'entrypoint')}
        u.update({'type': 'user', 'uuid': u_id, 'parentUuid': r.get('parentUuid'), 'timestamp': r.get('timestamp'),
                  'message': {'role': 'user', 'content': ex['user']}})
        a_row = {k: v for k, v in template.items() if k in ('isSidechain', 'userType', 'cwd', 'sessionId', 'version', 'gitBranch', 'entrypoint')}
        msg = copy.deepcopy(template['message'])
        msg.update({'id': 'msg_probe_' + a_id[:8], 'content': [{'type': 'text', 'text': ex['assistant']}], 'stop_reason': 'end_turn'})
        prev_usage = next((rows[j]['message']['usage'] for j in range(i - 1, s0 - 1, -1) if ctx(rows[j])), msg.get('usage'))
        msg['usage'] = copy.deepcopy(prev_usage)
        a_row.update({'type': 'assistant', 'uuid': a_id, 'parentUuid': u_id, 'timestamp': r.get('timestamp'), 'message': msg,
                      'requestId': 'req_probe_' + a_id[:8]})
        out += [u, a_row]
        r = dict(r, parentUuid=a_id)
        inserted.append({'row': i, 'octx': before[i]})
    out.append(r)
if todo:
    sys.exit(f'{len(todo)} exchange(s) not inserted: segment too short')

# cuts: just before a real request, at the first turn whose context reaches the target
before_out, last = [], 0
for r in out:
    before_out.append(last)
    last = ctx(r) or last
seg_start = next(i for i, r in enumerate(out) if r is rows[s0] or r.get('uuid') == rows[s0].get('uuid'))
cuts = {}
for c in targets:
    k = next((i for i in range(seg_start + 1, len(out)) if prompt(out[i]) and before_out[i] >= c and not out[i].get('uuid', '').startswith('x')
              and i > max(x['row'] for x in inserted) + 2 * len(inserted)), None)
    if k is None:
        sys.exit(f'target {c} out of reach (max context {max(before_out)})')
    last = next(out[j] for j in range(k - 1, 0, -1) if prompt(out[j]))
    lc = last['message']['content']
    lt = lc if isinstance(lc, str) else ' '.join(b.get('text', '') for b in lc if isinstance(b, dict) and b.get('type') == 'text')
    cuts[str(c // 1000)] = {'rows': k, 'octx': before_out[k], 'last_prompt': lt[:300]}
with open(os.path.join(d, f'aug{suffix}.jsonl'), 'w', encoding='utf-8') as f:
    for r in out:
        f.write(json.dumps(r, ensure_ascii=False) + '\n')
json.dump({'inserted': inserted, 'cuts': cuts, 's0': s0}, open(os.path.join(d, f'cuts{suffix}.json'), 'w'), indent=1)
print('inserted:', inserted)
print('cuts:', {k: {kk: vv for kk, vv in v.items() if kk != 'last_prompt'} for k, v in cuts.items()})
