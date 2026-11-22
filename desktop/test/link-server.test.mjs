import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { loadIdentity } from '../lib/identity.mjs';
import { DeviceRegistry, PairingCodes } from '../lib/devices.mjs';
import { createLinkServer, checkClientFrame, READ_STREAMS, READ_RPC } from '../lib/link-server.mjs';
import { exchangeLaunchURL, httpUpstream } from '../lib/upstream-http.mjs';

/** A stand-in for the DSH web host: launch-token exchange, RPC and remote.mux. */
async function fakeHarness(t) {
  const seen = { rpc: [], frames: [] };
  const host = http.createServer(async (req, res) => {
    if (req.url === '/?token=launch-1') { res.writeHead(302, { 'Set-Cookie': 'dsh-auth-local=cookie-1; HttpOnly; SameSite=Strict', Location: '/' }); return res.end(); }
    if (req.headers.cookie !== 'dsh-auth-local=cookie-1') { res.writeHead(401); return res.end(); }
    let body = ''; for await (const c of req) body += c;
    const envelope = JSON.parse(body); seen.rpc.push(envelope);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { items: [{ sessionId: 's1', running: true }] } } }));
  });
  const wss = new WebSocketServer({ server: host });
  wss.on('connection', (socket, req) => {
    if (req.headers.cookie !== 'dsh-auth-local=cookie-1') return socket.close(4401);
    socket.on('message', bytes => {
      const m = JSON.parse(bytes.toString()); seen.frames.push(m);
      if (m.type === 'open') socket.send(JSON.stringify({ type: 'item', streamId: m.streamId, value: { type: 'ready', clientId: 'c1', host: { home: '/h' } } }));
    });
  });
  host.listen(0, '127.0.0.1'); await once(host, 'listening');
  const close = async () => { for (const s of wss.clients) s.terminate(); wss.close(); const done = new Promise(r => host.close(r)); host.closeAllConnections(); await done; };
  return { url: `http://127.0.0.1:${host.address().port}/?token=launch-1`, seen, wss, close };
}

/** Pinned HTTPS request, the way the phone checks the desktop: the SPKI hash is checked before any byte is sent. */
function pinnedRequest(port, fingerprint, { method = 'GET', path, token, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, method, path, agent: false, rejectUnauthorized: false, headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, json: data ? JSON.parse(data) : undefined }));
    });
    req.on('socket', socket => socket.once('secureConnect', () => {
      const spki = createHash('sha256').update(socket.getPeerX509Certificate().publicKey.export({ type: 'spki', format: 'der' })).digest('base64url');
      if (spki !== fingerprint) req.destroy(new Error('pin mismatch'));
    }));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function start(t, notifications) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-link-srv-'));
  const harness = await fakeHarness(t);
  const identity = await loadIdentity(dir, { name: '测试电脑' });
  const devices = await new DeviceRegistry(dir).load();
  const codes = new PairingCodes();
  const events = [];
  const link = createLinkServer({ notifications, identity, devices, codes, upstream: httpUpstream(await exchangeLaunchURL(harness.url)), log: e => events.push(e) });
  const { port } = await link.listen(0, '127.0.0.1');
  // One hook, in order: stop serving, stop the fake host, then delete files (Windows refuses to delete open files).
  t.after(async () => { await link.close(); await harness.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });
  return { harness, identity, devices, codes, link, port, events };
}

const pair = async (s, code = s.codes.current().code) => pinnedRequest(s.port, s.identity.fingerprint, {
  method: 'POST', path: '/mobile/v1/pair', body: { code, device: { id: 'iphone-test-0001', name: '测试 iPhone', model: 'iPhone17,2', system: 'iOS 18.5', app: '0.2.0' } } });

test('hello, pairing and token checks', async t => {
  const s = await start(t);
  const hello = await pinnedRequest(s.port, s.identity.fingerprint, { path: '/mobile/v1/hello' });
  assert.equal(hello.status, 200);
  assert.deepEqual(hello.json.desktop, { id: s.identity.id, name: '测试电脑' });
  assert.equal(hello.json.fingerprint, s.identity.fingerprint);
  assert.equal((await pair(s, 'not-the-code-000000000000')).status, 403);
  const code = s.codes.current().code;
  const ok = await pair(s, code);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.desktop.name, '测试电脑');
  assert.ok(ok.json.token.length >= 43);
  assert.equal((await pair(s, code)).status, 403, 'code is single use');
  assert.equal((await pinnedRequest(s.port, s.identity.fingerprint, { path: '/mobile/v1/session' })).status, 401);
  const session = await pinnedRequest(s.port, s.identity.fingerprint, { path: '/mobile/v1/session', token: ok.json.token });
  assert.equal(session.status, 200);
  assert.equal(session.json.device.name, '测试 iPhone');
  assert.ok(s.events.some(e => e.type === 'paired'));
});

