// Tests src/verify/blank-frames.ts. The parse and the judgement are pure, so most edge cases are levels written out;
// clips ffmpeg synthesises then run the measurement end to end.
//   Run:  node --import tsx --test cli/tests/blank-frames.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FFMPEG } from '../src/config.ts';
import {
  colourName, findBlanks, findFlashes, findOpening, judgeBlankFrames, levelsIn, measureBlankFrames, parseLevels,
  type FrameLevels, type Planes,
} from '../src/verify/blank-frames.ts';
import { pictureDurationOf } from '../src/probe.ts';
import { SINE, TESTSRC, scratchDir, synthClip } from './helpers/synth.ts';

const dir = scratchDir('blank-frames');

/** `testsrc` with frames `from`..`to` painted over in one colour, and a dark bar like a caption on frames `caption`.. `to`. */
function painted(name: string, o: { from: number; to: number; colour: string; caption?: number; seconds?: number }): string {
  const on = (first: number) => `enable='between(n,${first},${o.to})'`;
  const caption = o.caption === undefined ? '' : `,drawbox=x=100:y=200:w=120:h=12:color=black:t=fill:${on(o.caption)}`;
  return synthClip(dir, name, { video: TESTSRC, seconds: o.seconds ?? 3, vf: `drawbox=x=0:y=0:w=iw:h=ih:color=${o.colour}:t=fill:${on(o.from)}${caption}` });
}

/** A lavfi graph of shots joined end to end, each `[source, seconds]`, such as `['color=red', 0.4]`. */
const joined = (...shots: [string, number][]) =>
  shots.map(([source, seconds], i) => `${source}${source.includes('=') ? ':' : '='}s=320x240:r=25:d=${seconds}[s${i}];`).join('') +
  `${shots.map((_, i) => `[s${i}]`).join('')}concat=n=${shots.length}:v=1:a=0`;

const measure = (video: string) => measureBlankFrames({
  video, duration: pictureDurationOf(video), transcript: { missing: 'none' }, askedLength: { missing: 'none' }, textRecord: { missing: 'none' }, brief: { missing: 'none' },
});
const flashLines = (lines: string[]) => lines.filter((line) => line.startsWith('a flash'));

/** Levels for a frame at `sec`, `change` levels from the one before: flat at luma `level`, or a full picture when `level` is null. */
function frame(
  sec: number, change: number, level: number | null = 235, o: { mean?: number; band?: number; range?: number; lumaMax?: number } = {},
): FrameLevels {
  const planes = (y: number): Planes => [y, 128, 128];
  const flat = level !== null;
  return {
    sec, change, band: o.band ?? (flat ? 0 : 200), range: o.range ?? (flat ? 0 : 220),
    mean: planes(o.mean ?? level ?? 126), bandMiddle: planes(level ?? 126), lumaMax: o.lumaMax ?? (flat ? level : 235),
  };
}

// --- the parse and the judgement ---------------------------------------------------

await test('signalstats\' print is read into each frame\'s widest band, range and change, timed from the first frame', () => {
  const keys = (y: [number, number, number, number, number], dif: number) => [
    `lavfi.signalstats.YMIN=${y[0]}`, `lavfi.signalstats.YLOW=${y[1]}`, `lavfi.signalstats.YAVG=${y[2]}`,
    `lavfi.signalstats.YHIGH=${y[3]}`, `lavfi.signalstats.YMAX=${y[4]}`,
    'lavfi.signalstats.UMIN=120', 'lavfi.signalstats.ULOW=126', 'lavfi.signalstats.UAVG=128.5', 'lavfi.signalstats.UHIGH=130',
    'lavfi.signalstats.UMAX=140', 'lavfi.signalstats.VMIN=128', 'lavfi.signalstats.VLOW=128', 'lavfi.signalstats.VAVG=128',
    'lavfi.signalstats.VHIGH=128', 'lavfi.signalstats.VMAX=128',
    `lavfi.signalstats.YDIF=${dif}`, 'lavfi.signalstats.UDIF=3', 'lavfi.signalstats.VDIF=0.5',
  ];
  const text = ['frame:0    pts:512     pts_time:0.5', ...keys([16, 16, 125.1, 235, 235], 0),
    'frame:1    pts:1024    pts_time:0.54', ...keys([15, 235, 230.9, 235, 235], 110.5), ''].join('\n');
  const [first, second] = parseLevels(text);
  assert.deepEqual(first, {
    sec: 0, band: 219, range: 219, change: 3, mean: [125.1, 128.5, 128], bandMiddle: [125.5, 128, 128], lumaMax: 235,
  });
  assert.equal(second.sec.toFixed(2), '0.04');
  assert.deepEqual(
    { ...second, sec: 0 },
    { sec: 0, band: 4, range: 220, change: 110.5, mean: [230.9, 128.5, 128], bandMiddle: [235, 128, 128], lumaMax: 235 },
  );
});

