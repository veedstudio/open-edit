// What happens on a screen recording, from the differences between frames sampled a tenth of a second apart, small and
// grey: where the cursor is, where it clicks, what changes near it, when the whole screen changes, and when nothing does.
// No model: a drawn cursor is the small thing that moves, leaving a patch of its own outline where it was and showing the
// same outline where it is, and once seen its picture is kept to find it again after moves too small to leave two patches.
// A click is a rest of the cursor that the screen answers: a change near it, or the whole screen changing soon after it
// arrived (a link followed). Without a drawn cursor a click is the first change after a quiet spell, at that change.

/** A connected patch of changed pixels between two samples, in work pixels; `n` is how many changed. */
export interface Blob { x: number; y: number; w: number; h: number; n: number }

/** One sample: its time, what changed since the one before, and the cursor's box in it (work pixels). */
export interface Change {
  sec: number;
  blobs: Blob[];
  cursor: Blob | null;
  /** Whether the cursor was seen moving to `cursor` in this sample. */
  moved: boolean;
}

/** A rectangle in the clip's display pixels. */
export interface Box { x: number; y: number; w: number; h: number }

export interface Click { t: number; x: number; y: number; /** The sample just before the screen answered: the frame to measure text on. */ before: number }

/** A stretch in which the screen changed wholesale (a page loaded, a scroll), and the box it changed in. */
export interface Wide { from: number; to: number; box: Box }

export interface Activity {
  /** The cursor's box at each sample, in display pixels, or null before it is first seen. */
  cursor: (Box | null)[];
  /** Samples at which the cursor was seen moving. */
  sightings: number;
  /** Whether a cursor is drawn: it was seen moving often enough that clicks are read off its rests. */
  drawn: boolean;
  clicks: Click[];
  wide: Wide[];
  /** Changes that are neither the cursor nor wholesale, [sec, x, y, w, h] in display pixels. */
  local: [number, number, number, number, number][];
  /** Stretches in which nothing changes but a blinking caret or an animation in place, at least STILL_MIN long. */
  still: { from: number; to: number }[];
}

// A pixel changed by more than this many grey levels changed: past an encoder's flicker on flat screen colours.
const DIFF = 20;
// Changed pixels are joined across CELL x CELL blocks, so the letters of a typed word or the parts of an arrow are one patch.
const CELL = 4;
// A patch of fewer changed pixels than this is noise.
const MIN_PIXELS = 3;
// The drawn cursor fits a square this share of the work frame's longer side: a 2x cursor on a Retina recording included.
const CURSOR_SIDE = 0.04;
// A change counts as near the cursor within this share of the work frame's longer side of its tip.
const REACH = 0.08;
// A whole-screen change answers a click when it starts within this long of the cursor arriving: a link followed,
// not a scroll made after resting there.
const WIDE_AFTER_SEC = 1.5;
// A change covering this share of the frame (its patches' bounding box) with this share of the pixels changed is wholesale.
const WIDE_AREA = 0.25;
const WIDE_PIXELS = 0.01;
// Wholesale changes this close together are one stretch (a smooth scroll, a page painting in steps).
const WIDE_JOIN_SEC = 0.5;
// Without a drawn cursor, a change after this long with none is taken as a click.
const QUIET_SEC = 0.5;
// The cursor is taken as drawn once it is seen moving this many times.
const MIN_SIGHTINGS = 5;
// A patch of cursor size that changes again within this long, mostly where it changed before, is an animation in place.
const REPEAT_SEC = 4;
/** Still stretches shorter than this are not recorded. */
export const STILL_MIN = 1;

