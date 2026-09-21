// MUX AUDIO — restore the soundtrack. veed-engine-cli renders video only; this muxes the original audio
// onto the clean silent render, levelled to the delivery target. Deterministic; ffmpeg only, no sandbox exit needed.
//
//   openedit mux-audio <run-dir> [--doc final] [--audio <file>] [--no-loudnorm]
// Audio comes from --audio when given, else from <run-dir>/meta.json's source video. Muxes
// <run-dir>/<doc>/out.silent.mp4 -> out.mp4, where <doc> defaults to final.
//   VEED_ENGINE_FFMPEG  ffmpeg (default: ffmpeg on PATH)
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { FFMPEG, FFPROBE } from '../config.ts';
import { hasAudioStream } from '../probe.ts';

class MuxError extends Error {
  constructor(msg: string, readonly code: number) { super(msg); }
}
const fail = (msg: string, code: number): never => { throw new MuxError(msg, code); };

export const usage = {
  summary: "Mux a run's audio onto its silent render at delivery loudness",
  positionals: '<run-dir>',
  flags: {
    // A film gates one chapter at a time, and its audio is a built mix rather than the source clip's.
    doc: { type: 'string', value: '<subdir>', help: 'Document under the run to mux (default final)' },
    audio: { type: 'string', value: '<file>', help: "A built soundtrack to mux instead of the source clip's own track" },
    'no-loudnorm': { type: 'boolean', help: 'Skip levelling to the delivery loudness' },
  },
} satisfies Usage;

export function muxAudio(argv: string[]): number {
  try {
    run(argv);
    return 0;
  } catch (error) {
    if (error instanceof MuxError) {
      if (error.message) console.error(error.message);
      return error.code;
    }
    throw error;
  }
}

