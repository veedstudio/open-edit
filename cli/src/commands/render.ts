// An HTML page, rendered frame by frame in headless Chrome, into a video.
//
// The page runs under a virtual clock, and every worker steps it through the frames before its own,
// so each frame depends only on its index: not on the machine's speed, and not on the worker count.
// The video is cut into short segments kept beside the output; a change to one moment re-renders only
// the segments that hold it (--from/--to) and splices them back by stream copy, leaving every other
// frame of the file bit-identical.
//
//   openedit render page.html --out out.mp4 --duration 12 [--fps 30000/1001] [--workers 6]
//   openedit render page.html --out out.mp4 --duration 12 --from 4.5 --to 6      (patch)
//   openedit render page.html --out stills/ --stills 0.5,3,7.25 --sheet sheet.jpg
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseUsage, usageLine, numberFlag, type Usage } from '../args.ts';
import { FFMPEG } from '../config.ts';
import { FFMPEG_PROBE, probeVersion } from '../platform.ts';
import { tilePath, tileSheet, withTileDir } from '../sheet.ts';
import { parseTimeSpec } from './frames.ts';
import { CHROME, mb, resolveChrome } from '../render/browser.ts';
import { countFrames, encoderArgs, joinSegments, killEncoders, startSegmentEncoder } from '../render/encode.ts';
import { longestGop, MAX_GOP, seekableCopy } from '../render/media.ts';
import { inspectPng, showsSomething } from '../render/png.ts';
import { onDisk, startPageServer, tooBroad, type PageServer } from '../render/server.ts';
import { RenderSession, type SessionOptions } from '../render/session.ts';
import {
  fpsLabel, frameAtTime, frameSpan, frameTime, framesForDuration, parseFps, planSegments, segmentFramesFor,
  segmentsTouching, splitContiguous, splitFrames, workersFor, type Fps, type Segment,
} from '../render/timing.ts';

// Fixed, so two renders of one page agree to the pixel: Math.random() draws the same sequence and
// Date.now() reads the same instant at frame 0 on every machine.
export const SEED = 0x5eed;
export const EPOCH = Date.UTC(2025, 0, 1);
export const BUDGET_MS = 60_000;
// A worker costs a Chrome launch, a page load and a preroll through every frame before its first: worth
// it for a dozen frames of a heavy page, where a patch is waiting on every one of them, but not for fewer.
const MIN_FRAMES_PER_WORKER = 12;

