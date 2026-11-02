// A clip cut to another shape, e.g. 16:9 to 9:16, around the faces `faces` found, else from the middle: the one
// tool for a change of shape, so every crop a piece needs comes out the same. It never guesses who is who,
// and it knows faces, not who is talking:
//
//   openedit reframe <video> --aspect 9:16 --out <file> [--faces <faces.json>]
//
// - A shot that shows one face only (never two at once, each found overlapping the one before) is followed:
//   the crop holds still while the face stays inside it, and moves only when no single place keeps every
//   sample's face in frame, the way a camera operator holds a frame rather than chasing the subject, easing
//   from rest and back to rest, in one even pan when the face keeps moving the same way.
// - A shot that shows more than one face is held at one place throughout: where the faces lying wholly inside
//   the crop add up to the most height over the shot. It does not pan, so someone who walks out is not followed.
// - A shot with no face is cut from the middle. At a cut the crop jumps.
// - A shot is first split, as at a dissolve or a cut ffmpeg did not see, between two runs of four or more lone
//   faces (each overlapping the one before) where the later run's first face does not overlap the earlier
//   run's last, no other run of four or more on the far side of that jump overlaps either of those two faces,
//   and the samples showing several faces between the two runs span at most a second. Each part is framed as
//   a shot, and the crop changes at the split as at a cut.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { FFMPEG } from '../config.ts';
import { othersFaces, ownFaces, strandedFaces } from '../faces/folder.ts';
import type { FaceBox, FacesClip, Shot } from '../faces/page-script.ts';
import { probeFrameRate, probeSquareSize, probeVideoSpan } from '../probe.ts';
import { resolveVideoArg } from '../resolve-video.ts';
import { asShown } from '../shown.ts';
import { measuredAs, notFacesOf, readFaces } from './faces.ts';

export const usage = {
  summary: 'Cut a clip to another shape: around the faces faces found (one face followed, several held still), else from the middle',
  positionals: '<video>',
  flags: {
    aspect: { type: 'string', required: true, value: 'W:H', help: 'The shape to cut to, e.g. 9:16 or 1:1' },
    out: { type: 'string', required: true, value: '<file>', help: 'The reframed clip: re-encoded upright to H.264 in square pixels at the source\'s frame rate, with its sound, a clip already in the shape included' },
    faces: { type: 'string', value: '<faces.json>', help: 'The boxes to follow (default the clip\'s own, in runs/<key>/faces-<hash>/ where faces writes them, else in runs/<key>/faces.json when an older faces wrote them there for this clip; with none, the crop is cut from the middle)' },
  },
  notes: [
    'The crop keeps the source\'s full height (or width) and its resolution, and jumps at a cut. With face boxes',
    'each shot, which can be split again where a face seen alone for four samples jumps further than its own',
    'width and is seen alone there for four more (a dissolve or a cut the cut detection missed), is followed when',
    'it shows one face only, still while the face stays inside and moving smoothly only when it must, and held at',
    'one place when it shows more, where the faces wholly inside add up to the most height; a shot with none is',
    'cut from the middle. Without face boxes the whole clip is cut from the middle. A clip already in the shape,',
    'to within the two pixels even sides round to, is re-encoded uncropped. The output is new footage: run faces',
    'on it before laying text.',
  ].join('\n'),
} satisfies Usage;

export interface Crop {
  w: number;
  h: number;
  /** The axis the crop moves along, and how far it can move. */
  axis: 'x' | 'y';
  travel: number;
}

export function parseAspect(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)[:x/](\d+(?:\.\d+)?)$/.exec(raw.trim());
  const ratio = m ? Number(m[1]) / Number(m[2]) : NaN;
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error(`--aspect wants W:H, e.g. 9:16; got "${raw}"`);
  return ratio;
}

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/**
 * The largest crop of that shape: the full height of a wider source, the full width of a taller one. A source
 * within two pixels of the shape, which even pixels round to (a reframe's own output, say), is already in it.
 */
