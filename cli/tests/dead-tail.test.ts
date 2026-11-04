// Tests src/verify/dead-tail.ts. The gate and the judgement are pure, so most cases are envelopes,
// transcripts and records of on-screen text written out; synthesised clips then run the measurement end to
// end, among them one with a silent tail, one that ends on its last line and one that ends on an end card.
//   Run:  node --import tsx --test cli/tests/dead-tail.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { FFMPEG } from '../src/config.ts';
import {
  beforeLastPhraseOf, END_CARD_CAP, END_CARD_FLOOR, endCardLimit, judgeDeadTail, lastSoundIn, lastSoundOf, lastWordOf, measureDeadTail,
  readingSeconds, soundSpanOf, TAIL_SECONDS, WINDOW_MS, type LastSound,
} from '../src/verify/dead-tail.ts';
import { pictureDurationOf } from '../src/probe.ts';
import type { TextEntry, TextSample } from '../src/render/text-record.ts';
import type { Transcript } from '../src/transcript/transcript-types.ts';
import type { TextRecordInput, TranscriptInput } from '../src/verify/checks.ts';
import { TESTSRC, scratchDir, synthClip } from './helpers/synth.ts';

/** An envelope at WINDOW_MS per entry: `[dBFS, seconds]` stretches in order. */
const envelope = (...stretches: [number, number][]): number[] =>
  stretches.flatMap(([db, seconds]) => Array(Math.round((seconds * 1000) / WINDOW_MS)).fill(db));

/** A transcript whose words end at the given times, each a quarter second long. */
const transcriptOf = (...ends: number[]): Transcript => {
  const words = ends.map((end, i) => ({ text: `w${i + 1}`, timestamp: [end - 0.25, end] as [number, number] }));
  const text = words.map((w) => w.text).join(' ');
  return { text, chunks: [{ text, timestamp: [words[0].timestamp[0], ends.at(-1)!], words }] };
};

const given = (transcript: Transcript): TranscriptInput => ({ path: 'runs/piece/transcript.json', transcript });
const NONE: TranscriptInput = { missing: 'none passed' };
const sound = (end: number | null): LastSound => ({ end, gate: -40, windows: 100 });

type Box = [number, number, number, number];
/** A text over [from, to), in an element of its own unless `el` names one it shares. */
interface Showing { text: string; from: number; to: number; box?: Box; el?: string }
/** Where a caption sits, and where an end card does: far enough apart to read as two texts. */
const CAPTION: Box = [100, 1500, 880, 80];
const CARD: Box = [100, 900, 880, 120];
const TITLE: Box = [100, 200, 880, 120];

/** A 1080x1920 record at 30 fps, read every third frame. */
function recordOf(seconds: number, showing: Showing[]): TextRecordInput {
  const frames = Math.round(seconds * 30);
  const samples: TextSample[] = [];
  for (let frame = 0; frame < frames; frame += 3) {
    const t = frame / 30;
    const texts = showing.flatMap((x, i): TextEntry[] => (t >= x.from - 1e-9 && t < x.to - 1e-9
      ? [{ text: x.text, box: x.box ?? CARD, fontSize: 64, color: [255, 255, 255, 1], opacity: 1, selector: x.el ?? `#t${i}` }] : []));
    samples.push({ frame, time: Math.round(t * 1000) / 1000, texts });
  }
  return {
    path: 'runs/piece/out.mp4.text.json',
    record: { version: 1, page: 'index.html', width: 1080, height: 1920, fps: '30', frames, transparent: false, framesPerSample: 3, samples },
  };
}

/** Words a quarter second long, back to back, from `from` to `to` seconds: their ends. */
const run = (from: number, to: number): number[] => Array.from({ length: Math.round((to - from) / 0.25) }, (_, i) => from + 0.25 * (i + 1));
/** Speech from 2s to 6s, a pause, and a last phrase from 7.5s to 9s, captioned in one element. */
const SPEECH = transcriptOf(...run(2, 6), ...run(7.5, 9));
const SPOKEN = given(SPEECH);
const CAPTIONS: Showing[] = [
  { text: 'the first line', from: 2, to: 6, box: CAPTION, el: '#cap' },
  { text: 'and the last line', from: 7.5, to: 9, box: CAPTION, el: '#cap' },
];
const LEFT_UP = 'the picture runs 3.00s past the last spoken word, with sound under it to 12.00s and no end card: '
  + 'the only text on screen is a caption or text up from before the last spoken phrase, and neither is an end card';
