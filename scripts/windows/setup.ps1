param(
  [ValidateSet('install','register','unregister','rollback','status','verify')][string]$Action = 'install',
  [string]$InstallRoot,
  [string]$Profile,
  [string]$McpConfig,
  [string]$CodexDirectory,
  [string]$SkillDirectory,
  [string]$BundledSkill
)
$ErrorActionPreference = 'Stop'
$bridgeRuntime = Join-Path $PSScriptRoot 'runtime/WebImageBridge.exe'
$bridgeManager = Join-Path $PSScriptRoot 'runtime/resources/app/scripts/install.cjs'
$bridgeArguments = @($bridgeManager, $Action, '--package', $PSScriptRoot)
foreach ($bridgePair in @(@('--root',$InstallRoot),@('--profile',$Profile),@('--config',$McpConfig),@('--codex',$CodexDirectory),@('--skill',$SkillDirectory),@('--bundled',$BundledSkill))) {
  if ($bridgePair[1]) { $bridgeArguments += $bridgePair }
}
$previousElectronMode = $env:ELECTRON_RUN_AS_NODE
try { $env:ELECTRON_RUN_AS_NODE = '1'; & $bridgeRuntime @bridgeArguments | Write-Output; if ($LASTEXITCODE -ne 0) { throw 'Web Image Bridge setup failed.' } }
finally { $env:ELECTRON_RUN_AS_NODE = $previousElectronMode }
