// One soundtrack out of many pieces.
//
// `mux-audio.ts` restores the SOURCE audio of a clip onto its render, which is the whole audio story a
// captioned run has. A film is not that: a 12-minute documentary carried 66 narration takes, 11 sound
// effects and 6 music cues, and nothing in this repository could put them together — no `amix`, no
// `adelay`, no concat anywhere. So the run hand-wrote its own, once, and threw it away.
//
// This takes a spec and produces the mixed track. Every piece states WHERE it starts and how loud it
// sits; music and effects under narration are ducked by the narration itself rather than by a gain somebody
// guessed at, an effect given no gain is set under the narration by measuring both, a mono or one-sided
// piece is centred in both channels, and the music bed runs to the last frame.
//
//   openedit mix-audio <run-dir> [--spec audio/mix.json] [--out audio/mix.m4a] [--video <render>]
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, extname, isAbsolute } from 'node:path';
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { FFMPEG } from '../config.ts';
import { channelLevels, describeBalance, toStereo } from '../channels.ts';
import { hasAudioStream, pictureDurationOf } from '../probe.ts';
import { soundSpanIn, type SoundSpan } from '../verify/dead-tail.ts';

export interface Track {
  /** Relative to the run dir, or absolute. */
  path: string;
  /** When it starts, in seconds on the film's timeline. */
  atSec: number;
  /** Level in dB. 0 leaves it alone; negative is quieter. Unset on an sfx track in a spec with a voice, it is set under the voice (see `effectLevels`). */
  gainDb?: number;
  fadeInSec?: number;
  /** Ends at endSec when the track sets one, else at the film's end. Unset on a music track run to its end, MUSIC_FADE_OUT_SEC. */
  fadeOutSec?: number;
  /** Where it stops on the film's timeline. Unset, the music track that would end last runs to durationSec (see `fits`). */
  endSec?: number;
  /** Where this piece sits. `voice` is the bus everything else can duck under. */
  role?: 'voice' | 'music' | 'sfx' | 'ambience';
  /** Lowered while the voice bus speaks. Unset: true for a music or sfx track when the spec has a voice track, false otherwise. */
  duck?: boolean;
  /** Keeps a two-channel track's panning as recorded, for an effect meant to sit on one side. */
  keepPan?: boolean;
}

export interface MixSpec {
  /** The film's length. Anything past it is trimmed, so one long cue cannot extend the deliverable. */
  durationSec: number;
  tracks: Track[];
}

function label(i: number): string {
  return `a${i}`;
}

/**
 * An explicit `duck` wins; unset, music and sound effects duck when the spec has a voice track, because an
 * effect left at its own gain plays over the words. A voice track never ducks.
 */
export function ducks(track: Track, hasVoice: boolean): boolean {
  if (track.role === 'voice') return false;
  return track.duck ?? ((track.role === 'music' || track.role === 'sfx') && hasVoice);
}

/**
 * The loudness the duck's key is brought to, so a ducked track dips as deep under a quiet narration as under a
 * loud one. At -19.7 LUFS, the median of 68 real narration tracks, the compressor below takes the ducked bed down
 * 12 dB, Audacity Auto Duck's default.
 */
export const KEY_LUFS = -19.7;

/**
 * The quietest voice track whose key is raised in full: 11 dB under the quietest of those 68 tracks (-39.0 LUFS)
 * and 20 dB over the -70 LUFS ebur128 reports for silence. A quieter track is raised no further, so the duck
 * fades out with it instead of keying on a silent or near-silent track's noise.
 */
const QUIETEST_KEY_LUFS = -50;

/** The gain that brings one voice track's key to KEY_LUFS; unmeasured, the key is the voice as it is. */
function keyGainDb(lufs: number | undefined): number {
  return lufs === undefined || !Number.isFinite(lufs) ? 0 : KEY_LUFS - Math.max(lufs, QUIETEST_KEY_LUFS);
}

/** A shorter gap is a few codec frames of padding (an AAC frame is 21 ms at 48 kHz), not a silence anyone hears. */
const SILENCE_SLOP_SEC = 0.1;

/**
 * How long the music run to its end takes to fade out, unless it sets fadeOutSec: the median of the 35 fade-outs given
 * to music tracks in 53 real mix specs (from 0.5 to 3 s, half of them from 0.9 to 1.8 s).
 */
export const MUSIC_FADE_OUT_SEC = 1.5;

/**
 * Tracks summed without renormalising, restamped from their sample count: ffmpeg 9 stops stamping amix's output once
 * one input ends before the others, so a fade, pad or trim after it misses. Every input is laid out from zero here.
 */
const sumOf = (n: number) => `amix=inputs=${n}:normalize=0,asetpts=N/SR/TB`;

/**
 * The crossfade that joins a looped music file to its own start: one second, the length Adobe's editors give an audio
 * transition by default, at equal power so a join between unrelated passages neither dips nor swells.
 */
export const LOOP_CROSSFADE_SEC = 1;

