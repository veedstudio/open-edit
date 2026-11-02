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
import { assertConvertible, describeHdr, hdrKind, toSdr } from '../hdr.ts';
import { FFMPEG_PROBE, probeVersion } from '../platform.ts';
import { codecOf, colourTagsOf, NoVideoStream, type ColourReport } from '../probe.ts';
import { tilePath, tileSheet, withTileDir } from '../sheet.ts';
import { parseTimeSpec } from './frames.ts';
import { cropFor } from './reframe.ts';
import { CHROME, mb, resolveChrome } from '../render/browser.ts';
import { countFrames, encoderArgs, FULL_ENCODE, joinSegments, killEncoders, startSegmentEncoder, X264_PRESETS, type Encode } from '../render/encode.ts';
import { composeStill, gcd, overlayFor, probeFootage, sameRate, seekArgs, type Footage } from '../render/footage.ts';
import { alphaInputOf, longestGop, MAX_GOP, perVersion, seekableCopy, shownSize } from '../render/media.ts';
import { inspectPng, showsSomething } from '../render/png.ts';
import { onDisk, startPageServer, tooBroad, type PageServer } from '../render/server.ts';
import { BUDGET_MS, EPOCH, openLead, SEED, sessionOptions, UsageError, type Canvas, type SessionBase } from '../render/lead.ts';
import { CAPTURES, DRAW_EVERY_MS, DrawnLarger, drawnSize, newTimings, RenderSession, timed, type Capture, type Timings } from '../render/session.ts';
import {
  dropRecord, readSegmentText, recordPath, SAMPLE_MS, sampleAt, sampledFrames, sampleEvery, writeRecord, writeSegmentText, type TextSample,
} from '../render/text-record.ts';
import {
  fpsLabel, frameAtTime, frameSpan, frameTime, framesForDuration, parseFps, planSegments, segmentFramesFor,
  segmentsTouching, splitContiguous, splitFrames, workersFor, type Fps, type Segment,
} from '../render/timing.ts';

