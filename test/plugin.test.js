import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('the host half registers tools, a prompt section and the route', async (t) => {
  const storeDir = mkdtempSync(path.join(tmpdir(), 'dsh-live-doc-host-'));
  const cwdDir = mkdtempSync(path.join(tmpdir(), 'dsh-live-doc-cwd-'));
  const previous = process.env.DSH_LIVE_DOC_DIR;
  process.env.DSH_LIVE_DOC_DIR = storeDir;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_LIVE_DOC_DIR;
    else process.env.DSH_LIVE_DOC_DIR = previous;
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(cwdDir, { recursive: true, force: true });
  });

  // Import after the environment override so the store path is deterministic.
  const { apply, name, inject } = await import('../src/host/index.js');
  assert.equal(name, 'live-doc');
  assert.deepEqual(inject, ['tools', 'webServer', 'systemPrompt', 'workingDirectory']);

  const tools = [];
  const sections = [];
  const routes = [];
  const effects = [];
  const ctx = {
    workingDirectory: {
      defaultDirectory: cwdDir,
      async ensure() { return cwdDir; },
    },
    inject(names, callback) {
      callback(ctx);
    },
    effect(factory, label) {
      const disposer = factory();
      effects.push({ label, disposer });
      return () => {};
    },
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
    },
    webServer: {
      getOrigin() { return 'http://127.0.0.1:1'; },
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  };

  apply(ctx);
  assert.equal(tools.length, 8);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'live-doc:coedit');
  assert.equal(routes.length, 2);
  assert.equal(routes[0].path, '/live-doc/api');
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[1].path, '/live-doc/asset');
  assert.equal(routes[1].kind, 'exact');

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const exec = { agent: {}, signal: undefined };
  const created = await byName.get('doc_create').execute({ title: '集成测试' }, exec);
  const docId = /docId: (doc_\w+)/.exec(created)?.[1];
  assert.ok(docId, created);

  const appended = await byName.get('doc_append').execute({ docId, markdown: '# 标题\n\n正文' }, exec);
  assert.match(appended, /已追加 2 段/);

  const read = await byName.get('doc_read').execute({ docId, withIds: true }, exec);
  assert.match(read, /# 标题/);
  assert.match(read, /\[b_[^|]+\|p\|ai\] 正文/);

  const exported = await byName.get('doc_export').execute({ docId }, exec);
  assert.match(exported, /\.docx/);
  const file = path.join(cwdDir, '集成测试.docx');
  assert.equal(readFileSync(file).subarray(0, 2).toString('latin1'), 'PK');

  const listed = await byName.get('doc_list').execute({});
  assert.match(listed, /集成测试/);
});