export const usage = {
  summary: 'Render an HTML page to video in headless Chrome, frame-exact; re-render only a changed range',
  positionals: '<page.html>',
  flags: {
    out: { type: 'string', required: true, value: '<file|dir>', help: 'The video (.mp4, or .mov); with --stills, the directory for the PNGs' },
    fps: { type: 'string', value: 'N|N/D', help: 'Frame rate, an integer or exact rational such as 30000/1001 (default 30)' },
    duration: { type: 'string', value: '<sec>', help: 'Length; frames = round(sec × fps)' },
    frames: { type: 'string', value: 'N', help: 'Length in frames, instead of --duration' },
    width: { type: 'string', value: 'N', help: 'Canvas width; with --height, captures that much of the page from its top-left corner instead of the stage (default: the #stage or [data-stage] element, else 1920x1080)' },
    height: { type: 'string', value: 'N', help: 'Canvas height' },
    workers: { type: 'string', value: 'N', help: `Parallel Chrome instances, each rendering a contiguous run of frames; for a video, at most one per ${MIN_FRAMES_PER_WORKER} frames rendered (default ${defaultWorkers()} here)` },
    segment: { type: 'string', value: '<sec>', help: 'Segment length in seconds (default 2); the unit a patch re-renders' },
    from: { type: 'string', value: '<sec>', help: 'Patch: re-render only the segments overlapping --from..--to, reuse the rest, rejoin (default 0)' },
    to: { type: 'string', value: '<sec>', help: 'End of the patch range, exclusive: a segment that starts exactly here is not re-rendered (default: the end)' },
    transparent: { type: 'boolean', help: 'No page background: a ProRes 4444 .mov with alpha (PNGs with alpha under --stills)' },
    stills: { type: 'string', multiple: true, value: '<sec,...>', help: 'Render only these moments as PNGs, no video; repeatable or comma-separated' },
    sheet: { type: 'string', value: '<file.jpg>', help: 'With --stills: also tile them on one contact sheet' },
    chrome: { type: 'string', value: '<path>', help: 'Drive this Chrome/Chromium binary instead of the pinned headless shell' },
    root: { type: 'string', multiple: true, value: '<dir>', help: 'Also let the page read files beneath this directory; repeatable' },
  },
  notes: [
    'Time: the page runs on a virtual clock. performance.now, Date.now, requestAnimationFrame, setTimeout/setInterval',
    'advance by exactly one frame per frame, and Math.random is seeded. Frame i is at i*den/num s. Each frame, CSS and',
    'Web Animations are set to that time, gsap.globalTimeline is seeked when GSAP is present, and window.__seek(t) is',
    'called and awaited when the page defines it (the clock stands still while it runs, so it must not await',
    'requestAnimationFrame or a timer); <video> elements show the picture at t (from 0 unless __seek sets their',
    'time). Timers and requestAnimationFrame run before that seek, so a video drawn into a canvas from either shows',
    'the previous frame\'s picture; draw it from window.__seek(t) once the video\'s own seek has settled (while',
    'video.seeking, await its seeked event). Fonts, images and videos are loaded before frame 0. A local video with',
    'keyframes far apart is served from an all-intra copy, so every seek decodes a single frame; the copy is kept in',
    '<out>.render/media for later renders and patches, and a copy the page no longer plays is removed by the next',
    'video render to that --out. Stills keep theirs in <stills-dir>.render/media, which nothing prunes.',
    'Each worker steps the page through every earlier frame (without capturing them) before its own, so state a page',
    'builds as time passes matches a one-worker render, and the output is the same whatever --workers is.',
    'Cache: segments and a manifest live in <out>.render/. --from/--to re-renders the segments that overlap the range',
    '(plus any missing from the cache) with the same fps, size, length, segment length, browser and ffmpeg, and rejoins',
    'by stream copy.',
    'Fails, naming the cause, when Chrome does not start, the page server refuses a file the page needs (see Files),',
    'the page throws or rejects unhandled, a video never shows the picture a seek asked for, or every rendered frame',
    'is one flat colour (fully transparent with --transparent), a patch\'s range included where the render it patches',
    'drew; the output is then left as it was. Loads that fail, and videos that will not play, are listed as warnings,',
    'before the error when the render fails.',
    'Files: the page is served over loopback HTTP and reads files beneath its own directory, the working directory and',
    'each --root. The home directory, an ancestor of it and the filesystem root are served only when a --root names',
    'one: a working directory there is left out, and a page kept there is refused.',
    'Anything else, any hidden (dot) name, the CLI\'s own state and the fal key file are refused. A refused file fails',
    'the render, naming it and the --root that would let the page read it, or, when that folder is one of those above',
    'or a hidden one, saying it sits in a folder render does not serve. A refused fetch() or XMLHttpRequest is only a',
    'failed load, since the page sees the refusal and can handle it, as is a missing file beneath the roots; a path',
    'outside them is refused without being looked up, so a missing one is refused too.',
    'Output: H.264 yuv420p (CRF 15, BT.709, +faststart), or ProRes 4444 with alpha under --transparent; silent.',
    '`mux-audio --video <out> --audio <track> --out <file>` adds a soundtrack (mix-audio builds one from several pieces).',
    'The browser is Chrome Headless Shell at a pinned version, downloaded on first use (see install-browser). It',
    'runs in its own sandbox, and without it wherever Chrome refuses it (inside another macOS sandbox, as root in a',
    'Linux container, without user namespaces, or for any other reason Chrome gives), and says so.',
  ].join('\n'),
} satisfies Usage;

export function defaultWorkers(cpus = availableParallelism()): number {
  return Math.max(1, Math.min(8, Math.floor(cpus / 2)));
}

interface Params {
  page: string;
  fps: string;
  width: number;
  height: number;
  frames: number;
  segmentFrames: number;
  transparent: boolean;
  encoder: string;
  /** The browser and ffmpeg builds: a segment made by another is not spliced in beside this render's. */
  browser: string;
  ffmpeg: string;
}

interface Manifest {
  version: 1;
  params: Params;
  /** `drawn`: whether any frame of the segment is more than one flat colour; absent reads as drawn. */
  segments: { index: number; start: number; frames: number; file: string; bytes: number; drawn?: boolean }[];
}

interface Canvas {
  width: number;
  height: number;
  /** The viewport the stage was measured in, and so the only one its clip is valid in. */
  viewport: { width: number; height: number };
  clip: SessionOptions['clip'];
}

type SessionBase = Omit<SessionOptions, 'viewport' | 'clip'>;
type Stage = NonNullable<RenderSession['info']['stage']>;

const PROBE = { width: 1920, height: 1080 };

const say = (line: string) => console.error(`render: ${line}`);
const pad = (n: number, w: number) => String(n).padStart(w, '0');

