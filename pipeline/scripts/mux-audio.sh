#!/bin/bash
# MUX AUDIO — restore the soundtrack. veed-engine-cli renders video only; this muxes the original audio
# onto the clean silent render. Deterministic; run OUTSIDE any sandbox is NOT required (ffmpeg only).
#
#   bash pipeline/scripts/mux-audio.sh <run-dir>
# Audio comes from --audio when given, else from <run-dir>/meta.json's source video. Muxes
# <run-dir>/<doc>/out.silent.mp4 -> out.mp4, where <doc> defaults to final.
#   VEED_ENGINE_FFMPEG  ffmpeg (default: ffmpeg on PATH)
set -euo pipefail
DIR="${1:?usage: mux-audio.sh <run-dir> [--doc final] [--audio <file>]}"
shift || true
# A film gates and delivers one chapter at a time, and its audio is a built mix rather than the
# source clip's track — hardcoding both was why the chain's own --doc flag stopped at the engine.
DOC="final"
AUDIO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --doc) DOC="${2:?--doc needs a subdirectory}"; shift ;;
    --audio) AUDIO="${2:?--audio needs a file}"; shift ;;
    *) echo "mux-audio: unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
FF="${VEED_ENGINE_FFMPEG:-ffmpeg}"
FP="${VEED_ENGINE_FFPROBE:-ffprobe}"
SILENT="$DIR/$DOC/out.silent.mp4"
OUT="$DIR/$DOC/out.mp4"
[ -f "$SILENT" ] || { echo "mux: missing $SILENT (render first)"; exit 1; }

# The audio is either a track that was BUILT for this run (a mix of narration, music and effects) or
# the source clip's own. Only the second needs meta.json — a run with no footage has none, and
# requiring it was why the footage-free path failed at its last gate.
if [ -n "$AUDIO" ]; then
  SRC="$AUDIO"
  [ -f "$SRC" ] || { echo "mux: no audio at $SRC"; exit 1; }
else
  # videoPath from meta.json (no jq): first "videoPath": "..." value.
  [ -f "$DIR/meta.json" ] || { echo "mux: no $DIR/meta.json and no --audio — say which track to lay on"; exit 2; }
  SRC="$(grep -m1 '"videoPath"' "$DIR/meta.json" | sed -E 's/.*"videoPath": *"([^"]+)".*/\1/')"
  [ -n "$SRC" ] && [ -f "$SRC" ] || { echo "mux: could not resolve source video from $DIR/meta.json"; exit 1; }
fi

# -map 1:a:0? tolerates a source with no audio track (out.mp4 then == silent render); -shortest trims to video.
# Write to a tmp name and rename: out.mp4 is watched live by the preview server, so its
# existence must mean completeness (a moov-less in-progress file plays as broken "done").
# +faststart keeps moov up front (the engine records it that way; default muxing would move it
# to the tail, making the deliverable start slower anywhere without Range support).
TMP="$DIR/$DOC/out.tmp.mp4"
# The PICTURE decides the length. `-shortest` let a built mix truncate the film — a 2s track over a
# 6s render wrote a 2s deliverable and exited 0, which destroys work without saying so.
VDUR="$("$FP" -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "$SILENT")"
[ -n "$VDUR" ] || VDUR="$("$FP" -v error -show_entries format=duration -of csv=p=0 "$SILENT")"
"$FF" -y -hide_banner -loglevel error -i "$SILENT" -i "$SRC" \
  -map 0:v:0 -map 1:a:0? -c:v copy -c:a aac -t "$VDUR" -movflags +faststart "$TMP"
mv "$TMP" "$OUT"
echo "mux: wrote $OUT"
