// @ts-check
/**
 * Publishes the Teams app package to the org's app catalog, so nobody has to upload it by hand, and keeps
 * that app up to date on later runs. When it can't (no admin role, no consent, a tenant policy, an API
 * error, a sign-in that isn't finished in time), or the admin chooses not to, the package stays on disk,
 * the admin gets the steps to upload it, and the install carries on.
 *
 * Publishing needs the delegated AppCatalog.ReadWrite.All scope, which the installer's own sign-in (the
 * Azure CLI's app) can't ask for, so it signs in once more as Microsoft Graph Command Line Tools.
 */
import { createHash } from 'node:crypto';
import { abandonSignIn, isTransientNetworkError } from '../../auth.js';
import { TEAMS_PUBLISH_ROLES } from '../../clients/graph.js';
import { HttpError } from '../../http.js';
import { VIEWER_GROUP_NAME } from '../access.js';

/** @typedef {import('../../install.js').Ctx} Ctx */
/** @typedef {import('../../config.js').AzureConfig} AzureConfig */
/** @typedef {NonNullable<AzureConfig['teamsApp']>} TeamsAppRecord */

/** Teams admin center > Teams apps > Manage apps, where admins upload, update and delete custom apps. */
export const MANAGE_APPS_URL = 'https://admin.teams.microsoft.com/policies/manage-apps';

/** How the pending admin action starts when the installer couldn't publish the app, so a later run can clear it. */
export const TEAMS_APP_PENDING = 'Publish the Teams app';

/** How long the app catalog sign-in can take before the install carries on without it. */
export const CATALOG_SIGN_IN_MS = 5 * 60_000;

/**
 * How long after the installer publishes or updates the app a "not found" from the app catalog isn't believed.
 * In a live run, Microsoft Graph took about 25 minutes to find a newly published app, so an uninstall soon after
 * publishing got 404 and left the app in the catalog with no record of it. Waiting too long costs only a warning.
 */
export const CATALOG_SETTLE_MS = 24 * 60 * 60_000;

const PERMISSION = '"Read and write to all app catalogs" (AppCatalog.ReadWrite.All)';
const STEPS_LATER = 'The install carries on, and the steps to upload it by hand come at the end.';

/**
 * Whether this run can publish the Teams app, worked out before the plan is shown.
 * @typedef {object} CatalogAccess
 * @property {boolean} canTry
 * @property {string} [role]  The role that allows it, when the installer could see it.
 * @property {string} [reason]  Why not, when it can't.
 * @property {string} [fix]  What lets a later run publish it, when it can't.
 * @property {boolean} [skip]  The admin said no when the plan asked to publish it, so this run leaves it for them to upload.
 * @property {Promise<string | undefined>} [ready]  The sign-in for the app catalog, once started: undefined when it worked, otherwise why not.
 */

/**
 * Whether to try publishing: the sign-in can ask for the app catalog permission, and the signed-in user
 * has a role that publishes straight to the catalog. When the roles can't be read, it tries anyway.
 * @param {Ctx} ctx
 * @returns {Promise<CatalogAccess>}
 */
export async function checkCatalogAccess(ctx) {
  if (!ctx.api.appCatalog) {
    return {
      canTry: false,
      reason: 'You signed in with the Azure CLI, which can\'t ask for the permission to change your org\'s app catalog.',
      fix: 'Next time, sign in with the browser or a code instead, and the installer publishes it for you.',
    };
  }
  /** @type {{ roleTemplateId: string }[]} */
  let roles;
  try {
    roles = await ctx.api.graph.myDirectoryRoles();
  } catch {
    return { canTry: true };
  }
  const role = roles.map((r) => TEAMS_PUBLISH_ROLES[/** @type {keyof typeof TEAMS_PUBLISH_ROLES} */ (r.roleTemplateId)]).find(Boolean);
  if (role) return { canTry: true, role };
  return {
    canTry: false,
    reason: 'Changing your org\'s app catalog takes the Teams Administrator or Global Administrator role, active, and you have neither.',
    fix: 'If you can activate one in Privileged Identity Management, do that, then run the installer again and choose Repair or change.',
  };
}

/** @param {Ctx} ctx */
const accessFor = async (ctx) => (ctx.teamsCatalog ??= await checkCatalogAccess(ctx));

