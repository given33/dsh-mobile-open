import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { openOutbox } from '../lib/task-outbox.mjs';
import { taskReducer, view } from '../lib/task-events.mjs';
import { taskPush } from '../lib/task-push.mjs';
import { createServer } from 'node:http';
import { receiver, payload, providers } from '../../deploy/task-push/relay.mjs';
const sid = 'session-example';
const start = { type: 'turn/start', seq: 0, data: { turn: 1 } };
test('authoritative terminal reasons, concurrent interaction waits and no content disclosure', () => {
  let s = taskReducer(null, sid, start),
    n = 1;
  const next = (type, data) => (s = taskReducer(s, sid, { seq: n++, type, data }));
  next('tool/call', { turn: 1, step: 1, callId: 'q', name: 'ask_user_question', arguments: 'PRIVATE' });
  assert.equal(s.phase, 'question');
  next('approval/asked', { id: 'a', reason: 'PRIVATE' });
  assert.equal(s.phase, 'approval');
  next('tool/result', { turn: 1, step: 1, message: { toolCallId: 'q', content: 'PRIVATE' } });
  assert.equal(s.phase, 'approval');
  next('approval/decided', { id: 'a', outcome: 'rejected' });
  assert.equal(s.phase, 'denied');
  next('todo/write', {
    turn: 1,
    todos: [{ status: 'completed', content: 'PRIVATE' }, { status: 'in_progress' }],
  });
  assert(view(s).detail.includes('1/2'));
  next('llm/retry', { turn: 1, step: 2, failure: { message: 'PRIVATE' } });
  assert.equal(s.phase, 'retry');
  assert(!JSON.stringify(view(s)).includes('PRIVATE'));
  assert(!taskReducer(s, sid, { seq: 0, type: 'step/start', data: { step: 5, turn: 1 } }));
  for (const kind of [
    'completed',
    'aborted',
    'blocked',
    'error',
    'interrupted',
    'max-tokens',
    'new-host-reason',
  ]) {
    const ended = taskReducer(s, sid, { type: 'turn/end', data: { turn: 1, reason: { kind } } });
    assert(ended.terminal);
    assert.equal(ended.phase, kind === 'new-host-reason' ? 'ended' : kind);
    assert(!taskReducer(ended, sid, { type: 'step/start', data: { turn: 1, step: 9 } }));
  }
});
test('paired recipients, late activity token closes correct turn, revoke stops all deliveries', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'push-test-'));
  let paired = true,
    remove;
  const deliveries = [];
  const devices = {
    list: () => (paired ? [{ id: 'phone', pairedAt: 123 }] : []),
    onChange: (fn) => {
      remove = fn;
      return () => {};
    },
  };
  const p = await taskPush({
    desktopId: 'desk-test',
    stateDir: dir,
    devices,
    send: async (m) => {
      deliveries.push(m);
    },
  });
  t.after(async () => {
    await p.close();
    await rm(dir, { recursive: true, force: true });
  });
  p.event(sid, start);
  assert.equal(deliveries.length, 0);
  await p.configure('phone', { op: 'island', enabled: true });
  await p.configure('phone', { op: 'bark', key: 'device-key' });
  assert(!JSON.stringify(p.status('phone')).includes('device-key'));
  await p.configure('phone', { op: 'startToken', token: 'ab'.repeat(32) });
  await p.configure('phone', { op: 'background' });
  p.event(sid, { type: 'turn/start', seq: 1, data: { turn: 2 } });
  p.event(sid, { type: 'approval/asked', seq: 2, data: { turn: 2, id: 'approval' } });
  p.event(sid, { type: 'assistant/message', seq: 3, data: { turn: 2, message: { content: [
    { type: 'reasoning', text: 'PRIVATE' }, { type: 'text', text: '校验了 **三处修改**。' },
  ] } } });
  p.event(sid, { type: 'turn/end', seq: 4, data: { turn: 2, reason: { kind: 'completed' } } },
    () => ({title: '检查改动', workspace: '设计组'}));
  p.event(sid, { type: 'turn/start', seq: 5, data: { turn: 3 } });
  await p.configure('phone', { op: 'activity', sessionId: sid, turn: 2, token: 'cd'.repeat(32) });
  for (let i = 0; i < 100 && !deliveries.some((m) => m.method === 'end'); i++) await pause(10);
  assert(deliveries.some((m) => m.method === 'end' && m.state.turn === 2 && m.state.phase === 'completed'));
  assert(deliveries.some((m) => m.method === 'start'));
  const notices = deliveries.filter(m => m.method === 'bark');
  assert.deepEqual(notices.map(m => m.kind), ['completed']);
  assert.deepEqual(notices[0].report, { task:'检查改动', workspace:'设计组', summary:'校验了 三处修改。' });
  assert(!deliveries.some(m => m.method !== 'bark' && m.report));
  paired = false;
  remove({ type: 'removed', id: 'phone' });
  const count = deliveries.length;
  p.event(sid, { type: 'turn/end', seq: 4, data: { turn: 3, reason: { kind: 'completed' } } });
  assert.equal(deliveries.length, count);
  assert.equal(p.status('phone').bark, false);
});
test('authenticated relay rejects tampering and replay, deduplicates retries, produces proper deep links and dismissal policy', async (t) => {
  const secret = 'x'.repeat(40),
    sent = [];
  const server = receiver(secret, async (m) => sent.push(m));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/v1/event`;
  const m = {
    eventId: randomUUID(),
    method: 'bark',
    desktopId: 'desktop',
    kind: 'completed',
    title: '任务已完成',
    token: 'abcdefgh',
    state: {
      sessionId: sid,
      turn: 1,
      step: 5,
      phase: 'completed',
      label: '任务已完成',
      detail: '',
      terminal: true,
      updatedAt: 123,
    },
  };
  const body = JSON.stringify(m);
  const headers = () => {
    const n = randomUUID(),
      t = String(Date.now());
    return {
      'x-dsh-time': t,
      'x-dsh-nonce': n,
      'x-dsh-signature': createHmac('sha256', secret)
        .update(t + '.' + n + '.' + body)
        .digest('hex'),
    };
  };
  const h = headers();
  const post = (b, hs) => fetch(url, { method: 'POST', body: b, headers: hs });
  assert.equal((await post(body + ' ', h)).status, 401);
  assert.equal((await post(body, h)).status, 200);
  assert.equal((await post(body, h)).status, 401);
  assert.equal((await post(body, headers())).status, 200);
  assert.equal(sent.length, 1);
  assert.equal(payload(m).url, 'dshmobile://task/desktop/' + sid);
  const end = { ...m, method: 'end' };
  assert.equal(payload(end, 1000).aps['dismissal-date'], 999);
  end.state = { ...m.state, phase: 'interrupted' };
  assert.equal(payload(end, 1000).aps['dismissal-date'], 1300);
});

test('outbox survives restart, binds retries to the original pairing and replaces stale waiting notices', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'push-q-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'q.json'),
    q = await openOutbox(file),
    m = {
      method: 'bark',
      token: 'abcdefgh',
      state: { sessionId: 's', turn: 1, terminal: false },
      eventId: 'wait',
    };
  await q.add('a', 3, m);
  await q.add('a', 3, { ...m, eventId: 'end', state: { ...m.state, terminal: true } });
  const reopened = await openOutbox(file);
  const ids = [];
  await reopened.recover(
    () => ({ pair: 3, bark: m.token }),
    (_, v) => ids.push(v.eventId),
  );
  assert.deepEqual(ids, ['end']);
  await reopened.recover(
    () => ({ pair: 4, bark: m.token }),
    () => assert.fail('re-paired device inherited notice'),
  );
  await reopened.close();
});

test('Bark provider POSTs to the private backend and treats provider errors as undelivered', async (t) => {
  let received,
    ok = true;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/push');
    assert.equal(req.method, 'POST');
    let body = '';
    for await (const c of req) body += c;
    received = JSON.parse(body);
    res.end(JSON.stringify({ code: ok ? 200 : 400 }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const deliver = providers({ BARK_ORIGIN: `http://127.0.0.1:${server.address().port}` });
  const m = {
    kind: 'error',
    method: 'bark',
    title: '任务失败',
    report: {task: '排版检查', workspace: '设计组', summary: '校验未通过。'},
    desktopId: 'desk',
    token: 'test-device',
    state: { sessionId: sid, turn: 2, step: 4, detail: '', phase: 'error', terminal: true },
  };
  await deliver({...m, kind:'started', state:{...m.state, terminal:false}});
  assert.equal(received, undefined);
  await deliver(m);
  assert.equal(received.title, '排版检查');
  assert.equal(received.subtitle, '任务失败 · 工作区：设计组');
  assert.equal(received.body, '校验未通过。');
  assert.match(received.icon, /^https:.*AppIcon.png$/);
  assert.equal(received.device_key, 'test-device');
  assert.equal(received.level, 'timeSensitive');
  assert.equal(received.url, `dshmobile://task/desk/${sid}`);
  ok = false;
  await assert.rejects(deliver(m));
});
