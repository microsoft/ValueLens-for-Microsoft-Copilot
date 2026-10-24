// @ts-check
/**
 * The PAX route's SharePoint folder: reading the address the user pastes, giving the app write
 * access to that one site (Sites.Selected), and checking the app can reach the folder the way the
 * scheduled task will. Product names come only from product.js, so other installers can copy it.
 */
import { HttpError } from '../../http.js';
import { PRODUCT } from '../../product.js';
import { appName } from '../../target.js';
import { checkFolder } from './local.js';

/** @typedef {import('../../install.js').Ctx} Ctx */
/** @typedef {import('../../config.js').InstallConfig} InstallConfig */
/** @typedef {import('../../config.js').SharePointConfig} SharePointConfig */
/** @typedef {import('../../config.js').RetiredGrant} RetiredGrant */
/** @typedef {import('./local.js').FolderCheck} FolderCheck */
/** @typedef {import('./local.js').PaxHost} PaxHost */

/**
 * A folder the user pasted, in the forms the install record keeps.
 * @typedef {Pick<SharePointConfig, 'folderUrl' | 'siteUrl' | 'sitePath' | 'library' | 'folderPath'>} SharePointFolder
 */

export const EXAMPLE_FOLDER = `https://contoso.sharepoint.com/sites/Analytics/Shared Documents/${PRODUCT.name}`;
/** Who can give an app access to one site. */
export const SITE_ADMIN = 'A SharePoint Administrator or Global Administrator';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const HOST = /^[a-z0-9-]+\.sharepoint\.com$/;
const ONEDRIVE = /-my\.sharepoint\.com$/;
const FILE_NAME = /\.(csv|xlsx?|xlsm|pbi[xt]|docx?|pptx?|pdf|txt|json|zip)$/i;
const BAD_NAME = /["*:<>?\\|\u0000-\u001f]/;
const SIGN_IN_FAILED = /^Couldn't sign in to Microsoft Graph as the app/;
/** While a new secret or grant reaches every server, the check runs again every 15 seconds for about two minutes. */
const SETTLE_TRIES = 9;
const SETTLE_MS = 15_000;

/**
 * Decodes one part of a pasted address. A typed % that isn't an escape, as in "100% Done", stays
 * as it is: the browser escapes the space after it but not the %.
 * @param {string} s
 */
const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  }
};

/**
 * A folder name the scheduled refresh accepts (refresh.ps1's Test-FileName): no leading or
 * trailing spaces, and no full stop at the end.
 * @param {string} s
 */
export const tidyFolderName = (s) => s === s.trim() && !s.endsWith('.');

/** @param {string} why */
const notAFolder = (why) =>
  new Error(`${why} Open the folder in its document library, then copy the address from the browser's address bar, like ${EXAMPLE_FOLDER}.`);

/**
 * Reads a SharePoint folder's address as it's pasted from the browser: a folder in a library, a
 * library's AllItems.aspx view, either with ?id=, or a "people with existing access" link to a
 * folder. Throws an error that says what to paste instead. Subsites aren't supported.
 * @param {string} text
 * @returns {SharePointFolder}
 */
