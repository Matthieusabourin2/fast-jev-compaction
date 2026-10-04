#!/usr/bin/env bash
# Replays a classic NATIVE compaction on a copy of a session stopped just before its cut point.
# usage: fork_native.sh <source transcript> <cut index> <session cwd> <model> <output dir>
# The fast-jev-compaction plugin, function hooks and all hooks are disabled: no TypeSafe call.
# Cost cap: --max-budget-usd 25 for this single call.
set -euo pipefail
src="$1"; bi="$2"; cwd="$3"; model="$4"; out="$5"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
proj="$(dirname "$src")"
new="$(python3 -c 'import uuid; print(uuid.uuid4())')"
# copy of non-empty lines 0..bi-1 (same indexing as common/bench.load)
python3 - "$src" "$bi" "$proj/$new.jsonl" <<'EOF'
import sys
src, bi, dst = sys.argv[1], int(sys.argv[2]), sys.argv[3]
lines = [l for l in open(src, encoding="utf-8") if l.strip()]
open(dst, "w", encoding="utf-8").writelines(lines[:bi])
EOF
echo "$new" > "$out/source_copy_id"
echo "$proj/$new.jsonl" >> "$out/created_sessions.txt"  # recorded at once: a failed call must not leave an unlisted copy
settings="$(python3 "$here/../common/bench.py" quiet)"
cd "$cwd"
start=$(date +%s)
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=0 claude -p --resume "$new" --fork-session \
  --settings "$settings" \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools "" \
  --model "$model" --max-budget-usd 25 --output-format json "/compact" < /dev/null > "$out/compact_result.json"
echo $(( $(date +%s) - start )) > "$out/compact_seconds"
# the source copy is no longer needed: the fork holds the history + the compaction
rm -f "$proj/$new.jsonl"
fork="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("session_id", ""))' "$out/compact_result.json")"
[[ -n "$fork" ]] && echo "$proj/$fork.jsonl" >> "$out/created_sessions.txt"
head -c 1500 "$out/compact_result.json"
