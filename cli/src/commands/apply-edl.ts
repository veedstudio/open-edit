// Assemble an EDL's kept ranges into one file. An EDL (edit decision list) is the list of source intervals to
// keep, in order, each at its own speed and grade.
//
//   openedit apply-edl --edl <edl.json> --out <cut.mp4> [--crossfade 40] [--crf 20] [--fit crop|letterbox] [--keep-levels]
//
// Each range's picture is encoded on its own into `<cut>.ranges/`, under a name made of everything that went into
// it, so a run that changes one range encodes that range alone and stream-copies the rest into the join. The sound
// is cut afresh on every run in the join's one pass: decoding sound is cheap, and every join is crossfaded over
// sound from beyond its out-point, since a butt join clicks.
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { numberFlag, parseUsage, usageLine, type Usage } from '../args.ts';
import { joinColour } from '../colour.ts';
import { FFMPEG } from '../config.ts';
import {
  END_FRAMES, STRETCHED_SPEEDS, framesOf, loadEdl, locate, playedLength, relocated, snapRanges, soundOf, sourceOrder, sourcePath, stretchOf,
  type LoadedEdl, type SnappedRange,
} from '../edl.ts';
import { boxesOwner, facesFolder, ownFaces, sameFile } from '../faces/folder.ts';
import { facesOnCut, type CutPicture, type RangeOnCut } from '../faces/onto-cut.ts';
import { facesScript, type FacesClip } from '../faces/page-script.ts';
import { describeGrade, gradeFilters, mergeGrade, type Grade } from '../grade.ts';
import { describeHdr, filterPath, hdrKind, toSdr, yuvMatrix } from '../hdr.ts';
import { FFMPEG_PROBE, probeVersion } from '../platform.ts';
import {
  audioDurationOf, decodedColourOf, hasAudioStream, probeFrameRate, probeSquareSize, probeVideoSpan, videoDurationOf,
  type ColourReport, type ColourTags, type Display,
} from '../probe.ts';
import { writeAtomic, writeTextAtomic } from '../providers/exclusive-files.ts';
import { countFrames } from '../render/encode.ts';
import { asShown } from '../shown.ts';
import { ChangeReader, changesIn, quietStillsOf, scanFilter, scanSize, STILL_SECONDS, type Span } from '../stillness.ts';
import { mappedNote, readTranscriptFile } from '../transcript/read-transcript.ts';
import { transcriptPathFor, wordCount } from '../transcript/transcript-cache.ts';
import type { Transcript } from '../transcript/transcript-types.ts';
import { soundGateOf, soundIn, TAIL_SECONDS, WINDOW_MS, type Sound } from '../verify/dead-tail.ts';
import { lengthAgainstBrief } from '../verify/length.ts';
import { seconds as inSeconds } from '../verify/report.ts';
import { notFacesOf, readFaces } from './faces.ts';
import { momentaryOf, speakingLoudness } from './mix-audio.ts';
import { cropFor, describeShape, parseFit, placeAt, planShape, shapeChain, type Fit, type Shaping } from './reframe.ts';
import { droppedNote, relocatedTranscripts, retime, transcriptPathsOf } from './retime-transcript.ts';

const seconds = (t: number) => t.toFixed(6);
const AUDIO_RATE = 48000;
/**
 * x264's settings for every range, which its cache name carries. The profile is left to x264: the same settings
 * pick the same one for every range, and --crf 0 needs one that a pinned High would refuse.
 */
const encodeArgs = (crf: number) => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p'];
/** minterpolate as a slow-motion pass: motion-compensated, both directions searched, block edges smoothed. */
const INTERPOLATE = 'mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1';
/**
 * Ranges encoded at once, one per CPU up to four: minterpolate and much of a decode run on one thread, so even at 4K
 * one range leaves CPUs idle, and four 4K ranges hold about 5 GB.
 */
const encodeWorkers = (cpus = availableParallelism()): number => Math.max(1, Math.min(4, cpus));

/**
 * Where each range's input is opened: every range is its OWN input, seeked to a whole second at least
 * one second before it starts. The seek is coarse on purpose: the graph's trim defines the edge, and
 * the second of margin keeps that edge inside what was decoded.
 */
export function inputSeeks(ranges: SnappedRange[]): number[] {
  return ranges.map((range) => Math.max(0, Math.floor(range.start) - 1));
}

/**
 * One range's picture, from its own input opened at `seek`, onto the canvas, graded and at its speed.
 *
 * The range arrives snapped to its source's frame grid, so it keeps a whole number of frames, and a range from a
 * source at another rate is brought to the cut's (`rate`) by the same `fps` filter. The trim edges
 * sit half a frame before those instants: a frame's timestamp can land a few microseconds either side of k/fps
 * once rounded to the container's timebase, and a boundary exactly on it would keep or drop that frame by luck.
 *
 * An HDR source's range (`hdr`) is converted to SDR before it is scaled, so it is scaled as the SDR BT.709
 * picture it joins. `shape` cuts the range to the canvas's shape after its conversion, on the range's own clock;
 * what even pixels leave, `fit` crop covers and letterbox pads. The grade's tone runs before the speed change,
 * on the frames the source has, and its grain after, on the frames the cut plays. At another speed the frames
 * are stretched by played/kept and laid on the output's grid, by repeating or dropping frames or, interpolated,
 * by drawing new ones, and the encode stops at the count the range plays. `stamp` (joinColour's for the range's
 * source) comes last: it brings the picture to the cut's colour and labels every axis on its frames.
 */
