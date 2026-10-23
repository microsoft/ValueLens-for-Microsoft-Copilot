// @ts-check
/** Teams package hook for the Azure target. teams/ is vendored from 'azure/teams' (drift-checked by tests/test_azure_scaffold.py). */

/** The package's manifest version for an installer version: Teams takes x.y.z only. @param {string} version */
export const manifestVersion = (version) => version.replace(/[-+].*$/, '');

/**
 * Builds the package and writes it. Returns the zip and the manifest's version too, for publishing it.
 * @param {{ clientId: string, fqdn: string, appIdUri: string, version: string, outFile: string }} o
 * @returns {Promise<{ skipped: true, reason: string } | { skipped: false, path: string, zip: Uint8Array, version: string }>}
 */
export async function writeTeamsPackage(o) {
  let mod;
  try {
    // @ts-ignore Optional vendored file.
    mod = await import('./teams/build-package.mjs');
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ERR_MODULE_NOT_FOUND') return { skipped: true, reason: 'src/azure/teams/build-package.mjs is not vendored yet.' };
    throw err;
  }
  if (typeof mod.buildTeamsPackage !== 'function') throw new Error('src/azure/teams/build-package.mjs must export buildTeamsPackage().');
  const version = manifestVersion(o.version);
  const zip = await mod.buildTeamsPackage({ clientId: o.clientId, fqdn: o.fqdn, appIdUri: o.appIdUri, version });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(o.outFile, zip);
  return { skipped: false, path: o.outFile, zip, version };
}
