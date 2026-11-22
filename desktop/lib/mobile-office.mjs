// Fast host-side Office & delimited document extractor for mobile reading.
// Runs directly on the desktop (native zlib + full ICU TextDecoder), ignoring
// megabytes of embedded images/media/macros and eliminating mobile CJK/Symbol
// mojibake before sending a compact structured JSON payload to the phone.

import { inflateRawSync } from 'node:zlib';
import { basename, extname } from 'node:path';

export const SUPPORTED_OFFICE_EXTENSIONS = [
  'docx', 'doc', 'pptx', 'odt', 'odp', 'ods', 'xlsx', 'csv', 'tsv',
];

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_XML_BYTES = 16 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 16384;
const MAX_SELECTED_FILES = 512;
const MAX_BLOCKS = 4000;
const MAX_CHARS = 1_500_000;
const MAX_TABLE_ROWS = 500;
const MAX_TABLE_COLS = 40;
const CACHE_LIMIT = 24;

const resultCache = new Map();

// Complete Symbol font (0x20..0xFF) -> Unicode map (Greek + engineering math).
const SYMBOL_MAP = {
  0x22: '∀', 0x24: '∃', 0x27: '∋', 0x2A: '∗', 0x2D: '−', 0x40: '≅',
  0x41: 'Α', 0x42: 'Β', 0x43: 'Χ', 0x44: 'Δ', 0x45: 'Ε', 0x46: 'Φ',
  0x47: 'Γ', 0x48: 'Η', 0x49: 'Ι', 0x4A: 'ϑ', 0x4B: 'Κ', 0x4C: 'Λ',
  0x4D: 'Μ', 0x4E: 'Ν', 0x4F: 'Ο', 0x50: 'Π', 0x51: 'Θ', 0x52: 'Ρ',
  0x53: 'Σ', 0x54: 'Τ', 0x55: 'Υ', 0x56: 'ς', 0x57: 'Ω', 0x58: 'Ξ',
  0x59: 'Ψ', 0x5A: 'Ζ', 0x5C: '∴', 0x5E: '⊥', 0x60: '‾',
  0x61: 'α', 0x62: 'β', 0x63: 'χ', 0x64: 'δ', 0x65: 'ε', 0x66: 'φ',
  0x67: 'γ', 0x68: 'η', 0x69: 'ι', 0x6A: 'ϕ', 0x6B: 'κ', 0x6C: 'λ',
  0x6D: 'μ', 0x6E: 'ν', 0x6F: 'ο', 0x70: 'π', 0x71: 'θ', 0x72: 'ρ',
  0x73: 'σ', 0x74: 'τ', 0x75: 'υ', 0x76: 'ϖ', 0x77: 'ω', 0x78: 'ξ',
  0x79: 'ψ', 0x7A: 'ζ', 0x7E: '∼',
  0xA0: '€', 0xA1: 'ϒ', 0xA2: '′', 0xA3: '≤', 0xA4: '⁄', 0xA5: '∞',
  0xA6: 'ƒ', 0xA7: '♣', 0xA8: '♦', 0xA9: '♥', 0xAA: '♠', 0xAB: '↔',
  0xAC: '←', 0xAD: '↑', 0xAE: '→', 0xAF: '↓', 0xB0: '°', 0xB1: '±',
  0xB2: '″', 0xB3: '≥', 0xB4: '×', 0xB5: '∝', 0xB6: '∂', 0xB7: '•',
  0xB8: '÷', 0xB9: '≠', 0xBA: '≡', 0xBB: '≈', 0xBC: '…', 0xBD: '│',
  0xBE: '─', 0xBF: '↵', 0xC0: 'ℵ', 0xC1: 'ℑ', 0xC2: 'ℜ', 0xC3: '℘',
  0xC4: '⊗', 0xC5: '⊕', 0xC6: '∅', 0xC7: '∩', 0xC8: '∪', 0xC9: '⊃',
  0xCA: '⊇', 0xCB: '⊄', 0xCC: '⊂', 0xCD: '⊆', 0xCE: '∈', 0xCF: '∉',
  0xD0: '∠', 0xD1: '∇', 0xD2: '®', 0xD3: '©', 0xD4: '™', 0xD5: '∏',
  0xD6: '√', 0xD7: '⋅', 0xD8: '¬', 0xD9: '∧', 0xDA: '∨', 0xDB: '⇔',
  0xDC: '⇐', 0xDD: '⇑', 0xDE: '⇒', 0xDF: '⇓', 0xE0: '◊', 0xE1: '⟨',
  0xE5: '∑', 0xF1: '⟩', 0xF2: '∫',
};

// Wingdings / Wingdings 2 / Wingdings 3 / Webdings common bullets, checks, arrows.
const WINGDINGS_MAP = {
  0x21: '✎', 0x22: '✂', 0x27: '🕯', 0x28: '☎', 0x2A: '✉', 0x2B: '✉',
  0x32: '📄', 0x3C: '💾', 0x46: '☞', 0x4A: '☺', 0x4C: '☹',
  0x6C: '●', 0x6D: '○', 0x6E: '■', 0x6F: '□', 0x70: '▪', 0x71: '▫',
  0x72: '❑', 0x73: '◆', 0x74: '◆', 0x75: '◆', 0x76: '❖', 0x77: '◆',
  0x78: '☒', 0x79: '⌧', 0x9E: '•', 0x9F: '•', 0xA0: '▪', 0xA1: '○',
  0xA2: '●', 0xA4: '◉', 0xA6: '❏', 0xA7: '■', 0xA8: '□', 0xA9: '◆',
  0xAA: '✦', 0xAB: '★', 0xD8: '➢', 0xDF: '←', 0xE0: '→', 0xE1: '↑',
  0xE2: '↓', 0xE7: '←', 0xE8: '→', 0xE9: '↑', 0xEA: '↓', 0xEF: '⇦',
  0xF0: '⇨', 0xF1: '⇧', 0xF2: '⇩', 0xFB: '✗', 0xFC: '✓', 0xFD: '☒',
  0xFE: '☑',
};

const WINGDINGS2_MAP = {
  0x4F: '✗', 0x50: '✓', 0x51: '☒', 0x52: '☑', 0x53: '☒', 0x54: '☑',
  0x55: '✗', 0x56: '✗', 0x97: '•', 0x98: '●', 0xA2: '■', 0xA3: '□',
  0xA4: '▪', 0xA5: '▫', 0xA6: '◆', 0xA7: '◇',
};

const WINGDINGS3_MAP = {
  0x61: '←', 0x62: '→', 0x63: '↑', 0x64: '↓', 0x65: '↖', 0x66: '↗',
  0x67: '↙', 0x68: '↘', 0x69: '↔', 0x6A: '↕', 0x70: '▲', 0x71: '▼',
  0x74: '◄', 0x75: '►', 0x80: '➔', 0x81: '→', 0x82: '←', 0x83: '↑',
  0x84: '↓',
};

// Stray PUA \uF020..\uF0FF glyphs embedded directly in Word/WPS text without font tag.
const PUA_FALLBACK_MAP = {
  0x6C: '●', 0x6D: '○', 0x6E: '■', 0x6F: '□', 0x70: '▪', 0x71: '▫',
  0x75: '◆', 0x76: '❖', 0x77: '◆', 0x9F: '•', 0xA1: '○', 0xA7: '■',
  0xA8: '□', 0xAB: '★', 0xB0: '°', 0xB1: '±', 0xB3: '≥', 0xB4: '×',
  0xB7: '•', 0xB8: '÷', 0xB9: '≠', 0xBB: '≈', 0xD6: '√', 0xD7: '⋅',
  0xD8: '➢', 0xDE: '⇒', 0xE0: '➔', 0xE8: '→', 0xF0: '⇨', 0xFB: '✗',
  0xFC: '✓', 0xFD: '☒', 0xFE: '☑',
};

