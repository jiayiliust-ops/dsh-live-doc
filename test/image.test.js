import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A real 1×1 PNG: the import path and the DOCX embedder both sniff it. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Minimal ZIP reader for the DOCX package. */
function readZip(buffer) {
  let eocd = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65_557); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
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

/** Mount the host half against a temp store and a temp workspace. */
async function mount(t) {
  const storeDir = mkdtempSync(path.join(tmpdir(), 'dsh-live-doc-image-'));
  const cwdDir = mkdtempSync(path.join(tmpdir(), 'dsh-live-doc-cwd-'));
  const previous = process.env.DSH_LIVE_DOC_DIR;
  process.env.DSH_LIVE_DOC_DIR = storeDir;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_LIVE_DOC_DIR;
    else process.env.DSH_LIVE_DOC_DIR = previous;
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(cwdDir, { recursive: true, force: true });
  });

  const { apply } = await import('../src/host/index.js');
  const tools = [];
  const routes = [];
  const ctx = {
    workingDirectory: { defaultDirectory: cwdDir, async ensure() { return cwdDir; } },
    inject(_names, callback) { callback(ctx); },
    effect(factory) { factory(); return () => {}; },
    tools: { register(definition) { tools.push(definition); return () => {}; } },
    systemPrompt: { section() { return () => {}; } },
    webServer: {
      getOrigin() { return 'http://127.0.0.1:1'; },
      register(route) { routes.push(route); return () => {}; },
    },
  };
  apply(ctx);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { storeDir, cwdDir, tools, byName, routes };
}

/** Call one registered route with a minimal request/response pair. */
function callRoute(route, { url, method = 'GET', headers = {} }) {
  return new Promise((resolve) => {
    const chunks = [];
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(status, nextHeaders) {
        this.statusCode = status;
        this.headers = nextHeaders ?? {};
      },
      end(body) {
        if (body !== undefined) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body));
        resolve({ status: this.statusCode, headers: this.headers, body: Buffer.concat(chunks) });
      },
    };
    route.handler({ url, method, headers }, res);
  });
}

test('an agent image path is copied into the document and embedded on export', async (t) => {
  const { cwdDir, byName, routes } = await mount(t);
  mkdirSync(path.join(cwdDir, 'figures'), { recursive: true });
  writeFileSync(path.join(cwdDir, 'figures', 'f1.png'), PNG_1X1);

  const exec = { agent: {}, signal: undefined };
  const created = await byName.get('doc_create').execute({ title: '带图论文' }, exec);
  const docId = /docId: (doc_\w+)/.exec(created)?.[1];
  assert.ok(docId, created);

  const appended = await byName.get('doc_append').execute({
    docId,
    markdown: '# 结果\n\n![图 1](figures/f1.png)\n\n| 指标 | 值 |\n| --- | --- |\n| 耗时 | 8s |',
  }, exec);
  assert.match(appended, /已追加 3 段/);

  // The block now points at a stored asset, not at the workspace file.
  const read = await byName.get('doc_read').execute({ docId, withIds: true }, exec);
  assert.match(read, /!\[图 1\]\(asset:[a-f0-9]{16}\.png\)/);
  assert.match(read, /\| 指标 \| 值 \|/);

  const exported = await byName.get('doc_export').execute({ docId }, exec);
  assert.match(exported, /\.docx/);
  const entries = readZip(readFileSync(path.join(cwdDir, '带图论文.docx')));
  const document = entries.get('word/document.xml').toString('utf8');
  assert.match(document, /<w:tbl>/);
  assert.match(document, /r:embed="rId4"/);
  assert.deepEqual(entries.get('word/media/image1.png'), PNG_1X1);

  // The panel reads the image back through the GET route.
  const assetRoute = routes.find((route) => route.path === '/live-doc/asset');
  assert.ok(assetRoute, 'asset route registered');
  const name = /asset:([a-f0-9]{16}\.png)/.exec(read)?.[1];
  assert.ok(name);
  const served = await callRoute(assetRoute, {
    url: `/live-doc/asset?doc=${encodeURIComponent(docId)}&name=${encodeURIComponent(name)}`,
    headers: { 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(served.status, 200);
  assert.equal(served.headers['content-type'], 'image/png');
  assert.deepEqual(served.body, PNG_1X1);

  // …and refuses traversal, unknown documents and cross-site loads.
  const traversal = await callRoute(assetRoute, { url: '/live-doc/asset?doc=../..&name=../../etc/passwd' });
  assert.equal(traversal.status, 404);
  const crossSite = await callRoute(assetRoute, {
    url: `/live-doc/asset?doc=${encodeURIComponent(docId)}&name=${encodeURIComponent(name)}`,
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
});

test('an append naming a missing image fails loudly instead of writing a broken block', async (t) => {
  const { byName } = await mount(t);
  const exec = { agent: {}, signal: undefined };
  const created = await byName.get('doc_create').execute({ title: '缺图' }, exec);
  const docId = /docId: (doc_\w+)/.exec(created)?.[1];
  await assert.rejects(
    () => byName.get('doc_append').execute({ docId, markdown: '![x](nope/missing.png)' }, exec),
    /找不到图片文件/,
  );
  const read = await byName.get('doc_read').execute({ docId }, exec);
  assert.match(read, /（空文档）/);
});

test('a remote image stays remote and is skipped by the exporter', async (t) => {
  const { cwdDir, byName } = await mount(t);
  const exec = { agent: {}, signal: undefined };
  const created = await byName.get('doc_create').execute({ title: '远程图' }, exec);
  const docId = /docId: (doc_\w+)/.exec(created)?.[1];
  await byName.get('doc_append').execute({ docId, markdown: '![远程](https://example.com/a.png)' }, exec);
  const exported = await byName.get('doc_export').execute({ docId }, exec);
  const target = /到：(.+)$/m.exec(exported)?.[1]?.trim();
  const entries = readZip(readFileSync(target ?? path.join(cwdDir, '远程图.docx')));
  assert.doesNotMatch(entries.get('word/document.xml').toString('utf8'), /<w:drawing>/);
  assert.equal([...entries.keys()].filter((name) => name.startsWith('word/media/')).length, 0);
});

test('the browser insert route understands after: "end"', async (t) => {
  const { byName, routes } = await mount(t);
  const exec = { agent: {}, signal: undefined };
  const created = await byName.get('doc_create').execute({ title: '面板追加' }, exec);
  const docId = /docId: (doc_\w+)/.exec(created)?.[1];
  const route = routes.find((entry) => entry.path === '/live-doc/api');

  /** POST one JSON payload into the prefixed route with a fake request. */
  const post = (path, payload) => new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload));
    const req = {
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/json', 'x-live-doc': '1', origin: 'http://127.0.0.1:1' },
      on(event, callback) {
        if (event === 'data') callback(body);
        if (event === 'end') callback();
        return req;
      },
    };
    const chunks = [];
    const res = {
      headersSent: false,
      writeHead() { this.headersSent = true; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); },
    };
    route.handler(req, res);
  });

  const inserted = await post('/live-doc/api/insertAfter', { docId, after: 'end', markdown: '追加的一段' });
  assert.equal(inserted.ok, true);
  assert.equal(inserted.blocks.length, 1);
  const read = await byName.get('doc_read').execute({ docId }, exec);
  assert.match(read, /追加的一段/);
});
