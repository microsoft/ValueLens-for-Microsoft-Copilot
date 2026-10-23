// @ts-check
/**
 * CSVs picked for upload before the install reaches the Lakehouse. A file picked in the terminal
 * is read where it is; one picked in the browser is staged in a temporary folder until the
 * install uploads it, then deleted.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { dataSource, decodeStart, detectSource, MAX_UPLOAD_BYTES, parseCsvHeader, routedSources } from './uploads.js';

/**
 * @typedef {object} PendingUpload  A recognised CSV waiting to go to the drop folder.
 * @property {string} path  Where it is on this computer.
 * @property {string} name  Its own name.
 * @property {number} size
 * @property {import('./uploads.js').DataSourceId} source
 * @property {string} kind
 * @property {string} [token]  Staged from the browser.
 */

/**
 * @typedef {object} Staged
 * @property {string} token
 * @property {string} name
 * @property {string} path
 * @property {number} size
 * @property {string[]} headers
 */

/** @type {Map<string, Staged>} */
const staged = new Map();
/** @type {string | undefined} */
let stageDir;

const MB = 1024 * 1024;

/**
 * Whether a file of this size can be uploaded, and why not.
 * @param {number} size
 * @returns {true | string}
 */
export function sizeOk(size) {
  if (!size) return 'The file is empty.';
  if (size > MAX_UPLOAD_BYTES) return `It's ${Math.round(size / MB)} MB. The installer uploads files up to ${MAX_UPLOAD_BYTES / MB} MB; put bigger ones in the Lakehouse with OneLake File Explorer.`;
  return true;
}

/**
 * Checks headers against the chosen sources.
 * @param {{ path: string, name: string, size: number, headers: string[], token?: string }} f
 * @param {import('./uploads.js').DataSourceModes} modes
 * @returns {{ ok: true, file: PendingUpload } | { ok: false, error: string }}
 */
function recognise(f, modes) {
  if (!/\.csv$/i.test(f.name)) return { ok: false, error: `${f.name} isn't a .csv file.` };
  const size = sizeOk(f.size);
  if (size !== true) return { ok: false, error: `${f.name}: ${size}` };
  const d = detectSource(f.headers, routedSources(modes));
  if (!d.ok) return { ok: false, error: `${f.name}: ${d.reason}` };
  return { ok: true, file: { path: f.path, name: f.name, size: f.size, source: d.source, kind: d.kind.kind, ...(f.token ? { token: f.token } : {}) } };
}

/**
 * Reads a CSV on this computer and recognises it.
 * @param {string} path
 * @param {import('./uploads.js').DataSourceModes} modes
 */
export function inspectFile(path, modes) {
  const p = path.trim().replace(/^"(.*)"$/, '$1');
  if (!p || !existsSync(p)) return /** @type {const} */ ({ ok: false, error: `There's no file at ${p || '(blank)'}.` });
  const st = statSync(p);
  if (!st.isFile()) return /** @type {const} */ ({ ok: false, error: `${p} is a folder. Choose a .csv file.` });
  const headers = st.size && st.size <= MAX_UPLOAD_BYTES ? parseCsvHeader(decodeStart(readHead(p))) : [];
  return recognise({ path: p, name: basename(p), size: st.size, headers }, modes);
}

/** @param {string} path */
function readHead(path) {
  const buf = new Uint8Array(64 * 1024);
  const fd = openSync(path, 'r');
  try {
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0));
  } finally {
    closeSync(fd);
  }
}

/**
 * Keeps a file the page sent until the install uploads it.
 * @param {string} name
 * @param {Uint8Array} bytes
 * @returns {{ token: string, name: string, size: number, source?: string, label?: string, error?: string }}
 */
export function stageUpload(name, bytes) {
  const clean = basename(String(name).replace(/\\/g, '/')) || 'upload.csv';
  stageDir ??= mkdtempSync(join(tmpdir(), 'analytics-hub-uploads-'));
  const token = randomBytes(12).toString('hex');
  const path = join(stageDir, `${token}.csv`);
  writeFileSync(path, bytes);
  const headers = parseCsvHeader(decodeStart(bytes));
  staged.set(token, { token, name: clean, path, size: bytes.length, headers });
  const d = detectSource(headers);
  return { token, name: clean, size: bytes.length, ...(d.ok ? { source: d.source, label: dataSource(d.source).label } : { error: d.reason }) };
}

/**
 * A staged file, recognised against the chosen sources.
 * @param {string} token
 * @param {import('./uploads.js').DataSourceModes} modes
 */
export function checkStaged(token, modes) {
  const s = staged.get(String(token));
  if (!s) return /** @type {const} */ ({ ok: false, error: 'That file is no longer here. Choose it again.' });
  return recognise(s, modes);
}

/**
 * Deletes a staged file once it's uploaded.
 * @param {string} [token]
 */
export function releaseStaged(token) {
  if (!token) return;
  const s = staged.get(token);
  staged.delete(token);
  if (s) rmSync(s.path, { force: true });
}

/** Deletes every staged file. */
export function clearStaged() {
  for (const token of [...staged.keys()]) releaseStaged(token);
  if (stageDir) rmSync(stageDir, { recursive: true, force: true });
  stageDir = undefined;
}
