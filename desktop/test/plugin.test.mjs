import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { WebSocket } from 'ws';
import * as plugin from '../plugin/host.mjs';
import { LocalMux } from '../lib/upstream-inprocess.mjs';
import { safetyCode } from '../lib/link-service.mjs';

/** Stand-ins for the three DSH host services the plugin injects. */
function fakeHost() {
  const seen = { rpc: [], opens: [], peers: [], cancelled: [] };
  const peerAbort = new AbortController();
  const connection = {
    createPeer(options) { const peer = { ...options, signal: peerAbort.signal }; seen.peers.push(peer); return peer; },
    createSharedFetchHandler(channel) {
      assert.equal(channel, '/api');
      return {
        requestBodyMode: () => 'buffered',
        async fetch(request, peer) {
          if (request.headers.get('content-type') === 'application/octet-stream') {
            seen.upload = { url: new URL(request.url), bytes: Buffer.from(await request.arrayBuffer()), peer };
            return Response.json({ ok: true, value: { receiptId: 'receipt-test' } });
          }
          const envelope = await request.json();
          seen.rpc.push({ path: new URL(request.url).pathname, envelope, peer });
          return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { items: [{ sessionId: 's1' }] } } });
        },
      };
    },
    requestRejection: req => (req.headers.cookie === 'dsh-auth=ok' ? undefined : 401),
  };
  const typertGateway = {
    wireStream: {
      async open(endpoint, payload, uplink, peer, signal) {
        seen.opens.push({ endpoint, payload, peer });
        signal.addEventListener('abort', () => seen.cancelled.push(endpoint), { once: true });
        if (endpoint === 'terminal/attach') return (async function* () {
          yield { type: 'snapshot', screen: 'test', writable: true };
          for await (const value of uplink) {
            seen.terminalInput = value;
            yield { type: 'ack', sequence: value.sequence };
          }
        })();
        if (endpoint === 'job/list') throw Object.assign(new Error('no such agent'), { code: 'job/not-found' });
        if (endpoint === '$events') return (async function* () {
          yield { type: 'ready', clientId: 'c1', host: { home: '/h' } };
          yield { type: 'waterfall', eventId: 'e1', agentId: 's1', event: 'approval/request', request: { toolName: 'demo-tool' } };
          yield { type: 'waterfall', eventId: 'e2', agentId: 's1', event: 'user-questions/request', request: { questions: [{ id: 'q1' }] } };
          await new Promise(() => {});
        })();
        if (endpoint === 'session/follow') return (async function* () { yield { type: 'snapshot', cursor: 2 }; yield { type: 'event', event: { type: 'turn/start', seq: 3 } }; })();
        return (async function* () { await new Promise(() => {}); })();
      },
      failure: error => ({ code: error.code ?? 'internal', message: error.message }),
    },
  };
  const routes = [];
  const webServer = { register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); } };
  const disposers = [];
  const ctx = { connection, typertGateway, webServer, effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); } };
  return { ctx, seen, routes, peerAbort, dispose: async () => { for (const d of disposers.reverse()) await d(); } };
}

/** Call the panel API the way the desktop UI does (fake req/res on the host's web server). */
async function panel(host, method, path, { body, cookie = 'dsh-auth=ok', type = 'application/json' } = {}) {
  const route = host.routes.find(r => r.path === plugin.PANEL_PATH);
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url: `${plugin.PANEL_PATH}${path}`, headers: { cookie, 'content-type': type } });
  const res = { status: 0, body: '', headers: {}, writeHead(s, h) { this.status = s; Object.assign(this.headers, h ?? {}); }, end(b = '') { this.body = String(b); this.done(); } };
  const done = new Promise(resolve => { res.done = resolve; });
  route.handler(req, res);
  await done;
  return { status: res.status, json: res.body ? JSON.parse(res.body) : undefined };
}

function pinned(port, fingerprint, { method = 'GET', path, token, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, method, path, agent: false, rejectUnauthorized: false,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' } : {}) } }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, json: data ? JSON.parse(data) : undefined }));
    });
    req.on('socket', socket => socket.once('secureConnect', () => {
      const spki = createHash('sha256').update(socket.getPeerX509Certificate().publicKey.export({ type: 'spki', format: 'der' })).digest('base64url');
      if (spki !== fingerprint) req.destroy(new Error('pin mismatch'));
    }));
    req.on('error', reject);
    req.end(Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined);
  });
}

