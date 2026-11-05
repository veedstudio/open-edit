// The dead-tail check: a video that runs on after its last line, such as a silent end card or a "thank
// you" scene with nothing to hear. It measures how far the picture runs past the last spoken word and
// past the last sound, and reports a tail longer than TAIL_SECONDS. A tail past the last word with sound under it
// and new text on screen from the last spoken phrase on is an end card instead, reported only when held longer than
// its words take to read.
import { decode, envelopeOf, SAMPLE_RATE } from '../commands/speech-probe.ts';
import { hasAudioStream, streamStartOf } from '../probe.ts';
import { sampleSeconds, timeOf, type TextEntry, type TextRecord } from '../render/text-record.ts';
import type { Transcript } from '../transcript/transcript-types.ts';
import type { CheckReport, ReviewContext, TextRecordInput, TranscriptInput } from './checks.ts';
import { quoted, seconds as s } from './report.ts';
import { blocksOf } from './text-blocks.ts';

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

/**
 * How long on-screen text takes to read: the least time UK broadcast advertising lets text over picture hold so that
 * a viewer making some effort can read it, 0.2 s a word plus a recognition period of 2 s, or 3 s from ten words (CAP
 * and BCAP, "On screen text and subtitling in TV ads", Duration of hold). A web address counts as one word, as there.
 */
export const READING = { perWord: 0.2, recognition: 2, longRecognition: 3, longFrom: 10 } as const;

/**
 * However few its words, an end card may hold this long: 2 to 4 s is the usual hold for one, so no hold in that range
 * is reported.
 */
export const END_CARD_FLOOR = 4;

/**
 * However many its words, an end card held longer than this is reported: cards held 5 s to 8.5 s were judged too long
 * in testing. It sits halfway between the shortest of those and the top of the usual hold, a judgement, as no sample
 * falls between them.
 */
export const END_CARD_CAP = 4.5;

/** Seconds `words` take to read, by READING. */
export const readingSeconds = (words: number): number =>
  words * READING.perWord + (words >= READING.longFrom ? READING.longRecognition : READING.recognition);

/**
 * The longest an end card of `words` may hold: its reading time and then the beat TAIL_SECONDS allows after the last
 * thing to take in, as after a last line, kept between END_CARD_FLOOR and END_CARD_CAP.
 */
export const endCardLimit = (words: number): number =>
  Math.min(END_CARD_CAP, Math.max(END_CARD_FLOOR, readingSeconds(words) + TAIL_SECONDS));

/** Words to read: whitespace-separated pieces with a letter or a digit in them, so an icon or an arrow is none. */
export const wordsIn = (text: string): number => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

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
  const gate = soundGateOf(envelope);
  if (gate === null) return { end: null, gate: ABSOLUTE_GATE_DB, windows };
  const last = envelope.findLastIndex((db) => db >= gate);
  return { end: last < 0 ? null : start + ((last + 1) * windowMs) / 1000, gate, windows };
}

/** The level, in dBFS, a window of `envelope` must reach to count as sound; null when no window is above the absolute gate. */
export function soundGateOf(envelope: number[]): number | null {
  const audible = envelope.filter((db) => db > ABSOLUTE_GATE_DB);
  if (audible.length === 0) return null;
  // A power mean, as BS.1770 averages its gated blocks: loud windows dominate, so quiet stretches pull the
  // level down far less than an average of decibels would.
  const level = 10 * Math.log10(audible.reduce((sum, db) => sum + 10 ** (db / 10), 0) / audible.length);
  return Math.max(ABSOLUTE_GATE_DB, level - RELATIVE_GATE_DB);
}

export interface SoundSpan {
  /** Seconds to the start of the first window loud enough to count as sound. */
  start: number;
  /** Seconds to the end of the last one. */
  end: number;
}

