#!/usr/bin/env bash
# Asks the question bank to one variant: no tools, no MCP, no hooks, fast-jev-compaction plugin disabled.
# usage: ask.sh <session_id | none> <cwd> <questions.json> <output.json> <model>
# Cost cap: --max-budget-usd 15 for this single call.
set -euo pipefail
sid="$1"; cwd="$2"; qfile="$3"; out="$4"; model="$5"
here="$(cd "$(dirname "$0")" && pwd)"
qfile="$(cd "$(dirname "$qfile")" && pwd)/$(basename "$qfile")"
out="$(cd "$(dirname "$out")" && pwd)/$(basename "$out")"
prompt="$(python3 "$here/ask_prompt.py" "$qfile")"
settings="$(python3 "$here/../common/bench.py" quiet)"
resume=()
[[ "$sid" != none ]] && resume=(--resume "$sid" --fork-session)
cd "$cwd"
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=0 claude -p ${resume[@]+"${resume[@]}"} \
  --settings "$settings" \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools "" \
  --model "$model" --max-budget-usd 15 --output-format json "$prompt" < /dev/null > "$out"
python3 "$here/ask_usage.py" "$out"