const CTA = 'Link in bio for the full guide';

// --- where the last sound ends ---------------------------------------------------

await test('the last sound ends where the level last reaches the gate', () => {
  assert.equal(lastSoundOf(envelope([-20, 3], [-100, 4]), WINDOW_MS).end, 3);
});

await test('sound starts where the level first reaches the same gate, so a quiet lead-in is silence', () => {
  assert.deepEqual(soundSpanOf(envelope([-55, 1.5], [-20, 3], [-100, 4]), WINDOW_MS), { start: 1.5, end: 4.5 });
  assert.deepEqual(soundSpanOf(envelope([-20, 3]), WINDOW_MS, 0.5), { start: 0.5, end: 3.5 }, 'placed where the track starts');
  assert.equal(soundSpanOf(envelope([-100, 3]), WINDOW_MS), null);
});

await test('room tone after the last line is silence, not sound', () => {
  // A camera left rolling: 20 dB and more under the speech is background, the relative gate's whole point.
  assert.equal(lastSoundOf(envelope([-20, 3], [-55, 4]), WINDOW_MS).end, 3);
});

await test('a music outro at the piece\'s own level is sound', () => {
  assert.equal(lastSoundOf(envelope([-20, 3], [-24, 4]), WINDOW_MS).end, 7);
});

await test('a quiet mix and a loud one put the end in the same place', () => {
  const loud = lastSoundOf(envelope([-12, 3], [-50, 1], [-14, 1], [-100, 2]), WINDOW_MS);
  const quiet = lastSoundOf(envelope([-32, 3], [-70, 1], [-34, 1], [-100, 2]), WINDOW_MS);
  assert.equal(loud.end, 5);
  assert.equal(quiet.end, 5);
  // Each ends on a stretch 25 dB under its own level, and the mixes sit 30 dB apart: a fixed gate ends the loud
  // one at 3s only above -37 dBFS and the quiet one only at -42 or below, never both.
  assert.equal(lastSoundOf(envelope([-12, 3], [-37, 2], [-100, 2]), WINDOW_MS).end, 3);
  assert.equal(lastSoundOf(envelope([-42, 3], [-67, 2], [-100, 2]), WINDOW_MS).end, 3);
});

await test('below the absolute gate a window is silence, however quiet the piece', () => {
  // The relative gate alone would sit at -80 here and count the -75 stretch as sound.
  assert.equal(lastSoundOf(envelope([-60, 3], [-75, 4]), WINDOW_MS).end, 3);
});

await test('digital silence does not drag the piece\'s level down and let background through', () => {
  // Averaged in, thirty seconds of silence would lower the gate to about -55 and count the -50 second.
  assert.equal(lastSoundOf(envelope([-20, 1], [-50, 1], [-100, 30]), WINDOW_MS).end, 1);
});

await test('digital silence, and an envelope that measured nothing, hold no sound at all', () => {
  assert.equal(lastSoundOf(envelope([-100, 5]), WINDOW_MS).end, null);
  assert.deepEqual(lastSoundOf([], WINDOW_MS), { end: null, gate: -70, windows: 0 });
});

await test('a track that starts after the picture has its sound placed on the picture\'s timeline', () => {
  assert.equal(lastSoundOf(envelope([-20, 3]), WINDOW_MS, 2).end, 5);
});

await test('the last word is the one that ends last, whichever chunk holds it', () => {
  const transcript: Transcript = {
    text: 'b a',
    chunks: [
      { text: 'b', timestamp: [0, 4], words: [{ text: ' late ', timestamp: [3, 4] }] },
      { text: 'a', timestamp: [1, 2], words: [{ text: 'early', timestamp: [1, 2] }] },
    ],
  };
  assert.deepEqual(lastWordOf(transcript), { text: 'late', end: 4 });
  assert.equal(lastWordOf({ text: '', chunks: [] }), null);
});