/** The size the frames are analysed at: 960 px on the longer side (never enlarged), both sides even. */
export function workSize(width: number, height: number): { width: number; height: number } {
  const k = Math.min(1, 960 / Math.max(width, height));
  const even = (v: number) => Math.max(2, Math.round((v * k) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/**
 * The patches that differ between two grey frames of `width` x `height`. A caret's blink (a line one or two pixels wide)
 * is left out: it changes for as long as a field has focus, and is neither the cursor nor anything happening.
 */
export function changedBlobs(a: Uint8Array, b: Uint8Array, width: number, height: number): Blob[] {
  const cw = Math.ceil(width / CELL), ch = Math.ceil(height / CELL);
  const count = new Int32Array(cw * ch);
  const minX = new Int32Array(cw * ch).fill(width), minY = new Int32Array(cw * ch).fill(height);
  const maxX = new Int32Array(cw * ch).fill(-1), maxY = new Int32Array(cw * ch).fill(-1);
  for (let y = 0; y < height; y++) {
    const row = y * width, cy = ((y / CELL) | 0) * cw;
    for (let x = 0; x < width; x++) {
      const d = a[row + x] - b[row + x];
      if (d <= DIFF && d >= -DIFF) continue;
      const c = cy + ((x / CELL) | 0);
      count[c]++;
      if (x < minX[c]) minX[c] = x;
      if (x > maxX[c]) maxX[c] = x;
      if (y < minY[c]) minY[c] = y;
      if (y > maxY[c]) maxY[c] = y;
    }
  }
  const label = new Int32Array(cw * ch).fill(-1);
  const blobs: Blob[] = [];
  const stack: number[] = [];
  for (let start = 0; start < count.length; start++) {
    if (!count[start] || label[start] >= 0) continue;
    const blob = { x0: width, y0: height, x1: -1, y1: -1, n: 0 };
    label[start] = blobs.length;
    stack.push(start);
    while (stack.length) {
      const c = stack.pop()!;
      blob.n += count[c];
      blob.x0 = Math.min(blob.x0, minX[c]); blob.x1 = Math.max(blob.x1, maxX[c]);
      blob.y0 = Math.min(blob.y0, minY[c]); blob.y1 = Math.max(blob.y1, maxY[c]);
      const cx = c % cw, cy = (c / cw) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const n = ny * cw + nx;
          if (count[n] && label[n] < 0) { label[n] = blobs.length; stack.push(n); }
        }
      }
    }
    const w = blob.x1 - blob.x0 + 1, h = blob.y1 - blob.y0 + 1;
    if (blob.n < MIN_PIXELS || (w <= 2 && h >= 4)) continue;
    blobs.push({ x: blob.x0, y: blob.y0, w, h, n: blob.n });
  }
  return blobs;
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const grown = (b: Box, by: number): Box => ({ x: b.x - by, y: b.y - by, w: b.w + 2 * by, h: b.h + 2 * by });
const gap = (a: Box, b: Box) => Math.hypot(Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)), Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)));
// How much of the smaller of two boxes they share.
const sharedShare = (a: Box, b: Box) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / Math.min(a.w * a.h, b.w * b.h) : 0;
};
const union = (list: Box[]): Box => {
  const x = Math.min(...list.map((b) => b.x)), y = Math.min(...list.map((b) => b.y));
  return { x, y, w: Math.max(...list.map((b) => b.x + b.w)) - x, h: Math.max(...list.map((b) => b.y + b.h)) - y };
};
const nearest = (list: Blob[], to: Box | null): Blob | undefined =>
  to ? [...list].sort((a, b) => gap(a, to) - gap(b, to))[0] : [...list].sort((a, b) => b.n - a.n)[0];
// A patch no bigger than the cursor's box, give or take its moving a little within one sample.
const likeCursor = (b: Box, cur: Box) => b.w <= 1.6 * cur.w + 2 && b.h <= 1.6 * cur.h + 2;
// Two patches of one outline, as the cursor leaves where it was and shows where it is: what it uncovers and what it
// covers differ with the background, so the changed pixels may differ twofold.
const sameShape = (a: Blob, b: Blob) => Math.abs(a.w - b.w) <= Math.max(2, 0.25 * b.w) && Math.abs(a.h - b.h) <= Math.max(2, 0.25 * b.h)
  && Math.max(a.n, b.n) <= 2 * Math.min(a.n, b.n);

/** Whether a sample's change is wholesale: its patches span WIDE_AREA of the frame with WIDE_PIXELS of it changed. */
export function isWide(blobs: Blob[], width: number, height: number): boolean {
  if (!blobs.length) return false;
  const pixels = blobs.reduce((sum, b) => sum + b.n, 0);
  const box = union(blobs);
  return box.w * box.h >= WIDE_AREA * width * height && pixels >= WIDE_PIXELS * width * height;
}

