// A clip cut to another shape, e.g. 16:9 to 9:16, around the faces `faces` found, else from the middle: the one
// tool for a change of shape, so every crop a piece needs comes out the same. It never guesses who is who,
// and it knows faces, not who is talking. The crop is scaled to 1080 px on its short side, the platforms' canvas for
// their shapes, unless --size names another size or `native` keeps the source's own pixels:
//
//   openedit reframe <video> --aspect 9:16 --out <file> [--faces <faces.json>] [--size WxH|native]
//   openedit reframe <video> --out runs/<key>/<file>        (the shape of the platform in the piece's brief.json)
//
// - A shot that shows one face only (never two at once, each found overlapping the one before) is followed:
//   the crop holds still while the face stays inside it, and moves only when no single place keeps every
//   sample's face in frame, the way a camera operator holds a frame rather than chasing the subject, easing
//   from rest and back to rest, in one even pan when the face keeps moving the same way.
// - A shot that shows more than one face is held at one place throughout: where the faces lying wholly inside
//   the crop add up to the most height over the shot. It does not pan, so someone who walks out is not followed.
// - A shot with no face is cut from the middle. At a cut the crop jumps.
// - A face less than half the height of the tallest found with it is someone in the background, and none of these
//   rules counts it.
// - A shot is first split, as at a dissolve or a cut ffmpeg did not see, between two runs of four or more lone
//   faces (each overlapping the one before) where the later run's first face does not overlap the earlier
//   run's last, no other run of four or more on the far side of that jump overlaps either of those two faces,
//   and the samples showing several faces between the two runs span at most a second. Each part is framed as
//   a shot, and the crop changes at the split as at a cut.
// - With --panel, the clip's rectangle on the canvas of the brief's platform, the output fills that panel and each
//   face is also kept inside the part of it the platform's UI leaves clear, anchored within that part: a followed face
//   at every sample some place allows, a held shot's faces where the most of their height is clear without cutting
//   one. A followed shot the largest crop cannot clear is cut tighter, to the largest crop that clears the most of it
//   with every face whole. A face no crop keeps clear stays under the UI, and the seconds it shows are printed.
// Where a face does not lie wholly inside the crop it prints those seconds, and leaves how to show them to the piece.
// With the clip's face boxes it also writes the output's own where faces would write them for it, each box and burned-in
// graphic moved and scaled with the crop, so the faces of the clip a page shows are never looked for twice. A burned-in
// graphic the crop cuts in part is reported; --erase erases its rows first, on a fal run the agent makes (faces/erase.ts).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { readBrief, type FoundBrief } from '../brief.ts';
import { settledTags, stampColour } from '../colour.ts';
import { FFMPEG } from '../config.ts';
import {
  approveParts, bandsOf, cutGraphics, ERASER, ERASER_USD_PER_SEC, erasedPart, eraseFolder, fpsOf, joinErased, missingParts, PART_SEC, partsOver, partsToErase,
  prepareErase, quoteFor, quoteOf, quoteSpent, resendQuote, spendQuote, splitParts, splittable, unapproved, writeJobs, type ErasePlan, type Quote,
} from '../faces/erase.ts';
import { facesFolder, othersFaces, ownFaces, strandedFaces } from '../faces/folder.ts';
import { graphicOnto } from '../faces/onto-cut.ts';
import { facesScript, type FaceBox, type FacesClip, type GraphicBox, type Shot } from '../faces/page-script.ts';
import { decodedColourOf, probeFrameRate, probeSquareSize, probeVideoSpan } from '../probe.ts';
import { findOnPath } from '../platform.ts';
import { writeAtomic, writeTextAtomic } from '../providers/exclusive-files.ts';
import { falKey } from '../providers/fal.ts';
import { resolveVideoArg } from '../resolve-video.ts';
import { shellArg } from '../shell-arg.ts';
import { asShown } from '../shown.ts';
import { evenSize } from '../size.ts';
import { canvasFor, type Size } from '../verify/canvas.ts';
import { findGraphics, measuredAs, notFacesOf, readFaces, toDisplay } from './faces.ts';
import { formatNamed, type Format, type Shape } from './safe-zone.ts';

export const usage = {
  summary: 'Cut a clip to another shape at the platforms\' 1080 px canvas: around the faces faces found (one face followed, several held still), else from the middle',
  positionals: '<video>',
  flags: {
    aspect: { type: 'string', value: 'W:H', help: 'The shape to cut to, e.g. 9:16 or 1:1 (default: the shape of the platform in the piece\'s brief.json, found from --out)' },
    out: { type: 'string', required: true, value: '<file>', help: 'The reframed clip: re-encoded upright to H.264 in square pixels at the source\'s frame rate, with its sound, a clip already in the shape included' },
    faces: { type: 'string', value: '<faces.json>', help: 'The boxes to follow (default the clip\'s own, in runs/<key>/faces-<hash>/ where faces writes them, else in runs/<key>/faces.json when an older faces wrote them there for this clip; with none, the crop is cut from the middle)' },
    size: {
      type: 'string', value: 'WxH|native',
      help: 'The output\'s size, of the shape cut to with even sides, e.g. 2160x3840 for 9:16 in 4K (default 1080 px on the short side, the platforms\' canvas '
        + 'for their shapes: 1080x1920 for 9:16, 1080x1080 for 1:1, 1080x1350 for 4:5, 1920x1080 for 16:9); native keeps the crop in the source\'s own pixels, unscaled',
    },
    erase: {
      type: 'boolean',
      help: 'When the crop cuts text burned into the footage, erase its rows first with an eraser on fal that you run: the first call cuts the '
        + 'eraser\'s parts and prints their price for the user to approve, the call with --approve prints the fal runs, and the same call once '
        + 'they are done reframes the erased clip',
    },
    approve: {
      type: 'string', value: '<usd:quote>',
      help: 'With --erase: the price the user said yes to and its quote, as --erase printed them (e.g. 5.04:3f2a9c1e); it writes and prints the '
        + 'runs of the parts that price is for, once: a quote approved before approves nothing again',
    },
    panel: {
      type: 'string', value: 'x,y,w,h',
      help: 'The rectangle the clip fills on the canvas of the platform in the piece\'s brief.json, in px of that canvas (0,960,1080,960 is the bottom half '
        + 'of 1080x1920): the clip is cut to the panel\'s shape and size, each face kept clear of the platform\'s UI where the panel sits, a shot cut tighter '
        + 'only when that keeps its face whole, and the seconds no crop keeps clear printed',
    },
  },
  notes: [
    'The crop keeps the source\'s full height (or width), is scaled (lanczos) to the output size, and jumps at a cut.',
    'With face boxes each shot, which can be split again where a face seen alone for four samples jumps further than',
    'its own width and is seen alone there for four more (a dissolve or a cut the cut detection missed), is followed',
    'when it shows one face only, still while the face stays inside and moving smoothly only when it must, and held',
    'at one place when it shows more, where the faces wholly inside add up to the most height; a shot with none is',
    'cut from the middle. A face less than half the height of the tallest found with it is someone in the background',
    'and does not count among the shot\'s faces. Without face boxes the whole clip is cut from the middle. A clip',
    'already in the shape, to within the two pixels even sides round to, is re-encoded uncropped and scaled the same',
    'way. When the clip has face boxes, the output\'s own are written where faces writes them for it, each box and',
    'graphic moved and scaled with the crop and cut where the crop cuts it, and the path is printed; without, none are.',
    'Where a face does not lie wholly inside the crop, larger than it or beside another face a held shot keeps, one',
    'line names those seconds.',
    '',
    'Text burned into the footage that the crop cuts in part (old subtitles, a lower third: the graphics faces finds',
    'in the same run as the faces) is reported in a last line, with the rows it is in and what erasing them costs.',
    '--erase erases those rows across the whole width for the whole clip, since the search misses a line of text up for',
    `under a second and a half. The clip is cut into parts of at most ${PART_SEC} s, each with half a second of what follows`,
    `it, beside --out, for the eraser, ${ERASER},`,
    `told to remove the subtitles and keep the rest. fal bills each run in whole seconds, rounded down, at $${ERASER_USD_PER_SEC} a second, and`,
    'the price of every part is printed as one total, an estimate, for the user to approve, with a quote id; nothing is',
    'spent and no run exists until --approve passes that price and quote back. That call writes each part\'s input and',
    'prints the fal runs to make: one batch for openedit fal on a fal key, or with no key set, one run a part for a fal',
    'command of the environment\'s own that runs a model with its input as the second argument. A quote approves once,',
    'so one yes prints each run once: running a part again may buy it twice, so a part not back yet is priced again,',
    'with a quote of its own, and its run printed only for an --approve of that. reframe never runs the eraser.',
    'Once every part is erased, the same command takes the erased',
    'rows alone and lays them over the clip, keeping every other pixel, frame and its sound, writes that clip beside the',
    'parts with its face boxes and its graphics searched for again, and reframes it. Text that search finds the crop',
    'still cuts is said in a last line, with the parts it is in; those of 2 s or more are cut in two for the eraser again,',
    'and their price, a second spend, is printed for an --approve of its own; a shorter one is left as it is. Check the',
    'result on frames --sheet: a line up for under a second and a half that the eraser left is not found. An HDR clip is',
    'sent and laid over as SDR.',
  ].join('\n'),
} satisfies Usage;

