// Upstream for plugin mode: the link server runs inside the DSH host process
// and dispatches the phone's DSH protocol through the host's own services.
//
// RPC and non-RPC `/api/*` Fetch routes (media, deliverables, document preview,
// plugin icons, exports, streaming uploads) go through Connection's shared `/api`
// fetch handler, the same code path as the desktop UI.
// Streams go through the Gateway's wire carrier, the same one the host's
// `/api/remote.mux` WebSocket uses. No cookie, launch token or loopback hop.

import { TerminalUplink } from './terminal-uplink.mjs';

/** Read streams receive no uplink. */
const NO_UPLINK = {
  [Symbol.asyncIterator]() {
    return {
      next: async () => ({ done: true, value: undefined }),
      return: async () => ({ done: true, value: undefined }),
    };
  },
};

const FORWARD_REQUEST_HEADERS = [
  'accept', 'accept-language', 'content-type', 'if-none-match', 'if-modified-since', 'range',
];

/**
 * @param {{ connection: any, typertGateway: any, local?: Record<string, Function>, nativeLocal?: (method: string) => Function | undefined }} services - injected DSH host services.
 * @returns the upstream interface `createLinkServer` expects.
 */
export function inProcessUpstream({ connection, typertGateway, local = {}, nativeLocal }) {
  if (typeof connection?.createPeer !== 'function' || typeof connection?.createSharedFetchHandler !== 'function') {
    throw new Error('dsh-mobile-link needs DSH 0.2.1-rc.2 or later (Connection.createPeer)');
  }
  if (typeof typertGateway?.wireStream?.open !== 'function') {
    throw new Error('dsh-mobile-link needs the DSH Remote Gateway (typertGateway.wireStream)');
  }
  // A phone's unary actions, API fetch routes, index rendering, and event stream share its own owner Peer.
  const peers = new Map();
  let disposed = false;
  const peerFor = id => {
    if (disposed) throw new Error('phone link stopped');
    if (!peers.has(id)) peers.set(id, connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' }));
    return peers.get(id);
  };
  const revoke = async id => {
    const peer = peers.get(id);
    peers.delete(id);
    await peer?.dispose?.();
  };
  const api = connection.createSharedFetchHandler('/api');
  return {
    available: () => !disposed,
    peerFor,
    async rpc(method, body, id, { official = false } = {}) {
      const action = (!official && nativeLocal?.(method)) || (Object.hasOwn(local, method) ? local[method] : undefined);
      if (action) {
        const envelope = JSON.parse(body);
        let result;
        try { result = { ok: true, value: await action(envelope.payload.args, peerFor(id).signal) }; }
        catch (error) { result = { ok: false, error: { code: error.code ?? 'mobile/failed', message: error.message } }; }
        return { status: 200, body: Buffer.from(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result })) };
      }
      if (method === 'mobilePermissions/select') {
        const envelope = JSON.parse(body);
        const { sessionId, preset } = envelope.payload.args;
        if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128 ||
            typeof preset !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(preset)) {
          return { status: 200, body: Buffer.from(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId,
            result: { ok: false, error: { code: 'mobilePermissions/input', message: '无效的会话或权限预设。' } } })) };
        }
        method = 'commands/execute';
        envelope.method = method;
        envelope.payload.args = { agentId: sessionId, line: '/permission ' + preset, submittedAttachments: [] };
        body = Buffer.from(JSON.stringify(envelope));
      }
      const peer = peerFor(id);
      const request = new Request(`http://localhost/api/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      });
      const response = await api.fetch(request, peer);
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? 'application/json; charset=utf-8',
        body: Buffer.from(await response.arrayBuffer()),
      };
    },
    async fetch({ method = 'GET', url, headers = {}, body }, id) {
      const peer = peerFor(id);
      const reqHeaders = new Headers();
      for (const name of FORWARD_REQUEST_HEADERS) {
        const value = headers[name];
        if (typeof value === 'string' && value) reqHeaders.set(name, value);
      }
      const init = { method, headers: reqHeaders };
      if (!['GET', 'HEAD'].includes(method) && body !== undefined) init.body = body;
      const request = new Request(new URL(url, 'http://localhost'), init);
      const response = await api.fetch(request, peer);
      const outHeaders = Object.fromEntries(response.headers);
      delete outHeaders['content-encoding'];
      delete outHeaders['transfer-encoding'];
      const bytes = method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
      outHeaders['content-length'] = String(bytes.length);
      return { status: response.status, headers: outHeaders, body: bytes };
    },
    async upload({ sessionId, name, mediaType, body }, id) {
      const url = new URL('http://localhost/api/session/uploadFileBinary');
      url.searchParams.set('sessionId', sessionId);
      if (name) url.searchParams.set('name', name);
      if (mediaType) url.searchParams.set('mediaType', mediaType);
      const request = new Request(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body, duplex: 'half' });
      const response = await api.fetch(request, peerFor(id));
      return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
    },
    async mux(id) { return new LocalMux(typertGateway.wireStream, peerFor(id)); },
    revoke,
    async dispose() { disposed = true; await Promise.allSettled([...peers.keys()].map(revoke)); },
  };
}

/**
 * Server side of the remote.mux protocol for one phone socket, with the
 * frame semantics of the Gateway's own RemoteStreamMuxServer: items in order,
 * `end` on completion, `error` with the Gateway's failure encoding, nothing
 * after a client cancel, and a duplicate `open` closes the connection.
 */
export class LocalMux {
  #wire; #peer; #streams = new Map(); #closed = false;
  #listeners = { message: new Set(), close: new Set() };
  #onPeerEnd = () => this.close();

  constructor(wire, peer) {
    this.#wire = wire; this.#peer = peer;
    peer.signal?.addEventListener?.('abort', this.#onPeerEnd, { once: true });
  }

  on(event, fn) { this.#listeners[event]?.add(fn); return this; }

  send(text) {
    if (this.#closed) return;
    let msg;
    try { msg = JSON.parse(text); } catch { this.close(); return; }
    if (msg?.type === 'open') {
      if (this.#streams.has(msg.streamId)) { this.close(); return; }
      this.#pump(msg);
    } else if (msg?.type === 'cancel') {
      const active = this.#streams.get(msg.streamId);
      active?.uplink?.close();
      active?.control.abort(new Error('Remote stream cancelled'));
    } else if (msg?.type === 'item') {
      const active = this.#streams.get(msg.streamId);
      if (active?.uplink && !active.uplink.push(msg.value)) {
        active.uplink.close();
        active.control.abort();
        this.#emit({ type: 'error', streamId: msg.streamId, error: { code: 'terminal/queue-full', message: 'Terminal input buffer is full.' } });
      }
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#peer.signal?.removeEventListener?.('abort', this.#onPeerEnd);
    for (const { control, uplink } of this.#streams.values()) {
      uplink?.close();
      control.abort(new Error('Remote stream socket closed'));
    }
    this.#streams.clear();
    for (const fn of this.#listeners.close) { try { fn(); } catch {} }
  }

  #emit(frame) {
    if (this.#closed) return;
    const text = JSON.stringify(frame);
    for (const fn of this.#listeners.message) fn(text, false);
  }

  async #pump({ streamId, endpoint, payload }) {
    const control = new AbortController();
    const uplink = endpoint === 'terminal/attach' ? new TerminalUplink() : undefined;
    const entry = { control, uplink };
    this.#streams.set(streamId, entry);
    try {
      const source = await this.#wire.open(endpoint, payload, uplink ?? NO_UPLINK, this.#peer, control.signal);
      for await (const value of source) {
        if (control.signal.aborted) break;
        this.#emit({ type: 'item', streamId, value });
      }
      if (!control.signal.aborted) this.#emit({ type: 'end', streamId });
    } catch (error) {
      if (!control.signal.aborted) this.#emit({ type: 'error', streamId, error: this.#wire.failure(error) });
    } finally {
      uplink?.close();
      if (this.#streams.get(streamId) === entry) this.#streams.delete(streamId);
    }
  }
}
