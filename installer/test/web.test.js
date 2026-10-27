// @ts-check
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyConfig, loadConfig, saveConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { memoApi, rewindable } from '../src/install.js';
import { PRODUCT } from '../src/product.js';
import { mirror, reopenOnEnter, startServer } from '../src/server.js';
import { collectChoices } from '../src/steps/plan.js';
import { reportUrl } from '../src/steps/report.js';
import { ROUTE_NAMES } from '../src/target.js';
import { createWebUi, plainText, SECRET_MASK, toSegments } from '../src/web-ui.js';
import { createSession, describeRecord, paxFirstRun, prereqsSnapshot, WEB_COMMANDS } from '../src/web-session.js';
import { fakeCtx } from './fakes.js';
import { fakePaxHost } from './pax-fakes.js';

const SRC = new URL('../src/', import.meta.url);

/**
 * @param {number} port
 * @param {{ method?: string, path: string, headers?: Record<string, string>, body?: string, until?: string }} o
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
 */
function call(port, o) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path, headers: { Host: `127.0.0.1:${port}`, ...o.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        // An event stream never ends on its own, so stop once the expected frame is in.
        if (o.until && body.includes(o.until)) {
          res.destroy();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        }
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** @param {Record<string, any>} [session] Kept by reference, so a test can change it later. */
async function serve(session = {}) {
  const ui = createWebUi({ now: () => 1000 });
  session.running ??= null;
  session.state ??= () => ({ installed: false });
  session.start ??= () => ({ ok: true });
  const server = await startServer({ ui, session: /** @type {any} */ (session), token: 'tok' });
  const cookie = `valuelens_${server.port}=tok`;
  const post = (/** @type {string} */ path, /** @type {unknown} */ body, /** @type {Record<string, string>} */ headers = {}) =>
    call(server.port, {
      method: 'POST',
      path,
      body: JSON.stringify(body),
      headers: { Cookie: cookie, Origin: `http://127.0.0.1:${server.port}`, 'Content-Type': 'application/json', ...headers },
    });
  return { ui, server, cookie, post };
}

const tick = () => new Promise((r) => setImmediate(r));

/** The newest event. @param {{ history: () => import('../src/web-ui.js').UiEvent[] }} ui */
const latest = (ui) => /** @type {import('../src/web-ui.js').UiEvent} */ (ui.history().at(-1));

/**
 * Asks the questions again each time Back stops them, as rewindable() does in the installer.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function untilDone(fn) {
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (/** @type {Error} */ (err).name !== 'GoBack') throw err;
    }
  }
}

test('web ui: colours become styled runs and plain text drops them', () => {
  const s = '\x1b[1mBold\x1b[22m and \x1b[32mgreen\x1b[39m\x1b[2K\r';
  assert.deepEqual(toSegments(s), [{ text: 'Bold', bold: true }, { text: ' and ' }, { text: 'green', colour: 'green' }]);
  assert.equal(plainText(s), 'Bold and green');
});

test('web ui: output and a device code become events, replayable from any point', () => {
  const ui = createWebUi({ now: () => 5 });
  ui.heading('Fabric');
  ui.ok('\x1b[32mWorkspace\x1b[39m is ready');
  ui.line('To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD-1234 to authenticate.');
  ui.line('   ');
  const all = ui.history();
  assert.deepEqual(all.map((e) => e.type), ['heading', 'line', 'device-code']);
  assert.equal(all[1].text, 'Workspace is ready');
  assert.equal(all[1].kind, 'ok');
  assert.deepEqual([all[2].url, all[2].code], ['https://microsoft.com/devicelogin', 'ABCD-1234']);
  assert.deepEqual(ui.history(2).map((e) => e.seq), [3]);
});

test('web ui: a wrong answer leaves the question open; a right one resolves it', async () => {
  const ui = createWebUi();
  const asked = ui.select('Which capacity?', [
    { name: 'F2', value: 'a', disabled: 'Paused' },
    { name: 'F4', value: 'b' },
    { name: 'F8', value: 'c' },
  ], 'c');
  const prompt = ui.history().find((e) => e.type === 'prompt');
  assert.equal(prompt?.default, 2);
  assert.deepEqual(prompt?.choices[0], { name: 'F2', disabled: 'Paused' });
  assert.deepEqual(ui.answer(prompt?.id, 0), { ok: false, error: 'Choose one of the options.' });
  assert.equal(ui.history().at(-1)?.type, 'invalid');
  assert.deepEqual(ui.answer(prompt?.id, 1), { ok: true });
  assert.equal(await asked, 'b');
  assert.equal(ui.history().at(-1)?.display, 'F4');
  assert.equal(ui.answer(prompt?.id, 1).ok, false, 'an answered question is closed');
});

test('web ui: a question with one open choice answers itself', async () => {
  const ui = createWebUi();
  assert.equal(await ui.select('Which tenant?', [{ name: 'Contoso', value: 't1' }, { name: 'Fabrikam', value: 't2', disabled: true }]), 't1');
  assert.deepEqual(ui.history().map((e) => [e.type, e.display]), [['auto', 'Contoso']]);
});

test('web ui: input defaults and validates; checkbox refuses disabled options', async () => {
  const ui = createWebUi();
  const name = ui.input('Workspace name', { default: 'ValueLens', validate: (v) => (v.length < 40 ? true : 'Too long') });
  const id = ui.history().at(-1)?.id;
  assert.equal(ui.answer(id, 'x'.repeat(50)).error, 'Too long');
  ui.answer(id, '');
  assert.equal(await name, 'ValueLens');

  const picked = ui.checkbox('What else?', [{ name: 'Product feedback', value: 'feedback' }, { name: 'Defender', value: 'defender', disabled: 'Not licensed' }, { name: 'M365', value: 'm365' }]);
  const box = ui.history().at(-1)?.id;
  assert.equal(ui.answer(box, [1]).ok, false);
  ui.answer(box, [2, 0, 2]);
  assert.deepEqual(await picked, ['feedback', 'm365']);
  assert.equal(ui.history().at(-1)?.display, 'Product feedback, M365');
});

