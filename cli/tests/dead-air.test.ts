// Tests src/verify/dead-air.ts. The judgement is pure, so most cases are changes, envelopes, transcripts and records of
// on-screen text written out; clips ffmpeg synthesises then run the measurement end to end: a frozen picture, one a
// keyframe nudges by a level, a slow zoom on a flat card, a slow pan over texture, and silences at the start, between
// sounds and at the end.
//   Run:  node --import tsx --test cli/tests/dead-air.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { FFMPEG } from '../src/config.ts';
import { pictureDurationOf } from '../src/probe.ts';
import type { TextSample } from '../src/render/text-record.ts';
import type { Transcript } from '../src/transcript/transcript-types.ts';
import type { TextRecordInput, TranscriptInput } from '../src/verify/checks.ts';
import {
  changeOf, changesIn, FROZEN_LEVELS, GAP_SECONDS, judgeDeadAir, longestUnspoken, measureDeadAir, NUDGE_LEVELS, SCAN_RATE, silencesOf,
  STILL_SECONDS, stillLimit, stillsOf, wordsDuring, type Change,
} from '../src/verify/dead-air.ts';
import { endCardLimit, judgeDeadTail, lastSoundOf, WINDOW_MS } from '../src/verify/dead-tail.ts';
import { scratchDir, SINE, synthClip } from './helpers/synth.ts';

const dir = scratchDir('dead-air');
// testsrc's pattern holds still but for a scrolling band and a counter, so it measures nearly still; testsrc2 moves.
const MOVING = 'testsrc2=size=320x240:rate=25';

/**
 * The changes between frames scanned at SCAN_RATE from 0s: `[kind, seconds]` stretches of frames in order, each frame
 * changed from the one before as its stretch's kind says, so a still begins on the frame before its stretch.
 */
type Kind = 'frozen' | 'drift' | 'pan' | 'moving' | 'drawing' | 'cut' | 'keyframe' | 'word';
const LOOKS: Record<Kind, Omit<Change, 'sec'>> = {
  frozen: { mean: 0, peak: 0.02, area: 0.001 },
  word: { mean: 0.2, peak: 30, area: 0.01 },
  drift: { mean: 0.3, peak: 4, area: 0.07 },
  keyframe: { mean: 0.4, peak: 1, area: 0.5 },
  pan: { mean: 0.6, peak: 2, area: 0.45 },
  drawing: { mean: 0.8, peak: 30, area: 0.05 },
  moving: { mean: 6, peak: 40, area: 0.8 },
  cut: { mean: 40, peak: 120, area: 0.95 },
};
function changes(...stretches: [Kind, number][]): Change[] {
  const frames = stretches.flatMap(([kind, seconds]) => Array<Kind>(Math.round(seconds * SCAN_RATE)).fill(kind));
  return frames.slice(1).map((kind, i) => ({ sec: (i + 1) / SCAN_RATE, ...LOOKS[kind] }));
}
const durationOf = (c: Change[]) => (c.length + 1) / SCAN_RATE;

/** An envelope at WINDOW_MS per entry: `[dBFS, seconds]` stretches in order. */
const envelope = (...stretches: [number, number][]): number[] =>
  stretches.flatMap(([db, seconds]) => Array(Math.round((seconds * 1000) / WINDOW_MS)).fill(db));
const sound = (...stretches: [number, number][]) => ({ envelope: envelope(...stretches), start: 0 });

/** A transcript with a quarter-second word every `every` seconds from `from` to `to`. */
function speech(from: number, to: number, every = 0.3): TranscriptInput {
  const words = [];
  for (let t = from; t + 0.25 <= to + 1e-9; t += every) words.push({ text: 'word', timestamp: [t, t + 0.25] as [number, number] });
  const transcript: Transcript = { text: '', chunks: [{ text: '', timestamp: [from, to], words }] };
  return { path: 'runs/piece/transcript.json', transcript };
}
const NO_SPEECH: TranscriptInput = { missing: 'no transcript at runs/piece/transcript.json' };
const NO_RECORD: TextRecordInput = { missing: 'no record at runs/piece/out.mp4.text.json' };

