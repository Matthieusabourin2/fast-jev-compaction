# fast-jev-compaction (summary-rules fork)

*[Version française](README.md)*

Long Claude Code sessions forget.

When the context fills up, Claude Code replaces the whole conversation with a summary written by Claude. That summary is short, generic and lossy. On our real working sessions, Claude could still answer 58% of factual questions about the summarized part. An amount the user corrected, an instruction given once, a file path: these are what disappear first.

This fork of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) changes the order of operations. Jev, a fast model from TypeSafe, cleans first by removal only. Claude summarizes last, from a cleaned history, with rules that keep the user's words and exact facts. Clean early, summarize late, keep the words.

## 1. What it is

A Claude Code plugin, built on function hooks, that steps in three times over the life of a session.

1. **Jev cleans the context without rewriting it.** From 30% of the context window, it removes the tool calls and tool outputs that no longer matter. Text written by you and by Claude stays word for word. Claude's thinking blocks, attached files and images in the rebuilt history do not survive a pass.
2. **The plugin refuses compactions that are not worth it.** Between two cleanings, Claude Code asks for a compaction before every model call. The plugin says no until the context has grown enough to justify another pass.
3. **Claude summarizes once, late, with stricter rules.** At 60% of the window, Jev cleans one last time, then Claude writes the summary from that smaller history. A fixed plan tells Claude what to keep: every user message word for word, the instructions still in force, exact figures with the values they replaced, decisions, work done, open items.

### What we measured

Four real working sessions, each cut at its compaction point (about 600k tokens). A model wrote 30 questions per session from the part about to be summarized, and a blind judge scored the answers without knowing which compaction produced them.

| What Claude has after compaction | Questions answered |
|---|---|
| The full conversation (reference, 2 sessions) | 98% |
| Jev cleanings only, no summary yet | 97% |
| Claude Code's default summary | 58% |
| Claude's summary with this fork's rules | 70 to 75% |
| **Jev cleaning, then Claude's summary with the rules** (this plugin) | **80 to 87%** |

Reasoning after a summary at 600k: a fictitious thread of 8 exchanges (six clients with similar names, rules stated once, an amount updated late) planted in 2 real long sessions, 12 questions, 3 runs each.

| Summary | Correct answers |
|---|---|
| Claude Code's default summary | 74% |
| Claude's summary with the rules | 79 to 82% |
| **Jev cleaning, then Claude's summary with the rules** | **100%** (12/12 on every run) |

Behavior drift: six working rules given early (signature, tone, amounts excluding tax, no Friday meetings), then three emails to write without any reminder. The rules held at 100% in raw context up to about 890k tokens, and after the summary with the rules, with or without Jev. They dropped to 93% after the default summary.

Tokens re-read across the four sessions: 321M originally, 234M with this plugin (-27%; from -69% to 0% per session). Having Claude Code alone compact at 30% re-reads less (146M, -55%), at the cost of 2 to 3 lossy summaries per session.

<details>
<summary>Limits of these measurements</summary>

- Small sample: 4 sessions for recall, 2 for reasoning, one model (Claude Opus 5), French-language sessions.
- Questions were written by a model, and answered without tools. In real work Claude can reread a file or re-run a command.
- Claude's summary varies from one run to the next: the same session gave 7/12 and 12/12 with the same rules.
- On the long sessions we tested, raw context showed no measurable reasoning loss up to about 890k tokens. Compacting earlier saves tokens. It did not improve answers.
- The numbers were measured with the v0.7.0 rules. v0.7.1 adds two lines (your `/compact` text now overrides the plan; the open items section is never cut) that were not re-measured.
- The protocol and scripts are in [`bench/`](bench/README.md). The recall and token scripts are the ones behind these numbers. The reasoning and drift probes were rewritten in English with new fictitious names and a slightly more lenient scorer, so their scores are not directly comparable to ours. Run them on your own sessions before trusting our numbers.

</details>

## 2. How it works

```
context  0% ─────────── 30% ───────────────────────── 60% ──────── 85%
                         │                              │            │
                         │  Jev pass: remove stale      │  final:    │  hard cap:
                         │  tool calls and outputs      │  Jev pass  │  final stage
                         │  (text kept word for word)   │  + Claude  │  whatever the
                         │                              │  summary   │  settings
                         │  refuse until +100k tokens   │  with the  │
                         │  since the last pass         │  rules     │
```

