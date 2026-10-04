// compaction-probe : instrument de mesure, inerte hors d'un dossier dont le chemin contient « labo-compaction ».
// Écrit un fichier JSON par observation dans <cwd>/.probe/ (pas d'append dans l'API $.fs).
// Déclencheur expérimental : un fichier <cwd>/.probe/trigger contenant « turn.complete » ou « prompt.submit »
// fait appeler $.session.compact() depuis cet événement (une fois), pour tester ce qui marche sur chaque surface.

const CANARY = /CANARI-\d\d/g;
let seq = 0;
let cwdCache: string | undefined;

async function labo($: any): Promise<string | undefined> {
  if (cwdCache === undefined) cwdCache = await $.session.cwd();
  return cwdCache && cwdCache.includes('labo-compaction') ? cwdCache : undefined;
}

async function log($: any, kind: string, data: unknown) {
  const cwd = await labo($);
  if (!cwd) return;
  const ts = new Date().toISOString();
  const name = `${ts.replace(/[:.]/g, '-')}-${String(seq++).padStart(5, '0')}-${kind}.json`;
  try {
    await $.fs.write(`${cwd}/.probe/${name}`, JSON.stringify({ ts, kind, ...(data as object) }, null, 1));
  } catch (err) {
    $.ui.log(`probe: write failed ${String(err)}`);
  }
}

function canaries(text: string): string[] {
  return [...new Set(text.match(CANARY) ?? [])].sort();
}

function blockText(b: any): string {
  if (b.type === 'text') return b.text ?? '';
  if (b.type === 'thinking') return b.thinking ?? '';
  if (b.type === 'redacted_thinking') return b.data ?? '';
  if (b.type === 'tool_use') return JSON.stringify(b.input ?? {});
  if (b.type === 'tool_result') {
    const c = b.content;
    return typeof c === 'string' ? c : Array.isArray(c) ? c.map(blockText).join('\n') : JSON.stringify(c ?? '');
  }
  if (b.type === 'image' || b.type === 'document') return '';
  return JSON.stringify(b);
}

// Forme API exacte de la conversation : ce que la requête suivante enverra (hors prompt système et outils).
async function apiSnapshot($: any, agentId?: string) {
  const msgs = agentId ? await $.session.messages({ as: 'api', agentId }) : await $.session.messages({ as: 'api' });
  if (!Array.isArray(msgs)) return { deny: msgs?.deny };
  const byType: Record<string, { n: number; chars: number }> = {};
  const found: Record<string, string[]> = {};
  msgs.forEach((m: any, i: number) => {
    for (const b of m.content ?? []) {
      const t = `${m.role}:${b.type}`;
      const txt = blockText(b);
      byType[t] ??= { n: 0, chars: 0 };
      byType[t].n++;
      byType[t].chars += txt.length;
      for (const c of canaries(txt)) (found[c] ??= []).push(`${i}:${t}`);
    }
  });
  const snippets: Record<string, unknown> = {};
  for (const [c, where] of Object.entries(found)) {
    const i = Number(where[0]!.split(':')[0]);
    snippets[c] = msgs[i];
  }
  return { messages: msgs.length, byType, canaries: found, snippets };
}

function summarizeSessionMessages(messages: readonly any[]) {
  const found: Record<string, string[]> = {};
  let withHandle = 0;
  const rows = messages.map((m, i) => {
    if (m.handle) withHandle++;
    const parts: [string, string][] = [['text', m.text ?? '']];
    for (const u of m.toolUses ?? []) parts.push([`tool_use:${u.tool}`, JSON.stringify(u.input ?? {}) + (u.text ?? '')]);
    for (const r of m.toolResults ?? []) parts.push(['tool_result', r.text ?? '']);
    for (const [k, t] of parts) for (const c of canaries(t)) (found[c] ??= []).push(`${i}:${m.role}:${k}`);
    return { i, role: m.role, handle: !!m.handle, textChars: (m.text ?? '').length, toolUses: (m.toolUses ?? []).length, toolResults: (m.toolResults ?? []).length };
  });
  return { count: messages.length, withHandle, canaries: found, rows };
}

async function usage($: any) {
  try {
    const u = await $.session.usage({ breakdown: 'full' });
    const b = u.context?.breakdown;
    return {
      tokens: u.context?.tokens, window: u.context?.window, percent: u.context?.percent,
      breakdown: b && {
        totalTokens: b.totalTokens, rawMaxTokens: b.rawMaxTokens, autoCompactThreshold: b.autoCompactThreshold,
        isAutoCompactEnabled: b.isAutoCompactEnabled, autocompactSource: b.autocompactSource,
        categories: b.categories?.map((c: any) => ({ name: c.name, kind: c.kind, tokens: c.tokens })),
        memoryFiles: b.memoryFiles?.map((f: any) => ({ path: f.path, tokens: f.tokens })),
        apiUsage: b.apiUsage,
      },
    };
  } catch (err) {
    return { error: String(err) };
  }
}