/** A stretch of a track's file on the film: from `in` to `out` in the file's seconds, starting at `at` in the film's. */
export interface Piece {
  at: number;
  in: number;
  out: number;
  fadeIn?: number;
  fadeOut?: number;
}

/** How a music track runs to where it stops: that point, the stretches of its file that play there, and its fade-out. */
export interface Fit {
  until: number;
  pieces: Piece[];
  fadeOutSec: number;
}

const sec = (v: number) => Number(v.toFixed(3));

/**
 * The stretches of a file whose sound spans `span` that carry it from `at` to `until` on the film: the file as it is
 * when its sound lasts that long, else the file to its last sound, then its sound again from its first, as often as
 * it takes, each joined to the one before by LOOP_CROSSFADE_SEC. A file with no sound, or with too little to hold a
 * crossfade at each end, plays once.
 */
export function piecesOf(span: SoundSpan | null, at: number, until: number): Piece[] {
  const c = LOOP_CROSSFADE_SEC;
  if (!span || at + span.end >= until - SILENCE_SLOP_SEC || span.end - span.start < 2 * c) {
    return [{ at, in: 0, out: sec(until - at) }];
  }
  const unit = span.end - span.start;
  const pieces: Piece[] = [{ at, in: 0, out: span.end, fadeOut: c }];
  let next = at + span.end - c;
  while (next + unit < until - SILENCE_SLOP_SEC) {
    pieces.push({ at: sec(next), in: span.start, out: span.end, fadeIn: c, fadeOut: c });
    next += unit - c;
  }
  pieces.push({ at: sec(next), in: span.start, out: sec(span.start + until - next), fadeIn: c });
  return pieces;
}

/**
 * Where each music track stops, and how it gets there, indexed like the spec's tracks; `spans` holds where each
 * music file's sound starts and ends (see `musicSpans`). A track that sets endSec stops there. Of the rest, the one
 * whose sound would end last on the film is the bed and runs to durationSec, so the film never ends on a bed that
 * stopped short or on nothing at all; an earlier cue keeps its own length. Tracks of other roles play as set.
 */
export function fits(spec: MixSpec, spans: readonly (SoundSpan | null | undefined)[]): (Fit | undefined)[] {
  const music = spec.tracks.flatMap((t, i) => (t.role === 'music' ? [i] : []));
  const endOf = (i: number): number | undefined => {
    const t = spec.tracks[i];
    if (t.endSec !== undefined) return t.endSec;
    const span = spans[i];
    return span === undefined ? undefined : t.atSec + (span?.end ?? 0);
  };
  const ends = music.map(endOf).filter((e): e is number => e !== undefined);
  const last = ends.length ? Math.max(...ends) : undefined;
  return spec.tracks.map((t, i) => {
    if (t.role !== 'music') return undefined;
    const end = endOf(i);
    const bed = t.endSec === undefined && end !== undefined && last !== undefined && end >= last - SILENCE_SLOP_SEC;
    if (t.endSec === undefined && !bed) return undefined;
    const until = Math.min(t.endSec ?? spec.durationSec, spec.durationSec);
    return { until, pieces: piecesOf(spans[i] ?? null, t.atSec, until), fadeOutSec: t.fadeOutSec ?? MUSIC_FADE_OUT_SEC };
  });
}

/** The line that says a music track was looped to its end; null for one that plays once. */
export function describeFit(path: string, fit: Fit): string | null {
  const repeats = fit.pieces.length - 1;
  if (!repeats) return null;
  const s = (v: number) => `${Number(v.toFixed(2))}s`;
  const joins = repeats === 1 ? `1 repeat joined by a ${s(LOOP_CROSSFADE_SEC)} crossfade` : `${repeats} repeats joined by ${s(LOOP_CROSSFADE_SEC)} crossfades`;
  const fade = fit.fadeOutSec ? `, faded out over the last ${s(fit.fadeOutSec)}` : '';
  return `${path} looped to ${s(fit.until)} (its sound ends ${s(fit.pieces[0].out)} in): ${joins}${fade}`;
}

/**
 * One track's chain from its inputs: made stereo, placed on the timeline, levelled, faded and stopped. `setDb` is
 * the gain `effectLevels` measured for it, which its own gainDb overrides. A track `fit` with several pieces reads
 * one input per piece, from `input` on, each cut from the file and crossfaded into the next before they are summed;
 * so a long film over a short loop costs a decoder per repeat rather than a copy of the whole bed held in memory.
 */