// A worker costs a Chrome launch, a page load and, unless the page is stateless, a preroll through every
// frame before its first: worth it for a dozen frames of a heavy page, where a patch is waiting on every
// one of them, but not for fewer.
export const MIN_FRAMES_PER_WORKER = 12;
// What --draft sets unless the flag is given: a quarter of the pixels, a lossy capture, the fastest encode.
const DRAFT = { scale: 0.5, capture: 'jpeg' as Capture, quality: 80, preset: 'ultrafast', crf: 28 };

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
    capture: { type: 'string', value: 'png|jpeg', help: 'What each frame leaves Chrome as (default png, the exact picture). jpeg is about half the capture time on a busy frame, at a small loss: Chrome stores its colour at half resolution (4:2:0) even at the quality 100 used. Opaque video only: not with --transparent, --footage or --stills' },
    draft: { type: 'boolean', help: `A quick look rather than the deliverable: --scale ${DRAFT.scale}, --capture ${DRAFT.capture} --quality ${DRAFT.quality}, --preset ${DRAFT.preset} --crf ${DRAFT.crf}, each unless given; --out must end in .draft.mp4 or .draft.mov (see Draft below)` },
    scale: { type: 'string', value: '<0.1-1>', help: 'Draw the frames at this fraction of the canvas, an odd side cropped to even for H.264 (default 1; 0.5 under --draft)' },
    quality: { type: 'string', value: '<1-100>', help: `With --capture jpeg: the JPEG's quality (default 100; ${DRAFT.quality} under --draft)` },
    preset: { type: 'string', value: '<x264 preset>', help: `x264's speed, ${X264_PRESETS[0]} to ${X264_PRESETS[X264_PRESETS.length - 1]} (default ${FULL_ENCODE.preset}; ${DRAFT.preset} under --draft); not with --transparent` },
    crf: { type: 'string', value: '<0-51>', help: `x264's quality, lower is better and larger (default ${FULL_ENCODE.crf}; ${DRAFT.crf} under --draft); not with --transparent` },
    footage: { type: 'string', value: '<file>', help: 'Lay the page, captured with alpha, over this clip in ffmpeg: full-stage footage from the first frame, with captions or graphics over it (see Footage below)' },
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
    'video.seeking, await its seeked event). Fonts, images and videos are loaded before the first frame. A local video with',
    'keyframes far apart is served from an all-intra copy, so every seek decodes a single frame. A copy of a video',
    'with alpha, such as a cut-out, is a VP9 WebM that keeps it, so what lies under it still shows (an HDR one,',
    'converted to SDR, does not); one with alpha Chrome cannot play (ProRes 4444, PNG or QTRLE in a .mov) is copied',
    'whatever its keyframes. A stage that names a cut-out (data-cutout="<file>") is drawn in layers: the page\'s',
    'footage, behind and front layers ([data-layer]) stacked in that order, and the cut-out in a layer of its own between',
    'behind and front, filling the stage on the page\'s clock from time 0 (see behind --help); a cut-out that cannot be',
    'played, or a layer or a data-behind graphic out of place, fails the render. A video the page shows',
    'smaller than its frame (its box and object-fit, as the page has loaded, put the picture at no more than two',
    'thirds of its width and height) is served from a copy at the shown size, keyframes far apart or not, so a seek',
    'decodes no more than is shown. A page that draws it larger, or a hidden one (no box, visibility hidden, opacity',
    '0), which may be drawn into a canvas at full size, gets a full-size copy, or none; a visible video drawn into a',
    'canvas larger than its own box shows the copy\'s picture scaled up, so give such a video its full box or hide',
    'it. One the page later draws larger than it showed it on load fails the frame it grows in, and the render is',
    'made again from full-size copies, at the cost of the time already spent. A copy is kept in <out>.render/media',
    'for later renders and patches, and a copy the page no longer plays or plays at another size is removed by the',
    'next video render to that --out. Stills keep theirs in <stills-dir>.render/media, which nothing prunes.',
    'Each worker steps the page through every earlier frame (without capturing them) before its own, so state a page',
    'builds as time passes matches a one-worker render, and the output is the same whatever --workers is; with a',
    '<video> on the page every one of those frames seeks it. A page that draws frame t from t alone (CSS and Web',
    'Animations running from load, GSAP, a window.__seek(t) that places everything from t) may say so with a',
    'data-stateless attribute on any element (the stage, say): its workers and stills then jump straight to their',
    'frames, and timers still fire in order at their virtual times. A counter, a rAF loop with state of its own, a',
    'simulation, or an animation the page starts partway through (it is dated from the frame it first appeared in)',
    'is state carried between frames; a page with any of those marked stateless renders differently per worker',
    'count, and nothing checks the mark.',
    'Footage: --footage <file> lays the page\'s frames over the clip in ffmpeg, from its first frame and unscaled in',
    'time, scaled to fill the canvas, whose shape it must have as shown: footage of another shape is refused with the',
    'reframe command that cuts it, so the page previews and places text over the picture the render shows. The page',
    'must not paint an opaque background (on html, body or the stage) over it. A <video> on the page that plays that',
    'file is stood down before the first frame (hidden, its source removed), so the same page previews in an ordinary',
    'browser and Chrome never decodes or seeks the footage here; the page may also leave the <video> out. The clip\'s',
    'frame rate must be --fps and it must run to the render\'s last frame; both are checked before anything starts.',
    'This is for footage that fills the stage from the first frame: a page that moves, times, crops or transforms its',
    'footage keeps its <video> and renders without --footage, which draws it as the page does. HDR (PQ/HLG) footage,',
    'under --footage or in a <video>, is converted to SDR BT.709, and a line says so.',
    'Cache: segments and a manifest live in <out>.render/. --from/--to re-renders the segments that overlap the range',
    '(plus any missing from the cache) with the same page, fps, size, length, segment length, transparency, capture,',
    'footage (its path, size and date), conversion of HDR videos, encoder settings, browser and ffmpeg, and rejoins',
    'by stream copy.',
    `Text: a video render also writes <out>.text.json for openedit review: the text the page draws in its HTML and SVG, read about`,
    `every ${SAMPLE_MS} ms of page time (a whole number of frames) on frames it captures anyway, with its words, its box and font`,
    'size in the video\'s pixels, its colour and its opacity. Each segment\'s text is cached beside it, so a patch reads again',
    'only the segments it renders again, and renders again, with a line saying so, a segment cached without its text.',
    'mux-audio carries the record to the file it writes.',
    'Capture: each frame leaves Chrome as a PNG, the exact picture, and on a page full of gradients, shadows and large',
    'text that capture is most of what a frame costs. --capture jpeg has Chrome write a JPEG instead, at quality 100,',
    'which is about half the capture time on such a frame. It is a loss, a small one: Chrome stores the JPEG\'s colour',
    'at half resolution (4:2:0), so the colour is resampled twice between the page and the H.264, which is 4:2:0',
    'anyway, and the picture is rounded once more on its way in. The JPEG\'s own colour space (BT.601, full range) is',
    'converted to the same BT.709 as the PNG path, so the two match to within a level. Not with --transparent or',
    '--footage, since a JPEG carries no alpha, and not with --stills, which are PNG files.',
    'Draft: --draft renders a quick look at the piece, not the deliverable: the frames are drawn at half the canvas',
    '(Chrome rasterises the page at that size, so the layout is the same and a quarter of the pixels are drawn), leave',
    'Chrome as JPEGs at quality 80, and are encoded with x264 ultrafast at CRF 28. Under --transparent or --footage the',
    'capture stays PNG, since those need the alpha. Each setting can be given on its own instead, with or without',
    '--draft: --scale, --capture, --quality, --preset, --crf; a lower --fps also cuts the frames to draw, at the cost',
    'of the page\'s motion. A draft\'s --out must end in .draft.mp4 or .draft.mov, so it never takes the place, or the',
    'cache, of the full render beside it. The cache records every one of these settings, so a patch keeps them.',
    'Fails, naming the cause, when Chrome does not start, the page server refuses a file the page needs (see Files),',
    'the page throws or rejects unhandled, a video never shows the picture a seek asked for, or every rendered frame',
    'is one flat colour (fully transparent with --transparent or --footage), a patch\'s range included where the render',
    'it patches drew, or under --footage every frame of a whole render is opaque, so the footage would never show; the',
    'output is then left as it was. Loads that fail, and videos that will not play, are listed as warnings, before the',
    'error when the render fails.',
    'Files: the page is served over loopback HTTP and reads files beneath its own directory, the working directory and',
    'each --root. The home directory, an ancestor of it and the filesystem root are served only when a --root names',
    'one: a working directory there is left out, and a page kept there is refused.',
    'Anything else, any hidden (dot) name, the CLI\'s own state and the fal key file are refused. A refused file fails',
    'the render, naming it and the --root that would let the page read it, or, when that folder is one of those above',
    'or a hidden one, saying it sits in a folder render does not serve. A refused fetch() or XMLHttpRequest is only a',
    'failed load, since the page sees the refusal and can handle it, as is a missing file beneath the roots; a path',
    'outside them is refused without being looked up, so a missing one is refused too.',
    `Output: H.264 yuv420p (CRF ${FULL_ENCODE.crf} unless --crf or --draft, BT.709, +faststart), or ProRes 4444 with alpha under --transparent; silent.`,
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
  /** A segment captured as JPEG is never spliced in beside ones captured as PNG, or the reverse. */
  capture: Capture;
  /** The size frames were drawn at, as a fraction of the canvas. */
  scale: number;
  /** A JPEG capture's quality; absent at 100, which every JPEG capture was before it was a choice. */
  quality?: number;
  /** The footage the segments were laid over, by path, size and mtime; absent when the page drew it all. */
  footage?: string;
  /** How the page's HDR videos were converted to SDR; absent when it plays none. */
  sdr?: string;
  /** How the page's videos with alpha were served; absent when it plays none, so an older cache is never spliced in. */
  alpha?: string;
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


