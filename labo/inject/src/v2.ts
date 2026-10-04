import { estimateTokens } from './state.js';
import type { Message } from './types.js';

/**
 * Tools whose call and result are never compaction candidates: the person's
 * answers to a multiple-choice question, a subagent's report, a plan approval.
 */
export const DEFAULT_PROTECTED_TOOLS = ['AskUserQuestion', 'Agent', 'Task', 'ExitPlanMode'];

/**
 * Rebuilds every message from its role, text and tool blocks only, with no
 * engine handle. Claude Code then writes fresh rows: thinking blocks, attached
 * files, injected listings and images are left behind, and a later resume does
 * not reload the pre-compaction history through a kept row's old parent link.
 * Messages left with nothing to carry are dropped.
 */
export function rebuildAll(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    const toolUses = message.toolUses.map((tool) => {
      const copy: Message['toolUses'][number] = {
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
      };
      if (tool.text !== undefined) copy.text = tool.text;
      if (tool.isError) copy.isError = true;
      return copy;
    });
    const toolResults = (message.toolResults ?? []).map((result) => ({
      tool_use_id: result.tool_use_id,
      text: result.text,
      isError: result.isError ?? false,
    }));
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) continue;
    // Claude Code writes one row per block of an API message, and loads rows of the same
    // message id as one message. Rebuilt rows get fresh ids, so the rows of one assistant
    // turn (parallel tool calls) and the rows of their results are joined here: otherwise
    // every call but the last loses its result ("Tool result missing due to internal error").
    const last = out[out.length - 1];
    if (last && last.role === 'assistant' && message.role === 'assistant' && toolResults.length === 0 && last.toolUses.length > 0) {
      last.text = [last.text, message.text].filter((t) => t.length > 0).join('\n');
      last.toolUses.push(...toolUses);
      continue;
    }
    if (last && last.role === 'user' && message.role === 'user' && toolResults.length > 0 && message.text.length === 0
      && (last.toolResults ?? []).length > 0 && last.text.length === 0) {
      last.toolResults!.push(...toolResults);
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    out.push(rebuilt);
  }
  return out;
}

/** A Messages API message as `$.session.messages({ as: 'api' })` returns it. */
export interface ApiMessage {
  role: 'user' | 'assistant';
  content: ReadonlyArray<{ type: string; text?: string; content?: string | ReadonlyArray<{ type: string; text?: string }> }>;
}

/** Every text of a user message, including the texts nested in a tool result. */
function userTexts(message: ApiMessage): string[] {
  const texts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text' && block.text) texts.push(block.text);
    if (block.type !== 'tool_result') continue;
    if (typeof block.content === 'string') texts.push(block.content);
    else for (const part of block.content ?? []) if (part.type === 'text' && part.text) texts.push(part.text);
  }
  return texts;
}

const QUEUED_HEAD = 'The user sent a new message while you were working:\n';
const REMINDER = '<system-reminder>\n';

/**
 * The messages the person typed while a turn ran. Claude Code delivers them as
 * attachments, which a compaction hook does not receive: read them from the API
 * form of the conversation so they can be carried over as text.
 */
export function queuedUserMessages(api: readonly ApiMessage[]): string[] {
  const found: string[] = [];
  for (const message of api) {
    if (message.role !== 'user') continue;
    for (const text of userTexts(message)) {
      for (const prompt of trailingQueued(text)) if (!found.includes(prompt)) found.push(prompt);
    }
  }
  return found;
}

/**
 * The queued prompts in the reminders Claude Code appends at the end of a text:
 * a head that opens a whole text, or a reminder block in the trailing run of
 * reminders. The same words inside what a tool read are not matched.
 */
function trailingQueued(text: string): string[] {
  const prompts: string[] = [];
  let rest = text.trimEnd();
  for (;;) {
    if (!rest.endsWith('</system-reminder>')) break;
    const open = rest.lastIndexOf(REMINDER);
    if (open < 0) break;
    const block = rest.slice(open + REMINDER.length, rest.length - '</system-reminder>'.length);
    if (block.startsWith(QUEUED_HEAD)) prompts.unshift(queuedBody(block.slice(QUEUED_HEAD.length)));
    rest = rest.slice(0, open).trimEnd();
  }
  if (text.startsWith(QUEUED_HEAD)) prompts.unshift(queuedBody(text.slice(QUEUED_HEAD.length)));
  return prompts.filter((prompt) => prompt.length > 0);
}

function queuedBody(body: string): string {
  const end = body.search(/\n\nThis is how Claude Code surfaces|<\/system-reminder>/);
  return (end < 0 ? body : body.slice(0, end)).trim();
}

const SKILL_HEAD = 'Base directory for this skill: ';
/** Total carried over for skills, the budget Claude Code's own compaction gives them. */
const SKILLS_TOTAL_TOKENS = 25000;

