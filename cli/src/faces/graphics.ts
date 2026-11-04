// Graphics burned into footage (a broadcast lower third, a score bar, old subtitles, a channel logo), found on the
// grey frames faces samples, without OCR or a model. A pixel on a sharp edge that holds its value for a while is
// a candidate; the footage's own still parts (a wall, a cushion in a locked-off interview) hold too, so a held run
// counts only with evidence that it sits on top of the picture rather than in it:
//   - it held while most of the frame changed, at a cut or through camera movement, or
//   - it is the rarer state of that pixel in its shot and it replaced, or gave way to, other content at once, content
//     that was itself steady and is not the same picture shifted by a pixel (a hand passing, a camera nudge, a zoom).
// Both are judged past a step in the camera's exposure, which changes every bright pixel and nothing in the picture.
// Pixels with evidence are grouped per sampled frame into boxes and followed through time into regions, each with
// the seconds it is up, and a region is kept when it is drawn square to the frame, as text, plates and logos are.
import { closeSync, openSync, readSync } from 'node:fs';

/** A region in the clip's display pixels, top-left origin, up from `from` to `to` seconds of the clip. */
export interface GraphicBox { x: number; y: number; w: number; h: number; from: number; to: number }

// The frames are analysed at this size on their longer side: a lower third's smallest line of text stays several
// pixels tall, and a five-minute clip's frames stay a few seconds of work.
export const LONG_SIDE = 480;

/** The size the frames are analysed at: LONG_SIDE on the longer side (never enlarged), both sides even. */
export function workSize(width: number, height: number): { width: number; height: number } {
  const k = Math.min(1, LONG_SIDE / Math.max(width, height));
  const even = (v: number) => Math.max(2, Math.round((v * k) / 2) * 2);
  return { width: even(width), height: even(height) };
}

// An edge: a step of at least this many grey levels to the pixel left of it or above it.
const EDGE = 40;
// Within this many levels of the value it started at, a pixel holds: past the encoder's flicker on a still graphic.
const STILL = 8;
// Further than this from another value, content is other content.
const CHANGED = 24;
// The middle half of a steady neighbour state lies within this many levels.
const SPREAD = 16;
// A sample where this share of the frame moved by more than STILL is a cut (or a flash, or a whip pan).
const CUT = 0.5;
// A run over which this share of the frame moved on average is a run the camera or the scene moved through.
const MOVING = 0.25;
// An exposure step is fitted on every FIT_STRIDE-th pixel, from the median ratio of the pixels at LIT or above, in
// FIT_ROUNDS rounds on at least FIT_LEAST of them, and is one only while its gain stays within MAX_GAIN either way: past
// that a fit is one frame's flat field mapped onto another's.
const FIT_STRIDE = 4;
const LIT = 16;
const FIT_ROUNDS = 4;
const FIT_LEAST = 100;
const MAX_GAIN = 1.5;
const RATIO_STEP = 256;
const RATIO_BINS = 4 * RATIO_STEP;
// Seconds a pixel must hold to count, how far either side its neighbour state is read, and how long it may be
// covered (by a flicker, a passing hand) and still be the same run.
const HOLD_SEC = 1.5;
const WINDOW_SEC = 2;
const GAP_SEC = 0.5;
// The frame's outer pixels are left out: an encoder's or a scaler's edge line is not a graphic.
const BORDER = 2;
// Pixels with evidence are counted per CELL x CELL block; a block with CELL_MIN of them is part of a graphic.
const CELL = 4;
const CELL_MIN = 2;
// A box keeps at least this share of the frame's pixels as evidence, and that much of its own area: scattered
// specks are left out, a line of text is kept.
const MIN_SHARE = 0.0003;
const DENSITY = 0.025;
// A box is at least MIN_CELLS cells wide and at most TALL times as tall as it is wide.
const MIN_CELLS = 3;
const TALL = 1.5;
// A box joins a region when they overlap by this much of their union; a region is the cells it covered in at least
// KEEP of its samples.
const LINK = 0.5;
const KEEP = 0.25;
// The frames a shot's per-pixel median is taken over, spread evenly across it.
const MEDIAN_FRAMES = 15;
// Text, plates and logos are drawn square to the frame: a region keeps at least this share of its strong gradients
// within 22.5 degrees of the horizontal or the vertical (half of them, by chance), over SQUARE_FRAMES of its samples.
// Stripes on a cushion or a dress, seen at a slant, fall well short.
const SQUARE = 0.4;
const SQUARE_FRAMES = 5;
const TAN_22_5 = Math.tan(Math.PI / 8);

