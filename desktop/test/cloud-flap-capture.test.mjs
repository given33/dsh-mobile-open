// Run directly with --capture and the exported iPhone console log. The twelfth
// switch-request is an end marker, so silence cannot masquerade as a full minute.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { RECONNECT_POLICY } from '../lib/mobile-shell.mjs';

function auditCapture(text) {
  const records = [...text.matchAll(/\[dsh-link\] ms=(\d+) ticket=\S+ page=\S+ ([^\r\n]+)/g)]
    .map(([, time, event]) => ({ ms: Number(time), event: event.trim() }));
  const clicks = records.flatMap(({ event }, i) => event.startsWith('switch-request target=') ? [i] : []);
  assert.equal(clicks.length, 12, 'capture 11 observed switches and one final end-marker click');
  return clicks.slice(0, -1).map((offset, i) => {
    const click = records[offset], end = records[clicks[i + 1]], target = i % 2 ? 'desktop' : 'cloud';
    const events = records.slice(offset + 1, clicks[i + 1]);
    assert.equal(click.event, `switch-request target=${target}`, `round ${i + 1}`);
    const activations = events.filter(e => e.event.startsWith('activate target='));
    assert.deepEqual(activations.map(e => e.event), [`activate target=${target}`], `round ${i + 1} target`);
    const targetEvents = events.slice(events.indexOf(activations[0]) + 1);
    const connected = targetEvents.filter(e => /^ws \w+->connected$/.test(e.event));
    assert.equal(connected.length, 1, `round ${i + 1} logical connected transitions`);
    const latency = connected[0].ms - click.ms, observed = end.ms - connected[0].ms;
    assert.ok(latency >= 0 && (!i || latency <= 5000), `round ${i + 1}: click to connected ${latency}ms`);
    assert.ok(observed >= 60000, `round ${i + 1}: only ${observed}ms after connected`);
    assert.ok(!targetEvents.some(e => /^(?:force-reconnect|forced-reconnect|breaker-open)\b/.test(e.event)), `round ${i + 1}: client intervened`);
    assert.ok(!targetEvents.slice(targetEvents.indexOf(connected[0]) + 1).some(e => /^ws |^document-start$/.test(e.event)), `round ${i + 1}: connection or document changed`);
    return { round: i + 1, target, clickToConnectedMs: latency, observedMs: observed, connected: 1, disconnected: 0, forced: 0 };
  });
}

// Dedicated capture: trip the breaker, restore a reachable upstream, then tap Retry once.
function auditRetry(text) {
  const events = [...text.matchAll(/\[dsh-link\] ms=(\d+) ticket=(\S+) page=(\S+) ([^\r\n]+)/g)]
    .map(([, ms, ticket, page, detail]) => ({ ms: Number(ms), ticket, page, detail }));
  const tap = events.findIndex(e => e.detail === 'retry-request');
  assert.ok(tap > 0, 'missing Retry tap');
  const click = events[tap];
  const previous = events.slice(0, tap);
  const trip = previous.findLastIndex(e => e.detail.startsWith('breaker-open '));
  assert.ok(trip >= 0 && previous[trip].page === click.page && !previous.slice(trip + 1).some(e => e.detail.startsWith('override ')), 'tap on the tripped device');
  const remaining = previous[trip].ms + RECONNECT_POLICY.breakerCooldownMs - click.ms;
  assert.ok(remaining > 0, 'tap inside cooldown');
  const after = events.slice(tap + 1);
  const reset = after.findIndex(e => e.detail === 'override source=userRetry budget=cleared' && e.ticket === click.ticket);
  const start = after.findIndex(e => e.detail.startsWith('begin source=userRetry '));
  assert.ok(reset >= 0 && start > reset, 'missing clear or userRetry begin');
  const begin = after[start];
  assert.ok(after[reset].ms >= click.ms && begin.ms >= after[reset].ms && begin.ms - click.ms < Math.min(1000, remaining), 'Retry did not start immediately');
  const connected = after.slice(start + 1).find(e => e.ticket === begin.ticket && /^ws \w+->connected$/.test(e.detail));
  assert.ok(connected && connected.ms >= begin.ms && connected.ms - click.ms < remaining, 'no recovery on the Retry ticket inside cooldown');
  return { clickToBeginMs: begin.ms - click.ms, clickToConnectedMs: connected.ms - click.ms };
}

if (process.argv[2] === '--capture') {
  console.table(auditCapture(await readFile(process.argv[3], 'utf8')));
  if (process.argv[4]) console.table(auditRetry(await readFile(process.argv[4], 'utf8')));
} else if (process.argv[2] === '--retry-capture') {
  console.table(auditRetry(await readFile(process.argv[3], 'utf8')));
} else {
  test('physical capture auditor requires eleven complete target windows and rejects reconnects and slow switches', () => {
    const lines = [];
    const line = (ms, event) => `[dsh-link] ms=${ms} ticket=t page=p ${event}`;
    for (let i = 0; i < 12; i++) {
      const at = i * 65000, target = i % 2 ? 'desktop' : 'cloud';
      lines.push(line(at, `switch-request target=${target}`));
      if (i < 11) lines.push(line(at + 100, `activate target=${target}`), line(at + 4500, 'ws connecting->connected'));
    }
    const capture = lines.join('\n');
    assert.equal(auditCapture(capture).length, 11);
    assert.throws(() => auditCapture(lines.slice(0, -1).join('\n')), /end-marker/);
    assert.throws(() => auditCapture(capture.replace('ms=715000', 'ms=714499')), /only 59999ms/);
    assert.throws(() => auditCapture(capture.replace('ms=69500', 'ms=70001')), /5001ms/);
    for (const event of ['ws connected->disconnected', 'ws connecting->connected', 'force-reconnect reason=wakeCheck', 'document-start']) {
      const corrupted = [...lines]; corrupted.splice(3, 0, line(10000, event));
      assert.throws(() => auditCapture(corrupted.join('\n')));
    }
  });
  test('physical retry capture requires a tap inside cooldown, immediate clear and recovery on the same attempt', () => {
    const log = [
      '[dsh-link] ms=1000 ticket=a page=p breaker-open reason=upstream-1011',
      '[dsh-link] ms=5000 ticket=a page=p retry-request',
      '[dsh-link] ms=5001 ticket=a page=p override source=userRetry budget=cleared',
      '[dsh-link] ms=5002 ticket=b page=p begin source=userRetry reuseCandidate=true',
      '[dsh-link] ms=8500 ticket=b page=p ws connecting->connected',
    ].join('\n');
    assert.deepEqual(auditRetry(log), { clickToBeginMs: 2, clickToConnectedMs: 3500 });
    assert.throws(() => auditRetry(log.replace('ms=5002', 'ms=62000')), /immediately/);
    assert.throws(() => auditRetry(log.replace('budget=cleared', 'suppressed')), /missing clear/);
    assert.throws(() => auditRetry(log.replace('8500 ticket=b', '8500 ticket=c')), /no recovery/);
  });
}
