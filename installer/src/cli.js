// @ts-check
/** Command-line entry point. */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AZ_LOGIN } from './auth.js';
import { orgUrl } from './clients/dataverse.js';
import { AH_CONFIG_FILE, archiveConfig, DEFAULT_CONFIG_FILE, loadConfig, normaliseResourceGraph } from './config.js';
import { HttpError } from './http.js';
import { connect, createCtx, preview, runCommand } from './install.js';
import { adoptUploadedRecord, cloudShellKeepsFiles, cloudShellRecordMessage, commandLine, inCloudShell, installerVersion } from './launch.js';
import { PRODUCT } from './product.js';
import { runWizard } from './server.js';
import { loadSources } from './sources.js';
import { recordWorkspaceGone, staleRecordMessage } from './steps/fabric.js';
import { isResumeLater, MAX_SECRET_DAYS, NOTEBOOK_SECRET_DAYS } from './steps/identity.js';
import { isManagementGroupId, managementGroupId } from './steps/resource-graph.js';
import { paxHostProblem, ROUTE_NAMES, settledRoute, TARGETS } from './target.js';
import { c, createUi } from './ui.js';
import { CURRENCIES, toCurrencyCode } from './currency.js';
import { DATA_SOURCE_IDS, modulesFromSources, parseDataFlags, UPLOAD_DIR } from './uploads.js';

/** @typedef {import('./target.js').Target} Target */

const COMMANDS = ['install', 'update', 'run', 'rerun-failed', 'check', 'refresh', 'status', 'rotate-secret', 'access', 'upload', 'deploy-app', 'uninstall', 'prereqs', 'preview'];

/**
 * The route the command line settles: --target, else the install record's route, else the route
 * that the route-specific flags given belong to. Throws when flags from both routes are given, or
 * flags that don't belong to the route.
 * @param {{ target?: Target, fabricFlags: string[], paxFlags: string[] }} args
 * @param {Target | undefined} settled  The install record's route, when it has started on one.
 * @returns {Target | undefined}
 */
export function routeFromFlags(args, settled) {
  const list = (/** @type {string[]} */ flags) => (flags.length > 1 ? `${flags.slice(0, -1).join(', ')} and ${flags[flags.length - 1]} are` : `${flags[0]} is`);
  const { fabricFlags, paxFlags } = args;
  if (fabricFlags.length && paxFlags.length) {
    throw new Error(`${list(fabricFlags)} for the ${ROUTE_NAMES.fabric} route and ${list(paxFlags)} for the ${ROUTE_NAMES.pax} route, so they can't go together.`);
  }
  const route = args.target ?? settled;
  const why = args.target ? `--target ${args.target}` : 'this install record';
  const so = (/** @type {string[]} */ flags) => (flags.length > 1 ? "so they don't" : "so it doesn't");
  if (route === 'pax' && fabricFlags.length) throw new Error(`${list(fabricFlags)} for the ${ROUTE_NAMES.fabric} route, ${so(fabricFlags)} go with ${why}.`);
  if (route === 'fabric' && paxFlags.length) throw new Error(`${list(paxFlags)} for the ${ROUTE_NAMES.pax} route, ${so(paxFlags)} go with ${why}.`);
  return route ?? (fabricFlags.length ? 'fabric' : paxFlags.length ? 'pax' : undefined);
}

