// Page wiring, grouped: state + formatters · status strip · transcript rail · shared time
// sync · timeline · player · transport + keyboard · plumbing/boot. The preview is read-only
// in V1: watch the footage while the style cooks, follow the transcript, grab the render.
// Pure logic lives in helpers.mjs (tested from node); everything here touches the DOM.
import { chunkIndexAtTime, cueBlockGeometry, fitWidth, focalFraction, nextCueTime, prevCueTime, rearmDecoder, refocusScrollDelta } from './helpers.mjs';

// ---- elements + state ----
const $ = (id) => document.getElementById(id);
const player = $('player');
const lines = $('lines');
const track = $('track'); // cue lane (violet blocks)
const tracks = $('tracks'); // slider role + geometry reference spanning both lanes
const lanes = $('lanes'); // the scrub surface: ruler, lanes, and the needle's grab pad all seek
const playhead = $('playhead');
const playBtn = $('play');
const timecodeNow = $('timecode-now');
const timecodeSub = $('timecode-sub');
const timecodeDur = $('timecode-dur');

let state = null;
let railHovered = false;

// ---- formatters ----
function duration() {
  return state?.video?.durationSec || player.duration || 0;
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtTimecode(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`; // veed editor format
}

function fps() {
  return state?.video?.fps ?? null; // no meta -> no fps readout; never invent one
}

function fmtElapsed(sinceMs) {
  return fmtTime(Math.max(0, Math.floor((Date.now() - sinceMs) / 1000)));
}

function announce(msg) {
  $('announce').textContent = msg;
}

// ---- status strip ----
let lastStage = null;
function renderStrip() {
  const pill = $('stage-pill');
  const pillText = $('pill-text');
  pill.hidden = false;
  pill.classList.remove('pending', 'done');
  if (state.stage === 'rendered') {
    pill.classList.add('done');
    pillText.textContent = 'done · final video';
  } else if (state.stage === 'cooking') {
    pill.classList.add('pending');
    const since = state.stageStartedAtMs ? ` · ${fmtElapsed(state.stageStartedAtMs)}` : '';
    pillText.textContent = `pending · designing style${since}`;
    pill.title = 'Subtitles appear on the video when the style is done';
  } else {
    pill.classList.add('pending');
    pillText.textContent = 'pending · transcribing';
  }
  const phase = state.stage === 'cooking' ? 1 : 0; // 0 transcribe, 1 design, 2 render
  $('stage-steps').querySelectorAll('i').forEach((seg, i) => {
    seg.classList.toggle('done', i < phase);
    seg.classList.toggle('active', i === phase);
  });
  if (state.stage !== lastStage) {
    if (lastStage !== null) {
      announce(state.stage === 'rendered' ? 'Final video ready' : state.stage === 'cooking' ? 'Transcribed; designing the style' : 'Transcribing');
    }
    lastStage = state.stage;
  }
}

setInterval(() => { if (state && state.stage === 'cooking') renderStrip(); }, 1000);

// ---- transcript rail (read-only; click a line to jump there) ----
function buildRow(i) {
  const li = document.createElement('li');
  li.dataset.index = String(i);
  const text = document.createElement('span');
  text.className = 'text';
  li.append(text);
  li.addEventListener('click', () => {
    const c = state.chunks?.[i];
    if (c) {
      player.currentTime = c.timestamp[0];
      syncToTime();
    }
  });
  return li;
}

function renderTranscript() {
  $('no-speech').hidden = state.chunks?.length !== 0; // shown only for a present-but-empty transcript
  if (!state.chunks) { lines.replaceChildren(); return; } // unreadable transcript
  if (lines.childElementCount !== state.chunks.length) {
    lastActive = -2; // fresh rows carry no active class yet
    lines.replaceChildren(...state.chunks.map((_, i) => buildRow(i)));
  }
  state.chunks.forEach((chunk, i) => {
    const text = lines.children[i].querySelector('.text');
    if (text.textContent !== chunk.text) text.textContent = chunk.text;
  });
}

// ---- shared time sync: transcript highlight + track state + timecode ----
let lastActive = -2; // -2 = force the first pass (chunkIndexAtTime yields -1 before the first cue)
let lastDur = -1;

function syncToTime() {
  if (!state) return;
  const t = player.currentTime;
  const dur = duration();
  if (dur) {
    playhead.style.left = `${(t / dur) * 100}%`;
    // AE shape in VEED's dialect: "now / total" at reading size, fps beneath (frame numbers
    // cut for v1; blank-but-reserved when fps is unknown so the line never collapses)
    timecodeNow.textContent = fmtTimecode(t);
    const f = fps();
    timecodeSub.textContent = f ? `${f} fps` : '\u00a0';
    tracks.setAttribute('aria-valuenow', String(Math.round(t)));
    tracks.setAttribute('aria-valuetext', `${fmtTimecode(t)} of ${fmtTimecode(dur)}`);
    if (dur !== lastDur) {
      lastDur = dur;
      timecodeDur.textContent = ` / ${fmtTimecode(dur)}`;
      tracks.setAttribute('aria-valuemax', String(Math.round(dur)));
    }
  }
  if (!state.chunks?.length) return;
  const active = chunkIndexAtTime(state.chunks, t);
  if (active === lastActive) return; // every toggle below would be a no-op; skip the sweep (scrub rate matters)
  lastActive = active;
  for (const li of lines.children) {
    const isActive = Number(li.dataset.index) === active;
    li.classList.toggle('active', isActive);
    if (isActive && !railHovered) li.scrollIntoView({ block: 'nearest' });
  }
  for (const blk of track.querySelectorAll('.blk')) {
    blk.classList.toggle('active', Number(blk.dataset.index) === active);
  }
}

player.addEventListener('timeupdate', syncToTime);

// ---- timeline: ruler + cue/footage lanes + scrub + hover tooltip ----
let lastTrackKey = ''; // blocks and ruler depend only on chunk count + duration

function rebuildLanes(dur) {
  const ruler = $('ruler');
  ruler.replaceChildren();
  if (dur) {
    const step = dur <= 16 ? 2 : dur <= 45 ? 5 : dur <= 120 ? 10 : 30;
    for (let s = 0; s <= dur; s += step) {
      const label = document.createElement('span');
      label.style.left = `${(s / dur) * 100}%`;
      label.textContent = s >= 60 ? fmtTime(s) : `${s}s`;
      ruler.append(label);
    }
  }
  track.querySelectorAll('.blk').forEach((el) => el.remove());
  for (const [i, chunk] of (state.chunks ?? []).entries()) {
    const g = cueBlockGeometry(chunk, dur);
    if (!g) continue;
    const blk = document.createElement('div');
    blk.className = 'blk';
    blk.dataset.index = String(i);
    blk.style.left = `${g.leftPct}%`;
    blk.style.width = `${g.widthPct}%`;
    track.append(blk);
  }
  lastActive = -2; // fresh blocks carry no active class yet
}

function renderTrack() {
  const dur = duration();
  // footage lane: V1 has exactly one source video = one clip block spanning the run
  const label = state.video?.videoPath ? state.video.videoPath.split('/').pop() : 'source';
  $('footage-label').textContent = label;
  tracks.title = label;
  const key = `${state.chunks?.length ?? 0}@${dur}`;
  if (key !== lastTrackKey) {
    lastTrackKey = key;
    rebuildLanes(dur);
  }
  syncToTime();
}

// pointer position -> clamped time
function pointerTime(e) {
  const dur = duration();
  if (!dur) return null;
  const rect = tracks.getBoundingClientRect();
  const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  return pct * dur;
}

let scrubbing = false;
lanes.addEventListener('pointerdown', (e) => {
  scrubbing = true;
  if (e.target === playhead) {
    playhead.classList.add('dragging'); // keep the grab affordance lit while captured
    lanes.classList.add('dragging-needle');
  }
  const t = pointerTime(e);
  if (t !== null) { player.currentTime = t; syncToTime(); }
  try { lanes.setPointerCapture(e.pointerId); } catch { /* capture is drag-only sugar; never block the seek */ }
});
function endScrub() {
  scrubbing = false;
  playhead.classList.remove('dragging');
  lanes.classList.remove('dragging-needle');
}
lanes.addEventListener('pointerup', endScrub);
lanes.addEventListener('pointercancel', endScrub);

// tooltip is absolutely positioned: a hover affordance that shifts row layout was a real shipped bug
const tip = $('track-tip');
lanes.addEventListener('pointermove', (e) => {
  const t = pointerTime(e);
  if (t === null) return;
  if (scrubbing) { player.currentTime = t; syncToTime(); }
  tip.textContent = fmtTimecode(t);
  tip.style.left = `${e.clientX - tracks.parentElement.getBoundingClientRect().left}px`;
  tip.hidden = false;
});
lanes.addEventListener('pointerleave', () => { tip.hidden = true; });

// ---- player: source selection + error honesty + chrome ----
function renderPlayer() {
  // keyed on the render existing, not on the stage: an edit puts a delivered run back to cooking,
  // and the last good render must keep playing until the new one lands rather than snapping back
  // to the unsubtitled source. Its changing mtime is what swaps it in.
  const desired = state.renderMtimeMs !== null ? `/render?v=${state.renderMtimeMs}` : '/video';
  // after a media error, fall through even when src is unchanged: the next state event
  // becomes the retry (a stale error must never outlive its cause; no timers involved)
  if (player.dataset.src === desired && !player.error) return;
  const at = player.currentTime;
  const wasPaused = player.paused;
  player.dataset.src = desired;
  $('video-error').hidden = true;
  player.src = desired;
  player.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(at) && at > 0) player.currentTime = Math.min(at, player.duration || at);
    player.playbackRate = Number($('speed').value); // a src swap silently resets the rate
    if (!wasPaused) player.play().catch(() => {});
    renderTrack(); // duration may only now be known
    applyZoom();   // and so may the source's real dimensions
  }, { once: true });
}

player.addEventListener('error', () => {
  // only decode/source failures (3/4) earn the codec message; transient network errors stay quiet
  const code = player.error?.code ?? 0;
  if (code >= 3 && player.dataset.src === '/video') $('video-error').hidden = false;
});
player.addEventListener('loadedmetadata', () => {
  $('video-error').hidden = true; // recovered (e.g. the render swapped in)
});

// No buffering ring: the media is local, so there is nothing to wait for. Measured on a 2.7GB
// 1h55m source, the worst case we have, far seeks resolved in 13-132ms — never long enough to
// read as anything but a flicker, while the indicator itself bit us twice over.

// ---- transport + keyboard ----
function togglePlay() {
  if (player.paused) player.play().catch(() => {});
  else player.pause();
}
function gotoPrevCue() {
  if (!state?.chunks) return;
  player.currentTime = prevCueTime(state.chunks, player.currentTime);
  syncToTime();
}
function gotoNextCue() {
  if (!state?.chunks) return;
  const t = nextCueTime(state.chunks, player.currentTime);
  if (t !== null) { player.currentTime = t; syncToTime(); }
}

playBtn.addEventListener('click', togglePlay);
player.addEventListener('click', togglePlay);
$('prev').addEventListener('click', gotoPrevCue);
$('next').addEventListener('click', gotoNextCue);
player.loop = true; // review loops by default (Anton); the button turns it off
function renderLoopBtn() {
  // the icon alone did not say what the control does, let alone which way it is set
  const on = player.loop;
  $('loop').setAttribute('aria-pressed', String(on));
  $('loop').setAttribute('aria-label', on ? 'Loop: on' : 'Loop: off');
  $('loop').dataset.tip = on ? 'Loop: on' : 'Loop: off';
}
renderLoopBtn();
$('loop').addEventListener('click', () => {
  player.loop = !player.loop;
  renderLoopBtn();
});
$('speed').addEventListener('change', () => { player.playbackRate = Number($('speed').value); });

// Canvas zoom: every step a multiple of the fit width, so 100% is fit and 50% is half of what you
// were looking at. An overflowing canvas pans by drag, with a slop guard so a plain click still
// toggles play.
const zoomSel = $('zoom');

function applyZoom() {
  const wrap = $('player-wrap');
  const stage = $('stage-area');
  const z = Number(zoomSel.value);
  const vw = state?.video?.width || player.videoWidth;
  const vh = state?.video?.height || player.videoHeight;
  if (!vw || !vh) return; // no dimensions yet; the CSS contain rules hold the fort
  // measured off the stage, which never scrolls: the wrap's own box loses width to the scrollbar
  // once zoomed, so fit would drift with the zoom that caused it
  const pad = getComputedStyle(wrap);
  const availW = stage.clientWidth - Number.parseFloat(pad.paddingLeft) - Number.parseFloat(pad.paddingRight);
  const availH = stage.clientHeight - Number.parseFloat(pad.paddingTop) - Number.parseFloat(pad.paddingBottom);
  const w = fitWidth(availW, availH, vw, vh) * z;
  if (w <= 0) return;
  player.style.maxWidth = 'none'; // the contain caps would re-clamp everything above 100%
  player.style.maxHeight = 'none';
  player.style.width = `${Math.round(w)}px`;
  player.style.height = 'auto';
  wrap.classList.toggle('zoomed', z > 1); // only an overflowing canvas is pannable
}

zoomSel.addEventListener('change', () => {
  const wrap = $('player-wrap');
  const stage = wrap.getBoundingClientRect();
  const centreX = stage.left + stage.width / 2;
  const centreY = stage.top + stage.height / 2;
  const before = player.getBoundingClientRect(); // read the focal point before the resize moves it
  const fracX = focalFraction(centreX, before.left, before.width);
  const fracY = focalFraction(centreY, before.top, before.height);
  applyZoom();
  const after = player.getBoundingClientRect(); // forces the new layout
  wrap.scrollLeft += refocusScrollDelta(centreX, after.left, after.width, fracX);
  wrap.scrollTop += refocusScrollDelta(centreY, after.top, after.height, fracY);
});

new ResizeObserver(applyZoom).observe($('stage-area')); // fit depends on the stage size

let pan = null;
let panMoved = false;
$('player-wrap').addEventListener('pointerdown', (e) => {
  const wrap = $('player-wrap');
  if (!wrap.classList.contains('zoomed')) return;
  pan = { x: e.clientX, y: e.clientY, left: wrap.scrollLeft, top: wrap.scrollTop };
  panMoved = false;
});
$('player-wrap').addEventListener('pointermove', (e) => {
  if (!pan) return;
  const dx = e.clientX - pan.x;
  const dy = e.clientY - pan.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) panMoved = true;
  const wrap = $('player-wrap');
  wrap.scrollLeft = pan.left - dx;
  wrap.scrollTop = pan.top - dy;
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
  $('player-wrap').addEventListener(ev, () => { pan = null; });
}
// the click that ends a drag must not reach click-to-play
player.addEventListener('click', (e) => {
  if (panMoved) {
    e.stopImmediatePropagation();
    panMoved = false;
  }
}, true);

$('mute').addEventListener('click', () => { player.muted = !player.muted; });
player.addEventListener('volumechange', () => {
  $('mute').classList.toggle('muted', player.muted);
  const label = player.muted ? 'Unmute' : 'Mute';
  $('mute').setAttribute('aria-label', label);
  $('mute').dataset.tip = label;
});
function renderPlayBtn(playing) {
  playBtn.classList.toggle('playing', playing);
  const label = playing ? 'Pause' : 'Play';
  playBtn.setAttribute('aria-label', label);
  playBtn.dataset.tip = label;
}
player.addEventListener('play', () => renderPlayBtn(true));
player.addEventListener('pause', () => renderPlayBtn(false));

// reading the rail shouldn't fight the auto-follow
$('transcript').addEventListener('mouseenter', () => { railHovered = true; });
$('transcript').addEventListener('mouseleave', () => { railHovered = false; });

document.addEventListener('keydown', (e) => {
  if (!state || state.stage === 'waiting') return;
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLButtonElement) return; // let controls keep their keys
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  if (e.key === 'ArrowLeft') { player.currentTime = Math.max(0, player.currentTime - 1); syncToTime(); }
  if (e.key === 'ArrowRight') { player.currentTime = Math.min(duration(), player.currentTime + 1); syncToTime(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); gotoPrevCue(); }
  if (e.key === 'ArrowDown') { e.preventDefault(); gotoNextCue(); }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') rearmDecoder(player);
});

// ---- state plumbing + boot ----
let lastRendered = ''; // duplicate SSE frames are no-ops; skip them

function render() {
  lastRendered = JSON.stringify(state);
  const ready = state.stage !== 'waiting';
  $('layout').hidden = !ready;
  $('waiting').hidden = ready;
  renderStrip();
  if (ready) {
    renderTranscript();
    renderPlayer();
    renderTrack();
    // said on the canvas, where the eye is: an unsubtitled video reads as a failed render. Only
    // before the first render — after that the render is what's on screen.
    $('cooking-note').hidden = !(state.stage === 'cooking' && state.renderMtimeMs === null);
  }
}

function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    if (e.data === lastRendered) return;
    state = JSON.parse(e.data);
    render();
  };
  es.onopen = () => { $('conn').hidden = true; };
  es.onerror = () => { $('conn').hidden = false; }; // EventSource auto-retries
}

fetch('/api/state')
  .then(async (r) => {
    if (!r.ok) throw new Error(`state ${r.status}`);
    state = await r.json();
    render();
  })
  .catch(() => { $('waiting').textContent = 'Waiting for the preview server…'; })
  .finally(connect); // SSE self-heals both failure paths and delivers every later state
