# Benchmark

## 1. What it is

The scripts that measure what fast-jev-compaction keeps, what it costs and what it changes, run on **your own** Claude Code sessions. No transcript ships with this folder: every run copies one of your sessions, works on the copy, and writes its outputs to `bench/runs/` (gitignored).

| Benchmark | Question | Folder |
|---|---|---|
| Recall | After compaction, how many facts from the session can Claude still state? | `recall/` |
| Tokens | How many tokens get re-read over a session under each policy? | `tokens/` |
| Reasoning | Can Claude still apply rules and facts planted early in a long context, at 50k to 900k and after a summary? | `reasoning/` |
| Drift | Does Claude still follow working rules given once, long ago, without being reminded? | `drift/` |

## 2. How it works

```
your transcript ──► recall/prepare.py   cut point, readable history (before.md), meta.json
                     │
                     ├─ classic /compact on a copy ──────────────┐
                     ├─ recall/native_rules.py  native + rules ──┤
                     ├─ recall/replay.py   Jev passes (offline, ──┤──► ask.sh: the question bank, no tools
                     │     real Jev API) injected into a copy,   │        ──► blind.py ──► judge ──► score.py
                     │     then Jev + Claude summary, full ref.  ┘
                     └─ tokens/tokens_reread.py   offline, from replay.py's state files
reasoning/insert_probes.py  fictitious thread spliced into a copy ──► run_conditions.py ──► score_*.py
```

- **Copies, never the original.** Each variant resumes a copy with `--fork-session`. The source transcript is only read.
- **The labo plugins** (`labo/inject`, `labo/rules`, `labo/skiptest`) are passed with `--plugin-dir` and only act on that one call. They inject a precomputed state, apply summary rules to a native compaction, or refuse compaction to give the full-context reference. The installed plugin is disabled in every call (see `BENCH_PLUGIN_IDS`).
- **No tools when answering.** `ask.sh` passes `--tools ""` together with an empty `--strict-mcp-config`. The ~330k inflation noted in `docs/mesures-compaction.md` comes from deferred MCP tools, which the empty config removes. Check `_context_loaded` in each answers file anyway.
- **Blind judging.** `blind.py` shuffles the variants behind letters, with a new draw for each question. A fresh Claude session (or a subagent) grades `blind.json` with `recall/judge.md`; it never sees `.mapping.json`. Only `score.py` reveals the labels.
- **Reasoning and drift** are scored by fixed rules (regexes), so no judge is needed. The probe threads use invented companies and people only.

## 3. How to use it

### Prerequisites

