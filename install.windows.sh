#!/usr/bin/env bash
# Windows Git Bash adapter for scripts/install_portable.mjs, via install.sh.
# PowerShell users should run install.ps1; this route intentionally stays Bash-only.
if [ -z "${BASH_VERSION:-}" ]; then
  echo "FORGE-SHELL-UNAVAILABLE: execute com Git Bash ou use install.ps1 no PowerShell" >&2
  exit 2
fi
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec "$root/install.sh" "$@"
