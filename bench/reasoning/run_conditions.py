"""Reasoning test: the fictitious probe thread is asked to Claude at several context sizes, with and without Jev.

Conditions (a run dir = meta.json, plus aug.jsonl / cuts.json and, for raw_50, aug_50.jsonl / cuts_50.json, from
insert_probes.py):
  raw_N                    real copy of the session cut at N k tokens (thinking included), compaction disabled
  jev_N                    the same content cleaned by the plugin logic (Jev passes, no summary), injected in a copy
  summary_classic_600      Claude Code's native compaction, no plugin and no rules: the reference
  summary_native_600       Claude Code's native compaction with the product's summary rules, on raw_600
  summary_jev_600          last Jev clean, then a Claude summary with the same rules, on the content of jev_600
Each condition: one single call, all questions in one prompt, no tools. Answers in rep_<condition><suffix>.json.
usage: run_conditions.py <run dir> [comma-separated conditions] [--probes FILE] [--suffix _b]
Needs TYPESAFE_API_KEY for jev_N and summary_jev_N. RULES_FILE=<absolute path> swaps the summary rules.
Caps: --max-budget-usd 40 per call; at most BENCH_MAX_CALLS Claude calls per run (default: 2 per condition).
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
ap.add_argument('conditions', nargs='?')
ap.add_argument('--probes', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'probes_reasoning.json'))
ap.add_argument('--suffix', default='', help='repeated-trial suffix: rep_<condition><suffix>.json (e.g. _b, _c)')
args = ap.parse_args()

d = os.path.abspath(args.run_dir)
J = str(REPO)
m = json.load(open(os.path.join(d, 'meta.json')))
proj = os.path.dirname(m['file'])
probes = json.load(open(args.probes, encoding='utf-8'))
created = open(os.path.join(d, 'created_sessions.txt'), 'a')
costs = open(os.path.join(d, 'costs.tsv'), 'a')
PROMPT = ((probes.get('intro') or "Reasoning test. Do not use any tool and do not look anything up: answer only with "
           "what you know of our conversation so far. For each question, give the answer and, in one sentence, the "
           "facts and the calculation that justify it. If the information is missing, answer exactly \"I don't know\". "
           "Do not guess.")
          + '\n\n' + '\n'.join(f"{q['id']}: {q['question']}" for q in probes['questions'])
          + '\n\nReply only with a JSON object {' + ', '.join(f'"{q["id"]}": "..."' for q in probes['questions'][:2])
          + ', ...}, with no other text.')

wanted = args.conditions.split(',') if args.conditions else \
    ['raw_50', 'raw_300', 'jev_300', 'raw_600', 'jev_600', 'summary_native_600', 'summary_jev_600', 'raw_900', 'jev_900']
MAX_CALLS = max_calls(2 * len(wanted))
calls = 0


def cuts_of(suffix=''):
    return json.load(open(os.path.join(d, f'cuts{suffix}.json')))['cuts']


def copy_rows(src, n):
    sid = str(uuid.uuid4())
    path = os.path.join(proj, sid + '.jsonl')
    lines = [l for l in open(src, encoding='utf-8') if l.strip()][:n]
    open(path, 'w', encoding='utf-8').writelines(lines)
    created.write(path + '\n')  # recorded at once: an aborted run must not leave an unlisted copy
    created.flush()
    return sid, path


def claude(label, args, prompt, env_extra, budget='40'):
    global calls
    calls += 1
    if calls > MAX_CALLS:
        sys.exit(f'more than {MAX_CALLS} Claude calls: stopping the bench (raise BENCH_MAX_CALLS if intended)')
    env = dict(os.environ, **env_extra)
    out = subprocess.run(['claude', '-p', *args, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
                          '--model', m['model'], '--max-budget-usd', budget, '--output-format', 'json', prompt],
                         cwd=m['cwd'], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True)
    try:
        res = json.loads(out.stdout)
    except json.JSONDecodeError:
        sys.exit(f'{label}: claude failed ({out.returncode}): {out.stdout[-300:]} {out.stderr[-600:]}')
    created.write(os.path.join(proj, res['session_id'] + '.jsonl') + '\n')
    created.flush()
    u = res.get('usage', {})
    costs.write(f"{label}\t{sum(u.get(k, 0) * p for k, p in PRICE.items()) / 1e6:.2f}\t{json.dumps({k: u.get(k, 0) for k in PRICE})}\n")
    costs.flush()
    return res


def ask(label, sid):
    res = claude(f'question {label}', ['--resume', sid, '--fork-session', '--settings', json.dumps(QUIET), '--tools', ''],
                 PROMPT, {'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS': '0', 'DISABLE_AUTO_COMPACT': '1'})
    u = res['usage']
    res['_context_loaded'] = u['input_tokens'] + u.get('cache_read_input_tokens', 0) + u.get('cache_creation_input_tokens', 0)
    json.dump(res, open(os.path.join(d, f'rep_{label}.json'), 'w'), ensure_ascii=False)
    print(f"{label}: context loaded {res['_context_loaded']}", flush=True)


def compact(label, src, n, plugin, env_extra):
    """Compacts a copy (src lines 0..n) with a labo plugin; returns the id of the compacted copy."""
    sid, path = copy_rows(src, n)
    res = claude(label, ['--resume', sid, '--fork-session', '--plugin-dir', os.path.join(J, plugin),
                         '--settings', json.dumps({'enabledPlugins': NOJEV})], '/compact',
                 dict(env_extra, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS='1'))
    os.remove(path)
    return res['session_id']


def jev_state(n):
    """Jev passes of the plugin logic on aug[:n], no summary; writes jev_<n>.json and jev_<n>_final.json."""
    inp, out = os.path.join(d, f'mpin_{n}.json'), os.path.join(d, f'jev_{n}.json')
    if not os.path.exists(out):
        if not os.environ.get('TYPESAFE_API_KEY'):
            sys.exit('TYPESAFE_API_KEY is not set')
        subprocess.run(['python3', os.path.join(J, 'labo/offline/multipass_input.py'), os.path.join(d, 'aug.jsonl'), str(n), inp], check=True)
        p = subprocess.run(['npx', 'tsx', 'labo/offline/multipass.ts', inp, out], cwd=J, capture_output=True, text=True,
                           env=dict(os.environ, MP_OPTIONS=json.dumps({'summarizeAtPercent': 100, 'hardCapPercent': 100})))
        open(os.path.join(d, f'jev_{n}_log.txt'), 'w').write(p.stdout + p.stderr)
        if p.returncode != 0:
            sys.exit(f'multipass {n} failed: {p.stderr[-400:]}')
        print(p.stdout.strip().splitlines()[-1], flush=True)
    return out


aug = os.path.join(d, 'aug.jsonl')
for base in wanted:
    c = base + args.suffix
    if os.path.exists(os.path.join(d, f'rep_{c}.json')):
        continue
    kind, size = base.rsplit('_', 1)
    if kind == 'raw':
        src, n = (os.path.join(d, 'aug_50.jsonl'), cuts_of('_50')['50']['rows']) if size == '50' else (aug, cuts_of()[size]['rows'])
        sid, path = copy_rows(src, n)
        ask(c, sid)
        os.remove(path)
    elif kind == 'jev':
        n = cuts_of()[size]['rows']
        ask(c, compact(f'injection {c}', aug, n, 'labo/inject', {'INJECT_FILE': jev_state(n)}))
    elif kind == 'summary_classic':
        # Claude Code's native compaction without plugin or rules: the reference
        sid, path = copy_rows(aug, cuts_of()[size]['rows'])
        res = claude(f'summary {c}', ['--resume', sid, '--fork-session', '--settings', json.dumps(QUIET)], '/compact',
                     {'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS': '0'})
        os.remove(path)
        ask(c, res['session_id'])
    elif kind == 'summary_native':
        ask(c, compact(f'summary {c}', aug, cuts_of()[size]['rows'], 'labo/rules', {}))
    elif kind == 'summary_jev':
        n = cuts_of()[size]['rows']
        jev_state(n)
        ask(c, compact(f'summary {c}', aug, n, 'labo/inject', {'INJECT_FILE': os.path.join(d, f'jev_{n}_final.json')}))
    else:
        sys.exit(f'unknown condition {base}')
