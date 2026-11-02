// Tests src/channels.ts: which tracks are one-sided, and the filter that puts them in both channels.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { CENTRE_GAIN, channelLevels, describeBalance, oneSided, toStereo } from '../src/channels.ts';
import { scratchDir, synthClip } from './helpers/synth.ts';

const dir = scratchDir('channels');

test('channels: a two-channel track is one-sided from 20 dB apart, whichever side carries it', () => {
  assert.equal(oneSided([-20, -40]), true);
  assert.equal(oneSided([-40, -20]), true);
  assert.equal(oneSided([-20, -39.9]), false);
  assert.equal(oneSided([-39.9, -20]), false);
  assert.equal(oneSided([-22.5, -84.3]), true, 'a narration beside an open input');
  assert.equal(oneSided([-Infinity, -22.5]), true, 'beside digital silence');
  // The widest real two-channel track measured 8 dB apart; panned is not one-sided.
  assert.equal(oneSided([-74.7, -66.6]), false);
  assert.equal(oneSided([-Infinity, -Infinity]), false, 'silence is not on one side');
  assert.equal(oneSided([-20]), false, 'a mono file is centred as a matter of course, not reported');
  assert.equal(oneSided([-20, -80, -20, -20, -20, -20]), false, 'more channels are not checked');
});

test('channels: a one-sided track is said to be centred, a leaning one is named with its lean, a balanced one is not mentioned', () => {
  assert.equal(describeBalance([-84.3, -22.5]), 'has its sound on one channel only (-84.3 dBFS / -22.5 dBFS); centred in both channels');
  assert.equal(describeBalance([-22.5, -Infinity]), 'has its sound on one channel only (-22.5 dBFS / silent); centred in both channels');
  assert.equal(describeBalance([-20, -34.5]), 'leans 14.5 dB to the left (-20.0 dBFS / -34.5 dBFS); left as it is');
  assert.equal(describeBalance([-32, -20]), 'leans 12.0 dB to the right (-32.0 dBFS / -20.0 dBFS); left as it is');
  assert.equal(describeBalance([-20, -31.9]), null);
  assert.equal(describeBalance([-20]), null);
});

test('channels: a mono or one-sided track is summed into both channels at equal power; anything else is made stereo by ffmpeg', () => {
  assert.equal(CENTRE_GAIN, 0.7071);
  assert.equal(toStereo([-20]), 'pan=stereo|c0=0.7071*c0|c1=0.7071*c0');
  assert.equal(toStereo([-84.3, -22.5]), 'pan=stereo|c0=0.7071*c0+0.7071*c1|c1=0.7071*c0+0.7071*c1');
  assert.equal(toStereo([-20, -34.5]), 'aformat=channel_layouts=stereo', 'a lean is left as it is');
  assert.equal(toStereo([-17.1, -17.6]), 'aformat=channel_layouts=stereo');
  assert.equal(toStereo([-20, -21, -30, -40, -22, -23]), 'aformat=channel_layouts=stereo', 'more channels: ffmpeg\'s own downmix');
  assert.equal(toStereo(), 'aformat=channel_layouts=stereo');
});

test('channels: each channel is measured on its own, and silence reads as silence', () => {
  // An eighth of full scale is -18.06 dBFS at its peak, and a sine's RMS sits 3.01 dB under that.
  const left = synthClip(dir, 'left.m4a', { audio: 'aevalsrc=sin(2*PI*1000*t)/8|0:s=48000', seconds: 2 });
  const [l, r] = channelLevels(left);
  assert.ok(Math.abs(l - -21.07) < 0.3, `left ${l}`);
  assert.ok(r < -80, `right ${r}`);
  assert.equal(oneSided([l, r]), true);
  assert.equal(channelLevels(synthClip(dir, 'mono.m4a', { audio: 'sine=frequency=440:sample_rate=48000', seconds: 2 })).length, 1);
  assert.throws(() => channelLevels(join(dir, 'missing.m4a')), /could not measure the channels of .*missing\.m4a/);
});
