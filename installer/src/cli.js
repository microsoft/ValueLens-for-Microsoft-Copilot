// @ts-check
/** Command-line entry point. */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AZ_LOGIN } from './auth.js';
import { orgUrl } from './clients/dataverse.js';
import { archiveConfig, DEFAULT_CONFIG_FILE, loadConfig, normaliseResourceGraph } from './config.js';
import { HttpError } from './http.js';
import { connect, createCtx, preview, runCommand } from './install.js';
import { adoptUploadedRecord, cloudShellKeepsFiles, cloudShellRecordMessage, commandLine, inCloudShell } from './launch.js';
import { runWizard } from './server.js';
import { loadSources } from './sources.js';
import { azureUploadError } from './steps/data-sources.js';
import { recordWorkspaceGone, staleRecordMessage } from './steps/fabric.js';
import { isResumeLater, MAX_SECRET_DAYS, NOTEBOOK_SECRET_DAYS } from './steps/identity.js';
import { isManagementGroupId, managementGroupId } from './steps/resource-graph.js';
import { isVivaId } from './transform/dataflow.js';
import { c, createUi } from './ui.js';
import { CURRENCIES, DEFAULT_CURRENCY, parseRate, toCurrencyCode } from './currency.js';
import { DATA_SOURCE_IDS, modulesFromSources, parseDataFlags } from './uploads.js';

const COMMANDS = ['install', 'update', 'run', 'rerun-failed', 'load-cowork', 'check', 'refresh', 'deploy-app', 'status', 'rotate-secret', 'access', 'upload', 'uninstall', 'prereqs', 'preview'];

