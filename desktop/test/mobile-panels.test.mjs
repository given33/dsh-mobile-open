import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelRegistry } from '../lib/mobile-panels.mjs';
import { streamKey, rpcKey } from '../lib/upstream-replay.mjs';

test('native panels expose declared controls, dispatch guarded writes, and unload', async () => {
  const registry = createPanelRegistry();
  let revision = 1, writes = 0;
  const id = 'example:counter';
  const dispose = registry.register('example', {
    id: 'counter', title: 'Counter',
    fields: [
      { id: 'key', title: 'Key', kind: 'secret' },
      { id: 'mode', title: 'Mode', kind: 'select', required: true, options: [{ id: 'a', title: 'A' }] },
    ],
    read: () => ({ revision, values: { key: 'stored-secret', mode: 'a', extra: 'private' } }),
    actions: [{
      id: 'save', title: 'Save', confirm: true,
      run(values, context) {
        assert.equal(context.expectedRevision, '1');
        assert.equal(values.mode, 'a');
        revision++; writes++;
        return 'Saved';
      },
    }],
  });
  assert.equal((await registry.list())[0].id, id);
  const view = await registry.read({ id });
  assert.ok(!JSON.stringify(view).includes('stored-secret'));
  assert.ok(!JSON.stringify(view).includes('private'));
  assert.deepEqual(view.actions, [{ id: 'save', title: 'Save', confirm: true }]);
  const args = { id, action: 'save', expectedRevision: view.revision, values: { mode: 'a' } };
  await assert.rejects(registry.perform({ ...args, values: { mode: 'b' } }), /字段/);
  await assert.rejects(registry.perform({ ...args, values: { mode: 'a', undeclared: 1 } }), /字段/);
  assert.deepEqual(await registry.perform(args), { message: 'Saved' });
  await assert.rejects(registry.perform(args), { code: 'mobilePanels/stale' });
  assert.equal(writes, 1);
  dispose();
  await assert.rejects(registry.read({ id }), { code: 'mobilePanels/unavailable' });
  assert.deepEqual(await registry.list(), []);
});

test('subagent replay uses the child identity instead of the parent', () => {
  const args = { request: { address: { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child' }, beforeSeq: 42 } };
  assert.equal(streamKey('session/follow', args), 'session/follow:child');
  assert.equal(rpcKey('session/page', args), 'session/page:child:42');
});
