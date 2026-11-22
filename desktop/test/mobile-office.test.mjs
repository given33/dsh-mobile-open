import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fflate from 'fflate';
import {
  decodeSmartText,
  extractOfficeBuffer,
  mapSymbolText,
  readOfficeDocument,
} from '../lib/mobile-office.mjs';
import { mobileHostActions, workspaceOffice } from '../lib/mobile-host-actions.mjs';

const enc = s => Buffer.from(s, 'utf8');

/** Build a valid minimal OLE2 Compound File Binary containing WordDocument + 0Table streams. */
function makeMinimalOle2Doc(unicodeText) {
  const sectorSize = 512;
  const textBytes = Buffer.from(unicodeText, 'utf16le');
  // WordDocument stream: 512-byte FIB header + UTF-16LE text at offset 512.
  const wordDocSize = Math.ceil((512 + textBytes.length) / sectorSize) * sectorSize;
  const wordDoc = Buffer.alloc(wordDocSize);
  wordDoc.writeUInt16LE(0xA5EC, 0); // wIdent
  wordDoc.writeUInt16LE(0x0000, 10); // flags: unencrypted, 0Table
  wordDoc.writeUInt32LE(unicodeText.length, 0x004C); // ccpText
  wordDoc.writeUInt32LE(0, 0x01A2); // fcClx = 0
  // Clx in 0Table: clxt(0x02) + lcb(16) + cp0(0) + cp1(len) + pcd(8 bytes: fc = 512, UTF-16LE bit30=0)
  const clx = Buffer.alloc(1 + 4 + 16);
  clx[0] = 0x02;
  clx.writeUInt32LE(16, 1);
  clx.writeUInt32LE(0, 5);
  clx.writeUInt32LE(unicodeText.length, 9);
  clx.writeUInt32LE(512, 13 + 2); // fc = 512 (uncompressed UTF-16LE)
  wordDoc.writeUInt32LE(clx.length, 0x01A6); // lcbClx
  textBytes.copy(wordDoc, 512);

  // Pad 0Table to >= 4096 bytes so it uses regular FAT sectors (above miniSectorCutoff 4096).
  const tableBuf = Buffer.alloc(4096);
  clx.copy(tableBuf, 0);
  const wordDocPadded = Buffer.alloc(Math.max(4096, wordDoc.length));
  wordDoc.copy(wordDocPadded, 0);

  const wdSects = wordDocPadded.length / sectorSize;
  const tblSects = tableBuf.length / sectorSize;
  // Sector layout:
  // 0: FAT
  // 1: Directory
  // 2 .. 2+wdSects-1: WordDocument
  // 2+wdSects .. 2+wdSects+tblSects-1: 0Table
  const totalSects = 2 + wdSects + tblSects;
  const file = Buffer.alloc((1 + totalSects) * sectorSize);

  // Header (sector -1)
  Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]).copy(file, 0);
  file.writeUInt16LE(0xFFFE, 28);
  file.writeUInt16LE(9, 30); // sectorShift = 9 (512)
  file.writeUInt16LE(6, 32); // miniShift = 6 (64)
  file.writeUInt32LE(1, 44); // numFatSectors
  file.writeInt32LE(1, 48); // firstDirSector = 1
  file.writeUInt32LE(4096, 56); // miniSectorCutoff
  file.writeInt32LE(-2, 60); // firstMiniFatSector = ENDOFCHAIN
  file.writeInt32LE(-2, 68); // firstDifatSector = ENDOFCHAIN
  file.writeUInt32LE(0, 72); // numDifatSectors
  file.writeInt32LE(0, 76); // DIFAT[0] = FAT sector 0
  for (let i = 1; i < 109; i++) file.writeInt32LE(-1, 76 + i * 4);

  // FAT sector (sector 0 -> file offset 512)
  const fat = file.subarray(sectorSize, sectorSize * 2);
  fat.fill(0xFF);
  fat.writeInt32LE(-3, 0); // FATSECT
  fat.writeInt32LE(-2, 4); // Dir ENDOFCHAIN
  for (let i = 0; i < wdSects; i++) {
    fat.writeInt32LE(i === wdSects - 1 ? -2 : 2 + i + 1, (2 + i) * 4);
  }
  const tblStart = 2 + wdSects;
  for (let i = 0; i < tblSects; i++) {
    fat.writeInt32LE(i === tblSects - 1 ? -2 : tblStart + i + 1, (tblStart + i) * 4);
  }

  // Directory sector (sector 1 -> file offset 1024)
  const dir = file.subarray(sectorSize * 2, sectorSize * 3);
  function writeDirEntry(index, name, type, startSid, size) {
    const off = index * 128;
    const nameBuf = Buffer.from(name + '\0', 'utf16le');
    nameBuf.copy(dir, off);
    dir.writeUInt16LE(nameBuf.length, off + 64);
    dir[off + 66] = type;
    dir.writeInt32LE(startSid, off + 116);
    dir.writeUInt32LE(size, off + 120);
  }
  writeDirEntry(0, 'Root Entry', 5, -2, 0);
  writeDirEntry(1, 'WordDocument', 2, 2, wordDocPadded.length);
  writeDirEntry(2, '0Table', 2, tblStart, tableBuf.length);

  wordDocPadded.copy(file, (1 + 2) * sectorSize);
  tableBuf.copy(file, (1 + tblStart) * sectorSize);
  return file;
}

