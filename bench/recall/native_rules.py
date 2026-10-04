"""Claude Code's native compaction with the product's summary rules, without Jev, on the raw copy of the session at bi.

usage: native_rules.py <run dir> <name>   writes answers_<name>.json (questions asked after the compaction)
Rules: those of src/v2.ts by default (labo/rules plugin); set RULES_FILE=<absolute path> to use another rule file,
e.g. labo/rules-variants/combine.txt. Cost cap: --max-budget-usd 15 for the compaction, 15 for the questions.
"""
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common.bench import NOJEV, REPO  # noqa: E402

d = os.path.abspath(sys.argv[1]); name = sys.argv[2]
here = os.path.dirname(os.path.abspath(__file__))
J = str(REPO)
m = json.load(open(os.path.join(d, 'meta.json')))
proj = os.path.dirname(m['file'])
created = open(os.path.join(d, 'created_sessions.txt'), 'a')
sid = str(uuid.uuid4()); path = os.path.join(proj, sid + '.jsonl')
lines = [l for l in open(m['file'], encoding='utf-8') if l.strip()][:m['bi']]
open(path, 'w', encoding='utf-8').writelines(lines)
created.write(path + '\n'); created.flush()  # recorded at once: an aborted run must not leave an unlisted copy
out = subprocess.run(['claude', '-p', '--resume', sid, '--fork-session', '--plugin-dir', os.path.join(J, 'labo/rules'),
                      '--settings', json.dumps({'enabledPlugins': NOJEV}),
                      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--model', m['model'],
                      '--max-budget-usd', '15', '--output-format', 'json', '/compact'],
                     cwd=m['cwd'], env=dict(os.environ, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS='1'),
                     stdin=subprocess.DEVNULL, capture_output=True, text=True)
os.remove(path)
try:
    res = json.loads(out.stdout)
except json.JSONDecodeError:
    sys.exit(f'claude failed ({out.returncode}): {out.stdout[-400:]} {out.stderr[-800:]}')
copy = res['session_id']
created.write(os.path.join(proj, copy + '.jsonl') + '\n'); created.flush()
rows = [json.loads(l) for l in open(os.path.join(proj, copy + '.jsonl'), encoding='utf-8') if l.strip()]
s = [r for r in rows if r.get('isCompactSummary')]
c = s[-1]['message']['content'] if s else ''
t = c if isinstance(c, str) else ''.join(b.get('text', '') for b in c if isinstance(b, dict))
print(f'{name}: summary {len(t)} characters')
if not t:
    sys.exit('no summary: stopping')
open(os.path.join(d, f'{name}_copy_id'), 'w').write(copy)
subprocess.run(['bash', os.path.join(here, 'ask.sh'), copy, m['cwd'], os.path.join(d, 'questions.json'),
                os.path.join(d, f'answers_{name}.json'), m['model']], check=False)