/** The side of the square a drawn cursor fits in, on a work frame of this size. */
export const cursorSide = (size: { width: number; height: number }) => Math.max(4, Math.round(CURSOR_SIDE * Math.max(size.width, size.height)));

// The cursor's picture matches where the frame contradicts at most this share of it: a cursor drawn over any background
// passes, a glyph or an icon of its size does not. A pixel within EDGE_SLACK grey levels of halfway contradicts nothing.
const MATCH = 0.1;
const EDGE_SLACK = 30;

/**
 * The cursor as last seen arriving: its own pixels, the ring around them, how much lighter (or, for a light cursor,
 * darker) the ring was, and the grey halfway between the two.
 */
interface Picture { w: number; h: number; px: Uint8Array; body: Uint8Array; ring: Uint8Array; contrast: number; mid: number }

/**
 * Follows the drawn cursor through the samples, one frame at a time. It moves where a patch of its own outline is left
 * where it was and the same outline shows elsewhere; typed text, a page painting in and an animation in place change
 * patches of its size too, but never in such pairs. Once seen, its picture finds it again after a move too small to leave
 * two patches, and checks a pair seen away from it before the cursor is taken to have gone there.
 */
export class CursorTracker {
  private cur: Blob | null = null;
  private picture: Picture | null = null;
  // The newer half of a pair seen away from the cursor in the last sample, until a pair moving on from it confirms it.
  private lead: Blob | null = null;
  private readonly side: number;

  constructor(private readonly width: number, private readonly height: number) {
    this.side = cursorSide({ width, height });
  }

  step(prev: Uint8Array, frame: Uint8Array, blobs: Blob[], wide: boolean): { cursor: Blob | null; moved: boolean } {
    const cur = this.cur;
    if (wide) return { cursor: cur, moved: false };
    const here = blobs.filter((b) => b.w <= this.side && b.h <= this.side && b.n >= 4);
    if (cur) {
      const was = grown(cur, 2);
      const from = here.filter((b) => overlaps(b, was) && likeCursor(b, cur));
      const pair = nearest(here.filter((b) => !overlaps(b, was) && from.some((d) => sameShape(d, b))), cur);
      if (pair) return this.moveTo(prev, frame, pair);
      if (blobs.some((b) => overlaps(b, was))) {
        // Its place changed without a pair: a move too small to leave one, or the screen answering under a cursor that stayed.
        const found = this.find(frame, grown(cur, Math.ceil(this.side / 2)));
        // A pixel either way is the match wavering as the screen changes under it, not a move.
        if (found && Math.abs(found.x - cur.x) + Math.abs(found.y - cur.y) >= 2) return this.moveTo(prev, frame, found, false);
        return { cursor: cur, moved: false };
      }
    }
    // A pair away from where it was believed to be: the first sighting, or the cursor found again. It is taken when the
    // next sample moves on from it by another pair, which nothing but a moving cursor does, and once its picture is known,
    // only where that picture matches: items of one shape painting in one after another chain too.
    const away = cur ? here.filter((b) => !overlaps(b, grown(cur, 2))) : here;
    const pairs: { from: Blob; to: Blob }[] = [];
    for (const a of away) {
      for (const b of away) {
        if (a === b || overlaps(a, b) || !sameShape(a, b)) continue;
        if (this.shows(prev, frame, a) > this.shows(prev, frame, b)) pairs.push({ from: b, to: a });
      }
    }
    const lead = this.lead;
    const chained = lead ? pairs.filter((p) => overlaps(grown(lead, 2), p.from)).map((p) => p.to) : [];
    const found = nearest(chained.filter((a) => !this.picture || this.matchAt(frame, a) <= MATCH), lead);
    this.lead = found ? null : nearest(pairs.map((p) => p.to), cur) ?? null;
    return found ? this.moveTo(prev, frame, found) : { cursor: cur, moved: false };
  }

  private moveTo(prev: Uint8Array, frame: Uint8Array, to: Blob, keep = true): { cursor: Blob; moved: true } {
    this.cur = to;
    if (keep) this.keep(prev, frame, to);
    return { cursor: to, moved: true };
  }