/** The `--help` text, naming the command the way it was started. */
export const help = () => `Sets up ${PRODUCT.name}: its data, semantic model and report, on one of two routes.
  ${ROUTE_NAMES.fabric}: notebooks and a pipeline in a Fabric workspace load a Lakehouse each day.
  ${ROUTE_NAMES.pax}: a daily task on this Windows PC runs PAX and writes the data
    to a SharePoint folder, which the report and the app read.
The install record says which route an install is on, so the other commands need no flag.

Usage: ${commandLine('[command] [options]')}
       ${commandLine('--ui [options]')}

Commands:
  install          Set up ${PRODUCT.name}, or repair it from the install record (default)
  update           Push this checkout to the install: Fabric's notebooks, pipeline and semantic
                   model, or PAX's scripts on this PC, the report and the app
  run              Fabric: run the pipeline now, then the data check. PAX: run the refresh now
  rerun-failed     Fabric: run again only the loads that failed in the latest pipeline run
  check            Fabric: run the data check again, without the pipeline. PAX: check the app
                   can still write to the SharePoint folder
  refresh          Refresh the semantic model now
  status           Show recent runs and refreshes, the last data check and when secrets expire
  rotate-secret    Create new client secrets: Fabric's for Key Vault and the model's connection,
                   or PAX's in Credential Manager on this PC
  access           Who can view: the viewer group, its members and owners, and its Build on the model
  upload [files]   Upload files. Fabric: CSV exports to the drop folder (${UPLOAD_DIR}),
                   which the next run loads. PAX: any files to the SharePoint folder; the report
                   reads only the files the refresh writes there
  deploy-app       PAX: deploy the app, or deploy it again from this checkout's build
  uninstall        Fabric: delete the workspace's managed private endpoints, then the workspace.
                   PAX: remove the task, the app and the app's access to the site; SharePoint
                   keeps its files
  prereqs          Check the roles, licences, capacities and Azure access you have and lack.
                   Read-only; works before anything is installed. --target pax checks the
                   ${ROUTE_NAMES.pax} route's
  preview          Write what would be deployed to a folder, without signing in

Options:
  --ui                 Run the installer in your browser instead of the terminal, and choose
                       the command there. Only this computer can reach the page.
  --no-open            With --ui: print the link instead of opening the browser
  --config <file>      Install record (default ./${DEFAULT_CONFIG_FILE})
  --source <dir>       The repo folder to deploy from (default: this checkout)
  --tenant <id>        Tenant ID or domain to sign in to
  --target <target>    The route, fabric or pax. install asks when it's left out, and an install
                       record keeps the route it started on
  --device-code        Sign in with a code on another device instead of a browser. The default
                       in Azure Cloud Shell
  --use-az             Use the account you are signed in to with the Azure CLI. In Azure Cloud
                       Shell, run ${AZ_LOGIN} first
  --backfill-days <n>  With run: reload n days of audit history. Fabric rebuilds the curated
                       table; PAX adds the days to the SharePoint folder's files
  --out <dir>          With preview: where to write (default ./valuelens-preview)
  --yes                Take saved answers and defaults without asking. It never lets Fabric clear a
                       model's data: add --allow-model-reset for that
  --no-wait            Don't wait for the first load or a refresh to finish
  --verbose            Print each API call
  -h, --help           Show this help
  -v, --version        Show the version

${ROUTE_NAMES.fabric} route options. Without --target or an install record, they choose this route:
  --data <id=mode>     With install: how a source arrives, api, csv or skip. Repeat it or use
                       commas, e.g. --data productFeedback=flow,agent365=api. flow is the
                       Power Automate flow, the api mode of productFeedback.
                       Sources: ${DATA_SOURCE_IDS.join(', ')}
  --csv <file>         With install: an export to upload during the install. Repeat for more.
  --feedback-flow      With install: same as --data productFeedback=flow, the flow that saves
                       product feedback exports emailed to you (needs Power Automate Premium)
  --flow-environment <url>
                       With install: the Power Platform environment to create the flows in
  --flow-identity <user|app>
                       With install: who the flows write to OneLake as. user (default): a person
                       signs in to an HTTP with Microsoft Entra ID connection; no Key Vault.
                       app: the app registration, with its secret from Key Vault. The vault must
                       allow public network access.
  --arg-management-group <id>
                       With install: the Azure management group Resource Graph reads agents
                       and Foundry from (needs resourceGraph=api). Default: the whole tenant
  --no-arg-agents      With install: leave Copilot Studio agents out of Resource Graph
  --no-arg-foundry     With install: leave Foundry resources out of Resource Graph
  --currency <code>    With install: the currency the report shows money in, e.g. GBP. Default USD.
                       ${CURRENCIES.map((cur) => cur.code).join(', ')}
  --run                With upload: run the pipeline straight after, to load the files now
  --no-key-vault       With install: no Key Vault, the default for a new install. The client
                       secret goes in the notebooks, where anyone with a role in the workspace can
                       read it. Same as --secret-in-notebook.
  --key-vault          With install: keep the client secret in Azure Key Vault instead, so workspace
                       roles don't expose it. Needed with --yes to choose Key Vault for a new install.
  --secret-days <n>    With install or rotate-secret, and no Key Vault: how many days the secret in
                       the notebooks lasts, 1 to ${MAX_SECRET_DAYS} (default ${NOTEBOOK_SECRET_DAYS}). Each install, repair or update
                       replaces it.
  --allow-model-reset  With install, update or access: when Fabric can't update a model and keep its
                       data, clear the data and reload it without asking. Reports on that model show
                       no data until the reload finishes

${ROUTE_NAMES.pax} route options. Without --target or an install record, they choose this route:
  --environment-id <id>
                       With install or deploy-app: the Power Platform environment for a new app.
                       Default: the one the Power Apps CLI picks
  --folder <path>      With upload: a subfolder of the SharePoint folder to upload to, such as
                       Exports/2026. Missing folders are created
`;

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 */
export function parseCli(argv, env = process.env) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      source: { type: 'string' },
      tenant: { type: 'string' },
      target: { type: 'string' },
      'device-code': { type: 'boolean' },
      'use-az': { type: 'boolean' },
      'backfill-days': { type: 'string' },
      out: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      'no-wait': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      ui: { type: 'boolean' },
      'no-open': { type: 'boolean' },
      verbose: { type: 'boolean' },
      data: { type: 'string', multiple: true },
      csv: { type: 'string', multiple: true },
      'feedback-flow': { type: 'boolean' },
      'flow-environment': { type: 'string' },
      'flow-identity': { type: 'string' },
      'arg-management-group': { type: 'string' },
      'no-arg-agents': { type: 'boolean' },
      'no-arg-foundry': { type: 'boolean' },
      currency: { type: 'string' },
      run: { type: 'boolean' },
      'secret-in-notebook': { type: 'boolean' },
      'no-key-vault': { type: 'boolean' },
      'key-vault': { type: 'boolean' },
      'secret-days': { type: 'string' },
      'allow-model-reset': { type: 'boolean' },
      'environment-id': { type: 'string' },
      folder: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const command = values['dry-run'] ? 'preview' : positionals[0] ?? 'install';
  const files = command === 'upload' ? positionals.slice(1) : [];
  if (command !== 'upload' && positionals.length > 1) throw new Error(`Unexpected argument: ${positionals[1]}`);
  if (!COMMANDS.includes(command)) throw new Error(`Unknown command "${command}". Try --help.`);
  if (values.run && command !== 'upload') throw new Error('--run goes with upload.');
  const noVaultFlag = values['no-key-vault'] ? '--no-key-vault' : values['secret-in-notebook'] ? '--secret-in-notebook' : undefined;
  if (noVaultFlag && command !== 'install') throw new Error(`${noVaultFlag} goes with install.`);
  if (values['key-vault'] && command !== 'install') throw new Error('--key-vault goes with install.');
  if (values['key-vault'] && noVaultFlag) throw new Error(`--key-vault can't go with ${noVaultFlag}.`);
  /** @type {number | undefined} */
  let secretDays;
  if (values['secret-days'] !== undefined) {
    if (command !== 'install' && command !== 'rotate-secret') throw new Error('--secret-days goes with install or rotate-secret.');
    secretDays = Number(values['secret-days']);
    if (!Number.isInteger(secretDays) || secretDays < 1 || secretDays > MAX_SECRET_DAYS) throw new Error(`--secret-days must be a whole number from 1 to ${MAX_SECRET_DAYS}.`);
  }
  const installOnly = ['feedback-flow', 'flow-environment', 'flow-identity', 'arg-management-group', 'no-arg-agents', 'no-arg-foundry', 'currency'].filter((k) => values[/** @type {'feedback-flow'} */ (k)] !== undefined);
  if ((values.data?.length || values.csv?.length || installOnly.length) && !['install', 'preview'].includes(command)) {
    throw new Error(`--data, --csv${installOnly.map((k) => ` and --${k}`).join('')} go with install. To add exports later, use upload.`);
  }
  const identity = values['flow-identity'];
  if (identity !== undefined && identity !== 'user' && identity !== 'app') throw new Error('--flow-identity must be "user" or "app".');
  if (identity === 'app' && noVaultFlag) throw new Error(`--flow-identity app reads the secret from Key Vault, so it can't go with ${noVaultFlag}.`);
  const dataSources = parseDataFlags(values.data ?? []);
  const argManagementGroup = values['arg-management-group'] === undefined ? undefined : managementGroupId(values['arg-management-group']);
  if (argManagementGroup && !isManagementGroupId(argManagementGroup)) throw new Error('--arg-management-group should be a management group ID, as the Azure portal shows it under Management groups.');
  if (values['no-arg-agents'] && values['no-arg-foundry']) throw new Error('--no-arg-agents and --no-arg-foundry together leave Resource Graph nothing to read. Use --data resourceGraph=skip.');
  const currency = values.currency === undefined ? undefined : toCurrencyCode(values.currency);
  if (values.currency !== undefined && !currency) throw new Error(`--currency should be one of ${CURRENCIES.map((cur) => cur.code).join(', ')}.`);
  /** @type {string | undefined} */
  let flowEnvironment;
  if (values['flow-environment'] !== undefined) {
    try {
      flowEnvironment = orgUrl(values['flow-environment']);
    } catch {
      throw new Error('--flow-environment should be the environment URL, such as https://contoso.crm.dynamics.com.');
    }
  }
  if (values['device-code'] && values['use-az']) throw new Error('Choose one of --device-code and --use-az.');
  const cloudShell = inCloudShell(env);
  if (values.ui && cloudShell) throw new Error('Azure Cloud Shell can\'t open the installer\'s page in your browser. Leave out --ui to answer in the terminal.');
  const target = values.target;
  if (target !== undefined && !TARGETS.includes(/** @type {Target} */ (target))) throw new Error('--target must be "fabric" or "pax".');
  if (target === 'pax' && cloudShell) throw new Error(/** @type {string} */ (paxHostProblem({ platform: process.platform, cloudShell })));
  const environmentId = values['environment-id'];
  if (environmentId !== undefined) {
    if (command !== 'install' && command !== 'deploy-app') throw new Error('--environment-id goes with install or deploy-app.');
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(environmentId)) throw new Error('--environment-id should be the environment\'s ID, as the Power Platform admin center shows it, such as Default-<tenant ID>.');
  }
  if (values.folder !== undefined && command !== 'upload') throw new Error('--folder goes with upload.');
  const fabricFlags = [
    ...(values.data?.length ? ['--data'] : []),
    ...(values.csv?.length ? ['--csv'] : []),
    ...installOnly.map((k) => `--${k}`),
    ...(values.run ? ['--run'] : []),
    ...(noVaultFlag ? [noVaultFlag] : []),
    ...(values['key-vault'] ? ['--key-vault'] : []),
    ...(values['secret-days'] !== undefined ? ['--secret-days'] : []),
    ...(values['allow-model-reset'] ? ['--allow-model-reset'] : []),
  ];
  const paxFlags = [...(environmentId !== undefined ? ['--environment-id'] : []), ...(values.folder !== undefined ? ['--folder'] : [])];
  routeFromFlags({ target: /** @type {Target | undefined} */ (target), fabricFlags, paxFlags }, undefined);
  if (values.ui && (target !== undefined || paxFlags.length)) throw new Error('With --ui, choose where it runs on the page.');
  if (values.ui && (positionals.length || values['dry-run'])) throw new Error('--ui opens a home page where you choose what to do. Leave out the command.');
  if (values.ui && values.yes) throw new Error('Choose one of --ui and --yes.');
  if (values.ui && values.currency !== undefined) throw new Error('With --ui, choose the currency under Advanced settings.');
  if (values.ui && (values.data?.length || values.csv?.length || installOnly.length)) throw new Error('With --ui, choose data sources and exports on the Data sources page.');
  if (values['allow-model-reset'] && !['install', 'update', 'access'].includes(command)) throw new Error('--allow-model-reset goes with install, update or access.');
  if (values.ui && values['allow-model-reset']) throw new Error('With --ui, the page asks before a model\'s data is cleared. Leave out --allow-model-reset.');
  /** @type {number | undefined} */
  let backfillDays;
  if (values['backfill-days'] !== undefined) {
    backfillDays = Number(values['backfill-days']);
    if (!Number.isInteger(backfillDays) || backfillDays < 1 || backfillDays > 180) throw new Error('--backfill-days must be a whole number from 1 to 180.');
  }
  return {
    command,
    configFile: resolve(values.config ?? DEFAULT_CONFIG_FILE),
    sourceDir: values.source,
    tenantId: values.tenant,
    target: /** @type {Target | undefined} */ (target),
    environmentId,
    folder: values.folder,
    fabricFlags,
    paxFlags,
    // Cloud Shell has no browser to sign in with.
    method: /** @type {'browser' | 'device-code' | 'azure-cli'} */ (values['use-az'] ? 'azure-cli' : values['device-code'] || cloudShell ? 'device-code' : 'browser'),
    cloudShell,
    backfillDays,
    outDir: values.out ?? 'valuelens-preview',
    yes: !!values.yes,
    wait: !values['no-wait'],
    ui: !!values.ui,
    open: !values['no-open'],
    verbose: !!values.verbose,
    dataSources,
    csvFiles: values.csv ?? [],
    feedbackFlow: values['feedback-flow'],
    flowEnvironment,
    flowIdentity: /** @type {import('./config.js').FlowIdentity | undefined} */ (identity),
    argManagementGroup,
    argAgents: values['no-arg-agents'] ? false : undefined,
    argFoundry: values['no-arg-foundry'] ? false : undefined,
    currency,
    files,
    run: values.run,
    secretInNotebook: !!noVaultFlag,
    useKeyVault: !!values['key-vault'],
    secretDays,
    allowModelReset: !!values['allow-model-reset'],
    help: !!values.help,
    version: !!values.version,
  };
}