/** Text is kept this far from a graphic, as a share of the frame's shorter side, by faces.js. */
export const GRAPHICS_MARGIN = 0.01;

const steps = (sec: number, every: number, least: number) => Math.max(least, Math.round(sec / every));

/** The median of the first `n` values of `v`, which it sorts. Insertion sort: `n` is at most a few dozen. */
function medianOf(v: Uint8Array, n: number): number {
  for (let i = 1; i < n; i++) {
    const x = v[i];
    let j = i - 1;
    while (j >= 0 && v[j] > x) { v[j + 1] = v[j]; j--; }
    v[j + 1] = x;
  }
  return v[n >> 1];
}

/** Frame i of a file of grey frames `bytes` long each, read into `into`. */
function readFrame(fd: number, i: number, into: Uint8Array): void {
  const bytes = into.length;
  for (let at = 0; at < bytes;) {
    const got = readSync(fd, into, at, bytes - at, i * bytes + at);
    if (got <= 0) throw new Error(`the sampled frames end before frame ${i}`);
    at += got;
  }
}

/** The share of the pixels of `b` further than STILL from `gain` times the same pixel of `a` plus `offset`. */
function movedShare(a: Uint8Array, b: Uint8Array, gain: number, offset: number): number {
  let count = 0;
  for (let p = 0; p < a.length; p++) {
    const d = b[p] - (gain * a[p] + offset);
    if (d > STILL || d < -STILL) count++;
  }
  return count / a.length;
}

/**
 * The gain and offset that carry the grey levels of `a` into those of `b`: from the ratio most lit pixels moved by,
 * refitted on the pixels that carry within STILL; null when it is no exposure step, or no fit.
 */
function exposureStep(a: Uint8Array, b: Uint8Array): { gain: number; offset: number } | null {
  // Ratios in steps of 1/RATIO_STEP, up to RATIO_BINS of them; a near-black pixel's ratio is noise.
  const bins = new Uint32Array(RATIO_BINS);
  let lit = 0;
  for (let p = 0; p < a.length; p += FIT_STRIDE) {
    if (a[p] < LIT) continue;
    bins[Math.min(RATIO_BINS - 1, Math.floor((b[p] * RATIO_STEP) / a[p]))]++;
    lit++;
  }
  if (lit < FIT_LEAST) return null;
  let bin = 0;
  for (let below = 0; below + bins[bin] <= lit / 2; bin++) below += bins[bin];
  let gain = (bin + 0.5) / RATIO_STEP;
  let offset = 0;
  for (let round = 0; round < FIT_ROUNDS; round++) {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let p = 0; p < a.length; p += FIT_STRIDE) {
      const x = a[p];
      const y = b[p];
      const d = y - (gain * x + offset);
      if (d > STILL || d < -STILL) continue;
      n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    const vx = sxx / n - (sx / n) ** 2;
    if (n < FIT_LEAST || vx < 1) return null;
    gain = (sxy / n - (sx / n) * (sy / n)) / vx;
    offset = sy / n - gain * (sx / n);
  }
  return gain >= 1 / MAX_GAIN && gain <= MAX_GAIN ? { gain, offset } : null;
}

/** Per sampled frame from the second: the share of pixels that moved from the one before, and the exposure step between them. */
interface Motion { moved: Float64Array; gain: Float64Array; offset: Float64Array }

/**
 * The share of pixels that moved by more than STILL from each sampled frame to the next; 0 for the first. Where enough
 * moved to matter, it is the share that moved past the exposure step between them, if there is one: a camera whose
 * exposure jumps at a cut within one locked-off view changes every bright pixel and nothing in the picture.
 */
