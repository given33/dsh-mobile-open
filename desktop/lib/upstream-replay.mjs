// Upstream that replays frames recorded from a real DSH host
// (tools/record-fixture.mjs). Used for simulator screenshots, demos and tests:
// the phone talks to the real link server, which serves recorded data.

const sessionOf = args => {
  const address = args?.request?.address ?? args?.address;
  return address?.childSessionId ?? address?.sessionId ?? '';
};

/** Fixture key for one stream open. */
export function streamKey(endpoint, args = {}) {
  if (endpoint === 'session/follow') return `session/follow:${sessionOf(args)}`;
  if (endpoint === 'job/list') return `${endpoint}:${args.request?.sessionId ?? ''}`;
  if (endpoint === 'job/follow') return `${endpoint}:${args.request?.jobId ?? ''}`;
  return endpoint;
}

/** Fixture key for one RPC call. */
export function rpcKey(method, args = {}) {
  if (method === 'session/page') return `session/page:${sessionOf(args)}:${args?.request?.beforeSeq ?? ''}`;
  if (method === 'session/projections') return `session/projections:${sessionOf(args)}`;
  return method;
}

const response = (rpcId, result) => ({ status: 200, body: Buffer.from(JSON.stringify({ type: 'server-response', rpcId, result })) });

/**
 * @param {{ rpc: Record<string, unknown>, streams: Record<string, {at:number, value:unknown}[]> }} fixture
 * @param {{ speed?: number }} [options] speed > 1 plays recorded timing faster; Infinity sends everything at once.
 */
export function replayUpstream(fixture, { speed = 1 } = {}) {
  return {
    available: () => true,
    async rpc(method, body) {
      const envelope = JSON.parse(body.toString('utf8'));
      const args = envelope.payload?.args ?? {};
      const value = fixture.rpc?.[rpcKey(method, args)] ?? fixture.rpc?.[method];
      return value === undefined
        ? response(envelope.rpcId, { ok: false, error: { message: `Not recorded: ${rpcKey(method, args)}` } })
        : response(envelope.rpcId, { ok: true, value });
    },
    async mux() {
      const listeners = { message: new Set(), close: new Set() };
      const timers = new Map(); // streamId -> Set<Timeout>
      let closed = false;
      const emit = frame => { if (!closed) for (const fn of listeners.message) fn(Buffer.from(JSON.stringify(frame)), false); };
      const clear = id => { for (const t of timers.get(id) ?? []) clearTimeout(t); timers.delete(id); };
      return {
        send(text) {
          const msg = JSON.parse(text);
          if (msg.type === 'cancel') return clear(msg.streamId);
          if (msg.type !== 'open') return;
          const frames = fixture.streams?.[streamKey(msg.endpoint, msg.payload?.args)] ?? [];
          const set = new Set(); timers.set(msg.streamId, set);
          for (const frame of frames) {
            const delay = Number.isFinite(speed) ? Math.max(0, frame.at / speed) : 0;
            const t = setTimeout(() => { set.delete(t); emit({ type: 'item', streamId: msg.streamId, value: frame.value }); }, delay);
            set.add(t);
          }
        },
        close() {
          if (closed) return;
          closed = true;
          for (const id of [...timers.keys()]) clear(id);
          for (const fn of listeners.close) fn();
        },
        on(event, fn) { listeners[event]?.add(fn); },
      };
    },
  };
}
