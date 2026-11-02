// A narration on one input of a two-channel recorder, the other left open, plays in one ear as it stands,
// and a mono file joined to a stereo mix lands wherever ffmpeg's format negotiation puts it.
import { spawnSync } from 'node:child_process';
import { FFMPEG } from './config.ts';

/**
 * Equal-power gain for a channel laid into both: the pair carries the energy the one channel did, so the
 * track's loudness as BS.1770 measures it (a sum of channel powers) does not move. It is also the gain
 * ffmpeg's resampler gives a mono input it upmixes to stereo.
 */
export const CENTRE_GAIN = 0.7071;

/**
 * Two channels this far apart over a whole track play in one ear: the track is one-sided. The 175 two-channel
 * tracks of 64 real mix specs measured within 8 dB of balance; an open input carries only its noise floor, far lower.
 */
export const ONE_SIDED_DB = 20;

/** Two channels this far apart lean hard to one side without being one-sided, as a lav on one input and a camera mic on the other do. */
export const LEANING_DB = 12;

/** The RMS level of each channel of a file's first audio stream, in dBFS; -Infinity for digital silence. */
export function channelLevels(file: string): number[] {
  const run = spawnSync(FFMPEG, [
    '-hide_banner', '-nostats', '-i', file, '-map', '0:a:0',
    '-af', 'astats=measure_overall=none:measure_perchannel=RMS_level', '-f', 'null', '-',
  ], { encoding: 'utf8' });
  if (run.error) throw new Error(`could not measure the channels of ${file}: ${run.error.message}`);
  const stderr = run.stderr ?? '';
  if (run.status !== 0) {
    throw new Error(`could not measure the channels of ${file}: ${stderr.trim().split('\n').pop() || `ffmpeg exited ${run.status}`}`);
  }
  // Anchored on the filter's own prefix: a file's metadata is printed to the same stderr.
  const levels = [...stderr.matchAll(/\[Parsed_astats_0 @ [^\]]+\] RMS level dB: (\S+)/g)]
    .map(([, v]) => (v === '-inf' ? -Infinity : Number(v)));
  if (!levels.length || levels.some(Number.isNaN)) throw new Error(`could not measure the channels of ${file}`);
  return levels;
}

/** How far apart a two-channel track's channels are, in dB; 0 for any other track, which is not checked. */
function gap(levels: readonly number[]): number {
  if (levels.length !== 2 || levels[0] === levels[1]) return 0;
  return Math.abs(levels[0] - levels[1]);
}

/** Whether a two-channel track is one-sided: its channels differ by ONE_SIDED_DB or more. */
export function oneSided(levels: readonly number[]): boolean {
  return gap(levels) >= ONE_SIDED_DB;
}

/** The line that says what became of a one-sided or leaning track; null for a balanced one. */
export function describeBalance(levels: readonly number[]): string | null {
  const dbfs = (v: number) => (Number.isFinite(v) ? `${v.toFixed(1)} dBFS` : 'silent');
  const both = levels.map(dbfs).join(' / ');
  if (oneSided(levels)) return `has its sound on one channel only (${both}); centred in both channels`;
  if (gap(levels) < LEANING_DB) return null;
  return `leans ${gap(levels).toFixed(1)} dB to the ${levels[0] > levels[1] ? 'left' : 'right'} (${both}); left as it is`;
}

/**
 * The filter that lays a track into a stereo mix: a mono or one-sided track has its channels summed into both
 * at equal power, never one picked, so a second voice on the quieter channel survives. Anything else is made
 * stereo by ffmpeg (two channels pass unchanged, more are downmixed), which alone keeps a mono file from
 * collapsing the mix to mono.
 */
export function toStereo(levels?: readonly number[]): string {
  if (!levels || (levels.length !== 1 && !oneSided(levels))) return 'aformat=channel_layouts=stereo';
  const sum = levels.map((_, c) => `${CENTRE_GAIN}*c${c}`).join('+');
  return `pan=stereo|c0=${sum}|c1=${sum}`;
}
