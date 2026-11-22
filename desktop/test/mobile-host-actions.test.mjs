import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mobileHostActions, parseGitStatus, workspaceFile } from '../lib/mobile-host-actions.mjs';

test('file preview retains binary bytes and confines paths to regular workspace files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mobile-file-test-'));
  try {
    const workspace = join(dir, 'work');
    const outside = join(dir, 'outside');
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(workspace, 'binary.dat'), Buffer.from([0, 1, 2, 255]));
    await writeFile(join(outside, 'external.txt'), 'not in the workspace');
    await symlink(outside, join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await workspaceFile(workspace, 'binary.dat');
    assert.equal(result.bytes, 4);
    assert.deepEqual(Buffer.from(result.data, 'base64'), Buffer.from([0, 1, 2, 255]));
    for (const candidate of ['../outside/external.txt', 'link/external.txt', 'binary.dat:alt', '/absolute']) {
      await assert.rejects(workspaceFile(workspace, candidate), error => /^mobileFiles\//.test(error.code));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('schedule creation refuses missing sessions and conflicting timing selectors', async () => {
  let received;
  const actions = mobileHostActions({ get: key => ({
    sessionPersistence: { stat: id => id === 'known' ? { cwd: '/test' } : undefined },
    schedule: { create(id, request) { received = [id, request]; return { id: 'new' }; } },
  })[key] });
  const create = actions['mobileSchedule/create'];
  const fields = { title: ' test ', prompt: ' prompt ', after_seconds: 3600 };
  await assert.rejects(create({ request: { ...fields, sessionId: 'unknown' } }), { code: 'mobile/session' });
  await assert.rejects(create({ request: { ...fields, sessionId: 'known', every_seconds: 300 } }), { code: 'mobileSchedule/input' });
  assert.equal(received, undefined);
  assert.deepEqual(await create({ request: { ...fields, sessionId: 'known' } }), { id: 'new' });
  assert.deepEqual(received, ['known', { title: 'test', prompt: 'prompt', after_seconds: 3600 }]);
});

test('Git status handles names with whitespace and separate rename sources', () => {
  assert.deepEqual(parseGitStatus('R  dir/new name\0dir/old name\0 M line\nbreak\0?? --not-a-flag\0'), [
    { index: 'R', worktree: ' ', path: 'dir/new name', previous: 'dir/old name' },
    { index: ' ', worktree: 'M', path: 'line\nbreak' },
    { index: '?', worktree: '?', path: '--not-a-flag' },
  ]);
});
