// Where the faces are in each shot of a clip, written for laying text out around them and for reframe.
//
//   openedit faces <video> [--out <dir>] [--every 0.25] [--threshold 10] [--confidence 0.5] [--margin 0.25] [--speakers <file>] [--local]
//
// One decode finds the cuts (from ffmpeg scdet's difference between each frame and the one before) and samples a
// frame every --every seconds, each labelled by its presentation time, so footage with a variable frame rate (most
// phone video) is sampled in time rather than by frame count. A shot that holds fewer than MIN_SAMPLES of them gets more, spread across
// it, from one more decode on the same timeline, never a seek, whose clock a container's start time would
// move: the more samples a shot has, the less one missed detection decides about it. MediaPipe's
// full-range BlazeFace finds the faces on each sample. The same decode hands the grid's frames, small and grey,
// to the search for graphics burned into the footage (faces/graphics.ts): part of this command so that one call
// and one place() keep text off both, at the cost of no second decode. faces.json holds the boxes and the
// graphics; faces.js holds them too, with the code that moves text out of them.
//
// With --speakers the shots and the boxes come from a speakers file made for the clip (faces/speakers.ts), on the
// same grid of sampled frames: no scene detection, no stills and no MediaPipe, and the graphics from the same grey
// frames as ever. Where the environment names a hosted analysis that makes such a file (faces/analysis.ts), faces
// runs it on the clip, keeps its file beside faces.json and maps that; a clip it does not take, a refusal or a
// failure leaves the clip to MediaPipe, and --local never calls it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { numberFlag, parseUsage, usageLine, type Usage } from '../args.ts';
import { FFMPEG, runsDir } from '../config.ts';
import { ANALYSIS_ENV, AnalysisFailed, analysisNamed, runAnalysis, sendable, WAIT_MS, whyNotSent } from '../faces/analysis.ts';
import { boxesOwner, facesFolder, sameFile } from '../faces/folder.ts';
import { analyseGraphics, GRAPHICS_MARGIN, workSize, type GraphicBox } from '../faces/graphics.ts';
import { MODEL, missingDetector, modelPath, runDetector, venvPython, type Spawn } from '../faces/mediapipe.ts';
import { facesApi, facesScript, NEAR, SAME_CLIP_SEC, toDisplay, type FacesClip, type Sample, type Shot } from '../faces/page-script.ts';
import {
  facesAt, notSpeakersOf, pastMapping, readSpeakers, shotBounds, showRuns, SPEAKERS_BYTES, SPEAKERS_MODEL, SpeakersRefused, SpeakersUnread,
} from '../faces/speakers.ts';
import { isNum, readJsonFile } from '../json-file.ts';
import { printable } from '../printable.ts';
import { containerDurationOf, probeFrameRate, probeSquareSize, probeVideoSpan } from '../probe.ts';
import { errorText } from '../proxy.ts';
import { writeAtomic, writeTextAtomic } from '../providers/exclusive-files.ts';
import { fileDigest } from '../providers/fal-storage.ts';
import { falRoute } from '../providers/fal-route.ts';
import { resolveVideoArg, runKeyOf } from '../resolve-video.ts';

// The detector sees a 192 px square whatever it is given, so a larger still only costs time to write.
const DETECT_SIDE = 640;

// A shot sampled fewer times than this also gets its first frame and the first at or past the middle of each
// quarter of it, those it has. Four a second by default: on a 60 s 1080p clip the whole command took 5.1 s
// against 3.6 s at one a second.
const MIN_SAMPLES = 4;

// A cut between two shots of one set changes the picture less than scdet's threshold asks (6 to 9 between a podcast's
// close-ups), but all in one frame, where motion, a fade or a phone's judder spread theirs over several (a graphic cut in
// over a still shot does not, and reads as a cut). On 16 clips with 33 cuts labelled by eye and a made flash, fade and whip
// pan, no other frame changing 1 or more stood over 2.2 times above every frame within four of it, the weakest such cut 6.9.
const SPIKE_RATIO = 3;
const SPIKE_SPAN = 4;
// Of the threshold, so --threshold still sets how readily a change starts a shot.
const SPIKE_FLOOR = 0.2;

