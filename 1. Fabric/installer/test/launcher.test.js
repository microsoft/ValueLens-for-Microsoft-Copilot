// @ts-check
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSC = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const skip = process.platform !== 'win32' || !existsSync(CSC) ? 'needs Windows and the .NET Framework C# compiler' : false;

test('launcher: quotes arguments, refuses unsafe entries and unpacks past 260 characters', { skip }, () => {
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
