#!/bin/bash
# Compatibility entrypoint. The installable skill owns the canonical preflight implementation, and
# every argument passes through to it untouched.
#
# It adds no --workspace of its own. This file travels with the content tree, which inside an install
# is a directory under node_modules — naming it as the workspace would put a user's renders there.
# Left alone, init takes the invoking checkout's top level, or the working directory.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The WCAG analyzer needs no check of its own: it ships inside the release engine (since 0.8.0, below
# every floor init enforces), so the engine check init runs covers it.

exec bash "$REPO_ROOT/.claude/skills/open-edit/scripts/preflight.sh" "$@"
