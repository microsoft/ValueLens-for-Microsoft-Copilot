// @ts-check
/** Command-line entry point. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { orgUrl } from './clients/dataverse.js';
import { DEFAULT_CONFIG_FILE, loadConfig, normaliseResourceGraph } from './config.js';
import { HttpError } from './http.js';
import { connect, createCtx, preview, runCommand } from './install.js';
import { commandLine } from './launch.js';
import { runWizard } from './server.js';
import { loadSources } from './sources.js';
import { isResumeLater } from './steps/identity.js';
import { isManagementGroupId, managementGroupId } from './steps/resource-graph.js';
import { isVivaId } from './transform/dataflow.js';
import { c, createUi } from './ui.js';
import { DATA_SOURCE_IDS, modulesFromSources, parseDataFlags } from './uploads.js';

const COMMANDS = ['install', 'update', 'run', 'rerun-failed', 'check', 'refresh', 'deploy-app', 'status', 'rotate-secret', 'upload', 'uninstall', 'prereqs', 'preview'];

/** The `--help` text, naming the command the way it was started. */
export const help = () => `Sets up Analytics Hub in Microsoft Fabric: the data pipeline, the semantic model and the app.

Usage: ${commandLine('[command] [options]')}
       ${commandLine('--ui [options]')}

Commands:
  install          Set up Analytics Hub, or repair it from the install record (default)
  update           Push the notebooks, pipeline and semantic model from this checkout to Fabric
  run              Run the pipeline now, then the data check
  rerun-failed     Run again only the loads that failed in the latest pipeline run
  check            Run the data check again, without the pipeline
  refresh          Refresh the semantic model now
  deploy-app       Deploy the Analytics Hub app again
  status           Show recent runs and refreshes, the last data check and when secrets expire
  rotate-secret    Create new client secrets for Key Vault and the model's connection
  upload [files]   Upload CSV exports to the drop folder (Files/analytics_hub_uploads)
  uninstall        Azure target only: remove the resource group if created, or only tagged resources
  prereqs          Check the roles, licences, capacities and Azure access you have and lack.
                   Read-only; works before anything is installed
  preview          Write what would be deployed to a folder, without signing in

Options:
  --ui                 Run the installer in your browser instead of the terminal, and choose
                       the command there. Only this computer can reach the page.
  --no-open            With --ui: print the link instead of opening the browser
  --config <file>      Install record (default ./${DEFAULT_CONFIG_FILE})
  --source <dir>       The "1. Fabric" folder to deploy from (default: this checkout)
  --tenant <id>        Tenant ID or domain to sign in to
  --target <target>    Where Analytics Hub runs: fabric (default) or azure
  --device-code        Sign in with a code on another device instead of a browser
  --use-az             Use the account you are signed in to with the Azure CLI
  --backfill-days <n>  With run: reload n days of audit history and rebuild the curated table
  --out <dir>          With preview: where to write (default ./valuelens-preview)
  --data <id=mode>     With install: how a source arrives, api, csv or skip. Repeat it or use
                       commas, e.g. --data productFeedback=flow,agent365=api. flow is the
                       Power Automate flow, the api mode of productFeedback and studioCredits.
                       Sources: ${DATA_SOURCE_IDS.join(', ')}
  --csv <file>         With install: an export to upload during the install. Repeat for more.
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
                       allow public network access.
  --viva-partition <id>
  --viva-query <id>    With install: the Viva Insights partition and query the Cowork credits
                       Dataflow reads (needs coworkCredits=api)
  --arg-management-group <id>
                       With install: the Azure management group Resource Graph reads agents
                       and Foundry from (needs resourceGraph=api). Default: the whole tenant
  --no-arg-agents      With install: leave Copilot Studio agents out of Resource Graph
  --no-arg-foundry     With install: leave Foundry resources out of Resource Graph
  --run                 With upload: run the pipeline straight after, to load the files now
  --secret-in-notebook With install: store the client secret in plain text in the notebooks instead
                       of Key Vault. Not recommended: for quick tests only. Needed with --yes.
  --yes                Take saved answers and defaults without asking
  --no-wait            Don't wait for the first load or a refresh to finish
  --verbose            Print each API call
  -h, --help           Show this help
  -v, --version        Show the version
`;

/**
 * @param {string[]} argv
 */