const say = (line: string) => console.error(`render: ${line}`);
const pad = (n: number, w: number) => String(n).padStart(w, '0');

/**
 * Where the time went, as lines for the summary. Per-frame figures are what a frame cost on the worker
 * that drew it, summed over the stages a worker waits through in turn, so they add up to the pace of
 * one worker and not to the wall clock.
 */
export function breakdown(t: Timings, frames: number): string[] {
  if (!frames) return [];
  const per = (stage: keyof Timings) => `${Math.round(t[stage].ms / frames)} ms`;
  const sec = (stage: keyof Timings) => `${(t[stage].ms / 1000).toFixed(1)} s`;
  const lines = [`per frame on its worker: page ${per('page')}, capture ${per('capture')}, loads ${per('loads')}, encode wait ${per('encode')}`];
  const rest = [`Chrome: ${t.launch.n} launched in ${sec('launch')}, pages ready in ${sec('load')}`];
  if (t.preroll.n) rest.unshift(`preroll: ${t.preroll.n} earlier frame(s) stepped through in ${sec('preroll')} (${Math.round(t.preroll.ms / t.preroll.n)} ms/frame)`);
  if (t.text.n) rest.push(`text read on ${t.text.n} frame(s) in ${sec('text')} (${(t.text.ms / t.text.n).toFixed(1)} ms each)`);
  if (t.copy.n) rest.push(`all-intra copies ${sec('copy')}`);
  if (t.join.n) rest.push(`join ${sec('join')}`);
  // A frame's step ran past DRAW_EVERY_MS, slow or left undrawn; on every frame of a fast page, that would be Chrome
  // no longer drawing on its own.
  if (t.draw.n) rest.push(`${t.draw.n} draw(s) forced on frames slower than ${DRAW_EVERY_MS / 1000} s`);
  lines.push(rest.join('; '));
  return lines;
}

/** `f()`, with any error it throws turned into a usage error: it read a flag the user got wrong. */
function asUsage<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

/** The video's size: the frames as drawn, an odd side cropped to even for H.264 (ProRes keeps it). */
function videoSize(c: { width: number; height: number }, scale: number, transparent: boolean): { width: number; height: number } {
  const d = drawnSize(c, scale);
  return transparent ? d : { width: d.width - (d.width % 2), height: d.height - (d.height % 2) };
}

const firstLine = (e: unknown): string =>
  ((e as { stderr?: Buffer }).stderr?.toString().trim() || (e as Error).message).split('\n')[0];

/**
 * Serves an all-intra copy in place of every video the page plays that is long-GOP, or, when `shrink`,
 * drawn well below its own size (then at the drawn size, so a seek decodes no more than is shown), and
 * reloads the lead when what it loaded has changed: a copy swapped in, or, on the full-size attempt, the
 * smaller copies the first attempt served. Returns the copies in use and the URLs served from smaller ones.
 */
