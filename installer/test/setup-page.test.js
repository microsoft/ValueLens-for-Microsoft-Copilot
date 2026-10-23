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
  runInContext("app.attempts = [{ at: 0, state: 'failed', error: 'Capacity cap-1 not active' }];", context);
  const root = runInContext(`renderPrompt({
    id: 1, kind: 'settings', message: 'Review and fix setup', error: '',
    categories: [{ id: 'placement', title: 'Fabric placement', summary: 'capacity: cap-1', complete: true },
      { id: 'schedule', title: 'Schedule', summary: 'Daily at 02:00', complete: false }],
    notice: 'The capacity is paused', changes: ['capacity: cap-1 -> cap-2']
  })`, context);
  assert.match(root.text, /Fabric placement.*Schedule/);
  assert.match(root.text, /capacity: cap-1 -> cap-2/);
  assert.match(root.text, /Previous attempts in this session.*Capacity cap-1 not active/);
  const edit = all(root).find((el) => el.tag === 'button' && el.text.startsWith('Fabric placement'));
  edit?.events.click();
  assert.equal(context.submitted[0], 'placement');
});

test('grouped form submits all related fields together and explains locked fields', () => {
  const context = page();
  const root = runInContext(`renderPrompt({
    id: 2, kind: 'form', message: 'Fabric placement', error: '',
    fields: [{ id: 'capacity', label: 'Capacity', default: 'cap-1', readOnly: 'Already deployed',
      choices: [{ name: 'Contoso F64', value: 'cap-1' }] },
      { id: 'workspace', label: 'Workspace', default: 'ws-1', choices: [{ name: 'ValueLens', value: 'ws-1' }] }],
    settingsBack: true
  })`, context);
  assert.match(root.text, /Already deployed/);
  assert.match(root.text, /Back to settings/);
  assert.equal(all(root).filter((el) => el.tag === 'select').length, 2);
  root.events.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(context.submitted[0])), { capacity: 'cap-1', workspace: 'ws-1' });
});

test('failure page offers direct category edit, all settings and saved-config retry without Home', () => {
  const context = page();
  const root = runInContext(`renderOutcome({
    command: 'install', state: 'failed', phase: 'build', startedAt: 0, endedAt: 1000,
    error: 'Capacity cap-1 not active\\nCapacityNotActive: the capacity is paused',
    recovery: { section: 'placement', label: 'Change region or capacity' }
  })`, context);
  for (const label of ['Change region or capacity', 'Edit all settings', 'Retry saved configuration']) {
    const button = all(root).find((el) => el.tag === 'button' && el.text === label);
    assert.ok(button, label);
    button.events.click();
  }
  assert.deepEqual(JSON.parse(JSON.stringify(context.submitted)), [
    { command: 'install', section: 'placement' },
    { command: 'install' },
    { command: 'install', retry: true },
  ]);
  assert.match(root.text, /Technical details.*CapacityNotActive/s);
});

test('run page: an install step with a ✗ line shows as failed, even when the install carries on past it', () => {
  const context = page();
  const install = runInContext(`
    app.replay = true;
    app.run = createRun({ type: 'command', command: 'install', state: 'running', at: 0, seq: 1 });
    [
      { type: 'step', n: 1, total: 3, title: 'Power BI reports', at: 1 },
      { type: 'line', kind: 'fail', text: "The ValueLens report wasn't published: the import failed", at: 2 },
      { type: 'step', n: 2, total: 3, title: 'Data uploads', at: 3 },
      { type: 'line', kind: 'warn', text: 'No exports to upload.', at: 4 },
      { type: 'step', n: 3, total: 3, title: 'Model refresh', at: 5 },
      { type: 'line', kind: 'fail', text: 'The model refreshed, but a test query failed', at: 6 },
    ].forEach(apply);
    onCommand({ type: 'command', command: 'install', state: 'done', at: 7, seq: 2 });
    app.run.stages.find((s) => s.title === 'Setting up').kids.map((k) => [k.title, k.status, k.el.dataset.status]);
  `, context);
  assert.deepEqual(JSON.parse(JSON.stringify(install)), [
    ['Power BI reports', 'failed', 'failed'],
    ['Data uploads', 'done', 'done'],
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
  const feedback = { activity: 'Run_ProductFeedback_Ingester', name: 'Product feedback', state: 'failed', fix: [] };
  const defender = { activity: 'Run_Defender_Ingester', name: 'Shadow AI and agent risk (Defender)', state: 'ok', fix: [] };
  /** An install whose First load ends with these cards, then the product feedback export as a next step. @param {any[]} cards */
  const firstLoad = (cards) => JSON.parse(JSON.stringify(runInContext(`
    app.replay = true;
    app.state = { record: { can: { 'rerun-failed': true } } };
    app.run = createRun({ type: 'command', command: 'install', state: 'running', at: 0, seq: 1 });
    [
      { type: 'step', n: 1, total: 1, title: 'First load', at: 1 },
      { type: 'line', kind: 'ok', text: 'Pipeline finished in 2 h', at: 2 },
      { type: 'loads', cards: ${JSON.stringify(cards)}, at: 3 },
      { type: 'next-steps', title: '1 step left', at: 4, steps: [{ id: 'm365-export', title: 'Ask for the product feedback export',
        why: 'Without it, product feedback has no data.', who: 'A Microsoft 365 admin', activity: 'Run_ProductFeedback_Ingester' }] },
    ].forEach(apply);
    onCommand({ type: 'command', command: 'install', state: 'done', at: 5, seq: 2 });
    ({
      step: app.run.stages.find((s) => s.title === 'Setting up').kids[0].status,
      waiting: [...runItems(app.run.stages)].find((it) => it.t === 'loads').cards.map((c) => c.expected ?? null),
      outcome: app.run.outcomeEl.text,
    });
  `, context)));

  // On a busy capacity the load failed, export or not: the install counts it, so it isn't waiting on the export.
  const busy = firstLoad([{ ...feedback, kind: 'capacity', reason: "Fabric's capacity was too busy to start it.", counted: true }, defender]);
  assert.equal(busy.step, 'failed');
  assert.deepEqual(busy.waiting, [null, null]);
  assert.match(busy.outcome, /Some loads failed/);
  assert.match(busy.outcome, /Rerun failed/);

  // Failing until the export arrives is expected, as are cards saved before the page was told which failures count.
  const noExport = firstLoad([{ ...feedback, kind: 'noData' }, defender]);
  assert.equal(noExport.step, 'done');
  assert.deepEqual(noExport.waiting, ['Ask for the product feedback export', null]);
  assert.doesNotMatch(noExport.outcome, /Some loads failed|Rerun failed/);

  const other = firstLoad([{ ...feedback, kind: 'noData' }, { ...defender, state: 'failed', counted: true }]);
  assert.equal(other.step, 'failed', 'another load failed beside it');
  assert.deepEqual(other.waiting, ['Ask for the product feedback export', null]);
  assert.match(other.outcome, /Some loads failed/);
});
