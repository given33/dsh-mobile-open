import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHomeDirectory, listHomeDirectories } from '../lib/directory-picker.mjs';

test('local folder picker keeps the desktop-only fallback inside the home directory', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-folder-test-'));
  try {
    const home = join(temp, 'home');
    const documents = join(home, 'Documents');
    const outside = join(temp, 'outside');
    await mkdir(documents, { recursive: true });
    await mkdir(outside);
    await writeFile(join(home, 'not-a-directory.txt'), 'file');
    await symlink(outside, join(home, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await listHomeDirectories(undefined, home);
    assert.deepEqual(result.entries.map(item => item.name), ['Documents']);
    assert.deepEqual((await listHomeDirectories(documents, home)).crumbs.map(item => item.path), [home, documents]);
    for (const target of [outside, join(home, 'link')]) {
      await assert.rejects(listHomeDirectories(target, home), { code: 'directory-picker/outside-home' });
      await assert.rejects(createHomeDirectory(target, 'blocked', home), { code: 'directory-picker/outside-home' });
    }
    assert.equal(await createHomeDirectory(documents, 'new-folder', home), join(documents, 'new-folder'));
    await assert.rejects(createHomeDirectory(documents, 'new-folder', home), { code: 'directory-picker/exists' });
    await assert.rejects(createHomeDirectory(documents, '../escape', home), { code: 'directory-picker/create-failed' });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