await test('a frame with no time, or a key signalstats did not print, stops the check rather than reading as a number', () => {
  assert.throws(() => parseLevels('frame:0    pts:NOPTS   pts_time:NOPTS\n'), /ffmpeg gave frame 0 no time/);
  assert.throws(() => parseLevels('frame:0    pts:0       pts_time:0\nlavfi.signalstats.YMIN=16\n'), /signalstats printed no YHIGH/);
});

await test('a flat colour is named white or black within a tenth of the range of either, and not otherwise', () => {
  assert.equal(colourName([235, 128, 128]), 'white');
  assert.equal(colourName([16, 128, 128]), 'black');
  assert.equal(colourName([31, 128, 128]), 'black', 'a page\'s near-black, #111');
  assert.equal(colourName([200, 128, 128]), null, 'light grey');
  assert.equal(colourName([29, 184, 118]), null, 'navy is dark, but not black');
});

await test('a blank stretch open at the last frame runs to the picture\'s end, and never stops before its last frame', () => {
  const frames = [frame(0, 0, null), frame(0.5, 100), frame(1, 0), frame(1.5, 0)];
  assert.deepEqual(findBlanks(frames, 2), [{ start: 0.5, end: 2, colour: 'white', mixed: false }]);
  assert.deepEqual(findBlanks(frames, 0), [{ start: 0.5, end: 2, colour: 'white', mixed: false }], 'a probed length short of the frames');
});

await test('a blank stretch of exactly a second is not reported, and one of two colours is named by neither', () => {
  assert.deepEqual(findBlanks([frame(0, 0, null), frame(0.5, 100), frame(1, 0), frame(1.5, 100, null)], 2), []);
  const twoColours = [frame(0, 0, null), frame(0.5, 100, 16), frame(1, 100, 235), frame(1.5, 0, 235), frame(2, 100, null)];
  assert.deepEqual(findBlanks(twoColours, 2.5), [{ start: 0.5, end: 2, colour: null, mixed: true }]);
});

await test('a flat run at the first or last frame has only one neighbour, and is not reported as a flash', () => {
  const frames = [frame(0, 0), frame(0.04, 100, null), frame(0.08, 1, null), frame(0.12, 100)];
  assert.deepEqual(findFlashes(frames), []);
});

await test('a flat frame mid-dissolve between two flat pictures is not a flash; a near-black page between two dark slides is', () => {
  // The dissolve: every pixel moves alike, so each side's change is the means' shift.
  assert.deepEqual(findFlashes([frame(0, 0, 33), frame(0.04, 0, 33), frame(0.08, 99, 132), frame(0.12, 70, 202)]), []);
  // The page lies between the slides' means too, but the slides' text comes and goes: far more change than shift.
  const slides = [frame(0, 0, null, { mean: 38 }), frame(0.04, 1, null, { mean: 38 }), frame(0.08, 34, 31), frame(0.12, 24.5, null, { mean: 25 })];
  assert.equal(findFlashes(slides).length, 1);
  // White past both sides is no mix of them, however its change splits.
  assert.equal(findFlashes([frame(0, 0, 33), frame(0.04, 0, 33), frame(0.08, 202, 235), frame(0.12, 33, 202)]).length, 1);
});

await test('a still that a variable-rate file holds as one long frame is not a flash, nor is a slide of a slideshow', () => {
  const caption = { range: 200 };
  const still = [frame(0, 0, null), frame(0.04, 1, null), frame(0.08, 1, null), frame(0.12, 100, 235, caption), frame(2.12, 100, null)];
  assert.deepEqual(findFlashes(still), []);
  // Every frame held two seconds, so the usual gap between frames is a slide's length.
  const slides = [frame(0, 0, null), frame(2, 100, null), frame(4, 100, 235, caption), frame(6, 100, null), frame(8, 1, null)];
  assert.deepEqual(findFlashes(slides), []);
});

/** Seconds of frame `n` at 25 fps. */
const at = (n: number) => n / 25;

