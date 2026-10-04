"""Shared paths, settings and helpers for the benchmark scripts.

Run as a script, prints the --settings JSON used by the shell scripts:
  bench.py quiet   all hooks off and the fast-jev-compaction plugin disabled
  bench.py nojev   only the plugin disabled
"""
import json
import os
import sys
from pathlib import Path

BENCH = Path(__file__).resolve().parents[1]
REPO = BENCH.parent
RUNS = Path(os.environ.get('BENCH_RUNS', BENCH / 'runs'))
PROJECTS = Path(os.path.expanduser('~/.claude/projects'))

# Installed ids of the fast-jev-compaction plugin. Every "without Jev" call disables all of them, so the plugin's own
# compaction hook can never run inside a baseline. Check yours with `claude plugin list` and set BENCH_PLUGIN_IDS
# (comma-separated) if it differs.
PLUGIN_IDS = [p for p in os.environ.get(
    'BENCH_PLUGIN_IDS', 'fast-jev-compaction@jev-compaction,fast-jev-compaction@fast-jev-compaction').split(',') if p]
NOJEV = {p: False for p in PLUGIN_IDS}
QUIET = {'disableAllHooks': True, 'enabledPlugins': NOJEV}

# list-price equivalent (Opus), $ per million tokens; only used to log an indicative cost per call in costs.tsv
PRICE = {'input_tokens': 15, 'cache_creation_input_tokens': 18.75, 'cache_read_input_tokens': 1.5, 'output_tokens': 75}


def max_calls(default):
    """Global cap on `claude` calls for one script run (BENCH_MAX_CALLS overrides the script default)."""
    return int(os.environ.get('BENCH_MAX_CALLS', default))


def load(f):
    """Transcript rows (one JSON object per non-empty line; unreadable lines are skipped)."""
    rows = []
    for line in open(f, encoding='utf-8'):
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


if __name__ == '__main__':
    print(json.dumps(QUIET if sys.argv[1:] == ['quiet'] else {'enabledPlugins': NOJEV}))
