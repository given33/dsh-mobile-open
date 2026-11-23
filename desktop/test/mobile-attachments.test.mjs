import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as fflate from 'fflate';
import { MOBILE_FILE_LIMIT } from '../lib/mobile-attachments.mjs';

const worker = readFileSync(new URL('../lib/folder-worker.js', import.meta.url), 'utf8');
async function pack(entries, limit = MOBILE_FILE_LIMIT) {
  let result;
  const self = { postMessage(value) { result = value; } };
  vm.runInNewContext(worker, { self, fflate, File, Blob, Uint8Array });
  const items = entries.map(([path, text]) => ({ path, file: new File([text], path.split('/').at(-1)) }));
  await self.onmessage({ data: { items, limit } });
  return result;
}

test('folder uploads preserve nested duplicate names, Unicode, and zero-byte files', async () => {
  const entries = [['目录/A/同.txt','a'], ['目录/B/同.txt','b'], ['目录/空','']];
  const { archive } = await pack(entries);
  assert.equal(archive.name, '目录.zip');
  const files = fflate.unzipSync(new Uint8Array(await archive.arrayBuffer()));
  assert.deepEqual(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, fflate.strFromU8(bytes)])), Object.fromEntries(entries));
  assert.equal((await pack(entries, archive.size)).archive.size, archive.size);
  assert.match((await pack(entries, archive.size - 1)).error, /200 MB/);
});

test('folder packer rejects duplicate, escaping and mixed-root entries, without returning a partial file', async () => {
  for (const paths of [['a/../z'], ['a/./z'], ['a/z','a/z'], ['a/x','b/z'], ['a/c:\\z']]) {
    const result = await pack(paths.map(path => [path, 'x']));
    assert.match(result.error, /路径/);
    assert.equal(result.archive, undefined);
  }
});