await test('five findings are all listed; past five the rest are counted, with when the last one is', () => {
  const flashes = (n: number) => {
    const frames: FrameLevels[] = [];
    for (let i = 0; i < n; i++) frames.push(frame(at(2 * i), 100, null), frame(at(2 * i + 1), 100));
    return [...frames, frame(at(2 * n), 100, null)];
  };
  assert.equal(judgeBlankFrames(flashes(5), at(11)).lines.length, 5);
  const report = judgeBlankFrames(flashes(8), at(17));
  assert.equal(report.verdict, 'found');
  assert.equal(report.lines.length, 6);
  assert.equal(report.lines[0], 'a flash at 0.04s: 1 frame of flat white with nothing on it, sharply unlike the frames either side');
  assert.equal(report.lines[5], 'and 3 more, the last at 0.60s');
});

await test('findings are listed in the order they happen, blanks and flashes together', () => {
  const black = Array.from({ length: 30 }, (_, i) => frame(at(i + 1), i === 0 ? 100 : 0, 16));
  const frames = [frame(0, 0, null), ...black, frame(at(31), 100, null), frame(at(32), 100), frame(at(33), 100, null), frame(at(34), 1, null)];
  assert.deepEqual(judgeBlankFrames(frames, at(35)).lines.map((line) => line.split(':')[0]), ['blank from 0.04s to 1.24s', 'a flash at 1.28s']);
});

await test('a decode that stops short of the picture\'s end is named, so it never reads as a full pass', () => {
  const frames = [frame(0, 0, null), frame(0.04, 1, null), frame(0.08, 1, null)];
  const report = judgeBlankFrames(frames, 6);
  assert.equal(report.verdict, 'pass');
  assert.deepEqual(report.skipped, ['the picture after 0.12s: ffmpeg decoded no frame past it, though the video runs to 6.00s']);
  assert.deepEqual(judgeBlankFrames(frames, 0.12).skipped, []);
});

// --- synthesised clips -------------------------------------------------------------

await test('one inserted white frame is reported as a flash, with its time on the picture\'s timeline', () => {
  const report = measure(painted('white.mp4', { from: 25, to: 25, colour: 'white' }));
  assert.equal(report.verdict, 'found');
  assert.deepEqual(report.lines, ['a flash at 1.00s: 1 frame of flat white with nothing on it, sharply unlike the frames either side']);
  assert.deepEqual(report.skipped, []);
});

await test('a picture that starts after its sound has its flash timed on the picture\'s own timeline', () => {
  const video = join(dir, 'late-picture.mp4');
  execFileSync(FFMPEG, [
    '-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-itsoffset', '1', '-f', 'lavfi', '-i', TESTSRC, '-f', 'lavfi', '-i', SINE,
    '-t', '4', '-vf', 'drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable=\'eq(n,25)\'', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    // ffmpeg 6.1's default frame-rate mode for .mp4 fills the late first second with copies of the first frame.
    '-fps_mode', 'vfr', '-c:a', 'aac', video,
  ]);
  assert.match(measure(video).lines[0], /^a flash at 1\.00s:/);
});

await test('a white flash with a caption on any of its frames is still a flash, and says something is on it', () => {
  assert.deepEqual(measure(painted('caption.mp4', { from: 25, to: 25, colour: 'white', caption: 25 })).lines, [
    'a flash at 1.00s: 1 frame of flat white with something small on it, such as a caption, sharply unlike the frames either side',
  ]);
  assert.deepEqual(measure(painted('caption-second.mp4', { from: 25, to: 26, colour: 'white', caption: 26 })).lines, [
    'a flash at 1.00s: 2 frames of flat white with something small on it, such as a caption, sharply unlike the frames either side',
  ]);
});

await test('a frame washed white with the picture still showing through is not flat, so not a flash', () => {
  assert.equal(measure(painted('washed.mp4', { from: 25, to: 25, colour: 'white@0.8' })).verdict, 'pass');
});

await test('a flash of a colour that is neither white nor black is still a flash', () => {
  assert.deepEqual(measure(painted('red.mp4', { from: 25, to: 25, colour: 'red' })).lines, [
    'a flash at 1.00s: 1 frame of one flat colour with nothing on it, sharply unlike the frames either side',
  ]);
});

await test('two black frames between pictures are a flash; three are a deliberate dip, and nothing is reported', () => {
  assert.deepEqual(measure(painted('two-black.mp4', { from: 25, to: 26, colour: 'black' })).lines, [
    'a flash at 1.00s: 2 frames of flat black with nothing on it, sharply unlike the frames either side',
  ]);
  assert.equal(measure(painted('three-black.mp4', { from: 25, to: 27, colour: 'black' })).verdict, 'pass');
});

