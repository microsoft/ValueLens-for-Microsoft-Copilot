// @ts-check
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { permissionsFor } from '../src/catalog.js';
import { help, parseCli } from '../src/cli.js';
import { allowsAction, armLocation, parseResourceId, validateVaultName } from '../src/clients/azure.js';
import { notebookDefinition, notebookJobParameters, scheduleBody } from '../src/clients/fabric.js';
import { resolveAppRoles } from '../src/clients/graph.js';
import { emptyConfig, loadConfig, saveConfig } from '../src/config.js';
import { commandLine, EXE_ENV, fromExe, installerWindow } from '../src/launch.js';
import { describeSchedule, sameSchedule } from '../src/steps/fabric.js';
import { addMonths } from '../src/steps/identity.js';
import { jobIdFrom, utc } from '../src/steps/run.js';
import { formatDuration } from '../src/ui.js';

const dir = mkdtempSync(join(tmpdir(), 'vl-installer-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('allowsAction handles wildcards, notActions and data actions', () => {
  const owner = [{ actions: ['*'], notActions: [] }];
  const contributor = [{ actions: ['*'], notActions: ['Microsoft.Authorization/*/Write', 'Microsoft.Authorization/*/Delete'] }];
  const write = 'Microsoft.Authorization/roleAssignments/write';
  assert.equal(allowsAction(owner, write), true);
  assert.equal(allowsAction(contributor, write), false);
  assert.equal(allowsAction(contributor, 'Microsoft.KeyVault/vaults/write'), true);

  const setSecret = 'Microsoft.KeyVault/vaults/secrets/setSecret/action';
  const officer = [{ dataActions: ['Microsoft.KeyVault/vaults/secrets/*'], notDataActions: [] }];
  const reader = [{ dataActions: ['Microsoft.KeyVault/vaults/secrets/readMetadata/action'] }];
  const blocked = [{ dataActions: ['*'], notDataActions: ['Microsoft.KeyVault/vaults/secrets/setSecret/action'] }];
  assert.equal(allowsAction(officer, setSecret, 'dataActions'), true);
  assert.equal(allowsAction(reader, setSecret, 'dataActions'), false);
  assert.equal(allowsAction(blocked, setSecret, 'dataActions'), false);
  assert.equal(allowsAction(owner, setSecret, 'dataActions'), false, 'control-plane * is not a data action');
});

test('Key Vault names, regions and resource IDs', () => {
  assert.equal(validateVaultName('kv-valuelens-01'), true);
  assert.notEqual(validateVaultName('1kv'), true);
  assert.notEqual(validateVaultName('kv'), true);
  assert.notEqual(validateVaultName('kv--valuelens'), true);
  assert.notEqual(validateVaultName('kv-valuelens-'), true);
  assert.notEqual(validateVaultName('a'.repeat(25)), true);

  assert.equal(armLocation('UK South'), 'uksouth');
  assert.equal(armLocation('westeurope'), 'westeurope');

  assert.deepEqual(parseResourceId('/subscriptions/s1/resourceGroups/rg-1/providers/Microsoft.KeyVault/vaults/kv1'), {
    subscriptionId: 's1',
    resourceGroup: 'rg-1',
    type: 'Microsoft.KeyVault/vaults',
    name: 'kv1',
  });
  assert.throws(() => parseResourceId('/subscriptions/s1'), /Not a resource ID/);
});

test('resolveAppRoles: required permissions must exist, optional ones are reported', () => {
  const sp = { appRoles: [{ id: 'r1', value: 'AuditLogsQuery.Read.All' }, { id: 'r2', value: 'User.Read.All' }] };
  assert.deepEqual(resolveAppRoles(sp, ['AuditLogsQuery.Read.All', 'User.Read.All']), {
    roles: [
      { value: 'AuditLogsQuery.Read.All', id: 'r1' },
      { value: 'User.Read.All', id: 'r2' },
    ],
    missing: [],
  });
  const withOptional = resolveAppRoles(sp, ['CopilotPackages.Read.All', 'User.Read.All'], ['CopilotPackages.Read.All']);
  assert.deepEqual(withOptional.missing, ['CopilotPackages.Read.All']);
  assert.deepEqual(withOptional.roles, [{ value: 'User.Read.All', id: 'r2' }]);
  assert.throws(() => resolveAppRoles(sp, ['Reports.Read.All']), /no application permission named Reports\.Read\.All/);
});

