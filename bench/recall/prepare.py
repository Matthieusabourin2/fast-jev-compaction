"""Prepares one session for the recall benchmark: readable pre-compaction state, meta.json, classic native compaction.

usage: prepare.py <transcript.jsonl> <run dir> [--cut last|INDEX|TIMESTAMP] [--model M] [--meta-only] [--plugin-copy]
       prepare.py --list <transcript.jsonl>      lists the compaction boundaries of a transcript (candidate cut points)

The cut point (bi) is a row index in the transcript (non-empty lines). By default it is the last compact_boundary
row, i.e. the moment the session was really compacted: everything before it is the state to be compacted.
Writes <run dir>/before.md, meta.json and, unless --meta-only, compact_result.json (classic /compact on a copy).
--plugin-copy: the boundary was a compaction made by the fast-jev-compaction plugin itself; also writes a resumable copy
of the segment the plugin kept (jev_copy_id), to be checked with check_fork.py / relink.py.
"""
import argparse
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common.bench import load  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

ap = argparse.ArgumentParser()
ap.add_argument('transcript')
ap.add_argument('out', nargs='?')
ap.add_argument('--cut', default='last', help='last (default), a row index, or the timestamp prefix of a compact_boundary')
ap.add_argument('--model', default='claude-opus-5[1m]')
ap.add_argument('--meta-only', action='store_true', help='only before.md and meta.json, no Claude call')
ap.add_argument('--plugin-copy', action='store_true')
ap.add_argument('--list', action='store_true')
a = ap.parse_args()

src = os.path.abspath(os.path.expanduser(a.transcript))
rows = load(src)
bounds = [i for i, d in enumerate(rows) if d.get('subtype') == 'compact_boundary']
if a.list:
    for i in bounds:
        md = rows[i].get('compactMetadata', {})
        print(i, rows[i].get('timestamp'), md.get('trigger'), 'preTokens', md.get('preTokens'))
    print(len(rows), 'rows')
    sys.exit(0)
if not a.out:
    sys.exit('run dir missing')
if a.cut == 'last':
    if not bounds:
        sys.exit('no compact_boundary in this transcript: pass --cut <row index>')
    bi = bounds[-1]
elif a.cut.isdigit():
    bi = int(a.cut)
else:
    bi = next((i for i in bounds if rows[i].get('timestamp', '').startswith(a.cut)), None)
    if bi is None:
        sys.exit(f'no compact_boundary with timestamp {a.cut}')

out = os.path.abspath(a.out)
os.makedirs(out, exist_ok=True)
cwd = next(d['cwd'] for d in rows if d.get('cwd'))
bt = rows[bi].get('timestamp', '')
end = next((j for j in range(bi + 1, len(rows))
            if rows[j].get('timestamp', '0') >= bt or rows[j].get('subtype') == 'compact_boundary'), len(rows))
meta = {'label': os.path.basename(out), 'file': src, 'bi': bi, 'end': end, 'cwd': cwd, 'model': a.model, 'timestamp': bt}
subprocess.run(['python3', os.path.join(HERE, 'render.py'), src, str(bi), os.path.join(out, 'before.md')],
               check=True, cwd=HERE)
if a.plugin_copy and not os.path.exists(os.path.join(out, 'jev_copy_id')):
    lines = [l for l in open(src, encoding='utf-8') if l.strip()]
    new = str(uuid.uuid4())
    dst = os.path.join(os.path.dirname(src), new + '.jsonl')
    open(dst, 'w', encoding='utf-8').writelines(lines[:end])
    open(os.path.join(out, 'jev_copy_id'), 'w').write(new)
    open(os.path.join(out, 'created_sessions.txt'), 'a').write(dst + '\n')
json.dump(meta, open(os.path.join(out, 'meta.json'), 'w'), indent=1)
if not a.meta_only and not os.path.exists(os.path.join(out, 'compact_result.json')):
    subprocess.run(['bash', os.path.join(HERE, 'fork_native.sh'), src, str(bi), cwd, a.model, out], check=True)
print(meta['label'], 'ready, cut at row', bi, flush=True)
