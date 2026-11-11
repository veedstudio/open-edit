// Text burned into a clip that reframe's crop would cut in half (old subtitles, a lower third), erased before the cut.
// The eraser is a fal model the agent runs, never this CLI. A part's input, what its fal run takes, is written only
// once the total for the parts is approved, so no run exists to make before the user said yes to its price.
// Here the clip is cut into parts the eraser takes; once every part is back, only the rows the text is in are taken
// from it and laid over the clip, so outside them every pixel and frame is the clip's own.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { CONVERTED, settledTags, stampColour } from '../colour.ts';
import { FFMPEG } from '../config.ts';
import { describeHdr, hdrKind, toSdr } from '../hdr.ts';
import { readJsonFile } from '../json-file.ts';
import { BT709, decodedColourOf, probeFrameRate, probeVideoSpan } from '../probe.ts';
import { createExclusive, writeAtomic } from '../providers/exclusive-files.ts';
import { asShown } from '../shown.ts';
import type { GraphicBox } from './page-script.ts';

/**
 * The eraser: a video editor told to remove the text, which keeps what is behind and around it (a face, a hand, the
 * furniture). A masked inpainter given the rows repaints everything in them, and invents what it cannot see.
 */
export const ERASER = 'fal-ai/kling-video/o3/pro/video-to-video/edit';
// Asked for every frame, to the last: asked only to remove "the subtitle text", it once left the last 8 s of a 10 s part.
export const ERASE_PROMPT = 'Remove every subtitle and caption (the lines of text drawn over the picture) from every frame of @Video1, '
  + 'from the first frame to the last, and fill their area with what is behind them. '
  + 'Keep everything else exactly the same: the people, their faces and lip movement, the camera, the lighting and the timing.';

// The eraser takes 3 to 15 s of video, 720 to 3840 px on a side. It is sent far less than 15 s: parts of 10 s came back
// with text left in one part of three, twice; parts of 4 to 5.5 s came back clean eight times of nine, the ninth with
// one half-second line left in it.
const LEAST_SEC = 3;
export const PART_SEC = 6;
const SHORT_SIDE = 720;
const LONG_SIDE = 3840;
// It hands back up to a third of a second less than it is sent (whole groups of 8 frames at 24 fps, and one more), so
// a part is sent with this much of what follows it.
const LEAD_SEC = 0.5;

/**
 * fal's price for the eraser, in US dollars per second of video. quoteOf counts the seconds sent: in every run measured they
 * round down to the same whole seconds as what came back, so which of the two fal bills is not known.
 */
export const ERASER_USD_PER_SEC = 0.168;

/**
 * What sending `parts` to the eraser is estimated to cost: the seconds billed, and those seconds at fal's price.
 * fal bills each run in whole seconds, rounded down: a part sent as 5.5 s is billed 5, and one of 3.5 s is billed 3.
 */
export function quoteOf(parts: { sent: number }[], fps: number): { seconds: number; usd: number } {
  const seconds = parts.reduce((sum, p) => sum + Math.floor(p.sent / fps + 1e-9), 0);
  return { seconds, usd: Math.round(seconds * ERASER_USD_PER_SEC * 100) / 100 };
}

/** What sending one of `parts` again as two halves is estimated to cost, for the costliest of them. */
export function resendQuote(parts: Part[], fps: number): { seconds: number; usd: number } {
  return parts.map((p) => {
    const h = Math.floor(p.frames / 2);
    return quoteOf([{ sent: sentFrames(h, fps) }, { sent: sentFrames(p.frames - h, fps) }], fps);
  }).reduce((a, b) => (b.usd > a.usd ? b : a), { seconds: 0, usd: 0 });
}

/** A price put to the user for some parts: its id binds those parts, that price and the prices approved before it. */
export interface Quote { id: string; usd: number; seconds: number; parts: string[] }

const QUOTE_FILE = /^quote-[0-9a-f]{8}\.json$/;
const quoteFile = (dir: string, id: string) => join(dir, `quote-${id}.json`);

