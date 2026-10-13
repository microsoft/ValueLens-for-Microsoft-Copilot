// @ts-check
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSC = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const skip = process.platform !== 'win32' || !existsSync(CSC) ? 'needs Windows and the .NET Framework C# compiler' : false;

test('launcher: quotes arguments, refuses unsafe entries, unpacks past 260 characters and keeps the PC awake', { skip }, () => {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), 'ahl-'));
  try {
    const exe = join(dir, 'check.exe');
    const sources = [join(HERE, '..', 'packaging', 'launcher', 'Launcher.cs'), join(HERE, 'launcher-check.cs')];
    const built = spawnSync(CSC, ['/nologo', '/target:exe', `/out:${exe}`, '/main:LauncherCheck', '/reference:System.IO.Compression.dll', ...sources], {
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const res = spawnSync(exe, [dir], { encoding: 'utf8', windowsHide: true });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /^ok$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('launcher: stays awake while the installer runs, and lets the PC sleep again after', () => {
  const src = readFileSync(join(HERE, '..', 'packaging', 'launcher', 'Launcher.cs'), 'utf8');
  const run = src.slice(src.indexOf('private static int Run('), src.indexOf('private static void Unpack('));
  const on = run.indexOf('KeepAwake(true);');
  const start = run.indexOf('Process.Start(psi)');
  const off = run.indexOf('KeepAwake(false);');
  assert.ok(on > 0 && on < start, 'turned on before the installer starts');
  assert.ok(off > start && /finally\s*\{\s*KeepAwake\(false\);/.test(run), 'reset in a finally block, after it exits');
  assert.match(src, /SetThreadExecutionState\(on \? AwakeFlags : EsContinuous\)/);
});
