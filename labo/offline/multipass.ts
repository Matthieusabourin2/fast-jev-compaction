// v0.6 : passages Jev entre PASS et summarizeAt (refus entre deux passages trop rapprochés), rejoué hors ligne sur les vrais messages d'une session, avec la vraie API Jev.
// Entrée (multipass_input.py) : messages SessionMessage du segment, contexte d'origine avant chaque message, début de demande.
// À chaque début de demande où le contexte du monde rejoué atteint PASS : compact() sur l'état courant, puis rebuildAll,
// exactement comme le hook v2 en mode jev. Sortie : l'état final (à injecter) et le journal des passages.
// usage : TYPESAFE_API_KEY=… npx tsx labo/offline/multipass.ts <entrée.json> <sortie.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { estimateMessagesTokens, takeNotes } from '../../src/v2.js';
import { compactV2, gate, resolveHookConfig } from '../../hooks/fast-jev.js';
import type { Message } from '../../src/types.js';

const [input, output, resumeFile] = process.argv.slice(2);
const inp = JSON.parse(readFileSync(input, 'utf8')) as {
  msgs: Message[]; octxPrev: number[]; isPrompt: boolean[]; over: number; pass: number; ceil: number; window?: number;
};
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error('TYPESAFE_API_KEY manquant');
// la logique complète du hook v2 (plafond, tour en cours protégé, garde de remplissage, notes) ; le préfixe
// fixe et le seuil sont ceux de la session d'origine, le contexte est celui du monde rejoué
const config = { ...resolveHookConfig(JSON.parse(process.env.MP_OPTIONS ?? '{}')), apiKey };
const HANDOVER = Symbol('handover');
const fetchJev = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
  const res = await fetch(url, init);
  return { status: res.status, ok: res.ok, text: await res.text() };
};

// reprise après un résumé Claude réel (passage de relais) : état = résumé, position, taille mesurée
const resume = resumeFile ? JSON.parse(readFileSync(resumeFile, 'utf8')) as { at: number; state: Message[]; kept: number; passes: unknown[] } : undefined;
let state: Message[] = resume?.state ?? [];
let at = resume?.at ?? 0;
let kept: number | undefined = resume?.kept;
let previousLength: number | undefined;
const passes: unknown[] = resume?.passes ?? [];
const W = inp.window ?? 1_000_000;
let lastAfter: number | undefined;
let refusals = 0;
let summarized = false;
const open = new Set<string>();
for (let i = 1; i < inp.msgs.length; i++) {
  for (const u of inp.msgs[i - 1]!.toolUses) open.add(u.tool_use_id);
  for (const r of inp.msgs[i - 1]!.toolResults ?? []) open.delete(r.tool_use_id);
  if (i <= at) continue;
  const world = kept === undefined ? inp.octxPrev[i]! : inp.over + kept + inp.octxPrev[i]! - inp.octxPrev[at]!;
  // le vrai seuil se déclenche avant un appel au modèle : début de demande, ou appel suivant dans une boucle d'outils
  const callStart = inp.msgs[i]!.role === 'assistant' && inp.msgs[i - 1]!.role === 'user' && open.size === 0;
  if (summarized || !(inp.isPrompt[i] || callStart) || world < inp.pass) continue;
  const decided = gate({ trigger: 'auto', messages: [] } as never, world, W, lastAfter, config);
  if (decided.stage === 'skip') { refusals++; continue; }
  const before = state.concat(inp.msgs.slice(at, i));
  let handed: { messages: Message[]; instructions?: string } | undefined;
  const { result, journal } = await compactV2({ trigger: 'auto', messages: before } as never, config, {
    fetch: fetchJev,
    api: async () => [],
    transcript: async () => undefined,
    next: async (e: { messages: unknown; instructions?: string }) => {
      handed = { messages: e.messages as Message[], instructions: e.instructions };
      return HANDOVER as never;
    },
    usage: async () => ({ tokens: world, fixed: inp.over, threshold: inp.pass }),
    previousLength,
    stage: decided.stage as 'pass' | 'final',
  });
  if ((result as unknown) === HANDOVER) {
    // 600k atteints pour de vrai : plus de passage ; le dernier nettoyage et le résumé sont mesurés au point d'origine
    passes.push({ message: i, worldBefore: world, summarizeAt: true });
    console.log(`message ${i} : ${world} -> seuil de résumé atteint (dernier nettoyage au point d'origine)`);
    summarized = true;
    continue;
  }
  if ('skip' in (result as object) && (result as { skip?: string }).skip) {
    passes.push({ message: i, worldBefore: world, refused: (result as { skip: string }).skip });
    console.log(`message ${i} : ${world} -> passage refusé (${(result as { skip: string }).skip})`);
    lastAfter = world;
    continue;
  }
  state = (result as { messages: Message[] }).messages;
  previousLength = state.length;
  kept = journal!.contextAfter - inp.over;
  lastAfter = journal!.contextAfter;
  passes.push({ message: i, worldBefore: world, contextAfter: journal!.contextAfter, keptEstimate: estimateMessagesTokens(state), stats: journal!.stats });
  console.log(`passage ${passes.length} message ${i} : ${world} -> ~${journal!.contextAfter}`);
  at = i;
}
state = takeNotes(state).messages; // la note finale est posée à l'injection, avec la forme API complète
const final = state.concat(inp.msgs.slice(at));
const worldFinal = kept === undefined ? inp.octxPrev[inp.msgs.length - 1]! : inp.over + kept + inp.octxPrev[inp.msgs.length - 1]! - inp.octxPrev[at]!;
writeFileSync(output, JSON.stringify({ passes, refusals, worldFinal, finalEstimate: estimateMessagesTokens(final), messages: final }));
// dernier nettoyage forcé au point de compaction d'origine (choix de mesure : le résumé Claude d'origine tombait là)
let handed: { messages: Message[]; instructions?: string } | undefined;
await compactV2({ trigger: 'auto', messages: final } as never, config, {
  fetch: fetchJev, api: async () => [], transcript: async () => undefined,
  next: async (e: { messages: unknown; instructions?: string }) => { handed = { messages: e.messages as Message[], instructions: e.instructions }; return HANDOVER as never; },
  usage: async () => ({ tokens: worldFinal, fixed: inp.over, threshold: inp.pass }),
  previousLength, stage: 'final',
});
writeFileSync(output.replace(/\.json$/, '_final.json'), JSON.stringify({ handover: true, messages: handed!.messages, instructions: handed!.instructions, finalEstimate: estimateMessagesTokens(handed!.messages) }));
console.log(`refus : ${refusals} ; dernier nettoyage : ~${estimateMessagesTokens(handed!.messages)} tokens transmis au résumé Claude`);
console.log(`final : ${worldFinal} ; ${final.length} messages, ~${estimateMessagesTokens(final)} tokens de conversation`);
