// Assemble an EDL's kept ranges into one file in a single encode.
// An EDL (edit decision list) is the list of source intervals to keep, in order.
//
//   openedit apply-edl --edl <edl.json> --out <cut.mp4> [--crossfade 40] [--crf 20]
//
// Joins are crossfaded, not butt-joined: a butt join clicks at the seam, and a crossfade needs one
// encode over both sides of it. That is why this re-encodes instead of stream-copying like `concat-chapters`.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { numberFlag, parseUsage, usageLine, type Usage } from '../args.ts';
import { FFMPEG } from '../config.ts';
import { loadEdl, snapRanges, sourceOrder, sourcePath, type SnappedRange } from '../edl.ts';
import {
  ASSUMED_COLOUR, audioDurationOf, colourTagsOf, probeDisplaySize, probeFrameRate, videoDurationOf,
  type ColourReport, type ColourTags, type Display,
} from '../probe.ts';

const seconds = (t: number) => t.toFixed(6);
const AUDIO_RATE = 48000;
/** One AAC block at the lowest common source rate: the most a file's audio ends short of its picture by design. */
const AAC_BLOCK_SEC = 1024 / 44100;

/**
 * Where each range's input is opened: every range is its OWN input, seeked to a whole second at least
 * one second before it starts. One input shared by every range made the graph buffer whatever a
 * reordered edit needed later. The seek is coarse on purpose: the graph's trim defines the edge, and
 * the second of margin keeps that edge inside what was decoded.
 */
export function inputSeeks(ranges: SnappedRange[]): number[] {
  return ranges.map((range) => Math.max(0, Math.floor(range.start) - 1));
}

/**
 * One filter graph: trim every range out of its own input, put each on the same canvas, concat the
 * video, and crossfade the audio by mixing fades rather than with `acrossfade`.
 *
 * The ranges arrive snapped to their source's frame grid, so each keeps a whole number of frames. The
 * VIDEO trim edges sit half a frame before those instants: a frame's timestamp can land a few
 * microseconds either side of k/fps once rounded to the container's timebase, and a boundary exactly on
 * it would keep or drop that frame by luck. The AUDIO is cut on the instants themselves.
 *
 * Every segment but the last takes `crossfadeSec` of EXTRA audio from beyond its out-point, fades out
 * over that tail, and is delayed to its place on the output timeline; the next segment fades in over
 * the same window, and `amix` sums them without renormalising. Two linear fades sum to unity, so the
 * sound that bleeds across a join is the room tone that genuinely followed the last kept frame. The
 * last segment is padded to its snapped length, so the mix is exactly as long as the concatenated
 * video even when the source's audio ends a few milliseconds before its last frame does.
 */
export function buildGraph(
  ranges: SnappedRange[],
  seeks: number[],
  canvas: Display,
  colour: ColourTags,
  crossfadeSec: number,
): { filter: string; videoLabel: string; audioLabel: string } {
  const parts: string[] = [];
  const scale =
    `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
    `pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

  let offset = 0;
  ranges.forEach((range, i) => {
    const isLast = i === ranges.length - 1;
    const start = range.start - seeks[i];
    const end = range.end - seeks[i];
    const length = range.end - range.start;
    const halfFrame = 0.5 / range.fps;
    parts.push(
      `[${i}:v]trim=start=${seconds(Math.max(0, start - halfFrame))}:end=${seconds(end - halfFrame)},` +
        `setpts=PTS-STARTPTS,${scale}[v${i}]`,
    );
    const audio = [
      `atrim=start=${seconds(start)}:end=${seconds(isLast ? end : end + crossfadeSec)}`,
      'asetpts=PTS-STARTPTS',
      `aformat=sample_rates=${AUDIO_RATE}:channel_layouts=stereo`,
    ];
    if (i > 0) audio.push(`afade=t=in:st=0:d=${seconds(crossfadeSec)}`);
    if (isLast) audio.push(`apad=whole_len=${Math.round(length * AUDIO_RATE)}`);
    else audio.push(`afade=t=out:st=${seconds(length)}:d=${seconds(crossfadeSec)}`);
    // Delayed in SAMPLES: adelay's default unit is whole milliseconds, which is not a frame boundary.
    const delay = Math.round(offset * AUDIO_RATE);
    if (delay > 0) audio.push(`adelay=${delay}S:all=1`);
    parts.push(`[${i}:a]${audio.join(',')}[a${i}]`);
    offset += length;
  });

  // Colour is stamped as frame properties: the encoder takes its tags from the frames it is handed, and
  // the -color_* output options are ignored on the ffmpeg builds this runs against.
  parts.push(
    `${ranges.map((_, i) => `[v${i}]`).join('')}concat=n=${ranges.length}:v=1:a=0,` +
      `setparams=color_primaries=${colour.primaries}:color_trc=${colour.transfer}:colorspace=${colour.space}[vout]`,
  );
  parts.push(
    ranges.length === 1
      ? '[a0]anull[aout]'
      : `${ranges.map((_, i) => `[a${i}]`).join('')}amix=inputs=${ranges.length}:normalize=0:dropout_transition=0[aout]`,
  );

  return { filter: parts.join(';'), videoLabel: '[vout]', audioLabel: '[aout]' };
}

