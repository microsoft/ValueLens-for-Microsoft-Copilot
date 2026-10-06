// @ts-check
/** Teams package hook for the Azure target. teams/ is vendored from '5. Azure/teams' (drift-checked by tests/test_azure_scaffold.py). */

/**
 * @param {{ clientId: string, fqdn: string, appIdUri: string, version: string, outFile: string }} o
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
  const zip = await mod.buildTeamsPackage({ clientId: o.clientId, fqdn: o.fqdn, appIdUri: o.appIdUri, version: o.version.replace(/[-+].*$/, '') });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(o.outFile, zip);
  return { skipped: false, path: o.outFile };
}
