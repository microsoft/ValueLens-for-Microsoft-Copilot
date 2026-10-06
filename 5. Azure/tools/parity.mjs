#!/usr/bin/env node
// Runs every app DAX query against two semantic models (e.g. the Fabric model and the Azure-hosted one)
// through the Power BI executeQueries API, then compares the results.
//
//   node "5. Azure/tools/parity.mjs" --a <workspaceId>/<datasetId> --b <workspaceId>/<datasetId> [--out report.json] [--only <folder>]
//
// Auth: an access token for https://analysis.windows.net/powerbi/api from POWERBI_TOKEN, or `az account get-access-token`.
// Queries with __PLACEHOLDER__ templates are filled in by app code at runtime, so they are reported as skipped.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const QUERIES = resolve(here, '../../1. Fabric/Fabric App/src/queries');
const TOLERANCE = 1e-6;

function args() {
  const out = /** @type {Record<string, string>} */ ({});
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
  if (!out.a || !out.b) {
    console.error('Usage: parity.mjs --a <workspaceId>/<datasetId> --b <workspaceId>/<datasetId> [--out report.json] [--only <folder>]');
    process.exit(2);
  }
  return out;
}

function token() {
  if (process.env.POWERBI_TOKEN) return process.env.POWERBI_TOKEN;
  return execFileSync('az', ['account', 'get-access-token', '--resource', 'https://analysis.windows.net/powerbi/api', '--query', 'accessToken', '-o', 'tsv'],
    { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
}

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : name.endsWith('.dax') ? [p] : [];
  }).sort();
}

const detail = (e) => e?.['pbi.error']?.details?.[0]?.detail?.value ?? e?.message;

async function execute(bearer, target, query) {
  const [ws, ds] = target.split('/');
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.powerbi.com/v1.0/myorg/groups/${ws}/datasets/${ds}/executeQueries`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: [{ query }], serializerSettings: { includeNulls: true } }),
    });
    if (res.status === 429 && attempt < 6) {
      await new Promise((r) => setTimeout(r, Number(res.headers.get('retry-after') ?? 5) * 1000));
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: detail(body?.error) ?? `HTTP ${res.status}` };
    const err = body.results?.[0]?.error ?? body.error;
    if (err) return { error: detail(err) ?? JSON.stringify(err) };
    return { rows: body.results?.[0]?.tables?.[0]?.rows ?? [] };
  }
}

const norm = (v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);
const key = (row) => JSON.stringify(Object.keys(row).sort().map((k) => [k, norm(row[k])]));

function compare(a, b) {
  if (a.error || b.error) return { status: a.error && b.error ? 'both-error' : a.error ? 'a-error' : 'b-error' };
  if (a.rows.length === 0 && b.rows.length === 0) return { status: 'both-empty' };
  if (a.rows.length !== b.rows.length) return { status: 'diff', detail: `rows ${a.rows.length} vs ${b.rows.length}` };
  const left = a.rows.map(key).sort();
  const right = b.rows.map(key).sort();
  const i = left.findIndex((k, n) => k !== right[n]);
  if (i === -1) return { status: 'match' };
  const ra = JSON.parse(left[i]);
  const rb = Object.fromEntries(JSON.parse(right[i]));
  const cell = ra.find(([k, v]) => {
    const w = rb[k];
    return !(typeof v === 'number' && typeof w === 'number' ? Math.abs(v - w) <= TOLERANCE * Math.max(1, Math.abs(v)) : v === w);
  });
  return cell ? { status: 'diff', detail: `${cell[0]}: ${JSON.stringify(cell[1])} vs ${JSON.stringify(rb[cell[0]])}` } : { status: 'match' };
}

const opts = args();
const bearer = token();
const report = [];
for (const file of files(QUERIES)) {
  const name = relative(QUERIES, file).replaceAll('\\', '/');
  if (opts.only && !name.startsWith(opts.only)) continue;
  const query = readFileSync(file, 'utf8');
  if (/__[A-Z_]+__/.test(query)) {
    report.push({ name, status: 'skipped-template' });
    continue;
  }
  const [a, b] = await Promise.all([execute(bearer, opts.a, query), execute(bearer, opts.b, query)]);
  const r = { name, ...compare(a, b), rowsA: a.rows?.length, rowsB: b.rows?.length, errorA: a.error, errorB: b.error };
  report.push(r);
  const err = r.status === 'a-error' ? `  A: ${r.errorA}` : r.status === 'b-error' ? `  B: ${r.errorB}` : '';
  console.log(`${r.status.padEnd(16)} ${name}${r.detail ? `  (${r.detail})` : ''}${err.slice(0, 200)}`);
}

const byFolder = {};
for (const r of report) {
  const folder = r.name.split('/')[0];
  byFolder[folder] ??= {};
  byFolder[folder][r.status] = (byFolder[folder][r.status] ?? 0) + 1;
}
console.log('\nSummary by folder:');
for (const [folder, counts] of Object.entries(byFolder)) console.log(`  ${folder.padEnd(18)} ${Object.entries(counts).map(([s, n]) => `${s}=${n}`).join(' ')}`);
const totals = report.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
console.log(`\nTotal ${report.length}: ${Object.entries(totals).map(([s, n]) => `${s}=${n}`).join(' ')}`);
if (opts.out) writeFileSync(opts.out, JSON.stringify(report, null, 2));
