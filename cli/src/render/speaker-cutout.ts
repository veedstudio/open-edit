// A cut-out of the speaker the CLI makes itself, for a page that lays a graphic behind the speaker and has none: only
// for the stretches of the clip a graphic is up for, so the cost follows those seconds and not the clip's length.
//
// It spends on whichever fal the environment has, so it runs only where the environment switches it on (CUTOUT_ENV).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { FAL_BG_REMOVAL_FAST_MODEL, FAL_BG_REMOVAL_FAST_UNITS } from '../commands/background-removal.ts';
import { runFalJobs } from '../commands/fal.ts';
import { notFacesOf, readFaces } from '../commands/faces.ts';
import { FFMPEG, runsDir } from '../config.ts';
import { clipFolder, ownFaces } from '../faces/folder.ts';
import type { FacesClip } from '../faces/page-script.ts';
import { hdrKind, sendable } from '../hdr.ts';
import { pictureDurationOf, probeSquareSize, probeVideoSpan, SDR_MATRICES } from '../probe.ts';
import { processAlive, tmpName, writeAtomic } from '../providers/exclusive-files.ts';
import { authHeaders, queueUrls, realHttp, REQUEST_TIMEOUT_MS, type Http } from '../providers/fal.ts';
import { FalCommandFailed, runFalCommand, type Runner } from '../providers/fal-command.ts';
import { falRoute, type FalRoute } from '../providers/fal-route.ts';
import { errorText } from '../proxy.ts';
import { runKeyOf } from '../resolve-video.ts';
import { shellArg } from '../shell-arg.ts';
import { asShown } from '../shown.ts';
import { concatList, countFrames, ffmpegInto } from './encode.ts';
import { probeFootage, seekArgs, type Footage } from './footage.ts';
import { sessionOptions, type Canvas, type SessionBase } from './lead.ts';
import { ALPHA_ENCODE, alphaInputOf, boundCache, contentId, markUsed, mediaCache } from './media.ts';
import type { MadeCutout, ReadyInfo } from './page-runtime.ts';
import type { PageServer } from './server.ts';
import { RenderSession } from './session.ts';
import { fpsLabel, type Fps } from './timing.ts';

export const CUTOUT_ENV = 'OPEN_EDIT_SPEAKER_CUTOUT';

/** Whether the environment has the automatic cut-out switched on; a value that says neither is a setting to fix. */
export function cutoutSwitchedOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const set = env[CUTOUT_ENV]?.trim().toLowerCase();
  if (!set || ['0', 'false', 'off', 'no'].includes(set)) return false;
  if (['1', 'true', 'on', 'yes'].includes(set)) return true;
  throw new Error(`${CUTOUT_ENV} is ${JSON.stringify(env[CUTOUT_ENV])}, which switches the automatic cut-out neither on (1) nor off (0): set it to one of the two, or unset it`);
}

// Bought either side of the frames a graphic is on, and never drawn there: a graphic moved by a few frames, or a page
// stepped at another rate, then finds its frames in what is kept and buys nothing.
export const PAD_SEC = 0.25;

// A stretch sent is at least this long, since what the model does with a few frames is not known.
export const SHORTEST_SEC = 1;

// The most one render buys, and the most a page may ask a cut-out for: a title or a caption behind the speaker for
// seconds, a few times in a piece. A page past either gets no cut-out, so no page can run up a bill or a file.
export const MOST_STRETCHES = 12;
export const MOST_SECONDS = 60;

// How long a stretch's answer is waited for: what the CLI's other fal requests wait.
export const WAIT_MS = 15 * 60_000;

// The largest answer taken: a minute of 1080p as the model writes it is under a tenth of this.
export const MOST_ANSWER_BYTES = 512e6;

// An answer whose matte covers less of the frame than this holds nobody to stand in front of anything.
export const LEAST_MATTE = 0.005;

/** Frames `from` up to, not including, `to`. */
export interface Run { from: number; to: number }

const frames = (runs: Run[]): number => runs.reduce((n, r) => n + r.to - r.from, 0);

/** The runs of consecutive frames in a list of frames in order. */
export function runsOf(on: number[]): Run[] {
  const runs: Run[] = [];
  for (const i of on) {
    const last = runs.at(-1);
    if (last && last.to === i) last.to++;
    else runs.push({ from: i, to: i + 1 });
  }
  return runs;
}

/** Runs in order, those that touch or overlap joined. */
export function merged(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of [...runs].filter((x) => x.to > x.from).sort((a, b) => a.from - b.from)) {
    const last = out.at(-1);
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
}

/** The clip's frame the speaker layer draws on page frame `i`, as the page's runtime finds it: the clip's first frame shows on page frame `footageAt`. */
export const clipFrameAt = (i: number, page: Fps, footageAt: number, clip: { fps: Fps; frames: number }): number =>
  Math.max(0, Math.min(clip.frames - 1, Math.floor((((i - footageAt) * page.den) / page.num + 1e-4) * (clip.fps.num / clip.fps.den))));

/** The clip's frames drawn while a graphic is on: for each run of page frames it is on (`on`, at `page` fps), the clip's frames from its first to its last. */
export function shownFor(on: Run[], page: Fps, footageAt: number, clip: { fps: Fps; frames: number }): Run[] {
  return merged(on.map((r) => ({ from: clipFrameAt(r.from, page, footageAt, clip), to: clipFrameAt(r.to - 1, page, footageAt, clip) + 1 })));
}

