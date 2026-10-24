#Requires -Version 7.2
<#
.SYNOPSIS
  Writes, reads, tests or deletes one generic credential in Windows Credential Manager.

.DESCRIPTION
  The scheduled PAX refresh keeps its app registration's client secret here, so neither the
  task's arguments nor any file on disk holds it. Credential Manager is per user: write the
  secret as the account that runs the scheduled task.

  Write reads the secret from standard input, so it never appears on a command line or in a
  process list. Read outputs the secret, for refresh.ps1 to capture in-process. Test reports
  whether the credential exists, its user name and when it was written, never the secret.
  Delete succeeds when there's nothing to delete.

  The credential is CRED_TYPE_GENERIC with CRED_PERSIST_LOCAL_MACHINE: it stays on this
  machine, for this user, and is visible to the user's other sign-in sessions, such as a task
  set to run whether the user is signed in or not.

  Add-Type compiles the Credential Manager calls, so this script can't run in PowerShell's
  constrained language mode.

.PARAMETER Action
  Write, Read, Test or Delete.

.PARAMETER Target
  The credential's name, for example PAX-<Product>-<tenant-id>.

.PARAMETER UserName
  Stored by Write, usually the app registration's client ID.

.EXAMPLE
  $secret | pwsh -NoProfile -NonInteractive -File .\credential.ps1 -Action Write -Target PAX-Product-<tenant-id> -UserName <client-id>

.EXAMPLE
  pwsh -NoProfile -NonInteractive -File .\credential.ps1 -Action Test -Target PAX-Product-<tenant-id>
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [ValidateSet('Write', 'Read', 'Test', 'Delete')] [string]$Action,
  [Parameter(Mandatory = $true)] [ValidateNotNullOrEmpty()] [string]$Target,
  [string]$UserName
)

$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
  throw 'Windows Credential Manager is only available on Windows.'
}
if ($Target -ne $Target.Trim()) {
  throw '-Target must not start or end with spaces.'
}

