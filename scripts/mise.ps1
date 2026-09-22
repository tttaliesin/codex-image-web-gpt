$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$env:MISE_DATA_DIR = Join-Path $projectRoot '.local/mise/data'
$env:MISE_CACHE_DIR = Join-Path $projectRoot '.local/mise/cache'
$env:MISE_STATE_DIR = Join-Path $projectRoot '.local/mise/state'
$env:MISE_CONFIG_DIR = Join-Path $projectRoot '.local/mise/config'
New-Item -ItemType Directory -Path (Join-Path $projectRoot '.local') -Force | Out-Null
# Keep standalone pnpm's ESM worker outside the application's CommonJS scope.
Set-Content -LiteralPath (Join-Path $projectRoot '.local/package.json') -Value '{"type":"module"}' -Encoding utf8
Push-Location $projectRoot
$miseArguments = @($args)
if ($miseArguments[0] -eq 'exec' -and $miseArguments -notcontains '--') {
  $miseArguments = @('exec', '--') + $miseArguments[1..($miseArguments.Length - 1)]
}
try { & mise @miseArguments; $taskExit = $LASTEXITCODE } finally { Pop-Location }
exit $taskExit
