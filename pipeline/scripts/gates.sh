#!/bin/bash
# POSIX shim. THE GATE CHAIN lives in gates.ts (Node, cross-platform); see it for usage and flags.
# RUN OUTSIDE ANY SANDBOX: --verify and --record need a real desktop session.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec node --import tsx "$ROOT/pipeline/scripts/gates.ts" "$@"
