import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filtergraph, type MixSpec } from '../src/commands/mix-audio.ts';

const spec = (over: Partial<MixSpec> = {}): MixSpec => ({
  durationSec: 60,
  tracks: [{ path: 'vo.wav', atSec: 0, role: 'voice' }],
  ...over,
});

test('mix: every piece lands where the spec puts it, at the level the spec sets', () => {
  const { graph } = filtergraph(spec({
    tracks: [
      { path: 'vo.wav', atSec: 0, role: 'voice' },
      { path: 'sfx.wav', atSec: 12.5, gainDb: -6, role: 'sfx' },
    ],
  }));
  assert.match(graph, /\[1:a\]aresample=48000,adelay=12500\|12500,volume=-6dB/, 'adelay takes one value per channel');
  assert.doesNotMatch(graph, /\[0:a\][^[]*volume=/, 'a track with no gain is left alone');
});

test('mix: levels stay where the spec put them', () => {
  // `amix` divides by the input count unless told not to, which is why a mix assembled without this
  // comes out mysteriously quiet and someone then raises everything to compensate.
  const { graph } = filtergraph(spec({
    tracks: [
      { path: 'a.wav', atSec: 0, role: 'sfx' },
      { path: 'b.wav', atSec: 1, role: 'sfx' },
    ],
  }));
  assert.match(graph, /amix=inputs=2:normalize=0/);
});

test('mix: the film’s length is the film’s length', () => {
  const { graph } = filtergraph(spec({ durationSec: 726.8 }));
  assert.match(graph, /apad=whole_dur=726\.8,atrim=0:726\.8,asetpts=N\/SR\/TB\[mix\]/, 'short pads, long trims');
  assert.throws(() => filtergraph(spec({ durationSec: 0 })), /positive number/);
  assert.throws(() => filtergraph(spec({ tracks: [] })), /no tracks/);
  assert.throws(() => filtergraph(spec({ tracks: [{ path: 'a.wav', atSec: -1 }] })), /non-negative/);
});

test('mix: a fade-out is measured from the end of the film, not from the cue', () => {
  // A cue's own length is not in the spec, so the only end that can be known is the film's.
  const { graph } = filtergraph(spec({
    durationSec: 60,
    tracks: [{ path: 'm.wav', atSec: 2, fadeInSec: 1, fadeOutSec: 3, role: 'sfx' }],
  }));
  assert.match(graph, /afade=t=in:st=2:d=1/);
  assert.match(graph, /afade=t=out:st=57:d=3/);
});

test('mix: the narration keys the duck, and the key outlives the bed', () => {
  // `sidechaincompress` ends its OUTPUT when the sidechain ends. With an unpadded key the music died
  // at the last word — measured at -91dB against -33dB for the same bed one second later, which is
  // the exact opposite of what ducking is for.
  const { graph } = filtergraph(spec({
    durationSec: 60,
    tracks: [
      { path: 'vo.wav', atSec: 0, role: 'voice' },
      { path: 'm.wav', atSec: 0, gainDb: -12, role: 'music', duck: true },
    ],
  }));
  assert.match(graph, /asplit=2\[vmix\]\[vkeyraw\]/);
  assert.match(graph, /\[vkeyraw\]apad=whole_dur=60\[vkey\]/, 'the key is padded to the film');
  assert.match(graph, /sidechaincompress=threshold=0\.03:ratio=8:attack=20:release=600/);
  assert.match(graph, /\[duckedbed\]\[vmix\]/, 'the voice is mixed back in at full level');
});

test('mix: a bed cannot ask to be ducked when nothing is narrating', () => {
  assert.throws(
    () => filtergraph(spec({ tracks: [{ path: 'm.wav', atSec: 0, duck: true }] })),
    /no track is marked role "voice"/,
  );
});

test('mix: without a duck the graph has no compressor at all', () => {
  const { graph } = filtergraph(spec({
    tracks: [
      { path: 'vo.wav', atSec: 0, role: 'voice' },
      { path: 'm.wav', atSec: 0, gainDb: -12, role: 'music' },
    ],
  }));
  assert.doesNotMatch(graph, /sidechaincompress/);
  assert.doesNotMatch(graph, /asplit/);
});

test('mix: the duck is keyed on an absolute threshold, and the graph says which', () => {
  // How deep the bed dips is set by how loud the VOICE is, not by the gap between them. Measured
  // against one bed: -3dB voice pulls the mix down 1.4dB, -12dB pulls 0.8dB, -24dB pulls nothing at
  // all. A quiet take silently gets no ducking, so the number has to be visible and stable.
  const { graph } = filtergraph(spec({
    tracks: [
      { path: 'vo.wav', atSec: 0, role: 'voice' },
      { path: 'm.wav', atSec: 0, role: 'music', duck: true },
    ],
  }));
  assert.match(graph, /threshold=0\.03/, 'the threshold is a stated constant, not a default nobody can see');
  assert.match(graph, /release=600/, 'and the release is slow enough not to pump between words');
});

test('mix: the padding is bounded, or ffmpeg never finishes', () => {
  // `apad` with no argument pads forever, and the `atrim` after it does not always close the graph.
  // A review's fifty-track stress spec ran ffmpeg for an hour without producing a file; bounded, the
  // same spec finishes in under a second.
  const { graph } = filtergraph(spec({ durationSec: 726.8 }));
  assert.match(graph, /apad=whole_dur=726\.8,atrim=0:726\.8/);
  assert.doesNotMatch(graph, /[^_]apad,/, 'no unbounded apad anywhere in the chain');

  const many = filtergraph(spec({
    durationSec: 12,
    tracks: Array.from({ length: 50 }, (_, i) => ({ path: `s${i}.wav`, atSec: i * 0.2, role: 'sfx' as const })),
  }));
  assert.match(many.graph, /amix=inputs=50:normalize=0,apad=whole_dur=12/);
});