function motion(fd: number, n: number, pixels: number): Motion {
  const out = { moved: new Float64Array(n), gain: new Float64Array(n).fill(1), offset: new Float64Array(n) };
  let prev = new Uint8Array(pixels);
  let cur = new Uint8Array(pixels);
  readFrame(fd, 0, prev);
  for (let i = 1; i < n; i++) {
    readFrame(fd, i, cur);
    out.moved[i] = movedShare(prev, cur, 1, 0);
    const step = out.moved[i] >= MOVING ? exposureStep(prev, cur) : null;
    // A step is one only when it accounts for the motion: a cut or a pan with some change of exposure stays what it is.
    const past = step ? movedShare(prev, cur, step.gain, step.offset) : 1;
    if (step && past < MOVING) {
      out.moved[i] = past;
      out.gain[i] = step.gain;
      out.offset[i] = step.offset;
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return out;
}

/** Per pixel, 1 where it steps by EDGE or more to the pixel left of it or above it, away from the frame's border. */
function edges(f: Uint8Array, w: number, h: number, out: Uint8Array): void {
  out.fill(0);
  for (let y = Math.max(1, BORDER); y < h - BORDER; y++) {
    let p = y * w + Math.max(1, BORDER);
    for (let x = Math.max(1, BORDER); x < w - BORDER; x++, p++) {
      const v = f[p];
      const a = v - f[p - 1];
      const b = v - f[p - w];
      if (a >= EDGE || a <= -EDGE || b >= EDGE || b <= -EDGE) out[p] = 1;
    }
  }
}

/** Each pixel's current run: the value it holds, its first and latest matching samples, and whether it replaced steady content. */
interface Runs { ref: Uint8Array; start: Int32Array; last: Int32Array; active: Uint8Array; onset: Uint8Array }

/**
 * Sample t of the runs: a pixel on an edge within STILL of its run's value extends it; one off it for more than `gap`
 * samples ends it (`ended`); an edge pixel with no run starts one. `reached` is told when a run first spans `hold` samples.
 */
function step(runs: Runs, f: Uint8Array, edge: Uint8Array, t: number, hold: number, gap: number,
  reached: (p: number) => void, ended: (p: number) => void): void {
  const { ref, start, last, active, onset } = runs;
  const n = f.length;
  for (let p = 0; p < n; p++) {
    if (active[p]) {
      const d = f[p] - ref[p];
      if (edge[p] && d <= STILL && d >= -STILL) {
        last[p] = t;
        if (onset[p] === 0 && t - start[p] + 1 >= hold) reached(p);
        continue;
      }
      if (t - last[p] <= gap) continue;
      ended(p);
      active[p] = 0;
    }
    if (edge[p]) {
      active[p] = 1;
      ref[p] = f[p];
      start[p] = t;
      last[p] = t;
      onset[p] = 0;
    }
  }
}

/**
 * The regions of graphics burned into a clip, from its sampled frames: `raw` holds them one after another, grey, a
 * byte a pixel at `size`, sampled at `times` seconds every `every` seconds; boxes come back in `display` pixels.
 */
export function analyseGraphics(raw: string, size: { width: number; height: number }, times: number[], every: number,
  display: { width: number; height: number }, durationSec: number): GraphicBox[] {
  const { width: W, height: H } = size;
  const P = W * H;
  const N = times.length;
  if (N < 2) return [];
  const L = steps(HOLD_SEC, every, 2);
  const K = steps(WINDOW_SEC, every, 2);
  const GAP = steps(GAP_SEC, every, 0);
  const fd = openSync(raw, 'r');
  try {
    // A sample where most of the frame moved starts a new shot.
    const { moved, gain, offset } = motion(fd, N, P);
    const shotOf = new Int32Array(N);
    const shotStart: number[] = [0];
    for (let i = 1; i < N; i++) {
      if (moved[i] >= CUT) shotStart.push(i);
      shotOf[i] = shotStart.length - 1;
    }
    const shotEnd = (s: number) => (s + 1 < shotStart.length ? shotStart[s + 1] : N);
    const movedSum = new Float64Array(N + 1);
    const cuts = new Int32Array(N + 1);
    for (let i = 0; i < N; i++) {
      movedSum[i + 1] = movedSum[i] + moved[i];
      cuts[i + 1] = cuts[i] + (i > 0 && moved[i] >= CUT ? 1 : 0);
    }

    const medians = new Map<number, Uint8Array>();
    function medianOfShot(s: number): Uint8Array {
      const kept = medians.get(s);
      if (kept) return kept;
      const lo = shotStart[s];
      const hi = shotEnd(s);
      const n = Math.min(MEDIAN_FRAMES, hi - lo);
      const stack = Array.from({ length: n }, () => new Uint8Array(P));
      stack.forEach((f, j) => readFrame(fd, lo + Math.floor(((j + 0.5) * (hi - lo)) / n), f));
      const m = new Uint8Array(P);
      const v = new Uint8Array(n);
      for (let p = 0; p < P; p++) {
        for (let j = 0; j < n; j++) v[j] = stack[j][p];
        m[p] = medianOf(v, n);
      }
      // Runs are judged in time order, so only the latest shots are asked for again.
      if (medians.size > 2) medians.delete(medians.keys().next().value!);
      medians.set(s, m);
      return m;
    }

    // Frames from BACK samples before the current one to K after it: a run's onset is judged once it has held for
    // L samples (and up to two gaps more), from the K samples before it; its end from the K samples after.
    const BACK = L + K + 2 * GAP + 2;
    const R = BACK + K + 1;
    const ring = Array.from({ length: R }, () => new Uint8Array(P));
    let loaded = -1;
    const frame = (i: number): Uint8Array | null => (i <= loaded && i > loaded - R && i >= 0 ? ring[i % R] : null);
    const vals = new Uint8Array(K);

    /**
     * Whether, over frames lo to hi (exclusive), pixel p was steady at something other than v, and so was every
     * pixel around it, and the frame `next` to the run was already that other content: content that replaced the
     * run, or that it gave way to, at once, rather than the run shifted a pixel or drifting there in a slow zoom.
     */
    function replaced(lo: number, hi: number, next: number, p: number, v: number): boolean {
      const n = hi - lo;
      const beside = frame(next);
      if (n < 2 || !beside || Math.abs(beside[p] - v) <= CHANGED) return false;
      const fs: Uint8Array[] = [];
      for (let i = lo; i < hi; i++) {
        const f = frame(i);
        if (!f) return false;
        fs.push(f);
      }
      for (let j = 0; j < n; j++) vals[j] = fs[j][p];
      medianOf(vals, n);
      if (vals[Math.floor((3 * (n - 1)) / 4)] - vals[Math.floor((n - 1) / 4)] > SPREAD) return false;
      const x = p % W;
      const y = (p - x) / W;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          for (let j = 0; j < n; j++) vals[j] = fs[j][q];
          if (Math.abs(medianOf(vals, n) - v) <= CHANGED) return false;
        }
      }
      return true;
    }

    const runs: Runs = { ref: new Uint8Array(P), start: new Int32Array(P), last: new Int32Array(P), active: new Uint8Array(P), onset: new Uint8Array(P) };
    let accepted = new Int32Array(3 * 4096);
    let count = 0;
    const accept = (p: number, a: number, b: number) => {
      if (3 * count + 3 > accepted.length) {
        const more = new Int32Array(accepted.length * 2);
        more.set(accepted);
        accepted = more;
      }
      accepted[3 * count] = p;
      accepted[3 * count + 1] = a;
      accepted[3 * count + 2] = b;
      count++;
    };
    // 1 when the run replaced steady content within its shot, 2 when it did not.
    const reached = (p: number) => {
      const a = runs.start[p];
      const lo = shotStart[shotOf[a]];
      // Judged in the exposure of the frames before it, so a step in exposure where it starts is no content coming up.
      runs.onset[p] = a > lo && replaced(Math.max(lo, a - K), a, a - 1, p, (runs.ref[p] - offset[a]) / gain[a]) ? 1 : 2;
    };
    const ended = (p: number) => {
      const a = runs.start[p];
      const b = runs.last[p] + 1;
      if (b - a < L) return;
      const across = cuts[b] - cuts[a + 1] > 0;
      const through = b - a > 1 && (movedSum[b] - movedSum[a + 1]) / (b - a - 1) >= MOVING;
      if (across || through) {
        accept(p, a, b);
        return;
      }
      const s = shotOf[a];
      if (shotOf[b - 1] !== s) return;
      const v = runs.ref[p];
      if (Math.abs(medianOfShot(s)[p] - v) <= CHANGED) return;
      const hi = shotEnd(s);
      if (runs.onset[p] === 1 || (b < hi && replaced(b, Math.min(hi, b + K), b, p, gain[b] * v + offset[b]))) accept(p, a, b);
    };

    const edge = new Uint8Array(P);
    for (let t = 0; t < N; t++) {
      while (loaded < Math.min(N - 1, t + K)) {
        loaded++;
        readFrame(fd, loaded, ring[loaded % R]);
      }
      const f = frame(t)!;
      edges(f, W, H, edge);
      step(runs, f, edge, t, L, GAP, reached, ended);
    }
    for (let p = 0; p < P; p++) if (runs.active[p]) ended(p);

    return regionsOf(accepted.subarray(0, 3 * count), size, times, GAP, display, durationSec, (i, into) => readFrame(fd, i, into));
  } finally {
    closeSync(fd);
  }
}