export const version = installerVersion;

/**
 * Applies --data, the flow flags and the currency to the install record's answers. The Data
 * sources screen then opens with them, and --yes takes them as they are.
 * @param {import('./config.js').InstallConfig} config
 * @param {{ dataSources: Partial<import('./uploads.js').DataSourceModes>, feedbackFlow?: boolean, flowEnvironment?: string, flowIdentity?: import('./config.js').FlowIdentity, argManagementGroup?: string, argAgents?: boolean, argFoundry?: boolean, currency?: string }} args
 */
export function applyDataFlags(config, args) {
  // --feedback-flow is from before the flow was its source's api mode: with csv (as the old docs had it) or alone, it means api.
  const feedback = args.feedbackFlow && args.dataSources.productFeedback !== 'skip' ? { productFeedback: /** @type {const} */ ('api') } : {};
  const sources = { ...args.dataSources, ...feedback };
  if (Object.keys(sources).length) {
    config.dataSources = { ...config.dataSources, ...sources };
    config.modules = modulesFromSources(config.dataSources);
  }
  if (args.flowEnvironment && args.flowEnvironment !== config.uploads.flowEnvironment?.url) config.uploads.flowEnvironment = { url: args.flowEnvironment };
  if (args.flowIdentity) config.uploads.flowIdentity = args.flowIdentity;
  if (args.argManagementGroup !== undefined || args.argAgents !== undefined || args.argFoundry !== undefined) {
    const rg = (config.resourceGraph = normaliseResourceGraph(config.resourceGraph));
    if (args.argManagementGroup !== undefined && args.argManagementGroup !== rg.managementGroup) {
      rg.managementGroup = args.argManagementGroup;
      delete rg.access;
    }
    if (args.argAgents !== undefined) rg.agents = args.argAgents;
    if (args.argFoundry !== undefined) rg.foundry = args.argFoundry;
  }
  if (args.currency) config.reporting = { currency: args.currency };
}

