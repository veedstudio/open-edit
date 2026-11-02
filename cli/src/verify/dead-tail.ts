// The dead-tail check: a video that runs on after its last line, such as a silent end card or a "thank
// you" scene with nothing to hear. It measures how far the picture runs past the last spoken word and
// past the last sound, and reports a tail longer than TAIL_SECONDS.
import { decode, envelopeOf, SAMPLE_RATE } from '../commands/speech-probe.ts';
import { hasAudioStream, streamStartOf } from '../probe.ts';
import type { Transcript } from '../transcript/transcript-types.ts';
import type { CheckReport, ReviewContext, TranscriptInput } from './checks.ts';

/**
 * About a second is where a silence starts to read as something gone wrong (Jefferson 1989: a "standard
 * maximum" silence of about one second in conversation), so a deliberate beat after the last line sits under it.
 */
export const TAIL_SECONDS = 1;

/** The envelope's resolution: finer than any tail worth reporting. */
export const WINDOW_MS = 100;

/**
 * Below this a window is silence however loud the rest of the piece is: ITU-R BS.1770's absolute gate,
 * borrowed for 100 ms RMS windows (it is defined on K-weighted 400 ms blocks).
 */
export const ABSOLUTE_GATE_DB = -70;

/**
 * A window this far under the piece's own level is background, so room tone after the last line is silence and a
 * music outro at the piece's level is sound. It is EBU Tech 3342's relative gate, defined on K-weighted 3 s
 * blocks and borrowed for 100 ms RMS windows.
 */
export const RELATIVE_GATE_DB = 20;

// ASR word ends overshoot a little, so a last word may end this far after the sound, or the picture,
// before its transcript is taken to belong to another timeline.
const WORD_SLACK = 0.5;

export interface LastSound {
  /** Seconds to the end of the last window loud enough to count as sound; null when none is. */
  end: number | null;
  /** The level a window had to reach, in dBFS. */
  gate: number;
  /** Full windows measured: none means the audio was too short to say anything about. */
  windows: number;
}

/**
 * Where the last sound ends, gated against the piece's own level so a quiet mix and a loud one agree.
 * `start` is where the envelope's first window sits on the picture's timeline. The levels are plain RMS
 * rather than K-weighted loudness: the few dB K-weighting moves a window do not move a one-second boundary.
 */
export function lastSoundOf(envelope: number[], windowMs: number, start = 0): LastSound {
  const windows = envelope.length;
  const audible = envelope.filter((db) => db > ABSOLUTE_GATE_DB);
  if (audible.length === 0) return { end: null, gate: ABSOLUTE_GATE_DB, windows };
  // A power mean, as BS.1770 averages its gated blocks: loud windows dominate, so quiet stretches pull the
  // level down far less than an average of decibels would.
  const level = 10 * Math.log10(audible.reduce((sum, db) => sum + 10 ** (db / 10), 0) / audible.length);
  const gate = Math.max(ABSOLUTE_GATE_DB, level - RELATIVE_GATE_DB);
  const last = envelope.findLastIndex((db) => db >= gate);
  return { end: last < 0 ? null : start + ((last + 1) * windowMs) / 1000, gate, windows };
}

export interface LastWord {
  text: string;
  end: number;
}

export function lastWordOf(transcript: Transcript): LastWord | null {
  let last: LastWord | null = null;
  for (const chunk of transcript.chunks) {
    for (const word of chunk.words) {
      if (!last || word.timestamp[1] > last.end) last = { text: word.text.trim(), end: word.timestamp[1] };
    }
  }
  return last;
}

export interface DeadTailInput {
  /** Seconds of picture. */
  duration: number;
  /** The last sound, or null when the video has no audio track. */
  sound: LastSound | null;
  transcript: TranscriptInput;
}

const s = (seconds: number) => `${seconds.toFixed(2)}s`;

