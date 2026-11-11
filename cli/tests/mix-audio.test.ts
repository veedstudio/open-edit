import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TESTSRC, bandLevels, captureConsole, probeStream, scratchDir, synthClip } from './helpers/synth.ts';
import { FFMPEG } from '../src/config.ts';
import {
  ducks, effectLevels, filtergraph, fits, KEY_LUFS, LOOP_CROSSFADE_SEC, mixAudio, MUSIC_FADE_OUT_SEC, PAGE_VIDEO_KEYS, parseSpec, piecesOf,
  setUnderVoice, SFX_UNDER_VOICE_LU, SILENCE_FLOOR_DB, speakingLoudness, SPEC_KEYS, TRACK_KEYS, usage, type MixSpec,
} from '../src/commands/mix-audio.ts';
import { lastSoundOf, soundSpanIn, TAIL_SECONDS } from '../src/verify/dead-tail.ts';
import { decode, envelopeOf, SAMPLE_RATE } from '../src/commands/speech-probe.ts';
import { EDGE_FADE_SEC, pageSounds, stemGraph, tempoOf, type PageSound } from '../src/page-sound.ts';
import { writeRecord, type TextRecord } from '../src/render/text-record.ts';

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
  assert.match(graph, /\[1:a\]aresample=48000,aformat=channel_layouts=stereo,adelay=12500\|12500,volume=-6dB/, 'adelay takes one value per channel');
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
  assert.match(graph, /\[a0\]asplit=2\[a0h\]\[a0k\]/);
  assert.match(graph, /\[a0k\]apad=whole_dur=60,apad=pad_dur=0\.5\[bedkey\]/, 'the key is padded to the film, then by the lead');
  assert.match(graph, /\[a1\]adelay=500\|500\[bedlead\];\[bedlead\]\[bedkey\]amerge=inputs=2/, 'the bed meets the key half a second late');
  assert.match(graph, /sidechaincompress=threshold=0\.03:ratio=8:attack=150:release=3000,atrim=start=0\.5,asetpts=N\/SR\/TB\[duckedbed\]/,
    'and the half second is trimmed off after the duck');
  assert.match(graph, /\[duckedbed\]\[vmix\]/, 'the voice is mixed back in at full level');
});

test('mix: a bed cannot ask to be ducked when nothing is narrating', () => {
  assert.throws(
    () => filtergraph(spec({ tracks: [{ path: 'm.wav', atSec: 0, duck: true }] })),
    /no track is marked role "voice"/,
  );
});