/** A 1080x1920 record at 30 fps, read every third frame, showing `text` from `from` to `to`. */
function recordOf(seconds: number, ...showing: { text: string; from: number; to: number }[]): TextRecordInput {
  const frames = Math.round(seconds * 30);
  const samples: TextSample[] = [];
  for (let frame = 0; frame < frames; frame += 3) {
    const t = frame / 30;
    samples.push({
      frame, time: t, texts: showing.filter((x) => t >= x.from - 1e-9 && t < x.to - 1e-9).map((x, i) => ({
        text: x.text, box: [100, 300 + 200 * i, 880, 120] as [number, number, number, number], fontSize: 64,
        color: [40, 30, 20, 1] as [number, number, number, number], opacity: 1, selector: `#t${i}`,
      })),
    });
  }
  return {
    path: 'runs/piece/out.mp4.text.json',
    record: { version: 1, page: 'index.html', width: 1080, height: 1920, fps: '30', frames, transparent: false, framesPerSample: 3, samples },
  };
}

const judge = (picture: Change[], o: { sound?: ReturnType<typeof sound> | null; transcript?: TranscriptInput; textRecord?: TextRecordInput } = {}) =>
  judgeDeadAir({
    duration: durationOf(picture), picture, sound: o.sound === undefined ? sound([-20, durationOf(picture)]) : o.sound,
    transcript: o.transcript ?? NO_SPEECH, textRecord: o.textRecord ?? NO_RECORD,
  });

// --- how two frames differ ---------------------------------------------------------

await test('a change is measured over the picture, in the square that changed most, and as the share of pixels that changed', () => {
  const a = new Uint8Array(16 * 16).fill(100);
  const b = Uint8Array.from(a);
  // One 8x8 square of four brightens by 16 levels, and one pixel elsewhere by a single level.
  for (let y = 0; y < 8; y++) for (let x = 8; x < 16; x++) b[y * 16 + x] = 116;
  b[15 * 16] = 101;
  const change = changeOf(a, b, 16, 16);
  assert.equal(change.peak, 16);
  assert.equal(change.mean, (64 * 16 + 1) / 256);
  assert.equal(change.area, 65 / 256);
});

// --- which stretches are still ------------------------------------------------------

await test('a frozen stretch is still from the frame it repeats to the frame after its last, and to the picture\'s end at the end', () => {
  const stills = stillsOf(changes(['moving', 1], ['frozen', 2], ['moving', 1], ['frozen', 3]), 7);
  assert.deepEqual(stills.map((x) => [Number(x.start.toFixed(2)), Number(x.end.toFixed(2))]), [[0.9, 3], [3.9, 7]]);
  assert.deepEqual(stills.map((x) => x.frozen && Number((x.frozen.end - x.frozen.start).toFixed(2))), [2.1, 3.1]);
});

await test('a drift over a held card is still; a pan over texture, a line drawing itself or footage that moves is not', () => {
  assert.equal(stillsOf(changes(['moving', 1], ['drift', 5], ['moving', 1]), 7).length, 1);
  assert.deepEqual(stillsOf(changes(['moving', 1], ['pan', 5], ['moving', 1]), 7), []);
  assert.deepEqual(stillsOf(changes(['moving', 1], ['drawing', 5], ['moving', 1]), 7), []);
  assert.deepEqual(stillsOf(changes(['moving', 7]), 7), []);
});

await test('an encoder\'s keyframe inside a still does not end it, and a cut between two stills does', () => {
  const held = stillsOf(changes(['moving', 1], ['drift', 2], ['keyframe', 0.1], ['drift', 2.9], ['moving', 1]), 7);
  assert.equal(held.length, 1);
  assert.equal(Number((held[0].end - held[0].start).toFixed(2)), 5.1);
  assert.equal(stillsOf(changes(['moving', 1], ['drift', 2], ['cut', 0.1], ['drift', 2.9], ['moving', 1]), 7).length, 2);
});

// --- how long a still may hold ------------------------------------------------------

await test('a still with nothing to read holds three seconds; one with words holds as an end card of as many words', () => {
  assert.equal(STILL_SECONDS, 3);
  assert.equal(stillLimit(0), 3);
  assert.equal(stillLimit(7), endCardLimit(7));
  assert.equal(stillLimit(12), 4.5);
});

await test('the words a still asks to read are the most on screen at once while it holds', () => {
  const shown = recordOf(10, { text: 'Bean There', from: 5, to: 10 }, { text: 'Grand opening this Saturday', from: 8, to: 10 });
  if ('missing' in shown) throw new Error(shown.missing);
  const { record } = shown;
  assert.equal(wordsDuring(record, { start: 5, end: 7.9 }), 2);
  assert.equal(wordsDuring(record, { start: 5, end: 10 }), 6);
  assert.equal(wordsDuring(record, { start: 0, end: 5 }), 0);
});

