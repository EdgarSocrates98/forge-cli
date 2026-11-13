#!/usr/bin/env bash
# forge-cli portable install — Node >=20 source route.
# Delegates to scripts/install_portable.mjs which owns the pipeline;
# this wrapper only picks the interpreter and styles its own refusal.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

# -- decoration (plain when not interactive; honors NO_COLOR/CI) -----------
_f_yellow=""; _f_red=""; _f_reset=""
if [ -t 2 ] \
    && [ -z "${NO_COLOR:-}" ] && [ -z "${FORGE_NO_UI:-}" ] \
    && [ -z "${CI:-}" ] && [ -z "${GITHUB_ACTIONS:-}" ] \
    && [ "${TERM:-dumb}" != "dumb" ]; then
  _f_yellow=$'\033[33m'; _f_red=$'\033[31m'; _f_reset=$'\033[0m'
fi
_m_fail="x"; _m_dash="-"
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *[Uu][Tt][Ff]*|*[Uu][Tt][Ff]8*) _m_fail="✗"; _m_dash="—" ;;
esac

node_bin="${FORGE_NODE:-node}"
if ! command -v "$node_bin" >/dev/null 2>&1; then
  printf '  %s%s%s install: FORGE-NODE-NOT-FOUND %s instale Node.js >=20 e reabra o terminal\n' \
      "$_f_red" "$_m_fail" "$_f_reset" "$_m_dash" >&2
  printf '    %sremedy:%s install Node.js >=20, or point FORGE_NODE=<path/to/node>\n' \
      "$_f_yellow" "$_f_reset" >&2
  exit 2
fi
exec "$node_bin" "$root/scripts/install_portable.mjs" "$@"
