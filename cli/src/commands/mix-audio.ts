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
// piece is centred in both channels, and the music bed runs to the last frame. The page's own videos need no
// entry: each one's sound is laid where the render played it, from the record the render left beside it.
//
//   openedit mix-audio <run-dir> [--spec audio/mix.json] [--out audio/mix.m4a] [--video <render>]
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname, isAbsolute } from 'node:path';
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { FFMPEG } from '../config.ts';
import { channelLevels, describeBalance, toStereo } from '../channels.ts';
import { layStem, pageRecordOf, pageSounds, sameFile, shownPath, type Stretch } from '../page-sound.ts';
import { audioDurationOf, hasAudioStream, pictureDurationOf } from '../probe.ts';
import { recordPath } from '../render/text-record.ts';
import { soundSpanOf, WINDOW_MS, type SoundSpan } from '../verify/dead-tail.ts';
import { decode, envelopeOf, SAMPLE_RATE } from './speech-probe.ts';

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

/** How the sound of a video the page plays is laid: a track's own settings, placed where the render played it. */
export type PageVideoSettings = Pick<Track, 'gainDb' | 'fadeInSec' | 'fadeOutSec' | 'role' | 'duck' | 'keepPan'>;

export interface MixSpec {
  /** The film's length. Anything past it is trimmed, so one long cue cannot extend the deliverable. */
  durationSec: number;
  tracks: Track[];
  /** By the file it plays: false leaves a page video's sound out, settings lay it otherwise. Unnamed, each is laid as sfx. */
  pageVideos?: Record<string, false | PageVideoSettings>;
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
 * 20 dB over the -70 LUFS ebur128 reports for silence: a voice track quieter than this, or a 100 ms stretch of a music
 * file, is taken for noise rather than sound.
 */
export const SILENCE_FLOOR_DB = -50;

/**
 * The quietest voice track whose key is raised in full: 11 dB under the quietest of those 68 tracks (-39.0 LUFS),
 * at the silence floor. A quieter track is raised no further, so the duck fades out with it instead of keying on a
 * silent or near-silent track's noise.
 */
const QUIETEST_KEY_LUFS = SILENCE_FLOOR_DB;

/** How a ducked track follows the voice: how far ahead of the bed the voice is read, and the compressor's attack and release. */
interface DuckTiming {
  leadSec: number;
  attackMs: number;
  releaseMs: number;
}

/**
 * A compressor only reacts once a word has begun, so music is read leadSec behind the voice to be down before it, and
 * the slow release holds it through short pauses and lets it back gradually. The attack moves with the release: this
 * one keeps the dip under speech at the depth KEY_LUFS was set for.
 */
const MUSIC_DUCK: DuckTiming = { leadSec: 0.5, attackMs: 150, releaseMs: 3000 };

/**
 * Effects mostly land between lines, where `effectLevels` sets one given no gainDb against the voice, so a lead or a
 * slow release would duck them there too.
 */
const EFFECT_DUCK: DuckTiming = { leadSec: 0, attackMs: 20, releaseMs: 600 };

/** The duck each ducked track goes through: an sfx track its own, every other role the music's. */
const DUCKS = { bed: MUSIC_DUCK, fx: EFFECT_DUCK };
const duckOf = (t: Track): keyof typeof DUCKS => (t.role === 'sfx' ? 'fx' : 'bed');

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

/** `adelay`'s value for a delay of `v` seconds, one per channel of a stereo track. */
const ms = (v: number) => `${Math.round(v * 1000)}|${Math.round(v * 1000)}`;

/** Where a music file's sound starts and ends, as `musicSpans` measures it. */
export interface MusicSpan extends SoundSpan {
  /**
   * Seconds to where the file stays under SILENCE_FLOOR_DB, never before `end`: a last chord decays well past `end`,
   * which is where a loop joins. Unset, `end`.
   */
  silentFrom?: number;
}

/**
 * The stretches of a file whose sound spans `span` that carry it from `at` to `until` on the film: the file as it is
 * when its sound, a slow last decay included, lasts that long, else the file to its last sound, then its sound again
 * from its first, as often as it takes, each joined to the one before by LOOP_CROSSFADE_SEC. A file with no sound, or
 * with too little to hold a crossfade at each end, plays once.
 */
export function piecesOf(span: MusicSpan | null, at: number, until: number): Piece[] {
  const c = LOOP_CROSSFADE_SEC;
  if (!span || at + (span.silentFrom ?? span.end) >= until - SILENCE_SLOP_SEC || span.end - span.start < 2 * c) {
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
export function fits(spec: MixSpec, spans: readonly (MusicSpan | null | undefined)[]): (Fit | undefined)[] {
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
  const ducked: Record<keyof typeof DUCKS, string[]> = { bed: [], fx: [] };
  const plain: string[] = [];
  const hasVoice = spec.tracks.some((t) => t.role === 'voice');
  const sum = (ls: string[], out: string, then = '') => (ls.length === 1
    ? `[${ls[0]}]${then || 'anull'}[${out}]`
    : `${ls.map((l) => `[${l}]`).join('')}${sumOf(ls.length)}${then ? `,${then}` : ''}[${out}]`);
  // The label that carries several: the one itself, else their sum as `out`.
  const joined = (ls: string[], out: string): string => {
    if (ls.length === 1) return ls[0];
    parts.push(`${ls.map((l) => `[${l}]`).join('')}${sumOf(ls.length)}[${out}]`);
    return out;
  };

  const inputs: number[] = [];
  spec.tracks.forEach((t, i) => {
    const l = label(i);
    parts.push(`${chainOf(t, inputs.length, levels[i], spec.durationSec, setDb[i], fitted[i])}[${l}]`);
    inputs.push(...Array<number>(Math.max(1, fitted[i]?.pieces.length ?? 1)).fill(i));
    if (t.role === 'voice') voices.push({ l, i });
    else if (ducks(t, hasVoice)) ducked[duckOf(t)].push(l);
    else plain.push(l);
  });

  const groups = (Object.keys(DUCKS) as (keyof typeof DUCKS)[]).filter((name) => ducked[name].length);
  if (groups.length && !voices.length) {
    throw new Error('mix-audio: a track asks to be ducked, but no track is marked role "voice" to duck it');
  }

  const beds: string[] = [];
  if (groups.length) {
    // The threshold is absolute, so on the voice's own level the dip followed how loud the narration was:
    // 15dB under -16.6 LUFS, under 2dB under -32.6. Each voice track is split before the bus, and only its
    // key copy is brought to KEY_LUFS, on its own: one level for the whole bus left a quiet voice taking
    // turns with a loud one barely ducking at all. The narration is still heard at its own level.
    const keys = voices.map(({ l, i }) => {
      parts.push(`[${l}]asplit=2[${l}h][${l}k]`);
      const gain = keyGainDb(voiceLufs[i]);
      if (!gain) return `${l}k`;
      parts.push(`[${l}k]volume=${gain.toFixed(2)}dB[${l}kg]`);
      return `${l}kg`;
    });
    parts.push(sum(voices.map(({ l }) => `${l}h`), 'vmix'));
    const key = joined(keys, 'vkey');
    if (groups.length > 1) parts.push(`[${key}]asplit=2${groups.map((name) => `[${name}k]`).join('')}`);
    for (const name of groups) {
      const { leadSec, attackMs, releaseMs } = DUCKS[name];
      // Rounded once to the whole milliseconds `ms` writes for `adelay`, so the key's pad and the trim match the bed's delay.
      const lead = Math.round(leadSec * 1000) / 1000;
      let bed = joined(ducked[name], `${name}s`);
      // The duck ends with the shorter of bed and key, so the key is padded to the film's length as the mix is, then by
      // the lead the bed is delayed by.
      parts.push(`[${groups.length > 1 ? `${name}k` : key}]apad=whole_dur=${spec.durationSec}`
        + `${lead ? `,apad=pad_dur=${lead}` : ''}[${name}key]`);
      // Delayed against its key, the bed reaches a compressor that has already answered the word, one at the film's
      // first frame included; the delay is trimmed off after.
      if (lead) {
        parts.push(`[${bed}]adelay=${ms(lead)}[${name}lead]`);
        bed = `${name}lead`;
      }
      // The compressor stops at either input's end and drops what the other has not matched; ffmpeg 7 decodes the two on
      // separate threads, so the bed lost a different length of its end each run. Joined first, the two end together.
      parts.push(`[${bed}][${name}key]amerge=inputs=2,asplit=2[${name}0][${name}1]`, `[${name}0]pan=stereo|c0=c0|c1=c1[${name}in]`,
        `[${name}1]pan=stereo|c0=c2|c1=c3[${name}sc]`);
      parts.push(`[${name}in][${name}sc]sidechaincompress=threshold=0.03:ratio=8:attack=${attackMs}:release=${releaseMs}`
        + `${lead ? `,atrim=start=${lead},asetpts=N/SR/TB` : ''}[ducked${name}]`);
      beds.push(`ducked${name}`);
    }
    beds.push('vmix');
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
export const SPEC_KEYS = ['durationSec', 'tracks', 'pageVideos'] as const;
export const TRACK_KEYS = ['path', 'atSec', 'endSec', 'gainDb', 'fadeInSec', 'fadeOutSec', 'role', 'duck', 'keepPan'] as const;
export const PAGE_VIDEO_KEYS = ['gainDb', 'fadeInSec', 'fadeOutSec', 'role', 'duck', 'keepPan'] as const;

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
  const { tracks, pageVideos } = raw as { tracks?: unknown; pageVideos?: unknown };
  const durationSec = (raw as { durationSec?: unknown }).durationSec ?? lengthSec;
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
    bad(`durationSec, the film's length in seconds, must be a positive number (got ${JSON.stringify(durationSec)}); `
      + '--video supplies it from a render');
  }
  // The fields a track and a page video's sound share.
  const settings = (at: string, track: Record<string, unknown>): void => {
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
  };
  if (tracks !== undefined && !Array.isArray(tracks)) bad('tracks must be a list');
  ((tracks ?? []) as unknown[]).forEach((t, i) => {
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
    settings(at, track);
  });
  if (pageVideos !== undefined) {
    if (typeof pageVideos !== 'object' || pageVideos === null || Array.isArray(pageVideos)) {
      bad('pageVideos maps a file the page plays to false or to the settings its sound is laid with');
    }
    for (const [file, v] of Object.entries(pageVideos as object)) {
      const at = `pageVideos[${JSON.stringify(file)}]`;
      if (v === false) continue;
      if (typeof v !== 'object' || v === null || Array.isArray(v)) bad(`${at} must be false, which leaves its sound out, or the settings it is laid with`);
      onlyKnown(at, v as object, PAGE_VIDEO_KEYS);
      // A music track is looped to the film's end, and a page video's sound plays only where its picture does.
      if ((v as Track).role === 'music') bad(`${at}.role must be voice, sfx or ambience: a music track is looped to the end, and a page video's sound plays where its picture does`);
      settings(at, v as Record<string, unknown>);
    }
  }
  return { ...(raw as MixSpec), durationSec: durationSec as number, tracks: (tracks ?? []) as Track[] };
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

/** A music file's sound span, and where it falls silent, from one decode. */
function musicSpanIn(file: string): MusicSpan | null {
  const envelope = envelopeOf(decode(file, null), (SAMPLE_RATE * WINDOW_MS) / 1000);
  const span = soundSpanOf(envelope, WINDOW_MS);
  if (!span) return null;
  const heard = ((envelope.findLastIndex((db) => db > SILENCE_FLOOR_DB) + 1) * WINDOW_MS) / 1000;
  return { ...span, silentFrom: Math.max(span.end, heard) };
}

/**
 * Where each music track's sound starts and ends in its file, gated as the review gates a delivered video's, and where
 * it falls silent, indexed like the spec's tracks. Measured from the sound, not read off the file's length, because a
 * generated piece writes its own fade to silence before its file ends. Null for a file with nothing loud enough to
 * count; tracks of other roles, and files that are not there, are left unmeasured.
 */
export function musicSpans(runDir: string, spec: MixSpec): (MusicSpan | null | undefined)[] {
  const resolve = resolver(runDir);
  const measured = new Map<string, MusicSpan | null>();
  return spec.tracks.map((t) => {
    const file = resolve(t.path);
    if (t.role !== 'music' || !existsSync(file)) return undefined;
    if (!measured.has(file)) {
      try {
        measured.set(file, musicSpanIn(file));
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
export function momentaryOf(stderr: string): Map<string, number[]> {
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

/** A mistake in what the spec asks of the page's videos, refused as a malformed spec is. */
class PageVideoError extends Error {}

/** The tracks the page's videos add to a spec, the names to print them by (indexed after the spec's own), and a line for each. */
export interface PageTracks {
  tracks: Track[];
  names: Map<number, string>;
  lines: string[];
}

const secs = (v: number) => `${Number(v.toFixed(2))}s`;

function describeStretches(stretches: readonly Stretch[]): string {
  const one = (x: Stretch) => `${Number(x.in.toFixed(2))}-${secs(x.out)} of the file from ${secs(x.at)}${x.rate === 1 ? '' : ` at ${Number(x.rate.toFixed(2))}x`}`;
  const shown = stretches.slice(0, 3).map(one).join(', ');
  return stretches.length > 3 ? `${shown}, and ${stretches.length - 3} more` : shown;
}

/**
 * The sound of each <video> the page plays, as one track per file laid where the render played it, read from the
 * record of `video` or, without one, of the run's newest render. Its stretches are written as stems into `stems`. A
 * file the spec leaves out in pageVideos, lays as a track of its own, or that render laid as --footage is not laid
 * again, and one with no audio stream has nothing to lay; each says so.
 */
export function pageTracks(runDir: string, spec: MixSpec, video: string | undefined, stems: string): PageTracks {
  const resolve = resolver(runDir);
  const lines: string[] = [];
  const asked = new Map(Object.entries(spec.pageVideos ?? {}).map(([path, settings]) => [sameFile(resolve(path)), { path, settings }]));
  let found: ReturnType<typeof pageRecordOf>;
  try {
    found = pageRecordOf(runDir, video);
  } catch (error) {
    throw new Error(`mix-audio: ${(error as Error).message}`);
  }
  if (!found) {
    const where = video === undefined ? `no render in ${runDir} has a` : `${video} has no`;
    if (asked.size) {
      throw new PageVideoError(`mix-audio: pageVideos names ${[...asked.values()].map((a) => a.path).join(', ')}, but ${where} record of `
        + 'its page\'s videos beside it (<render>.text.json); --video names the render');
    }
    lines.push(`mix-audio: ${where} record of its page's videos beside it (<render>.text.json), so no page video's sound is laid in`
      + (video === undefined ? '; --video names the render' : ''));
    return { tracks: [], names: new Map(), lines };
  }
  if (video === undefined) lines.push(`mix-audio: the page's videos are read from ${recordPath(found.video)}, the run's newest render; --video names another`);
  const files = [...new Set(found.record.samples.flatMap((s) => (s.videos ?? []).map((v) => v.file)))];
  const heard = new Map<string, number>();
  for (const file of files) {
    if (!existsSync(file)) throw new Error(`mix-audio: the page played ${file}, which is no longer there; render the page again`);
    try {
      if (hasAudioStream(file)) heard.set(file, audioDurationOf(file));
    } catch (error) {
      throw new Error(`mix-audio: could not read the sound of ${file}: ${(error as Error).message}`);
    }
  }
  const unplayed = [...asked].filter(([key]) => !files.some((f) => sameFile(f) === key)).map(([, a]) => a.path);
  if (unplayed.length) {
    throw new PageVideoError(`mix-audio: pageVideos names ${unplayed.join(', ')}, which the page does not play in ${found.video} `
      + `(it plays ${files.map((f) => shownPath(runDir, f)).join(', ') || 'no video'})`);
  }
  const own = new Set(spec.tracks.map((t) => sameFile(resolve(t.path))));
  const footage = found.record.footage && sameFile(found.record.footage.file);
  const d = spec.durationSec;
  const laid: { name: string; track: Track; stretches: Stretch[]; unheard: string }[] = [];
  for (const sound of pageSounds(found.record, (file) => heard.get(file) ?? 0)) {
    const name = shownPath(runDir, sound.file);
    const key = sameFile(sound.file);
    const settings = asked.get(key)?.settings;
    const out = (why: string) => lines.push(`mix-audio: ${name}, a video the page plays from ${secs(sound.from)} to ${secs(sound.to)}, is left out: ${why}`);
    if (settings === false) { out('the spec\'s pageVideos sets it false'); continue; }
    if (own.has(key)) { out('the spec lays that file as a track of its own'); continue; }
    if (key === footage) { out('it is the footage render laid under the page, which the spec lays itself'); continue; }
    if (!heard.has(sound.file)) { out('it has no sound'); continue; }
    // Cut at the film's end, so a stem never holds sound the mix trims.
    const stretches = sound.stretches.filter((x) => x.at < d - 0.001)
      .map((x) => (x.at + (x.out - x.in) / x.rate > d ? { ...x, out: x.in + (d - x.at) * x.rate } : x));
    const unheard = sound.unheard.map((u) => `; silent from ${secs(u.from)} to ${secs(u.to)}, where it `
      + (u.rate < 0 ? 'plays backwards' : `moves at ${Number(u.rate.toFixed(2))}x, a speed Chrome plays no sound at`)).join('');
    if (!stretches.length) {
      out(sound.stretches.length ? `it plays only after the mix ends at ${secs(d)}`
        : unheard.slice(2) || 'it holds still or shows only frames after its sound ends, so none of its sound plays');
      continue;
    }
    const stem = join(stems, `${laid.length}.wav`);
    const { atSec, lengthSec } = layStem(sound.file, stretches, stem);
    // Laid as a sound effect, which is what a page video's own sound is to the piece: ducked under the voice and, given no
    // gain, set under it by measuring both. As music it would be looped to the film's end, and as ambience it would play
    // at its own level over the words.
    const track: Track = { path: stem, atSec, endSec: Number((atSec + lengthSec).toFixed(3)), role: 'sfx', ...settings };
    laid.push({ name, track, stretches, unheard });
  }
  const hasVoice = [...spec.tracks, ...laid.map((l) => l.track)].some((t) => t.role === 'voice');
  for (const { name, track, stretches, unheard } of laid) {
    const level = track.gainDb === undefined ? '' : ` at ${track.gainDb >= 0 ? '+' : ''}${track.gainDb} dB`;
    const ducked = ducks(track, hasVoice) ? ', ducked under the voice' : '';
    lines.push(`mix-audio: ${name}, a video the page plays, laid in as ${track.role}${level}${ducked}: ${describeStretches(stretches)}${unheard}`);
  }
  return { tracks: laid.map((l) => l.track), names: new Map(laid.map((l, j) => [spec.tracks.length + j, l.name])), lines };
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
    video: { type: 'string', value: '<file>', help: 'The render the mix is for: its length is the mix\'s, durationSec or not, and its record names the videos its page plays' },
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
    `${MUSIC_FADE_OUT_SEC}s unless it sets fadeOutSec; the command prints each loop it made. It plays once when the file is still`,
    `over ${SILENCE_FLOOR_DB} dBFS where it stops, so a last chord decaying to the file's end is not looped; a loop joins where the`,
    'file falls 20 dB under its own level, so a piece that fades to silence before its file ends is looped too. Earlier',
    'music cues and every other track play to their own end, or to their endSec.',
    `An sfx track given no gainDb, in a spec with a voice track, is set so its loudest moment sits ${SFX_UNDER_VOICE_LU} LU under`,
    'the voice\'s loudness while it speaks, both measured as the mix plays them; the command prints the gain it set.',
    'Give an sfx track its own gainDb for a deliberate loud hit: it keeps that gain. With no voice track, every',
    'track plays at its own gain.',
    'Music and sfx tracks are ducked by default whenever a voice track exists, and "duck": false keeps one from',
    'dipping; any other non-voice track is ducked with "duck": true. A ducked track other than an sfx track is already',
    'down when a line starts and comes back over about a second and a half after it; an sfx track\'s duck lets go within',
    'the beat after a line. Each voice track keys the duck at one loudness, so a ducked track dips as deep under a quiet',
    'narration as under a loud one; under one quieter than -50 LUFS the dip fades out with it. A mono file, or a',
    'two-channel one with its sound on one channel, is centred in both channels unless it sets keepPan; one leaning',
    '12 dB or more to a side is named and left as it is. Files with more than two channels are downmixed to stereo by',
    'ffmpeg and not checked.',
    'The sound of each <video> the page plays is laid in as an sfx track where the render played it, its trims, loops',
    'and speed included, read from the record beside --video (else beside the run\'s newest render), unless a track names',
    'its file or render laid it with --footage; pageVideos maps a file the page plays (named as path is) to false, which',
    'leaves its sound out, or to the fields gainDb, fadeInSec, fadeOutSec, role (voice, sfx or ambience), duck and keepPan,',
    'which lay it otherwise, tracks may be empty when these are the whole soundtrack, and the command prints a line for each.',
    'The result is audio only. Lay it on a render at delivery loudness with',
    '  mux-audio --video <render> --audio <run-dir>/audio/mix.m4a --out <file>',
  ].join('\n'),
} satisfies Usage;

export function mixAudio(argv: string[]): number {
  // The page's videos are laid as stems, each a file of this attempt's own.
  const stems = mkdtempSync(join(tmpdir(), 'openedit-page-sound-'));
  try {
    return mixInto(argv, stems);
  } finally {
    rmSync(stems, { recursive: true, force: true });
  }
}

function mixInto(argv: string[], stems: string): number {
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
  let page: PageTracks;
  try {
    page = pageTracks(runDir, spec, values.video, stems);
  } catch (error) {
    console.error((error as Error).message);
    return error instanceof PageVideoError ? 2 : 1;
  }
  spec = { ...spec, tracks: [...spec.tracks, ...page.tracks] };
  if (!spec.tracks.length) {
    for (const line of page.lines) console.log(line);
    console.error('mix-audio: nothing to mix: the spec has no tracks, and no video the page plays has sound to lay in');
    return 2;
  }
  const nameOf = (i: number) => page.names.get(i) ?? spec.tracks[i].path;
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
  for (const line of page.lines) console.log(line);
  // A mono file is centred as a matter of course; a one-sided or leaning two-channel one is worth saying.
  spec.tracks.forEach((t, i) => {
    const l = levels[i];
    const said = l && !t.keepPan ? describeBalance(l) : null;
    if (said) console.log(`mix-audio: ${nameOf(i)} ${said}`);
  });
  // The gain each effect was given, with both measurements it came from, so a level that sounds wrong can be traced.
  const lufs = (v: number) => `${v.toFixed(1)} LUFS`;
  spec.tracks.forEach((t, i) => {
    const e = effects[i];
    if (!e) return;
    console.log(`mix-audio: ${nameOf(i)} at ${t.atSec}s set ${e.gainDb >= 0 ? '+' : ''}${e.gainDb.toFixed(1)} dB, its loudest moment from `
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