/** Runs with `pad` seconds more either side, inside a clip of `clip.frames` frames, joined where they then touch. */
export function padded(runs: Run[], clip: { fps: Fps; frames: number }, pad = PAD_SEC): Run[] {
  const more = Math.ceil((pad * clip.fps.num) / clip.fps.den - 1e-6);
  return merged(runs.map((r) => ({ from: Math.max(0, r.from - more), to: Math.min(clip.frames, r.to + more) })));
}

/** The frames of `wanted` that no run of `kept` holds. */
export function without(wanted: Run[], kept: Run[]): Run[] {
  const have = merged(kept);
  return merged(wanted).flatMap((w) => {
    const left: Run[] = [];
    let at = w.from;
    for (const k of have) {
      if (k.to <= at || k.from >= w.to) continue;
      if (k.from > at) left.push({ from: at, to: k.from });
      at = Math.max(at, k.to);
    }
    if (at < w.to) left.push({ from: at, to: w.to });
    return left;
  });
}

/** Each run made at least `least` frames long, about its middle, inside a clip of `total` frames; joined where they then touch. */
export function grown(runs: Run[], least: number, total: number): Run[] {
  return merged(runs.map((r) => {
    const short = Math.min(least, total) - (r.to - r.from);
    if (short <= 0) return r;
    const from = Math.max(0, Math.min(r.from - Math.floor(short / 2), total - Math.min(least, total)));
    return { from, to: from + Math.min(least, total) };
  }));
}

/** Why these runs are more than a cut-out is made of, or null when they are not: too many seconds, or, when they are to be bought, too many stretches. */
export function overCap(runs: Run[], fps: Fps, bought: boolean): string | null {
  const secs = (frames(runs) * fps.den) / fps.num;
  if (bought && runs.length > MOST_STRETCHES) return `the cut-out would be bought in ${runs.length} stretches, and at most ${MOST_STRETCHES} are bought for one render`;
  if (secs > MOST_SECONDS + 1e-9) {
    return bought ? `the cut-out would be bought for ${secs.toFixed(1)} s of the clip, and at most ${MOST_SECONDS} s are bought for one render`
      : `graphics are behind the speaker for ${secs.toFixed(1)} s of the clip, and a cut-out is made for at most ${MOST_SECONDS} s of a piece`;
  }
  return null;
}

/** What fal's result is expected to count for a request of `sent` frames, and its price at the listed rate: an estimate. */
export function estimateOf(sent: number[]): { units: number; usd: number } {
  const { usdPerUnit, framesPerUnit, refine } = FAL_BG_REMOVAL_FAST_UNITS;
  const units = sent.reduce((n, f) => n + Math.ceil((f * refine) / framesPerUnit - 1e-9), 0);
  return { units, usd: units * usdPerUnit };
}

/** What a kept stretch was made of and by: the clip by its content, as it is shown, and the model and its setting. */
interface MadeOf { clip: string; model: string; refine: boolean; fps: string; width: number; height: number }
interface Kept extends Run { file: string }

/** The name a stretch is kept under: for what it was made of and the clip's frames it holds, so it is its own record. */
const idOf = (of: MadeOf): string => createHash('sha256').update(JSON.stringify(of)).digest('hex').slice(0, 16);
const keptName = (of: MadeOf, r: Run): string => `stretch-${idOf(of)}-${r.from}-${r.to}.webm`;
/** Where it is recorded that the model's answer for a stretch was not a cut-out, so the stretch is not sent again. */
const rejectedName = (of: MadeOf, r: Run): string => `rejected-${idOf(of)}-${r.from}-${r.to}.json`;

/** The stretches kept in `folder` for this clip as its bytes are now, and how many are kept there for another. */
function keptIn(folder: string, now: MadeOf): { kept: Kept[]; others: number } {
  let names: string[] = [];
  try {
    names = readdirSync(folder);
  } catch {
    // No folder yet: nothing is kept.
  }
  const kept: Kept[] = [];
  let others = 0;
  for (const name of names) {
    const m = /^stretch-([0-9a-f]{16})-(\d+)-(\d+)\.webm$/.exec(name);
    if (!m) continue;
    if (m[1] === idOf(now) && Number(m[3]) > Number(m[2])) kept.push({ from: Number(m[2]), to: Number(m[3]), file: join(folder, name) });
    else others++;
  }
  return { kept: kept.sort((a, b) => a.from - b.from), others };
}

/** One part of a cut-out: frames `from` up to `to` of the clip, out of the kept stretch that starts at `keptFrom`. */
export interface Piece extends Run { file: string; keptFrom: number }

/** The parts of kept stretches that hold `wanted`, in order, or null when some frame of it is in none. */
export function covering(wanted: Run[], kept: Kept[]): Piece[] | null {
  const pieces: Piece[] = [];
  for (const w of merged(wanted)) {
    for (let at = w.from; at < w.to;) {
      // The stretch that carries on furthest from here, so a run is laid from as few as hold it.
      const best = kept.filter((k) => k.from <= at && k.to > at).sort((a, b) => b.to - a.to)[0];
      if (!best) return null;
      const to = Math.min(w.to, best.to);
      pieces.push({ from: at, to, file: best.file, keptFrom: best.from });
      at = to;
    }
  }
  return pieces;
}

