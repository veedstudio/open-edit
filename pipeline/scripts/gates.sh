#!/bin/bash
# THE GATE CHAIN, as one command.
#
# `generate-recipe.ts` already drives this for a compiled recipe. Every other path — the inline
# creative pass, a remix, a run with no footage — retyped the five gates below into every brief. All
# 52 agent briefs of the launch session carried them by hand, which is 52 chances to drop the probe,
# reorder the record, or forget that the engine needs the window-server.
#
#   bash pipeline/scripts/gates.sh <run-dir> [--doc <subdir>] [--audio <file>] [--no-mux] [--no-probe] [--no-expect] [--no-design] [--no-wcag]
#
# design → lint → --verify → WCAG → --record → probe-qa → mux. Stops at the first failure and names it.
# RUN OUTSIDE ANY SANDBOX: --verify and --record need the window-server.
#
# --no-probe   the run has no source footage to diff frames against
# --no-mux     the run has no soundtrack to restore (the silent render is copied to out.mp4, so the
#              deliverable path is the same on every path)
# --no-expect  skip deriving `verify.expect` from the document's own gates. Do not reach for this to
#              make a failure go away: an expect-visible failure means a cue is off screen inside the
#              window the document itself declares, which is a real defect no other gate can see.
# --no-design  the run has no design/system.json — true only of a compiled-recipe run, where the
#              recipe IS the system. An authored run without one is the defect this gate exists for.
set -euo pipefail

DIR="${1:?usage: gates.sh <run-dir> [--doc <subdir>] [--audio <file>] [--no-mux] [--no-probe] [--no-expect] [--no-design] [--no-wcag]}"
shift || true
NO_MUX=0
NO_PROBE=0
NO_EXPECT=0
NO_DESIGN=0
NO_WCAG=0
# Which document under the run this call gates. A captioned clip has one; a film has one per
# chapter, and hardcoding `final` was why a seven-chapter run found no route through here.
DOC="final"
# Whether --doc was actually GIVEN, which is a different question from which document is gated. The
# default is `final`, so passing it on unconditionally told design-gate every run was one chapter of
# a longer piece — and the declared-but-unused check, which only fires on a whole run, never ran at
# all through this chain.
DOC_GIVEN=0
# A built soundtrack rather than the source clip's track — a film has one, a captioned clip does not.
AUDIO=""
while [ $# -gt 0 ]; do
  a="$1"
  case "$a" in
    # `--doc final` is the default written out, not a request to gate one chapter of many.
    --doc) DOC="${2:?--doc needs a subdirectory}"; [ "$DOC" = "final" ] || DOC_GIVEN=1; shift ;;
    --audio) AUDIO="${2:?--audio needs a file}"; shift ;;
    --no-mux) NO_MUX=1 ;;
    --no-probe) NO_PROBE=1 ;;
    --no-expect) NO_EXPECT=1 ;;
    --no-design) NO_DESIGN=1 ;;
    --no-wcag) NO_WCAG=1 ;;
    *) echo "gates: unknown flag $a" >&2; exit 2 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FINAL="$DIR/$DOC"
TPL="$FINAL/template.wv"
ENGINE="${VEED_ENGINE_BIN:-$ROOT/.veed-engine/veed-engine-cli}"

[ -f "$TPL" ] || { echo "gates: no $TPL — author the document first" >&2; exit 2; }
[ -f "$FINAL/manifest.json" ] || { echo "gates: no $FINAL/manifest.json — the render block is required" >&2; exit 2; }

fail() { echo "gates: FAILED at $1 — fix that, then re-run gates.sh" >&2; exit 1; }

if [ "$NO_DESIGN" -eq 0 ]; then
  echo "gates: design"
  if [ "$DOC_GIVEN" -eq 1 ]; then
    node --import tsx "$ROOT/pipeline/scripts/design-gate.ts" "$DIR" --doc "$DOC" || fail "design"
  else
    node --import tsx "$ROOT/pipeline/scripts/design-gate.ts" "$DIR" || fail "design"
  fi
fi

echo "gates: lint"
node --import tsx "$ROOT/pipeline/scripts/lint-template.ts" "$TPL" || fail "lint"

# Derive the timing assertions from the document's own gates, unless the manifest already carries a
# hand-written set. Without them --verify only checks what IS drawn; with them it also checks WHEN.
# `--write` stamps what it derived, so a re-run can replace its own work and leave a hand-written block
# alone. Without the stamp the guard saw any `verify` block as authored and every later run gated the
# document against the timings of an earlier one.
if [ "$NO_EXPECT" -eq 0 ] && { ! grep -q '"verify"' "$FINAL/manifest.json" || grep -q '"derivedBy"' "$FINAL/manifest.json"; }; then
  node --import tsx "$ROOT/pipeline/scripts/expect-windows.ts" "$DIR" --doc "$DOC" --write >/dev/null || fail "expect-windows"
fi

echo "gates: verify"
"$ENGINE" "$FINAL" --verify || fail "--verify"

# Contrast is a REPORT, not a verdict. wcag-pass exits 1 only when its analyzer is missing or crashes,
# and its own documentation calls that an environment problem rather than a design failure — so it is
# said out loud and the run continues to a deliverable rather than dying without one.
#
# It reads <run>/final and takes no document argument, so it has nothing to say about a chapter of a
# longer piece. Running it anyway would either abort on a directory that is not there or, worse, report
# on a document this invocation never touched.
if [ "$NO_WCAG" -eq 0 ]; then
  if [ "$DOC" != "final" ]; then
    echo "gates: wcag skipped — it reads $DIR/final and this run gates $DOC; check contrast on the assembled film"
  else
    echo "gates: wcag"
    node --import tsx "$ROOT/pipeline/scripts/wcag-pass.ts" --run "$DIR" \
      || echo "gates: wcag could not run (analyzer missing or crashed) — contrast is UNCHECKED for this render" >&2
  fi
fi

echo "gates: record"
"$ENGINE" "$FINAL" --progress-output --record "$FINAL/out.silent.mp4" || fail "--record"

if [ "$NO_PROBE" -eq 0 ]; then
  echo "gates: probe-qa"
  node --import tsx "$ROOT/pipeline/scripts/probe-qa.ts" "$DIR" --doc "$DOC" || fail "probe-qa"
else
  echo "gates: probe-qa skipped (no source footage to diff against)"
fi

if [ "$NO_MUX" -eq 0 ]; then
  echo "gates: mux"
  bash "$ROOT/pipeline/scripts/mux-audio.sh" "$DIR" --doc "$DOC" ${AUDIO:+--audio "$AUDIO"} || fail "mux"
else
  cp "$FINAL/out.silent.mp4" "$FINAL/out.mp4"
  echo "gates: no soundtrack to restore — silent render copied to out.mp4"
fi

echo "gates: clean → $FINAL/out.mp4"