/** The `--help` text, naming the command the way it was started. */
export const help = () => `Sets up Analytics Hub in Microsoft Fabric: the data pipeline, the semantic model and the app.

Usage: ${commandLine('[command] [options]')}
       ${commandLine('--ui [options]')}

Commands:
  install          Set up Analytics Hub, or repair it from the install record (default)
  update           Push the notebooks, pipeline and semantic model from this checkout to Fabric
  run              Run the pipeline now, then the data check
  rerun-failed     Run again only the loads that failed in the latest pipeline run
  load-cowork      Once the Cowork Dataflow is signed in: refresh it, load the Viva credits
                   and refresh the consumption model. Fabric only
  check            Run the data check again, without the pipeline
  refresh          Refresh the semantic model now
  deploy-app       Deploy the Analytics Hub app again
  status           Show recent runs and refreshes, the last data check and when secrets expire
  rotate-secret    Create new client secrets for Key Vault and the model's connection
  access           Who can view: the viewer group, its members and owners, and its Build on the models
  upload [files]   Upload CSV exports to the drop folder (Files/analytics_hub_uploads). Fabric only
  uninstall        Azure: remove the resource group if created, or only tagged resources. Fabric: delete
                   the workspace's managed private endpoints, then the workspace. On Azure, it also
                   deletes the Power BI workspace if created, and waits for the resource group to go
  prereqs          Check the roles, licences, capacities and Azure access you have and lack.
                   Read-only; works before anything is installed
  preview          Write what would be deployed to a folder, without signing in

Options:
  --ui                 Run the installer in your browser instead of the terminal, and choose
                       the command there. Only this computer can reach the page.
  --no-open            With --ui: print the link instead of opening the browser
  --config <file>      Install record (default ./${DEFAULT_CONFIG_FILE})
  --source <dir>       The repo folder to deploy from (default: this checkout)
  --tenant <id>        Tenant ID or domain to sign in to
  --target <target>    Where Analytics Hub runs: fabric (default) or azure
  --device-code        Sign in with a code on another device instead of a browser. The default
                       in Azure Cloud Shell
  --use-az             Use the account you are signed in to with the Azure CLI. In Azure Cloud
                       Shell, run ${AZ_LOGIN} first
  --backfill-days <n>  With run: reload n days of audit history and rebuild the curated table
  --out <dir>          With preview: where to write (default ./valuelens-preview)
  --data <id=mode>     With install: how a source arrives, api, csv or skip. Repeat it or use
                       commas, e.g. --data productFeedback=flow,agent365=api. flow is the
                       Power Automate flow, the api mode of productFeedback and studioCredits.
                       Sources: ${DATA_SOURCE_IDS.join(', ')}
  --csv <file>         With install: an export to upload during the install. Repeat for more.
                       Fabric only: on Azure, put exports in the landing folders yourself
  --feedback-flow      With install: same as --data productFeedback=flow, the flow that saves
                       product feedback exports emailed to you (needs Power Automate Premium)
  --studio-flow        With install: same as --data studioCredits=api, the daily flow that reads
                       Copilot Studio credits from the licensing API
  --flow-environment <url>
                       With install: the Power Platform environment to create the flows in
  --flow-identity <user|app>
                       With install: who the flows write to OneLake as. user (default): a person
                       signs in to an HTTP with Microsoft Entra ID connection; no Key Vault.
                       app: the app registration, with its secret from Key Vault. The vault must
                       allow public network access. Fabric only: on Azure the Studio flow
                       always signs in as you.
  --viva-partition <id>
  --viva-query <id>    With install: the Viva Insights partition and query the Cowork credits
                       Dataflow reads (needs coworkCredits=api). Fabric only: on Azure, Cowork
                       credits come from the Consumption Dashboard's CSV export
  --arg-management-group <id>
                       With install: the Azure management group Resource Graph reads agents
                       and Foundry from (needs resourceGraph=api). Default: the whole tenant
  --no-arg-agents      With install: leave Copilot Studio agents out of Resource Graph
  --no-arg-foundry     With install: leave Foundry resources out of Resource Graph
  --currency <code>    With install: the currency the Value page reports in, e.g. GBP. Default USD.
                       ${CURRENCIES.map((cur) => cur.code).join(', ')}
  --exchange-rate <n>  With --currency: how many of it to 1 US dollar, e.g. 0.79. Without it,
                       set the rate under Prices in the app
  --run                 With upload: run the pipeline straight after, to load the files now
  --no-key-vault       With install: no Key Vault, the default for a new Fabric install. The client
                       secret goes in the notebooks, where anyone with a role in the workspace can
                       read it. Same as --secret-in-notebook.
  --key-vault          With install: keep the client secret in Azure Key Vault instead, so workspace
                       roles don't expose it. Needed with --yes to choose Key Vault for a new install.
  --secret-days <n>    With install or rotate-secret, and no Key Vault: how many days the secret in
                       the notebooks lasts, 1 to ${MAX_SECRET_DAYS} (default ${NOTEBOOK_SECRET_DAYS}). Each install, repair or update
                       replaces it.
  --yes                Take saved answers and defaults without asking. It never lets Fabric clear a
                       model's data: add --allow-model-reset for that
  --allow-model-reset  With install, update or access: when Fabric can't update a model and keep its
                       data, clear the data and reload it without asking. Reports on that model show
                       no data until the reload finishes
  --no-wait            Don't wait for the first load or a refresh to finish, or for Azure to delete
                       the resource group on uninstall
  --verbose            Print each API call
  -h, --help           Show this help
  -v, --version        Show the version
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
      'studio-flow': { type: 'boolean' },
      'flow-environment': { type: 'string' },
      'flow-identity': { type: 'string' },
      'viva-partition': { type: 'string' },
      'viva-query': { type: 'string' },
      'arg-management-group': { type: 'string' },
      'no-arg-agents': { type: 'boolean' },
      'no-arg-foundry': { type: 'boolean' },
      currency: { type: 'string' },
      'exchange-rate': { type: 'string' },
      run: { type: 'boolean' },
      'secret-in-notebook': { type: 'boolean' },
      'no-key-vault': { type: 'boolean' },
      'key-vault': { type: 'boolean' },
      'secret-days': { type: 'string' },
      'allow-model-reset': { type: 'boolean' },
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
  if (noVaultFlag && values.target === 'azure') throw new Error(`${noVaultFlag} is for the Fabric target only.`);
  if (values['key-vault'] && command !== 'install') throw new Error('--key-vault goes with install.');
  if (values['key-vault'] && values.target === 'azure') throw new Error('--key-vault is for the Fabric target only.');
  if (values['key-vault'] && noVaultFlag) throw new Error(`--key-vault can't go with ${noVaultFlag}.`);
  /** @type {number | undefined} */
  let secretDays;
  if (values['secret-days'] !== undefined) {
    if (command !== 'install' && command !== 'rotate-secret') throw new Error('--secret-days goes with install or rotate-secret.');
    if (values.target === 'azure') throw new Error('--secret-days is for the Fabric target only.');
    secretDays = Number(values['secret-days']);
    if (!Number.isInteger(secretDays) || secretDays < 1 || secretDays > MAX_SECRET_DAYS) throw new Error(`--secret-days must be a whole number from 1 to ${MAX_SECRET_DAYS}.`);
  }
  const installOnly = ['feedback-flow', 'studio-flow', 'flow-environment', 'flow-identity', 'viva-partition', 'viva-query', 'arg-management-group', 'no-arg-agents', 'no-arg-foundry', 'currency', 'exchange-rate'].filter((k) => values[/** @type {'feedback-flow'} */ (k)] !== undefined);
  if ((values.data?.length || values.csv?.length || installOnly.length) && !['install', 'preview'].includes(command)) {
    throw new Error(`--data, --csv${installOnly.map((k) => ` and --${k}`).join('')} go with install. To add exports later, use upload.`);
  }
  const identity = values['flow-identity'];
  if (identity !== undefined && identity !== 'user' && identity !== 'app') throw new Error('--flow-identity must be "user" or "app".');
  if (identity === 'app' && noVaultFlag) throw new Error(`--flow-identity app reads the secret from Key Vault, so it can't go with ${noVaultFlag}.`);
  const dataSources = parseDataFlags(values.data ?? []);
  for (const k of /** @type {const} */ (['viva-partition', 'viva-query'])) {
    if (values[k] !== undefined && !isVivaId(values[k])) throw new Error(`--${k} should be a GUID, as Viva Insights shows it.`);
  }
  const argManagementGroup = values['arg-management-group'] === undefined ? undefined : managementGroupId(values['arg-management-group']);
  if (argManagementGroup && !isManagementGroupId(argManagementGroup)) throw new Error('--arg-management-group should be a management group ID, as the Azure portal shows it under Management groups.');
  if (values['no-arg-agents'] && values['no-arg-foundry']) throw new Error('--no-arg-agents and --no-arg-foundry together leave Resource Graph nothing to read. Use --data resourceGraph=skip.');
  const currency = values.currency === undefined ? undefined : toCurrencyCode(values.currency);
  if (values.currency !== undefined && !currency) throw new Error(`--currency should be one of ${CURRENCIES.map((cur) => cur.code).join(', ')}.`);
  /** @type {number | undefined} */
  let exchangeRate;
  if (values['exchange-rate'] !== undefined) {
    if (!currency) throw new Error('--exchange-rate goes with --currency, e.g. --currency GBP --exchange-rate 0.79.');
    if (currency === DEFAULT_CURRENCY) throw new Error('Licences and credits are billed in US dollars, so USD needs no --exchange-rate.');
    const rate = parseRate(values['exchange-rate']);
    if (typeof rate !== 'number') throw new Error(`--exchange-rate: ${typeof rate === 'string' ? rate : 'Type a number above 0.'}`);
    exchangeRate = rate;
  }
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
  if (values.target !== undefined && values.target !== 'fabric' && values.target !== 'azure') throw new Error('--target must be "fabric" or "azure".');
  if (values.ui && (positionals.length || values['dry-run'])) throw new Error('--ui opens a home page where you choose what to do. Leave out the command.');
  if (values.ui && values.yes) throw new Error('Choose one of --ui and --yes.');
  if (values.ui && (values.currency !== undefined || values['exchange-rate'] !== undefined)) throw new Error('With --ui, choose the currency under Advanced settings.');
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
    target: /** @type {'fabric' | 'azure' | undefined} */ (values.target),
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
    studioFlow: values['studio-flow'],
    flowEnvironment,
    flowIdentity: /** @type {import('./config.js').FlowIdentity | undefined} */ (identity),
    vivaPartition: values['viva-partition']?.trim(),
    vivaQuery: values['viva-query']?.trim(),
    argManagementGroup,
    argAgents: values['no-arg-agents'] ? false : undefined,
    argFoundry: values['no-arg-foundry'] ? false : undefined,
    currency,
    exchangeRate,
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