function symbolTableForFont(fontName) {
  const f = String(fontName || '').trim().toLowerCase();
  if (!f) return null;
  if (f === 'symbol' || f === 'mt extra' || f === 'mtextra') return SYMBOL_MAP;
  if (f === 'wingdings' || f === 'webdings') return WINGDINGS_MAP;
  if (f === 'wingdings 2') return WINGDINGS2_MAP;
  if (f === 'wingdings 3') return WINGDINGS3_MAP;
  return null;
}

export function mapSymbolCode(code, fontName) {
  const low = code >= 0xF000 && code <= 0xF0FF ? code - 0xF000 : code;
  const table = symbolTableForFont(fontName);
  if (table && table[low]) return table[low];
  if (code >= 0xF020 && code <= 0xF0FF) {
    return PUA_FALLBACK_MAP[low] || SYMBOL_MAP[low] || WINGDINGS_MAP[low] || '•';
  }
  return null;
}

export function mapSymbolText(text, fontName) {
  if (!text) return '';
  const table = symbolTableForFont(fontName);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xF020 && code <= 0xF0FF) {
      out += mapSymbolCode(code, fontName) ?? '•';
    } else if (table && code >= 0x20 && code <= 0xFF && table[code]) {
      out += table[code];
    } else if (code === 0 || (code < 0x20 && code !== 9 && code !== 10 && code !== 13)) {
      // Strip stray NUL / control chars that cause tofu glyphs on mobile.
    } else {
      out += text[i];
    }
  }
  return out;
}

function normalizeCharset(raw) {
  const label = String(raw || '').trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!label) return '';
  if (/^(?:gb2312|gbk|cp936|x-gbk|gb_2312|gb_2312-80|csgb2312|ms936)$/.test(label)) return 'gb18030';
  if (/^(?:big5|cp950|x-big5)$/.test(label)) return 'big5';
  if (/^(?:shift_jis|shift-jis|sjis|cp932|ms932)$/.test(label)) return 'shift_jis';
  if (/^(?:utf8|utf-8)$/.test(label)) return 'utf-8';
  if (/^(?:utf16le|utf-16le)$/.test(label)) return 'utf-16le';
  if (/^(?:utf16be|utf-16be)$/.test(label)) return 'utf-16be';
  if (/^(?:latin1|iso-8859-1|ascii|us-ascii)$/.test(label)) return 'windows-1252';
  return label;
}

