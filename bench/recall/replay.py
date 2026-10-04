"""Plugin logic (v0.6+) replayed on a real session: Jev passes from 300k, refusals in between, Claude summary at 600k.

Measures, at the original cut point (bi), the information carried over in these states, next to the classic native
summary (answers_native.json, from prepare.py + ask.sh):
  jev_passes   after the Jev passes, no summary (what Claude has in context just before 600k) -> answers_jev_passes.json
  jev_summary  last Jev clean, then a real Claude summary of the cleaned history (forced at bi) -> answers_jev_summary.json
  full         full context, compaction refused (the "before" reference), with --full           -> answers_full.json

usage: replay.py <run dir> [--full] [--only-final NAME]
  --only-final NAME   redo only the "last clean + Claude summary" step on the existing jev_state_final.json and write
                      answers_NAME.json (repeated trials, other summary rules via RULES_FILE=<absolute path>)
Needs TYPESAFE_API_KEY in the environment (Jev passes) and `npm i` at the repo root (tsx).
Caps: --max-budget-usd per call, at most BENCH_MAX_CALLS Claude calls per run (default 8), costs logged in costs.tsv.
"""
import argparse
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common.bench import NOJEV, PRICE, QUIET, REPO, max_calls  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument('run_dir')
ap.add_argument('--full', action='store_true')
ap.add_argument('--only-final', metavar='NAME')
args = ap.parse_args()

d = os.path.abspath(args.run_dir)
here = os.path.dirname(os.path.abspath(__file__))
J = str(REPO)
m = json.load(open(os.path.join(d, 'meta.json')))
proj = os.path.dirname(m['file'])
created = open(os.path.join(d, 'created_sessions.txt'), 'a')
costs = open(os.path.join(d, 'costs.tsv'), 'a')
MAX_CALLS = max_calls(8)
calls = 0
if not os.environ.get('TYPESAFE_API_KEY') and not args.only_final:
    sys.exit('TYPESAFE_API_KEY is not set')


def guard():
    global calls
    calls += 1
    if calls > MAX_CALLS:
        sys.exit(f'more than {MAX_CALLS} Claude calls: stopping the bench (raise BENCH_MAX_CALLS if intended)')


def copy_prefix():
    sid = str(uuid.uuid4())
    path = os.path.join(proj, sid + '.jsonl')
    lines = [l for l in open(m['file'], encoding='utf-8') if l.strip()][:m['bi']]
    open(path, 'w', encoding='utf-8').writelines(lines)
    created.write(path + '\n')  # recorded at once: an aborted run must not leave an unlisted copy
    created.flush()
    return sid, path


def claude(label, args, prompt, env_extra=None, budget='8'):
    guard()
    env = dict(os.environ, **(env_extra or {}))
    out = subprocess.run(['claude', '-p', *args, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
                          '--model', m['model'], '--max-budget-usd', budget, '--output-format', 'json', prompt],
                         cwd=m['cwd'], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True)
    try:
        res = json.loads(out.stdout)
    except json.JSONDecodeError:
        sys.exit(f'claude failed ({out.returncode}): {out.stdout[-400:]} {out.stderr[-800:]}')
    created.write(os.path.join(proj, res['session_id'] + '.jsonl') + '\n')
    created.flush()
    u = res.get('usage', {})
    cost = sum(u.get(k, 0) * p for k, p in PRICE.items()) / 1e6
    costs.write(f"{label}\t{cost:.2f}\t{json.dumps({k: u.get(k, 0) for k in PRICE})}\n")
    costs.flush()
    return res


