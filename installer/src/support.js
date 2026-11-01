// @ts-check
/**
 * The support file: one zip a customer can look through and email when setup or a load goes wrong.
 *
 * It holds the installer's version and route, the last run's step log, the prerequisite checks,
 * recent run statuses and their errors, row counts per table, a summary of the refresh logs, and
 * the install record. Secrets, keys and tokens are removed, email addresses and people's names are
 * hashed, and no data rows are ever read. The Analytics Hub installer writes the same layout with
 * the same rules, so one set of notes covers both.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { PRODUCT } from './product.js';
import { ROUTE_NAMES } from './target.js';
import { crc32 } from './transform/zip.js';
import { DATA_CHECK_FILE } from './transform/notebook.js';
import { defaultPaxHost, paxPaths } from './steps/pax/local.js';

/** The files in the zip, in order. Each is always there; a missing piece says why. */
export const SUPPORT_FILES = /** @type {const} */ ([
  'README.txt',
  'manifest.json',
  'settings.json',
  'last-run.json',
  'prereqs.json',
  'runs.json',
  'row-counts.json',
  'logs-summary.json',
]);

export const REMOVED = '[removed]';

/** Keys whose values are secrets. `keyVault` is kept: it names the vault, not a key. */
export const SECRET_KEY = /secret|passw(or)?d|^pwd$|token|key(?!vault)|signature|connectionstring|^sas|sas(url|uri)?$|credential|authori[sz]ation|cookie/i;

/** Keys that hold a person, or under which everything is about a person, such as user.displayName. */
export const PERSON_KEY = /^(givenName|surname|fullName|userName|contact|owner|owners|createdBy|lastModifiedBy|requestedBy|upn|userPrincipalName|mail|email|adminEmail|user|signedInAs|signedInUser|userDisplayName)$/i;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const EMAIL = /[A-Za-z0-9._%+'#-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Secrets in free text, each with what it becomes. */
const SECRET_TEXT = /** @type {[RegExp, string][]} */ ([
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REMOVED], // JWT
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REMOVED}`],
  [/\b(sig|AccountKey|SharedAccessKey|SharedAccessSignature|client_secret|client_assertion|code_verifier|refresh_token|access_token|id_token|password|pwd)(\s*[=:]\s*)("?)[^;&\s"',}]+/gi, `$1$2$3${REMOVED}`],
  [/\b[A-Za-z0-9_.-]{2,5}~[A-Za-z0-9_.~-]{30,}/g, REMOVED], // Entra client secret
]);
const LONG_BASE64 = /[A-Za-z0-9+/_=-]{80,}/g;
/** Long runs that are Azure resource paths or URLs, not keys. */
const RESOURCE_PATH = /\/(subscriptions|resourceGroups|providers|groups|workspaces|items)\//i;

export const REDACTION_RULES = Object.freeze([
  'Values under keys that name a secret, token, key, password, signature, SAS, credential or connection string are removed. GUIDs, dates, numbers and true/false under them stay, such as when a secret expires.',
  'Tokens (JWTs), bearer tokens, SAS signatures, account and shared access keys, client secrets and long base64 strings are removed from any text.',
  'Email addresses, UPNs and people\'s names are replaced by user- and 10 hex digits: a SHA-256 hash with a random salt that is used for this file only and kept nowhere. The same person has the same token throughout the file.',
  'Tenant, workspace and item IDs (GUIDs) are kept, so we can find the right run.',
  'No data rows are read: tables appear as row counts only.',
]);

/**
 * Removes secrets and, unless `people` is false, hashes email addresses, UPNs and names, counting
 * what it changed. Tokens are SHA-256 of a salt and the trimmed, lower-cased value, shown as `user-`
 * and 10 hex digits. One redactor per support file, so one person has one token in it and nowhere
 * else. The Analytics Hub installer uses the same rules.
 * @param {{ salt?: Buffer, people?: boolean }} [o]
 */
export function createRedactor(o = {}) {
  const salt = o.salt ?? randomBytes(16);
  const people = o.people !== false;
  const counts = { secrets: 0, emails: 0, names: 0 };
  /** Names seen under person keys. @type {Set<string>} */
  const names = new Set();

  /** @param {string} value */
  const token = (value) => `user-${createHash('sha256').update(salt).update(value.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 10)}`;

  /** @param {unknown} name */
  function learn(name) {
    if (typeof name !== 'string') return;
    const n = name.trim();
    // A short name, an email (hashed anyway) or an ID would only blur the text around it.
    if (n.length < 3 || n.includes('@') || GUID.test(n) || /^user-[0-9a-f]{10}$/.test(n)) return;
    names.add(n);
  }

  /** @param {string} s */
  function text(s) {
    // eslint-disable-next-line no-control-regex
    let out = String(s).replace(/\x1b\[[0-9;]*m/g, '');
    for (const [re, to] of SECRET_TEXT) {
      out = out.replace(re, (...m) => {
        counts.secrets++;
        return to.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? '');
      });
    }
    out = out.replace(LONG_BASE64, (m) => {
      if (RESOURCE_PATH.test(m) || !(/\d/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m))) return m;
      counts.secrets++;
      return REMOVED;
    });
    if (!people) return out;
    out = out.replace(EMAIL, (m) => {
      counts.emails++;
      return token(m);
    });
    for (const n of [...names].sort((a, b) => b.length - a.length)) {
      out = out.replace(new RegExp(`(?<![\\w-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'gi'), () => {
        counts.names++;
        return token(n);
      });
    }
    return out;
  }

  /**
   * @param {unknown} v
   * @param {boolean} secret  Under a secret key: only GUIDs, dates, numbers and booleans stay.
   * @param {boolean} person  Under a person key.
   * @returns {unknown}
   */
  function walk(v, secret, person) {
    if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      if (secret) {
        if (!v || GUID.test(v) || ISO_DATE.test(v)) return v;
        counts.secrets++;
        return REMOVED;
      }
      if (person && people && v.trim() && !GUID.test(v)) {
        if (v.includes('@')) counts.emails++;
        else counts.names++;
        return token(v);
      }
      return text(v);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, secret, person));
    if (typeof v === 'object') {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, secret || SECRET_KEY.test(k), person || PERSON_KEY.test(k));
      return out;
    }
    return REMOVED;
  }

  /** Learns every name under a person key, so the same names in free text are hashed too. @param {unknown} v */
  function learnFrom(v) {
    /** @param {unknown} x @param {boolean} person */
    const visit = (x, person) => {
      if (typeof x === 'string') {
        if (person) learn(x);
      } else if (Array.isArray(x)) x.forEach((y) => visit(y, person));
      else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) visit(y, person || PERSON_KEY.test(k));
    };
    visit(v, false);
  }

  return { text, value: (/** @type {unknown} */ v) => walk(v, false, false), learn, learnFrom, token, counts };
}

