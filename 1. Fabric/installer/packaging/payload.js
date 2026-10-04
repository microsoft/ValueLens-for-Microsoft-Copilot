// @ts-check
/**
 * What goes into AnalyticsHubInstaller.exe, kept apart from the build so it can be tested.
 * The payload unpacks to:
 *   node/node.exe            Node.js, which runs everything below
 *   f/installer/             the installer, with its production dependencies
 *   f/<templates>            the notebooks, pipeline and semantic model templates it deploys
 *   f/Fabric App/            the app, already built, with only the tools that deploy it
 * `f` stands in for `1. Fabric`, which keeps paths short when unpacked under the user's profile.
 */
import { posix } from 'node:path';
import { NOTEBOOKS } from '../src/catalog.js';
import { APP_DIR, PIPELINE_TEMPLATE } from '../src/sources.js';
import { PREBUILT_STATIC } from '../src/steps/app.js';
import { AGENT_EVALUATOR_TEMPLATE, CONSUMPTION_TEMPLATE, MODEL_TEMPLATE } from '../src/transform/model.js';

export const EXE_NAME = 'AnalyticsHubInstaller.exe';
/** The `1. Fabric` folder inside the payload. */
export const SOURCE_ROOT = 'f';
/** The app folder inside the payload. */
export const APP_PAYLOAD_DIR = posix.join(SOURCE_ROOT, APP_DIR);
/**
 * Longest path allowed inside the payload. It unpacks to
 * `%LOCALAPPDATA%\AnalyticsHub\<version>-<hash>\`, about 70 characters for a typical profile, so
 * the deepest dependencies end up past Windows' 260-character limit. The launcher and Node.js
 * both use extended-length paths, which don't have that limit; this catches a dependency tree
 * that suddenly nests much deeper.
 */
export const MAX_PAYLOAD_PATH = 200;
/**
 * Longest path allowed for a native binary. Windows loads DLLs and Node.js addons only from
 * paths under 260 characters, so these must fit even under a long user name.
 */
export const MAX_NATIVE_PATH = 120;
/** Rewritten in the lock files so CI installs from the public registry, not Microsoft's mirror of it. */
export const MIRROR_REGISTRY = 'https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/';
export const PUBLIC_REGISTRY = 'https://registry.npmjs.org/';

/** @param {string} p */
const slash = (p) => p.replaceAll('\\', '/');

/**
 * The files under `1. Fabric` that `loadSources` reads, relative to it.
 * @returns {string[]}
 */
export function sourceFiles() {
  return [
    PIPELINE_TEMPLATE,
    ...NOTEBOOKS.map((nb) => posix.join(nb.dir ?? 'notebooks', nb.file)),
    MODEL_TEMPLATE,
    CONSUMPTION_TEMPLATE,
    AGENT_EVALUATOR_TEMPLATE,
  ].map(slash);
}

/**
 * Whether a tracked installer file ships, given its path relative to the installer folder.
 * @param {string} rel
 */
export function installerFile(rel) {
  return /^(bin|src)\//.test(rel) || ['package.json', 'package-lock.json', 'README.md'].includes(rel);
}

/**
 * Whether a tracked app file ships with the prebuilt app, given its path relative to the app
 * folder. `rayfin up` compiles the data schema with `rayfin/tsconfig.json`, which extends the
 * app's `tsconfig.json`. `rayfin.yml` ships rewritten by {@link prebuiltRayfinYml}.
 * @param {string} rel
 */
export function appFile(rel) {
  return ['tsconfig.json', 'LICENSE', 'rayfin/tsconfig.json'].includes(rel) || /^rayfin\/data\/[^/]+\.ts$/.test(rel);
}

/**
 * Points static hosting at the built app and drops its build command, so `rayfin up` deploys the
 * files as they are.
 * @param {string} yml  The app's `rayfin/rayfin.yml`.
 */
