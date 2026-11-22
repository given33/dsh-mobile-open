/* Same-origin dedicated worker. Inflate only document XML, never media, macros,
   embedded programs, external relationships or an archive-supplied URL. */
'use strict';
const LIMIT = 6 * 1024 * 1024;
function decodeXmlBytes(bytes) {
  let slice = bytes;
  let enc = '';
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    slice = bytes.subarray(3);
    enc = 'utf-8';
  } else if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 60)) {
    enc = 'utf-16be';
  } else if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 60 && bytes[1] === 0)) {
    enc = 'utf-16le';
  } else {
    const m = new TextDecoder('latin1')
      .decode(bytes.subarray(0, 256))
      .match(/^\s*<\?xml\s[^?]*encoding\s*=\s*["']([\w.-]+)["']/i);
    if (m) enc = /^(?:gb2312|gbk|cp936)$/i.test(m[1]) ? 'gb18030' : m[1];
  }
  const order = [];
  if (enc) order.push(enc);
  if (!order.includes('utf-8')) order.push('utf-8');
  if (!order.includes('gb18030')) order.push('gb18030');
  for (const label of order) {
    try {
      return new TextDecoder(label, { fatal: true }).decode(slice);
    } catch {}
  }
  return new TextDecoder(order[0] || 'utf-8', { fatal: false }).decode(slice);
}
function unpack(buf) {
  const data = new Uint8Array(buf),
    v = new DataView(buf),
    u16 = (i) => v.getUint16(i, true),
    u32 = (i) => v.getUint32(i, true);
  if (data.length > 32 * 1024 * 1024) throw Error('文件较大，请切换原版式或下载');
  let end = data.length - 22;
  const min = Math.max(0, end - 65535);
  for (; end >= min; end--)
    if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === data.length) break;
  if (end < min || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10))
    throw Error('不支持此压缩格式');
  const count = u16(end + 10);
  let p = u32(end + 16);
  if (count > 8192 || p + u32(end + 12) > end) throw Error('文档超出预览限制');
  const files = new Map(),
    utf = new TextDecoder();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || u32(p) !== 0x02014b50) throw Error('文档目录不完整');
    const a = u16(p + 28),
      step = 46 + a + u16(p + 30) + u16(p + 32);
    if (p + step > end) throw Error('文档目录不完整');
    const rawName = utf.decode(data.subarray(p + 46, p + 46 + a)).replace(/\\/g, '/');
    const name = rawName.toLowerCase();
    if (
      /^(?:word\/document\.xml|content\.xml|ppt\/slides\/slide\d+\.xml|ppt\/presentation\.xml|ppt\/_rels\/presentation\.xml\.rels)$/.test(
        name,
      )
    ) {
      const size = u32(p + 24);
      total += size;
      if (total > LIMIT || files.size >= 256 || u16(p + 8) & 1 || files.has(name))
        throw Error('文档加密或超出预览限制');
      files.set(name, { size, packed: u32(p + 20), method: u16(p + 10), off: u32(p + 42) });
    }
    p += step;
  }
  if (!files.size) throw Error('没有可读原文');
  return [...files].map(([name, { size, packed, method, off }]) => {
    if (off + 30 > data.length || u32(off) !== 0x04034b50) throw Error('文档已损坏');
    const pos = off + 30 + u16(off + 26) + u16(off + 28);
    if (pos + packed > end) throw Error('文档不完整');
    const src = data.subarray(pos, pos + packed);
    let bytes;
    if (method === 0 && size === packed) bytes = src;
    else if (method === 8) {
      bytes = new Uint8Array(size);
      let used = 0;
      const inflater = new fflate.Inflate((chunk) => {
        if (used + chunk.length > size) throw Error('文档尺寸不匹配');
        bytes.set(chunk, used);
        used += chunk.length;
      });
      for (let i = 0; i < src.length; i += 2048)
        inflater.push(src.subarray(i, i + 2048), i + 2048 >= src.length);
      if (used !== size) throw Error('文档不完整');
    } else throw Error('不支持此压缩格式');
    const xml = decodeXmlBytes(bytes);
    if (/<!DOCTYPE/i.test(xml)) throw Error('不支持带外部声明的 XML');
    return [name, xml];
  });
}
self.onmessage = ({ data }) => {
  try {
    postMessage({ files: unpack(data) });
  } catch (e) {
    postMessage({ error: e.message || '文档无法读取' });
  }
};
