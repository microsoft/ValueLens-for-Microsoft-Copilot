// @ts-check
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { payloadId } from '../packaging/payload.js';
import { SCRIPT_NAME, ZIP_NAME, installScript, scriptSha256, zipUrl } from '../packaging/script.js';
import { CLOUD_SHELL_SHIM, INSTALLED_NODE_ENV, installerVersion, SCRIPT_SHIM, scriptCommand, scriptUrl } from '../src/launch.js';
import { PRODUCT } from '../src/product.js';
import { RELEASES_PAGE, REPO } from '../src/update-check.js';

const TEMPLATE = readFileSync(fileURLToPath(new URL('../packaging/launcher/install.ps1', import.meta.url)), 'utf8');
const HASH = '748ed2f139d14f8babdabea867a809c4fe6da12ef9da3d07ecd93dba616224db';
const V = { version: '1.2.3', sha256: HASH.toUpperCase(), id: '1.2.3-748ed2f139', repo: 'octo/hub', sizeMb: 151.6, commit: 'D793F32'.padEnd(40, 'A'), nodeVersion: '24.11.1' };

test('script: fills in every placeholder', () => {
  const s = installScript(TEMPLATE, V);
  assert.doesNotMatch(s, /\{\{/);
  assert.equal(scriptSha256(s), HASH);
  assert.match(s, /^\s*\$Version = '1\.2\.3'$/m);
  assert.match(s, /^\s*\$Id = '1\.2\.3-748ed2f139'$/m);
  assert.ok(s.includes(`$ZipUrl = 'https://github.com/octo/hub/releases/download/valuelens-installer-v1.2.3/${ZIP_NAME}'`));
  assert.match(s, /^\s*\$SizeMb = '152'$/m);
  const again = scriptCommand('1.2.3', 'octo/hub');
  assert.ok(s.includes(`\r\n  ${again}\r\n`), "its help names this release's install.ps1");
  assert.ok(s.includes(`$Again = '${again}'`));
  assert.doesNotMatch(s, /releases\/latest/, "GitHub's Latest is often a dashboard release");
  assert.match(s, /^\s*\$Commit = 'd793f32a{33}'$/m);
  assert.match(s, /^\s*\$NodeVersion = '24\.11\.1'$/m);
  assert.ok(s.includes("$RepoUrl = 'https://github.com/octo/hub.git'"));
});

test('script: is plain ASCII with Windows line endings, for Windows PowerShell 5.1', () => {
  const s = installScript(TEMPLATE, V);
  assert.ok([...s].every((ch) => ch.charCodeAt(0) < 0x7f));
  assert.doesNotMatch(s, /[^\r]\n/);
  assert.throws(() => installScript(`${TEMPLATE}\n# caf\u00e9`, V), /plain ASCII/);
});

test('script: Node.js code passed with -e has no double quotes, which Windows PowerShell 5.1 drops', () => {
  const evals = [...TEMPLATE.matchAll(/ -e '((?:[^']|'')*)'/g)].map((m) => m[1]);
  assert.ok(evals.length > 0);
  for (const code of evals) assert.doesNotMatch(code, /"/, code);
});

test('script: refuses values that would break out of a PowerShell string', () => {
  assert.throws(() => installScript(TEMPLATE, { ...V, sha256: 'abc' }), /isn't a SHA-256/);
  assert.throws(() => installScript(TEMPLATE, { ...V, version: "1'; rm -r ~; '" }), /letters, digits/);
  assert.throws(() => installScript(TEMPLATE, { ...V, repo: 'octo/hub/../x' }), /owner\/name/);
  assert.throws(() => installScript(TEMPLATE, { ...V, commit: 'd793f32' }), /full commit ID/);
  assert.throws(() => installScript(TEMPLATE, { ...V, commit: "main'; rm -r ~; '".padEnd(40, 'a') }), /full commit ID/);
  assert.throws(() => installScript(TEMPLATE, { ...V, nodeVersion: '24' }), /Node\.js version/);
  assert.throws(() => installScript('{{NOPE}}', V), /unknown placeholder \{\{NOPE\}\}/);
});

test('script: the whole launcher runs in a script block, so iex leaves nothing behind in the session', () => {
  const body = TEMPLATE.replace(/^<#[\s\S]*?#>\s*/, '');
  assert.match(body, /^& \{/);
  assert.match(body, /\} @args\r?\nif \(\$MyInvocation\.MyCommand\.Path -and \$LASTEXITCODE\) \{ exit \$LASTEXITCODE \}\r?\n$/);
  assert.doesNotMatch(TEMPLATE, /\bparam\s*\(/i, 'a param block would bind installer commands such as "status" as launcher options');
  assert.match(TEMPLATE, /VALUELENS_LAUNCHER=pwsh/);
  assert.match(TEMPLATE, /VALUELENS_LAUNCHER = 'pwsh'/);
});

test('script: commands and URLs agree between the launcher and the installer', () => {
  assert.equal(SCRIPT_NAME, 'install.ps1');
  assert.equal(scriptUrl('1.2.3', 'octo/hub'), `https://github.com/octo/hub/releases/download/valuelens-installer-v1.2.3/${SCRIPT_NAME}`);
  assert.equal(scriptCommand('1.2.3', 'octo/hub'), 'irm https://github.com/octo/hub/releases/download/valuelens-installer-v1.2.3/install.ps1 | iex');
  assert.equal(scriptCommand('1.2.3'), `irm https://github.com/${REPO}/releases/download/valuelens-installer-v1.2.3/install.ps1 | iex`);
  assert.equal(zipUrl('octo/hub', '1.2.3'), 'https://github.com/octo/hub/releases/download/valuelens-installer-v1.2.3/ValueLensInstaller.zip');
  assert.ok(TEMPLATE.includes("Join-Path $VlHome 'valuelens.cmd'"));
  assert.equal(SCRIPT_SHIM, '& $env:LOCALAPPDATA\\ValueLens\\valuelens.cmd');
});

test("script: the installer README shows this version's install command and links the installer releases", () => {
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  const { version } = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  assert.equal(installerVersion(), version);
  assert.ok(readme.includes(`\n${scriptCommand(version)}\n`), `README.md shows: ${scriptCommand(version)}`);
  assert.ok(readme.includes(`installer ${version} as a zip`));
  assert.ok(readme.includes(`(${scriptUrl(version).replace(/install\.ps1$/, PRODUCT.exe)})`), 'links this version of the exe');
  const tags = [...readme.matchAll(/releases\/download\/([^/\s)]+)\//g)].map((m) => m[1]);
  assert.deepEqual(tags, [`${PRODUCT.tagPrefix}${version}`, `${PRODUCT.tagPrefix}${version}`], 'no other version');
  assert.ok(readme.includes(`(${RELEASES_PAGE})`), RELEASES_PAGE);
  assert.doesNotMatch(readme, /releases\/latest/, "GitHub's Latest is often a dashboard release");
});

test('script: in Azure Cloud Shell, gets the pinned commit and runs the installer in the terminal', () => {
  const cloud = TEMPLATE.slice(TEMPLATE.indexOf('if ($CloudShell) {'), TEMPLATE.indexOf("if ($env:OS -ne 'Windows_NT')"));
  assert.ok(cloud.length > 1000, 'the Cloud Shell branch comes before the Windows-only check');
  assert.match(cloud, /\$env:VALUELENS_LAUNCHER = 'cloudshell'/);
  assert.match(cloud, /export VALUELENS_LAUNCHER=cloudshell/);
  assert.match(cloud, /fetch --quiet --depth 1 \$RepoUrl \$Commit/);
  assert.match(cloud, /rev-parse HEAD[\s\S]*\$head -ne \$Commit/, 'checks it got the commit it asked for');
  assert.match(cloud, /npm ci --omit=dev/);
  assert.match(cloud, /SHASUMS256\.txt[\s\S]*Get-FileHash[\s\S]*\$got -ne \$want/, 'checks the Node.js it downloads');
  assert.doesNotMatch(cloud, /--ui/, 'Cloud Shell has no browser for the wizard');
  assert.ok(cloud.includes("$VlHome = Join-Path $HOME '.valuelens'") && cloud.includes("$Shim = Join-Path $VlHome 'valuelens'"));
  assert.equal(CLOUD_SHELL_SHIM, '~/.valuelens/valuelens');
});
test('script: -UseInstalledNode runs the installer with an installed Node.js and keeps the same folders and command', () => {
  const win = TEMPLATE.slice(TEMPLATE.indexOf("if ($env:OS -ne 'Windows_NT')"));
  assert.match(TEMPLATE, /\$UseInstalledNode = \$env:VALUELENS_USE_INSTALLED_NODE -eq '1'/);
  assert.match(TEMPLATE, /\$a -eq '-UseInstalledNode'\) \{ \$UseInstalledNode = \$true \}/);
  assert.ok(TEMPLATE.includes(`$env:${INSTALLED_NODE_ENV}`), 'the launcher and the installer agree on the variable');
  // The same Node.js check serves Cloud Shell and Windows.
  assert.equal(TEMPLATE.match(/Get-Command node /g)?.length, 1);
  assert.match(TEMPLATE.slice(TEMPLATE.indexOf('if ($CloudShell) {')), /\$sys = Get-SystemNode/);
  assert.match(win, /\(\$sys\.Major -eq 22 -and \$sys\.Minor -ge 13\) -or \$sys\.Major -eq 24/, "rayfin supports Node.js 22 and 24");
  assert.match(win, /-p 'process\.arch'[\s\S]*\$arch -ne 'x64'/, 'the native packages in the zip are x64');
  // Same unpacked folder, install record and command, so either route finds the other's install.
  assert.equal(win.match(/\$Root = Join-Path \$VlHome \$Id/g)?.length, 1);
  assert.equal(win.match(/\$Work = Join-Path \$Docs 'ValueLens'/g)?.length, 1);
  assert.match(win, /\$node = \$Installed\r?\n\s*if \(-not \$node\) \{ \$node = Join-Path \$Root 'node\\node\.exe' \}/);
  assert.match(win, /& \$node \$script @Forward/);
  assert.match(win, /set `"VL_NODE=\$Installed`"/);
  assert.match(win, /'set "VALUELENS_USE_INSTALLED_NODE=1"'/);
  assert.match(win, /"%VL_NODE%" "%VL_ROOT%\\f\\installer\\bin\\valuelens-installer\.js" %\*/);
  assert.doesNotMatch(win, /"%VL_ROOT%\\node\\node\.exe" "%VL_ROOT%/, 'the command runs whichever Node.js install.ps1 used');
  assert.match(win, /\$Again = "`\$env:VALUELENS_USE_INSTALLED_NODE = '1'; \$Again"/);
});

test('script: the command it leaves behind escapes the | in the install command for cmd.exe', () => {
  const win = TEMPLATE.slice(TEMPLATE.indexOf("if ($env:OS -ne 'Windows_NT')"));
  assert.match(win, /\$AgainCmd = \$Again -replace '\\\|', '\^\|'/);
  assert.doesNotMatch(win, /echo [^\r\n]*\$Again\b(?!Cmd)/);
});

const WINDOWS_POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** Where Windows PowerShell's execution policy blocks script files, the test skips rather than bypass it. */
function windowsPowerShellSkip() {
  if (process.platform !== 'win32') return 'needs Windows PowerShell and cmd.exe';
  // A PSModulePath inherited from PowerShell 7 stops Windows PowerShell loading its own Get-ExecutionPolicy.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'));
  const policy = spawnSync(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy'], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000, env,
  });
  const name = policy.status === 0 ? policy.stdout.trim() : '';
  return /^(Restricted|AllSigned)$/.test(name) ? `Windows PowerShell's execution policy is ${name}, which blocks script files (not bypassed)` : false;
}

test('script: generated Windows commands run and report missing files with special characters in Node paths', {
  skip: windowsPowerShellSkip(),
}, () => {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), 'ahs-'));
  try {
    const start = TEMPLATE.indexOf('  $shimNode =');
    const end = TEMPLATE.indexOf('  if (-not $Forward.Count)', start);
    assert.ok(start >= 0 && end > start, 'finds the actual shim-generation block');
    const powershell = WINDOWS_POWERSHELL;
    const again = 'irm https://example.test/install.ps1 | iex';
    for (const installed of [false, true]) {
      const root = join(dir, installed ? 'installed (Node) & tools' : 'bundled (Node) & tools');
      const payload = join(root, 'payload');
      const node = join(installed ? join(root, 'approved (Node) & tools') : join(payload, 'node'), 'node.exe');
      const entry = join(payload, 'f', 'installer', 'bin', 'valuelens-installer.js');
      const work = join(root, 'work');
      for (const folder of [dirname(node), dirname(entry), work]) mkdirSync(folder, { recursive: true });
      copyFileSync(process.execPath, node);
      writeFileSync(join(payload, '.unpacked'), 'fixture');
      writeFileSync(entry, 'console.log(JSON.stringify({ args: process.argv.slice(2), node: process.execPath, cwd: process.cwd() })); if (process.argv.includes("--fail")) process.exitCode = 23;\n');
      const generate = join(root, 'generate.ps1');
      // Exercise only the real shim-generation block, without downloads or changes to the user's profile.
      writeFileSync(generate, [
        "$ErrorActionPreference = 'Stop'",
        "$Id = 'payload'",
        "$Shim = Join-Path $PSScriptRoot 'valuelens.cmd'",
        "$Work = Join-Path $PSScriptRoot 'work'",
        `$Again = '${again}'`,
        '$Installed = $null',
        "if ($env:SHIM_TEST_INSTALLED -eq '1') { $Installed = $env:SHIM_TEST_NODE }",
        '$NodeDir = Split-Path $env:SHIM_TEST_NODE',
        TEMPLATE.slice(start, end),
      ].join('\r\n'), 'ascii');
      const generated = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', generate], {
        encoding: 'utf8', windowsHide: true, timeout: 30_000,
        env: { ...process.env, SHIM_TEST_INSTALLED: installed ? '1' : '0', SHIM_TEST_NODE: node },
      });
      assert.equal(generated.status, 0, generated.error?.message ?? generated.stdout + generated.stderr);
      const shim = join(root, 'valuelens.cmd');
      /** @param {string} args */
      const run = (args) => spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${shim}" ${args}"`], {
        encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 30_000,
      });
      for (const args of ['', 'status "argument with spaces"']) {
        const result = run(args);
        assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
        const output = JSON.parse(result.stdout);
        assert.deepEqual(output.args, args ? ['status', 'argument with spaces'] : ['--ui']);
        assert.equal(output.node, node);
        assert.equal(output.cwd, work);
      }
      assert.equal(run('--fail').status, 23, 'preserves the installer exit code');
      assert.ok(existsSync(node));
      unlinkSync(node);
      const missingNode = run('--version');
      assert.equal(missingNode.status, 1, missingNode.stdout + missingNode.stderr);
      assert.ok(missingNode.stdout.includes(`Can't find Node.js at "${node}".`));
      assert.ok(missingNode.stdout.includes(again), 'prints the reinstall pipe literally');
      unlinkSync(join(payload, '.unpacked'));
      const missingPayload = run('--version');
      assert.equal(missingPayload.status, 1, missingPayload.stdout + missingPayload.stderr);
      assert.ok(missingPayload.stdout.includes(again));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("script: doesn't tell people to get around their organisation's policy", () => {
  assert.doesNotMatch(TEMPLATE, /ExecutionPolicy|Bypass|Run anyway|Keep anyway|AllSigned/i);
  assert.match(TEMPLATE, /ask your IT team/);
});

const WIN_ONLY = { skip: process.platform !== 'win32' ? 'needs Windows PowerShell' : false };
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
/** Windows PowerShell 5.1, and PowerShell 7 when it's installed: their web errors differ. */
const SHELLS = [POWERSHELL, ...(spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { windowsHide: true }).status === 0 ? ['pwsh'] : [])];

/**
 * Runs a real block of the filled-in launcher after a prelude. Like `irm | iex`, it's a command rather than a
 * script file, so the test machine's execution policy doesn't apply.
 * @param {string} shell
 * @param {string[]} prelude
 * @param {string} block
 * @returns {Promise<{ status: number | null, out: string }>}
 */
function runBlock(shell, prelude, block) {
  const code = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    ...prelude,
    block,
    "} catch { [Console]::Out.WriteLine('FAILED: ' + $_.Exception.Message); exit 1 }",
  ].join('\r\n');
  const encoded = Buffer.from(code, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (status) => resolve({ status, out: out.replace(/\s+/g, ' ') }));
  });
}

test("script: a pinned release whose zip is gone says so and gives the current release's command", WIN_ONLY, async () => {
  const s = installScript(TEMPLATE, V);
  const start = s.indexOf('      $request = @{ Uri = $ZipUrl');
  const end = s.lastIndexOf('}', s.indexOf('    # Get-FileHash'));
  assert.ok(start >= 0 && end > start, 'finds the actual download block');
  const block = s.slice(start, end);
  assert.doesNotMatch(block, /\biex\b|Invoke-Expression|\[scriptblock\]::Create/i, "it doesn't run another release by itself");
  const server = createServer((req, res) => {
    res.statusCode = req.url?.includes('gone') ? 404 : 500;
    res.end('no');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), 'ahd-'));
  try {
    for (const shell of SHELLS) {
      /** @param {string} path */
      const prelude = (path) => [
        "$Version = '1.2.3'",
        `$ZipUrl = 'http://127.0.0.1:${port}/${path}'`,
        `$ZipName = '${ZIP_NAME}'`,
        `$zip = '${join(dir, 'x.zip.partial')}'`,
        '$Proxy = $null',
        `$Again = '${scriptCommand('1.2.3', 'octo/hub')}'`,
      ];
      const gone = await runBlock(shell, prelude('gone/ValueLensInstaller.zip'), block);
      assert.notEqual(gone.status, 0, `${shell}: ${gone.out}`);
      assert.match(gone.out, /Release valuelens-installer-v1\.2\.3 is no longer available/, `${shell}: ${gone.out}`);
      assert.match(gone.out, /Get the current release's install command from https:\/\/github\.com\/octo\/hub\/releases\?q=valuelens-installer-v/);
      assert.doesNotMatch(gone.out, /irm /, "this release's own command would fail the same way");
      assert.doesNotMatch(gone.out, /proxy/i);

      const broken = await runBlock(shell, prelude('broken/ValueLensInstaller.zip'), block);
      assert.notEqual(broken.status, 0);
      assert.match(broken.out, /Couldn't download .*If a proxy blocks it/, `${shell}: ${broken.out}`);
      assert.doesNotMatch(broken.out, /no longer available/);
    }
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("script: a node.exe blocked by device policy says what to do instead of the raw error", WIN_ONLY, async () => {
  const s = installScript(TEMPLATE, V);
  const start = s.indexOf('  # AppLocker or App Control may block node.exe');
  const end = s.indexOf('  # Remove what other versions unpacked', start);
  assert.ok(start >= 0 && end > start, 'finds the actual probe');
  const block = s.slice(start, end);
  /** @param {string} node @param {boolean} [installed] */
  const prelude = (node, installed = false) => [
    `$Again = '${scriptCommand('1.2.3', 'octo/hub')}'`,
    `$Installed = ${installed ? "'C:\\approved\\node.exe'" : '$null'}`,
    `$node = ${node}`,
  ];
  const applocker = "{ throw 'Program ''node.exe'' failed to run: This program is blocked by group policy. For more information, contact your system administrator' }";
  // App Control, spotted by its Win32 error code alone.
  const wdac = "{ throw (New-Object Management.Automation.ApplicationFailedException 'Program failed to run', (New-Object ComponentModel.Win32Exception 4551, 'x')) }";
  for (const shell of SHELLS) {
    for (const blocked of [applocker, wdac]) {
      const r = await runBlock(shell, prelude(blocked), block);
      assert.notEqual(r.status, 0, r.out);
      assert.match(r.out, /Your organisation's policy blocks the Node\.js that comes with the installer/, `${shell}: ${r.out}`);
      assert.match(r.out, /Don't work around it/);
      assert.match(r.out, /Company Portal/);
      assert.match(r.out, /\$env:VALUELENS_USE_INSTALLED_NODE = '1'; irm https:\/\/github\.com\/octo\/hub\/releases\/download\/valuelens-installer-v1\.2\.3\/install\.ps1 \| iex/);
      assert.match(r.out, /docs\/INSTALL\.md#locked-down-tenant--azure-cloud-shell/);
      assert.match(r.out, /ask your IT team/);
    }
    const approved = await runBlock(shell, prelude(applocker, true), block);
    assert.notEqual(approved.status, 0);
    assert.match(approved.out, /Your organisation's policy blocks .*so the installer can't run here.*Azure Cloud Shell/, `${shell}: ${approved.out}`);
    assert.doesNotMatch(approved.out, /Company Portal/);

    const other = await runBlock(shell, prelude("{ throw 'disk on fire' }"), block);
    assert.notEqual(other.status, 0);
    assert.match(other.out, /disk on fire/);
    assert.doesNotMatch(other.out, /policy/);

    const fine = await runBlock(shell, prelude("{ 'v24.11.1' }"), `${block}\r\nWrite-Host 'ran on'`);
    assert.equal(fine.status, 0, fine.out);
    assert.match(fine.out, /ran on/);
  }
});

test('script: moving the unpacked installer into place retries while antivirus holds the files', () => {
  const win = TEMPLATE.slice(TEMPLATE.indexOf("Write-Host 'Unpacking it."));
  const move = win.slice(0, win.indexOf('# The zip\'s node.exe stays unpacked'));
  assert.match(move, /for \(\$try = 1; ; \$try\+\+\) \{\r?\n\s*try \{ Rename-Item -LiteralPath \$partial -NewName \$Id; break \} catch \{/);
  assert.match(move, /if \(\$try -ge 10 -or \(Test-Path -LiteralPath \(Join-Path \$Root \$Marker\)\)\) \{ throw \}\r?\n\s*Start-Sleep -Seconds 2/);
  assert.match(move, /Remove-Tree \$partial \$Installed\r?\n\s*throw "Couldn't finish unpacking the installer: .*Run the command again/, 'removes the half-unpacked folder and says what to do');
  assert.equal(move.match(/Rename-Item -LiteralPath \$partial/g)?.length, 1);
});

test('script: cleanup falls back to Remove-Item when policy blocks node.exe', () => {
  const tree = TEMPLATE.slice(TEMPLATE.indexOf('function Remove-Tree'), TEMPLATE.indexOf('function Find-Node'));
  const tryAt = tree.indexOf('try {');
  const nodeAt = tree.indexOf('& $Node -e ');
  const catchAt = tree.indexOf('} catch { }');
  assert.ok(tryAt >= 0 && tryAt < nodeAt && nodeAt < catchAt, tree);
  assert.match(tree, /Remove-Item -LiteralPath \$Dir -Recurse -Force/);
});

test('script: cleanup and -Uninstall know the folders the launcher makes by the same patterns as Launcher.cs', () => {
  const cs = readFileSync(fileURLToPath(new URL('../packaging/launcher/Launcher.cs', import.meta.url)), 'utf8');
  const fn = TEMPLATE.slice(TEMPLATE.indexOf('function Test-Unpacked'), TEMPLATE.indexOf('# Azure Cloud Shell runs Linux'));
  const patterns = [...fn.matchAll(/-cmatch '([^']+)'/g)].map((m) => m[1]);
  assert.equal(patterns.length, 2, fn);
  assert.deepEqual([...patterns].sort(), [...cs.matchAll(/new Regex\(@"([^"]+)"\)/g)].map((m) => m[1]).sort());
  const made = (/** @type {string} */ name) => patterns.some((p) => new RegExp(p).test(name));
  for (const version of ['0.1.0', '12.34.56', '0.2.0-rc.1']) {
    const id = payloadId(version, HASH);
    for (const name of [id, `${id}.partial-4242`, '~0123456789abcdef', '~42424242']) assert.ok(made(name), name);
  }
  for (const name of [PRODUCT.pax.folder, 'notes', 'node', '~', '~pax', `${V.id}.zip.partial-1`, V.id.toUpperCase()]) assert.ok(!made(name), name);
});

test("script: cleanup and -Uninstall keep the PAX refresh's folder, and anything else the launcher didn't make", WIN_ONLY, async () => {
  const s = installScript(TEMPLATE, V);
  /** @param {string} from @param {string} to */
  const block = (from, to) => {
    const start = s.indexOf(from);
    const end = s.indexOf(to, start + from.length);
    assert.ok(start >= 0 && end > start, `finds ${from.trim()}`);
    return s.slice(start, end);
  };
  const helpers = [
    block('  function Test-Unpacked', '  # Azure Cloud Shell runs Linux'),
    block('  # Removes a folder whose paths', '  # An installed Node.js'),
  ];
  const cloudCleanup = block('    # Remove other versions, and a Node.js', '    # A command for later');
  const cleanup = block('  # Remove what other versions unpacked', '  # The install record lives here');
  const uninstall = block('\n  if ($Uninstall) {', '\n  if (-not (Test-Path -LiteralPath (Join-Path $Root $Marker))) {');
  const id = V.id;
  const stale = '0.0.9-0123456789.partial-2';
  const installer = [id, `${id}.partial-1`, '0.1.0-0123456789', stale, '~1234567'];
  const others = [PRODUCT.pax.folder, 'notes', 'node', '0.1.0-ABCDEF0123'];
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), 'ahc-'));
  /**
   * A launcher home holding these folders, each with a file named after it, and these files.
   * @param {string} name
   * @param {{ dirs: string[], files?: string[], marked?: string[] }} spec
   */
  const home = (name, { dirs, files = [], marked = [] }) => {
    const root = join(dir, name);
    for (const d of dirs) {
      mkdirSync(join(root, d), { recursive: true });
      writeFileSync(join(root, d, 'file.txt'), d);
    }
    for (const d of marked) writeFileSync(join(root, d, '.unpacked'), 'done');
    for (const f of files) writeFileSync(join(root, f), f);
    // Stopped two hours ago, so no copy is still unpacking it.
    const old = new Date(Date.now() - 2 * 3600_000);
    if (dirs.includes(stale)) utimesSync(join(root, stale), old, old);
    return root;
  };
  /** @param {string} root */
  const left = (root) => (existsSync(root) ? readdirSync(root).sort() : null);
  /** @param {string} root */
  const prelude = (root) => [
    `$VlHome = '${root.replace(/'/g, "''")}'`,
    `$Id = '${id}'`,
    "$Marker = '.unpacked'",
    `$Shim = Join-Path $VlHome '${PRODUCT.shim}'`,
    '$Installed = $null',
    '$Uninstall = $true',
    '$node = $null',
    "$NodeDir = Join-Path $VlHome 'node-v24.11.1-linux-x64'",
    ...helpers,
  ];
  try {
    for (const [n, shell] of SHELLS.entries()) {
      const win = home(`${n}-win`, { dirs: [...installer, ...others] });
      const w = await runBlock(shell, prelude(win), cleanup);
      assert.equal(w.status, 0, `${shell}: ${w.out}`);
      assert.deepEqual(left(win), [id, `${id}.partial-1`, ...others].sort(), `${shell}: removes older versions, a stopped unpack and a folder moved aside, nothing else`);
      assert.equal(readFileSync(join(win, PRODUCT.pax.folder, 'file.txt'), 'utf8'), PRODUCT.pax.folder);

      const nodes = ['node-v24.11.1-linux-x64', 'node-v22.13.0-linux-x64', 'node-v22.13.0-linux-x64.partial-3'];
      const cloud = home(`${n}-cloud`, { dirs: [...installer, ...others, ...nodes] });
      const c = await runBlock(shell, prelude(cloud), cloudCleanup);
      assert.equal(c.status, 0, `${shell}: ${c.out}`);
      assert.deepEqual(left(cloud), [id, `${id}.partial-1`, ...others, nodes[0], nodes[2]].sort(), `${shell}: in Cloud Shell, also removes a Node.js this version doesn't use`);

      // Only node.exe from a complete unpacked installer, to remove the rest with.
      const found = home(`${n}-find`, { dirs: [`${PRODUCT.pax.folder}/node`, 'notes/node', `${id}.partial-1/node`], marked: [PRODUCT.pax.folder, 'notes'] });
      for (const d of [PRODUCT.pax.folder, 'notes', `${id}.partial-1`]) writeFileSync(join(found, d, 'node', 'node.exe'), '');
      const find = "[Console]::Out.WriteLine('found:' + [string](Find-Node) + ':')";
      assert.match((await runBlock(shell, prelude(found), find)).out, /found::/, `${shell}: no node.exe outside a complete unpacked installer`);
      mkdirSync(join(found, id, 'node'), { recursive: true });
      writeFileSync(join(found, id, '.unpacked'), 'done');
      writeFileSync(join(found, id, 'node', 'node.exe'), '');
      assert.ok((await runBlock(shell, prelude(found), find)).out.includes(`found:${join(found, id, 'node', 'node.exe')}:`), shell);

      const mixed = home(`${n}-mixed`, { dirs: [...installer, ...others], files: [PRODUCT.shim, `${id}.zip.partial-77`, 'notes.txt'], marked: [id] });
      const u = await runBlock(shell, prelude(mixed), uninstall);
      assert.equal(u.status, 0, `${shell}: ${u.out}`);
      assert.deepEqual(left(mixed), [...others, 'notes.txt'].sort(), `${shell}: -Uninstall removes the command, what the launcher made and a stopped download`);
      assert.ok(u.out.includes(`Removed the installer from ${mixed}. Your install record in Documents\\ValueLens is still there.`), u.out);
      assert.ok(u.out.includes(`The scheduled PAX refresh still runs from ${join(mixed, PRODUCT.pax.folder)}. To remove it too, run the installer again and use its uninstall command.`), u.out);
      const kept = /Left (.*?) in .*, because the installer didn't put them there\./.exec(u.out);
      assert.deepEqual(kept?.[1].split(', ').sort(), [...others.slice(1), 'notes.txt'].sort(), u.out);

      const only = home(`${n}-only`, { dirs: installer, files: [PRODUCT.shim], marked: [id] });
      const o = await runBlock(shell, prelude(only), uninstall);
      assert.equal(o.status, 0, `${shell}: ${o.out}`);
      assert.equal(left(only), null, `${shell}: with nothing else in it, the folder goes too`);
      assert.ok(o.out.includes(`Removed ${only}. Your install record in Documents\\ValueLens is still there.`), o.out);
      assert.doesNotMatch(o.out, /PAX|Left /);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
