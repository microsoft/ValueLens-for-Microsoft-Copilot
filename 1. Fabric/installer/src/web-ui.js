// @ts-check
/**
 * The installer's output and questions as events, for the browser wizard. It has the same
 * methods as the terminal UI, so every step runs unchanged; each question waits until the
 * page answers it. Answers are checked here, with the step's own validation.
 */

/**
 * @typedef {'red' | 'green' | 'yellow' | 'cyan'} Colour
 * @typedef {{ text: string, bold?: boolean, dim?: boolean, colour?: Colour }} Segment
 * @typedef {{ type: string, seq: number, at: number, [key: string]: any }} UiEvent
 * @typedef {{ value?: any, display?: string, error?: string }} Parsed
 * @typedef {{ parse: (raw: unknown) => Parsed, resolve: (v: any) => void, reject: (e: Error) => void }} Pending
 */

// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[([0-9;]*)m/g;
// eslint-disable-next-line no-control-regex
const OTHER_ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]|\r/g;
/** @type {Record<number, Colour>} */
const COLOURS = { 31: 'red', 32: 'green', 33: 'yellow', 36: 'cyan' };
/** How a sign-in code reads in the device-code message. */
const DEVICE_CODE = /(https:\/\/\S+)\s.*?\bcode\s+([A-Z0-9-]{6,})/i;
export const SECRET_MASK = '••••••••';

/**
 * Splits text with ANSI colour codes into styled runs.
 * @param {string} s
 * @returns {Segment[]}
 */
export function toSegments(s) {
  /** @type {Segment[]} */
  const out = [];
  /** @type {Omit<Segment, 'text'>} */
  let style = {};
  let last = 0;
  const push = (/** @type {string} */ text) => {
    const clean = text.replace(OTHER_ESCAPES, '');
    if (clean) out.push({ text: clean, ...style });
  };
  for (const m of s.matchAll(SGR)) {
    push(s.slice(last, m.index));
    for (const code of (m[1] || '0').split(';').map(Number)) {
      if (code === 0) style = {};
      else if (code === 1) style = { ...style, bold: true };
      else if (code === 2) style = { ...style, dim: true };
      else if (code === 22) style = { colour: style.colour };
      else if (code === 39) style = { bold: style.bold, dim: style.dim };
      else if (COLOURS[code]) style = { ...style, colour: COLOURS[code] };
    }
    last = (m.index ?? 0) + m[0].length;
  }
  push(s.slice(last));
  return out.map((seg) => /** @type {Segment} */ (Object.fromEntries(Object.entries(seg).filter(([, v]) => v !== undefined))));
}

/** @param {string} s */
export const plainText = (s) => s.replace(SGR, '').replace(OTHER_ESCAPES, '');

/**
 * @template T
 * @typedef {import('./ui.js').Choice<T>} Choice
 */

/**
 * @param {{ now?: () => number }} [opts]
 */