const describeTags = (t: ColourTags) => `${t.primaries}/${t.transfer}/${t.space}`;
const sameTags = (a: ColourTags, b: ColourTags) =>
  a.primaries === b.primaries && a.transfer === b.transfer && a.space === b.space;

/**
 * One colour for the whole output, or a refusal: every source must agree, and a source that declares
 * any axis the bt709 assumption would contradict (an HDR transfer, wide-gamut primaries) is never
 * relabelled by having the rest assumed for it.
 */
export function decideColour(sources: { id: string; colour: ColourReport }[]): ColourReport {
  for (const { id, colour } of sources) {
    if (!colour.assumed) continue;
    const contradicted = (Object.entries(colour.declared) as [keyof ColourTags, string][])
      .filter(([axis, value]) => value !== ASSUMED_COLOUR[axis]);
    if (contradicted.length > 0) {
      throw new Error(
        `source "${id}" declares ${contradicted.map(([axis, value]) => `${axis} ${value}`).join(' and ')} but not the rest — ` +
          'stamping bt709 over it would mislabel the picture. Tag the file completely before assembling.',
      );
    }
  }
  const first = sources[0];
  for (const { id, colour } of sources.slice(1)) {
    if (!sameTags(colour.tags, first.colour.tags)) {
      throw new Error(
        `sources disagree on colour: "${first.id}" is ${describeTags(first.colour.tags)} and "${id}" is ` +
          `${describeTags(colour.tags)} — convert them to one colour space before assembling.`,
      );
    }
  }
  return first.colour;
}

export const usage = {
  summary: 'Assemble the kept ranges of an EDL into one file, crossfading every join',
  flags: {
    edl: { type: 'string', value: '<edl.json>', required: true, help: 'The edit decision list to assemble' },
    out: { type: 'string', value: '<cut.mp4>', required: true, help: 'Where the assembled file is written' },
    crossfade: { type: 'string', value: '<ms>', help: 'Audio crossfade at each join, at least 1 (default 40)' },
    crf: { type: 'string', value: '0-51', help: 'x264 quality (default 20)' },
  },
} satisfies Usage;