/**
 * The price of `parts` as the next yes approves it. Each approval leaves a file of its own, and the id counts them, so a
 * price for the same parts put again, to run them again, never has the id of one approved before.
 */
export function quoteFor(dir: string, parts: ErasePlan['parts'], fps: number): Quote {
  const { seconds, usd } = quoteOf(parts, fps);
  const approved = readdirSync(dir).filter((n) => QUOTE_FILE.test(n)).length;
  const id = createHash('sha256').update(JSON.stringify([parts.map((p) => [p.name, p.first, p.frames, p.sent]), usd, approved])).digest('hex').slice(0, 8);
  return { id, usd, seconds, parts: parts.map((p) => p.name) };
}

/** Records `quote` approved: false when it was approved before, by an earlier call or one running beside this one. */
export const spendQuote = (dir: string, quote: Quote): boolean => createExclusive(quoteFile(dir, quote.id), quote);

/** Whether the quote `id` was approved already. */
export const quoteSpent = (dir: string, id: string): boolean => existsSync(quoteFile(dir, id));

// Rows kept around the text the search found, as a share of the frame's height: an outline or a shadow reaches past
// the sharp edges it finds, and the search sees the frame at a third of 1440 px or less.
const BAND_PAD = 0.02;

/** Rows to erase across the clip's whole width, in its display pixels, on even rows for 4:2:0. */
export interface Band { y: number; h: number }

/**
 * A crop as reframe plans it: where it stands along its axis over the clip, with the size and place across the axis of a
 * shot cut tighter where one is, and the graphics found on the clip.
 */
export interface CropPlan {
  crop: { w: number; h: number; axis: 'x' | 'y' };
  moves: { sec: number; at: number; zoom?: { w: number; h: number; cross: number } }[];
  graphics: GraphicBox[];
}

const moveAt = (moves: CropPlan['moves'], sec: number) => moves.reduce((at, m) => (m.sec <= sec ? m : at), moves[0]);

/**
 * The graphics the crop cuts: partly inside it and partly outside, as it stands when each comes up and at every move it
 * makes while it is up. One wholly inside shows whole, and one wholly outside does not show at all.
 */
export function cutGraphics(p: CropPlan): GraphicBox[] {
  if (!p.moves.length) return [];
  const x = p.crop.axis === 'x';
  return p.graphics.filter((g) => {
    const times = [g.from, ...p.moves.filter((m) => m.sec > g.from && m.sec < g.to).map((m) => m.sec)];
    return times.some((t) => {
      const { at, zoom } = moveAt(p.moves, t);
      // Each span a graphic must lie within: along the axis always, and across it only where a tighter crop leaves rows or columns out.
      const spans: [number, number, number, number][] = [x ? [g.x, g.x + g.w, at, zoom?.w ?? p.crop.w] : [g.y, g.y + g.h, at, zoom?.h ?? p.crop.h]];
      if (zoom) spans.push(x ? [g.y, g.y + g.h, zoom.cross, zoom.h] : [g.x, g.x + g.w, zoom.cross, zoom.w]);
      return spans.every(([a, b, lo, size]) => a < lo + size && b > lo) && spans.some(([a, b, lo, size]) => a < lo || b > lo + size);
    });
  });
}

/**
 * The rows to erase: those of the cut graphics, padded, joined where they meet, across the full width. Full width and
 * the whole clip, because the search finds a line of text only once it has held for a second and a half, often only
 * part of its width: a short subtitle in the same rows is missed, and the rows catch it anyway.
 */
export function bandsOf(cut: GraphicBox[], height: number): Band[] {
  const pad = Math.max(8, Math.round(BAND_PAD * height));
  const spans = cut.map((g) => [Math.max(0, g.y - pad), Math.min(height, g.y + g.h + pad)]).sort((a, b) => a[0] - b[0]);
  const joined: number[][] = [];
  for (const [a, b] of spans) {
    const last = joined.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else joined.push([a, b]);
  }
  return joined.map(([a, b]) => {
    const y = Math.floor(a / 2) * 2;
    return { y, h: Math.min(height - y, Math.ceil((b - y) / 2) * 2) };
  });
}