function chainOf(t: Track, input: number, levels: readonly number[] | undefined, durationSec: number, setDb?: number, fit?: Fit): string {
  if (!Number.isFinite(t.atSec) || t.atSec < 0) {
    throw new Error(`mix-audio: "${t.path}" starts at ${t.atSec}s — a start must be a non-negative number`);
  }
  const ms = (v: number) => `${Math.round(v * 1000)}|${Math.round(v * 1000)}`;
  const stereo = toStereo(t.keepPan ? undefined : levels);
  const pieces: string[] = [];
  let chain: string[];
  if (fit && fit.pieces.length > 1) {
    const ls = fit.pieces.map((p, k) => {
      const piece = [`[${input + k}:a]aresample=48000`, stereo, 'asetpts=PTS-STARTPTS', `atrim=start=${p.in}:end=${p.out}`, 'asetpts=PTS-STARTPTS'];
      if (p.fadeIn) piece.push(`afade=t=in:d=${p.fadeIn}:curve=qsin`);
      if (p.fadeOut) piece.push(`afade=t=out:st=${sec(p.out - p.in - p.fadeOut)}:d=${p.fadeOut}:curve=qsin`);
      pieces.push(`${[...piece, `adelay=${ms(p.at)}`].join(',')}[p${input + k}]`);
      return `[p${input + k}]`;
    });
    chain = [`${ls.join('')}${sumOf(ls.length)}`];
  } else {
    chain = [`[${input}:a]aresample=48000`, stereo, `adelay=${ms(t.atSec)}`];
  }
  if (t.gainDb) chain.push(`volume=${t.gainDb}dB`);
  else if (t.gainDb === undefined && setDb !== undefined) chain.push(`volume=${setDb.toFixed(2)}dB`);
  if (t.fadeInSec) chain.push(`afade=t=in:st=${t.atSec}:d=${t.fadeInSec}`);
  const until = fit?.until ?? (t.endSec === undefined ? undefined : Math.min(t.endSec, durationSec));
  const fadeOut = fit?.fadeOutSec ?? t.fadeOutSec;
  if (until !== undefined && until < durationSec) chain.push(`atrim=end=${until}`);
  if (fadeOut) {
    // Measured from where the track stops, the film's end unless it says otherwise, as a file's own length is not in the spec.
    const end = until ?? durationSec;
    chain.push(`afade=t=out:st=${sec(Math.max(0, end - fadeOut))}:d=${fadeOut}`);
  }
  return [...pieces, chain.join(',')].join(';');
}

/**
 * The filtergraph, built as a string so it can be read and tested without running ffmpeg. `levels` holds each
 * track's measured channel levels, `voiceLufs` each voice track's loudness (see `voiceLoudness`) and `setDb` the
 * gain each effect is set to under the voice (see `effectLevels`); a track without levels is still made stereo, an
 * unmeasured voice keys the duck at its own level, and an unmeasured effect plays as recorded. `fitted` holds how
 * each music track runs to where it stops (see `fits`), and `inputs` names the track each ffmpeg input reads, in order.
 *
 * Every track is made stereo first: left to format negotiation, a mono narration listed first collapsed the
 * whole mix, music included, to mono. `adelay` needs a value per channel, `amix` with `normalize=0` keeps
 * levels where the spec put them (its default divides every input by the input count, which is why a mix
 * built without it comes out mysteriously quiet), and `apad` plus `atrim` fix the total length so a short
 * mix does not shorten the film.
 */
export function filtergraph(
  spec: MixSpec,
  levels: (readonly number[] | undefined)[] = [],
  voiceLufs: (number | undefined)[] = [],
  setDb: (number | undefined)[] = [],
  fitted: (Fit | undefined)[] = [],
): { graph: string; out: string; inputs: number[] } {
  if (!spec.tracks.length) throw new Error('mix-audio: the spec has no tracks');
  if (!Number.isFinite(spec.durationSec) || spec.durationSec <= 0) {
    throw new Error(`mix-audio: durationSec must be a positive number, got ${spec.durationSec}`);
  }
  const parts: string[] = [];
  const voices: { l: string; i: number }[] = [];
  const ducked: string[] = [];
  const plain: string[] = [];
  const hasVoice = spec.tracks.some((t) => t.role === 'voice');
  const sum = (ls: string[], out: string, then = '') => (ls.length === 1
    ? `[${ls[0]}]${then || 'anull'}[${out}]`
    : `${ls.map((l) => `[${l}]`).join('')}${sumOf(ls.length)}${then ? `,${then}` : ''}[${out}]`);

  const inputs: number[] = [];
  spec.tracks.forEach((t, i) => {
    const l = label(i);
    parts.push(`${chainOf(t, inputs.length, levels[i], spec.durationSec, setDb[i], fitted[i])}[${l}]`);
    inputs.push(...Array<number>(Math.max(1, fitted[i]?.pieces.length ?? 1)).fill(i));
    if (t.role === 'voice') voices.push({ l, i });
    else if (ducks(t, hasVoice)) ducked.push(l);
    else plain.push(l);
  });

  if (ducked.length && !voices.length) {
    throw new Error('mix-audio: a track asks to be ducked, but no track is marked role "voice" to duck it');
  }

  const beds: string[] = [];
  if (ducked.length) {
    // The narration itself opens the gap, with a slow release so the bed does not pump between words.
    //
    // The threshold is absolute, so on the voice's own level the dip followed how loud the narration was:
    // 15dB under -16.6 LUFS, under 2dB under -32.6. Each voice track is split before the bus, and only its
    // key copy is brought to KEY_LUFS, on its own: one level for the whole bus left a quiet voice taking
    // turns with a loud one barely ducking at all. The narration is still heard at its own level.
    // The key is padded to the film's length. `sidechaincompress` ends its OUTPUT when the sidechain
    // ends, so an unpadded key truncated the bed at the last word — measured at -91dB against -33dB
    // for the same music one second later. Music dying when narration stops is the exact opposite of
    // what ducking is for.
    const keys = voices.map(({ l, i }) => {
      parts.push(`[${l}]asplit=2[${l}h][${l}k]`);
      const gain = keyGainDb(voiceLufs[i]);
      if (!gain) return `${l}k`;
      parts.push(`[${l}k]volume=${gain.toFixed(2)}dB[${l}kg]`);
      return `${l}kg`;
    });
    parts.push(sum(voices.map(({ l }) => `${l}h`), 'vmix'));
    parts.push(sum(keys, 'vkey', `apad=whole_dur=${spec.durationSec}`));
    const bed = ducked.length === 1 ? ducked[0] : 'beds';
    if (ducked.length > 1) parts.push(`${ducked.map((l) => `[${l}]`).join('')}${sumOf(ducked.length)}[beds]`);
    parts.push(`[${bed}][vkey]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=600[duckedbed]`);
    beds.push('duckedbed', 'vmix');
  } else if (voices.length) {
    parts.push(sum(voices.map(({ l }) => l), 'vox'));
    beds.push('vox');
  }
  beds.push(...plain);

  // `apad` with no bound pads FOREVER, and `atrim` downstream does not always close the graph — a
  // review's fifty-track stress spec ran ffmpeg for an hour without finishing. Pad to the film's own
  // length instead, so the padding ends on its own and `atrim` only ever has to cut.
  const out = 'mix';
  const tail = `apad=whole_dur=${spec.durationSec},atrim=0:${spec.durationSec},asetpts=N/SR/TB[${out}]`;
  parts.push(beds.length === 1
    ? `[${beds[0]}]${tail}`
    : `${beds.map((l) => `[${l}]`).join('')}${sumOf(beds.length)},${tail}`);

  return { graph: parts.join(';'), out, inputs };
}