async function readFile($: any, name: string): Promise<string | undefined> {
  const cwd = await labo($);
  if (!cwd) return undefined;
  try {
    return (await $.fs.read(`${cwd}/.probe-ctl/${name}`)).trim();
  } catch {
    return undefined;
  }
}

const readTrigger = ($: any) => readFile($, 'trigger');

async function tryCompact($: any, from: string) {
  const t = await readTrigger($);
  if (t !== from) return;
  const cwd = await labo($);
  await $.fs.write(`${cwd}/.probe-ctl/trigger`, `done:${from}`);
  try {
    const r = await $.session.compact({ instructions: `probe trigger from ${from}` });
    await log($, 'trigger-result', { from, ok: true, skip: r?.skip, messages: r?.messages?.length, tokensBefore: r?.tokensBefore, tokensAfter: r?.tokensAfter });
  } catch (err) {
    await log($, 'trigger-result', { from, ok: false, error: String(err) });
  }
}

export function register(on: any) {
  on('session.start', async ($: any, e: any, next: any) => {
    cwdCache = undefined;
    if (!(await labo($))) return next(e);
    const surfaces = await $.session.surfaces().catch(() => []);
    await log($, 'session.start', { cwd: e.cwd, surface: e.surface, isInteractive: e.isInteractive, surfaces });
    return next(e);
  });

  on('prompt.submit', async ($: any, e: any, next: any) => {
    if (!(await labo($))) return next(e);
    await log($, 'prompt.submit', { origin: e.origin, text: String(e.text ?? '').slice(0, 300), canaries: canaries(String(e.text ?? '')) });
    const r = await next(e);
    await tryCompact($, 'prompt.submit');
    return r;
  });

  on('turn.start', async ($: any, e: any, next: any) => {
    if (!(await labo($))) return next(e);
    await log($, 'turn.start', { e: JSON.stringify(e).slice(0, 500) });
    return next(e);
  });

  on('turn.complete', async ($: any, e: any, next: any) => {
    if (!(await labo($))) return next(e);
    const r = await next(e);
    await log($, 'turn.complete', { agentId: e.agentId, e: JSON.stringify(e).slice(0, 500), usage: e.agentId ? undefined : await usage($), api: await apiSnapshot($, e.agentId) });
    if (!e.agentId) await tryCompact($, 'turn.complete');
    return r;
  });

  on('session.append', async ($: any, e: any, next: any) => {
    if (!(await labo($))) return next(e);
    const m = e.message ?? {};
    const blocks = (m.content ?? []).map((b: any) => ({ type: b.type, chars: blockText(b).length }));
    const text = (m.content ?? []).map(blockText).join('\n');
    await log($, 'session.append', {
      agentId: e.agentId, door: e.door, origin: e.origin?.kind, type: m.type, name: m.name, role: m.role, isMeta: m.isMeta,
      blocks, canaries: canaries(text), head: text.slice(0, 160),
    });
    return next(e);
  });

  on('session.compact', async ($: any, e: any, next: any) => {
    if (!(await labo($))) return next(e);
    const t0 = Date.now();
    await log($, 'compact.in', {
      trigger: e.trigger, agentId: e.agentId, instructions: e.instructions,
      input: summarizeSessionMessages(e.messages ?? []),
      api: await apiSnapshot($, e.agentId), usage: e.agentId ? undefined : await usage($),
    });
    const mode = await readFile($, 'compact-mode');
    if ((mode === 'rebuild' || mode === 'hybrid') && !e.agentId) {
      const all = e.messages ?? [];
      const keepFrom = mode === 'hybrid' ? Math.max(0, all.length - 6) : all.length;
      const rebuilt = all.map((m: any, i: number) => {
        if (i >= keepFrom) return m;
        const out: any = { role: m.role, text: m.text ?? '', toolUses: (m.toolUses ?? []).map((u: any) => ({ tool_use_id: u.tool_use_id, tool: u.tool, input: u.input, ...(u.text !== undefined ? { text: u.text } : {}), ...(u.isError ? { isError: true } : {}) })) };
        if (m.toolResults?.length) out.toolResults = m.toolResults.map((r: any) => ({ tool_use_id: r.tool_use_id, text: r.text ?? '', isError: !!r.isError }));
        return out;
      });
      await log($, 'compact.rebuild', { mode, trigger: e.trigger, count: rebuilt.length, keptWithHandle: all.length - keepFrom });
      return { messages: rebuilt };
    }
    if (mode === 'identity' && !e.agentId) {
      await log($, 'compact.identity', { trigger: e.trigger, count: (e.messages ?? []).length });
      return { messages: e.messages };
    }
    const r = await next(e);
    await log($, 'compact.out', {
      trigger: e.trigger, agentId: e.agentId, ms: Date.now() - t0, skip: r?.skip,
      tokensBefore: r?.tokensBefore, tokensAfter: r?.tokensAfter, usage: r?.usage,
      output: r?.messages ? summarizeSessionMessages(r.messages) : undefined,
      outputText: r?.messages ? r.messages.map((m: any) => `[${m.role}] ${m.text}`).join('\n').slice(0, 20000) : undefined,
    });
    return r;
  });
}
