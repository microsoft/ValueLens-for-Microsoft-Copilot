// @ts-check
/**
 * Uninstall on Fabric: the workspace, after its managed private endpoints, which Fabric won't
 * delete a workspace without, then the model's SQL connection, which lives outside the workspace,
 * then the transcript read roles the installer gave the app in Dataverse environments.
 */
import { secretMode } from '../config.js';
import { HttpError } from '../http.js';
import { removeFabricReadRoles } from './agent-evaluator.js';

/** @typedef {import('../install.js').Ctx} Ctx */

/** How often, and how many times, to check the private endpoints have gone: ten minutes in all. */
export const ENDPOINT_POLL_MS = 10_000;
const ENDPOINT_POLLS = 60;

/** @param {unknown} err */
const gone = (err) => err instanceof HttpError && err.status === 404;

/**
 * Deletes the workspace's managed private endpoints and waits until Fabric has removed them.
 * @param {Ctx} ctx
 * @param {string} workspaceId
 * @returns {Promise<number>}  How many there were.
 */
export async function deletePrivateEndpoints(ctx, workspaceId) {
  const { ui, api } = ctx;
  const list = async () => {
    try {
      return await api.fabric.listPrivateEndpoints(workspaceId);
    } catch (err) {
      if (gone(err)) return [];
      throw err;
    }
  };
  const endpoints = await list();
  if (!endpoints.length) return 0;
  for (const mpe of endpoints) {
    try {
      await api.fabric.deletePrivateEndpoint(workspaceId, mpe.id);
    } catch (err) {
      if (!gone(err)) throw err;
    }
  }
  for (let i = 0; i < ENDPOINT_POLLS; i++) {
    if (!(await list()).length) {
      ui.ok(`Deleted ${endpoints.length === 1 ? 'the managed private endpoint' : `${endpoints.length} managed private endpoints`} (${endpoints.map((e) => e.name ?? e.id).join(', ')})`);
      return endpoints.length;
    }
    await ctx.sleep(ENDPOINT_POLL_MS);
  }
  throw new Error('Fabric is still deleting the workspace\'s managed private endpoints after ten minutes. Run uninstall again later.');
}

/**
 * Deletes the semantic model's SQL connection. Connections live outside the workspace, so deleting
 * the workspace leaves it behind. A failure only warns: the workspace is already gone.
 * @param {Ctx} ctx
 */
async function deleteModelConnection(ctx) {
  const { ui, config, api } = ctx;
  const sm = config.semanticModel;
  if (!sm?.connectionId) return;
  const label = sm.connectionName ?? sm.connectionId;
  try {
    await api.fabric.deleteConnection(sm.connectionId);
    ui.ok(`Deleted the connection "${label}"`);
  } catch (err) {
    if (gone(err)) ui.ok(`The connection "${label}" was already gone`);
    else ui.warn(`Couldn't delete the connection "${label}": ${/** @type {Error} */ (err).message}. Delete it under Manage connections and gateways.`);
  }
}

/**
 * Deletes the Fabric workspace and everything in it, managed private endpoints first. Asks first,
 * and by default leaves a workspace the installer didn't create.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>}  Whether the workspace was deleted.
 */
export async function fabricUninstall(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  if (!f.workspaceId) throw new Error('Nothing is installed yet.');
  const name = f.workspaceName ?? f.workspaceId;
  ui.heading('Uninstalling Analytics Hub on Fabric');
  const sure = await ui.confirm(
    f.createdWorkspace
      ? `Delete workspace "${name}" and everything in it, including the Lakehouse data?`
      : `Delete workspace "${name}" and everything in it, including the Lakehouse data? The record doesn't show the installer created it.`,
    !!f.createdWorkspace,
  );
  if (!sure) {
    ui.note(`Left workspace "${name}" alone.`);
    return false;
  }
  await deletePrivateEndpoints(ctx, f.workspaceId);
  try {
    await api.fabric.deleteWorkspace(f.workspaceId);
    ui.ok(`Deleted workspace "${name}"`);
  } catch (err) {
    if (!gone(err)) throw err;
    ui.ok(`Workspace "${name}" was already gone`);
  }
  await deleteModelConnection(ctx);
  await removeFabricReadRoles(ctx);
  ui.note(
    `Left alone: the app registration ${config.app.displayName ?? config.app.appId ?? ''}, ${secretMode(config) === 'notebook' ? '' : 'the Key Vault and its secret, '}any Power Automate flows, ` +
      'the app\'s application users in Dataverse environments with their Bot Transcript Viewer role, and the other roles it was given. Remove them yourself if nothing else uses them.',
  );
  ui.note('The install record still names the deleted workspace. Move it aside before installing again.');
  return true;
}
