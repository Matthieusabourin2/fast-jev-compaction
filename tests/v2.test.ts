import { describe, expect, it } from 'vitest';
import { compactV2, gate, resolveHookConfig } from '../hooks/fast-jev.ts';
import { compact } from '../src/compact.js';
import { compactionNote, documentReads, handoverInstructions, insertNote, invokedSkills, queuedUserMessages, rebuildAll, takeNotes, transcriptPath } from '../src/v2.js';
import type { JevAsker, Message } from '../src/index.js';

type SM = Message & { handle?: string };
const msg = (role: Message['role'], text: string, extra: Partial<SM> = {}): SM => ({ role, text, toolUses: [], handle: `h-${text.slice(0, 8)}`, ...extra });
const call = (id: string, tool: string, out: string): SM[] => [
  msg('assistant', '', { toolUses: [{ tool_use_id: id, tool, input: { q: id }, text: out }], handle: `a-${id}` }),
  msg('user', '', { toolResults: [{ tool_use_id: id, text: out, isError: false }], handle: `u-${id}` }),
];

function transcript(): SM[] {
  return [
    msg('user', 'Prépare le devis. Ne touche pas au dossier client.'),
    msg('assistant', ''), // ligne de réflexion seule : vide pour le hook
    ...call('t-read', 'Read', 'x'.repeat(5000)),
    ...call('t-ask', 'AskUserQuestion', 'Réponse : option B, budget 12 k€'),
    ...call('t-agent', 'Agent', 'Rapport du sous-agent : 3 fournisseurs'),
    ...call('t-bash', 'Bash', 'ok'),
    msg('assistant', 'Devis prêt.'),
    msg('user', 'Envoie-le demain.'),
    msg('assistant', 'Noté.'),
    msg('user', 'Merci'),
    msg('assistant', 'Avec plaisir.'),
    msg('user', 'Dernière chose'),
    msg('assistant', 'Oui ?'),
  ];
}

const dropAll: JevAsker = {
  async ask(_state, questions) {
    return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: 0 }])) } as never;
  },
};

function jevFetch(answer = 0) {
  return async (_url: string, init?: { body?: string }) => {
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: answer }]));
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

const api = [
  { role: 'user' as const, content: [{ type: 'text', text: '<system-reminder>\nThe user sent a new message while you were working:\nAjoute la TVA à 20 %.\n\nThis is how Claude Code surfaces messages the user sends mid-turn.</system-reminder>' }] },
  { role: 'user' as const, content: [{ type: 'text', text: '<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nbackground task done</system-reminder>' }] },
];

describe('rebuildAll', () => {
  it('regroups the rows of parallel tool calls so each call is followed by its result', () => {
    const rows: SM[] = [msg('user', 'Lis les annexes.'),
      ...['a', 'b', 'c'].map((id) => msg('assistant', '', { toolUses: [{ tool_use_id: id, tool: 'Read', input: {}, text: 'x' }], handle: `a-${id}` })),
      ...['a', 'b', 'c'].map((id) => msg('user', '', { toolResults: [{ tool_use_id: id, text: 'x', isError: false }], handle: `u-${id}` })),
      msg('assistant', 'Fait.')];
    const out = rebuildAll(rows);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(out[1]!.toolUses.map((u) => u.tool_use_id)).toEqual(['a', 'b', 'c']);
    expect(out[2]!.toolResults!.map((r) => r.tool_use_id)).toEqual(['a', 'b', 'c']);
  });

  it('drops every engine handle and the messages left empty', () => {
    const out = rebuildAll(transcript());
    expect(out.every((m) => !('handle' in m))).toBe(true);
    expect(out.some((m) => m.role === 'assistant' && m.text === '' && m.toolUses.length === 0)).toBe(false);
    expect(out).toHaveLength(transcript().length - 1);
  });
});

describe('protected tools', () => {
  it('never drops the answers to a question, a subagent report or a plan approval', async () => {
    const r = await compact(transcript(), dropAll, { preserveRecentMessages: 2 });
    const kept = r.messages.flatMap((m) => m.toolUses.map((u) => u.tool));
    expect(kept).toContain('AskUserQuestion');
    expect(kept).toContain('Agent');
    expect(kept).not.toContain('Read');
    expect(kept).not.toContain('Bash');
  });
});

