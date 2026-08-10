// Pure client-side logic, kept out of app.js so node:test can exercise it.

export function chunkIndexAtTime(chunks, tSec) {
  let index = -1;
  for (let i = 0; i < chunks.length; i++) {
    if (tSec >= chunks[i].timestamp[0]) index = i;
    else break;
  }
  return index;
}

// Skip-forward: the first cue starting after now (with a small grace so the current
// cue's own start doesn't match). Null when there's nothing ahead.
export function nextCueTime(chunks, tSec) {
  const next = chunks.find((c) => c.timestamp[0] > tSec + 0.05);
  return next ? next.timestamp[0] : null;
}

// Skip-back, audio-player convention: deep into a cue restarts it; near its start
// (or between cues) goes to the previous cue's start; before everything, zero.
export function prevCueTime(chunks, tSec) {
  const i = chunkIndexAtTime(chunks, tSec);
  if (i >= 0 && tSec - chunks[i].timestamp[0] > 0.7) return chunks[i].timestamp[0];
  return i > 0 ? chunks[i - 1].timestamp[0] : 0;
}

// Width of the canvas at 100%: contained in the stage, never upscaled past the source — what Fit
// always showed. Computed rather than left to CSS, because `width:auto` renders a replaced element
// at intrinsic size and max-width only caps it, so CSS alone clamps zoom at native resolution.
export function fitWidth(availWidth, availHeight, videoWidth, videoHeight) {
  if (!videoWidth || !videoHeight) return 0;
  return Math.min(availWidth, availHeight * (videoWidth / videoHeight), videoWidth);
}

// Zoom re-centres on whatever was under the middle of the stage. Measured against the canvas, not
// the scroll origin — below 100% auto margins centre it, so scroll 0 is not its left edge.
export function focalFraction(viewportCentre, canvasStart, canvasSize) {
  if (!canvasSize) return 0.5;
  return (viewportCentre - canvasStart) / canvasSize;
}

// Scroll nudge that puts `fraction` back under the stage centre; the browser clamps overshoot.
export function refocusScrollDelta(viewportCentre, canvasStart, canvasSize, fraction) {
  return canvasStart + fraction * canvasSize - viewportCentre;
}

// Safari can suspend a paused media decoder when the page is backgrounded. Reloading the
// media resource re-arms it, which makes subsequent paused seeks paint the requested frame.
// Do not do this in Chromium/Firefox: reloading a video is disruptive and their decoders do
// not need the workaround.
export function rearmDecoder(video, userAgent = globalThis.navigator?.userAgent ?? '') {
  if (!/Safari/i.test(userAgent) || /Chrome|Chromium|CriOS|FxiOS|EdgiOS|OPiOS|Android/i.test(userAgent)) {
    return false;
  }
  const currentTime = video.currentTime;
  const restoreTime = () => {
    if (Number.isFinite(currentTime)) {
      video.currentTime = Math.min(currentTime, video.duration || currentTime);
    }
  };
  video.addEventListener('loadedmetadata', restoreTime, { once: true });
  video.load();
  return true;
}

// Position of one cue's block on the timeline track, as percentages of the run duration.
export function cueBlockGeometry(chunk, durationSec) {
  if (!durationSec || durationSec <= 0) return null;
  const [start, end] = chunk.timestamp;
  const leftPct = Math.min(100, Math.max(0, (start / durationSec) * 100));
  const rightPct = Math.min(100, Math.max(leftPct, (end / durationSec) * 100));
  return { leftPct, widthPct: rightPct - leftPct };
}
