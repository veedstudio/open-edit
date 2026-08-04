#!/bin/bash
# Compatibility entrypoint. The installable skill owns the canonical preflight implementation.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Only default the workspace when the caller did not give one, otherwise it is passed twice.
for arg in "$@"; do
  [ "$arg" = "--workspace" ] && exec bash "$REPO_ROOT/.claude/skills/open-edit/scripts/preflight.sh" "$@"
done
exec bash "$REPO_ROOT/.claude/skills/open-edit/scripts/preflight.sh" --workspace "$REPO_ROOT" "$@"