- Claude Code CLI, logged in, with function hooks. The scripts set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` per call.
- Node 18+ and `npm i` at the repo root (for `npx tsx`). Python 3.9+.
- `export TYPESAFE_API_KEY=...` in your shell for anything that runs Jev. The key is read from the environment only. Never write it to a file in the repo.
- Your installed plugin id: `claude plugin list`. If it is not `fast-jev-compaction@jev-compaction`, set `BENCH_PLUGIN_IDS=<id>` so the baselines really run without Jev.
- A long session: one that was auto-compacted (recall, tokens), or one that reached 600-900k on a 1M-context model (reasoning).

### Recall

```bash
T=~/.claude/projects/<project>/<session>.jsonl
python3 bench/recall/prepare.py --list "$T"                 # compaction boundaries = candidate cut points
python3 bench/recall/prepare.py "$T" bench/runs/S1          # default cut: last compact_boundary; or --cut <row>
R=$PWD/bench/runs/S1
```

Question bank: paste this prompt into a fresh Claude Code session. It writes `questions.json` (30 questions).

```bash
sed "s|{BEFORE}|$R/before.md|; s|{OUT}|$R/questions.json|" bench/recall/questions_gen.md
```

Variants. Each one writes `answers_<name>.json`:

```bash
meta() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$R/meta.json" "$1"; }
native=$(python3 -c "import json; print(json.load(open('$R/compact_result.json'))['session_id'])")
bash bench/recall/ask.sh "$native" "$(meta cwd)" "$R/questions.json" "$R/answers_native.json" "$(meta model)"
python3 bench/recall/native_rules.py "$R" native_rules
python3 bench/recall/replay.py "$R" --full       # answers_jev_passes, answers_jev_summary, answers_full
# other summary rules, repeated trials:
RULES_FILE=$PWD/labo/rules-variants/combine.txt python3 bench/recall/native_rules.py "$R" native_combine
RULES_FILE=$PWD/labo/rules-variants/combine.txt python3 bench/recall/replay.py "$R" --only-final jev_combine
```

Judge and score:

```bash
python3 bench/recall/blind.py "$R"
sed "s|{BLIND}|$R/blind.json|; s|{OUT}|$R/judgments.json|" bench/recall/judge.md   # give to a fresh session
python3 bench/recall/score.py bench/runs/S1 bench/runs/S2                          # writes bench/runs/scores.json
```

<details><summary>Sessions already compacted by the plugin</summary>

`prepare.py --plugin-copy` also copies the segment the plugin kept (`jev_copy_id`). Ask it with `ask.sh` into `answers_jev.json`. Then `check_fork.py` checks that the resumed copy loaded exactly that segment. If the chain is broken, `relink.py` rebuilds the copy.
</details>

### Tokens

Offline, after `replay.py`:

```bash
python3 bench/tokens/tokens_reread.py bench/runs/S1 bench/runs/S2
```

It compares three worlds over the segment: the original session, Claude alone summarizing at 300k, and the plugin. Constants and the model are in the docstring.

### Reasoning

Use its own run dir.

```bash
python3 bench/recall/prepare.py "$T" bench/runs/R1 --meta-only --cut <row>
python3 bench/reasoning/insert_probes.py bench/runs/R1 40,60,80,100,120,140,160,180 300,600,900
python3 bench/reasoning/insert_probes.py bench/runs/R1 0,0,0,0,0,0,0,0 50 _50
python3 bench/reasoning/run_conditions.py bench/runs/R1 raw_50,raw_300,jev_300,raw_600,jev_600,summary_classic_600,summary_native_600,summary_jev_600,raw_900
python3 bench/reasoning/run_conditions.py bench/runs/R1 summary_native_600,summary_jev_600 --suffix _b   # repeat trial
python3 bench/reasoning/score_reasoning.py bench/runs/R1
```

Give one position (in k tokens) per probe exchange. Targets must be sizes your session really reached. Check R00 (integrity: Claude quotes the last message) by reading it.

### Drift

Same scripts, the drift probes, and a separate run dir:

```bash
P=bench/drift/probes_drift.json
python3 bench/recall/prepare.py "$T" bench/runs/D1 --meta-only --cut <row>
python3 bench/reasoning/insert_probes.py bench/runs/D1 40,70,100,130,160,190 600 --probes $P
python3 bench/reasoning/insert_probes.py bench/runs/D1 0,0,0,0,0,0 50 _50 --probes $P
python3 bench/reasoning/run_conditions.py bench/runs/D1 raw_50,raw_600,jev_600,summary_native_600,summary_jev_600 --probes $P
python3 bench/drift/score_drift.py bench/runs/D1
```

### Costs

Each `claude` call is capped with `--max-budget-usd`: 15 for `ask.sh`, 25 for the classic compaction, 15 for `native_rules.py`, 8 for each `replay.py` step (15 for the full reference), and 40 for each `run_conditions.py` call. Looping scripts stop after `BENCH_MAX_CALLS` calls: 8 for `replay.py`, and 2 per condition for `run_conditions.py`. `costs.tsv` logs a list-price estimate per call.

### Cleanup

The scripts create session copies **in your `~/.claude/projects/<project>/` folder**. They show up in your session list. Every path is recorded in `<run dir>/created_sessions.txt`. To move them out (nothing is deleted):

```bash
mkdir -p bench/runs/_sessions
find bench/runs -name created_sessions.txt -exec cat {} + | sort -u |
  while read -r f; do [ -f "$f" ] && mv "$f" bench/runs/_sessions/; done
```

`bench/runs/` holds copies of your transcripts (`before.md`, `aug.jsonl`, `mp_input.json`…). Keep it private.
