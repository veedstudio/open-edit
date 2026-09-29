// One soundtrack out of many pieces.
//
// `mux-audio.ts` restores the SOURCE audio of a clip onto its render, which is the whole audio story a
// captioned run has. A film is not that: a 12-minute documentary carried 66 narration takes, 11 sound
// effects and 6 music cues, and nothing in this repository could put them together — no `amix`, no
// `adelay`, no concat anywhere. So the run hand-wrote its own, once, and threw it away.
//
// This takes a spec and produces the mixed track. Every piece states WHERE it starts and how loud it
// sits; music that has to live under narration says so and is ducked by the narration itself rather
// than by a gain somebody guessed at.
//
//   openedit mix-audio <run-dir> [--spec audio/mix.json] [--out audio/mix.m4a]
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { FFMPEG } from '../config.ts';

export interface Track {
  /** Relative to the run dir, or absolute. */
  path: string;
  /** When it starts, in seconds on the film's timeline. */
  atSec: number;
  /** Level in dB. 0 leaves it alone; negative is quieter. */
  gainDb?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  /** Where this piece sits. `voice` is the bus everything else can duck under. */
  role?: 'voice' | 'music' | 'sfx' | 'ambience';
  /** Music under narration. Ducked by the voice bus, not by a guessed gain. */
  duck?: boolean;
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
 * The filtergraph, built as a string so it can be read and tested without running ffmpeg.
 *
 * `adelay` needs a value per channel, `amix` with `normalize=0` keeps levels where the spec put them
 * (its default divides every input by the input count, which is why a mix built without it comes out
 * mysteriously quiet), and `apad` plus `atrim` fix the total length so a short mix does not shorten
 * the film.
 */
export function filtergraph(spec: MixSpec): { graph: string; out: string } {
  if (!spec.tracks.length) throw new Error('mix-audio: the spec has no tracks');
  if (!Number.isFinite(spec.durationSec) || spec.durationSec <= 0) {
    throw new Error(`mix-audio: durationSec must be a positive number, got ${spec.durationSec}`);
  }
  const parts: string[] = [];
  const voices: string[] = [];
  const ducked: string[] = [];
  const plain: string[] = [];

  spec.tracks.forEach((t, i) => {
    if (!Number.isFinite(t.atSec) || t.atSec < 0) {
      throw new Error(`mix-audio: "${t.path}" starts at ${t.atSec}s — a start must be a non-negative number`);
    }
    const ms = Math.round(t.atSec * 1000);
    const chain = [`[${i}:a]aresample=48000`, `adelay=${ms}|${ms}`];
    if (t.gainDb) chain.push(`volume=${t.gainDb}dB`);
    if (t.fadeInSec) chain.push(`afade=t=in:st=${t.atSec}:d=${t.fadeInSec}`);
    if (t.fadeOutSec) {
      // Measured from the END of the film, because a cue's own length is not knowable from the spec.
      const at = Math.max(0, spec.durationSec - t.fadeOutSec);
      chain.push(`afade=t=out:st=${at}:d=${t.fadeOutSec}`);
    }
    const l = label(i);
    parts.push(`${chain.join(',')}[${l}]`);
    if (t.role === 'voice') voices.push(l);
    else if (t.duck) ducked.push(l);
    else plain.push(l);
  });

  if (ducked.length && !voices.length) {
    throw new Error('mix-audio: a track asks to be ducked, but no track is marked role "voice" to duck it');
  }

  let voiceBus = '';
  if (voices.length) {
    voiceBus = 'vox';
    parts.push(voices.length === 1
      ? `[${voices[0]}]anull[${voiceBus}]`
      : `${voices.map((l) => `[${l}]`).join('')}amix=inputs=${voices.length}:normalize=0[${voiceBus}]`);
  }

  const beds: string[] = [];
  if (ducked.length) {
    // The narration itself opens the gap. A threshold high enough to ignore room tone, a slow release
    // so the bed does not pump between words.
    //
    // THE THRESHOLD IS ABSOLUTE, so how deep the bed dips is set by how loud the VOICE is, not by the
    // gap between them. Measured against the same bed: a voice at -3dB pulls the mix down 1.4dB, at
    // -12dB 0.8dB, and at -24dB not at all — below the threshold nothing ducks. Level the narration
    // before mixing, or set its gain so it actually crosses; a quiet take silently gets no ducking.
    // The key is padded to the film's length. `sidechaincompress` ends its OUTPUT when the sidechain
    // ends, so an unpadded key truncated the bed at the last word — measured at -91dB against -33dB
    // for the same music one second later. Music dying when narration stops is the exact opposite of
    // what ducking is for.
    parts.push(`[${voiceBus}]asplit=2[vmix][vkeyraw]`);
    parts.push(`[vkeyraw]apad=whole_dur=${spec.durationSec}[vkey]`);
    const bed = ducked.length === 1 ? ducked[0] : 'beds';
    if (ducked.length > 1) parts.push(`${ducked.map((l) => `[${l}]`).join('')}amix=inputs=${ducked.length}:normalize=0[beds]`);
    parts.push(`[${bed}][vkey]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=600[duckedbed]`);
    beds.push('duckedbed', 'vmix');
  } else if (voiceBus) {
    beds.push(voiceBus);
  }
  beds.push(...plain);

  // `apad` with no bound pads FOREVER, and `atrim` downstream does not always close the graph — a
  // review's fifty-track stress spec ran ffmpeg for an hour without finishing. Pad to the film's own
  // length instead, so the padding ends on its own and `atrim` only ever has to cut.
  const out = 'mix';
  const tail = `apad=whole_dur=${spec.durationSec},atrim=0:${spec.durationSec},asetpts=N/SR/TB[${out}]`;
  parts.push(beds.length === 1
    ? `[${beds[0]}]${tail}`
    : `${beds.map((l) => `[${l}]`).join('')}amix=inputs=${beds.length}:normalize=0,${tail}`);

  return { graph: parts.join(';'), out };
}

const ROLES = ['voice', 'music', 'sfx', 'ambience'] as const;
export const SPEC_KEYS = ['durationSec', 'tracks'] as const;
export const TRACK_KEYS = ['path', 'atSec', 'gainDb', 'fadeInSec', 'fadeOutSec', 'role', 'duck'] as const;

/**
 * The spec as written by hand, checked field by field. Unchecked, a malformed one fails deep in the graph
 * builder with a message that names no field, and a misspelt key or role mixes the wrong thing without a word.
 */
export function parseSpec(raw: unknown): MixSpec {
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
  const { durationSec, tracks } = raw as { durationSec?: unknown; tracks?: unknown };
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
    bad(`durationSec, the film's length in seconds, must be a positive number (got ${JSON.stringify(durationSec)})`);
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
    // The voice tracks are the key the others duck under, so a ducked voice would be ignored.
    if (track.duck === true && track.role === 'voice') bad(`${at} is a voice track, which ducks the others and cannot be ducked itself`);
  });
  return raw as MixSpec;
}