test('permissions follow the chosen modules', () => {
  assert.deepEqual(permissionsFor({ orgData: false, m365Activity: false, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false }), [
    'AuditLogsQuery.Read.All',
    'Reports.Read.All',
    'User.Read.All',
  ]);
  assert.deepEqual(permissionsFor({ orgData: true, m365Activity: false, agent365: true, productFeedback: true, consumption: false, agentEvaluator: false }), [
    'Application.Read.All',
    'AuditLogsQuery.Read.All',
    'CopilotPackages.Read.All',
    'Reports.Read.All',
    'User.Read.All',
  ]);
});

test('schedule body starts tomorrow and is compared on what matters', () => {
  const now = new Date('2026-03-31T22:15:00Z');
  const daily = scheduleBody({ frequency: 'daily', time: '02:00', weekday: 'Sunday', timeZone: 'GMT Standard Time' }, now);
  assert.deepEqual(daily, {
    enabled: true,
    configuration: {
      startDateTime: '2026-04-01T00:00:00',
      endDateTime: '2036-03-31T00:00:00',
      localTimeZoneId: 'GMT Standard Time',
      type: 'Daily',
      times: ['02:00'],
    },
  });
  const weekly = scheduleBody({ frequency: 'weekly', time: '06:30', weekday: 'Monday', timeZone: 'UTC' }, now);
  assert.deepEqual(weekly.configuration.weekdays, ['Monday']);
  assert.equal(weekly.configuration.type, 'Weekly');

  const fromApi = { id: 's', enabled: true, owner: {}, configuration: { ...daily.configuration, startDateTime: '2025-01-01T00:00:00' } };
  assert.equal(sameSchedule(fromApi, daily), true, 'start date is ignored');
  assert.equal(sameSchedule({ ...fromApi, enabled: false }, daily), false);
  assert.equal(sameSchedule({ ...fromApi, configuration: { ...fromApi.configuration, times: ['03:00'] } }, daily), false);
  assert.equal(sameSchedule({ ...fromApi, configuration: { ...weekly.configuration, weekdays: ['Friday'] } }, weekly), false);
  assert.equal(describeSchedule({ frequency: 'weekly', time: '06:30', weekday: 'Monday', timeZone: 'UTC' }), 'every Monday at 06:30 UTC');
  assert.equal(describeSchedule({ frequency: 'daily', time: '02:00', weekday: 'Sunday', timeZone: 'UTC' }), 'daily at 02:00 UTC');
});

test('Fabric definitions and job parameters', () => {
  const def = notebookDefinition('{"cells":[]}');
  assert.equal(def.format, 'ipynb');
  assert.equal(def.parts[0].path, 'notebook-content.ipynb');
  assert.equal(Buffer.from(def.parts[0].payload, 'base64').toString('utf8'), '{"cells":[]}');
  assert.deepEqual(notebookJobParameters({ MODE: 'backfill', DAYS: 30, RATE: 0.5, ON: true }), {
    MODE: { value: 'backfill', type: 'string' },
    DAYS: { value: 30, type: 'int' },
    RATE: { value: 0.5, type: 'float' },
    ON: { value: true, type: 'bool' },
  });
});

test('job helpers read Fabric times as UTC and take the job ID from its URL', () => {
  assert.equal(utc('2026-05-01T02:00:13.123')?.toISOString(), '2026-05-01T02:00:13.123Z');
  assert.equal(utc('2026-05-01T02:00:13Z')?.toISOString(), '2026-05-01T02:00:13.000Z');
  assert.equal(utc('2026-05-01T03:00:13+01:00')?.toISOString(), '2026-05-01T02:00:13.000Z');
  assert.equal(utc(null), undefined);
  assert.equal(jobIdFrom('https://api.fabric.microsoft.com/v1/workspaces/w/items/i/jobs/instances/j-123'), 'j-123');
  assert.equal(jobIdFrom('/workspaces/w/items/i/jobs/instances/j-9/'), 'j-9');
});