  // Its picture where it arrived: its own pixels (those that changed as it came) and the ring just outside them.
  private keep(prev: Uint8Array, frame: Uint8Array, at: Blob): void {
    const { w, h } = at;
    const body = new Uint8Array(w * h);
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (at.y + y) * this.width + at.x + x;
        px[y * w + x] = frame[p];
        const d = frame[p] - prev[p];
        if (d > DIFF || d < -DIFF) body[y * w + x] = 1;
      }
    }
    const ring = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (body[y * w + x]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= 0 && xx >= 0 && yy < h && xx < w && body[yy * w + xx]) ring[y * w + x] = 1;
          }
        }
      }
    }
    let inside = 0, around = 0, ni = 0, na = 0;
    for (let k = 0; k < w * h; k++) {
      if (body[k]) { inside += px[k]; ni++; } else if (ring[k]) { around += px[k]; na++; }
    }
    if (ni < 10 || !na) return;
    const contrast = around / na - inside / ni;
    if (Math.abs(contrast) >= 2 * DIFF) this.picture = { w, h, px, body, ring, contrast, mid: (around / na + inside / ni) / 2 };
  }

  // How much more the patch stands out from its surroundings in `frame` than in `prev`: the half of a pair that shows the cursor.
  private shows(prev: Uint8Array, frame: Uint8Array, b: Box): number {
    const spread = (img: Uint8Array) => {
      let sum = 0, sq = 0, n = 0;
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) { const v = img[y * this.width + x]; sum += v; sq += v * v; n++; }
      return n ? sq / n - (sum / n) ** 2 : 0;
    };
    return spread(frame) - spread(prev);
  }

  // The share of its picture the frame contradicts with the picture's corner at x, y: a pixel of its own that is not on
  // its side of the grey halfway to its ring, or a ring pixel that is not on the ring's. Sides, not grey levels, since a
  // cursor at another sub-pixel offset draws its edges in other greys on the smaller work frame.
  private scoreAt(frame: Uint8Array, x: number, y: number): number {
    const pic = this.picture!;
    const sign = Math.sign(pic.contrast);
    let wrong = 0, n = 0;
    for (let j = 0; j < pic.h; j++) {
      for (let i = 0; i < pic.w; i++) {
        const k = j * pic.w + i;
        const own = pic.body[k] && sign * (pic.mid - pic.px[k]) > 0;
        if (!own && !pic.ring[k]) continue;
        const side = sign * (pic.mid - frame[(y + j) * this.width + x + i]);
        n++;
        if (own ? side < -EDGE_SLACK : side > EDGE_SLACK) wrong++;
      }
    }
    return n ? wrong / n : Infinity;
  }

  private matchAt(frame: Uint8Array, b: Box): number {
    let best = Infinity;
    for (let y = b.y - 2; y <= b.y + 2; y++) for (let x = b.x - 2; x <= b.x + 2; x++) if (this.fits(x, y)) best = Math.min(best, this.scoreAt(frame, x, y));
    return best;
  }

  private fits(x: number, y: number): boolean {
    const pic = this.picture!;
    return x >= 0 && y >= 0 && x + pic.w <= this.width && y + pic.h <= this.height;
  }

  // Where its picture matches best within `area`, if it matches there.
  private find(frame: Uint8Array, area: Box): Blob | null {
    const pic = this.picture;
    if (!pic) return null;
    let best = { score: Infinity, x: 0, y: 0 };
    for (let y = area.y; y + pic.h <= area.y + area.h; y++) {
      for (let x = area.x; x + pic.w <= area.x + area.w; x++) {
        if (!this.fits(x, y)) continue;
        const score = this.scoreAt(frame, x, y);
        if (score < best.score) best = { score, x, y };
      }
    }
    return best.score <= MATCH ? { x: best.x, y: best.y, w: pic.w, h: pic.h, n: this.cur?.n ?? 0 } : null;
  }
}

/**
 * What the samples show, in the clip's display pixels: `size` is the work frame the blobs were found on and `display`
 * the clip's own size.
 */