const ROLES = ['voice', 'music', 'sfx', 'ambience'] as const;
export const SPEC_KEYS = ['durationSec', 'tracks'] as const;
export const TRACK_KEYS = ['path', 'atSec', 'endSec', 'gainDb', 'fadeInSec', 'fadeOutSec', 'role', 'duck', 'keepPan'] as const;

/**
 * The spec as written by hand, checked field by field. Unchecked, a malformed one fails deep in the graph
 * builder with a message that names no field, and a misspelt key or role mixes the wrong thing without a word.
 * `lengthSec` is the film's length for a spec that leaves durationSec out.
 */
export function parseSpec(raw: unknown, lengthSec?: number): MixSpec {
  const bad = (what: string): never => {
    throw new Error(`mix-audio: ${what} (the spec's fields are in mix-audio --help)`);
  };
  // Checked before the known fields, because a misspelt key also reads as its real one missing.
  const onlyKnown = (at: string, obj: object, known: readonly string[]): void => {
    const extra = Object.keys(obj).find((k) => !known.includes(k));
    if (extra !== undefined) bad(`${at} has unknown field ${JSON.stringify(extra)} (known: ${known.join(', ')})`);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    bad('the spec is an object, { "durationSec": <seconds>, "tracks": [ ... ] }, not a bare list of tracks');
  }
  onlyKnown('the spec', raw as object, SPEC_KEYS);
  const { tracks } = raw as { tracks?: unknown };
  const durationSec = (raw as { durationSec?: unknown }).durationSec ?? lengthSec;
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
    bad(`durationSec, the film's length in seconds, must be a positive number (got ${JSON.stringify(durationSec)}); `
      + '--video supplies it from a render');
  }
  if (!Array.isArray(tracks) || tracks.length === 0) bad('tracks must be a non-empty list');
  (tracks as unknown[]).forEach((t, i) => {
    const at = `tracks[${i}]`;
    if (typeof t !== 'object' || t === null || Array.isArray(t)) bad(`${at} must be an object`);
    const track = t as Record<string, unknown>;
    onlyKnown(at, track, TRACK_KEYS);
    if (typeof track.path !== 'string' || track.path === '') bad(`${at}.path must name a file`);
    if (typeof track.atSec !== 'number' || !Number.isFinite(track.atSec) || track.atSec < 0) {
      bad(`${at}.atSec, its start in seconds, must be a non-negative number`);
    }
    // The mix is trimmed at durationSec, so a track starting there or later would vanish without a word.
    if ((track.atSec as number) >= (durationSec as number)) {
      bad(`${at} starts at ${track.atSec}s, at or past durationSec ${durationSec}s, so it would be trimmed out`);
    }
    if (track.endSec !== undefined && (typeof track.endSec !== 'number' || !Number.isFinite(track.endSec) || track.endSec <= (track.atSec as number))) {
      bad(`${at}.endSec, where it stops in seconds, must be a number after its atSec`);
    }
    for (const key of ['gainDb', 'fadeInSec', 'fadeOutSec'] as const) {
      const v = track[key];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || (key !== 'gainDb' && v < 0))) {
        bad(`${at}.${key} must be a ${key === 'gainDb' ? '' : 'non-negative '}number`);
      }
    }
    if (track.role !== undefined && !(ROLES as readonly unknown[]).includes(track.role)) {
      bad(`${at}.role must be one of ${ROLES.join(', ')} (got ${JSON.stringify(track.role)})`);
    }
    if (track.duck !== undefined && typeof track.duck !== 'boolean') bad(`${at}.duck must be true or false`);
    if (track.keepPan !== undefined && typeof track.keepPan !== 'boolean') bad(`${at}.keepPan must be true or false`);
    // The voice tracks are the key the others duck under, so a ducked voice would be ignored.
    if (track.duck === true && track.role === 'voice') bad(`${at} is a voice track, which ducks the others and cannot be ducked itself`);
  });
  return { ...(raw as MixSpec), durationSec: durationSec as number };
}