Claude Code fires `session.compact` before each model call once the context passes `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (30%). The hook in [`hooks/fast-jev.ts`](hooks/fast-jev.ts) decides what happens:

| Situation | What the plugin does |
|---|---|
| Below `summarizeAtPercent` (60%), context grew by `passGrowthTokens` (100k) since the last pass | Jev pass: removes tool calls and outputs, keeps all text |
| Below 60%, not enough growth, Jev removed less than 25%, Jev failed, or the previous pass was less than 3 calls ago | Refuses: one `not compacted` notice, the conversation stays intact |
| At 60% or more, or on `/compact` | Final stage: Jev pass, then Claude's summary with the rules |
| Subagent compaction | Claude Code's own compaction, untouched |

Each pass also carries forward what Claude Code would otherwise lose: messages typed while Claude was working, and skills invoked earlier. Each pass and each final stage is logged in `~/.claude/jev-journal/`.

The summary rules are in `handoverInstructions` in [`src/v2.ts`](src/v2.ts). Text you pass to `/compact <text>` is appended and takes precedence over the plan.

> Rules written in `CLAUDE.md`, even under a "Compact Instructions" heading, are ignored by Claude Code's summary: we tested it twice. `/compact <rules>` works but only by hand. For automatic compaction, a plugin is the only way to pass rules.

## 3. How to use it

### Prerequisites

- Claude Code with function hooks (early access). Everything here was measured on 2.1.286.
- A TypeSafe API key for Jev (see below).

### Get a Jev key

1. Sign in to the [TypeSafe console](https://console.typesafe.ai/) with Google or an email code.
2. Open [API Keys](https://console.typesafe.ai/keys), create a key and copy it right away.
3. Check it in a terminal:

   ```bash
   curl -s https://api.typesafe.ai/v1/models -H "Authorization: Bearer $TYPESAFE_API_KEY"
   ```

   The response lists the models. The plugin uses `jev-1.13.0`.

Public price: $0.042 per million input tokens, per the [TypeSafe homepage](https://typesafe.ai). A cleaning pass sends a few tens of thousands of tokens.

Signups have changed several times since launch: open to everyone on September 21, 2026, paused the next day for capacity, still paused at the end of September. If the console does not let you create an account, write to hello@typesafe.ai. Access through Vercel's AI Gateway does not work with this plugin, which calls the TypeSafe API directly. Official docs: [quick start](https://docs.typesafe.ai/introduction/quickstart).

### Install

1. Add these variables to `~/.claude/settings.json`, under `"env"`:

   ```json
   {
     "env": {
       "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
       "TYPESAFE_API_KEY": "<your key>",
       "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "30"
     }
   }
   ```

   `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is where Jev starts cleaning. Without it, Claude Code waits until the window is nearly full and every compaction becomes a final stage.

2. Add this repository as a marketplace and install the plugin:

   ```bash
   claude plugin marketplace add Matthieusabourin2/fast-jev-compaction
   ```

   ```bash
   claude plugin install fast-jev-compaction@jev-compaction
   ```

   If you installed the original plugin, disable it first (`claude plugin disable fast-jev-compaction@fast-jev-compaction`) so the two do not both answer.

3. Restart Claude Code. Leave the plugin options at their defaults unless you know why.

### Get updates

In Claude Code, run `/plugin`, open **Marketplaces**, select `jev-compaction` and enable auto-update. A new version reaches you when its number changes in `plugin.json`.

This fork follows the original project. A weekly GitHub Action ([`sync-upstream.yml`](.github/workflows/sync-upstream.yml)) merges upstream changes into a branch, runs the tests and opens a pull request. A conflict opens an issue instead.

### Check that it runs

- Run `/compact` in a long session. A new file appears in `~/.claude/jev-journal/` with `"stage": "final"`, and the summary follows the seven sections.
- Between 30% and 60%, a `not compacted` notice means the plugin refused a compaction on purpose.

### Options

| Option | Default | Effect |
|---|---|---|
| `summarizeAtPercent` | 60 | Where Claude summarizes after a last Jev pass |
| `hardCapPercent` | 85 | Final stage whatever the other settings |
| `passGrowthTokens` | 100000 | Growth needed between two Jev passes |
| `minReductionRatio` | 0.25 | Below this reduction, a pass is refused |
| `keepThreshold` | 0.5 | Jev's minimum keep probability for a tool call or output |
| `preserveRecentMessages` | 6 | Newest messages never touched |

The full list is in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json). Library use and the original options are documented in [`docs/library.md`](docs/library.md). The engine measurements behind the design (what a compaction hook sees, what Claude Code keeps) are in [`docs/mesures-compaction.md`](docs/mesures-compaction.md), in French.

### Run the benchmark

[`bench/README.md`](bench/README.md) runs the same protocol on your own sessions: recall after compaction, tokens re-read, reasoning at several context sizes, behavior drift. Every call to Claude is capped in cost, and copies of your sessions stay on your machine.

### Development

```bash
npm install && npm run typecheck && npm test
```

To load the plugin from a checkout without installing it: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`

MIT license, like the original project.
