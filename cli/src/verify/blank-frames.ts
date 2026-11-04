// The blank-frames check: a flash, at most MAX_FLASH_FRAMES frames of one flat colour with a sharp change into and out
// of them, such as a page shows for one paint between two scenes; a blank stretch, frames with nothing at all on them
// held longer than BLANK_SECONDS; and a first frame that is blank, near-black or partway into a fade-in, since platforms
// show it as the cover. A flash may carry a caption, since a scene missing for a frame under its caption still flashes; a
// stretch must be empty, since a title held on a flat background is a design, not a gap.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { FFMPEG } from '../config.ts';
import { alphaInput } from '../probe.ts';
import type { CheckReport, ReviewContext } from './checks.ts';
import { TAIL_SECONDS } from './dead-tail.ts';
import { seconds as s } from './report.ts';

/** signalstats reads every pixel, so measuring a small copy keeps the pass near the cost of the decode alone. */
const SCAN_WIDTH = 256;

/**
 * Most of a frame is one flat colour when every plane's 10th-to-90th percentile band is this narrow, in 8-bit levels:
 * a few times what compression leaves on a flat colour, and blind to a caption over less than a tenth of the frame.
 */
const FLAT_LEVELS = 8;

/**
 * Nothing is on a frame when every plane's darkest-to-brightest range is this narrow: text at WCAG's 3:1 large-text
 * minimum differs from its background by about 40 levels or more on some plane, and compression keeps an empty frame
 * within a few.
 */
const BLANK_LEVELS = 12;

/**
 * A sharp change is a mean absolute difference this large between neighbouring frames on any plane. It doubles the
 * per-frame step of a linear one-second fade from white to black at 24 fps (9 levels), leaving room for easing, and
 * stays under what a black frame differs from any scene whose mean clears blackdetect's black threshold (22 levels up).
 */
const SHARP_LEVELS = 20;

/**
 * A flash lasts at most this many frames: a rate conversion under 2x repeats a stray frame at most once, as 24 to 30 fps
 * repeats one in four.
 */
const MAX_FLASH_FRAMES = 2;

/** However a variable-rate file times its frames, a flash lasts no longer than its frames would at 24 fps, film's rate. */
const SLOWEST_FPS = 24;

/** A dissolve's frame may sit this many levels outside its neighbours' means: compression moves a mean a level or so. */
const BLEND_SLACK = 2;

/** A blank stretch longer than the dead tail's limit is reported: nothing to see is held to the bar of nothing to hear. */
const BLANK_SECONDS = TAIL_SECONDS;

/**
 * A colour within this fraction of the range of black, its chroma within the same fraction of neutral, is named black,
 * as blackdetect's default reads black; white mirrors it.
 */
const NAMED_FRACTION = 0.1;

/**
 * A frame is near-black when no pixel is brighter than this fraction of the way from black to white, a dark grey, and no
 * plane spans more than this fraction of its range, so that as a cover it reads as black with no title, light or coloured.
 */
const NEAR_BLACK_FRACTION = 0.25;

/**
 * An opening is fading in while its mean luma climbs at least this many levels a second: a fade from black to a
 * mid-grey picture (110 levels) over seven seconds still climbs faster.
 */
export const FADE_RATE = 15;

/** The climb is measured over this many seconds ahead, so 8-bit steps and a frame a rate conversion repeats even out. */
const FADE_WINDOW = 0.25;

/**
 * A fade-in leaves a poor cover when its first frame, above black, is at most this fraction as bright as the frame it
 * ends on, in its mean and its brightest pixel alike: a title drawn at full brightness over the fade, or a picture
 * that brightens only a little as a title slides in over it, starts brighter.
 */
const FADE_START_FRACTION = 1 / 3;

/** The first this many findings are listed and the rest only counted: past a handful they share one cause to find. */
const LISTED = 5;

export type Planes = [number, number, number];

export type ColourName = 'white' | 'black';