/** Where sound starts and ends, gated as lastSoundOf gates it; null when nothing is loud enough to count. */
export function soundSpanOf(envelope: number[], windowMs: number, start = 0): SoundSpan | null {
  const last = lastSoundOf(envelope, windowMs, start);
  if (last.end === null) return null;
  return { start: start + (envelope.findIndex((db) => db >= last.gate) * windowMs) / 1000, end: last.end };
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

/**
 * A silence between two words longer than this ends a phrase: 250 ms is the usual floor for a silent pause, under which
 * a gap is taken for articulation rather than a break (Goldman-Eisler 1968).
 */
export const PHRASE_PAUSE = 0.25;

/**
 * Where the speech before the last spoken phrase ends: the end of the last word before the last pause longer than
 * PHRASE_PAUSE, or, with no such pause, where the first word starts.
 */
export function beforeLastPhraseOf(transcript: Transcript): number {
  const words = transcript.chunks.flatMap((chunk) => chunk.words).sort((a, b) => a.timestamp[0] - b.timestamp[0]);
  if (words.length === 0) return 0;
  let before = words[0].timestamp[0];
  let heard = words[0].timestamp[1];
  for (const word of words.slice(1)) {
    if (word.timestamp[0] - heard > PHRASE_PAUSE) before = heard;
    heard = Math.max(heard, word.timestamp[1]);
  }
  return before;
}

export interface EndCard {
  /** Seconds of the tail with the card's words on screen. */
  seconds: number;
  /** The most of the card's words on screen at once, which is what it asks a viewer to read. */
  words: number;
  /** Those words as they read, block by block. */
  text: string;
  /** Seconds of the tail with no card on screen but other words: a caption, or text up from before the last phrase. */
  leftUp: number;
}

/**
 * The end card from `from`, where the last spoken word ends, to `to` on the picture's timeline: the text that came up
 * for the ending, from `phrase`, where the pause before the last spoken phrase begins, so a card brought up with the
 * spoken call to action counts. A sample's leeway is allowed, as the record places a text only to the sample. Text up
 * since earlier, such as a title or a watermark, is left out, and so is text in an element that showed other words
 * before then, as a caption track's elements do: a last caption left up into the music, or a word-by-word caption's
 * last word, is not an end card.
 */
export function endCardOf(record: TextRecord, phrase: number, from: number, to: number): EndCard {
  const step = sampleSeconds(record);
  const since = phrase - step - 1e-9;
  const card: EndCard = { seconds: 0, words: 0, text: '', leftUp: 0 };
  const keyOf = (e: TextEntry) => `${e.selector}\u0000${e.text}`;
  // When each text on screen came up, as the same element showing the same words in every sample since.
  let upSince = new Map<string, number>();
  // The words each element showed before the last phrase.
  const earlier = new Map<string, Set<string>>();
  const isCard = (e: TextEntry) =>
    upSince.get(keyOf(e))! >= since && ![...(earlier.get(e.selector) ?? [])].some((said) => said !== e.text && wordsIn(said) > 0);
  for (const sample of record.samples) {
    const t = timeOf(record, sample.frame);
    upSince = new Map(sample.texts.map((e) => [keyOf(e), upSince.get(keyOf(e)) ?? t]));
    if (t < since) {
      for (const e of sample.texts) earlier.set(e.selector, (earlier.get(e.selector) ?? new Set<string>()).add(e.text));
      continue;
    }
    const span = Math.min(t + step, to) - Math.max(t, from);
    if (span <= 0) continue;
    const blocks = blocksOf(sample.texts.filter(isCard));
    const words = blocks.reduce((n, b) => n + wordsIn(b.text), 0);
    if (words === 0) {
      if (sample.texts.some((e) => wordsIn(e.text) > 0)) card.leftUp += span;
      continue;
    }
    card.seconds += span;
    if (words > card.words) Object.assign(card, { words, text: blocks.map((b) => b.text).join(' / ') });
  }
  return card;
}

export interface DeadTailInput {
  /** Seconds of picture. */
  duration: number;
  /** The last sound, or null when the video has no audio track. */
  sound: LastSound | null;
  transcript: TranscriptInput;
  /** What text the video shows, to tell an end card from background left running; without it, the two are reported alike. */
  textRecord?: TextRecordInput;
}

export function judgeDeadTail(
  { duration, sound: measured, transcript, textRecord = { missing: 'no record of on-screen text was given' } }: DeadTailInput,
  threshold = TAIL_SECONDS,
): CheckReport {
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
  let phrase = 0;
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
      phrase = beforeLastPhraseOf(transcript.transcript);
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
    } else if (word && speechTail !== null && speechTail > threshold) {
      // Sound runs to the end, so whether the tail is dead turns on what is on screen through it.
      if ('missing' in textRecord) {
        found = true;
        lines.push(
          `the picture runs ${s(speechTail)} past the last spoken word, with sound under it to ${s(sound.end)}: ` +
            'fine for a deliberate outro, a dead tail if that sound is background left running',
        );
        skipped.push(`whether the tail is an end card: ${textRecord.missing}`);
      } else {
        const card = endCardOf(textRecord.record, phrase, word.end, duration);
        // Up to a beat with nothing to read, before the card comes up or after it goes, is part of an ending.
        const bare = speechTail - card.seconds;
        if (bare > threshold + 1e-9) {
          found = true;
          const runOn = `the picture runs ${s(speechTail)} past the last spoken word, with sound under it to ${s(sound.end)}`;
          const part = card.seconds > 0 ? ` for ${s(bare)} of it` : '';
          lines.push(card.leftUp > 0
            ? `${runOn} and no end card${part}: the only text on screen${card.seconds > 0 ? ' then' : ''} is a caption or text up from ` +
              'before the last spoken phrase, and neither is an end card'
            : `${runOn} and no text on screen${part}: background left running, not an end card`);
        } else {
          const limit = endCardLimit(card.words);
          const words = `${card.words} word${card.words === 1 ? '' : 's'}`;
          const soundTo = duration - sound.end <= WINDOW_MS / 1000 + 1e-9 ? 'to the last frame' : `to ${s(sound.end)}`;
          found = card.seconds > limit + 1e-9;
          lines.push(
            `ends on a ${s(card.seconds)} end card with sound ${soundTo}, ` +
              `${found ? 'held longer than' : 'within'} the ${s(limit)} allowed for its ${words}: ${quoted(card.text)}`,
          );
          const reading = readingSeconds(card.words);
          if (found && reading > END_CARD_CAP) {
            lines.push(`its ${words} take ${s(reading)} to read, and an end card holds ${s(END_CARD_CAP)} at most: it has too many words for one`);
          }
        }
      }
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

export interface Sound {
  /** dBFS of each WINDOW_MS window of the first audio track. */
  envelope: number[];
  /** Where the first window sits on the picture's timeline. */
  start: number;
}

/** A video's first audio track as WINDOW_MS levels, on the picture's timeline; null when it has no track. */
export function soundIn(video: string): Sound | null {
  if (!hasAudioStream(video)) return null;
  const pcm = decode(video, null);
  // The decode starts at the track's first sample, so its windows are placed where the track starts
  // relative to the picture.
  const start = streamStartOf(video, 'a:0') - streamStartOf(video, 'v:0');
  return { envelope: envelopeOf(pcm, (SAMPLE_RATE * WINDOW_MS) / 1000), start };
}

/** The last sound in a video's first audio track, on the picture's timeline; null when it has no track. */
export function lastSoundIn(video: string): LastSound | null {
  const sound = soundIn(video);
  return sound && lastSoundOf(sound.envelope, WINDOW_MS, sound.start);
}

/**
 * Where sound starts and ends in a file's first audio track, measured as the review measures it, from the track's
 * first sample or from `start` when that sample sits elsewhere on a picture's timeline. Null when nothing counts.
 */
export function soundSpanIn(file: string, start = 0): SoundSpan | null {
  return soundSpanOf(envelopeOf(decode(file, null), (SAMPLE_RATE * WINDOW_MS) / 1000), WINDOW_MS, start);
}

export function measureDeadTail({ video, duration, transcript, textRecord }: ReviewContext): CheckReport {
  return judgeDeadTail({ duration, sound: lastSoundIn(video), transcript, textRecord });
}