export function readActivity(changes: Change[], size: { width: number; height: number }, display: { width: number; height: number }): Activity {
  const side = cursorSide(size);
  const reach = REACH * Math.max(size.width, size.height);
  const kx = display.width / size.width, ky = display.height / size.height;
  const toDisplay = (b: Box): Box => ({ x: Math.round(b.x * kx), y: Math.round(b.y * ky), w: Math.round(b.w * kx), h: Math.round(b.h * ky) });
  const cursorSized = (b: Blob) => b.w <= side && b.h <= side && b.n >= 4;
  const wideAt = changes.map((c) => isWide(c.blobs, size.width, size.height));
  const track = changes.map((c) => c.cursor);
  const sightings = changes.filter((c) => c.moved).length;
  const drawn = sightings >= MIN_SIGHTINGS;

  // Wholesale stretches, joined across short gaps.
  const wide: Wide[] = [];
  for (const [i, change] of changes.entries()) {
    if (!wideAt[i]) continue;
    const box = toDisplay(union(change.blobs));
    const last = wide.at(-1);
    if (last && change.sec - last.to <= WIDE_JOIN_SEC) {
      last.to = change.sec;
      last.box = union([last.box, box]);
    } else {
      wide.push({ from: change.sec, to: change.sec, box });
    }
  }

  // What happens: patches that are neither the cursor's own nor an animation in place (a badge pulsing, a spinner),
  // which changes the same small patch again and again.
  const own = (i: number, b: Blob) => drawn && [track[i], track[i - 1]].some((c) => c && overlaps(grown(c, 2), b) && likeCursor(b, c));
  const recent: { sec: number; b: Blob }[] = [];
  const happening = changes.map((change, i) => {
    while (recent.length && change.sec - recent[0].sec > REPEAT_SEC) recent.shift();
    const repeats = (b: Blob) => cursorSized(b) && recent.filter((r) => sharedShare(r.b, b) >= 0.5).length >= 2;
    const kept = change.blobs.filter((b) => !repeats(b));
    for (const b of change.blobs) if (cursorSized(b)) recent.push({ sec: change.sec, b });
    return { kept, events: kept.filter((b) => !own(i, b)) };
  });
  const local: Activity['local'] = [];
  for (const [i, change] of changes.entries()) {
    if (wideAt[i]) continue;
    for (const b of happening[i].events) {
      const d = toDisplay(b);
      local.push([change.sec, d.x, d.y, d.w, d.h]);
    }
  }

  // Clicks.
  const clicks: Click[] = [];
  if (drawn) {
    let restFrom = 0;
    let answered = false;
    for (let i = 1; i < changes.length; i++) {
      const c = track[i];
      if (changes[i].moved) { restFrom = i; answered = false; continue; }
      if (!c || answered) continue;
      const tip = { x: c.x, y: c.y, w: 1, h: 1 };
      const answer = wideAt[i]
        ? changes[i].sec - changes[restFrom].sec <= WIDE_AFTER_SEC
        : happening[i].events.some((b) => gap(b, tip) <= reach);
      if (!answer) continue;
      answered = true;
      clicks.push({ t: changes[i].sec, x: Math.round(c.x * kx), y: Math.round(c.y * ky), before: changes[i - 1].sec });
    }
  } else {
    let lastLocal = -Infinity;
    for (const [i, change] of changes.entries()) {
      const events = happening[i].events;
      if (wideAt[i] || !events.length) continue;
      if (change.sec - lastLocal >= QUIET_SEC && i > 0) {
        const b = toDisplay(nearest(events, null)!);
        clicks.push({ t: change.sec, x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2), before: changes[i - 1].sec });
      }
      lastLocal = change.sec;
    }
  }

  // Still stretches: nothing but an animation in place changes, the cursor included.
  const still: Activity['still'] = [];
  let from: number | null = null;
  for (const [i, change] of changes.entries()) {
    const quiet = happening[i].kept.length === 0;
    if (quiet && from === null) from = i > 0 ? changes[i - 1].sec : change.sec;
    if ((!quiet || i === changes.length - 1) && from !== null) {
      const to = quiet ? change.sec : changes[i - 1].sec;
      if (to - from >= STILL_MIN) still.push({ from, to });
      from = null;
    }
  }

  return { cursor: track.map((c) => (c ? toDisplay(c) : null)), sightings, drawn, clicks, wide, local, still };
}
