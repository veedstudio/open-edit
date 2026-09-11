// Tests src/commands/mux-audio.ts. The measurement's whole contract is agreement with what ffmpeg
// prints, so the modes that depend on it run against real ffmpeg; the decision about what loudnorm
// will DO with a measurement is arithmetic, and is pinned as such.
//   Run:  node --import tsx tests/mux-audio.test.ts
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  LOUDNORM_I, LOUDNORM_LRA, LOUDNORM_TP, decideLoudnorm, loudnormFilter, muxAudio, parseLoudnormSummary,
} from '../src/commands/mux-audio.ts';
import { SINE, TESTSRC, captureConsole, probeStream, scratchDir, synthClip } from './helpers/synth.ts';

const dir = scratchDir('mux');
const audioOnly = (name: string, source: string) => synthClip(dir, name, { audio: source, seconds: 2 });

await test('the target the pipeline aims at is the one the filter asks for', () => {
  const r = decideLoudnorm({ input_i: -20, input_tp: -8, input_lra: 6, input_thresh: -30, target_offset: 0 });
  assert.equal(r.mode, 'measured');
  assert.match(r.filter ?? '', new RegExp(`^loudnorm=I=${LOUDNORM_I}:TP=${LOUDNORM_TP}:LRA=${LOUDNORM_LRA}:measured_I=-20:measured_TP=-8`));
  assert.match(r.filter ?? '', /:linear=true$/);
});

await test('a gain that would push the true peak over the ceiling is reported as DYNAMIC, not as -14 LUFS', () => {
  // -20 LUFS needs +6 dB; a -4 dBTP peak lands at +2, and ffmpeg then runs its dynamic normaliser
  // without a word — the deliverable line must not claim the linear correction.
  const r = decideLoudnorm({ input_i: -20, input_tp: -4, input_lra: 6, input_thresh: -30, target_offset: 0 });
  assert.equal(r.mode, 'dynamic');
  assert.match(r.mode === 'dynamic' ? r.why : '', /\+6\.0 dB would put the true peak at 2\.0 dBTP/);
  assert.match(r.filter ?? '', /measured_I=-20.*linear=false$/);
});

await test('a loudness range wider than the limit is reported as dynamic too', () => {
  const r = decideLoudnorm({ input_i: -14, input_tp: -5, input_lra: 15, input_thresh: -30, target_offset: 0 });
  assert.equal(r.mode, 'dynamic');
  assert.match(r.mode === 'dynamic' ? r.why : '', /loudness range is 15\.0 LU/);
});

await test('a loudness range of exactly zero is reported as dynamic, because loudnorm refuses linear mode for it', () => {
  // A steady tone or a stinger over silence measures LRA 0.00; ffmpeg's own gate then runs dynamic.
  const r = decideLoudnorm({ input_i: -10.65, input_tp: -0.41, input_lra: 0, input_thresh: -20.7, target_offset: 0 });
  assert.equal(r.mode, 'dynamic');
  assert.match(r.mode === 'dynamic' ? r.why : '', /loudness range measured as 0 LU/);
});

await test('the summary is found by its own first key, so a later warning with a brace cannot shift it', () => {
  const stderr = 'noise\n{\n\t"input_i" : "-20.5",\n\t"input_tp" : "-3.0"\n}\n[warn] something { odd } after\n';
  assert.equal(parseLoudnormSummary(stderr)?.input_i, '-20.5');
  assert.equal(parseLoudnormSummary('no summary here'), null);
  assert.equal(parseLoudnormSummary('{ "input_i" : broken'), null);
});

await test('a silent track is left at its own level rather than handed an -inf loudnorm refuses', () => {
  const r = loudnormFilter(audioOnly('silent.m4a', 'anullsrc=r=48000:cl=stereo'));
  assert.equal(r.mode, 'none');
  assert.equal(r.filter, null);
  assert.match(r.mode === 'none' ? r.why : '', /no measurable loudness/);
});

await test('a real tone measures, and the measurement reaches the filter', () => {
  const r = loudnormFilter(audioOnly('tone.m4a', SINE));
  assert.notEqual(r.mode, 'none');
  assert.match(r.filter ?? '', /measured_I=.*measured_thresh=/);
});

await test('a file ffmpeg cannot open reports the failure, with ffmpeg\'s own last line', () => {
  const r = loudnormFilter(join(dir, 'does-not-exist.m4a'));
  assert.equal(r.mode, 'dynamic');
  assert.match(r.mode === 'dynamic' ? r.why : '', /measurement pass exited \d+: .+/);
});

// --- the command, end to end ---------------------------------------------------

const runDir = (name: string, source: string): string => {
  const run = join(dir, name);
  mkdirSync(join(run, 'final'), { recursive: true });
  copyFileSync(synthClip(dir, `${name}-render.mp4`, { video: TESTSRC, seconds: 2 }), join(run, 'final', 'out.silent.mp4'));
  writeFileSync(join(run, 'meta.json'), JSON.stringify({ videoPath: source }));
  return run;
};

await test('a normalised deliverable is written at 48 kHz, not the 96 kHz loudnorm would otherwise hand the encoder', () => {
  const run = runDir('tone-run', synthClip(dir, 'tone-src.mp4', { video: TESTSRC, audio: SINE, seconds: 2 }));
  const { result, out } = captureConsole(() => muxAudio([run]));
  assert.equal(result, 0);
  assert.equal(probeStream(join(run, 'final', 'out.mp4'), 'a:0', 'sample_rate').sample_rate, '48000');
  assert.match(out, /mux: wrote .*out\.mp4 \((normalised to -14 LUFS|dynamic loudness correction)/);
});

await test('--no-loudnorm muxes the track as recorded and says nothing about a level', () => {
  const run = runDir('raw-run', synthClip(dir, 'raw-src.mp4', { video: TESTSRC, audio: SINE, seconds: 2 }));
  const { result, out } = captureConsole(() => muxAudio([run, '--no-loudnorm']));
  assert.equal(result, 0);
  assert.doesNotMatch(out, /LUFS|dynamic/);
});

await test('an --audio file with no audio stream is refused: a silent deliverable must not exit 0', () => {
  const run = runDir('named-mute-run', synthClip(dir, 'named-src.mp4', { video: TESTSRC, audio: SINE, seconds: 2 }));
  const mute = synthClip(dir, 'named-mute.mp4', { video: TESTSRC, seconds: 2 });
  const { result, err } = captureConsole(() => muxAudio([run, '--audio', mute]));
  assert.equal(result, 1);
  assert.match(err, /has no audio stream — nothing to lay on the render/);
});

await test('a source with no audio track is muxed as-is and says so, rather than reporting a correction', () => {
  const run = runDir('mute-run', synthClip(dir, 'mute-src.mp4', { video: TESTSRC, seconds: 2 }));
  const { result, out } = captureConsole(() => muxAudio([run]));
  assert.equal(result, 0);
  assert.match(out, /no audio track/);
  assert.doesNotMatch(out, /dynamic/);
  assert.deepEqual(probeStream(join(run, 'final', 'out.mp4'), 'a:0', 'codec_type'), {});
});
