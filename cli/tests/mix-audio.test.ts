import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filtergraph, mixAudio, parseSpec, SPEC_KEYS, TRACK_KEYS, usage, type MixSpec } from '../src/commands/mix-audio.ts';

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

// --- the spec as written by hand -------------------------------------------------
// --help is the only place the spec is documented, so its example has to be one the command accepts.

test('mix: the example in --help is a spec the command accepts, and every field is documented', () => {
  const notes = usage.notes;
  const example = notes.slice(notes.indexOf('{'), notes.lastIndexOf('}') + 1);
  const parsed = parseSpec(JSON.parse(example));
  assert.equal(parsed.tracks.length, 3);
  assert.doesNotThrow(() => filtergraph(parsed));
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
    /tracks\[1\] has unknown field "gain_db" \(known: path, atSec, gainDb, fadeInSec, fadeOutSec, role, duck\)/,
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
