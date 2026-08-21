#!/bin/bash
# POSIX shim. The mux lives in mux-audio.ts (Node, cross-platform); see it for usage.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec node --import tsx "$ROOT/pipeline/scripts/mux-audio.ts" "$@"