export function parseCli(argv) {
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
      run: { type: 'boolean' },
      'secret-in-notebook': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const command = values['dry-run'] ? 'preview' : positionals[0] ?? 'install';
  const files = command === 'upload' ? positionals.slice(1) : [];
  if (command !== 'upload' && positionals.length > 1) throw new Error(`Unexpected argument: ${positionals[1]}`);
  if (!COMMANDS.includes(command)) throw new Error(`Unknown command "${command}". Try --help.`);
  if (values.run && command !== 'upload') throw new Error('--run goes with upload.');
  if (values['secret-in-notebook'] && command !== 'install') throw new Error('--secret-in-notebook goes with install.');
  if (values['secret-in-notebook'] && values.target === 'azure') throw new Error('--secret-in-notebook is for the Fabric target only.');
  const installOnly = ['feedback-flow', 'studio-flow', 'flow-environment', 'flow-identity', 'viva-partition', 'viva-query', 'arg-management-group', 'no-arg-agents', 'no-arg-foundry'].filter((k) => values[/** @type {'feedback-flow'} */ (k)] !== undefined);
  if ((values.data?.length || values.csv?.length || installOnly.length) && !['install', 'preview'].includes(command)) {
    throw new Error(`--data, --csv${installOnly.map((k) => ` and --${k}`).join('')} go with install. To add exports later, use upload.`);
  }
  const identity = values['flow-identity'];
  if (identity !== undefined && identity !== 'user' && identity !== 'app') throw new Error('--flow-identity must be "user" or "app".');
  if (identity === 'app' && values['secret-in-notebook']) throw new Error('--flow-identity app reads the secret from Key Vault, so it can\'t go with --secret-in-notebook.');
  const dataSources = parseDataFlags(values.data ?? []);
  for (const k of /** @type {const} */ (['viva-partition', 'viva-query'])) {
    if (values[k] !== undefined && !isVivaId(values[k])) throw new Error(`--${k} should be a GUID, as Viva Insights shows it.`);
  }
  const argManagementGroup = values['arg-management-group'] === undefined ? undefined : managementGroupId(values['arg-management-group']);
  if (argManagementGroup && !isManagementGroupId(argManagementGroup)) throw new Error('--arg-management-group should be a management group ID, as the Azure portal shows it under Management groups.');
  if (values['no-arg-agents'] && values['no-arg-foundry']) throw new Error('--no-arg-agents and --no-arg-foundry together leave Resource Graph nothing to read. Use --data resourceGraph=skip.');
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
  if (values.target !== undefined && values.target !== 'fabric' && values.target !== 'azure') throw new Error('--target must be "fabric" or "azure".');
  if (values.ui && (positionals.length || values['dry-run'])) throw new Error('--ui opens a home page where you choose what to do. Leave out the command.');
  if (values.ui && values.yes) throw new Error('Choose one of --ui and --yes.');
  if (values.ui && (values.data?.length || values.csv?.length || installOnly.length)) throw new Error('With --ui, choose data sources and exports on the Data sources page.');
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
    method: /** @type {'browser' | 'device-code' | 'azure-cli'} */ (values['use-az'] ? 'azure-cli' : values['device-code'] ? 'device-code' : 'browser'),
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
    files,
    run: values.run,
    secretInNotebook: !!values['secret-in-notebook'],
    help: !!values.help,
    version: !!values.version,
  };
}

export function version() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return String(pkg.version);
}

/**
 * Applies --data, the flow flags and the Viva IDs to the install record's answers. The Data
 * sources screen then opens with them, and --yes takes them as they are.
 * @param {import('./config.js').InstallConfig} config
 * @param {{ dataSources: Partial<import('./uploads.js').DataSourceModes>, feedbackFlow?: boolean, studioFlow?: boolean, flowEnvironment?: string, flowIdentity?: import('./config.js').FlowIdentity, vivaPartition?: string, vivaQuery?: string, argManagementGroup?: string, argAgents?: boolean, argFoundry?: boolean }} args
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
    const { config, existed } = loadConfig(args.configFile);
    if (args.target) config.target = args.target;
    const sources = loadSources(args.sourceDir);
    applyDataFlags(config, args);

    ui.line(c.bold(`Analytics Hub installer ${version()}`));
    if (args.command === 'preview') {
      preview({ ui, config, sources, outDir: args.outDir });
      return 0;
    }
    if (args.command !== 'install' && args.command !== 'prereqs' && !existed) throw new Error(`No install record at ${args.configFile}. Run the installer first, or pass --config.`);
    if (existed) ui.note(`Install record: ${args.configFile}`);

    ui.note(args.method === 'azure-cli' ? 'Using your Azure CLI sign-in…' : 'Signing in…');
    const { api, user } = await connect({
      tenantId: args.tenantId ?? config.tenantId,
      method: args.method,
      ui,
      debug,
    });
    const ctx = createCtx({ ui, config, file: args.configFile, api, user, sources });
    ctx.csvFiles = args.csvFiles;
    if (args.secretInNotebook) ctx.secretInNotebook = true;
    const ok = await runCommand(ctx, args.command, { wait: args.wait, backfillDays: args.backfillDays, files: args.files, run: args.run });
    return ok ? 0 : 1;
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