export interface FrameLevels {
  /** Seconds on the picture's timeline: from the first frame. */
  sec: number;
  /** The widest 10th-to-90th percentile band of the three planes, in 8-bit levels. */
  band: number;
  /** The widest darkest-to-brightest range of the three planes. */
  range: number;
  /** The largest mean absolute difference from the frame before, over the three planes; signalstats gives the first frame 0. */
  change: number;
  /** Each plane's mean, Y, U and V. */
  mean: Planes;
  /** The middle of each plane's 10th-to-90th percentile band: on a flat frame, its colour, whatever a caption adds. */
  bandMiddle: Planes;
  /** The brightest pixel's luma. */
  lumaMax: number;
}

const PLANES = ['Y', 'U', 'V'] as const;
const perPlane = (f: (plane: string) => number) => PLANES.map(f) as Planes;

/** What ffmpeg's metadata filter prints after signalstats: `frame:N pts:P pts_time:T`, then that frame's keys. */
export function parseLevels(text: string): FrameLevels[] {
  const raw: { sec: number; keys: Map<string, number> }[] = [];
  for (const line of text.split('\n')) {
    const head = line.match(/^frame:(\d+)\s+pts:\S+\s+pts_time:(\S+)/);
    if (head) {
      const sec = Number(head[2]);
      if (!Number.isFinite(sec)) throw new Error(`ffmpeg gave frame ${head[1]} no time (pts_time:${head[2]})`);
      raw.push({ sec, keys: new Map() });
      continue;
    }
    const key = line.match(/^lavfi\.signalstats\.(\w+)=(\S+)/);
    if (key && raw.length) raw.at(-1)!.keys.set(key[1], Number(key[2]));
  }
  const origin = raw[0]?.sec ?? 0;
  return raw.map(({ sec, keys }) => {
    const get = (name: string) => {
      const value = keys.get(name);
      if (value === undefined || !Number.isFinite(value)) throw new Error(`signalstats printed no ${name} for the frame at ${sec}s`);
      return value;
    };
    return {
      sec: sec - origin,
      band: Math.max(...perPlane((p) => get(`${p}HIGH`) - get(`${p}LOW`))),
      range: Math.max(...perPlane((p) => get(`${p}MAX`) - get(`${p}MIN`))),
      change: Math.max(...perPlane((p) => get(`${p}DIF`))),
      mean: perPlane((p) => get(`${p}AVG`)),
      bandMiddle: perPlane((p) => (get(`${p}HIGH`) + get(`${p}LOW`)) / 2),
      lumaMax: get('YMAX'),
    };
  });
}

// Limited range before measuring, so a full-range render's white is 235 like everyone else's.
const levelsArgs = (video: string, seconds?: number) => ['-nostdin', '-v', 'error', ...(seconds === undefined ? [] : ['-t', String(seconds)]),
  '-i', video, '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', `scale=${SCAN_WIDTH}:-2:out_range=tv,format=yuv420p,signalstats,metadata=print:file=-`,
  '-f', 'null', '-'];
const LEVELS_OPTIONS = { encoding: 'utf8', maxBuffer: 1 << 30 } as const;

function levelsFrom(text: string, video: string): FrameLevels[] {
  const frames = parseLevels(text);
  if (!frames.length) throw new Error(`ffmpeg decoded no frames from ${video}`);
  return frames;
}

/** One decode of the picture at its own frame rate: every frame's levels. */
export function levelsIn(video: string): FrameLevels[] {
  return levelsFrom(execFileSync(FFMPEG, levelsArgs(video), { ...LEVELS_OPTIONS, stdio: ['ignore', 'pipe', 'pipe'] }), video);
}

/** The levels of the first `seconds` of the picture, without holding up anything else that runs meanwhile. */
export async function openingLevelsIn(video: string, seconds: number): Promise<FrameLevels[]> {
  return levelsFrom((await promisify(execFile)(FFMPEG, levelsArgs(video, seconds), LEVELS_OPTIONS)).stdout, video);
}

export interface Flash {
  start: number;
  frameCount: number;
  colour: ColourName | null;
  /** False when something small, such as a caption, is on the flat colour. */
  blank: boolean;
}

export interface Blank {
  start: number;
  end: number;
  /** The stretch's colour when it is white or black throughout. */
  colour: ColourName | null;
  /** True when the stretch changes from one flat colour to another. */
  mixed: boolean;
}