/**
 * Signs in for the app catalog permission. Once per run, whatever the outcome, so a declined consent isn't
 * asked for again. Gives up after CATALOG_SIGN_IN_MS. Never throws.
 * @param {Ctx} ctx
 * @returns {Promise<string | undefined>}  Why it can't change the catalog, or undefined when it can.
 */
export async function catalogSignIn(ctx) {
  const access = await accessFor(ctx);
  const catalog = ctx.api.appCatalog;
  if (!access.canTry || !catalog) return access.reason ?? 'This sign-in can\'t change your org\'s app catalog.';
  return (access.ready ??= signInWithin(catalog, CATALOG_SIGN_IN_MS));
}

/**
 * Signs in, but stops waiting after `ms`, so a browser sign-in that nobody finishes can't hold up the install.
 * @param {import('../../clients/graph.js').AppCatalogApi} catalog
 * @param {number} ms
 * @returns {Promise<string | undefined>}  undefined when it worked, otherwise why not. Never rejects.
 */
function signInWithin(catalog, ms) {
  const abort = new AbortController();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Promise<string>} */
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => {
      abort.abort();
      // A code sign-in stops on the abort, but a browser sign-in keeps waiting for the browser.
      abandonSignIn();
      resolve(`The sign-in to Microsoft Graph Command Line Tools wasn't finished within ${ms / 60_000} minutes.`);
    }, ms);
  });
  const signedIn = Promise.resolve()
    .then(() => catalog.signIn({ abortSignal: abort.signal }))
    .then(() => undefined, catalogErrorReason);
  return Promise.race([signedIn, timedOut]).finally(() => clearTimeout(timer));
}

/**
 * Whether the catalog may need this run's package: nothing published yet, another version, an app
 * published for another app registration, or an earlier run that left the steps to upload it.
 * @param {AzureConfig} az
 * @param {string} version  The package's manifest version.
 */
export function catalogNeedsChange(az, version) {
  const rec = az.teamsApp;
  return !rec || rec.version !== version || rec.externalId !== az.webApp?.clientId || !!az.status?.pendingAdminActions?.some((a) => a.startsWith(TEAMS_APP_PENDING));
}

/**
 * With the plan: asks whether to publish the Teams app this run, when the installer can try. Saying no
 * leaves it for an admin to upload by hand, with no sign-in. The default is the last answer this run, or yes.
 * @param {Ctx} ctx
 * @param {string} version  The package's manifest version.
 */
export async function askToPublishTeamsApp(ctx, version) {
  const az = ctx.config.azure;
  if (!az || !ctx.api.appCatalog || !catalogNeedsChange(az, version)) return;
  const access = await accessFor(ctx);
  if (!access.canTry) return;
  access.skip = !(await ctx.ui.confirm('Publish the Teams app to your org\'s app catalog? It takes one more sign-in. If you say no, the installer prints the steps to upload it by hand.', !access.skip));
}

/**
 * Asks for the app catalog permission straight after the plan is approved, while the admin is still at the
 * keyboard, rather than at the end of the install. Does nothing when the catalog already has this version,
 * or when the admin chose to upload it by hand.
 * @param {Ctx} ctx
 * @param {string} version  The package's manifest version.
 */
export async function signInForTeamsApp(ctx, version) {
  const az = ctx.config.azure;
  if (!az || !catalogNeedsChange(az, version)) return;
  const access = await accessFor(ctx);
  if (!access.canTry || access.skip) return;
  ctx.ui.note(`Signing in once more, as Microsoft Graph Command Line Tools, to publish the Teams app to your org's app catalog. If the sign-in isn't finished within ${CATALOG_SIGN_IN_MS / 60_000} minutes, the install carries on without it.`);
  const reason = await catalogSignIn(ctx);
  if (reason) ctx.ui.warn(`The installer can't publish the Teams app. ${reason} ${STEPS_LATER}`);
  else ctx.ui.ok('Signed in to publish the Teams app');
}

/**
 * The plan's line for the Teams app.
 * @param {Ctx} ctx
 * @param {string} version  The package's manifest version.
 * @returns {{ kind: string, name: string, detail: string, isNew: boolean }}
 */