/**
 * When the install record's workspace is gone, offers to set the record aside and start fresh.
 * Only install can start fresh; other commands stop and say so.
 * @param {{ ui: import('./ui.js').Ui, config: import('./config.js').InstallConfig, file: string, fabric: { getWorkspace: (id: string) => Promise<any> }, tenantId?: string, command: string }} o
 * @returns {Promise<boolean>} whether the record was set aside
 */
export async function startFresh(o) {
  const gone = await recordWorkspaceGone({ config: o.config, fabric: o.fabric, tenantId: o.tenantId });
  if (!gone) return false;
  const why = staleRecordMessage(gone);
  if (o.command !== 'install') throw new Error(`${why} To start fresh, run install.`);
  if (o.ui.yes) throw new Error(`${why} To start fresh, run install without --yes.`);
  o.ui.warn(why);
  if (!(await o.ui.confirm('Start fresh? The old install record is kept beside the new one, renamed with the date and time.', true))) return false;
  o.ui.ok(`The old install record is now ${archiveConfig(o.file)}`);
  return true;
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} Exit code.
 */
export async function main(argv) {
  let verbose = false;
  try {
    const args = parseCli(argv);
    verbose = args.verbose;
    if (args.help) {
      process.stdout.write(help());
      return 0;
    }
    if (args.version) {
      process.stdout.write(`${version()}\n`);
      return 0;
    }
    const debug = verbose ? (/** @type {string} */ m) => process.stderr.write(`${c.dim(m)}\n`) : undefined;
    if (args.ui) {
      await runWizard({ configFile: args.configFile, sourceDir: args.sourceDir, tenantId: args.tenantId, method: args.method, open: args.open, version: version(), debug });
      return 0;
    }
    const ui = createUi({ yes: args.yes });
    const uploaded = args.cloudShell && args.command !== 'prereqs' ? adoptUploadedRecord(args.configFile) : undefined;
    const loaded = loadConfig(args.configFile);
    let config = loaded.config;
    const existed = loaded.existed;
    let target = routeFromFlags(args, settledRoute(config));
    if (target) config.target = target;
    const sources = loadSources(args.sourceDir);
    applyDataFlags(config, args);

    ui.line(c.bold(`${PRODUCT.name} installer ${version()}`));
    if (args.command === 'preview') {
      preview({ ui, config, sources, outDir: args.outDir });
      return 0;
    }
    if (args.command !== 'install' && args.command !== 'prereqs' && !existed) throw new Error(`No install record at ${args.configFile}. Run the installer first, or pass --config.`);
    if (uploaded) ui.note(`Moved the install record you uploaded from ${uploaded}.`);
    if (existed) ui.note(`Install record: ${args.configFile}`);
    else if (existsSync(join(dirname(args.configFile), AH_CONFIG_FILE))) {
      ui.note(`${AH_CONFIG_FILE} in this folder is the Analytics Hub installer's record. This installer leaves it, and what it set up, alone.`);
    }
    if (args.cloudShell && args.command !== 'prereqs') {
      ui.note('Azure Cloud Shell signs you out after 20 minutes without input. If that stops the installer, run the same command again: it carries on from the install record. --no-wait saves waiting for the first load.');
    }

    ui.note(args.method === 'azure-cli' ? 'Using your Azure CLI sign-in…' : 'Signing in…');
    const { api, user, getToken } = await connect({
      tenantId: args.tenantId ?? config.tenantId,
      method: args.method,
      ui,
      debug,
      checkTokens: args.cloudShell && args.method === 'azure-cli',
    });
    if (existed && args.command !== 'prereqs' && (await startFresh({ ui, config, file: args.configFile, fabric: api.fabric, tenantId: user.tenantId, command: args.command }))) {
      config = loadConfig(args.configFile).config;
      // The old record's route went with it.
      target = routeFromFlags(args, undefined);
      if (target) config.target = target;
      applyDataFlags(config, args);
    }
    const ctx = createCtx({ ui, config, file: args.configFile, api, user, sources, getToken });
    ctx.targetChosen = !!target;
    if (args.environmentId) ctx.environmentId = args.environmentId;
    ctx.csvFiles = args.csvFiles;
    if (args.secretInNotebook) ctx.secretInNotebook = true;
    if (args.useKeyVault) ctx.useKeyVault = true;
    if (args.allowModelReset) ctx.allowModelReset = true;
    if (args.secretDays) config.app.secretDays = args.secretDays;
    try {
      const ok = await runCommand(ctx, args.command, { wait: args.wait, backfillDays: args.backfillDays, files: args.files, run: args.run, folder: args.folder });
      return ok ? 0 : 1;
    } finally {
      // Also after a failure part way: the record is what lets the next run carry on.
      if (args.cloudShell && !cloudShellKeepsFiles() && existsSync(args.configFile)) ui.warn(cloudShellRecordMessage(args.configFile));
    }
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e?.name === 'ExitPromptError') {
      process.stderr.write('\nCancelled.\n');
      return 130;
    }
    if (isResumeLater(e)) {
      process.stderr.write(`\n${c.yellow('!')} ${e.message}\n`);
      return 0;
    }
    if (/device_code_expired|expired_token|code_expired/i.test(String(e?.message ?? e?.errorCode ?? ''))) {
      process.stderr.write(`\n${c.red('✗')} The sign-in code expired before it was used. Run the installer again and enter the new code within 15 minutes.\n`);
      return 1;
    }
    process.stderr.write(`\n${c.red('✗')} ${e?.message ?? String(err)}\n`);
    if (verbose && err instanceof HttpError && err.body) process.stderr.write(`${c.dim(JSON.stringify(err.body, null, 2))}\n`);
    else if (verbose && e?.stack) process.stderr.write(`${c.dim(e.stack)}\n`);
    return 1;
  }
}