await test('a one second fade to black, held, then a cut to another shot is not a flash', () => {
  const video = synthClip(dir, 'fade.mp4', { video: `testsrc=s=320x240:r=25:d=2,fade=t=out:st=0.9:d=1[a];testsrc2=s=320x240:r=25:d=1[b];[a][b]concat=n=2:v=1:a=0`, seconds: 3 });
  const report = measure(video);
  assert.equal(report.verdict, 'pass', report.lines.join('\n'));
});

await test('a one-frame dissolve between two flat colours is not a flash', () => {
  const video = synthClip(dir, 'dissolve.mp4', {
    video: 'color=red:s=320x240:r=25:d=1[a];color=blue:s=320x240:r=25:d=1[b];[a][b]xfade=transition=fade:duration=0.08:offset=0.92',
    seconds: 2,
  });
  assert.deepEqual(flashLines(measure(video).lines), []);
});

await test('a hard cut between two colours, set between two pictures, is not a flash', () => {
  const video = synthClip(dir, 'colours.mp4', { video: joined(['testsrc', 1], ['color=red', 0.4], ['color=blue', 0.4], ['testsrc2', 1]), seconds: 2.8 });
  const report = measure(video);
  assert.equal(report.verdict, 'pass', report.lines.join('\n'));
});

await test('a hard cut between two shots is not a flash', () => {
  const video = synthClip(dir, 'shots.mp4', { video: joined(['testsrc', 1.5], ['testsrc2', 1.5]), seconds: 3 });
  assert.equal(measure(video).verdict, 'pass');
});

await test('a dim title held on a flat background is a design, not a blank stretch', () => {
  const title = 'color=0x111111:s=320x240:r=25:d=2,drawbox=x=60:y=110:w=200:h=20:color=0x333333:t=fill';
  const video = synthClip(dir, 'title.mp4', { video: `testsrc=s=320x240:r=25:d=1[a];${title}[b];testsrc2=s=320x240:r=25:d=1[c];[a][b][c]concat=n=3:v=1:a=0`, seconds: 4 });
  const report = measure(video);
  assert.equal(report.verdict, 'pass', report.lines.join('\n'));
});

await test('a black gap mid-video is reported as blank, with its range, once it runs past a second', () => {
  assert.deepEqual(measure(painted('gap.mp4', { from: 25, to: 74, colour: 'black', seconds: 4 })).lines, [
    'blank from 1.00s to 3.00s: 2.00s of flat black with nothing on it',
  ]);
  assert.equal(measure(painted('gap-25.mp4', { from: 25, to: 49, colour: 'black' })).verdict, 'pass', '25 frames are exactly a second');
  assert.deepEqual(measure(painted('gap-26.mp4', { from: 25, to: 50, colour: 'black' })).lines, [
    'blank from 1.00s to 2.04s: 1.04s of flat black with nothing on it',
  ]);
});

await test('a file whose frames stop early is named as such, not passed', () => {
  const video = join(dir, 'truncated.mp4');
  execFileSync(FFMPEG, ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', TESTSRC, '-t', '6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video]);
  truncateSync(video, Math.floor(statSync(video).size / 2));
  const report = measure(video);
  assert.equal(report.verdict, 'pass');
  assert.match(report.skipped[0], /^the picture after \d\.\d\ds: ffmpeg decoded no frame past it, though the video runs to 6\.00s$/);
});

await test('a picture with an alpha channel is skipped, since what shows through it depends on what it is laid over', () => {
  const video = join(dir, 'alpha.mov');
  execFileSync(FFMPEG, ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', TESTSRC, '-t', '1',
    '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', video]);
  assert.deepEqual(measure(video), {
    verdict: 'skipped', lines: [],
    skipped: ['every frame: the picture has an alpha channel, so what shows through it depends on what it is laid over'],
  });
  // VP9 keeps its alpha out of the pixel format ffprobe reports.
  const webm = join(dir, 'alpha.webm');
  execFileSync(FFMPEG, ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', TESTSRC, '-t', '1',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-deadline', 'realtime', '-metadata:s:v:0', 'alpha_mode=1', webm]);
  assert.equal(measure(webm).verdict, 'skipped');
});

// --- the opening, which platforms show as the cover ----------------------------------

const COVER = ': platforms show the first frame as the cover';

