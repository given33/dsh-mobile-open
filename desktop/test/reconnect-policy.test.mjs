import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { RECONNECT_POLICY, initialForceState, nextForceState as next, shouldForceReconnect as allow } from '../lib/mobile-shell.mjs';

test('Swift and shipped JS match the millisecond policy contract', async () => {
  const contract = { handshakeGraceMs: 12000, confirmWindowMs: 3000, wsAliveSamples: 2,
    minForceReconnectGapMs: 5000, breakerAfter: 3, breakerDecisionMs: 10000,
    breakerCooldownMs: 60000, recoveryDelaysMs: [3500, 6000, 10000, 20000, 30000] };
  const swift = await readFile(new URL('../../DSHMobile/App/AppModel.swift', import.meta.url), 'utf8');
  assert.deepEqual(RECONNECT_POLICY, contract);
  for (const [name, expected] of Object.entries(contract)) {
    const match = swift.match(new RegExp(`static let ${name} = (.*)`));
    assert.deepEqual(JSON.parse(match[1]), expected, name);
  }
});

test('document and each new mux protect pending subscriptions and share one 5000ms gap', () => {
  let s = initialForceState(1000);
  assert.equal(allow(s, 12999), false);
  s = next(s, { type: 'loaded' }, 1100);
  s = next(s, { type: 'mux' }, 12000);
  s = next(s, { type: 'open' }, 12001);
  for (const reason of ['bridge', 'credentialsChanged', 'wakeCheck', 'poke-wsAlive']) assert.equal(allow(s, 23999, reason), false);
  assert.equal(allow(s, 24000), true);
  s = next(s, { type: 'forced' }, 24000);
  assert.equal(allow(s, 28999), false); assert.equal(allow(s, 29000), true);
  let replacement = initialForceState(24500, s.budget);
  replacement = next(replacement, { type: 'state', state: 'connected' }, 24600);
  replacement = next(replacement, { type: 'close', code: 1000 }, 24700);
  assert.equal(allow(replacement, 28999), false); assert.equal(allow(replacement, 29000), true);
});

test('two negative pokes 3000ms apart, with no intervening ws activity or stale reply', () => {
  let s = next(initialForceState(0), { type: 'open' }, 10);
  s = next(s, { type: 'state', state: 'connected' }, 100);
  const sample = (time, alive = false, epoch = s.epoch) => { s = next(s, { type: 'poke', alive, epoch }, time); };
  const dead = time => allow(s, time, 'poke-wsAlive');
  sample(101); sample(3100); assert.equal(dead(3100), false);
  let now = 3101;
  for (const event of [{ type: 'item' }, { type: 'state', state: 'reconnecting' }]) {
    const before = s.epoch;
    s = next(s, event, now++); sample(now++, false, before);
    assert.equal(s.samples, 0); sample(now++); assert.equal(dead(now), false);
  }
  sample(6103, true); assert.equal(s.samples, 0);
  sample(6104); assert.equal(dead(6104), false);
  sample(9104); assert.equal(s.samples, 2); assert.equal(dead(9104), true);
});

test('three unsuccessful forces reserve a 10s verdict then a 60s cooldown; connected cancels the verdict', () => {
  let s = initialForceState(0);
  for (const now of [12000, 17000, 22000]) {
    assert.equal(allow(s, now), true); s = next(s, { type: 'forced' }, now);
  }
  assert.equal(allow(s, 27000), false);
  assert.equal(next(s, { type: 'tick' }, 31999).budget.until, 0);
  const recovered = next(s, { type: 'state', state: 'connected' }, 31999);
  assert.equal(next(recovered, { type: 'tick' }, 32000).budget.until, 0);
  s = next(s, { type: 'tick' }, 32000); assert.equal(s.budget.until, 92000);
  for (const now of [32000, 91999]) {
    for (const reason of ['bridge', 'wakeCheck', 'credentialsChanged', 'poke-wsAlive']) assert.equal(allow(s, now, reason), false);
    assert.equal(next(s, { type: 'tick' }, now).budget.until, 92000);
  }
  assert.equal(allow(s, 92000), true);
});
