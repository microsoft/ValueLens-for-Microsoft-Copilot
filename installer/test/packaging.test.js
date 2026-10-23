// @ts-check
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SOURCE_DIR } from '../src/sources.js';
import {
  MAX_NATIVE_PATH, MAX_PAYLOAD_PATH, MIRROR_REGISTRY, PUBLIC_REGISTRY, fileVersion, installerFile, leakedIds, localIds, payloadId, prunable, publicRegistry,
  sourceFiles, tooLong,
} from '../packaging/payload.js';

test('packaging: ships every template the installer reads, and they exist', () => {
  const files = sourceFiles();
  assert.ok(files.includes('1. Fabric/Manual setup/pipelines/CopilotAdoptionPipeline.DataPipeline/pipeline-content.json'));
  assert.ok(files.includes('1. Fabric/Manual setup/ValueLens - Fabric.pbit'));
  assert.ok(files.includes('1. Fabric/Manual setup/notebooks/Copilot_Audit_Log_Processor.ipynb'));
  assert.ok(files.every((f) => !f.includes('\\')));
  for (const f of files) assert.ok(existsSync(join(DEFAULT_SOURCE_DIR, f)), `${f} is missing`);
});

test('packaging: ships the installer code, not its tests or tooling', () => {
  for (const f of ['bin/valuelens-install.js', 'src/cli.js', 'src/web/index.html', 'package.json', 'package-lock.json', 'README.md']) assert.ok(installerFile(f), f);
  for (const f of ['test/cli.test.js', 'packaging/build-exe.js', 'jsconfig.json', '.gitignore', 'valuelens-install.json']) assert.ok(!installerFile(f), f);
});

test('packaging: payload IDs change with the content', () => {
  assert.equal(payloadId('0.2.0', 'abcdef0123456789'), '0.2.0-abcdef0123');
  assert.notEqual(payloadId('0.2.0', 'abcdef0123456789'), payloadId('0.2.0', 'abcdef0124456789'));
});

test('packaging: file versions take four numbers', () => {
  assert.equal(fileVersion('0.2.0'), '0.2.0.0');
  assert.equal(fileVersion('1.10.3-beta.1'), '1.10.3.0');
  assert.throws(() => fileVersion('1.2'), /file version/);
  assert.throws(() => fileVersion('1.x.0'), /file version/);
  assert.throws(() => fileVersion('1.2.70000'), /file version/);
});

test('packaging: long paths are caught, with a tighter limit for native binaries', () => {
  const ok = 'f/installer/src/cli.js';
  const long = `f/installer/node_modules/${'x'.repeat(MAX_PAYLOAD_PATH)}`;
  const addon = `f/installer/node_modules/${'x'.repeat(MAX_NATIVE_PATH)}/a.node`;
  const deepJs = `f/installer/node_modules/${'x'.repeat(MAX_NATIVE_PATH)}/a.js`;
  assert.ok(MAX_NATIVE_PATH < MAX_PAYLOAD_PATH);
  assert.deepEqual(tooLong([ok, long, addon, deepJs]), [long, addon]);
  assert.deepEqual(tooLong([ok, 'node/node.exe'], { max: 10, native: 100 }), [ok]);
});

test('packaging: source maps in installed packages are left out', () => {
  for (const f of ['f/installer/node_modules/a/index.js.map', 'f/installer/node_modules/@s/b/build/x.d.ts.map']) assert.ok(prunable(f), f);
  for (const f of ['f/installer/src/web/index.js.map', 'f/installer/node_modules/a/index.js', 'f/installer/node_modules/a/map.js', 'f/x.map']) {
    assert.ok(!prunable(f), f);
  }
});

test('packaging: IDs from local settings are caught, public ones are not', () => {
  const graph =  '00000003-0000-0000-C000-000000000000';
  const ws = 'aaaa1111-1111-2222-3333-444455556666';
  const ids = localIds([`workspace: ${ws.toUpperCase()}\napp: ${graph}`], [graph]);
  assert.deepEqual([...ids], [ws]);
  assert.deepEqual(leakedIds(`const a="${ws}";const b="${graph}";const c="${ws}"`, ids), [ws]);
  assert.deepEqual(leakedIds('nothing here', ids), []);
});

test('packaging: lock files are pointed at the public registry', () => {
  const lock = JSON.stringify({ packages: { 'node_modules/a': { resolved: `${MIRROR_REGISTRY}a/-/a-1.0.0.tgz` } } });
  assert.equal(JSON.parse(publicRegistry(lock)).packages['node_modules/a'].resolved, `${PUBLIC_REGISTRY}a/-/a-1.0.0.tgz`);
  assert.equal(publicRegistry(publicRegistry(lock)), publicRegistry(lock));
});

test('packaging: the lock-file rewrite loads before npm ci', () => {
  // CI runs public-registry.js before installing dependencies, so neither it nor what it imports
  // may reach the installer source (which imports npm packages).
  for (const file of ['public-registry.js', 'registry.js']) {
    const src = readFileSync(new URL(`../packaging/${file}`, import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.deepEqual(imports.filter((s) => !s.startsWith('node:') && s !== './registry.js'), [], `${file} imports more than Node built-ins`);
  }
});
