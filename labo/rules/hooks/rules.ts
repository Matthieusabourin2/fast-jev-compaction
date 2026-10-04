// Plugin de labo « règles seules, sans Jev » : la compaction native de Claude Code, messages intacts (handles compris),
// avec les règles de résumé du produit (src/v2.ts).
import { handoverInstructions } from '../src/v2.js';

export function register(on: any) {
  on('session.compact', async ($: any, e: any, next: any) => {
    if (e.agentId !== undefined) return next(e);
    const file = await $.env.get('RULES_FILE');
    return next({ ...e, instructions: file ? await $.fs.read(file) : handoverInstructions(e.instructions) });
  });
}