test('safety code matches the phone formatting', () => {
  // Same fixture as Core/Tests/DSHCoreTests/PairingTests.swift (fingerprint of a known SPKI).
  assert.equal(safetyCode('37xy7YxSjXOStXHwa32paYJ4De6vIBFnfvTZklusQNE'), 'DFBC 72ED 8C52 8D73');
});

test('plugin: panel API, in-process RPC and streams, revoke', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-plugin-'));
  const host = fakeHost();
  plugin.apply(host.ctx, { port: 0, host: '127.0.0.1', stateDir: dir, name: '插件测试电脑', extraHosts: ['127.0.0.1'] });
  t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });

  // A peer is created only after an authenticated phone uses the API.
  assert.equal(host.seen.peers.length, 0);

  // The panel API sits behind the host's login check, and changes need a JSON body.
  assert.equal((await panel(host, 'GET', '/status', { cookie: 'nope' })).status, 401);
  let status = (await panel(host, 'GET', '/status')).json;
  assert.equal(status.enabled, false, 'off until the user turns it on');
  assert.equal(status.listening, false);
  assert.equal(status.pairing, null);
  assert.equal((await panel(host, 'POST', '/enabled', { body: { enabled: true }, type: 'text/plain' })).status, 415);
  status = (await panel(host, 'POST', '/enabled', { body: { enabled: true } })).json;
  assert.equal(status.listening, true);
  assert.match(status.pairing.link, /^dshmobile:\/\/pair\?v=1&/);
  assert.match(status.pairing.qrSvg, /^<svg/);
  assert.equal(status.safetyCode.length, 19);
  const port = status.port;
  const fingerprint = new URL(status.pairing.link.replace('dshmobile://', 'https://x/')).searchParams.get('fp');
  const code = new URL(status.pairing.link.replace('dshmobile://', 'https://x/')).searchParams.get('c');

  // A new code invalidates the one on screen.
  const rotated = (await panel(host, 'POST', '/code', { body: {} })).json;
  assert.notEqual(new URL(rotated.pairing.link.replace('dshmobile://', 'https://x/')).searchParams.get('c'), code);
  assert.equal((await pinned(port, fingerprint, { method: 'POST', path: '/mobile/v1/pair', body: { code, device: { id: 'iphone-plugin-01' } } })).status, 403);
  const fresh = new URL(rotated.pairing.link.replace('dshmobile://', 'https://x/')).searchParams.get('c');
  const paired = await pinned(port, fingerprint, { method: 'POST', path: '/mobile/v1/pair', body: { code: fresh, device: { id: 'iphone-plugin-01', name: '测试 iPhone' } } });
  assert.equal(paired.status, 200);
  const token = paired.json.token;

  // RPC: the phone's envelope reaches the shared /api handler unchanged, with the plugin's Peer.
  const envelope = { type: 'client-request', rpcId: 'r1', method: 'session/list', payload: { args: { _request: {} } } };
  const listed = await pinned(port, fingerprint, { method: 'POST', path: '/api/session/list', token, body: envelope });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.result.value.items, [{ sessionId: 's1' }]);
  assert.equal(host.seen.rpc[0].path, '/api/session/list');
  assert.deepEqual(host.seen.rpc[0].envelope, envelope);
  assert.equal(host.seen.rpc[0].peer, host.seen.peers[0]);
  assert.deepEqual({ principal: host.seen.peers[0].principal, interactions: host.seen.peers[0].interactions },
    { principal: { kind: 'owner' }, interactions: 'answer' });

  // Streams: same frames as the host's own mux.
  const ws = new WebSocket(`wss://127.0.0.1:${port}/api/remote.mux`, { rejectUnauthorized: false, headers: { Authorization: `Bearer ${token}` } });
  const frames = [];
  ws.on('message', (data, isBinary) => { assert.equal(isBinary, false); frames.push(JSON.parse(data.toString())); });
  await once(ws, 'open');
  const until = async test => { for (let i = 0; i < 100 && !test(); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(test(), JSON.stringify(frames)); };
  ws.send(JSON.stringify({ type: 'open', streamId: 'e', endpoint: '$events', payload: { args: {} } }));
  ws.send(JSON.stringify({ type: 'open', streamId: 'f', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: 's1' } } } } }));
  ws.send(JSON.stringify({ type: 'open', streamId: 'j', endpoint: 'job/list', payload: { args: { agentId: 'a' } } }));
  ws.send(JSON.stringify({ type: 'open', streamId: 'w', endpoint: 'workspace/follow', payload: { args: {} } }));
  await until(() => frames.some(f => f.streamId === 'f' && f.type === 'end') && frames.some(f => f.streamId === 'j') && frames.some(f => f.streamId === 'e'));
  assert.deepEqual(frames.filter(f => f.streamId === 'f').map(f => f.type === 'item' ? f.value.type : f.type), ['snapshot', 'event', 'end']);
  assert.deepEqual(frames.find(f => f.streamId === 'j'), { type: 'error', streamId: 'j', error: { code: 'job/not-found', message: 'no such agent' } });
  assert.equal(frames.find(f => f.streamId === 'e').value.type, 'ready');
  ws.send(JSON.stringify({ type: 'cancel', streamId: 'w' }));
  await until(() => host.seen.cancelled.includes('workspace/follow'));
  assert.equal(frames.filter(f => f.streamId === 'w').length, 0, 'a cancelled stream sends nothing');

  // Uplink frames stay blocked. Approval decisions use a correlated unary RPC.
  ws.send(JSON.stringify({ type: 'item', streamId: 'e', value: { answer: 'allow' } }));
  const [closeCode, reason] = await once(ws, 'close');
  assert.equal(closeCode, 1008);
  assert.match(reason.toString(), /^frame-policy/);
  status = (await panel(host, 'GET', '/status')).json;
  assert.equal(status.devices.length, 1);

  // Removing the phone in the panel closes its sockets and invalidates its token.
  const ws2 = new WebSocket(`wss://127.0.0.1:${port}/api/remote.mux`, { rejectUnauthorized: false, headers: { Authorization: `Bearer ${token}` } });
  await once(ws2, 'open');
  await until(() => true);
  const online = (await panel(host, 'GET', '/status')).json;
  assert.equal(online.devices[0].online, true);
  const closed = once(ws2, 'close');
  await panel(host, 'POST', '/devices/remove', { body: { id: 'iphone-plugin-01' } });
  assert.equal((await closed)[0], 4401);
  assert.equal((await pinned(port, fingerprint, { path: '/mobile/v1/session', token })).status, 401);

  // Turning it off stops the listener; the choice is remembered.
  status = (await panel(host, 'POST', '/enabled', { body: { enabled: false } })).json;
  assert.equal(status.listening, false);
  await assert.rejects(pinned(port, fingerprint, { path: '/mobile/v1/hello' }));
});