class UsageError extends Error {}

/** `f()`, with any error it throws turned into a usage error: it read a flag the user got wrong. */
function asUsage<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

function sessionOptions(base: SessionBase, canvas: Canvas): SessionOptions {
  return { ...base, viewport: canvas.viewport, clip: canvas.clip };
}

const fitsIn = (s: Stage, v: { width: number; height: number }): boolean =>
  s.left >= 0 && s.top >= 0 && s.left + s.width <= v.width && s.top + s.height <= v.height;

function stageCanvas(s: Stage, viewport: { width: number; height: number }): Canvas {
  const whole = s.left === 0 && s.top === 0 && s.width === viewport.width && s.height === viewport.height;
  return { width: s.width, height: s.height, viewport, clip: whole ? null : { x: s.left, y: s.top, width: s.width, height: s.height } };
}

function led(canvas: Canvas, lead: RenderSession): { canvas: Canvas; lead: RenderSession } {
  lead.setClip(canvas.clip);
  return { canvas, lead };
}

const where = (s: Stage | null): string => (s ? `${s.width}x${s.height} at ${s.left},${s.top}` : 'gone');

/**
 * The first worker, opened before the others: it settles the canvas (the flags when given, else the
 * page's stage element) and reports the page's videos. The stage is captured from the viewport it was
 * measured in: a centred or viewport-sized stage moves when the viewport changes size.
 */
async function openLead(base: SessionBase, width?: number, height?: number): Promise<{ canvas: Canvas; lead: RenderSession }> {
  if (width && height) {
    const canvas = { width, height, viewport: { width, height }, clip: null };
    return { canvas, lead: await RenderSession.open(sessionOptions(base, canvas)) };
  }
  const probe = await RenderSession.open({ ...base, viewport: PROBE, clip: null });
  const first = probe.info.stage;
  if (!first) return { canvas: { ...PROBE, viewport: PROBE, clip: null }, lead: probe };
  const inProbe = fitsIn(first, PROBE);
  if (inProbe && stageCanvas(first, PROBE).clip === null) return led(stageCanvas(first, PROBE), probe);
  // The smallest viewport that holds the stage where it sat, measured again there. The probe stays open
  // meanwhile: when the stage fits it, its own measurement is the fallback.
  const viewport = { width: Math.max(first.left, 0) + first.width, height: Math.max(first.top, 0) + first.height };
  let lead: RenderSession;
  try {
    lead = await RenderSession.open({ ...base, viewport, clip: null });
  } catch (e) {
    await probe.close();
    throw e;
  }
  const again = lead.info.stage;
  if (again && again.width === first.width && again.height === first.height && fitsIn(again, viewport)) {
    await probe.close();
    return led(stageCanvas(again, viewport), lead);
  }
  await lead.close();
  if (inProbe) return led(stageCanvas(first, PROBE), probe);
  await probe.close();
  throw new UsageError(`the page's stage is ${where(first)} in a ${PROBE.width}x${PROBE.height} viewport but ${where(again)} in ${viewport.width}x${viewport.height}: `
    + 'its size or place follows the viewport, so give it a fixed size, or pass --width/--height');
}

const firstLine = (e: unknown): string =>
  ((e as { stderr?: Buffer }).stderr?.toString().trim() || (e as Error).message).split('\n')[0];

/**
 * Serves an all-intra copy in place of every long-GOP video the page plays, and reloads the lead when
 * any was swapped in, since the page read the originals as it loaded. Returns the copies in use.
 */