def inject(label, state_file):
    """Compacts a copy of the session with the injection plugin; returns the id of the compacted copy."""
    sid, path = copy_prefix()
    res = claude(label, ['--resume', sid, '--fork-session', '--plugin-dir', os.path.join(J, 'labo/inject'),
                         '--settings', json.dumps({'enabledPlugins': NOJEV})], '/compact',
                 {'INJECT_FILE': state_file, 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS': '1'})
    os.remove(path)
    return res['session_id']


def loaded_of(sid, label):
    chk = claude(label, ['--resume', sid, '--fork-session', '--settings', json.dumps(QUIET),
                         '--tools', ''], 'Reply only "ok".', {'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS': '0'})
    u = chk['usage']
    return u['input_tokens'] + u.get('cache_read_input_tokens', 0) + u.get('cache_creation_input_tokens', 0)


def ask(sid, name):
    guard()
    subprocess.run(['bash', os.path.join(here, 'ask.sh'), sid, m['cwd'], os.path.join(d, 'questions.json'),
                    os.path.join(d, name), m['model']], check=False)
    res = json.load(open(os.path.join(d, name)))
    u = res.get('usage', {})
    costs.write(f"ask {name}\t{sum(u.get(k, 0) * p for k, p in PRICE.items()) / 1e6:.2f}\t{json.dumps({k: u.get(k, 0) for k in PRICE})}\n")
    costs.flush()


if args.only_final:
    # only the "last clean + Claude summary" step is redone, on the input already computed (jev_state_final.json)
    name = args.only_final
    summary_sid = inject(f'Claude summary ({name})', os.path.join(d, 'jev_state_final.json'))
    open(os.path.join(d, f'{name}_copy_id'), 'w').write(summary_sid)
    ask(summary_sid, f'answers_{name}.json')
    sys.exit(0)

inp = os.path.join(d, 'mp_input.json')
state, final = os.path.join(d, 'jev_state.json'), os.path.join(d, 'jev_state_final.json')
subprocess.run(['python3', os.path.join(J, 'labo/offline/multipass_input.py'), m['file'], str(m['bi']), inp], check=True)
p = subprocess.run(['npx', 'tsx', 'labo/offline/multipass.ts', inp, state], cwd=J, capture_output=True, text=True)
open(os.path.join(d, 'jev_log.txt'), 'w').write(p.stdout + p.stderr)
print(p.stdout.strip(), flush=True)
if p.returncode != 0:
    sys.exit(f'multipass failed ({p.returncode}): the summary threshold (600k) should not be reached before bi. {p.stderr[-400:]}')
report = {'passes_state': json.load(open(state)), 'final': json.load(open(final))}
report = {'passes': report['passes_state']['passes'], 'refusals': report['passes_state']['refusals'],
          'worldFinal': report['passes_state']['worldFinal'], 'passesEstimate': report['passes_state']['finalEstimate'],
          'summaryInputEstimate': report['final']['finalEstimate']}

jp = inject('inject jev_passes', state)
report['passesLoaded'] = loaded_of(jp, 'check jev_passes')
print(f"jev_passes: context loaded {report['passesLoaded']} for ~{report['passesEstimate']} estimated", flush=True)
if report['passesLoaded'] < 0.6 * report['passesEstimate']:
    sys.exit('jev_passes injection truncated: stopping')
ask(jp, 'answers_jev_passes.json')

summary_sid = inject('Claude summary after last clean', final)
rows = [json.loads(l) for l in open(os.path.join(proj, summary_sid + '.jsonl'), encoding='utf-8') if l.strip()]
summary = [r for r in rows if r.get('isCompactSummary')]
c = summary[-1]['message']['content'] if summary else ''
report['summaryChars'] = len(c if isinstance(c, str) else ''.join(b.get('text', '') for b in c if isinstance(b, dict)))
if not report['summaryChars']:
    sys.exit('empty Claude summary: stopping')
report['summaryLoaded'] = loaded_of(summary_sid, 'check jev_summary')
ask(summary_sid, 'answers_jev_summary.json')

if args.full:
    sid, path = copy_prefix()
    # reference: the automatic compaction is refused (labo/skiptest plugin), the full context stays
    os.makedirs(os.path.join(d, 'skiplog'), exist_ok=True)
    env = {'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS': '1', 'SKIP_LOG': os.path.join(d, 'skiplog')}
    prompt = subprocess.run(['python3', os.path.join(here, 'ask_prompt.py'), os.path.join(d, 'questions.json')],
                            capture_output=True, text=True, check=True).stdout  # same prompt as ask.sh
    res = claude('ask full', ['--resume', sid, '--fork-session', '--plugin-dir', os.path.join(J, 'labo/skiptest'),
                              '--settings', json.dumps({'enabledPlugins': NOJEV}), '--tools', ''],
                 prompt, env, budget='15')
    os.remove(path)
    json.dump(res, open(os.path.join(d, 'answers_full.json'), 'w'), ensure_ascii=False)
    subprocess.run(['python3', os.path.join(here, 'ask_usage.py'), os.path.join(d, 'answers_full.json')], check=False)

json.dump(report, open(os.path.join(d, 'replay.json'), 'w'), indent=1)
print(json.dumps(report), flush=True)
