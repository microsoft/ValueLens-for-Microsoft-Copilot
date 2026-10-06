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
     * The plan as structured data. The terminal already printed it line by line.
     * @param {import('./steps/plan.js').PlanReview} _plan
     */
    review: (_plan) => {},

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
      for (const card of cards) {
        const fixed = card.locked || o.lockModes || card.modes.length === 1 || yes;
        if (!fixed) {
          modes[card.id] = await select({
            message: card.label,
            choices: card.modes.map((m) => ({ name: m.label, value: m.value, description: modeHint(card, m.value) })),
            default: card.mode,
          });
        } else line(`${c.green('✔')} ${card.label} ${c.cyan(card.modes.find((m) => m.value === modes[card.id])?.label ?? MODE_LABELS[modes[card.id]])}`);
        if (modes[card.id] === 'csv' && card.export && !o.lockModes) line(`    ${c.dim(`Export: ${card.export.where} ${card.export.url}`)}`);
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