export function rangeGraph(
  range: SnappedRange,
  seek: number,
  canvas: Display,
  stamp: string[],
  rate: string,
  o: { hdr?: string; shape?: string[]; fit?: Fit; grade?: { tone: string[]; grain: string[] } } = {},
): string {
  const { width: W, height: H } = canvas;
  const boxed = o.fit === 'letterbox';
  const fitTo = boxed
    ? `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos`
    : `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}`;
  // Padded last, so the grade and its grain never reach the bars.
  const pad = boxed ? [`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`] : [];
  const halfFrame = 0.5 / range.fps;
  const start = range.start - seek;
  const end = range.end - seek;
  const { kept, played } = framesOf(range);
  const sped = played !== kept;
  // The last frame cloned for a few output frames past the range, so fps and minterpolate, which drop the last
  // frames they hold at the end of a stream, drop only clones; the encode's frame count ends the range. Padded
  // straight after the trim: some builds drop the clones of a pad placed after a scale.
  const sourcePerCut = range.cutFps === undefined ? 1 : range.fps / range.cutFps;
  const clones = [`tpad=stop_mode=clone:stop=${Math.ceil((4 * kept * sourcePerCut) / played) + 1}`];
  const speed = sped ? [
    // In microseconds, so the stretched instants are not rounded to a coarse container timebase first.
    'settb=AVTB', `setpts=PTS*${played}/${kept}`,
    range.interpolate ? `minterpolate=fps=${rate}:${INTERPOLATE}` : `fps=${rate}`,
    // At its own speed too: a frame a variable-rate source skipped is filled with the one before it, so the range
    // holds every frame of its grid and its picture stays over its sound.
  ] : [`fps=${rate}`];
  const chain = [
    `trim=start=${seconds(Math.max(0, start - halfFrame))}:end=${seconds(end - halfFrame)}`, 'setpts=PTS-STARTPTS', ...clones,
    o.hdr, ...(o.shape ?? []), fitTo, 'setsar=1', ...(o.grade?.tone ?? []), ...speed, ...(o.grade?.grain ?? []), ...pad,
    // Stamped as frame properties, last: the encoder takes its tags from the frames, and the -color_* output
    // options are ignored on the ffmpeg builds this runs against.
    ...stamp,
  ].filter(Boolean);
  return `[0:v]${chain.join(',')}[v]`;
}

/**
 * The cut's sound in one graph: every range's own, from its own input, crossfaded into the next by mixing fades
 * rather than with `acrossfade`. `heard[i]` says whether range i's sound comes from its source; any other range
 * is silence of its length. Input 0 is the joined picture, so range i's sound is the next input after the
 * previous heard range's.
 *
 * Every heard range but the last takes `crossfadeSec` of EXTRA sound from beyond its out-point, fades out over
 * that tail, and is delayed to its place on the output timeline; the next range fades in over the same window,
 * and `amix` sums them without renormalising. Two linear fades sum to unity, so the sound that bleeds across a
 * join is the room tone that genuinely followed the last kept frame. At another speed the sound, tail included,
 * is time-stretched by atempo to exactly the range's played length. The last range is padded to its length, so
 * the mix is exactly as long as the joined picture even when a source's audio ends before its last frame does;
 * another range whose sound runs out is silent to its join and fades over what sound is left. `gainsDb[i]` levels
 * range i's sound first, so a join crossfades two levelled sounds.
 */
export function audioGraph(
  ranges: SnappedRange[], seeks: number[], crossfadeSec: number, heard: boolean[], gainsDb: readonly number[] = [],
): string {
  const parts: string[] = [];
  let offset = 0;
  let input = 1;
  ranges.forEach((range, i) => {
    const isLast = i === ranges.length - 1;
    const length = playedLength(range);
    const stretch = stretchOf(range);
    let chain: string[];
    if (!heard[i]) {
      chain = [`anullsrc=r=${AUDIO_RATE}:cl=stereo`, `atrim=end_sample=${Math.round(length * AUDIO_RATE)}`];
    } else {
      const tail = isLast ? 0 : crossfadeSec;
      chain = [
        `atrim=start=${seconds(range.start - seeks[i])}:end=${seconds(range.end - seeks[i] + tail / stretch)}`,
        'asetpts=PTS-STARTPTS',
        `aformat=sample_rates=${AUDIO_RATE}:channel_layouts=stereo`,
      ];
      const gain = gainsDb[i] ?? 0;
      if (Math.abs(gain) >= 0.005) chain.push(`volume=${gain.toFixed(2)}dB`);
      if (stretch !== 1) {
        const whole = Math.round((length + tail) * AUDIO_RATE);
        chain.push(`atempo=${(1 / stretch).toFixed(6)}`, `apad=whole_len=${whole}`, `atrim=end_sample=${whole}`);
      }
      if (i > 0) chain.push(`afade=t=in:st=0:d=${seconds(crossfadeSec)}`);
      if (!isLast) chain.push(`afade=t=out:st=${seconds(length)}:d=${seconds(crossfadeSec)}`);
      else if (stretch === 1) chain.push(`apad=whole_len=${Math.round(length * AUDIO_RATE)}`);
    }
    // Delayed in SAMPLES: adelay's default unit is whole milliseconds, which is not a frame boundary.
    const delay = Math.round(offset * AUDIO_RATE);
    if (delay > 0) chain.push(`adelay=${delay}S:all=1`);
    parts.push(`${heard[i] ? `[${input++}:a]` : ''}${chain.join(',')}[a${i}]`);
    offset += length;
  });
  parts.push(
    ranges.length === 1
      ? '[a0]anull[aout]'
      : `${ranges.map((_, i) => `[a${i}]`).join('')}amix=inputs=${ranges.length}:normalize=0:dropout_transition=0[aout]`,
  );
  return parts.join(';');
}

const describeTags = (t: ColourTags) => `${t.primaries}/${t.transfer}/${t.space}`;

/** What was assumed for a source whose colour was, and why. */
const describeAssumed = (id: string, colour: ColourReport): string => {
  const declared = (['primaries', 'transfer', 'space'] as const).filter((axis) => colour.declared[axis] !== undefined);
  if (declared.length === 0) return `assumed for "${id}": no tags declared`;
  const rest = (['primaries', 'transfer', 'space'] as const).filter((axis) => !declared.includes(axis));
  return `${rest.join(' and ')} assumed bt709 for "${id}", which declares only ${declared.map((axis) => `${axis} ${colour.declared[axis]}`).join(' and ')}`;
};