/** The answer folders in `dir` of runs that are no longer running. */
function leftBehind(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => {
      const pid = /^(\d+)-[0-9a-f]{8}$/.exec(name)?.[1];
      return pid !== undefined && !processAlive(Number(pid));
    }).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** The model gave no cut-out for a stretch: it refused, failed, was not answered in time, or answered with something else. */
export class CutoutFailed extends Error {}

/** A stretch cut from the clip, ready to send. */
export interface Sent extends Run { name: string; file: string }
/** What came back for one: the cut-out's file, or why there is none. */
export type Answer = { file: string; requestId?: string; units?: number } | { failed: string };

export interface ModelRun {
  /** The clip's run folder, whose job ledger keeps a stretch from being bought twice. */
  runDir: string;
  /** Where each answer's files land, in a folder named for its stretch. */
  dir: string;
  route: Exclude<FalRoute, { how: 'none' }>;
  log: (line: string) => void;
  http?: Http;
  run?: Runner;
  sleep?: (ms: number) => Promise<void>;
  /** In place of WAIT_MS, for a test that cannot wait it out. */
  waitMs?: number;
}

const CUTOUT_FILE = /\.(webm|mov)$/i;

/**
 * Runs the model on each stretch and hands `take` what came back for each. Through the environment's fal command
 * they run in turn, each answer handed over before the next is asked for, and the first to fail stops the rest.
 */
export async function runModel(sent: Sent[], o: ModelRun, take: (index: number, answer: Answer) => void): Promise<void> {
  const input = (s: Sent) => ({ video_url: s.file, refine_foreground_edges: true });
  const waitMs = o.waitMs ?? WAIT_MS;
  if (o.route.how === 'key') {
    const key = o.route.key;
    const outcomes = await runFalJobs(sent.map((s) => ({ name: s.name, model: FAL_BG_REMOVAL_FAST_MODEL, input: input(s), bases: [], outDir: join(o.dir, s.name), largestBytes: MOST_ANSWER_BYTES })),
      { key, ledgerRoot: o.runDir, timeoutMs: waitMs, http: o.http, log: o.log, sleep: o.sleep });
    for (const [i, outcome] of outcomes.entries()) {
      const file = outcome.files?.find((f) => CUTOUT_FILE.test(f));
      if (outcome.error) take(i, { failed: outcome.error.split('\n')[0] });
      else if (!file) take(i, { failed: 'its answer held no video' });
      else take(i, { file, requestId: outcome.requestId, units: outcome.requestId ? await billableUnits(outcome.requestId, key, o.http) : undefined });
    }
    return;
  }
  let stopped = false;
  for (const [i, s] of sent.entries()) {
    if (stopped) {
      take(i, { failed: 'not asked for after the stretch before it failed' });
      continue;
    }
    let answer: Answer;
    try {
      const left = await runFalCommand({ fal: o.route.fal, model: FAL_BG_REMOVAL_FAST_MODEL, input: input(s), under: join(o.dir, s.name), waitMs, log: o.log, largest: MOST_ANSWER_BYTES, run: o.run });
      const file = left.files.find((f) => CUTOUT_FILE.test(f));
      answer = file ? { file, requestId: left.requestId } : {
        failed: 'the environment\'s fal command left no video in the folder it was given'
          + `${left.passedOver ? ` (${left.passedOver} thing(s) there are not a plain file of at most ${MOST_ANSWER_BYTES / 1e6} MB)` : ''}`,
      };
    } catch (e) {
      if (!(e instanceof FalCommandFailed)) throw e;
      answer = { failed: e.message };
    }
    stopped = 'failed' in answer;
    take(i, answer);
  }
}

/** The units fal's result says it bills a finished request by, read off the result itself; undefined when it says none. */
async function billableUnits(requestId: string, key: string, http: Http = realHttp(REQUEST_TIMEOUT_MS)): Promise<number | undefined> {
  try {
    const res = await http(queueUrls(FAL_BG_REMOVAL_FAST_MODEL, requestId).responseUrl, { method: 'GET', headers: authHeaders(key) });
    const units = Number(res.header?.('x-fal-billable-units'));
    return res.status < 300 && Number.isFinite(units) && units > 0 ? units : undefined;
  } catch {
    return undefined;
  }
}

/** What stands in for a part of making a cut-out, for a test. */
export interface CutoutDeps {
  env?: NodeJS.ProcessEnv;
  route?: typeof falRoute;
  model?: typeof runModel;
  http?: Http;
  run?: Runner;
  sleep?: (ms: number) => Promise<void>;
}

/** The cut-out laid for a page: its file, the clip's frames each of its stretches holds, and the kept files it is laid from. */
export interface Laid { file: string; stretches: MadeCutout['stretches']; pieces: Piece[] }

const seconds = (n: number, fps: Fps) => (n * fps.den) / fps.num;
const span = (r: Run, fps: Fps) => `${seconds(r.from, fps).toFixed(3)}-${seconds(r.to, fps).toFixed(3)} s`;
const spans = (runs: Run[], fps: Fps) => (runs.length > 4 ? `${runs.slice(0, 3).map((r) => span(r, fps)).join(', ')} and ${runs.length - 3} more` : runs.map((r) => span(r, fps)).join(', '));