export function judgeDeadTail({ duration, sound: measured, transcript }: DeadTailInput, threshold = TAIL_SECONDS): CheckReport {
  const lines: string[] = [];
  const skipped: string[] = [];

  let sound = measured;
  if (!sound) {
    skipped.push('the last sound: the video has no audio track');
  } else if (sound.windows === 0) {
    skipped.push(`the last sound: the audio is shorter than one ${WINDOW_MS} ms window, too short to measure`);
    sound = null;
  }

  // The audio is the measurement. A transcript is trusted only where the audio, or with no audio the
  // picture, leaves room for its last word: one from another timeline would otherwise hide a silence.
  let word: LastWord | null = null;
  let wordLine: string | null = null;
  if ('missing' in transcript) {
    skipped.push(`the last spoken word: ${transcript.missing}`);
  } else {
    word = lastWordOf(transcript.transcript);
    const room = sound ? (sound.end ?? 0) : duration;
    if (!word) {
      skipped.push(`the last spoken word: ${transcript.path} holds no words`);
    } else if (word.end > room + WORD_SLACK) {
      // Past the picture the transcript is certainly another timeline's; past the gated sound it may be,
      // or the ending may just be quieter than the gate, and the report cannot tell which.
      let why: string;
      if (!sound) {
        why = `, after the picture ends at ${s(duration)}, so it is not on this video's timeline`;
      } else if (sound.end === null) {
        why = " over an audio track with nothing loud enough to count as sound: either it is not on this video's timeline, or the speech is quieter than the gate";
      } else {
        why = `, ${s(word.end - sound.end)} after the last sound at ${s(sound.end)}: either it is not on this video's timeline, or the ending is quieter than the gate`;
      }
      skipped.push(`the last spoken word: ${transcript.path} has a word ending at ${s(word.end)}${why}`);
      word = null;
    } else {
      wordLine = `the last spoken word, "${word.text}", ends at ${s(word.end)} (${transcript.path})`;
    }
  }

  if (sound && sound.end === null) {
    lines.push(`all ${s(duration)} are silent: nothing in the audio track reaches ${sound.gate.toFixed(0)} dBFS`);
    return { verdict: 'found', lines, skipped };
  }

  let found = false;
  const speechTail = word ? Math.max(0, duration - word.end) : null;
  if (sound && sound.end !== null) {
    // A word inside the slack is a quiet ending the gate missed, so it still counts as heard.
    const heard = Math.max(sound.end, word?.end ?? 0);
    const silentTail = Math.max(0, duration - heard);
    if (silentTail > threshold) {
      found = true;
      lines.push(`the last ${s(silentTail)} are silent: nothing is heard after ${s(heard)}, and the picture runs to ${s(duration)}`);
    } else if (speechTail !== null && speechTail > threshold) {
      found = true;
      lines.push(
        `the picture runs ${s(speechTail)} past the last spoken word, with sound under it to ${s(sound.end)}: ` +
          'fine for a deliberate outro, a dead tail if that sound is background left running',
      );
    } else {
      lines.push(
        `ends on time: the picture ends ${s(silentTail)} after the last sound` +
          (speechTail === null ? '' : ` and ${s(speechTail)} after the last spoken word`),
      );
    }
  } else if (speechTail !== null) {
    found = speechTail > threshold;
    lines.push(found
      ? `the picture runs ${s(speechTail)} past the last spoken word, to ${s(duration)}`
      : `ends on time: the picture ends ${s(speechTail)} after the last spoken word`);
  } else {
    return { verdict: 'skipped', lines, skipped };
  }
  if (wordLine) lines.push(wordLine);
  return { verdict: found ? 'found' : 'pass', lines, skipped };
}

/** The last sound in a video's first audio track, on the picture's timeline; null when it has no track. */
export function lastSoundIn(video: string): LastSound | null {
  if (!hasAudioStream(video)) return null;
  const pcm = decode(video, null);
  // The decode starts at the track's first sample, so its windows are placed where the track starts
  // relative to the picture.
  const start = streamStartOf(video, 'a:0') - streamStartOf(video, 'v:0');
  return lastSoundOf(envelopeOf(pcm, (SAMPLE_RATE * WINDOW_MS) / 1000), WINDOW_MS, start);
}

export function measureDeadTail({ video, duration, transcript }: ReviewContext): CheckReport {
  return judgeDeadTail({ duration, sound: lastSoundIn(video), transcript });
}