/** A part of the clip sent to the eraser: its first frame on the clip's frame grid, and how many. */
export interface Part { name: string; first: number; frames: number }

/** The clip's `frames` in parts of at most PART_SEC at `fps`, as equal as whole frames allow. */
export function eraserParts(frames: number, fps: number): Part[] {
  const most = Math.max(1, Math.floor(PART_SEC * fps));
  const n = Math.max(1, Math.ceil(frames / most));
  const edge = (i: number) => Math.round((i * frames) / n);
  return Array.from({ length: n }, (_, i) => ({ name: `part-${String(i + 1).padStart(3, '0')}`, first: edge(i), frames: edge(i + 1) - edge(i) }));
}

/** A part as sent: its own frames, then what follows (the clip's last frame repeated past its end), at least LEAST_SEC. */
export const sentFrames = (frames: number, fps: number): number => Math.max(frames + Math.ceil(LEAD_SEC * fps), Math.ceil(LEAST_SEC * fps));

/** The size a part is sent at: the clip's own, scaled up or down only as far as the eraser's sides need, on even pixels. */
export function sentSize(width: number, height: number): { width: number; height: number } {
  const k = Math.min(Math.max(1, SHORT_SIDE / Math.min(width, height)), LONG_SIDE / Math.max(width, height));
  const even = (v: number) => Math.max(2, Math.round((v * k) / 2) * 2);
  return k === 1 ? { width, height } : { width: even(width), height: even(height) };
}

/** What the folder an erase is prepared in holds, as plan.json records it. */
export interface ErasePlan {
  video: string;
  width: number;
  height: number;
  /** The clip's nominal frame rate (ffprobe's, e.g. 30000/1001): the parts are cut on its grid. */
  rate: string;
  /** Where the clip's first frame is on the clock ffmpeg's filters see, so the erased rows land on their own frames. */
  start: number;
  bands: Band[];
  model: string;
  parts: (Part & { sent: number; video: string; input: string; out: string })[];
}

const VIDEO = /\.(mp4|mov|webm|mkv|m4v)$/i;