test('what to collect: the essentials are ticked and locked, every extra has a description, and only extras can be unticked', async () => {
  const config = emptyConfig();
  const choices = collectChoices(config.modules);
  assert.deepEqual(choices.map((ch) => [ch.value, ch.checked, 'disabled' in ch ? ch.disabled : false]), [
    ['core', true, 'Always collected'],
    ['orgData', true, 'Always collected'],
    ['m365Activity', true, false],
    ['agent365', false, false],
    ['productFeedback', false, false],
    ['defender', false, false],
  ]);
  for (const ch of choices) assert.match(ch.description, /^From .+\. (Shows|Adds|Lists) /, ch.value);

  const ui = createWebUi();
  const asked = ui.checkbox('Tick the data you want.', choices);
  const id = ui.history().at(-1)?.id;
  assert.deepEqual(ui.history().at(-1)?.choices?.slice(0, 2).map((/** @type {any} */ ch) => [ch.checked, ch.disabled]), [[true, 'Always collected'], [true, 'Always collected']]);
  ui.answer(id, [4]);
  assert.deepEqual(await asked, ['core', 'orgData', 'productFeedback']);
  assert.equal(ui.history().at(-1)?.display, 'Copilot usage and licences, Org data, Product feedback');

  const again = ui.checkbox('Tick the data you want.', choices);
  ui.answer(ui.history().at(-1)?.id, [0, 1]);
  assert.deepEqual(await again, ['core', 'orgData'], 'sending a locked box back is harmless');
});

test('web ui: a secret never reaches the history or the page', async () => {
  const ui = createWebUi();
  const seen = /** @type {string[]} */ ([]);
  ui.subscribe((e) => seen.push(JSON.stringify(e)));
  const secret = ui.secret('Client secret');
  const id = ui.history().at(-1)?.id;
  assert.equal(ui.answer(id, '   ').error, 'Required');
  ui.answer(id, 's3cr3t-value');
  assert.equal(await secret, 's3cr3t-value');
  assert.equal(ui.history().at(-1)?.display, SECRET_MASK);
  assert.ok(!JSON.stringify(ui.history()).includes('s3cr3t-value'));
  assert.ok(!seen.join('').includes('s3cr3t-value'));
});

test('web ui: cancel stops at the open question, as Ctrl+C does', async () => {
  const ui = createWebUi();
  assert.equal(ui.cancel(), false);
  const asked = ui.confirm('Go ahead?', true);
  assert.equal(ui.cancel(), true);
  await assert.rejects(asked, { name: 'ExitPromptError' });
  assert.equal(ui.history().at(-1)?.cancelled, true);
});

test('web ui: Back asks again from the start, gives the earlier answers again and opens the last one as it was', async () => {
  const ui = createWebUi();
  ui.heading('Before');
  ui.begin();
  /** @type {{ id: string }[]} */
  let offered = [];
  const done = untilDone(async () => {
    // New objects each time, as a fresh API call gives.
    offered = [{ id: 'a' }, { id: 'b' }];
    const ws = await ui.select('Workspace', offered.map((v) => ({ name: v.id.toUpperCase(), value: v })));
    const name = await ui.input('Lakehouse name', { default: 'ValueLens' });
    const extras = await ui.checkbox('Extras', [{ name: 'Product feedback', value: 'feedback' }, { name: 'M365', value: 'm365' }]);
    const go = await ui.confirm('Go ahead?', true);
    return { ws, name, extras, go };
  });

  assert.equal('back' in latest(ui), false, 'nothing to go back to from the first question');
  assert.equal(ui.back(), false);
  ui.answer(latest(ui).id, 1);
  await tick();
  assert.deepEqual([latest(ui).message, latest(ui).back], ['Lakehouse name', true]);
  ui.answer(latest(ui).id, 'Lake1');
  await tick();
  ui.answer(latest(ui).id, [1]);
  await tick();
  assert.deepEqual([latest(ui).message, latest(ui).back], ['Go ahead?', true]);

  assert.equal(ui.back(), true);
  await tick();
  assert.deepEqual(ui.history().map((e) => [e.type, e.message ?? e.title ?? '', !!e.replayed]), [
    ['heading', 'Before', false],
    ['rewind', '', false],
    ['prompt', 'Workspace', true],
    ['answered', '', true],
    ['prompt', 'Lakehouse name', true],
    ['answered', '', true],
    ['prompt', 'Extras', false],
  ]);
  assert.equal(ui.history()[1].to, ui.history()[0].seq, 'the page drops what came after begin()');
  assert.deepEqual(latest(ui).choices.map((/** @type {any} */ ch) => ch.checked), [false, true], 'opens with the boxes that were ticked');
  assert.equal(latest(ui).back, true);

  assert.equal(ui.back(), true);
  await tick();
  assert.deepEqual([latest(ui).message, latest(ui).default], ['Lakehouse name', 'Lake1']);
  ui.answer(latest(ui).id, 'Lake2');
  await tick();
  assert.equal(latest(ui).choices.some((/** @type {any} */ ch) => 'checked' in ch), false, 'after a new answer the rest are asked fresh');
  ui.answer(latest(ui).id, [0]);
  await tick();
  ui.answer(latest(ui).id, true);
  const result = await done;
  assert.deepEqual(result, { ws: { id: 'b' }, name: 'Lake2', extras: ['feedback'], go: true });
  assert.equal(result.ws, offered[1], 'a choice given again is the one offered this time');
  assert.equal(ui.back(), false, 'no question is open');

  ui.end();
  const next = ui.input('Next');
  ui.answer(latest(ui).id, 'y');
  await next;
  const later = ui.input('Later');
  assert.equal(ui.back(), false, 'no going back past end()');
  ui.cancel();
  await assert.rejects(later, { name: 'ExitPromptError' });
});

