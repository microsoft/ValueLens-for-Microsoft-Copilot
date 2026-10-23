// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

/** A small DOM double exercises the real page renderers and their event payloads. */
class Element {
  /** @param {string} tag */
  constructor(tag) {
    this.tag = tag;
    /** @type {Element[]} */
    this.children = [];
    /** @type {Record<string, string>} */
    this.attributes = {};
    /** @type {Record<string, Function>} */
    this.events = {};
    this.value = '';
    this.selected = false;
    this.textContent = '';
    /** @type {Record<string, string>} */
    this.dataset = {};
  }
  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name === 'value') this.value = value;
    if (name === 'selected') this.selected = true;
  }
  /** @param {string} name @param {Function} handler */
  addEventListener(name, handler) { this.events[name] = handler; }
  /** @param {Element[]} kids */
  append(...kids) {
    this.children.push(...kids);
    if (this.tag === 'select') {
      this.value = this.children.find((child) => child.selected)?.value ?? this.children[0]?.value ?? '';
    }
  }
  /** @param {(Element | string)[]} kids */
  replaceChildren(...kids) {
    this.children = [];
    this.append(...kids.map((kid) => (typeof kid === 'string' ? Object.assign(new Element('#text'), { textContent: kid }) : kid)));
  }
  replaceWith() {}
  remove() {}
  /** @returns {string} */
  get text() { return this.textContent + this.children.map((child) => child.text).join(''); }
}

function page() {
  const context = createContext({
    Node: Element, matchMedia: () => ({ matches: false }), requestAnimationFrame: () => 0, submitted: [],
    document: {
      createElement: (/** @type {string} */ tag) => new Element(tag),
      createElementNS: (/** @type {string} */ ns, /** @type {string} */ tag) => new Element(tag),
      createTextNode: (/** @type {string} */ text) => Object.assign(new Element('#text'), { textContent: text }),
    },
  });
  const source = readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8').replace(/\ninit\(\);\s*$/, '\n');
  runInContext(source, context);
  runInContext('answer = (item, value) => submitted.push(value); start = (command, extra = {}) => submitted.push({ command, ...extra });', context);
  return context;
}

/** @param {Element} root @returns {Element[]} */
function all(root) { return [root, ...root.children.flatMap(all)]; }

test('settings page renders every category as a direct action and shows edits and earlier attempts', () => {
  const context = page();
  runInContext("app.attempts = [{ at: 0, state: 'failed', error: 'SQL region locked' }];", context);
  const root = runInContext(`renderPrompt({
    id: 1, kind: 'settings', message: 'Review and fix setup', error: '',
    categories: [{ id: 'placement', title: 'Azure placement', summary: 'SQL: UK South', complete: true },
      { id: 'schedule', title: 'Schedule', summary: 'Daily at 02:00', complete: false }],
    notice: 'SQL capacity is locked', changes: ['SQL: UK South -> Sweden Central']
  })`, context);
  assert.match(root.text, /Azure placement.*Schedule/);
  assert.match(root.text, /SQL: UK South -> Sweden Central/);
  assert.match(root.text, /Previous attempts in this session.*SQL region locked/);
  const edit = all(root).find((el) => el.tag === 'button' && el.text.startsWith('Azure placement'));
  edit?.events.click();
  assert.equal(context.submitted[0], 'placement');
});

test('grouped form submits all related fields together and explains locked fields', () => {
  const context = page();
  const root = runInContext(`renderPrompt({
    id: 2, kind: 'form', message: 'Azure placement', error: '',
    fields: [{ id: 'region', label: 'Region', default: 'uk', readOnly: 'Already deployed',
      choices: [{ name: 'UK South', value: 'uk' }] },
      { id: 'sql', label: 'SQL region', default: 'sweden', choices: [{ name: 'Sweden Central', value: 'sweden' }] }],
    settingsBack: true
  })`, context);
  assert.match(root.text, /Already deployed/);
  assert.match(root.text, /Back to settings/);
  assert.equal(all(root).filter((el) => el.tag === 'select').length, 2);
  root.events.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(context.submitted[0])), { region: 'uk', sql: 'sweden' });
});

test('failure page offers direct category edit, all settings and saved-config retry without Home', () => {
  const context = page();
  const root = runInContext(`renderOutcome({
    command: 'install', state: 'failed', phase: 'build', startedAt: 0, endedAt: 1000,
    error: 'SQL capacity locked\\nDeploymentFailed: nested SQL failure',
    recovery: { section: 'placement', label: 'Change SQL region' }
  })`, context);
  for (const label of ['Change SQL region', 'Edit all settings', 'Retry saved configuration']) {
    const button = all(root).find((el) => el.tag === 'button' && el.text === label);
    assert.ok(button, label);
    button.events.click();
  }
  assert.deepEqual(JSON.parse(JSON.stringify(context.submitted)), [
    { command: 'install', section: 'placement' },
    { command: 'install' },
    { command: 'install', retry: true },
  ]);
  assert.match(root.text, /Technical details.*DeploymentFailed/s);
});

