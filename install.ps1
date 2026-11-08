[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$NoLink,
  [switch]$Quiet
)

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error 'FORGE-NODE-NOT-FOUND: instale Node.js >=20 e reabra o terminal'
  exit 2
}
$args = @((Join-Path $PSScriptRoot 'scripts/install_portable.mjs'))
if ($DryRun) { $args += '--dry-run' }
if ($NoLink) { $args += '--no-link' }
if ($Quiet) { $args += '--quiet' }
& $node.Source @args
exit $LASTEXITCODE