/** A spec file's JSON, unchecked. */
export function readSpecJson(specPath: string): unknown {
  let text: string;
  try {
    text = readFileSync(specPath, 'utf8');
  } catch (error) {
    throw new Error(`mix-audio: cannot read ${specPath}: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`mix-audio: ${specPath} is not valid JSON: ${(error as Error).message}`);
  }
  return raw;
}

/** A spec file, checked; `lengthSec` is the film's length when it leaves durationSec out. */
export function readSpec(specPath: string, lengthSec?: number): MixSpec {
  return parseSpec(readSpecJson(specPath), lengthSec);
}

const resolver = (runDir: string) => (p: string) => (isAbsolute(p) ? p : join(runDir, p));

/** One measurement per track, taken once per file; a file that is not there is left unmeasured. */
function perTrackFile<T>(runDir: string, spec: MixSpec, measure: (file: string, t: Track) => T): (T | undefined)[] {
  const resolve = resolver(runDir);
  const measured = new Map<string, T>();
  return spec.tracks.map((t) => {
    const file = resolve(t.path);
    if (!existsSync(file)) return undefined;
    if (!measured.has(file)) measured.set(file, measure(file, t));
    return measured.get(file);
  });
}

/** Each track's channel levels, measured once per file; a file that is not there is left unmeasured. */
export function trackLevels(runDir: string, spec: MixSpec): (number[] | undefined)[] {
  return perTrackFile(runDir, spec, (file, t) => {
    try {
      if (!hasAudioStream(file)) throw new Error(`${t.path} has no audio stream`);
      return channelLevels(file);
    } catch (error) {
      throw new Error(`mix-audio: ${(error as Error).message}`);
    }
  });
}

/**
 * Where each music track's sound starts and ends in its file, gated as the review gates a delivered video's, indexed
 * like the spec's tracks. Measured from the sound, not read off the file's length, because a generated piece writes its
 * own fade to silence before its file ends. Null for a file with nothing loud enough to count; tracks of other roles,
 * and files that are not there, are left unmeasured.
 */
export function musicSpans(runDir: string, spec: MixSpec): (SoundSpan | null | undefined)[] {
  const resolve = resolver(runDir);
  const measured = new Map<string, SoundSpan | null>();
  return spec.tracks.map((t) => {
    const file = resolve(t.path);
    if (t.role !== 'music' || !existsSync(file)) return undefined;
    if (!measured.has(file)) {
      try {
        measured.set(file, soundSpanIn(file));
      } catch (error) {
        throw new Error(`mix-audio: could not measure where the sound of ${t.path} ends: ${(error as Error).message.trim().split('\n').pop()}`);
      }
    }
    return measured.get(file);
  });
}

/**
 * Each voice track's integrated loudness as the mix plays it, in one ffmpeg pass, indexed like the spec's
 * tracks; measured only when something ducks under the voice.
 */
export function voiceLoudness(runDir: string, spec: MixSpec, levels: (readonly number[] | undefined)[] = []): (number | undefined)[] {
  const unmeasured = spec.tracks.map((): number | undefined => undefined);
  const hasVoice = spec.tracks.some((t) => t.role === 'voice');
  if (!spec.tracks.some((t) => ducks(t, hasVoice))) return unmeasured;
  const resolve = resolver(runDir);
  const voiced = spec.tracks.flatMap((t, i) => (t.role === 'voice' ? [i] : []));
  // Nothing to measure: the graph refuses a duck with no voice, and the mix names a missing file.
  if (!voiced.length || voiced.some((i) => !existsSync(resolve(spec.tracks[i].path)))) return unmeasured;
  const args = ['-hide_banner', '-nostats'];
  for (const i of voiced) args.push('-i', resolve(spec.tracks[i].path));
  const d = spec.durationSec;
  // Per-frame lines go to the verbose level, which the default log level hides, so only the summary is printed;
  // ffmpeg 5.1 has no framelog=quiet and refuses the graph.
  args.push('-filter_complex', voiced
    .map((i, n) => `${chainOf(spec.tracks[i], n, levels[i], d)},atrim=0:${d},ebur128@v${i}=framelog=verbose[m${n}]`).join(';'));
  voiced.forEach((_, n) => args.push('-map', `[m${n}]`, '-f', 'null', '-'));
  const run = spawnSync(FFMPEG, args, { encoding: 'utf8' });
  // Each instance prints its own summary, named after the track it measured.
  const found = new Map([...(run.stderr ?? '').matchAll(/\[ebur128@v(\d+) @ [^\]]+\] Summary:\s+Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/g)]
    .map(([, i, v]) => [Number(i), Number(v)]));
  if (run.error || run.status !== 0) {
    const why = run.error?.message ?? (run.stderr ?? '').trim().split('\n').pop();
    throw new Error(`mix-audio: could not measure the loudness of the voice tracks${why ? `: ${why}` : ''}`);
  }
  const unmeasuredVoices = voiced.filter((i) => !found.has(i)).map((i) => spec.tracks[i].path);
  if (unmeasuredVoices.length) throw new Error(`mix-audio: could not measure the loudness of ${unmeasuredVoices.join(', ')}`);
  return spec.tracks.map((_, i) => found.get(i));
}

/**
 * How far under the voice an effect given no gain is set, in LU: the separation between dialogue and its
 * background of music and effects that SVT's delivery spec recommends, the strict end of the 4 to 8 LU that
 * broadcasters' delivery specs ask for.
 */
export const SFX_UNDER_VOICE_LU = 8;

/** Momentary loudness this close to the voice's loudest moment is the voice speaking; pauses and breaths fall below it. */
const SPEECH_GATE_LU = 20;

/** BS.1770's absolute gate: a track that never rises above it is silent, and nothing can be set against silence. */
const SILENT_LUFS = -70;

/** Whether a track is set under the voice: a sound effect given no gain, in a spec with a voice track. */
export function setUnderVoice(track: Track, hasVoice: boolean): boolean {
  return track.role === 'sfx' && track.gainDb === undefined && hasVoice;
}

/**
 * The voice's loudness while it speaks: the energy mean of its momentary loudness within SPEECH_GATE_LU of its
 * loudest moment, so the pauses between lines do not pull it down. Undefined for a voice that never sounds.
 */
export function speakingLoudness(momentary: readonly number[]): number | undefined {
  const loudest = momentary.reduce((a, b) => Math.max(a, b), -Infinity);
  if (!(loudest > SILENT_LUFS)) return undefined;
  const speaking = momentary.filter((m) => m >= loudest - SPEECH_GATE_LU);
  return 10 * Math.log10(speaking.reduce((sum, m) => sum + 10 ** (m / 10), 0) / speaking.length);
}

/** Each named ebur128 instance's momentary loudness, one value per 100 ms, read from its `framelog=info` lines. */
function momentaryOf(stderr: string): Map<string, number[]> {
  const series = new Map<string, number[]>();
  for (const [, name, m] of stderr.matchAll(/^\[ebur128@(\w+) @ [^\]]+\] t: *\S+ +TARGET:\S+ LUFS +M: *(\S+)/gm)) {
    if (!series.has(name)) series.set(name, []);
    series.get(name)!.push(Number.isFinite(Number(m)) ? Number(m) : -Infinity);
  }
  return series;
}

export interface EffectLevel {
  /** The gain the effect is given. */
  gainDb: number;
  /** Its loudest momentary loudness as the mix plays it, before that gain. */
  loudestLufs: number;
  /** The voice's loudness while it speaks, as the mix plays it. */
  voiceLufs: number;
}

/**
 * The level of each sfx track given no gain, indexed like the spec's tracks: its loudest momentary (400 ms) loudness
 * set SFX_UNDER_VOICE_LU under the voice's loudness while it speaks, both as the mix plays them. Effects mostly land
 * between lines where nothing ducks them, so what is heard is an effect's peak against the voice a moment before;
 * integrated or 3 s short-term loudness would average a short hit with its tail and read it several LU quieter than
 * it sounds. A silent effect, and every effect under a silent voice, is left unmeasured.
 */
export function effectLevels(runDir: string, spec: MixSpec, levels: (readonly number[] | undefined)[] = []): (EffectLevel | undefined)[] {
  const unmeasured = spec.tracks.map((): EffectLevel | undefined => undefined);
  const hasVoice = spec.tracks.some((t) => t.role === 'voice');
  const set = spec.tracks.flatMap((t, i) => (setUnderVoice(t, hasVoice) ? [i] : []));
  if (!set.length) return unmeasured;
  const resolve = resolver(runDir);
  const voiced = spec.tracks.flatMap((t, i) => (t.role === 'voice' ? [i] : []));
  // Nothing to measure: the mix names a missing file.
  if ([...voiced, ...set].some((i) => !existsSync(resolve(spec.tracks[i].path)))) return unmeasured;
  const args = ['-hide_banner', '-nostats'];
  for (const i of [...voiced, ...set]) args.push('-i', resolve(spec.tracks[i].path));
  const d = spec.durationSec;
  const graph = voiced.map((i, n) => `${chainOf(spec.tracks[i], n, levels[i], d)}[v${n}]`);
  // Padded as the mix pads it, so a voice that stops dead is read through its last word's release like any other pause.
  graph.push(`${voiced.map((_, n) => `[v${n}]`).join('')}${voiced.length > 1 ? `${sumOf(voiced.length)},` : ''}`
    + `apad=whole_dur=${d},atrim=0:${d},ebur128@voice=framelog=info[mvoice]`);
  // Each effect is measured from its own start, so the silence before it on the timeline is not read.
  set.forEach((i, k) => graph.push(`${chainOf(spec.tracks[i], voiced.length + k, levels[i], d)},`
    + `atrim=start=${spec.tracks[i].atSec}:end=${d},ebur128@s${i}=framelog=info[ms${i}]`));
  args.push('-filter_complex', graph.join(';'), '-map', '[mvoice]', '-f', 'null', '-');
  for (const i of set) args.push('-map', `[ms${i}]`, '-f', 'null', '-');
  // A line per instance every 100 ms: a long narration logs megabytes.
  const run = spawnSync(FFMPEG, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (run.error || run.status !== 0) {
    const why = run.error?.message ?? (run.stderr ?? '').trim().split('\n').pop();
    throw new Error(`mix-audio: could not measure the loudness of the voice and the sound effects${why ? `: ${why}` : ''}`);
  }
  const momentary = momentaryOf(run.stderr ?? '');
  const unread = [...(momentary.has('voice') ? [] : voiced), ...set.filter((i) => !momentary.has(`s${i}`))];
  if (unread.length) throw new Error(`mix-audio: could not measure the loudness of ${unread.map((i) => spec.tracks[i].path).join(', ')}`);
  const voiceLufs = speakingLoudness(momentary.get('voice')!);
  if (voiceLufs === undefined) return unmeasured;
  return spec.tracks.map((_, i) => {
    if (!set.includes(i)) return undefined;
    const loudestLufs = momentary.get(`s${i}`)!.reduce((a, b) => Math.max(a, b), -Infinity);
    return loudestLufs > SILENT_LUFS ? { gainDb: voiceLufs - SFX_UNDER_VOICE_LU - loudestLufs, loudestLufs, voiceLufs } : undefined;
  });
}

export function mix(
  runDir: string,
  spec: MixSpec,
  outPath: string,
  levels = trackLevels(runDir, spec),
  voiceLufs = voiceLoudness(runDir, spec, levels),
  effects = effectLevels(runDir, spec, levels),
  fitted = fits(spec, musicSpans(runDir, spec)),
): string {
  const resolve = resolver(runDir);
  for (const t of spec.tracks) {
    if (!existsSync(resolve(t.path))) throw new Error(`mix-audio: no such track — ${t.path}`);
  }
  const { graph, out, inputs } = filtergraph(spec, levels, voiceLufs, effects.map((e) => e?.gainDb), fitted);
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const i of inputs) args.push('-i', resolve(spec.tracks[i].path));
  // A WAV is an intermediate another command levels and encodes, so it is kept as float rather than encoded twice.
  const codec = extname(outPath).toLowerCase() === '.wav' ? ['-c:a', 'pcm_f32le'] : ['-c:a', 'aac', '-b:a', '192k'];
  args.push('-filter_complex', graph, '-map', `[${out}]`, ...codec, outPath);
  mkdirSync(dirname(outPath), { recursive: true });
  execFileSync(FFMPEG, args);
  return outPath;
}

export const usage = {
  summary: "Build one soundtrack from a run's mix spec (narration/music/sfx, with ducking)",
  positionals: '<run-dir>',
  flags: {
    spec: { type: 'string', value: '<file>', help: 'Mix spec, relative to the run (default audio/mix.json)' },
    out: { type: 'string', value: '<file>', help: 'Output, relative to the run (default audio/mix.m4a)' },
    video: { type: 'string', value: '<file>', help: 'The render the mix is for: its length is the mix\'s, durationSec or not' },
    'print-graph': { type: 'boolean', help: 'Print the ffmpeg filtergraph and write nothing' },
  },
  notes: [
    'The spec is JSON:',
    '  { "durationSec": 60, "tracks": [',
    '    { "path": "assets/vo.mp3", "atSec": 0, "role": "voice" },',
    '    { "path": "assets/music.mp3", "atSec": 0, "gainDb": -14, "role": "music" } ] }',
    'durationSec: the film\'s length in seconds; the mix is padded or trimmed to exactly that. With --video it may be',
    'left out, and the video\'s length is used whatever the spec says.',
    'Each track: path (relative to the run dir, or absolute), atSec (its start on the film\'s timeline, in',
    'seconds), and optionally endSec (where it stops), gainDb (0 leaves it as recorded, negative is quieter), fadeInSec,',
    'fadeOutSec (ends at endSec, else at durationSec; 0 for none), role (voice, music, sfx or ambience), duck (whether it',
    'is lowered while the voice tracks speak) and keepPan (true: a two-channel track keeps its panning, for an effect',
    'meant to sit on one side).',
    'The music track whose sound would end last runs to durationSec, and a music track with an endSec runs to that:',
    `looped from its first sound when its sound ends sooner, joined by ${LOOP_CROSSFADE_SEC}s crossfades, and faded out over its last`,
    `${MUSIC_FADE_OUT_SEC}s unless it sets fadeOutSec; the command prints each loop it made. Its sound ends where the file falls`,
    '20 dB under its own level, so a piece that fades to silence before its file ends is looped too. Earlier music cues',
    'and every other track play to their own end, or to their endSec.',
    `An sfx track given no gainDb, in a spec with a voice track, is set so its loudest moment sits ${SFX_UNDER_VOICE_LU} LU under`,
    'the voice\'s loudness while it speaks, both measured as the mix plays them; the command prints the gain it set.',
    'Give an sfx track its own gainDb for a deliberate loud hit: it keeps that gain. With no voice track, every',
    'track plays at its own gain.',
    'Music and sfx tracks are ducked by default whenever a voice track exists, and "duck": false keeps one from',
    'dipping; any other non-voice track is ducked with "duck": true. Each voice track keys the duck at one loudness,',
    'so a ducked track dips as deep under a quiet narration as under a loud one; under one quieter than -50 LUFS the',
    'dip fades out with it. A mono file, or a two-channel one with its sound on one channel, is centred in both channels',
    'unless it sets keepPan; one leaning 12 dB or more to a side is named and left as it is. Files with more',
    'than two channels are downmixed to stereo by ffmpeg and not checked.',
    'The result is audio only. Lay it on a render at delivery loudness with',
    '  mux-audio --video <render> --audio <run-dir>/audio/mix.m4a --out <file>',
  ].join('\n'),
} satisfies Usage;

export function mixAudio(argv: string[]): number {
  const { values, positionals } = parseUsage('mix-audio', usage, argv);
  const [runDir] = positionals;
  if (!runDir) {
    console.error(usageLine('mix-audio', usage));
    return 2;
  }
  const specPath = join(runDir, values.spec ?? 'audio/mix.json');
  if (!existsSync(specPath)) {
    console.error(`mix-audio: no spec at ${specPath}; mix-audio --help shows what it holds`);
    return 2;
  }
  let spec: MixSpec;
  try {
    let raw = readSpecJson(specPath);
    if (values.video !== undefined) {
      if (!existsSync(values.video)) throw new Error(`mix-audio: no video at ${values.video}`);
      const videoSec = pictureDurationOf(values.video);
      // The picture decides the length, so a durationSec left from an earlier cut cannot end the mix short of it.
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        const stated = (raw as { durationSec?: unknown }).durationSec;
        if (typeof stated === 'number' && Math.abs(stated - videoSec) > 0.001) {
          console.log(`mix-audio: durationSec is ${stated}s in the spec and ${values.video} runs ${videoSec}s; the mix runs ${videoSec}s`);
        }
        raw = { ...raw, durationSec: videoSec };
      }
    }
    spec = parseSpec(raw);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  let levels: (number[] | undefined)[];
  let voiceLufs: (number | undefined)[];
  let effects: (EffectLevel | undefined)[];
  let fitted: (Fit | undefined)[];
  try {
    levels = trackLevels(runDir, spec);
    voiceLufs = voiceLoudness(runDir, spec, levels);
    effects = effectLevels(runDir, spec, levels);
    fitted = fits(spec, musicSpans(runDir, spec));
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
  if (values['print-graph']) {
    console.log(filtergraph(spec, levels, voiceLufs, effects.map((e) => e?.gainDb), fitted).graph);
    return 0;
  }
  // A mono file is centred as a matter of course; a one-sided or leaning two-channel one is worth saying.
  spec.tracks.forEach((t, i) => {
    const l = levels[i];
    const said = l && !t.keepPan ? describeBalance(l) : null;
    if (said) console.log(`mix-audio: ${t.path} ${said}`);
  });
  // The gain each effect was given, with both measurements it came from, so a level that sounds wrong can be traced.
  const lufs = (v: number) => `${v.toFixed(1)} LUFS`;
  spec.tracks.forEach((t, i) => {
    const e = effects[i];
    if (!e) return;
    console.log(`mix-audio: ${t.path} at ${t.atSec}s set ${e.gainDb >= 0 ? '+' : ''}${e.gainDb.toFixed(1)} dB, its loudest moment from `
      + `${lufs(e.loudestLufs)} to ${lufs(e.loudestLufs + e.gainDb)}, ${SFX_UNDER_VOICE_LU} LU under the voice speaking at ${lufs(e.voiceLufs)}`);
  });
  spec.tracks.forEach((t, i) => {
    const said = fitted[i] && describeFit(t.path, fitted[i]);
    if (said) console.log(`mix-audio: ${said}`);
  });
  const out = mix(runDir, spec, join(runDir, values.out ?? 'audio/mix.m4a'), levels, voiceLufs, effects, fitted);
  console.log(`mix-audio: ${out}`);
  return 0;
}
