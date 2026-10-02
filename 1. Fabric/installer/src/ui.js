// @ts-check
/**
 * Terminal output and questions. With --yes every question takes its default,
 * so a saved install record can be replayed without a person at the keyboard.
 */
import { checkbox, confirm, input, password, select } from '@inquirer/prompts';

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