await test('a fade-in from black is reported, with when the picture is reached', () => {
  const report = measure(synthClip(dir, 'fade-in.mp4', { video: TESTSRC, seconds: 3, vf: 'fade=t=in:st=0:d=1' }));
  assert.equal(report.verdict, 'found');
  assert.deepEqual(report.lines, [`opens fading in until 1.00s, from a first frame of flat black with nothing on it${COVER}`]);
});

await test('a fade-in caught partway still leaves a dim cover, and says how dim', () => {
  const caught = (name: string, frame: number) =>
    synthClip(dir, name, { video: TESTSRC, seconds: 3, vf: `fade=t=in:st=0:d=1.6,trim=start_frame=${frame},setpts=PTS-STARTPTS` });
  assert.match(measure(caught('mid-fade.mp4', 12)).lines[0],
    /^opens fading in until 1\.12s, from a first frame (29|30|31)% as bright as the frame the fade ends on: /);
  assert.match(measure(caught('dark-fade.mp4', 6)).lines[0], /^opens fading in until 1\.36s, from a near-black first frame: /);
});

await test('a slow fade-in is followed to its end, through 8-bit steps and the frames a rate conversion repeats', () => {
  const slow = synthClip(dir, 'slow-fade.mp4', { video: 'testsrc=size=320x240:rate=30', seconds: 7, vf: 'fade=t=in:st=0:d=6' });
  assert.match(measure(slow).lines[0], /^opens fading in until (5\.9\d|6\.0\d)s, from a first frame of flat black/);
  const converted = synthClip(dir, 'converted-fade.mp4', { video: 'testsrc=size=320x240:rate=24', seconds: 3, vf: 'fade=t=in:st=0:d=1,fps=30' });
  assert.match(measure(converted).lines[0], /^opens fading in until (0\.9\d|1\.0\d)s, /);
});

await test('black held before a fade-in is part of the opening, reported to where the fade ends', () => {
  const late = synthClip(dir, 'late-fade.mp4', { video: TESTSRC, seconds: 3, vf: 'fade=t=in:st=0.5:d=1' });
  assert.match(measure(late).lines[0], /^opens fading in until 1\.(4[89]|5\d)s, from a first frame of flat black with nothing on it: /);
});

await test('an eased fade-in is one fade, reported to where it settles', () => {
  const frames = Array.from({ length: 40 }, (_, i) => {
    const a = i >= 25 ? 1 : (1 - Math.cos((Math.PI * i) / 25)) / 2;
    return frame(at(i), i ? 3 : 0, null, { mean: 16 + 110 * a, lumaMax: 16 + 219 * a, range: 220 * a, band: 200 * a });
  });
  const opening = findOpening(frames, at(40));
  assert.ok(opening?.fading, 'a fade-in');
  assert.ok(opening.until >= 0.88 && opening.until <= 1, `until ${opening.until}s`);
});

await test('a black first frame is reported, and so is a cut in from black however long it holds', () => {
  assert.deepEqual(measure(painted('black-first.mp4', { from: 0, to: 0, colour: 'black' })).lines, [
    `opens on flat black with nothing on it until 0.04s${COVER}`,
  ]);
  assert.deepEqual(measure(painted('red-first.mp4', { from: 0, to: 0, colour: 'red' })).lines, [
    `opens on one flat colour with nothing on it until 0.04s${COVER}`,
  ]);
  // Two seconds of black is a blank stretch too, reported once, as the opening.
  assert.deepEqual(measure(painted('black-held.mp4', { from: 0, to: 49, colour: 'black' })).lines, [
    `opens on flat black with nothing on it until 2.00s${COVER}`,
  ]);
});

await test('a near-black opening is reported until the picture shows', () => {
  assert.deepEqual(measure(painted('near-black.mp4', { from: 0, to: 12, colour: 'black@0.85' })).lines, [
    `opens near-black, nothing on it brighter than dark grey, until 0.52s${COVER}`,
  ]);
});

await test('opening on a title on a dark background passes, and so does opening on a person', () => {
  const title = synthClip(dir, 'title-first.mp4', {
    video: 'color=0x111111:s=320x240:r=25:d=3,drawbox=x=60:y=110:w=200:h=20:color=white:t=fill', seconds: 3,
  });
  assert.equal(measure(title).verdict, 'pass');
  const person = fileURLToPath(new URL('./fixtures/talking-head.mp4', import.meta.url));
  assert.equal(measure(person).verdict, 'pass');
});

