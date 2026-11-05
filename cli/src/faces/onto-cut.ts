// The faces of a cut, from the faces `faces` found on its sources: each range's samples moved onto the cut's
// timeline and through what the cut does to the range's picture, so the cut needs no detection of its own.
import { basename } from 'node:path';
import type { FaceBox, FacesClip, GraphicBox, Rect, Sample, Shot } from './page-script.ts';

/** One range of the cut, as its picture was made from its source. */
export interface RangeOnCut {
  /** The stretch of the source it keeps, in the source's seconds, on the source's frame grid. */
  start: number;
  end: number;
  fps: number;
  /** Where it starts on the cut, and how much longer it plays there than in its source (2 at half speed). */
  at: number;
  stretch: number;
  /** The source's boxes, or null when there are none to move. */
  faces: FacesClip | null;
  /** The source's picture as shown, in square pixels. */
  shown: { width: number; height: number };
  /** The crop cut from that picture before it meets the canvas, and its place along its axis at a source second. */
  crop?: { axis: 'x' | 'y'; w: number; h: number; place: (sec: number) => number };
}

/** What the cut is: its file, its picture as probed, and how each range's picture meets its canvas. */
export interface CutPicture {
  video: string;
  width: number;
  height: number;
  fps: number;
  frameRate: string;
  durationSec: number;
  fit: 'crop' | 'letterbox';
}

const micro = (s: number) => Math.round(s * 1e6) / 1e6;

/**
 * A box of the source at `sec` of it, where it lands on the cut: less the range's crop, then scaled onto the canvas
 * as apply-edl scales the picture (covering it and cropping the middle, or fitting it whole and padding), clamped to
 * the canvas; null when nothing of it is left.
 */