test('web ui: Back gives a secret again from memory and never shows it; back at it, an empty answer keeps it', async () => {
  const ui = createWebUi();
  const seen = /** @type {string[]} */ ([]);
  ui.subscribe((e) => seen.push(JSON.stringify(e)));
  ui.begin();
  const done = untilDone(async () => ({
    clientId: await ui.input('Client ID'),
    secret: await ui.secret('Client secret'),
    name: await ui.input('Name'),
    go: await ui.confirm('Go ahead?', true),
  }));
  ui.answer(latest(ui).id, 'c1');
  await tick();
  ui.answer(latest(ui).id, 'first-s3cr3t');
  await tick();
  ui.answer(latest(ui).id, 'n1');
  await tick();

  assert.equal(ui.back(), true);
  await tick();
  assert.deepEqual([latest(ui).message, latest(ui).default], ['Name', 'n1'], 'Back from Go ahead goes past the secret');
  assert.equal(ui.history().find((e) => e.kind === 'secret')?.replayed, true);

  assert.equal(ui.back(), true);
  await tick();
  const asked = latest(ui);
  assert.deepEqual([asked.kind, asked.keep, asked.back], ['secret', true, true]);
  assert.equal(ui.answer(asked.id, '  ').error, 'Required', 'only an empty answer keeps it');
  ui.answer(asked.id, '');
  await tick();
  assert.deepEqual([latest(ui).message, 'default' in latest(ui)], ['Name', false], 'after a new answer the rest are asked fresh');
  ui.answer(latest(ui).id, 'n2');
  await tick();
  ui.answer(latest(ui).id, true);
  assert.deepEqual(await done, { clientId: 'c1', secret: 'first-s3cr3t', name: 'n2', go: true });
  assert.doesNotMatch(JSON.stringify(ui.history()), /s3cr3t/);
  assert.doesNotMatch(seen.join(''), /s3cr3t/);
  ui.end();
});

test('web ui: back at a secret, a new one replaces it, and that is the one an empty answer keeps after', async () => {
  const ui = createWebUi();
  ui.begin();
  const done = untilDone(async () => ({ secret: await ui.secret('Client secret'), name: await ui.input('Name') }));
  ui.answer(latest(ui).id, 'first-s3cr3t');
  await tick();

  assert.equal(ui.back(), true);
  await tick();
  assert.equal(latest(ui).keep, true);
  ui.answer(latest(ui).id, 'second-s3cr3t');
  await tick();
  assert.equal(latest(ui).message, 'Name');

  assert.equal(ui.back(), true);
  await tick();
  assert.equal(latest(ui).keep, true);
  ui.answer(latest(ui).id, '');
  await tick();
  ui.answer(latest(ui).id, 'n1');
  assert.deepEqual(await done, { secret: 'second-s3cr3t', name: 'n1' });
  assert.doesNotMatch(JSON.stringify(ui.history()), /s3cr3t/);
  ui.end();
});

test('server: only the printed link opens it, and every call needs its cookie', async () => {
  const { server, cookie } = await serve();
  try {
    assert.equal((await call(server.port, { path: '/?t=wrong' })).status, 403);
    const opened = await call(server.port, { path: '/?t=tok' });
    assert.equal(opened.status, 303);
    assert.match(String(opened.headers['set-cookie']), new RegExp(`^${PRODUCT.id}_${server.port}=tok; HttpOnly; SameSite=Strict`));
    assert.equal((await call(server.port, { path: '/' })).status, 401);
    assert.equal((await call(server.port, { path: '/api/state', headers: { Cookie: `${PRODUCT.id}_${server.port}=nope` } })).status, 401);
    const state = await call(server.port, { path: '/api/state', headers: { Cookie: cookie } });
    assert.equal(state.status, 200);
    assert.deepEqual(JSON.parse(state.body), { installed: false });
    const html = await call(server.port, { path: '/', headers: { Cookie: cookie } });
    assert.match(html.body, /<title>ValueLens installer<\/title>/);
    assert.match(String(html.headers['content-security-policy']), /default-src 'none'/);
  } finally {
    server.close();
    await server.done;
  }
});