function tryDecode(bytes, encoding, fatal) {
  try {
    return new TextDecoder(encoding, { fatal, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

export function decodeSmartText(input, { xml = false, html = false } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!bytes.length) return '';

  // 1. Explicit BOM checks first (UTF-8, UTF-16LE, UTF-16BE).
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    const sub = bytes.subarray(3);
    const strict = tryDecode(sub, 'utf-8', true);
    if (strict !== null) return strict;
    return tryDecode(sub, 'gb18030', false) ?? tryDecode(sub, 'utf-8', false) ?? '';
  }
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return tryDecode(bytes.subarray(2), 'utf-16le', false) ?? '';
  }
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return tryDecode(bytes.subarray(2), 'utf-16be', false) ?? '';
  }

  // 2. BOM-less UTF-16 detection for XML/text starting with '<' or ASCII.
  if (bytes.length >= 4) {
    if (bytes[0] === 0x00 && bytes[1] === 0x3C && bytes[2] === 0x00) {
      return tryDecode(bytes, 'utf-16be', false) ?? '';
    }
    if (bytes[0] === 0x3C && bytes[1] === 0x00 && bytes[3] === 0x00) {
      return tryDecode(bytes, 'utf-16le', false) ?? '';
    }
  }

  // 3. Declared encoding inside XML declaration or HTML <meta charset=...>.
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 1024))).toString('latin1');
  let declared = '';
  if (xml) {
    const m = head.match(/^\s*<\?xml\s[^?]*encoding\s*=\s*["']([\w.-]+)["']/i);
    if (m) declared = normalizeCharset(m[1]);
  }
  if (!declared && html) {
    const m = head.match(/charset\s*=\s*["']?\s*([\w.-]+)/i);
    if (m) declared = normalizeCharset(m[1]);
  }

  const order = [];
  if (declared) order.push(declared);
  if (!order.includes('utf-8')) order.push('utf-8');
  if (!order.includes('gb18030')) order.push('gb18030');

  for (const enc of order) {
    const text = tryDecode(bytes, enc, true);
    if (text !== null) return text;
  }
  for (const enc of order) {
    const text = tryDecode(bytes, enc, false);
    if (text !== null) return text;
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeZipFilename(bytes, isUtf8) {
  if (isUtf8) {
    const strict = tryDecode(bytes, 'utf-8', true);
    if (strict !== null) return strict;
  }
  return tryDecode(bytes, 'utf-8', true)
    ?? tryDecode(bytes, 'gb18030', true)
    ?? tryDecode(bytes, 'utf-8', false)
    ?? '';
}

function readU64LE(buf, offset) {
  const lo = buf.readUInt32LE(offset);
  const hi = buf.readUInt32LE(offset + 4);
  const val = hi * 0x100000000 + lo;
  if (!Number.isSafeInteger(val)) throw new Error('ZIP64 偏移超出范围');
  return val;
}

/** Selective pure-Node ZIP unpacker with ZIP64 + GB18030 filename support. */
function unpackZipSelected(buf, selector) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (data.length < 22) throw new Error('文档压缩包不完整');
  if (data.length > MAX_INPUT_BYTES) throw new Error('文件超过 64 MiB，请切换原版式或下载');

  let eocd = data.length - 22;
  const minEocd = Math.max(0, eocd - 65535);
  for (; eocd >= minEocd; eocd--) {
    if (data.readUInt32LE(eocd) === 0x06054b50 && eocd + 22 + data.readUInt16LE(eocd + 20) === data.length) {
      break;
    }
  }
  if (eocd < minEocd) throw new Error('不支持此压缩格式');

  let count = data.readUInt16LE(eocd + 10);
  let cdSize = data.readUInt32LE(eocd + 12);
  let cdOffset = data.readUInt32LE(eocd + 16);

  // ZIP64 EOCD locator (20 bytes immediately preceding EOCD).
  if ((count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) && eocd >= 20) {
    const loc = eocd - 20;
    if (data.readUInt32LE(loc) === 0x07064b50) {
      const z64Off = readU64LE(data, loc + 8);
      if (z64Off + 56 <= loc && data.readUInt32LE(z64Off) === 0x06064b50) {
        count = readU64LE(data, z64Off + 32);
        cdSize = readU64LE(data, z64Off + 40);
        cdOffset = readU64LE(data, z64Off + 48);
      }
    }
  }

  if (count > MAX_ZIP_ENTRIES || cdOffset + cdSize > data.length) {
    throw new Error('文档目录超出安全限制');
  }

  const entries = new Map();
  let totalUnpacked = 0;
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;

  for (let i = 0; i < count; i++) {
    if (p + 46 > cdEnd || data.readUInt32LE(p) !== 0x02014b50) throw new Error('文档目录不完整');
    const flags = data.readUInt16LE(p + 8);
    const method = data.readUInt16LE(p + 10);
    let packed = data.readUInt32LE(p + 20);
    let size = data.readUInt32LE(p + 24);
    const nameLen = data.readUInt16LE(p + 28);
    const extraLen = data.readUInt16LE(p + 30);
    const commentLen = data.readUInt16LE(p + 32);
    let localOff = data.readUInt32LE(p + 42);
    const step = 46 + nameLen + extraLen + commentLen;
    if (p + step > cdEnd) throw new Error('文档目录不完整');

    const rawName = decodeZipFilename(data.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
    const normName = rawName.replace(/\\/g, '/').replace(/^\/+/, '');
    const lowerName = normName.toLowerCase();

    if (selector(lowerName)) {
      if (flags & 1) throw new Error('文档已加密，无法直接读取原文');
      // Parse ZIP64 extra field (tag 0x0001) when any 32-bit field is 0xFFFFFFFF.
      if (size === 0xFFFFFFFF || packed === 0xFFFFFFFF || localOff === 0xFFFFFFFF) {
        let ep = p + 46 + nameLen;
        const eEnd = ep + extraLen;
        while (ep + 4 <= eEnd) {
          const tag = data.readUInt16LE(ep);
          const len = data.readUInt16LE(ep + 2);
          ep += 4;
          if (tag === 0x0001 && ep + len <= eEnd) {
            let zp = ep;
            if (size === 0xFFFFFFFF && zp + 8 <= ep + len) { size = readU64LE(data, zp); zp += 8; }
            if (packed === 0xFFFFFFFF && zp + 8 <= ep + len) { packed = readU64LE(data, zp); zp += 8; }
            if (localOff === 0xFFFFFFFF && zp + 8 <= ep + len) { localOff = readU64LE(data, zp); zp += 8; }
            break;
          }
          ep += len;
        }
      }
      if (!entries.has(lowerName)) {
        totalUnpacked += size;
        if (totalUnpacked > MAX_XML_BYTES || entries.size >= MAX_SELECTED_FILES) {
          throw new Error('文档正文字数过多，请切换原版式或下载');
        }
        entries.set(lowerName, { name: normName, size, packed, method, localOff });
      }
    }
    p += step;
  }

  const out = new Map();
  for (const [lowerName, entry] of entries) {
    const { localOff, packed, size, method } = entry;
    if (localOff + 30 > data.length || data.readUInt32LE(localOff) !== 0x04034b50) {
      throw new Error('文档条目已损坏');
    }
    const pos = localOff + 30 + data.readUInt16LE(localOff + 26) + data.readUInt16LE(localOff + 28);
    if (pos + packed > data.length) throw new Error('文档数据不完整');
    const src = data.subarray(pos, pos + packed);
    let raw;
    if (method === 0) {
      raw = src;
    } else if (method === 8) {
      raw = inflateRawSync(src, { maxOutputLength: Math.max(size + 1024, 64 * 1024) });
    } else {
      throw new Error('不支持此压缩算法');
    }
    const xml = decodeSmartText(raw, { xml: true });
    if (/<!(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('不支持带外部声明的 XML');
    out.set(lowerName, xml);
  }
  return out;
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0',
  mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', middot: '·', deg: '°', plusmn: '±',
  times: '×', divide: '÷', copy: '©', reg: '®', trade: '™',
};

function decodeEntities(str) {
  if (!str || str.indexOf('&') === -1) return str;
  return str.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/g, (m, hex, dec, name) => {
    if (hex) {
      const cp = parseInt(hex, 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : '';
    }
    if (dec) {
      const cp = parseInt(dec, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : '';
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? m;
  });
}

function parseAttrs(raw) {
  const map = Object.create(null);
  if (!raw) return map;
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))/g;
  let m;
  while ((m = re.exec(raw))) {
    const full = m[1];
    const colon = full.indexOf(':');
    const local = colon === -1 ? full : full.slice(colon + 1);
    const val = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    map[local] = val;
    if (colon !== -1) map[full] = val;
  }
  return map;
}

/** Fast zero-dependency linear XML scanner. */
function scanXml(xml, { onOpen, onClose, onText }) {
  const len = xml.length;
  let i = 0;
  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      if (i < len) onText?.(decodeEntities(xml.slice(i)));
      break;
    }
    if (lt > i) {
      onText?.(decodeEntities(xml.slice(i, lt)));
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) break;
      onText?.(xml.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (xml[lt + 1] === '?' || xml[lt + 1] === '!') {
      const end = xml.indexOf('>', lt + 2);
      i = end === -1 ? len : end + 1;
      continue;
    }
    // Find closing '>' outside quoted attribute values.
    let gt = lt + 1;
    let quote = 0;
    while (gt < len) {
      const ch = xml.charCodeAt(gt);
      if (quote) {
        if (ch === quote) quote = 0;
      } else if (ch === 34 || ch === 39) {
        quote = ch;
      } else if (ch === 62) {
        break;
      }
      gt++;
    }
    if (gt >= len) break;
    let tagBody = xml.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (!tagBody) continue;
    if (tagBody[0] === '/') {
      const rawName = tagBody.slice(1).trim();
      const colon = rawName.indexOf(':');
      onClose?.(colon === -1 ? rawName : rawName.slice(colon + 1), rawName);
      continue;
    }
    const selfClose = tagBody.endsWith('/');
    if (selfClose) tagBody = tagBody.slice(0, -1).trim();
    let sp = 0;
    while (sp < tagBody.length && tagBody.charCodeAt(sp) > 32) sp++;
    const rawName = tagBody.slice(0, sp);
    const attrStr = sp < tagBody.length ? tagBody.slice(sp + 1) : '';
    const colon = rawName.indexOf(':');
    const localName = colon === -1 ? rawName : rawName.slice(colon + 1);
    onOpen?.(localName, rawName, attrStr, selfClose);
    if (selfClose) onClose?.(localName, rawName);
  }
}

function createCollector() {
  const blocks = [];
  let chars = 0;
  let tables = 0;
  let truncated = false;

  function pushText(type, rawText) {
    const text = String(rawText ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) return;
    if (blocks.length >= MAX_BLOCKS || chars + text.length > MAX_CHARS) {
      truncated = true;
      return;
    }
    chars += text.length;
    blocks.push({ type, text });
  }

  function pushSlide(title) {
    if (blocks.length >= MAX_BLOCKS) { truncated = true; return; }
    blocks.push({ type: 'slide', text: title });
  }

  function pushTable(rows) {
    if (!rows.length) return;
    const cleaned = [];
    for (const row of rows) {
      if (cleaned.length >= MAX_TABLE_ROWS) { truncated = true; break; }
      const trimmed = row.slice(0, MAX_TABLE_COLS).map(cell => String(cell ?? '').replace(/\r\n?/g, '\n').trim());
      while (trimmed.length > 1 && trimmed[trimmed.length - 1] === '') trimmed.pop();
      if (trimmed.some(c => c.length > 0)) cleaned.push(trimmed);
    }
    if (!cleaned.length) return;
    const maxCols = cleaned.reduce((m, r) => Math.max(m, r.length), 0);
    const normalized = cleaned.map(r => (r.length < maxCols ? [...r, ...Array(maxCols - r.length).fill('')] : r));
    const tableChars = normalized.reduce((s, r) => s + r.reduce((rs, c) => rs + c.length, 0), 0);
    if (blocks.length >= MAX_BLOCKS || chars + tableChars > MAX_CHARS) {
      truncated = true;
      return;
    }
    chars += tableChars;
    tables++;
    blocks.push({ type: 'table', rows: normalized });
  }

  return {
    pushText,
    pushSlide,
    pushTable,
    finish(format, title) {
      return {
        format,
        title,
        blocks,
        truncated,
        stats: { blocks: blocks.length, tables, chars },
      };
    },
  };
}

function headingLevelFromName(val) {
  const s = String(val || '').trim().toLowerCase();
  if (!s) return 0;
  if (s === 'title' || s === 'heading1' || s === 'heading 1' || s === '标题 1' || s === '标题1' || s === 'h1') return 1;
  if (s === 'subtitle' || s === 'heading2' || s === 'heading 2' || s === '标题 2' || s === '标题2' || s === 'h2') return 2;
  if (/^(?:heading\s*[3-9]|标题\s*[3-9]|h[3-6])$/.test(s)) return 3;
  return 0;
}

function parseDocxStyles(xml) {
  const map = new Map();
  if (!xml) return map;
  let curId = '';
  let curLevel = 0;
  scanXml(xml, {
    onOpen(local, _raw, attrStr) {
      if (local === 'style') {
        const a = parseAttrs(attrStr);
        curId = a.styleId || '';
        curLevel = headingLevelFromName(curId);
      } else if (curId && local === 'name') {
        const lvl = headingLevelFromName(parseAttrs(attrStr).val);
        if (lvl) curLevel = lvl;
      } else if (curId && local === 'outlineLvl') {
        const n = Number(parseAttrs(attrStr).val);
        if (Number.isInteger(n) && n >= 0 && n <= 5) {
          curLevel = Math.min(3, n + 1);
        }
      }
    },
    onClose(local) {
      if (local === 'style') {
        if (curId && curLevel) map.set(curId, curLevel);
        curId = '';
        curLevel = 0;
      }
    },
  });
  return map;
}

function extractDocxXml(xml, styleLevels, collector) {
  const SKIP_TAGS = new Set(['Fallback', 'del', 'delText', 'instrText', 'moveFrom', 'proofErr', 'commentReference', 'footnoteReference', 'endnoteReference', 'binData']);
  let skipDepth = 0;
  const fieldStack = [];
  let inText = false;
  let inRunPr = false;
  let runFont = '';
  const paraStack = [];
  const tableStack = [];

  const curPara = () => paraStack[paraStack.length - 1];
  const curTable = () => tableStack[tableStack.length - 1];
  const inFieldInstr = () => fieldStack.includes('instr');

  scanXml(xml, {
    onOpen(local, _raw, attrStr) {
      if (skipDepth > 0) {
        if (SKIP_TAGS.has(local)) skipDepth++;
        return;
      }
      if (SKIP_TAGS.has(local)) {
        skipDepth = 1;
        return;
      }
      if (local === 'tbl') {
        tableStack.push({ rows: [], curRow: null, curCell: null });
        return;
      }
      if (local === 'tr' && tableStack.length) {
        curTable().curRow = [];
        return;
      }
      if (local === 'tc' && tableStack.length && curTable().curRow) {
        curTable().curCell = [];
        return;
      }
      if (local === 'p') {
        paraStack.push({ parts: [], heading: 0, isList: false });
        return;
      }
      const p = curPara();
      if (!p) return;
      if (local === 'pStyle') {
        const val = parseAttrs(attrStr).val || '';
        const lvl = styleLevels.get(val) || headingLevelFromName(val);
        if (lvl) p.heading = lvl;
      } else if (local === 'outlineLvl') {
        const n = Number(parseAttrs(attrStr).val);
        if (Number.isInteger(n) && n >= 0 && n <= 5 && !p.heading) p.heading = Math.min(3, n + 1);
      } else if (local === 'numPr') {
        p.isList = true;
      } else if (local === 'r') {
        runFont = '';
      } else if (local === 'rPr') {
        inRunPr = true;
      } else if (inRunPr && local === 'rFonts') {
        const a = parseAttrs(attrStr);
        runFont = [a.ascii, a.hAnsi, a.cs].find(f => symbolTableForFont(f)) || '';
      } else if (local === 'fldChar') {
        const t = (parseAttrs(attrStr).fldCharType || '').toLowerCase();
        if (t === 'begin') fieldStack.push('instr');
        else if (t === 'separate' && fieldStack.length) fieldStack[fieldStack.length - 1] = 'result';
        else if (t === 'end' && fieldStack.length) fieldStack.pop();
      } else if (!inFieldInstr()) {
        if (local === 't') inText = true;
        else if (local === 'tab') p.parts.push('\t');
        else if (local === 'br' || local === 'cr') p.parts.push('\n');
        else if (local === 'noBreakHyphen') p.parts.push('-');
        else if (local === 'sym') {
          const a = parseAttrs(attrStr);
          const hex = parseInt(a.char || '', 16);
          const mapped = Number.isFinite(hex) ? mapSymbolCode(hex, a.font) : null;
          p.parts.push(mapped || '•');
        }
      }
    },
    onText(text) {
      if (skipDepth > 0 || inFieldInstr() || !inText || !paraStack.length) return;
      curPara().parts.push(mapSymbolText(text, runFont));
    },
    onClose(local) {
      if (skipDepth > 0) {
        if (SKIP_TAGS.has(local)) skipDepth--;
        return;
      }
      if (local === 't') { inText = false; return; }
      if (local === 'rPr') { inRunPr = false; return; }
      if (local === 'r') { runFont = ''; return; }
      if (local === 'p' && paraStack.length) {
        const p = paraStack.pop();
        const text = p.parts.join('').trim();
        if (paraStack.length) {
          if (text) curPara().parts.push((curPara().parts.length ? '\n' : '') + text);
        } else if (tableStack.length && curTable().curCell) {
          if (text) curTable().curCell.push(text);
        } else if (text) {
          const type = p.heading === 1 ? 'h1' : p.heading === 2 ? 'h2' : p.heading === 3 ? 'h3' : p.isList ? 'li' : 'p';
          collector.pushText(type, text);
        }
        return;
      }
      if (local === 'tc' && tableStack.length && curTable().curRow && curTable().curCell) {
        curTable().curRow.push(curTable().curCell.join('\n'));
        curTable().curCell = null;
        return;
      }
      if (local === 'tr' && tableStack.length && curTable().curRow) {
        curTable().rows.push(curTable().curRow);
        curTable().curRow = null;
        return;
      }
      if (local === 'tbl' && tableStack.length) {
        const tbl = tableStack.pop();
        if (tableStack.length && curTable().curCell) {
          const flat = tbl.rows.map(r => r.join(' | ')).join('\n');
          if (flat) curTable().curCell.push(flat);
        } else {
          collector.pushTable(tbl.rows);
        }
      }
    },
  });
}

function extractPptxSlide(xml, collector) {
  let skipDepth = 0;
  let inText = false;
  let inTitleShape = false;
  let runFont = '';
  let para = null;
  const tableStack = [];
  const curTable = () => tableStack[tableStack.length - 1];

  scanXml(xml, {
    onOpen(local, _raw, attrStr) {
      if (skipDepth > 0) {
        if (local === 'Fallback') skipDepth++;
        return;
      }
      if (local === 'Fallback') { skipDepth = 1; return; }
      if (local === 'sp') { inTitleShape = false; return; }
      if (local === 'ph') {
        const t = (parseAttrs(attrStr).type || '').toLowerCase();
        if (t === 'title' || t === 'ctrtitle') inTitleShape = true;
        return;
      }
      if (local === 'tbl') { tableStack.push({ rows: [], curRow: null, curCell: null }); return; }
      if (local === 'tr' && tableStack.length) { curTable().curRow = []; return; }
      if (local === 'tc' && tableStack.length && curTable().curRow) { curTable().curCell = []; return; }
      if (local === 'p') { para = []; return; }
      if (local === 'r') { runFont = ''; return; }
      if (local === 'latin' || local === 'cs' || local === 'sym') {
        const tf = parseAttrs(attrStr).typeface;
        if (tf) runFont = tf;
        return;
      }
      if (para) {
        if (local === 't') inText = true;
        else if (local === 'br') para.push('\n');
        else if (local === 'tab') para.push('\t');
      }
    },
    onText(text) {
      if (skipDepth > 0 || !inText || !para) return;
      para.push(mapSymbolText(text, runFont));
    },
    onClose(local) {
      if (skipDepth > 0) {
        if (local === 'Fallback') skipDepth--;
        return;
      }
      if (local === 't') { inText = false; return; }
      if (local === 'r') { runFont = ''; return; }
      if (local === 'sp') { inTitleShape = false; return; }
      if (local === 'p' && para) {
        const text = para.join('').trim();
        para = null;
        if (tableStack.length && curTable().curCell) {
          if (text) curTable().curCell.push(text);
        } else if (text) {
          collector.pushText(inTitleShape ? 'h2' : 'p', text);
        }
        return;
      }
      if (local === 'tc' && tableStack.length && curTable().curRow && curTable().curCell) {
        curTable().curRow.push(curTable().curCell.join('\n'));
        curTable().curCell = null;
        return;
      }
      if (local === 'tr' && tableStack.length && curTable().curRow) {
        curTable().rows.push(curTable().curRow);
        curTable().curRow = null;
        return;
      }
      if (local === 'tbl' && tableStack.length) {
        collector.pushTable(tableStack.pop().rows);
      }
    },
  });
}

function orderPptxSlides(files) {
  let names = [...files.keys()]
    .filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/(\d+)\.xml/)[1]) - Number(b.match(/(\d+)\.xml/)[1]));
  const pres = files.get('ppt/presentation.xml');
  const relsXml = files.get('ppt/_rels/presentation.xml.rels');
  if (!pres || !relsXml) return names;
  const rels = new Map();
  scanXml(relsXml, {
    onOpen(local, _raw, attrStr) {
      if (local === 'Relationship') {
        const a = parseAttrs(attrStr);
        if (a.Id && a.Target) rels.set(a.Id, a.Target);
      }
    },
  });
  const ordered = [];
  scanXml(pres, {
    onOpen(local, _raw, attrStr) {
      if (local === 'sldId') {
        const a = parseAttrs(attrStr);
        const rid = a['r:id'] || a.id;
        const target = rels.get(rid);
        if (target) {
          const clean = target.replace(/^\/+/, '').replace(/^ppt\//i, '');
          const key = ('ppt/' + clean).toLowerCase();
          if (files.has(key)) ordered.push(key);
        }
      }
    },
  });
  return ordered.length ? ordered : names;
}

function colLettersToIndex(ref) {
  const m = String(ref || '').match(/^([A-Za-z]+)/);
  if (!m) return -1;
  let col = 0;
  const s = m[1].toUpperCase();
  for (let i = 0; i < s.length; i++) col = col * 26 + (s.charCodeAt(i) - 64);
  return col - 1;
}

function extractXlsx(files, collector) {
  const shared = [];
  const ssXml = files.get('xl/sharedstrings.xml');
  if (ssXml) {
    let cur = null;
    let inT = false;
    let skipPhonetic = 0;
    scanXml(ssXml, {
      onOpen(local) {
        if (local === 'rPh') { skipPhonetic++; return; }
        if (skipPhonetic > 0) return;
        if (local === 'si') cur = [];
        else if (local === 't' && cur) inT = true;
      },
      onText(text) {
        if (inT && cur && skipPhonetic === 0) cur.push(text);
      },
      onClose(local) {
        if (local === 'rPh' && skipPhonetic > 0) { skipPhonetic--; return; }
        if (local === 't') inT = false;
        else if (local === 'si' && cur) { shared.push(cur.join('')); cur = null; }
      },
    });
  }

  const rels = new Map();
  const relsXml = files.get('xl/_rels/workbook.xml.rels');
  if (relsXml) {
    scanXml(relsXml, {
      onOpen(local, _raw, attrStr) {
        if (local === 'Relationship') {
          const a = parseAttrs(attrStr);
          if (a.Id && a.Target) rels.set(a.Id, a.Target);
        }
      },
    });
  }

  const sheets = [];
  const wbXml = files.get('xl/workbook.xml');
  if (wbXml) {
    scanXml(wbXml, {
      onOpen(local, _raw, attrStr) {
        if (local === 'sheet') {
          const a = parseAttrs(attrStr);
          const rid = a['r:id'] || a.id;
          const target = rels.get(rid);
          if (target) {
            const clean = target.replace(/^\/+/, '').replace(/^xl\//i, '');
            const key = ('xl/' + clean).toLowerCase();
            if (files.has(key)) sheets.push({ name: a.name || `工作表 ${sheets.length + 1}`, key });
          }
        }
      },
    });
  }
  if (!sheets.length) {
    for (const key of [...files.keys()].filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()) {
      sheets.push({ name: `工作表 ${sheets.length + 1}`, key });
    }
  }

  for (const sheet of sheets) {
    const xml = files.get(sheet.key);
    if (!xml) continue;
    const rows = [];
    let curRow = null;
    let cellType = '';
    let cellCol = -1;
    let inVal = false;
    let inInlineT = false;
    let buf = [];

    scanXml(xml, {
      onOpen(local, _raw, attrStr) {
        if (local === 'row') {
          curRow = [];
        } else if (local === 'c' && curRow) {
          const a = parseAttrs(attrStr);
          cellType = a.t || '';
          cellCol = colLettersToIndex(a.r);
          buf = [];
        } else if (local === 'v' && curRow) {
          inVal = true;
        } else if (local === 't' && curRow && cellType === 'inlineStr') {
          inInlineT = true;
        }
      },
      onText(text) {
        if (inVal || inInlineT) buf.push(text);
      },
      onClose(local) {
        if (local === 'v') { inVal = false; return; }
        if (local === 't') { inInlineT = false; return; }
        if (local === 'c' && curRow) {
          const raw = buf.join('');
          let value = raw;
          if (cellType === 's') {
            const idx = Number(raw);
            value = Number.isInteger(idx) && idx >= 0 && idx < shared.length ? shared[idx] : '';
          } else if (cellType === 'b') {
            value = raw === '1' ? 'TRUE' : 'FALSE';
          }
          const idx = cellCol >= 0 ? cellCol : curRow.length;
          if (idx < MAX_TABLE_COLS) {
            while (curRow.length < idx) curRow.push('');
            curRow[idx] = mapSymbolText(value, '');
          }
          cellType = '';
          cellCol = -1;
          buf = [];
        } else if (local === 'row' && curRow) {
          if (curRow.some(v => v.trim() !== '')) rows.push(curRow);
          curRow = null;
        }
      },
    });
    if (rows.length) {
      collector.pushSlide(sheet.name);
      collector.pushTable(rows);
    }
  }
}

function extractOdfXml(xml, collector) {
  const SKIP_TAGS = new Set(['binary-data', 'annotation', 'tracked-changes', 'office-meta', 'automatic-styles', 'font-face-decls']);
  let skipDepth = 0;
  let inBody = false;
  const paraStack = [];
  const tableStack = [];
  const curPara = () => paraStack[paraStack.length - 1];
  const curTable = () => tableStack[tableStack.length - 1];

  scanXml(xml, {
    onOpen(local, _raw, attrStr) {
      if (skipDepth > 0) {
        if (SKIP_TAGS.has(local)) skipDepth++;
        return;
      }
      if (SKIP_TAGS.has(local)) { skipDepth = 1; return; }
      if (local === 'body') { inBody = true; return; }
      if (!inBody) return;
      if (local === 'table') {
        const name = parseAttrs(attrStr).name;
        tableStack.push({ name, rows: [], curRow: null, curCell: null, repeat: 1 });
        return;
      }
      if (local === 'table-row' && tableStack.length) { curTable().curRow = []; return; }
      if (local === 'table-cell' && tableStack.length && curTable().curRow) {
        const rep = Math.min(8, Math.max(1, Number(parseAttrs(attrStr)['number-columns-repeated']) || 1));
        curTable().curCell = [];
        curTable().repeat = rep;
        return;
      }
      if (local === 'h' || local === 'p') {
        const lvl = local === 'h' ? Math.min(3, Math.max(1, Number(parseAttrs(attrStr)['outline-level']) || 1)) : 0;
        paraStack.push({ parts: [], heading: lvl });
        return;
      }
      if (paraStack.length) {
        if (local === 'tab') curPara().parts.push('\t');
        else if (local === 'line-break') curPara().parts.push('\n');
        else if (local === 's') {
          const c = Math.min(64, Math.max(1, Number(parseAttrs(attrStr).c) || 1));
          curPara().parts.push(' '.repeat(c));
        }
      }
    },
    onText(text) {
      if (skipDepth > 0 || !inBody || !paraStack.length) return;
      curPara().parts.push(mapSymbolText(text, ''));
    },
    onClose(local) {
      if (skipDepth > 0) {
        if (SKIP_TAGS.has(local)) skipDepth--;
        return;
      }
      if (local === 'body') { inBody = false; return; }
      if (!inBody) return;
      if ((local === 'h' || local === 'p') && paraStack.length) {
        const p = paraStack.pop();
        const text = p.parts.join('').trim();
        if (paraStack.length) {
          if (text) curPara().parts.push(text);
        } else if (tableStack.length && curTable().curCell) {
          if (text) curTable().curCell.push(text);
        } else if (text) {
          collector.pushText(p.heading === 1 ? 'h1' : p.heading === 2 ? 'h2' : p.heading === 3 ? 'h3' : 'p', text);
        }
        return;
      }
      if (local === 'table-cell' && tableStack.length && curTable().curRow && curTable().curCell) {
        const val = curTable().curCell.join('\n');
        const rep = val ? curTable().repeat : Math.min(curTable().repeat, 2);
        for (let k = 0; k < rep && curTable().curRow.length < MAX_TABLE_COLS; k++) {
          curTable().curRow.push(val);
        }
        curTable().curCell = null;
        return;
      }
      if (local === 'table-row' && tableStack.length && curTable().curRow) {
        if (curTable().curRow.some(c => c.trim() !== '')) curTable().rows.push(curTable().curRow);
        curTable().curRow = null;
        return;
      }
      if (local === 'table' && tableStack.length) {
        const tbl = tableStack.pop();
        if (tbl.rows.length) {
          if (tbl.name && /^表|sheet/i.test(tbl.name)) collector.pushSlide(tbl.name);
          collector.pushTable(tbl.rows);
        }
      }
    },
  });
}

/** Pure-Node OLE2 / Compound File Binary reader for legacy Word 97-2003 (.doc). */
function readOle2Streams(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (data.length < 512) throw new Error('旧版文档不完整');
  const sectorShift = data.readUInt16LE(30);
  const miniShift = data.readUInt16LE(32);
  if (sectorShift < 9 || sectorShift > 12 || miniShift < 4 || miniShift > sectorShift) {
    throw new Error('不支持此复合文档格式');
  }
  const sectorSize = 1 << sectorShift;
  const miniSize = 1 << miniShift;
  const firstDirSect = data.readInt32LE(48);
  const miniCutoff = data.readUInt32LE(56);
  const firstMiniFatSect = data.readInt32LE(60);
  const firstDifatSect = data.readInt32LE(68);
  const numDifatSects = data.readUInt32LE(72);

  const sectorPos = sid => (sid + 1) * sectorSize;
  const readSector = sid => {
    const off = sectorPos(sid);
    if (sid < 0 || off + sectorSize > data.length) return null;
    return data.subarray(off, off + sectorSize);
  };

  // Build DIFAT -> FAT sector list.
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const sid = data.readInt32LE(76 + i * 4);
    if (sid >= 0) fatSectors.push(sid);
  }
  let difatSect = firstDifatSect;
  for (let d = 0; d < numDifatSects && difatSect >= 0 && d < 512; d++) {
    const sec = readSector(difatSect);
    if (!sec) break;
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per; i++) {
      const sid = sec.readInt32LE(i * 4);
      if (sid >= 0) fatSectors.push(sid);
    }
    difatSect = sec.readInt32LE(per * 4);
  }

  const fat = [];
  for (const sid of fatSectors) {
    const sec = readSector(sid);
    if (!sec) continue;
    for (let i = 0; i < sectorSize; i += 4) fat.push(sec.readInt32LE(i));
  }

  function readChain(startSid, maxLen) {
    const chunks = [];
    const seen = new Set();
    let sid = startSid;
    let total = 0;
    while (sid >= 0 && sid < fat.length && !seen.has(sid)) {
      seen.add(sid);
      const sec = readSector(sid);
      if (!sec) break;
      chunks.push(sec);
      total += sec.length;
      if (maxLen !== undefined && total >= maxLen) break;
      sid = fat[sid];
    }
    const combined = Buffer.concat(chunks);
    return maxLen !== undefined ? combined.subarray(0, Math.min(maxLen, combined.length)) : combined;
  }

  const dirBuf = readChain(firstDirSect);
  const entries = [];
  for (let off = 0; off + 128 <= dirBuf.length; off += 128) {
    const nameLen = dirBuf.readUInt16LE(off + 64);
    const type = dirBuf[off + 66];
    if (!type || nameLen < 2 || nameLen > 64) continue;
    const name = dirBuf.subarray(off, off + nameLen - 2).toString('utf16le');
    const startSid = dirBuf.readInt32LE(off + 116);
    const size = dirBuf.readUInt32LE(off + 120);
    entries.push({ name, type, startSid, size });
  }

  const root = entries.find(e => e.type === 5);
  const miniStream = root && root.startSid >= 0 ? readChain(root.startSid, root.size) : Buffer.alloc(0);
  const miniFatBuf = firstMiniFatSect >= 0 ? readChain(firstMiniFatSect) : Buffer.alloc(0);
  const miniFat = [];
  for (let i = 0; i + 4 <= miniFatBuf.length; i += 4) miniFat.push(miniFatBuf.readInt32LE(i));

  function readMiniChain(startSid, size) {
    const chunks = [];
    const seen = new Set();
    let sid = startSid;
    let total = 0;
    while (sid >= 0 && sid < miniFat.length && !seen.has(sid) && total < size) {
      seen.add(sid);
      const off = sid * miniSize;
      if (off + miniSize > miniStream.length) break;
      chunks.push(miniStream.subarray(off, off + miniSize));
      total += miniSize;
      sid = miniFat[sid];
    }
    return Buffer.concat(chunks).subarray(0, size);
  }

  const streams = new Map();
  for (const e of entries) {
    if (e.type !== 2) continue;
    const content = e.size < miniCutoff && miniStream.length > 0
      ? readMiniChain(e.startSid, e.size)
      : readChain(e.startSid, e.size);
    streams.set(e.name, content);
  }
  return streams;
}

function extractLegacyDoc(buf, collector) {
  const streams = readOle2Streams(buf);
  const wordDoc = streams.get('WordDocument');
  if (!wordDoc || wordDoc.length < 0x1B0) {
    throw new Error('此旧版文档无法直接提取原文');
  }
  const wIdent = wordDoc.readUInt16LE(0);
  if (wIdent !== 0xA5EC && wIdent !== 0xA5DC) {
    throw new Error('此文档不是标准 Word 格式');
  }
  const flags = wordDoc.readUInt16LE(10);
  if (flags & 0x0100) throw new Error('文档已加密，无法直接读取原文');
  const tableName = (flags & 0x0200) ? '1Table' : '0Table';
  const table = streams.get(tableName);
  const ccpText = wordDoc.readUInt32LE(0x004C);
  const fcClx = wordDoc.readUInt32LE(0x01A2);
  const lcbClx = wordDoc.readUInt32LE(0x01A6);

  if (!table || !lcbClx || fcClx + lcbClx > table.length) {
    throw new Error('此旧版 .doc 结构较复杂，无法直接提取原文');
  }

  // Locate PlcPcd inside Clx (clxt === 0x02).
  let p = fcClx;
  const end = fcClx + lcbClx;
  while (p < end && table[p] === 0x01) {
    if (p + 3 > end) break;
    const cbGrpprl = table.readUInt16LE(p + 1);
    p += 3 + cbGrpprl;
  }
  if (p + 5 > end || table[p] !== 0x02) {
    throw new Error('此旧版 .doc 缺少正文索引，无法直接提取原文');
  }
  const lcb = table.readUInt32LE(p + 1);
  p += 5;
  if (p + lcb > end || lcb < 12) throw new Error('文档正文索引不完整');

  const n = Math.floor((lcb - 4) / 12);
  const cps = [];
  for (let i = 0; i <= n; i++) cps.push(table.readUInt32LE(p + i * 4));
  const pcdBase = p + (n + 1) * 4;

  const pieces = [];
  let charTotal = 0;
  for (let i = 0; i < n; i++) {
    const charCount = cps[i + 1] - cps[i];
    if (charCount <= 0) continue;
    const fcVal = table.readUInt32LE(pcdBase + i * 8 + 2);
    const compressed = (fcVal & 0x40000000) !== 0;
    let pieceText = '';
    if (compressed) {
      const byteOff = (fcVal & 0x3FFFFFFF) >>> 1;
      if (byteOff + charCount <= wordDoc.length) {
        pieceText = new TextDecoder('windows-1252').decode(wordDoc.subarray(byteOff, byteOff + charCount));
      }
    } else {
      const byteOff = fcVal & 0x3FFFFFFF;
      const byteLen = charCount * 2;
      if (byteOff + byteLen <= wordDoc.length) {
        pieceText = wordDoc.subarray(byteOff, byteOff + byteLen).toString('utf16le');
      }
    }
    pieces.push(pieceText);
    charTotal += pieceText.length;
    if (ccpText > 0 && charTotal >= ccpText) break;
  }

  let rawText = pieces.join('');
  if (ccpText > 0 && rawText.length > ccpText) rawText = rawText.slice(0, ccpText);

  // Strip Word binary field instructions (\x13 ... \x14 display \x15).
  let cleaned = '';
  let fieldState = []; // 'instr' | 'result'
  for (let i = 0; i < rawText.length; i++) {
    const c = rawText.charCodeAt(i);
    if (c === 0x13) { fieldState.push('instr'); continue; }
    if (c === 0x14) { if (fieldState.length) fieldState[fieldState.length - 1] = 'result'; continue; }
    if (c === 0x15) { fieldState.pop(); continue; }
    if (fieldState.includes('instr')) continue;
    if (c === 0x01 || c === 0x08 || c === 0x0C) continue; // inline picture/drawing/page break
    if (c === 0x0B) { cleaned += '\n'; continue; }
    cleaned += rawText[i];
  }

  // Convert \x07 table cells/rows and \r paragraphs cleanly.
  const lines = cleaned.split('\r');
  let tableRows = [];
  let curRow = [];
  const flushTable = () => {
    if (tableRows.length) { collector.pushTable(tableRows); tableRows = []; }
  };
  for (const line of lines) {
    if (line.includes('\x07')) {
      const parts = line.split('\x07');
      for (let j = 0; j < parts.length - 1; j++) {
        const cell = mapSymbolText(parts[j], '').trim();
        if (cell === '' && curRow.length > 0) {
          tableRows.push(curRow);
          curRow = [];
        } else {
          curRow.push(cell);
        }
      }
    } else {
      if (curRow.length) { tableRows.push(curRow); curRow = []; }
      flushTable();
      const text = mapSymbolText(line, '').trim();
      if (text) collector.pushText('p', text);
    }
  }
  if (curRow.length) tableRows.push(curRow);
  flushTable();
}

/** Clean RTF text extractor (supports Chinese \ansicpg936 hex escapes & \uN). */
function extractRtf(buf, collector) {
  const src = Buffer.from(buf).toString('latin1');
  const SKIP_GROUPS = new Set([
    'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header',
    'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf',
    'listtable', 'listoverridetable', 'revtbl', 'themedata', 'colorschememapping',
    'datastore', 'latentstyles', 'fldinst',
  ]);
  const cpgMatch = src.slice(0, 2048).match(/\\ansicpg(\d+)/);
  const cpgNum = cpgMatch ? Number(cpgMatch[1]) : 936;
  const enc = cpgNum === 936 ? 'gb18030' : cpgNum === 950 ? 'big5' : cpgNum === 932 ? 'shift_jis' : 'windows-1252';
  const hexDecoder = new TextDecoder(enc, { fatal: false });

  const stack = [{ skip: false, uc: 1 }];
  let out = [];
  let hexBytes = [];
  const flushHex = () => {
    if (!hexBytes.length) return;
    out.push(hexDecoder.decode(new Uint8Array(hexBytes)));
    hexBytes = [];
  };
  const flushPara = () => {
    flushHex();
    const text = mapSymbolText(out.join(''), '').trim();
    out = [];
    if (text) collector.pushText('p', text);
  };

  let i = 0;
  const len = src.length;
  while (i < len) {
    const ch = src[i];
    const state = stack[stack.length - 1];
    if (ch === '{') {
      flushHex();
      stack.push({ skip: state.skip, uc: state.uc });
      i++;
      continue;
    }
    if (ch === '}') {
      flushHex();
      if (stack.length > 1) stack.pop();
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') { i++; continue; }
    if (ch === '\\') {
      i++;
      if (i >= len) break;
      const next = src[i];
      if (next === '*' ) { state.skip = true; i++; continue; }
      if (next === '\\' || next === '{' || next === '}') {
        flushHex();
        if (!state.skip) out.push(next);
        i++;
        continue;
      }
      if (next === '~') { flushHex(); if (!state.skip) out.push('\u00A0'); i++; continue; }
      if (next === '-' || next === '_') { flushHex(); if (!state.skip) out.push('-'); i++; continue; }
      if (next === "'") {
        const hex = src.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          if (!state.skip) hexBytes.push(parseInt(hex, 16));
          i += 3;
          continue;
        }
        i++;
        continue;
      }
      flushHex();
      let j = i;
      while (j < len && /[a-zA-Z]/.test(src[j])) j++;
      const word = src.slice(i, j);
      let k = j;
      if (k < len && (src[k] === '-' || /[0-9]/.test(src[k]))) {
        k++;
        while (k < len && /[0-9]/.test(src[k])) k++;
      }
      const param = k > j ? Number(src.slice(j, k)) : null;
      if (k < len && src[k] === ' ') k++;
      i = k;

      if (SKIP_GROUPS.has(word)) { state.skip = true; continue; }
      if (state.skip) continue;
      if (word === 'uc' && param !== null) { state.uc = Math.max(0, param); continue; }
      if (word === 'u' && param !== null) {
        const cp = param < 0 ? param + 65536 : param;
        out.push(String.fromCharCode(cp));
        // Skip uc fallback bytes/chars following \uN.
        let skipped = 0;
        while (skipped < state.uc && i < len) {
          if (src[i] === '\\' && src[i + 1] === "'") { i += 4; }
          else if (src[i] === '{' || src[i] === '}') break;
          else i++;
          skipped++;
        }
        continue;
      }
      if (word === 'par') { flushPara(); continue; }
      if (word === 'line') { out.push('\n'); continue; }
      if (word === 'tab') { out.push('\t'); continue; }
      if (word === 'cell') { out.push('\t'); continue; }
      if (word === 'row') { flushPara(); continue; }
      continue;
    }
    flushHex();
    if (!state.skip) out.push(ch);
    i++;
  }
  flushPara();
}

/** Extract clean text and tables from HTML/Word2003-HTML saved as .doc/.xls. */
function extractHtmlDocument(buf, collector) {
  const html = decodeSmartText(buf, { html: true });
  const SKIP = new Set(['script', 'style', 'head', 'noscript', 'title', 'xml']);
  let skipDepth = 0;
  let block = null;
  const tableStack = [];
  const curTable = () => tableStack[tableStack.length - 1];

  const flushBlock = () => {
    if (!block) return;
    const text = mapSymbolText(block.parts.join(''), '').replace(/[ \t]{2,}/g, ' ').trim();
    const type = block.type;
    block = null;
    if (!text) return;
    if (tableStack.length && curTable().curCell) curTable().curCell.push(text);
    else collector.pushText(type, text);
  };

  scanXml(html, {
    onOpen(local) {
      const tag = local.toLowerCase();
      if (skipDepth > 0) { if (SKIP.has(tag)) skipDepth++; return; }
      if (SKIP.has(tag)) { skipDepth = 1; return; }
      if (tag === 'table') { flushBlock(); tableStack.push({ rows: [], curRow: null, curCell: null }); return; }
      if (tag === 'tr' && tableStack.length) { curTable().curRow = []; return; }
      if ((tag === 'td' || tag === 'th') && tableStack.length && curTable().curRow) { curTable().curCell = []; return; }
      if (tag === 'br') { if (block) block.parts.push('\n'); else if (tableStack.length && curTable().curCell) curTable().curCell.push('\n'); return; }
      if (/^h[1-6]$/.test(tag)) { flushBlock(); block = { type: tag === 'h1' ? 'h1' : tag === 'h2' ? 'h2' : 'h3', parts: [] }; return; }
      if (tag === 'p' || tag === 'div' || tag === 'li') {
        flushBlock();
        block = { type: tag === 'li' ? 'li' : 'p', parts: [] };
      }
    },
    onText(text) {
      if (skipDepth > 0) return;
      const clean = text.replace(/\s+/g, ' ');
      if (!clean.trim()) return;
      if (block) block.parts.push(clean);
      else if (tableStack.length && curTable().curCell) curTable().curCell.push(clean.trim());
      else block = { type: 'p', parts: [clean] };
    },
    onClose(local) {
      const tag = local.toLowerCase();
      if (skipDepth > 0) { if (SKIP.has(tag)) skipDepth--; return; }
      if (/^(?:h[1-6]|p|div|li)$/.test(tag)) { flushBlock(); return; }
      if ((tag === 'td' || tag === 'th') && tableStack.length && curTable().curRow && curTable().curCell) {
        flushBlock();
        curTable().curRow.push(curTable().curCell.join(' ').trim());
        curTable().curCell = null;
        return;
      }
      if (tag === 'tr' && tableStack.length && curTable().curRow) {
        curTable().rows.push(curTable().curRow);
        curTable().curRow = null;
        return;
      }
      if (tag === 'table' && tableStack.length) {
        collector.pushTable(tableStack.pop().rows);
      }
    },
  });
  flushBlock();
}

/** RFC-4180 CSV/TSV parser with UTF-8 / UTF-16 / GB18030 auto-detection. */
function extractDelimited(buf, delimiter, collector) {
  const text = decodeSmartText(buf);
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.length === 0) {
      inQuotes = true;
    } else if (ch === delimiter) {
      if (row.length < MAX_TABLE_COLS) row.push(cell);
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (row.length < MAX_TABLE_COLS) row.push(cell);
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= MAX_TABLE_ROWS) break;
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    if (row.length < MAX_TABLE_COLS) row.push(cell);
    if (row.some(c => c.trim() !== '')) rows.push(row);
  }
  if (rows.length) collector.pushTable(rows);
}

export function extractOfficeBuffer(buffer, filePath = '') {
  const started = Date.now();
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (data.length === 0) throw new Error('文档内容为空');
  if (data.length > MAX_INPUT_BYTES) throw new Error('文件超过 64 MiB，请切换原版式或下载');

  const title = filePath ? basename(filePath) : '文档';
  const ext = extname(filePath).slice(1).toLowerCase();
  const collector = createCollector();

  const isZip = data.length >= 4 && data[0] === 0x50 && data[1] === 0x4B && (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07);
  const isOle2 = data.length >= 8 && data[0] === 0xD0 && data[1] === 0xCF && data[2] === 0x11 && data[3] === 0xE0 && data[4] === 0xA1 && data[5] === 0xB1 && data[6] === 0x1A && data[7] === 0xE1;
  const headText = data.subarray(0, Math.min(data.length, 512)).toString('latin1').replace(/^\xEF\xBB\xBF/, '').trimStart();

  let format = ext || 'office';

  if (isZip) {
    const files = unpackZipSelected(data, lower =>
      lower === 'word/document.xml'
      || lower === 'word/styles.xml'
      || lower === 'content.xml'
      || lower === 'ppt/presentation.xml'
      || lower === 'ppt/_rels/presentation.xml.rels'
      || /^ppt\/slides\/slide\d+\.xml$/.test(lower)
      || lower === 'xl/workbook.xml'
      || lower === 'xl/_rels/workbook.xml.rels'
      || lower === 'xl/sharedstrings.xml'
      || /^xl\/worksheets\/sheet\d+\.xml$/.test(lower),
    );
    if (files.has('word/document.xml')) {
      format = 'docx';
      const styles = parseDocxStyles(files.get('word/styles.xml'));
      extractDocxXml(files.get('word/document.xml'), styles, collector);
    } else if (files.has('content.xml')) {
      format = ext || 'odf';
      extractOdfXml(files.get('content.xml'), collector);
    } else if ([...files.keys()].some(k => /^ppt\/slides\/slide\d+\.xml$/.test(k))) {
      format = 'pptx';
      const slides = orderPptxSlides(files);
      slides.forEach((key, index) => {
        collector.pushSlide(`第 ${index + 1} 页`);
        extractPptxSlide(files.get(key), collector);
      });
    } else if (files.has('xl/workbook.xml') || [...files.keys()].some(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))) {
      format = 'xlsx';
      extractXlsx(files, collector);
    } else {
      throw new Error('文档中没有可提取的正文内容');
    }
  } else if (/^\{\\rtf/i.test(headText)) {
    format = 'rtf';
    extractRtf(data, collector);
  } else if (isOle2) {
    format = 'doc';
    extractLegacyDoc(data, collector);
  } else if (ext === 'csv' || ext === 'tsv') {
    format = ext;
    extractDelimited(data, ext === 'tsv' ? '\t' : ',', collector);
  } else if (/^<\?xml\b/i.test(headText) && /wordDocument|w:body/i.test(data.subarray(0, Math.min(data.length, 4096)).toString('latin1'))) {
    format = 'doc-xml';
    const xml = decodeSmartText(data, { xml: true });
    if (/<!(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('不支持带外部声明的 XML');
    extractDocxXml(xml, new Map(), collector);
  } else if (/^(?:<!doctype\s+html|<html\b|<meta\b|<table\b|<body\b)/i.test(headText)) {
    format = 'html';
    extractHtmlDocument(data, collector);
  } else {
    throw new Error('暂不支持直接提取此格式原文');
  }

  const out = collector.finish(format, title);
  if (!out.blocks.length) {
    throw new Error('没有可提取的文字（可能是纯图片或扫描件）');
  }
  out.stats.parseMs = Date.now() - started;
  out.stats.bytes = data.length;
  return out;
}

export function getCachedOfficeDocument(cacheKey, version) {
  const key = cacheKey && version ? `${cacheKey}|${version}` : '';
  if (!key || !resultCache.has(key)) return null;
  const cached = resultCache.get(key);
  resultCache.delete(key);
  resultCache.set(key, cached);
  return { ...cached, cached: true };
}

export function readOfficeDocument({ buffer, filePath, version = '', cacheKey = '' }) {
  const cached = getCachedOfficeDocument(cacheKey, version);
  if (cached) return cached;
  const parsed = extractOfficeBuffer(buffer, filePath);
  const result = { ...parsed, version };
  const key = cacheKey && version ? `${cacheKey}|${version}` : '';
  if (key) {
    resultCache.set(key, result);
    while (resultCache.size > CACHE_LIMIT) {
      resultCache.delete(resultCache.keys().next().value);
    }
  }
  return result;
}
