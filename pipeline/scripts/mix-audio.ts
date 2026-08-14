// One soundtrack out of many pieces.
//
// `mux-audio.sh` restores the SOURCE audio of a clip onto its render, which is the whole audio story a
// captioned run has. A film is not that: a 12-minute documentary carried 66 narration takes, 11 sound
// effects and 6 music cues, and nothing in this repository could put them together — no `amix`, no
// `adelay`, no concat anywhere. So the run hand-wrote its own, once, and threw it away.
//
// This takes a spec and produces the mixed track. Every piece states WHERE it starts and how loud it
// sits; music that has to live under narration says so and is ducked by the narration itself rather
// than by a gain somebody guessed at.
//
//   node --import tsx pipeline/scripts/mix-audio.ts <run-dir> [--spec audio/mix.json] [--out audio/mix.m4a]
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFlags } from '../../veed/args.ts';
import { FFMPEG } from '../../config.ts';

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

export function mix(runDir: string, specPath: string, outPath: string): string {
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as MixSpec;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseFlags({
    args: process.argv.slice(2),
    options: { spec: { type: 'string' }, out: { type: 'string' }, 'print-graph': { type: 'boolean' } },
    allowPositionals: true,
  });
  const [runDir] = positionals;
  if (!runDir) {
    console.error('usage: mix-audio.ts <run-dir> [--spec audio/mix.json] [--out audio/mix.m4a] [--print-graph]');
    process.exit(2);
  }
  const specPath = join(runDir, values.spec ?? 'audio/mix.json');
  if (!existsSync(specPath)) {
    console.error(`mix-audio: no spec at ${specPath} — it lists each track with its path, atSec, gainDb and role`);
    process.exit(2);
  }
  if (values['print-graph']) {
    console.log(filtergraph(JSON.parse(readFileSync(specPath, 'utf8')) as MixSpec).graph);
    process.exit(0);
  }
  const out = mix(runDir, specPath, join(runDir, values.out ?? 'audio/mix.m4a'));
  console.log(`mix-audio: ${out}`);
}
