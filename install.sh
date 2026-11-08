#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
node_bin="${FORGE_NODE:-node}"
if ! command -v "$node_bin" >/dev/null 2>&1; then
  echo "FORGE-NODE-NOT-FOUND: instale Node.js >=20 e reabra o terminal" >&2
  exit 2
fi
exec "$node_bin" "$root/scripts/install_portable.mjs" "$@"
