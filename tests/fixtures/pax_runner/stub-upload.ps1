# Stub Upload-Rollups-SharePoint.ps1 body. test_pax_runner.py puts the real script's param
# block before it, so refresh.ps1's splat binds exactly as it would to the real script. The
# file lands in the harness's stand-in library. STUB_UPLOAD_FAIL names a remote file whose
# upload fails.
$ErrorActionPreference = 'Stop'
if ($PSCmdlet.ParameterSetName -ne 'File') {
  throw "The stub uploader only takes the File parameter set, not $($PSCmdlet.ParameterSetName)."
}
$content = [System.IO.File]::ReadAllText($File)
[ordered]@{
  run        = $env:STUB_RUN
  file       = $File
  remoteName = $RemoteName
  tenantId   = $TenantId
  clientId   = $ClientId
  siteId     = $SiteId
  driveId    = $DriveId
  folderPath = $FolderPath
  secretOk   = ($ClientSecret -ceq 'stub-secret')
  content    = $content
} | ConvertTo-Json -Compress | Add-Content -LiteralPath $env:STUB_UPLOAD_LOG -Encoding utf8
if ($env:STUB_UPLOAD_FAIL -and $RemoteName -eq $env:STUB_UPLOAD_FAIL) {
  throw 'HTTP 507 Insufficient Storage: the library is full.'
}
$remotePath = (@($FolderPath -split '/' | Where-Object { $_ }) + $RemoteName) -join '/'
Set-HarnessItem -Path $remotePath -Item @{
  folder   = $false
  content  = $content
  modified = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
}