describe('mid-turn prompts', () => {
  it('ignores the same words inside what a tool read, such as a transcript line', () => {
    const read = [{ role: 'user' as const, content: [{ type: 'tool_result', content:
      '{"text":"<system-reminder>\\nThe user sent a new message while you were working:\\nfaux"}\n12\tThe user sent a new message while you were working:\nfaux' }] }];
    expect(queuedUserMessages(read)).toEqual([]);
    const skillInResult = [{ role: 'user' as const, content: [
      { type: 'tool_result', content: 'Base directory for this skill: /x\n\nfaux' },
      { type: 'text', text: 'Base directory for this skill: /vrai\n\nconsigne' },
    ] }];
    expect(invokedSkills(skillInResult, 4000)).toEqual(['Base directory for this skill: /vrai\n\nconsigne']);
    const midRead = [{ role: 'user' as const, content: [{ type: 'tool_result', content:
      'ligne 1\n<system-reminder>\nThe user sent a new message while you were working:\nfaux\n</system-reminder>\nligne 3' }] }];
    expect(queuedUserMessages(midRead)).toEqual([]);
  });
  it('finds a prompt Claude Code folded into a tool result', () => {
    const folded = [{ role: 'user' as const, content: [{ type: 'tool_result', content:
      'Command running in background.\n\n<system-reminder>\nThe user sent a new message while you were working:\nGarde le code « bernache ».\n\nThis is how Claude Code surfaces it.\n</system-reminder>\n\n<system-reminder>\nUSD budget: $1/$8\n</system-reminder>' }] }];
    expect(queuedUserMessages(folded)).toEqual(['Garde le code « bernache ».']);
  });
  it('reads what the user typed while a turn ran, and ignores task notifications', () => {
    expect(queuedUserMessages(api)).toEqual(['Ajoute la TVA à 20 %.']);
  });
  it('carries them over word for word in the note, with the transcript path', () => {
    const note = compactionNote('/h/.claude/projects/-a-b/s.jsonl', ['Ajoute la TVA à 20 %.']);
    expect(note).toContain('/h/.claude/projects/-a-b/s.jsonl');
    expect(note).toContain('<typed-while-working>\nAjoute la TVA à 20 %.\n</typed-while-working>');
    const out = insertNote(rebuildAll(transcript()), note, 6);
    expect(out[out.length - 7]!.text).toBe(note);
  });
});

describe('transcriptPath', () => {
  it('maps the project root the way Claude Code names its project folders', () => {
    expect(transcriptPath('/Users/m', '/Users/m/Documents/my app', 'abc')).toBe('/Users/m/.claude/projects/-Users-m-Documents-my-app/abc.jsonl');
  });
});