test('addMonths and formatDuration', () => {
  assert.equal(addMonths(new Date('2026-01-15T10:00:00Z'), 12).toISOString(), '2027-01-15T10:00:00.000Z');
  assert.equal(formatDuration(4_000), '4s');
  assert.equal(formatDuration(125_000), '2m 05s');
  assert.equal(formatDuration(3_780_000), '1h 03m');
});

test('parseCli: commands, sign-in methods and validation', () => {
  const d = parseCli([]);
  assert.equal(d.command, 'install');
  assert.equal(d.method, 'browser');
  assert.equal(d.wait, true);
  assert.equal(d.yes, false);
  assert.match(d.configFile, /valuelens-install\.json$/);

  const r = parseCli(['run', '--backfill-days', '30', '--use-az', '-y', '--no-wait', '--config', 'x.json']);
  assert.equal(r.command, 'run');
  assert.equal(r.backfillDays, 30);
  assert.equal(r.method, 'azure-cli');
  assert.equal(r.yes, true);
  assert.equal(r.wait, false);
  assert.match(r.configFile, /x\.json$/);

  assert.equal(parseCli(['--dry-run']).command, 'preview');
  assert.equal(parseCli(['check']).command, 'check');
  assert.equal(parseCli(['--device-code']).method, 'device-code');
  assert.throws(() => parseCli(['nope']), /Unknown command "nope"/);
  assert.throws(() => parseCli(['run', 'extra']), /Unexpected argument: extra/);
  assert.throws(() => parseCli(['--device-code', '--use-az']), /Choose one/);
  assert.throws(() => parseCli(['run', '--backfill-days', '0']), /1 to 180/);
  assert.throws(() => parseCli(['run', '--backfill-days', '181']), /1 to 180/);
  assert.throws(() => parseCli(['run', '--backfill-days', '2.5']), /1 to 180/);
  assert.throws(() => parseCli(['--bogus']), /Unknown option/);
});

test('install record round-trips, fills defaults and refuses secrets', () => {
  const file = join(dir, 'valuelens-install.json');
  assert.equal(loadConfig(file).existed, false);

  const config = emptyConfig();
  config.tenantId = 't';
  config.fabric.workspaceId = 'w';
  config.fabric.notebooks.processor = 'nb';
  saveConfig(file, config);
  const { config: back, existed } = loadConfig(file);
  assert.equal(existed, true);
  assert.deepEqual(back, config);

  writeFileSync(file, JSON.stringify({ version: 1, schedule: { time: '05:00' }, modules: { agent365: true } }));
  const partial = loadConfig(file).config;
  assert.equal(partial.schedule.time, '05:00');
  assert.equal(partial.schedule.frequency, 'daily');
  assert.deepEqual(partial.modules, { orgData: true, m365Activity: true, agent365: true, productFeedback: false, consumption: false, agentEvaluator: false });
  assert.deepEqual(partial.fabric.notebooks, {});

  const leaky = /** @type {any} */ (emptyConfig());
  leaky.app.clientSecret = 'abc';
  assert.throws(() => saveConfig(file, leaky), /Refusing to keep a secret/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).schedule.time, '05:00', 'the old record is untouched');

  writeFileSync(file, JSON.stringify({ version: 2 }));
  assert.throws(() => loadConfig(file), /version 2/);
  writeFileSync(file, '{not json');
  assert.throws(() => loadConfig(file), /not valid JSON/);
});

test('messages name the exe when it started the installer', () => {
  const exe = { [EXE_ENV]: '1' };
  assert.equal(fromExe({}), false);
  assert.equal(fromExe({ [EXE_ENV]: '0' }), false);
  assert.equal(fromExe(exe), true);
  assert.equal(commandLine('status', {}), 'valuelens-install status');
  assert.equal(commandLine('status', exe), 'AnalyticsHubInstaller.exe status');
  assert.equal(commandLine('', exe), 'AnalyticsHubInstaller.exe');
  assert.equal(installerWindow({}), 'your terminal');
  assert.equal(installerWindow(exe), 'the installer window');
  assert.match(help(), /Usage: (valuelens-install|AnalyticsHubInstaller\.exe) \[command\] \[options\]/);
  assert.match(help(), /deploy-app\s+Deploy the Analytics Hub app again/);
});