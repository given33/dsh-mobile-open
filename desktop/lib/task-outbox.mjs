// Bounded, private outbox for notices and terminal updates. Ordinary live progress
// is transient. A revoked, re-paired or reconfigured recipient never inherits a retry.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { writePrivate } from './identity.mjs';
const hash = (s) => createHash('sha256').update(s).digest('hex');
export async function openOutbox(path) {
  let pending = new Map(),
    writes = Promise.resolve();
  try {
    pending = new Map(
      JSON.parse(await readFile(path, 'utf8'))
        .filter(([, r]) => r.until > Date.now())
        .slice(-512),
    );
  } catch {}
  const flush = () => {
    const data = JSON.stringify([...pending]);
    writes = writes.catch(() => {}).then(() => writePrivate(path, data));
    return writes;
  };
  return {
    async add(id, pair, m) {
      const { token, ...item } = m;
      // A waiting-for-input alert is no longer useful once the same turn ended.
      if (item.state.terminal)
        for (const [k, v] of pending)
          if (
            v.id === id &&
            v.item.state.sessionId === item.state.sessionId &&
            v.item.state.turn === item.state.turn &&
            !v.item.state.terminal
          )
            pending.delete(k);
      pending.set(m.eventId, {
        id,
        pair,
        hash: hash(token),
        item,
        until: Date.now() + (item.state.terminal ? 3600000 : 300000),
      });
      if (pending.size > 512) pending.delete(pending.keys().next().value);
      await flush();
    },
    async ack(k) {
      if (pending.delete(k)) await flush();
    },
    async forget(id) {
      for (const [k, r] of pending) if (r.id === id) pending.delete(k);
      await flush();
    },
    async recover(get, deliver) {
      let dirty = false;
      for (const [k, r] of pending) {
        const row = get(r.id),
          m = r.item;
        const token =
          m.method === 'bark' ? row?.bark : row?.island && row.tokens[m.state.sessionId + ':' + m.state.turn];
        if (r.until < Date.now() || r.pair !== row?.pair || !token || hash(token) !== r.hash) {
          pending.delete(k);
          dirty = true;
          continue;
        }
        deliver(r.id, { ...m, token });
      }
      if (dirty) await flush();
    },
    close: () => writes.catch(() => {}),
  };
}
