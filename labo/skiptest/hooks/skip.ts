// Labo : refuse toute compaction automatique et journalise chaque déclenchement.
export const register = (on: any) => {
  let i = 0;
  on('session.compact', async ($: any, event: any, next: any) => {
    const dir = await $.env.get('SKIP_LOG');
    if (!dir) return next(event);
    const u = await $.session.usage().catch(() => null);
    i += 1;
    await $.fs.write(`${dir}/${Date.now()}-${String(i).padStart(3, "0")}-${event.trigger}.json`, JSON.stringify({ t: new Date().toISOString(), trigger: event.trigger, agentId: event.agentId ?? null, n: event.messages.length, context: u?.context ?? null })).catch(() => {});
    if (event.trigger === 'auto' || event.trigger === 'precompute') return { skip: 'labo: refus de compaction' };
    return next(event);
  });
};
