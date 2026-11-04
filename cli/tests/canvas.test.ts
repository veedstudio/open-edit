// Tests src/verify/canvas.ts: the review's check of the delivered picture's size, on sizes written out and on clips
// ffmpeg makes at the platforms' canvases and at the sizes an unscaled 9:16 crop of 1080p and 4K footage has
// (606x1080 and 1214x2160).
//   Run:  node --import tsx --test cli/tests/canvas.test.ts
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FFMPEG } from '../src/config.ts';
import { canvasFor, judgeCanvas, measureCanvas } from '../src/verify/canvas.ts';
import { rotatedCopy, scratchDir } from './helpers/synth.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const dir = scratchDir('canvas');

/** A one-second clip whose picture is stored at `size`, with `vf` after the source. */
function clipAt(size: string, vf?: string): string {
  const out = join(dir, `${size}${vf ? '-filtered' : ''}.mp4`);
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=10:d=1`, ...(vf ? ['-vf', vf] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out]);
  return out;
}

const judged = (video: string) => measureCanvas({
  video, duration: 1, transcript: { missing: 'none' }, askedLength: { missing: 'none' }, textRecord: { missing: 'none' }, brief: { missing: 'none' },
});

test('canvas: the default canvas of a shape has 1080 px on its short side', () => {
  assert.deepEqual(canvasFor(9 / 16), { width: 1080, height: 1920 });
  assert.deepEqual(canvasFor(1), { width: 1080, height: 1080 });
  assert.deepEqual(canvasFor(4 / 5), { width: 1080, height: 1350 });
  assert.deepEqual(canvasFor(16 / 9), { width: 1920, height: 1080 });
  assert.deepEqual(canvasFor(9 / 16, 2160), { width: 2160, height: 3840 });
});

test('canvas: a 16:9 source cut to 9:16 at its own 606x1080 is reported for its shape and its short side', () => {
  const report = judged(clipAt('606x1080'));
  assert.equal(report.verdict, 'found');
  assert.deepEqual(report.lines, [
    'the picture is 606x1080, nearly 9:16 but not exactly: the 9:16 canvases the platforms list are 1080x1920, 1440x2560 and 2160x3840',
    'its short side is 606 px, under the 1080 px of the platforms\' canvases',
    'reframe scales footage to 1080x1920 by default, and a page\'s stage of that size renders at it',
  ]);
});

test('canvas: a 4K source cut to 9:16 at its own 1214x2160 is reported: large enough, but not 9:16', () => {
  const report = judged(clipAt('1214x2160'));
  assert.equal(report.verdict, 'found');
  assert.match(report.lines[0], /^the picture is 1214x2160, nearly 9:16 but not exactly/);
  assert.equal(report.lines.length, 2, 'its short side is no finding');
});

test('canvas: each platform shape at its canvas passes, read from the file', () => {
  for (const [size, shape] of [['1080x1920', '9:16'], ['1920x1080', '16:9'], ['1080x1080', '1:1'], ['1080x1350', '4:5']]) {
    const report = judged(clipAt(size));
    assert.equal(report.verdict, 'pass', size);
    assert.deepEqual(report.lines, [`${size}, exactly ${shape} with 1080 px on its short side`]);
    assert.deepEqual(report.skipped, []);
  }
});

test('canvas: the size is read as the picture is shown, upright and in square pixels', () => {
  // Stored 1920x1080 with a quarter-turn tag: a phone's 1080x1920 portrait.
  const phone = rotatedCopy(clipAt('1920x1080'), join(dir, 'phone.mp4'), 90);
  assert.deepEqual(judged(phone).lines, ['1080x1920, exactly 9:16 with 1080 px on its short side']);
  // Stored 1440x1080 in 4:3 pixels: a 1920x1080 picture.
  assert.deepEqual(judged(clipAt('1440x1080', 'setsar=4/3')).lines, ['1920x1080, exactly 16:9 with 1080 px on its short side']);
});

test('canvas: a platform shape at a larger size passes, and one under 1080 on its short side is reported', () => {
  assert.equal(judgeCanvas({ width: 2160, height: 3840 }).verdict, 'pass');
  assert.equal(judgeCanvas({ width: 2560, height: 1440 }).verdict, 'pass');
  assert.equal(judgeCanvas({ width: 1440, height: 1800 }).verdict, 'pass');
  const small = judgeCanvas({ width: 1280, height: 720 });
  assert.equal(small.verdict, 'found');
  assert.deepEqual(small.lines, [
    'its short side is 720 px, under the 1080 px of the platforms\' canvases',
    'reframe scales footage to 1920x1080 by default, and a page\'s stage of that size renders at it',
  ]);
  // A percent off 9:16 is that shape gone wrong, however large.
  assert.match(judgeCanvas({ width: 1080, height: 1900 }).lines[0], /^the picture is 1080x1900, nearly 9:16 but not exactly/);
});

test('canvas: a shape no platform lists is judged on its short side alone, and says so', () => {
  const four = judgeCanvas({ width: 1440, height: 1080 });
  assert.equal(four.verdict, 'pass');
  assert.deepEqual(four.lines, ['1440x1080, 1080 px on its short side, at least the 1080 px of the platforms\' canvases']);
  assert.deepEqual(four.skipped, ['the shape: 1440x1080 is 4:3, none of the platform shapes (9:16, 1:1, 4:5, 16:9)']);
  // 3:4 lies 6.25% from 4:5, another shape rather than 4:5 gone wrong.
  assert.equal(judgeCanvas({ width: 1080, height: 1440 }).verdict, 'pass');
  const scope = judgeCanvas({ width: 1920, height: 804 });
  assert.equal(scope.verdict, 'found');
  assert.deepEqual(scope.lines[0], 'its short side is 804 px, under the 1080 px of the platforms\' canvases');
});

test('canvas: the review runs the check, and a 606x1080 delivery is reported in its report', () => {
  const video = clipAt('606x1080');
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'review', video], { encoding: 'utf8', env: { ...process.env, OPEN_EDIT_ROOT: dir } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^canvas +FOUND +the picture is 606x1080, nearly 9:16 but not exactly/m);
});