// --- the judgement ---------------------------------------------------------------

await test('a silent tail longer than the threshold is reported, with where the sound stops', () => {
  const report = judgeDeadTail({ duration: 12, sound: sound(8), transcript: given(transcriptOf(3, 7.9)) });
  assert.equal(report.verdict, 'found');
  assert.match(report.lines[0], /the last 4\.00s are silent: nothing is heard after 8\.00s, and the picture runs to 12\.00s/);
  assert.match(report.lines[1], /the last spoken word, "w2", ends at 7\.90s \(runs\/piece\/transcript\.json\)/);
  assert.deepEqual(report.skipped, []);
});

await test('a video that ends on its last line passes', () => {
  const report = judgeDeadTail({ duration: 6, sound: sound(5.8), transcript: given(transcriptOf(5.7)) });
  assert.equal(report.verdict, 'pass');
  assert.match(report.lines[0], /^ends on time: the picture ends 0\.20s after the last sound and 0\.30s after the last spoken word/);
});

await test('the threshold is one second, and only a longer tail is reported', () => {
  assert.equal(TAIL_SECONDS, 1);
  assert.equal(judgeDeadTail({ duration: 6.5, sound: sound(5), transcript: NONE }).verdict, 'found');
  assert.equal(judgeDeadTail({ duration: 5.9, sound: sound(5), transcript: NONE }).verdict, 'pass');
  assert.equal(judgeDeadTail({ duration: 6, sound: sound(5), transcript: NONE }).verdict, 'pass');
  assert.equal(judgeDeadTail({ duration: 7, sound: null, transcript: given(transcriptOf(6)) }).verdict, 'pass');
});

await test('a picture that runs on past the last word under other sound is reported, and named as possibly deliberate', () => {
  const report = judgeDeadTail({ duration: 12, sound: sound(11.9), transcript: given(transcriptOf(11.5, 8.5)) });
  assert.equal(report.verdict, 'pass', 'the last word is the one that ends last');
  const past = judgeDeadTail({ duration: 12, sound: sound(11.9), transcript: given(transcriptOf(8.5)) });
  assert.equal(past.verdict, 'found');
  assert.match(past.lines[0], /runs 3\.50s past the last spoken word, with sound under it to 11\.90s: fine for a deliberate outro/);
});

await test('a last word just past the measured sound is a quiet ending the gate missed, and counts as heard', () => {
  assert.equal(judgeDeadTail({ duration: 6.6, sound: sound(5.5), transcript: NONE }).verdict, 'found');
  const report = judgeDeadTail({ duration: 6.6, sound: sound(5.5), transcript: given(transcriptOf(5.9)) });
  assert.equal(report.verdict, 'pass');
  assert.deepEqual(report.skipped, []);
});

await test('a transcript from another timeline cannot hide a measured silent tail', () => {
  // Sound for 4s of a 10s picture, and a transcript (the source's, say, before a head trim) ending at 9.8s.
  const report = judgeDeadTail({ duration: 10, sound: sound(4), transcript: given(transcriptOf(9.8)) });
  assert.equal(report.verdict, 'found');
  assert.match(report.lines[0], /the last 6\.00s are silent/);
  // The check cannot tell a transcript from another timeline from an ending quieter than the gate, so the
  // message names both.
  assert.match(
    report.skipped[0],
    /runs\/piece\/transcript\.json has a word ending at 9\.80s, 5\.80s after the last sound at 4\.00s: either it is not on this video's timeline, or the ending is quieter than the gate/,
  );
  assert.doesNotMatch(report.lines.join('\n'), /spoken word/);
});