async function seekableVideos(lead: RenderSession, server: PageServer, dir: string, shrink: boolean): Promise<{ copies: string[]; shrunk: string[] }> {
  const copies: string[] = [];
  const shrunk: string[] = [];
  // The server swaps a file whatever URL names it (a fragment, a query), so the copy is sized for the
  // largest of a file's URLs, and one whose drawn size is unknown under any of them keeps it full size.
  const byFile = new Map<string, { video: RenderSession['info']['videos'][number]; urls: string[] }>();
  for (const video of lead.info.videos) {
    const file = server.fileFor(video.url);
    if (!file || !existsSync(file)) continue;
    const seen = byFile.get(file);
    if (!seen) {
      byFile.set(file, { video: { ...video }, urls: [video.url] });
      continue;
    }
    seen.urls.push(video.url);
    seen.video.scale = seen.video.scale === null || video.scale === null ? null : Math.max(seen.video.scale, video.scale);
  }
  // A picture with alpha Chrome has no decoder for (ProRes 4444, PNG or QTRLE in a .mov) plays from its copy.
  for (const url of lead.info.unplayable) {
    const file = server.fileFor(url);
    if (!file || byFile.has(file) || !existsSync(file) || !pictureColour(file) || alphaInputOf(file)?.webm !== false) continue;
    byFile.set(file, { video: { url, width: 0, height: 0, scale: null }, urls: [url] });
  }
  for (const [file, { video, urls }] of byFile) {
    // A copy an earlier attempt served is dropped unless this one makes it again.
    server.substitute(file, file);
    const name = basename(file);
    // An HDR video is always copied, whatever its keyframes: the copy is where it is converted, so Chrome
    // never tone-maps it its own way.
    const colour = pictureColour(file);
    const kind = colour && hdrKind(colour);
    const sdr = kind ? toSdr(colour!, name) : undefined;
    if (kind) say(describeHdr(name, colour!));
    let gop: number | null = null;
    try {
      gop = longestGop(file);
    } catch (e) {
      if (!kind) {
        say(`could not read the keyframes of ${name} (${firstLine(e)}); serving it as it is, so its seeks may be slow`);
        continue;
      }
    }
    const size = shrink ? shownSize(video, video.scale) : null;
    // Copied whatever its keyframes when Chrome cannot play its alpha as it is.
    const recoded = !kind && colour !== null && alphaInputOf(file)?.webm === false;
    if (!kind && !recoded && gop! <= MAX_GOP && !size) continue;
    const started = Date.now();
    const copy = await timed(lead.timings, 'copy', async () => seekableCopy(file, dir, size, sdr));
    if (copy.made) {
      const secs = `${((Date.now() - started) / 1000).toFixed(1)} s`;
      if (kind) say(`made an SDR copy of ${name}${size ? ` at ${size.width}x${size.height}` : ''} (it is HDR), all-intra for frame-exact seeks, in ${secs}`);
      else if (recoded) say(`made a VP9 copy of ${name} that keeps its alpha, since Chrome cannot play it as it is, in ${secs}`);
      else {
        const why = size
          ? `at ${size.width}x${size.height} (shown at that size; the source is ${video.width}x${video.height}${gop! > MAX_GOP ? `, with keyframes up to ${gop} frames apart` : ''})`
          : `(keyframes up to ${gop} frames apart)`;
        say(`made an all-intra copy of ${name} ${why} for frame-exact seeks in ${secs}`);
      }
    }
    server.substitute(file, copy.path);
    copies.push(copy.path);
    if (size) shrunk.push(...urls);
  }
  lead.serveShrunk(shrunk);
  if (copies.length || !shrink) await lead.reload();
  const cutout = lead.info.cutout;
  if (cutout && !cutout.playable) {
    const file = server.fileFor(cutout.url);
    let codec = '';
    try {
      if (file) codec = codecOf(file);
    } catch {
      // Not a video ffprobe can read: the refusal stands without naming a codec.
    }
    const hevc = codec === 'hevc' ? ': it is HEVC, whose alpha Chrome cannot draw here, so convert it to VP9 WebM or ProRes 4444' : '';
    throw new Error(`the speaker layer's cut-out ${file ?? cutout.url} could not be played, so it would not cover the graphics behind it${hevc}`);
  }
  return { copies, shrunk };
}

/** How the page's videos with alpha are served, as the cache records it; absent when it plays none. */
function pageAlpha(lead: RenderSession, server: PageServer): string | undefined {
  const files = [...lead.info.videos.map((v) => v.url), ...lead.info.unplayable].map((u) => server.fileFor(u)).filter((f): f is string => !!f && existsSync(f));
  return files.some((f) => pictureColour(f) !== null && alphaInputOf(f) !== null) ? 'alpha kept, in VP9 WebM copies where copied' : undefined;
}

/**
 * A page video's colour, or null for a file ffprobe finds no picture in, such as a sound played by a <video>,
 * or cannot read at all, which is served unconverted and said so.
 */
const pictureColour = perVersion((file): ColourReport | null => {
  try {
    return colourTagsOf(file);
  } catch (e) {
    if (!(e instanceof NoVideoStream)) say(`could not read the colour of ${basename(file)} (${(e as Error).message}); serving it unconverted`);
    return null;
  }
});

/** How the page's HDR videos are converted, as the cache records it; absent when the page plays none. */
function pageConversion(lead: RenderSession, server: PageServer): string | undefined {
  const chains = new Set<string>();
  for (const video of lead.info.videos) {
    const file = server.fileFor(video.url);
    if (!file || !existsSync(file)) continue;
    let colour: ColourReport;
    try {
      colour = colourTagsOf(file);
    } catch {
      continue; // seekableVideos says why, when it serves the file
    }
    if (hdrKind(colour)) chains.add(toSdr(colour, basename(file)));
  }
  return chains.size ? [...chains].sort().join('; ') : undefined;
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
    if (m.version !== 1 || !m.params || !Array.isArray(m.segments)) return null;
    // A manifest from before the capture was a choice was made when every capture was a PNG.
    m.params.capture ??= 'png';
    // And before the scale was, when every frame was drawn at the canvas's size.
    m.params.scale ??= 1;
    return m;
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
  // Both key sets: a setting the cached render had and this one lacks (its footage) is a difference too.
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])] as (keyof Params)[];
  return keys.filter((k) => a[k] !== b[k]).map((k) => `${k} ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`);
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
export async function runWorkers<T>(base: SessionBase, canvas: Canvas, lead: RenderSession, plan: WorkerPlan<T>): Promise<void> {
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
  base: SessionBase; canvas: Canvas; lead: RenderSession; fps: Fps; footage: Footage | null;
  frames: number[]; outDir: string; sheet?: string; workers: number; shrink: boolean;
}): Promise<{ paths: string[]; workers: number }> {
  mkdirSync(o.outDir, { recursive: true });
  // Every worker steps through the frames before its first still (unless the page is stateless), so a
  // long-GOP video pays one slow seek per earlier frame unless it is swapped for its all-intra copy
  // here too; a stateless page's one seek per still is fast only from the copy.
  const { shrunk } = await seekableVideos(o.lead, o.base.server, `${o.outDir}.render/media`, o.shrink);
  const groups = splitContiguous(o.frames, o.workers);
  const paths = new Map<number, string>();
  let drawn = false;
  await runWorkers({ ...o.base, shrunk }, o.canvas, o.lead, {
    groups,
    run: async (session, frame) => {
      const png = await session.capture(frame);
      if (!drawn && showsSomething(inspectPng(png))) drawn = true;
      const path = join(o.outDir, `f${pad(frame, 6)}-${frameTime(frame, o.fps).toFixed(3)}s.png`);
      writeFileSync(path, o.footage ? composeStill(o.footage, frame, o.fps, o.canvas, png) : png);
      paths.set(frame, path);
    },
  });
  const ordered = o.frames.map((f) => paths.get(f)!);
  // Over footage a moment with no caption is still footage: whether the page draws at all is the video render's to judge.
  if (!drawn && !o.footage) throw new Error(`every still is ${o.base.transparent ? 'fully transparent or ' : ''}one flat colour: the page drew nothing (stills kept in ${o.outDir})`);
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
  /** Why no record of the video's text was written; null when it was. */
  unread: string | null;
}

