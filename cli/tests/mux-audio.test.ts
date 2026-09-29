// Tests src/commands/mux-audio.ts. The measurement's whole contract is agreement with what ffmpeg
// prints, so the modes that depend on it run against real ffmpeg; the decision about what loudnorm
// will DO with a measurement is arithmetic, and is pinned as such.
//   Run:  node --import tsx tests/mux-audio.test.ts
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
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

const picture = (name: string): string => synthClip(dir, `${name}-render.mp4`, { video: TESTSRC, seconds: 2 });

await test('a normalised deliverable is written at 48 kHz, not the 96 kHz loudnorm would otherwise hand the encoder', () => {
  const track = synthClip(dir, 'tone-src.mp4', { video: TESTSRC, audio: SINE, seconds: 2 });
  const out = join(dir, 'tone', 'out.mp4');
  const { result, out: said } = captureConsole(() => muxAudio(['--video', picture('tone'), '--audio', track, '--out', out]));
  assert.equal(result, 0);
  assert.equal(probeStream(out, 'a:0', 'sample_rate').sample_rate, '48000');
  assert.match(said, /mux: wrote .*out\.mp4 \((normalised to -14 LUFS|dynamic loudness correction)/);
});

await test('--no-loudnorm muxes the track as recorded and says nothing about a level', () => {
  const track = synthClip(dir, 'raw-src.mp4', { video: TESTSRC, audio: SINE, seconds: 2 });
  const { result, out } = captureConsole(() =>
    muxAudio(['--video', picture('raw'), '--audio', track, '--out', join(dir, 'raw', 'out.mp4'), '--no-loudnorm']));
  assert.equal(result, 0);
  assert.doesNotMatch(out, /LUFS|dynamic/);
});

await test('an --audio file with no audio stream is refused: a silent deliverable must not exit 0', () => {
  const mute = synthClip(dir, 'named-mute.mp4', { video: TESTSRC, seconds: 2 });
  const { result, err } = captureConsole(() =>
    muxAudio(['--video', picture('mute'), '--audio', mute, '--out', join(dir, 'mute', 'out.mp4')]));
  assert.equal(result, 1);
  assert.match(err, /has no audio stream — nothing to lay on the render/);
});

await test('the output lands where --out names, and the per-attempt temp file is renamed away', () => {
  const track = synthClip(dir, 'elsewhere-track.m4a', { audio: SINE, seconds: 2 });
  const out = join(dir, 'delivered', 'film.mp4');
  const { result } = captureConsole(() => muxAudio(['--video', picture('elsewhere'), '--audio', track, '--out', out, '--no-loudnorm']));
  assert.equal(result, 0);
  assert.equal(probeStream(out, 'a:0', 'codec_type').codec_type, 'audio');
  assert.equal(probeStream(out, 'v:0', 'codec_type').codec_type, 'video');
  assert.deepEqual(readdirSync(join(dir, 'delivered')), ['film.mp4']);
});

await test('a missing --audio or --out is refused by name rather than guessed', () => {
  const { result, err } = captureConsole(() => muxAudio(['--video', picture('lonely'), '--out', join(dir, 'x.mp4')]));
  assert.equal(result, 2);
  assert.match(err, /pass --video, --audio and --out together/);
});

await test('a --video that does not exist is named as the missing input', () => {
  const { result, err } = captureConsole(() => muxAudio(['--video', join(dir, 'nope.mp4'), '--audio', join(dir, 'nope.m4a'), '--out', join(dir, 'y.mp4')]));
  assert.equal(result, 1);
  assert.match(err, /no video at .*nope\.mp4/);
});