export const usage = {
  summary: 'Find the faces in each shot of a clip and write their boxes, for laying text out around them and for reframe',
  positionals: '<video>',
  flags: {
    out: { type: 'string', value: '<dir>', help: 'Where faces.json and faces.js are written (default runs/<key>/faces-<hash>/ of the workspace, a folder of the clip\'s own by its real path)' },
    every: { type: 'string', value: '<sec>', help: 'Seconds between sampled frames (default 0.25); a shot with fewer than 4 of them also gets its first frame and the first at or past the middle of each quarter of it' },
    threshold: {
      type: 'string', value: '<score>',
      help: 'Scene-change score that starts a new shot, above 0 and at most 100 on ffmpeg scdet\'s scale (default 10); a frame that '
        + `changes ${SPIKE_FLOOR * 100}% of it or more, and ${SPIKE_RATIO} times as much as any frame within ${SPIKE_SPAN} of it, `
        + 'starts one too, as a cut between two shots of one set does',
    },
    confidence: { type: 'string', value: '<0-1>', help: 'Lowest detection score kept (default 0.5)' },
    margin: { type: 'string', value: '<fraction>', help: 'Kept clear of text around each face box on every side, as a fraction of its size (default 0.25)' },
    speakers: {
      type: 'string', value: '<file>',
      help: 'A speakers file made for this clip (its shots, a track per face with a box and whether it is speaking at each analysed '
        + 'frame, and whom to show): the shots and the boxes are taken from it, sampled as ever, so MediaPipe is not run and need '
        + 'not be installed, and --threshold and --confidence, which steer what it replaces, are refused. A convenience for a '
        + 'clip that comes with one; without it faces finds the shots and the faces itself',
    },
    local: {
      type: 'boolean',
      help: `Find the shots and the faces on this machine, with MediaPipe, also where the environment names a hosted analysis for them (${ANALYSIS_ENV})`,
    },
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
    'still shot) for the seconds each is up. openeditFaces.placer(spans, measure, options) is for elements shown one',
    'after another in one spot, such as caption cues: spans are their {from, to} seconds of the clip, in time order and',
    'not overlapping, and measure(i) lays element i out alone, unmoved, and gives its box {x, y, w, h} in viewport pixels',
    '(a DOMRect will do). It returns {prepare(i), place(el, i, sec), part(i, sec), check(el, i, sec)}. Run prepare(i)',
    'while none of the elements is on screen, before showing element i: measure is called then, for elements not on',
    'screen; a page that never calls prepare still works, with place() measuring each time. Unlike place(el, from, to),',
    "which clears one element over its own span, its place takes an element's index and one second of the clip and puts",
    'it where the elements are then: one place through each shot, moving only at a cut, or where no single place stays',
    'clear for every element up in the shot, however briefly. Place an element again whenever part(i, sec) changes, as',
    'it does at each cut the element is up across; check(el, i, sec), called as an element is drawn, says when it is',
    'drawn larger than it was measured and meets a face. Needs MediaPipe (install-mediapipe), except where the shots and',
    'the faces come from a speakers file: one named with --speakers, or the one a hosted analysis answers with.',
    'From a speakers file each face box also carries its track (an id of its own shot and no other) and whether it is',
    'speaking around that sample, and each shot the runs of whom the file would show, as {start, end, tracks}: in',
    'faces.json, and in the clip faces.js holds under openeditFaces.clips.',
    '',
    `Where the environment names a hosted analysis that makes a speakers file (${ANALYSIS_ENV}, a fal model), faces`,
    'runs it on the clip unless --speakers, --local, --threshold or --confidence is given, and says so in one line',
    'before it does: it is one generation on the fal account of the fal key this run reads, bought as fal run buys one',
    'and never on a VEED workspace, else through the fal command the environment gives in place of a key, which prices',
    'and approves it and bills as that environment arranges. The file it answers with is kept beside',
    'faces.json as speakers-<id>.json, named for the clip\'s bytes and the analysis, and a later faces reads it instead',
    'of running the analysis again while both are the same. A clip with no sound, longer than 10 minutes or larger than',
    '4 GB is not sent; that, no fal to run it on, a refusal, a failure or an answer that does not map onto the clip is',
    'said in one line, and the shots and the faces are then found with MediaPipe. On either route the answer is waited',
    `for up to ${WAIT_MS / 60_000} minutes, and the environment\'s fal command is stopped then, with whatever it started, as it is when`,
    'faces is stopped; a request it had queued may still run and be billed, nothing of that run is kept, and the next',
    'run asks again. The command\'s own lines are shown as it prints them, and its answer is the plain files it leaves',
    `in a folder made for that run. A speakers file over ${SPEAKERS_BYTES >> 20} MB is not read, from --speakers or from the analysis.`,
    'Measured on eight calls, on clips of 20 s to 9.5 minutes and 6 to 110 MB: the analysis ran for 0.38',
    'to 0.67 of the clip\'s length, the upload and the rest of the call took 10 to 163 s on one connection, and the',
    'request waited 83 and 87 s in the queue the two times the analysis had to start first.',
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

/** One frame after scdet: its pts, its difference from the frame before (0-100), and whether scdet's own score reached the threshold. */
export interface SceneFrame { pts: number; mafd: number; cut: boolean }

/** What ffmpeg's metadata filter printed after scdet: `frame:N pts:P pts_time:T`, then that frame's keys. */
export function parseScenes(text: string): SceneFrame[] {
  const frames: SceneFrame[] = [];
  for (const line of text.split(/\r?\n/)) {
    const head = /^frame:\d+\s+pts:(\S+)/.exec(line);
    // A frame without a pts (NOPTS) still holds its place among its neighbours.
    if (head) frames.push({ pts: /^-?\d+$/.test(head[1]) ? Number(head[1]) : NaN, mafd: 0, cut: false });
    else if (frames.length && line.startsWith('lavfi.scd.mafd=')) frames.at(-1)!.mafd = Number(line.slice(15));
    else if (frames.length && line.startsWith('lavfi.scd.time=')) frames.at(-1)!.cut = true;
  }
  return frames;
}

/**
 * The pts of each frame that opens a shot: scdet's own cuts, and each frame that changes SPIKE_FLOOR of the threshold or
 * more and SPIKE_RATIO times as much as any other within SPIKE_SPAN frames of it. The first frame's difference is left out
 * of every comparison, since it has no frame before it.
 */
export function cutsOf(frames: SceneFrame[], threshold: number): number[] {
  return frames.flatMap((f, i) => {
    if (i === 0 || !Number.isFinite(f.pts)) return [];
    if (f.cut) return [f.pts];
    const around = frames.slice(Math.max(1, i - SPIKE_SPAN), i + SPIKE_SPAN + 1).filter((g) => g !== f).map((g) => g.mafd);
    return f.mafd >= SPIKE_FLOOR * threshold && f.mafd >= SPIKE_RATIO * Math.max(0, ...around) ? [f.pts] : [];
  });
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

/** Which shot a frame is in: how many cuts (the pts of each shot's first frame, in order) are at or before it. */
export function shotOf(cuts: number[], pts: number): number {
  let [lo, hi] = [0, cuts.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cuts[mid] <= pts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const micro = (s: number) => Math.round(s * 1e6) / 1e6;

/** ffmpeg on `video` with these arguments, returning its log and what it printed, or an error saying what it could not do and why. */
function ffmpegFor(spawn: Spawn, video: string): (args: string[], what: string) => { log: string; out: string } {
  return (args, what) => {
    // Room for hours of footage at the three lines a frame the scene decode prints.
    const r = spawn(FFMPEG, ['-nostdin', '-hide_banner', '-nostats', ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.error || r.status !== 0) {
      const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
      const why = code === 'ENOENT' ? `${FFMPEG} was not found` : code === 'ENOBUFS' ? 'its log outgrew the buffer'
        : r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
      const tail = String(r.stderr ?? '').trim().split('\n').slice(-3).join(' ');
      throw new Error(`ffmpeg could not ${what} ${video} (${why})${tail ? `: ${tail}` : ''}`);
    }
    return { log: String(r.stderr), out: String(r.stdout ?? '') };
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
  const work = mkdtempSync(join(tmpdir(), 'open-edit-graphics-'));
  try {
    const { graphics } = readGrid(ffmpegFor(spawn, video), video, work, every, { width, height }, span.end);
    return { video, width, height, durationSec: span.end, every, graphics };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The grid's frames of a clip, as their pts, and the graphics burned into them: one decode that writes no still. */
function readGrid(ffmpeg: ReturnType<typeof ffmpegFor>, video: string, work: string, every: number, display: { width: number; height: number },
  durationSec: number): { grid: { num: number; den: number; pts: number[] }; graphics: GraphicBox[] } {
  const size = workSize(display.width, display.height);
  const raw = join(work, 'grey.raw');
  const { log } = ffmpeg(['-i', video, '-an', '-sn', '-dn', '-vf', `${gridSelect(every)},showinfo@grid,${greyFilter(size)}`,
    '-fps_mode', 'passthrough', '-f', 'rawvideo', raw], 'read');
  const grid = parseShowinfo(log, 'grid');
  return { grid, graphics: graphicsFrom(raw, grid, size, every, display, durationSec) };
}

/**
 * The shots the grid sampled fewer than MIN_SAMPLES times, each with the pts it is asked for a frame at or past: null
 * for the clip's first frame, else the shot's own first, then the middle of each of MIN_SAMPLES equal parts of it.
 */
function shortShots(cuts: number[], bounds: number[], grid: { num: number; den: number; pts: number[] }): { shot: number; targets: (number | null)[] }[] {
  const sampled = new Array<number>(bounds.length - 1).fill(0);
  for (const p of grid.pts) sampled[shotOf(cuts, p)]++;
  return sampled.flatMap((count, k) => (count >= MIN_SAMPLES ? [] : [{
    shot: k,
    targets: [k === 0 ? null : cuts[k - 1], ...Array.from({ length: MIN_SAMPLES }, (_, j) =>
      Math.ceil(((bounds[k] + ((j + 0.5) * (bounds[k + 1] - bounds[k])) / MIN_SAMPLES) * grid.den) / grid.num))],
  }]));
}

/**
 * The frames short shots get beyond the grid's, decoded as stills a few shots at a time, not kept when already sampled
 * or of a shot that was not asked about. `read(select, from)` decodes the frames a select keeps, numbered from `from`.
 */
function shortShotFrames(cuts: number[], bounds: number[], grid: { num: number; den: number; pts: number[] },
  read: (select: string, from: number) => number[]): { n: number; pts: number; kept: boolean }[] {
  const have = new Set(grid.pts);
  const short = shortShots(cuts, bounds, grid);
  // A few dozen select terms per decode: a very long expression is where ffmpeg starts to fail.
  const per = Math.floor(40 / (MIN_SAMPLES + 1));
  const frames: { n: number; pts: number; kept: boolean }[] = [];
  for (let i = 0; i < short.length; i += per) {
    const chunk = short.slice(i, i + per);
    const from = frames.length;
    read(`select='${chunk.flatMap((c) => c.targets.map(atPts)).join('+')}'`, from).forEach((pts, j) => {
      const kept = chunk.some((c) => c.shot === shotOf(cuts, pts)) && !have.has(pts);
      if (kept) have.add(pts);
      frames.push({ n: from + j, pts, kept });
    });
  }
  return frames;
}

/**
 * The same frames by their times alone, from `all`, every frame's pts in order: for a caller that needs no still, so
 * however many shots it is given it reads the clip once more and no oftener.
 */
function shortShotTimes(cuts: number[], bounds: number[], grid: { num: number; den: number; pts: number[] }, all: () => number[]): number[] {
  const short = shortShots(cuts, bounds, grid);
  if (!short.length) return [];
  const frames = all();
  const have = new Set(grid.pts);
  const times: number[] = [];
  for (const { shot, targets } of short) {
    for (const target of targets) {
      const pts = target === null ? frames[0] : frames[shotOf(frames, target - 1)];
      if (pts === undefined || shotOf(cuts, pts) !== shot || have.has(pts)) continue;
      have.add(pts);
      times.push(pts);
    }
  }
  return times;
}

/** Refuses a shot no sampled frame fell in: it would read as a shot with no face, and text would be laid over whoever is in it. */
function assertSampled(cuts: number[], bounds: number[], sampled: number[], video: string): void {
  const hit = new Set(sampled.map((p) => shotOf(cuts, p)));
  const empty = bounds.slice(1).map((_, k) => k).filter((k) => !hit.has(k));
  if (empty.length) {
    const named = empty.slice(0, 8).map((k) => `${bounds[k].toFixed(3)}-${bounds[k + 1].toFixed(3)} s`).join(', ');
    throw new Error(`no frame could be read from ${named}${empty.length > 8 ? ` and ${empty.length - 8} more shots` : ''} ` +
      `of ${video}, so the faces there are unknown`);
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
    const { log, out } = ffmpeg(['-i', video, '-an', '-sn', '-dn', '-filter_complex',
      `[0:v]split=2[a][b];[a]scdet=threshold=${o.threshold},metadata=mode=print:file=-,nullsink;` +
        `[b]${gridSelect(o.every)},showinfo@grid,split=2[c][g];[c]${scale}[s];[g]${greyFilter(grey)}[r]`,
      '-map', '[s]', '-fps_mode', 'passthrough', '-start_number', '0', join(work, 'c%07d.png'),
      '-map', '[r]', '-fps_mode', 'passthrough', '-f', 'rawvideo', raw], 'read');
    const grid = parseShowinfo(log, 'grid');
    const graphics = graphicsFrom(raw, grid, grey, o.every, { width, height }, span.end);
    rmSync(raw, { force: true });
    const sec = (pts: number) => (pts * grid.num) / grid.den;
    grid.pts.forEach((p, i) => stills.set(name('c', i), p));
    const cuts = [...new Set(cutsOf(parseScenes(out), o.threshold))].sort((x, y) => x - y);
    // Shot k runs from bounds[k] to bounds[k + 1]: the cuts between, the video's last moment at the end, and 0 at
    // the start even when the picture starts later, since a player shows its first frame until then.
    const bounds = [0, ...cuts.map(sec), span.end];
    const shots = cuts.length + 1;
    const more = shortShotFrames(cuts, bounds, grid, (select, from) => parseShowinfo(ffmpeg(['-i', video, '-an', '-sn', '-dn', '-vf',
      `${select},showinfo@more,${scale}`, '-fps_mode', 'passthrough', '-start_number', String(from), join(work, 'm%07d.png')],
    'sample the short shots of').log, 'more').pts);
    for (const frame of more) {
      if (frame.kept) stills.set(name('m', frame.n), frame.pts);
      else rmSync(join(work, name('m', frame.n)), { force: true });
    }
    assertSampled(cuts, bounds, [...stills.values()], video);

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

/**
 * A clip's faces from the speakers file made for it: the file's shots, and on faces' own grid of sampled frames each
 * track's box and whether it is speaking, so every reader of faces.json reads it as it reads one faces found. The
 * frames are decoded only for their times and for the graphics, which no file holds.
 */
export function facesFromSpeakers(videoArg: string, speakersArg: string, o: Pick<FacesOptions, 'every' | 'margin'>, spawn: Spawn = spawnSync): FacesClip {
  const video = resolveVideoArg(videoArg);
  if (!existsSync(video)) throw new Error(`video not found: ${video}`);
  const path = resolve(speakersArg);
  if (!existsSync(path)) throw new Error(`no speakers file at ${path}`);
  const file = readSpeakers(path);
  const past = pastMapping(file);
  if (past) throw new SpeakersRefused(`${path} ${past}`, false);
  const { width, height } = probeSquareSize(video);
  const rate = probeFrameRate(video);
  const span = probeVideoSpan(video);
  const other = notSpeakersOf(file, { width, height, start: span.start, end: span.end, frame: 1 / rate.fps, container: containerDurationOf(video) });
  if (other) throw new SpeakersRefused(`${path} ${other}`);
  const bounds = shotBounds(file, span.end);
  // Each shot is asked for its own frames, so shots that do not follow one another are not a clip's.
  if (bounds.some((b, k) => k > 0 && b <= bounds[k - 1])) throw new SpeakersRefused(`${path} has shots that do not follow one another on this clip`);
  const ffmpeg = ffmpegFor(spawn, video);
  const work = mkdtempSync(join(tmpdir(), 'open-edit-faces-'));
  try {
    const { grid, graphics } = readGrid(ffmpeg, video, work, o.every, { width, height }, span.end);
    const sec = (pts: number) => (pts * grid.num) / grid.den;
    // The first frame at or past each bound opens its shot, found from NEAR before it, where the file's rounding can put that frame.
    const cuts = bounds.slice(1, -1).map((b) => Math.ceil(((b - NEAR) * grid.den) / grid.num));
    // The shots are the file's word, so what they cost is fixed here: one more read of the clip's frame times, however many they are.
    const more = shortShotTimes(cuts, bounds, grid, () => parseShowinfo(ffmpeg(['-i', video, '-an', '-sn', '-dn', '-vf',
      'showinfo@more', '-fps_mode', 'passthrough', '-f', 'null', '-'], 'read the frame times of').log, 'more').pts);
    const sampled = [...grid.pts, ...more].sort((x, y) => x - y);
    assertSampled(cuts, bounds, sampled, video);
    const inShot: number[][] = bounds.slice(1).map(() => []);
    for (const p of sampled) inShot[shotOf(cuts, p)].push(p);
    return {
      video,
      name: basename(video),
      width,
      height,
      fps: rate.fps,
      frameRate: rate.rate.replace(/\/1$/, ''),
      durationSec: span.end,
      model: SPEAKERS_MODEL,
      every: o.every,
      textMargin: o.margin,
      graphicsMargin: GRAPHICS_MARGIN,
      graphics,
      shots: bounds.slice(1).map((end, k): Shot => {
        const [start, from] = [micro(bounds[k]), file.shots[k]];
        return {
          start,
          end: micro(end),
          samples: inShot[k].map((p): Sample => ({
            // Never before its shot's start, which the file's rounding can put just after the shot's first frame.
            sec: Math.max(start, micro(sec(p))),
            // Each sample stands for the half step either side of it, so that is the span its boxes are read over.
            faces: from ? facesAt(from, sec(p), o.every / 2, { width, height }) : [],
          })),
          ...(from ? { show: showRuns(from) } : {}),
        };
      }),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

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
    : clip.shots.some((s) => s.samples.some((x) => x.faces.some((f) => (f.track === undefined ? f.speaking !== undefined
      : !Number.isInteger(f.track) || typeof f.speaking !== 'boolean')))) ? 'a face with a track or a speaking flag but not both'
    : clip.shots.some((s) => s.show !== undefined && (!Array.isArray(s.show) || s.show.some((run) => !isNum(run?.start) || !isNum(run.end)
      || !Array.isArray(run.tracks) || !run.tracks.every(Number.isInteger)))) ? 'a shot whose runs of whom to show are not each a start, an end and tracks'
    : clip.shots.some((s) => s.show?.some((run, k) => !(run.end > run.start) || (k > 0 && run.start < s.show![k - 1].end - NEAR)))
      ? 'a shot whose runs of whom to show end before they start, or start before the one ahead ends'
    : clip.graphics !== undefined && (!Array.isArray(clip.graphics) || clip.graphics.some((g) => ![g?.x, g?.y, g?.w, g?.h, g?.from, g?.to].every(isNum)))
      ? 'a graphic without its box or its times'
    : null;
  if (problem) throw new Error(`${path} is not a faces.json the faces command wrote (${problem})`);
  return clip as FacesClip;
}

/** Whether boxes found on a clip of `found`'s size and length fit a clip of this size and length. */
export const measuredAs = (found: { width: number; height: number; durationSec: number }, size: { width: number; height: number }, durationSec: number): boolean =>
  found.width === size.width && found.height === size.height && Math.abs(found.durationSec - durationSec) <= SAME_CLIP_SEC;

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

/**
 * A clip's faces from the speakers file the hosted analysis `model` makes for it, kept beside faces.json in `out`
 * under a name made of the clip's bytes and the analysis: the one kept there, else a new one, said before the call
 * that buys it. Undefined, with the reason said, when the clip is left to MediaPipe.
 */
async function analysed(model: string, video: string, out: string, options: Pick<FacesOptions, 'every' | 'margin'>, say: (line: string) => void,
  deps: FacesRunDeps): Promise<{ clip: FacesClip; from: string } | undefined> {
  // Size and length stay the same when a clip is rendered again, so its bytes name the file, with the analysis that
  // made it: one file, so two runs at once cannot leave one's answer beside the other's record of what it is for.
  const kept = join(out, `speakers-${createHash('sha256').update(`${await fileDigest(video)}\n${model}`).digest('hex').slice(0, 16)}.json`);
  // A refusal of the file is a reason to say; anything else, ffmpeg's failure included, is not the file's and is thrown.
  const mapped = (file: string): FacesClip | string => {
    try {
      return facesFromSpeakers(video, file, options);
    } catch (e) {
      if (e instanceof SpeakersRefused) return e.message;
      throw e;
    }
  };
  const here = 'the shots and the faces are found here, with MediaPipe';
  if (existsSync(kept)) {
    let clip: FacesClip | string;
    try {
      clip = mapped(kept);
    } catch (e) {
      // One that cannot be opened is said and run for again: left to fail, it would fail every run of this clip.
      if (!(e instanceof SpeakersUnread)) throw e;
      clip = e.message;
    }
    if (typeof clip === 'object') {
      say(`the speakers file the hosted analysis made for this clip is kept at ${kept}, so the analysis is not run again`);
      return { clip, from: kept };
    }
    say(`the speakers file kept at ${kept} is not used (${clip}), so the hosted analysis is run again`);
  }
  const skip = whyNotSent(sendable(video));
  if (skip) return void say(`the hosted analysis ${ANALYSIS_ENV} names is not run: ${skip}. So ${here}`);
  const route = (deps.route ?? falRoute)(deps.env);
  if (route.how === 'none') return void say(`the hosted analysis ${ANALYSIS_ENV} names is not run: ${route.why}. So ${here}`);
  // Said before the call, since the call is where the fal account is charged.
  say(`running the hosted analysis ${ANALYSIS_ENV} names on ${basename(video)}: one generation ` +
    `${route.how === 'key' ? 'on the fal account of the fal key this run reads, never on a VEED workspace'
      : 'through the fal command the environment gives in place of a key, which prices and approves it and bills as that environment arranges'}. ` +
    `Its answer is waited for up to ${WAIT_MS / 60_000} minutes; --local finds the shots and the faces here instead`);
  const began = Date.now();
  const took = () => `${Math.round((Date.now() - began) / 1000)} s`;
  let got: Awaited<ReturnType<typeof runAnalysis>>;
  try {
    got = await (deps.analysis ?? runAnalysis)(model, video, { runDir: join(runsDir(), runKeyOf(video)), dir: join(out, 'analysis'), route, log: say });
  } catch (e) {
    if (!(e instanceof AnalysisFailed)) throw e;
    return void say(`the hosted analysis gave no speakers file for this clip after ${took()} (${e.message}). So ${here}`);
  }
  const answered = took();
  const clip = mapped(got.file);
  if (typeof clip === 'string') return void say(`the hosted analysis answered in ${answered} with a file that is not used (${clip}). So ${here}`);
  const request = got.requestId ? ` (request ${got.requestId})` : '';
  // Kept only once it maps, and whole or not at all: a file left there half written, or unmappable, would be run for again every time.
  try {
    writeTextAtomic(kept, readFileSync(got.file, 'utf8'));
  } catch (e) {
    say(`the hosted analysis answered in ${answered}${request}; its speakers file could not be kept at ${kept} (${errorText(e)}), so the next run asks again`);
    return { clip, from: got.file };
  }
  say(`the hosted analysis answered in ${answered}${request}; its speakers file is kept at ${kept}`);
  return { clip, from: kept };
}

/** What faces runs in place of its own parts, for a test to stand in for them. */
export interface FacesRunDeps { analysis?: typeof runAnalysis; route?: typeof falRoute; env?: NodeJS.ProcessEnv }

export async function faces(argv: string[], deps: FacesRunDeps = {}): Promise<number> {
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
  const options = {
    every: numberFlag('every', values.every, 0.25, (n) => n > 0, 'seconds above 0'),
    threshold: numberFlag('threshold', values.threshold, 10, (n) => n > 0 && n <= 100, 'a score above 0 and at most 100'),
    confidence: numberFlag('confidence', values.confidence, 0.5, (n) => n > 0 && n < 1, 'a score between 0 and 1'),
    margin: numberFlag('margin', values.margin, 0.25, (n) => n >= 0, 'a fraction of the box, 0 or more'),
  };
  const steered = (['threshold', 'confidence'] as const).filter((flag) => values[flag] !== undefined).map((flag) => `--${flag}`);
  if (values.speakers !== undefined && steered.length) {
    throw new Error(`${steered.join(' and ')} steer${steered.length > 1 ? '' : 's'} the cuts and the faces that faces finds itself, and with --speakers ` +
      `both come from the file: leave ${steered.length > 1 ? 'them' : 'it'} out, or leave out --speakers`);
  }
  if (values.speakers !== undefined && values.local) throw new Error('--local finds the shots and the faces here, and --speakers takes them from a file: pass one of the two');
  // In --json the clip alone goes to stdout.
  // What a line quotes may be a command's or a file's own words, so no control character of theirs reaches the terminal.
  const say = (line: string) => (values.json ? console.error : console.log)(`faces: ${printable(line)}`);
  let from = values.speakers === undefined ? undefined : resolve(values.speakers);
  const without = 'leave out --speakers, and faces finds the shots and the faces itself';
  const remedy = `name the speakers file made for ${video} as it is now, or ${without}`;
  if (from !== undefined && !existsSync(from)) throw new Error(`no speakers file at ${from}: ${remedy}`);
  let clip: FacesClip | undefined;
  try {
    clip = from === undefined ? undefined : facesFromSpeakers(video, from, options);
  } catch (e) {
    if (!(e instanceof SpeakersRefused)) throw e;
    // Another file helps only where this one is not the clip's: one past what faces maps is past it whoever made it.
    throw new Error(`${e.message}: ${e.another ? remedy : without}`, { cause: e });
  }
  const model = clip || values.local ? null : analysisNamed(deps.env);
  if (model && steered.length) say(`${steered.join(' and ')} ask${steered.length > 1 ? '' : 's'} for the cuts and the faces found here, so the hosted analysis ${ANALYSIS_ENV} names is not run`);
  else if (model) ({ clip, from } = (await analysed(model, resolved, out, options, say, deps)) ?? { clip, from });
  clip ??= findFaces(video, options);
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
  const sampled = clip.detector?.frames ?? clip.shots.reduce((sum, s) => sum + s.samples.length, 0);
  console.log(`faces: ${clip.shots.length} shot(s) of ${clip.name} (${clip.width}x${clip.height}, ${clip.durationSec.toFixed(3)}s), ` +
    `${sampled} sampled frame(s), faces on ${found}`);
  for (const shot of clip.shots) {
    const boxes = api.boxes(shot.start, shot.end);
    const list = boxes.map((b) => `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)}`).join('; ');
    console.log(`  ${shot.start.toFixed(3)}–${shot.end.toFixed(3)}s  ${shot.samples.length} sample(s)  ${boxes.length ? `keep text clear of: ${list}` : 'no face'}`);
  }
  const graphics = clip.graphics ?? [];
  console.log(`  graphics burned into the footage: ${graphics.length ? `${graphics.length}, kept clear like the faces` : 'none found'}`);
  for (const g of graphics.slice(0, 12)) console.log(`    ${g.from.toFixed(3)}–${g.to.toFixed(3)}s  ${g.x},${g.y} ${g.w}x${g.h}`);
  if (graphics.length > 12) console.log(`    and ${graphics.length - 12} more in faces.json`);
  const whole = `whole command ${((Date.now() - started) / 1000).toFixed(1)} s`;
  const d = clip.detector;
  if (d) {
    console.log(`  detector: model loaded in ${Math.round(d.readyMs)} ms, ${d.frames} frame(s) in ${d.totalMs} ms` +
      `${d.frames ? ` (${(d.totalMs / d.frames).toFixed(1)} ms each)` : ''}; ${whole}`);
  } else {
    const tracks = clip.shots.reduce((sum, s) => sum + new Set(s.samples.flatMap((x) => x.faces.map((f) => f.track))).size, 0);
    const speaking = clip.shots.reduce((sum, s) => sum + s.samples.filter((x) => x.faces.some((f) => f.speaking)).length, 0);
    console.log(`  shots and faces from the speakers file ${from}: ${tracks} track(s) sampled, a face speaking on ` +
      `${speaking} sampled frame(s); MediaPipe not run; ${whole}`);
  }
  console.log(`  wrote ${join(out, 'faces.json')} and ${join(out, 'faces.js')}`);
  return 0;
}