describe('compactV2', () => {
  const config = { ...resolveHookConfig({}), apiKey: 'k', preserveRecentMessages: 2 };
  const deps = (nextLog: unknown[]) => ({
    fetch: jevFetch(0),
    api: async () => api,
    transcript: async () => '/t.jsonl',
    usage: async () => undefined,
    stage: 'pass' as 'pass' | 'final',
    next: async (e: unknown) => {
      nextLog.push(e);
      return { messages: [] };
    },
  });

  it('leaves subagents to the native summary, untouched', async () => {
    for (const event of [{ trigger: 'auto', agentId: 'a1', messages: transcript() }]) {
      const seen: unknown[] = [];
      const { journal } = await compactV2(event as never, config, deps(seen));
      expect(seen).toEqual([event]);
      expect(journal).toBeUndefined();
    }
  });

  it('answers itself with rebuilt messages, the note and the mid-turn prompt', async () => {
    const seen: unknown[] = [];
    const { result, journal } = await compactV2({ trigger: 'auto', messages: transcript() } as never, config, deps(seen));
    expect(seen).toHaveLength(0);
    const messages = (result as { messages: SM[] }).messages;
    expect(messages.every((m) => !('handle' in m))).toBe(true);
    expect(messages.some((m) => m.text.includes('Ajoute la TVA à 20 %.'))).toBe(true);
    expect(messages.some((m) => m.text.includes('/t.jsonl'))).toBe(true);
    expect(journal?.mode).toBe('jev');
  });

  it('measures the context left in real tokens, and the final stage hands over to Claude', async () => {
    // contexte réel 300k dont 90k de partie fixe : la conversation réelle pèse 210k pour l'estimation avant
    const big = { tokens: 300_000, fixed: 90_000, threshold: 300_000 };
    const kept = await compactV2({ trigger: 'auto', messages: transcript() } as never, config, { ...deps([]), usage: async () => big });
    expect(kept.journal?.mode).toBe('jev');
    expect(kept.journal?.contextAfter).toBeGreaterThan(90_000);
    expect(kept.journal?.contextAfter).toBeLessThan(0.7 * 300_000);
    const seen: Array<{ messages: SM[]; instructions: string }> = [];
    const full = { tokens: 300_000, fixed: 260_000, threshold: 300_000 };
    const { journal } = await compactV2(
      { trigger: 'manual', instructions: 'focus devis', messages: transcript() } as never,
      config,
      { ...deps(seen as unknown[]), usage: async () => full, stage: 'final' as const },
    );
    expect(journal?.mode).toBe('handover');
    expect(seen[0]!.messages.every((m) => !('handle' in m))).toBe(true);
    expect(seen[0]!.instructions).toContain('focus devis');
    expect(seen[0]!.instructions).toContain('word for word');
  });

  it('keeps every tool result of the turn in progress during a pass in the middle of a tool loop', async () => {
    const midLoop = [...transcript(), ...call('old', 'Bash', 'z'.repeat(200000)), msg('assistant', 'Vu.'), msg('user', 'Lis les quatre annexes.'), ...call('r1', 'Read', 'a'.repeat(20000)),
      ...call('r2', 'Read', 'b'.repeat(20000)), ...call('r3', 'Read', 'c'.repeat(20000))];
    const { result, journal } = await compactV2({ trigger: 'auto', messages: midLoop } as never, config, deps([]));
    expect(journal?.mode).toBe('jev');
    const kept = (result as { messages: SM[] }).messages.flatMap((m) => m.toolUses.map((u) => u.tool_use_id));
    expect(kept).toEqual(expect.arrayContaining(['r1', 'r2', 'r3']));
    expect(kept).not.toContain('old');
  });

  it('cleans the older part of a turn in progress that outgrows the ceiling', async () => {
    const reads = Array.from({ length: 8 }, (_, k) => call(`r${k}`, 'Read', String(k).repeat(40000))).flat();
    const longTurn = [...transcript(), msg('user', 'Lis tout.'), ...reads];
    const usage = async () => ({ tokens: 300_000, fixed: 20_000, threshold: 300_000 });
    const { result, journal } = await compactV2({ trigger: 'auto', messages: longTurn } as never, config, { ...deps([]), usage });
    expect(journal?.mode).toBe('jev');
    const kept = (result as { messages: SM[] }).messages.flatMap((m) => m.toolUses.map((u) => u.tool_use_id));
    expect(kept).toContain('r7');
    expect(kept).not.toContain('r0');
  });

  it('refuses a pass when the context refilled within three calls of the previous pass', async () => {
    const first = await compactV2({ trigger: 'auto', messages: transcript() } as never, config, deps([]));
    const kept = (first.result as { messages: SM[] }).messages;
    const quick = [...kept, ...call('q1', 'Read', 'q'.repeat(90000)), ...call('q2', 'Read', 'r'.repeat(90000))];
    const seen: unknown[] = [];
    const again = await compactV2({ trigger: 'auto', messages: quick } as never, config, { ...deps(seen), previousLength: kept.length });
    expect(again.journal?.mode).toBe('skip');
    expect(again.journal?.reason).toContain('refilled');
    expect(seen).toHaveLength(0);
    const slow = [...kept, ...['s1', 's2', 's3', 's4'].flatMap((id) => call(id, 'Read', id.repeat(30000)))];
    const usage = async () => ({ tokens: 300_000, fixed: 20_000, threshold: 300_000 });
    const later = await compactV2({ trigger: 'auto', messages: slow } as never, config, { ...deps([]), usage, previousLength: kept.length });
    expect(later.journal?.reason).toBeUndefined();
    expect(later.journal?.mode).toBe('jev');
  });

  it('carries the prompts and skills of an earlier note into a single new note', async () => {
    const skillApi = [...api, { role: 'user' as const, content: [{ type: 'text', text: 'Base directory for this skill: /s/devis\n\nToujours en HT.' }] }];
    const multi = [{ role: 'user' as const, content: [{ type: 'tool_result', content:
      'ok\n\n<system-reminder>\nThe user sent a new message while you were working:\nLigne 1\nLigne 2\n\nThis is how Claude Code surfaces it.\n</system-reminder>' }] }];
    const first = await compactV2({ trigger: 'auto', messages: transcript() } as never, config,
      { ...deps([]), api: async () => [...skillApi, ...multi] });
    const after = [...(first.result as { messages: SM[] }).messages, msg('user', 'Nouvelle demande'), msg('assistant', 'Fait.'),
      ...call('t-2', 'Bash', 'y'.repeat(60000)), msg('assistant', 'Fini.'), msg('user', 'Suite'), msg('assistant', 'Oui.'),
      msg('user', 'Encore'), msg('assistant', 'Voilà.')];
    const second = await compactV2({ trigger: 'auto', messages: after } as never, config, { ...deps([]), api: async () => [] });
    const notes = (second.result as { messages: SM[] }).messages.filter((m) => m.text.startsWith('[fast-jev-compaction]'));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain('Ajoute la TVA à 20 %.');
    expect(notes[0]!.text).toContain('Ligne 1\nLigne 2');
    expect(notes[0]!.text).toContain('Toujours en HT.');
    expect(second.journal?.queued).toBe(2);
    expect(second.journal?.skills).toBe(1);
  });

  it('at the final stage, still cleans and hands over when Jev fails or the key is missing', async () => {
    const seen: Array<{ messages: SM[] }> = [];
    const { journal } = await compactV2({ trigger: 'auto', messages: transcript() } as never, { ...config, apiKey: undefined }, { ...deps(seen as unknown[]), stage: 'final' as const });
    expect(journal?.mode).toBe('handover');
    expect(journal?.reason).toContain('TYPESAFE_API_KEY');
    expect(seen[0]!.messages.every((m) => !('handle' in m))).toBe(true);
  });
});

