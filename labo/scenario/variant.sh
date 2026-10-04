#!/bin/zsh
# Compacte une copie de la session témoin puis mesure le rappel de chaque code, sans outils.
# usage : variant.sh <nom> <session de base> <manual|auto|none> <jev:on|off>
set -euo pipefail
name="$1"; base="$2"; mode="$3"; jev="$4"
CC="$HOME/Library/Application Support/Claude/claude-code/2.1.286/f2326db61802/claude.app/Contents/MacOS/claude"
PROBE="$HOME/Documents/fast-jev-compaction/labo/probe"
LABO="$HOME/Documents/labo-compaction"; out="$LABO/runs/$name"; mkdir -p "$out"; cd "$LABO"
[[ -d .probe ]] && { echo ".probe existe déjà"; exit 1; }
settings='{"enabledPlugins":{"fast-jev-compaction@fast-jev-compaction":'$([[ $jev == on ]] && echo true || echo false)'}}'
envs=(CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1)
extra=(); [[ -n "${JEVDIR:-}" ]] && extra=(--plugin-dir "$JEVDIR") && envs+=(TYPESAFE_API_KEY="$TYPESAFE_API_KEY")
[[ $mode == auto ]] && envs+=(CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000)
sid="$base"
if [[ $mode != none ]]; then
  prompt=$([[ $mode == manual ]] && echo "/compact" || echo "Réponds seulement « fait ».")
  start=$(date +%s)
  env $envs "$CC" -p --resume "$base" --fork-session --plugin-dir "$PROBE" $extra --settings "$settings" \
     --max-budget-usd 60 --output-format json "$prompt" < /dev/null > "$out/compact.json" 2> "$out/compact.err" || true
  echo $(( $(date +%s) - start )) > "$out/compact_seconds"
  sid=$(python3 -c "import json;print(json.load(open('$out/compact.json'))['session_id'])")
fi
echo "$sid" > "$out/session_id"
q="Sans utiliser d'outil : pour chaque code de CANARI-01 à CANARI-19, donne la valeur exacte si elle figure dans notre conversation ou dans ton contexte, sinon écris « inconnu ». Ne devine pas. Une ligne par code, au format « CANARI-xx : valeur »."
env CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 "$CC" -p --resume "$sid" --fork-session --plugin-dir "$PROBE" $extra --settings "$settings" \
   --disallowedTools "Bash,Read,Write,Edit,Grep,Glob,Agent,Skill,WebFetch,WebSearch,NotebookEdit" --max-budget-usd 60 --output-format json "$q" < /dev/null > "$out/recall.json" 2> "$out/recall.err" || true
mv .probe "$out/probe" 2>/dev/null || true
python3 - "$out" <<'PY'
import json,sys,re
o=sys.argv[1]; r=json.load(open(o+'/recall.json'))
exp={'01':'albatros','02':'bernache','04':'fou de bassan','05':'macareux','06':'sterne','07':'tadorne','08':'bécasseau','09':'pélican','10':'mouette','12':'goéland','13':'cormoran','14':'harle','15':'héron','16':'flamant','17':'grèbe','18':'avocette','19':'harle huppé'}
txt=r.get('result','')
got={}
for code,val in exp.items():
    m=re.search(rf'CANARI-{code}\s*:\s*(.+)',txt)
    v=(m.group(1).strip().strip('«» ').lower() if m else 'absent')
    got[code]='OK' if val in v and not (code=='14' and 'huppé' in v) else ('inconnu' if 'inconnu' in v else 'FAUX:'+v[:30])
json.dump(got,open(o+'/recall_score.json','w'),ensure_ascii=False,indent=1)
import glob
tc=[json.load(open(f)) for f in sorted(glob.glob(o+'/probe/*turn.complete.json'))]
ctx=tc[-1]['usage'].get('tokens') if tc else None
print(o.split('/')[-1], 'ctx rappel', ctx, 'turns', r.get('num_turns'), ' '.join(f"{k}={v}" for k,v in got.items()))
PY
