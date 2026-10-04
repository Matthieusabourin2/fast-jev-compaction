// Exécuteur hors ligne : rejoue compact() sur une liste SessionMessage (JSON) avec la vraie API Jev,
// et écrit l'état envoyé, les questions, les réponses, les décisions et les statistiques.
// usage : TYPESAFE_API_KEY=… npx tsx labo/offline/run.ts <messages.json> <sortie.json> [options JSON]
import { readFileSync, writeFileSync } from 'node:fs';
import { compact, reductionRatio } from '../../src/compact.js';
import { buildJevRequest, parseJevResponse } from '../../src/request.js';
import type { JevAsker, Message } from '../../src/types.js';

const [input, output, optsJson] = process.argv.slice(2);
const messages: Message[] = JSON.parse(readFileSync(input, 'utf8'));
const options = { keepThreshold: 0.65, ...(optsJson ? JSON.parse(optsJson) : {}) };
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error('TYPESAFE_API_KEY manquant');
const model = options.model ?? 'jev-latest';
const calls: unknown[] = [];

const asker: JevAsker = {
  async ask(state, questions) {
    const req = buildJevRequest({ apiKey, model }, state, questions);
    const t0 = Date.now();
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
    const text = await res.text();
    const parsed = parseJevResponse(res.status, res.ok, text);
    let usage: unknown;
    try { usage = JSON.parse(text).usage; } catch { usage = undefined; }
    calls.push({ ms: Date.now() - t0, stateChars: JSON.stringify(state).length, questions: Object.keys(questions).length, usage });
    return parsed;
  },
};

const t0 = Date.now();
const result = await compact(messages, asker, options);
const keptChars = (ms: Message[]) => ms.reduce((n, m) => n + (m.text?.length ?? 0)
  + (m.toolUses ?? []).reduce((k, u) => k + JSON.stringify(u.input ?? {}).length + (u.text?.length ?? 0), 0)
  + (m.toolResults ?? []).reduce((k, r) => k + (r.text?.length ?? 0), 0), 0);
writeFileSync(output, JSON.stringify({
  ms: Date.now() - t0, reduction: reductionRatio(result), stats: result.stats, calls,
  charsBefore: keptChars(messages), charsAfter: keptChars(result.messages),
  decisions: result.decisions, messagesAfter: result.messages,
}, null, 1));
console.log(JSON.stringify({ reduction: reductionRatio(result), requests: calls.length, stats: result.stats }));
