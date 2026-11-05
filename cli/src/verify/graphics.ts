// The graphics check: page text drawn over a graphic burned into the footage (a lower third, a score bar, old
// subtitles, a logo) while that graphic is up. The text comes from the render's record, and so does the footage: the
// clip render --footage laid under the page, which fills the frame frame for frame, and each <video> of the page with
// the second of its clip it shows and where its picture lies. The graphics are the ones faces wrote for a clip, or,
// when faces has not run on it, the same search run here. A page may cover the footage there (a card, an opaque band
// laid over old subtitles): a text whose backing the record measures as mostly opaque is not over the footage, and any
// other collision is confirmed on the pixels, where the video must still show the clip's picture around the text, as it
// is in the clip and at enough of its strength.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { findGraphics, notFacesOf, readFaces } from '../commands/faces.ts';
import { FFMPEG } from '../config.ts';
import { ownFaces } from '../faces/folder.ts';
import { workSize, type GraphicBox } from '../faces/graphics.ts';
import { probeSquareSize, probeVideoSpan } from '../probe.ts';
import { recordSeconds, sampleSeconds, timeOf, type TextRecord, type TextSample } from '../render/text-record.ts';
import type { CheckReport, Found, ReviewContext, TextRecordInput } from './checks.ts';
import { fromTo, listed, quoted, skippedFor } from './report.ts';
import { MIN_SECONDS } from './text.ts';

/** A clip's graphics, where they came from, and the size of the picture they are measured in. */
export interface FootageGraphics {
  graphics: GraphicBox[];
  /** The faces.json they were read from, or the clip they were just found on. */
  source: string;
  /** The clip's display size, which the boxes are in. */
  width: number;
  height: number;
  /** Seconds from the clip's start to its first frame: what turns a second counted from the first frame into the boxes' time. */
  offset: number;
}

type Find = (video: string) => { graphics: GraphicBox[] };

/** The graphics of `footage`: from its faces.json when that holds them for this very file, else found now. */
export function footageGraphics(footage: string, find: Find = findGraphics): FootageGraphics {
  const size = probeSquareSize(footage);
  const span = probeVideoSpan(footage);
  const base = { width: size.width, height: size.height, offset: span.start };
  const saved = ownFaces(footage);
  if (saved) {
    try {
      const clip = readFaces(saved);
      if (clip.graphics && !notFacesOf(clip, footage, size, span.end)) return { ...base, graphics: clip.graphics, source: saved };
    } catch {
      // A faces.json that cannot be read is no answer; the search below is.
    }
  }
  return { ...base, graphics: find(footage).graphics, source: `${footage}, searched now` };
}

type Box = [number, number, number, number];
const overlaps = (a: Box, b: Box) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
const meet = (a: Box, b: Box): Box | null => {
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - x;
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - y;
  return w > 0 && h > 0 ? [x, y, w, h] : null;
};

/** A clip on screen at one sampled frame: its second, counted from its first frame, and where its picture is laid. */
interface Picture { file: string; time: number; box: Box; shown: Box }

/**
 * Every clip the frame shows: the footage under the page, filling the frame from the frame it starts on, then each
 * <video> of the page.
 */
function picturesOf(record: TextRecord, sample: TextSample): Picture[] {
  const frame: Box = [0, 0, record.width, record.height];
  const { footage } = record;
  const under = footage && sample.frame >= footage.frame
    ? [{ file: footage.file, time: timeOf(record, sample.frame) - footage.time, box: frame, shown: frame }] : [];
  return [...under, ...(sample.videos ?? [])];
}

/** A graphic as the video shows it at one frame: where it lies there, and through which picture. */
interface Shown { graphic: GraphicBox; at: Box; picture: Picture }

interface Stretch { key: string; group: string; text: string; first: number; last: number; graphic: GraphicBox; backing: number }

/** The element a text's own element belongs to: a caption's word spans are children of one, on one backing. */
const groupOf = (selector: string): string => selector.slice(0, Math.max(0, selector.lastIndexOf('>'))) || selector;

// Around the glyphs, this many ems are the text's own (a stroke, a shadow, a backing) rather than what is behind it;
// out to NEAR_EM is what the text is seen against.
const AROUND_EM = 0.5;
const NEAR_EM = 1.5;
// The graphic's place is compared in blocks of this many pixels a side at the work size, each by how the video's pixels
// follow the clip's: a vignette, a grade or a tint over the footage keeps it, a card or a band over it takes it away.
const BLOCK = 8;
// A block of the clip flatter than this standard deviation (grey levels) says nothing either way.
const TEXTURED = 4;
// A layer the page draws at least this opaque covers the footage: a text backed that much is not over it, and on the
// pixels, a block shows the clip when its correlation reaches MATCH and the video carries more than what such a layer lets
// through of the clip's contrast there, however well that lines up. The picture shows when SHOWN of the textured blocks do.
const COVERS = 0.75;
const MATCH = 0.6;
const SHOWN = 0.3;
// Fewer textured blocks than this cannot say whether the picture shows.
const MIN_BLOCKS = 3;
// Frames read per decode: a very long select expression is where ffmpeg starts to fail.
const PER_DECODE = 40;
// A clip's picture at a second is the last frame at or before it, looked for this far back.
const LOOK_BACK_SEC = 1;