async function seekableVideos(lead: RenderSession, server: PageServer, dir: string): Promise<string[]> {
  const copies: string[] = [];
  for (const url of new Set(lead.info.videos)) {
    const file = server.fileFor(url);
    if (!file || !existsSync(file)) continue;
    let gop: number;
    try {
      gop = longestGop(file);
    } catch (e) {
      say(`could not read the keyframes of ${basename(file)} (${firstLine(e)}); serving it as it is, so its seeks may be slow`);
      continue;
    }
    if (gop <= MAX_GOP) continue;
    const started = Date.now();
    const copy = seekableCopy(file, dir);
    if (copy.made) say(`made an all-intra copy of ${basename(file)} (keyframes up to ${gop} frames apart) for frame-exact seeks in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    server.substitute(file, copy.path);
    copies.push(copy.path);
  }
  if (copies.length) await lead.reload();
  return copies;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Refuses while a live process holds the lock and takes over one left by a process that is gone.
 * Liveness is a PID check on this machine, so a PID the system has since given to another process
 * reads as live until that one exits.
 */
export function acquireLock(dir: string): () => void {
  const lock = join(dir, '.lock');
  const mine = String(process.pid);
  // Only while the lock is still this render's: one that took it over from here must keep it.
  const drop = () => {
    if (holderOf(lock)?.text === mine) rmSync(lock, { force: true });
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(lock, mine, { flag: 'wx' });
      // An exit forced by a signal skips every finally; the lock must not outlive the process anyway.
      process.once('exit', drop);
      return () => {
        process.off('exit', drop);
        drop();
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const seen = holderOf(lock);
      if (!seen) continue;
      const holder = Number(seen.text);
      // An empty lock is one a render has created but not yet written its PID into.
      const starting = seen.text === '' && Date.now() - seen.mtimeMs < 10_000;
      // This process holds no lock yet, so its own PID in the file was left by an earlier process.
      const live = Number.isInteger(holder) && holder > 0 && holder !== process.pid && processAlive(holder);
      if (starting || live) throw new Error(`another render (${live ? `pid ${holder}` : 'starting'}) is writing ${dir}; wait for it, or render to a different --out`);
      // Moved aside rather than deleted: a rename takes one file whole, so of two renders that found the
      // same holder gone only one moves it, and a lock taken since is seen for what it is and put back.
      const aside = join(dir, `.lock.${mine}-${randomBytes(3).toString('hex')}`);
      try {
        renameSync(lock, aside);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      const moved = holderOf(aside);
      if (moved && (moved.text !== seen.text || moved.mtimeMs !== seen.mtimeMs)) renameSync(aside, lock);
      else rmSync(aside, { force: true });
    }
  }
  throw new Error(`could not take the lock on ${dir}`);
}

/** What a lock file holds and when it was written, or null when it is gone. */
function holderOf(file: string): { text: string; mtimeMs: number } | null {
  try {
    return { text: readFileSync(file, 'utf8').trim(), mtimeMs: statSync(file).mtimeMs };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function readManifest(dir: string): Manifest | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
    return m.version === 1 && m.params && Array.isArray(m.segments) ? m : null;
  } catch {
    return null;
  }
}

function writeManifest(dir: string, m: Manifest): void {
  const tmp = join(dir, `manifest.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`);
  renameSync(tmp, join(dir, 'manifest.json'));
}

function paramsDiffer(a: Params, b: Params): string[] {
  return (Object.keys(b) as (keyof Params)[]).filter((k) => a[k] !== b[k]).map((k) => `${k} ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`);
}

interface WorkerPlan<T> {
  groups: T[][];
  run: (session: RenderSession, item: T, stop: () => boolean) => Promise<void>;
}

/**
 * Runs each group on its own Chrome, all at once. The first failure stops every worker before its next
 * capture (a page load or a preroll already under way runs to its end) and is the one reported; all
 * browsers are closed whatever happens.
 */
async function runWorkers<T>(base: SessionBase, canvas: Canvas, lead: RenderSession, plan: WorkerPlan<T>): Promise<void> {
  const sessions: RenderSession[] = [];
  let failure: unknown = null;
  const stop = () => failure !== null;
  let spare: RenderSession | null = lead;
  try {
    await Promise.all(plan.groups.map(async (group) => {
      try {
        const session = spare ?? await RenderSession.open(sessionOptions(base, canvas));
        spare = null;
        sessions.push(session);
        for (const item of group) {
          if (stop()) return;
          await plan.run(session, item, stop);
        }
      } catch (e) {
        failure ??= e;
      }
    }));
  } finally {
    if (spare) sessions.push(spare);
    await Promise.all(sessions.map((s) => s.close()));
  }
  if (failure) throw failure;
}

// Said without blame on a failure: the list is printed before every error, a usage one or a held lock
// included, which no failed load can have caused.
function warnLoads(loads: Set<string>, delivered: boolean): void {
  if (!loads.size) return;
  const after = delivered ? '; the frames were rendered without them' : ' before the failure below';
  console.error(`render: warning: ${loads.size} resource(s) failed to load or play${after}:`);
  for (const line of [...loads].sort()) console.error(`  ${line}`);
}

async function renderStills(o: {
  base: SessionBase; canvas: Canvas; lead: RenderSession; fps: Fps;
  frames: number[]; outDir: string; sheet?: string; workers: number;
}): Promise<{ paths: string[]; workers: number }> {
  mkdirSync(o.outDir, { recursive: true });
  // Every worker steps through the frames before its first still, so a long-GOP video pays one slow
  // seek per earlier frame unless it is swapped for its all-intra copy here too.
  await seekableVideos(o.lead, o.base.server, `${o.outDir}.render/media`);
  const groups = splitContiguous(o.frames, o.workers);
  const paths = new Map<number, string>();
  let drawn = false;
  await runWorkers(o.base, o.canvas, o.lead, {
    groups,
    run: async (session, frame) => {
      const png = await session.capture(frame);
      if (!drawn && showsSomething(inspectPng(png))) drawn = true;
      const path = join(o.outDir, `f${pad(frame, 6)}-${frameTime(frame, o.fps).toFixed(3)}s.png`);
      writeFileSync(path, png);
      paths.set(frame, path);
    },
  });
  const ordered = o.frames.map((f) => paths.get(f)!);
  if (!drawn) throw new Error(`every still is ${o.base.transparent ? 'fully transparent or ' : ''}one flat colour: the page drew nothing (stills kept in ${o.outDir})`);
  if (o.sheet) {
    const sheet = resolve(o.sheet);
    mkdirSync(dirname(sheet), { recursive: true });
    withTileDir((dir) => {
      ordered.forEach((p, i) => execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', p, '-vf', 'scale=640:-2,format=rgb24', tilePath(dir, i)]));
      tileSheet(dir, ordered.length, Math.ceil(Math.sqrt(ordered.length)), sheet);
    });
  }
  return { paths: ordered, workers: groups.length };
}

interface VideoResult {
  frames: number;
  rendered: number;
  reusedSegments: number;
  renderedSegments: number;
  workers: number;
  bytes: number;
}

async function renderVideo(o: {
  base: SessionBase; canvas: Canvas; lead: RenderSession; fps: Fps; page: string; browser: string;
  total: number; segmentFrames: number; out: string; workers: number; patch: { from: number; to: number } | null;
}): Promise<VideoResult> {
  const transparent = o.base.transparent;
  const ext = transparent ? 'mov' : 'mp4';
  const cache = `${o.out}.render`;
  mkdirSync(cache, { recursive: true });
  const release = acquireLock(cache);
  try {
    const params: Params = {
      page: o.page, fps: fpsLabel(o.fps), width: o.canvas.width, height: o.canvas.height, frames: o.total,
      segmentFrames: o.segmentFrames, transparent, encoder: encoderArgs(transparent).join(' '),
      browser: o.browser, ffmpeg: probeVersion(FFMPEG, FFMPEG_PROBE).banner.replace(/\s+Copyright.*$/, ''),
    };
    const segments = planSegments(o.total, o.segmentFrames);
    const fileOf = (s: Segment) => join(cache, `seg-${pad(s.index, 5)}.${ext}`);
    const previous = readManifest(cache);
    let toRender: Segment[];
    const sizes = new Map<number, number>();

    if (o.patch) {
      if (!previous) throw new UsageError(`nothing to patch: ${cache} holds no finished render; render once without --from/--to first`);
      const differ = paramsDiffer(previous.params, params);
      if (differ.length) throw new UsageError(`the cached render was made differently (${differ.join('; ')}); a patch keeps every one of these, so render without --from/--to`);
      const span = frameSpan(o.patch.from, o.patch.to, o.fps, o.total);
      const targeted = new Set(segmentsTouching(segments, span.from, span.to).map((s) => s.index));
      const recorded = new Map(previous.segments.map((s) => [s.index, s.bytes]));
      for (const s of segments) {
        const f = fileOf(s);
        const ok = existsSync(f) && statSync(f).size === recorded.get(s.index);
        if (ok && !targeted.has(s.index)) sizes.set(s.index, recorded.get(s.index)!);
      }
      toRender = segments.filter((s) => !sizes.has(s.index));
    } else {
      // A full render starts from an empty cache: a segment left from a different render must never
      // be spliced into this one.
      for (const name of readdirSync(cache)) if (name !== '.lock' && name !== 'media') rmSync(join(cache, name), { recursive: true, force: true });
      toRender = segments;
    }
    // Half-written segments of an interrupted render; the lock means no live render owns them.
    for (const name of readdirSync(cache)) {
      if (name.endsWith('.tmp') || name.startsWith('spill.')) rmSync(join(cache, name), { recursive: true, force: true });
    }

    const media = join(cache, 'media');
    const copies = await seekableVideos(o.lead, o.base.server, media);
    // A copy is keyed by its source's path, size and mtime, so one not in use now belongs to a source
    // that changed or left the page and would never be read again. The lock makes this render the
    // cache's only writer.
    if (existsSync(media)) {
      for (const name of readdirSync(media)) if (!copies.includes(join(media, name))) rmSync(join(media, name), { recursive: true, force: true });
    }
    const reusedSegments = segments.length - toRender.length;
    const renderedFrames = toRender.reduce((n, s) => n + s.frames, 0);
    const runs = splitFrames(toRender, workersFor(renderedFrames, o.workers, MIN_FRAMES_PER_WORKER));
    const attempt = `${process.pid}-${randomBytes(3).toString('hex')}`;
    // A segment split between workers is kept as PNGs, one per frame, and encoded in order once every
    // worker has finished.
    const spill = join(cache, `spill.${attempt}`);
    const spillDir = (seg: Segment) => join(spill, pad(seg.index, 5));
    const spillFrame = (dir: string, i: number) => join(dir, `f-${pad(i, 7)}.png`);
    const shared = new Map<number, Segment>();
    const drew = new Set<number>();
    let doneFrames = 0;
    let nextReport = 0.1;
    const progress = (frames: number) => {
      doneFrames += frames;
      if (doneFrames / renderedFrames >= nextReport && doneFrames < renderedFrames) {
        say(`${Math.floor((doneFrames / renderedFrames) * 100)}% (${doneFrames}/${renderedFrames} frames)`);
        nextReport = Math.floor((doneFrames / renderedFrames) * 10) / 10 + 0.1;
      }
    };
    const encode = async (seg: Segment, frames: AsyncIterable<Buffer> | Iterable<Buffer>) => {
      const tmp = join(cache, `seg-${pad(seg.index, 5)}.${attempt}.tmp`);
      const enc = startSegmentEncoder(tmp, o.fps, transparent);
      try {
        for await (const png of frames) await enc.write(png);
        await enc.finish();
        renameSync(tmp, fileOf(seg));
        sizes.set(seg.index, statSync(fileOf(seg)).size);
      } catch (e) {
        enc.kill();
        rmSync(tmp, { force: true });
        throw e;
      }
    };

    try {
      await runWorkers(o.base, o.canvas, o.lead, {
        groups: runs,
        run: async (session, piece, stop) => {
          const seg = piece.segment;
          async function* captured() {
            for (let i = piece.from; i < piece.to; i++) {
              if (stop()) throw new Error('stopped');
              const png = await session.capture(i);
              if (!drew.has(seg.index) && showsSomething(inspectPng(png))) drew.add(seg.index);
              yield png;
            }
          }
          if (piece.from === seg.start && piece.to === seg.start + seg.frames) {
            await encode(seg, captured());
          } else {
            const dir = spillDir(seg);
            mkdirSync(dir, { recursive: true });
            let i = piece.from;
            for await (const png of captured()) writeFileSync(spillFrame(dir, i++), png);
            shared.set(seg.index, seg);
          }
          progress(piece.to - piece.from);
        },
      });
      await Promise.all([...shared.values()].map((seg) => {
        const files = Array.from({ length: seg.frames }, (_, k) => spillFrame(spillDir(seg), seg.start + k));
        return encode(seg, (function* () { for (const f of files) yield readFileSync(f); })());
      }));
    } finally {
      rmSync(spill, { recursive: true, force: true });
    }

    // A patch runs on a page edited since the render it patches, which says nothing about whether this
    // one draws, so a blank range is refused where that render drew; one that was blank may stay so.
    const drewBefore = new Map(previous?.segments.map((s) => [s.index, s.drawn !== false]) ?? []);
    const blank = renderedFrames > 0 && !toRender.some((s) => drew.has(s.index));
    if (blank && (!o.patch || toRender.some((s) => drewBefore.get(s.index) !== false))) {
      // The manifest still records the segments these replaced, so they must not stay in the cache.
      if (o.patch) for (const s of toRender) rmSync(fileOf(s), { force: true });
      const flat = `${transparent ? 'fully transparent or ' : ''}one flat colour`;
      throw new Error(o.patch
        ? `every re-rendered frame is ${flat} where the render it patches drew: the page drew nothing in the patched range; ${o.out} was left as it was. `
          + 'If the range is meant to be empty, render without --from/--to, which checks the whole video'
        : `every rendered frame is ${flat}: the page drew nothing; ${o.out} was left as it was`);
    }
    joinSegments(segments.map(fileOf), o.out);
    const counted = countFrames(o.out);
    if (counted !== o.total) throw new Error(`${o.out} holds ${counted} frames, expected ${o.total}; the segments in ${cache} do not add up`);
    writeManifest(cache, {
      version: 1,
      params,
      segments: segments.map((s) => ({
        index: s.index, start: s.start, frames: s.frames, file: basename(fileOf(s)), bytes: sizes.get(s.index)!,
        drawn: toRender.includes(s) ? drew.has(s.index) : drewBefore.get(s.index) !== false,
      })),
    });
    return {
      frames: o.total, rendered: renderedFrames, reusedSegments, renderedSegments: toRender.length,
      workers: runs.length, bytes: statSync(o.out).size,
    };
  } finally {
    release();
  }
}

// The browser driver answers SIGINT by closing Chrome and exiting, but SIGTERM and SIGHUP only close
// Chrome, which would leave this process waiting on pages that are gone.
const onSignal = (signal: NodeJS.Signals) => {
  killEncoders();
  process.exit(128 + (signal === 'SIGHUP' ? 1 : 15));
};

export async function render(argv: string[]): Promise<number> {
  const { values, positionals } = parseUsage('render', usage, argv);
  process.once('SIGTERM', onSignal);
  process.once('SIGHUP', onSignal);
  try {
    return await run(values, positionals);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
      console.error(usageLine('render', usage));
      return 2;
    }
    throw e;
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    // A browser that ignored its close would keep the process alive after the answer is printed.
    setTimeout(() => process.exit(), 20_000).unref();
  }
}

/**
 * What the page may read: its own directory, the working directory, and each --root. A directory
 * tooBroad() names is served only when a --root names it: the working directory is then left out, and
 * a page kept there is refused.
 */
export function pageRoots(page: string, extra: string[], o: { cwd?: string; home?: string } = {}): { roots: string[]; notes: string[] } {
  const home = o.home ?? homedir();
  const named = extra.map((r) => {
    const dir = resolve(r);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new UsageError(`--root ${r} is not a directory`);
    return dir;
  });
  const explicit = new Set(named.map(onDisk));
  const own = dirname(page);
  const wide = tooBroad(own, home);
  if (wide && !explicit.has(onDisk(own))) {
    throw new UsageError(`the page sits in ${own}, ${wide}, so every script on it could read the files beneath: `
      + `move the page into a folder of its own, or pass --root ${own} to serve that folder anyway`);
  }
  const roots = [own];
  const cwd = o.cwd ?? process.cwd();
  if (!tooBroad(cwd, home)) roots.push(cwd);
  const notes: string[] = [];
  for (const dir of named) {
    const why = tooBroad(dir, home);
    if (why) notes.push(`--root ${dir} is ${why}; every script on the page can read the files beneath it`);
    roots.push(dir);
  }
  return { roots, notes };
}

/**
 * A --chrome binary as the cache tells builds apart: its own version line and its size and date too,
 * since a desktop Chrome updates itself in place and on Windows prints no version at all.
 */
function browserBuild(chrome: string): string {
  const st = statSync(chrome);
  return `${probeVersion(chrome).banner || 'version unknown'} (${chrome}, ${st.size} bytes, modified ${st.mtime.toISOString()})`;
}

type Values = ReturnType<typeof parseUsage<typeof usage.flags>>['values'];

async function run(values: Values, positionals: string[]): Promise<number> {
  const started = Date.now();
  if (positionals.length !== 1) throw new UsageError('give exactly one page: openedit render <page.html> --out <file>');
  const page = resolve(positionals[0]);
  if (!existsSync(page) || !statSync(page).isFile()) throw new UsageError(`${positionals[0]} is not a file`);
  if (!values.out) throw new UsageError('give --out: the video file, or with --stills the directory for the PNGs');
  const out = resolve(values.out);

  const fps = asUsage(() => parseFps(values.fps ?? '30'));
  const posInt = (flag: 'frames' | 'width' | 'height' | 'workers') => asUsage(() =>
    values[flag] === undefined ? undefined : numberFlag(flag, values[flag], 1, (n) => Number.isInteger(n) && n > 0, 'a positive integer'));
  const seconds = (flag: 'duration' | 'segment' | 'from' | 'to') => asUsage(() =>
    values[flag] === undefined ? undefined : numberFlag(flag, values[flag], 1, (n) => Number.isFinite(n) && n >= 0, 'seconds'));
  const width = posInt('width');
  const height = posInt('height');
  const frames = posInt('frames');
  const duration = seconds('duration');
  const segmentSec = seconds('segment') ?? 2;
  const from = seconds('from');
  const to = seconds('to');
  const workers = posInt('workers') ?? defaultWorkers();
  if ((width === undefined) !== (height === undefined)) throw new UsageError('give --width and --height together');
  if (frames !== undefined && duration !== undefined) throw new UsageError('give --duration or --frames, not both');
  const total = frames ?? (duration !== undefined ? framesForDuration(duration, fps) : undefined);
  const transparent = values.transparent === true;
  const stillSpecs = (values.stills ?? []).flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);

  if (stillSpecs.length === 0 && values.sheet) throw new UsageError('--sheet tiles the --stills; give --stills too');
  if (stillSpecs.length && (from !== undefined || to !== undefined)) throw new UsageError('--from/--to patch a video; --stills renders no video');
  if (stillSpecs.length === 0) {
    if (total === undefined) throw new UsageError('give the length: --duration <sec> or --frames <n>');
    if (total < 1) throw new UsageError('the video would have no frames');
    const ext = extname(out).toLowerCase();
    if (transparent && ext !== '.mov') throw new UsageError('--transparent writes ProRes 4444 with alpha, which needs a .mov --out');
    if (!transparent && ext !== '.mp4' && ext !== '.mov') throw new UsageError('--out must end in .mp4 or .mov');
    if (segmentSec <= 0) throw new UsageError('--segment must be more than 0 seconds');
    const end = frameTime(total, fps);
    if (from !== undefined && from >= end) throw new UsageError(`--from ${from} is at or past the end (${end.toFixed(3)} s)`);
    if (from !== undefined && to !== undefined && to <= from) throw new UsageError('--to must be after --from');
  }
  if (width !== undefined && height !== undefined && !transparent && stillSpecs.length === 0 && (width % 2 || height % 2)) {
    throw new UsageError(`H.264 needs an even width and height; got ${width}x${height}`);
  }

  const { roots, notes } = pageRoots(page, values.root ?? []);
  for (const line of notes) say(line);

  const chrome = await resolveChrome(values.chrome, (line) => console.error(line));
  const server: PageServer = await startPageServer({ roots });
  let lead: RenderSession | null = null;
  const failedLoads = new Set<string>();
  let delivered = false;
  try {
    const base = { chrome, server, page, transparent, fps, seed: SEED, epoch: EPOCH, budgetMs: BUDGET_MS, failedLoads, refused: new Set<string>() };
    const opened = await openLead(base, width, height);
    lead = opened.lead;
    const canvas = opened.canvas;
    if (!transparent && stillSpecs.length === 0 && (canvas.width % 2 || canvas.height % 2)) {
      throw new UsageError(`the page's stage is ${canvas.width}x${canvas.height}; H.264 needs even sides: make them even, or pass --width/--height, which capture that much of the page from its top-left corner instead of the stage`);
    }

    if (stillSpecs.length) {
      const times = asUsage(() => stillSpecs.map(parseTimeSpec));
      const wanted = [...new Set(times.map((t) => frameAtTime(t, fps)))].sort((a, b) => a - b);
      const past = total === undefined ? [] : wanted.filter((f) => f >= total);
      if (past.length) throw new UsageError(`${past.length} still(s) lie past the end (${frameTime(total!, fps).toFixed(3)} s)`);
      const r = await renderStills({ base, canvas, lead, fps, frames: wanted, outDir: out, sheet: values.sheet, workers });
      const wall = (Date.now() - started) / 1000;
      console.log(`render: ${r.paths.length} still(s), ${canvas.width}x${canvas.height} at ${fpsLabel(fps)} fps → ${out}`);
      for (const p of r.paths) console.log(`  ${p}`);
      if (values.sheet) console.log(`  sheet: ${resolve(values.sheet)}`);
      console.log(`  wall ${wall.toFixed(1)} s, ${Math.round((wall * 1000) / r.paths.length)} ms/still, ${r.workers} worker(s)`);
      delivered = true;
      return 0;
    }

    const patch = from !== undefined || to !== undefined ? { from: from ?? 0, to: to ?? frameTime(total!, fps) } : null;
    const browser = values.chrome ? browserBuild(chrome) : `Chrome Headless Shell ${CHROME.version}`;
    const r = await renderVideo({
      base, canvas, lead, fps, page, browser, total: total!, segmentFrames: segmentFramesFor(segmentSec, fps), out, workers, patch,
    });
    const wall = (Date.now() - started) / 1000;
    const perFrame = r.rendered ? Math.round((wall * 1000) / r.rendered) : 0;
    console.log(`render: ${out}`);
    console.log(`  ${r.frames} frames at ${fpsLabel(fps)} fps = ${frameTime(r.frames, fps).toFixed(3)} s, ${canvas.width}x${canvas.height}, ${mb(r.bytes)}`);
    console.log(`  wall ${wall.toFixed(1)} s, ${perFrame} ms/frame over ${r.rendered} rendered frame(s), ${r.workers} worker(s), segments: ${r.renderedSegments} rendered, ${r.reusedSegments} reused`);
    delivered = true;
    return 0;
  } finally {
    warnLoads(failedLoads, delivered);
    await lead?.close();
    await server.close();
  }
}
