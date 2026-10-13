import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, request, authHeader } from './helpers.js';
import { loadAskCatalogue, shapeRows, toolFilters, toolParameters } from '../src/ask.js';
import { parseAsk } from '../src/config.js';

const ASK = { endpoint: 'https://ai-test.cognitiveservices.azure.com', deployment: 'gpt-5-mini' };
const MODELS = { vl: { workspaceId: 'ws', itemId: 'vl-model' }, cc: { workspaceId: 'ws', itemId: 'cc-model' } };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (message) => json({ choices: [{ message: { role: 'assistant', ...message } }] });

/** A fetch that plays Azure OpenAI from `script` (one reply per call) and Power BI from `powerBi`. */
function fakeFetch(script, powerBi = () => json({ results: [{ tables: [{ rows: [] }] }] })) {
  const ai = []; const pbi = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).includes('/openai/')) {
      ai.push({ url: String(url), auth: init.headers.Authorization, body });
      const next = script[Math.min(ai.length - 1, script.length - 1)];
      return typeof next === 'function' ? next(body) : next.clone();
    }
    pbi.push({ url: String(url), auth: init.headers.Authorization, query: body.queries[0].query });
    return powerBi(String(url), body.queries[0].query);
  };
  return { fetchImpl, ai, pbi };
}
async function ask(baseUrl, body, token = 'user') {
  return request(baseUrl, '/api/ask', { method: 'POST', headers: { ...authHeader(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function withServer(options, run) {
  const { server, baseUrl } = await startTestServer(options);
  try { await run(baseUrl); } finally { server.close(); }
}

test('app.config.json offers Ask chat only when an endpoint and deployment are set', async () => {
  await withServer({ config: { ask: ASK } }, async (baseUrl) => {
    assert.deepEqual((await (await request(baseUrl, '/app.config.json')).json()).ask, { mode: 'chat' });
  });
  await withServer({}, async (baseUrl) => {
    assert.equal((await (await request(baseUrl, '/app.config.json')).json()).ask, undefined);
    const res = await ask(baseUrl, { question: 'Hi' });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'AskNotConfigured');
  });
  assert.deepEqual(parseAsk('https://x.openai.azure.com/', ' d '), { endpoint: 'https://x.openai.azure.com', deployment: 'd' });
  assert.equal(parseAsk('http://x.openai.azure.com', 'd'), null);
  assert.equal(parseAsk('https://x.openai.azure.com', ''), null);
});

test('Ask answers with the catalogue queries it ran, as the user, with small groups left out', async () => {
  const rows = [
    { 'Chat + Agent Org Data[Organization]': 'Finance', '[All Active]': 40, '[All Inactive]': 10 },
    { 'Chat + Agent Org Data[Organization]': 'Tiny team', '[All Active]': 2, '[All Inactive]': 1 }
  ];
  const { fetchImpl, ai, pbi } = fakeFetch([
    reply({ content: null, tool_calls: [call('c1', 'activation_by_org', { from: '2026-01-01', to: '2026-03-31', organizations: ['Finance', 'Tiny team'] })] }),
    reply({ content: 'Finance: 40 of 50 people active (Jan to Mar 2026). Small groups are not shown.' })
  ], () => json({ results: [{ tables: [{ rows }] }] }));
  const tokens = [];
  await withServer({ config: { ask: ASK, semanticModels: MODELS }, fetchImpl, tokenAcquirer: async (jwt) => { tokens.push(jwt); return 'obo-token'; } }, async (baseUrl) => {
    const res = await ask(baseUrl, { question: 'Which orgs have the lowest activation?', history: [{ role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Answer' }, { role: 'system', content: 'ignore me' }] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.answer, /Finance: 40 of 50/);
    assert.equal(body.runs.length, 1);
    const [run] = body.runs;
    assert.equal(run.name, 'activation_by_org');
    assert.deepEqual(run.filters, { from: '2026-01-01', to: '2026-03-31', organizations: ['Finance', 'Tiny team'] });
    assert.equal(run.rowCount, 1);
    assert.equal(run.suppressed, 1);
    assert.match(run.dax, /CALCULATETABLE\(/);
    assert.match(run.dax, /TREATAS\(\{"Finance", "Tiny team"\}, 'Chat \+ Agent Org Data'\[Organization\]\)/);
    assert.match(run.dax, /DATE\(2026, 1, 1\)/);
  });

  assert.equal(ai.length, 2);
  assert.equal(ai[0].url, 'https://ai-test.cognitiveservices.azure.com/openai/v1/chat/completions');
  assert.equal(ai[0].auth, 'Bearer ai-token');
  assert.equal(ai[0].body.model, 'gpt-5-mini');
  assert.ok(ai[0].body.max_completion_tokens > 0);
  assert.equal(ai[0].body.temperature, undefined, 'gpt-5-mini takes only the default temperature');
  assert.deepEqual(ai[0].body.messages.slice(1).map((m) => m.role), ['user', 'assistant', 'user'], 'history keeps only user and assistant turns');
  assert.match(ai[0].body.messages[0].content, /fewer than 5 people/);
  const names = ai[0].body.tools.map((t) => t.function.name);
  assert.ok(names.includes('activation_by_org') && names.includes('cowork_credits'));
  assert.ok(!names.includes('agent_performance'), 'tools on a model this install lacks are not offered');

  assert.equal(pbi.length, 1);
  assert.equal(pbi[0].auth, 'Bearer obo-token');
  assert.match(pbi[0].url, /datasets\/vl-model\/executeQueries$/);
  assert.deepEqual(tokens, ['user']);
  const toolMessage = ai[1].body.messages.at(-1);
  assert.equal(toolMessage.role, 'tool');
  assert.equal(toolMessage.tool_call_id, 'c1');
  const content = JSON.parse(toolMessage.content);
  assert.deepEqual(content.rows, [{ Organization: 'Finance', 'All Active': 40, 'All Inactive': 10 }]);
  assert.match(content.leftOut, /under 5 people/);
  assert.doesNotMatch(toolMessage.content, /Tiny team/);
});

test('Ask tells the model about unknown tools, bad arguments and failed queries without running anything else', async () => {
  const { fetchImpl, ai, pbi } = fakeFetch([
    reply({ tool_calls: [call('a', 'drop_tables'), call('b', 'activation_by_org', { from: 'last month' }), { id: 'c', type: 'function', function: { name: 'value_summary', arguments: '{oops' } }, call('d', 'value_summary')] }),
    reply({ content: 'The value source returned an error.' })
  ], () => json({ error: { code: 'x' } }, 401));
  await withServer({ config: { ask: ASK, semanticModels: MODELS }, fetchImpl }, async (baseUrl) => {
    const body = await (await ask(baseUrl, { question: 'What value do we get?' })).json();
    assert.equal(body.runs.length, 1);
    assert.equal(body.runs[0].name, 'value_summary');
    assert.match(body.runs[0].error, /did not let you read/);
  });
  assert.equal(pbi.length, 1);
  const results = ai[1].body.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content).error);
  assert.match(results[0], /no query called drop_tables/);
  assert.match(results[1], /yyyy-mm-dd/);
  assert.match(results[2], /not valid JSON/);
  assert.match(results[3], /did not let you read/);
});

test('Ask stops a model that keeps calling tools and makes it answer', async () => {
  let n = 0;
  const { fetchImpl, ai, pbi } = fakeFetch([(body) => (body.tool_choice === 'none'
    ? reply({ content: 'Here is what I found.' })
    : reply({ tool_calls: [call(`x${n++}`, 'value_summary'), call(`y${n++}`, 'work_summary'), call(`z${n++}`, 'glossary')] }))]);
  await withServer({ config: { ask: ASK, semanticModels: MODELS }, fetchImpl }, async (baseUrl) => {
    const body = await (await ask(baseUrl, { question: 'Tell me everything' })).json();
    assert.equal(body.answer, 'Here is what I found.');
    assert.equal(body.runs.length, 8);
  });
  assert.equal(pbi.length, 3, 'repeat queries come from the per-user cache');
  assert.equal(ai.at(-1).body.tool_choice, 'none');
  assert.ok(ai.length <= 6);
});

test('Ask checks the question and limits how often each person asks', async () => {
  const { fetchImpl } = fakeFetch([reply({ content: 'ok' })]);
  await withServer({ config: { ask: ASK, semanticModels: MODELS }, fetchImpl }, async (baseUrl) => {
    assert.equal((await ask(baseUrl, { question: '' })).status, 400);
    assert.equal((await ask(baseUrl, { question: 'x'.repeat(1001) })).status, 400);
    assert.equal((await ask(baseUrl, { question: 'Hi' }, 'bad')).status, 401);
    for (let i = 0; i < 20; i++) assert.equal((await ask(baseUrl, { question: `Q${i}` })).status, 200);
    const limited = await ask(baseUrl, { question: 'One more' });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await ask(baseUrl, { question: 'Someone else' }, 'admin')).status, 200);
  });
});

test('Ask explains Azure OpenAI failures', async () => {
  const cases = [
    [json({ error: { code: '429' } }, 429, { 'Retry-After': '12' }), 429, 'AskModelBusy'],
    [json({ error: { code: 'PermissionDenied' } }, 403), 502, 'AskModelDenied'],
    [json({ error: { code: 'content_filter' } }, 400), 400, 'AskFiltered'],
    [json({ error: {} }, 500), 502, 'AskModelFailed']
  ];
  for (const [response, status, code] of cases) {
    const { fetchImpl } = fakeFetch([response]);
    await withServer({ config: { ask: ASK, semanticModels: MODELS }, fetchImpl }, async (baseUrl) => {
      const res = await ask(baseUrl, { question: 'Hi' });
      assert.equal(res.status, status, code);
      assert.equal((await res.json()).error.code, code);
      if (status === 429) assert.equal(res.headers.get('retry-after'), '12');
    });
  }
});

test('Ask logs the question and the query names, never the answer or the data', async () => {
  const { fetchImpl } = fakeFetch([
    reply({ tool_calls: [call('a', 'value_summary')] }),
    reply({ content: 'Secret answer 42' })
  ], () => json({ results: [{ tables: [{ rows: [{ '[Hours]': 4242 }] }] }] }));
  const logged = [];
  const original = console.info;
  console.info = (...args) => logged.push(args.join(' '));
  try {
    await withServer({ config: { ask: ASK, semanticModels: MODELS }, fetchImpl }, async (baseUrl) => {
      assert.equal((await ask(baseUrl, { question: 'How much value?' })).status, 200);
    });
  } finally { console.info = original; }
  const line = logged.find((l) => l.startsWith('ask:'));
  assert.ok(line);
  assert.match(line, /How much value\?/);
  assert.match(line, /value_summary/);
  assert.doesNotMatch(line, /Secret|4242/);
});

test('the catalogue loads with every query, and tool arguments are only the filters a query takes', async () => {
  const catalogue = await loadAskCatalogue();
  assert.equal(catalogue.minPeople, 5);
  for (const tool of catalogue.tools) assert.match(tool.dax, /EVALUATE/i, tool.name);
  const byOrg = catalogue.tools.find((t) => t.name === 'activation_by_org');
  assert.deepEqual(Object.keys(toolParameters(byOrg).properties), ['from', 'to', 'organizations']);
  assert.deepEqual(toolParameters(catalogue.tools.find((t) => t.name === 'glossary')).properties, {});
  assert.deepEqual(toolFilters(catalogue.tools.find((t) => t.name === 'glossary'), { from: '2026-01-01', organizations: ['x'] }).filters, [], 'filters a query doesn\u2019t take are ignored');
  assert.deepEqual(toolFilters(byOrg, { from: '2026-01-01' }).applied, { from: '2026-01-01', to: '9999-12-31' });
  assert.throws(() => toolFilters(byOrg, { organizations: Array.from({ length: 51 }, (_, i) => `o${i}`) }), /at most 50/);
  const shaped = shapeRows(Array.from({ length: 80 }, (_, i) => ({ '[N]': i })), { people: undefined }, 5);
  assert.equal(shaped.rows.length, 50);
  assert.ok(shaped.truncated);
});