await test('the longest stretch with no word spoken is found between words and at either end of a span', () => {
  const { transcript } = speech(1, 3) as { transcript: Transcript };
  assert.deepEqual(longestUnspoken(transcript, { start: 0, end: 3.5 }), { start: 0, end: 1 });
  const last = longestUnspoken(transcript, { start: 2, end: 6 });
  assert.equal(last.end, 6);
  assert.ok(Math.abs(last.start - 3) < 0.31);
});

// --- the judgement of the picture ---------------------------------------------------

await test('a frozen picture held past three seconds is reported, with when it starts and ends', () => {
  const report = judge(changes(['moving', 2], ['frozen', 4]));
  assert.equal(report.verdict, 'found');
  assert.deepEqual(report.lines, [
    'frozen from 1.90s to 6.00s: 4.10s with nothing moving, longer than the 3.00s a still may hold with no record of the words on it',
  ]);
  // A frozen picture is judged whatever is said over it, so whether anyone speaks is not asked.
  assert.deepEqual(report.skipped, ['the words on screen through a still, which let it hold longer: no record at runs/piece/out.mp4.text.json']);
  const recorded = judge(changes(['moving', 2], ['frozen', 4]), { textRecord: recordOf(6) });
  assert.match(recorded.lines[0], /with no page text on it to read$/);
  assert.deepEqual(recorded.skipped, []);
});

await test('a frozen picture is reported even with someone speaking all through it', () => {
  const report = judge(changes(['moving', 2], ['frozen', 4]), { transcript: speech(0, 6.1) });
  assert.match(report.lines[0], /^frozen from 1\.90s to 6\.00s/);
});

await test('an encoder\'s keyframe inside a frozen picture leaves it frozen under a voice; words appearing on it one by one do not', () => {
  const nudged = judge(changes(['moving', 2], ['frozen', 2.5], ['keyframe', 0.1], ['frozen', 2.4]), { transcript: speech(0, 7.1) });
  assert.deepEqual(nudged.lines.map((line) => line.split(':')[0]), ['frozen from 1.90s to 7.00s']);
  const typed = changes(['moving', 2], ...Array.from({ length: 12 }, () => [['frozen', 0.3], ['word', 0.1]] as [Kind, number][]).flat());
  assert.equal(judge(typed, { transcript: speech(0, 6.9) }).verdict, 'pass');
});

await test('a held card under music is reported past what its words allow; one under a voice that keeps talking is a talking head and passes', () => {
  const picture = changes(['moving', 9.6], ['drift', 5.4]);
  const record = recordOf(15, { text: 'Bean There Coffee Shop', from: 5, to: 15 }, { text: 'Grand opening this Saturday', from: 9.3, to: 15 });
  const music = judge(picture, { textRecord: record });
  assert.deepEqual(music.lines, [
    'nearly still from 9.50s to 15.00s: 5.50s with only slight motion, such as a slow zoom or a drift, longer than the 4.50s a still may hold with 8 words on screen to read',
  ]);
  assert.deepEqual(music.skipped, [
    'whether a voice carries the nearly still picture, as a talking head can be that still: no transcript at runs/piece/transcript.json',
  ]);
  assert.equal(judge(picture, { textRecord: record, transcript: speech(0, 15) }).verdict, 'pass');
});

await test('a voice that stops partway leaves the rest of a still uncarried, and the report says from when', () => {
  // A card that comes up during the spoken call to action and holds well past it.
  const report = judge(changes(['moving', 24.3], ['drift', 5.7]), {
    transcript: speech(20, 26.1), textRecord: recordOf(30, { text: 'Pick yours creativecommons.org /choose Every CC license needs credit', from: 23, to: 30 }),
  });
  assert.equal(report.lines.length, 1);
  assert.match(report.lines[0], /^nearly still from 24\.20s to 30\.00s: 5\.80s .* longer than the 4\.50s a still may hold with 9 words on screen to read, and no word is spoken from 25\.95s to 30\.00s$/);
});