export interface Crop {
  w: number;
  h: number;
  /** The axis the crop moves along, and how far it can move. */
  axis: 'x' | 'y';
  travel: number;
}

/** The part of the output a face is kept inside, as fractions of its width and height: what the platform's UI leaves clear. */
export interface Clear { x0: number; x1: number; y0: number; y1: number }

/** A crop tighter than the largest, for one shot: its size, and its place across the axis the crop moves along. */
export interface Zoom { w: number; h: number; cross: number }

/** Where the crop stands from `sec` of the clip: `at` along its axis, and a tighter size where a shot has one. */
export interface Move { sec: number; at: number; zoom?: Zoom }

export function parseAspect(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)[:x/](\d+(?:\.\d+)?)$/.exec(raw.trim());
  const ratio = m ? Number(m[1]) / Number(m[2]) : NaN;
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error(`--aspect wants W:H, e.g. 9:16; got "${raw}"`);
  return ratio;
}

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

const sized = (s: Size) => `${s.width}x${s.height}`;

/** Whether a size has the shape `ratio`, to within the two pixels even sides round to. */
const hasShape = (width: number, height: number, ratio: number) => Math.abs(width - height * ratio) < 2 || Math.abs(height - width / ratio) < 2;

/**
 * The size --size asks for: `native` for the crop's own pixels, else even sides (H.264 in 4:2:0 wants them) of the
 * shape `ratio`, so the scale never stretches the picture. Absent, the platforms' canvas for the shape.
 */
export function parseSize(raw: string | undefined, ratio: number, aspect: string): Size | 'native' {
  if (raw === undefined) return canvasFor(ratio);
  if (raw.trim() === 'native') return 'native';
  const m = /^(\d+)x(\d+)$/.exec(raw.trim());
  const [width, height] = m ? [Number(m[1]), Number(m[2])] : [NaN, NaN];
  if (!(width >= 2 && height >= 2 && width % 2 === 0 && height % 2 === 0)) {
    throw new Error(`--size wants WxH with even sides, e.g. ${sized(canvasFor(ratio))}, or native; got "${raw}"`);
  }
  if (!hasShape(width, height, ratio)) {
    throw new Error(`--size ${raw.trim()} is not ${aspect}: ${aspect} is ${sized(canvasFor(ratio))} on the platforms, or ${sized(canvasFor(ratio, 2160))} in 4K`);
  }
  return { width, height };
}

/**
 * The largest crop of that shape: the full height of a wider source, the full width of a taller one. A source
 * within two pixels of the shape, which even pixels round to (a reframe's own output, say), is already in it.
 */
