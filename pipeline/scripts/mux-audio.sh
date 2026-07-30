#!/bin/bash
# Step 5 — restore the soundtrack. veed-engine-cli renders video only; this muxes the original audio
# onto the clean silent render. Deterministic; run OUTSIDE any sandbox is NOT required (ffmpeg only).
#
#   bash pipeline/scripts/mux-audio.sh <run-dir>
# Reads <run-dir>/meta.json for the source video path; muxes <run-dir>/final/out.silent.mp4 -> out.mp4.
#   VEED_ENGINE_FFMPEG  ffmpeg (default: ffmpeg on PATH)
set -euo pipefail
DIR="${1:?usage: mux-audio.sh <run-dir>}"
FF="${VEED_ENGINE_FFMPEG:-ffmpeg}"
SILENT="$DIR/final/out.silent.mp4"
OUT="$DIR/final/out.mp4"
[ -f "$SILENT" ] || { echo "mux: missing $SILENT (render first)"; exit 1; }

# videoPath from meta.json (no jq): first "videoPath": "..." value.
SRC="$(grep -m1 '"videoPath"' "$DIR/meta.json" | sed -E 's/.*"videoPath": *"([^"]+)".*/\1/')"
[ -n "$SRC" ] && [ -f "$SRC" ] || { echo "mux: could not resolve source video from $DIR/meta.json"; exit 1; }

# -map 1:a:0? tolerates a source with no audio track (out.mp4 then == silent render); -shortest trims to video.
# Write to a tmp name and rename: out.mp4 is watched live by the preview server, so its
# existence must mean completeness (a moov-less in-progress file plays as broken "done").
# +faststart keeps moov up front (the engine records it that way; default muxing would move it
# to the tail, making the deliverable start slower anywhere without Range support).
TMP="$DIR/final/out.tmp.mp4"
"$FF" -y -hide_banner -loglevel error -i "$SILENT" -i "$SRC" \
  -map 0:v:0 -map 1:a:0? -c:v copy -c:a aac -shortest -movflags +faststart "$TMP"
mv "$TMP" "$OUT"
echo "mux: wrote $OUT"