/** The latest copy of each skill invoked in the session, keyed by its directory. */
export function latestSkills(api: readonly ApiMessage[]): Map<string, string> {
  const latest = new Map<string, string>();
  for (const message of api) {
    if (message.role !== 'user') continue;
    for (const block of message.content) {
      const text = block.type === 'text' ? block.text ?? '' : '';
      if (!text.startsWith(SKILL_HEAD)) continue;
      const dir = skillDir(text);
      latest.delete(dir);
      latest.set(dir, text.trim());
    }
  }
  return latest;
}

function skillDir(body: string): string {
  return body.slice(SKILL_HEAD.length).split('\n', 1)[0]!.trim();
}

/**
 * Skill bodies to carry over, newest last, within the budget Claude Code's own
 * compaction gives them. A body over `maxTokens` or over the budget is replaced
 * by the path of its SKILL.md.
 */
export function capSkills(latest: ReadonlyMap<string, string>, maxTokens: number): string[] {
  let budget = SKILLS_TOTAL_TOKENS;
  return [...latest].reverse().map(([dir, body]) => {
    const tokens = estimateTokens(body);
    if (tokens <= maxTokens && tokens <= budget) {
      budget -= tokens;
      return body;
    }
    return `${SKILL_HEAD}${dir}\n(Instructions not carried over: read ${dir}/SKILL.md before acting on this skill.)`;
  }).reverse();
}

/**
 * The instructions of the skills invoked in the session, latest copy per skill.
 * Claude Code injects them as meta messages that a compaction hook does not
 * receive. A body above `maxTokens` is replaced by the path of its SKILL.md.
 */
export function invokedSkills(api: readonly ApiMessage[], maxTokens: number): string[] {
  return capSkills(latestSkills(api), maxTokens);
}

/** The transcript file Claude Code keeps for a session, which still holds every pre-compaction row. */
export function transcriptPath(home: string, projectRoot: string, sessionId: string): string {
  return `${home}/.claude/projects/${projectRoot.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}.jsonl`;
}

export const NOTE_HEAD = '[fast-jev-compaction]';
const QUEUED_TAG = 'typed-while-working';
const SKILL_TAG = 'skill-in-force';
const SAID_TAG = 'user-said';

/** The note Jev leaves in place of what it removed: where the full history is, and the carried-over prompts and skills. */
export function compactionNote(transcript: string | undefined, queued: readonly string[], skills: readonly string[] = [], said: readonly string[] = []): string {
  const lines = [`${NOTE_HEAD} Older tool calls and outputs were removed from this conversation; the text exchanged is kept verbatim.`];
  if (transcript) {
    lines.push(`The full history before this compaction is in ${transcript} (JSONL; read it, or re-run a tool, when a removed detail is needed).`);
  }
  if (queued.length > 0) {
    lines.push('Messages the user typed while you were working, already delivered and handled during those turns; kept only so their exact words are not lost:');
    for (const prompt of queued) lines.push(`<${QUEUED_TAG}>`, prompt, `</${QUEUED_TAG}>`);
  }
  if (skills.length > 0) {
    lines.push('Skills invoked earlier in this session, still in force:');
    for (const skill of skills) lines.push(`<${SKILL_TAG}>`, skill, `</${SKILL_TAG}>`);
  }
  if (said.length > 0) {
    lines.push("The user's own messages in this conversation, word for word (oldest dropped first, long pastes cut):");
    for (const text of said) lines.push(`<${SAID_TAG}>`, text, `</${SAID_TAG}>`);
  }
  return lines.join('\n');
}

/**
 * Takes the notes of earlier compactions out of the conversation and returns
 * what they carried: after a first pass, the prompts typed mid-turn and the
 * skill bodies survive only there, so each new note merges the earlier ones.
 */
export function takeNotes(messages: readonly Message[]): { messages: Message[]; queued: string[]; skills: Map<string, string>; said: string[] } {
  const queued: string[] = [];
  const said: string[] = [];
  const skills = new Map<string, string>();
  const rest: Message[] = [];
  for (const message of messages) {
    if (message.role !== 'user' || !message.text.startsWith(NOTE_HEAD) || message.toolUses.length > 0 || (message.toolResults ?? []).length > 0) {
      rest.push(message);
      continue;
    }
    for (const prompt of tagged(message.text, QUEUED_TAG)) if (!queued.includes(prompt)) queued.push(prompt);
    for (const text of tagged(message.text, SAID_TAG)) if (!said.includes(text)) said.push(text);
    for (const body of tagged(message.text, SKILL_TAG)) {
      const dir = skillDir(body);
      skills.delete(dir);
      skills.set(dir, body);
    }
  }
  return { messages: rest, queued, skills, said };
}

