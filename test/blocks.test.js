import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DocumentStore,
  blocksToMarkdown,
  blockText,
  markdownToBlocks,
  normalizeRows,
  tableToMarkdown,
} from '../src/host/store.js';
import { buildDocx } from '../src/host/docx.js';
import { imageInfo, saveAsset, readAsset, isSafeAssetName } from '../src/host/assets.js';

/** A real 1×1 transparent PNG, so the size sniffer is exercised for real. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A fresh store plus a cleanup hook. */
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-live-doc-blocks-'));
  const store = new DocumentStore(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { store, dir };
}

/** Read a ZIP archive as a name -> bytes map (the DOCX writer's own format). */
function readZip(buffer) {
  let eocd = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65_557); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  assert.notEqual(eocd, -1, 'missing end-of-central-directory record');
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(start, start + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(raw) : raw);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('a GFM table becomes a table block and round-trips through Markdown', () => {
  const blocks = markdownToBlocks([
    '| 指标 | 基线 | 改造后 |',
    '| --- | --- | --- |',
    '| 耗时 | 12s | 8s |',
    '| 内存 | **1.2GB** | 0.8GB |',
  ].join('\n'));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'table');
  assert.deepEqual(blocks[0].rows.map((row) => row.length), [3, 3, 3]);
  assert.equal(blockText(blocks[0]), '指标 基线 改造后 耗时 12s 8s 内存 1.2GB 0.8GB');

  const markdown = blocksToMarkdown(blocks);
  assert.match(markdown, /^\| 指标 \| 基线 \| 改造后 \|$/m);
  assert.match(markdown, /^\| --- \| --- \| --- \|$/m);
  assert.match(markdown, /\*\*1\.2GB\*\*/);

  const again = markdownToBlocks(markdown);
  assert.equal(again[0].type, 'table');
  assert.equal(again[0].rows.length, 3);
});

test('normalizeRows pads ragged tables and refuses an empty grid', () => {
  const grid = normalizeRows([['a', 'b', 'c'], ['d']]);
  assert.deepEqual(grid, [['a', 'b', 'c'], ['d', '', '']]);
  assert.deepEqual(normalizeRows([]), []);
  assert.deepEqual(normalizeRows(undefined), []);
  assert.equal(tableToMarkdown([]), '');
});

test('a standalone image line becomes an image block', () => {
  const blocks = markdownToBlocks('说明\n\n![图 1](figures/f1.png)\n\n结尾');
  assert.deepEqual(blocks.map((block) => block.type), ['p', 'image', 'p']);
  assert.equal(blocks[1].src, 'figures/f1.png');
  assert.equal(blocks[1].alt, '图 1');
  assert.match(blocksToMarkdown(blocks), /!\[图 1\]\(figures\/f1\.png\)/);
});

test('storing a table keeps its grid and counts its cells as text', (t) => {
  const { store } = fixture(t);
  const doc = store.create({ title: '表格' });
  const { added } = store.append(doc.id, '| a | b |\n| --- | --- |\n| 1 | 2 |');
  assert.equal(added.length, 1);
  assert.equal(added[0].type, 'table');
  assert.deepEqual(added[0].rows, [['a', 'b'], ['1', '2']]);
  assert.equal(store.read(doc.id).wordCount, 7);
});

test('a panel table edit is journaled and bumps the revision', (t) => {
  const { store } = fixture(t);
  const doc = store.create({ title: '表格' });
  const { added } = store.append(doc.id, '| a | b |\n| --- | --- |\n| 1 | 2 |');
  const before = doc.rev;
  const result = store.patchFromUser(doc.id, added[0].id, { rows: [['a', 'b'], ['9', '2']] }, added[0].rev);
  assert.equal(result.changed, true);
  assert.equal(result.block.rows[1][0], '9');
  assert.ok(result.doc.rev > before);
  const edits = store.read(doc.id).edits;
  assert.equal(edits.length, 1);
  assert.match(edits[0].after, /\| 9 \| 2 \|/);
});

test('an image alt and width edit is journaled without touching src', (t) => {
  const { store } = fixture(t);
  const doc = store.create({ title: '图片' });
  const { added } = store.append(doc.id, '![图](figures/a.png)');
  const result = store.patchFromUser(doc.id, added[0].id, { alt: '新说明', width: 60 }, added[0].rev);
  assert.equal(result.block.alt, '新说明');
  assert.equal(result.block.width, 60);
  assert.equal(store.read(doc.id).edits.length, 1);
});

