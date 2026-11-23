import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRouteMemory, routedModelFetch } from '../lib/model-routing.mjs';

const base = 'https://model.example/tenant/v1';
const input = { method:'POST', headers:{ 'user-agent':'deepseek-harness/fixture', authorization:'Bearer secret-fixture' }, body:'{"model":"fixture"}' };
const json = status => Response.json({ status }, { status });
async function fixture(t, responder, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'model-routing-'));
  const memory = await openRouteMemory(dir);
  t.after(async () => { await memory.flush(); await rm(dir, {recursive:true,force:true}); });
  const calls = [];
  function load(state) {
    return routedModelFetch({ original:async (url, init) => {
      calls.push([url, init]); return responder(init, calls.length, url);
    }, direct:'direct', hostProxy:() => 'https://configured-proxy', proxyAgent:() => 'proxy', memory:state, ...options });
  }
  return { dir, memory, fetch:load(memory), load, calls, routes:() => calls.map(([,i]) => i.dispatcher) };
}

test('regional denial: same URL, headers and body; learned route survives restart, isolates prefixes and heals', async t => {
  let winner = 'direct';
  const f = await fixture(t, init => json(init.dispatcher === winner ? 200 : 401));
  const url = base + '/chat/completions';
  assert.equal((await f.fetch(url, input)).status, 200);
  assert.deepEqual(f.routes(), ['proxy','direct']);
  for (const [u, opts] of f.calls) { assert.equal(u, url); assert.deepEqual(opts.headers, input.headers); assert.equal(opts.body, input.body); assert.equal(opts.redirect, 'error'); }
  await f.memory.flush();
  const disk = await readFile(join(f.dir, 'model-network-rules.json'), 'utf8');
  assert.doesNotMatch(disk, /fixture|https|tenant|example|Bearer/);
  const restored = await openRouteMemory(f.dir);t.after(() => restored.flush());
  const next = f.load(restored); f.calls.length = 0;
  await next(base+'/models', { ...input, method:'GET', body:undefined });
  winner = 'proxy'; await next(url, input); await next(url, input);
  await next(url.replace('/tenant/', '/other/'),input);
  assert.deepEqual(f.routes(), ['direct','direct','proxy','proxy','proxy']); await restored.flush();
});

test('real credential rejection preserved, no learned rule; 429, cancellation and partial SSE never replay', async t => {
  let responder = (_, i) => new Response('denial '+i, {status:403});
  const f = await fixture(t, (...args) => responder(...args));
  const url = base+'/messages';
  assert.equal(await (await f.fetch(url,input)).text(), 'denial 1');
  assert.deepEqual(f.routes(), ['proxy','direct']);
  responder = () => json(429); await f.fetch(url,input);
  const ac = new AbortController();responder = () => { ac.abort(); throw new Error(); };
  await assert.rejects(f.fetch(url,{...input,signal:ac.signal}),{name:'AbortError'});
  responder = () => new Response(new ReadableStream({start(c){c.error(Error('stream ended'));}}), { headers:{'content-type':'text/event-stream'} });
  await assert.rejects((await f.fetch(url,input)).text(),/stream ended/);
  assert.deepEqual(f.routes(), ['proxy','direct','proxy','proxy','proxy']);
});

test('only pre-connect errors replay a generation; ambiguous disconnect or gateway failure switches on next retry', async t => {
  for (const code of ['ECONNREFUSED','ECONNRESET','504']) {
    const f = await fixture(t, (_, i) => {
      if (i > 1) return json(200);
      if (code === '504') return json(504);
      throw new TypeError('fetch failed', {cause:Object.assign(new Error(), {code})});
    });
    const req = () => f.fetch(base+'/responses',input);
    if (code === 'ECONNRESET') await assert.rejects(req());
    if (code === '504') assert.equal((await req()).status,504);
    if (code !== 'ECONNREFUSED') assert.deepEqual(f.routes(),['proxy']);
    assert.equal((await req()).status,200); assert.deepEqual(f.routes(),['proxy','direct']);
  }
});

test('caller-owned transports, unrelated URLs, ordinary fetches and bypass rules retain original options', async t => {
  const f = await fixture(t, () => json(200));
  for (const [url,opts] of [[base+'/models',{headers:{}}], [base+'/files',input], [base+'/messages',{...input,dispatcher:'mTLS'}], [base.replace('https:', 'http:')+'/messages',input]]) {
    await f.fetch(url,opts); assert.equal(f.calls.at(-1)[1],opts);
  }
  const bypass = await fixture(t, () => json(200), { hostProxy:()=>undefined, systemProxy:()=>undefined });
  await bypass.fetch(base+'/messages',input);assert.equal(bypass.calls[0][1],input);
  const system = await fixture(t, opts => json(opts.dispatcher === 'direct' ? 200 : 403), {hostProxy:()=>undefined,systemProxy:async ()=>'http://system-proxy'});
  await system.fetch(base+'/messages',input);assert.deepEqual(system.routes(),['proxy','direct']);
});

test('a stalled model listing switches quickly without imposing a first-token timeout on inference', async t => {
  const f = await fixture(t, (init, index) => {
    if (index === 1) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), {once:true}));
    return json(200);
  }, {listingTimeoutMs: 10});
  assert.equal((await f.fetch(base+'/models', {headers:input.headers})).status,200);
  assert.deepEqual(f.routes(), ['proxy','direct']);
  await f.fetch(base+'/messages', input);
  assert.equal(f.calls.at(-1)[1].signal, undefined);
});