export function applyEdl(argv: string[]): number {
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

  // Probed once per distinct source; the encode opens one input per RANGE (see inputSeeks).
  const order = sourceOrder(loaded.edl.ranges);
  const sources = new Map(order.map((id) => {
    const path = sourcePath(loaded, id);
    let duration: number;
    try {
      duration = audioDurationOf(path);
    } catch (cause) {
      // Every join borrows audio from beyond its out-point, so the audio's own length is what the
      // guard below needs; the container's length would pass a file whose audio ends early or is absent.
      throw new Error(`source "${id}": ${(cause as Error).message} — apply-edl assembles picture and sound together`, { cause });
    }
    return [id, { path, ...probeFrameRate(path), duration, video: videoDurationOf(path), colour: colourTagsOf(path) }];
  }));
  const sourceOf = (id: string) => sources.get(id)!;
  // One frame rate for the whole output: the encode is forced to it, and a source at another rate would
  // have frames dropped or doubled to fit without a word.
  const first = sourceOf(order[0]);
  for (const [id, source] of sources) {
    if (Math.abs(source.fps - first.fps) > 1e-6) {
      throw new Error(
        `sources disagree on frame rate: "${order[0]}" runs at ${first.rate} fps and "${id}" at ${source.rate} — ` +
          'bring them to one rate first (concat-videos re-encodes to a common one).',
      );
    }
    // The grid assumes every frame slot is filled; a slot the camera skipped inside a kept range moves
    // every later frame a slot earlier against the sound, and nothing downstream can see it.
    if (Math.abs(source.averageFps - source.fps) / source.fps > 0.005) {
      console.warn(
        `warning: source "${id}" is not constant frame rate (nominal ${source.rate}, average ${source.averageFps.toFixed(2)}) — ` +
          'a frame the camera skipped inside a kept range shifts the picture against the sound from there on.',
      );
    }
  }
  const ranges = snapRanges(loaded.edl.ranges, new Map(order.map((id) => [id, sourceOf(id).fps])));

  ranges.forEach((range, index) => {
    // A single range emits `anull`, not a crossfade, so it has no minimum beyond being non-empty.
    if (ranges.length > 1 && range.end - range.start <= crossfadeSec) {
      throw new Error(
        `range ${index} of "${range.source}" is ${(range.end - range.start).toFixed(3)}s, no longer than the ` +
          `${crossfadeMs}ms crossfade — shorten --crossfade or lengthen the range`,
      );
    }
    const source = sourceOf(range.source);
    // The picture's own length: a range past it plays every later range's picture early, and `trim`
    // simply delivers fewer frames.
    if (range.end > source.video + 1e-6) {
      throw new Error(
        `range ${index} of "${range.source}" ends at ${range.end.toFixed(3)}s but the source's picture is only ` +
          `${source.video.toFixed(3)}s long. Move the out-point earlier.`,
      );
    }
    const isLast = index === ranges.length - 1;
    const needed = isLast ? range.end : range.end + crossfadeSec;
    // The last range's audio may end short of its snapped end: the snap moves the edge up by less than
    // a frame, and AAC stops on its own block grid rather than on the picture's. Within that the graph
    // pads the sound to the picture; beyond it the out-point is genuinely past the recording.
    const tolerated = isLast ? 1 / range.fps + AAC_BLOCK_SEC : 0;
    if (needed > source.duration + tolerated + 1e-6) {
      throw new Error(
        isLast
          ? `range ${index} of "${range.source}" ends at ${range.end.toFixed(3)}s but the source's audio is only ` +
            `${source.duration.toFixed(3)}s long. Move the out-point earlier.`
          : `range ${index} of "${range.source}" ends at ${range.end.toFixed(3)}s and its join needs ` +
            `${crossfadeMs}ms more audio, but the source's audio is only ${source.duration.toFixed(3)}s long. ` +
            'Move the out-point earlier, reorder so this range is last, or lower --crossfade.',
      );
    }
  });

  const colour = decideColour(order.map((id) => ({ id, colour: sourceOf(id).colour })));
  const assumedFor = order.filter((id) => sourceOf(id).colour.assumed);
  const canvas = probeDisplaySize(first.path);
  const seeks = inputSeeks(ranges);
  const { filter, videoLabel, audioLabel } = buildGraph(ranges, seeks, canvas, colour.tags, crossfadeSec);

  const outPath = resolve(values.out);
  mkdirSync(dirname(outPath), { recursive: true });
  execFileSync(FFMPEG, [
    '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
    ...ranges.flatMap((range, i) => [...(seeks[i] > 0 ? ['-ss', String(seeks[i])] : []), '-i', sourceOf(range.source).path]),
    '-filter_complex', filter,
    '-map', videoLabel, '-map', audioLabel,
    // -r pins the output to the source rate and gives the LAST frame a duration. Without it that frame
    // reaches the muxer with none, the mp4 edit list ends a frame early, and players drop the frame.
    '-r', first.rate,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    outPath,
  ], { stdio: ['ignore', 'inherit', 'inherit'] });

  const kept = ranges.reduce((total, r) => total + (r.end - r.start), 0);
  const joins = ranges.length - 1;
  console.log(
    `assembled ${ranges.length} range(s) from ${order.length} source(s) -> ${outPath}\n` +
      `  ${kept.toFixed(3)}s kept, ${joins} crossfaded join(s) of ${crossfadeMs}ms; ${canvas.width}x${canvas.height}, ` +
      `colour ${describeTags(colour.tags)}${assumedFor.length > 0 ? ` (assumed for ${assumedFor.map((id) => `"${id}"`).join(', ')}: no tags declared)` : ''}.\n` +
      '  Each range is snapped to its source\'s frame grid, so the timeline is exactly the sum of the ' +
      'snapped ranges — a transcript retimed from the same EDL lands on the same instants.',
  );
  return 0;
}
