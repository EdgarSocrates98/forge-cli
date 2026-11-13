[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$NoLink,
  [switch]$Quiet,
  [switch]$Plain,
  [switch]$Verbose
)

# forge-cli portable install - delegates to scripts/install_portable.mjs.
# Wrapper styles only its own FORGE-* refusal via Write-Host colors.

function Write-ForgeLine {
    param([string]$Mark, [string]$Color, [string]$Text)
    $plainOut = -not $Host.UI.SupportsVirtualTerminal -or $env:NO_COLOR -or $env:CI -or $env:FORGE_NO_UI
    if ($plainOut) { Write-Host $Text } else { Write-Host "  $Mark " -ForegroundColor $Color -NoNewline; Write-Host $Text }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-ForgeLine "x" "Red" "install: FORGE-NODE-NOT-FOUND - instale Node.js >=20 e reabra o terminal"
    Write-ForgeLine ">" "Yellow" "remedy: install Node.js >=20, or set FORGE_NODE=<path/to/node>"
    exit 2
}
$args = @((Join-Path $PSScriptRoot 'scripts/install_portable.mjs'))
if ($DryRun) { $args += '--dry-run' }
if ($NoLink) { $args += '--no-link' }
if ($Quiet) { $args += '--quiet' }
if ($Plain) { $args += '--plain' }
if ($Verbose) { $args += '--verbose' }
& $node.Source @args
exit $LASTEXITCODE