test('server: refuses another host name, another site and anything but JSON', async () => {
  const { server, post } = await serve();
  try {
    assert.equal((await call(server.port, { path: '/?t=tok', headers: { Host: `evil.example:${server.port}` } })).status, 421);
    assert.equal((await post('/api/cancel', {}, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await post('/api/cancel', {}, { Origin: '' })).status, 403);
    assert.equal((await post('/api/cancel', {}, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await call(server.port, { method: 'PUT', path: '/api/cancel', headers: { Cookie: `valuelens_${server.port}=tok` } })).status, 405);
  } finally {
    server.close();
    await server.done;
  }
});

test('server: answers reach the open question; a reconnecting page gets only what it missed', async () => {
  const { ui, server, cookie, post } = await serve();
  try {
    ui.heading('Fabric');
    const name = ui.input('Workspace name', { validate: (v) => (v ? true : 'Type a name') });
    const id = ui.history().at(-1)?.id;
    const bad = await post('/api/answer', { id, value: '' });
    assert.equal(bad.status, 422);
    assert.equal(JSON.parse(bad.body).error, 'Type a name');
    assert.equal((await post('/api/answer', { id, value: 'Analytics' })).status, 200);
    assert.equal(await name, 'Analytics');

    const stream = await call(server.port, { path: '/events', headers: { Cookie: cookie, 'Last-Event-ID': '2' }, until: '"type":"answered"' });
    assert.equal(stream.status, 200);
    assert.match(String(stream.headers['content-type']), /^text\/event-stream/);
    const ids = [...stream.body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    assert.deepEqual(ids, [3, 4], 'replays from after Last-Event-ID');
  } finally {
    server.close();
    await server.done;
  }
});

test('server: start passes through; quit waits for a running command', async () => {
  /** @type {unknown[]} */
  const started = [];
  /** @type {Record<string, any>} */
  const session = {
    running: 'install',
    start: (/** @type {unknown} */ body) => {
      started.push(body);
      return { ok: false, status: 409, error: 'Busy' };
    },
  };
  const { server, post } = await serve(session);
  try {
    const start = await post('/api/start', { command: 'status' });
    assert.equal(start.status, 409);
    assert.deepEqual(started, [{ command: 'status' }]);
    assert.equal((await post('/api/quit', {})).status, 409);
    session.running = null;
    assert.equal((await post('/api/quit', {})).status, 200);
    await server.done;
  } finally {
    server.close();
  }
});

test('server: start fresh and keep the record pass through, behind the same checks', async () => {
  let fresh = /** @type {any} */ ({ ok: true, archived: 'C:\\Docs\\valuelens-setup.20260507-090302.json' });
  let kept = 0;
  const { server, post } = await serve({ startFresh: () => fresh, keepRecord: () => (kept++, { ok: true }) });
  try {
    const ok = await post('/api/fresh', {});
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), fresh);
    fresh = { ok: false, status: 409, error: 'Wait for the current command to finish.' };
    const busy = await post('/api/fresh', {});
    assert.equal(busy.status, 409);
    assert.equal(JSON.parse(busy.body).error, 'Wait for the current command to finish.');
    assert.equal((await post('/api/keep', {})).status, 200);
    assert.equal(kept, 1);

    assert.equal((await call(server.port, { method: 'POST', path: '/api/fresh', body: '{}', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${server.port}` } })).status, 401);
    assert.equal((await post('/api/fresh', {}, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await post('/api/keep', {}, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal(kept, 1);
  } finally {
    server.close();
    await server.done;
  }
});

test('server: a page without the link says to press Enter in the installer window, and Enter opens it again', async () => {
  const { server } = await serve();
  try {
    const bare = await call(server.port, { path: '/' });
    assert.equal(bare.status, 401);
    assert.match(bare.body, /needs the installer's link\. Go back to .* and press Enter there to open the installer again\./);
    assert.match((await call(server.port, { path: '/?t=wrong' })).body, /expired\. Go back to .* press Enter/);
    assert.match(JSON.parse((await call(server.port, { path: '/api/state' })).body).error, /press Enter/);
  } finally {
    server.close();
    await server.done;
  }

  const input = new PassThrough();
  let opened = 0;
  const stop = reopenOnEnter(input, () => opened++);
  input.write('x');
  await tick();
  assert.equal(opened, 0);
  input.write('\r\n');
  await tick();
  assert.equal(opened, 1, 'one Enter, one page');
  stop();
  input.write('\n');
  await tick();
  assert.equal(opened, 1);
});

test('server: Back to settings cancels only an open category and keeps the installer session available', async () => {
  const { ui, server, post } = await serve();
  try {
    assert.equal((await post('/api/section-cancel', {})).status, 409);
    ui.beginSection();
    const asked = ui.form('Networking', [{ id: 'mode', label: 'Mode', default: 'private' }]);
    const cancelled = assert.rejects(asked, { name: 'SettingsCancelled' });
    assert.equal((await post('/api/section-cancel', {})).status, 200);
    await cancelled;
    ui.endSection();
    assert.equal((await post('/api/section-cancel', {})).status, 409);
    const next = ui.confirm('Continue?', true);
    assert.equal((await post('/api/answer', { id: latest(ui).id, value: true })).status, 200);
    assert.equal(await next, true);
  } finally {
    server.close();
    await server.done;
  }
});

test('server: Back works once there is an earlier question', async () => {
  const { ui, server, post } = await serve();
  try {
    ui.begin();
    const first = ui.input('Workspace name');
    const refused = await post('/api/back', {});
    assert.equal(refused.status, 409);
    assert.equal(JSON.parse(refused.body).error, 'There\'s no earlier question to go back to.');
    ui.answer(latest(ui).id, 'Analytics');
    assert.equal(await first, 'Analytics');
    const second = ui.input('Lakehouse name');
    const stopped = assert.rejects(second, { name: 'GoBack' });
    assert.equal((await post('/api/back', {})).status, 200);
    await stopped;
    assert.equal(latest(ui).type, 'rewind');
  } finally {
    ui.end();
    server.close();
    await server.done;
  }
});

test('terminal: after Back it shows the question the user went back to, not the answers given again', async () => {
  const ui = createWebUi();
  /** @type {string[]} */
  const out = [];
  ui.subscribe(mirror((s) => out.push(plainText(s))));
  ui.begin();
  const done = untilDone(async () => {
    ui.heading('Fabric');
    const ws = await ui.input('Workspace name');
    const lh = await ui.input('Lakehouse name');
    return { ws, lh, go: await ui.confirm('Go ahead?', true) };
  });
  ui.answer(latest(ui).id, 'Analytics');
  await tick();
  ui.answer(latest(ui).id, 'Lake');
  await tick();
  assert.equal(ui.back(), true);
  await tick();
  ui.answer(latest(ui).id, 'Lake2');
  await tick();
  ui.answer(latest(ui).id, true);
  assert.deepEqual(await done, { ws: 'Analytics', lh: 'Lake2', go: true });
  ui.end();
  assert.deepEqual(out.join('').split('\n').filter((l) => l.trim()), [
    'Fabric',
    '? Workspace name (answer in the browser)',
    '  → Analytics',
    '? Lakehouse name (answer in the browser)',
    '  → Lake',
    '? Go ahead? (answer in the browser)',
    '  ← Back',
    '? Lakehouse name (answer in the browser)',
    '  → Lake2',
    '? Go ahead? (answer in the browser)',
    '  → Yes',
  ]);
});

test('web ui: load cards become one event, and the terminal shows each source with its fix', () => {
  const ui = createWebUi();
  /** @type {string[]} */
  const out = [];
  ui.subscribe(mirror((s) => out.push(plainText(s))));
  /** @type {import('../src/loads.js').LoadCard[]} */
  const cards = [
    /** @type {any} */ ({ name: 'Licensed users', state: 'ok', fix: [] }),
    /** @type {any} */ ({ name: 'Copilot audit log', state: 'failed', reason: 'The capacity was busy.', fix: ['Try again later.'] }),
    /** @type {any} */ ({ name: 'Agent 365 (API)', state: 'skipped', fix: [] }),
    /** @type {any} */ ({ name: 'Shadow AI and agent risk (Defender)', state: 'warning', reason: 'It ran, but found nothing to load in cloud_discovery.', fix: ['Check the source has data for the period it reads.'] }),
  ];
  ui.loads(cards);
  const e = latest(ui);
  assert.equal(e.type, 'loads');
  assert.deepEqual(e.cards.map((/** @type {any} */ c) => c.state), ['ok', 'failed', 'skipped', 'warning']);
  const lines = out.join('').split('\n').map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(lines.slice(-8), [
    `${String.fromCharCode(10003)} Licensed users`,
    `${String.fromCharCode(10007)} Copilot audit log: failed`,
    'The capacity was busy.',
    'Try again later.',
    '! Agent 365 (API): skipped',
    '! Shadow AI and agent risk (Defender): loaded with a warning',
    'It ran, but found nothing to load in cloud_discovery.',
    'Check the source has data for the period it reads.',
  ]);
});

test('rewindable: Back puts the config back and reuses the API calls; the terminal just runs', async () => {
  const ui = createWebUi();
  let lists = 0;
  const fabric = {
    listWorkspaces: async () => {
      lists++;
      return [{ id: 'w1', displayName: 'One', type: 'Workspace' }, { id: 'w2', displayName: 'Two', type: 'Workspace' }];
    },
  };
  const { ctx, config } = fakeCtx({ ui: /** @type {any} */ (ui), fabric, sources: /** @type {any} */ ({}) });
  const real = ctx.api;
  const done = rewindable(ctx, async () => {
    const workspaces = await ctx.api.fabric.listWorkspaces();
    config.fabric.workspaceId = await ui.select('Workspace', workspaces.map((w) => ({ name: w.displayName, value: w.id })));
    config.fabric.lakehouseName = await ui.input('Lakehouse name', { default: config.fabric.lakehouseName });
    ctx.pendingSecret = 'pasted';
    return ui.confirm('Go ahead?', true);
  });
  await tick();
  assert.notEqual(ctx.api, real);
  ui.answer(latest(ui).id, 1);
  await tick();
  ui.answer(latest(ui).id, 'Lake1');
  await tick();
  assert.deepEqual([config.fabric.lakehouseName, ctx.pendingSecret], ['Lake1', 'pasted']);

  assert.equal(ui.back(), true);
  await tick();
  assert.deepEqual([latest(ui).message, latest(ui).default], ['Lakehouse name', 'Lake1']);
  assert.equal(config.fabric.lakehouseName, 'ValueLens', 'the config is as it was before the questions');
  assert.equal(ctx.pendingSecret, undefined);
  assert.equal(config.fabric.workspaceId, 'w2', 'the answer given again is in the config');
  assert.equal(lists, 1, 'the workspaces are listed once');

  ui.answer(latest(ui).id, 'Lake2');
  await tick();
  ui.answer(latest(ui).id, true);
  assert.equal(await done, true);
  assert.equal(ctx.api, real);
  assert.equal(ctx.config, config, 'put back in place, so save() still writes it');
  assert.deepEqual([config.fabric.lakehouseName, ctx.pendingSecret], ['Lake2', 'pasted']);

  const plain = fakeCtx({ sources: /** @type {any} */ ({}) });
  const plainApi = plain.ctx.api;
  assert.equal(await rewindable(plain.ctx, async () => plain.ctx.api === plainApi), true, 'the terminal can\'t go back, so nothing changes');

  const ui2 = createWebUi();
  const other = fakeCtx({ ui: /** @type {any} */ (ui2), sources: /** @type {any} */ ({}) });
  const otherApi = other.ctx.api;
  const failing = rewindable(other.ctx, async () => {
    await ui2.input('Workspace name');
    throw new Error('boom');
  });
  await tick();
  ui2.answer(latest(ui2).id, 'x');
  await assert.rejects(failing, /boom/);
  assert.equal(other.ctx.api, otherApi);
  const next = ui2.input('Next');
  ui2.answer(latest(ui2).id, 'y');
  await next;
  const after = ui2.input('After');
  assert.equal(ui2.back(), false, 'recording stopped with the error');
  ui2.cancel();
  await assert.rejects(after, { name: 'ExitPromptError' });
});

test('memoApi: the same call is made once, each caller gets its own copy, and a failure is not kept', async () => {
  /** @type {string[]} */
  const calls = [];
  let fail = true;
  const real = /** @type {any} */ ({
    fabric: {
      listItems: async (/** @type {string} */ ws, /** @type {string} */ type) => {
        calls.push(`listItems ${ws} ${type}`);
        return [{ id: `${ws}-1`, type }];
      },
      flaky: async () => {
        calls.push('flaky');
        if (fail) {
          fail = false;
          throw new Error('throttled');
        }
        return 'ok';
      },
      count: () => calls.length,
      each: async (/** @type {() => void} */ fn) => {
        calls.push('each');
        fn();
      },
    },
    dataverse: (/** @type {string} */ url) => ({ url }),
  });
  const api = /** @type {any} */ (memoApi(real));

  const first = await api.fabric.listItems('ws', 'Lakehouse');
  first[0].id = 'changed';
  assert.deepEqual(await api.fabric.listItems('ws', 'Lakehouse'), [{ id: 'ws-1', type: 'Lakehouse' }]);
  await api.fabric.listItems('ws', 'Notebook');
  assert.deepEqual(calls, ['listItems ws Lakehouse', 'listItems ws Notebook']);

  await assert.rejects(api.fabric.flaky(), /throttled/);
  assert.equal(await api.fabric.flaky(), 'ok');
  assert.equal(api.fabric.count(), 4, 'an answer that isn\'t a promise comes straight back');
  await api.fabric.each(() => {});
  await api.fabric.each(() => {});
  assert.equal(calls.filter((x) => x === 'each').length, 2, 'a call given a function is never kept');
  assert.equal(api.dataverse, real.dataverse);
});

test('page: every script under web/ parses', async () => {
  const web = new URL('web/', SRC);
  const scripts = (await readdir(web)).filter((f) => f.endsWith('.js'));
  assert.ok(scripts.includes('app.js'));
  for (const f of scripts) {
    const r = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(f, web))], { encoding: 'utf8' });
    assert.equal(r.status, 0, `web/${f} has a syntax error:\n${r.stderr}`);
  }
});

test('page: the stages and the finish it waits for are headings the installer prints', async () => {
  const app = await readFile(new URL('web/app.js', SRC), 'utf8');
  // A heading may carry the product's name: PRODUCT_NAME in the page, PRODUCT.name in the installer.
  const named = (/** @type {string} */ s) => s.replaceAll('${PRODUCT_NAME}', PRODUCT.name).replaceAll('${PRODUCT.name}', PRODUCT.name);
  const list = (/** @type {string} */ name) => {
    const m = new RegExp(`const ${name} = (?:new Set\\()?\\[([^\\]]*)\\]`).exec(app);
    assert.ok(m, `${name} is in app.js`);
    return [...m[1].matchAll(/'([^']+)'|`((?:[^`$]|\$\{PRODUCT_NAME\})+)`/g)].map((x) => named(x[1] ?? x[2]));
  };
  const files = (await readdir(SRC, { recursive: true })).filter((f) => f.endsWith('.js') && !/^web[\\/]/.test(f));
  const printed = new Set();
  for (const f of files) {
    const text = await readFile(new URL(f.replaceAll('\\', '/'), SRC), 'utf8');
    for (const m of text.matchAll(/\bheading\((?:'([^']+)'|`((?:[^`$]|\$\{PRODUCT\.name\})+)`)\)/g)) printed.add(named(m[1] ?? m[2]));
  }

  // Sign in comes from the sign-in event, Setting up from the numbered steps, and Done from the finish.
  const fromHeadings = list('INSTALL_STAGES').filter((s) => !['Sign in', 'Setting up', 'Done'].includes(s));
  assert.ok(fromHeadings.length >= 6);
  assert.deepEqual(fromHeadings.filter((s) => !printed.has(s)), []);
  const done = list('DONE_HEADINGS');
  assert.ok(done.length >= 2);
  assert.deepEqual(done.filter((s) => !printed.has(s)), []);

  // Done is last, so nothing ahead of it is skipped; each target-only stage is one of the stages.
  const stages = list('INSTALL_STAGES');
  assert.equal(stages.at(-1), 'Done');
  assert.ok(!stages.includes(`Where should ${PRODUCT.name} run?`), 'the target question comes first, so it slots in');
  const only = /const TARGET_STAGES = \{([\s\S]*?)\n\};/.exec(app)?.[1] ?? '';
  const tagged = [...only.matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(tagged.includes('Fabric'));
  assert.deepEqual(tagged.filter((s) => !stages.includes(s)), []);
});

test('page: every command has a row, or for prerequisites its own panel; Check the data needs the data check notebook', async () => {
  const app = await readFile(new URL('web/app.js', SRC), 'utf8');
  const rows = /const ROW_ORDER = \[([^\]]*)\]/.exec(app)?.[1] ?? '';
  assert.deepEqual(WEB_COMMANDS.filter((c) => c !== 'prereqs' && !rows.includes(`'${c}'`)), []);
  assert.match(app, /start\('prereqs'\)/, 'the Prerequisites panel starts the check');

  const config = emptyConfig();
  config.fabric.workspaceId = 'ws-1';
  config.fabric.lakehouseId = 'lh-1';
  assert.equal(describeRecord(config).can.check, false);
  config.fabric.notebooks.dataCheck = 'nb-check';
  assert.equal(describeRecord(config).can.check, true);
  config.history.days = 90;
  assert.equal(describeRecord(config).historyDays, 90, 'the installed view shows how much audit history is loaded');
  assert.equal(describeRecord(config).target, 'fabric', 'the page shows only that target\'s stages');
  assert.match(app, /backfillDays/, 'the Run row can load more history');
});

test('prereqsSnapshot: says whether the signer can assign directory roles, from an active Global or Privileged Role Administrator', () => {
  const row = (/** @type {string} */ status) => /** @type {any} */ ({ id: 'consent-role', label: 'x', neededFor: 'x', status });
  const yes = prereqsSnapshot('admin@contoso.com', [row('met')]);
  assert.equal(yes.canAssignDirectoryRoles, true);
  assert.equal(yes.upn, 'admin@contoso.com');
  assert.equal(prereqsSnapshot('admin@contoso.com', [row('eligible')]).canAssignDirectoryRoles, false, 'eligible is not active');
  assert.equal(prereqsSnapshot('admin@contoso.com', [row('missing')]).canAssignDirectoryRoles, false);
  assert.equal(prereqsSnapshot('admin@contoso.com', []).canAssignDirectoryRoles, false);
});

/** What the home page gets for a record, as a plain object. @param {any} config @param {any} [local] */
const describe = (config, local) => /** @type {Record<string, any>} */ (describeRecord(config, local));

/** An installed PAX record in tenant-1: the refresh on this PC, the SharePoint folder, the report and the app. */
function paxRecord() {
  const config = emptyConfig();
  config.target = 'pax';
  config.tenantId = 'tenant-1';
  config.app.appId = 'app-1';
  config.fabric.workspaceId = 'ws-1';
  config.fabric.workspaceName = PRODUCT.pax.workspace;
  config.semanticModel = { name: PRODUCT.pax.model, id: 'sm-1', report: { id: 'rep-1', name: PRODUCT.pax.report } };
  config.sharePoint = {
    folderUrl: 'https://contoso.sharepoint.com/sites/Analytics/Shared%20Documents/ValueLens',
    siteUrl: 'https://contoso.sharepoint.com/sites/Analytics',
    sitePath: 'contoso.sharepoint.com:/sites/Analytics',
    library: 'Shared Documents',
    folderPath: '/ValueLens',
  };
  config.pax = {
    credentialTarget: `${PRODUCT.pax.credentialPrefix}tenant-1`,
    secretExpires: '2027-06-01T00:00:00.000Z',
    task: { name: PRODUCT.pax.task, at: '02:00', registeredAt: '2026-06-01T12:00:00.000Z', logonType: 'Interactive' },
  };
  config.powerBi = { credentials: 'set' };
  config.access = { groupId: 'g-1', groupName: PRODUCT.viewerGroup };
  config.managedApp = { url: 'https://apps.powerplatform.example/valuelens' };
  return config;
}

test('describeRecord on the PAX route: the refresh on this PC, the folder, the report and the app', () => {
  const r = describe(paxRecord());
  assert.equal(r.target, 'pax');
  assert.equal(r.installed, true);
  assert.equal(r.workspace, PRODUCT.pax.workspace);
  assert.equal(r.workspaceUrl, 'https://app.powerbi.com/groups/ws-1?ctid=tenant-1', 'a Power BI workspace, not a Fabric one, in the install\'s tenant');
  assert.equal(r.lakehouse, undefined);
  assert.equal(r.files, 'Shared Documents/ValueLens on https://contoso.sharepoint.com/sites/Analytics');
  assert.equal(r.filesUrl, 'https://contoso.sharepoint.com/sites/Analytics/Shared%20Documents/ValueLens');
  assert.equal(r.schedule, `${PRODUCT.pax.task}, daily at 02:00, while you're signed in to this PC`);
  assert.deepEqual(r.data, ['Copilot interactions', 'users']);
  assert.equal(r.model, PRODUCT.pax.model);
  assert.equal(r.reportUrl, reportUrl('ws-1', 'rep-1', 'tenant-1'));
  assert.ok(r.reportUrl.endsWith('/reports/rep-1?ctid=tenant-1'), r.reportUrl);
  assert.equal(r.secretExpires, '2027-06-01');
  assert.equal(r.viewers, PRODUCT.viewerGroup);
  assert.equal(r.app, 'Open the app');
  assert.equal(r.appUrl, 'https://apps.powerplatform.example/valuelens');
  assert.deepEqual(r.can, {
    update: true, run: true, 'rerun-failed': false, check: true, refresh: true, status: true,
    'rotate-secret': true, access: true, upload: false, 'deploy-app': true, uninstall: true,
  });
});

test('describeRecord on the PAX route: what isn\'t done yet, and what each part allows', () => {
  const fresh = emptyConfig();
  fresh.target = 'pax';
  const none = describe(fresh);
  assert.equal(none.installed, false);
  for (const field of ['workspaceUrl', 'schedule', 'files', 'model', 'reportUrl', 'app']) assert.equal(none[field], undefined, field);
  assert.deepEqual(Object.keys(none.can).filter((c) => none.can[c]), [], 'nothing until the task is registered');

  // A setup that stopped part way can still be taken out.
  for (const part of [{ pax: { credentialTarget: 'PAX-ValueLens-tenant-1' } }, { sharePoint: paxRecord().sharePoint }, { app: { appId: 'app-1' } }]) {
    const d = describe({ ...emptyConfig(), target: 'pax', ...part });
    assert.equal(d.installed, false);
    assert.equal(d.can.uninstall, true, JSON.stringify(part));
    assert.equal(d.can['deploy-app'], false);
  }

  const c = /** @type {any} */ (paxRecord());
  c.pax.task.logonType = 'Password';
  c.pax.agent365 = true;
  c.powerBi = { credentials: 'later' };
  c.managedApp = { skipped: { why: 'Copilot managed apps are off in this tenant.', steps: [] } };
  const d = describe(c);
  assert.equal(d.schedule, `${PRODUCT.pax.task}, daily at 02:00`, 'it runs whether or not anyone is signed in');
  assert.equal(d.model, `${PRODUCT.pax.model}, not signed in to SharePoint yet`);
  assert.deepEqual(d.data, ['Copilot interactions', 'users', 'Agent 365']);
  assert.equal(d.app, 'Not deployed. Copilot managed apps are off in this tenant.');
  assert.equal(d.appUrl, undefined);

  c.managedApp = {};
  c.pax.deployApp = false;
  assert.equal(describe(c).app, 'Not deployed');
  delete c.app.appId;
  assert.equal(describe(c).can['rotate-secret'], false);
  c.semanticModel = { name: PRODUCT.pax.model };
  const noModel = describe(c);
  assert.deepEqual([noModel.can.refresh, noModel.can.access, noModel.reportUrl], [false, false, undefined]);
});

test('paxFirstRun: the first refresh as the home page shows it; this PC\'s state.json has the last word', () => {
  const startedAt = '2026-06-01T12:00:00.000Z';
  const state = (/** @type {string} */ lastResult, at = '2026-06-01T14:00:00.000Z') => ({ lastRunUtc: at, lastResult, ...(lastResult === 'success' ? { lastSuccessUtc: at } : {}) });
  assert.equal(paxFirstRun(undefined, undefined), undefined);
  assert.equal(paxFirstRun(undefined, state('success')), 'Completed', 'no first run on the record, and a refresh here has worked');
  assert.equal(paxFirstRun(undefined, state('failed')), undefined);
  assert.equal(paxFirstRun({ startedAt }, undefined), 'InProgress');
  assert.equal(paxFirstRun({ startedAt }, state('success', '2026-06-01T11:00:00.000Z')), 'InProgress', 'state.json from before it started');
  assert.equal(paxFirstRun({ startedAt }, state('success', '2026-06-01T11:59:30.000Z')), 'Completed', 'up to a minute before counts, as the clocks may differ');
  assert.equal(paxFirstRun({ startedAt }, state('success')), 'Completed');
  assert.equal(paxFirstRun({ startedAt }, state('no-data')), 'FinishedWithNoData');
  assert.equal(paxFirstRun({ startedAt }, state('failed')), 'Failed');
  assert.equal(paxFirstRun({ startedAt, result: 'failed' }, undefined), 'Failed', 'the record\'s result when this PC has no state.json');
  assert.equal(paxFirstRun({ startedAt, result: 'failed' }, state('success')), 'Completed', 'a later refresh here worked');
});

test('page: the route names are the installer\'s, each route hides only rows it never allows, and the PAX needs are current', async () => {
  const app = await readFile(new URL('web/app.js', SRC), 'utf8');
  const names = /const ROUTE_NAMES = \{ fabric: '([^']+)', pax: '([^']+)' \};/.exec(app);
  assert.ok(names, 'ROUTE_NAMES is in app.js');
  assert.deepEqual({ fabric: names[1], pax: names[2] }, { ...ROUTE_NAMES }, 'the page reads the route from the answer to "Where it runs"');
  assert.match(await readFile(new URL('target.js', SRC), 'utf8'), /heading\('Where it runs'\)/);
  assert.match(app, /run\.cur\?\.title === 'Where it runs'/);

  const quoted = (/** @type {string} */ s) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const rows = quoted(/const ROW_ORDER = \[([^\]]*)\]/.exec(app)?.[1] ?? '');
  const hidden = /const HIDDEN_ROWS = \{ fabric: new Set\(\[([^\]]*)\]\), pax: new Set\(\[([^\]]*)\]\) \};/.exec(app);
  assert.ok(hidden, 'HIDDEN_ROWS is in app.js');
  const byRoute = { fabric: quoted(hidden[1]), pax: quoted(hidden[2]) };
  assert.deepEqual(byRoute, { fabric: ['deploy-app'], pax: ['rerun-failed', 'upload'] });
  for (const c of [...byRoute.fabric, ...byRoute.pax]) assert.ok(rows.includes(c) && WEB_COMMANDS.includes(c), c);
  const fabric = emptyConfig();
  Object.assign(fabric.fabric, { workspaceId: 'ws-1', lakehouseId: 'lh-1', pipelineId: 'pl-1' });
  for (const c of byRoute.fabric) assert.equal(describe(fabric).can[c], false, c);
  const pax = describe(paxRecord()).can;
  for (const c of byRoute.pax) assert.equal(pax[c], false, c);
  assert.deepEqual(Object.keys(pax).filter((c) => pax[c] && !rows.includes(c)), [], 'what the record allows has a row');

  const needs = /\n {2}pax: \[\r?\n([\s\S]*?)\r?\n {2}\],\r?\n\};/.exec(app)?.[1] ?? '';
  assert.match(needs, /Power BI Pro or Premium Per User licence, to publish and share the report\. In a workspace without a capacity, everyone who opens the report needs one too\./);
  assert.doesNotMatch(needs, /from Power BI Desktop/, 'the installer publishes through the API, and Desktop is only the fallback');
  assert.doesNotMatch(app, /App Edition/i);
});

/**
 * A browser session over a record in a new temp folder, signed in to tenant-1 with read-only APIs.
 * Azure and Fabric capacities throw if asked, and the PAX route's PC is a fake.
 * @param {import('../src/config.js').InstallConfig | null} record
 */
function paxSession(record) {
  const dir = mkdtempSync(join(tmpdir(), 'vl-web-pax-'));
  const configFile = join(dir, PRODUCT.recordFile);
  if (record) saveConfig(configFile, record);
  const pc = fakePaxHost();
  const ui = createWebUi({ now: () => 1000 });
  const refuse = (/** @type {string} */ what) => () => {
    throw new Error(`Asked for ${what}.`);
  };
  const api = {
    graph: {
      myDirectoryRoles: async () => [{ roleTemplateId: '62e90394-69f5-4237-9190-012177145e10', displayName: 'Global Administrator' }],
      myEligibleRoles: async () => [],
      myGroupIds: refuse('graph.myGroupIds'),
      myLicenseDetails: async () => [{ servicePlans: [{ servicePlanName: 'BI_AZURE_P2', provisioningStatus: 'Success' }] }],
      subscribedSkus: async () => [],
      usersCanRegisterApps: async () => true,
    },
    arm: new Proxy({}, { get: (_, name) => refuse(`arm.${String(name)}`) }),
    fabric: {
      listCapacities: refuse('fabric.listCapacities'),
      tenantSettings: async () => {
        throw new HttpError('401 Unauthorized', { method: 'GET', url: 'https://api.fabric.microsoft.com/v1/admin/tenantsettings', status: 401 });
      },
      getWorkspace: async () => ({ id: 'ws-1' }),
    },
  };
  const connect = async () => ({ api, user: { id: 'u', upn: 'admin@contoso.com', tenantId: 'tenant-1' } });
  const s = createSession({ ui, configFile, version: '0.0.0', connect: /** @type {any} */ (connect), paxHost: pc.host });
  const ended = () => ui.history().filter((e) => e.type === 'command' && e.state !== 'running');
  const done = () => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(pc.base, { recursive: true, force: true });
  };
  return { s, pc, configFile, ended, done };
}

test('web session: only the prerequisites check takes a route; it checks that route on this PC and saves nothing', async () => {
  const fresh = paxSession(null);
  try {
    for (const req of [{ command: 'status', target: 'pax' }, { command: 'install', target: 'pax' }, { command: 'prereqs', target: 'azure' }]) {
      assert.deepEqual(fresh.s.start(/** @type {any} */ (req)), { ok: false, status: 400, error: 'The route is "fabric" or "pax", and only the prerequisites check takes one.' }, JSON.stringify(req));
    }
    assert.deepEqual(fresh.s.start({ command: 'prereqs', target: 'pax' }), { ok: true });
    await fresh.s.settled();
    assert.deepEqual(fresh.ended().map((e) => e.state), ['done']);
    const p = fresh.s.state().prereqs;
    assert.equal(p?.target, 'pax');
    assert.equal(p?.items.find((i) => i.id === 'this-pc')?.status, 'met', 'the session\'s PC, not the one running the tests');
    assert.ok(!p?.items.some((i) => i.id === 'azure-rbac' || i.id === 'fabric-capacity'));
    assert.ok(fresh.pc.keys().includes('pwsh'));
    assert.equal(existsSync(fresh.configFile), false, 'checking makes no install record');
  } finally {
    fresh.done();
  }

  const record = emptyConfig();
  record.tenantId = 'tenant-1';
  Object.assign(record.fabric, { workspaceId: 'ws-1', workspaceName: 'Analytics', lakehouseId: 'lh-1' });
  const fabric = paxSession(record);
  try {
    fabric.s.start({ command: 'prereqs', target: 'pax' });
    await fabric.s.settled();
    assert.equal(fabric.s.state().prereqs?.target, 'pax');
    assert.equal(loadConfig(fabric.configFile).config.target, 'fabric', 'the record keeps its route');
  } finally {
    fabric.done();
  }
});

test('web session: the home page reads the PAX refresh\'s state.json on the PC its steps run on', () => {
  const record = /** @type {any} */ (paxRecord());
  record.pax.firstRun = { startedAt: '2026-06-01T12:00:00.000Z' };
  const { s, pc, done } = paxSession(record);
  try {
    assert.equal(s.state().record?.firstRun, 'InProgress');
    pc.writeState({ lastRunUtc: '2026-06-01T15:00:00.000Z', lastResult: 'success', lastSuccessUtc: '2026-06-01T15:00:00.000Z' });
    assert.equal(s.state().record?.firstRun, 'Completed');
  } finally {
    done();
  }
});