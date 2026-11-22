import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mobileHostActions, nativeScheduleAction, parseGitStatus, workspaceFile } from '../lib/mobile-host-actions.mjs';

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

test('host-wide scheduling preserves native rules, session scope and optimistic revision', async () => {
  const record = { id: 'task', title: 'test', prompt: 'message', kind: 'after', afterSeconds: 3600, scheduledAt: '2027-01-01T01:00:00.000Z' };
  const target = { kind: 'session', sessionId: 's1' };
  const row = { ...record, target, status: 'active', updatedAt: '2027-01-01T00:00:00.000Z' };
  const calls = [];
  const service = {
    catalog: () => [row, { ...row, id: 'other', target: { kind: 'new' } }],
    view: () => row,
    history: request => { calls.push(request); return { records: [], nextBefore: 'older' }; },
    create: (request, _, signal) => { calls.push([request, signal]); return row; },
    edit: (request, _, signal) => { calls.push([request, signal]); return request.action === 'delete' ? { deleted: true } : { ...row, ...request.patch }; },
  };
  const ctx = { get: key => key === 'schedule' ? service : key === 'sessionPersistence' ? { stat: () => ({ cwd: '/test' }) } : undefined };
  const signal = new AbortController().signal;
  const call = (name, request) => nativeScheduleAction(ctx, `schedule/${name}`)({ request }, signal);
  assert.equal(nativeScheduleAction({ get: () => ({ create() {} }) }, 'schedule/list'), undefined);
  assert.equal(nativeScheduleAction(ctx, 'schedule/edit'), undefined);
  await mobileHostActions(ctx)['mobileSchedule/create']({ request: { sessionId: 's1', title: ' test ', prompt: ' message ', after_seconds: 3600 } }, signal);
  assert.deepEqual(calls.shift(), [{ title: 'test', prompt: 'message', timing: { kind: 'after', after_seconds: 3600 }, target }, signal]);
  assert.deepEqual((await call('catalog')).map(task => task.sessionId), ['s1']);
  assert.deepEqual(await call('list', { sessionId: 's2' }), []);
  assert.equal((await call('history', { id: 'task', sessionId: 's1', limit: 1, before: 'cursor' })).nextBefore, 'older');
  assert.deepEqual(calls.shift(), { id: 'task', limit: 1, before: 'cursor' });
  assert.deepEqual(await call('delete', { id: 'task', sessionId: 's2' }), { deleted: false });
  assert.equal((await call('update', { id: 'task', sessionId: 's1', expected: {} })).code, 'schedule_conflict');
  assert.deepEqual(calls, []);
  const update = await call('update', { id: 'task', sessionId: 's1', title: 'changed', expected: record,
    change: { kind: 'every', every_seconds: 3600 } });
  assert.equal(update.record.title, 'changed');
  assert.deepEqual(calls.shift(), [{ id: 'task', action: 'update', expectedUpdatedAt: row.updatedAt,
    patch: { title: 'changed', timing: { kind: 'every', every_seconds: 3600 } } }, signal]);
  assert.equal((await call('delete', { id: 'task', sessionId: 's1' })).deleted, true);
  assert.deepEqual(calls.shift(), [{ id: 'task', action: 'delete', expectedUpdatedAt: row.updatedAt }, signal]);
});

test('Git status handles names with whitespace and separate rename sources', () => {
  assert.deepEqual(parseGitStatus('R  dir/new name\0dir/old name\0 M line\nbreak\0?? --not-a-flag\0'), [
    { index: 'R', worktree: ' ', path: 'dir/new name', previous: 'dir/old name' },
    { index: ' ', worktree: 'M', path: 'line\nbreak' },
    { index: '?', worktree: '?', path: '--not-a-flag' },
  ]);
});