/** @typedef {ReturnType<typeof createRedactor>} Redactor */

// ---------------------------------------------------------------------------------------------
// The run log, kept beside the install record.

/** The run log beside the install record: the last few runs, prerequisites and loads. @param {string} configFile */
export const runLogFile = (configFile) => `${configFile.replace(/\.json$/i, '')}.log.json`;

/** @param {string} file */
export function readRunLog(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const MAX_LINES = 400;
export const MAX_RUNS = 5;
/** Runs that change nothing, so they'd only push the useful ones out of the log. */
const UNRECORDED = new Set(['status', 'preview']);

/**
 * Records what a run showed, step by step, in the run log beside the install record, so the
 * support file can show the step that failed and its error after the run has ended. It keeps the
 * last few runs, with secrets removed before saving; people are hashed only when the support file
 * is made. It only watches the UI; it changes nothing the user sees.
 * @param {import('./ui.js').Ui | import('./web-ui.js').WebUi} ui
 * @param {string} file  The run log.
 * @param {{ now?: () => Date }} [o]
 */
export function attachRunLog(ui, file, o = {}) {
  const now = o.now ?? (() => new Date());
  /** @type {any} */
  let run = null;
  const u = /** @type {any} */ (ui);

  function save() {
    try {
      const prev = readRunLog(file);
      const runs = Array.isArray(prev.runs) ? prev.runs.filter((/** @type {any} */ x) => !(x.startedAt === run.startedAt && x.command === run.command)) : [];
      runs.push(createRedactor({ people: false }).value(run));
      writeFileSync(file, `${JSON.stringify({ ...prev, runs: runs.slice(-MAX_RUNS) }, null, 2)}\n`);
    } catch {
      // The log is a help, never a reason for a run to stop.
    }
  }
  /** @param {Record<string, unknown>} patch */
  function savePart(patch) {
    try {
      writeFileSync(file, `${JSON.stringify({ ...readRunLog(file), ...patch }, null, 2)}\n`);
    } catch {
      // As above.
    }
  }
  /** @param {string} level @param {unknown} s */
  function add(level, s) {
    if (!run) return;
    const step = run.steps[run.steps.length - 1];
    const textOf = String(s ?? '').replace(ANSI, '').trimEnd();
    if (!textOf.trim()) return;
    step.lines.push({ level, text: textOf.slice(0, 2000) });
    if (step.lines.length > MAX_LINES) step.lines.splice(0, step.lines.length - MAX_LINES);
  }

  for (const level of ['ok', 'warn', 'fail', 'info', 'note', 'heading']) {
    const orig = u[level];
    if (typeof orig !== 'function') continue;
    u[level] = (/** @type {any[]} */ ...args) => {
      add(level, args[0]);
      return orig.apply(u, args);
    };
  }
  const step = u.step;
  u.step = (/** @type {number} */ n, /** @type {number} */ total, /** @type {string} */ title) => {
    if (run) {
      run.steps.push({ n, title: String(title ?? '').replace(ANSI, ''), lines: [] });
      save();
    }
    return step.call(u, n, total, title);
  };
  const prereqs = u.prereqs;
  u.prereqs = (/** @type {any[]} */ items) => {
    savePart({ prereqs: { at: now().toISOString(), items } });
    return prereqs.call(u, items);
  };
  const loads = u.loads;
  u.loads = (/** @type {any[]} */ cards) => {
    savePart({ loads: { at: now().toISOString(), cards } });
    return loads.call(u, cards);
  };

  return {
    /**
     * Notes who signed in, so their name is hashed wherever the log shows it. Kept on this PC only.
     * @param {{ upn?: string, displayName?: string }} user
     */
    signedIn(user) {
      savePart({ signedInAs: { upn: user.upn, displayName: user.displayName } });
    },
    /** @param {string} command */
    begin(command) {
      run = UNRECORDED.has(command) ? null : { command, startedAt: now().toISOString(), finishedAt: null, ok: null, failedStep: null, error: null, steps: [{ n: 0, title: 'Start', lines: [] }] };
      if (run) save();
    },
    /** @param {boolean} ok @param {unknown} [err] */
    end(ok, err) {
      if (!run) return;
      run.finishedAt = now().toISOString();
      run.ok = ok;
      const message = err === undefined || err === null ? null : String(/** @type {any} */ (err)?.message ?? err);
      if (message) {
        run.error = message.slice(0, 4000);
        add('fail', message);
      }
      if (!ok) {
        const failed = [...run.steps].reverse().find((s) => s.lines.some((/** @type {any} */ l) => l.level === 'fail'));
        const at = failed ?? run.steps[run.steps.length - 1];
        run.failedStep = { n: at.n, title: at.title };
        if (!run.error) run.error = [...at.lines].reverse().find((/** @type {any} */ l) => l.level === 'fail')?.text ?? null;
      }
      save();
      run = null;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Logs.

const LOG_RULES = {
  http429: /\b429\b|too ?many ?requests|throttl/i,
  http401: /\b401\b|unauthori[sz]ed|invalid_client|AADSTS\d+/i,
  http403: /\b403\b|forbidden|Authorization_RequestDenied|insufficient privileges/i,
  timeouts: /timed? ?out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|TaskCanceled/i,
};
const WINDOW_LINE = /==>\s*Window\s+\d+\s+of\s+\d+/i;
const ERROR_LINE = /\bERROR\b|\berror:|exception|\bfailed\b|exit code [1-9]/i;

/**
 * Counts the throttling, sign-in, permission and timeout lines in a log, and the time windows it
 * worked through, with its first error.
 * @param {string} text
 * @param {Redactor} redact
 */
export function summariseLog(text, redact) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = { lines: lines.length, http429: 0, http401: 0, http403: 0, timeouts: 0, windows: 0, firstError: /** @type {string | null} */ (null) };
  for (const line of lines) {
    for (const [k, re] of Object.entries(LOG_RULES)) if (re.test(line)) out[/** @type {keyof typeof LOG_RULES} */ (k)]++;
    if (WINDOW_LINE.test(line)) out.windows++;
    if (out.firstError === null && ERROR_LINE.test(line)) out.firstError = redact.text(line.trim()).slice(0, 500);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Collecting.

/** @param {string} reason */
export const notCollected = (reason) => ({ notCollected: reason });

/** @param {string} file */
function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The newest files in a folder matching a pattern. @param {string} dir @param {RegExp} re @param {number} n */
function newest(dir, re, n) {
  try {
    return readdirSync(dir)
      .filter((f) => re.test(f))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, n)
      .map((x) => join(dir, x.f));
  } catch {
    return [];
  }
}

/**
 * Rows per CSV under a folder, counted by line breaks. The rows are never read into the file.
 * @param {string} dir
 * @returns {Record<string, number>}
 */
export function csvRowCounts(dir) {
  /** @type {Record<string, number>} */
  const out = {};
  /** @param {string} d @param {string} rel @param {number} depth */
  const walk = (d, rel, depth) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const name = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth < 3) walk(join(d, e.name), name, depth + 1);
      else if (e.isFile() && /\.csv$/i.test(e.name)) {
        try {
          const buf = readFileSync(join(d, e.name));
          let lines = 0;
          for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lines++;
          if (buf.length && buf[buf.length - 1] !== 10) lines++;
          out[name] = Math.max(0, lines - 1);
        } catch {
          // Locked by a running refresh: leave it out.
        }
      }
    }
  };
  walk(dir, '', 0);
  return out;
}

/**
 * What a signed-in installer can add: run statuses, row counts and prerequisites, live.
 * @typedef {object} Live
 * @property {any} [api]
 * @property {any} [user]
 * @property {any[] | null} [prereqs]  A prerequisites check already made for this sign-in.
 * @property {() => Promise<any[]>} [checkPrereqs]
 */

/**
 * Recent Fabric pipeline, notebook and model runs, with the error each failed one gave.
 * @param {any} api
 * @param {import('./config.js').InstallConfig} config
 */
async function fabricRuns(api, config) {
  const f = config.fabric;
  const ws = /** @type {string} */ (f.workspaceId);
  /** @type {any} */
  const out = { collectedAt: new Date().toISOString() };
  const job = (/** @type {any} */ j) => ({
    id: j.id,
    status: j.status,
    invokeType: j.invokeType,
    startTimeUtc: j.startTimeUtc,
    endTimeUtc: j.endTimeUtc,
    error: j.failureReason?.message ? String(j.failureReason.message).slice(0, 2000) : undefined,
    errorCode: j.failureReason?.errorCode,
  });
  const byStart = (/** @type {any} */ a, /** @type {any} */ b) => String(b.startTimeUtc ?? '').localeCompare(String(a.startTimeUtc ?? ''));
  if (f.pipelineId) {
    try {
      const jobs = (await api.fabric.listJobs(ws, f.pipelineId)).sort(byStart).slice(0, 5);
      out.pipeline = { name: f.pipelineName, id: f.pipelineId, runs: jobs.map(job) };
      const latest = jobs.find((j) => j.status === 'Failed' || j.status === 'Completed' || j.status === 'Cancelled');
      if (latest) {
        try {
          const start = new Date(Date.parse(latest.startTimeUtc ?? '') || Date.now());
          const end = new Date(Date.parse(latest.endTimeUtc ?? '') || Date.now());
          const acts = await api.fabric.queryActivityRuns(ws, latest.id, new Date(start.getTime() - 3_600_000), new Date(end.getTime() + 3_600_000));
          out.pipeline.latestActivities = acts.map((/** @type {any} */ a) => ({
            activity: a.activityName,
            status: a.status,
            start: a.activityRunStart,
            end: a.activityRunEnd,
            durationMs: a.durationInMs,
            error: a.error?.message ? String(a.error.message).slice(0, 2000) : undefined,
            errorCode: a.error?.errorCode || undefined,
          }));
        } catch (err) {
          out.pipeline.latestActivities = notCollected(`Fabric didn't return the activity runs: ${String(/** @type {any} */ (err)?.message ?? err).slice(0, 300)}`);
        }
      }
    } catch (err) {
      out.pipeline = notCollected(`Fabric didn't return the pipeline's runs: ${String(/** @type {any} */ (err)?.message ?? err).slice(0, 300)}`);
    }
  } else out.pipeline = notCollected('No pipeline is installed yet.');
  /** @type {Record<string, unknown>} */
  const notebooks = {};
  for (const [key, id] of Object.entries(f.notebooks ?? {})) {
    if (!id) continue;
    try {
      const jobs = (await api.fabric.listJobs(ws, id)).sort(byStart).slice(0, 3);
      notebooks[key] = { name: f.notebookNames?.[/** @type {keyof typeof f.notebookNames} */ (key)], id, runs: jobs.map(job) };
    } catch (err) {
      notebooks[key] = notCollected(String(/** @type {any} */ (err)?.message ?? err).slice(0, 300));
    }
  }
  out.notebooks = notebooks;
  const sm = config.semanticModel;
  if (sm?.id) {
    try {
      const refreshes = await api.powerBi.refreshes(ws, sm.id, 3);
      out.modelRefreshes = refreshes.map((/** @type {any} */ r) => ({
        status: r.extendedStatus ?? r.status,
        refreshType: r.refreshType,
        startTime: r.startTime,
        endTime: r.endTime,
        error: r.serviceExceptionJson ? String(r.serviceExceptionJson).slice(0, 2000) : undefined,
      }));
    } catch (err) {
      out.modelRefreshes = notCollected(String(/** @type {any} */ (err)?.message ?? err).slice(0, 300));
    }
  }
  return out;
}

/**
 * Row counts from the data check's summary in the Lakehouse.
 * @param {any} api
 * @param {import('./config.js').InstallConfig} config
 */
async function fabricRowCounts(api, config) {
  const f = config.fabric;
  if (!f.workspaceId || !f.lakehouseId) return notCollected('No Lakehouse is installed yet.');
  const summary = await api.oneLake.readJson(f.workspaceId, f.lakehouseId, DATA_CHECK_FILE).catch(() => null);
  if (!summary?.tables) return notCollected('The data check hasn\'t left a summary yet. Run the "check" command, then create the support file again.');
  /** @type {Record<string, number | null>} */
  const out = {};
  for (const [k, t] of Object.entries(summary.tables)) out[k] = typeof (/** @type {any} */ (t))?.rows === 'number' ? /** @type {any} */ (t).rows : null;
  return out;
}

/**
 * Gathers the support file's contents. Works without a sign-in, from the files on this PC; with one,
 * it adds the live run statuses, row counts and prerequisites.
 * @param {{
 *   configFile: string,
 *   version: string,
 *   now?: Date,
 *   live?: Live | null,
 *   paxHost?: { root: string },
 *   logs?: string[],
 *   offline?: string,
 *   madeBy?: string,
 *   redactor?: Redactor,
 * }} o  logs: collector or PAX log files to summarise (--log). offline: why there's no sign-in.
 * @returns {Promise<{ name: string, text: string }[]>}
 */
export async function collectSupportBundle(o) {
  const now = o.now ?? new Date();
  const r = o.redactor ?? createRedactor();
  const record = readJsonFile(o.configFile);
  /** @type {import('./config.js').InstallConfig | undefined} */
  const config = record && typeof record === 'object' ? record : undefined;
  const diag = readRunLog(runLogFile(o.configFile));
  /** @type {any[]} */
  const runLog = Array.isArray(diag.runs) ? diag.runs : [];
  const lastRun = runLog[runLog.length - 1];
  const route = config?.target === 'pax' ? 'pax' : 'fabric';
  const live = o.live?.api ? o.live : null;
  const notSignedIn = o.offline ?? 'Not signed in: the support file was made from the files on this PC. Run it with --use-az (or from the installer\'s page after signing in) to add live run statuses and row counts.';

  // Learn every person first so their names are hashed wherever they turn up.
  r.learnFrom(config);
  r.learnFrom(diag);
  if (live?.user) r.learnFrom({ user: live.user });

  /** @type {Record<string, unknown>} */
  const files = {};

  files['settings.json'] = config ? r.value(config) : notCollected(existsSync(o.configFile) ? `The install record at ${basename(o.configFile)} couldn't be read.` : `No install record at ${basename(o.configFile)}. Pass --config with its path, or run from the folder that holds it.`);

  files['last-run.json'] = lastRun
    ? r.value({ ...lastRun, earlierRuns: runLog.slice(0, -1).reverse().map((x) => ({ command: x.command, startedAt: x.startedAt, ok: x.ok, failedStep: x.failedStep, error: x.error })) })
    : notCollected('No installer run has been recorded on this PC yet. Run the installer once, then create the support file again.');

  // Prerequisites: a check made for this sign-in, a fresh one, or the last one saved.
  /** @type {unknown} */
  let prereqs;
  if (live?.prereqs) prereqs = { at: now.toISOString(), live: true, items: live.prereqs };
  else if (live?.checkPrereqs) {
    try {
      prereqs = { at: now.toISOString(), live: true, items: await live.checkPrereqs() };
    } catch (err) {
      prereqs = undefined;
      if (!diag.prereqs) prereqs = notCollected(`The prerequisites check failed: ${String(/** @type {any} */ (err)?.message ?? err).slice(0, 300)}`);
    }
  }
  prereqs ??= diag.prereqs ? { ...diag.prereqs, live: false } : notCollected('No prerequisites check has been recorded on this PC. Run the "prereqs" command, then create the support file again.');
  files['prereqs.json'] = r.value(prereqs);

  /** @type {Record<string, unknown>} */
  const logs = {};
  if (lastRun) {
    const lines = lastRun.steps?.flatMap((/** @type {any} */ s) => s.lines?.map((/** @type {any} */ l) => l.text) ?? []) ?? [];
    logs['installer-last-run'] = summariseLog(lines.join('\n'), r);
  }
  for (const f of o.logs ?? []) {
    try {
      logs[basename(f)] = summariseLog(readFileSync(f, 'utf8'), r);
    } catch {
      logs[basename(f)] = notCollected(`Couldn't read ${basename(f)}.`);
    }
  }

  if (route === 'pax') {
    const host = o.paxHost ?? defaultPaxHost();
    const p = paxPaths(/** @type {any} */ (host));
    const state = readJsonFile(p.state);
    files['runs.json'] = r.value({
      firstRun: config?.pax?.firstRun ?? null,
      refreshState: state ?? notCollected(`No refresh state at ${p.state} on this PC.`),
      scheduledTask: config?.pax?.task ?? null,
      lastLoads: diag.loads ?? null,
    });
    const counts = existsSync(p.data) ? csvRowCounts(p.data) : null;
    files['row-counts.json'] = counts && Object.keys(counts).length ? counts : notCollected(`No CSV files under ${p.data} on this PC. The refresh may not have run here yet.`);
    for (const f of newest(p.logs, /\.log$/i, 5)) {
      try {
        logs[basename(f)] = summariseLog(readFileSync(f, 'utf8'), r);
      } catch {
        logs[basename(f)] = notCollected('The log couldn\'t be read.');
      }
    }
    if (!newest(p.logs, /\.log$/i, 1).length) logs.refresh = notCollected(`No refresh logs under ${p.logs} on this PC.`);
  } else if (!config?.fabric?.workspaceId) {
    files['runs.json'] = notCollected('Nothing is installed in Fabric yet.');
    files['row-counts.json'] = notCollected('Nothing is installed in Fabric yet.');
  } else if (live) {
    let runs;
    try {
      runs = await fabricRuns(live.api, /** @type {any} */ (config));
    } catch (err) {
      runs = notCollected(`Fabric didn't return the runs: ${String(/** @type {any} */ (err)?.message ?? err).slice(0, 300)}`);
    }
    files['runs.json'] = r.value({ ...runs, firstRun: config.firstRun ?? null, lastLoads: diag.loads ?? null });
    let counts;
    try {
      counts = await fabricRowCounts(live.api, /** @type {any} */ (config));
    } catch (err) {
      counts = notCollected(String(/** @type {any} */ (err)?.message ?? err).slice(0, 300));
    }
    files['row-counts.json'] = counts;
    const errors = [];
    const rr = /** @type {any} */ (runs);
    for (const j of rr?.pipeline?.runs ?? []) if (j.error) errors.push(j.error);
    for (const a of Array.isArray(rr?.pipeline?.latestActivities) ? rr.pipeline.latestActivities : []) if (a.error) errors.push(`${a.activity}: ${a.error}`);
    for (const nb of Object.values(rr?.notebooks ?? {})) for (const j of /** @type {any} */ (nb)?.runs ?? []) if (j.error) errors.push(j.error);
    logs['fabric-run-errors'] = summariseLog(errors.join('\n'), r);
  } else {
    files['runs.json'] = r.value({ ...notCollected(notSignedIn), firstRun: config.firstRun ?? null, lastLoads: diag.loads ?? null });
    files['row-counts.json'] = notCollected(notSignedIn);
  }
  files['logs-summary.json'] = Object.keys(logs).length ? logs : notCollected('No logs were found on this PC.');

  /** @type {{ name: string, text: string }[]} */
  const body = Object.entries(files).map(([name, v]) => ({ name, text: `${JSON.stringify(v, null, 2)}\n` }));
  const manifest = {
    product: PRODUCT.id,
    installerVersion: o.version,
    madeBy: o.madeBy ?? `installer ${o.version}`,
    createdAt: now.toISOString(),
    route,
    signedIn: !!live,
    files: [{ name: 'README.txt' }, ...body.map((f) => ({ name: f.name, bytes: Buffer.byteLength(f.text) }))],
    redaction: { rules: REDACTION_RULES, counts: { ...r.counts } },
  };
  const readme = readmeText({ version: o.version, createdAt: now.toISOString(), routeName: ROUTE_NAMES[route], signedIn: !!live, counts: r.counts });
  manifest.files[0] = { name: 'README.txt', bytes: Buffer.byteLength(readme) };
  const all = [{ name: 'README.txt', text: readme }, { name: 'manifest.json', text: `${JSON.stringify(manifest, null, 2)}\n` }, ...body];
  return SUPPORT_FILES.map((name) => /** @type {{ name: string, text: string }} */ (all.find((f) => f.name === name)));
}

/** @param {{ version: string, createdAt: string, routeName: string, signedIn: boolean, counts: { secrets: number, emails: number, names: number } }} o */
function readmeText(o) {
  return [
    `${PRODUCT.name} support file`,
    `Made by the ${PRODUCT.installer} ${o.version} at ${o.createdAt} (UTC). Route: ${o.routeName}.`,
    o.signedIn ? 'Made while signed in, so it has live run statuses and row counts.' : 'Made without signing in, from the files on this PC. Live run statuses and row counts say "notCollected".',
    '',
    'What\'s inside (all plain text, so you can read every file before you send it):',
    '  manifest.json      the installer version, route, the files and what was removed',
    '  settings.json      the install record (IDs and choices), with secrets removed',
    '  last-run.json      the last installer run, step by step, with the step that failed and its error, and a line for each earlier run',
    '  prereqs.json       the prerequisite and permission checks',
    '  runs.json          recent pipeline, notebook and refresh runs, with their error messages',
    '  row-counts.json    rows per table (counts only: a 0 shows a source that loaded nothing)',
    '  logs-summary.json  per log: HTTP 429, 401 and 403 lines, timeouts, time windows, first error',
    '',
    'What was removed:',
    ...REDACTION_RULES.map((rule) => `  - ${rule}`),
    `  This file: ${o.counts.secrets} secret value(s) removed, ${o.counts.emails} email address(es) and ${o.counts.names} name(s) hashed.`,
    '',
    'A piece that couldn\'t be collected says why, as { "notCollected": "<reason>" }.',
    '',
  ].join('\r\n');
}

// ---------------------------------------------------------------------------------------------
// The zip.

/**
 * A zip of UTF-8 text files, deflated.
 * @param {{ name: string, text: string }[]} entries
 * @param {Date} [when]
 * @returns {Buffer}
 */
export function writeZip(entries, when = new Date()) {
  const dosTime = ((when.getHours() & 31) << 11) | ((when.getMinutes() & 63) << 5) | ((when.getSeconds() / 2) & 31);
  const dosDate = (((when.getFullYear() - 1980) & 127) << 9) | (((when.getMonth() + 1) & 15) << 5) | (when.getDate() & 31);
  /** @type {Buffer[]} */
  const parts = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.from(e.text, 'utf8');
    const data = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(dosTime, 12);
    dir.writeUInt16LE(dosDate, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    central.push(dir, name);
    offset += local.length + name.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

/** `valuelens-support-<yyyyMMdd-HHmmss>.zip`, in UTC. @param {Date} [now] */
export function supportFileName(now = new Date()) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `${PRODUCT.id}-support-${stamp}.zip`;
}

/**
 * Collects the support file and writes it to a folder.
 * @param {Parameters<typeof collectSupportBundle>[0] & { outDir: string }} o
 */
export async function createSupportBundle(o) {
  const now = o.now ?? new Date();
  const files = await collectSupportBundle({ ...o, now });
  const zip = writeZip(files, now);
  const dir = resolve(o.outDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, supportFileName(now));
  writeFileSync(path, zip);
  return { path, fileName: basename(path), files, zip };
}