test('read-only RPC is forwarded unchanged; writes are refused', async t => {
  const s = await start(t);
  const { json: { token } } = await pair(s);
  const envelope = { type: 'client-request', rpcId: 'r1', method: 'session/list', payload: { args: { _request: {} } } };
  const ok = await pinnedRequest(s.port, s.identity.fingerprint, { method: 'POST', path: '/api/session/list', token, body: envelope });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.result.value.items[0].sessionId, 's1');
  assert.deepEqual(s.harness.seen.rpc.at(-1), envelope);
  const write = await pinnedRequest(s.port, s.identity.fingerprint, { method: 'POST', path: '/api/session/prompt', token, body: { ...envelope, method: 'session/prompt' } });
  assert.equal(write.status, 403);
  const mismatch = await pinnedRequest(s.port, s.identity.fingerprint, { method: 'POST', path: '/api/session/list', token, body: { ...envelope, method: 'session/page' } });
  assert.equal(mismatch.status, 400);
  assert.equal((await pinnedRequest(s.port, s.identity.fingerprint, { method: 'POST', path: '/api/session/list', body: envelope })).status, 401);
  assert.equal(s.harness.seen.rpc.length, 1, 'refused requests never reach Harness');
});

test('mux streams pass through; write frames close the socket; unpair disconnects', async t => {
  const s = await start(t);
  const { json: { token } } = await pair(s);
  const url = `wss://127.0.0.1:${s.port}/api/remote.mux`;
  const denied = new WebSocket(url, { rejectUnauthorized: false });
  const [err] = await Promise.race([once(denied, 'unexpected-response'), once(denied, 'error')]);
  assert.ok(err, 'no token, no socket');
  const ws = new WebSocket(url, { rejectUnauthorized: false, headers: { Authorization: `Bearer ${token}` } });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } }));
  const [first, isBinary] = await once(ws, 'message');
  assert.equal(isBinary, false, 'text frames stay text');
  assert.equal(JSON.parse(first.toString()).value.type, 'ready');
  ws.send(JSON.stringify({ type: 'open', streamId: 'w', endpoint: 'session/prompt', payload: { args: {} } }));
  const [code, reason] = await once(ws, 'close');
  assert.equal(code, 1008); assert.match(reason.toString(), /endpoint-forbidden/);
  assert.ok(!s.harness.seen.frames.some(f => f.endpoint === 'session/prompt'));

  const ws2 = new WebSocket(url, { rejectUnauthorized: false, headers: { Authorization: `Bearer ${token}` } });
  await once(ws2, 'open');
  const closed = once(ws2, 'close');
  const devices = s.devices.list();
  await s.devices.remove(devices[0].id);
  const [code2] = await closed;
  assert.equal(code2, 4401);
});

test('frame policy', () => {
  const policy = { rpc: READ_RPC, streams: READ_STREAMS };
  const open = new Set(['a']);
  assert.equal(checkClientFrame({ type: 'open', streamId: 'b', endpoint: 'session/follow', payload: { args: { request: {} } } }, open, policy), 'ok');
  assert.equal(checkClientFrame({ type: 'open', streamId: 'b', endpoint: 'session/follow', payload: { args: { request: { activate: true } } } }, open, policy), 'write-forbidden');
  assert.equal(checkClientFrame({ type: 'open', streamId: 'a', endpoint: '$events', payload: { args: {} } }, open, policy), 'duplicate-stream');
  assert.equal(checkClientFrame({ type: 'item', streamId: 'a' }, open, policy), 'write-forbidden');
  assert.equal(checkClientFrame({ type: 'cancel', streamId: 'a' }, open, policy), 'ok');
  assert.equal(checkClientFrame({ type: 'cancel', streamId: 'zz' }, open, policy), 'unknown-stream');
  assert.equal(checkClientFrame({ type: 'open', streamId: 'c', endpoint: 'job/list', payload: { args: [] } }, open, policy), 'bad-args');
});

test('notification settings authorize the paired device, not the recipient named by the client', async t => {
  const updates = [];
  const s = await start(t, {status: id => ({id}), configure: async (id, body) => updates.push([id,body.op])});
  const path = '/mobile/v1/task-notifications';
  const req = opts => pinnedRequest(s.port, s.identity.fingerprint, {path,...opts});
  assert.equal((await req({})).status, 401);
  const {json:{token}} = await pair(s);
  assert.equal((await req({token})).json.id, 'iphone-test-0001');
  assert.equal((await req({method:'POST',token,body:{id:'different-phone',op:'island',enabled:true}})).status, 200);
  assert.deepEqual(updates,[['iphone-test-0001','island']]);
  assert.equal((await req({method:'POST',token,body:{padding:'a'.repeat(4100)}})).status, 413);
  assert.equal(updates.length,1);
});
