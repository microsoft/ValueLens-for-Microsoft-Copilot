// @ts-check
/**
 * `upload` on the PAX route: puts files into the SharePoint folder the scheduled refresh writes
 * to, or a subfolder of it, as the PAX app. It uses the app's secret in Credential Manager and
 * its Sites.Selected grant, the same as the refresh.
 *
 * Every name comes from product.js, so another installer can copy this file as it is.
 */
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { PRODUCT } from '../../product.js';
import { paxHostOf, paxPaths, refreshConfig, uploadToFolder, writeRefreshConfig } from './local.js';
import { describeFolder } from './site.js';

/** @typedef {import('../../install.js').Ctx} Ctx */

/**
 * A subfolder's path, checked the way refresh.ps1 checks it: forward slashes, no empty, `.` or
 * `..` parts, none of the characters SharePoint refuses in names, and no name ending in a full stop.
 * @param {string} text
 * @returns {string}  The tidied path, or '' for the folder itself.
 */
export function remoteFolderPath(text) {
  const parts = text.replace(/\\/g, '/').split('/').map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    if (p === '.' || p === '..') throw new Error(`"${text}" isn't a subfolder of the SharePoint folder.`);
    if (/["*:<>?|\u0000-\u001f]/.test(p) || p.endsWith('.')) throw new Error(`"${p}" isn't a name SharePoint allows for a folder.`);
  }
  return parts.join('/');
}

/**
 * Paths typed at the prompt: separated by semicolons, each with or without quotes.
 * @param {string} text
 */
export const splitPaths = (text) =>
  text.split(';').map((p) => p.trim().replace(/^"(.*)"$/, '$1').trim()).filter(Boolean);

/**
 * Uploads files to the SharePoint folder, replacing any of the same name. With no files named, it
 * asks for them, so the browser can run it too.
 * @param {Ctx} ctx
 * @param {{ files: string[], remoteFolder?: string }} o
 * @returns {Promise<boolean>}  Whether every file went up.
 */
export async function paxUpload(ctx, o) {
  const { ui, config } = ctx;
  const sp = config.sharePoint;
  if (!sp || !config.app.appId) throw new Error(`${PRODUCT.name} isn't set up on this PC yet, so there's no SharePoint folder to upload to. Run install first.`);
  const sub = o.remoteFolder ? remoteFolderPath(o.remoteFolder) : '';
  let files = o.files;
  if (!files.length) {
    if (ui.yes) throw new Error('Name the files to upload.');
    ui.heading('Upload files');
    files = splitPaths(await ui.input(`Which files go in ${describeFolder(sp)}${sub ? `, in ${sub}` : ''}? Give the full path of each on this PC, separated by semicolons.`, {
      validate: (v) => (splitPaths(v).length ? true : 'Give at least one file.'),
    }));
  }

  const host = paxHostOf(ctx);
  // The upload reads the folder and the secret's name from refresh.json. A record copied from
  // another PC has none yet.
  if (!existsSync(paxPaths(host).config)) writeRefreshConfig(host, refreshConfig(config, { configFile: ctx.configFile }));

  const where = `${describeFolder(sp)}${sub ? `, in ${sub}` : ''}`;
  let failed = 0;
  for (const given of files) {
    const file = resolve(given);
    if (!existsSync(file) || !statSync(file).isFile()) {
      ui.fail(`${given}: no such file`);
      failed++;
      continue;
    }
    try {
      await uploadToFolder(host, file, sub ? { remoteFolder: sub } : {});
      ui.ok(`Uploaded ${basename(file)} to ${where}`);
    } catch (err) {
      ui.fail(/** @type {Error} */ (err).message);
      failed++;
    }
  }
  return failed === 0;
}
