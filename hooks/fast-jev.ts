import type {
  On,
  PluginOptions,
  Register,
  SessionCompactInput,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import {
  type ApiMessage,
  compactionNote,
  estimateMessagesTokens,
  handoverInstructions,
  insertNote,
  queuedUserMessages,
  capSkills,
  latestSkills,
  takeNotes,
  NOTE_HEAD,
  documentReads,
  rebuildAll,
  transcriptPath,
} from '../src/v2.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  // 0 = no plugin-initiated compaction: `turn.complete` cannot call $.session.compact()
  // headless (measured), and the desktop case is still to be measured.
  compactAtPercent: 0,
  minReductionRatio: 0.25,
  // Above this share of the auto-compact threshold after cleaning (real tokens, fixed prefix
  // included), Jev hands the cleaned history to the native summary instead of re-triggering.
  handoverAbove: 0.7,
  // v0.6: between the auto-compact trigger and this share of the window, Jev only removes;
  // at it, Jev cleans one last time and Claude summarizes the cleaned history.
  summarizeAtPercent: 60,
  // Never refuse a compaction above this share of the window (the engine's `auto` also covers "prompt too long").
  hardCapPercent: 85,
  // A new pass only once the context has grown this much since the previous one; refused in between.
  passGrowthTokens: 100_000,
  model: DEFAULT_MODEL,
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  handoverAbove: number;
  summarizeAtPercent: number;
  hardCapPercent: number;
  passGrowthTokens: number;
  model: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    handoverAbove: optionNumber(options, 'handoverAbove', HOOK_DEFAULTS.handoverAbove),
    summarizeAtPercent: optionNumber(options, 'summarizeAtPercent', HOOK_DEFAULTS.summarizeAtPercent),
    hardCapPercent: optionNumber(options, 'hardCapPercent', HOOK_DEFAULTS.hardCapPercent),
    passGrowthTokens: optionNumber(options, 'passGrowthTokens', HOOK_DEFAULTS.passGrowthTokens),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const result = await compact(messages, jevAsker(fetchFn, config.apiKey, config.model), config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;
/** Above this estimate, an invoked skill is carried over as the path of its SKILL.md. */
const SKILL_MAX_TOKENS = 4000;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

export type V2Deps<R> = {
  fetch: HookFetch;
  api: () => Promise<ApiMessage[]>;
  transcript: () => Promise<string | undefined>;
  next: (event: SessionCompactInput) => Promise<R>;
  /** The context at compaction time: real tokens, the fixed prefix (system, tools, memory, skills), the auto-compact threshold. */
  usage: () => Promise<ContextUsage | undefined>;
  /** Messages in the conversation right after this session's previous pass, if any. */
  previousLength?: number;
  /** `pass`: remove only, refuse rather than summarize; `final`: clean, then Claude summarizes. */
  stage: 'pass' | 'final';
};

export type Stage = 'pass' | 'final' | 'skip' | 'native';

/**
 * What one `session.compact` does, from the real context size (cheap
 * `$.session.usage()`): subagents go to Claude untouched; `precompute` is
 * refused (it would compute a summary the passes make stale); `/compact` and a
 * plugin's call are the final clean; on `auto`, at `summarizeAtPercent` (or
 * the hard cap) the final clean, below it a pass, or a refusal while the
 * context has grown less than `passGrowthTokens` since the previous pass.
 */
export function gate(
  event: SessionCompactInput,
  tokens: number | undefined,
  window: number | undefined,
  lastAfter: number | undefined,
  config: HookConfig,
): { stage: Stage; reason?: string } {
  if (event.agentId !== undefined) return { stage: 'native' };
  if (event.trigger === 'precompute') return { stage: 'skip', reason: 'fast-jev: no summary ahead of time' };
  if (event.trigger !== 'auto' || tokens === undefined || !window) return { stage: 'final' };
  const at = (Math.min(config.summarizeAtPercent, config.hardCapPercent) / 100) * window;
  if (tokens >= at) return { stage: 'final' };
  if (lastAfter !== undefined && tokens - lastAfter < config.passGrowthTokens) {
    return { stage: 'skip', reason: `fast-jev: ~${Math.round(tokens / 1000)}k, next clean at +${Math.round(config.passGrowthTokens / 1000)}k, summary at ${Math.round(at / 1000)}k` };
  }
  return { stage: 'pass' };
}

/** Claude Code stops a session whose context refills within 3 calls of a compaction, 3 times in a row. */
const REFILL_CALLS = 3;

export type ContextUsage = { tokens: number; fixed: number; threshold: number };

/** Real tokens per estimated token of conversation, measured on seven real sessions (1.29 to 1.47). */
const ESTIMATE_TO_REAL = 1.4;

export type V2Journal = {
  mode: 'jev' | 'handover' | 'native' | 'skip';
  trigger: string;
  reason?: string;
  messagesBefore: number;
  messagesAfter: number;
  tokensAfterEstimate: number;
  contextAfter: number;
  ceiling?: number;
  queued: number;
  skills: number;
  stats?: CompactResult['stats'];
  summary: string;
};

/**
 * One v2 compaction. Subagents and `precompute` go to the native summary
 * untouched. Otherwise Jev decides which tool calls go, every message is
 * rebuilt without its engine handle (dropping thinking, attachments and
 * injected listings, and keeping a later resume from reloading the old
 * history), the prompts typed mid-turn are carried over as text, and a note
 * points to the full transcript. When the result is still above
 * `maxKeptTokens`, or Jev failed, the cleaned history goes to the native
 * summary with instructions to keep the user's words.
 */
export async function compactV2<R>(
  event: SessionCompactInput,
  config: HookConfig,
  deps: V2Deps<R>,
): Promise<{ result: R | { messages: SessionMessage[] } | { skip: string }; journal?: V2Journal }> {
  if (event.agentId !== undefined) return { result: await deps.next(event) };
  const before = event.messages as unknown as Message[];
  const final = deps.stage === 'final';
  const tokensBefore = estimateMessagesTokens(before);
  const callsSince = deps.previousLength === undefined || deps.previousLength > before.length ? undefined
    : before.slice(deps.previousLength).filter((m) => m.role === 'assistant' && m.toolUses.length > 0).length;
  const refused = (reason: string, extra: Partial<V2Journal> = {}) => ({
    result: { skip: `fast-jev: ${reason}` },
    journal: { mode: 'skip' as const, trigger: event.trigger, reason, messagesBefore: before.length, messagesAfter: before.length,
      tokensAfterEstimate: tokensBefore, contextAfter: 0, queued: 0, skills: 0, summary: `refused (${reason})`, ...extra },
  });
  if (!final && callsSince !== undefined && callsSince <= REFILL_CALLS) {
    // checked before calling Jev: a pass right after the previous one would rewrite the cache for little
    return refused(`context refilled within ${callsSince} call(s) of the previous pass`);
  }
  const usage = await deps.usage().catch(() => undefined);
  const ratio = usage && tokensBefore > 0 ? Math.max((usage.tokens - usage.fixed) / tokensBefore, 1) : ESTIMATE_TO_REAL;
  const ceiling = usage ? Math.round(config.handoverAbove * usage.threshold) : undefined;
  let jev: CompactResult | undefined;
  let reason: string | undefined;
  try {
    if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
    jev = await compact(before, jevAsker(deps.fetch, config.apiKey, config.model), {
      ...config,
      protectedCallIds: documentReads(before),
      preserveRecentMessages: protectedTail(before, resolveOptions(config).preserveRecentMessages,
        ceiling === undefined ? undefined : (ceiling - (usage?.fixed ?? 0)) / ratio / 2),
      goal: config.goal ?? event.instructions,
    });
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  const earlier = takeNotes(rebuildAll(jev?.messages ?? before));
  const api = await deps.api().catch(() => [] as ApiMessage[]);
  const queued = [...earlier.queued];
  for (const prompt of queuedUserMessages(api)) if (!queued.includes(prompt)) queued.push(prompt);
  const skillMap = new Map(earlier.skills);
  for (const [dir, body] of latestSkills(api)) {
    skillMap.delete(dir);
    skillMap.set(dir, body);
  }
  const skills = capSkills(skillMap, SKILL_MAX_TOKENS);
  const transcript = await deps.transcript().catch(() => undefined);
  const preserve = resolveOptions(config).preserveRecentMessages;
  // user's words carried by notes from v0.6.1–0.6.2 stay in the note, pass after pass
  const out = insertNote(earlier.messages, compactionNote(transcript, queued, skills, earlier.said), preserve);
  const tokens = estimateMessagesTokens(out);
  const contextAfter = Math.round((usage?.fixed ?? 0) + tokens * ratio);
  const reduced = tokensBefore > 0 ? 1 - tokens / tokensBefore : 1;
  const journal: V2Journal = {
    mode: final ? 'handover' : 'jev',
    trigger: event.trigger,
    reason,
    messagesBefore: before.length,
    messagesAfter: out.length,
    tokensAfterEstimate: tokens,
    contextAfter,
    ceiling,
    queued: queued.length,
    skills: skills.length,
    stats: jev?.stats,
    summary: '',
  };
  const messages = out as unknown as SessionMessage[];
  if (!final) {
    // a pass only removes; when it cannot remove enough (or Jev failed) the conversation stays as it is
    if (jev === undefined) return refused(reason!, journal);
    if (reduced < config.minReductionRatio) {
      return refused(`only ${Math.round(reduced * 100)}% removable, below minReductionRatio ${config.minReductionRatio}`, journal);
    }
    return { result: { messages }, journal: { ...journal, summary: `kept ${out.length}/${before.length} messages verbatim, ~${contextAfter} tokens of context, ${queued.length} mid-turn prompt(s) carried over` } };
  }
  reason ??= 'final clean before the summary';
  const summarized = await deps.next({ ...event, messages, instructions: handoverInstructions(event.instructions) });
  if ((summarized as { skip?: string })?.skip) return { result: summarized, journal: { ...journal, mode: 'skip', reason, summary: `summary refused downstream (${reason})` } };
  return { result: summarized, journal: { ...journal, reason, summary: `native summary over the cleaned history (${reason})` } };
}

/**
 * How many of the newest messages a pass leaves alone: the turn in progress,
 * from the user's last prompt, so a pass in the middle of a tool loop does not
 * take away what the task is working from; but no more than `budget`
 * estimated tokens, so one long autonomous turn can still be cleaned.
 */
export function protectedTail(messages: readonly Message[], minimum: number, budget: number | undefined): number {
  const turn = messages.length - lastPrompt(messages);
  if (budget === undefined) return Math.max(minimum, turn);
  let n = 0;
  let used = 0;
  while (n < turn) {
    used += estimateMessagesTokens([messages[messages.length - 1 - n]!]);
    if (used > budget) break;
    n++;
  }
  return Math.max(minimum, n);
}

/** Index of the last message the user typed (text, no tool result); 0 when there is none. */
export function lastPrompt(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && m.text.trim().length > 0 && (m.toolResults ?? []).length === 0 && !m.text.startsWith(NOTE_HEAD)) return i;
  }
  return 0;
}

/** Categories of the context breakdown that a compaction cannot touch. */
const FIXED_CATEGORIES = ['System prompt', 'System tools', 'MCP tools', 'MCP server instructions', 'Custom agents', 'Memory files', 'Skills'];

/**
 * Reads the real context size, its fixed prefix and the auto-compact threshold
 * from `$.session.usage`. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` moves the real
 * trigger without moving the reported threshold (measured), so the lower of the
 * two wins.
 */
export function contextUsage(u: unknown, overridePercent?: string): ContextUsage | undefined {
  const context = (u as { context?: { tokens?: number; window?: number; breakdown?: { autoCompactThreshold?: number; categories?: Array<{ name: string; tokens: number }> } } })?.context;
  const breakdown = context?.breakdown;
  if (!context?.tokens || !breakdown?.categories) return undefined;
  const fixed = breakdown.categories.filter((c) => FIXED_CATEGORIES.includes(c.name)).reduce((n, c) => n + c.tokens, 0);
  const pct = Number(overridePercent);
  const candidates = [breakdown.autoCompactThreshold, pct > 0 && pct < 100 && context.window ? (pct / 100) * context.window : undefined]
    .filter((v): v is number => typeof v === 'number' && v > 0);
  if (candidates.length === 0) return undefined;
  return { tokens: context.tokens, fixed, threshold: Math.min(...candidates) };
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;

  // per session: messages and real context right after the previous pass (or refusal for lack of gain)
  const lastPass = new Map<string, { length?: number; after: number }>();
  on('session.compact', async ($, event, next) => {
    const sessionId = await $.session.id();
    const live = await $.session.usage().then((u) => u.context, () => undefined);
    const last = lastPass.get(sessionId);
    // `tokens` is absent right after a resume and lags one response: the estimate of what is about to be sent is a floor
    const estimated = Math.round(estimateMessagesTokens(event.messages as unknown as Message[]) * ESTIMATE_TO_REAL);
    const size = Math.max(live?.tokens ?? 0, estimated) || undefined;
    const decided = gate(event, size, live?.window, last?.after, configured);
    if (decided.stage === 'native') return next(event);
    if (decided.stage === 'skip') return { skip: decided.reason ?? 'fast-jev' };
    const home = (await $.env.get('HOME')) ?? '~';
    const outcome = await compactV2(event, { ...configured, apiKey: await getApiKey($, configured) }, {
      fetch: async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      },
      api: async () => (await $.session.messages({ as: 'api' })) as unknown as ApiMessage[],
      transcript: async () => transcriptPath(home, await $.session.root(), await $.session.id()),
      next,
      usage: async () => contextUsage(await $.session.usage({ breakdown: 'full' }), await $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')),
      previousLength: last?.length,
      stage: decided.stage,
    });
    const mode = outcome.journal?.mode;
    if (mode === 'jev') lastPass.set(sessionId, { length: outcome.journal!.messagesAfter, after: outcome.journal!.contextAfter });
    else if (mode === 'skip' && decided.stage === 'pass' && size !== undefined) lastPass.set(sessionId, { length: last?.length, after: size });
    else lastPass.delete(sessionId);
    if (outcome.journal) {
      $.ui.log(`fast-jev-compaction: ${JSON.stringify(outcome.journal)}`);
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await $.fs.write(`${home}/.claude/jev-journal/${stamp}.json`, JSON.stringify({ ...outcome.journal, stage: decided.stage, contextBefore: size }));
      } catch {
        // the journal is diagnostic only
      }
      if (mode !== 'skip') notify($, outcome.journal.summary);
    }
    return outcome.result;
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting || configured.compactAtPercent <= 0 || event.agentId) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