export function teamsAppPlanRow(ctx, version) {
  const az = /** @type {AzureConfig} */ (ctx.config.azure);
  const row = { kind: 'Teams app', name: 'Analytics Hub in your org\'s app catalog' };
  if (az.teamsApp && !catalogNeedsChange(az, version)) return { ...row, isNew: false, detail: `Already published (version ${version}).` };
  const access = ctx.teamsCatalog;
  const byHand = 'The installer prints the steps for a Teams Administrator to upload it.';
  if (access && !access.canTry) return { ...row, isNew: false, detail: `Not published by the installer. ${access.reason} ${byHand}` };
  if (access?.skip) return { ...row, isNew: false, detail: `Not published by the installer. You chose to upload it by hand. ${byHand}` };
  const signIn = 'You sign in once more for this, to Microsoft Graph Command Line Tools.';
  return az.teamsApp
    ? { ...row, isNew: false, detail: `Update to version ${version}. ${signIn}` }
    : { ...row, isNew: true, detail: `Publish version ${version}, or update the app if it's there already. ${signIn}` };
}

/**
 * Publishes the Teams package to the org's app catalog, or updates the app already there. Never throws:
 * when it can't, the package stays on disk and the admin gets the steps to upload it.
 * @param {Ctx} ctx
 * @param {{ path: string, zip: Uint8Array, version: string }} pkg
 */
export async function publishTeamsApp(ctx, pkg) {
  const { ui } = ctx;
  const az = /** @type {AzureConfig} */ (ctx.config.azure);
  const externalId = String(az.webApp?.clientId ?? '');
  const sha256 = createHash('sha256').update(pkg.zip).digest('hex');
  const rec = az.teamsApp;
  // The app recorded for this app registration, or one published for an earlier registration, which can't sign in any more.
  const ours = rec?.externalId === externalId ? rec : undefined;
  const stale = rec && !ours ? rec : undefined;
  if (ours && ours.version === pkg.version && ours.sha256 === sha256) {
    if (clearPending(az)) ctx.save();
    ui.ok(`Teams app: up to date in your org's app catalog (version ${pkg.version})`);
    return;
  }
  if (ctx.teamsCatalog?.skip) {
    return manual(ctx, pkg, 'You chose to upload it by hand. To have the installer publish it, run the installer again, choose Repair or change, and say yes to publishing it.', { existing: ours ? true : undefined, stale });
  }
  const reason = await catalogSignIn(ctx);
  if (reason) return manual(ctx, pkg, [reason, ctx.teamsCatalog?.fix].filter(Boolean).join(' '), { existing: ours ? true : undefined, stale });
  const catalog = /** @type {import('../../clients/graph.js').AppCatalogApi} */ (ctx.api.appCatalog);
  /** @type {boolean | undefined} */
  let existing = ours ? true : undefined;
  try {
    const apps = await catalog.find(externalId);
    let app = apps.find((a) => a.id === ours?.id) ?? apps[0];
    existing = !!app;
    if (!app) {
      try {
        app = await catalog.publish(pkg.zip);
      } catch (err) {
        // Graph doesn't list an app that's waiting for approval, but Teams still won't take a second one with its ID.
        if (err instanceof HttpError && err.status === 409) return manual(ctx, pkg, 'Teams says Analytics Hub is in the catalog already, but Microsoft Graph didn\'t list it. It may be waiting for approval.', { existing: true, stale });
        throw err;
      }
      ui.ok(`Teams app: published Analytics Hub ${pkg.version} to your org's app catalog`);
      ui.info(whereToFind(ctx));
    } else {
      const current = publishedVersion(app);
      if (!current) return manual(ctx, pkg, 'Analytics Hub is in the catalog waiting for approval, so the installer can\'t update it.', { existing: true, stale, approve: true });
      const order = compareVersions(pkg.version, current);
      if (order < 0) {
        if (clearPending(az)) ctx.save();
        ui.warn(`Teams app: your org's app catalog has Analytics Hub ${current}, newer than this installer's ${pkg.version}, so the installer left it alone.`);
        return;
      }
      if (order === 0 && !(ours?.id === app.id && ours.version === pkg.version)) {
        // This version, uploaded by hand or by a run that didn't record it.
        ui.ok(`Teams app: Analytics Hub ${pkg.version} is already in your org's app catalog`);
      } else {
        try {
          await catalog.update(/** @type {string} */ (app.id), pkg.zip);
          ui.ok(`Teams app: updated Analytics Hub to ${pkg.version} in your org's app catalog`);
        } catch (err) {
          if (!(order === 0 && err instanceof HttpError && (err.status === 400 || err.status === 409))) throw err;
          // The record keeps the package Teams has, so the next run tries again.
          return manual(ctx, pkg, `Teams kept Analytics Hub ${current} and didn't take this package as an update at the same version (${firstLine(err.message)}).`, { existing: true, stale });
        }
      }
    }
    az.teamsApp = { id: /** @type {string} */ (app.id), externalId, version: pkg.version, sha256, publishedAt: ctx.now().toISOString() };
    clearPending(az);
    ctx.save();
    if (stale && stale.id !== app.id) await removeStale(ctx, stale);
  } catch (err) {
    return manual(ctx, pkg, catalogErrorReason(err), { existing, stale });
  }
}