await test('a picture that only brightens a little as it starts is no fade-in', () => {
  // A title sliding in over a dim backdrop: its brightest pixels come with the title, but the mean climbs from more than
  // half where it ends, so the backdrop was no dimmed copy of the picture.
  const frames = [39, 44, 48, 51, 53, 55, 58, 58, 58].map((mean, i) =>
    frame(at(i), i ? 6 : 0, null, i ? { mean } : { mean, lumaMax: 80, range: 64 }));
  assert.equal(findOpening(frames, at(9)), null);
});

await test('a title drawn at full brightness over a fade-in is the cover, and passes', () => {
  const vf = 'fade=t=in:st=0:d=1,drawbox=x=60:y=110:w=200:h=20:color=white:t=fill';
  assert.equal(measure(synthClip(dir, 'title-over-fade.mp4', { video: TESTSRC, seconds: 3, vf })).verdict, 'pass');
});

await test('a coloured or dim title on black is a title, not a near-black cover', () => {
  // The blue line is too small to tint the frame's mean, and darker than the dark grey near-black allows.
  for (const [name, box] of [['blue-title.mp4', 'x=60:y=110:w=200:h=20:color=blue'], ['dim-title.mp4', 'x=40:y=60:w=240:h=120:color=0x555555']]) {
    const video = synthClip(dir, name, { video: `color=black:s=320x240:r=25:d=2,drawbox=${box}:t=fill`, seconds: 2 });
    assert.equal(measure(video).verdict, 'pass', name);
  }
});

await test('a blank stretch past the opening is still reported; one inside it is not reported twice', () => {
  // Black fading to white, held to 2.4s, then a picture: the fade is the opening, and the white after it is a gap.
  const toWhite = synthClip(dir, 'fade-to-white.mp4', {
    video: 'color=white:s=320x240:r=25:d=2.4,fade=t=in:st=0:d=0.5[a];testsrc=s=320x240:r=25:d=1[b];[a][b]concat=n=2:v=1:a=0',
    seconds: 3.4,
  });
  const lines = measure(toWhite).lines;
  assert.match(lines[0], /^opens fading in until 0\.\d\ds, from a first frame of flat black with nothing on it: /);
  assert.equal(lines[1], 'blank from 0.00s to 2.40s: 2.40s of flat colours with nothing on them');
  // One near-black frame, then two seconds of black: one opening, and no blank stretch beside it.
  const black = Array.from({ length: 50 }, (_, i) => frame(at(i + 1), i ? 0 : 5, 16));
  const frames = [frame(0, 0, null, { lumaMax: 50, range: 30 }), ...black, frame(at(51), 100, null)];
  assert.deepEqual(judgeBlankFrames(frames, at(52)).lines, [`opens near-black, nothing on it brighter than dark grey, until 2.04s${COVER}`]);
});

await test('an opening dark to the last frame runs to the picture\'s end, or to where a short decode stopped', () => {
  const dark = Array.from({ length: 30 }, (_, i) => frame(at(i), 0, null, { lumaMax: 40, range: 20 }));
  assert.equal(findOpening(dark, at(30))?.until, at(30));
  assert.equal(findOpening(dark, 6)?.until, at(30));
  assert.equal(findOpening(dark, at(31))?.until, at(31), 'a probed length a frame past the last one');
});

await test('an opening holds only on frames like its first, so a card of another colour after it is a blank stretch', () => {
  const cards = (name: string, first: string, held: number, then: string) => synthClip(dir, name, {
    video: joined([`color=${first}`, held], [`color=${then}`, 1.52], ['testsrc', 1]), seconds: held + 2.52,
  });
  assert.deepEqual(measure(cards('black-then-blue.mp4', 'black', 0.32, 'blue')).lines, [
    `opens on flat black with nothing on it until 0.32s${COVER}`,
    'blank from 0.00s to 1.84s: 1.84s of flat colours with nothing on them',
  ]);
  assert.deepEqual(measure(cards('white-then-black.mp4', 'white', 0.48, 'black')).lines, [
    `opens on flat white with nothing on it until 0.48s${COVER}`,
    'blank from 0.00s to 2.00s: 2.00s of flat colours with nothing on them',
  ]);
});

await test('a clean clip passes, every frame read once at its own rate', () => {
  const video = synthClip(dir, 'clean.mp4', { video: TESTSRC, seconds: 3 });
  assert.equal(levelsIn(video).length, 75);
  const report = measure(video);
  assert.equal(report.verdict, 'pass');
  assert.deepEqual(report.lines, ['opens on a picture, no flash, and nothing blank for longer than 1.00s, in 75 frames']);
  assert.deepEqual(report.skipped, []);
});