test('extracts Chinese DOCX with styles headings, structured tables, Symbol/Wingdings/PUA cleanup, and field stripping while skipping huge media', () => {
  const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
    <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:type="paragraph" w:styleId="a3">
        <w:name w:val="heading 1"/>
      </w:style>
      <w:style w:type="paragraph" w:styleId="a4">
        <w:pPr><w:outlineLvl w:val="1"/></w:pPr>
      </w:style>
    </w:styles>`;

  const docXml = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
      <w:body>
        <w:p><w:pPr><w:pStyle w:val="a3"/></w:pPr><w:r><w:t>机械原理考研重点</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="a4"/></w:pPr><w:r><w:t>一、齿轮传动公式</w:t></w:r></w:p>
        <w:p>
          <w:r><w:t>压力角 </w:t></w:r>
          <w:r><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr><w:t>a</w:t></w:r>
          <w:r><w:t> = 20° </w:t></w:r>
          <w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>
          <w:r><w:t> 模数 \uF0B7 中心距 </w:t></w:r>
          <w:r><w:fldChar w:fldCharType="begin"/></w:r>
          <w:r><w:instrText> HYPERLINK "https://example.invalid" </w:instrText></w:r>
          <w:r><w:fldChar w:fldCharType="separate"/></w:r>
          <w:r><w:t>参考教材</w:t></w:r>
          <w:r><w:fldChar w:fldCharType="end"/></w:r>
          <mc:Fallback><w:r><w:t>不应该重复出现的回退文字</w:t></w:r></mc:Fallback>
        </w:p>
        <w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>渐开线性质</w:t></w:r></w:p>
        <w:tbl>
          <w:tr><w:tc><w:p><w:r><w:t>参数</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数值</w:t></w:r></w:p></w:tc></w:tr>
          <w:tr><w:tc><w:p><w:r><w:t>齿数 z</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>24</w:t></w:r></w:p></w:tc></w:tr>
        </w:tbl>
      </w:body>
    </w:document>`;

  // Embed a 2 MiB dummy image that must never be inflated.
  const dummyImage = new Uint8Array(2 * 1024 * 1024);
  const archive = fflate.zipSync({
    'word/styles.xml': enc(stylesXml),
    'word/document.xml': enc(docXml),
    'word/media/huge.png': [dummyImage, { level: 0 }],
    'word/vbaProject.bin': enc('ignored-macro'),
  });

  const result = extractOfficeBuffer(archive, '机械原理复习.docx');
  assert.equal(result.format, 'docx');
  assert.equal(result.blocks[0].type, 'h1');
  assert.equal(result.blocks[0].text, '机械原理考研重点');
  assert.equal(result.blocks[1].type, 'h2');
  assert.equal(result.blocks[1].text, '一、齿轮传动公式');
  assert.equal(result.blocks[2].type, 'p');
  assert.equal(result.blocks[2].text, '压力角 α = 20° ✓ 模数 • 中心距 参考教材');
  assert.ok(!result.blocks[2].text.includes('HYPERLINK'));
  assert.ok(!result.blocks[2].text.includes('回退文字'));
  assert.equal(result.blocks[3].type, 'li');
  assert.equal(result.blocks[3].text, '渐开线性质');
  assert.deepEqual(result.blocks[4], {
    type: 'table',
    rows: [
      ['参数', '数值'],
      ['齿数 z', '24'],
    ],
  });
});

