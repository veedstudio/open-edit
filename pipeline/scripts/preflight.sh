#!/bin/bash
# Compatibility entrypoint. The installable skill owns the canonical preflight implementation.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec bash "$REPO_ROOT/.claude/skills/open-edit/scripts/preflight.sh" --workspace "$REPO_ROOT" "$@"