describe('documents the session works from', () => {
  it('keeps the latest read of each Markdown document within the budget, and leaves code and logs to Jev', async () => {
    const read = (id: string, input: Record<string, unknown>, tool = 'Read', out = 'contenu') => [
      msg('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text: out }], handle: `a-${id}` }),
      msg('user', '', { toolResults: [{ tool_use_id: id, text: out, isError: false }], handle: `u-${id}` }),
    ];
    const msgs = [msg('user', 'Reprends le dossier.'),
      ...read('brief1', { file_path: '/p/state/handoff.md' }), ...read('state', { command: 'cat STATE.md && ls' }, 'Bash'),
      ...read('code', { file_path: '/p/src/app.ts' }), ...read('huge', { file_path: '/p/notes.md' }, 'Read', 'n'.repeat(60000)),
      ...read('brief2', { file_path: '/p/state/handoff.md' }), msg('assistant', 'Lu.')];
    const ids = documentReads(msgs);
    expect([...ids].sort()).toEqual(['brief2', 'state']);
    const longer = [...msgs, ...Array.from({ length: 10 }, (_, k) => [msg('user', `Étape ${k}`), msg('assistant', 'ok')]).flat()];
    const { result } = await compactV2({ trigger: 'auto', messages: longer } as never, { ...resolveHookConfig({}), apiKey: 'k', preserveRecentMessages: 2 },
      { fetch: jevFetch(0), api: async () => [], transcript: async () => undefined, next: async () => ({ messages: [] }), usage: async () => undefined });
    const kept = (result as { messages: SM[] }).messages.flatMap((m) => m.toolUses.map((u) => u.tool_use_id));
    expect(kept).toEqual(expect.arrayContaining(['brief2', 'state']));
    expect(kept).not.toContain('code');
    expect(kept).not.toContain('brief1');
  });
});

describe('note placement', () => {
  it('never puts the note between a tool call and its result', () => {
    const m = (role: 'user' | 'assistant', text: string, use?: string, res?: string) => ({
      role, text, toolUses: use ? [{ tool_use_id: use, tool: 'Bash', input: {} }] : [],
      ...(res ? { toolResults: [{ tool_use_id: res, text: 'ok', isError: false }] } : {}),
    });
    const msgs = [m('user', 'go'), m('assistant', '', 'a'), m('assistant', '', 'b'), m('user', '', undefined, 'a'),
      m('user', '', undefined, 'b'), m('assistant', '', 'c'), m('user', '', undefined, 'c'), m('assistant', 'Terminé')];
    for (let preserve = 0; preserve < msgs.length; preserve++) {
      const out = insertNote(msgs as never, 'NOTE', preserve);
      const i = out.findIndex((x) => x.text === 'NOTE');
      const open = new Set<string>();
      for (const x of out.slice(0, i)) {
        x.toolUses.forEach((u) => open.add(u.tool_use_id));
        (x.toolResults ?? []).forEach((r) => open.delete(r.tool_use_id));
      }
      expect(open.size, `preserve ${preserve}`).toBe(0);
      expect(out[i + 1]?.toolResults ?? []).toHaveLength(0);
    }
  });
});

describe('invoked skills', () => {
  const skill = (dir: string, body: string) => ({ role: 'user' as const, content: [{ type: 'text', text: `Base directory for this skill: ${dir}\n\n${body}` }] });
  it('keeps the latest copy of each skill and points to SKILL.md when a body is too long', () => {
    const out = invokedSkills([skill('/s/a', 'v1'), skill('/s/b', 'x'.repeat(40000)), skill('/s/a', 'v2')], 4000);
    expect(out).toHaveLength(2);
    expect(out[1]).toContain('v2');
    expect(out[0]).toContain('/s/b/SKILL.md');
    expect(compactionNote(undefined, [], out)).toContain('still in force');
  });
});

describe('gate: clean between the trigger and summarizeAt, summarize only at summarizeAt', () => {
  const config = resolveHookConfig({});
  const W = 1_000_000;
  const auto = { trigger: 'auto', messages: [] };

  it('passes the first time the trigger is crossed, then refuses until the context has grown enough', () => {
    expect(gate(auto as never, 305_000, W, undefined, config).stage).toBe('pass');
    expect(gate(auto as never, 330_000, W, 180_000, config).stage).toBe('pass');
    const refused = gate(auto as never, 260_000, W, 180_000, config);
    expect(refused.stage).toBe('skip');
    expect(refused.reason).toMatch(/fast-jev/);
  });

  it('does the final clean and hands over to Claude at summarizeAt, and above the hard cap whatever happened before', () => {
    expect(gate(auto as never, 600_000, W, 590_000, config).stage).toBe('final');
    expect(gate(auto as never, 860_000, W, undefined, { ...config, summarizeAtPercent: 95 }).stage).toBe('final');
  });

  it('leaves subagents to Claude, refuses precompute, and treats /compact as the final clean', () => {
    expect(gate({ ...auto, agentId: 'a' } as never, 400_000, W, undefined, config).stage).toBe('native');
    expect(gate({ trigger: 'precompute', messages: [] } as never, 400_000, W, undefined, config).stage).toBe('skip');
    expect(gate({ trigger: 'manual', messages: [] } as never, 100_000, W, undefined, config).stage).toBe('final');
  });

  it('falls back to the final clean when the context size is unknown', () => {
    expect(gate(auto as never, undefined, undefined, undefined, config).stage).toBe('final');
  });
});

describe('compactV2 stages', () => {
  const config = { ...resolveHookConfig({}), apiKey: 'k', preserveRecentMessages: 2 };
  const base = (seen: unknown[]) => ({
    fetch: jevFetch(0), api: async () => api, transcript: async () => '/t.jsonl', usage: async () => undefined, stage: 'pass' as 'pass' | 'final',
    next: async (e: unknown) => { seen.push(e); return { messages: [] }; },
  });

  it('a pass removes and never summarizes, even when much context is left', async () => {
    const seen: unknown[] = [];
    const usage = async () => ({ tokens: 450_000, fixed: 400_000, threshold: 300_000 });
    const { result, journal } = await compactV2({ trigger: 'auto', messages: transcript() } as never, config, { ...base(seen), usage, stage: 'pass' });
    expect(seen).toHaveLength(0);
    expect(journal?.mode).toBe('jev');
    expect((result as { messages: SM[] }).messages.length).toBeGreaterThan(0);
  });

  it('a pass that cannot remove enough, or whose Jev call failed, refuses instead of summarizing', async () => {
    const seen: unknown[] = [];
    const keepAll = await compactV2({ trigger: 'auto', messages: transcript() } as never, config, { ...base(seen), fetch: jevFetch(1), stage: 'pass' });
    expect(keepAll.result).toEqual({ skip: expect.stringContaining('fast-jev') });
    const noKey = await compactV2({ trigger: 'auto', messages: transcript() } as never, { ...config, apiKey: undefined }, { ...base(seen), stage: 'pass' });
    expect(noKey.result).toEqual({ skip: expect.stringContaining('TYPESAFE_API_KEY') });
    expect(seen).toHaveLength(0);
  });

  it('the final stage cleans then always hands the cleaned history to Claude', async () => {
    const seen: Array<{ messages: SM[]; instructions: string }> = [];
    const { journal } = await compactV2({ trigger: 'auto', messages: transcript() } as never, config, { ...base(seen as unknown[]), stage: 'final' });
    expect(journal?.mode).toBe('handover');
    expect(seen[0]!.messages.some((m) => m.toolUses.some((u) => u.tool === 'Read'))).toBe(false);
    expect(seen[0]!.instructions).toContain('word for word');
  });
});

describe('final stage: Claude summarizes with the summary rules', () => {
  it('hands Claude\'s summary through unchanged, with the summary rules', async () => {
    const config = { ...resolveHookConfig({}), apiKey: 'k', preserveRecentMessages: 2 };
    const summary = { messages: [{ role: 'user', text: 'Résumé.', toolUses: [] }] };
    const seen: Array<{ instructions: string }> = [];
    const { result } = await compactV2({ trigger: 'auto', messages: transcript() } as never, config, {
      fetch: jevFetch(0), api: async () => api, transcript: async () => '/t.jsonl', usage: async () => undefined, stage: 'final',
      next: async (e: unknown) => { seen.push(e as { instructions: string }); return summary; },
    });
    expect(result).toBe(summary);
    expect(seen[0]!.instructions).toBe(handoverInstructions(undefined));
  });

  it('asks for the seven sections in order, and lets the user\'s /compact text override the plan', () => {
    const rules = handoverInstructions('drop everything about the demo');
    const at = ['1. Goal', '2. All user messages', '3. Standing instructions', '4. Exact facts', '5. Decisions', '6. Work done', '7. Open items']
      .map((section) => rules.indexOf(section));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(rules).toContain('never drop section 7');
    expect(rules.indexOf('drop everything about the demo')).toBeGreaterThan(at[6]!);
    expect(rules).toContain('take precedence over the plan above');
  });

  it('keeps the user\'s words carried by a note from v0.6.1–0.6.2 when a later pass merges the notes', () => {
    const note = compactionNote(undefined, [], [], ['Toujours en HT.']);
    const merged = takeNotes([msg('user', note), msg('user', 'Suite'), msg('assistant', 'Oui')]);
    expect(merged.said).toEqual(['Toujours en HT.']);
    expect(merged.messages).toHaveLength(2);
  });
});

describe('labo copies', () => {
  it('run the same src/ as the shipped plugin, so the benchmark measures the shipped rules', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    for (const copy of ['labo/inject/src', 'labo/rules/src']) {
      for (const file of readdirSync('src')) expect(readFileSync(`${copy}/${file}`, 'utf8'), `${copy}/${file}`).toBe(readFileSync(`src/${file}`, 'utf8'));
    }
  });
});