export function cropFor(width: number, height: number, ratio: number): Crop {
  if (hasShape(width, height, ratio)) {
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

// How far into a crop `size` long the anchor falls: within the part the platform's UI leaves clear when there is one,
// since that is the part of the picture people see.
const anchorIn = (size: number, axis: 'x' | 'y', clear?: [number, number]) =>
  (clear ? clear[0] + (clear[1] - clear[0]) * ANCHOR[axis] : ANCHOR[axis]) * size;

// A cut takes effect this long before its first frame's time: less than any two frames apart, so the frame
// before the cut keeps the old place and the cut's own frame gets the new one, whatever the frame rate.
const BEFORE_CUT = 0.0005;

// A move between two held places is spread over this long, half from the end of each hold, whatever the
// sampling (a hold shorter than its half gives what it has). It is the pace one sample a second gave: four a
// second would otherwise whip the crop across in 0.25 s.
const PAN_SEC = 1;

const overlaps = (a: FaceBox, b: FaceBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const spanOn = (f: FaceBox, axis: 'x' | 'y'): [number, number] => (axis === 'x' ? [f.x, f.x + f.w] : [f.y, f.y + f.h]);
const across = (axis: 'x' | 'y') => (axis === 'x' ? 'y' : 'x');
const clearOn = (c: Clear, axis: 'x' | 'y'): [number, number] => (axis === 'x' ? [c.x0, c.x1] : [c.y0, c.y1]);

/** The places, from 0 to `travel`, of a window `size` long that hold the span [a, b] within the fractions [c0, c1] of it; empty when lo > hi. */
const keeping = ([a, b]: [number, number], [c0, c1]: [number, number], size: number, travel: number): [number, number] =>
  [Math.max(0, b - c1 * size), Math.min(travel, a - c0 * size)];

/**
 * Where the spans [lo, hi] that overlap there weigh the most together: the stretch between two of their ends, and of
 * equal weights the one nearest `centre`. Null when there is no span.
 */
function heaviest(spans: { lo: number; hi: number; weight: number }[], centre: number): { weight: number; from: number; to: number } | null {
  // Ends at one place: every span that starts there before any that stops, so spans that only touch still meet.
  const ends = spans.flatMap((p) => [{ at: p.lo, by: p.weight }, { at: p.hi, by: -p.weight }]).sort((a, b) => a.at - b.at || b.by - a.by);
  const gap = (from: number, to: number) => Math.max(0, from - centre, centre - to);
  let best: { weight: number; from: number; to: number } | null = null;
  let weight = 0;
  for (const [i, end] of ends.entries()) {
    weight += end.by;
    if (end.by < 0) continue;
    const here = { weight, from: end.at, to: ends[i + 1].at };
    if (!best || weight > best.weight || (weight === best.weight && gap(here.from, here.to) < gap(best.from, best.to))) best = here;
  }
  return best;
}

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

// A face less than this share of the tallest found with it is someone in the background, not a second person in
// the shot: on 13 clips, people behind a speaker came to 0.24-0.33 of the speaker's height and the second person of
// a two-shot, in profile too, to 0.61 or more. Their scores overlap (0.51-0.61 against 0.53), so size decides, not score.
const BACKGROUND = 0.5;

/** A shot as the crop frames it: each sample without the faces in the background. */
function foreground(shot: Shot): Shot {
  return {
    ...shot,
    samples: shot.samples.map((sample) => {
      const tallest = Math.max(0, ...sample.faces.map((f) => f.h));
      return { ...sample, faces: sample.faces.filter((f) => f.h >= BACKGROUND * tallest) };
    }),
  };
}

/** The shots, and parts of shots, the crop frames one after another. */
const framedShots = (clip: FacesClip): Shot[] => clip.shots.map(foreground).flatMap(partsOf);

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
 * places, the first along the axis. Null for a shot with no face. With `clear`, the fractions of the crop along its
 * axis the platform's UI leaves clear, the place is also kept where the most of those faces' height is clear of it.
 */
export function stillPlace(shot: Shot, crop: Crop, clear?: [number, number]): number | null {
  const size = crop.axis === 'x' ? crop.w : crop.h;
  const faces = shot.samples.flatMap((sample) => sample.faces);
  if (!faces.length) return null;
  const span = (f: FaceBox) => spanOn(f, crop.axis);
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
  let [lo, hi] = held.length ? [clamp(b - size), clamp(a)] : [0, crop.travel];
  const want = (a + b) / 2 - anchorIn(size, crop.axis, clear);
  if (clear && held.length) {
    // Held faces that span more than the clear part cannot all be clear at one place, and the crop does not pan to
    // clear them in turn, so it clears the most face height it can without cutting any of them.
    const spans = held.flatMap((f) => {
      const [l, r] = keeping(span(f), clear, size, crop.travel);
      return Math.max(l, lo) <= Math.min(r, hi) ? [{ lo: Math.max(l, lo), hi: Math.min(r, hi), weight: f.h }] : [];
    });
    const most = heaviest(spans, Math.min(hi, Math.max(lo, want)));
    if (most) [lo, hi] = [most.from, most.to];
  }
  return evenWithin(Math.min(hi, Math.max(lo, want)), lo, hi);
}

/**
 * The places the crop holds within one shot, each from its first sample to its last. With several faces it
 * is the one still place for the whole shot. With one face, a run of samples shares one place for as long as
 * some place keeps every one of its faces in frame (with `margin` of the face's size beside it when that
 * fits); that place is the one nearest the faces' average anchor, and a sample without the face is passed over.
 * With `clear`, the fractions of the crop along its axis the platform's UI leaves clear, each face is also kept
 * inside them wherever some place does that, giving up the margin first.
 */
export function holdsFor(shot: Shot, crop: Crop, margin: number, clear?: [number, number]): Hold[] {
  if (!oneFace(shot)) {
    const at = stillPlace(shot, crop, clear);
    return at === null ? [] : [{ from: shot.start, to: shot.end, at }];
  }
  const holds: Hold[] = [];
  let run: { lo: number; hi: number; want: number[]; from: number; to: number } | null = null;
  const close = () => {
    if (!run) return;
    const mean = run.want.reduce((a, b) => a + b, 0) / run.want.length;
    holds.push({ from: run.from, to: run.to, at: evenWithin(Math.min(run.hi, Math.max(run.lo, mean)), run.lo, run.hi) });
  };
  for (const { sec, lo, hi, want } of rangesFor(shot, crop, margin, clear)) {
    if (run && Math.max(run.lo, lo) <= Math.min(run.hi, hi)) {
      run.lo = Math.max(run.lo, lo);
      run.hi = Math.min(run.hi, hi);
      run.want.push(want);
      run.to = sec;
    } else {
      close();
      run = { lo, hi, want: [want], from: sec, to: sec };
    }
  }
  close();
  return holds;
}

/**
 * For each sample of a shot showing one face only that shows it, the places that keep it in frame (with `margin` of
 * its size beside it when that fits, and inside the `clear` fractions where some place does that, the margin given up
 * first), and the place its anchor wants.
 */
function rangesFor(shot: Shot, crop: Crop, margin: number, clear?: [number, number]): { sec: number; lo: number; hi: number; want: number }[] {
  const size = crop.axis === 'x' ? crop.w : crop.h;
  const extent = crop.travel + size;
  return shot.samples.flatMap((sample) => {
    const face = sample.faces[0];
    if (!face) return [];
    const [start, length] = crop.axis === 'x' ? [face.x, face.w] : [face.y, face.h];
    const pad = length * margin;
    const [a, b] = length + 2 * pad <= size
      ? [Math.max(0, start - pad), Math.min(extent, start + length + pad)]
      : [start, start + length];
    // Every place from lo to hi keeps [a, b] in frame; a face larger than the crop is centred instead.
    let lo = Math.max(0, b - size);
    let hi = Math.min(crop.travel, a);
    if (lo > hi) lo = hi = Math.min(crop.travel, Math.max(0, (a + b) / 2 - size / 2));
    else if (clear) {
      const [l, h] = keeping([start, start + length], clear, size, crop.travel);
      if (l <= h) [lo, hi] = Math.max(l, lo) <= Math.min(h, hi) ? [Math.max(l, lo), Math.min(h, hi)] : [l, h];
    }
    const want = Math.min(crop.travel, Math.max(0, start + length / 2 - anchorIn(size, crop.axis, clear)));
    return [{ sec: sample.sec, lo, hi, want }];
  });
}

/**
 * The places a followed face allows at any time of its shot: each sample's own at its time, and between two samples
 * the line between theirs. A move between two holds is eased over a second, past samples of the holds at each end,
 * and with the face held inside a narrow clear part it would otherwise carry the face out of it mid-move.
 */
function boundsFor(shot: Shot, crop: Crop, margin: number, clear: [number, number]): (t: number) => [number, number] {
  const ranges = rangesFor(shot, crop, margin, clear);
  return (t) => {
    const k = ranges.findIndex((r) => r.sec >= t);
    if (k === 0 || k === -1) {
      const r = k === 0 ? ranges[0] : ranges.at(-1);
      return r ? [r.lo, r.hi] : [0, crop.travel];
    }
    const [p, q] = [ranges[k - 1], ranges[k]];
    const u = (t - p.sec) / (q.sec - p.sec);
    return [p.lo + (q.lo - p.lo) * u, p.hi + (q.hi - p.hi) * u];
  };
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

/** The crop `zoom` names, moving along the same axis as the largest one, `crop`, over what that one's travel leaves. */
function zoomed(crop: Crop, zoom: Zoom): Crop {
  const along = (c: { w: number; h: number }) => (crop.axis === 'x' ? c.w : c.h);
  return { w: zoom.w, h: zoom.h, axis: crop.axis, travel: along(crop) + crop.travel - along(zoom) };
}

/**
 * How many faces of a shot showing one face only a crop `a` long along its axis and `side` across it keeps inside the
 * `clear` part, at its best place across the axis, held for the whole shot (each sample gets its own place along it),
 * and that place: the one nearest `centre` of those that clear the most. Every face must lie whole inside the crop at
 * that place, else null.
 */
function clearedBy(faces: FaceBox[], crop: Crop, clear: Clear, a: number, side: number, centre: number): { count: number; cross: number } | null {
  const axis = crop.axis;
  const [along, beside] = [clearOn(clear, axis), clearOn(clear, across(axis))];
  const [alongExtent, sideExtent] = axis === 'x' ? [crop.w + crop.travel, crop.h] : [crop.h + crop.travel, crop.w];
  const sides = faces.map((f) => spanOn(f, across(axis)));
  // Places across that keep every face whole.
  const lo = Math.max(0, ...sides.map(([, b]) => b - side));
  const hi = Math.min(sideExtent - side, ...sides.map(([b]) => b));
  if (lo > hi || faces.some((f) => spanOn(f, axis)[1] - spanOn(f, axis)[0] > a)) return null;
  // Each face some place along keeps clear counts wherever the place across keeps it clear too.
  const spans = faces.flatMap((f, i) => {
    const [l, r] = keeping(spanOn(f, axis), along, a, alongExtent - a);
    const [p, q] = keeping(sides[i], beside, side, sideExtent - side);
    return l <= r && Math.max(p, lo) <= Math.min(q, hi) ? [{ lo: Math.max(p, lo), hi: Math.min(q, hi), weight: 1 }] : [];
  });
  const most = heaviest(spans, Math.min(hi, Math.max(lo, centre))) ?? { weight: 0, from: lo, to: hi };
  return { count: most.weight, cross: evenWithin(Math.min(most.to, Math.max(most.from, centre)), most.from, most.to) };
}

/**
 * The crop tighter than `crop`, of its shape, that keeps the most faces of a shot showing one face only inside the
 * `clear` part, every face whole, held at one place across the axis: the largest of those that clear the most, and
 * only when it clears more than the largest crop does. Null when none does.
 */
export function tighterCrop(shot: Shot, crop: Crop, clear: Clear): Zoom | null {
  const faces = shot.samples.flatMap((sample) => sample.faces);
  const [alongSize, sideSize] = crop.axis === 'x' ? [crop.w, crop.h] : [crop.h, crop.w];
  const base = clearedBy(faces, crop, clear, alongSize, sideSize, 0)?.count ?? 0;
  if (base === faces.length) return null;
  let best: Zoom | null = null;
  let most = base;
  for (let w = crop.w - 2; w >= 2; w -= 2) {
    const h = even((w * crop.h) / crop.w);
    const [a, side] = crop.axis === 'x' ? [w, h] : [h, w];
    // A crop too small to hold every face whole only gets smaller.
    const found = clearedBy(faces, crop, clear, a, side, (sideSize - side) / 2);
    if (!found) break;
    if (found.count > most) [most, best] = [found.count, { w, h, cross: found.cross }];
    if (most === faces.length) break;
  }
  return best;
}

/** How each shot (or part) of a clip is framed: from just before it starts, the crop it uses and its path. */
function framing(clip: FacesClip, crop: Crop, clear?: Clear): { from: number; crop: Crop; zoom?: Zoom; at: (t: number) => number }[] {
  const middle = (c: Crop) => Math.floor(c.travel / 4) * 2;
  return framedShots(clip).map((shot) => {
    const along = clear && clearOn(clear, crop.axis);
    const zoom = clear && oneFace(shot) ? tighterCrop(shot, crop, clear) : null;
    const used = zoom ? zoomed(crop, zoom) : crop;
    const path = pathThrough(holdsFor(shot, used, KEEP_BESIDE, along), middle(used));
    const bounds = along && oneFace(shot) ? boundsFor(shot, used, KEEP_BESIDE, along) : null;
    const at = bounds ? (t: number) => { const [lo, hi] = bounds(t); return evenWithin(Math.min(hi, Math.max(lo, path(t))), lo, hi); } : path;
    return { from: shot.start - BEFORE_CUT, crop: used, ...(zoom ? { zoom } : {}), at };
  });
}

/** The crop at any time of the clip, on even pixels: its shot's (or part's) size and path, from just before it starts. */
function trackOf(clip: FacesClip, crop: Crop, clear?: Clear): (t: number) => { at: number; zoom?: Zoom } {
  const shots = framing(clip, crop, clear);
  return (t) => {
    let k = 0;
    while (k + 1 < shots.length && t >= shots[k + 1].from) k++;
    const shot = shots[k];
    if (!shot) return { at: Math.floor(crop.travel / 4) * 2 };
    const at = Math.min(shot.crop.travel, Math.max(0, Math.round(shot.at(t) / 2) * 2));
    return shot.zoom ? { at, zoom: shot.zoom } : { at };
  };
}

/** The crop's place at any time of the clip, on even pixels: its shot's (or part's) path, from just before it starts. */
export function cropTrack(clip: FacesClip, crop: Crop, clear?: Clear): (t: number) => number {
  const track = trackOf(clip, crop, clear);
  return (t) => track(t).at;
}

const sameZoom = (a?: Zoom, b?: Zoom) => a?.w === b?.w && a?.h === b?.h && a?.cross === b?.cross;

/**
 * When the crop moves and to where: a look every frame of the nominal rate, sent half a frame early with the place
 * that frame's own time asks for (never the next shot's, so a frame before a cut keeps its shot's place), and at each
 * cut or split just before its first frame, kept only where the place changes. Times, not frame numbers, so a clip
 * whose frame rate varies is cut where its frames really fall.
 */
export function cropMoves(clip: FacesClip, crop: Crop, fps: number, durationSec: number, clear?: Clear): Move[] {
  const track = trackOf(clip, crop, clear);
  const cuts = framedShots(clip).slice(1).map((shot) => shot.start - BEFORE_CUT);
  const looks = new Map<number, number>([[0, 0]]);
  let next = 0;
  for (let n = 1; (n - 0.5) / fps < durationSec; n++) {
    const sec = (n - 0.5) / fps;
    while (next < cuts.length && cuts[next] <= sec) next++;
    looks.set(sec, next < cuts.length ? Math.min(n / fps, cuts[next] - BEFORE_CUT / 2) : n / fps);
  }
  for (const cut of cuts) looks.set(cut, cut);
  const moves: Move[] = [];
  for (const [sec, on] of [...looks].sort(([a], [b]) => a - b)) {
    const { at, zoom } = track(on);
    const last = moves.at(-1);
    if (!last || last.at !== at || !sameZoom(last.zoom, zoom)) moves.push({ sec, at, ...(zoom ? { zoom } : {}) });
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
  moves: Move[];
}

/**
 * How `video` is cut to the shape `ratio`, with the boxes at `faces`, by default its own where faces writes them, and
 * with `clear` each face kept inside that part of the output where a crop can. Boxes it reads that were found on another
 * clip, or on this one before it was cut or replaced, are refused, naming `label` and the `ways` out.
 */
export function planShape(video: string, ratio: number, o: { faces?: string; label?: string; ways?: string; clear?: Clear } = {}): Shaping {
  const { width, height, sar } = probeSquareSize(video);
  const crop = cropFor(width, height, ratio);
  const base = { video, width, height, sar, crop };
  // A clip already in the shape may still need a tighter crop to keep a face clear.
  if (crop.travel === 0 && !o.clear) return { ...base, how: 'already', facesPath: null, clip: null, moves: [] };
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
  const moves = cropMoves(shots, crop, probeFrameRate(video).fps, durationSec, o.clear);
  const seen = clip?.shots.some((shot) => shot.samples.some((sample) => sample.faces.length > 0)) ?? false;
  const ignored = clip ? undefined : othersFaces(video) ?? stranded[0]?.path;
  return { ...base, how: seen ? 'faces' : 'middle', facesPath, clip, moves, ...(ignored ? { ignored } : {}) };
}

/** The move in force at `sec` of the clip: the last at or before it. */
function moveAt(moves: Move[], sec: number): Move {
  let at = moves[0];
  for (const m of moves) {
    if (m.sec > sec) break;
    at = m;
  }
  return at;
}

/** The place the crop holds at `sec` of the clip: the last move at or before it. */
export function placeAt(moves: Move[], sec: number): number {
  return moveAt(moves, sec).at;
}

/** The source's pixels the crop shows at `sec` of the clip, as a box in them. */
function windowAt(s: Shaping, sec: number): FaceBox {
  const m = s.moves.length ? moveAt(s.moves, sec) : { at: 0, zoom: undefined };
  const [w, h, cross] = m.zoom ? [m.zoom.w, m.zoom.h, m.zoom.cross] : [s.crop.w, s.crop.h, 0];
  return s.crop.axis === 'x' ? { x: m.at, y: cross, w, h } : { x: cross, y: m.at, w, h };
}

/**
 * The parts of the clip where a face the crop shows reaches outside the `clear` part of the output, each with how
 * many of its samples do, and the samples with a face in all.
 */
export function underClear(s: Shaping, clear: Clear): { spans: { from: number; to: number; samples: number }[]; samples: number; of: number } {
  const spans: { from: number; to: number; samples: number }[] = [];
  let of = 0;
  // Float error only: a place is rounded to even pixels inside the range that keeps its face clear.
  const slack = 1e-6;
  for (const shot of s.clip ? framedShots(s.clip) : []) {
    let samples = 0;
    for (const sample of shot.samples) {
      const win = windowAt(s, sample.sec);
      const shown = sample.faces.filter((f) => overlaps(f, win));
      if (!shown.length) continue;
      of++;
      const out = (f: FaceBox) => (f.x - win.x) / win.w < clear.x0 - slack || (f.x + f.w - win.x) / win.w > clear.x1 + slack
        || (f.y - win.y) / win.h < clear.y0 - slack || (f.y + f.h - win.y) / win.h > clear.y1 + slack;
      if (shown.some(out)) samples++;
    }
    if (samples) spans.push({ from: shot.start, to: shot.end, samples });
  }
  return { spans, samples: spans.reduce((sum, p) => sum + p.samples, 0), of };
}

/**
 * The stretches of the clip where a face does not lie wholly inside the crop: one larger than the crop, or one a shot
 * held for several faces cuts or leaves out. Each sample stands for its shot's time halfway to the samples either side.
 */
export function unfitted(s: Shaping): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = [];
  if (s.how !== 'faces' || !s.clip) return spans;
  const size = s.crop.axis === 'x' ? s.crop.w : s.crop.h;
  for (const shot of framedShots(s.clip)) {
    for (const [i, sample] of shot.samples.entries()) {
      const at = placeAt(s.moves, sample.sec);
      const cut = sample.faces.some((f) => {
        const [a, b] = s.crop.axis === 'x' ? [f.x, f.x + f.w] : [f.y, f.y + f.h];
        return a < at || b > at + size;
      });
      if (!cut) continue;
      const from = i ? (shot.samples[i - 1].sec + sample.sec) / 2 : shot.start;
      const to = i + 1 < shot.samples.length ? (sample.sec + shot.samples[i + 1].sec) / 2 : shot.end;
      const last = spans.at(-1);
      if (last && last.to >= from) last.to = to;
      else spans.push({ from, to });
    }
  }
  return spans;
}

/**
 * The filters that cut the clip's decoded picture, from `window.from` to `window.to` seconds of it, on a clock that
 * starts at `from` (a trimmed range's); a crop that moves there is sent its moves from `script`, written into ffmpeg's
 * working directory under that name, since a path inside a filter argument would need its own escaping.
 */
export function shapeChain(s: Shaping, name: string, window = { from: 0, to: Infinity }): { filters: string[]; script?: { file: string; text: string } } {
  // Only reframe's --panel cuts a shot tighter, and it lays those shots with zoomGraph.
  if (s.moves.some((m) => m.zoom)) throw new Error('a clip with shots cut tighter is laid by zoomGraph, not one crop');
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

/**
 * The -vf graph for a clip with shots cut tighter, ending at `end`: the largest crop as shapeChain cuts it, and a crop of
 * each tighter size, every one brought to the output by the filters `fit`, each tighter one laid over the stretches cut
 * to it. A crop that changed size mid-stream would need every filter after it to change size too, and ffmpeg's scale
 * drops those frames, so each size keeps a branch of its own. The branches share the decoded frames, so they meet frame
 * for frame.
 */
export function zoomGraph(s: Shaping, name: string, fit: string[], end: number): { graph: string; scripts: { file: string; text: string }[] } {
  const spans = tighterSpans(s, end);
  const sizes = [...new Map(spans.map((p) => [`${p.zoom.w}x${p.zoom.h}`, p.zoom])).values()];
  const scripts: { file: string; text: string }[] = [];
  const branch = (label: string, w: number, h: number, places: { sec: number; x: number; y: number }[]) => {
    const target = `crop@${label}`;
    const changes = places.filter((p, i) => i === 0 || p.x !== places[i - 1].x || p.y !== places[i - 1].y);
    const crop = `${target}=w=${w}:h=${h}:x=${changes[0].x}:y=${changes[0].y}`;
    if (changes.length < 2) return [crop, ...fit].join(',');
    // sendcmd orders its lines by time, so the two axes' lines can simply follow one another.
    const text = sendcmdScript(changes.map((p) => ({ sec: p.sec, at: p.x })), 'x', target) + sendcmdScript(changes.map((p) => ({ sec: p.sec, at: p.y })), 'y', target);
    scripts.push({ file: `${label}.cmd`, text });
    return [`sendcmd=f=${label}.cmd`, crop, ...fit].join(',');
  };
  const place = (m: Move) => {
    const cross = m.zoom?.cross ?? 0;
    return { sec: Math.max(0, m.sec), x: s.crop.axis === 'x' ? m.at : cross, y: s.crop.axis === 'x' ? cross : m.at };
  };
  // The largest crop holds its last place through a stretch a tighter one covers.
  const largest = s.moves.filter((m) => !m.zoom).map(place);
  const lines = [`${[...asShown(s), `split=${sizes.length + 1}`].join(',')}[full]${sizes.map((_, k) => `[in${k}]`).join('')}`,
    `[full]${branch(name, s.crop.w, s.crop.h, largest.length ? largest : [{ sec: 0, x: 0, y: 0 }])}[o0]`];
  for (const [k, z] of sizes.entries()) {
    const own = s.moves.filter((m) => m.zoom?.w === z.w && m.zoom.h === z.h).map(place);
    const when = spans.filter((p) => p.zoom.w === z.w && p.zoom.h === z.h).map((p) => `gte(t,${p.from.toFixed(6)})*lt(t,${p.to.toFixed(6)})`).join('+');
    lines.push(`[in${k}]${branch(`${name}_${k}`, z.w, z.h, own)}[z${k}]`,
      `[o${k}][z${k}]overlay=x=0:y=0:format=auto:enable='${when}'${k + 1 < sizes.length ? `[o${k + 1}]` : ''}`);
  }
  return { graph: lines.join(';'), scripts };
}

/** Fit for a clip of another shape than a canvas: `crop` cuts it as reframe does, `letterbox` pads it whole. */
export type Fit = 'crop' | 'letterbox';

export function parseFit(text: string | undefined): Fit {
  if (text === undefined) return 'crop';
  if (text === 'crop' || text === 'letterbox') return text;
  throw new Error(`--fit expects crop or letterbox, got "${text}"`);
}

/**
 * Where the crop's pixels land in the output, as ffmpeg's scale and crop put them: the crop scaled to cover `to` with its
 * shape kept, each side rounded to the nearest pixel, and the middle of that cut out.
 */
function coverScale(crop: { w: number; h: number }, to: Size): { sx: number; sy: number; ox: number; oy: number } {
  const w = Math.max(to.width, Math.round((to.height * crop.w) / crop.h));
  const h = Math.max(to.height, Math.round((to.width * crop.h) / crop.w));
  return { sx: w / crop.w, sy: h / crop.h, ox: Math.floor((w - to.width) / 2), oy: Math.floor((h - to.height) / 2) };
}

/** The clip reframe wrote, as its faces.json describes it. */
interface Output extends Size { video: string; fps: number; frameRate: string; durationSec: number }

/**
 * The faces of reframe's output, from its source's: each sample's boxes moved with the crop where it stood at that sample and
 * scaled with it, a box the crop cuts kept in part and one wholly outside dropped as faces does at a frame's edge, the shots
 * and times the source's, so the output's faces.json reads as faces' own for it.
 */
function reframedFaces(s: Shaping, source: FacesClip, out: Output): FacesClip {
  // Where the crop stands at `sec` and how it is scaled there: a shot cut tighter is scaled up more.
  const placed = (sec: number) => {
    const win = windowAt(s, sec);
    const { sx, sy, ox, oy } = coverScale(win, out);
    return { sx, sy, shift: { x: win.x * sx + ox, y: win.y * sy + oy } };
  };
  const shown = (boxes: [number, number, number, number, number?][], sec: number) => {
    const { sx, sy, shift } = placed(sec);
    return toDisplay(boxes, sx, sy, out.width, out.height, shift);
  };
  const shots = source.shots.map((shot, k): Shot => ({
    start: shot.start,
    // The last shot runs to the output's own end, as faces would measure it there.
    end: k === source.shots.length - 1 ? out.durationSec : shot.end,
    samples: shot.samples.map((sample) => {
      const boxes = sample.faces.map((f): [number, number, number, number, number?] => [f.x, f.y, f.w, f.h, f.score]);
      return { sec: sample.sec, faces: shown(boxes, sample.sec) };
    }),
  }));
  // Each graphic moved with the crop as a face is, over the seconds it is up.
  const boxAt = (g: GraphicBox) => (sec: number) => {
    const [box] = shown([[g.x, g.y, g.w, g.h]], sec);
    return box ? { x: box.x, y: box.y, w: box.w, h: box.h } : null;
  };
  const graphics = source.graphics?.flatMap((g) => graphicOnto(g.from, g.to, source.every, boxAt(g), (sec) => sec));
  return {
    video: out.video, name: basename(out.video), width: out.width, height: out.height, fps: out.fps, frameRate: out.frameRate,
    durationSec: out.durationSec, model: source.model, every: source.every, threshold: source.threshold,
    confidence: source.confidence, textMargin: source.textMargin,
    ...(graphics ? { graphicsMargin: source.graphicsMargin, graphics } : {}), shots,
  };
}

/**
 * The boxes of a clip already in the shape, which planShape does not read since nothing is cut: those `named`, else its own,
 * when they were found on this clip as it is now. Otherwise null, and why.
 */
function wholeFaces(video: string, named: string | undefined, size: Size): { clip: FacesClip | null; why?: string } {
  const path = named === undefined ? ownFaces(video) : resolve(named);
  if (!path) return { clip: null };
  try {
    const clip = readFaces(path);
    const other = notFacesOf(clip, video, size, probeVideoSpan(video).end);
    return other ? { clip: null, why: `${path} ${other}` } : { clip };
  } catch (e) {
    return { clip: null, why: (e as Error).message };
  }
}

const unused = (s: Shaping) => (s.ignored ? `; ${s.ignored} holds another clip's and is not used` : '');

/** What a command prints for a clip it cut to `target`: which of reframe's two ways it took, and from what. */
export function describeShape(what: string, s: Shaping, target: string): string {
  const size = `${s.width}x${s.height}`;
  if (s.how === 'faces') return `${what} (${size}) is cut to ${target} around its faces (${s.facesPath}), as reframe cuts it`;
  const why = s.clip ? `its face boxes (${s.facesPath}) show no face` : `no face boxes for it (faces writes them)${unused(s)}`;
  return `${what} (${size}) is cut to ${target} from the middle, as reframe cuts it: ${why}`;
}

/**
 * The shape to cut to: --aspect, else the shape of the platform in the piece's brief, which is found from the clip
 * reframe writes, since that is the piece's own file and the source may be anyone's. Null when neither gives one.
 */
export function aspectFor(named: string | undefined, out: string): { aspect: string; said?: string } | null {
  let found: FoundBrief | null = null;
  try {
    found = readBrief(out);
  } catch (error) {
    // An --aspect needs no brief, so one that cannot be read stops only a call that relies on it.
    if (named === undefined) throw error;
  }
  const platform = found?.brief.platform;
  if (named !== undefined) {
    const theirs = platform === undefined ? undefined : shapeOf(platform);
    const differs = theirs !== undefined && Math.abs(parseAspect(theirs) / parseAspect(named) - 1) > 1e-9;
    return { aspect: named, said: differs ? `${named} from --aspect, over the ${theirs} of the platform ${platform} in ${found!.path}` : undefined };
  }
  if (platform === undefined) return null;
  const shape = shapeOf(platform);
  if (!shape) throw new Error(`${found!.path} has the platform ${JSON.stringify(platform)}, which names no one shape: pass --aspect`);
  return { aspect: shape, said: `${shape}, the shape of the platform ${platform} in ${found!.path}` };
}

// A platform posted in several shapes names none (openedit brief refuses one, but a brief can be written by hand).
function shapeOf(platform: string): Shape | undefined {
  try {
    return formatNamed(platform).shape;
  } catch {
    return undefined;
  }
}

/**
 * What the crop cuts: how many graphics, over which seconds, in which rows of a picture `height` tall; `left` for text
 * found on the erased clip, which the eraser left.
 */
export function describeCut(cut: GraphicBox[], height: number, left = false): string {
  const [from, to] = [Math.min(...cut.map((g) => g.from)), Math.max(...cut.map((g) => g.to))];
  const rows = bandsOf(cut, height).map((b) => `${b.y}-${b.y + b.h}`).join(', ');
  const where = `up from ${from.toFixed(1)} to ${to.toFixed(1)} s, in rows ${rows} of ${height}`;
  return left
    ? `the crop still cuts text the eraser left (${cut.length} graphic(s) found on the erased clip, ${where})`
    : `the crop cuts text burned into the footage (subtitles, a lower third: ${cut.length} graphic(s) faces found, ${where})`;
}

type EraseFlags = { aspect?: string; size?: string; faces?: string; panel?: string };
const say = (line: string) => console.log(`reframe: ${line}`);
const usd = (n: number) => `$${n.toFixed(2)}`;

/** This reframe as it was given, with --erase and `extra`, to run again. */
const rerun = (video: string, out: string, flags: EraseFlags, ...extra: string[]) => ['openedit reframe', shellArg(video),
  ...(flags.aspect ? ['--aspect', flags.aspect] : []), ...(flags.size ? ['--size', flags.size] : []),
  ...(flags.faces ? ['--faces', shellArg(flags.faces)] : []), ...(flags.panel ? ['--panel', shellArg(flags.panel)] : []), '--out', shellArg(out), '--erase', ...extra].join(' ');

/** A yes as --approve carries it: the price the user approved and the quote it was printed with. */
type Approval = { raw: string; usd: number; id: string };

/** --approve's price and quote; it only ever approves an erase. */
function approved(raw: string | undefined, erase: boolean | undefined): Approval | undefined {
  if (raw === undefined) return undefined;
  if (!erase) throw new Error('--approve approves the price of an erase: pass it with --erase');
  const m = /^\$?(\d+(?:\.\d+)?):([0-9a-f]{8})$/.exec(raw.trim());
  if (!m) throw new Error(`--approve wants the price the user approved and its quote, as --erase printed them (e.g. --approve 5.04:3f2a9c1e), not "${raw}"`);
  return { raw: raw.trim(), usd: Number(m[1]), id: m[2] };
}

/** What sending `parts` to the eraser costs, as fal bills it: an estimate, from the seconds of video sent. */
function priced(parts: { sent: number }[], fps: number): string {
  const q = quoteOf(parts, fps);
  return `about ${usd(q.usd)} (an estimate: ${q.seconds} s billed, each run in whole seconds, at fal's $${ERASER_USD_PER_SEC} per second)`;
}

/**
 * Approves `parts` when `approve` carries their quote as it stands, recording that quote approved so it never approves
 * again: their inputs are written, so their runs exist, and the quote is returned. Otherwise says the price and the
 * --approve that carries the user's yes to it, and returns the exit code.
 */
function approveOrAsk(dir: string, parts: ErasePlan['parts'], fps: number, approve: Approval | undefined, spend: string, again: string,
  notes: string[] = [], ask = 'nothing is spent yet, and there is no run to make yet: ask the user to approve about'): { quote: Quote } | { code: number } {
  const q = quoteFor(dir, parts, fps);
  const theirs = approve !== undefined && approve.id === q.id && Math.abs(approve.usd - q.usd) < 0.005;
  if (theirs && spendQuote(dir, q)) {
    approveParts(parts);
    say(`approved: ${spend} for ${usd(q.usd)}`);
    return { quote: q };
  }
  say(`${spend} costs ${priced(parts, fps)}`);
  for (const note of notes) say(note);
  say(`${ask} ${usd(q.usd)} once, before any part runs. `
    + `When they say yes, run ${again} --approve ${q.usd.toFixed(2)}:${q.id}: it writes the runs and prints them, once`);
  if (approve === undefined) return { code: 0 };
  say(theirs || quoteSpent(dir, approve.id)
    ? `--approve ${approve.raw} was approved already and its runs printed, so it approves nothing again`
    : `--approve ${approve.raw} is not the price waiting for a yes, so nothing was approved`);
  return { code: 1 };
}

/**
 * The fal command `fal`, when it is one an environment gives in place of a fal key (it holds the key where this process
 * cannot read it): it says it takes a model and that model's input. fal's own CLI also answers to `fal`, and runs apps.
 */
function ownFal(): boolean {
  const fal = findOnPath('fal');
  if (!fal) return false;
  const r = spawnSync(fal, ['--help'], { encoding: 'utf8', timeout: 10_000 });
  return /fal run MODEL_ID INPUT_JSON/.test(`${r.stdout ?? ''}${r.stderr ?? ''}`);
}

/**
 * The fal runs for `parts`, approved under `quote`. `openedit fal` runs them as one batch on a fal key it can read. With
 * no key, the environment's own `fal` runs one generation a call, its input the second argument.
 */
function falRuns(parts: ErasePlan['parts'], dir: string, out: string, quote: Quote): string[] {
  let keyed = true;
  try {
    falKey();
  } catch {
    keyed = false;
  }
  if (!keyed && ownFal()) return parts.map((p) => `fal run ${ERASER} @${shellArg(p.input)} --out ${shellArg(p.out)}`);
  return [`openedit fal run --batch ${shellArg(writeJobs(parts, dir, quote.id))} --out ${shellArg(dir)} --run ${shellArg(dirname(out))}`];
}

/** The runs that erase `parts`, just approved under `quote`, and what to run once they are back. */
function runsToMake(plan: ErasePlan, parts: ErasePlan['parts'], dir: string, out: string, again: string, quote: Quote): void {
  const missing = missingParts(plan);
  const runs = falRuns(parts, dir, out, quote);
  say(`run the eraser on ${parts.length === 1 ? 'the part' : `each of the ${parts.length} parts`}, its output in the folder named for it`
    + `${runs.length > 1 ? ' (the runs can go at the same time)' : ''}:`);
  for (const run of runs) say(`  ${run}`);
  say(`then run ${again} again: it lays the erased rows over the clip and reframes that to ${out}. `
    + `Still to erase: ${missing.length === plan.parts.length ? 'every part' : missing.map((p) => p.name).join(', ')}`);
}

/**
 * The clip with the rows of `cut` erased, its face boxes and the erase's plan, once the eraser has erased every part of
 * it; until then the exit code, with the parts written beside `out` and either their price or their fal runs printed.
 */
function erasedClip(s: Shaping, cut: GraphicBox[], out: string, flags: EraseFlags, approve: Approval | undefined):
{ video: string; faces: string; plan: ErasePlan; dir: string } | { code: number } {
  const bands = bandsOf(cut, s.height);
  const dir = eraseFolder(out, s.video, bands);
  const plan = prepareErase(s.video, s, bands, dir, say);
  const rows = bands.map((b) => `${b.y}-${b.y + b.h}`).join(', ');
  const missing = missingParts(plan);
  if (missing.length) {
    const fps = fpsOf(plan.rate);
    const again = rerun(s.video, out, flags);
    const unpaid = unapproved(missing);
    if (unpaid.length === plan.parts.length) {
      say(`${describeCut(cut, s.height)}`);
      say(`${plan.parts.length} part(s) of it, each of at most ${PART_SEC} s with half a second of what follows, are cut for the eraser `
        + `in ${dir}; rows ${rows} of what comes back are laid over the clip`);
    }
    if (unpaid.length) {
      const first = unpaid.length === plan.parts.length;
      const spend = `erasing ${first ? 'them' : unpaid.map((p) => p.name).join(', ')} with ${ERASER} on fal`;
      const resend = first ? `a part the eraser hands back with text left in it is sent again in two halves: a second spend of up to `
        + `${usd(resendQuote(plan.parts, fps).usd)} for each part sent again, which needs its own yes` : '';
      const asked = approveOrAsk(dir, unpaid, fps, approve, spend, again, resend ? [resend] : []);
      if ('code' in asked) return asked;
      runsToMake(plan, unpaid, dir, out, again, asked.quote);
      return { code: 0 };
    }
    // Their runs were printed when their price was approved, and a second run of one is a second charge.
    const names = missing.map((p) => p.name).join(', ');
    say(`still to erase: ${names}, whose runs were printed when their price was approved: wait for a run that is still going, and run this again once it is back`);
    const asked = approveOrAsk(dir, missing, fps, approve, `running ${names} again with ${ERASER} on fal`, again,
      ['a run fal refused cost nothing, but one that failed after fal took it may have been charged, so running a part again is a new spend'],
      'to run them again, ask the user to approve about');
    if ('code' in asked) return asked;
    runsToMake(plan, missing, dir, out, again, asked.quote);
    return { code: 0 };
  }
  const video = join(dir, `${basename(s.video, extname(s.video))}.erased.mp4`);
  const newest = Math.max(...plan.parts.map((p) => statSync(erasedPart(p.out)!).mtimeMs));
  if (!existsSync(video) || statSync(video).mtimeMs < newest) joinErased(plan, s, video, say);
  // The source's face boxes (it has some: the graphics cut came from them) hold for the erased clip, which keeps every
  // frame and every pixel outside the rows. Its graphics are searched for again, so text the eraser left is found.
  const faces = join(facesFolder(video), 'faces.json');
  const clip: FacesClip = { ...s.clip!, video, name: basename(video), durationSec: probeVideoSpan(video).end, graphics: findGraphics(video, s.clip!.every).graphics };
  writeAtomic(faces, clip);
  writeTextAtomic(join(facesFolder(video), 'faces.js'), facesScript(clip));
  say(`erased rows ${rows} of ${basename(s.video)} in ${plan.parts.length} part(s) and laid them over it → ${video}`);
  return { video, faces, plan, dir };
}

/**
 * Text the crop still cuts once the erase is laid in: said, with the parts it is in; those of them long enough cut in two
 * for the eraser, their price said for a yes of its own, and the shorter ones left to the user.
 */
function leftBehind(left: GraphicBox[], plan: ErasePlan, source: Shaping, dir: string, out: string, flags: EraseFlags): void {
  // A graphic's times run from the sample before it was first seen to the one after it was last seen: up to one sampling
  // step wider at each end than it was up, which would reach into a part it is not in.
  const [from, to] = [Math.min(...left.map((g) => g.from)), Math.max(...left.map((g) => g.to))];
  const step = Math.min(source.clip?.every ?? 0, (to - from) / 2);
  const fps = fpsOf(plan.rate);
  const parts = partsOver(plan, fps, from + step, to - step);
  const names = (list: ErasePlan['parts']) => list.map((p) => p.name).join(', ');
  const [long, short] = [parts.filter((p) => splittable(p, fps)), parts.filter((p) => !splittable(p, fps))];
  const kept = short.length
    ? `${names(short)} ${short.length === 1 ? 'is' : 'are'} too short to cut in two and send again: tell the user that text is still there`
    : '';
  const what = `${describeCut(left, source.height, true)}, in ${names(parts)}`;
  if (!long.length) {
    say(`${what}: ${kept}`);
    return;
  }
  const halves = missingParts(splitParts(plan, long.map((p) => p.name), source, dir, say));
  say(`${what}: ${names(long)} ${long.length === 1 ? 'is' : 'are each'} cut in two to send to the eraser again, as ${names(halves)}`
    + `${kept ? `; ${kept}` : ''}`);
  // Never this call's --approve: that yes was to the parts before these, and sending these is a spend of its own.
  approveOrAsk(dir, halves, fps, undefined, `sending them again with ${ERASER} on fal, a second spend,`, rerun(source.video, out, flags));
}

export interface Panel { x: number; y: number; w: number; h: number }

export function parsePanel(raw: string): Panel {
  const m = /^(\d+),(\d+),(\d+),(\d+)$/.exec(raw.replace(/\s+/g, ''));
  const [x, y, w, h] = m ? m.slice(1).map(Number) : [];
  if (!m || w < 2 || h < 2) throw new Error(`--panel wants x,y,w,h in px of the canvas, e.g. 0,960,1080,960 for the bottom half of 1080x1920; got "${raw}"`);
  return { x, y, w, h };
}

/**
 * The part of `panel`, on the canvas of `format`, that the platform's UI leaves clear, as fractions of the panel; null when
 * the UI covers all of it. The UI's bands are the zone's insets as measured, not evened out as its text area's sides are,
 * since a face is kept clear of what the app draws, not centred.
 */
export function clearOf(panel: Panel, format: Format): Clear | null {
  const { canvas, insets } = format;
  const frac = (edge: number, from: number, size: number) => Math.min(1, Math.max(0, (edge - from) / size));
  const clear = {
    x0: frac(insets.left, panel.x, panel.w), x1: frac(canvas.width - insets.right, panel.x, panel.w),
    y0: frac(insets.top, panel.y, panel.h), y1: frac(canvas.height - insets.bottom, panel.y, panel.h),
  };
  return clear.x0 < clear.x1 && clear.y0 < clear.y1 ? clear : null;
}

/** --panel on the canvas of the platform in the piece's brief, found from `out`, with the part of it that platform's UI leaves clear. */
export function panelFor(raw: string, out: string): Panel & { format: Format; brief: string; clear: Clear | null } {
  const panel = parsePanel(raw);
  const found = readBrief(out);
  const platform = found?.brief.platform;
  if (!found || platform === undefined) {
    throw new Error(`--panel keeps faces clear of the UI of the platform the piece is posted on, and ${found ? `${found.path} records no platform` : `no brief.json for ${out} names one`}: `
      + `record it with npx @veedstudio/openedit-cli brief ${dirname(out)} --platform <zone>`);
  }
  let format: Format;
  try {
    format = formatNamed(platform);
  } catch (error) {
    throw new Error(`${found.path} has the platform ${JSON.stringify(platform)}: ${(error as Error).message}`, { cause: error });
  }
  const { width, height } = format.canvas;
  if (panel.x + panel.w > width || panel.y + panel.h > height) {
    throw new Error(`--panel ${raw.trim()} runs off the ${width}x${height} canvas of ${format.name}, the platform in ${found.path}: it is in px of that canvas`);
  }
  return { ...panel, format, brief: found.path, clear: clearOf(panel, format) };
}

const secs = (n: number) => Math.max(0, n).toFixed(2);

/** The stretches of the clip cut tighter than the largest crop, from its moves, each with its crop. */
function tighterSpans(s: Shaping, end: number): { from: number; to: number; zoom: Zoom }[] {
  const spans: { from: number; to: number; zoom: Zoom }[] = [];
  for (const [i, m] of s.moves.entries()) {
    const last = spans.at(-1);
    if (last && last.to === Infinity && !sameZoom(last.zoom, m.zoom)) last.to = m.sec;
    if (m.zoom && (i === 0 || !sameZoom(s.moves[i - 1].zoom, m.zoom))) spans.push({ from: m.sec, to: Infinity, zoom: m.zoom });
  }
  return spans.map((span) => ({ ...span, to: Math.min(span.to, end) }));
}

/** What --panel did: where the faces are kept, each stretch cut tighter, and in one line the faces left under the UI. */
function printPanel(panel: ReturnType<typeof panelFor>, s: Shaping): void {
  const { format, clear } = panel;
  const place = `${panel.w}x${panel.h} at ${panel.x},${panel.y} of the ${format.canvas.width}x${format.canvas.height} canvas of ${format.name}, the platform in ${panel.brief}`;
  if (!clear) {
    console.log(`reframe: the panel, ${place}, lies wholly under its UI, so it is framed as without --panel`);
    return;
  }
  const on = (f: number, from: number, size: number) => Math.round(from + f * size);
  console.log(`reframe: the clip fills ${place}; faces are kept inside x ${on(clear.x0, panel.x, panel.w)}–${on(clear.x1, panel.x, panel.w)}, `
    + `y ${on(clear.y0, panel.y, panel.h)}–${on(clear.y1, panel.y, panel.h)} of that canvas, clear of the UI`);
  const end = s.clip?.shots.at(-1)?.end ?? 0;
  for (const span of tighterSpans(s, end)) {
    console.log(`reframe: ${secs(span.from)}–${secs(span.to)} s is cut tighter, ${span.zoom.w}x${span.zoom.h} of the source for ${s.crop.w}x${s.crop.h}, `
      + 'the largest that keeps the most of its face clear of the UI, all of it whole');
  }
  const under = underClear(s, clear);
  if (under.samples) {
    const where = under.spans.map((p) => `${secs(p.from)}–${secs(p.to)} s`).join(', ');
    console.log(`reframe: ${under.samples} of ${under.of} samples with a face (${where}) still show one under the UI, where the crop `
      + 'cannot hold every face of the shot whole and clear of it; none is cut to try');
  }
}

export function reframe(argv: string[]): number {
  const { values, positionals } = parseUsage('reframe', usage, argv);
  const [videoArg] = positionals;
  if (!videoArg || !values.out) {
    console.error(usageLine('reframe', usage));
    return 2;
  }
  const out = resolve(values.out);
  const panel = values.panel === undefined ? null : panelFor(values.panel, values.out);
  if (panel && values.aspect !== undefined && Math.abs(parseAspect(values.aspect) / (panel.w / panel.h) - 1) > 1e-9) {
    throw new Error(`--aspect ${values.aspect} is not the shape of --panel's ${panel.w}x${panel.h}: leave out --aspect, the panel gives the shape`);
  }
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const chosen = panel ? { aspect: `${panel.w / gcd(panel.w, panel.h)}:${panel.h / gcd(panel.w, panel.h)}`, said: undefined } : aspectFor(values.aspect, out);
  if (!chosen) {
    console.error(`no --aspect, and no platform in a brief.json for ${out}: pass --aspect, or record where the piece is posted with `
      + `npx @veedstudio/openedit-cli brief ${dirname(values.out)} --platform <zone>`);
    console.error(usageLine('reframe', usage));
    return 2;
  }
  const aspect = chosen.aspect;
  if (chosen.said) console.log(`reframe: shape ${chosen.said}`);
  const video = resolveVideoArg(videoArg);
  if (!existsSync(video)) throw new Error(`video not found: ${video}`);
  if (values.faces !== undefined && !existsSync(resolve(values.faces))) {
    throw new Error(`no face boxes at ${resolve(values.faces)}: run npx @veedstudio/openedit-cli faces ${videoArg} first, or leave out --faces to cut from the middle`);
  }
  const ratio = parseAspect(aspect);
  const size = panel && values.size === undefined ? evenSize({ width: panel.w, height: panel.h }) : parseSize(values.size, ratio, aspect);
  const approve = approved(values.approve, values.erase);
  let shape = planShape(video, ratio, {
    faces: values.faces, label: videoArg,
    ways: `, or name its faces.json with --faces${values.faces === undefined ? '' : ', or leave out --faces to cut from the middle'}`,
    ...(panel?.clear ? { clear: panel.clear } : {}),
  });
  const cutBy = (s: Shaping) => (s.how === 'already' ? [] : cutGraphics({ crop: s.crop, moves: s.moves, graphics: s.clip?.graphics ?? [] }));
  const cut = cutBy(shape);
  let again: (() => void) | null = null;
  if (values.erase && cut.length) {
    const source = shape;
    const clean = erasedClip(source, cut, out, values, approve);
    if ('code' in clean) return clean.code;
    shape = planShape(clean.video, ratio, { faces: clean.faces, label: clean.video, ...(panel?.clear ? { clear: panel.clear } : {}) });
    const still = cutBy(shape);
    // Said last, after the clip is written, as the cut line is.
    if (still.length) again = () => leftBehind(still, clean.plan, source, clean.dir, out, values);
  } else if (values.erase) {
    console.log(`reframe: the crop cuts no text burned into ${videoArg}${shape.clip?.graphics ? '' : ' that is known (faces finds it, in the same run as the faces: run faces on it first)'}, so nothing is erased`);
  }
  const source = shape.video;
  const { width, height, crop } = shape;
  const to = size === 'native' ? { width: crop.w, height: crop.h } : size;
  // A shot cut tighter is scaled up to the size the rest of the clip has.
  const scaled = to.width !== crop.w || to.height !== crop.h || shape.moves.some((m) => m.zoom);
  if (shape.how !== 'already' && !shape.clip) console.log(`reframe: no face boxes for ${videoArg} (faces writes them)${unused(shape)}, so the crop is cut from the middle`);
  const whole: { clip: FacesClip | null; why?: string } = shape.how === 'already' ? wholeFaces(video, values.faces, { width, height }) : { clip: shape.clip };
  // The clip at `out` is about to be replaced, and boxes found on the one there before would be read as its faces.
  if (existsSync(out)) for (const file of ['faces.json', 'faces.js']) rmSync(join(facesFolder(out), file), { force: true });
  const work = mkdtempSync(join(tmpdir(), 'open-edit-reframe-'));
  try {
    // A clip already in the shape gets the same encode with no crop, so every clip a piece joins comes out alike:
    // upright, in square pixels, in one codec, whatever rotation tag, pixel shape or codec it arrived with.
    // Covered, then trimmed to the size, as the joins fit a clip to their canvas: the at most two pixels by which the
    // crop's even sides miss the shape are cut off rather than stretched.
    const fit = scaled ? [`scale=${to.width}:${to.height}:force_original_aspect_ratio=increase:flags=lanczos`, `crop=${to.width}:${to.height}`] : [];
    const colour = decodedColourOf(source);
    const tail = ['setsar=1', ...stampColour(colour, settledTags(colour))];
    let graph: string;
    if (shape.moves.some((m) => m.zoom)) {
      const zoomed = zoomGraph(shape, 'reframe', fit, probeVideoSpan(source).end);
      for (const script of zoomed.scripts) writeFileSync(join(work, script.file), script.text);
      graph = [zoomed.graph, ...tail].join(',');
    } else {
      const { filters, script } = shapeChain(shape, 'reframe');
      if (script) writeFileSync(join(work, script.file), script.text);
      // H.264 in 4:2:0 wants even sides: an odd one loses its last pixel.
      if (shape.how === 'already' && (crop.w !== width || crop.h !== height)) filters.push(`crop=${crop.w}:${crop.h}:0:0`);
      graph = [...filters, ...fit, ...tail].join(',');
    }
    const r = spawnSync(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-i', source,
      '-vf', graph,
      '-map', '0:v:0', '-map', '0:a:0?', '-fps_mode', 'passthrough',
      '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], { cwd: work, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg could not reframe ${source}: ${String(r.stderr).trim().split('\n').slice(-3).join(' ')}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const fitted = scaled ? `, scaled to ${sized(to)}` : '';
  console.log(shape.how !== 'already'
    ? `reframe: ${width}x${height} → ${crop.w}x${crop.h} (${aspect})${fitted}, ${shape.clip?.shots.length ?? 1} shot(s), the crop changes place ${shape.moves.length - 1} time(s) → ${out}`
    : `reframe: ${videoArg} is already ${aspect} (${width}x${height}), so it is re-encoded upright, ` +
      `${crop.w === width && crop.h === height ? 'uncropped' : `to even pixels (${crop.w}x${crop.h})`}${fitted} → ${out}`);
  const unfit = unfitted(shape);
  if (unfit.length) {
    console.log(`reframe: a face does not fit the ${crop.w}x${crop.h} crop at ${unfit.map((p) => `${p.from.toFixed(2)}–${p.to.toFixed(2)}`).join(', ')} s `
      + '(larger than it, or beside another face a held shot keeps), so the output cuts or leaves it out there; how to show those seconds is the piece\'s choice');
  }
  if (panel) printPanel(panel, shape);
  if (whole.clip) {
    const rate = probeFrameRate(out);
    const faces = reframedFaces(shape, whole.clip, { video: out, ...to, fps: rate.fps, frameRate: rate.rate.replace(/\/1$/, ''), durationSec: probeVideoSpan(out).end });
    // Found only now that the file exists, by its real path, as faces finds it.
    const dir = facesFolder(out);
    writeAtomic(join(dir, 'faces.json'), faces);
    writeTextAtomic(join(dir, 'faces.js'), facesScript(faces));
    console.log(`reframe: wrote the faces of ${basename(out)}, its source's boxes moved with the crop, to ${join(dir, 'faces.json')} and ${join(dir, 'faces.js')}`);
  } else if (whole.why) {
    console.log(`reframe: no faces written for ${basename(out)}: ${whole.why}`);
  }
  if (cut.length && !values.erase) {
    const { parts, fps } = partsToErase(shape.video);
    console.log(`reframe: ${describeCut(cut, shape.height)}: run this again with --erase to erase those rows first, so no cut-off text shows; `
      + `erasing them costs ${priced(parts, fps)}, for the user to approve before anything is spent`);
  }
  again?.();
  return 0;
}
