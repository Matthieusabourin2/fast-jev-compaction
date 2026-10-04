// Plugin de labo : une compaction remplace la conversation par la liste de messages du fichier INJECT_FILE
// (sortie de multipass.ts), puis ajoute la note v2 (messages tapés en cours de tour, skills) lue dans la forme API.
import { compactionNote, handoverInstructions, insertNote, invokedSkills, queuedUserMessages } from '../src/v2.js';

export function register(on: any) {
  on('session.compact', async ($: any, e: any, next: any) => {
    const path = await $.env.get('INJECT_FILE');
    if (!path || e.agentId !== undefined) return next(e);
    const { messages, instructions, handover } = JSON.parse(await $.fs.read(path));
    // résumé Claude réel sur l'historique nettoyé, avec les règles de résumé du produit (src/v2.ts)
    const rules = (await $.env.get('RULES_FILE')) ? await $.fs.read(await $.env.get('RULES_FILE')) : handoverInstructions(undefined);
    if (handover) return next({ ...e, messages, instructions: rules });
    const api = await $.session.messages({ as: 'api' }).catch(() => []);
    const note = compactionNote(undefined, queuedUserMessages(api), invokedSkills(api, 4000));
    return { messages: insertNote(messages, note, 6) };
  });
}
