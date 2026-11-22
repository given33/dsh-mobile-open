// A narrow compatibility fix for the official workspace-changes recorder in these
// Harness builds. Its record() already returns without doing anything if the turn
// has no tool result; stopping() nevertheless queues that no-op *behind* its Git
// baseline. Never change the session log, skip another stop hook, or infer that a
// turn ended. AgentLoop still owns turn/end, cancellation and queued next steps.
export const name = 'dsh-mobile-text-turn-tail';
const recorder = '@deepseek-ai/dsh-workspace-changes';
const known = new Set(['0.2.2-rc.3', '0.2.2-rc.5', '0.2.3-alpha.2']);
export function apply(ctx) {
  const turns = new Map();
  ctx.on('session/event', (session, { type, data }) => {
    const id = session.id;
    if (type === 'turn/start') { turns.set(id, { turn: data.turn, step: undefined, pure: true, closed: false }); return; }
    const state = turns.get(id);
    if (!state || data?.turn !== state.turn) return;
    if (type === 'turn/end') { turns.delete(id); return; }
    if (type.startsWith('tool/')) state.pure = false;
    if (type === 'step/start') { state.step = data.step; state.text = false; state.closed = false; }
    if (type === 'assistant/message') {
      const parts = data.message?.content;
      state.text = Array.isArray(parts) && parts.some(p => p?.type === 'text') && parts.every(p => p?.type === 'text' || p?.type === 'reasoning');
      if (!state.text) state.pure = false;
    }
    if (type === 'step/end' && state.step === data.step) state.closed = state.text;
  });
  ctx.on('session/disposed', session => turns.delete(session.id));
  // Public Cordis registration hook; preserve registration order, receiver, owner
  // and unload semantics. No patching signed app files or mutating the hook list.
  let registering = false;
  ctx.on('internal/listener', function(event, callback, options) {
    if (registering || event !== 'agent/turn-stopping') return;
    const entry = this.fiber?.entry;
    if (entry?.options?.name !== recorder) return;
    const base = entry.parent?.tree?.ctx?.baseUrl;
    if (!base || !known.has(ctx.get('pluginPackages')?.packageOf(recorder, base)?.version)) return;
    registering = true;
    try {
      return this.on(event, function(payload) {
        const s = turns.get(payload.agent.session.id);
        if (s?.turn === payload.turn && s.pure && s.closed) return;
        return callback.call(this, payload);
      }, options);
    } finally { registering = false; }
  }, { global: true });
  // The matching bundle row waits until listener decoration is ready; unknown
  // recorder versions still activate normally with their original implementation.
  ctx.provide('dshMobileTextTurnTail', true);
}
