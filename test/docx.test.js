import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { buildDocx } from '../src/host/docx.js';
import { markdownToBlocks } from '../src/host/store.js';

/**
 * Read the central directory of a ZIP archive and return entry name -> bytes.
 * @param {Buffer} buffer - the archive.
 * @returns {Map<string, Buffer>}
 */
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
  const offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let cursor = offset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, 'bad central directory signature');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(raw) : raw);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('buildDocx emits a complete Word package', () => {
  const blocks = markdownToBlocks([
    '# 报告标题',
    '正文 **加粗** 与 *斜体*，A & B，还有 <尖括号>。',
    '- 项目一',
    '1. 编号一',
    '> 引用',
    '```',
    'const a = 1;',
    '```',
  ].join('\n'));
  const buffer = buildDocx({ title: '报告 & 测试', blocks, createdAt: Date.now() });
  assert.equal(buffer.subarray(0, 4).toString('latin1'), 'PK\u0003\u0004');

  const entries = readZip(buffer);
  for (const name of [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
    'word/styles.xml',
    'word/numbering.xml',
    'word/settings.xml',
    'word/_rels/document.xml.rels',
    'docProps/core.xml',
    'docProps/app.xml',
  ]) {
    assert.ok(entries.has(name), `missing ${name}`);
  }

  const document = entries.get('word/document.xml').toString('utf8');
  assert.match(document, /<w:pStyle w:val="Heading1"\/>/);
  assert.match(document, /<w:numId w:val="1"\/>/);
  assert.match(document, /<w:numId w:val="2"\/>/);
  assert.match(document, /<w:b\/>/);
  assert.match(document, /<w:i\/>/);
  assert.match(document, /&amp; B/);
  assert.match(document, /&lt;尖括号&gt;/);
  assert.match(document, /const a = 1;/);

  const styles = entries.get('word/styles.xml').toString('utf8');
  assert.match(styles, /w:styleId="Heading1"/);
  assert.match(styles, /w:eastAsia="宋体"/);

  const core = entries.get('docProps/core.xml').toString('utf8');
  assert.match(core, /报告 &amp; 测试/);
});

test('buildDocx produces a valid empty document', () => {
  const buffer = buildDocx({ title: '空文档', blocks: [], createdAt: Date.now() });
  const document = readZip(buffer).get('word/document.xml').toString('utf8');
  assert.match(document, /<w:body><w:p\/>/);
});
