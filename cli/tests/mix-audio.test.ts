import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TESTSRC, bandLevels, captureConsole, probeStream, scratchDir, synthClip } from './helpers/synth.ts';
import { FFMPEG } from '../src/config.ts';
import { ducks, filtergraph, KEY_LUFS, mixAudio, parseSpec, silentTail, SPEC_KEYS, TRACK_KEYS, usage, type MixSpec } from '../src/commands/mix-audio.ts';

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
  assert.match(graph, /\[a0k\]apad=whole_dur=60\[vkey\]/, 'the key is padded to the film');
  assert.match(graph, /sidechaincompress=threshold=0\.03:ratio=8:attack=20:release=600/);
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
  assert.match(graph, /\[a1\]\[a2\]amix=inputs=2:normalize=0\[beds\]/, 'the music and the effect are one bed');
  assert.match(graph, /\[beds\]\[vkey\]sidechaincompress=/, 'which the voice ducks');
  assert.match(graph, /\[duckedbed\]\[vmix\]amix=inputs=2/, 'nothing plays beside the duck');
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
  assert.match(graph, /\[a1\]\[vkey\]sidechaincompress=/);
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
  assert.match(graph, /\[a0k\]volume=9\.40dB\[a0kg\];\[a0h\]anull\[vmix\];\[a0kg\]apad=whole_dur=60\[vkey\]/, `the key rises to ${KEY_LUFS} LUFS`);
  assert.match(graph, /\[a0\]asplit=2\[a0h\]\[a0k\]/, 'the voice heard is split off before the key is raised');
  assert.match(graph, /threshold=0\.03/, 'the threshold is a stated constant, not a default nobody can see');
  assert.match(graph, /release=600/, 'and the release is slow enough not to pump between words');
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
  assert.match(graph, /\[a0h\]\[a1h\]amix=inputs=2:normalize=0\[vmix\]/, 'the voices are heard as they are');
  assert.match(graph, /\[a0kg\]\[a1kg\]amix=inputs=2:normalize=0,apad=whole_dur=60\[vkey\]/);
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
  for (const field of [...SPEC_KEYS, ...TRACK_KEYS]) {
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
  assert.throws(() => parseSpec({ durationSec: 10, tracks: [] }), /tracks must be a non-empty list/);
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
    /tracks\[1\] has unknown field "gain_db" \(known: path, atSec, gainDb, fadeInSec, fadeOutSec, role, duck, keepPan\)/,
  );
  assert.throws(
    () => parseSpec({ durationSec: 10, tracks: [voice, { path: 'm.wav', atSec: 0, ducking: true }] }),
    /tracks\[1\] has unknown field "ducking"/,
  );
  assert.throws(
    () => parseSpec({ duration: 10, tracks: [voice] }),
    /the spec has unknown field "duration" \(known: durationSec, tracks\)/,
  );
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
  const { run, out } = mixRun(name, { 'vo.m4a': `aevalsrc=${VOICE}:s=48000`, 'music.m4a': MUSIC }, [
    { path: 'vo.m4a', atSec: 0, role: 'voice', ...voice },
    { path: 'music.m4a', atSec: 0, role: 'music', ...music },
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

test('mix: an unmarked effect is ducked under the voice, and one marked "duck": false plays at its own gain', () => {
  const ducked = musicUnder('sfx-duck-default', {}, { role: 'sfx' });
  const level = musicUnder('sfx-duck-opt-out', {}, { role: 'sfx', duck: false });
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
      { path: 'music.m4a', atSec: 0, role: 'music', ...music },
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

// The padding keeps the film its length, so a soundtrack that runs out early ends the video on silence.
test('mix: when every track has ended before the film does, the command names the last one and the silent stretch', () => {
  const { out, warned } = mixRun('short', { 'vo.m4a': `aevalsrc=${VOICE}:s=48000`, 'sting.m4a': MUSIC }, [
    { path: 'vo.m4a', atSec: 0, role: 'voice' },
    { path: 'sting.m4a', atSec: 0.5, role: 'sfx' },
  ], 3.5);
  assert.match(warned, /^mix-audio: warning: every track has ended by 2\.5\d?s, the last being sting\.m4a, so the mix is silent from 2\.5\d?s to 3\.5s$/);
  assert.ok(Math.abs(Number(probeStream(out, 'a:0', 'duration').duration) - 3.5) < 0.05, 'and the mix is still the film\'s length');
  assert.equal(mixRun('full', { 'vo.m4a': `aevalsrc=${VOICE}:s=48000` }, [{ path: 'vo.m4a', atSec: 0, role: 'voice' }]).warned, '',
    'a track that plays to the end says nothing');
});

test('mix: the silent end is the last track\'s, past any slop in a file\'s length, and never guessed', () => {
  const tracks: MixSpec['tracks'] = [
    { path: 'vo.wav', atSec: 0, role: 'voice' },
    { path: 'sting.wav', atSec: 40, role: 'sfx' },
  ];
  assert.deepEqual(silentTail(spec({ tracks }), [50, 1]), { path: 'vo.wav', endSec: 50 }, 'an effect ending early leaves no silence while the voice plays');
  assert.deepEqual(silentTail(spec({ tracks }), [30, 1.5]), { path: 'sting.wav', endSec: 41.5 });
  assert.equal(silentTail(spec({ tracks }), [59.98, 1]), null, 'a few milliseconds short is encoder slop');
  assert.equal(silentTail(spec({ tracks }), [59.95, 1]), null);
  assert.deepEqual(silentTail(spec({ tracks }), [59.85, 1]), { path: 'vo.wav', endSec: 59.85 }, 'a tenth of a second and more is a silence');
  assert.equal(silentTail(spec({ tracks }), [180, 1]), null, 'a track trimmed at the end plays to it');
  assert.equal(silentTail(spec({ tracks }), [undefined, 1]), null, 'an unmeasured track could be playing');
  assert.equal(silentTail(spec({ tracks }), [new Error('no length'), 1]), null, 'and so could one whose length could not be read');
});

// A recording written live, as a browser records one, carries no length in its header.
test('mix: a track whose length cannot be read still mixes, and the command says its end is not checked', () => {
  const run = join(heard, 'no-length');
  mkdirSync(join(run, 'audio'), { recursive: true });
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=${VOICE}:s=48000`, '-t', '2',
    '-c:a', 'opus', '-strict', '-2', '-f', 'webm', '-live', '1', join(run, 'vo.webm')]);
  writeFileSync(join(run, 'audio', 'mix.json'), JSON.stringify({ durationSec: 3, tracks: [{ path: 'vo.webm', atSec: 0, role: 'voice' }] }));
  const graph = captureConsole(() => mixAudio([run, '--print-graph']));
  assert.equal(graph.result, 0);
  assert.equal(graph.err, '', '--print-graph measures nothing it does not print');
  const { result, out, err } = captureConsole(() => mixAudio([run]));
  assert.equal(result, 0);
  assert.match(out, /mix-audio: could not measure the audio duration of .*vo\.webm, so whether the mix ends on silence is not checked/);
  assert.equal(err, '', 'an unmeasured track is never reported as ending early');
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
