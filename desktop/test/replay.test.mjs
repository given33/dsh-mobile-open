import test from 'node:test';
import assert from 'node:assert/strict';
import { replayUpstream, streamKey, rpcKey } from '../lib/upstream-replay.mjs';

const fixture = {
  rpc: { 'session/list': { items: [{ sessionId: 's1', running: true }] }, 'session/page:s1:7': { records: [], hasMore: false } },
  streams: {
    '$events': [{ at: 0, value: { type: 'ready', clientId: 'c' } }],
    'session/follow:s1': [{ at: 0, value: { type: 'snapshot', cursor: 7 } }, { at: 40, value: { type: 'assistant-stream', frame: { type: 'start' } } }],
  },
};

test('keys identify sessions and pages', () => {
  assert.equal(streamKey('session/follow', { request: { address: { kind: 'session', sessionId: 's1' } } }), 'session/follow:s1');
  assert.equal(streamKey('job/list', { request: { sessionId: 's1' } }), 'job/list:s1');
  assert.equal(streamKey('job/follow', { request: { sessionId: 's1', jobId: 'j1' } }), 'job/follow:j1');
  assert.equal(rpcKey('session/page', { request: { address: { sessionId: 's1' }, beforeSeq: 7 } }), 'session/page:s1:7');
});

test('rpc answers from the fixture and reports gaps as Harness errors', async () => {
  const up = replayUpstream(fixture);
  const ok = JSON.parse((await up.rpc('session/list', Buffer.from(JSON.stringify({ rpcId: 'a', payload: { args: { _request: {} } } })))).body);
  assert.equal(ok.rpcId, 'a'); assert.equal(ok.result.value.items[0].sessionId, 's1');
  const page = JSON.parse((await up.rpc('session/page', Buffer.from(JSON.stringify({ rpcId: 'b', payload: { args: { request: { address: { sessionId: 's1' }, beforeSeq: 7 } } } })))).body);
  assert.equal(page.result.ok, true);
  const missing = JSON.parse((await up.rpc('workspace/list', Buffer.from(JSON.stringify({ rpcId: 'c', payload: { args: {} } })))).body);
  assert.equal(missing.result.ok, false);
});

test('streams replay with the client stream id, in order, and stop on cancel', async () => {
  const up = replayUpstream(fixture, { speed: 1 });
  const mux = await up.mux();
  const got = [];
  mux.on('message', data => got.push(JSON.parse(data.toString())));
  mux.send(JSON.stringify({ type: 'open', streamId: 'mine', endpoint: 'session/follow', payload: { args: { request: { address: { sessionId: 's1' } } } } }));
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(got.map(f => [f.streamId, f.value.type]), [['mine', 'snapshot']]);
  mux.send(JSON.stringify({ type: 'cancel', streamId: 'mine' }));
  await new Promise(r => setTimeout(r, 60));
  assert.equal(got.length, 1, 'cancelled stream sends nothing more');
  const fast = await replayUpstream(fixture, { speed: Infinity }).mux();
  const all = []; fast.on('message', d => all.push(JSON.parse(d.toString())));
  fast.send(JSON.stringify({ type: 'open', streamId: 'x', endpoint: 'session/follow', payload: { args: { request: { address: { sessionId: 's1' } } } } }));
  await new Promise(r => setTimeout(r, 5));
  assert.equal(all.length, 2);
  let closed = false; fast.on('close', () => { closed = true; }); fast.close();
  assert.equal(closed, true);
});