test('extracts ordered PPTX slides, XLSX sheets, ODT content, GB18030 CSV, Chinese RTF, and legacy OLE2 .doc with zero mojibake', () => {
  // 1. PPTX slide order via presentation.xml.rels
  const pptx = fflate.zipSync({
    'ppt/presentation.xml': enc('<p:presentation xmlns:p="p" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>'),
    'ppt/_rels/presentation.xml.rels': enc('<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>'),
    'ppt/slides/slide1.xml': enc('<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>第二页正文</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'),
    'ppt/slides/slide2.xml': enc('<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>封面标题</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'),
  });
  const pptRes = extractOfficeBuffer(pptx, '答辩.pptx');
  assert.equal(pptRes.format, 'pptx');
  assert.deepEqual(pptRes.blocks.map(b => [b.type, b.text]), [
    ['slide', '第 1 页'],
    ['h2', '封面标题'],
    ['slide', '第 2 页'],
    ['p', '第二页正文'],
  ]);

  // 2. XLSX with sharedStrings & sparse columns
  const xlsx = fflate.zipSync({
    'xl/workbook.xml': enc('<workbook xmlns:r="r"><sheets><sheet name="成绩单" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': enc('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/sharedStrings.xml': enc('<sst><si><t>姓名</t></si><si><t>总分</t></si><si><t>张三</t></si></sst>'),
    'xl/worksheets/sheet1.xml': enc('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>412</v></c></row></sheetData></worksheet>'),
  });
  const xlsxRes = extractOfficeBuffer(xlsx, '成绩.xlsx');
  assert.equal(xlsxRes.format, 'xlsx');
  assert.equal(xlsxRes.blocks[0].text, '成绩单');
  assert.deepEqual(xlsxRes.blocks[1].rows, [
    ['姓名', '', '总分'],
    ['张三', '', '412'],
  ]);

  // 3. GB18030 CSV (Chinese Excel export: "科目,分数\r\n机械设计,138")
  // "科目" = BF C6 C4 BF, "分数" = B7 D6 CA FD, "机械设计" = BB FA D0 B5 C9 E8 BC C6
  const gbkCsv = Buffer.from([
    0xBF, 0xC6, 0xC4, 0xBF, 0x2C, 0xB7, 0xD6, 0xCA, 0xFD, 0x0D, 0x0A,
    0xBB, 0xFA, 0xD0, 0xB5, 0xC9, 0xE8, 0xBC, 0xC6, 0x2C, 0x31, 0x33, 0x38,
  ]);
  const csvRes = extractOfficeBuffer(gbkCsv, '分数表.csv');
  assert.equal(csvRes.format, 'csv');
  assert.deepEqual(csvRes.blocks[0].rows, [
    ['科目', '分数'],
    ['机械设计', '138'],
  ]);

  // 4. Chinese RTF saved as .doc (GBK hex escapes + \uN unicode)
  const rtf = Buffer.from("{\\rtf1\\ansi\\ansicpg936{\\fonttbl{\\f0 SimSun;}}\\uc1\\'d6\\'d0\\'ce\\'c4\\u27979?\\u35797?\\par第二行}", 'latin1');
  const rtfRes = extractOfficeBuffer(rtf, '通知.doc');
  assert.equal(rtfRes.format, 'rtf');
  assert.equal(rtfRes.blocks[0].text, '中文测试');

  // 5. Legacy OLE2 binary .doc with Piece Table UTF-16LE + field code stripping + table
  const docText = '标题：理论力学\r正文\x13 HYPERLINK "x" \x14链接文字\x15完成\r项目\x07数值\x07\x07速度\x0710m/s\x07\x07';
  const ole2 = makeMinimalOle2Doc(docText);
  const docRes = extractOfficeBuffer(ole2, '讲义.doc');
  assert.equal(docRes.format, 'doc');
  assert.equal(docRes.blocks[0].text, '标题：理论力学');
  assert.equal(docRes.blocks[1].text, '正文链接文字完成');
  assert.deepEqual(docRes.blocks[2], {
    type: 'table',
    rows: [
      ['项目', '数值'],
      ['速度', '10m/s'],
    ],
  });

  // 6. PUA & Symbol mapping helper
  assert.equal(mapSymbolText('abp\uF0B7\uF0FC', 'Symbol'), 'αβπ•✓');
  assert.equal(decodeSmartText(Buffer.from([0xEF, 0xBB, 0xBF, ...Buffer.from('中文UTF8')])), '中文UTF8');
});

test('workspaceOffice enforces workspace confinement, rejects XXE, and serves LRU-cached results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mobile-office-'));
  try {
    const work = join(dir, 'work');
    const outside = join(dir, 'outside');
    await mkdir(work);
    await mkdir(outside);
    const docx = fflate.zipSync({
      'word/document.xml': enc('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>工作区正文</w:t></w:r></w:p></w:body></w:document>'),
    });
    const xxeDocx = fflate.zipSync({
      'word/document.xml': enc('<!DOCTYPE foo><w:document/>'),
    });
    const filePath = join(work, 'report.docx');
    await writeFile(filePath, docx);
    await writeFile(join(work, 'xxe.docx'), xxeDocx);
    await writeFile(join(outside, 'secret.docx'), docx);
    await symlink(outside, join(work, 'ext'), process.platform === 'win32' ? 'junction' : 'dir');

    // Relative path works & populates cache.
    const first = await workspaceOffice(work, 'report.docx');
    assert.equal(first.blocks[0].text, '工作区正文');
    assert.ok(!first.cached);

    // Absolute path inside workspace hits LRU cache immediately.
    const second = await workspaceOffice(work, filePath);
    assert.equal(second.blocks[0].text, '工作区正文');
    assert.equal(second.cached, true);

    // A trusted workspace root may be an alias (e.g. macOS /var).
    const alias = join(dir, 'workspace-alias');
    await symlink(work, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await workspaceOffice(alias, join(alias, 'report.docx'))).cached, true);
    await assert.rejects(workspaceOffice(alias, join(alias, 'ext', 'secret.docx')), e => e.code === 'mobileOffice/type');

    // Traversal, symlink escape, outside absolute path, and XXE are rejected.
    await assert.rejects(workspaceOffice(work, '../outside/secret.docx'), e => e.code === 'mobileOffice/path');
    await assert.rejects(workspaceOffice(work, 'ext/secret.docx'), e => e.code === 'mobileOffice/type');
    await assert.rejects(workspaceOffice(work, join(outside, 'secret.docx')), e => e.code === 'mobileOffice/path');
    await assert.rejects(workspaceOffice(work, 'xxe.docx'), e => e.code === 'mobileOffice/parse');

    // Host action RPC wiring works for stored sessions (including DSH 0.2.2 `{ header }` shape).
    const actions = mobileHostActions({
      get: key => ({
        sessionPersistence: { stat: async id => (id === 's-1' ? { header: { cwd: work } } : undefined) },
      })[key],
    });
    const rpcRes = await actions['mobileOffice/read']({ sessionId: 's-1', path: 'report.docx' });
    assert.equal(rpcRes.blocks[0].text, '工作区正文');
    assert.equal(rpcRes.cached, true);

    // Direct readOfficeDocument caching check.
    const direct = readOfficeDocument({ buffer: docx, filePath: 'demo.docx', version: 'v1', cacheKey: 'k-demo' });
    const direct2 = readOfficeDocument({ buffer: Buffer.alloc(0), filePath: 'demo.docx', version: 'v1', cacheKey: 'k-demo' });
    assert.equal(direct.blocks[0].text, '工作区正文');
    assert.equal(direct2.cached, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