/**
 * Uninstall: deletes the app the installer looks after from the org's catalog, the one it published or a
 * hand upload it took on. Never deletes an app it didn't record, and never throws.
 * @param {Ctx} ctx
 */
export async function removeTeamsApp(ctx) {
  const { ui } = ctx;
  const az = ctx.config.azure;
  const rec = az?.teamsApp;
  const steps = `Delete it in Teams admin center > Teams apps > Manage apps (${MANAGE_APPS_URL}): select Analytics Hub, then Delete.`;
  if (!az || !rec) {
    if (az?.teamsPackage) ui.note(`If Analytics Hub was uploaded to your org's Teams app catalog by hand, a Teams Administrator deletes it there. ${steps}`);
    return;
  }
  const reason = await catalogSignIn(ctx);
  if (!reason) {
    try {
      await /** @type {import('../../clients/graph.js').AppCatalogApi} */ (ctx.api.appCatalog).remove(rec.id);
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) return notRemoved(ctx, catalogErrorReason(err), steps);
      const ms = ctx.now().getTime() - Date.parse(rec.publishedAt);
      // Kept, so the record still points the installer at the app.
      if (ms < CATALOG_SETTLE_MS) return notRemoved(ctx, `Microsoft Graph didn't find Analytics Hub, which the installer published or updated ${ago(ms)}. Graph can take half an hour or more to find a new app, so it may still be there.`, steps);
    }
    delete az.teamsApp;
    ctx.save();
    ui.ok('Teams app: removed Analytics Hub from your org\'s app catalog');
    return;
  }
  notRemoved(ctx, reason, steps);
}

/** @param {Ctx} ctx @param {string} reason @param {string} steps */
function notRemoved(ctx, reason, steps) {
  ctx.ui.warn(`Teams app: not removed from your org's app catalog. ${reason}`);
  ctx.ui.info(steps);
}

/** @param {number} ms */
function ago(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  return `${Math.round(minutes / 60)} hours ago`;
}

/**
 * Why publishing didn't work, in words an admin can act on.
 * @param {unknown} err
 */
export function catalogErrorReason(err) {
  const e = /** @type {any} */ (err);
  const message = String(e?.message ?? err ?? '');
  const text = `${message} ${typeof e?.body === 'string' ? e.body : JSON.stringify(e?.body ?? '')}`;
  switch (/AADSTS(\d+)/.exec(text)?.[1]) {
    case '65004':
      return `The app catalog permission, ${PERMISSION}, was declined at sign-in.`;
    case '90094':
    case '90095':
      return `The app catalog permission, ${PERMISSION}, needs admin consent. A Global Administrator, Privileged Role Administrator, Cloud Application Administrator or Application Administrator can give it at sign-in.`;
    case '65001':
      return `Microsoft Graph Command Line Tools hasn't been given ${PERMISSION} in your tenant.`;
    case '50105':
      return 'Your tenant only lets assigned users sign in to Microsoft Graph Command Line Tools, and you aren\'t one. An admin can assign you in Entra, under Enterprise applications.';
    case '53003':
      return 'A Conditional Access policy blocked the sign-in to Microsoft Graph Command Line Tools.';
    case '7000112':
      return 'Microsoft Graph Command Line Tools is turned off in your tenant (Entra, Enterprise applications).';
    case '700016':
      return 'Microsoft Graph Command Line Tools isn\'t available in your tenant.';
    default:
  }
  if (err instanceof HttpError) {
    if (err.status === 401 || err.status === 403) {
      return `Microsoft Graph refused it (${err.status}). Changing your org's app catalog takes the Teams Administrator or Global Administrator role, active, and consent to ${PERMISSION}.`;
    }
    if (err.status === 400) return `Teams didn't accept the package: ${firstLine(message)}`;
  }
  if (isTransientNetworkError(err)) return 'The network connection dropped.';
  return firstLine(message) || 'Something went wrong.';
}

/** @param {string} text */
const firstLine = (text) => text.split(/\r?\n/)[0].replace(/\s*Trace ID:.*$/i, '').slice(0, 300).trim();