export function createWebUi(opts = {}) {
  const now = opts.now ?? Date.now;
  /** @type {UiEvent[]} */
  const history = [];
  /** @type {Set<(e: UiEvent) => void>} */
  const listeners = new Set();
  /** @type {Map<number, Pending>} */
  const pending = new Map();
  let seq = 0;
  let ids = 0;

  /**
   * @param {{ type: string, [key: string]: any }} event
   * @returns {UiEvent}
   */
  function emit(event) {
    const e = { seq: ++seq, at: now(), ...event };
    history.push(e);
    for (const fn of listeners) fn(e);
    return e;
  }

  /** @param {string} kind @param {string} s */
  const say = (kind, s) => {
    emit({ type: 'line', kind, text: plainText(s), segments: toSegments(s) });
  };

  /**
   * @param {string} kind
   * @param {string} message
   * @param {Record<string, any>} extra
   * @param {(raw: unknown) => Parsed} parse
   * @returns {Promise<any>}
   */
  function ask(kind, message, extra, parse) {
    const id = ++ids;
    return new Promise((resolve, reject) => {
      pending.set(id, { parse, resolve, reject });
      emit({ type: 'prompt', id, kind, message: plainText(message), ...extra });
    });
  }

  /**
   * @param {{ name: string, description?: string, disabled?: boolean | string, checked?: boolean }} ch
   */
  const choiceView = (ch) => ({
    name: plainText(ch.name),
    ...(ch.description ? { description: plainText(ch.description) } : {}),
    ...(ch.disabled ? { disabled: typeof ch.disabled === 'string' ? ch.disabled : true } : {}),
    ...(ch.checked !== undefined ? { checked: !!ch.checked } : {}),
  });

  return {
    yes: false,
    /** @param {string} [s] */
    line(s = '') {
      const text = plainText(s);
      const code = DEVICE_CODE.exec(text);
      if (code) emit({ type: 'device-code', url: code[1], code: code[2], text });
      else if (text.trim()) say('line', s);
    },
    /** @param {string} title */
    heading: (title) => {
      emit({ type: 'heading', title: plainText(title) });
    },
    /** @param {number} n @param {number} total @param {string} title */
    step: (n, total, title) => {
      emit({ type: 'step', n, total, title: plainText(title) });
    },
    /** @param {string} s */
    ok: (s) => say('ok', s),
    /** @param {string} s */
    warn: (s) => say('warn', s),
    /** @param {string} s */
    fail: (s) => say('fail', s),
    /** @param {string} s */
    info: (s) => say('info', s),
    /** @param {string} s */
    note: (s) => say('note', s),
    /** @param {import('./steps/plan.js').PlanReview} plan */
    review: (plan) => {
      emit({ type: 'review', plan });
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
        emit({ type: 'auto', message: plainText(message), display: plainText(open[0].name) });
        return open[0].value;
      }
      const preferred = choices.findIndex((ch) => !ch.disabled && ch.value === defaultValue);
      return ask('select', message, { choices: choices.map(choiceView), default: preferred >= 0 ? preferred : choices.findIndex((ch) => !ch.disabled) }, (raw) => {
        const ch = Number.isInteger(raw) ? choices[/** @type {number} */ (raw)] : undefined;
        if (!ch || ch.disabled) return { error: 'Choose one of the options.' };
        return { value: ch.value, display: plainText(ch.name) };
      });
    },

    /**
     * @param {string} message
     * @param {boolean} defaultValue
     * @returns {Promise<boolean>}
     */
    async confirm(message, defaultValue) {
      return ask('confirm', message, { default: defaultValue }, (raw) =>
        typeof raw === 'boolean' ? { value: raw, display: raw ? 'Yes' : 'No' } : { error: 'Answer yes or no.' },
      );
    },

    /**
     * @param {string} message
     * @param {{ default?: string, validate?: (v: string) => true | string }} [o]
     * @returns {Promise<string>}
     */
    async input(message, o = {}) {
      return ask('input', message, o.default !== undefined ? { default: o.default } : {}, (raw) => {
        if (typeof raw !== 'string') return { error: 'Type an answer.' };
        const value = raw === '' && o.default !== undefined ? o.default : raw;
        const verdict = o.validate ? o.validate(value) : true;
        if (verdict !== true) return { error: verdict };
        return { value, display: value };
      });
    },

    /**
     * Never recorded: the history and the page only see a mask.
     * @param {string} message
     * @returns {Promise<string>}
     */
    async secret(message) {
      return ask('secret', message, {}, (raw) => (typeof raw === 'string' && raw.trim() ? { value: raw, display: SECRET_MASK } : { error: 'Required' }));
    },

    /**
     * @template T
     * @param {string} message
     * @param {(Choice<T> & { checked?: boolean })[]} choices
     * @returns {Promise<T[]>}
     */
    async checkbox(message, choices) {
      return ask('checkbox', message, { choices: choices.map(choiceView) }, (raw) => {
        if (!Array.isArray(raw)) return { error: 'Choose from the options.' };
        const picked = [...new Set(raw)].sort((a, b) => a - b);
        if (picked.some((i) => !Number.isInteger(i) || !choices[i] || choices[i].disabled)) return { error: 'Choose from the options.' };
        return {
          value: picked.map((i) => choices[i].value),
          display: picked.length ? picked.map((i) => plainText(choices[i].name)).join(', ') : 'None',
        };
      });
    },

    /**
     * A long wait. The page counts the elapsed time itself, so only a new status is sent.
     * @param {string} label
     */
    progress(label) {
      const id = ++ids;
      const startedAt = now();
      let last = '';
      emit({ type: 'progress', id, label: plainText(label), status: '', startedAt });
      return {
        /** @param {string} status */
        update(status) {
          const s = plainText(status);
          if (s === last) return;
          last = s;
          emit({ type: 'progress', id, label: plainText(label), status: s, startedAt });
        },
        done() {
          const ms = now() - startedAt;
          emit({ type: 'progress-done', id, ms });
          return ms;
        },
      };
    },

    /** Session events, such as a command starting or finishing. */
    emit,

    /**
     * Answers an open question. A rejected answer leaves it open.
     * @param {number} id
     * @param {unknown} raw
     * @returns {{ ok: boolean, error?: string }}
     */
    answer(id, raw) {
      const p = pending.get(id);
      if (!p) return { ok: false, error: 'That question isn\'t open any more.' };
      const r = p.parse(raw);
      if (r.error !== undefined) {
        emit({ type: 'invalid', id, error: r.error });
        return { ok: false, error: r.error };
      }
      pending.delete(id);
      emit({ type: 'answered', id, display: r.display });
      p.resolve(r.value);
      return { ok: true };
    },

    /** Stops at the open question, the way Ctrl+C does in the terminal. */
    cancel() {
      if (!pending.size) return false;
      for (const [id, p] of pending) {
        pending.delete(id);
        emit({ type: 'answered', id, display: 'Cancelled', cancelled: true });
        const err = new Error('Cancelled');
        err.name = 'ExitPromptError';
        p.reject(err);
      }
      return true;
    },

    /** Events after `since`, for a page that connects or reconnects. @param {number} [since] */
    history: (since = 0) => history.filter((e) => e.seq > since),

    /**
     * @param {(e: UiEvent) => void} fn
     * @returns {() => void} Unsubscribes.
     */
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** @typedef {ReturnType<typeof createWebUi>} WebUi */
