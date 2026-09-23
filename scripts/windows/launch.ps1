$ErrorActionPreference = 'Stop'
$bridgeState = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'current.json') -Raw | ConvertFrom-Json
if ($bridgeState.product -ne 'web-image-bridge') { throw 'Invalid installation state' }
$bridgeArgs = @('--profile', ('"' + $bridgeState.profile + '"'), '--mcp-config', ('"' + $bridgeState.config + '"'), '--install-root', ('"' + $PSScriptRoot + '"'))
$previousElectronMode = $env:ELECTRON_RUN_AS_NODE
try { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; Start-Process -FilePath $bridgeState.exe -ArgumentList $bridgeArgs -WorkingDirectory $PSScriptRoot -WindowStyle Hidden }
finally { $env:ELECTRON_RUN_AS_NODE = $previousElectronMode }
