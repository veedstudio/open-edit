import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDelivery, meanAbsDiff, offsetOf, parseEbur128 } from '../src/commands/check-delivery.ts';
import { FFMPEG } from '../src/config.ts';

test('offsetOf: the offset of the minimum is read, a still shot is unknown, a near-tie prefers no slip', () => {
  assert.equal(offsetOf([9, 8, 6, 1, 6, 8, 9], 3), 0);
  assert.equal(offsetOf([9, 8, 6, 5, 1, 8, 9], 3), 1);
  assert.equal(offsetOf([4, 4.1, 4, 4.2, 4, 4.1, 4], 3), null, 'a shot that does not move cannot say which frame it is');
  assert.equal(offsetOf([9, 9, 1.0, 1.2, 9, 9, 9], 3), 0, 'two frames this close are one held frame, read as in place');
});

test('meanAbsDiff and parseEbur128 read what they are given', () => {
  assert.equal(meanAbsDiff(new Uint8Array([0, 10, 20]), new Uint8Array([10, 10, 0])), 10);
  const out = 'noise\n[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -14.2 LUFS\n    Threshold: -25.1 LUFS\n\n  Loudness range:\n    LRA:         3.3 LU\n\n  True peak:\n    Peak:       -1.0 dBFS\n';
  assert.deepEqual(parseEbur128(out), { integratedLufs: -14.2, truePeakDb: -1, rangeLu: 3.3 });
  assert.equal(parseEbur128('nothing measured'), null);
});

/** A run whose source moves every frame, so every frame is its own. */
function run(delivered: (src: string, out: string) => void, rate = '24'): string {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-'));
  const src = join(dir, 'src.mp4');
  execFileSync(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=${rate}`, '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '3', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  mkdirSync(join(dir, 'final'));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ videoPath: src }));
  delivered(src, join(dir, 'final', 'out.mp4'));
  return dir;
}

test('checkDelivery: a deliverable that is its source has nothing to report, and its loudness is measured', () => {
  const r = checkDelivery(run((src, out) => copyFileSync(src, out)));
  assert.deepEqual(r.findings, []);
  assert.ok(r.sync.length === 3 && r.sync.every((s) => s.offsetFrames === 0), JSON.stringify(r.sync));
  assert.ok(r.loudness && Number.isFinite(r.loudness.integratedLufs));
  assert.equal(r.fps, '24');
});

test('checkDelivery: a picture three frames late, and a missing soundtrack, are both findings', () => {
  const r = checkDelivery(run((src, out) => {
    execFileSync(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-i', src, '-vf', 'tpad=start=3:start_mode=clone,trim=end_frame=72', '-an', '-pix_fmt', 'yuv420p', out]);
  }));
  assert.ok(r.findings.some((f) => /^picture: -3 frame/.test(f)), r.findings.join(' | '));
  assert.ok(r.findings.some((f) => /no audio stream/.test(f)));
  assert.equal(r.loudness, null);
});

test('checkDelivery: a 23.976 source delivered at 24 is a frame-rate finding that names the exact rate', () => {
  const r = checkDelivery(run((src, out) => {
    execFileSync(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-i', src, '-r', '24', '-c:a', 'copy', '-pix_fmt', 'yuv420p', out]);
  }, '24000/1001'));
  assert.equal(r.source?.fps, '24000/1001');
  assert.equal(r.fps, '24');
  assert.ok(r.findings.some((f) => /^frame rate: delivered 24 fps, source 24000\/1001 fps .*\(24000\/1001\)$/.test(f)), r.findings.join(' | '));
  // The same source delivered at its own rate has no frame-rate finding.
  const same = checkDelivery(run((src, out) => copyFileSync(src, out), '24000/1001'));
  assert.equal(same.fps, '24000/1001');
  assert.ok(!same.findings.some((f) => f.startsWith('frame rate')), same.findings.join(' | '));
});

test('checkDelivery: a run with no out.mp4 is refused, not reported as clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-'));
  assert.throws(() => checkDelivery(dir), /run the gate chain first/);
});
