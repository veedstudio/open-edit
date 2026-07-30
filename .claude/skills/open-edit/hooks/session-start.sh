#!/bin/bash
# Adapter for Claude Code, Codex, and Gemini CLI SessionStart hooks.
set -uo pipefail

AGENT="${1:-plain}"
SKILL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$(pwd -P)"
PREFLIGHT="${OPEN_EDIT_PREFLIGHT:-$SKILL_ROOT/scripts/preflight.sh}"
OUTPUT="$(bash "$PREFLIGHT" --workspace "$WORKSPACE" 2>&1)"
STATUS=$?

if [ "$STATUS" -eq 0 ] && ! printf '%s' "$OUTPUT" | grep -Eq 'APPROVAL REQUIRED|incomplete|not ready|waiting'; then
  CONTEXT="Open Edit preflight is ready. Before using the open-edit skill in this session, still run preflight --dry, resolve OPEN_EDIT_ROOT, and read OPEN_EDIT_ROOT/AGENTS.md completely. Proceed silently if preflight remains ready."
else
  CONTEXT="Open Edit startup preflight reported:\n${OUTPUT}\nBefore doing Open Edit work, ALWAYS run preflight --dry, communicate every APPROVAL REQUIRED action to the user, and wait for explicit approval. Run preflight --auto-approve only after the user approves all reported actions. Never install machine-global dependencies or update existing code without that approval. After resolving OPEN_EDIT_ROOT, read OPEN_EDIT_ROOT/AGENTS.md completely before running repository commands."
fi

if [ "$AGENT" = "gemini" ]; then
  # Gemini requires JSON on stdout. Encode the context with tools available on every supported macOS.
  ESCAPED="$(printf '%s' "$CONTEXT" | awk 'BEGIN { ORS="" } { gsub(/\\/, "\\\\"); gsub(/\"/, "\\\""); if (NR > 1) printf "\\n"; printf "%s", $0 }')"
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$ESCAPED"
else
  printf '%b\n' "$CONTEXT"
fi

# Session startup is advisory. The context carries any setup failure to the agent.
exit 0
