// Where the faces are in each shot of a clip, written for laying text out around them and for reframe.
//
//   openedit faces <video> [--out <dir>] [--every 0.25] [--threshold 10] [--confidence 0.5] [--margin 0.25]
//
// One decode finds the cuts (ffmpeg's scdet) and samples a frame every --every seconds, each labelled by
// its presentation time, so footage with a variable frame rate (most phone video) is sampled in time
// rather than by frame count. A shot that holds fewer than MIN_SAMPLES of them gets more, spread across
// it, from one more decode on the same timeline, never a seek, whose clock a container's start time would
// move: the more samples a shot has, the less one missed detection decides about it. MediaPipe's
// full-range BlazeFace finds the faces on each sample. The same decode hands the grid's frames, small and grey,
// to the search for graphics burned into the footage (faces/graphics.ts): part of this command so that one call
// and one place() keep text off both, at the cost of no second decode. faces.json holds the boxes and the
// graphics; faces.js holds them too, with the code that moves text out of them.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { numberFlag, parseUsage, usageLine, type Usage } from '../args.ts';
import { FFMPEG } from '../config.ts';
import { boxesOwner, facesFolder, sameFile } from '../faces/folder.ts';
import { analyseGraphics, GRAPHICS_MARGIN, workSize, type GraphicBox } from '../faces/graphics.ts';
import { MODEL, missingDetector, modelPath, runDetector, venvPython, type Spawn } from '../faces/mediapipe.ts';
import { facesApi, facesScript, type FaceBox, type FacesClip, type Sample, type Shot } from '../faces/page-script.ts';
import { readJsonFile } from '../json-file.ts';
import { probeFrameRate, probeSquareSize, probeVideoSpan } from '../probe.ts';
import { writeAtomic, writeTextAtomic } from '../providers/exclusive-files.ts';
import { resolveVideoArg } from '../resolve-video.ts';

// The detector sees a 192 px square whatever it is given, so a larger still only costs time to write.
const DETECT_SIDE = 640;

// A shot sampled fewer times than this also gets its first frame and the first at or past the middle of each
// quarter of it, those it has. Four a second by default: on a 60 s 1080p clip the whole command took 5.1 s
// against 3.6 s at one a second.
const MIN_SAMPLES = 4;

export const usage = {
  summary: 'Find the faces in each shot of a clip and write their boxes, for laying text out around them and for reframe',
  positionals: '<video>',
  flags: {
    out: { type: 'string', value: '<dir>', help: 'Where faces.json and faces.js are written (default runs/<key>/faces-<hash>/ of the workspace, a folder of the clip\'s own by its real path)' },
    every: { type: 'string', value: '<sec>', help: 'Seconds between sampled frames (default 0.25); a shot with fewer than 4 of them also gets its first frame and the first at or past the middle of each quarter of it' },
    threshold: { type: 'string', value: '<score>', help: 'Scene-change score that starts a new shot, above 0 and at most 100 on ffmpeg scdet\'s scale (default 10)' },
    confidence: { type: 'string', value: '<0-1>', help: 'Lowest detection score kept (default 0.5)' },
    margin: { type: 'string', value: '<fraction>', help: 'Kept clear of text around each face box on every side, as a fraction of its size (default 0.25)' },
    json: { type: 'boolean', help: 'Print faces.json instead of the summary' },
  },
  notes: [
    'Boxes are in the clip\'s display pixels (square), top-left origin, per sampled frame of each shot, at its',
    'presentation time in seconds. Load the faces.js whose path faces printed with a <script> tag, then',
    'openeditFaces.place(el, from, to) moves a laid-out element the least distance that keeps it clear of every',
    'face on screen between those seconds of the clip (the clip\'s own time, not the page\'s), where the <video>',
    'playing the clip draws it, else on the stage (options: {video, within, clip}; {video} picks one when several',
    'play it). It keeps the element off graphics burned into the footage too (a lower third, a score bar,',
    'subtitles, a logo: sharp edges that hold still while the rest of the picture moves, or that come and go in a',
    'still shot) for the seconds each is up. Needs MediaPipe: install-mediapipe.',
  ].join('\n'),
} satisfies Usage;

/**
 * What one named showinfo logged: its time base and each frame's pts in that base, in order. The integers,
 * not the printed seconds, which are rounded, so a cut's own frame never reads as just before the cut.
 */
