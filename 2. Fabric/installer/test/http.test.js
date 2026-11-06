// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient, HttpError, retryDelayMs } from '../src/http.js';

/**
 * A fetch that answers from a script and records each call.
 * @param {Array<(url: string, init: any) => { status?: number, body?: any, headers?: Record<string, string> } | Error>} script
 */
function fakeFetch(script) {
  /** @type {{ url: string, method: string, headers: Record<string, string>, body?: string }[]} */
  const calls = [];
  const fetchImpl = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (
      async (/** @type {string} */ url, /** @type {any} */ init) => {
        calls.push({ url, method: init.method, headers: init.headers, body: init.body });
        const step = script.shift();
        if (!step) throw new Error(`Unexpected request: ${init.method} ${url}`);
        const r = step(url, init);
        if (r instanceof Error) throw r;
        const body = r.body === undefined ? null : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        return new Response(body, { status: r.status ?? 200, headers: r.headers });
      }
    )
  );
  return { fetchImpl, calls };
}

/** @param {ReturnType<typeof fakeFetch>} f */
function client(f) {
  /** @type {number[]} */
  const sleeps = [];
  const http = createClient({
    baseUrl: 'https://api.example.com/v1/',
    getToken: async () => 'tok',
    fetchImpl: f.fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { http, sleeps };
}

test('sends a bearer token, JSON body and query', async () => {
  const f = fakeFetch([() => ({ status: 201, body: { id: 'a' } })]);
  const { http } = client(f);
  const data = await http.post('/things', { name: 'x' }, { query: { type: 'Notebook', skip: undefined } });
  assert.deepEqual(data, { id: 'a' });
  assert.equal(f.calls[0].url, 'https://api.example.com/v1/things?type=Notebook');
  assert.equal(f.calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(f.calls[0].headers['Content-Type'], 'application/json');
  assert.equal(f.calls[0].body, '{"name":"x"}');
});

test('retries throttling using Retry-After', async () => {
  const f = fakeFetch([() => ({ status: 429, headers: { 'Retry-After': '7' } }), () => ({ body: { ok: true } })]);
  const { http, sleeps } = client(f);
  assert.deepEqual(await http.get('/x'), { ok: true });
  assert.deepEqual(sleeps, [7000]);
});

test('retries network errors, then gives up with the URL', async () => {
  const f = fakeFetch([() => new Error('ECONNRESET'), () => ({ body: 1 })]);
  const { http } = client(f);
  assert.equal(await http.get('/x'), 1);

  const g = fakeFetch([() => new Error('ECONNRESET'), () => new Error('ECONNRESET')]);
  await assert.rejects(client(g).http.get('/x', { maxRetries: 1 }), /GET https:\/\/api\.example\.com\/v1\/x failed: ECONNRESET/);
});

test('a 400 is not retried and becomes an HttpError with code and message', async () => {
  const f = fakeFetch([() => ({ status: 400, body: { errorCode: 'InvalidInput', message: 'Bad name' } })]);
  const { http, sleeps } = client(f);
  await assert.rejects(http.get('/x'), (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 400);
    assert.equal(err.code, 'InvalidInput');
    assert.match(err.message, /GET \/v1\/x returned 400 InvalidInput: Bad name/);
    return true;
  });
  assert.equal(sleeps.length, 0);
  assert.equal(f.calls.length, 1);
});

test('retryOn and retryIf retry statuses that are usually final', async () => {
  const f = fakeFetch([() => ({ status: 403 }), () => ({ body: 'ok' })]);
  assert.equal(await client(f).http.get('/x', { retryOn: [403] }), 'ok');

  const g = fakeFetch([() => ({ status: 404, body: { error: { message: 'not yet' } } }), () => ({ body: 'ok' })]);
  assert.equal(await client(g).http.get('/x', { retryIf: (s, d) => s === 404 && /not yet/.test(JSON.stringify(d)) }), 'ok');

  const h = fakeFetch([() => ({ status: 400, body: { error: { message: 'already exists' } } })]);
  await assert.rejects(client(h).http.get('/x', { retryIf: (s, d) => s === 400 && !/already exists/.test(JSON.stringify(d)) }), HttpError);
});

test('a long-running operation is followed to its Location result', async () => {
  const f = fakeFetch([
    () => ({ status: 202, headers: { Location: 'https://api.example.com/v1/operations/op1', 'Retry-After': '2' } }),
    () => ({ body: { status: 'Running' } }),
    () => ({ body: { status: 'Succeeded' }, headers: { Location: 'https://api.example.com/v1/operations/op1/result' } }),
    () => ({ body: { id: 'new-item' } }),
  ]);
  const { http, sleeps } = client(f);
  assert.deepEqual(await http.requestLro('POST', '/items', { body: {} }), { id: 'new-item' });
  assert.equal(f.calls[3].url, 'https://api.example.com/v1/operations/op1/result');
  assert.equal(sleeps[0], 2000);
});

test('lroResult fetches /result when the operation gives no Location', async () => {
  const f = fakeFetch([
    () => ({ status: 202, headers: { 'x-ms-operation-id': 'op2', 'Retry-After': '1' } }),
    () => ({ body: { status: 'Succeeded' } }),
    () => ({ body: { id: 'lh' } }),
  ]);
  assert.deepEqual(await client(f).http.requestLro('POST', '/lakehouses', { body: {}, lroResult: true }), { id: 'lh' });
  assert.equal(f.calls[1].url, 'https://api.example.com/v1/operations/op2');
  assert.equal(f.calls[2].url, 'https://api.example.com/v1/operations/op2/result');
});

test('an operation with no result returns null, and a failed one throws', async () => {
  const f = fakeFetch([() => ({ status: 202, headers: { 'x-ms-operation-id': 'op3' } }), () => ({ body: { status: 'Succeeded' } })]);
  assert.equal(await client(f).http.requestLro('POST', '/update', { body: {} }), null);

  const g = fakeFetch([
    () => ({ status: 202, headers: { 'x-ms-operation-id': 'op4' } }),
    () => ({ body: { status: 'Failed', error: { errorCode: 'Boom', message: 'It broke' } } }),
  ]);
  await assert.rejects(client(g).http.requestLro('POST', '/update', { body: {} }), /Fabric operation failed \(Boom\): It broke/);

  const h = fakeFetch([() => ({ status: 200, body: { id: 'sync' } })]);
  assert.deepEqual(await client(h).http.requestLro('POST', '/update', { body: {} }), { id: 'sync' });
});

test('list follows Fabric, Graph and ARM paging links', async () => {
  const f = fakeFetch([
    () => ({ body: { value: [1, 2], continuationUri: 'https://api.example.com/v1/things?ct=a' } }),
    () => ({ body: { value: [3], '@odata.nextLink': 'https://api.example.com/v1/things?skip=b' } }),
    () => ({ body: { value: [4], nextLink: 'https://api.example.com/v1/things?n=c' } }),
    () => ({ body: { value: [] } }),
  ]);
  assert.deepEqual(await client(f).http.list('/things', { query: { type: 'Notebook' } }), [1, 2, 3, 4]);
  assert.equal(f.calls[0].url, 'https://api.example.com/v1/things?type=Notebook');
  assert.equal(f.calls[1].url, 'https://api.example.com/v1/things?ct=a');
});

test('retryDelayMs honours Retry-After and caps backoff', () => {
  assert.equal(retryDelayMs(new Headers({ 'Retry-After': '0' }), 0), 1000);
  assert.equal(retryDelayMs(new Headers({ 'Retry-After': '999' }), 0), 120_000);
  const d = retryDelayMs(undefined, 10);
  assert.ok(d >= 30_000 && d < 30_500);
});
