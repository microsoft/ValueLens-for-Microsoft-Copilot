// @ts-check
/**
 * Terminal output and questions. With --yes every question takes its default,
 * so a saved install record can be replayed without a person at the keyboard.
 */
import { checkbox, confirm, input, password, select } from '@inquirer/prompts';
import { inspectFile } from './staging.js';
import { dataSource, MODE_LABELS, routedSources } from './uploads.js';

const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
/** @param {string} code */
const paint = (code) => (/** @type {string} */ s) => (useColour ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  bold: paint('1'),
  dim: paint('2'),
  green: paint('32'),
  yellow: paint('33'),
  red: paint('31'),
  cyan: paint('36'),
};

/**
 * @template T
 * @typedef {{ name: string, value: T, description?: string, disabled?: boolean | string }} Choice
 */
/**
 * @typedef {{ id: string, label: string, default: string, choices?: Choice<string>[], validate?: (value: string) => true | string, readOnly?: string }} FormField
 * @typedef {{ id: string, title: string, summary: string, complete: boolean }} SettingsCategory
 */

/**
 * @param {unknown} raw
 * @param {FormField[]} fields
 * @returns {{ value: Record<string, string>, error?: undefined } | { error: string, value?: undefined }}
 */
export function parseForm(raw, fields) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Fill in the settings.' };
  const input = /** @type {Record<string, unknown>} */ (raw);
  /** @type {Record<string, string>} */
  const value = {};
  for (const field of fields) {
    const v = input[field.id];
    if (typeof v !== 'string') return { error: `${field.label}: enter a value.` };
    if (field.readOnly && v !== field.default) return { error: `${field.label}: ${field.readOnly}` };
    if (field.choices && !field.choices.some((ch) => ch.value === v && !ch.disabled)) return { error: `${field.label}: choose one of the options.` };
    const verdict = field.validate?.(v) ?? true;
    if (verdict !== true) return { error: `${field.label}: ${verdict}` };
    value[field.id] = v;
  }
  return { value };
}

/**
 * @param {{ yes?: boolean, write?: (s: string) => void }} [opts]
 */