/** @param {Ctx} ctx */
const whereToFind = (ctx) =>
  `A few hours after it's published, people find it in Teams under Apps > Built for your org, and in the Outlook and Microsoft 365 Copilot app stores. To pin it in Teams for ${ctx.config.access?.groupName || VIEWER_GROUP_NAME}, a Teams Administrator adds it to an app setup policy and assigns that policy to the group.`;

/**
 * Leaves the package for an admin to upload, prints the steps, and adds a pending admin action that a later
 * run clears once the app is published.
 * @param {Ctx} ctx
 * @param {{ path: string }} pkg
 * @param {string} reason
 * @param {{ existing?: boolean, stale?: TeamsAppRecord, approve?: boolean }} [o]  existing: whether the catalog has the app already, undefined
 *   when not known. approve: it's there, waiting for an admin to approve it.
 */
function manual(ctx, pkg, reason, o = {}) {
  const { ui } = ctx;
  const az = /** @type {AzureConfig} */ (ctx.config.azure);
  // With an earlier app registration's app in the catalog too, "Analytics Hub" alone doesn't say which one.
  const app = o.stale ? `the Analytics Hub with App ID ${az.webApp?.clientId}` : 'Analytics Hub';
  ui.warn(`Teams app: not published to your org's app catalog. ${reason}`);
  ui.info(`To ${o.approve ? 'approve' : 'publish'} it, a Teams Administrator or Global Administrator:`);
  const steps = [`Opens Teams admin center > Teams apps > Manage apps: ${MANAGE_APPS_URL}`];
  if (o.stale) steps.push(`Deletes the Analytics Hub with App ID ${o.stale.externalId}, which was published for an earlier app registration.`);
  if (o.approve) steps.push(`Selects ${app}, which is waiting for approval, then Publish in its Publishing status box.`);
  else if (o.existing === true) steps.push(`Selects ${app}, then Upload file on its page, and chooses ${pkg.path}`);
  else if (o.existing === false) steps.push(`Selects Upload new app, then Upload, and chooses ${pkg.path}`);
  else steps.push(`If ${app} is listed, selects it, then Upload file on its page. If not, selects Upload new app, then Upload. Either way, chooses ${pkg.path}`);
  steps.forEach((s, i) => ui.info(`  ${i + 1}. ${s}`));
  if (o.approve) ui.info('Then run the installer again and choose Repair or change, to bring it up to date.');
  ui.info(whereToFind(ctx));
  az.status ??= {};
  const where = `Teams admin center > Teams apps > Manage apps (${MANAGE_APPS_URL})`;
  const action = o.approve ? `${TEAMS_APP_PENDING}: approve Analytics Hub in ${where}, then run the installer again.` : `${TEAMS_APP_PENDING}: upload ${pkg.path} in ${where}.`;
  az.status.pendingAdminActions = [...(az.status.pendingAdminActions ?? []).filter((a) => !a.startsWith(TEAMS_APP_PENDING)), action];
  ctx.save();
}

/** Takes the Teams app's pending admin action off the list. @param {AzureConfig} az @returns {boolean} Whether there was one. */
function clearPending(az) {
  const list = az.status?.pendingAdminActions;
  if (!az.status || !list?.some((a) => a.startsWith(TEAMS_APP_PENDING))) return false;
  az.status.pendingAdminActions = list.filter((a) => !a.startsWith(TEAMS_APP_PENDING));
  return true;
}

/** Deletes the app published for an earlier app registration. @param {Ctx} ctx @param {TeamsAppRecord} stale */
async function removeStale(ctx, stale) {
  try {
    await ctx.api.appCatalog?.remove(stale.id);
    ctx.ui.ok('Teams app: removed the one published for an earlier app registration');
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return;
    ctx.ui.warn(`Teams app: couldn't remove the Analytics Hub published for an earlier app registration (App ID ${stale.externalId}). ${catalogErrorReason(err)} Delete it in ${MANAGE_APPS_URL}`);
  }
}

/** The app's highest published version; versions waiting for approval don't count. @param {import('../../clients/graph.js').TeamsCatalogApp} app */
function publishedVersion(app) {
  return (app.appDefinitions ?? [])
    .filter((d) => d.publishingState === 'published' && d.version)
    .map((d) => String(d.version))
    .sort(compareVersions)
    .at(-1);
}

/** Compares x.y.z versions. @param {string} a @param {string} b */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}
