// @ts-check
// Azure, by hand (docs/MANUAL-INSTALL.md#azure) must set up what the installer does.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { azureGraphRolesFor } from '../src/catalog.js';
import { graphApi } from '../src/clients/graph.js';
import { AZURE_PROVIDERS, TEAMS_CLIENTS, WEB_APP_NAME } from '../src/steps/azure/index.js';

/** @param {string} path from the repo root */
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

// Power BI's Dataset.Read.All and Graph's User.Read: the same in every tenant.
const DATASET_READ_ALL = '7f33e027-4039-419b-938e-2f8ca153e68e';
const USER_READ = 'e1fe6dd8-ba31-4d61-89e7-88639da4683d';

test('the by-hand web app registration is the one the installer creates', async () => {
  /** @type {any[]} */
  const posts = [];
  const http = /** @type {any} */ ({ post: async (/** @type {string} */ _path, /** @type {any} */ body) => (posts.push(body), { id: 'a' }) });
  await graphApi(http).createAzureWebApplication({ displayName: WEB_APP_NAME, fqdn: '{{fqdn}}', pbiScopeId: DATASET_READ_ALL, graphUserReadScopeId: USER_READ, teamsClientIds: TEAMS_CLIENTS });
  // The installer makes new IDs for the scope and roles each time; the file has fixed ones.
  /** @param {any} body */
  const withoutIds = (body) => JSON.parse(JSON.stringify({ ...body, notes: '' })
    .replaceAll(body.api.oauth2PermissionScopes[0].id, 'scope')
    .replaceAll(body.appRoles[0].id, 'user')
    .replaceAll(body.appRoles[1].id, 'admin'));
  assert.deepEqual(withoutIds(JSON.parse(read('azure/infra/web-app-registration.json'))), withoutIds(posts[0]));
});

test('Azure, by hand, gives the managed identity the Graph roles and registers the providers the installer does', () => {
  const page = read('docs/MANUAL-INSTALL.md');
  /** @param {string} name */
  const loop = (name) => page.match(new RegExp(`^\\s*for ${name} in (.+); do\\s*$`, 'm'))?.[1].split(' ');
  const modules = { orgData: true, m365Activity: false, agent365: false, productFeedback: false, consumption: true, agentEvaluator: false };
  assert.deepEqual(loop('role'), azureGraphRolesFor(modules));
  assert.deepEqual(loop('p')?.map((p) => `Microsoft.${p}`), AZURE_PROVIDERS);
});