test('run page: an install step with a ✗ line shows as failed, even when the install carries on past it', () => {
  const context = page();
  const install = runInContext(`
    app.replay = true;
    app.run = createRun({ type: 'command', command: 'install', state: 'running', at: 0, seq: 1 });
    [
      { type: 'step', n: 1, total: 3, title: 'Analytics Hub app', at: 1 },
      { type: 'line', kind: 'fail', text: "The app wasn't deployed: the deploy tool failed", at: 2 },
      { type: 'step', n: 2, total: 3, title: 'Share the app', at: 3 },
      { type: 'line', kind: 'warn', text: "There's no app yet, so there's nothing to share.", at: 4 },
      { type: 'step', n: 3, total: 3, title: 'Model refresh', at: 5 },
      { type: 'line', kind: 'fail', text: 'The model refreshed, but a test query failed', at: 6 },
    ].forEach(apply);
    onCommand({ type: 'command', command: 'install', state: 'done', at: 7, seq: 2 });
    app.run.stages.find((s) => s.title === 'Setting up').kids.map((k) => [k.title, k.status, k.el.dataset.status]);
  `, context);
  assert.deepEqual(JSON.parse(JSON.stringify(install)), [
    ['Analytics Hub app', 'failed', 'failed'],
    ['Share the app', 'done', 'done'],
    ['Model refresh', 'failed', 'failed'],
  ]);

  // Other commands' sections aren't steps: status shows an earlier run that failed with ✗, and checking it didn't fail.
  const status = runInContext(`
    app.run = createRun({ type: 'command', command: 'status', state: 'running', at: 0, seq: 3 });
    [
      { type: 'heading', title: 'Recent runs', at: 1 },
      { type: 'line', kind: 'fail', text: '2026-06-01 02:00 UTC  Failed, 3 h 45 min  Scheduled', at: 2 },
    ].forEach(apply);
    onCommand({ type: 'command', command: 'status', state: 'done', at: 3, seq: 4 });
    app.run.stages[1].kids.map((k) => [k.title, k.status]);
  `, context);
  assert.deepEqual(JSON.parse(JSON.stringify(status)), [['Recent runs', 'done']]);
});

test('run page: a load failure the install counts shows as failed with Rerun failed, even when a next step is for that load', () => {
  const context = page();
  const cowork = { activity: 'Refresh_Cowork_Credits', name: 'Cowork credits (Viva Insights)', state: 'failed', fix: [] };
  const studio = { activity: 'Run_Consumption_Studio', name: 'Copilot Studio credits', state: 'ok', fix: [] };
  /** An install whose First load ends with these cards, then the Cowork sign-in as a next step. @param {any[]} cards */
  const firstLoad = (cards) => JSON.parse(JSON.stringify(runInContext(`
    app.replay = true;
    app.state = { record: { can: { 'rerun-failed': true } } };
    app.run = createRun({ type: 'command', command: 'install', state: 'running', at: 0, seq: 1 });
    [
      { type: 'step', n: 1, total: 1, title: 'First load', at: 1 },
      { type: 'line', kind: 'ok', text: 'Pipeline finished in 2 h', at: 2 },
      { type: 'loads', cards: ${JSON.stringify(cards)}, at: 3 },
      { type: 'next-steps', title: '1 step left', at: 4, steps: [{ id: 'cowork-dataflow', title: 'Sign in to the Dataflow',
        why: 'Cowork credits load once it has its sign-ins.', who: 'You', activity: 'Refresh_Cowork_Credits' }] },
    ].forEach(apply);
    onCommand({ type: 'command', command: 'install', state: 'done', at: 5, seq: 2 });
    ({
      step: app.run.stages.find((s) => s.title === 'Setting up').kids[0].status,
      waiting: [...runItems(app.run.stages)].find((it) => it.t === 'loads').cards.map((c) => c.expected ?? null),
      outcome: app.run.outcomeEl.text,
    });
  `, context)));

  // On a busy capacity the Dataflow failed, signed in or not: the install counts it, so it isn't waiting on the sign-in.
  const busy = firstLoad([{ ...cowork, kind: 'capacity', reason: "Fabric's capacity was too busy to start it.", counted: true }, studio]);
  assert.equal(busy.step, 'failed');
  assert.deepEqual(busy.waiting, [null, null]);
  assert.match(busy.outcome, /Some loads failed/);
  assert.match(busy.outcome, /Rerun failed/);

  // Failing until it's signed in is expected, as are cards saved before the page was told which failures count.
  const unsigned = firstLoad([{ ...cowork, kind: 'signIn' }, studio]);
  assert.equal(unsigned.step, 'done');
  assert.deepEqual(unsigned.waiting, ['Sign in to the Dataflow', null]);
  assert.doesNotMatch(unsigned.outcome, /Some loads failed|Rerun failed/);

  const other = firstLoad([{ ...cowork, kind: 'signIn' }, { ...studio, state: 'failed', counted: true }]);
  assert.equal(other.step, 'failed', 'another load failed beside it');
  assert.deepEqual(other.waiting, ['Sign in to the Dataflow', null]);
  assert.match(other.outcome, /Some loads failed/);
});