if (-not ('PaxRunner.CredentialStore' -as [type])) {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace PaxRunner
{
    public sealed class CredentialInfo
    {
        public string UserName;
        public DateTime LastWrittenUtc;
    }

    public static class CredentialStore
    {
        private const uint CredTypeGeneric = 1;
        private const uint CredPersistLocalMachine = 2;
        private const int ErrorNotFound = 1168;
        private const int MaxBlobBytes = 2560;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct NativeCredential
        {
            public uint Flags;
            public uint Type;
            public IntPtr TargetName;
            public IntPtr Comment;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
            public uint CredentialBlobSize;
            public IntPtr CredentialBlob;
            public uint Persist;
            public uint AttributeCount;
            public IntPtr Attributes;
            public IntPtr TargetAlias;
            public IntPtr UserName;
        }

        [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredWrite(ref NativeCredential credential, uint flags);

        [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

        [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredDelete(string target, uint type, uint flags);

        [DllImport("advapi32.dll", EntryPoint = "CredFree")]
        private static extern void CredFree(IntPtr buffer);

        public static void Write(string target, string userName, string secret)
        {
            if (string.IsNullOrEmpty(secret)) throw new ArgumentException("The secret is empty.");
            byte[] blob = Encoding.Unicode.GetBytes(secret);
            if (blob.Length > MaxBlobBytes)
            {
                Array.Clear(blob, 0, blob.Length);
                throw new ArgumentException("The secret is longer than Credential Manager allows (2,560 bytes).");
            }
            IntPtr blobPointer = Marshal.AllocHGlobal(blob.Length);
            IntPtr targetPointer = Marshal.StringToHGlobalUni(target);
            IntPtr userPointer = string.IsNullOrEmpty(userName) ? IntPtr.Zero : Marshal.StringToHGlobalUni(userName);
            try
            {
                Marshal.Copy(blob, 0, blobPointer, blob.Length);
                NativeCredential credential = new NativeCredential();
                credential.Type = CredTypeGeneric;
                credential.TargetName = targetPointer;
                credential.CredentialBlobSize = (uint)blob.Length;
                credential.CredentialBlob = blobPointer;
                credential.Persist = CredPersistLocalMachine;
                credential.UserName = userPointer;
                if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            finally
            {
                for (int i = 0; i < blob.Length; i++) Marshal.WriteByte(blobPointer, i, 0);
                Array.Clear(blob, 0, blob.Length);
                Marshal.FreeHGlobal(blobPointer);
                Marshal.FreeHGlobal(targetPointer);
                if (userPointer != IntPtr.Zero) Marshal.FreeHGlobal(userPointer);
            }
        }

        private static IntPtr Open(string target)
        {
            IntPtr pointer;
            if (CredRead(target, CredTypeGeneric, 0, out pointer)) return pointer;
            int error = Marshal.GetLastWin32Error();
            if (error == ErrorNotFound) return IntPtr.Zero;
            throw new Win32Exception(error);
        }

        public static string ReadSecret(string target)
        {
            IntPtr pointer = Open(target);
            if (pointer == IntPtr.Zero) return null;
            NativeCredential credential = new NativeCredential();
            try
            {
                credential = Marshal.PtrToStructure<NativeCredential>(pointer);
                if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0) return string.Empty;
                return Marshal.PtrToStringUni(credential.CredentialBlob, (int)(credential.CredentialBlobSize / 2));
            }
            finally
            {
                if (credential.CredentialBlob != IntPtr.Zero)
                {
                    for (int i = 0; i < credential.CredentialBlobSize; i++) Marshal.WriteByte(credential.CredentialBlob, i, 0);
                }
                CredFree(pointer);
            }
        }

        public static CredentialInfo Find(string target)
        {
            IntPtr pointer = Open(target);
            if (pointer == IntPtr.Zero) return null;
            try
            {
                NativeCredential credential = Marshal.PtrToStructure<NativeCredential>(pointer);
                CredentialInfo info = new CredentialInfo();
                info.UserName = credential.UserName == IntPtr.Zero ? null : Marshal.PtrToStringUni(credential.UserName);
                long fileTime = ((long)(uint)credential.LastWritten.dwHighDateTime << 32) | (uint)credential.LastWritten.dwLowDateTime;
                info.LastWrittenUtc = DateTime.FromFileTimeUtc(fileTime);
                return info;
            }
            finally
            {
                CredFree(pointer);
            }
        }

        public static bool Delete(string target)
        {
            if (CredDelete(target, CredTypeGeneric, 0)) return true;
            int error = Marshal.GetLastWin32Error();
            if (error == ErrorNotFound) return false;
            throw new Win32Exception(error);
        }
    }
}
'@
}

switch ($Action) {
  'Write' {
    if (-not [Console]::IsInputRedirected) {
      throw 'Write reads the secret from standard input. Pipe it in; this script never prompts for it or takes it as an argument.'
    }
    $secret = [Console]::In.ReadToEnd().Trim()
    if (-not $secret) { throw 'No secret arrived on standard input.' }
    try {
      [PaxRunner.CredentialStore]::Write($Target, $UserName, $secret)
    } finally {
      $secret = $null
    }
    [pscustomobject]@{ target = $Target; written = $true } | ConvertTo-Json -Compress
  }
  'Read' {
    $value = [PaxRunner.CredentialStore]::ReadSecret($Target)
    if (-not $value) { throw "Windows Credential Manager has no credential named $Target for $([Environment]::UserName)." }
    $value
  }
  'Test' {
    $info = [PaxRunner.CredentialStore]::Find($Target)
    [pscustomobject]@{
      target         = $Target
      exists         = [bool]$info
      userName       = if ($info) { $info.UserName } else { $null }
      lastWrittenUtc = if ($info) { $info.LastWrittenUtc.ToString('o') } else { $null }
    } | ConvertTo-Json -Compress
  }
  'Delete' {
    $removed = [PaxRunner.CredentialStore]::Delete($Target)
    [pscustomobject]@{ target = $Target; deleted = $removed } | ConvertTo-Json -Compress
  }
}
