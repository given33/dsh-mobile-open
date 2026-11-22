import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as fflate from 'fflate';
const script = readFileSync(new URL('../lib/reader-worker.js', import.meta.url), 'utf8');
function read(entries) {
  const archive = entries instanceof Uint8Array ? entries : fflate.zipSync(entries);
  let result;
  const self = {};
  runInNewContext(script, {
    self,
    Uint8Array,
    DataView,
    TextDecoder,
    fflate,
    postMessage: (v) => {
      result = v;
    },
  });
  self.onmessage({ data: archive.slice().buffer });
  return result;
}
const enc = (s) => new TextEncoder().encode(s);
test('reads UTF-8 and UTF-16 originals without loading fonts, media, or macros', () => {
  const text = '简繁・한글・العربية・👩🏽‍💻・∑';
  const r = read({
    'word/document.xml': enc('<p>' + text + '</p>'),
    'word/media/bg.png': enc('unused'),
    'word/vbaProject.bin': enc('unused'),
  });
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0][1], '<p>' + text + '</p>');
  const xml = '<?xml version="1.0" encoding="UTF-16"?><p>' + text + '</p>';
  assert.equal(read({ 'content.xml': Buffer.from('\ufeff' + xml, 'utf16le') }).files[0][1], xml);
});
test('bad archives, declarations, and oversized selected XML get an explicit fallback', () => {
  for (const fixture of [
    new Uint8Array(12),
    { 'word/media/no-text.png': enc('none') },
    { 'word/document.xml': enc('<!DOCTYPE doc><doc/>') },
    { 'word/document.xml': new Uint8Array(6 * 1024 * 1024 + 1) },
  ])
    assert.equal(typeof read(fixture).error, 'string');
});