/** The video the eraser wrote for a part, in the folder its fal run downloaded to, or null while there is none. */
export function erasedPart(out: string): string | null {
  let names: string[];
  try {
    names = readdirSync(out).filter((n) => VIDEO.test(n));
  } catch {
    return null;
  }
  const newest = names.map((n) => join(out, n)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  return newest ?? null;
}

/** The folder an erase for the clip reframe writes at `out` is prepared in: beside it, named for what it erases. */
export function eraseFolder(out: string, video: string, bands: Band[]): string {
  const st = statSync(video);
  const key = createHash('sha256').update(JSON.stringify([video, st.size, st.mtimeMs, bands, ERASER, ERASE_PROMPT])).digest('hex').slice(0, 8);
  return join(dirname(out), `${basename(out, extname(out))}.erase-${key}`);
}

const fail = (what: string, r: ReturnType<typeof spawnSync>) =>
  new Error(`ffmpeg could not ${what}: ${String(r.stderr ?? r.error ?? '').trim().split('\n').slice(-3).join(' ')}`);

/** The filters every picture of the erase goes through: upright, square pixels, SDR when it was HDR, then BT.709 in 4:2:0. */
function pictureChain(video: string, shown: { width: number; height: number; sar: number }, say: (line: string) => void): string[] {
  const colour = decodedColourOf(video);
  if (!hdrKind(colour)) return [...asShown(shown), ...stampColour(colour, settledTags(colour))];
  say(describeHdr(basename(video), colour));
  return [...asShown(shown), toSdr(colour, basename(video)), ...stampColour(CONVERTED, BT709)];
}

type Shown = { width: number; height: number; sar: number };
type SentPart = ErasePlan['parts'][number];

export const fpsOf = (rate: string): number => rate.split('/').map(Number).reduce((n, d) => n / d);

/**
 * Cuts `parts` of the plan's clip for the eraser into `dir`, then writes plan.json (the plan with them in place of
 * `replacing`), last, so a folder with plan.json holds every video it names. Their inputs wait for approveParts.
 * Cut in a folder of this attempt's own and moved in, so two runs at once never read each other's half-written files.
 */
function writeParts(plan: ErasePlan, parts: Part[], replacing: string[], shown: Shown, dir: string, say: (line: string) => void): ErasePlan {
  const fps = fpsOf(plan.rate);
  const size = sentSize(shown.width, shown.height);
  const chain = pictureChain(plan.video, shown, say);
  const sent: SentPart[] = parts.map((p) => ({
    ...p, sent: sentFrames(p.frames, fps), video: join(dir, `${p.name}.mp4`), input: join(dir, `${p.name}.json`), out: join(dir, p.name),
  }));
  mkdirSync(dir, { recursive: true });
  const work = mkdtempSync(join(dir, '.attempt-'));
  try {
    for (const p of sent) {
      // From half a frame before the part's first, so that frame is the first kept however the times round.
      const seek = p.first > 0 ? ['-ss', (plan.start + (p.first - 0.5) / fps).toFixed(6)] : [];
      const scale = size.width === shown.width ? [] : [`scale=${size.width}:${size.height}:flags=lanczos`, 'setsar=1'];
      // x264's output depends on its thread count, so it is fixed: a part cut again is the same bytes, and a fal run that
      // already bought it resumes it rather than buying it again.
      const r = spawnSync(FFMPEG, ['-nostdin', '-y', '-v', 'error', ...seek, '-i', plan.video, '-an', '-sn', '-dn',
        '-vf', [...chain, `fps=${plan.rate}`, ...scale, `tpad=stop_mode=clone:stop=${p.sent}`].join(','), '-frames:v', String(p.sent),
        '-c:v', 'libx264', '-crf', '17', '-preset', 'veryfast', '-threads', '4', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        join(work, `${p.name}.mp4`)], { encoding: 'utf8' });
      if (r.status !== 0) throw fail(`cut ${p.name} of ${plan.video}`, r);
    }
    for (const p of sent) renameSync(join(work, `${p.name}.mp4`), p.video);
    const kept = plan.parts.filter((p) => !replacing.includes(p.name));
    const out: ErasePlan = { ...plan, parts: [...kept, ...sent].sort((a, b) => a.first - b.first) };
    writeAtomic(join(dir, 'plan.json'), out);
    return out;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The parts `video` goes to the eraser in, each with the frames it is sent with, and the clip's frame rate. */
export function partsToErase(video: string): { parts: (Part & { sent: number })[]; fps: number; rate: string; start: number } {
  const { rate, fps } = probeFrameRate(video);
  const span = probeVideoSpan(video);
  const parts = eraserParts(Math.max(1, Math.round((span.end - span.start) * fps)), fps).map((p) => ({ ...p, sent: sentFrames(p.frames, fps) }));
  return { parts, fps, rate, start: span.start };
}

/** Cuts `video` into the eraser's parts in `dir`, and writes plan.json; or reads plan.json. */
export function prepareErase(video: string, shown: Shown, bands: Band[], dir: string, say: (line: string) => void = () => {}): ErasePlan {
  const plan = join(dir, 'plan.json');
  if (existsSync(plan)) return readJsonFile(plan) as ErasePlan;
  const { parts, rate, start } = partsToErase(video);
  const empty: ErasePlan = { video, width: shown.width, height: shown.height, rate, start, bands, model: ERASER, parts: [] };
  return writeParts(empty, parts, [], shown, dir, say);
}

/** Whether a part is long enough to cut in two and send again: 2 s or more. */
export const splittable = (part: Part, fps: number): boolean => part.frames >= 2 * fps;

/**
 * The plan with each part named cut in two and the halves written for the eraser, as new requests: for a part it handed
 * back with text left in. Shorter parts came back clean every time they were tried. A part under 2 s stays as it is.
 */
export function splitParts(plan: ErasePlan, names: string[], shown: Shown, dir: string, say: (line: string) => void = () => {}): ErasePlan {
  const split = plan.parts.filter((p) => names.includes(p.name) && splittable(p, fpsOf(plan.rate)));
  if (!split.length) return plan;
  const halves = split.flatMap((p) => {
    const h = Math.floor(p.frames / 2);
    return [{ name: `${p.name}a`, first: p.first, frames: h }, { name: `${p.name}b`, first: p.first + h, frames: p.frames - h }];
  });
  return writeParts(plan, halves, split.map((p) => p.name), shown, dir, say);
}

/** The parts the eraser has not written yet. */
export const missingParts = (plan: ErasePlan) => plan.parts.filter((p) => !erasedPart(p.out));

/** The parts whose price nobody has approved yet: they have no input for a fal run to take. */
export const unapproved = (parts: ErasePlan['parts']) => parts.filter((p) => !existsSync(p.input));

/** Writes each of `parts`' input for its fal run: what the approval of their price makes. */
export function approveParts(parts: ErasePlan['parts']): void {
  for (const p of parts) writeAtomic(p.input, { video_url: p.video, prompt: ERASE_PROMPT, keep_audio: false });
}

/** Writes the batch of fal runs for `parts`, approved under the quote `id`, in a file of that quote's own, and returns its path. */
export function writeJobs(parts: ErasePlan['parts'], dir: string, id: string): string {
  const jobs = join(dir, `jobs-${id}.json`);
  writeAtomic(jobs, parts.map((p) => ({ name: p.name, model: ERASER, input: readJsonFile(p.input) })));
  return jobs;
}

/**
 * The clip with the erased rows laid over it, at `to`, with its sound. Each part's erased video is placed by its own
 * times from the part's first frame (the eraser answers at a frame rate of its own, 24 fps, the same stretch of time),
 * brought to the clip's rate, and cut to the part's frames, the last held when it came back shorter. Outside the rows,
 * the picture is the clip's own.
 */
export function joinErased(plan: ErasePlan, shown: { width: number; height: number; sar: number }, to: string, say: (line: string) => void = () => {}): void {
  const { width: W, height: H, rate, parts, bands } = plan;
  const files = parts.map((p) => erasedPart(p.out)!);
  const per = `(${rate})`;
  const graph = [
    `[0:v]${pictureChain(plan.video, shown, say).join(',')}[base]`,
    ...parts.map((p, i) => `[${i + 1}:v]scale=${W}:${H},setsar=1,format=yuv420p,setpts=PTS-STARTPTS,fps=${rate},`
      + `tpad=stop_mode=clone:stop=${p.frames},trim=end_frame=${p.frames}[e${i}]`),
    // Half a frame early, so each frame of the clip meets its own erased frame however the times round.
    `${parts.map((_, i) => `[e${i}]`).join('')}concat=n=${parts.length}:v=1:a=0,setpts=N/${per}/TB+${plan.start}/TB-0.5/${per}/TB,`
      + `split=${bands.length}${bands.map((_, j) => `[s${j}]`).join('')}`,
    ...bands.map((b, j) => `[s${j}]crop=${W}:${b.h}:0:${b.y}[r${j}]`),
    // Past the last erased frame its rows are held rather than passed through, so the text never comes back at the end.
    ...bands.map((b, j) => `[${j === 0 ? 'base' : `o${j - 1}`}][r${j}]overlay=0:${b.y}:eof_action=repeat[${j === bands.length - 1 ? 'v' : `o${j}`}]`),
  ].join(';');
  const tmp = `${to}.${process.pid}.tmp${extname(to)}`;
  const r = spawnSync(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-i', plan.video, ...files.flatMap((f) => ['-i', f]),
    '-filter_complex', graph, '-map', '[v]', '-map', '0:a:0?', '-fps_mode', 'passthrough',
    '-c:v', 'libx264', '-crf', '17', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp],
  { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    rmSync(tmp, { force: true });
    throw fail(`lay the erased rows over ${plan.video}`, r);
  }
  renameSync(tmp, to);
}

/** The parts a stretch of the clip from `from` to `to` seconds lies in. */
export function partsOver(plan: ErasePlan, fps: number, from: number, to: number): ErasePlan['parts'] {
  const [a, b] = [(from - plan.start) * fps, (to - plan.start) * fps];
  return plan.parts.filter((p) => p.first < b && p.first + p.frames > a);
}
