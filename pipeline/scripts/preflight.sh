#!/bin/bash
# Compatibility entrypoint. The installable skill owns the canonical preflight implementation.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# WCAG tooling (report-only, like everything here): the wcag pass is a DEFAULT gate on creative
# runs and hard-fails at run time when the analyzer is missing — surface that up front instead of
# mid-pipeline. Path mirrors the config.ts default (env-overridable the same way).
WEAVE_RENDERER_ROOT="${WEAVE_RENDERER_ROOT:-$REPO_ROOT/../weave-renderer}"
WCAG_CONTRAST="${WCAG_CONTRAST_BIN:-$WEAVE_RENDERER_ROOT/src/crates/wcag-contrast/target/debug/wcag-contrast}"
if [ ! -x "$WCAG_CONTRAST" ]; then
  echo "wcag: analyzer NOT FOUND ('$WCAG_CONTRAST') — the wcag pass will fail. Build it:"
  echo "  cd $WEAVE_RENDERER_ROOT/src/crates/wcag-contrast && cargo build"
else
  echo "wcag: analyzer ok"
fi

# Only default the workspace when the caller did not give one, otherwise it is passed twice.
for arg in "$@"; do
  [ "$arg" = "--workspace" ] && exec bash "$REPO_ROOT/.claude/skills/open-edit/scripts/preflight.sh" "$@"
done
exec bash "$REPO_ROOT/.claude/skills/open-edit/scripts/preflight.sh" --workspace "$REPO_ROOT" "$@"
