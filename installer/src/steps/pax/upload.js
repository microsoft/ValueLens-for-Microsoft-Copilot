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
 * A subfolder's path, checked: forward slashes, no empty, `.` or `..` parts, and none of the
 * characters SharePoint refuses in names.
 * @param {string} text
 * @returns {string}  The tidied path, or '' for the folder itself.
 */
export function remoteFolderPath(text) {
  const parts = text.replace(/\\/g, '/').split('/').map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    if (p === '.' || p === '..') throw new Error(`"${text}" isn't a subfolder of the SharePoint folder.`);
    if (/["*:<>?|#%]/.test(p) || /[. ]$/.test(p)) throw new Error(`"${p}" isn't a name SharePoint allows for a folder.`);
  }
  return parts.join('/');
}

/**
 * Uploads files to the SharePoint folder, replacing any of the same name.
 * @param {Ctx} ctx
 * @param {{ files: string[], remoteFolder?: string }} o
 * @returns {Promise<boolean>}  Whether every file went up.
 */
export async function paxUpload(ctx, o) {
  const { ui, config } = ctx;
  const sp = config.sharePoint;
  if (!sp || !config.app.appId) throw new Error(`${PRODUCT.name} isn't set up on this PC yet, so there's no SharePoint folder to upload to. Run install first.`);
  if (!o.files.length) throw new Error('Name the files to upload.');
  const sub = o.remoteFolder ? remoteFolderPath(o.remoteFolder) : '';

  const host = paxHostOf(ctx);
  // The upload reads the folder and the secret's name from refresh.json. A record copied from
  // another PC has none yet.
  if (!existsSync(paxPaths(host).config)) writeRefreshConfig(host, refreshConfig(config, { configFile: ctx.configFile }));

  const where = `${describeFolder(sp)}${sub ? `, in ${sub}` : ''}`;
  let failed = 0;
  for (const given of o.files) {
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