/** White or black when a colour is within NAMED_FRACTION of limited-range white or black; null for any other. */
export function colourName([y, u, v]: Planes): ColourName | null {
  const chromaSlack = (240 - 16) * NAMED_FRACTION;
  if (Math.abs(u - 128) > chromaSlack || Math.abs(v - 128) > chromaSlack) return null;
  const lumaSlack = (235 - 16) * NAMED_FRACTION;
  if (y >= 235 - lumaSlack) return 'white';
  if (y <= 16 + lumaSlack) return 'black';
  return null;
}

const isFlat = (f: FrameLevels) => f.band <= FLAT_LEVELS;
const isBlank = (f: FrameLevels) => f.range <= BLANK_LEVELS;
/** Two flat frames of one colour: as close on every plane as one frame's own spread may be. */
const sameColour = (a: FrameLevels, b: FrameLevels) => a.bandMiddle.every((m, p) => Math.abs(m - b.bandMiddle[p]) <= FLAT_LEVELS);

/** The median gap between frames, so a still that a variable-rate file holds as one long frame does not set it. */
function frameInterval(frames: FrameLevels[]): number {
  const gaps = frames.slice(1).map((f, i) => f.sec - frames[i].sec).sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
}

const between = (f: FrameLevels, a: FrameLevels, b: FrameLevels) => f.mean.every((m, p) =>
  m >= Math.min(a.mean[p], b.mean[p]) - BLEND_SLACK && m <= Math.max(a.mean[p], b.mean[p]) + BLEND_SLACK);
const shift = (a: FrameLevels, b: FrameLevels) => Math.max(...a.mean.map((m, p) => Math.abs(m - b.mean[p])));

/**
 * A run in the middle of a dissolve between two flat pictures: a mix's means lie between those of what it mixes, and a
 * mix of flat pictures moves every pixel alike, so on each side the change beyond the means' shift stays short of sharp.
 */
function isMix(run: FrameLevels[], before: FrameLevels, after: FrameLevels): boolean {
  return run.every((f) => between(f, before, after))
    && run[0].change - shift(before, run[0]) < SHARP_LEVELS
    && after.change - shift(run.at(-1)!, after) < SHARP_LEVELS;
}

/**
 * Runs of flat frames split from the rest at every sharp change, lasting no longer than MAX_FLASH_FRAMES frames do,
 * never the first or last run, which have one neighbour, and never a dissolve's middle. A fade of half a second or more
 * spreads its change too thin to open a run, and a cut opens one as long as the shot after it.
 */
export function findFlashes(frames: FrameLevels[]): Flash[] {
  const flashes: Flash[] = [];
  // Timed rather than counted, so a still a variable-rate file holds as one long frame is not a flash; half a frame's
  // give is for timestamps that jitter on a coarse time base.
  const longest = (MAX_FLASH_FRAMES + 0.5) * Math.min(frameInterval(frames), 1 / SLOWEST_FPS);
  let start = 0;
  for (let i = 1; i <= frames.length; i++) {
    if (i < frames.length && frames[i].change < SHARP_LEVELS) continue;
    const run = frames.slice(start, i);
    if (start > 0 && i < frames.length && frames[i].sec - run[0].sec <= longest
      && run.every(isFlat) && !isMix(run, frames[start - 1], frames[i])) {
      flashes.push({
        start: run[0].sec, frameCount: run.length, colour: colourName(run[0].bandMiddle), blank: run.every(isBlank),
      });
    }
    start = i;
  }
  return flashes;
}

/** Where the decoded frames end: the last one's start, and one usual gap. */
const decodedEndOf = (frames: FrameLevels[]) => (frames.at(-1)?.sec ?? 0) + frameInterval(frames);

/** A decode that stopped short of the probed length by more than a flash could fit in, past a frame's give. */
const stoppedShort = (frames: FrameLevels[], duration: number) =>
  duration - decodedEndOf(frames) > (MAX_FLASH_FRAMES + 1) * frameInterval(frames);

/** Where the picture ends: its probed length, never before its last frame does, and never past a decode that stopped. */
const pictureEndOf = (frames: FrameLevels[], duration: number) =>
  stoppedShort(frames, duration) ? decodedEndOf(frames) : Math.max(duration, decodedEndOf(frames));