await test('a speaking transcript over a track with no sound at all names both possible causes too', () => {
  const report = judgeDeadTail({ duration: 10, sound: { end: null, gate: -70, windows: 100 }, transcript: given(transcriptOf(6)) });
  assert.match(report.skipped[0], /over an audio track with nothing loud enough to count as sound: either it is not on this video's timeline, or the speech is quieter than the gate/);
});

await test('a last word up to half a second past the sound is used, and one further is set aside', () => {
  const near = judgeDeadTail({ duration: 7, sound: sound(5.5), transcript: given(transcriptOf(6)) });
  assert.deepEqual(near.skipped, []);
  assert.match(near.lines.join('\n'), /"w1", ends at 6\.00s/);
  const far = judgeDeadTail({ duration: 7, sound: sound(5.5), transcript: given(transcriptOf(6.1)) });
  assert.match(far.skipped[0], /not on this video's timeline/);
});

await test('with no audio track, a last word up to half a second past the picture is used, and one further is set aside', () => {
  const near = judgeDeadTail({ duration: 6, sound: null, transcript: given(transcriptOf(6.5)) });
  assert.deepEqual(near.skipped, ['the last sound: the video has no audio track']);
  assert.match(near.lines.join('\n'), /"w1", ends at 6\.50s/);
  const far = judgeDeadTail({ duration: 6, sound: null, transcript: given(transcriptOf(6.6)) });
  assert.match(far.skipped[1], /has a word ending at 6\.60s, after the picture ends at 6\.00s, so it is not on this video's timeline/);
});

await test('without a transcript the sound is still judged, and the report says what it skipped', () => {
  const report = judgeDeadTail({ duration: 12, sound: sound(8), transcript: { missing: 'no transcript beside the video' } });
  assert.equal(report.verdict, 'found');
  assert.deepEqual(report.skipped, ['the last spoken word: no transcript beside the video']);
});

await test('a transcript with no words is said, not read as speech that ended at zero', () => {
  const report = judgeDeadTail({ duration: 6, sound: sound(5.9), transcript: given({ text: '', chunks: [] }) });
  assert.equal(report.verdict, 'pass');
  assert.match(report.skipped[0], /holds no words/);
});

await test('with no audio track the last word alone is compared, and the missing track is named', () => {
  const report = judgeDeadTail({ duration: 10, sound: null, transcript: given(transcriptOf(6)) });
  assert.equal(report.verdict, 'found');
  assert.match(report.lines[0], /the picture runs 4\.00s past the last spoken word, to 10\.00s/);
  assert.deepEqual(report.skipped, ['the last sound: the video has no audio track']);
});

await test('with neither a track nor a transcript there is nothing to compare, and both are named as skipped', () => {
  const report = judgeDeadTail({ duration: 10, sound: null, transcript: NONE });
  assert.equal(report.verdict, 'skipped');
  assert.deepEqual(report.lines, []);
  assert.deepEqual(report.skipped, ['the last sound: the video has no audio track', 'the last spoken word: none passed']);
});

await test('an audio track with nothing in it is reported as silent end to end', () => {
  const report = judgeDeadTail({ duration: 10, sound: { end: null, gate: -70, windows: 100 }, transcript: NONE });
  assert.equal(report.verdict, 'found');
  assert.match(report.lines[0], /all 10\.00s are silent/);
});

await test('audio shorter than one window is too short to measure, not silent', () => {
  const report = judgeDeadTail({ duration: 0.08, sound: { end: null, gate: -70, windows: 0 }, transcript: NONE });
  assert.equal(report.verdict, 'skipped');
  assert.match(report.skipped[0], /the audio is shorter than one 100 ms window, too short to measure/);
});

// --- an end card -----------------------------------------------------------------

await test('the last phrase starts after the last pause longer than a quarter second, or with the speech when there is none', () => {
  assert.equal(beforeLastPhraseOf(SPEECH), 6);
  assert.equal(beforeLastPhraseOf(transcriptOf(1, 2, 3)), 2, 'each word follows a pause of 0.75s');
  assert.equal(beforeLastPhraseOf(transcriptOf(1, 1.5)), 0.75, 'a gap of exactly 0.25s is not a pause');
  assert.equal(beforeLastPhraseOf({ text: '', chunks: [] }), 0);
});

await test('an end card may hold its reading time and a beat, never under the floor nor over the cap', () => {
  assert.deepEqual([END_CARD_FLOOR, END_CARD_CAP], [4, 4.5]);
  // 0.2s a word and 2s to find the text, 3s from ten words.
  assert.deepEqual([1, 7, 9, 10, 13].map((n) => readingSeconds(n).toFixed(2)), ['2.20', '3.40', '3.80', '5.00', '5.60']);
  assert.deepEqual([1, 5, 6, 7, 8, 10, 30].map((n) => endCardLimit(n).toFixed(2)), ['4.00', '4.00', '4.20', '4.40', '4.50', '4.50', '4.50']);
});

await test('a 3s call-to-action card over music to the last frame passes, and the report says it is an end card', () => {
  const report = judgeDeadTail({ duration: 12, sound: sound(12), transcript: SPOKEN, textRecord: recordOf(12, [...CAPTIONS, { text: CTA, from: 9, to: 12 }]) });
  assert.equal(report.verdict, 'pass', report.lines.join('\n'));
  assert.equal(report.lines[0], `ends on a 3.00s end card with sound to the last frame, within the 4.40s allowed for its 7 words: "${CTA}"`);
  assert.match(report.lines[1], /the last spoken word, "w22", ends at 9\.00s/);
  assert.deepEqual(report.skipped, []);
});

await test('the same card over a silent tail is reported as silence', () => {
  const report = judgeDeadTail({ duration: 12, sound: sound(9), transcript: SPOKEN, textRecord: recordOf(12, [...CAPTIONS, { text: CTA, from: 9, to: 12 }]) });
  assert.equal(report.verdict, 'found');
  assert.match(report.lines[0], /^the last 3\.00s are silent: nothing is heard after 9\.00s, and the picture runs to 12\.00s$/);
});

await test('a picture running on under background sound with nothing to read is reported', () => {
  const bare = judgeDeadTail({ duration: 12, sound: sound(12), transcript: SPOKEN, textRecord: recordOf(12, CAPTIONS) });
  assert.equal(bare.verdict, 'found');
  assert.equal(bare.lines[0], 'the picture runs 3.00s past the last spoken word, with sound under it to 12.00s and no text on screen: '
    + 'background left running, not an end card');
  // A card that comes up only after a second and a half of nothing leaves the picture running on before it.
  const late = judgeDeadTail({ duration: 12, sound: sound(12), transcript: SPOKEN, textRecord: recordOf(12, [...CAPTIONS, { text: CTA, from: 10.5, to: 12 }]) });
  assert.equal(late.verdict, 'found');
  assert.match(late.lines[0], /and no text on screen for 1\.50s of it: background left running, not an end card$/);
});

await test('a caption or text up from before the last phrase is not an end card, and the report says so rather than that nothing is on screen', () => {
  const judged = (showing: Showing[]) => judgeDeadTail({ duration: 12, sound: sound(12), transcript: SPOKEN, textRecord: recordOf(12, showing) });
  // The last caption stuck on through three seconds of music: up with the last phrase, in the element the captions use.
  const stuck = judged([CAPTIONS[0], { ...CAPTIONS[1], to: 12 }]);
  assert.equal(stuck.verdict, 'found');
  assert.equal(stuck.lines[0], LEFT_UP);
  // A banner that fades in just after the speech starts and stays to the end is a title, not a card for the ending.
  const banner = judged([...CAPTIONS, { text: '3 tips for better sleep', from: 2.2, to: 12, box: TITLE }]);
  assert.equal(banner.verdict, 'found');
  assert.equal(banner.lines[0], LEFT_UP);
  // A handle up through the whole piece is the page's own.
  assert.equal(judged([...CAPTIONS, { text: '@studio', from: 0, to: 12, box: [40, 40, 300, 60] }]).lines[0], LEFT_UP);
  const lingering = judged([CAPTIONS[0], { ...CAPTIONS[1], to: 9.5 }]);
  assert.equal(lingering.verdict, 'found');
  assert.equal(lingering.lines[0], LEFT_UP);
});

await test('a card brought up with the last phrase, or in the pause before it, counts; one up before that pause does not', () => {
  const judged = (from: number) => judgeDeadTail({ duration: 12, sound: sound(12), transcript: SPOKEN, textRecord: recordOf(12, [...CAPTIONS, { text: CTA, from, to: 12 }]) });
  const within = `ends on a 3.00s end card with sound to the last frame, within the 4.40s allowed for its 7 words: "${CTA}"`;
  // Up with the spoken call to action, a second before its last word ends.
  assert.equal(judged(8).verdict, 'pass');
  assert.equal(judged(8).lines[0], within);
  assert.equal(judged(6.5).lines[0], within);
  // The record is read every 0.1s, so a card first read at 5.9s may have come up as the pause began at 6s.
  assert.equal(judged(5.9).lines[0], within);
  assert.equal(judged(5.8).verdict, 'found');
  assert.equal(judged(5.8).lines[0], LEFT_UP);
});

await test('a card that comes up after the last word counts alone, the caption still up beside it adding no words to read', () => {
  const report = judgeDeadTail({
    duration: 12, sound: sound(12), transcript: SPOKEN, textRecord: recordOf(12, [CAPTIONS[0], { ...CAPTIONS[1], to: 12 }, { text: CTA, from: 9.2, to: 12 }]),
  });
  assert.equal(report.verdict, 'pass', report.lines.join('\n'));
  assert.equal(report.lines[0], `ends on a 2.80s end card with sound to the last frame, within the 4.40s allowed for its 7 words: "${CTA}"`);
});

await test('the last word of a word-by-word caption is not an end card, though it comes up just before that word ends', () => {
  // Captions set one span per word slot, as pages do: the last phrase's words land in the slots earlier words used.
  const slot = (k: number) => `#cap>span:nth-child(${k})`;
  const words: Showing[] = [
    { text: 'the', from: 2, to: 6, box: [100, 1500, 200, 80], el: slot(1) },
    { text: 'first', from: 4, to: 6, box: [320, 1500, 200, 80], el: slot(2) },
    { text: 'follow', from: 7.5, to: 9.6, box: [100, 1500, 200, 80], el: slot(1) },
  ];
  const more: Showing = { text: 'more', from: 8.9, to: 9.6, box: [320, 1500, 200, 80], el: slot(2) };
  const judged = (showing: Showing[]) => judgeDeadTail({ duration: 10.3, sound: sound(10.3), transcript: SPOKEN, textRecord: recordOf(10.3, showing) });
  const caption = judged([...words, more]);
  assert.equal(caption.verdict, 'found');
  assert.match(caption.lines[0], /runs 1\.30s past the last spoken word, with sound under it to 10\.30s and no end card: the only text on screen is a caption/);
  // The same word in an element of its own is new text for the ending, and its 0.6s leave under a beat bare.
  const card = judged([...words, { ...more, el: '#more' }]);
  assert.equal(card.verdict, 'pass', card.lines.join('\n'));
  assert.match(card.lines[0], /^ends on a 0\.60s end card .* its 1 word: "more"$/);
});

await test('a card held far past its reading time is reported, and one with more words than a card can hold says so', () => {
  const long = judgeDeadTail({ duration: 16, sound: sound(16), transcript: SPOKEN, textRecord: recordOf(16, [...CAPTIONS, { text: 'Follow for more', from: 9, to: 16 }]) });
  assert.equal(long.verdict, 'found');
  assert.equal(long.lines[0], 'ends on a 7.00s end card with sound to the last frame, held longer than the 4.00s allowed for its 3 words: "Follow for more"');
  assert.match(long.lines[1], /^the last spoken word/);
  // Eight words read in 3.6s, inside the cap: the card is held too long, not too wordy.
  const eight = 'Link in bio for the full free guide';
  const held = judgeDeadTail({ duration: 15, sound: sound(15), transcript: SPOKEN, textRecord: recordOf(15, [...CAPTIONS, { text: eight, from: 9, to: 15 }]) });
  assert.equal(held.verdict, 'found');
  assert.equal(held.lines[0], `ends on a 6.00s end card with sound to the last frame, held longer than the 4.50s allowed for its 8 words: "${eight}"`);
  assert.match(held.lines[1], /^the last spoken word/);
  assert.doesNotMatch(held.lines.join('\n'), /too many words/);
  const wordy = 'Check your rate in two minutes and save on cover for your family';
  const crowded = judgeDeadTail({ duration: 14, sound: sound(14), transcript: SPOKEN, textRecord: recordOf(14, [...CAPTIONS, { text: wordy, from: 9, to: 14 }]) });
  assert.equal(crowded.verdict, 'found');
  assert.match(crowded.lines[0], /^ends on a 5\.00s end card with sound to the last frame, held longer than the 4\.50s allowed for its 13 words/);
  assert.equal(crowded.lines[1], 'its 13 words take 5.60s to read, and an end card holds 4.50s at most: it has too many words for one');
});

await test('a beat before the card comes up, and sound that stops short of the last frame, are part of the ending', () => {
  const report = judgeDeadTail({ duration: 12, sound: sound(11.5), transcript: SPOKEN, textRecord: recordOf(12, [...CAPTIONS, { text: CTA, from: 9.5, to: 12 }]) });
  assert.equal(report.verdict, 'pass', report.lines.join('\n'));
  assert.equal(report.lines[0], `ends on a 2.50s end card with sound to 11.50s, within the 4.40s allowed for its 7 words: "${CTA}"`);
});

await test('a card set one element per letter counts the words it spells, not its letters', () => {
  const letters = [...'Follow us'].flatMap((c, i): Showing[] => (c === ' ' ? [] : [{ text: c, from: 9, to: 13, box: [100 + 40 * i, 900, 36, 80] }]));
  const report = judgeDeadTail({ duration: 13, sound: sound(13), transcript: SPOKEN, textRecord: recordOf(13, [...CAPTIONS, ...letters]) });
  assert.equal(report.verdict, 'pass', report.lines.join('\n'));
  assert.equal(report.lines[0], 'ends on a 4.00s end card with sound to the last frame, within the 4.00s allowed for its 2 words: "Follow us"');
});

await test('without a record a tail under sound is reported as before, and the report says the end card was not judged', () => {
  const report = judgeDeadTail({ duration: 12, sound: sound(12), transcript: SPOKEN, textRecord: { missing: 'no record beside the video' } });
  assert.equal(report.verdict, 'found');
  assert.match(report.lines[0], /^the picture runs 3\.00s past the last spoken word, with sound under it to 12\.00s: fine for a deliberate outro/);
  assert.deepEqual(report.skipped, ['whether the tail is an end card: no record beside the video']);
});

// --- measured on real files -----------------------------------------------------

const dir = scratchDir('dead-tail');
/** A tone until `until` seconds, then digital silence. */
const toneUntil = (until: number) => `aevalsrc=exprs='if(lt(t,${until}),0.3*sin(2*PI*220*t),0)':s=48000`;
/** The check as the review runs it, on the picture's length probed here. */
const measure = (video: string, transcript: TranscriptInput, textRecord: TextRecordInput = { missing: 'none' }) =>
  measureDeadTail({ video, duration: pictureDurationOf(video), transcript, askedLength: { missing: 'none' }, textRecord, brief: { missing: 'none' } });

await test('a clip with a silent tail is reported', () => {
  const clip = synthClip(dir, 'silent-tail.mp4', { video: TESTSRC, audio: toneUntil(3), seconds: 6 });
  const report = measure(clip, given(transcriptOf(1.5, 2.9)));
  assert.equal(report.verdict, 'found');
  assert.match(report.lines[0], /the last 3\.00s are silent: nothing is heard after 3\.00s, and the picture runs to 6\.00s/);
});

await test('a clip that ends on its last line passes', () => {
  const clip = synthClip(dir, 'ends-on-line.mp4', { video: TESTSRC, audio: toneUntil(5.8), seconds: 6 });
  const report = measure(clip, given(transcriptOf(2, 5.7)));
  assert.equal(report.verdict, 'pass');
  assert.match(report.lines[0], /^ends on time/);
});

await test('a clip that ends on a card over music passes, and the same card over a silent tail is reported', () => {
  const card = recordOf(6, [{ text: 'we made this', from: 0, to: 3, box: CAPTION }, { text: 'Follow for more', from: 3, to: 6 }]);
  const music = synthClip(dir, 'card-music.mp4', { video: TESTSRC, audio: toneUntil(60), seconds: 6 });
  const report = measure(music, given(transcriptOf(1.5, 3)), card);
  assert.equal(report.verdict, 'pass', report.lines.join('\n'));
  assert.equal(report.lines[0], 'ends on a 3.00s end card with sound to the last frame, within the 4.00s allowed for its 3 words: "Follow for more"');
  const quiet = synthClip(dir, 'card-quiet.mp4', { video: TESTSRC, audio: toneUntil(3), seconds: 6 });
  assert.match(measure(quiet, given(transcriptOf(1.5, 3)), card).lines[0], /^the last 3\.00s are silent/);
});

await test('a clip whose transcript ends late still has its silent tail reported', () => {
  const clip = synthClip(dir, 'late-transcript.mp4', { video: TESTSRC, audio: toneUntil(4), seconds: 10 });
  const report = measure(clip, given(transcriptOf(9.8)));
  assert.equal(report.verdict, 'found');
  assert.match(report.lines[0], /the last 6\.00s are silent/);
  assert.match(report.skipped[0], /not on this video's timeline/);
});

await test('a track that starts after the picture is measured on the picture\'s timeline', () => {
  // Sound from about 2s to the end of a 10s picture: decoded from its first sample, it would end at 8s.
  const clip = join(dir, 'late-audio.mp4');
  execFileSync(FFMPEG, [
    '-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', TESTSRC,
    '-itsoffset', '2', '-f', 'lavfi', '-i', toneUntil(60), '-t', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip,
  ]);
  const report = measure(clip, NONE);
  assert.equal(report.verdict, 'pass', report.lines.join('\n'));
  // Offset twice, the sound would end past the picture and still pass: the end itself pins it.
  const end = lastSoundIn(clip)?.end ?? NaN;
  assert.ok(end > 9.5 && end <= 10.1, `the sound ends at ${end}s`);
});

await test('a Matroska file is judged on its picture\'s length, not the container\'s, which counts the audio', () => {
  // A 10s picture with 13s of audio that goes quiet at 9.8s: the container says 13s, a 3.2s tail that is not there.
  const clip = join(dir, 'longer-audio.mkv');
  execFileSync(FFMPEG, [
    '-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-t', '10', '-i', TESTSRC,
    '-f', 'lavfi', '-t', '13', '-i', toneUntil(9.8), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip,
  ]);
  const report = measure(clip, NONE);
  assert.equal(report.verdict, 'pass', report.lines.join('\n'));
  assert.match(report.lines[0], /^ends on time: the picture ends 0\.\d\ds after the last sound/);
});

await test('a Matroska picture that starts late is as long as its frames, not the end its DURATION tag records', () => {
  // An 8s picture from 2s, over sound to 9.8s: 0.2s of tail, where reading the tag as a length would give 2.2s.
  const clip = join(dir, 'late-picture.mkv');
  execFileSync(FFMPEG, [
    '-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-itsoffset', '2', '-f', 'lavfi', '-t', '8', '-i', TESTSRC,
    '-f', 'lavfi', '-t', '10', '-i', toneUntil(9.8), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip,
  ]);
  const report = measure(clip, NONE);
  assert.equal(report.verdict, 'pass', report.lines.join('\n'));
  assert.match(report.lines[0], /^ends on time: the picture ends 0\.\d\ds after the last sound/);
});

await test('a clip shorter than one window is too short to measure', () => {
  const clip = synthClip(dir, 'tiny.mp4', { video: TESTSRC, audio: toneUntil(1), seconds: 0.08 });
  const report = measure(clip, NONE);
  assert.equal(report.verdict, 'skipped');
  assert.match(report.skipped[0], /too short to measure/);
});

await test('a clip with no audio track is judged on its words alone', () => {
  const clip = synthClip(dir, 'picture-only.mp4', { video: TESTSRC, seconds: 4 });
  const report = measure(clip, given(transcriptOf(1)));
  assert.equal(report.verdict, 'found');
  assert.deepEqual(report.skipped, ['the last sound: the video has no audio track']);
});