export function parseSharePointFolder(text) {
  let raw = String(text ?? '').trim().replace(/^["'<]+|["'>]+$/g, '').trim();
  if (!raw) throw new Error(`Paste the folder's address, like ${EXAMPLE_FOLDER}.`);
  if (/^[a-z0-9-]+\.sharepoint\.com\//i.test(raw)) raw = `https://${raw}`;
  /** @type {URL} */
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw notAFolder("That isn't a web address.");
  }
  const host = url.hostname.toLowerCase();
  if (ONEDRIVE.test(host)) {
    throw new Error("That's a OneDrive folder. Use a folder in a SharePoint site's document library, so the refresh doesn't depend on one person's OneDrive.");
  }
  if (!HOST.test(host)) throw new Error('Use a folder on SharePoint Online, at https://<tenant>.sharepoint.com.');
  if (url.protocol !== 'https:') throw new Error("Use the folder's https:// address.");

  let segments = url.pathname.split('/').filter(Boolean).map(decode);
  if (segments[0]?.startsWith(':')) {
    if (segments[0] === ':f:' && segments[1] === 'r') segments = segments.slice(2);
    else if (segments[1] === 'r') throw new Error("That's a link to a file. Paste the address of the folder it's in.");
    else throw new Error("That's a sharing link. Open it, then copy the folder's address from the browser's address bar.");
  }
  // A library view names the folder it shows in ?id= (or the older ?RootFolder=).
  const shown = url.searchParams.get('id') ?? url.searchParams.get('RootFolder');
  if (shown) segments = shown.split('/').filter(Boolean);
  if (segments.some((s) => /^_(layouts|api|vti_bin)$/i.test(s))) throw notAFolder("That's a SharePoint page, not a folder.");
  const page = segments.findIndex((s) => /\.aspx$/i.test(s));
  if (page >= 0) {
    // Shared Documents/Forms/AllItems.aspx is the library itself.
    if (page > 0 && /^forms$/i.test(segments[page - 1])) segments = segments.slice(0, page - 1);
    else throw notAFolder("That's a page, not a folder.");
  }

  const inSite = /^(sites|teams)$/i.test(segments[0] ?? '');
  if (inSite && segments.length < 2) throw notAFolder("That isn't a site or a folder.");
  const site = segments.slice(0, inSite ? 2 : 0);
  const rest = segments.slice(site.length);
  if (!rest.length) throw notAFolder(inSite ? "That's a site, not a folder." : "That's the tenant's root site, not a folder.");
  if (/^lists$/i.test(rest[0])) throw new Error("That's a list, not a document library. Use a folder in a document library, such as Documents.");
  if (FILE_NAME.test(rest[rest.length - 1])) throw new Error("That's a file. Paste the address of the folder it's in.");
  const bad = [...site, ...rest].find((s) => BAD_NAME.test(s) || s === '.' || s === '..');
  if (bad !== undefined) throw new Error(`"${bad}" can't be part of a SharePoint folder's address. Check the address.`);
  const untidy = rest.slice(1).find((s) => !tidyFolderName(s));
  if (untidy !== undefined) throw new Error(`"${untidy}" can't be a folder's name: SharePoint doesn't allow spaces at the start or end, or a full stop at the end. Check the address.`);

  const enc = (/** @type {string[]} */ parts) => parts.map(encodeURIComponent).join('/');
  const siteUrl = site.length ? `https://${host}/${enc(site)}` : `https://${host}`;
  return {
    folderUrl: `${siteUrl}/${enc(rest)}`,
    siteUrl,
    sitePath: site.length ? `${host}:/${enc(site)}` : host,
    library: rest[0],
    folderPath: `/${rest.slice(1).join('/')}`,
  };
}

/**
 * For a prompt's validate: true, or what's wrong with the address.
 * @param {string} text
 * @returns {true | string}
 */
export function folderValidator(text) {
  try {
    parseSharePointFolder(text);
    return true;
  } catch (err) {
    return /** @type {Error} */ (err).message;
  }
}

/**
 * "Shared Documents/Reports on https://contoso.sharepoint.com/sites/Analytics".
 * @param {Pick<SharePointConfig, 'library' | 'folderPath' | 'siteUrl'>} sp
 */
export const describeFolder = (sp) => `${sp.library}${sp.folderPath === '/' ? '' : sp.folderPath} on ${sp.siteUrl}`;

/** @param {Pick<SharePointConfig, 'sitePath'>} a @param {Pick<SharePointConfig, 'sitePath'>} b */
export const sameSite = (a, b) => a.sitePath.toLowerCase() === b.sitePath.toLowerCase();

/**
 * The install record's sharePoint section for the folder the user chose. What the installer knew
 * about the site, its ID and the app's access, is kept while the site is the same. When the
 * folder moves to another site, the app's access to the old one is listed to take back.
 * @param {SharePointFolder} folder
 * @param {SharePointConfig} [previous]
 * @returns {SharePointConfig}
 */
export function folderConfig(folder, previous) {
  /** @type {SharePointConfig} */
  const next = { ...folder };
  /** @type {RetiredGrant[]} */
  const retired = (previous?.retiredGrants ?? []).filter((g) => !sameSite(g, folder));
  if (previous && sameSite(previous, folder)) {
    if (previous.siteId) next.siteId = previous.siteId;
    if (previous.granted) next.granted = true;
    if (previous.grantId) next.grantId = previous.grantId;
    if (previous.pendingAdminGrant) next.pendingAdminGrant = true;
  } else if (previous && (previous.granted || previous.grantId)) {
    retired.push({
      siteUrl: previous.siteUrl,
      sitePath: previous.sitePath,
      ...(previous.siteId ? { siteId: previous.siteId } : {}),
      ...(previous.grantId ? { grantId: previous.grantId } : {}),
    });
  }
  if (retired.length) next.retiredGrants = retired;
  return next;
}

/** @param {InstallConfig} config */
function sharePointOf(config) {
  if (!config.sharePoint) throw new Error('The install record has no SharePoint folder yet.');
  return config.sharePoint;
}

/** @param {InstallConfig} config */
function appIdOf(config) {
  if (!config.app.appId) throw new Error('The install record has no app registration yet.');
  return config.app.appId;
}

/** @param {InstallConfig} config */
const appLabel = (config) => config.app.displayName ?? appName(config);

/** Graph's ID for a site, contoso.sharepoint.com,<guid>,<guid>, rather than its path form. @param {string | undefined} id */
const isGraphSiteId = (id) => !!id && id.includes(',');

/** @param {string} role */
const canWrite = (role) => /^(write|owner|fullcontrol|manage)$/i.test(role);

/**
 * Whether a site permission is the app's.
 * @param {any} permission
 * @param {string} appId
 */
const grantedTo = (permission, appId) =>
  [...(permission?.grantedToIdentitiesV2 ?? []), ...(permission?.grantedToIdentities ?? [])].some(
    (g) => String(g?.application?.id ?? '').toLowerCase() === appId.toLowerCase(),
  );

/**
 * Gives the app write access to the folder's site, and to no other (Sites.Selected), when the
 * signed-in account can. That takes an administrator whose sign-in carries Sites.FullControl.All,
 * which the installer's usually doesn't, so this mostly records that an administrator still has
 * to do it and returns false. The check as the app is the proof either way.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>}
 */
export async function ensureSiteGrant(ctx) {
  const { ui, config, api } = ctx;
  const sp = sharePointOf(config);
  if (sp.granted) return true;
  const appId = appIdOf(config);
  const name = appLabel(config);
  try {
    if (!isGraphSiteId(sp.siteId)) {
      sp.siteId = String((await api.graph.site(sp.sitePath)).id);
      ctx.save();
    }
    const siteId = /** @type {string} */ (sp.siteId);
    const mine = (await api.graph.sitePermissions(siteId)).find((p) => grantedTo(p, appId));
    if (mine) {
      const roles = /** @type {string[]} */ ((await api.graph.sitePermission(siteId, mine.id))?.roles ?? []);
      if (roles.some(canWrite)) ui.ok(`${name} can already write to ${sp.siteUrl}`);
      else {
        await api.graph.updateSitePermission(siteId, mine.id, 'write');
        ui.ok(`Changed ${name}'s access to ${sp.siteUrl} from read to write`);
      }
    } else {
      const created = await api.graph.grantSitePermission(siteId, appId, name, 'write');
      if (created?.id) sp.grantId = String(created.id);
      ui.ok(`Gave ${name} write access to ${sp.siteUrl}, and to no other site`);
    }
    sp.granted = true;
    delete sp.pendingAdminGrant;
    ctx.save();
    return true;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    // A 404 can mean the site doesn't exist or that this sign-in can't see it. The administrator's
    // steps, and the check as the app, tell those apart.
    if (err.status === 404) ui.warn(`Couldn't find ${sp.siteUrl} with your sign-in. If the address is wrong, change it when you run the install again.`);
    sp.pendingAdminGrant = true;
    ctx.save();
    return false;
  }
}

/**
 * Records a check that passed: the app can write to the folder, so any admin step is done.
 * @param {Ctx} ctx
 * @param {FolderCheck} check
 */
export function recordFolderCheck(ctx, check) {
  const sp = sharePointOf(ctx.config);
  sp.granted = true;
  delete sp.pendingAdminGrant;
  if (isGraphSiteId(check.siteId)) sp.siteId = check.siteId;
  ctx.save();
}

/** @param {FolderCheck} check */
const denied = (check) => check.status === 401 || check.status === 403;

/**
 * Runs the check as the app, again while a new secret or a new grant is still reaching every
 * server: a sign-in the secret fails, or a refusal once the app should have access.
 * @param {Ctx} ctx
 * @param {PaxHost} host
 * @param {boolean} settling  The app should have access already.
 */
async function settledCheck(ctx, host, settling) {
  const progress = ctx.ui.progress('Checking the SharePoint folder as the app');
  try {
    let check = await checkFolder(host);
    for (let i = 1; i < SETTLE_TRIES && !check.ok; i++) {
      if (!(SIGN_IN_FAILED.test(check.error ?? '') || (settling && denied(check)))) break;
      progress.update('waiting for Microsoft Entra and SharePoint to catch up');
      await ctx.sleep(SETTLE_MS);
      check = await checkFolder(host);
    }
    return check;
  } finally {
    progress.done();
  }
}

/**
 * Checks the app can reach the folder as the task will: on this PC, signed in with the saved
 * secret. Creates the folder when it's missing. Until an administrator has given the app the
 * site, shows them what to run and waits, as the admin consent step does. Call it once the app
 * has admin consent, since without it every check is refused. Returns true once the app can
 * write there; throws when the folder itself is wrong.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>}
 */
export async function confirmFolderAccess(ctx) {
  const { ui, config } = ctx;
  const sp = sharePointOf(config);
  const host = ctx.paxHost;
  if (!host) throw new Error('confirmFolderAccess needs the PC the refresh runs on.');
  let check = await settledCheck(ctx, host, !!sp.granted);
  for (;;) {
    if (check.ok) {
      recordFolderCheck(ctx, check);
      ui.ok(`The app can write to ${describeFolder(sp)}`);
      return true;
    }
    if (!denied(check)) throw new Error(check.error ?? 'Checking the SharePoint folder failed.');
    sp.granted = false;
    sp.pendingAdminGrant = true;
    ctx.save();
    showSiteGrant(ctx);
    if (ui.yes) {
      ui.warn("Carrying on without it. The refresh can't save its files until it's done.");
      return false;
    }
    const next = await ui.select(
      'Once they have done it:',
      [
        { name: 'Check again', value: 'check' },
        { name: "Carry on without it (the refresh can't save its files until it's done)", value: 'skip' },
      ],
      'check',
    );
    if (next === 'skip') return false;
    check = await settledCheck(ctx, host, true);
  }
}

/** A PowerShell string literal. @param {string} s */
const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;

/** @param {InstallConfig} config */
const connectLine = (config) =>
  `Connect-MgGraph${config.tenantId ? ` -TenantId ${psQuote(config.tenantId)}` : ''} -Scopes Sites.FullControl.All`;

/**
 * What an administrator runs in PowerShell 7 to give the app write access to the folder's site,
 * and no other, with Microsoft Graph PowerShell. For the terminal, the steps left and the admin pack.
 * @param {InstallConfig} config
 * @param {string} [appIdVar]  A PowerShell variable that holds the client ID, such as `$appId`, for steps
 *   written before the app exists. By default, the record's client ID.
 * @returns {string[]}
 */
export function siteGrantCommands(config, appIdVar) {
  const sp = sharePointOf(config);
  const identity = `@{ application = @{ id = ${appIdVar ?? psQuote(appIdOf(config))}; displayName = ${psQuote(appLabel(config))} } }`;
  return [
    'Install-Module Microsoft.Graph.Authentication -Scope CurrentUser',
    connectLine(config),
    `$site = Invoke-MgGraphRequest -Method GET -Uri ${psQuote(`${GRAPH}/sites/${sp.sitePath}`)}`,
    `$body = @{ roles = @('write'); grantedToIdentities = @(${identity}) } | ConvertTo-Json -Depth 5`,
    `Invoke-MgGraphRequest -Method POST -Uri "${GRAPH}/sites/$($site.id)/permissions" -Body $body -ContentType 'application/json'`,
  ];
}

/**
 * The same grant with PnP PowerShell, for administrators who use it.
 * @param {InstallConfig} config
 * @param {string} [appIdVar]  As for siteGrantCommands.
 */
export const pnpGrantCommand = (config, appIdVar) =>
  `Grant-PnPAzureADAppSitePermission -AppId ${appIdVar ?? psQuote(appIdOf(config))} -DisplayName ${psQuote(appLabel(config))} -Site ${psQuote(sharePointOf(config).siteUrl)} -Permissions Write`;

/**
 * What an administrator runs to take back the app's access to one site.
 * @param {InstallConfig} config
 * @param {Pick<SharePointConfig, 'sitePath'>} site
 * @returns {string[]}
 */
export function siteRemovalCommands(config, site) {
  return [
    connectLine(config),
    `$site = Invoke-MgGraphRequest -Method GET -Uri ${psQuote(`${GRAPH}/sites/${site.sitePath}`)}`,
    `$grants = (Invoke-MgGraphRequest -Method GET -Uri "${GRAPH}/sites/$($site.id)/permissions").value`,
    `$grants | Where-Object { $_.grantedToIdentitiesV2.application.id -contains ${psQuote(appIdOf(config))} } | ForEach-Object { Invoke-MgGraphRequest -Method DELETE -Uri "${GRAPH}/sites/$($site.id)/permissions/$($_.id)" }`,
  ];
}

/**
 * Tells the user what an administrator has to run to give the app the site.
 * @param {Ctx} ctx
 */
export function showSiteGrant(ctx) {
  const { ui, config } = ctx;
  const sp = sharePointOf(config);
  ui.warn(`${SITE_ADMIN} needs to give "${appLabel(config)}" write access to ${sp.siteUrl}. The app can then write to that site and no other (Sites.Selected).`);
  ui.info('They can run this in PowerShell 7:');
  for (const line of siteGrantCommands(config)) ui.note(line);
  ui.info(`Or, with PnP PowerShell: ${pnpGrantCommand(config)}`);
}

/**
 * Takes back the app's access to one site with the signed-in account. Returns false when it can't,
 * which needs an administrator, as giving it does.
 * @param {Ctx} ctx
 * @param {RetiredGrant} grant
 */
async function takeBack(ctx, grant) {
  const { api } = ctx;
  const appId = appIdOf(ctx.config);
  try {
    const siteId = isGraphSiteId(grant.siteId) ? /** @type {string} */ (grant.siteId) : String((await api.graph.site(grant.sitePath)).id);
    const ids = grant.grantId
      ? [grant.grantId]
      : (await api.graph.sitePermissions(siteId)).filter((p) => grantedTo(p, appId)).map((p) => String(p.id));
    for (const id of ids) await api.graph.deleteSitePermission(siteId, id);
    return true;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    // Gone already, or the site is.
    return err.status === 404;
  }
}

/** "a SharePoint Administrator or Global Administrator", mid-sentence. */
const siteAdmin = `a${SITE_ADMIN.slice(1)}`;

/**
 * Takes back the app's access to sites the folder moved away from. What the signed-in account
 * can't take back stays listed, for an administrator.
 * @param {Ctx} ctx
 * @param {{ uninstall?: boolean }} [o]  Uninstalling: show the administrator's commands now, as no steps are left to list them.
 * @returns {Promise<boolean>}  Whether none is left.
 */
export async function removeRetiredGrants(ctx, o = {}) {
  const { ui, config } = ctx;
  const sp = config.sharePoint;
  if (!sp?.retiredGrants?.length || !config.app.appId) return true;
  /** @type {RetiredGrant[]} */
  const left = [];
  for (const grant of sp.retiredGrants) {
    if (await takeBack(ctx, grant)) ui.ok(`Took back the app's access to ${grant.siteUrl}, where the folder was before`);
    else left.push(grant);
  }
  if (left.length) sp.retiredGrants = left;
  else delete sp.retiredGrants;
  ctx.save();
  for (const grant of left) {
    if (o.uninstall) {
      ui.warn(`Couldn't take back the app's access to ${grant.siteUrl}. It does nothing once the app is deleted, but ${siteAdmin} can remove it with:`);
      for (const line of siteRemovalCommands(config, grant)) ui.note(line);
    } else ui.warn(`The app can still write to ${grant.siteUrl}, where the folder was before. ${SITE_ADMIN} can take that back: it's on the list of steps left.`);
  }
  return !left.length;
}

/**
 * For uninstall: takes back the app's access to the folder's site, and to any site the folder was
 * on before. Once the app is deleted its access does nothing, so what's left is only tidying up.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>}  Whether nothing is left to take back.
 */
export async function removeSiteGrant(ctx) {
  const { ui, config } = ctx;
  const sp = config.sharePoint;
  if (!sp || !config.app.appId) return true;
  if (sp.granted || sp.grantId) {
    /** @type {RetiredGrant} */
    const current = { siteUrl: sp.siteUrl, sitePath: sp.sitePath, ...(sp.siteId ? { siteId: sp.siteId } : {}), ...(sp.grantId ? { grantId: sp.grantId } : {}) };
    if (await takeBack(ctx, current)) {
      ui.ok(`Took back the app's access to ${sp.siteUrl}`);
      delete sp.grantId;
      sp.granted = false;
      ctx.save();
    } else {
      ui.warn(`Couldn't take back the app's access to ${sp.siteUrl}. It does nothing once the app is deleted, but ${siteAdmin} can remove it with:`);
      for (const line of siteRemovalCommands(config, sp)) ui.note(line);
    }
  }
  const retiredDone = await removeRetiredGrants(ctx, { uninstall: true });
  return !(sp.granted || sp.grantId) && retiredDone;
}