export function boxOnCut(box: FaceBox, sec: number, range: RangeOnCut, cut: CutPicture): FaceBox | null {
  let { x, y } = box;
  let [fw, fh] = [range.shown.width, range.shown.height];
  if (range.crop) {
    const p = range.crop.place(sec);
    if (range.crop.axis === 'x') x -= p;
    else y -= p;
    [fw, fh] = [range.crop.w, range.crop.h];
  }
  const s = cut.fit === 'letterbox' ? Math.min(cut.width / fw, cut.height / fh) : Math.max(cut.width / fw, cut.height / fh);
  const [ox, oy] = [(cut.width - fw * s) / 2, (cut.height - fh * s) / 2];
  const x0 = Math.max(0, x * s + ox), y0 = Math.max(0, y * s + oy);
  const x1 = Math.min(cut.width, (x + box.w) * s + ox), y1 = Math.min(cut.height, (y + box.h) * s + oy);
  const out = { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
  if (!(out.w > 0 && out.h > 0)) return null;
  return box.score === undefined ? out : { ...out, score: box.score };
}

/**
 * One range's shots on the cut. Each source shot the range reaches becomes a shot of its own, cut at the range's
 * edges, holding the samples whose frames the range plays: a source second t lands at at + (t - start) * stretch. A
 * part of a shot with no sample of its own takes the shot's nearest one at its first instant, since a shot with no
 * sample reads as a shot without a face. With no source boxes, the range is one shot marked unknown.
 */
export function rangeShots(range: RangeOnCut, cut: CutPicture): Shot[] {
  const onCut = (t: number) => range.at + (t - range.start) * range.stretch;
  if (!range.faces?.shots.length) return [{ start: micro(range.at), end: micro(onCut(range.end)), samples: [], unknown: true }];
  // The frames the range plays, as its trim keeps them: from half a frame before each edge.
  const half = 0.5 / range.fps;
  const plays = (sec: number) => sec >= range.start - half && sec < range.end - half;
  const { shots } = range.faces;
  const out: Shot[] = [];
  shots.forEach((shot, k) => {
    // The first shot holds whatever comes before it and the last whatever after, as a player shows them.
    const a = Math.max(k === 0 ? -Infinity : shot.start, range.start);
    const b = Math.min(k === shots.length - 1 ? Infinity : shot.end, range.end);
    if (b - a < half) return;
    const own = shot.samples.filter((x) => plays(x.sec));
    const nearest = (): Sample[] => {
      const away = (x: Sample) => (x.sec < a ? a - x.sec : x.sec - b);
      const best = shot.samples.reduce<Sample | null>((top, x) => (!top || away(x) < away(top) ? x : top), null);
      return best ? [{ sec: a, faces: best.faces }] : [];
    };
    const start = micro(onCut(a));
    out.push({
      start,
      end: micro(onCut(b)),
      samples: (own.length ? own : nearest()).map((x) => ({
        sec: Math.max(start, micro(onCut(x.sec))),
        faces: x.faces.flatMap((f) => boxOnCut(f, x.sec, range, cut) ?? []),
      })),
    });
  });
  return out;
}

/**
 * A graphic of a source carried onto another picture over the source's seconds `from` to `to`: `boxAt` places its box
 * at a source second, or null where none of it shows, and `timeOf` gives that second on the other picture. The box is
 * read every `step` of the source, the faces' own sampling, which the picture's moves are known no finer than; each
 * piece covers where the box stood at both of its ends, so a move between them stays inside it, and pieces holding one
 * box are joined.
 */
export function graphicOnto(from: number, to: number, step: number, boxAt: (sec: number) => Rect | null, timeOf: (sec: number) => number): GraphicBox[] {
  const marks = [from];
  for (let t = from + step; t < to - 1e-9; t += step) marks.push(t);
  marks.push(to);
  const out: GraphicBox[] = [];
  for (let k = 0; k + 1 < marks.length; k++) {
    const ends = [boxAt(marks[k]), boxAt(marks[k + 1])].filter((b): b is Rect => b !== null);
    if (!ends.length) continue;
    const x = Math.min(...ends.map((b) => b.x)), y = Math.min(...ends.map((b) => b.y));
    const box = { x, y, w: Math.max(...ends.map((b) => b.x + b.w)) - x, h: Math.max(...ends.map((b) => b.y + b.h)) - y };
    const piece = { ...box, from: micro(timeOf(marks[k])), to: micro(timeOf(marks[k + 1])) };
    const last = out.at(-1);
    if (last && last.to === piece.from && last.x === box.x && last.y === box.y && last.w === box.w && last.h === box.h) last.to = piece.to;
    else out.push(piece);
  }
  return out;
}

/** A range's graphics on the cut: each one up while the range plays, placed as boxOnCut places a face. */
function rangeGraphics(range: RangeOnCut, cut: CutPicture): GraphicBox[] {
  const onCut = (t: number) => range.at + (t - range.start) * range.stretch;
  return (range.faces?.graphics ?? []).flatMap((g) => {
    const from = Math.max(g.from, range.start);
    const to = Math.min(g.to, range.end);
    return to > from ? graphicOnto(from, to, range.faces!.every, (sec) => boxOnCut(g, sec, range, cut), onCut) : [];
  });
}

/**
 * The faces of the cut as the faces command writes a clip's, or null when no range's source has any. Each range's
 * shots come from rangeShots; the last ends where the cut does. The margin text keeps from a face is the widest
 * any source asked for, and the rest of how the boxes were found is the first such source's.
 */
export function facesOnCut(ranges: RangeOnCut[], cut: CutPicture): FacesClip | null {
  const found = ranges.flatMap((r) => (r.faces ? [r.faces] : []));
  if (!found.length) return null;
  const shots = ranges.flatMap((r) => rangeShots(r, cut));
  shots[shots.length - 1].end = micro(Math.max(shots[shots.length - 1].end, cut.durationSec));
  const [first] = found;
  // Graphics only when every range's source was searched for them, since a list read back is trusted as complete.
  const searched = ranges.every((r) => Array.isArray(r.faces?.graphics));
  return {
    video: cut.video,
    name: basename(cut.video),
    width: cut.width,
    height: cut.height,
    fps: cut.fps,
    frameRate: cut.frameRate,
    durationSec: cut.durationSec,
    model: first.model,
    every: first.every,
    threshold: first.threshold,
    confidence: first.confidence,
    textMargin: Math.max(...found.map((c) => c.textMargin)),
    ...(searched ? { graphicsMargin: Math.max(...found.map((c) => c.graphicsMargin ?? 0)), graphics: ranges.flatMap((r) => rangeGraphics(r, cut)) } : {}),
    shots,
  };
}