/** Runs of frames with nothing on them, longer than BLANK_SECONDS; one open at the last frame runs to the picture's end. */
export function findBlanks(frames: FrameLevels[], duration: number): Blank[] {
  const blanks: Blank[] = [];
  const pictureEnd = pictureEndOf(frames, duration);
  let from: number | null = null;
  for (let i = 0; i <= frames.length; i++) {
    const blank = i < frames.length && isBlank(frames[i]);
    if (blank && from === null) from = i;
    if (blank || from === null) continue;
    const start = frames[from].sec;
    const end = i < frames.length ? frames[i].sec : pictureEnd;
    // In whole milliseconds: printed times are rounded, and a stretch of exactly a second must not read as longer.
    if (Math.round((end - start) * 1000) > BLANK_SECONDS * 1000) {
      const run = frames.slice(from, i);
      const mixed = !run.every((f) => sameColour(f, run[0]));
      blanks.push({ start, end, colour: mixed ? null : colourName(run[0].bandMiddle), mixed });
    }
    from = null;
  }
  return blanks;
}

export interface Opening {
  /** When the picture the video opens into is reached, on the picture's timeline. */
  until: number;
  /** A fade-in, or a cover held until a cut or until the picture otherwise shows. */
  fading: boolean;
  /** What the first frame is: blank, near-black, or only dimmed by the fade. */
  first: 'blank' | 'near-black' | 'dim';
  /** A blank first frame's colour. */
  colour: ColourName | null;
  /** The first frame's brightness above black, as a fraction of the frame a fade-in ends on. */
  fraction: number;
}

// Its colour also has to be as near neutral as black is named, so a flat dark blue is a colour, not near-black.
const isNearBlack = (f: FrameLevels) =>
  f.lumaMax <= 16 + (235 - 16) * NEAR_BLACK_FRACTION && f.range <= (240 - 16) * NEAR_BLACK_FRACTION
  && f.mean.slice(1).every((m) => Math.abs(m - 128) <= (240 - 16) * NAMED_FRACTION);
const brightness = (f: FrameLevels) => Math.max(0, f.mean[0] - 16);
const peak = (f: FrameLevels) => Math.max(0, f.lumaMax - 16);

/**
 * The frame a fade-in from frame `from` reaches: it walks on while the frames up to FADE_WINDOW ahead, short of any cut,
 * climb at FADE_RATE or faster, then takes the first frame of that last window within BLEND_SLACK of its brightest.
 */
function fadeEnd(frames: FrameLevels[], from: number): number {
  const ahead = (k: number) => {
    let j = k;
    while (j + 1 < frames.length && frames[j + 1].change < SHARP_LEVELS && frames[j + 1].sec - frames[k].sec <= FADE_WINDOW) j++;
    return j;
  };
  const climbing = (k: number, j: number) => j > k && (brightness(frames[j]) - brightness(frames[k])) / (frames[j].sec - frames[k].sec) >= FADE_RATE;
  let k = from;
  while (climbing(k, ahead(k))) k++;
  if (k === from) return from;
  const window = frames.slice(k, ahead(k) + 1);
  const top = Math.max(...window.map(brightness));
  return k + window.findIndex((f) => brightness(f) >= top - BLEND_SLACK);
}

/**
 * How the video opens when its first frame makes a poor cover: on a blank or near-black hold until the picture shows,
 * or on a fade-in, from the hold's last frame or the first, to a picture its first frame is a dim copy of. Null when it
 * opens on a picture.
 */