function tagged(text: string, tag: string): string[] {
  return [...text.matchAll(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`, 'g'))].map((m) => m[1]!);
}

/**
 * Inserts the note as a user message just before the newest `preserve`
 * messages, so it reads as context for the work still in progress.
 */
export function insertNote(messages: readonly Message[], note: string, preserve: number): Message[] {
  let at = Math.max(1, messages.length - preserve);
  while (at > 1 && !pairsClosedBefore(messages, at)) at--;
  return [...messages.slice(0, at), { role: 'user', text: note, toolUses: [] }, ...messages.slice(at)];
}

/**
 * True when every tool call before `at` has its result before `at` and the
 * message at `at` carries no result: a user note there splits no tool pair.
 */
function pairsClosedBefore(messages: readonly Message[], at: number): boolean {
  if ((messages[at]?.toolResults ?? []).length > 0) return false;
  const open = new Set<string>();
  for (const message of messages.slice(0, at)) {
    for (const tool of message.toolUses) open.add(tool.tool_use_id);
    for (const result of message.toolResults ?? []) open.delete(result.tool_use_id);
  }
  return open.size === 0;
}

/** Estimated tokens of a message list, with the library's tokenizer-free estimate. */
export function estimateMessagesTokens(messages: readonly Message[]): number {
  let tokens = 0;
  for (const message of messages) {
    tokens += estimateTokens(message.text);
    for (const tool of message.toolUses) tokens += estimateTokens(`${tool.tool} ${JSON.stringify(tool.input ?? null)}`);
    for (const result of message.toolResults ?? []) tokens += estimateTokens(result.text);
  }
  return Math.ceil(tokens);
}

/**
 * The summary rules given to Claude Code's compaction (the combined set, measured best with Jev):
 * a fixed plan that keeps the user's words, the instructions in force, exact facts with their
 * replaced values, decisions, work done and open items.
 */
export function handoverInstructions(extra: string | undefined): string {
  const base = [
    'Write the summary with exactly the sections below, in this order, instead of your usual structure. Each section must be complete; the reader will have nothing else.',
    '1. Goal: what the user is trying to achieve in this session, in two or three sentences.',
    '2. All user messages: every message the user sent, in order, quoted word for word (long pastes may be cut after their first lines, marked "[…]"), including messages typed while you were working and answers to questions. Do not merge or paraphrase them.',
    '3. Standing instructions: every instruction, constraint, rule and preference still in force, quoted word for word. When a later instruction replaced an earlier one, give only the current one and say what it replaced.',
    '4. Exact facts: every figure, amount, date, identifier, reference, name, email address, file path, URL, command and setting that may still matter, copied exactly as written: no rounding, no paraphrase. Give the current value; when a value changed, give the current one and the one it replaced. Group them by topic.',
    '5. Decisions: each decision taken, with what was chosen, what was ruled out, why, and who decided. Mark decisions later reversed.',
    '6. Work done: files created or modified (path and what changed), tests run and their results, errors met and how they were fixed.',
    '7. Open items: unanswered questions, pending tasks, and the exact next step.',
    'When unsure whether a detail still matters, keep it. If space runs short, shorten section 2 (oldest messages first) and never drop section 7.',
  ].join('\n');
  return extra ? `${base}\n\nThe user's own instructions for this summary, which take precedence over the plan above:\n${extra}` : base;
}

/** Estimated tokens the documents a session works from may keep after a pass. */
const DOCUMENTS_TOTAL_TOKENS = 30000;
/** A single document above this estimate is left to Jev. */
const DOCUMENT_MAX_TOKENS = 8000;

/**
 * The reads of Markdown documents (briefs, state, plans, CLAUDE.md, drafts) a
 * session works from, latest read per document, newest first within a budget.
 * Their content often exists only in that tool result, never restated in the
 * dialogue, and a later pass would drop it once the work has moved on.
 */
export function documentReads(messages: readonly Message[]): Set<string> {
  const latest = new Map<string, { id: string; tokens: number }>();
  for (const message of messages) {
    for (const tool of message.toolUses) {
      const key = documentKey(tool.tool, tool.input as Record<string, unknown>);
      if (!key) continue;
      latest.delete(key);
      latest.set(key, { id: tool.tool_use_id, tokens: estimateTokens(tool.text ?? resultText(messages, tool.tool_use_id)) });
    }
  }
  const kept = new Set<string>();
  let budget = DOCUMENTS_TOTAL_TOKENS;
  for (const { id, tokens } of [...latest.values()].reverse()) {
    if (tokens > DOCUMENT_MAX_TOKENS || tokens > budget) continue;
    budget -= tokens;
    kept.add(id);
  }
  return kept;
}

function documentKey(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool === 'Read' && typeof input.file_path === 'string' && /\.(md|mdx|markdown)$/i.test(input.file_path)) {
    return `read:${input.file_path}`;
  }
  if (tool === 'Bash' && typeof input.command === 'string' && /\bcat\s[^|;&]*\.md\b/.test(input.command)) {
    return `bash:${input.command}`;
  }
  return undefined;
}

function resultText(messages: readonly Message[], id: string): string {
  for (const message of messages) for (const r of message.toolResults ?? []) if (r.tool_use_id === id) return r.text;
  return '';
}