const run = promisify(execFile);

/** ffmpeg's raw grey frames on stdout, or an error naming what could not be read. */
async function ffmpegRaw(args: string[], bytes: number, what: string): Promise<Buffer> {
  try {
    const { stdout } = await run(FFMPEG, ['-nostdin', '-v', 'error', ...args, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'],
      { encoding: 'buffer', maxBuffer: bytes + (1 << 20) });
    return stdout;
  } catch (error) {
    const said = String((error as { stderr?: Buffer }).stderr ?? '').trim().split('\n').pop();
    throw new Error(`ffmpeg could not read ${what}${said ? `: ${said}` : ''}`);
  }
}

/** Frames `frames` (by index from the first) of `file`, grey at `size`, by index. */
async function greyFrames(file: string, frames: number[], size: { width: number; height: number }): Promise<Map<number, Uint8Array>> {
  const out = new Map<number, Uint8Array>();
  const bytes = size.width * size.height;
  for (let i = 0; i < frames.length; i += PER_DECODE) {
    const chunk = frames.slice(i, i + PER_DECODE);
    const stdout = await ffmpegRaw(['-i', file, '-map', '0:v:0', '-an', '-vf',
      `select='${chunk.map((n) => `eq(n,${n})`).join('+')}',scale=${size.width}:${size.height},format=gray`], bytes * chunk.length, `frames of ${file}`);
    chunk.forEach((n, j) => {
      if ((j + 1) * bytes <= stdout.length) out.set(n, new Uint8Array(stdout.subarray(j * bytes, (j + 1) * bytes)));
    });
  }
  return out;
}

/**
 * The picture the video shows of `p`, grey at the work size `size` (`scale` of the video's pixels) and laid where the
 * page lays it, with 1 in `mask` where it is drawn; null when the clip has no frame at that second.
 */
async function clipPicture(p: Picture, size: { width: number; height: number }, scale: number): Promise<{ grey: Uint8Array; mask: Uint8Array } | null> {
  const w = Math.max(1, Math.round(p.box[2] * scale));
  const h = Math.max(1, Math.round(p.box[3] * scale));
  const from = Math.max(0, p.time - LOOK_BACK_SEC);
  // Half a millisecond of slack: the renderer seeks a video a hair past its frame's own time.
  const stdout = await ffmpegRaw(['-ss', from.toFixed(6), '-i', p.file, '-map', '0:v:0', '-an', '-vf',
    `select='lte(t,${(p.time - from + 0.0005).toFixed(6)})',scale=${w}:${h},format=gray`], 256 * w * h, `${p.file} at ${p.time.toFixed(3)} s`);
  const frames = Math.floor(stdout.length / (w * h));
  if (!frames) return null;
  const last = stdout.subarray((frames - 1) * w * h, frames * w * h);
  const grey = new Uint8Array(size.width * size.height);
  const mask = new Uint8Array(size.width * size.height);
  const left = Math.round(p.box[0] * scale);
  const top = Math.round(p.box[1] * scale);
  const [x0, y0, x1, y1] = [p.shown[0], p.shown[1], p.shown[0] + p.shown[2], p.shown[1] + p.shown[3]].map((v) => Math.round(v * scale));
  for (let y = Math.max(0, y0, top); y < Math.min(size.height, y1, top + h); y++) {
    for (let x = Math.max(0, x0, left); x < Math.min(size.width, x1, left + w); x++) {
      grey[y * size.width + x] = last[(y - top) * w + (x - left)];
      mask[y * size.width + x] = 1;
    }
  }
  return { grey, mask };
}

/**
 * Whether one frame of the video shows the clip's picture in `box`, near the texts that overlap it and away from their
 * glyphs; null when too little is left there to tell. Boxes are in the video's pixels.
 */
function shows(video: Uint8Array | undefined, clip: { grey: Uint8Array; mask: Uint8Array } | null, size: { width: number; height: number },
  scale: number, box: Box, texts: { box: Box; fontSize: number }[]): boolean | null {
  if (!video || !clip) return null;
  const padded = (em: number) => ({ box: b, fontSize }: { box: Box; fontSize: number }) => {
    const pad = em * fontSize;
    return [(b[0] - pad) * scale, (b[1] - pad) * scale, (b[0] + b[2] + pad) * scale, (b[1] + b[3] + pad) * scale];
  };
  const away = texts.map(padded(AROUND_EM));
  const near = texts.filter((t) => overlaps(t.box, box)).map(padded(NEAR_EM));
  const meets = (a: number[], x: number, y: number) => x + BLOCK > a[0] && x < a[2] && y + BLOCK > a[1] && y < a[3];
  const [x0, y0, x1, y1] = [box[0] * scale, box[1] * scale, (box[0] + box[2]) * scale, (box[1] + box[3]) * scale];
  let textured = 0;
  let matched = 0;
  for (let by = Math.max(0, Math.floor(y0)); by + BLOCK <= Math.min(size.height, Math.ceil(y1)); by += BLOCK) {
    for (let bx = Math.max(0, Math.floor(x0)); bx + BLOCK <= Math.min(size.width, Math.ceil(x1)); bx += BLOCK) {
      if (!near.some((a) => meets(a, bx, by)) || away.some((a) => meets(a, bx, by))) continue;
      let sv = 0, sc = 0, svv = 0, scc = 0, svc = 0, drawn = 0;
      for (let y = by; y < by + BLOCK; y++) {
        for (let x = bx, p = y * size.width + bx; x < bx + BLOCK; x++, p++) {
          const v = video[p];
          const c = clip.grey[p];
          drawn += clip.mask[p];
          sv += v; sc += c; svv += v * v; scc += c * c; svc += v * c;
        }
      }
      const n = BLOCK * BLOCK;
      if (drawn < n) continue;
      const varC = scc / n - (sc / n) ** 2;
      if (varC < TEXTURED * TEXTURED) continue;
      textured++;
      const varV = svv / n - (sv / n) ** 2;
      const cov = svc / n - (sv / n) * (sc / n);
      if (varV > 0 && cov / Math.sqrt(varV * varC) >= MATCH && cov / varC > 1 - COVERS) matched++;
    }
  }
  return textured < MIN_BLOCKS ? null : matched >= SHOWN * textured;
}

type Clips = Map<string, FootageGraphics | { missing: string }>;

/** The graphics up in each clip the frame shows, where the video shows them. */
function shownAt(record: TextRecord, sample: TextSample, clips: Clips): Shown[] {
  return picturesOf(record, sample).flatMap((picture) => {
    const found = clips.get(picture.file);
    if (!found || 'missing' in found) return [];
    const t = picture.time + found.offset;
    const sx = picture.box[2] / found.width;
    const sy = picture.box[3] / found.height;
    return found.graphics.filter((g) => g.from <= t && t <= g.to).flatMap((graphic) => {
      const at = meet([picture.box[0] + graphic.x * sx, picture.box[1] + graphic.y * sy, graphic.w * sx, graphic.h * sy], picture.shown);
      return at ? [{ graphic, at, picture }] : [];
    });
  });
}

/**
 * Each stretch of consecutive samples in which one text overlaps a graphic that is up where the video shows it, kept
 * when the video shows the clip's picture there (or too little of it is left around the texts to tell).
 */
export async function judgeGraphics(record: TextRecord, clips: Clips, video: string): Promise<CheckReport> {
  const step = sampleSeconds(record);
  const end = recordSeconds(record);
  const keyOf = (e: { selector: string; text: string }) => `${e.selector}\u0000${e.text}`;
  // Each text's first and last sample on screen.
  const shown = new Map<string, [number, number]>();
  const open = new Map<string, Stretch>();
  const done: Stretch[] = [];
  record.samples.forEach((sample, k) => {
    const up = shownAt(record, sample, clips);
    for (const entry of sample.texts) {
      const key = keyOf(entry);
      const span = shown.get(key);
      if (span) span[1] = k;
      else shown.set(key, [k, k]);
      const hit = up.find((g) => overlaps(entry.box, g.at));
      if (!hit) continue;
      const s = open.get(key);
      const backing = entry.backing ?? 0;
      if (s && s.last === k - 1 && s.graphic === hit.graphic) {
        s.last = k;
        s.backing = Math.min(s.backing, backing);
        continue;
      }
      if (s) done.push(s);
      open.set(key, { key, group: groupOf(entry.selector), text: entry.text, first: k, last: k, graphic: hit.graphic, backing });
    }
  });
  done.push(...open.values());
  // A text that overlaps on every sample it is on screen is reported however short; a stretch of one that stays longer
  // must last MIN_SECONDS, or it is a passing moment rather than a text shown over the graphic.
  const long = done.filter((s) => {
    const [first, last] = shown.get(s.key)!;
    return (first === s.first && last === s.last) || (s.last - s.first + 1) * step >= MIN_SECONDS - 1e-9;
  });
  // A text on a card or band the page paints all the while it is over the graphic is not over the footage.
  let covered = long.filter((s) => s.backing >= COVERS).length;

  // One look per graphic per element per stretch of time its texts cover it, at the middle of that stretch: a caption's
  // words change on one backing, while another element may sit on a card of its own.
  const looks: { graphic: GraphicBox; group: string; first: number; last: number; stretches: Stretch[] }[] = [];
  for (const s of long.filter((x) => x.backing < COVERS).sort((a, b) => a.first - b.first)) {
    const joined = looks.find((l) => l.graphic === s.graphic && l.group === s.group && s.first <= l.last + 1);
    if (joined) {
      joined.last = Math.max(joined.last, s.last);
      joined.stretches.push(s);
    } else looks.push({ graphic: s.graphic, group: s.group, first: s.first, last: s.last, stretches: [s] });
  }
  const size = workSize(record.width, record.height);
  const scale = size.width / record.width;
  const middle = (l: { first: number; last: number }) => record.samples[(l.first + l.last) >> 1];
  const inVideo = await greyFrames(video, [...new Set(looks.map((l) => middle(l).frame))].sort((a, b) => a - b), size);
  const reported: { stretch: Stretch; at: Box }[] = [];
  for (const l of looks) {
    const sample = middle(l);
    const there = shownAt(record, sample, clips).find((g) => g.graphic === l.graphic);
    const seen = there
      ? shows(inVideo.get(sample.frame), await clipPicture(there.picture, size, scale), size, scale, there.at, sample.texts)
      : null;
    if (seen === false) {
      covered += l.stretches.length;
      continue;
    }
    for (const stretch of l.stretches) {
      const first = shownAt(record, record.samples[stretch.first], clips).find((g) => g.graphic === stretch.graphic)!;
      reported.push({ stretch, at: (there ?? first).at });
    }
  }

  const found = [...clips.values()].filter((c): c is FootageGraphics => !('missing' in c));
  const count = found.reduce((n, c) => n + c.graphics.length, 0);
  const sources = found.map((c) => c.source).join('; ');
  const skipped = [
    ...[...clips.values()].flatMap((c) => ('missing' in c ? [c.missing] : [])),
    ...(covered ? [`${covered} text(s) over a graphic's place where the page covers the footage, so the graphic does not show`] : []),
  ];
  if (reported.length) {
    const place = (b: Box) => `${Math.round(b[0])},${Math.round(b[1])} ${Math.round(b[2])}x${Math.round(b[3])}`;
    const span = (s: Stretch) => fromTo(timeOf(record, record.samples[s.first].frame), Math.min(end, timeOf(record, record.samples[s.last].frame) + step));
    return {
      verdict: 'found',
      lines: [
        `${reported.length} time(s) a text sits over a graphic burned into the footage while it is up (${count} found, from ${sources}):`,
        ...listed(reported.map(({ stretch, at }) => ({ start: stretch.first, line: `${quoted(stretch.text)} over the graphic at ${place(at)} ${span(stretch)}` }))),
      ],
      skipped,
    };
  }
  return {
    verdict: 'pass',
    lines: [count
      ? `no text over a graphic burned into the footage (${count} found, from ${sources}): ${shown.size} text(s) over ${record.samples.length} sampled frames`
      : `no graphic burned into the footage (searched in ${sources}), so no text over one`],
    skipped,
  };
}

/** The check on a record that is there: skipped when it names no footage and the page shows no <video>, or none is on disk. */
export async function judgeFootage(video: string, { path, record }: Found<TextRecordInput>, find?: Find): Promise<CheckReport> {
  const files = [...new Set([...(record.footage ? [record.footage.file] : []), ...record.samples.flatMap((s) => (s.videos ?? []).map((v) => v.file))])];
  if (!files.length) return skippedFor(`the text over the footage's graphics: ${path} names no footage and records no <video> on the page`);
  const clips: Clips = new Map(files.map((file) => [file, existsSync(file) ? footageGraphics(file, find) : { missing: `the footage ${file} is no longer there` }]));
  const missing = [...clips.values()].flatMap((c) => ('missing' in c ? [c.missing] : []));
  if (missing.length === clips.size) return skippedFor(...missing.map((m) => `the text over the footage's graphics: ${m}`));
  return judgeGraphics(record, clips, video);
}

export async function measureGraphics({ video, textRecord }: ReviewContext): Promise<CheckReport> {
  if ('missing' in textRecord) return skippedFor(`the text over the footage's graphics: ${textRecord.missing}`);
  return judgeFootage(video, textRecord);
}