async function renderVideo(o: {
  base: SessionBase; canvas: Canvas; lead: RenderSession; fps: Fps; page: string; browser: string; transparent: boolean;
  footage: Footage | null; total: number; segmentFrames: number; out: string; workers: number; patch: { from: number; to: number } | null;
  shrink: boolean; x264: Encode;
}): Promise<VideoResult> {
  const { transparent, footage } = o;
  const capture = o.base.capture ?? 'png';
  const scale = o.base.scale ?? 1;
  // A scaled capture can leave an odd side, which is cropped off; an unscaled one is refused before.
  const x264: Encode = { ...o.x264, even: scale !== 1 };
  const ext = transparent ? 'mov' : 'mp4';
  // The footage is scaled to the frames as Chrome draws them, before an odd side is cropped off both.
  const overlay = footage ? overlayFor(footage, drawnSize(o.canvas, scale), o.fps) : null;
  const sdr = pageConversion(o.lead, o.base.server);
  const alpha = pageAlpha(o.lead, o.base.server);
  const cache = `${o.out}.render`;
  mkdirSync(cache, { recursive: true });
  const release = acquireLock(cache);
  try {
    const params: Params = {
      page: o.page, fps: fpsLabel(o.fps), width: o.canvas.width, height: o.canvas.height, frames: o.total,
      segmentFrames: o.segmentFrames, transparent, capture, scale, ...(capture === 'jpeg' && (o.base.quality ?? 100) !== 100 ? { quality: o.base.quality } : {}), ...(footage ? { footage: footage.identity } : {}),
      ...(sdr ? { sdr } : {}),
      ...(alpha ? { alpha } : {}),
      encoder: encoderArgs(transparent, capture, overlay, x264).join(' '),
      browser: o.browser, ffmpeg: probeVersion(FFMPEG, FFMPEG_PROBE).banner.replace(/\s+Copyright.*$/, ''),
    };
    const segments = planSegments(o.total, o.segmentFrames);
    const stemOf = (s: Segment) => join(cache, `seg-${pad(s.index, 5)}`);
    const fileOf = (s: Segment) => `${stemOf(s)}.${ext}`;
    const textOf = (s: Segment) => `${stemOf(s)}.text.json`;
    const every = sampleEvery(o.fps);
    const previous = readManifest(cache);
    let toRender: Segment[];
    let targeted: Set<number> | null = null;
    const sizes = new Map<number, number>();
    // The text each sampled frame shows: read as it is captured, and for a reused segment from the cache.
    const samples = new Map<number, TextSample>();

    if (o.patch) {
      if (!previous) throw new UsageError(`nothing to patch: ${cache} holds no finished render; render once without --from/--to first`);
      const differ = paramsDiffer(previous.params, params);
      if (differ.length) throw new UsageError(`the cached render was made differently (${differ.join('; ')}); a patch keeps every one of these, so render without --from/--to`);
      const span = frameSpan(o.patch.from, o.patch.to, o.fps, o.total);
      const inRange = new Set(segmentsTouching(segments, span.from, span.to).map((s) => s.index));
      targeted = inRange;
      const recorded = new Map(previous.segments.map((s) => [s.index, s.bytes]));
      const textless: string[] = [];
      for (const s of segments) {
        const f = fileOf(s);
        const ok = existsSync(f) && statSync(f).size === recorded.get(s.index);
        if (!ok || inRange.has(s.index)) continue;
        // A segment without usable cached text is rendered again, so the record of the whole video stays whole.
        const text = readSegmentText(textOf(s), s, every);
        if (!Array.isArray(text)) {
          textless.push(`${s.index} (${text.unusable})`);
          continue;
        }
        sizes.set(s.index, recorded.get(s.index)!);
        for (const sample of text) samples.set(sample.frame, sample);
      }
      if (textless.length) say(`also rendering segment(s) ${textless.join(', ')} outside --from/--to again, to record the text they show`);
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
    const { copies, shrunk } = await seekableVideos(o.lead, o.base.server, media, o.shrink);
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
    // A segment split between workers is kept as captured files, one per frame, and encoded in order
    // once every worker has finished.
    const spill = join(cache, `spill.${attempt}`);
    const spillDir = (seg: Segment) => join(spill, pad(seg.index, 5));
    const spillFrame = (dir: string, i: number) => join(dir, `f-${pad(i, 7)}.${capture}`);
    const shared = new Map<number, Segment>();
    const drew = new Set<number>();
    // Whether any frame let the footage through: a page that paints a background over it everywhere
    // would render captions over that background, and never the footage, with nothing else to say so.
    let letsThrough = !footage;
    let doneFrames = 0;
    let nextReport = 0.1;
    const progress = (frames: number) => {
      doneFrames += frames;
      if (doneFrames / renderedFrames >= nextReport && doneFrames < renderedFrames) {
        say(`${Math.floor((doneFrames / renderedFrames) * 100)}% (${doneFrames}/${renderedFrames} frames)`);
        nextReport = Math.floor((doneFrames / renderedFrames) * 10) / 10 + 0.1;
      }
    };
    // Why the page's text could not be read, once it could not: the render goes on without a record.
    let unread: string | null = null;
    /** A segment's samples, or null when a frame of it went unread. */
    const samplesOf = (seg: Segment): TextSample[] | null => {
      const taken = sampledFrames(seg, every).map((f) => samples.get(f));
      return taken.every((x) => x !== undefined) ? taken as TextSample[] : null;
    };
    const encode = async (seg: Segment, frames: AsyncIterable<Buffer> | Iterable<Buffer>) => {
      const tmp = `${stemOf(seg)}.${attempt}.tmp`;
      const under = footage && overlay ? { file: footage.file, seek: seekArgs(seg.start, o.fps, footage.offset), overlay, frames: seg.frames } : null;
      const enc = startSegmentEncoder(tmp, o.fps, transparent, capture, under, x264);
      try {
        for await (const frame of frames) await timed(o.base.timings, 'encode', () => enc.write(frame));
        await timed(o.base.timings, 'encode', () => enc.finish(), 0);
        // The old text goes first and the new comes last, so a failure in between leaves a segment with no text,
        // which a patch renders again, and never old text beside new pixels.
        rmSync(textOf(seg), { force: true });
        renameSync(tmp, fileOf(seg));
        sizes.set(seg.index, statSync(fileOf(seg)).size);
        const taken = samplesOf(seg);
        if (taken) writeSegmentText(textOf(seg), every, taken);
      } catch (e) {
        enc.kill();
        rmSync(tmp, { force: true });
        throw e;
      }
    };

    // Whether a frame draws, and whether it lets footage through, is read off its PNG. A JPEG would have
    // to be decoded to tell, so under --capture jpeg each frame is also captured as a PNG until its
    // segment is known to draw: a frame that draws ends that for its segment, and a flat one is the cheap
    // kind of PNG to capture.
    const look = async (session: RenderSession, shot: Buffer, i: number) =>
      inspectPng(capture === 'jpeg' ? await session.shoot(`frame ${i}`, 'png') : shot);

    try {
      await runWorkers({ ...o.base, shrunk }, o.canvas, o.lead, {
        groups: runs,
        run: async (session, piece, stop) => {
          const seg = piece.segment;
          async function* captured() {
            for (let i = piece.from; i < piece.to; i++) {
              if (stop()) throw new Error('stopped');
              const shot = await session.capture(i);
              if (i % every === 0 && unread === null) {
                try {
                  samples.set(i, sampleAt(i, o.fps, await session.readText()));
                } catch (e) {
                  // The record serves the review; a page whose text cannot be read still renders.
                  unread = firstLine(e);
                }
              }
              if (!drew.has(seg.index) || !letsThrough) {
                const seen = await look(session, shot, i);
                if (showsSomething(seen)) drew.add(seg.index);
                if (!seen.opaque) letsThrough = true;
              }
              yield shot;
            }
          }
          if (piece.from === seg.start && piece.to === seg.start + seg.frames) {
            await encode(seg, captured());
          } else {
            const dir = spillDir(seg);
            mkdirSync(dir, { recursive: true });
            let i = piece.from;
            for await (const shot of captured()) writeFileSync(spillFrame(dir, i++), shot);
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
    // Judged on the range asked for, not on segments outside it rendered again only for their text.
    const judged = targeted ? toRender.filter((s) => targeted!.has(s.index)) : toRender;
    const blank = renderedFrames > 0 && !judged.some((s) => drew.has(s.index));
    if (blank && (!o.patch || judged.some((s) => drewBefore.get(s.index) !== false))) {
      // The manifest still records the segments these replaced, so they must not stay in the cache.
      if (o.patch) {
        for (const s of toRender) {
          rmSync(fileOf(s), { force: true });
          rmSync(textOf(s), { force: true });
        }
      }
      const flat = `${o.base.transparent ? 'fully transparent or ' : ''}one flat colour`;
      throw new Error(o.patch
        ? `every re-rendered frame is ${flat} where the render it patches drew: the page drew nothing in the patched range; ${o.out} was left as it was. `
          + 'If the range is meant to be empty, render without --from/--to, which checks the whole video'
        : `every rendered frame is ${flat}: the page drew nothing; ${o.out} was left as it was`);
    }
    // Only a whole render is judged: a patched range may well be a card that covers the footage.
    if (!o.patch && renderedFrames > 0 && !letsThrough) {
      throw new Error(`every rendered frame is opaque, so the footage never shows: the page paints a background over it (on html, body or the stage); `
        + `make that transparent, or render without --footage if the page is meant to cover the footage; ${o.out} was left as it was`);
    }
    dropRecord(o.out);
    await timed(o.base.timings, 'join', async () => joinSegments(segments.map(fileOf), o.out));
    const counted = countFrames(o.out);
    if (counted !== o.total) throw new Error(`${o.out} holds ${counted} frames, expected ${o.total}; the segments in ${cache} do not add up`);
    const taken = segments.map(samplesOf);
    if (taken.every((x) => x !== null)) {
      const size = videoSize(o.canvas, scale, transparent);
      writeRecord(o.out, {
        page: o.page, width: size.width, height: size.height, fps: fpsLabel(o.fps), frames: o.total, transparent, framesPerSample: every,
        samples: taken.flat() as TextSample[],
      });
    }
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
      workers: runs.length, bytes: statSync(o.out).size, unread,
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
  const draft = values.draft === true;
  // A JPEG carries no alpha, so a draft that needs it keeps the PNG capture; stills are PNG files.
  const pngOnly = transparent || values.footage !== undefined || values.stills !== undefined;
  const scale = asUsage(() => numberFlag('scale', values.scale, draft ? DRAFT.scale : 1, (n) => n >= 0.1 && n <= 1, 'a fraction from 0.1 to 1'));
  const capture = (values.capture ?? (draft && !pngOnly ? DRAFT.capture : 'png')) as Capture;
  const quality = asUsage(() => numberFlag('quality', values.quality, draft ? DRAFT.quality : 100, (n) => Number.isInteger(n) && n >= 1 && n <= 100, 'an integer from 1 to 100'));
  const crf = asUsage(() => numberFlag('crf', values.crf, draft ? DRAFT.crf : FULL_ENCODE.crf, (n) => Number.isInteger(n) && n >= 0 && n <= 51, 'an integer from 0 to 51'));
  const preset = values.preset ?? (draft ? DRAFT.preset : FULL_ENCODE.preset);
  if (!(X264_PRESETS as readonly string[]).includes(preset)) throw new UsageError(`--preset must be one of ${X264_PRESETS.join(', ')}, not ${JSON.stringify(preset)}`);
  const x264: Encode = { preset, crf };
  if (!CAPTURES.includes(capture)) throw new UsageError(`--capture must be ${CAPTURES.join(' or ')}, not ${JSON.stringify(values.capture)}`);
  const stillSpecs = (values.stills ?? []).flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);
  let footage: Footage | null = null;
  if (values.footage !== undefined) {
    if (transparent) throw new UsageError('--footage lays the page over a clip, which has no alpha to keep; give --footage or --transparent, not both');
    const file = resolve(values.footage);
    if (!existsSync(file) || !statSync(file).isFile()) throw new UsageError(`--footage ${values.footage} is not a file`);
    footage = asUsage(() => probeFootage(file));
    if (!sameRate(footage.fps, fps)) {
      throw new UsageError(`the footage runs at ${fpsLabel(footage.fps)} fps and --fps is ${fpsLabel(fps)}: pass --fps ${fpsLabel(footage.fps)}, the footage's own rate, so its frames and the page's line up`);
    }
    if (hdrKind(footage.colour)) {
      assertConvertible(footage.colour, `the footage ${basename(file)}`);
      say(describeHdr(`the footage ${basename(file)}`, footage.colour));
    }
  }

  if (capture === 'jpeg' && transparent) throw new UsageError('--transparent keeps the page\'s alpha, which a JPEG cannot carry; leave --capture at png');
  if (capture === 'jpeg' && stillSpecs.length) throw new UsageError('--stills writes PNG files; --capture jpeg applies to a video');
  if (capture === 'jpeg' && footage) throw new UsageError('--footage lays the page over the clip by its alpha, which a JPEG cannot carry; leave --capture at png');
  if (stillSpecs.length) {
    const video = (['draft', 'scale', 'quality', 'crf', 'preset'] as const).filter((f) => values[f] !== undefined);
    if (video.length) throw new UsageError(`${video.map((f) => `--${f}`).join(', ')} shape${video.length === 1 ? 's' : ''} a video; --stills writes full-size PNGs`);
  }
  if (values.quality !== undefined && capture !== 'jpeg') {
    const alpha = transparent ? '--transparent' : footage ? '--footage' : null;
    throw new UsageError(alpha ? `--quality is a JPEG's quality, and ${alpha} captures PNG for the page's alpha; leave --quality out` : '--quality is a JPEG\'s quality; give --capture jpeg too');
  }
  if (transparent && (values.crf !== undefined || values.preset !== undefined)) throw new UsageError('--crf and --preset set the H.264 encode; --transparent writes ProRes 4444, which has neither');
  if (draft && stillSpecs.length === 0 && !/\.draft\.(mp4|mov)$/i.test(out)) {
    // The extension the render would take: .mov under --transparent, else the one given when it is one.
    const ext = transparent || extname(out).toLowerCase() === '.mov' ? '.mov' : '.mp4';
    throw new UsageError(`--draft writes a quick look, not the deliverable, so its --out must end in .draft${ext}, apart from the full render and its cache: `
      + `pass --out ${join(dirname(values.out), `${basename(out, extname(out))}.draft${ext}`)}`);
  }
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
    if (footage && footage.frames < total) {
      throw new UsageError(`the footage holds ${footage.frames} frames (${frameTime(footage.frames, fps).toFixed(3)} s at ${fpsLabel(fps)} fps) and the render is ${total} (${end.toFixed(3)} s): `
        + 'footage runs from the first frame to the last, so give a clip at least as long, or a shorter --duration/--frames');
    }
  }
  // A scaled capture is cropped to even sides after it is drawn, so only an unscaled one must be even.
  if (width !== undefined && height !== undefined && !transparent && stillSpecs.length === 0 && scale === 1 && (width % 2 || height % 2)) {
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
    const timings = newTimings();
    // Over footage the page is captured with alpha, like a transparent render, and composited by ffmpeg.
    const base = {
      chrome, server, page, transparent: transparent || footage !== null, capture, quality, scale, footage: footage?.file ?? null, fps, seed: SEED,
      epoch: EPOCH, budgetMs: BUDGET_MS, failedLoads, refused: new Set<string>(), timings,
    };
    const opened = await openLead(base, width, height);
    lead = opened.lead;
    const canvas = opened.canvas;
    if (!transparent && stillSpecs.length === 0 && scale === 1 && (canvas.width % 2 || canvas.height % 2)) {
      throw new UsageError(`the page's stage is ${canvas.width}x${canvas.height}; H.264 needs even sides: make them even, or pass --width/--height, which capture that much of the page from its top-left corner instead of the stage`);
    }
    const shrunkTo = videoSize(canvas, scale, transparent);
    if (stillSpecs.length === 0 && (shrunkTo.width < 2 || shrunkTo.height < 2)) {
      throw new UsageError(`--scale ${scale} leaves the ${canvas.width}x${canvas.height} canvas ${shrunkTo.width}x${shrunkTo.height}, and a video needs at least 2x2: give a larger --scale`);
    }
    // Cut here, the footage would show otherwise than in the page's preview and in faces.js, which place text
    // against the picture the page draws: the page's footage has to be the cut clip.
    if (footage && cropFor(footage.width, footage.height, canvas.width / canvas.height).travel > 0) {
      const g = gcd(canvas.width, canvas.height);
      throw new UsageError(`the footage ${basename(footage.file)} is ${footage.width}x${footage.height} as shown and the stage ${canvas.width}x${canvas.height}, another shape: `
        + `cut it to the stage's shape first with npx @veedstudio/openedit-cli reframe "${footage.file}" --aspect ${canvas.width / g}:${canvas.height / g} --out <file>, `
        + 'run faces on that file, and make it the page\'s footage (its <video> and --footage), so the preview, faces.js and the render show the same picture');
    }

    // A video the page shows smaller on load is served from a copy at that size. A page that later draws
    // it larger fails that frame, and the render is made once more from full-size copies.
    const sized = async <R>(go: (lead: RenderSession, shrink: boolean) => Promise<R>): Promise<R> => {
      try {
        return await go(lead!, true);
      } catch (e) {
        if (!(e instanceof DrawnLarger)) throw e;
        say(`${e.message}; rendering again from full-size copies`);
        lead = await RenderSession.open(sessionOptions(base, canvas));
        return go(lead, false);
      }
    };

    if (stillSpecs.length) {
      const times = asUsage(() => stillSpecs.map(parseTimeSpec));
      const wanted = [...new Set(times.map((t) => frameAtTime(t, fps)))].sort((a, b) => a - b);
      const past = total === undefined ? [] : wanted.filter((f) => f >= total);
      if (past.length) throw new UsageError(`${past.length} still(s) lie past the end (${frameTime(total!, fps).toFixed(3)} s)`);
      const beyond = footage ? wanted.filter((f) => f >= footage.frames) : [];
      if (beyond.length) {
        throw new UsageError(`${beyond.length} still(s) lie past the footage, which holds ${footage!.frames} frames (${frameTime(footage!.frames, fps).toFixed(3)} s at ${fpsLabel(fps)} fps)`);
      }
      const r = await sized((l, shrink) => renderStills({ base, canvas, lead: l, fps, footage, frames: wanted, outDir: out, sheet: values.sheet, workers, shrink }));
      const wall = (Date.now() - started) / 1000;
      console.log(`render: ${r.paths.length} still(s), ${canvas.width}x${canvas.height} at ${fpsLabel(fps)} fps → ${out}`);
      for (const p of r.paths) console.log(`  ${p}`);
      if (values.sheet) console.log(`  sheet: ${resolve(values.sheet)}`);
      console.log(`  wall ${wall.toFixed(1)} s, ${Math.round((wall * 1000) / r.paths.length)} ms/still, ${r.workers} worker(s)`);
      for (const line of breakdown(timings, r.paths.length)) console.log(`  ${line}`);
      delivered = true;
      return 0;
    }

    const patch = from !== undefined || to !== undefined ? { from: from ?? 0, to: to ?? frameTime(total!, fps) } : null;
    const browser = values.chrome ? browserBuild(chrome) : `Chrome Headless Shell ${CHROME.version}`;
    const r = await sized((l, shrink) => renderVideo({
      base, canvas, lead: l, fps, page, browser, transparent, footage, total: total!, segmentFrames: segmentFramesFor(segmentSec, fps), out, workers, patch, shrink, x264,
    }));
    const wall = (Date.now() - started) / 1000;
    const perFrame = r.rendered ? Math.round((wall * 1000) / r.rendered) : 0;
    console.log(`render: ${out}`);
    const size = videoSize(canvas, scale, transparent);
    const drawn = scale === 1 ? `${canvas.width}x${canvas.height}` : `${size.width}x${size.height} (the ${canvas.width}x${canvas.height} canvas at ${scale})`;
    console.log(`  ${r.frames} frames at ${fpsLabel(fps)} fps = ${frameTime(r.frames, fps).toFixed(3)} s, ${drawn}, ${mb(r.bytes)}`);
    if (draft) console.log(`  draft: ${capture}${capture === 'jpeg' ? ` q${quality}` : ''} capture, ${transparent ? 'ProRes' : `x264 ${preset} CRF ${crf}`}; render without --draft for the deliverable`);
    console.log(`  wall ${wall.toFixed(1)} s, ${perFrame} ms/frame over ${r.rendered} rendered frame(s), ${r.workers} worker(s), segments: ${r.renderedSegments} rendered, ${r.reusedSegments} reused`);
    for (const line of breakdown(timings, r.rendered)) console.log(`  ${line}`);
    console.log(r.unread === null
      ? `  on-screen text: ${recordPath(out)}, for openedit review`
      : `  on-screen text: not recorded, since the page's text could not be read (${r.unread}); openedit review skips the checks that need it`);
    delivered = true;
    return 0;
  } finally {
    warnLoads(failedLoads, delivered);
    await lead?.close();
    await server.close();
  }
}