export function parseShowinfo(log: string, name: string): { num: number; den: number; pts: number[] } {
  const base = new RegExp(`\\[showinfo@${name} @[^\\]]*\\] config in time_base: (\\d+)/(\\d+)`).exec(log);
  if (!base) throw new Error(`ffmpeg logged no time base for showinfo@${name}`);
  const pts = [...log.matchAll(new RegExp(`\\[showinfo@${name} @[^\\]]*\\] n:\\s*\\d+ pts:\\s*(-?\\d+)`, 'g'))].map((m) => Number(m[1]));
  return { num: Number(base[1]), den: Number(base[2]), pts };
}

/**
 * ffmpeg select: the first frame at or past each point of a grid every `every` seconds from half a step in,
 * judged by presentation time, so a variable frame rate cannot shift it.
 */
export function gridSelect(every: number): string {
  const off = every / 2;
  return `select='gte(t,${off})*(isnan(prev_t)+gt(floor((t-${off})/${every}),floor((prev_t-${off})/${every})))'`;
}

/** ffmpeg select terms: the first frame at or past this pts, or the very first frame for null. */
export const atPts = (pts: number | null): string => (pts === null ? 'isnan(prev_pts)' : `gte(pts,${pts})*(isnan(prev_pts)+lt(prev_pts,${pts}))`);

/** Which shot a frame is in: how many cuts (the pts of each shot's first frame) are at or before it. */
export const shotOf = (cuts: number[], pts: number): number => cuts.filter((c) => c <= pts).length;

/**
 * Boxes scaled, less `shift`, into a frame `width` by `height`, clamped to it, and dropped where none of a box is in it: how
 * faces takes detections on a still to the clip's display pixels, and reframe takes its source's boxes to its output's.
 */
export function toDisplay(faces: [number, number, number, number, number?][], scaleX: number, scaleY: number, width: number, height: number,
  shift = { x: 0, y: 0 }): FaceBox[] {
  return faces.map(([x, y, w, h, score]) => {
    const x0 = Math.max(0, x * scaleX - shift.x), y0 = Math.max(0, y * scaleY - shift.y);
    const x1 = Math.min(width, (x + w) * scaleX - shift.x), y1 = Math.min(height, (y + h) * scaleY - shift.y);
    return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0), score };
  }).filter((b) => b.w > 0 && b.h > 0);
}

const micro = (s: number) => Math.round(s * 1e6) / 1e6;

