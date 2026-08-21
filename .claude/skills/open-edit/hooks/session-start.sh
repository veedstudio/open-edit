#!/bin/bash
# POSIX shim. The adapter is session-start.mjs (Node, cross-platform).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/session-start.mjs" "$@"