export function cropFor(width: number, height: number, ratio: number): Crop {
  if (Math.abs(width - height * ratio) < 2 || Math.abs(height - width / ratio) < 2) {
    return { w: even(width), h: even(height), axis: width / height > ratio ? 'x' : 'y', travel: 0 };
  }
  if (width / height > ratio) {
    const w = Math.min(even(height * ratio), even(width));
    return { w, h: even(height), axis: 'x', travel: even(width) - w };
  }
  const h = Math.min(even(width / ratio), even(height));
  return { w: even(width), h, axis: 'y', travel: even(height) - h };
}

interface Hold { from: number; to: number; at: number }

// Kept in frame beside a face, as a fraction of its box along the crop's axis: a judgment call, enough for
// the ears and the side of the head. The wider margin faces.js keeps text from is not used here: on a
// close-up it nearly fills a 9:16 crop, and the crop would then chase every small move of the head.
const KEEP_BESIDE = 0.1;

// Where the face should sit across the crop: its centre in the middle side to side, and a third of the way
// down when the crop moves vertically (the rule of thirds).
const ANCHOR = { x: 0.5, y: 1 / 3 };

// A cut takes effect this long before its first frame's time: less than any two frames apart, so the frame
// before the cut keeps the old place and the cut's own frame gets the new one, whatever the frame rate.
const BEFORE_CUT = 0.0005;

// A move between two held places is spread over this long, half from the end of each hold, whatever the
// sampling (a hold shorter than its half gives what it has). It is the pace one sample a second gave: four a
// second would otherwise whip the crop across in 0.25 s.
const PAN_SEC = 1;