export function readSpec(specPath: string): MixSpec {
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
  return parseSpec(raw);
}

export function mix(runDir: string, spec: MixSpec, outPath: string): string {
  const resolve = (p: string) => (isAbsolute(p) ? p : join(runDir, p));
  for (const t of spec.tracks) {
    if (!existsSync(resolve(t.path))) throw new Error(`mix-audio: no such track — ${t.path}`);
  }
  const { graph, out } = filtergraph(spec);
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const t of spec.tracks) args.push('-i', resolve(t.path));
  args.push('-filter_complex', graph, '-map', `[${out}]`, '-c:a', 'aac', '-b:a', '192k', outPath);
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
    'print-graph': { type: 'boolean', help: 'Print the ffmpeg filtergraph and write nothing' },
  },
  notes: [
    'The spec is JSON:',
    '  { "durationSec": 60, "tracks": [',
    '    { "path": "assets/vo.mp3", "atSec": 0, "role": "voice" },',
    '    { "path": "assets/music.mp3", "atSec": 0, "gainDb": -14, "fadeOutSec": 3, "role": "music", "duck": true },',
    '    { "path": "assets/whoosh.wav", "atSec": 12.4, "gainDb": -6, "role": "sfx" } ] }',
    'durationSec (required): the film\'s length in seconds; the mix is padded or trimmed to exactly that.',
    'Each track: path (relative to the run dir, or absolute), atSec (its start on the film\'s timeline, in',
    'seconds), and optionally gainDb (0 leaves it as recorded, negative is quieter), fadeInSec, fadeOutSec (ends at',
    'durationSec), role (voice, music, sfx or ambience) and duck (true: lowered while the voice tracks speak).',
    'Ducking keys on the voice\'s own level, so a quiet voice take barely ducks: raise its gainDb.',
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
    spec = readSpec(specPath);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  if (values['print-graph']) {
    console.log(filtergraph(spec).graph);
    return 0;
  }
  const out = mix(runDir, spec, join(runDir, values.out ?? 'audio/mix.m4a'));
  console.log(`mix-audio: ${out}`);
  return 0;
}
