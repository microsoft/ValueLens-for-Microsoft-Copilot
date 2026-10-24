// @ts-check
/**
 * The installer's two routes: Fabric, where notebooks and a pipeline load a Lakehouse for the
 * report, and no Fabric, where a scheduled task on this PC runs PAX and writes to a SharePoint
 * folder that the report and the app read.
 */
import { permissionsFor } from './catalog.js';
import { PRODUCT } from './product.js';
import { paxHostOf } from './steps/pax/local.js';

/** @typedef {import('./config.js').InstallConfig} InstallConfig */
/** @typedef {'fabric' | 'pax'} Target */

export const TARGETS = /** @type {const} */ (['fabric', 'pax']);

/** What the installer calls each route. */
export const ROUTE_NAMES = Object.freeze({ fabric: 'Fabric', pax: 'No Fabric: PAX + SharePoint' });

/**
 * Graph application permissions the PAX app needs: the audit log query, the users and licences
 * that PAX's rollup joins to the activity, and write access to the one SharePoint site that an
 * administrator grants (Sites.Selected).
 */
export const PAX_PERMISSIONS = Object.freeze(['AuditLogsQuery.Read.All', 'Organization.Read.All', 'Sites.Selected', 'User.Read.All']);

/** What the Agent 365 registry adds. A tenant without CopilotPackages.Read.All yet only loses the registry. */
export const PAX_AGENT365_PERMISSIONS = Object.freeze(['Application.Read.All', 'CopilotPackages.Read.All']);

/** @param {InstallConfig} config */
export const isPax = (config) => config.target === 'pax';

/**
 * Graph application permissions the app registration needs on the record's route, sorted.
 * @param {InstallConfig} config
 * @returns {string[]}
 */
export function requiredPermissions(config) {
  if (!isPax(config)) return permissionsFor(config.modules, config.dataSources);
  return [...new Set([...PAX_PERMISSIONS, ...(config.pax?.agent365 ? PAX_AGENT365_PERMISSIONS : [])])].sort();
}

/**
 * The name a new app registration gets on the record's route.
 * @param {InstallConfig} config
 */
export const appName = (config) => (isPax(config) ? PRODUCT.pax.app : PRODUCT.fabric.app);

/**
 * The route an install has started on, which can't change without uninstalling first.
 * @param {InstallConfig} config
 * @returns {Target | undefined}
 */
export function settledRoute(config) {
  const f = config.fabric;
  if (f.lakehouseId || f.pipelineId || Object.keys(f.notebooks ?? {}).length) return 'fabric';
  if (config.pax?.task || config.pax?.credentialTarget || config.sharePoint) return 'pax';
  return undefined;
}

/**
 * Why this machine can't run the PAX route, or undefined when it can.
 * @param {{ platform: NodeJS.Platform | string, cloudShell: boolean }} host
 */
export function paxHostProblem(host) {
  if (host.cloudShell) {
    return `The ${ROUTE_NAMES.pax} route runs a daily task on a Windows PC, so it can't be set up from Azure Cloud Shell. Run the installer on the Windows PC that will run the task.`;
  }
  if (host.platform !== 'win32') {
    return `The ${ROUTE_NAMES.pax} route runs a daily task with Windows Task Scheduler, so it needs a Windows PC. Run the installer on the Windows PC that will run the task, or choose the Fabric route.`;
  }
  return undefined;
}

/**
 * Holds a command to the route its install record started on, without asking. install asks
 * instead (askTarget); prereqs may look at either route, since it changes nothing.
 * @param {import('./install.js').Ctx} ctx
 */
export function holdTarget(ctx) {
  const settled = settledRoute(ctx.config);
  if (!settled) return;
  if (ctx.targetChosen && ctx.config.target !== settled) {
    throw new Error(`This install record is for the ${ROUTE_NAMES[settled]} route, so --target ${ctx.config.target} doesn't apply to it. Leave out --target, or pass --config with the other route's install record.`);
  }
  ctx.config.target = settled;
}

/**
 * Asks which route to set up, unless the record or --target has settled it. A record that has
 * started on one route stays on it.
 * @param {import('./install.js').Ctx} ctx
 */
export async function askTarget(ctx) {
  const { config, ui } = ctx;
  const settled = settledRoute(config);
  if (settled) {
    if (ctx.targetChosen && config.target !== settled) {
      throw new Error(`This install record is for the ${ROUTE_NAMES[settled]} route. Uninstall it first to change route, or pass --config with a new file name to set up a second copy.`);
    }
    config.target = settled;
  } else if (!ctx.targetChosen) {
    ui.heading('Where it runs');
    config.target = await ui.select(
      `Where should ${PRODUCT.name} run?`,
      [
        {
          name: ROUTE_NAMES.fabric,
          value: 'fabric',
          description: 'Notebooks and a pipeline in a Fabric workspace load the data into a Lakehouse each day, for the report. Needs a Fabric capacity (F2 or larger, or a trial).',
        },
        {
          name: ROUTE_NAMES.pax,
          value: 'pax',
          description: 'A daily task on this Windows PC runs PAX and writes the data to a SharePoint folder, which the report and the app read. Needs Power BI Pro, PowerShell 7 and Python 3.10 or later.',
        },
      ],
      /** @type {Target} */ (config.target ?? 'fabric'),
    );
  }
  if (isPax(config)) {
    const problem = paxHostProblem(paxHostOf(ctx));
    if (problem) throw new Error(problem);
  }
  ctx.save();
  return config.target;
}