await test('a talking head that pauses longer than a reader would is reported; one pausing shorter is not', () => {
  const picture = changes(['drift', 12]);
  const paused: TranscriptInput = { path: 'runs/piece/transcript.json', transcript: {
    text: '', chunks: [{ text: '', timestamp: [0, 12], words: [...(speech(0, 5) as { transcript: Transcript }).transcript.chunks[0].words,
      ...(speech(5.2 + GAP_SECONDS + 0.3, 12) as { transcript: Transcript }).transcript.chunks[0].words] }],
  } };
  assert.match(judge(picture, { transcript: paused }).lines[0], /^nearly still from 0\.00s to 12\.00s: .*, and no word is spoken from 4\.75s to 7\.50s$/);
  assert.equal(judge(picture, { transcript: speech(0, 12, 1.9) }).verdict, 'pass');
});

await test('a still within what it may hold passes, and a still of exactly that long is not longer', () => {
  assert.equal(judge(changes(['moving', 2], ['frozen', 1.9], ['moving', 2])).verdict, 'pass');
  assert.equal(judge(changes(['moving', 2], ['frozen', 2.9], ['moving', 2])).verdict, 'pass');
  assert.equal(judge(changes(['moving', 2], ['frozen', 3], ['moving', 2])).verdict, 'found');
});

// --- the judgement of the sound -----------------------------------------------------

await test('a silent opening longer than a second is reported, and one of a second is not', () => {
  const picture = changes(['moving', 8]);
  assert.deepEqual(judge(picture, { sound: sound([-100, 4], [-20, 4.1]) }).lines, ['the first 4.00s are silent: nothing is heard until 4.00s']);
  assert.equal(judge(picture, { sound: sound([-100, 1], [-20, 7.1]) }).verdict, 'pass');
});

await test('a silence between two sounds longer than two seconds is reported; room tone counts as silence, two seconds does not', () => {
  const picture = changes(['moving', 10]);
  assert.deepEqual(judge(picture, { sound: sound([-20, 3], [-60, 2.5], [-20, 4.6]) }).lines, [
    'silent from 3.00s to 5.50s: 2.50s with nothing heard between two sounds',
  ]);
  assert.equal(judge(picture, { sound: sound([-20, 3], [-100, 2], [-20, 5.1]) }).verdict, 'pass');
});

await test('a silent ending is left to the dead-tail check, which reports it, so it is never reported twice', () => {
  const picture = changes(['moving', 10]);
  const tail = sound([-20, 5], [-100, 5.1]);
  assert.equal(judge(picture, { sound: tail }).verdict, 'pass');
  const deadTail = judgeDeadTail({ duration: durationOf(picture), sound: lastSoundOf(tail.envelope, WINDOW_MS), transcript: NO_SPEECH });
  assert.match(deadTail.lines[0], /^the last 5\.00s are silent/);
  assert.deepEqual(silencesOf(tail, durationOf(picture)), { firstSound: 0, gaps: [] });
});

await test('a track with no sound in it, or no track, skips the silences and says why', () => {
  const picture = changes(['moving', 5]);
  const silent = judge(picture, { sound: sound([-100, 5.1]) });
  assert.equal(silent.verdict, 'pass');
  assert.match(silent.skipped[0], /^silence at the start and between sounds: nothing in the audio track is loud enough/);
  assert.deepEqual(judge(picture, { sound: null }).skipped, ['silence at the start and between sounds: the video has no audio track']);
});

await test('findings are listed in the order they happen, and with nothing measured the check is skipped', () => {
  const report = judge(changes(['moving', 6], ['frozen', 4]), { sound: sound([-100, 2], [-20, 2], [-100, 3], [-20, 3.1]) });
  assert.deepEqual(report.lines.map((line) => line.split(':')[0]), ['the first 2.00s are silent', 'silent from 4.00s to 7.00s', 'frozen from 5.90s to 10.00s']);
  const nothing = judgeDeadAir({ duration: 5, picture: { missing: 'the picture has an alpha channel' }, sound: null, transcript: NO_SPEECH, textRecord: NO_RECORD });
  assert.equal(nothing.verdict, 'skipped');
});

// --- synthesised clips ----------------------------------------------------------------

const measure = (video: string, o: { transcript?: TranscriptInput } = {}) => measureDeadAir({
  video, duration: pictureDurationOf(video), transcript: o.transcript ?? NO_SPEECH, askedLength: { missing: 'none' }, textRecord: NO_RECORD,
  brief: { missing: 'none' },
});