/** Frames `run` of the clip as shown, upright and in square pixels, renumbered from zero: what the model is sent. */
async function cutStretch(clip: Footage, run: Run, out: string): Promise<void> {
  const chain = [...(clip.turned ? asShown(clip) : []), 'setpts=PTS-STARTPTS'].join(',');
  mkdirSync(dirname(out), { recursive: true });
  await ffmpegInto(tmpName(out), out, ['-v', 'error', '-y', ...seekArgs(run.from, clip.fps, clip.offset), '-i', clip.file, '-map', '0:v:0', '-an', '-vf', chain,
    '-frames:v', String(run.to - run.from), '-r', fpsLabel(clip.fps), '-fps_mode', 'cfr', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-f', 'mp4'], `could not cut ${span(run, clip.fps)} out of ${basename(clip.file)}`);
  const got = countFrames(out);
  if (got !== run.to - run.from) {
    rmSync(out, { force: true });
    throw new CutoutFailed(`${basename(clip.file)} gave ${got} frame(s) for ${span(run, clip.fps)}, not the ${run.to - run.from} it should hold`);
  }
}

/** The share of the frame a cut-out's matte covers, over every sixth of its frames. */
export function matteShare(file: string): number {
  const side = 64;
  const raw = execFileSync(FFMPEG, ['-v', 'error', ...alphaInputOf(file)!.args, '-i', file, '-vf', `select='not(mod(n\\,6))',alphaextract,scale=${side}:${side}:flags=area,format=gray`,
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  let on = 0;
  for (const a of raw) if (a >= 128) on++;
  return raw.length ? on / raw.length : 0;
}

/** Why an answer is not the cut-out of the stretch sent, or null when it is. */
export function notCutoutOf(file: string, sent: Run, size: { width: number; height: number }): string | null {
  try {
    if (!alphaInputOf(file)) return 'it has no alpha channel, so it does not say where the speaker is';
    const got = probeSquareSize(file);
    if (got.width !== size.width || got.height !== size.height) return `it is ${got.width}x${got.height}, and the stretch sent ${size.width}x${size.height}`;
    const count = countFrames(file);
    if (count !== sent.to - sent.from) return `it holds ${count} frame(s), and the stretch sent ${sent.to - sent.from}, so its frames would not line up with the clip's`;
    const share = matteShare(file);
    if (share < LEAST_MATTE) return `its matte covers ${(100 * share).toFixed(2)}% of the frame, so it holds nobody to stand in front of a graphic`;
    return null;
  } catch (e) {
    return `it could not be read as video (${errorText(e).split('\n')[0]})`;
  }
}

/**
 * The matrix a clip's picture is drawn by, as a file can name it: its own tag, else what players take an untagged
 * picture of its size to be; undefined for one a cut-out's file does not name.
 */
export function matrixOf(clip: Pick<Footage, 'matrix' | 'colour'>): string | undefined {
  const named = clip.matrix === 'auto' ? clip.colour.declared.space : clip.matrix === 'bt601' ? 'smpte170m' : clip.matrix;
  return named !== undefined && SDR_MATRICES.has(named) ? named : undefined;
}

/**
 * A file the media cache keeps under its own rules, made by `make` when it is not there or no longer holds `frames`
 * frames, as one cut short on disk would not; `named` is what it is made of.
 */
async function cached(named: unknown, frames: number, make: (out: string) => Promise<void>): Promise<string> {
  const dir = mediaCache();
  const path = join(dir, `${createHash('sha1').update(JSON.stringify(named)).digest('hex').slice(0, 20)}.webm`);
  const whole = () => {
    try {
      return countFrames(path) === frames;
    } catch {
      return false;
    }
  };
  if (markUsed(path) && whole()) return path;
  mkdirSync(dir, { recursive: true });
  await make(path);
  boundCache(dir, [path]);
  return path;
}

/** A kept stretch by its bytes, or by its name and size when it cannot be read at all. */
const idOfFile = (file: string): string => {
  try {
    return contentId(file, mediaCache());
  } catch {
    return `${file}:${statSync(file).size}`;
  }
};

/** A kept stretch could not be laid: it is not the video it was when it was kept. */
class Damaged extends Error {
  constructor(readonly file: string, why: string) {
    super(why);
  }
}

/**
 * One file of the kept stretches the pieces come from, each whole and all-intra, joined by copy, and where each
 * stretch's frames sit in it. Each is encoded alone, so the memory this takes is that of one, however many there are.
 */
async function lay(pieces: Piece[], fps: Fps, matrix: string | undefined, size: { width: number; height: number }): Promise<Laid> {
  const used = [...new Map(pieces.map((p) => [p.file, p.keptFrom])).keys()];
  const held = (file: string): Run => { const m = /-(\d+)-(\d+)\.webm$/.exec(file)!; return { from: Number(m[1]), to: Number(m[2]) }; };
  const length = (file: string) => held(file).to - held(file).from;
  // The model answers in the clip's own matrix and names none, and Chrome draws a cut-out that names none by BT.601:
  // unnamed, the speaker would change colour over footage drawn by BT.709.
  const named = matrix ? `,setparams=colorspace=${matrix}` : '';
  const parts: { file: string; frames: number }[] = [];
  for (const file of used) {
    const whole = await cached(['stretch', idOfFile(file), fpsLabel(fps), matrix ?? null, ALPHA_ENCODE], length(file), async (out) => {
      try {
        const input = alphaInputOf(file);
        if (!input) throw new Error('it has no alpha channel');
        const is = probeSquareSize(file);
        if (is.width !== size.width || is.height !== size.height) throw new Error(`it is ${is.width}x${is.height}, and the clip ${size.width}x${size.height}`);
        await ffmpegInto(tmpName(out), out, ['-v', 'error', '-y', ...input.args, '-i', file, '-vf', `settb=${fps.den}/${fps.num},setpts=N${named}`, ...ALPHA_ENCODE, '-f', 'webm'], 'ffmpeg could not read it');
        const got = countFrames(out);
        if (got !== length(file)) throw new Error(`it holds ${got} frame(s), not the ${length(file)} it was kept with`);
      } catch (e) {
        rmSync(out, { force: true });
        throw new Damaged(file, errorText(e).split('\n')[0]);
      }
    });
    parts.push({ file: whole, frames: length(file) });
  }
  // One stretch is its own file: nothing to join.
  const laid = parts.length === 1 ? parts[0].file : await cached(['laid', parts.map((p) => [basename(p.file), p.frames]), fpsLabel(fps)], parts.reduce((n, p) => n + p.frames, 0), async (out) => {
    const list = `${out}.${process.pid}-${randomBytes(3).toString('hex')}.txt`;
    writeFileSync(list, concatList(parts, fps));
    try {
      await ffmpegInto(tmpName(out), out, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-an', '-f', 'webm'], 'could not lay the speaker\'s cut-out together');
    } finally {
      rmSync(list, { force: true });
    }
    const [got, want] = [countFrames(out), parts.reduce((n, p) => n + p.frames, 0)];
    if (got !== want || !alphaInputOf(out)) {
      rmSync(out, { force: true });
      throw new CutoutFailed(`the cut-out laid together holds ${got} frame(s)${got === want ? ' and no alpha' : `, not ${want}`}`);
    }
  });
  let at = 0;
  // Every frame of each stretch is listed, its pad too: which of them are drawn is the page's frames to say.
  return { file: laid, pieces, stretches: used.map((file, i) => ({ ...held(file), at: (at += parts[i].frames) - parts[i].frames })) };
}

/**
 * The cut-out of the speaker for the clip's frames `shown`: from what is kept for the clip and, for the frames nothing
 * kept holds, from the model, said before the call that buys them. `none` is why there is none, in one line.
 */
export async function cutoutFor(clip: Footage, shown: Run[], say: (line: string) => void, deps: CutoutDeps = {}, within = clip.frames): Promise<{ laid: Laid } | { none: string }> {
  const folder = clipFolder(clip.file, 'cutout');
  const name = basename(clip.file);
  const size = { width: clip.width, height: clip.height };
  const now: MadeOf = { clip: contentId(clip.file, mediaCache()), model: FAL_BG_REMOVAL_FAST_MODEL, refine: true, fps: fpsLabel(clip.fps), ...size };
  let { kept, others } = keptIn(folder, now);
  if (others) say(`${others} stretch(es) of a cut-out kept in ${folder} are not used (not made for this clip as its bytes are now, or not as a cut-out is made now)`);
  const asked = overCap(merged(shown), clip.fps, false);
  if (asked) return { none: asked };
  // Padded and grown no further than the last frame of the clip the piece draws: past it, nothing would ever be shown.
  const buy = grown(padded(without(shown, kept), { fps: clip.fps, frames: within }), Math.ceil((SHORTEST_SEC * clip.fps.num) / clip.fps.den), within);
  if (!buy.length) {
    say(`the cut-out of the speaker for ${seconds(frames(merged(shown)), clip.fps).toFixed(1)} s of ${name} (${spans(merged(shown), clip.fps)}) is kept in ${folder}, so none is made`);
  } else {
    const over = overCap(buy, clip.fps, true);
    if (over) return { none: over };
    for (const r of buy) {
      const record = join(folder, rejectedName(now, r));
      if (!existsSync(record)) continue;
      let why = 'its answer was not a cut-out';
      try {
        why = String((JSON.parse(readFileSync(record, 'utf8')) as { why?: unknown }).why ?? why);
      } catch {
        // The record is there and unreadable: the stretch was still refused once.
      }
      return { none: `the model's answer for ${span(r, clip.fps)} was refused before (${why}), and the same stretch is not bought again while the clip and the model are the same: remove ${record} to send it again` };
    }
    const route = (deps.route ?? falRoute)(deps.env);
    if (route.how === 'none') return { none: route.why };
    const count = frames(buy);
    const estimate = estimateOf(buy.map((r) => r.to - r.from));
    const { usdPerUnit, framesPerUnit, refine } = FAL_BG_REMOVAL_FAST_UNITS;
    // Said before the call, since the call is where the fal account is charged.
    say(`making a cut-out of the speaker for ${seconds(count, clip.fps).toFixed(1)} s of ${name} (${count} frames in ${buy.length} stretch${buy.length > 1 ? 'es' : ''}: `
      + `${spans(buy, clip.fps)}) with ${FAL_BG_REMOVAL_FAST_MODEL}, `
      + `${route.how === 'key' ? 'on the fal account of the fal key this run reads, never on a VEED workspace'
        : 'through the fal command the environment gives in place of a key, which prices and approves it and bills as that environment arranges'}. `
      + `An estimate, not a charge: about $${estimate.usd.toFixed(4)} (${estimate.units} unit(s) at fal's listed $${usdPerUnit} per ${framesPerUnit} frames, `
      + `${refine} unit(s) per ${framesPerUnit} frames with edge refinement on, each stretch rounded up). Each answer is waited for up to ${WAIT_MS / 60_000} minutes`);
    const began = Date.now();
    const took = () => `${Math.round((Date.now() - began) / 1000)} s`;
    const sent: Sent[] = [];
    try {
      // An HDR clip is sent as the SDR copy a render shows, so the cut-out's edges are those of the picture under it.
      const source = hdrKind(clip.colour) ? probeFootage(sendable(clip.file, join(folder, 'sdr'), say)) : clip;
      for (const r of buy) {
        // Named for what it is cut from and kept until its answer is, so a run stopped mid-way sends the same bytes
        // again and the job ledger knows the request it already bought.
        const stretch = `${idOf(now)}-${r.from}-${r.to}`;
        const file = join(folder, 'sent', `${stretch}.mp4`);
        if (!existsSync(file)) await cutStretch(source, r, file);
        sent.push({ ...r, name: stretch, file });
      }
    } catch (e) {
      return { none: `${errorText(e).split('\n')[0]}, so no stretch was sent` };
    }
    // A folder of this attempt's own, so two runs after the same stretch never write each other's answer; removed
    // however this run ends, and one a killed run left is removed by the next.
    for (const left of leftBehind(join(folder, 'answers'))) rmSync(left, { recursive: true, force: true });
    const answersDir = join(folder, 'answers', `${process.pid}-${randomBytes(4).toString('hex')}`);
    const drop = () => rmSync(answersDir, { recursive: true, force: true });
    process.once('exit', drop);
    const failed: string[] = [];
    const take = (i: number, answer: Answer) => {
      const s = sent[i];
      if ('failed' in answer) return void failed.push(`${span(s, clip.fps)}: ${answer.failed}`);
      const why = notCutoutOf(answer.file, s, size);
      if (why !== null) {
        // Bought, and not a cut-out: recorded, so every later render and check does not buy the same answer again.
        writeAtomic(join(folder, rejectedName(now, s)), { why, at: new Date().toISOString(), ...(answer.requestId ? { requestId: answer.requestId } : {}) });
        return void failed.push(`${span(s, clip.fps)}: its answer is not used (${why}), and the stretch is not bought again while the clip and the model are the same`);
      }
      // Kept only once it is checked, and whole or not at all, under a name no other clip's stretch takes.
      const file = join(folder, keptName(now, s));
      const tmp = tmpName(file);
      copyFileSync(answer.file, tmp);
      renameSync(tmp, file);
      rmSync(s.file, { force: true });
      const billed = answer.units === undefined ? '' : `; fal's result counts ${answer.units} billable unit(s) for it, against ${estimateOf([s.to - s.from]).units} estimated`;
      say(`the cut-out of ${span(s, clip.fps)} came back in ${took()}${answer.requestId ? ` (request ${answer.requestId})` : ''} with the ${s.to - s.from} frame(s) sent${billed}; kept at ${file}`);
    };
    try {
      await (deps.model ?? runModel)(sent, { runDir: join(runsDir(), runKeyOf(clip.file)), dir: answersDir, route, log: say, http: deps.http, run: deps.run, sleep: deps.sleep }, take);
    } catch (e) {
      if (!(e instanceof CutoutFailed)) throw e;
      failed.push(e.message);
    } finally {
      drop();
      process.off('exit', drop);
    }
    // Read again, since another run may have kept meanwhile what this one could not get.
    ({ kept } = keptIn(folder, now));
    if (failed.length && !covering(shown, kept)) return { none: `the model gave no cut-out for ${failed.length} of ${sent.length} stretch(es) after ${took()} (${failed.join('; ')})` };
  }
  const pieces = covering(shown, kept);
  if (!pieces) return { none: `the stretches kept in ${folder} do not hold ${spans(merged(shown), clip.fps)}` };
  try {
    return { laid: await lay(pieces, clip.fps, matrixOf(clip), size) };
  } catch (e) {
    if (e instanceof Damaged) {
      rmSync(e.file, { force: true });
      return { none: `the kept stretch ${e.file} could not be read (${e.message}) and was removed, so the next run cuts it out again` };
    }
    if (e instanceof CutoutFailed) return { none: e.message };
    throw e;
  }
}

/**
 * The clip a page's speaker would be cut from, why there is none, or null when the page asks for no cut-out. A clip
 * the page names is taken only where its server would serve it, or a page could have a file it cannot read sent out.
 */
export async function askedBy(info: ReadyInfo, server: PageServer, footage: string | null): Promise<{ clip: string } | { why: string } | null> {
  if (info.cutout) {
    const named = server.fileFor(info.cutout.url);
    if (named === null || existsSync(named)) return null;
  }
  if (!info.behind || info.behind.graphics === 0) return null;
  if (footage) return { clip: footage };
  const files = new Set(info.behind.footage.map((urls) => urls.map((u) => server.fileFor(u)).find((f) => f !== null && existsSync(f)) ?? null));
  if (!files.size) return { why: 'its footage layer plays no video to cut the speaker from' };
  if (files.size > 1) return { why: `its footage layer plays ${files.size} videos, and the speaker is cut from one clip` };
  const [clip] = files;
  if (!clip) return { why: 'its footage layer\'s video is not a file on this machine' };
  const refused = await server.refusalOf(clip);
  return refused ? { why: `its footage layer's video ${clip} is one the page may not read (${refused.reason.toLowerCase()})` } : { clip };
}

/** Why a clip's frames cannot be told from its rate, or null when they can: a cut-out is laid on evenly timed frames. */
export function unevenlyTimed(clip: Pick<Footage, 'file' | 'fps' | 'frames'>, lasts = pictureDurationOf(clip.file)): string | null {
  const even = seconds(clip.frames, clip.fps);
  // A frame of slack and a hundredth of the length: a container's own rounding, and no more.
  if (Math.abs(even - lasts) <= Math.max(seconds(1, clip.fps), lasts / 100)) return null;
  return `${basename(clip.file)} holds ${clip.frames} frames in ${lasts.toFixed(3)} s, which is not its ${fpsLabel(clip.fps)} fps: its frames are unevenly timed, `
    + 'and a cut-out is laid on evenly timed frames. Make a copy at a constant frame rate the page\'s footage, or cut the speaker out with background-removal';
}

/** The shown runs with a face in them and those without, by the faces found on the clip; all of them where none were found for it. */
export function withFaces(shown: Run[], clip: Footage, faces: FacesClip | null): { kept: Run[]; empty: Run[] } {
  if (!faces) return { kept: shown, empty: [] };
  const samples = faces.shots.flatMap((s) => s.samples);
  const empty = shown.filter((r) => {
    const [from, to] = [seconds(r.from, clip.fps) - faces.every / 2, seconds(r.to, clip.fps) + faces.every / 2];
    const inside = samples.filter((x) => x.sec >= from && x.sec < to);
    return inside.length > 0 && inside.every((x) => x.faces.length === 0);
  });
  return { kept: shown.filter((r) => !empty.includes(r)), empty };
}

/** The faces `faces` found on this clip as it is now, or null when it has not run on it. */
function facesOf(clip: Footage): FacesClip | null {
  try {
    const path = ownFaces(clip.file);
    const found = path ? readFaces(path) : null;
    return found && !notFacesOf(found, clip.file, { width: clip.width, height: clip.height }, probeVideoSpan(clip.file).end) ? found : null;
  } catch {
    return null;
  }
}

// Whether a graphic behind the speaker is on screen now: one in the stage's behind layer that no opacity of 0 on it
// or above it rules out, and that has a visible box meeting the stage, its own or one inside it.
const GRAPHIC_ON = String.raw`(() => {
  const stage = document.querySelector('#stage') || document.querySelector('[data-stage]');
  if (!stage) return false;
  const s = stage.getBoundingClientRect();
  const lit = (el) => { for (let n = el; n; n = n.parentElement) if (parseFloat(getComputedStyle(n).opacity) === 0) return false; return true; };
  const meets = (r) => r.right > s.left && r.left < s.right && r.bottom > s.top && r.top < s.bottom;
  const boxed = (el) => [el, ...el.querySelectorAll('*')].some((n) => getComputedStyle(n).visibility === 'visible' && [...n.getClientRects()].some(meets));
  return [...stage.querySelectorAll(':scope > [data-layer="behind"] [data-behind]')].some((el) => lit(el) && boxed(el));
})()`;

/** A rule of its layers a stage breaks, and the page frame it is first broken on; null as the page loads. */
export interface Broken { frame: number | null; why: string }

/**
 * The page frames, of those `wanted`, in which a graphic behind the speaker is on screen; where the page set its
 * footage's time away from its own clock, if it did; and the first rule of its layers the stage breaks as it loads
 * or on a frame `drawn`, which ends the stepping. The page is stepped in a session that plays no footage.
 */
export async function graphicsOn(base: SessionBase, canvas: Canvas, wanted: number[], drawn: number[] = wanted): Promise<{ on: number[]; off: { at: number; time: number } | null; broken: Broken | null }> {
  const session = await RenderSession.open(sessionOptions({
    ...base, footage: null, videosIn: '[data-behind]', layers: null, cutout: undefined, shrunk: undefined, timings: undefined,
    failedLoads: new Set(), refused: new Set(), raised: undefined, boxed: undefined,
  }, canvas));
  try {
    const on: number[] = [];
    const loaded = await session.evaluate<string | null>('window.__openedit.stageRules()', 'reading the stage\'s layers');
    if (loaded) return { on, off: null, broken: { frame: null, why: loaded } };
    const looked = new Set(wanted);
    for (const i of [...new Set([...drawn, ...wanted])].sort((a, b) => a - b)) {
      await session.seek(i);
      const now = await session.evaluate<{ broken: string | null; on: boolean }>(
        `(() => { const broken = window.__openedit.stageRules(); return { broken, on: !broken && ${looked.has(i)} && ${GRAPHIC_ON} }; })()`,
        `frame ${i}: finding the graphics behind the speaker`);
      if (now.broken) return { on, off: null, broken: { frame: i, why: now.broken } };
      if (now.on) on.push(i);
    }
    return { on, off: await session.evaluate<{ at: number; time: number } | null>('window.__openedit.footageOff()', 'reading where the page put its footage'), broken: null };
  } finally {
    await session.close();
  }
}

export interface PageCutout {
  page: string;
  /** What the page's first session found on it. */
  info: ReadyInfo;
  server: PageServer;
  base: SessionBase;
  canvas: Canvas;
  /** The rate the page is stepped at; the clip's own when none is given. */
  fps?: Fps;
  /** The clip laid under the page (render --footage), which is then the one the speaker is cut from. */
  footage: string | null;
  /** When the clip's first frame shows, in seconds of the page's clock. */
  footageAt: number;
  /** The length of the page drawn, in seconds, when that is settled; else on to the clip's last frame. */
  until?: number;
  /** The page frames drawn, when they are not all of them (stills): the cut-out is found and made for these alone. */
  only?: number[];
  say: (line: string) => void;
  deps?: CutoutDeps;
}

/** A cut-out made for a page, served to it: what the speaker layer is given, what it is laid from, and the clip and rate it was made at. */
export interface Made { made: MadeCutout; laid: Laid; clip: Footage; fps: Fps; /** The page frame the clip's first frame shows on. */ first: number }

/**
 * The cut-out of the speaker for a page that lays a graphic behind the speaker and has none: null when the page does
 * not ask for one (askedBy), `none` with the reason when it asks and none is made, else the cut-out, admitted to
 * the page's server.
 */
export async function pageCutout(o: PageCutout): Promise<Made | { none: string } | null> {
  const asked = await askedBy(o.info, o.server, o.footage);
  if (!asked) return null;
  const by = 'clip' in asked ? shellArg(asked.clip) : '<clip>';
  if (!cutoutSwitchedOn(o.deps?.env)) {
    return { none: `the environment does not have the automatic cut-out switched on; npx @veedstudio/openedit-cli background-removal ${by} makes one to name on the stage (data-cutout="<file>")` };
  }
  if ('why' in asked) return { none: asked.why };
  let clip: Footage;
  try {
    clip = probeFootage(asked.clip);
    const uneven = unevenlyTimed(clip);
    if (uneven) return { none: uneven };
  } catch (e) {
    return { none: errorText(e).split('\n')[0] };
  }
  const fps = o.fps ?? clip.fps;
  const first = Math.round((o.footageAt * fps.num) / fps.den);
  const last = first + Math.ceil((clip.frames * clip.fps.den * fps.num) / (clip.fps.num * fps.den));
  const end = o.until === undefined ? last : Math.round((o.until * fps.num) / fps.den);
  // A footage that loops plays on past its last frame, where a cut-out, which runs once, has nothing to show.
  if (!o.footage && o.info.behind?.loops && end > last) return { none: `its footage loops past the clip's end, and a cut-out runs once from the clip's first frame` };
  const wanted = (o.only ?? Array.from({ length: Math.max(0, Math.min(end, last) - first) }, (_, k) => first + k)).filter((i) => i >= first && i < Math.min(end, last));
  if (!wanted.length) return { none: 'the footage is on screen in none of the frames drawn' };
  // Every frame drawn is read, the ones before and after the footage too: the layer holds the stage to its rules on each.
  const drawn = (o.only ?? Array.from({ length: Math.max(0, end) }, (_, k) => k)).filter((i) => i >= 0);
  const found = await graphicsOn({ ...o.base, fps }, o.canvas, wanted, drawn);
  // Nothing is made for a stage the layer would then refuse: the page is drawn as it is without one.
  if (found.broken) {
    const when = found.broken.frame === null ? 'as it loads' : `at ${seconds(found.broken.frame, fps).toFixed(3)} s`;
    return { none: `its stage does not keep to the layers a cut-out is laid in (${when}): ${found.broken.why}` };
  }
  if (!o.footage && found.off) {
    return { none: `the page sets its footage to ${found.off.time.toFixed(3)} s at ${found.off.at.toFixed(3)} s of its own clock, and a cut-out runs on the page's clock from the clip's first frame` };
  }
  if (!found.on.length) return { none: `no graphic behind the speaker is on screen in the ${wanted.length} frame(s) drawn over the footage` };
  // Each page frame's own frame of the clip, as the layer draws it: one run of the clip per run of the page.
  const frameOf = (i: number) => clipFrameAt(i, fps, first, clip);
  const faced = withFaces(shownFor(runsOf(found.on), fps, first, clip), clip, facesOf(clip));
  if (faced.empty.length) o.say(`no face is found in ${spans(faced.empty, clip.fps)} of ${basename(clip.file)}, so the speaker is not cut out there`);
  if (!faced.kept.length) return { none: `no face is found in ${basename(clip.file)} where a graphic is behind the speaker` };
  const on = found.on.filter((i) => faced.kept.some((r) => frameOf(i) >= r.from && frameOf(i) < r.to));
  const got = await cutoutFor(clip, faced.kept, o.say, o.deps, o.until === undefined ? clip.frames : frameOf(Math.min(end, last) - 1) + 1);
  if ('none' in got) return got;
  o.server.admit(got.laid.file);
  return { made: { url: o.server.urlFor(got.laid.file), num: clip.fps.num, den: clip.fps.den, stretches: got.laid.stretches, on: runsOf(on) }, laid: got.laid, clip, fps, first };
}

/**
 * What of a made cut-out page frames `from` up to `to` are drawn with: the kept stretches under them and the frames
 * each is drawn in, as a name; undefined when the cut-out is drawn in none of them.
 */
export function drawnWith(m: Made, from: number, to: number): string | undefined {
  const drawn = m.made.on.flatMap((r) => (r.to <= from || r.from >= to ? [] : [{ from: Math.max(r.from, from), to: Math.min(r.to, to) }]));
  if (!drawn.length) return undefined;
  const shown = shownFor(drawn, m.fps, m.first, m.clip);
  const files = m.laid.pieces.filter((p) => shown.some((r) => p.from < r.to && p.to > r.from)).map((p) => `${basename(p.file)}:${statSync(p.file).size}`);
  return createHash('sha1').update(JSON.stringify([m.made.num, m.made.den, drawn.map((r) => [r.from - from, r.to - from]), shown, files])).digest('hex').slice(0, 16);
}
