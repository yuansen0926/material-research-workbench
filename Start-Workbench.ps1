param([int]$Port = 4173)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) {
  $nodeExecutable = $nodeCommand.Source
} else {
  $nodeExecutable = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
  if (-not (Test-Path -LiteralPath $nodeExecutable)) {
    throw 'Node.js 24.19+ is required. Install Node.js and run npm ci first.'
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
  throw 'Dependencies are missing. Run npm ci in this folder first.'
}
$env:PORT = [string]$Port
& $nodeExecutable --env-file-if-exists=.env workbench.mjs
exit $LASTEXITCODE