// An effect left at its own gain plays over the words.
test('mix: music and sound effects duck under the voice by default, without the spec asking', () => {
  const { graph } = filtergraph(spec({
    tracks: [
      { path: 'vo.wav', atSec: 0, role: 'voice' },
      { path: 'm.wav', atSec: 0, gainDb: -12, role: 'music' },
      { path: 'sting.wav', atSec: 3, role: 'sfx' },
    ],
  }));
  assert.match(graph, /\[a0k\]asplit=2\[bedk\]\[fxk\];\[bedk\]apad=whole_dur=60,apad=pad_dur=0\.5\[bedkey\]/, 'one key for each duck');
  assert.match(graph, /\[a1\]adelay=500\|500\[bedlead\];\[bedlead\]\[bedkey\]amerge=inputs=2.*\[bedin\]\[bedsc\]sidechaincompress=[^[]*attack=150:release=3000/,
    'the music has room before and after the voice');
  assert.match(graph, /\[fxk\]apad=whole_dur=60\[fxkey\];\[a2\]\[fxkey\]amerge=inputs=2.*\[fxin\]\[fxsc\]sidechaincompress=threshold=0\.03:ratio=8:attack=20:release=600\[duckedfx\]/,
    'and the effect, on the beat between lines, a duck that lets go within it');
  assert.match(graph, /\[duckedbed\]\[duckedfx\]\[vmix\]amix=inputs=3/, 'nothing plays beside the ducks');
});

test('mix: effects with no music to duck read the voice as it plays and let go within the beat after it', () => {
  const { graph } = filtergraph(spec({
    tracks: [
      { path: 'vo.wav', atSec: 0, role: 'voice' },
      { path: 'a.wav', atSec: 1, role: 'sfx' },
      { path: 'b.wav', atSec: 2, role: 'sfx' },
    ],
  }));
  assert.match(graph, /\[a1\]\[a2\]amix=inputs=2:normalize=0,asetpts=N\/SR\/TB\[fxs\];\[a0k\]apad=whole_dur=60\[fxkey\];\[fxs\]\[fxkey\]amerge/);
  assert.match(graph, /sidechaincompress=threshold=0\.03:ratio=8:attack=20:release=600\[duckedfx\]/);
  assert.doesNotMatch(graph, /bedlead|atrim=start/);
});

test('mix: a track can opt out of the duck, and with "duck": false the graph has no compressor at all', () => {
  const { graph } = filtergraph(spec({
    tracks: [
      { path: 'vo.wav', atSec: 0, role: 'voice' },
      { path: 'm.wav', atSec: 0, gainDb: -12, role: 'music', duck: false },
      { path: 'sting.wav', atSec: 3, role: 'sfx', duck: false },
    ],
  }));
  assert.doesNotMatch(graph, /sidechaincompress/);
  assert.doesNotMatch(graph, /asplit/);
  assert.match(graph, /\[vox\]\[a1\]\[a2\]amix=inputs=3/, 'both play at their own gain');
});

test('mix: music and effects with nothing narrating play level, and any other track can still ask to duck', () => {
  assert.doesNotMatch(filtergraph(spec({ tracks: [{ path: 'm.wav', atSec: 0, role: 'music' }] })).graph, /sidechaincompress/);
  assert.doesNotMatch(filtergraph(spec({ tracks: [{ path: 'sting.wav', atSec: 0, role: 'sfx' }] })).graph, /sidechaincompress/,
    'an effect with no voice to duck under is not an error');
  const { graph } = filtergraph(spec({
    tracks: [
      { path: 'vo.wav', atSec: 0, role: 'voice' },
      { path: 'room.wav', atSec: 0, role: 'ambience', duck: true },
      { path: 'hiss.wav', atSec: 0, role: 'ambience' },
    ],
  }));
  assert.match(graph, /\[a1\]adelay=500\|500\[bedlead\];\[bedlead\]\[bedkey\]amerge=inputs=2.*\[bedin\]\[bedsc\]sidechaincompress=/);
  assert.match(graph, /\[duckedbed\]\[vmix\]\[a2\]amix=inputs=3/);
});

test('mix: which tracks duck, as the editor hand-off reads it too', () => {
  assert.equal(ducks({ path: 'm.wav', atSec: 0, role: 'music' }, true), true);
  assert.equal(ducks({ path: 'm.wav', atSec: 0, role: 'music' }, false), false);
  assert.equal(ducks({ path: 'm.wav', atSec: 0, role: 'music', duck: false }, true), false);
  assert.equal(ducks({ path: 's.wav', atSec: 0, role: 'sfx' }, true), true);
  assert.equal(ducks({ path: 's.wav', atSec: 0, role: 'sfx' }, false), false);
  assert.equal(ducks({ path: 's.wav', atSec: 0, role: 'sfx', duck: false }, true), false);
  assert.equal(ducks({ path: 'room.wav', atSec: 0, role: 'ambience' }, true), false);
  assert.equal(ducks({ path: 'a.wav', atSec: 0 }, true), false);
  assert.equal(ducks({ path: 's.wav', atSec: 0, duck: true }, true), true);
  assert.equal(ducks({ path: 'vo.wav', atSec: 0, role: 'voice' }, true), false);
});

// Left to ffmpeg's format negotiation, a mono narration listed first collapsed the whole mix to mono, and a
// narration on one channel of a stereo file played in one ear.
test('mix: every track is made stereo before it is placed, and a one-sided one is centred', () => {
  const tracks = [
    { path: 'vo-mono.wav', atSec: 0, role: 'voice' as const },
    { path: 'vo-right.wav', atSec: 1, role: 'voice' as const },
    { path: 'music.wav', atSec: 0, role: 'music' as const },
    { path: 'sting.wav', atSec: 2, role: 'sfx' as const },
  ];
  const { graph } = filtergraph(spec({ tracks }), [[-20], [-84.3, -22.5], [-17.1, -17.6]]);
  assert.match(graph, /\[0:a\]aresample=48000,pan=stereo\|c0=0\.7071\*c0\|c1=0\.7071\*c0,adelay/, 'mono: equal power in both');
  assert.match(graph, /\[1:a\]aresample=48000,pan=stereo\|c0=0\.7071\*c0\+0\.7071\*c1\|c1=0\.7071\*c0\+0\.7071\*c1,adelay/,
    'one channel: both summed, so nothing on the quiet one is dropped');
  assert.match(graph, /\[2:a\]aresample=48000,aformat=channel_layouts=stereo,adelay/, 'stereo stays as recorded');
  assert.match(graph, /\[3:a\]aresample=48000,aformat=channel_layouts=stereo,adelay/, 'unmeasured is still made stereo');
});

test('mix: a track that sets keepPan keeps its panning, even on one side', () => {
  const { graph } = filtergraph(spec({ tracks: [{ path: 'ping.wav', atSec: 0, role: 'sfx', keepPan: true }] }), [[-18, -90]]);
  assert.match(graph, /\[0:a\]aresample=48000,aformat=channel_layouts=stereo,adelay/);
  assert.doesNotMatch(graph, /pan=stereo/);
});

test('mix: the duck\'s key is brought to a fixed loudness, and the graph says by how much', () => {
  // With an absolute threshold, the dip followed the voice's own level: 15dB under -16.6 LUFS, under 2dB
  // under -32.6. Raising only the key makes it the same at any level, and leaves the narration as it is.
  const tracks: MixSpec['tracks'] = [
    { path: 'vo.wav', atSec: 0, role: 'voice' },
    { path: 'm.wav', atSec: 0, role: 'music' },
  ];
  const { graph } = filtergraph(spec({ tracks }), [], [-29.1]);
  assert.match(graph, /\[a0k\]volume=9\.40dB\[a0kg\];\[a0h\]anull\[vmix\];\[a0kg\]apad=whole_dur=60,apad=pad_dur=0\.5\[bedkey\]/, `the key rises to ${KEY_LUFS} LUFS`);
  assert.match(graph, /\[a0\]asplit=2\[a0h\]\[a0k\]/, 'the voice heard is split off before the key is raised');
  assert.match(graph, /threshold=0\.03/, 'the threshold is a stated constant, not a default nobody can see');
  assert.match(graph, /release=3000/, 'and the release is slow enough not to pump between words');
  assert.match(filtergraph(spec({ tracks })).graph, /\[a0k\]apad/, 'unmeasured, the key is the voice as it is');
  // Below -50 LUFS the key is raised no further, so the duck fades out with the track instead of keying on noise.
  assert.match(filtergraph(spec({ tracks }), [], [-50]).graph, /\[a0k\]volume=30\.30dB\[a0kg\]/);
  assert.match(filtergraph(spec({ tracks }), [], [-70]).graph, /\[a0k\]volume=30\.30dB\[a0kg\]/);
});

test('mix: each voice track\'s key is brought to the same loudness on its own', () => {
  const { graph } = filtergraph(spec({
    tracks: [
      { path: 'loud.wav', atSec: 0, role: 'voice' },
      { path: 'quiet.wav', atSec: 2, role: 'voice' },
      { path: 'm.wav', atSec: 0, role: 'music' },
    ],
  }), [], [-15, -35]);
  assert.match(graph, /\[a0k\]volume=-4\.70dB\[a0kg\]/);
  assert.match(graph, /\[a1k\]volume=15\.30dB\[a1kg\]/);
  assert.match(graph, /\[a0h\]\[a1h\]amix=inputs=2:normalize=0,asetpts=N\/SR\/TB\[vmix\]/, 'the voices are heard as they are');
  assert.match(graph, /\[a0kg\]\[a1kg\]amix=inputs=2:normalize=0,asetpts=N\/SR\/TB\[vkey\];\[vkey\]apad=whole_dur=60,apad=pad_dur=0\.5\[bedkey\]/);
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
  assert.match(many.graph, /amix=inputs=50:normalize=0,asetpts=N\/SR\/TB,apad=whole_dur=12/);
});

test('mix: an effect given no gain is set to the gain measured for it, and a gain of its own wins', () => {
  const tracks: MixSpec['tracks'] = [
    { path: 'vo.wav', atSec: 0, role: 'voice' },
    { path: 'whoosh.wav', atSec: 2, role: 'sfx' },
    { path: 'hit.wav', atSec: 4, role: 'sfx', gainDb: -3 },
    { path: 'tap.wav', atSec: 6, role: 'sfx', gainDb: 0 },
  ];
  const { graph } = filtergraph(spec({ tracks }), [], [], [undefined, -17.914, -5, -5]);
  assert.match(graph, /\[1:a\]aresample=48000,aformat=channel_layouts=stereo,adelay=2000\|2000,volume=-17\.91dB\[a1\]/);
  assert.match(graph, /\[2:a\][^[]*adelay=4000\|4000,volume=-3dB\[a2\]/, 'its own gain, not the measured one');
  assert.match(graph, /\[3:a\][^[]*adelay=6000\|6000\[a3\]/, 'and a gain of 0 leaves it as recorded');
  assert.equal(filtergraph(spec({ tracks })).graph.includes('volume=-17'), false, 'unmeasured, it plays as recorded');
});

test('mix: only a sound effect given no gain, under a voice, is set from the voice', () => {
  const sfx = { path: 's.wav', atSec: 0, role: 'sfx' as const };
  assert.equal(setUnderVoice(sfx, true), true);
  assert.equal(setUnderVoice({ ...sfx, duck: false }, true), true, 'whether or not it ducks');
  assert.equal(setUnderVoice(sfx, false), false, 'with no voice to sit under, it plays at its own gain');
  assert.equal(setUnderVoice({ ...sfx, gainDb: 6 }, true), false, 'a deliberate loud hit keeps its gain');
  assert.equal(setUnderVoice({ ...sfx, gainDb: 0 }, true), false);
  for (const role of ['music', 'ambience', 'voice', undefined] as const) {
    assert.equal(setUnderVoice({ path: 'a.wav', atSec: 0, role }, true), false, `${role ?? 'no role'} keeps its gain`);
  }
});

test('mix: the voice\'s loudness while it speaks leaves out its pauses', () => {
  const speech = Array(20).fill(-20);
  assert.equal(speakingLoudness([...speech, ...Array(20).fill(-120.7)]), -20, 'silence between lines');
  assert.equal(speakingLoudness([...speech, ...Array(20).fill(-45)]), -20, 'a breath or room tone 25 LU down');
  assert.ok(Math.abs(speakingLoudness([-20, -26])! - -22.04) < 0.01, 'what is left is averaged as energy, not as LU');
  assert.equal(speakingLoudness([-120.7, -120.7]), undefined, 'a voice that never sounds has no loudness to sit under');
  assert.equal(speakingLoudness([]), undefined);
});

// --- the spec as written by hand -------------------------------------------------
// --help is the only place the spec is documented, so its example has to be one the command accepts.

test('mix: the example in --help is a spec the command accepts, and every field is documented', () => {
  const notes = usage.notes;
  const example = notes.slice(notes.indexOf('{'), notes.lastIndexOf('}') + 1);
  const parsed = parseSpec(JSON.parse(example));
  assert.equal(parsed.tracks.length, 2);
  assert.doesNotThrow(() => filtergraph(parsed));
  // Whatever effect the example shows, an agent copies onto every beat at that level.
  assert.doesNotMatch(example, /"sfx"|whoosh|"gainDb": -6\b/, 'the example holds no sound effect to copy');
  assert.ok(parsed.tracks.every((t) => (t.fadeOutSec ?? 0) <= 1), 'nor a long fade into silence at the end');
  for (const field of [...SPEC_KEYS, ...TRACK_KEYS, ...PAGE_VIDEO_KEYS]) {
    assert.match(notes, new RegExp(`\\b${field}\\b`), `--help documents ${field}`);
  }
  assert.match(notes, /mux-audio --video <render> --audio <run-dir>\/audio\/mix\.m4a --out <file>/);
});

test('mix: a malformed spec is named field by field, never a TypeError from deep in the mix', () => {
  const good = { durationSec: 10, tracks: [{ path: 'vo.wav', atSec: 0, role: 'voice' }] };
  assert.deepEqual(parseSpec(good), good);
  // A bare list of tracks is the likeliest hand-written mistake.
  assert.throws(() => parseSpec([{ path: 'vo.wav', atSec: 0 }]), /not a bare list of tracks.*mix-audio --help/s);
  assert.throws(() => parseSpec({ tracks: good.tracks }), /durationSec.*positive number \(got undefined\)/);
  // The page's videos may be the whole soundtrack, so a spec may hold no track of its own.
  assert.deepEqual(parseSpec({ durationSec: 10 }).tracks, []);
  assert.throws(() => parseSpec({ durationSec: 10, tracks: {} }), /tracks must be a list/);
  assert.throws(() => parseSpec({ durationSec: 10, tracks: [{ atSec: 0 }] }), /tracks\[0\]\.path must name a file/);
  assert.throws(() => parseSpec({ durationSec: 10, tracks: [{ path: 'a.wav', atSec: '2' }] }), /tracks\[0\]\.atSec/);
  assert.throws(() => parseSpec({ durationSec: 10, tracks: [{ path: 'a.wav', atSec: 0, fadeOutSec: -1 }] }), /fadeOutSec must be a non-negative number/);
  assert.throws(() => parseSpec({ durationSec: 10, tracks: [{ path: 'a.wav', atSec: 0, role: 'narration' }] }), /role must be one of voice, music, sfx, ambience \(got "narration"\)/);
  assert.throws(() => parseSpec({ durationSec: 10, tracks: [{ path: 'a.wav', atSec: 0, duck: 'yes' }] }), /duck must be true or false/);
  assert.throws(() => parseSpec({ durationSec: 10, tracks: [{ path: 'a.wav', atSec: 0, keepPan: 1 }] }), /keepPan must be true or false/);
});

// Both specs are well-formed and would mix, but part of what they ask for would never be heard.
test('mix: a track that would be trimmed away, or a voice asked to duck, is refused', () => {
  const voice = { path: 'vo.wav', atSec: 0, role: 'voice' };
  assert.throws(
    () => parseSpec({ durationSec: 10, tracks: [voice, { path: 'sting.wav', atSec: 10, role: 'sfx' }] }),
    /tracks\[1\] starts at 10s, at or past durationSec 10s, so it would be trimmed out/,
  );
  assert.doesNotThrow(() => parseSpec({ durationSec: 10, tracks: [voice, { path: 'sting.wav', atSec: 9.9, role: 'sfx' }] }));
  assert.throws(
    () => parseSpec({ durationSec: 10, tracks: [{ ...voice, duck: true }] }),
    /tracks\[0\] is a voice track, which ducks the others and cannot be ducked itself/,
  );
});

// Every field but path and atSec is optional, so a misspelt one would otherwise be dropped in silence:
// a bed mixed at full level, or never ducked under the narration.
test('mix: a field the spec does not know is refused by name, with the ones it does', () => {
  const voice = { path: 'vo.wav', atSec: 0, role: 'voice' };
  assert.throws(
    () => parseSpec({ durationSec: 10, tracks: [voice, { path: 'm.wav', atSec: 0, gain_db: -14, role: 'music' }] }),
    /tracks\[1\] has unknown field "gain_db" \(known: path, atSec, endSec, gainDb, fadeInSec, fadeOutSec, role, duck, keepPan\)/,
  );
  assert.throws(
    () => parseSpec({ durationSec: 10, tracks: [voice, { path: 'm.wav', atSec: 0, ducking: true }] }),
    /tracks\[1\] has unknown field "ducking"/,
  );
  assert.throws(
    () => parseSpec({ duration: 10, tracks: [voice] }),
    /the spec has unknown field "duration" \(known: durationSec, tracks, pageVideos\)/,
  );
});

test('mix: pageVideos leaves a page video out or sets how it is laid, field by field, and never loops it as music', () => {
  const ok = { durationSec: 10, pageVideos: { 'broll.mp4': false, 'game.mp4': { gainDb: -6, duck: false }, 'talk.mp4': { role: 'voice' } } };
  assert.deepEqual(parseSpec(ok).pageVideos, ok.pageVideos);
  assert.throws(() => parseSpec({ durationSec: 10, pageVideos: ['game.mp4'] }), /pageVideos maps a file the page plays to false or to the settings/);
  assert.throws(() => parseSpec({ durationSec: 10, pageVideos: { 'game.mp4': true } }), /pageVideos\["game\.mp4"\] must be false, which leaves its sound out/);
  assert.throws(() => parseSpec({ durationSec: 10, pageVideos: { 'game.mp4': { atSec: 2 } } }),
    /pageVideos\["game\.mp4"\] has unknown field "atSec" \(known: gainDb, fadeInSec, fadeOutSec, role, duck, keepPan\)/);
  assert.throws(() => parseSpec({ durationSec: 10, pageVideos: { 'game.mp4': { role: 'music' } } }), /role must be voice, sfx or ambience: a music track is looped/);
  assert.throws(() => parseSpec({ durationSec: 10, pageVideos: { 'game.mp4': { gainDb: 'loud' } } }), /pageVideos\["game\.mp4"\]\.gainDb must be a number/);
  assert.throws(() => parseSpec({ durationSec: 10, pageVideos: { 'talk.mp4': { role: 'voice', duck: true } } }), /is a voice track, which ducks the others/);
});

test('mix: the command refuses a malformed, unparsable or missing spec with a usage error', async () => {
  const run = await mkdtemp(join(tmpdir(), 'mix-spec-'));
  await mkdir(join(run, 'audio'));
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => { errors.push(line); };
  try {
    await writeFile(join(run, 'audio', 'mix.json'), JSON.stringify([{ path: 'vo.wav', atSec: 0 }]));
    assert.equal(mixAudio([run, '--print-graph']), 2);
    await writeFile(join(run, 'audio', 'mix.json'), '{ "durationSec": 10,');
    assert.equal(mixAudio([run]), 2);
    assert.equal(mixAudio([join(run, 'nowhere')]), 2);
    assert.equal(mixAudio([run, '--spec', 'audio']), 2);
  } finally {
    console.error = original;
  }
  assert.match(errors[0], /not a bare list of tracks/);
  assert.match(errors[1], /is not valid JSON/);
  assert.match(errors[2], /no spec at .*mix-audio --help/);
  // A spec that exists but cannot be read is not a JSON mistake, and saying so sends the user to fix the wrong thing.
  assert.match(errors[3], /mix-audio: cannot read .*audio: EISDIR/);
  assert.doesNotMatch(errors[3], /not valid JSON/);
});

// --- the mix as heard ---------------------------------------------------------------
// Each source is a tone of its own, so one channel's level in one band is one source's level there:
// the voice at 1 kHz, the music at 200 Hz on the left and 5 kHz on the right.

const heard = scratchDir('mix-heard');
const VOICE = 'sin(2*PI*1000*t)/8';

function mixRun(name: string, sources: Record<string, string>, tracks: MixSpec['tracks'], durationSec = 2): { run: string; out: string; said: string; warned: string } {
  const run = join(heard, name);
  mkdirSync(join(run, 'audio'), { recursive: true });
  for (const [file, source] of Object.entries(sources)) synthClip(run, file, { audio: source, seconds: 2 });
  writeFileSync(join(run, 'audio', 'mix.json'), JSON.stringify({ durationSec, tracks }));
  const { result, out: said, err: warned } = captureConsole(() => mixAudio([run]));
  assert.equal(result, 0);
  return { run, out: join(run, 'audio', 'mix.m4a'), said, warned };
}

const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 0.5, `${what}: ${actual.toFixed(2)} dB, expected ${expected.toFixed(2)}`);

test('mix: a mono voice lands centred, at its own loudness, and the music keeps its stereo', () => {
  // The voice is listed first: the order in which negotiation used to collapse the whole mix to mono.
  const { run, out } = mixRun('mono-voice', {
    'vo.m4a': `aevalsrc=${VOICE}:s=48000`,
    'music.m4a': 'aevalsrc=sin(2*PI*200*t)/8|sin(2*PI*5000*t)/8:s=48000',
  }, [
    { path: 'vo.m4a', atSec: 0, role: 'voice' },
    { path: 'music.m4a', atSec: 0, role: 'music' },
  ]);
  assert.equal(Number(probeStream(out, 'a:0', 'channels').channels), 2);
  const [source] = bandLevels(join(run, 'vo.m4a'), 1000);
  const [left, right] = bandLevels(out, 1000);
  near(left - right, 0, 'the voice sits as loud on the left as on the right');
  // Equal power: each side 3 dB under the mono source, so the pair measures as loud as the source did.
  near(left, source - 3.01, 'and each side carries half its power');
  const [low200, high200] = bandLevels(out, 200);
  const [low5k, high5k] = bandLevels(out, 5000);
  assert.ok(low200 - high200 > 20, `the music's left stays left (${low200} / ${high200})`);
  assert.ok(high5k - low5k > 20, `and its right stays right (${low5k} / ${high5k})`);
});

// The music is a 200 Hz tone on both channels and the voice a 1 kHz one, so the music's band is the music.
const MUSIC = 'aevalsrc=sin(2*PI*200*t)/8|sin(2*PI*200*t)/8:s=48000';
const musicUnder = (name: string, voice: Partial<MixSpec['tracks'][number]>, music: Partial<MixSpec['tracks'][number]> = {}) => {
  // With no fade-out, so the whole file is the bed at its own level and only the duck moves it.
  const { run, out } = mixRun(name, { 'vo.m4a': `aevalsrc=${VOICE}:s=48000`, 'music.m4a': MUSIC }, [
    { path: 'vo.m4a', atSec: 0, role: 'voice', ...voice },
    { path: 'music.m4a', atSec: 0, role: 'music', fadeOutSec: 0, ...music },
  ]);
  return { level: bandLevels(out, 200)[0], source: bandLevels(join(run, 'music.m4a'), 200)[0] };
};

test('mix: unmarked music is ducked under the voice, and music marked "duck": false plays at its own gain', () => {
  const ducked = musicUnder('duck-default', {});
  const level = musicUnder('duck-opt-out', {}, { duck: false });
  // Measured 9.4 dB apart under this steady tone; speech, whose peaks stand over its loudness, dips it further.
  assert.ok(level.level - ducked.level > 8, `ducked ${ducked.level} dB against ${level.level} dB`);
  near(level.level, level.source, 'opted out, the music is as loud as its file');
});

// Each effect has a gain of its own, so the duck is the only thing between the two.
test('mix: an unmarked effect is ducked under the voice, and one marked "duck": false plays at its own gain', () => {
  const ducked = musicUnder('sfx-duck-default', {}, { role: 'sfx', gainDb: 0 });
  const level = musicUnder('sfx-duck-opt-out', {}, { role: 'sfx', gainDb: 0, duck: false });
  assert.ok(level.level - ducked.level > 8, `ducked ${ducked.level} dB against ${level.level} dB`);
  near(level.level, level.source, 'opted out, the effect is as loud as its file');
});

test('mix: the music dips as deep under a quiet narration as under a loud one', () => {
  // The voice tone measures -21.1 LUFS, so these play at about -17.1 and -29.1 LUFS.
  const loud = musicUnder('duck-loud', { gainDb: 4 });
  const quiet = musicUnder('duck-quiet', { gainDb: -8 });
  const level = musicUnder('duck-level', {}, { duck: false });
  near(loud.level, quiet.level, 'the same dip 12 dB apart');
  assert.ok(level.level - quiet.level > 8, `and the quiet one still ducks: ${quiet.level} dB against ${level.level} dB`);
});

// Two voices taking turns, about -15 and -35 LUFS: one key level for the whole bus left the quiet one barely
// ducking the music at all.
test('mix: the music dips as deep under a quiet voice as under a loud one taking turns with it', () => {
  const run = (name: string, music: Partial<MixSpec['tracks'][number]>) => {
    const dir = join(heard, name);
    mkdirSync(join(dir, 'audio'), { recursive: true });
    synthClip(dir, 'loud.m4a', { audio: `aevalsrc=${VOICE}*lt(t\\,2):s=48000`, seconds: 4 });
    synthClip(dir, 'quiet.m4a', { audio: `aevalsrc=${VOICE}*gte(t\\,2):s=48000`, seconds: 4 });
    synthClip(dir, 'music.m4a', { audio: MUSIC, seconds: 4 });
    writeFileSync(join(dir, 'audio', 'mix.json'), JSON.stringify({ durationSec: 4, tracks: [
      { path: 'loud.m4a', atSec: 0, role: 'voice', gainDb: 6 },
      { path: 'quiet.m4a', atSec: 0, role: 'voice', gainDb: -14 },
      { path: 'music.m4a', atSec: 0, role: 'music', fadeOutSec: 0, ...music },
    ] }));
    assert.equal(captureConsole(() => mixAudio([dir])).result, 0);
    const out = join(dir, 'audio', 'mix.m4a');
    return { underLoud: bandLevels(out, 200, [0.6, 1.9])[0], underQuiet: bandLevels(out, 200, [2.6, 3.9])[0] };
  };
  const ducked = run('turns-ducked', {});
  const level = run('turns-level', { duck: false });
  const dipLoud = level.underLoud - ducked.underLoud;
  const dipQuiet = level.underQuiet - ducked.underQuiet;
  near(dipQuiet, dipLoud, 'the dip under the quiet voice');
  assert.ok(dipQuiet > 8, `and it is a real dip: ${dipQuiet.toFixed(1)} dB`);
});

type TrackOver = Partial<MixSpec['tracks'][number]>;
const EFFECT_TONE = 'aevalsrc=sin(2*PI*5000*t)/8:s=48000';

/**
 * One line over a steady bed, the music a 200 Hz tone and, when asked, an effect a 5 kHz one under it all along, read
 * in their bands. A voice given `rampSec` rises from silence over that long, as a spoken word does.
 */
function lineOverBed(name: string, line: [number, number], over: { music?: TrackOver; effect?: TrackOver; rampSec?: number } = {}) {
  const dir = join(heard, name);
  mkdirSync(join(dir, 'audio'), { recursive: true });
  const ramp = over.rampSec ? `*min(1\\,(t-${line[0]})/${over.rampSec})` : '';
  synthClip(dir, 'vo.m4a', { audio: `aevalsrc=${VOICE}*between(t\\,${line[0]}\\,${line[1]})${ramp}:s=48000`, seconds: 6 });
  synthClip(dir, 'music.m4a', { audio: MUSIC, seconds: 6 });
  const tracks: MixSpec['tracks'] = [
    { path: 'vo.m4a', atSec: 0, role: 'voice' },
    { path: 'music.m4a', atSec: 0, role: 'music', fadeOutSec: 0, ...over.music },
  ];
  if (over.effect) {
    synthClip(dir, 'fx.m4a', { audio: EFFECT_TONE, seconds: 6 });
    tracks.push({ path: 'fx.m4a', atSec: 0, role: 'sfx', gainDb: -6, ...over.effect });
  }
  writeFileSync(join(dir, 'audio', 'mix.json'), JSON.stringify({ durationSec: 6, tracks }));
  assert.equal(captureConsole(() => mixAudio([dir])).result, 0);
  const out = join(dir, 'audio', 'mix.m4a');
  return (hz: number, from: number, to: number) => bandLevels(out, hz, [from, to])[0];
}

test('mix: the music is down before the first word and comes back gradually after the last', () => {
  const ducked = lineOverBed('line-ducked', [1, 2.5]);
  const level = lineOverBed('line-level', [1, 2.5], { music: { duck: false } });
  const dip = (from: number, to: number) => level(200, from, to) - ducked(200, from, to);
  assert.ok(dip(0.7, 1) > 8, `already down in the 0.3 s before the word: ${dip(0.7, 1).toFixed(1)} dB`);
  assert.ok(dip(2.8, 3.1) > 3, `still under the voice's room 0.3 s after the last word: ${dip(2.8, 3.1).toFixed(1)} dB`);
  assert.ok(dip(5, 5.8) < 1, `and back at its own level 2.5 s after it: ${dip(5, 5.8).toFixed(1)} dB`);
});

test('mix: a voice from the first frame to the last finds the music down from its start, and the music runs to the end', () => {
  const ducked = lineOverBed('line-whole', [0, 6], { rampSec: 0.25 });
  const level = lineOverBed('line-whole-level', [0, 6], { rampSec: 0.25, music: { duck: false } });
  const dip = (from: number, to: number) => level(200, from, to) - ducked(200, from, to);
  const deep = dip(2, 3);
  assert.ok(Math.abs(dip(0, 0.25) - deep) < 1,
    `down from the first frame while the voice rises, as deep as under the rest of the line: ${dip(0, 0.25).toFixed(1)} dB against ${deep.toFixed(1)}`);
  // The duck reads the voice half a second ahead, so over the last half second it starts to let go: 1.4 dB here.
  assert.ok(Math.abs(deep - dip(5.6, 5.95)) < 2.5,
    `and over 5.6 to 5.95 s the music is as far under the voice as over the line: ${dip(5.6, 5.95).toFixed(1)} dB down against ${deep.toFixed(1)}`);
});

test('mix: an effect under the music keeps a duck that reads the voice as it plays and lets go within the beat after it', () => {
  const ducked = lineOverBed('line-fx', [1, 2.5], { effect: {} });
  const level = lineOverBed('line-fx-level', [1, 2.5], { music: { duck: false }, effect: { duck: false } });
  const dip = (hz: number, from: number, to: number) => level(hz, from, to) - ducked(hz, from, to);
  assert.ok(dip(200, 0.7, 1) > 8 && dip(5000, 0.7, 1) < 1,
    `before the word the music is down and the effect is not: ${dip(200, 0.7, 1).toFixed(1)} and ${dip(5000, 0.7, 1).toFixed(1)} dB`);
  assert.ok(dip(5000, 1.5, 2.3) > 8, `under the word the effect is ducked: ${dip(5000, 1.5, 2.3).toFixed(1)} dB`);
  assert.ok(dip(200, 2.9, 3.2) > 3 && dip(5000, 2.9, 3.2) < 1,
    `0.4 s after the word the music is still down and the effect is back: ${dip(200, 2.9, 3.2).toFixed(1)} and ${dip(5000, 2.9, 3.2).toFixed(1)} dB`);
});

test('mix: a mix with a voice, ducked music and a ducked effect comes out the same on every run', () => {
  const dir = join(heard, 'same-twice');
  mkdirSync(join(dir, 'audio'), { recursive: true });
  synthClip(dir, 'vo.m4a', { audio: `aevalsrc=${VOICE}*between(t\\,0.5\\,2):s=48000`, seconds: 3 });
  synthClip(dir, 'music.m4a', { audio: MUSIC, seconds: 3 });
  synthClip(dir, 'fx.m4a', { audio: EFFECT_TONE, seconds: 3 });
  writeFileSync(join(dir, 'audio', 'mix.json'), JSON.stringify({ durationSec: 3, tracks: [
    { path: 'vo.m4a', atSec: 0, role: 'voice' },
    { path: 'music.m4a', atSec: 0, role: 'music' },
    { path: 'fx.m4a', atSec: 1, role: 'sfx', gainDb: -6 },
  ] }));
  for (const out of ['audio/a.wav', 'audio/b.wav']) assert.equal(captureConsole(() => mixAudio([dir, '--out', out])).result, 0);
  assert.ok(readFileSync(join(dir, 'audio', 'a.wav')).equals(readFileSync(join(dir, 'audio', 'b.wav'))));
});

/** A float WAV's samples, both channels interleaved. */
function samplesOf(file: string): Float32Array {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
}

// 61 frames at 30 fps: a length no whole number of milliseconds reaches.
test('mix: a ducked music bed and a ducked effect sound to the film\'s last sample, whatever its length', () => {
  const durationSec = 2.033333;
  for (const role of ['music', 'sfx'] as const) {
    const dir = join(heard, `last-sample-${role}`);
    mkdirSync(join(dir, 'audio'), { recursive: true });
    synthClip(dir, 'vo.m4a', { audio: `aevalsrc=${VOICE}:s=48000`, seconds: 1 });
    synthClip(dir, 'bed.m4a', { audio: role === 'music' ? MUSIC : EFFECT_TONE, seconds: 3 });
    writeFileSync(join(dir, 'audio', 'mix.json'), JSON.stringify({ durationSec, tracks: [
      { path: 'vo.m4a', atSec: 0, role: 'voice' },
      { path: 'bed.m4a', atSec: 0, role, gainDb: -6, fadeOutSec: 0 },
    ] }));
    assert.equal(captureConsole(() => mixAudio([dir, '--out', 'audio/mix.wav'])).result, 0);
    const pcm = samplesOf(join(dir, 'audio', 'mix.wav'));
    assert.equal(pcm.length / 2, Math.round(durationSec * 48000), `the ${role} mix is the film's length`);
    const last = pcm.findLastIndex((v) => Math.abs(v) > 1e-6);
    assert.equal(Math.floor(last / 2), pcm.length / 2 - 1, `the ${role} sounds to the last sample, not ${pcm.length / 2 - 1 - Math.floor(last / 2)} short of it`);
  }
});

// --- an effect set under the voice ---------------------------------------------------
// The voice speaks for two seconds and the effect, a 5 kHz tone far hotter than the 1 kHz voice, lands a second after
// it stops: on the beat between lines, where nothing ducks it. Both are read off the rendered mix.

/** A file's momentary loudness every 100 ms, as [seconds, LUFS], read here rather than with the command's own reader. */
function momentary(file: string): [number, number][] {
  const { stderr } = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=framelog=info', '-f', 'null', '-'], { encoding: 'utf8' });
  // Digital silence reads "nan".
  return [...(stderr ?? '').matchAll(/t: *(\S+) +TARGET:\S+ LUFS +M: *(\S+)/g)]
    .map(([, t, m]) => [Number(t), Number.isFinite(Number(m)) ? Number(m) : -Infinity]);
}
const loudest = (series: [number, number][], from: number, to: number) =>
  Math.max(...series.filter(([t]) => t >= from && t <= to).map(([, m]) => m));

const EFFECT = 'aevalsrc=sin(2*PI*5000*t)/2*lt(t\\,0.6):s=48000';

function effectAfterVoice(name: string, effect: Partial<MixSpec['tracks'][number]>) {
  const { run, out, said } = mixRun(name, { 'vo.m4a': `aevalsrc=${VOICE}:s=48000`, 'fx.m4a': EFFECT }, [
    { path: 'vo.m4a', atSec: 0, role: 'voice' },
    { path: 'fx.m4a', atSec: 3, role: 'sfx', ...effect },
  ], 4);
  const mixed = momentary(out);
  // Every window that ends before 2.9 s holds the voice alone; every one from 3 s on, the effect alone.
  const voice = speakingLoudness(mixed.filter(([t]) => t < 2.9).map(([, m]) => m))!;
  return { said, voice, steady: loudest(mixed, 0.5, 2), effect: loudest(mixed, 3, 4), source: loudest(momentary(join(run, 'fx.m4a')), 0, 1) };
}

test('mix: an effect louder than the voice, given no gain, comes out under it by the margin', () => {
  const { said, voice, steady, effect, source } = effectAfterVoice('fx-set', {});
  assert.ok(source - voice > 6, `the effect's file peaks ${(source - voice).toFixed(1)} LU over the voice`);
  near(effect - voice, -SFX_UNDER_VOICE_LU, 'the effect at its loudest, against the voice speaking');
  assert.ok(voice <= steady && steady - voice < 1, `the voice's onset and release barely move it: ${voice.toFixed(2)} against ${steady.toFixed(2)} LUFS`);
  assert.match(said, new RegExp(`^mix-audio: fx\\.m4a at 3s set -\\d+\\.\\d dB, its loudest moment from -\\d+\\.\\d LUFS to -\\d+\\.\\d LUFS, `
    + `${SFX_UNDER_VOICE_LU} LU under the voice speaking at -\\d+\\.\\d LUFS$`, 'm'), 'and the command says what it set, from what');
});

test('mix: an effect with a gain of its own keeps it, however loud that leaves it', () => {
  const { said, voice, effect, source } = effectAfterVoice('fx-own-gain', { gainDb: 0 });
  near(effect, source, 'the effect plays as loud as its file');
  assert.ok(effect - voice > 6, `a deliberate hit stays over the voice: ${(effect - voice).toFixed(1)} LU`);
  assert.doesNotMatch(said, /fx\.m4a at/);
});

// The graph the command made before effects were set under a voice: with no voice track, nothing in it moves.
test('mix: with no voice track, every track plays at its own gain and the graph is unchanged', () => {
  const run = join(heard, 'voiceless');
  mkdirSync(join(run, 'audio'), { recursive: true });
  // As long as the film, so the bed plays once.
  synthClip(run, 'music.m4a', { audio: MUSIC, seconds: 3 });
  synthClip(run, 'whoosh.m4a', { audio: EFFECT, seconds: 1 });
  const voiceless: MixSpec = { durationSec: 3, tracks: [
    { path: 'music.m4a', atSec: 0, gainDb: -14, fadeOutSec: 1, role: 'music' },
    { path: 'whoosh.m4a', atSec: 1.5, role: 'sfx' },
    { path: 'whoosh.m4a', atSec: 2, fadeInSec: 0.1, role: 'sfx', keepPan: true },
    { path: 'music.m4a', atSec: 0.5, role: 'ambience' },
  ] };
  writeFileSync(join(run, 'audio', 'mix.json'), JSON.stringify(voiceless));
  assert.deepEqual(effectLevels(run, voiceless), [undefined, undefined, undefined, undefined]);
  const { result, out } = captureConsole(() => mixAudio([run, '--print-graph']));
  assert.equal(result, 0);
  assert.equal(out, '[0:a]aresample=48000,aformat=channel_layouts=stereo,adelay=0|0,volume=-14dB,afade=t=out:st=2:d=1[a0];'
    + '[1:a]aresample=48000,pan=stereo|c0=0.7071*c0|c1=0.7071*c0,adelay=1500|1500[a1];'
    + '[2:a]aresample=48000,aformat=channel_layouts=stereo,adelay=2000|2000,afade=t=in:st=2:d=0.1[a2];'
    + '[3:a]aresample=48000,aformat=channel_layouts=stereo,adelay=500|500[a3];'
    + '[a0][a1][a2][a3]amix=inputs=4:normalize=0,asetpts=N/SR/TB,apad=whole_dur=3,atrim=0:3,asetpts=N/SR/TB[mix]');
});

// A recording written live, as a browser records one, carries no length in its header.
test('mix: a track whose length cannot be read still mixes', () => {
  const run = join(heard, 'no-length');
  mkdirSync(join(run, 'audio'), { recursive: true });
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=${VOICE}:s=48000`, '-t', '2',
    '-c:a', 'opus', '-strict', '-2', '-f', 'webm', '-live', '1', join(run, 'vo.webm')]);
  writeFileSync(join(run, 'audio', 'mix.json'), JSON.stringify({ durationSec: 3, tracks: [{ path: 'vo.webm', atSec: 0, role: 'voice' }] }));
  const graph = captureConsole(() => mixAudio([run, '--print-graph']));
  assert.equal(graph.result, 0);
  assert.equal(graph.err, '', '--print-graph measures nothing it does not print');
  const { result, err } = captureConsole(() => mixAudio([run]));
  assert.equal(result, 0);
  assert.equal(err, '');
  assert.ok(Math.abs(Number(probeStream(join(run, 'audio', 'mix.m4a'), 'a:0', 'duration').duration) - 3) < 0.05);
});

test('mix: a voice recorded on one channel of two is centred in both, and the command says so', () => {
  const { run, out, said } = mixRun('right-voice', { 'vo.m4a': `aevalsrc=0|${VOICE}:s=48000` }, [
    { path: 'vo.m4a', atSec: 0, role: 'voice' },
  ]);
  assert.match(said, /mix-audio: vo\.m4a has its sound on one channel only \(.+ \/ -2\d\.\d dBFS\); centred in both channels/);
  const [, source] = bandLevels(join(run, 'vo.m4a'), 1000);
  const [left, right] = bandLevels(out, 1000);
  near(left - right, 0, 'the voice is no longer in the right ear alone');
  near(left, source - 3.01, 'and loses none of its loudness');
});

test('mix: an effect that sets keepPan stays on its side, and nothing is said about it', () => {
  const { out, said } = mixRun('kept-pan', { 'ping.m4a': 'aevalsrc=sin(2*PI*5000*t)/8|0:s=48000' }, [
    { path: 'ping.m4a', atSec: 0, role: 'sfx', keepPan: true },
  ]);
  const [left, right] = bandLevels(out, 5000);
  assert.ok(left - right > 20, `the ping stays left (${left} / ${right})`);
  assert.doesNotMatch(said, /ping\.m4a/);
});

// A lav on one input and a camera mic on the other: both carry the voice, one far louder.
test('mix: a track leaning hard to one side is named with how far it leans, and left as it is', () => {
  const { out, said } = mixRun('leaning', { 'vo.m4a': `aevalsrc=${VOICE}|${VOICE}/5.62:s=48000` }, [
    { path: 'vo.m4a', atSec: 0, role: 'voice' },
  ]);
  assert.match(said, /mix-audio: vo\.m4a leans 1[45]\.\d dB to the left \(.+\); left as it is/);
  const [left, right] = bandLevels(out, 1000);
  near(left - right, 15, 'the lean is not corrected');
});

test('mix: a track with no sound in it is named, rather than failing deep in the measurement', () => {
  const run = join(heard, 'mute');
  mkdirSync(join(run, 'audio'), { recursive: true });
  synthClip(run, 'picture.mp4', { video: TESTSRC, seconds: 1 });
  writeFileSync(join(run, 'audio', 'mix.json'), JSON.stringify({ durationSec: 1, tracks: [{ path: 'picture.mp4', atSec: 0 }] }));
  const { result, err } = captureConsole(() => mixAudio([run]));
  assert.equal(result, 1);
  assert.equal(err, 'mix-audio: picture.mp4 has no audio stream');
});

// --- the music bed runs to the last frame ------------------------------------------------
// A bed that ended before the picture, a generated piece fading to silence before its file ends, left 10 of 28
// reviewed deliveries with a silent tail over a second.

test('mix: a bed whose sound ends before its stop is looped from its first sound, each repeat crossfaded into the last', () => {
  const c = LOOP_CROSSFADE_SEC;
  assert.deepEqual(piecesOf({ start: 0.5, end: 10 }, 0, 30), [
    { at: 0, in: 0, out: 10, fadeOut: c },
    { at: 9, in: 0.5, out: 10, fadeIn: c, fadeOut: c },
    { at: 17.5, in: 0.5, out: 10, fadeIn: c, fadeOut: c },
    { at: 26, in: 0.5, out: 4.5, fadeIn: c },
  ], 'the first pass keeps the file\'s opening; the repeats start where its sound does');
  assert.deepEqual(piecesOf({ start: 0, end: 29.95 }, 0, 30), [{ at: 0, in: 0, out: 30 }], 'a few codec frames short plays once');
  assert.deepEqual(piecesOf({ start: 0, end: 40 }, 2, 30), [{ at: 2, in: 0, out: 28 }], 'a longer file is cut where it stops');
  assert.deepEqual(piecesOf(null, 2, 10), [{ at: 2, in: 0, out: 8 }], 'a file with no sound plays once');
  assert.deepEqual(piecesOf({ start: 0, end: 1.5 }, 0, 30), [{ at: 0, in: 0, out: 30 }], 'too little sound to hold a crossfade at each end');
});

test('mix: the music that would end last runs to the film\'s end, a track with an endSec to that, and nothing else moves', () => {
  const tracks: MixSpec['tracks'] = [
    { path: 'vo.wav', atSec: 0, role: 'voice' },
    { path: 'intro.wav', atSec: 0, role: 'music' },
    { path: 'bed.wav', atSec: 5, role: 'music' },
    { path: 'hit.wav', atSec: 20, role: 'sfx' },
  ];
  const spans = [undefined, { start: 0, end: 4 }, { start: 0, end: 10 }, undefined];
  const fade = MUSIC_FADE_OUT_SEC;
  assert.deepEqual(fits(spec({ durationSec: 30, tracks }), spans), [
    undefined, undefined, { until: 30, pieces: piecesOf(spans[2]!, 5, 30), fadeOutSec: fade }, undefined,
  ], 'the earlier cue keeps its own length, the voice and the effect are left alone');
  const ownEnd = tracks.map((t) => (t.path === 'intro.wav' ? { ...t, endSec: 12, fadeOutSec: 0.6 } : t));
  assert.deepEqual(fits(spec({ durationSec: 30, tracks: ownEnd }), spans)[1], { until: 12, pieces: piecesOf(spans[1]!, 0, 12), fadeOutSec: 0.6 },
    'an endSec is where it runs to, with its own fade');
  const bedEnds = tracks.map((t) => (t.path === 'bed.wav' ? { ...t, endSec: 20 } : t));
  assert.deepEqual(fits(spec({ durationSec: 30, tracks: bedEnds }), spans).map((f) => f?.until), [undefined, undefined, 20, undefined],
    'music set to stop before the end is the last word on it: nothing else is stretched to the end');
  const layers = fits(spec({ durationSec: 30, tracks: [
    { path: 'pad.wav', atSec: 0, role: 'music' }, { path: 'drums.wav', atSec: 0, role: 'music' },
  ] }), [{ start: 0, end: 10 }, { start: 0, end: 10 }]);
  assert.deepEqual(layers.map((f) => f?.until), [30, 30], 'layers that end together both run on');
});

/** A file's level every 100 ms, in dBFS, as the review's dead-tail check reads it. */
const windows = (file: string) => envelopeOf(decode(file, null), 1600);
const lastSound = (file: string) => lastSoundOf(windows(file), 100).end ?? 0;

test('mix: a 10 s bed under a 30 s film runs to the last frame and fades out, while the voice and an effect play as set', () => {
  const run = join(heard, 'bed-loop');
  mkdirSync(join(run, 'audio'), { recursive: true });
  synthClip(run, 'music.m4a', { audio: MUSIC, seconds: 10 });
  synthClip(run, 'vo.m4a', { audio: `aevalsrc=${VOICE}:s=48000`, seconds: 4 });
  synthClip(run, 'fx.m4a', { audio: EFFECT, seconds: 1 });
  writeFileSync(join(run, 'audio', 'mix.json'), JSON.stringify({ durationSec: 30, tracks: [
    { path: 'vo.m4a', atSec: 0, role: 'voice' },
    { path: 'music.m4a', atSec: 0, role: 'music' },
    { path: 'fx.m4a', atSec: 20, role: 'sfx', gainDb: 0 },
  ] }));
  const { result, out: said } = captureConsole(() => mixAudio([run]));
  assert.equal(result, 0);
  assert.match(said, /^mix-audio: music\.m4a looped to 30s \(its sound ends 10s in\): 3 repeats joined by 1s crossfades, faded out over the last 1\.5s$/m);
  const out = join(run, 'audio', 'mix.m4a');
  const level = windows(out);
  const steady = level.slice(50, 90).reduce((a, b) => Math.max(a, b), -Infinity);
  const dips = level.slice(50, 280).filter((db) => db < steady - 3);
  assert.deepEqual(dips, [], 'no gap at a join: every window from 5 s to 28 s is within 3 dB of the bed');
  assert.ok(lastSound(out) > 30 - TAIL_SECONDS, `sound to within a beat of the end: ${lastSound(out)}s`);
  // The last 0.3 s: half a second from the end a linear 1.5 s fade is only about 10 dB under the bed, too close to
  // the bar to tell a fade from none.
  assert.ok(Math.max(...level.slice(297)) < steady - 10, 'and it fades out into the last frame');
  // The voice plays once and is not repeated with the bed (what is left in its band is the bed's 200 Hz leaking through
  // the filter, 30 dB down); the effect plays at its own gain.
  assert.ok(bandLevels(out, 1000, [0.5, 3.5])[0] - bandLevels(out, 1000, [5, 28])[0] > 20, 'the voice is heard only where it was placed');
  // Mono, so each side carries half its power.
  near(bandLevels(out, 5000, [20.1, 20.5])[0], bandLevels(join(run, 'fx.m4a'), 5000, [0.1, 0.5])[0] - 3.01, 'the effect at its own gain');
});

// Generated music ends on a fade it wrote itself, before its file does: 2.5 s and 1.1 s before the picture in two
// delivered runs, with files as long as the picture.
test('mix: a bed that fades to silence before its file ends is looped from where its sound ends, not its file', () => {
  const run = join(heard, 'bed-fades-early');
  mkdirSync(join(run, 'audio'), { recursive: true });
  synthClip(run, 'music.m4a', { audio: 'aevalsrc=sin(2*PI*200*t)/8*if(lt(t\\,6)\\,1\\,max(0\\,7-t)):s=48000', seconds: 10 });
  writeFileSync(join(run, 'audio', 'mix.json'), JSON.stringify({ durationSec: 10, tracks: [{ path: 'music.m4a', atSec: 0, role: 'music' }] }));
  const source = lastSound(join(run, 'music.m4a'));
  assert.ok(source < 7.5, `the file's own sound ends at ${source}s`);
  const { result, out: said } = captureConsole(() => mixAudio([run]));
  assert.equal(result, 0);
  assert.match(said, /music\.m4a looped to 10s \(its sound ends 6\.\ds in\): 1 repeat joined by a 1s crossfade/);
  const out = join(run, 'audio', 'mix.m4a');
  assert.ok(lastSound(out) > 10 - TAIL_SECONDS, `sound to within a beat of the end: ${lastSound(out)}s`);
});

// A generated piece's last chord rings on far under its own level: an 82 s track with 78 s of it needed was looped, and
// its opening restarted under the closing card.
test('mix: a bed whose last chord decays to the end of its file plays once when the file covers the film', () => {
  const run = join(heard, 'bed-decays-to-end');
  mkdirSync(join(run, 'audio'), { recursive: true });
  // At its level for 2 s, then 4 dB quieter every second to the end of the file.
  synthClip(run, 'music.m4a', { audio: 'aevalsrc=sin(2*PI*200*t)/2*if(lt(t\\,2)\\,1\\,exp(-0.46*(t-2))):s=48000', seconds: 10 });
  writeFileSync(join(run, 'audio', 'mix.json'), JSON.stringify({ durationSec: 9, tracks: [{ path: 'music.m4a', atSec: 0, role: 'music' }] }));
  const source = join(run, 'music.m4a');
  assert.ok(lastSound(source) < 8.5, `20 dB under its level ${lastSound(source)}s in, short of the film's 9 s`);
  assert.ok(windows(source).at(-1)! > SILENCE_FLOOR_DB, 'and still sounding at the end of its file');
  const { result, out: said } = captureConsole(() => mixAudio([run]));
  assert.equal(result, 0);
  assert.doesNotMatch(said, /looped/);
  const out = join(run, 'audio', 'mix.m4a');
  assert.ok(bandLevels(out, 200, [7.5, 8.5])[0] < bandLevels(out, 200, [0.5, 1.5])[0] - 15, 'its opening is not played again under the ending');
});

test('mix: a bed with seconds of true silence after its sound is still looped over them', () => {
  const run = join(heard, 'bed-then-silence');
  mkdirSync(join(run, 'audio'), { recursive: true });
  synthClip(run, 'music.m4a', { audio: 'aevalsrc=sin(2*PI*200*t)/8*lt(t\\,7):s=48000', seconds: 10 });
  writeFileSync(join(run, 'audio', 'mix.json'), JSON.stringify({ durationSec: 10, tracks: [{ path: 'music.m4a', atSec: 0, role: 'music' }] }));
  const { result, out: said } = captureConsole(() => mixAudio([run]));
  assert.equal(result, 0);
  assert.match(said, /music\.m4a looped to 10s \(its sound ends 7(\.\d)?s in\): 1 repeat joined by a 1s crossfade/);
  const out = join(run, 'audio', 'mix.m4a');
  assert.ok(lastSound(out) > 10 - TAIL_SECONDS, `sound to within a beat of the end: ${lastSound(out)}s`);
});

test('mix: a music track with an endSec stops there, faded, and an earlier cue keeps its own length', () => {
  const run = join(heard, 'own-end');
  mkdirSync(join(run, 'audio'), { recursive: true });
  synthClip(run, 'music.m4a', { audio: MUSIC, seconds: 20 });
  synthClip(run, 'cue.m4a', { audio: 'aevalsrc=sin(2*PI*5000*t)/8:s=48000', seconds: 3 });
  writeFileSync(join(run, 'audio', 'mix.json'), JSON.stringify({ durationSec: 30, tracks: [
    { path: 'cue.m4a', atSec: 0, role: 'music' },
    { path: 'music.m4a', atSec: 4, endSec: 12, role: 'music' },
  ] }));
  const { result, out: said } = captureConsole(() => mixAudio([run]));
  assert.equal(result, 0);
  assert.doesNotMatch(said, /looped/);
  const out = join(run, 'audio', 'mix.m4a');
  assert.ok(Math.abs(lastSound(out) - 12) < 0.3, `the bed stops at its endSec: ${lastSound(out)}s`);
  assert.ok(bandLevels(out, 200, [11.6, 12])[0] < bandLevels(out, 200, [8, 10])[0] - 6, 'faded on the way out');
  assert.ok(bandLevels(out, 5000, [0.5, 2.5])[0] - bandLevels(out, 5000, [3.5, 29])[0] > 30, 'the cue plays its 3 s once');
  assert.ok(Math.abs(Number(probeStream(out, 'a:0', 'duration').duration) - 30) < 0.05, 'and the mix is still the film\'s length');
});

test('mix: --video gives the mix its length, and wins over a durationSec left from another cut', () => {
  const run = join(heard, 'video-length');
  mkdirSync(join(run, 'audio'), { recursive: true });
  synthClip(run, 'vo.m4a', { audio: `aevalsrc=${VOICE}:s=48000`, seconds: 2 });
  const video = synthClip(run, 'render.mp4', { video: TESTSRC, seconds: 5 });
  writeFileSync(join(run, 'audio', 'mix.json'), JSON.stringify({ tracks: [{ path: 'vo.m4a', atSec: 0, role: 'voice' }] }));
  const refused = captureConsole(() => mixAudio([run]));
  assert.equal(refused.result, 2);
  assert.match(refused.err, /durationSec.*--video supplies it from a render/);
  assert.equal(captureConsole(() => mixAudio([run, '--video', video])).result, 0);
  const length = () => Number(probeStream(join(run, 'audio', 'mix.m4a'), 'a:0', 'duration').duration);
  assert.ok(Math.abs(length() - 5) < 0.05, `the video's 5 s, got ${length()}`);
  writeFileSync(join(run, 'audio', 'mix.json'), JSON.stringify({ durationSec: 3, tracks: [{ path: 'vo.m4a', atSec: 0, role: 'voice' }] }));
  const { result, out } = captureConsole(() => mixAudio([run, '--video', video]));
  assert.equal(result, 0);
  assert.match(out, /durationSec is 3s in the spec and .*render\.mp4 runs 5s; the mix runs 5s/);
  assert.ok(Math.abs(length() - 5) < 0.05, `still the video's 5 s, got ${length()}`);
});

// --- the page's own videos --------------------------------------------------------------
// The render records, every third frame at 30 fps, which second of which file each <video> of the page shows; a page
// whose videos are given here as page time -> file time (null where the video is not shown) is recorded the same way.

/** Each file's second shown at a page time: one, one per element showing it, or none. */
type Shows = Record<string, (p: number) => number | number[] | null>;

function recordOf(seconds: number, shows: Shows): TextRecord {
  const frames = seconds * 30;
  const samples: TextRecord['samples'] = [];
  const box: [number, number, number, number] = [0, 0, 160, 90];
  for (let frame = 0; frame < frames; frame += 3) {
    const p = frame / 30;
    const videos = Object.entries(shows).flatMap(([file, at]) => [at(p) ?? []].flat()
      .map((f) => ({ file, time: Math.round(f * 1e6) / 1e6, box, shown: box })));
    samples.push({ frame, time: Math.round(p * 1000) / 1000, texts: [], ...(videos.length ? { videos } : {}) });
  }
  return { version: 1, page: '/page.html', width: 320, height: 240, fps: '30', frames, transparent: false, framesPerSample: 3, samples };
}

const between = (from: number, to: number, f: (p: number) => number) => (p: number) => (p >= from - 1e-9 && p < to - 1e-9 ? f(p) : null);
const sounds = (shows: Shows, seconds = 10, length = 100): PageSound[] => pageSounds(recordOf(seconds, shows), () => length);
const near3 = (actual: number, expected: number, what: string) => assert.ok(Math.abs(actual - expected) < 1e-3, `${what}: ${actual}, expected ${expected}`);
const ms3 = (v: number) => Math.round(v * 1000) / 1000;

test('page sound: a clip plays from the moment it is shown, at the second of its file the render showed there', () => {
  // The render plays a clip it is not told otherwise about on the page's clock, 0.1 ms ahead.
  const [s] = sounds({ '/a.mp4': between(2, 5, (p) => p + 1e-4) });
  assert.equal(s.stretches.length, 1);
  near3(s.stretches[0].at, 2, 'at');
  near3(s.stretches[0].in, 2.0001, 'in');
  near3(s.stretches[0].out, 5.0001, 'out, at the sample after the last one that shows it');
  assert.equal(s.stretches[0].rate, 1);
  // A page that starts its clip from a later second: a trim.
  const [trim] = sounds({ '/a.mp4': between(3, 6, (p) => p - 3 + 10) });
  near3(trim.stretches[0].in, 10, 'a trimmed clip starts from its own second');
});

test('page sound: a clip started from its file\'s start between two samples starts there, not at the next sample', () => {
  const [s] = sounds({ '/a.mp4': between(3.05, 6, (p) => p - 3.05) });
  near3(s.stretches[0].at, 3.05, 'at');
  near3(s.stretches[0].in, 0, 'in');
});

test('page sound: a looped clip is laid again from its start at each loop, where the loop happened between samples', () => {
  const [s] = sounds({ '/a.mp4': between(0, 5, (p) => p % 1.55) }, 10, 1.55);
  assert.deepEqual(s.stretches.map((x) => [ms3(x.at), ms3(x.in), ms3(x.out)]), [[0, 0, 1.55], [1.55, 0, 1.55], [3.1, 0, 1.55], [4.65, 0, 0.35]]);
  // Two copies crossfaded into each other (a loop made of two elements) are two sounds while both show.
  const [two] = sounds({ '/g.mp4': (p) => [...(p < 4 ? [p] : []), ...(p >= 3.6 ? [p - 3.6] : [])] }, 6, 4);
  assert.equal(two.stretches.length, 2, 'the second copy may share a sample with the first and still be its own');
  // Not 3.7, the first sample it shows in: its line meets the file's start at 3.6.
  assert.deepEqual(two.stretches.map((x) => [ms3(x.at), ms3(x.in), ms3(x.out)]), [[0, 0, 4], [3.6, 0, 2.4]]);
});

test('page sound: speed is read from how fast the picture moves through its file, and only the speeds Chrome plays are heard', () => {
  const [fast] = sounds({ '/a.mp4': between(1, 3, (p) => 2 * (p - 1)) });
  near3(fast.stretches[0].rate, 2, 'rate');
  near3(fast.stretches[0].out, 4, 'two seconds of page carry four of the file');
  const [held] = sounds({ '/a.mp4': between(1, 3, () => 2) });
  assert.deepEqual([held.stretches, held.unheard], [[], []], 'a picture held on one frame is silent, and nothing is said');
  const [back] = sounds({ '/a.mp4': between(1, 3, (p) => 10 - p) });
  assert.equal(back.stretches.length, 0);
  assert.deepEqual(back.unheard.map((u) => [u.from, u.to, Math.round(u.rate)]), [[1, 3, -1]], 'backwards is named');
  const [blur] = sounds({ '/a.mp4': between(1, 3, (p) => 20 * p) }, 10, 1000);
  assert.deepEqual(blur.unheard.map((u) => Math.round(u.rate)), [20], 'past 16x is named');
});

test('page sound: two elements showing one file at one moment are one sound, and the sound stops where the file\'s does', () => {
  const at = between(0, 5, (p) => p);
  const record = recordOf(10, { '/a.mp4': at });
  for (const s of record.samples) if (s.videos) s.videos.push({ ...s.videos[0] });
  assert.equal(pageSounds(record, () => 100)[0].stretches.length, 1, 'a blurred copy behind the clip is not a second sound');
  const [short] = sounds({ '/a.mp4': at }, 10, 3);
  near3(short.stretches[0].out, 3, 'its sound ends at 3 s while its picture holds to 5 s');
});

test('page sound: each stretch is cut on the file\'s own clock, sped, faded at its edges and placed', () => {
  assert.deepEqual(tempoOf(1), []);
  assert.deepEqual(tempoOf(2), ['atempo=2']);
  assert.deepEqual(tempoOf(0.1), ['atempo=0.5', 'atempo=0.5', 'atempo=0.5', 'atempo=0.8'], 'one step goes no slower than half speed');
  const graph = stemGraph([{ at: 2.5, in: 7.5, out: 9.5, rate: 1 }, { at: 4.5, in: 0, out: 4, rate: 2 }], 2.5, 4);
  assert.match(graph, /^\[0:a\]atrim=start=7\.5:end=9\.5,asetpts=PTS-7\.5\/TB,aresample=48000:async=1:first_pts=0,/,
    'trimmed on its own timestamps, a gap before its sound padded, never shifted to its first sample');
  assert.match(graph, new RegExp(`afade=t=in:d=${EDGE_FADE_SEC},afade=t=out:st=1\\.99:d=${EDGE_FADE_SEC},adelay=delays=0\\.000:all=1\\[s0\\]`));
  assert.match(graph, /\[1:a\]atrim=start=0:end=4,.*atempo=2,asetpts=N\/SR\/TB,.*adelay=delays=2000\.000:all=1\[s1\]/);
  assert.match(graph, /\[s0\]\[s1\]amix=inputs=2:normalize=0,asetpts=N\/SR\/TB,apad=whole_dur=4,atrim=0:4\[stem\]$/);
});

// A tone burst every second of a clip's file, at 0.5, 1.5, 2.5 and 3.5 s, so where each lands in the mix says which
// second of the file plays there.
const BURSTS = 'aevalsrc=sin(2*PI*2000*t)/2*lt(mod(t+0.5\\,1)\\,0.02):s=48000';

/** Where each burst starts in a file, in seconds: the first sample over a tenth of full scale after 0.2 s under it. */
function burstsIn(file: string): number[] {
  const pcm = decode(file, null);
  const starts: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < pcm.length; i++) {
    if (Math.abs(pcm[i]) < 3277) continue;
    if (i - last > 0.2 * SAMPLE_RATE) starts.push(i / SAMPLE_RATE);
    last = i;
  }
  return starts;
}

function pageRun(name: string, clips: Record<string, { audio?: string; seconds: number }>, shows: (abs: (f: string) => string) => Shows,
  spec: object, seconds = 10): { run: string; video: string } {
  const run = join(heard, name);
  mkdirSync(join(run, 'audio'), { recursive: true });
  for (const [file, c] of Object.entries(clips)) synthClip(run, file, { video: TESTSRC, ...(c.audio ? { audio: c.audio } : {}), seconds: c.seconds });
  const video = synthClip(run, 'out.mp4', { video: 'testsrc=size=320x240:rate=30', seconds });
  writeRecord(video, recordOf(seconds, shows((f) => join(run, f))));
  writeFileSync(join(run, 'audio', 'mix.json'), JSON.stringify(spec));
  return { run, video };
}

const landsAt = (actual: number[], expected: number[], within = 0.004) => {
  const said = `bursts at ${actual.map((t) => t.toFixed(4)).join(', ')}, expected ${expected.join(', ')}`;
  assert.equal(actual.length, expected.length, said);
  actual.forEach((t, i) => assert.ok(Math.abs(t - expected[i]) < within, said));
};

test('page sound: a clip looped under a longer piece is heard where each loop shows, with no spec entry', () => {
  // Shown from 1 s to 9 s, looped every 4 s: its bursts land 1.5 s into the page and every second after.
  const { run, video } = pageRun('page-loop', { 'clip.mp4': { audio: BURSTS, seconds: 4 } },
    (abs) => ({ [abs('clip.mp4')]: between(1, 9, (p) => (p - 1) % 4) }), { tracks: [] });
  const { result, out } = captureConsole(() => mixAudio([run, '--video', video]));
  assert.equal(result, 0, out);
  assert.match(out, /^mix-audio: clip\.mp4, a video the page plays, laid in as sfx: 0-4s of the file from 1s, 0-4s of the file from 5s$/m);
  landsAt(burstsIn(join(run, 'audio', 'mix.m4a')), [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5]);
});

test('page sound: a trimmed clip at double speed lands where its picture does, and what is left out says why', () => {
  const { run, video } = pageRun('page-speed', {
    'fast.mp4': { audio: BURSTS, seconds: 4 },
    'mute.mp4': { seconds: 2 },
    'skip.mp4': { audio: BURSTS, seconds: 2 },
    'own.mp4': { audio: BURSTS, seconds: 4 },
    'still.mp4': { audio: BURSTS, seconds: 2 },
    'late.mp4': { audio: BURSTS, seconds: 2 },
  }, (abs) => ({
    // From its second 1, twice as fast, from 2 s to 3.5 s on the page: its bursts at 1.5, 2.5 and 3.5 land at 2.25, 2.75, 3.25.
    [abs('fast.mp4')]: between(2, 3.5, (p) => 1 + 2 * (p - 2)),
    [abs('mute.mp4')]: between(0, 1, (p) => p),
    [abs('skip.mp4')]: between(5, 6, (p) => p - 5),
    [abs('own.mp4')]: between(6, 7, (p) => p - 6),
    // Held on its second 1, and shown from its second 3 though its sound ends at 2: neither plays any sound.
    [abs('still.mp4')]: between(4, 5, () => 1),
    [abs('late.mp4')]: between(7, 8, (p) => p - 4),
  }), { tracks: [{ path: 'own.mp4', atSec: 8 }], pageVideos: { 'skip.mp4': false } });
  const { result, out } = captureConsole(() => mixAudio([run, '--video', video]));
  assert.equal(result, 0, out);
  assert.match(out, /^mix-audio: fast\.mp4, a video the page plays, laid in as sfx: 1-4s of the file from 2s at 2x$/m);
  assert.match(out, /^mix-audio: mute\.mp4, a video the page plays from 0s to 1s, is left out: it has no sound$/m);
  assert.match(out, /^mix-audio: skip\.mp4, a video the page plays from 5s to 6s, is left out: the spec's pageVideos sets it false$/m);
  assert.match(out, /^mix-audio: own\.mp4, a video the page plays from 6s to 7s, is left out: the spec lays that file as a track of its own$/m);
  for (const [file, span] of [['still', '4s to 5s'], ['late', '7s to 8s']]) {
    assert.match(out, new RegExp(`^mix-audio: ${file}\\.mp4, a video the page plays from ${span}, is left out: it holds still or shows only frames after its sound ends, so none of its sound plays$`, 'm'));
  }
  // Time-stretching moves a burst after silence by up to half of atempo's 43 ms window, here under a 30 fps frame.
  landsAt(burstsIn(join(run, 'audio', 'mix.m4a')), [2.25, 2.75, 3.25, 8.5, 9.5], 1 / 30);
});

test('page sound: the newest render in the run is read without --video, a page video can be the voice, and the rest duck under it', () => {
  const { run } = pageRun('page-voice', {
    'talk.mp4': { audio: `aevalsrc=${VOICE}:s=48000`, seconds: 3 },
    'game.mp4': { audio: MUSIC, seconds: 3 },
  }, (abs) => ({ [abs('talk.mp4')]: between(0, 3, (p) => p), [abs('game.mp4')]: between(0, 3, (p) => p) }),
  { durationSec: 3, pageVideos: { 'talk.mp4': { role: 'voice' } } }, 3);
  const { result, out } = captureConsole(() => mixAudio([run]));
  assert.equal(result, 0, out);
  assert.match(out, /^mix-audio: the page's videos are read from .*out\.mp4\.text\.json, the run's newest render; --video names another$/m);
  assert.match(out, /^mix-audio: talk\.mp4, a video the page plays, laid in as voice: 0-3s of the file from 0s$/m);
  assert.match(out, /^mix-audio: game\.mp4, a video the page plays, laid in as sfx, ducked under the voice: 0-3s of the file from 0s$/m);
  assert.match(out, /^mix-audio: game\.mp4 at 0s set -?[\d.]+ dB, its loudest moment from .* 8 LU under the voice/m, 'set under the voice by measuring both');
  const mixed = join(run, 'audio', 'mix.m4a');
  assert.ok(bandLevels(mixed, 1000, [0.5, 2.5])[0] - bandLevels(mixed, 200, [0.5, 2.5])[0] > 10, 'the voice on top, the game under it');
});

test('page sound: a pageVideos entry the page does not play, or with no render to read, is refused as a spec mistake', () => {
  const { run, video } = pageRun('page-unplayed', { 'game.mp4': { audio: BURSTS, seconds: 2 } },
    (abs) => ({ [abs('game.mp4')]: between(0, 2, (p) => p) }), { tracks: [], pageVideos: { 'gameplay.mp4': false } }, 2);
  const refused = captureConsole(() => mixAudio([run, '--video', video]));
  assert.equal(refused.result, 2);
  assert.match(refused.err, /pageVideos names gameplay\.mp4, which the page does not play in .*out\.mp4 \(it plays game\.mp4\)/);
  const bare = join(heard, 'page-none');
  mkdirSync(join(bare, 'audio'), { recursive: true });
  synthClip(bare, 'vo.m4a', { audio: `aevalsrc=${VOICE}:s=48000`, seconds: 1 });
  writeFileSync(join(bare, 'audio', 'mix.json'), JSON.stringify({ durationSec: 1, tracks: [], pageVideos: { 'game.mp4': false } }));
  const none = captureConsole(() => mixAudio([bare]));
  assert.equal(none.result, 2);
  assert.match(none.err, /pageVideos names game\.mp4, but no render in .* has a record of its page's videos beside it/);
  writeFileSync(join(bare, 'audio', 'mix.json'), JSON.stringify({ durationSec: 1 }));
  const empty = captureConsole(() => mixAudio([bare]));
  assert.equal(empty.result, 2);
  assert.match(empty.out, /no render in .* has a record of its page's videos beside it .*, so no page video's sound is laid in; --video names the render/);
  assert.match(empty.err, /nothing to mix: the spec has no tracks, and no video the page plays has sound to lay in/);
});

// --- a ducked bed's timing ---------------------------------------------------------------
// Bursts in a bed under a voice that speaks throughout and stays under burstsIn's threshold, so where each burst lands
// in the ducked mix says whether the duck's lead was trimmed back off every layer of the bed.

function bedsUnderVoice(name: string, layers: string[], duck: boolean): number[] {
  const dir = join(heard, name);
  mkdirSync(join(dir, 'audio'), { recursive: true });
  synthClip(dir, 'vo.m4a', { audio: `aevalsrc=${VOICE}:s=48000`, seconds: 6 });
  layers.forEach((audio, k) => synthClip(dir, `bed${k}.m4a`, { audio, seconds: 6 }));
  writeFileSync(join(dir, 'audio', 'mix.json'), JSON.stringify({ durationSec: 6, tracks: [
    { path: 'vo.m4a', atSec: 0, role: 'voice', gainDb: -6 },
    ...layers.map((_, k) => ({ path: `bed${k}.m4a`, atSec: 0, role: 'ambience', duck })),
  ] }));
  assert.equal(captureConsole(() => mixAudio([dir])).result, 0);
  return burstsIn(join(dir, 'audio', 'mix.m4a'));
}

test('mix: a ducked bed plays in time with the voice, its lead trimmed back off', () => {
  const level = bedsUnderVoice('bursts-level', [BURSTS], false);
  assert.deepEqual(level.map((t) => Math.round(t * 10) / 10), [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]);
  landsAt(bedsUnderVoice('bursts-ducked', [BURSTS], true), level);
});

// A second layer bursting a quarter second after each of the first's, so one layer moved alone moves its own bursts.
const LATE_BURSTS = 'aevalsrc=sin(2*PI*2000*t)/2*lt(mod(t+0.75\\,1)\\,0.02):s=48000';

test('mix: two ducked beds share one lead, so both play in time', () => {
  const level = bedsUnderVoice('two-beds-level', [BURSTS, LATE_BURSTS], false);
  assert.equal(level.length, 12);
  landsAt(bedsUnderVoice('two-beds-ducked', [BURSTS, LATE_BURSTS], true), level);
});
