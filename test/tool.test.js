import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileParameters, defineTool } from '../src/host/tool.js';

test('compileParameters mirrors the DSH parameter DSL', () => {
  const schema = compileParameters({
    title: { type: 'string', description: '标题' },
    file: { type: 'string' },
    docId: { type: 'string', required: true, description: '文档 id' },
    mode: { type: 'string', enum: ['a', 'b'] },
    files: { type: 'array', items: { type: 'string' } },
  });
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['docId']);
  assert.equal(schema.properties.title.description, '标题');
  assert.deepEqual(schema.properties.mode.enum, ['a', 'b']);
  assert.deepEqual(schema.properties.files.items, { type: 'string' });
  assert.equal(schema.properties.file.required, undefined);
});

test('compileParameters on an empty DSL stays an open object', () => {
  assert.deepEqual(compileParameters(), { type: 'object', properties: {} });
});

test('defineTool builds a registry-ready definition and rejects broken output', () => {
  const execute = () => 'ok';
  const tool = defineTool({
    name: 'demo_tool',
    description: 'demo',
    parameters: { value: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: () => [] },
    execute,
  });
  assert.equal(tool.name, 'demo_tool');
  assert.equal(tool.parameters.required[0], 'value');
  assert.equal(tool.output.schema.type, 'string');
  assert.equal(tool.execute, execute);

  assert.throws(() => defineTool({ name: 'x', description: '', parameters: {}, output: {}, execute }), /render/);
  assert.throws(() => defineTool({ name: '', description: '', parameters: {}, output: { schema: {}, render: () => [] }, execute }), /name/);
});

test('the client half registers under the package name and parses as a module', () => {
  const source = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8');
  assert.match(source, /window\.__ModuleLoader__\.load\(/);
  assert.match(source, /id: 'dsh-live-doc'/);
  assert.match(source, /factory\(require\)/);
  execFileSync(process.execPath, ['--check', fileURLToPath(new URL('../src/client/index.js', import.meta.url))], { stdio: 'pipe' });
  execFileSync(process.execPath, ['--check', fileURLToPath(new URL('../src/host/index.js', import.meta.url))], { stdio: 'pipe' });
});

test('the manifest declares a loadable bundle and client half', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'dsh-live-doc');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.exports['./client'], './src/client/index.js');
  assert.ok(manifest.files.includes('src'));
  assert.ok(manifest.files.includes('cordis.patch.yml'));
  assert.ok(!manifest.dependencies, 'the plugin must stay dependency-free');
});

test('the patch inserts exactly one row for this package', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const active = patch.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  const rows = active.match(/name: 'dsh-live-doc'/g) ?? [];
  assert.equal(rows.length, 1);
  assert.match(active, /id: live-doc/);
});