export function createUi(opts = {}) {
  const write = opts.write ?? ((/** @type {string} */ s) => process.stdout.write(s));
  const line = (/** @type {string} */ s = '') => write(`${s}\n`);
  const yes = !!opts.yes;

  /**
   * @param {string} question
   * @returns {never}
   */
  function needsAnswer(question) {
    throw new Error(`"${question}" has no saved answer. Run without --yes, or add it to the install record.`);
  }

  return {
    yes,
    /** The browser wizard, rather than the terminal. */
    web: false,
    beginSection() {},
    endSection() {},
    /**
     * @param {string} message
     * @param {FormField[]} fields
     * @returns {Promise<Record<string, string> | null>}
     */
    async form(message, fields) {
      line(message);
      /** @type {Record<string, string>} */
      const values = {};
      for (const field of fields) {
        values[field.id] = field.choices
          ? await select({ message: field.label, choices: field.choices, default: field.default })
          : await input({ message: field.label, default: field.default, validate: field.validate });
      }
      return values;
    },
    /**
     * @param {SettingsCategory[]} categories
     * @param {{ notice?: string, changes: string[] }} state
     * @returns {Promise<string>}
     */
    async settings(categories, state) {
      if (state.notice) line(state.notice);
      return select({ message: 'Review and fix setup', choices: [
        ...categories.map((cat) => ({ name: `${cat.title}: ${cat.summary}`, value: cat.id })),
        { name: 'Review deployment', value: 'deploy' },
        { name: 'Save and close', value: 'close' },
      ] });
    },
    line,
    /** @param {string} title */
    heading: (title) => line(`\n${c.bold(c.cyan(title))}`),
    /** @param {number} n @param {number} total @param {string} title */
    step: (n, total, title) => line(`\n${c.bold(`[${n}/${total}] ${title}`)}`),
    /** @param {string} s */
    ok: (s) => line(`  ${c.green('✓')} ${s}`),
    /** @param {string} s */
    warn: (s) => line(`  ${c.yellow('!')} ${s}`),
    /** @param {string} s */
    fail: (s) => line(`  ${c.red('✗')} ${s}`),
    /** @param {string} s */
    info: (s) => line(`    ${s}`),
    /** @param {string} s */
    note: (s) => line(`    ${c.dim(s)}`),
    /**
     * The plan as structured data. The terminal already printed it line by line, all but the costs.
     * @param {import('./steps/plan.js').PlanReview} plan
     */
    review: (plan) => {
      (plan.costs ?? []).forEach((cost, i) => line(`    ${i ? ' '.repeat(13) : 'Costs:       '}${cost.what} ${c.dim(cost.url)}`));
    },
    /**
     * How each source's load went: a tick, a cross or a warning per source, then why and what to do.
     * @param {import('./loads.js').LoadCard[]} cards
     */
    loads: (cards) => {
      for (const card of cards) {
        const tries = card.attempts ? c.dim(` (${card.attempts} attempts)`) : '';
        if (card.state === 'ok') line(`  ${c.green('✓')} ${card.name}${tries}`);
        else if (card.state === 'warning') line(`  ${c.yellow('!')} ${card.name}: loaded with a warning${tries}`);
        else if (card.state === 'failed') line(`  ${c.red('✗')} ${card.name}: failed${tries}`);
        else if (card.state === 'skipped') line(`  ${c.yellow('!')} ${card.name}: skipped`);
        else if (card.state === 'todo') line(`  ${c.yellow('!')} ${card.name}: to do`);
        else line(`  ${c.yellow('!')} ${card.name}: still running`);
        if (card.reason) line(`    ${card.reason}`);
        for (const fix of card.fix) line(`    ${c.dim(fix)}`);
      }
    },
    /**
     * Something left for the user to finish, such as signing in to the Cowork Dataflow.
     * @param {import('./steps/consumption.js').CoworkNextStep} step
     */
    todo: (step) => {
      line(`\n  ${c.yellow('!')} ${c.bold(step.title)}`);
      step.steps.forEach((s, i) => line(`    ${i + 1}. ${s}`));
      line(`    ${c.dim(step.note)}`);
    },
    /**
     * What's left, as numbered cards: who does each, why, the link and steps, and for a hand-off the message to send.
     * @param {string} title  e.g. "2 steps left".
     * @param {import('./steps/next-steps.js').NextStep[]} steps
     */
    nextSteps: (title, steps) => {
      line(`  ${c.bold(c.yellow(title))}`);
      steps.forEach((s, i) => {
        line(`  ${c.yellow(`${i + 1}.`)} ${c.bold(s.title)}${s.optional ? c.dim(' (optional)') : ''}${c.dim(`  ${s.who}`)}`);
        line(`     ${s.why}`);
        if (s.link) line(`     ${c.dim(`${s.linkText ? `${s.linkText}: ` : ''}${s.link}`)}`);
        (s.steps ?? []).forEach((step, j) => line(`     ${String.fromCharCode(97 + j)}. ${step}`));
        if (s.message) {
          line(`     ${c.dim('Copy and send:')}`);
          for (const m of s.message.split('\n')) line(`       ${c.dim(m)}`);
        }
      });
    },
    /**
     * What the user has and lacks: met, missing, eligible (activate first) or couldn't check.
     * @param {import('./prereqs.js').Prereq[]} items
     */
    prereqs: (items) => {
      const glyph = { met: c.green('✓'), missing: c.red('✗'), eligible: c.yellow('◐'), unknown: c.dim('?') };
      for (const it of items) {
        line(`  ${glyph[it.status]} ${it.label}${it.optional ? c.dim(' (optional)') : ''}`);
        line(`    ${it.detail}`);
        for (const r of it.rows ?? []) line(`      ${glyph[r.status]} ${r.name}${r.detail ? c.dim(`: ${r.detail}`) : ''}`);
        line(`    ${c.dim(`Needed for: ${it.neededFor}`)}`);
        if (it.status !== 'met') line(`    ${c.dim(`How to get it: ${it.howTo}`)}`);
      }
    },

    /**
     * @template T
     * @param {string} message
     * @param {Choice<T>[]} choices
     * @param {T} [defaultValue]
     * @returns {Promise<T>}
     */
    async select(message, choices, defaultValue) {
      const open = choices.filter((ch) => !ch.disabled);
      if (open.length === 1) {
        line(`${c.green('✔')} ${message} ${c.cyan(open[0].name)}`);
        return open[0].value;
      }
      if (yes) return defaultValue !== undefined ? defaultValue : needsAnswer(message);
      return select({ message, choices, default: defaultValue });
    },

    /**
     * @param {string} message
     * @param {boolean} defaultValue
     */
    async confirm(message, defaultValue) {
      if (yes) return defaultValue;
      return confirm({ message, default: defaultValue });
    },

    /**
     * @param {string} message
     * @param {{ default?: string, validate?: (v: string) => true | string }} [o]
     */
    async input(message, o = {}) {
      if (yes) {
        if (o.default === undefined) needsAnswer(message);
        const verdict = o.validate?.(o.default) ?? true;
        if (verdict !== true) throw new Error(`${message}: ${verdict}`);
        return o.default;
      }
      return input({ message, default: o.default, validate: o.validate });
    },

    /**
     * @param {string} message
     * @returns {Promise<string>}
     */
    async secret(message) {
      if (yes) return needsAnswer(message);
      return password({ message, mask: '*', validate: (v) => (v.trim() ? true : 'Required') });
    },

    /**
     * @template T
     * @param {string} message
     * @param {(Choice<T> & { checked?: boolean })[]} choices
     * @returns {Promise<T[]>}
     */
    async checkbox(message, choices) {
      if (yes) return choices.filter((ch) => ch.checked).map((ch) => ch.value);
      return checkbox({ message, choices });
    },

    /**
     * The Data sources screen: how each source arrives, then any exports to upload now.
     * @param {string} message
     * @param {import('./uploads.js').SourceCard[]} cards
     * @param {{ lockModes?: boolean }} [o]  Only pick files; the modes stay as they are.
     * @returns {Promise<{ modes: import('./uploads.js').DataSourceModes, files: import('./staging.js').PendingUpload[] }>}
     */
    async sources(message, cards, o = {}) {
      const modes = /** @type {import('./uploads.js').DataSourceModes} */ (Object.fromEntries(cards.map((card) => [card.id, card.mode])));
      line(`    ${message}`);
      /** @type {string | undefined} */
      let group;
      for (const card of cards) {
        if (card.group && card.group !== group) line(`    ${c.bold(card.group)}`);
        group = card.group;
        const fixed = card.locked || o.lockModes || card.modes.length === 1 || yes;
        if (!fixed) {
          modes[card.id] = await select({
            message: card.label,
            choices: card.modes.map((m) => ({ name: m.label, value: m.value, description: modeHint(card, m.value) })),
            default: card.mode,
          });
        } else line(`${c.green('✔')} ${card.label} ${c.cyan(card.modes.find((m) => m.value === modes[card.id])?.label ?? MODE_LABELS[modes[card.id]])}`);
        if ((card.exportModes ?? ['csv']).includes(modes[card.id]) && card.export && !o.lockModes) line(`    ${c.dim(`Export: ${card.export.where} ${card.export.url}`)}`);
      }
      /** @type {import('./staging.js').PendingUpload[]} */
      const files = [];
      if (yes || !routedSources(modes).length) return { modes, files };
      for (;;) {
        const path = await input({
          message: files.length ? 'Another export to upload now (leave blank when done)' : 'Path to an export to upload now (leave blank to add them later)',
          validate: (v) => {
            if (!v.trim()) return true;
            const r = inspectFile(v, modes);
            return r.ok ? true : r.error;
          },
        });
        if (!path.trim()) break;
        const r = inspectFile(path, modes);
        if (r.ok) {
          files.push(r.file);
          line(`    ${c.dim(`${r.file.name}: ${dataSource(r.file.source).label}`)}`);
        }
      }
      return { modes, files };
    },

    /**
     * A one-line ticking status for long waits.
     * @param {string} label
     */
    progress(label) {
      const started = Date.now();
      const tty = process.stdout.isTTY;
      let last = '';
      return {
        /** @param {string} status */
        update(status) {
          const head = `    ${label}: ${status}`;
          const tail = `(${formatDuration(Date.now() - started)})`;
          // A line that wraps can't be redrawn with \r, so keep it within the terminal.
          const width = process.stdout.columns ?? 0;
          const fits = !width || head.length + 1 + tail.length < width;
          const text = fits ? `${head} ${c.dim(tail)}` : head.slice(0, Math.max(1, width - 1));
          if (tty) write(`\r\x1b[K${text}`);
          else if (status !== last) line(`${head} ${c.dim(tail)}`);
          last = status;
        },
        done() {
          if (tty) write('\r\x1b[K');
          return Date.now() - started;
        },
      };
    },
  };
}

/** @typedef {ReturnType<typeof createUi>} Ui */

/**
 * What choosing a mode means for one source, under its name in the list.
 * @param {import('./uploads.js').SourceCard} card
 * @param {import('./uploads.js').SourceMode} mode
 */
export function modeHint(card, mode) {
  const own = card.modes.find((m) => m.value === mode)?.hint;
  if (own) return own;
  if (mode === 'api') return card.uploadable ? 'Read on every run. If the API can\'t be reached, an uploaded export is used instead.' : 'Read on every run.';
  if (mode === 'csv') return card.export ? `${card.export.where} ${card.export.files}` : 'Upload the export.';
  return card.page ? `Not collected. The ${card.page} page stays empty until you turn it on.` : 'Not collected.';
}

/** @param {number} ms */
export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(r).padStart(2, '0')}s`;
  return `${r}s`;
}
