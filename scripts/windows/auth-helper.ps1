$ErrorActionPreference = 'Stop'
$bridgeState = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'current.json') -Raw | ConvertFrom-Json
if ($bridgeState.product -ne 'web-image-bridge') { throw 'Invalid installation state' }
$previousElectronMode = $env:ELECTRON_RUN_AS_NODE
try {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  & $bridgeState.exe --mcp-headers-helper --profile $bridgeState.profile | Write-Output
  if ($LASTEXITCODE -ne 0) { throw 'MCP_AUTH_HELPER_FAILED' }
}
finally { $env:ELECTRON_RUN_AS_NODE = $previousElectronMode }