function run(argv: string[]): void {
  const { values, positionals: [dir] } = parseUsage('mux-audio', usage, argv);
  if (!dir) fail(usageLine('mux-audio', usage), 2);
  const doc = values.doc ?? 'final';
  const audio = values.audio ?? '';
  const normalise = !values['no-loudnorm'];

  const silent = join(dir!, doc, 'out.silent.mp4');
  const outPath = join(dir!, doc, 'out.mp4');
  if (!existsSync(silent)) fail(`mux: missing ${silent} (render first)`, 1);

  // The audio is either a track that was BUILT for this run (a mix of narration, music and effects) or
  // the source clip's own. Only the second needs meta.json — a run with no footage has none, and
  // requiring it was why the footage-free path failed at its last gate.
  let src: string;
  if (audio) {
    src = audio;
    if (!existsSync(src)) fail(`mux: no audio at ${src}`, 1);
  } else {
    const metaPath = join(dir!, 'meta.json');
    if (!existsSync(metaPath)) fail(`mux: no ${metaPath} and no --audio — say which track to lay on`, 2);
    const videoPath = (JSON.parse(readFileSync(metaPath, 'utf8')) as { videoPath?: string }).videoPath ?? '';
    if (!videoPath || !existsSync(videoPath)) fail(`mux: could not resolve source video from ${metaPath}`, 1);
    src = videoPath;
  }

  const probe = (args: string[]) => {
    try {
      return execFileSync(FFPROBE, args, { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };

  // -map 1:a:0? tolerates a source with no audio track (out.mp4 then == silent render).
  // Write to a tmp name and rename: out.mp4 is watched live by the preview server, so its
  // existence must mean completeness (a moov-less in-progress file plays as broken "done").
  // +faststart keeps moov up front (the engine records it that way; default muxing would move it
  // to the tail, making the deliverable start slower anywhere without Range support).
  const tmp = join(dir!, doc, 'out.tmp.mp4');
  // The PICTURE decides the length. `-shortest` let a built mix truncate the film — a 2s track over a
  // 6s render wrote a 2s deliverable and exited 0, which destroys work without saying so.
  const vdur = probe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', silent])
    || probe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', silent]);
  if (!vdur) fail(`mux: could not read the duration of ${silent}`, 1);

  // Camera audio commonly lands several decibels under the delivery target and plays quieter than its
  // neighbours in a feed; the track is re-encoded here anyway, so the correction costs one measurement
  // pass. --no-loudnorm keeps the source level for one chapter of a longer piece, whose level belongs
  // to the whole film.
  const hasAudio = hasAudioStream(src);
  // A source video with no track is a silent film and muxes as-is; a track the user NAMED with no
  // audio in it is a mistake, and a silent deliverable that exits 0 would pass the whole gate chain.
  if (audio && !hasAudio) fail(`mux: ${src} has no audio stream — nothing to lay on the render`, 1);
  let loudness: Loudnorm;
  if (!normalise) loudness = { mode: 'none', filter: null, why: 'not requested' };
  else if (!hasAudio) loudness = { mode: 'none', filter: null, why: 'the source has no audio track — nothing to normalise' };
  else loudness = loudnormFilter(src);
  if (normalise && loudness.mode !== 'measured') {
    console.log(`mux: loudness ${loudness.mode === 'dynamic' ? 'corrected dynamically' : 'left as recorded'} — ${loudness.why}`);
  }

  try {
    execFileSync(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', silent, '-i', src,
      '-map', '0:v:0', '-map', '1:a:0?', '-c:v', 'copy',
      ...(loudness.filter ? ['-af', loudness.filter] : []),
      // 48 kHz on every path: loudnorm works at 192 kHz and would otherwise hand the encoder 96 kHz,
      // and a chapter muxed with --no-loudnorm must not differ in rate from its neighbours.
      '-c:a', 'aac', '-ar', '48000', '-t', vdur, '-movflags', '+faststart', tmp,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch {
    fail('', 1);
  }
  renameSync(tmp, outPath);
  // Say which correction actually ran: a line that claims -14 LUFS after a fallback is a lie the
  // deliverable cannot be checked against without re-measuring it.
  const said: Record<Loudnorm['mode'], string> = {
    measured: ` (normalised to ${LOUDNORM_I} LUFS)`,
    dynamic: ' (dynamic loudness correction — see above)',
    none: hasAudio ? '' : ' (no audio track in the source)',
  };
  console.log(`mux: wrote ${outPath}${said[loudness.mode]}`);
}

// The delivery target this pipeline aims at: -14 LUFS integrated, -1 dBTP true peak, 11 LU range.
// It is the level the major social platforms have converged on for upload normalisation; a platform
// that moves its own target moves these, so they are constants to revisit, not physical facts.
export const LOUDNORM_I = -14;
export const LOUDNORM_TP = -1;
export const LOUDNORM_LRA = 11;

const TARGET = `loudnorm=I=${LOUDNORM_I}:TP=${LOUDNORM_TP}:LRA=${LOUDNORM_LRA}`;

/**
 * `measured`: a linear gain computed from a measurement pass — the only mode that is a plain level
 * change. `dynamic`: loudnorm's per-window normaliser, which pumps on speech, so it is a different
 * processing decision and is named as one. `none`: nothing applied; `why` says what stopped it.
 */
export type Loudnorm =
  | { mode: 'measured'; filter: string }
  | { mode: 'dynamic'; filter: string; why: string }
  | { mode: 'none'; filter: null; why: string };

export interface LoudnormMeasurement {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
}

/**
 * The JSON summary loudnorm prints, out of the rest of ffmpeg's stderr. Anchored on the block's own
 * first key: a warning printed after it that happens to contain a brace would otherwise shift a
 * last-brace slice and lose the measurement. Null when there is no summary or it does not parse.
 */
export function parseLoudnormSummary(stderr: string): Record<string, string> | null {
  const anchor = stderr.lastIndexOf('"input_i"');
  const open = anchor === -1 ? -1 : stderr.lastIndexOf('{', anchor);
  const close = open === -1 ? -1 : stderr.indexOf('}', anchor);
  if (open === -1 || close === -1) return null;
  try {
    return JSON.parse(stderr.slice(open, close + 1)) as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * What loudnorm will actually do with a measurement, mirroring its own gate: the linear mode applies
 * only when the gain that reaches the target keeps the true peak under the ceiling, the loudness range
 * is within the limit, and neither the level nor the range measured as exactly zero (a constant level
 * reports a range of 0 LU);
 * otherwise ffmpeg runs its dynamic normaliser without saying so, and the report has to say it instead.
 * (An input under three seconds takes loudnorm's own peak-limited linear gain whatever is passed.)
 */
export function decideLoudnorm(measured: LoudnormMeasurement): Loudnorm {
  const { input_i: i, input_tp: tp, input_lra: lra, input_thresh: thresh, target_offset: offset } = measured;
  const withMeasurement = `${TARGET}:measured_I=${i}:measured_TP=${tp}:measured_LRA=${lra}:measured_thresh=${thresh}:offset=${offset}`;
  const gain = LOUDNORM_I - i;
  const peakAfter = tp + gain;
  const reasons: string[] = [];
  if (peakAfter > LOUDNORM_TP) {
    reasons.push(`a linear gain of ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB would put the true peak at ${peakAfter.toFixed(1)} dBTP (limit ${LOUDNORM_TP})`);
  }
  if (lra > LOUDNORM_LRA) reasons.push(`the loudness range is ${lra.toFixed(1)} LU (limit ${LOUDNORM_LRA})`);
  if (lra === 0) reasons.push('the loudness range measured as 0 LU (a constant level), which the linear mode refuses');
  else if (i === 0) reasons.push('the integrated loudness measured as exactly 0 LUFS, which the linear mode refuses');
  if (reasons.length > 0) return { mode: 'dynamic', filter: `${withMeasurement}:linear=false`, why: reasons.join('; ') };
  return { mode: 'measured', filter: `${withMeasurement}:linear=true` };
}

const unmeasured = (why: string): Loudnorm => ({ mode: 'dynamic', filter: TARGET, why });

export function loudnormFilter(source: string): Loudnorm {
  // spawnSync, not execFileSync: the measurement is printed to STDERR, and execFileSync only hands
  // stderr back on a throw, so a successful pass would silently lose it.
  const measure = spawnSync(FFMPEG, [
    '-hide_banner', '-nostats', '-i', source, '-af', `${TARGET}:print_format=json`, '-vn', '-f', 'null', '-',
  ], { encoding: 'utf8' });

  if (measure.error) return { filter: null, mode: 'none', why: `ffmpeg could not run: ${measure.error.message}` };
  const stderr = measure.stderr ?? '';
  // A non-zero exit still prints the input dump, and a file's own metadata tags land on that same
  // stderr — so the summary is never read after a failure, only ffmpeg's last line is quoted.
  if (measure.status !== 0) {
    const last = stderr.trim().split('\n').pop() ?? '';
    return unmeasured(`the measurement pass exited ${measure.status}${last ? `: ${last}` : ''}`);
  }

  const summary = parseLoudnormSummary(stderr);
  if (!summary) return unmeasured('the measurement pass printed no readable summary');

  // Present is not the same as usable: a silent track reports every key, with -inf in some of them.
  // The filter is built from these coerced numbers, never from the summary's strings, so "" or " "
  // cannot interpolate as an empty argument.
  const needed = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'] as const;
  const values = needed.map((key) => Number(summary[key]));
  if (values.some((v) => !Number.isFinite(v))) {
    return {
      filter: null,
      mode: 'none',
      why: 'the track has no measurable loudness (silence or near-silence), so it is left at its own level',
    };
  }
  const [input_i, input_tp, input_lra, input_thresh, target_offset] = values;
  return decideLoudnorm({ input_i, input_tp, input_lra, input_thresh, target_offset });
}