/** A file's content as a digest, so a range is reused for the same bytes wherever they sit and never for others. */
function fileDigest(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.allocUnsafe(8 << 20);
    for (let n; (n = readSync(fd, chunk, 0, chunk.length, null)) > 0;) hash.update(chunk.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * One range's encode: its ffmpeg arguments, the cache file they make, and the frames that file must hold. The
 * arguments also write the scan's grey copy (`[g]`) to stdout, read into `changes` beside the file.
 */
interface RangeJob {
  index: number;
  label: string;
  file: string;
  args: string[];
  frames: number;
  scan: { width: number; height: number };
  script?: { file: string; text: string };
}

/** Where a range's picture changes are kept beside its cache file. */
const changesFile = (file: string) => file.replace(/\.mp4$/, '.changes.json');

/** Writes `text` to `path` through a file of this attempt's own, so a reader never sees half of it. */
function writeWhole(path: string, text: string): void {
  const tmp = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** A cached range's picture changes; one cached before they were kept beside it is scanned from its own file once. */
async function changesOf(file: string): Promise<number[]> {
  if (existsSync(changesFile(file))) return JSON.parse(readFileSync(changesFile(file), 'utf8')) as number[];
  const changes = await changesIn(file);
  writeWhole(changesFile(file), JSON.stringify(changes));
  return changes;
}

/**
 * Encodes the jobs, `workers` at a time, each into a file of its own named for this attempt and renamed into the
 * cache only once it holds every frame, so a run that dies or overlaps another never leaves a short range behind
 * a name the next run trusts. Each runs in a folder of its own under `work`, where its crop's moves are written.
 */
async function encodeRanges(jobs: RangeJob[], work: string, workers: number): Promise<void> {
  const live = new Set<ChildProcess>();
  const temps = new Set<string>();
  let next = 0;
  let failure: Error | undefined;
  const one = (job: RangeJob) => new Promise<void>((done, fail) => {
    const cwd = join(work, `r${job.index}`);
    mkdirSync(cwd, { recursive: true });
    if (job.script) writeFileSync(join(cwd, job.script.file), job.script.text);
    const tmp = `${job.file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    temps.add(tmp);
    const child = spawn(FFMPEG, [...job.args, '-f', 'mp4', tmp, '-map', '[g]', '-f', 'rawvideo', 'pipe:1'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    live.add(child);
    const reader = new ChangeReader(job.scan);
    child.stdout!.on('data', (chunk: Buffer) => reader.push(chunk));
    let stderr = '';
    child.stderr!.on('data', (d) => { stderr += d; });
    child.on('error', (e) => fail(new Error(`ffmpeg could not start (${FFMPEG}): ${e.message}`)));
    child.on('close', (code, signal) => {
      live.delete(child);
      if (code !== 0) {
        fail(new Error(`${job.label} failed to encode (${signal ?? `exit ${code}`}): ${stderr.trim().split('\n').slice(-4).join(' | ')}`));
        return;
      }
      const frames = countFrames(tmp);
      if (frames !== job.frames) {
        fail(new Error(`${job.label} encoded ${frames} frames where it plays ${job.frames}; nothing was kept of it`));
        return;
      }
      renameSync(tmp, job.file);
      temps.delete(tmp);
      writeWhole(changesFile(job.file), JSON.stringify(reader.changes));
      done();
    });
  });
  const worker = async () => {
    while (!failure && next < jobs.length) {
      const job = jobs[next++];
      try {
        await one(job);
      } catch (e) {
        failure ??= e as Error;
        for (const child of live) child.kill('SIGKILL');
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, worker));
  } finally {
    for (const tmp of temps) rmSync(tmp, { force: true });
  }
  if (failure) throw failure;
}

/** Where each range plays on the cut's timeline. */
const spansOf = (ranges: SnappedRange[]): Span[] => {
  let at = 0;
  return ranges.map((range) => ({ start: at, end: (at += playedLength(range)) }));
};

/**
 * What the cut does where nothing is heard, range by range, measured on what it plays: the cut's own sound, and each
 * range's picture changes as it was encoded (`changes`, one list per range). Named are a range whose picture runs
 * more than TAIL_SECONDS past its last sound, and a stretch held still, frozen or nearly so, with nothing heard under
 * it for longer than STILL_SECONDS (stillness.ts). A range that plays silent by design has no last sound to judge.
 * Sound is gated against the cut's own level, as the dead-tail check gates it. Times are given in the range's source,
 * where its edges are moved.
 */
export function rangeNotes(ranges: SnappedRange[], heard: boolean[], sound: Sound | null, changes: number[][]): string[] {
  const window = WINDOW_MS / 1000;
  const gate = sound && soundGateOf(sound.envelope);
  const loud = (k: number) => gate !== null && sound !== null && k >= 0 && k < sound.envelope.length && sound.envelope[k] >= gate;
  const quiet = (span: Span) => {
    if (!sound || gate === null) return true;
    for (let k = Math.floor((span.start - sound.start) / window + 1e-6); k * window + sound.start < span.end - 1e-6; k++) if (loud(k)) return false;
    return true;
  };
  const lines: string[] = [];
  spansOf(ranges).forEach((span, i) => {
    const range = ranges[i];
    const name = `range ${i} of "${range.source}"`;
    const inSource = (t: number) => range.start + (t - span.start) / stretchOf(range);
    if (heard[i] && sound) {
      // Only windows wholly inside the range, so a neighbour's crossfade never counts as this range's sound.
      const first = Math.ceil((span.start - sound.start) / window - 1e-6);
      let k = Math.floor((span.end - sound.start) / window + 1e-6) - 1;
      while (k >= first && !loud(k)) k--;
      const lastSound = k >= first ? sound.start + (k + 1) * window : null;
      if (lastSound === null && span.end - span.start > TAIL_SECONDS + 1e-9) {
        lines.push(`${name}: nothing in its ${inSeconds(span.end - span.start)} is heard above the rest of the cut`);
      } else if (lastSound !== null && span.end - lastSound > TAIL_SECONDS + 1e-9) {
        lines.push(`${name}: the picture runs ${inSeconds(span.end - lastSound)} past its last sound, which ends at ${inSeconds(inSource(lastSound))} of the source`);
      }
    }
    // Each range's changes are its own, from its first frame, so a join is never measured as a change.
    const onCut = (t: number) => span.start + t;
    for (const still of quietStillsOf(changes[i], 0, span.end - span.start, (s) => quiet({ start: onCut(s.start), end: onCut(s.end) }))) {
      const length = still.end - still.start;
      const where = `${inSource(onCut(still.start)).toFixed(2)}-${inSeconds(inSource(onCut(still.end)))} of the source`;
      lines.push(still.frozen >= length - 0.2
        ? `${name}: frozen with nothing heard for ${inSeconds(length)}, ${where}`
        : `${name}: nearly still with nothing heard for ${inSeconds(length)}, ${where}${still.frozen > 0 ? `, frozen for ${inSeconds(still.frozen)} of it` : ''}`);
    }
  });
  return lines;
}

/** ebur128's momentary loudness: a value every 100 ms, each over the 400 ms before it. */
const MOMENTARY = { step: 0.1, length: 0.4 } as const;

/** Word spans in their source's own seconds. */
type WordSpans = readonly (readonly [number, number])[];

const wordSpansOf = (transcript: Transcript): WordSpans => transcript.chunks.flatMap((c) => c.words.map((w) => w.timestamp));

/**
 * The momentary loudness values of one range that are speech: windows wholly inside the range and centred on a word
 * its source's transcript times, so neither the pauses between lines nor the room before them is read. `momentary` is
 * ebur128's series from the range's in-point.
 */
export function speechWindows(range: { start: number; end: number }, momentary: readonly number[], words: WordSpans): number[] {
  const near = words.filter(([a, b]) => b > range.start && a < range.end);
  return momentary.filter((_, k) => {
    const to = range.start + (k + 1) * MOMENTARY.step;
    const mid = to - MOMENTARY.length / 2;
    return to - MOMENTARY.length >= range.start - 1e-6 && to <= range.end + 1e-6 && near.some(([a, b]) => mid >= a && mid <= b);
  });
}

/**
 * The gain in dB that brings each source's speech to one level, the quietest source's: every gain then lowers, so
 * levelling never lifts a peak into clipping, and mux-audio sets the delivery loudness of the whole cut afterwards.
 */
export function levelGains(speech: ReadonlyMap<string, number>): { target: number; gains: Map<string, number> } | null {
  if (speech.size < 2) return null;
  const target = Math.min(...speech.values());
  return { target, gains: new Map([...speech].map(([id, lufs]) => [id, target - lufs])) };
}

/**
 * Each source's speech loudness as the cut plays it: every range that plays the source's sound and holds its words,
 * from an input seeked as the cut's sound is, all in one ffmpeg pass; their speech windows (speechWindows) are gated
 * and averaged as mix-audio reads a voice's (speakingLoudness). A source with no such range is not measured.
 */
function speechLoudness(
  ranges: SnappedRange[], seeks: number[], heard: boolean[], pathOf: (id: string) => string, words: ReadonlyMap<string, WordSpans>,
): Map<string, number> {
  const measured = ranges.flatMap((range, i) => (heard[i] && words.get(range.source)?.some(([a, b]) => b > range.start && a < range.end) ? [i] : []));
  if (measured.length === 0) return new Map();
  const args = ['-nostdin', '-hide_banner', '-nostats'];
  for (const i of measured) args.push(...(seeks[i] > 0 ? ['-ss', String(seeks[i])] : []), '-vn', '-i', pathOf(ranges[i].source));
  args.push('-filter_complex', measured.map((i, k) => `[${k}:a]atrim=start=${seconds(ranges[i].start - seeks[i])}:end=${seconds(ranges[i].end - seeks[i])},`
    + `asetpts=PTS-STARTPTS,aformat=sample_rates=${AUDIO_RATE}:channel_layouts=stereo,ebur128@r${i}=framelog=info[m${k}]`).join(';'));
  measured.forEach((_, k) => args.push('-map', `[m${k}]`, '-f', 'null', '-'));
  // A line per range every 100 ms: a long cut logs megabytes.
  const run = spawnSync(FFMPEG, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (run.error || run.status !== 0) throw new Error(run.error?.message ?? (run.stderr ?? '').trim().split('\n').pop());
  const momentary = momentaryOf(run.stderr ?? '');
  const windows = new Map<string, number[]>();
  for (const i of measured) {
    const { source } = ranges[i];
    windows.set(source, [...(windows.get(source) ?? []), ...speechWindows(ranges[i], momentary.get(`r${i}`) ?? [], words.get(source)!)]);
  }
  return new Map([...windows].flatMap(([id, values]): [string, number][] => {
    const lufs = speakingLoudness(values);
    return lufs === undefined ? [] : [[id, lufs]];
  }));
}

/** Each source's stretches that no range keeps, in its own seconds, from its start to the end of its picture (`ends`). */
export function removedOf(ranges: SnappedRange[], ends: ReadonlyMap<string, number>): Map<string, Span[]> {
  return new Map(sourceOrder(ranges).map((id) => {
    const kept = ranges.filter((r) => r.source === id).sort((a, b) => a.start - b.start);
    const gaps: Span[] = [];
    let at = 0;
    for (const range of kept) {
      if (range.start > at + 1e-6) gaps.push({ start: at, end: range.start });
      at = Math.max(at, range.end);
    }
    const end = ends.get(id)!;
    if (end > at + 1e-6) gaps.push({ start: at, end });
    return [id, gaps];
  }));
}

/** The transcripts of the sources whose sound the cut plays, each read once; lines name those that could not be. */
interface SourceTranscripts {
  read: Map<string, Transcript>;
  paths: Map<string, string>;
  lines: string[];
  /** Why none could be looked for. */
  failed?: string;
}

function transcriptsOf(loaded: LoadedEdl, videos: ReadonlyMap<string, string>, playing: string[]): SourceTranscripts {
  const read = new Map<string, Transcript>();
  const lines: string[] = [];
  let paths: Map<string, string>;
  try {
    paths = transcriptPathsOf(loaded, videos);
  } catch (e) {
    return { read, paths: new Map(), lines, failed: (e as Error).message };
  }
  for (const id of playing) {
    const path = paths.get(id)!;
    if (!existsSync(path)) {
      lines.push(`source "${id}" has no transcript at ${path}, so its ranges add no words to the cut's`);
      continue;
    }
    try {
      const file = readTranscriptFile(path);
      const note = mappedNote(path, file);
      if (note) lines.push(`source "${id}": ${note}`);
      read.set(id, file.transcript);
    } catch (e) {
      lines.push(`source "${id}"'s transcript is not used: ${(e as Error).message}`);
    }
  }
  return { read, paths, lines };
}

/**
 * The cut's own transcript, retimed from its sources' as retime-transcript retimes them, written where a
 * transcription of the cut would land so no transcription route overwrites it; lines say where, or why none was
 * written. A source whose sound plays but has no transcript adds no words, and a line names it.
 */
function retimeCut(ranges: SnappedRange[], heard: boolean[], out: string, sources: SourceTranscripts): string[] {
  if (sources.failed) return [`no transcript of the cut was written: ${sources.failed}`];
  const { read, paths, lines } = sources;
  const target = transcriptPathFor(out);
  if (!heard.some(Boolean)) return ['no transcript of the cut was written: no range plays its sound'];
  if (read.size === 0) return ['no transcript of the cut was written: its sources have none'];
  const own = [...paths].find(([, path]) => path === target);
  if (own) return [`no transcript of the cut was written: ${target}, where it goes, is the transcript of source "${own[0]}"`];
  let result: ReturnType<typeof retime>;
  try {
    result = retime(ranges, (id) => read.get(id) ?? { text: '', chunks: [] });
  } catch (e) {
    return [...lines, `no transcript of the cut was written: ${(e as Error).message}`];
  }
  const { droppedAtEdges, ...transcript } = result;
  mkdirSync(dirname(target), { recursive: true });
  writeWhole(target, JSON.stringify(transcript, null, 2));
  const dropped = droppedNote(droppedAtEdges);
  return [`the cut's transcript, its sources' words retimed onto it (${wordCount(transcript)} words) -> ${target}`, ...lines, ...(dropped ? [dropped] : [])];
}

/**
 * The cut's faces.json and faces.js, its sources' boxes moved onto it (facesOnCut), written where faces would write
 * the cut's; lines say where, and over which ranges the faces are unknown. When none is written, boxes found on the
 * file this cut replaced are removed.
 */
function facesOfCut(
  ranges: SnappedRange[],
  sources: ReadonlyMap<string, { path: string; shown: Display }>,
  plans: ReadonlyMap<string, Shaping>,
  cut: Omit<CutPicture, 'width' | 'height' | 'durationSec'>,
): string[] {
  const why = new Map<string, string>();
  const boxes = new Map([...sources].map(([id, { path, shown }]): [string, FacesClip | null] => {
    const at = ownFaces(path);
    if (!at) return [id, null];
    try {
      const clip = readFaces(at);
      const other = notFacesOf(clip, path, shown, probeVideoSpan(path).end);
      if (!other) return [id, clip];
      why.set(id, `${at} ${other}`);
    } catch (e) {
      why.set(id, (e as Error).message);
    }
    return [id, null];
  }));
  const picture = { ...cut, ...probeSquareSize(cut.video), durationSec: probeVideoSpan(cut.video).end };
  const spans = spansOf(ranges);
  const onCut = ranges.map((range, i): RangeOnCut => {
    const plan = plans.get(range.source);
    return {
      start: range.start, end: range.end, fps: range.fps, at: spans[i].start, stretch: stretchOf(range),
      faces: boxes.get(range.source)!, shown: sources.get(range.source)!.shown,
      ...(plan && plan.how !== 'already' ? { crop: { ...plan.crop, place: (sec: number) => placeAt(plan.moves, sec) } } : {}),
    };
  });
  const dir = facesFolder(cut.video);
  const clip = facesOnCut(onCut, picture);
  if (!clip) {
    const reasons = [...why].map(([id, text]) => `source "${id}"'s face boxes are not used: ${text}`);
    const owner = boxesOwner(join(dir, 'faces.json'));
    const stale = owner !== undefined && sameFile(owner, cut.video);
    if (stale) for (const file of ['faces.json', 'faces.js']) rmSync(join(dir, file), { force: true });
    return [`no faces of the cut were written: ${reasons.length ? reasons.join('; ') : 'faces has not run on its sources'}` +
      `${stale ? `; the boxes in ${dir}, found on the file this cut replaced, are removed` : ''}`];
  }
  writeAtomic(join(dir, 'faces.json'), clip);
  writeTextAtomic(join(dir, 'faces.js'), facesScript(clip));
  const unknown = sourceOrder(ranges).filter((id) => !boxes.get(id)).map((id) => {
    const where = ranges.flatMap((r, i) => (r.source === id ? [i] : []));
    const over = `the cut's faces over its range(s) ${indexList(where)} (${where.map((i) => `${spans[i].start.toFixed(2)}-${inSeconds(spans[i].end)}`).join(', ')}) are unknown`;
    return why.has(id) ? `source "${id}"'s face boxes are not used, so ${over}: ${why.get(id)}` : `faces has not run on source "${id}", so ${over}`;
  });
  return [`the cut's faces, its sources' boxes moved onto it -> ${join(dir, 'faces.js')} and faces.json`, ...unknown];
}

/** Indices as a short list: 0-3, 5, 7-8. */
const indexList = (indices: number[]): string => {
  const runs: string[] = [];
  for (let i = 0; i < indices.length; i++) {
    let j = i;
    while (j + 1 < indices.length && indices[j + 1] === indices[j] + 1) j++;
    runs.push(j > i ? `${indices[i]}-${indices[j]}` : String(indices[i]));
    i = j;
  }
  return runs.join(', ');
};

export const usage = {
  summary: 'Assemble the kept ranges of an EDL into one file, each at its own speed and grade, crossfading every join',
  flags: {
    edl: { type: 'string', value: '<edl.json>', required: true, help: 'The edit decision list to assemble' },
    out: { type: 'string', value: '<cut.mp4>', required: true, help: 'Where the assembled file is written' },
    crossfade: { type: 'string', value: '<ms>', help: 'Audio crossfade at each join, at least 1 (default 40)' },
    crf: { type: 'string', value: '0-51', help: 'x264 quality (default 20)' },
    fit: {
      type: 'string', value: 'crop|letterbox',
      help: 'How a range from a source of another shape meets the canvas: crop (default) cuts it as reframe does, around its faces when faces has run on that source, else from the middle; letterbox fits it whole and pads',
    },
    'keep-levels': { type: 'boolean', help: 'Leave every source\'s sound at its own level, for a deliberate difference between them' },
  },
  notes: [
    'The canvas is the first range\'s source as shown: upright, in square pixels. A line names each source cut',
    'to its shape and whether it followed the faces or cut from the middle. An HDR (PQ/HLG) source is converted to',
    'SDR BT.709, and a line says so. The frame rate is the first range\'s source\'s too: a range from a source at',
    'another rate is converted to it, its length rounded up to whole frames of the cut, and a line names the source.',
    `An out-point up to ${END_FRAMES} frames past its source's last frame ends the range on that frame; one further is`,
    'refused. Where a source\'s sound ends before its picture, a range past it plays silence there.',
    '',
    'Each source\'s speech is levelled to the quietest source\'s: measured where its transcript times words in the',
    'ranges that play its sound, and a line gives each source\'s gain. A source with no such words keeps its own level,',
    'and a line names it; --keep-levels keeps every source\'s.',
    '',
    'A range may also carry "speed" (0.5 half speed, 2 double), "interpolate": true to draw slow motion by motion',
    'interpolation instead of repeating frames (far slower to encode, worst at 4K), "mute": true, and "grade". A',
    'range plays a whole number of frames at its speed. Its sound is time-stretched, pitch kept, at speeds from',
    `${STRETCHED_SPEEDS.min} to ${STRETCHED_SPEEDS.max}, and silent at any other or when muted; a source with no sound plays silent.`,
    '"grade" on the EDL grades every range, and a range\'s own "grade" overrides it key by key (null drops a key):',
    'exposure (stops, -3 to 3), contrast and saturation (1 unchanged, 0 to 3), temperature (kelvin of the light,',
    '1000 to 40000, 6500 unchanged, lower warmer), lut (a .cube, .3dl, .dat, .m3d or .csp file) and grain (0 to',
    '100, whole numbers). A relative path in the EDL is read beside it, else from the working directory, else from',
    'the workspace ($OPEN_EDIT_ROOT), wherever the file is, and a line says where it was found.',
    '',
    'Each range\'s picture is kept in <out>.ranges/ under a name made of its source\'s content, its edges, speed,',
    'grade, shape and the encode, so a run that changes one range encodes that range alone; the sound is cut',
    'again on every run. Delete the folder to reclaim its space.',
    '',
    'When the sources have transcripts, the cut\'s is written where a transcription of it would land,',
    '$OPEN_EDIT_ROOT/runs/<key>/transcript.json for <key>.mp4, retimed as retime-transcript retimes it. When faces',
    'has run on them, the cut\'s faces.json and faces.js are written where faces would write the cut\'s, each',
    'range\'s boxes and graphics moved onto it; the faces over a range whose source has none are marked unknown. Measured',
    `on the cut, a line names each range whose picture runs more than ${TAIL_SECONDS}s past its last sound, and each`,
    `stretch held still, frozen or nearly so, with nothing heard for more than ${STILL_SECONDS}s. A line per source`,
    'gives every stretch of it no range kept, from its start to its last frame, in its own seconds.',
  ].join('\n'),
} satisfies Usage;

export async function applyEdl(argv: string[]): Promise<number> {
  const { values } = parseUsage('apply-edl', usage, argv);
  if (!values.edl || !values.out) {
    throw new Error(usageLine('apply-edl', usage));
  }
  const loaded = loadEdl(values.edl);
  // ffmpeg reads `afade=d=0` as UNSET and falls back to its 44100-sample default — nearly a second per
  // join, with no surplus trimmed to pay for it. A butt join would need its own flag.
  const crossfadeMs = numberFlag('crossfade', values.crossfade, 40, (n) => n >= 1, 'at least 1 millisecond');
  const crf = numberFlag('crf', values.crf, 20, (n) => n >= 0 && n <= 51, '0-51');
  const crossfadeSec = crossfadeMs / 1000;
  const fit = parseFit(values.fit);

  // Probed once per distinct source; every range is encoded from an input of its own (see inputSeeks).
  const order = sourceOrder(loaded.edl.ranges);
  const sources = new Map(order.map((id) => {
    const path = sourcePath(loaded, id);
    // The audio's own length, not the container's: a range from past it has no sound to play.
    const duration = hasAudioStream(path) ? audioDurationOf(path) : null;
    return [id, { path, ...probeFrameRate(path), duration, video: videoDurationOf(path), colour: decodedColourOf(path), shown: probeSquareSize(path) }];
  }));
  const sourceOf = (id: string) => sources.get(id)!;
  // One frame rate for the whole output, the first source's: snapRanges gives a range from a source at another rate
  // whole frames of it, so converting that range drops or repeats frames and moves no join.
  const first = sourceOf(order[0]);
  const converted = order.filter((id) => Math.abs(sourceOf(id).fps - first.fps) > 1e-6);
  const ranges = snapRanges(
    loaded.edl.ranges, new Map(order.map((id) => [id, sourceOf(id).fps])), new Map(order.map((id) => [id, sourceOf(id).video])),
  );
  // Heard: the range's sound comes from its source, which has sound from the range's in-point on.
  const heard = ranges.map((range) => {
    const audio = sourceOf(range.source).duration;
    return soundOf(range) !== 'muted' && audio !== null && range.start < audio - 1e-6;
  });

  ranges.forEach((range, index) => {
    const length = playedLength(range);
    // A single range emits `anull`, not a crossfade, so it has no minimum beyond being non-empty.
    if (ranges.length > 1 && length <= crossfadeSec) {
      throw new Error(
        `range ${index} of "${range.source}" plays ${length.toFixed(3)}s, no longer than the ` +
          `${crossfadeMs}ms crossfade — shorten --crossfade or lengthen the range`,
      );
    }
    const source = sourceOf(range.source);
    // The picture's own length: a range past it plays every later range's picture early, and `trim`
    // simply delivers fewer frames. An out-point just past it was moved onto it when snapped.
    if (range.end > source.video + 1e-6) {
      throw new Error(
        `range ${index} of "${range.source}" ends at ${range.end.toFixed(3)}s but the source's picture is only ` +
          `${source.video.toFixed(3)}s long. Move the out-point earlier.`,
      );
    }
  });

  const hdr = order.filter((id) => hdrKind(sourceOf(id).colour));
  // One colour for the cut as concat-videos decides one for a join: each source brought to it, an HDR one converted first.
  const joined = joinColour(order.map((id) => ({ id, colour: sourceOf(id).colour, sdr: hdr.includes(id) })));
  const stampOf = new Map(order.map((id, k) => [id, joined.stamps[k]]));
  const assumedFor = order.filter((id) => !hdr.includes(id) && sourceOf(id).colour.assumed);
  // A source whose picture the stamp converts, not only labels: its matrix or range is not the cut's.
  const recoded = order.filter((id) => stampOf.get(id)!.length > 2);
  const canvas = { width: first.shown.width, height: first.shown.height };
  const ratio = canvas.width / canvas.height;
  // Planned before anything is encoded, so stale face boxes are refused up front.
  const plans = new Map<string, Shaping>(fit === 'crop'
    ? order.map((id) => [id, planShape(sourceOf(id).path, ratio, { label: `source "${id}"`, ways: ', or assemble with --fit letterbox' })])
    : []);
  const letterboxed = fit === 'letterbox'
    ? order.filter((id) => cropFor(sourceOf(id).shown.width, sourceOf(id).shown.height, ratio).travel > 0)
    : [];
  const seeks = inputSeeks(ranges);
  const chains = new Map(hdr.map((id) => [id, toSdr(sourceOf(id).colour, `source "${id}"`)]));
  const grades = ranges.map((range) => mergeGrade(loaded.edl.grade, range.grade));
  const luts = new Map<string, { path: string; digest: string }>();
  for (const grade of grades) {
    if (grade.lut === undefined || luts.has(grade.lut)) continue;
    const { path } = locate(loaded, grade.lut);
    if (!existsSync(path)) throw new Error(`LUT "${grade.lut}" not found at ${path}`);
    luts.set(grade.lut, { path, digest: fileDigest(path) });
  }
  // A range is graded before its stamp, in the matrix its own picture is coded with.
  const codedIn = (id: string) => (hdr.includes(id) ? 'bt709' : sourceOf(id).colour.declared.space ?? 'bt709');
  const needsRgb = (g: Grade) => g.exposure !== undefined || g.temperature !== undefined || g.lut !== undefined;
  ranges.forEach((range, i) => {
    if (!yuvMatrix(codedIn(range.source)) && needsRgb(grades[i])) {
      throw new Error(`source "${range.source}" is coded with the ${codedIn(range.source)} matrix, which ffmpeg cannot read as RGB, so its ranges cannot take exposure, temperature or a LUT`);
    }
  });

  const outPath = resolve(values.out);
  mkdirSync(dirname(outPath), { recursive: true });
  const cache = `${outPath}.ranges`;
  mkdirSync(cache, { recursive: true });
  const ffmpeg = probeVersion(FFMPEG, FFMPEG_PROBE).banner.replace(/\s+Copyright.*$/, '');
  const digests = new Map(order.map((id) => [id, fileDigest(sourceOf(id).path)]));
  const files: string[] = [];
  const jobs: RangeJob[] = [];
  const scan = scanSize(canvas.width, canvas.height);
  ranges.forEach((range, i) => {
    const plan = plans.get(range.source);
    // Each range runs in a folder of its own, so its crop's moves keep one name and the graph does not change
    // with the range's place in the cut.
    const shaped = plan ? shapeChain(plan, 'shape', { from: range.start, to: range.end }) : { filters: asShown(sourceOf(range.source).shown) };
    const lut = grades[i].lut === undefined ? undefined : luts.get(grades[i].lut!)!;
    const grade = gradeFilters(grades[i], yuvMatrix(codedIn(range.source)) ?? 'bt709', lut && filterPath(lut.path));
    const graph = rangeGraph(range, seeks[i], canvas, stampOf.get(range.source)!, first.rate, { hdr: chains.get(range.source), shape: shaped.filters, fit, grade });
    const { played } = framesOf(range);
    const path = sourceOf(range.source).path;
    const encode = (filters: string) => [
      '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
      ...(seeks[i] > 0 ? ['-ss', String(seeks[i])] : []), '-i', path,
      '-filter_complex', filters, '-map', '[v]', '-frames:v', String(played),
      // -r gives the LAST frame a duration. Without it that frame reaches the muxer with none, the mp4 edit list
      // ends a frame early, and players drop the frame.
      '-r', first.rate, ...encodeArgs(crf),
    ];
    const args = encode(graph);
    // The scan's grey copy is split off the frames being encoded, so measuring the range costs no decode of its own;
    // its trim drops the clones past the range that only the encode's frame count would.
    const scanned = encode(`${graph.slice(0, -'[v]'.length)},split[v][s];[s]trim=end_frame=${played},${scanFilter(scan)}[g]`);
    // The source by its content rather than its path, so the name says what the file holds and nothing else.
    const key = createHash('sha256').update(JSON.stringify([
      ffmpeg, digests.get(range.source), args.filter((a) => a !== path), 'script' in shaped ? shaped.script?.text ?? '' : '', lut?.digest ?? '',
    ])).digest('hex').slice(0, 32);
    const file = join(cache, `${key}.mp4`);
    files.push(file);
    if (!existsSync(file) && !jobs.some((j) => j.file === file)) {
      jobs.push({
        index: i, label: `range ${i} of "${range.source}"`, file, args: scanned, frames: played, scan,
        ...('script' in shaped && shaped.script ? { script: shaped.script } : {}),
      });
    }
  });

  // Read once, before the sound is mixed: the levels are measured on the words, and the cut's transcript retimes them.
  const playing = sourceOrder(ranges.filter((_, i) => heard[i]));
  let transcripts: SourceTranscripts;
  try {
    transcripts = transcriptsOf(loaded, new Map(order.map((id) => [id, sourceOf(id).path])), playing);
  } catch (e) {
    transcripts = { read: new Map(), paths: new Map(), lines: [], failed: (e as Error).message };
  }
  const levelLines: string[] = [];
  let gainsDb: number[] = [];
  if (!values['keep-levels'] && playing.length > 1) {
    try {
      const words = new Map([...transcripts.read].map(([id, transcript]) => [id, wordSpansOf(transcript)]));
      const speech = speechLoudness(ranges, seeks, heard, (id) => sourceOf(id).path, words);
      const levels = levelGains(speech);
      if (levels) {
        gainsDb = ranges.map((range) => levels.gains.get(range.source) ?? 0);
        const gainOf = (db: number) => (Math.abs(db) < 0.05 ? 'as recorded' : `${db.toFixed(1)} dB`);
        levelLines.push(`Speech levelled to the quietest source's, ${levels.target.toFixed(1)} LUFS: ` +
          `${[...levels.gains].map(([id, db]) => `"${id}" ${gainOf(db)}`).join(', ')} (--keep-levels keeps each source's own)`);
      }
      for (const id of playing.filter((id) => !speech.has(id))) {
        levelLines.push(`source "${id}" has no transcribed words where the cut plays its sound, so its level is as recorded`);
      }
    } catch (e) {
      levelLines.push(`the sources' speech was not levelled: ${(e as Error).message}`);
    }
  }

  const work = mkdtempSync(join(tmpdir(), 'open-edit-apply-edl-'));
  try {
    await encodeRanges(jobs, work, encodeWorkers());
    const list = join(work, 'ranges.ffconcat');
    writeFileSync(list, `ffconcat version 1.0\n${files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n')}\n`);
    const sound = ranges.flatMap((range, i) => (heard[i] ? [...(seeks[i] > 0 ? ['-ss', String(seeks[i])] : []), '-vn', '-i', sourceOf(range.source).path] : []));
    const tmp = join(dirname(outPath), `.${basename(outPath)}.${process.pid}.tmp${extname(outPath)}`);
    try {
      execFileSync(FFMPEG, [
        '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'concat', '-safe', '0', '-i', list, ...sound,
        '-filter_complex', audioGraph(ranges, seeks, crossfadeSec, heard, gainsDb),
        '-map', '0:v', '-map', '[aout]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        '-movflags', '+faststart',
        tmp,
      ], { stdio: ['ignore', 'inherit', 'inherit'] });
      renameSync(tmp, outPath);
    } finally {
      rmSync(tmp, { force: true });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  // These only report on a cut already written, so none failing may fail the command.
  let notes: string[];
  try {
    const changes = await Promise.all(files.map(changesOf));
    notes = rangeNotes(ranges, heard, soundIn(outPath), changes);
  } catch (e) {
    notes = [`the cut's sound and stillness were not measured: ${(e as Error).message}`];
  }
  let transcribed: string[];
  try {
    transcribed = retimeCut(ranges, heard, outPath, transcripts);
  } catch (e) {
    transcribed = [`no transcript of the cut was written: ${(e as Error).message}`];
  }
  let faceLines: string[];
  try {
    faceLines = facesOfCut(ranges, sources, plans, { video: outPath, fps: first.fps, frameRate: first.rate.replace(/\/1$/, ''), fit });
  } catch (e) {
    faceLines = [`no faces of the cut were written: ${(e as Error).message}`];
  }
  const found = [
    ...relocated(loaded, order, [...luts.keys()].map((lut) => ({ what: `LUT "${lut}"`, named: lut }))),
    ...relocatedTranscripts(loaded),
  ];

  const kept = ranges.reduce((total, r) => total + (r.end - r.start), 0);
  const played = ranges.reduce((total, r) => total + playedLength(r), 0);
  const joins = ranges.length - 1;
  const speeds = ranges.some((r) => (r.speed ?? 1) !== 1);
  let at = 0;
  const timeline = speeds
    ? `  At each range's speed the cut runs ${played.toFixed(3)}s:\n` + ranges.map((r, i) => {
      const from = at;
      at += playedLength(r);
      const sound = !heard[i] ? (soundOf(r) === 'muted' ? 'silent' : 'silent (no sound in the source)') : soundOf(r) === 'stretched' ? 'sound stretched' : 'sound kept';
      return `    range ${i}${r.note ? ` "${r.note}"` : ''}: "${r.source}" ${r.start.toFixed(3)}-${r.end.toFixed(3)}s at ${r.speed ?? 1}x` +
        `${r.interpolate ? ' interpolated' : ''} -> ${from.toFixed(3)}-${at.toFixed(3)}s of the cut, ${sound}\n`;
    }).join('')
    : '';
  const muted = ranges.flatMap((r, i) => (r.mute ? [i] : []));
  const silentSources = order.filter((id) => sourceOf(id).duration === null);
  const byGrade = new Map<string, number[]>();
  grades.forEach((g, i) => {
    const text = describeGrade(g);
    if (text !== 'none') byGrade.set(text, [...(byGrade.get(text) ?? []), i]);
  });
  const fpsText = (rate: string) => `${rate.replace(/\/1$/, '')} fps`;
  const removed = [...removedOf(ranges, new Map(order.map((id) => [id, sourceOf(id).video])))].map(([id, gaps]) => {
    const name = `"${id}" (${basename(sourceOf(id).path)})`;
    if (gaps.length === 0) return `Nothing removed from ${name}`;
    const total = gaps.reduce((sum, g) => sum + g.end - g.start, 0);
    return `Removed from ${name}: ${gaps.map((g) => `${g.start.toFixed(3)}-${g.end.toFixed(3)}s (${(g.end - g.start).toFixed(3)}s)`).join(', ')}; ` +
      `${total.toFixed(3)}s of its ${sourceOf(id).video.toFixed(3)}s`;
  });
  console.log(
    `assembled ${ranges.length} range(s) from ${order.length} source(s) -> ${outPath}\n` +
      `  ${kept.toFixed(3)}s kept, ${joins} crossfaded join(s) of ${crossfadeMs}ms; ${canvas.width}x${canvas.height}, ` +
      `colour ${describeTags(joined.tags)}` +
      `${assumedFor.length > 0 ? ` (${assumedFor.map((id) => describeAssumed(id, sourceOf(id).colour)).join('; ')})` : ''}.\n` +
      recoded.map((id) => `  source "${id}" is coded otherwise (matrix ${codedIn(id)}${sourceOf(id).colour.full ? ', full range' : ''}): its picture is converted to the cut's.\n`).join('') +
      converted.map((id) => `  source "${id}" runs at ${fpsText(sourceOf(id).rate)}: its ranges are converted to the cut's ${fpsText(first.rate)}.\n`).join('') +
      found.map((line) => `  ${line}.\n`).join('') +
      timeline +
      (!speeds && muted.length ? `  Muted: range(s) ${indexList(muted)}.\n` : '') +
      silentSources.map((id) => `  source "${id}" has no sound: its ranges play silent.\n`).join('') +
      [...byGrade].map(([text, indices]) => `  Graded ${text}: range(s) ${indexList(indices)}.\n`).join('') +
      hdr.map((id) => `  ${describeHdr(`source "${id}"`, sourceOf(id).colour)}.\n`).join('') +
      [...plans].filter(([, plan]) => plan.how !== 'already')
        .map(([id, plan]) => `  ${describeShape(`source "${id}"`, plan, `the canvas's shape (${canvas.width}x${canvas.height})`)}.\n`).join('') +
      letterboxed.map((id) => `  source "${id}" (${sourceOf(id).shown.width}x${sourceOf(id).shown.height}) is letterboxed onto the canvas.\n`).join('') +
      [...levelLines, ...removed].map((line) => `  ${line}.\n`).join('') +
      `  ${jobs.length} range(s) encoded, ${ranges.length - jobs.length} reused from ${cache}.\n` +
      '  Each range is snapped to the frame grid, so the timeline is exactly the sum of the ranges as they play.' +
      [...transcribed, ...faceLines, ...notes].map((line) => `\n  ${line}.`).join(''),
  );
  // Said now, while the EDL is open, since a cut that is the piece's picture fixes the length the render will have.
  const length = lengthAgainstBrief(played, [outPath, loaded.path], 'the cut');
  if (length) console.log(`  ${length}`);
  return 0;
}
