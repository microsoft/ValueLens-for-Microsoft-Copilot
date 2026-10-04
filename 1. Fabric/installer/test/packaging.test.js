// @ts-check
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SOURCE_DIR } from '../src/sources.js';
import {
  APP_PAYLOAD_DIR, MAX_NATIVE_PATH, MAX_PAYLOAD_PATH, MIRROR_REGISTRY, PUBLIC_REGISTRY, appFile, appPackageJson, fileVersion, installerFile, leakedIds,
  localIds, payloadId, prebuiltRayfinYml, prunable, publicRegistry, sourceFiles, tooLong,
} from '../packaging/payload.js';

const RAYFIN_YML = `id: valuelens
name: Analytics Hub
services:
  auth:
    enabled: true
  staticHosting:
    enabled: true
    folder: dist
    buildCommand: npm run build:fabric
    indexDocument: index.html
  functions:
    enabled: false
`;

test('packaging: ships every template the installer reads, and they exist', () => {
  const files = sourceFiles();
  assert.ok(files.includes('pipelines/CopilotAdoptionPipeline.DataPipeline/pipeline-content.json'));
  assert.ok(files.includes('ValueLens - Fabric.pbit'));
  assert.ok(files.some((f) => f.startsWith('Add Credit Consumption/notebooks/')));
  assert.ok(files.some((f) => f.startsWith('Add Agent Evaluator/notebooks/')));
  assert.ok(files.every((f) => !f.includes('\\')));
  for (const f of files) assert.ok(existsSync(join(DEFAULT_SOURCE_DIR, f)), `${f} is missing`);
});

test('packaging: ships the installer code, not its tests or tooling', () => {
  for (const f of ['bin/valuelens-install.js', 'src/cli.js', 'src/web/index.html', 'package.json', 'package-lock.json', 'README.md']) assert.ok(installerFile(f), f);
  for (const f of ['test/cli.test.js', 'packaging/build-exe.js', 'jsconfig.json', '.gitignore', 'valuelens-install.json']) assert.ok(!installerFile(f), f);
});

test('packaging: ships only what deploys the built app', () => {
  for (const f of ['tsconfig.json', 'LICENSE', 'rayfin/tsconfig.json', 'rayfin/data/schema.ts', 'rayfin/data/TaskTime.ts']) assert.ok(appFile(f), f);
  for (const f of ['src/main.tsx', 'package.json', 'rayfin/rayfin.yml', 'rayfin/.deployments.json', 'rayfin/.env', 'fabric.yaml', '.env.local', 'rayfin/data/sub/x.ts']) {
    assert.ok(!appFile(f), f);
  }
  assert.equal(APP_PAYLOAD_DIR, 'f/Fabric App');
});

test('packaging: rayfin.yml deploys the built files without building', () => {
  const out = prebuiltRayfinYml(RAYFIN_YML);
  assert.match(out, /^ {4}folder: public$/m);
  assert.doesNotMatch(out, /buildCommand/);
  assert.match(out, /^ {4}indexDocument: index.html$/m);
  assert.match(out, /^ {2}functions:\n {4}enabled: false$/m);
  assert.equal(out.split('\n').length, RAYFIN_YML.split('\n').length - 1);
  assert.equal(prebuiltRayfinYml(RAYFIN_YML.replaceAll('\n', '\r\n')), out);
});

test('packaging: rayfin.yml without static hosting is refused', () => {
  assert.throws(() => prebuiltRayfinYml('id: x\nservices:\n  auth:\n    enabled: true\n'), /no staticHosting section/);
  assert.throws(() => prebuiltRayfinYml('services:\n  staticHosting:\n    enabled: true\n  data:\n    folder: x\n'), /no staticHosting folder/);
});

test('packaging: the committed rayfin.yml can be made prebuilt', () => {
  // The working copy is skip-worktree on developer machines, but keeps the same shape.
  const yml = readFileSync(join(DEFAULT_SOURCE_DIR, 'Fabric App', 'rayfin', 'rayfin.yml'), 'utf8');
  assert.match(prebuiltRayfinYml(yml), /^ {4}folder: public$/m);
});

test('packaging: the app package.json pins Rayfin and names vite without installing it', () => {
  const pkg = appPackageJson({ rayfin: '1.35.1', vite: '8.0.16', version: '0.2.0' });
  assert.deepEqual(pkg.dependencies, { '@microsoft/rayfin-cli': '1.35.1', '@microsoft/rayfin-core': '1.35.1' });
  assert.deepEqual(pkg.devDependencies, { vite: '8.0.16' });
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, true);
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
  const long = `f/Fabric App/node_modules/${'x'.repeat(MAX_PAYLOAD_PATH)}`;
  const addon = `f/Fabric App/node_modules/${'x'.repeat(MAX_NATIVE_PATH)}/a.node`;
  const deepJs = `f/Fabric App/node_modules/${'x'.repeat(MAX_NATIVE_PATH)}/a.js`;
  assert.ok(MAX_NATIVE_PATH < MAX_PAYLOAD_PATH);
  assert.deepEqual(tooLong([ok, long, addon, deepJs]), [long, addon]);
  assert.deepEqual(tooLong([ok, 'node/node.exe'], { max: 10, native: 100 }), [ok]);
});

test('packaging: source maps in installed packages are left out', () => {
  for (const f of ['f/Fabric App/node_modules/a/index.js.map', 'f/installer/node_modules/@s/b/build/x.d.ts.map']) assert.ok(prunable(f), f);
  for (const f of ['f/Fabric App/public/assets/index.js.map', 'f/Fabric App/node_modules/a/index.js', 'f/installer/node_modules/a/map.js', 'f/x.map']) {
    assert.ok(!prunable(f), f);
  }
});

test('packaging: IDs from local settings are caught, public ones are not', () => {
  const graph = '00000003-0000-0000-C000-000000000000';
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