export function version() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return String(pkg.version);
}

/**
 * Applies --data, the flow flags, the Viva IDs and the currency to the install record's answers. The
 * Data sources screen then opens with them, and --yes takes them as they are.
 * @param {import('./config.js').InstallConfig} config
 * @param {{ dataSources: Partial<import('./uploads.js').DataSourceModes>, feedbackFlow?: boolean, studioFlow?: boolean, flowEnvironment?: string, flowIdentity?: import('./config.js').FlowIdentity, vivaPartition?: string, vivaQuery?: string, argManagementGroup?: string, argAgents?: boolean, argFoundry?: boolean, currency?: string, exchangeRate?: number }} args
 */
export function applyDataFlags(config, args) {
  // --studio-flow and --feedback-flow are from before each flow was its source's api mode: with csv (as the old docs had it) or alone, they mean api.
  const studio = args.studioFlow && args.dataSources.studioCredits !== 'skip' ? { studioCredits: /** @type {const} */ ('api') } : {};
  const feedback = args.feedbackFlow && args.dataSources.productFeedback !== 'skip' ? { productFeedback: /** @type {const} */ ('api') } : {};
  const sources = { ...args.dataSources, ...studio, ...feedback };
  if (Object.keys(sources).length) {
    config.dataSources = { ...config.dataSources, ...sources };
    config.modules = modulesFromSources(config.dataSources);
  }
  if (args.flowEnvironment && args.flowEnvironment !== config.uploads.flowEnvironment?.url) config.uploads.flowEnvironment = { url: args.flowEnvironment };
  if (args.flowIdentity) config.uploads.flowIdentity = args.flowIdentity;
  if (args.vivaPartition) config.consumption.vivaPartition = args.vivaPartition;
  if (args.vivaQuery) config.consumption.vivaQuery = args.vivaQuery;
  if (args.argManagementGroup !== undefined || args.argAgents !== undefined || args.argFoundry !== undefined) {
    const rg = (config.resourceGraph = normaliseResourceGraph(config.resourceGraph));
    if (args.argManagementGroup !== undefined && args.argManagementGroup !== rg.managementGroup) {
      rg.managementGroup = args.argManagementGroup;
      delete rg.access;
      delete rg.azureAccess;
    }
    if (args.argAgents !== undefined) rg.agents = args.argAgents;
    if (args.argFoundry !== undefined) rg.foundry = args.argFoundry;
  }
  if (args.currency) {
    // A saved rate for the same currency stays unless a new one is given.
    const rate = args.exchangeRate ?? (config.reporting?.currency === args.currency ? config.reporting.exchangeRate : undefined);
    config.reporting = args.currency !== DEFAULT_CURRENCY && rate ? { currency: args.currency, exchangeRate: rate } : { currency: args.currency };
  }
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
    if (args.target) config.target = args.target;
    if (args.csvFiles.length && config.target === 'azure') throw azureUploadError(config, '--csv');
    const sources = loadSources(args.sourceDir);
    applyDataFlags(config, args);

    ui.line(c.bold(`Analytics Hub installer ${version()}`));
    if (args.command === 'preview') {
      preview({ ui, config, sources, outDir: args.outDir });
      return 0;
    }
    if (args.command !== 'install' && args.command !== 'prereqs' && !existed) throw new Error(`No install record at ${args.configFile}. Run the installer first, or pass --config.`);
    if (uploaded) ui.note(`Moved the install record you uploaded from ${uploaded}.`);
    if (existed) ui.note(`Install record: ${args.configFile}`);
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
      if (args.target) config.target = args.target;
      applyDataFlags(config, args);
    }
    const ctx = createCtx({ ui, config, file: args.configFile, api, user, sources, getToken });
    ctx.csvFiles = args.csvFiles;
    if (args.secretInNotebook) ctx.secretInNotebook = true;
    if (args.useKeyVault) ctx.useKeyVault = true;
    if (args.allowModelReset) ctx.allowModelReset = true;
    if (args.secretDays) config.app.secretDays = args.secretDays;
    try {
      const ok = await runCommand(ctx, args.command, { wait: args.wait, backfillDays: args.backfillDays, files: args.files, run: args.run });
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