/**
 * The share of the strong gradients inside a box (at the work size) that run within 22.5 degrees of the horizontal or
 * the vertical, over SQUARE_FRAMES of its samples from `first` to `last` spread evenly; 1 when it has none.
 */
function squareShare(frameAt: (i: number, into: Uint8Array) => void, size: { width: number; height: number },
  box: { x0: number; y0: number; x1: number; y1: number }, first: number, last: number): number {
  const { width: W, height: H } = size;
  const f = new Uint8Array(W * H);
  const n = Math.min(SQUARE_FRAMES, last - first + 1);
  let strong = 0;
  let square = 0;
  for (let j = 0; j < n; j++) {
    frameAt(first + Math.floor(((j + 0.5) * (last - first + 1)) / n), f);
    for (let y = Math.max(1, box.y0); y < Math.min(H - 1, box.y1); y++) {
      for (let x = Math.max(1, box.x0), p = y * W + x; x < Math.min(W - 1, box.x1); x++, p++) {
        const gx = Math.abs(f[p + 1] - f[p - 1]);
        const gy = Math.abs(f[p + W] - f[p - W]);
        if (gx * gx + gy * gy < EDGE * EDGE) continue;
        strong++;
        if (Math.min(gx, gy) <= TAN_22_5 * Math.max(gx, gy)) square++;
      }
    }
  }
  return strong ? square / strong : 1;
}