export function prebuiltRayfinYml(yml) {
  const lines = yml.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^ {2}staticHosting:\s*$/.test(l));
  if (start < 0) throw new Error('rayfin.yml has no staticHosting section.');
  let end = lines.findIndex((l, i) => i > start && /^ {0,2}\S/.test(l));
  if (end < 0) end = lines.length;
  const section = lines.slice(start + 1, end);
  const folder = section.findIndex((l) => /^ {4}folder:/.test(l));
  if (folder < 0) throw new Error('rayfin.yml has no staticHosting folder.');
  section[folder] = `    folder: ${PREBUILT_STATIC}`;
  const kept = section.filter((l) => !/^ {4}buildCommand:/.test(l));
  return [...lines.slice(0, start + 1), ...kept, ...lines.slice(end)].join('\n');
}

/**
 * `package.json` for the prebuilt app: just the tools `rayfin up` needs. Listing vite lets
 * Rayfin recognise the app without installing it.
 * @param {{ rayfin: string, vite: string, version: string }} v
 */
export function appPackageJson(v) {
  return {
    name: 'analytics-hub-app',
    version: v.version,
    private: true,
    type: 'module',
    dependencies: {
      '@microsoft/rayfin-cli': v.rayfin,
      '@microsoft/rayfin-core': v.rayfin,
    },
    devDependencies: { vite: v.vite },
  };
}

/** `src/fabric.generated.ts` for the prebuilt build: no models, so the app reads them at runtime. */
export const EMPTY_GENERATED = `// Built for the installer download. The app reads its semantic models from fabric.config.json.
export const fabricConfig = {
  semanticModels: {},
} as const;
`;

/**
 * Names the payload by version and content, so a new download unpacks afresh.
 * @param {string} version
 * @param {string} sha256  Hex digest of the payload zip.
 */
export function payloadId(version, sha256) {
  return `${version}-${sha256.slice(0, 10)}`;
}

/**
 * The `x.y.z.0` form Windows file versions take.
 * @param {string} version
 */
export function fileVersion(version) {
  const parts = version.split(/[.+-]/).slice(0, 3).map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (parts.length < 3 || parts.some((n) => !(n >= 0 && n <= 65534))) throw new Error(`Can't make a file version from "${version}".`);
  return `${parts.join('.')}.0`;
}

/**
 * Whether an installed package's file can be left out of the payload. Source maps are a fifth of
 * the download, and nothing reads them when the installer runs.
 * @param {string} rel  Relative to the payload root.
 */
export function prunable(rel) {
  return /(^|\/)node_modules\/.+\.map$/i.test(rel);
}

/**
 * The payload paths too long to unpack and run safely.
 * @param {string[]} files  Relative to the payload root.
 * @param {{ max?: number, native?: number }} [limits]
 */
export function tooLong(files, { max = MAX_PAYLOAD_PATH, native = MAX_NATIVE_PATH } = {}) {
  return files.filter((f) => f.length > (/\.(node|dll|exe)$/i.test(f) ? native : max));
}

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * GUIDs in a developer's local settings, such as their workspace and model IDs.
 * @param {string[]} texts
 * @param {Iterable<string>} [allowed]  IDs that are fine to ship, such as those the repo already holds.
 */
export function localIds(texts, allowed = []) {
  const skip = new Set([...allowed].map((a) => a.toLowerCase()));
  /** @type {Set<string>} */
  const ids = new Set();
  for (const t of texts) for (const m of t.matchAll(GUID)) if (!skip.has(m[0].toLowerCase())) ids.add(m[0].toLowerCase());
  return ids;
}

/**
 * The local IDs that turn up in a shipped file.
 * @param {string} text
 * @param {Set<string>} ids
 */
export function leakedIds(text, ids) {
  return [...new Set([...text.matchAll(GUID)].map((m) => m[0].toLowerCase()))].filter((id) => ids.has(id));
}

/**
 * Points a lock file at the public npm registry.
 * @param {string} lock
 */
export function publicRegistry(lock) {
  return lock.replaceAll(MIRROR_REGISTRY, PUBLIC_REGISTRY);
}
