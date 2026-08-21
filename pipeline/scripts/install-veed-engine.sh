#!/bin/bash
# POSIX shim. The installer is install-veed-engine.mjs (Node, cross-platform); see it for usage.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec node "$REPO_ROOT/pipeline/scripts/install-veed-engine.mjs" "$@"
