# Stub credential.ps1 body. test_pax_runner.py puts the real script's param block before it,
# so refresh.ps1's call binds exactly as it would to the real script. Nothing touches
# Windows Credential Manager.
$ErrorActionPreference = 'Stop'
[ordered]@{ run = $env:STUB_RUN; action = $Action; target = $Target } |
  ConvertTo-Json -Compress | Add-Content -LiteralPath $env:STUB_CRED_LOG -Encoding utf8
if ($Action -ne 'Read') { throw "The stub credential store only takes -Action Read, not $Action." }
if ($env:STUB_NO_SECRET) {
  throw "Windows Credential Manager has no credential named $Target for $([Environment]::UserName)."
}
'stub-secret'
