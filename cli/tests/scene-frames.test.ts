import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFor, extractSceneFrames } from '../src/commands/scene-frames.ts';
import { FFMPEG } from '../src/config.ts';

/** A deterministic clip, so the test needs no fixture on disk and no network. */
function clip(seconds = 4): string {
  const dir = mkdtempSync(join(tmpdir(), 'scene-frames-'));
  const p = join(dir, 'src.mp4');
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `testsrc=size=320x180:rate=24`, '-t', String(seconds), '-pix_fmt', 'yuv420p', p]);
  return p;
}

test('scene-frames: samples spread across the clip and avoid both ends', () => {
  const src = clip(4);
  const plan = planFor(src, '/tmp/out', 8);
  assert.equal(plan.samples.length, 8);
  assert.ok(plan.samples[0].sec > 0, 'the first frame of a clip is its least representative moment');
  assert.ok(plan.samples[7].sec < plan.durationSec, 'and so is the last');
  const secs = plan.samples.map((s) => s.sec);
  assert.deepEqual(secs, [...secs].sort((a, b) => a - b), 'in order');
});

test('scene-frames: the plan carries the canvas and the half-canvas the stills are written at', () => {
  const plan = planFor(clip(2), '/tmp/out', 4);
  assert.equal(plan.width, 320);
  assert.equal(plan.height, 180);
  assert.equal(plan.frameWidth, 160);
  assert.equal(plan.frameHeight, 90);
});

test('scene-frames: a frame index accompanies every sample, so a fact can name a frame', () => {
  const plan = planFor(clip(3), '/tmp/out', 5);
  for (const s of plan.samples) {
    assert.equal(s.frame, Math.round(s.sec * plan.fps));
  }
});

test('scene-frames: it writes the stills and the plan beside them', () => {
  const src = clip(3);
  const out = mkdtempSync(join(tmpdir(), 'scene-out-'));
  const plan = extractSceneFrames(src, out, 4);
  for (const s of plan.samples) assert.ok(existsSync(s.path), `${s.path} written`);
  const onDisk = JSON.parse(readFileSync(join(out, 'scene-plan.json'), 'utf8'));
  assert.equal(onDisk.samples.length, 4);
});

test('scene-frames: a clip with no speech needs no transcript to be sampled', () => {
  // The whole point: this path never reads a transcript, so a silent clip is an ordinary input.
  const plan = planFor(clip(3), '/tmp/out', 6);
  assert.equal(plan.samples.length, 6);
});
