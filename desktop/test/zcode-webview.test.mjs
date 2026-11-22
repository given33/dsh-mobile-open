import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatSessionScrollMemory, createWebRemoteControlLifecycleRecovery, groupMobileTasks } from '../lib/zcode-webview.mjs';

test('WebView lifecycle recovers from actual suspension, not first pageshow or duplicate wake events', () => {
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const win = Object.assign(new EventTarget(), { navigator: { onLine: true } });
  const changes = [];
  const lifecycle = createWebRemoteControlLifecycleRecovery({
    documentTarget: doc,
    windowTarget: win,
    onSuspend: () => changes.push('stop'),
    onRecover: reason => changes.push(reason),
  });
  const emit = (target, event) => target.dispatchEvent(new Event(event));
  emit(win, 'pageshow');
  assert.deepEqual(changes, []);
  doc.visibilityState = 'hidden';
  emit(doc, 'visibilitychange');
  emit(doc, 'freeze');
  emit(win, 'pagehide');
  emit(win, 'offline');
  emit(win, 'online');
  emit(doc, 'resume');
  assert.equal(lifecycle.isSuspended(), true);
  assert.deepEqual(changes, ['stop']);
  doc.visibilityState = 'visible';
  emit(doc, 'visibilitychange');
  emit(win, 'pageshow');
  emit(doc, 'resume');
  assert.deepEqual(changes, ['stop', 'visible']);
  emit(win, 'offline');
  emit(doc, 'resume');
  emit(win, 'online');
  assert.deepEqual(changes, ['stop', 'visible', 'stop', 'online']);
  lifecycle.dispose();
  emit(win, 'offline');
  assert.equal(lifecycle.isSuspended(), false);
});

test('session scroll memory isolates positions, retains bottom intent, clamps and evicts old entries', () => {
  const cache = createChatSessionScrollMemory(2);
  const full = { scrollHeight: 2000, clientHeight: 200 };
  cache.save('a', { ...full, scrollTop: 381 });
  cache.save('b', { ...full, scrollTop: 1780 });
  assert.equal(cache.resolve(cache.read('b'), { ...full, scrollHeight: 2600 }), 2400);
  assert.equal(cache.resolve(cache.read('a'), { ...full, scrollHeight: 450 }), 250);
  cache.save('c', { ...full, scrollTop: 500 });
  assert.equal(cache.read('b'), null);
  assert.equal(cache.read('a').scrollTop, 381);
});

test('task groups prioritize approval and never stop searching at the first page', () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ id: String(i), title: 'Bug ' + i, workspaceName: '网页' }));
  rows[0].running = true;
  rows[0].pendingInteraction = true;
  rows[1].running = true;
  const all = groupMobileTasks(rows, '');
  assert.deepEqual(all.approval.map(t => t.id), ['0']);
  assert.deepEqual(all.running.map(t => t.id), ['1']);
  assert.equal(all.history.length, 78);
  assert.deepEqual(groupMobileTasks(rows, '网页 BUG 79').history.map(t => t.id), ['79']);
});