function encode(name: string, inputs: string[], vf: string | null, seconds: number, extra: string[] = []): string {
  const path = join(dir, name);
  execFileSync(FFMPEG, ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', ...inputs.flatMap((i) => ['-f', 'lavfi', '-i', i]), '-t', String(seconds),
    ...(vf ? ['-vf', vf] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', ...extra, path]);
  return path;
}

await test('a picture that freezes partway, its sound running on, is reported frozen from where it stops', async () => {
  const video = encode('freeze.mp4', [MOVING, SINE], 'trim=0:2,tpad=stop_mode=clone:stop_duration=4', 6);
  const report = await measure(video);
  assert.equal(report.verdict, 'found');
  assert.equal(report.lines.length, 1);
  assert.match(report.lines[0], /^frozen from (1\.9|2\.0)0s to 6\.00s: .* longer than the 3\.00s a still may hold with no record of the words on it$/);
});

await test('a frozen picture a level brighter from a keyframe partway is one frozen stretch, reported under a voice that never pauses', async () => {
  // Neither part alone outlasts the 3 s a still may hold.
  const video = encode('nudged.mp4', [MOVING, SINE], "trim=0:2,tpad=stop_mode=clone:stop_duration=5,lutyuv=y='val+1':enable='gte(t,4.5)'", 7,
    ['-force_key_frames', '4.5']);
  const nudge = (await changesIn(video)).filter((c) => c.sec > 3 && c.peak >= FROZEN_LEVELS);
  assert.ok(nudge.length > 0 && nudge.every((c) => Math.abs(c.sec - 4.5) < 0.25 && c.peak < NUDGE_LEVELS), JSON.stringify(nudge));
  const report = await measure(video, { transcript: speech(0, 7) });
  assert.equal(report.verdict, 'found', report.lines.join('\n'));
  assert.equal(report.lines.length, 1, report.lines.join('\n'));
  assert.match(report.lines[0], /^frozen from (1\.9|2\.0)0s to 7\.00s: .* longer than the 3\.00s a still may hold with no record of the words on it$/);
});

await test('a slow zoom on a flat card with shapes on it measures nearly still, and is reported when nobody speaks', async () => {
  const card = 'color=c=0xF0E0C8:s=720x1280:r=30:d=6,drawbox=x=120:y=240:w=60:h=40:color=0x5a3a20:t=fill,'
    + 'drawbox=x=440:y=800:w=50:h=50:color=0x5a3a20:t=fill,drawbox=x=180:y=600:w=360:h=80:color=0x3a2a10:t=fill';
  // Zoomed at four times the size and scaled down, so zoompan's whole-pixel steps become the smooth zoom a page draws.
  const video = encode('zoom.mp4', [card, SINE], "zoompan=z='1+0.0004*on':d=1:s=720x1280:fps=30,scale=360:640", 6);
  const report = await measure(video);
  assert.match(report.lines[0], /^nearly still from 0\.00s to 6\.00s: 6\.00s with only slight motion/);
  assert.equal((await measure(video, { transcript: speech(0, 6) })).verdict, 'pass');
});

await test('a slow pan over a textured scene moves almost every pixel, so it is not still however slow', async () => {
  const scene = "nullsrc=s=2560x1440:r=30:d=6,geq=lum='abs(mod(sin(X*12.9898+Y*78.233)*43758.5453\\,1))*255':cb=128:cr=128,gblur=sigma=8";
  const video = encode('pan.mp4', [scene, SINE], "crop=1920:1440:'t*16':0,scale=480:360", 6);
  const picture = await changesIn(video);
  assert.ok(picture.every((c) => c.mean < 1.5), 'the pan is slower than the still bar on its own');
  assert.equal((await measure(video)).verdict, 'pass');
});

await test('silences at the start and between sounds are found in a real track, on the picture\'s timeline', async () => {
  const tone = "aevalsrc=exprs='if(between(t,1.5,4)+between(t,6.5,9),0.3*sin(2*PI*220*t),0)':s=48000";
  const video = synthClip(dir, 'gaps.mp4', { video: MOVING, audio: tone, seconds: 10 });
  const report = await measure(video);
  assert.deepEqual(report.lines, [
    'the first 1.50s are silent: nothing is heard until 1.50s',
    'silent from 4.00s to 6.50s: 2.50s with nothing heard between two sounds',
  ]);
});