/** Accepted runs, (pixel, first sample, sample after the last) each, grouped into boxes per sample and followed into regions. */
function regionsOf(runs: Int32Array, size: { width: number; height: number }, times: number[], gap: number,
  display: { width: number; height: number }, durationSec: number, frameAt: (i: number, into: Uint8Array) => void): GraphicBox[] {
  const { width: W, height: H } = size;
  const N = times.length;
  const CW = Math.ceil(W / CELL);
  const CH = Math.ceil(H / CELL);
  const minPixels = Math.max(8, MIN_SHARE * W * H);
  const starting: number[][] = Array.from({ length: N + 1 }, () => []);
  const ending: number[][] = Array.from({ length: N + 1 }, () => []);
  for (let r = 0; r < runs.length; r += 3) {
    const p = runs[r];
    const cell = Math.floor(Math.floor(p / W) / CELL) * CW + Math.floor((p % W) / CELL);
    starting[runs[r + 1]].push(cell);
    ending[runs[r + 2]].push(cell);
  }
  const counts = new Int32Array(CW * CH);
  const on = new Uint8Array(CW * CH);
  const grown = new Uint8Array(CW * CH);
  const label = new Int32Array(CW * CH);
  const stack: number[] = [];
  let live = 0;
  interface Box { x0: number; y0: number; x1: number; y1: number }
  /** A region: its latest box, its first and last samples, and per cell the samples it covered that cell in. */
  interface Track { latest: Box; first: number; last: number; samples: number; hits: Uint16Array }
  const open: Track[] = [];
  const done: Track[] = [];
  const area = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
  const union = (a: Box, b: Box): Box => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
  const iou = (a: Box, b: Box) => {
    const meet = area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
    return meet / (area(a) + area(b) - meet);
  };

  for (let t = 0; t < N; t++) {
    for (const c of starting[t]) { counts[c]++; live++; }
    for (const c of ending[t]) { counts[c]--; live--; }
    const boxes: (Box & { cells: number[] })[] = [];
    if (live > 0) {
      for (let c = 0; c < on.length; c++) on[c] = counts[c] >= CELL_MIN ? 1 : 0;
      // Joined two cells across and one down, so the letters and words of one line make one box.
      grown.fill(0);
      for (let cy = 0; cy < CH; cy++) {
        for (let cx = 0; cx < CW; cx++) {
          if (!on[cy * CW + cx]) continue;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const nx = cx + dx;
              const ny = cy + dy;
              if (nx >= 0 && ny >= 0 && nx < CW && ny < CH) grown[ny * CW + nx] = 1;
            }
          }
        }
      }
      label.fill(0);
      let next = 0;
      for (let c0 = 0; c0 < grown.length; c0++) {
        if (!grown[c0] || label[c0]) continue;
        next++;
        label[c0] = next;
        stack.push(c0);
        let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, pixels = 0;
        const cells: number[] = [];
        while (stack.length) {
          const c = stack.pop()!;
          const cx = c % CW;
          const cy = (c - cx) / CW;
          if (on[c]) {
            cells.push(c);
            x0 = Math.min(x0, cx); x1 = Math.max(x1, cx);
            y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
            pixels += counts[c];
          }
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = cx + dx;
              const ny = cy + dy;
              if (nx < 0 || ny < 0 || nx >= CW || ny >= CH) continue;
              const n = ny * CW + nx;
              if (grown[n] && !label[n]) { label[n] = next; stack.push(n); }
            }
          }
        }
        // A sliver one or two cells wide, or much taller than wide, is a held edge of the scene (a window frame, a
        // flagpole), not a line of text, a plate or a logo.
        if (x1 < 0 || x1 - x0 + 1 < MIN_CELLS || y1 - y0 + 1 > TALL * (x1 - x0 + 1)) continue;
        const box = { x0: x0 * CELL, y0: y0 * CELL, x1: Math.min(W, (x1 + 1) * CELL), y1: Math.min(H, (y1 + 1) * CELL) };
        if (pixels >= minPixels && pixels / area(box) >= DENSITY) boxes.push({ ...box, cells });
      }
    }
    // A box is more of the region seen within the last `gap` samples whose latest box it overlaps the most, at
    // LINK or more of their union: a smaller box left where a graphic was is something else, not more of it.
    const latest = new Map<Track, Box>();
    for (const box of boxes) {
      let best: Track | null = null;
      let most = LINK;
      for (const r of open) {
        const score = r.last >= t - 1 - gap ? iou(r.latest, box) : 0;
        if (score >= most) { best = r; most = score; }
      }
      if (!best) {
        best = { latest: box, first: t, last: t, samples: 0, hits: new Uint16Array(CW * CH) };
        open.push(best);
      }
      const seen = latest.get(best);
      latest.set(best, seen ? union(seen, box) : box);
      if (!seen) best.samples++;
      for (const c of box.cells) best.hits[c]++;
      best.last = t;
    }
    for (const [r, box] of latest) r.latest = box;
    for (let i = open.length - 1; i >= 0; i--) if (open[i].last < t - 1 - gap) done.push(...open.splice(i, 1));
  }
  done.push(...open);
  const sx = display.width / W;
  const sy = display.height / H;
  const micro = (s: number) => Math.round(s * 1e6) / 1e6;
  return done.map((r) => {
    // The cells it covered in at least KEEP of its samples: a speck that touched it once does not widen it.
    const least = Math.max(1, Math.ceil(KEEP * r.samples));
    let x0 = CW, y0 = CH, x1 = -1, y1 = -1;
    r.hits.forEach((n, c) => {
      if (n < least) return;
      const cx = c % CW;
      const cy = (c - cx) / CW;
      x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
    });
    return { r, x0: x0 * CELL, y0: y0 * CELL, x1: Math.min(W, (x1 + 1) * CELL), y1: Math.min(H, (y1 + 1) * CELL) };
  }).filter((b) => b.x1 > b.x0 && squareShare(frameAt, size, b, b.r.first, b.r.last) >= SQUARE)
    .sort((a, b) => a.r.first - b.r.first || a.y0 - b.y0 || a.x0 - b.x0).map(({ r, x0, y0, x1, y1 }) => {
    const x = Math.round(x0 * sx);
    const y = Math.round(y0 * sy);
    // Up from the sample before its first to the sample after its last: it came and went somewhere in between.
    return {
      x, y, w: Math.min(display.width, Math.round(x1 * sx)) - x, h: Math.min(display.height, Math.round(y1 * sy)) - y,
      from: r.first > 0 ? micro(times[r.first - 1]) : 0, to: r.last + 1 < N ? micro(times[r.last + 1]) : micro(durationSec),
    };
  });
}
