import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DocumentStore,
  blocksToMarkdown,
  htmlToMd,
  markdownToBlocks,
  sanitizeHtml,
} from '../src/host/store.js';

/** A fresh store plus a cleanup hook. */
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-live-doc-'));
  const store = new DocumentStore(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { store, dir };
}

test('markdown parser maps every supported block type', () => {
  const blocks = markdownToBlocks([
    '# 一级',
    '## 二级',
    '### 三级',
    '正文 **加粗** 和 *斜体*。',
    '- 项目一',
    '- 项目二',
    '1. 编号一',
    '2. 编号二',
    '> 引用',
    '```',
    'const a = 1;',
    '```',
    '---',
  ].join('\n'));
  assert.deepEqual(blocks.map((block) => block.type), [
    'h1', 'h2', 'h3', 'p', 'ul', 'ul', 'ol', 'ol', 'quote', 'code', 'hr',
  ]);
  assert.match(blocks[3].html, /<strong>加粗<\/strong>/);
  assert.match(blocks[3].html, /<em>斜体<\/em>/);
  assert.match(blocks[9].html, /const a = 1;/);
});

test('markdown output numbers ordered lists and keeps inline formatting', () => {
  const blocks = markdownToBlocks('1. 第一\n2. 第二\n\n**粗** 和 [链接](https://example.com)');
  const markdown = blocksToMarkdown(blocks);
  assert.match(markdown, /^1\. 第一\n2\. 第二/m);
  assert.match(markdown, /\*\*粗\*\*/);
  assert.match(markdown, /\[链接\]\(https:\/\/example\.com\)/);
});

test('html to markdown and sanitizer stay inside the inline vocabulary', () => {
  assert.equal(htmlToMd('<strong>加粗</strong> <em>斜体</em> <code>x</code>'), '**加粗** *斜体* `x`');
  const cleaned = sanitizeHtml(
    '<script>alert(1)</script><strong onclick="evil()">ok</strong>'
    + '<img src=x onerror=alert(1)><a href="javascript:alert(1)">bad</a>',
  );
  assert.doesNotMatch(cleaned, /script|onclick|onerror|<img/i);
  assert.match(cleaned, /<strong>ok<\/strong>/);
  assert.doesNotMatch(cleaned, /javascript:/);
});

test('append, read and word count share one block list', (t) => {
  const { store } = fixture(t);
  const doc = store.create({ title: '测试', file: path.join(tmpdir(), 'x.docx') });
  store.append(doc.id, '# 标题\n\n这是第一段。\n\n- 项目');
  const result = store.read(doc.id);
  assert.equal(result.doc.blocks.length, 3);
  assert.match(result.markdown, /# 标题/);
  assert.ok(result.wordCount > 0);
  assert.equal(result.edits.length, 0);
});

test('a user edit is reported once and retains the user text', (t) => {
  const { store } = fixture(t);
  const doc = store.create({ title: '测试' });
  const { added } = store.append(doc.id, 'AI 写的第一段。');
  const result = store.patchFromUser(doc.id, added[0].id, '用户改过。<strong>保留</strong>', added[0].rev);
  assert.equal(result.conflict, false);
  assert.equal(result.block.by, 'user');

  const first = store.read(doc.id);
  assert.equal(first.edits.length, 1);
  assert.match(first.edits[0].after, /用户改过/);
  const second = store.read(doc.id);
  assert.equal(second.edits.length, 0);
  assert.match(second.markdown, /用户改过。\*\*保留\*\*/);
});

test('editing a block the agent changed since the base revision is flagged', (t) => {
  const { store } = fixture(t);
  const doc = store.create({ title: '测试' });
  const { added } = store.append(doc.id, '原始内容');
  const baseRev = added[0].rev;
  store.replace(doc.id, added[0].id, 'AI 刚改的内容', '原始');
  const result = store.patchFromUser(doc.id, added[0].id, '用户后到的修改', baseRev);
  assert.equal(result.conflict, true);
  assert.match(result.block.html, /用户后到的修改/);
});

test('insertAfter places blocks after the anchor, not before it', (t) => {
  const { store } = fixture(t);
  const doc = store.create({ title: '测试' });
  const { added } = store.append(doc.id, 'A\n\nB');
  store.insertAfter(doc.id, added[0].id, '插入的内容');
  const texts = store.read(doc.id).doc.blocks.map((block) => block.html);
  assert.deepEqual(texts, ['A', '插入的内容', 'B']);
});

test('the panel insert route appends after the anchor too', (t) => {
  const { store } = fixture(t);
  const doc = store.create({ title: '测试' });
  const { added } = store.append(doc.id, 'A\n\nB');
  store.insertBlockAfter(doc.id, added[0].id, { type: 'p', html: '空段' }, 'user');
  const types = store.read(doc.id).doc.blocks.map((block) => block.html);
  assert.deepEqual(types, ['A', '空段', 'B']);
});

test('an agent rewrite supersedes the edit journal for that block', (t) => {
  const { store } = fixture(t);
  const doc = store.create({ title: '测试' });
  const { added } = store.append(doc.id, '原文');
  store.patchFromUser(doc.id, added[0].id, '用户版本', added[0].rev);
  store.replace(doc.id, added[0].id, 'AI 定稿', '用户版本');
  const result = store.read(doc.id);
  assert.equal(result.edits.length, 0);
  assert.match(result.markdown, /AI 定稿/);
});

test('deleting a block drops its pending edit entries', (t) => {
  const { store } = fixture(t);
  const doc = store.create({ title: '测试' });
  const { added } = store.append(doc.id, '要删的段');
  store.patchFromUser(doc.id, added[0].id, '用户改过', added[0].rev);
  store.remove(doc.id, added[0].id);
  assert.equal(store.read(doc.id).edits.length, 0);
  assert.equal(store.read(doc.id).doc.blocks.length, 0);
});

test('a Markdown side export does not steal the .docx default path', (t) => {
  const { store } = fixture(t);
  const doc = store.create({ title: '测试', file: '/tmp/report.docx' });
  store.markExported(doc.id, '/tmp/report.md');
  assert.equal(store.read(doc.id).doc.path, '/tmp/report.docx');
  store.markExported(doc.id, '/tmp/other.docx');
  assert.equal(store.read(doc.id).doc.path, '/tmp/other.docx');
});

test('documents survive a store reload', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-live-doc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new DocumentStore(dir);
  const doc = first.create({ title: '持久化' });
  first.append(doc.id, '重启后还在');
  const second = new DocumentStore(dir);
  const reloaded = second.read(doc.id);
  assert.equal(reloaded.doc.title, '持久化');
  assert.match(reloaded.markdown, /重启后还在/);
  assert.equal(second.view(doc.id).activeId, doc.id);
});