/** ffmpeg on `video` with these arguments, returning its log, or an error saying what it could not do and why. */
function ffmpegFor(spawn: Spawn, video: string): (args: string[], what: string) => string {
  return (args, what) => {
    const r = spawn(FFMPEG, ['-nostdin', '-hide_banner', '-nostats', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.error || r.status !== 0) {
      const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
      const why = code === 'ENOENT' ? `${FFMPEG} was not found` : code === 'ENOBUFS' ? 'its log outgrew the buffer'
        : r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
      const tail = String(r.stderr ?? '').trim().split('\n').slice(-3).join(' ');
      throw new Error(`ffmpeg could not ${what} ${video} (${why})${tail ? `: ${tail}` : ''}`);
    }
    return String(r.stderr);
  };
}

/** The grid's frames as faces/graphics.ts reads them: at its work size, grey, one byte a pixel. */
const greyFilter = (size: { width: number; height: number }) => `scale=${size.width}:${size.height},format=gray`;

/** The graphics burned into a clip's grid frames, read back from the raw file the decode wrote. */
function graphicsFrom(raw: string, grid: { num: number; den: number; pts: number[] }, size: { width: number; height: number },
  every: number, display: { width: number; height: number }, durationSec: number): GraphicBox[] {
  const bytes = existsSync(raw) ? statSync(raw).size : 0;
  if (bytes !== grid.pts.length * size.width * size.height) {
    throw new Error(`ffmpeg wrote ${bytes} bytes of grey frames for ${grid.pts.length} sampled frame(s) of ${size.width}x${size.height}`);
  }
  return analyseGraphics(raw, size, grid.pts.map((p) => micro((p * grid.num) / grid.den)), every, display, durationSec);
}

/** What graphics alone come to, for a reader that finds no faces.json holding them. */
export interface GraphicsOf { video: string; width: number; height: number; durationSec: number; every: number; graphics: GraphicBox[] }

/**
 * The graphics burned into a clip, on the same grid frames faces samples and from the same code, so a clip faces has
 * not run on gets the regions faces would have written for it. No MediaPipe, and no scene detection: one decode.
 */
export function findGraphics(videoArg: string, every = 0.25, spawn: Spawn = spawnSync): GraphicsOf {
  const video = resolveVideoArg(videoArg);
  if (!existsSync(video)) throw new Error(`video not found: ${video}`);
  const { width, height } = probeSquareSize(video);
  const span = probeVideoSpan(video);
  const size = workSize(width, height);
  const work = mkdtempSync(join(tmpdir(), 'open-edit-graphics-'));
  try {
    const raw = join(work, 'grey.raw');
    const log = ffmpegFor(spawn, video)(['-i', video, '-an', '-sn', '-dn', '-vf', `${gridSelect(every)},showinfo@grid,${greyFilter(size)}`,
      '-fps_mode', 'passthrough', '-f', 'rawvideo', raw], 'read');
    const graphics = graphicsFrom(raw, parseShowinfo(log, 'grid'), size, every, { width, height }, span.end);
    return { video, width, height, durationSec: span.end, every, graphics };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface FacesOptions { every: number; threshold: number; confidence: number; margin: number }
export interface FacesDeps { spawn?: Spawn; python?: string; model?: string }

export function findFaces(videoArg: string, o: FacesOptions, deps: FacesDeps = {}): FacesClip {
  const spawn = deps.spawn ?? spawnSync;
  const python = deps.python ?? venvPython();
  const model = deps.model ?? modelPath();
  const video = resolveVideoArg(videoArg);
  if (!existsSync(video)) throw new Error(`video not found: ${video}`);
  const missing = missingDetector(python, model);
  if (missing) {
    throw new Error(`${missing}. Face detection runs MediaPipe locally: ask the user, then run npx @veedstudio/openedit-cli install-mediapipe (several hundred MB).`);
  }
  const { width, height } = probeSquareSize(video);
  const rate = probeFrameRate(video);
  const span = probeVideoSpan(video);
  const k = Math.min(1, DETECT_SIDE / Math.max(width, height));
  // Scaled to the shown shape, so anamorphic footage is measured in square pixels like everything else.
  const scale = `scale=${Math.max(2, Math.round((width * k) / 2) * 2)}:${Math.max(2, Math.round((height * k) / 2) * 2)}`;
  const ffmpeg = ffmpegFor(spawn, video);
  const work = mkdtempSync(join(tmpdir(), 'open-edit-faces-'));
  const name = (prefix: string, i: number) => `${prefix}${String(i).padStart(7, '0')}.png`;
  // Each still's frame, by its pts.
  const stills = new Map<string, number>();

  try {
    const grey = workSize(width, height);
    const raw = join(work, 'grey.raw');
    // The grid's frames go both ways from one split, so the grey ones are the very frames findGraphics reads.
    const log = ffmpeg(['-i', video, '-an', '-sn', '-dn', '-filter_complex',
      `[0:v]split=2[a][b];[a]scdet=threshold=${o.threshold},metadata=mode=select:key=lavfi.scd.time,showinfo@cuts,nullsink;` +
        `[b]${gridSelect(o.every)},showinfo@grid,split=2[c][g];[c]${scale}[s];[g]${greyFilter(grey)}[r]`,
      '-map', '[s]', '-fps_mode', 'passthrough', '-start_number', '0', join(work, 'c%07d.png'),
      '-map', '[r]', '-fps_mode', 'passthrough', '-f', 'rawvideo', raw], 'read');
    const grid = parseShowinfo(log, 'grid');
    const graphics = graphicsFrom(raw, grid, grey, o.every, { width, height }, span.end);
    rmSync(raw, { force: true });
    const { num, den } = grid;
    const sec = (pts: number) => (pts * num) / den;
    grid.pts.forEach((p, i) => stills.set(name('c', i), p));
    const cuts = [...new Set(parseShowinfo(log, 'cuts').pts)].sort((x, y) => x - y);
    // Shot k runs from bounds[k] to bounds[k + 1]: the cuts between, the video's last moment at the end, and 0 at
    // the start even when the picture starts later, since a player shows its first frame until then.
    const bounds = [0, ...cuts.map(sec), span.end];
    const shots = cuts.length + 1;
    const count = (k: number) => [...stills.values()].filter((p) => shotOf(cuts, p) === k).length;
    const thin = Array.from({ length: shots }, (_, k) => k).filter((k) => count(k) < MIN_SAMPLES);
    // Per thin shot: its first frame and the frame at or past the middle of each of MIN_SAMPLES equal parts.
    const targets = (k: number) => [k === 0 ? null : cuts[k - 1], ...Array.from({ length: MIN_SAMPLES }, (_, j) =>
      Math.ceil(((bounds[k] + ((j + 0.5) * (bounds[k + 1] - bounds[k])) / MIN_SAMPLES) * den) / num))];
    // A few dozen select terms per decode: a very long expression is where ffmpeg starts to fail.
    const per = Math.floor(40 / (MIN_SAMPLES + 1));
    let next = 0;
    for (let i = 0; i < thin.length; i += per) {
      const chunk = thin.slice(i, i + per);
      const select = `select='${chunk.flatMap((k) => targets(k).map(atPts)).join('+')}'`;
      const shown = parseShowinfo(ffmpeg(['-i', video, '-an', '-sn', '-dn', '-vf', `${select},showinfo@more,${scale}`,
        '-fps_mode', 'passthrough', '-start_number', String(next), join(work, 'm%07d.png')], 'sample the short shots of'), 'more');
      const have = new Set(stills.values());
      shown.pts.forEach((p, j) => {
        const file = name('m', next + j);
        // A frame of a shot this decode was not asked about, or one the grid already sampled, is not kept.
        if (chunk.includes(shotOf(cuts, p)) && !have.has(p)) { stills.set(file, p); have.add(p); } else rmSync(join(work, file), { force: true });
      });
      next += shown.pts.length;
    }
    // A shot with no sample would read as a shot with no face, and text would be laid over whoever is in it.
    const empty = Array.from({ length: shots }, (_, k) => k).filter((k) => count(k) === 0);
    if (empty.length) {
      throw new Error(`no frame could be read from ${empty.map((k) => `${bounds[k].toFixed(3)}-${bounds[k + 1].toFixed(3)} s`).join(', ')} ` +
        `of ${video}, so the faces there are unknown`);
    }

    const run = runDetector({ folder: work, confidence: o.confidence, python, model }, spawn);
    const samples = run.images.filter((img) => stills.has(img.file)).map((img) => ({
      pts: stills.get(img.file)!,
      sample: { sec: micro(sec(stills.get(img.file)!)), faces: toDisplay(img.faces, width / img.width, height / img.height, width, height) } as Sample,
    })).sort((x, y) => x.pts - y.pts);
    return {
      video,
      name: basename(video),
      width,
      height,
      fps: rate.fps,
      frameRate: rate.rate.replace(/\/1$/, ''),
      durationSec: span.end,
      model: MODEL.file.replace(/\.tflite$/, ''),
      every: o.every,
      threshold: o.threshold,
      confidence: o.confidence,
      textMargin: o.margin,
      graphicsMargin: GRAPHICS_MARGIN,
      graphics,
      shots: Array.from({ length: shots }, (_, k): Shot => ({
        start: micro(bounds[k]),
        end: micro(bounds[k + 1]),
        samples: samples.filter((x) => shotOf(cuts, x.pts) === k).map((x) => x.sample),
      })),
      detector: { readyMs: run.readyMs, frames: run.images.length, totalMs: Math.round(run.images.reduce((sum, i) => sum + i.ms, 0)) },
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const isNum = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);

/** faces.json at `path`, or an error naming the file and what is wrong with it, so no reader trips on a field deep inside. */
export function readFaces(path: string): FacesClip {
  const clip = readJsonFile(path) as Partial<FacesClip> | null;
  const problem = !clip || typeof clip !== 'object' ? 'not an object'
    : typeof clip.video !== 'string' ? 'no video path'
    : !isNum(clip.width) || !isNum(clip.height) || !isNum(clip.durationSec) ? 'no width, height or durationSec'
    : !Array.isArray(clip.shots) ? 'no shots'
    : clip.shots.some((s) => !isNum(s?.start) || !isNum(s?.end)) ? 'a shot without its start or end'
    : clip.shots.some((s) => !Array.isArray(s?.samples) || s.samples.some((x) => !isNum(x?.sec) || !Array.isArray(x.faces)
      || x.faces.some((f) => ![f?.x, f?.y, f?.w, f?.h].every(isNum)))) ? 'a sample without its time or face boxes'
    : clip.graphics !== undefined && (!Array.isArray(clip.graphics) || clip.graphics.some((g) => ![g?.x, g?.y, g?.w, g?.h, g?.from, g?.to].every(isNum)))
      ? 'a graphic without its box or its times'
    : null;
  if (problem) throw new Error(`${path} is not a faces.json the faces command wrote (${problem})`);
  return clip as FacesClip;
}

/** Whether boxes found on a clip of `found`'s size and length fit a clip of this size and length. */
export const measuredAs = (found: { width: number; height: number; durationSec: number }, size: { width: number; height: number }, durationSec: number): boolean =>
  found.width === size.width && found.height === size.height && Math.abs(found.durationSec - durationSec) <= 0.05;

/**
 * Why `clip` does not hold the faces of `video` as it is now, or null when it does. Boxes found on another file,
 * or on this one before it was cut or replaced, would be read as this clip's faces: the file, the size (square
 * display pixels) and the length (probeVideoSpan's end) must all be this clip's.
 */
export function notFacesOf(clip: FacesClip, video: string, size: { width: number; height: number }, durationSec: number): string | null {
  if (sameFile(clip.video, video) && measuredAs(clip, size, durationSec)) return null;
  return `holds the faces of ${clip.video} (${clip.width}x${clip.height}, ${clip.durationSec.toFixed(3)} s), not of ` +
    `${video} (${size.width}x${size.height}, ${durationSec.toFixed(3)} s)`;
}

/** Why faces.json at `path` must not be overwritten for `video`, or null when it may be. */
export function otherClipAt(path: string, video: string): string | null {
  const held = boxesOwner(path);
  return held && !sameFile(held, video) ? `${path} holds the faces of ${held}, another clip: pass another --out <dir>, or leave --out out` : null;
}

export function faces(argv: string[]): number {
  const { values, positionals } = parseUsage('faces', usage, argv);
  const [video] = positionals;
  if (!video) {
    console.error(usageLine('faces', usage));
    return 2;
  }
  const started = Date.now();
  const resolved = resolveVideoArg(video);
  if (!existsSync(resolved)) throw new Error(`video not found: ${resolved}`);
  const out = values.out ?? facesFolder(resolved);
  const clash = otherClipAt(join(out, 'faces.json'), resolved);
  if (clash) {
    console.error(`faces: ${clash}`);
    return 1;
  }
  const clip = findFaces(video, {
    every: numberFlag('every', values.every, 0.25, (n) => n > 0, 'seconds above 0'),
    threshold: numberFlag('threshold', values.threshold, 10, (n) => n > 0 && n <= 100, 'a score above 0 and at most 100'),
    confidence: numberFlag('confidence', values.confidence, 0.5, (n) => n > 0 && n < 1, 'a score between 0 and 1'),
    margin: numberFlag('margin', values.margin, 0.25, (n) => n >= 0, 'a fraction of the box, 0 or more'),
  });
  // The folder is made only now, so a run that fails leaves none behind.
  writeAtomic(join(out, 'faces.json'), clip);
  writeTextAtomic(join(out, 'faces.js'), facesScript(clip));
  if (values.json) {
    console.log(JSON.stringify(clip, null, 2));
    console.error(`faces: wrote ${join(out, 'faces.json')} and ${join(out, 'faces.js')}`);
    return 0;
  }

  const api = facesApi(clip);
  const found = clip.shots.reduce((sum, s) => sum + s.samples.filter((x) => x.faces.length).length, 0);
  console.log(`faces: ${clip.shots.length} shot(s) of ${clip.name} (${clip.width}x${clip.height}, ${clip.durationSec.toFixed(3)}s), ` +
    `${clip.detector!.frames} sampled frame(s), faces on ${found}`);
  for (const shot of clip.shots) {
    const boxes = api.boxes(shot.start, shot.end);
    const list = boxes.map((b) => `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)}`).join('; ');
    console.log(`  ${shot.start.toFixed(3)}–${shot.end.toFixed(3)}s  ${shot.samples.length} sample(s)  ${boxes.length ? `keep text clear of: ${list}` : 'no face'}`);
  }
  const graphics = clip.graphics ?? [];
  console.log(`  graphics burned into the footage: ${graphics.length ? `${graphics.length}, kept clear like the faces` : 'none found'}`);
  for (const g of graphics.slice(0, 12)) console.log(`    ${g.from.toFixed(3)}–${g.to.toFixed(3)}s  ${g.x},${g.y} ${g.w}x${g.h}`);
  if (graphics.length > 12) console.log(`    and ${graphics.length - 12} more in faces.json`);
  const d = clip.detector!;
  console.log(`  detector: model loaded in ${Math.round(d.readyMs)} ms, ${d.frames} frame(s) in ${d.totalMs} ms` +
    `${d.frames ? ` (${(d.totalMs / d.frames).toFixed(1)} ms each)` : ''}; whole command ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log(`  wrote ${join(out, 'faces.json')} and ${join(out, 'faces.js')}`);
  return 0;
}
