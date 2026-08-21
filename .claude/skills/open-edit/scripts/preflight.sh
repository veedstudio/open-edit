#!/bin/bash
# macOS shim. The canonical preflight is preflight.mjs (Node, cross-platform); this wrapper restores
# the Homebrew PATH for GUI-launched agents and bootstraps Node itself — the one dependency the Node
# port cannot report on its own. Same contract: exit 10 = approval pending, stdout = OPEN_EDIT_ROOT.
set -uo pipefail

# GUI-launched agents inherit a minimal PATH that commonly omits Homebrew. Add both standard
# prefixes before probing node; preserve the caller's remaining PATH.
HOMEBREW_PATH_PREFIX="${OPEN_EDIT_HOMEBREW_PATH_PREFIX-/opt/homebrew/bin:/usr/local/bin}"
export PATH="${HOMEBREW_PATH_PREFIX:+$HOMEBREW_PATH_PREFIX:}$PATH"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  MODE=""
  for arg in "$@"; do [ "$arg" = "--auto-approve" ] && MODE="auto"; done
  if [ "$MODE" = "auto" ] && command -v brew >/dev/null 2>&1; then
    brew install node || { echo "preflight: ERROR — approved Node install failed" >&2; exit 1; }
  else
    echo "preflight: APPROVAL REQUIRED — install Node globally: brew install node" >&2
    echo "preflight: run with --auto-approve only after the user approves every action above" >&2
    exit 10
  fi
fi

exec node "$DIR/preflight.mjs" "$@"