test('retyping a paragraph into an image or table is refused', (t) => {
  const { store } = fixture(t);
  const doc = store.create({ title: 'x' });
  const { added } = store.append(doc.id, '正文');
  assert.throws(() => store.retype(doc.id, added[0].id, 'image'), /图片和表格/);
  assert.throws(() => store.retype(doc.id, added[0].id, 'table'), /图片和表格/);
});

test('replacing a table with a new GFM table keeps the block id', (t) => {
  const { store } = fixture(t);
  const doc = store.create({ title: 'x' });
  const { added } = store.append(doc.id, '| a |\n| --- |\n| 1 |');
  store.replace(doc.id, added[0].id, '| a | b |\n| --- | --- |\n| 1 | 2 |', '1');
  const block = store.read(doc.id).doc.blocks[0];
  assert.equal(block.id, added[0].id);
  assert.equal(block.type, 'table');
  assert.deepEqual(block.rows, [['a', 'b'], ['1', '2']]);
});

test('the PNG sniffer reports the real pixel size and rejects junk', () => {
  assert.deepEqual(imageInfo(PNG_1X1), { ext: 'png', px: 1, py: 1 });
  assert.equal(imageInfo(Buffer.from('not an image')).ext, '');
  assert.equal(isSafeAssetName('abc12345.png'), true);
  assert.equal(isSafeAssetName('../escape.png'), false);
  assert.equal(isSafeAssetName('abc12345.exe'), false);
});

test('an asset is stored under the document and read back by name', (t) => {
  const { dir } = fixture(t);
  const saved = saveAsset(dir, 'doc_1', PNG_1X1);
  assert.match(saved.src, /^asset:[a-f0-9]{16}\.png$/);
  assert.deepEqual({ px: saved.px, py: saved.py }, { px: 1, py: 1 });
  assert.deepEqual(readAsset(dir, 'doc_1', saved.src.slice('asset:'.length)), PNG_1X1);
  assert.equal(readAsset(dir, 'doc_1', '../../etc/passwd'), undefined);
  assert.throws(() => saveAsset(dir, 'doc_1', Buffer.from('nope')), /只支持/);
});

test('a document with a table and an image exports a real table and media part', () => {
  const blocks = markdownToBlocks([
    '# 报告',
    '| 指标 | 值 |',
    '| --- | --- |',
    '| 耗时 | 8s |',
    '![图 1](figures/f1.png)',
  ].join('\n'));
  for (const block of blocks) {
    if (block.type === 'image') {
      block.src = 'asset:abcdef0123456789.png';
      block.px = 1;
      block.py = 1;
    }
  }
  const buffer = buildDocx({
    title: '表格与图片',
    blocks,
    createdAt: Date.now(),
    resolveAsset: () => ({ data: PNG_1X1, ext: 'png' }),
  });
  const entries = readZip(buffer);
  const document = entries.get('word/document.xml').toString('utf8');
  assert.match(document, /<w:tbl>/);
  assert.match(document, /<w:tblHeader\/>/);
  assert.match(document, /<w:drawing>/);
  assert.match(document, /r:embed="rId4"/);
  assert.ok(entries.has('word/media/image1.png'));
  assert.deepEqual(entries.get('word/media/image1.png'), PNG_1X1);
  const types = entries.get('[Content_Types].xml').toString('utf8');
  assert.match(types, /Extension="png"/);
  const rels = entries.get('word/_rels/document.xml.rels').toString('utf8');
  assert.match(rels, /media\/image1\.png/);
});

test('an unresolved image is skipped instead of failing the export', () => {
  const buffer = buildDocx({
    title: '缺图',
    blocks: [{ type: 'image', src: 'asset:missing.png', alt: '', px: 10, py: 10, width: 100 }],
    createdAt: Date.now(),
    resolveAsset: () => undefined,
  });
  const document = readZip(buffer).get('word/document.xml').toString('utf8');
  assert.doesNotMatch(document, /<w:drawing>/);
  assert.match(document, /<w:body><w:p\/>/);
});