const overlaps = (a: FaceBox, b: FaceBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Whether a shot shows one face only: never two in a sample, and each found overlapping the one before it, so
 * it is one face moving and nothing about who is who is guessed. A face found away from the last one, with no
 * sample in between to join them, may be someone else, and the shot counts as showing more than one.
 */
export function oneFace(shot: Shot): boolean {
  let last: FaceBox | undefined;
  for (const sample of shot.samples) {
    if (sample.faces.length > 1) return false;
    const face = sample.faces[0];
    if (!face) continue;
    if (last && !overlaps(last, face)) return false;
    last = face;
  }
  return true;
}

// A part of a shot needs this many lone faces in a row to be framed on its own: as many as `faces` tops a short
// shot up to. Fewer is a stranger seen once, a miss or two people found in turn, not another shot.
const PART_SAMPLES = 4;

// The longest span of samples showing several faces between two runs a shot is split between: a second, the
// default dissolve in the common editors. A longer one is two people in one shot, and it is not split there.
const DISSOLVE_SEC = 1;

/**
 * A shot split where its picture changes without a cut ffmpeg sees, such as a dissolve. Lone faces (samples
 * showing exactly one) form runs, each face overlapping the run's last, and only runs of PART_SAMPLES or more
 * count. Two consecutive counted runs are split between when the later one's first face does not overlap the
 * earlier one's last (it moved further than its own width, faster than the crop can follow), no counted run
 * after the later one overlaps that last face and none before the earlier one overlaps that first face, and the
 * samples showing several faces between them span at most DISSOLVE_SEC. Shorter runs are not looked at, so a
 * place seen again for fewer than PART_SAMPLES samples does not stop a split. Each part runs to the middle of
 * the jump, and the samples between the two runs belong to neither.
 */
export function partsOf(shot: Shot): Shot[] {
  const face = (i: number) => shot.samples[i].faces[0];
  // Runs of lone faces, each overlapping the last lone one; samples with no face or several are passed over.
  const runs: number[][] = [];
  for (const [i, sample] of shot.samples.entries()) {
    if (sample.faces.length !== 1) continue;
    const run = runs.at(-1);
    if (run && overlaps(face(run.at(-1)!), sample.faces[0])) run.push(i);
    else runs.push([i]);
  }
  const settled = runs.filter((run) => run.length >= PART_SAMPLES);
  const parts: Shot[] = [];
  let [start, from] = [shot.start, 0];
  for (const [k, run] of settled.slice(0, -1).entries()) {
    const [a, b] = [run.at(-1)!, settled[k + 1][0]];
    if (overlaps(face(a), face(b))) continue;
    // Either face's place held again by a counted run on the far side of the jump: two people found in turn.
    const back = (runs: number[][], i: number) => runs.some((r) => r.some((j) => overlaps(face(j), face(i))));
    if (back(settled.slice(k + 2), a) || back(settled.slice(0, k), b)) continue;
    const together = shot.samples.slice(a + 1, b).filter((sample) => sample.faces.length > 1);
    if (together.length && together.at(-1)!.sec - together[0].sec > DISSOLVE_SEC) continue;
    const at = (shot.samples[a].sec + shot.samples[b].sec) / 2;
    parts.push({ start, end: at, samples: shot.samples.slice(from, a + 1) });
    [start, from] = [at, b];
  }
  parts.push({ start, end: shot.end, samples: shot.samples.slice(from) });
  return parts;
}

// On even pixels (4:2:0 chroma), inside [lo, hi] whenever that range holds an even one.
const evenWithin = (v: number, lo: number, hi: number) => {
  const [a, b] = [Math.ceil(lo / 2) * 2, Math.floor(hi / 2) * 2];
  const e = Math.round(v / 2) * 2;
  return a <= b ? Math.min(b, Math.max(a, e)) : e;
};

/**
 * The one place a shot with more than one face is held at: where the faces lying wholly inside the crop add up
 * to the most height over the shot's samples (height, not area, so a big face seen briefly does not outweigh a
 * smaller one on screen throughout), with those faces anchored as near the middle as the crop allows. Of equal
 * places, the first along the axis. Null for a shot with no face.
 */
export function stillPlace(shot: Shot, crop: Crop): number | null {
  const size = crop.axis === 'x' ? crop.w : crop.h;
  const faces = shot.samples.flatMap((sample) => sample.faces);
  if (!faces.length) return null;
  const span = (f: FaceBox): [number, number] => (crop.axis === 'x' ? [f.x, f.x + f.w] : [f.y, f.y + f.h]);
  const clamp = (p: number) => Math.min(crop.travel, Math.max(0, p));
  const inside = (p: number, f: FaceBox) => span(f)[0] >= p && span(f)[1] <= p + size;
  const height = (p: number) => faces.reduce((sum, f) => sum + (inside(p, f) ? f.h : 0), 0);
  // The total changes only where a face meets an edge of the crop, so those places are the only candidates.
  const places = [...new Set(faces.flatMap((f) => [clamp(span(f)[0]), clamp(span(f)[1] - size)]))].sort((x, y) => x - y);
  const best = places.reduce((top, p) => (height(p) > height(top) ? p : top), places[0]);
  const held = faces.filter((f) => inside(best, f));
  // Faces too big for the crop: centre the tallest.
  const kept = held.length ? held : [faces.reduce((top, f) => (f.h > top.h ? f : top))];
  const [a, b] = [Math.min(...kept.map((f) => span(f)[0])), Math.max(...kept.map((f) => span(f)[1]))];
  const [lo, hi] = held.length ? [clamp(b - size), clamp(a)] : [0, crop.travel];
  return evenWithin(Math.min(hi, Math.max(lo, (a + b) / 2 - size * ANCHOR[crop.axis])), lo, hi);
}

/**
 * The places the crop holds within one shot, each from its first sample to its last. With several faces it
 * is the one still place for the whole shot. With one face, a run of samples shares one place for as long as
 * some place keeps every one of its faces in frame (with `margin` of the face's size beside it when that
 * fits); that place is the one nearest the faces' average anchor, and a sample without the face is passed over.
 */
export function holdsFor(shot: Shot, crop: Crop, margin: number): Hold[] {
  if (!oneFace(shot)) {
    const at = stillPlace(shot, crop);
    return at === null ? [] : [{ from: shot.start, to: shot.end, at }];
  }
  const size = crop.axis === 'x' ? crop.w : crop.h;
  const extent = crop.travel + size;
  const holds: Hold[] = [];
  let run: { lo: number; hi: number; want: number[]; from: number; to: number } | null = null;
  const close = () => {
    if (!run) return;
    const mean = run.want.reduce((a, b) => a + b, 0) / run.want.length;
    holds.push({ from: run.from, to: run.to, at: evenWithin(Math.min(run.hi, Math.max(run.lo, mean)), run.lo, run.hi) });
  };
  for (const sample of shot.samples) {
    const face = sample.faces[0];
    if (!face) continue;
    const [start, length] = crop.axis === 'x' ? [face.x, face.w] : [face.y, face.h];
    const pad = length * margin;
    const [a, b] = length + 2 * pad <= size
      ? [Math.max(0, start - pad), Math.min(extent, start + length + pad)]
      : [start, start + length];
    // Every place from lo to hi keeps [a, b] in frame; a face larger than the crop is centred instead.
    let lo = Math.max(0, b - size);
    let hi = Math.min(crop.travel, a);
    if (lo > hi) lo = hi = Math.min(crop.travel, Math.max(0, (a + b) / 2 - size / 2));
    const want = Math.min(crop.travel, Math.max(0, start + length / 2 - size * ANCHOR[crop.axis]));
    if (run && Math.max(run.lo, lo) <= Math.min(run.hi, hi)) {
      run.lo = Math.max(run.lo, lo);
      run.hi = Math.min(run.hi, hi);
      run.want.push(want);
      run.to = sample.sec;
    } else {
      close();
      run = { lo, hi, want: [want], from: sample.sec, to: sample.sec };
    }
  }
  close();
  return holds;
}

/**
 * The crop's place through a shot, as a function of time: each hold's place from its first sample to its
 * last, less up to half of PAN_SEC at each end for the moves to and from it, joined by a monotone cubic
 * (Fritsch-Carlson). The curve stops only where the path rests or turns,
 * so a face moving steadily one way gets one even pan rather than a start and stop at every sample, and it
 * never overshoots a hold, where the face was seen to fit.
 */
export function pathThrough(holds: Hold[], middle: number): (t: number) => number {
  const paced = holds.map((h) => ({ ...h }));
  for (const [i, b] of paced.entries()) {
    const a = paced[i - 1];
    if (!a || a.at === b.at || b.from - a.to >= PAN_SEC) continue;
    // Taken from the ends of the two holds, centred on the gap between them; a hold shorter than that keeps one instant.
    const mid = (a.to + b.from) / 2;
    a.to = Math.max(a.from, mid - PAN_SEC / 2);
    b.from = Math.min(b.to, mid + PAN_SEC / 2);
  }
  const knots = paced.flatMap((h) => (h.to > h.from ? [[h.from, h.at], [h.to, h.at]] : [[h.from, h.at]]));
  if (!knots.length) return () => middle;
  const slope = knots.slice(0, -1).map(([t, p], i) => (knots[i + 1][1] - p) / (knots[i + 1][0] - t));
  const d = knots.map((_, i) => {
    if (i === 0 || i === knots.length - 1) return 0;
    const [s0, s1] = [slope[i - 1], slope[i]];
    if (s0 * s1 <= 0) return 0;
    const [h0, h1] = [knots[i][0] - knots[i - 1][0], knots[i + 1][0] - knots[i][0]];
    const [w1, w2] = [2 * h1 + h0, h1 + 2 * h0];
    return (w1 + w2) / (w1 / s0 + w2 / s1);
  });
  return (t) => {
    if (t <= knots[0][0]) return knots[0][1];
    for (let i = 0; i + 1 < knots.length; i++) {
      const [[t0, p0], [t1, p1]] = [knots[i], knots[i + 1]];
      if (t > t1) continue;
      const h = t1 - t0;
      const u = (t - t0) / h;
      return (2 * u ** 3 - 3 * u ** 2 + 1) * p0 + (u ** 3 - 2 * u ** 2 + u) * h * d[i] + (3 * u ** 2 - 2 * u ** 3) * p1 + (u ** 3 - u ** 2) * h * d[i + 1];
    }
    return knots[knots.length - 1][1];
  };
}

/** The crop's place at any time of the clip, on even pixels: its shot's (or part's) path, from just before it starts. */
export function cropTrack(clip: FacesClip, crop: Crop): (t: number) => number {
  const middle = Math.floor(crop.travel / 4) * 2;
  const shots = clip.shots.flatMap(partsOf).map((shot) => ({ from: shot.start - BEFORE_CUT, at: pathThrough(holdsFor(shot, crop, KEEP_BESIDE), middle) }));
  return (t) => {
    let k = 0;
    while (k + 1 < shots.length && t >= shots[k + 1].from) k++;
    const at = shots.length ? shots[k].at(t) : middle;
    return Math.min(crop.travel, Math.max(0, Math.round(at / 2) * 2));
  };
}

/**
 * When the crop moves and to where: a look every frame of the nominal rate (half a frame early), and at
 * each cut or split just before its first frame, kept only where the place changes. Times, not frame numbers, so
 * a clip whose frame rate varies is cut where its frames really fall.
 */
export function cropMoves(clip: FacesClip, crop: Crop, fps: number, durationSec: number): { sec: number; at: number }[] {
  const track = cropTrack(clip, crop);
  const times = [0];
  for (let n = 1; (n - 0.5) / fps < durationSec; n++) times.push((n - 0.5) / fps);
  for (const shot of clip.shots.flatMap(partsOf).slice(1)) times.push(shot.start - BEFORE_CUT);
  const moves: { sec: number; at: number }[] = [];
  for (const sec of [...new Set(times)].sort((a, b) => a - b)) {
    const at = track(sec);
    if (!moves.length || moves[moves.length - 1].at !== at) moves.push({ sec, at });
  }
  return moves;
}

/** ffmpeg sendcmd lines that move the crop: `target` names the crop filter, or its instance in a graph with several. */
export function sendcmdScript(moves: { sec: number; at: number }[], axis: 'x' | 'y', target = 'crop'): string {
  return `${moves.map((m) => `${Math.max(0, m.sec).toFixed(6)} ${target} ${axis} ${m.at};`).join('\n')}\n`;
}

/**
 * A clip planned for a shape as reframe cuts it. `faces`: its boxes show a face, so a shot showing one face only (never
 * two at once, each found overlapping the one before) is followed, any other shot with a face is held still, and a
 * lone face's jump splits a shot; `middle`: it has no boxes or they show no face; `already`: nothing is cut.
 */
export interface Shaping {
  video: string;
  /** Its picture as shown: upright, in square pixels. */
  width: number;
  height: number;
  /** The pixel aspect it is stored in, 1 for square pixels. */
  sar: number;
  crop: Crop;
  how: 'faces' | 'middle' | 'already';
  /** The face boxes read, never another clip's; null when it has none, or nothing is cut. */
  facesPath: string | null;
  /** Boxes found at the clip's name that are another clip's, so not used. */
  ignored?: string;
  clip: FacesClip | null;
  /** When the crop moves and to where, in the clip's own seconds; none when nothing is cut. */
  moves: { sec: number; at: number }[];
}

/**
 * How `video` is cut to the shape `ratio`, with the boxes at `faces`, by default its own where faces writes them.
 * Boxes it reads that were found on another clip, or on this one before it was cut or replaced, are refused, naming `label`
 * and the `ways` out.
 */
export function planShape(video: string, ratio: number, o: { faces?: string; label?: string; ways?: string } = {}): Shaping {
  const { width, height, sar } = probeSquareSize(video);
  const crop = cropFor(width, height, ratio);
  const base = { video, width, height, sar, crop };
  if (crop.travel === 0) return { ...base, how: 'already', facesPath: null, clip: null, moves: [] };
  const facesPath = o.faces === undefined ? ownFaces(video) : resolve(o.faces);
  // The video's own end on the clock its frames are timed by, as faces measures it.
  const durationSec = probeVideoSpan(video).end;
  // Boxes left by a file of this name that is gone are this clip moved only when they were found on a clip like it;
  // another camera's file of the same name is passed over.
  const stranded = facesPath ? [] : strandedFaces(video);
  const moved = stranded.find((b) => measuredAs(b, { width, height }, durationSec));
  if (moved) {
    throw new Error(`${moved.path} holds the faces of ${moved.owner}, which is no longer there: if ${o.label ?? video} is that clip moved, ` +
      `run faces on ${o.label ?? video}${o.ways ?? ''}`);
  }
  const again = `run faces on ${o.label ?? video} again${o.ways ?? ''}`;
  let clip: FacesClip | null = null;
  try {
    clip = facesPath ? readFaces(facesPath) : null;
  } catch (e) {
    throw new Error(`${(e as Error).message}: ${again}`, { cause: e });
  }
  const other = clip && notFacesOf(clip, video, { width, height }, durationSec);
  if (other) throw new Error(`${facesPath} ${other}: ${again}`);
  // Without boxes, one shot with no faces in it: the path that holds the middle.
  const shots = clip ?? ({ shots: [{ start: 0, end: durationSec, samples: [] }] } as unknown as FacesClip);
  const moves = cropMoves(shots, crop, probeFrameRate(video).fps, durationSec);
  const seen = clip?.shots.some((shot) => shot.samples.some((sample) => sample.faces.length > 0)) ?? false;
  const ignored = clip ? undefined : othersFaces(video) ?? stranded[0]?.path;
  return { ...base, how: seen ? 'faces' : 'middle', facesPath, clip, moves, ...(ignored ? { ignored } : {}) };
}

/** The place the crop holds at `sec` of the clip: the last move at or before it. */
function placeAt(moves: { sec: number; at: number }[], sec: number): number {
  let at = moves[0].at;
  for (const m of moves) {
    if (m.sec > sec) break;
    at = m.at;
  }
  return at;
}

/**
 * The filters that cut the clip's decoded picture, from `window.from` to `window.to` seconds of it, on a clock that
 * starts at `from` (a trimmed range's); a crop that moves there is sent its moves from `script`, written into ffmpeg's
 * working directory under that name, since a path inside a filter argument would need its own escaping.
 */
export function shapeChain(s: Shaping, name: string, window = { from: 0, to: Infinity }): { filters: string[]; script?: { file: string; text: string } } {
  const filters = asShown(s);
  if (s.how === 'already') return { filters };
  const first = placeAt(s.moves, window.from);
  const later = s.moves.filter((m) => m.sec > window.from && m.sec <= window.to).map((m) => ({ sec: m.sec - window.from, at: m.at }));
  const [x, y] = s.crop.axis === 'x' ? [first, 0] : [0, first];
  // An instance of its own, so in a graph with several the moves reach this crop alone.
  const crop = `crop@${name}=w=${s.crop.w}:h=${s.crop.h}:x=${x}:y=${y}`;
  if (!later.length) return { filters: [...filters, crop] };
  const script = { file: `${name}.cmd`, text: sendcmdScript([{ sec: 0, at: first }, ...later], s.crop.axis, `crop@${name}`) };
  return { filters: [...filters, `sendcmd=f=${script.file}`, crop], script };
}

/** Fit for a clip of another shape than a canvas: `crop` cuts it as reframe does, `letterbox` pads it whole. */
export type Fit = 'crop' | 'letterbox';

export function parseFit(text: string | undefined): Fit {
  if (text === undefined) return 'crop';
  if (text === 'crop' || text === 'letterbox') return text;
  throw new Error(`--fit expects crop or letterbox, got "${text}"`);
}

const unused = (s: Shaping) => (s.ignored ? `; ${s.ignored} holds another clip's and is not used` : '');

/** What a command prints for a clip it cut to `target`: which of reframe's two ways it took, and from what. */
export function describeShape(what: string, s: Shaping, target: string): string {
  const size = `${s.width}x${s.height}`;
  if (s.how === 'faces') return `${what} (${size}) is cut to ${target} around its faces (${s.facesPath}), as reframe cuts it`;
  const why = s.clip ? `its face boxes (${s.facesPath}) show no face` : `no face boxes for it (faces writes them)${unused(s)}`;
  return `${what} (${size}) is cut to ${target} from the middle, as reframe cuts it: ${why}`;
}

export function reframe(argv: string[]): number {
  const { values, positionals } = parseUsage('reframe', usage, argv);
  const [videoArg] = positionals;
  if (!videoArg || !values.aspect || !values.out) {
    console.error(usageLine('reframe', usage));
    return 2;
  }
  const video = resolveVideoArg(videoArg);
  if (!existsSync(video)) throw new Error(`video not found: ${video}`);
  if (values.faces !== undefined && !existsSync(resolve(values.faces))) {
    throw new Error(`no face boxes at ${resolve(values.faces)}: run npx @veedstudio/openedit-cli faces ${videoArg} first, or leave out --faces to cut from the middle`);
  }
  const shape = planShape(video, parseAspect(values.aspect), {
    faces: values.faces, label: videoArg,
    ways: `, or name its faces.json with --faces${values.faces === undefined ? '' : ', or leave out --faces to cut from the middle'}`,
  });
  const { width, height, crop } = shape;
  if (shape.how !== 'already' && !shape.clip) console.log(`reframe: no face boxes for ${videoArg} (faces writes them)${unused(shape)}, so the crop is cut from the middle`);
  const out = resolve(values.out);
  const work = mkdtempSync(join(tmpdir(), 'open-edit-reframe-'));
  try {
    // A clip already in the shape gets the same encode with no crop, so every clip a piece joins comes out alike:
    // upright, in square pixels, in one codec, whatever rotation tag, pixel shape or codec it arrived with.
    const { filters, script } = shapeChain(shape, 'reframe');
    if (script) writeFileSync(join(work, script.file), script.text);
    // H.264 in 4:2:0 wants even sides: an odd one loses its last pixel.
    if (shape.how === 'already' && (crop.w !== width || crop.h !== height)) filters.push(`crop=${crop.w}:${crop.h}:0:0`);
    filters.push('setsar=1');
    const r = spawnSync(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-i', video,
      '-vf', filters.join(','),
      '-map', '0:v:0', '-map', '0:a:0?', '-fps_mode', 'passthrough',
      '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], { cwd: work, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg could not reframe ${video}: ${String(r.stderr).trim().split('\n').slice(-3).join(' ')}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(shape.how !== 'already'
    ? `reframe: ${width}x${height} → ${crop.w}x${crop.h} (${values.aspect}), ${shape.clip?.shots.length ?? 1} shot(s), the crop changes place ${shape.moves.length - 1} time(s) → ${out}`
    : `reframe: ${videoArg} is already ${values.aspect} (${width}x${height}), so it is re-encoded upright, ` +
      `${crop.w === width && crop.h === height ? 'uncropped' : `to even pixels (${crop.w}x${crop.h})`} → ${out}`);
  return 0;
}