test('phone actions require opt-in and decisions are bound to the receiving phone', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-actions-'));
  const host = fakeHost();
  plugin.apply(host.ctx, { port: 0, host: '127.0.0.1', stateDir: dir, extraHosts: ['127.0.0.1'], enabled: true });
  t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });

  const pairPhone = async id => {
    const status = (await panel(host, 'GET', '/status')).json;
    const params = new URL(status.pairing.link).searchParams;
    const port = status.port;
    const fingerprint = params.get('fp');
    const response = await pinned(port, fingerprint, {
      method: 'POST', path: '/mobile/v1/pair', body: { code: params.get('c'), device: { id } },
    });
    assert.equal(response.status, 200);
    return {
      port, token: response.json.token,
      get: path => pinned(port, fingerprint, { path, token: response.json.token }),
      async rpc(method, args) {
        return pinned(port, fingerprint, {
          method: 'POST', path: '/api/' + method, token: response.json.token,
          body: { type: 'client-request', rpcId: 'phone-action', method, payload: { args } },
        });
      },
      upload: body => pinned(port, fingerprint, {
        method: 'POST', path: '/api/session/uploadFileBinary?sessionId=s1&name=test.txt', token: response.json.token, body,
      }),
    };
  };
  const one = await pairPhone('action-phone-01');
  const two = await pairPhone('action-phone-02');
  const prompt = { request: { sessionId: 's1', requestId: 'new-prompt', mode: 'queue', content: [{ type: 'text', text: 'hello' }] } };
  assert.equal((await one.get('/mobile/v1/session')).json.actions, false);
  assert.equal((await one.rpc('session/prompt', prompt)).json.error, 'actions-disabled');

  const enabled = await panel(host, 'POST', '/actions', { body: { enabled: true } });
  assert.equal(enabled.json.actions, true);
  assert.equal((await one.get('/mobile/v1/session')).json.actions, true);
  assert.equal((await one.rpc('session/prompt', prompt)).status, 200);
  assert.deepEqual(host.seen.rpc.at(-1).envelope.payload.args, prompt);
  assert.equal((await one.rpc('session/selectModel', { request: { sessionId: 's1', provider: 'p', model: 'm' } })).status, 200);
  assert.equal((await one.rpc('unrelated/unknown', {})).status, 403);

  assert.equal((await one.rpc('terminal/create', {})).json.error, 'terminal-disabled');
  await panel(host, 'POST', '/terminal', { body: { enabled: true } });
  assert.equal((await one.get('/mobile/v1/session')).json.terminal, true);
  assert.equal((await one.rpc('terminal/create', {})).status, 200);

  const bytes = Buffer.from('synthetic attachment');
  assert.equal((await one.upload(bytes)).json.value.receiptId, 'receipt-test');
  assert.deepEqual(host.seen.upload.bytes, bytes);
  assert.equal(host.seen.upload.url.searchParams.get('sessionId'), 's1');

  const ws = new WebSocket('wss://127.0.0.1:' + one.port + '/api/remote.mux', {
    rejectUnauthorized: false, headers: { Authorization: 'Bearer ' + one.token },
  });
  t.after(() => ws.terminate());
  const ready = new Promise(resolve => {
    ws.on('message', data => { if (JSON.parse(data).value?.eventId === 'e2') resolve(); });
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } }));
  await ready;
  const terminalAck = new Promise(resolve => {
    ws.on('message', bytes => {
      const frame = JSON.parse(bytes);
      if (frame.streamId !== 'term') return;
      if (frame.value?.type === 'snapshot') {
        ws.send(JSON.stringify({ type: 'item', streamId: 'term', value: { type: 'write', sequence: 1, data: 'echo mobile\r' } }));
      }
      if (frame.value?.type === 'ack') resolve(frame.value.sequence);
    });
  });
  ws.send(JSON.stringify({ type: 'open', streamId: 'term', endpoint: 'terminal/attach', payload: { args: { agentId: 's1', id: 'term1' } } }));
  assert.equal(await terminalAck, 1);
  assert.equal(host.seen.terminalInput.data, 'echo mobile\r');
  const decision = { clientId: 'c1', eventId: 'e1', outcome: { kind: 'result', value: 'allowed-once' } };
  assert.equal((await two.rpc('$events/result', decision)).status, 409);
  assert.equal((await one.rpc('$events/result', { ...decision, outcome: { kind: 'result', value: 'unavailable' } })).status, 409);
  assert.equal((await one.rpc('$events/result', decision)).status, 200);
  const peer = host.seen.opens.find(open => open.endpoint === '$events').peer;
  assert.equal(host.seen.rpc.at(-1).peer, peer);
  assert.equal((await one.rpc('$events/result', decision)).status, 409);

  const answer = { clientId: 'c1', eventId: 'e2', outcome: { kind: 'result', value: { answers: [{ id: 'q1', selected: ['A'] }] } } };
  assert.equal((await one.rpc('$events/result', answer)).status, 200);
  const disconnected = once(ws, 'close');
  await panel(host, 'POST', '/actions', { body: { enabled: false } });
  assert.equal((await disconnected)[0], 1012);
  assert.equal((await one.rpc('session/prompt', prompt)).status, 403);
});

test('LocalMux: duplicate open closes, peer end closes', async () => {
  const abort = new AbortController();
  const wire = { open: async () => (async function* () { await new Promise(() => {}); })(), failure: e => ({ code: 'x', message: e.message }) };
  const mux = new LocalMux(wire, { signal: abort.signal });
  let closed = 0; mux.on('close', () => closed++);
  mux.send(JSON.stringify({ type: 'open', streamId: 'a', endpoint: 'session/control', payload: { args: {} } }));
  mux.send(JSON.stringify({ type: 'open', streamId: 'a', endpoint: 'session/control', payload: { args: {} } }));
  assert.equal(closed, 1);
  const mux2 = new LocalMux(wire, { signal: abort.signal });
  let closed2 = 0; mux2.on('close', () => closed2++);
  abort.abort();
  assert.equal(closed2, 1);
});