export function findOpening(frames: FrameLevels[], duration: number): Opening | null {
  const first = frames[0];
  const kind = isBlank(first) ? 'blank' : isNearBlack(first) ? 'near-black' : 'dim';
  const colour = kind === 'blank' ? colourName(first.bandMiddle) : null;
  // The hold: frames like the first, blank in its colour, and after a black or near-black one any near-black frame
  // too, so a fade from black starts where it leaves them and a card of another colour is a blank stretch of its own.
  const dark = kind === 'near-black' || colour === 'black';
  const holds = (f: FrameLevels) => (kind === 'blank' && isBlank(f) && sameColour(f, first)) || (dark && isNearBlack(f));
  let held = 0;
  while (held < frames.length && holds(frames[held])) held++;
  const from = Math.max(0, held - 1);
  const reached = frames[fadeEnd(frames, from)];
  const dimmed = (of: (f: FrameLevels) => number) => of(first) <= FADE_START_FRACTION * of(reached);
  const fading = reached !== frames[from] && dimmed(brightness) && dimmed(peak);
  if (!fading && kind === 'dim') return null;
  const until = fading ? reached.sec : held < frames.length ? frames[held].sec : pictureEndOf(frames, duration);
  const fraction = brightness(reached) > 0 ? brightness(first) / brightness(reached) : 0;
  return { until, fading, first: kind, colour, fraction };
}

const flatColour = (colour: ColourName | null) => (colour ? `flat ${colour}` : 'one flat colour');

function flashLine(f: Flash): string {
  const length = f.frameCount === 1 ? '1 frame' : `${f.frameCount} frames`;
  const onIt = f.blank ? 'with nothing on it' : 'with something small on it, such as a caption';
  return `a flash at ${s(f.start)}: ${length} of ${flatColour(f.colour)} ${onIt}, sharply unlike the frames either side`;
}

function openingLine(o: Opening): string {
  const blank = `${flatColour(o.colour)} with nothing on it`;
  let opens: string;
  if (o.fading) {
    const from = {
      'blank': `a first frame of ${blank}`,
      'near-black': 'a near-black first frame',
      'dim': `a first frame ${Math.round(100 * o.fraction)}% as bright as the frame the fade ends on`,
    }[o.first];
    opens = `opens fading in until ${s(o.until)}, from ${from}`;
  } else if (o.first === 'blank') {
    opens = `opens on ${blank} until ${s(o.until)}`;
  } else {
    opens = `opens near-black, nothing on it brighter than dark grey, until ${s(o.until)}`;
  }
  return `${opens}: platforms show the first frame as the cover`;
}

export function judgeBlankFrames(frames: FrameLevels[], duration: number): CheckReport {
  const opening = findOpening(frames, duration);
  const findings = [
    ...(opening ? [{ start: frames[0].sec, line: openingLine(opening) }] : []),
    ...findFlashes(frames).map((f) => ({ start: f.start, line: flashLine(f) })),
    // A blank stretch inside the opening is already reported, with how long it lasts.
    ...findBlanks(frames, duration).filter((b) => !opening || b.end > opening.until).map((b) => ({
      start: b.start,
      line: `blank from ${s(b.start)} to ${s(b.end)}: ${s(b.end - b.start)} of ` +
        (b.mixed ? 'flat colours with nothing on them' : `${flatColour(b.colour)} with nothing on it`),
    })),
  ].sort((a, b) => a.start - b.start);
  const skipped: string[] = [];
  // Named, so a decode that stopped early never reads as a full pass.
  if (stoppedShort(frames, duration)) {
    skipped.push(`the picture after ${s(decodedEndOf(frames))}: ffmpeg decoded no frame past it, though the video runs ` +
      `to ${s(duration)}`);
  }
  if (!findings.length) {
    return {
      verdict: 'pass',
      lines: [`opens on a picture, no flash, and nothing blank for longer than ${s(BLANK_SECONDS)}, in ${frames.length} frames`],
      skipped,
    };
  }
  const lines = findings.slice(0, LISTED).map((f) => f.line);
  if (findings.length > LISTED) lines.push(`and ${findings.length - LISTED} more, the last at ${s(findings.at(-1)!.start)}`);
  return { verdict: 'found', lines, skipped };
}

export function measureBlankFrames({ video, duration }: ReviewContext): CheckReport {
  // signalstats reads only the colour planes, so on a picture with an alpha channel it would measure what lies under
  // transparent pixels, which nobody sees once the picture is laid over something.
  if (alphaInput(video)) {
    const why = 'the picture has an alpha channel, so what shows through it depends on what it is laid over';
    return { verdict: 'skipped', lines: [], skipped: [`every frame: ${why}`] };
  }
  return judgeBlankFrames(levelsIn(video), duration);
}
