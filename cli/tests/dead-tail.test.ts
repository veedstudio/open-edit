// Tests src/verify/dead-tail.ts. The gate and the judgement are pure, so most cases are envelopes and
// transcripts written out; synthesised clips then run the measurement end to end, among them one with a
// silent tail and one that ends on its last line.
//   Run:  node --import tsx --test cli/tests/dead-tail.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { FFMPEG } from '../src/config.ts';
import {
  judgeDeadTail, lastSoundIn, lastSoundOf, lastWordOf, measureDeadTail, TAIL_SECONDS, WINDOW_MS,
  type LastSound,
} from '../src/verify/dead-tail.ts';
import { pictureDurationOf } from '../src/probe.ts';
import type { Transcript } from '../src/transcript/transcript-types.ts';
import type { TranscriptInput } from '../src/verify/checks.ts';
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

// --- where the last sound ends ---------------------------------------------------

await test('the last sound ends where the level last reaches the gate', () => {
  assert.equal(lastSoundOf(envelope([-20, 3], [-100, 4]), WINDOW_MS).end, 3);
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

// --- measured on real files -----------------------------------------------------

const dir = scratchDir('dead-tail');
/** A tone until `until` seconds, then digital silence. */
const toneUntil = (until: number) => `aevalsrc=exprs='if(lt(t,${until}),0.3*sin(2*PI*220*t),0)':s=48000`;
/** The check as the review runs it, on the picture's length probed here. */
const measure = (video: string, transcript: TranscriptInput) =>
  measureDeadTail({ video, duration: pictureDurationOf(video), transcript, askedLength: { missing: 'none' } });

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
