// Colour through apply-edl, against clips ffmpeg synthesises: what a source declares, and what the
// assembled file ends up tagged with — the second cannot be asserted on a string, and the encoder takes
// its tags from the frames it is handed rather than from output options.
//   Run:  node --import tsx tests/apply-edl-colour.test.ts
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyEdl, decideColour } from '../src/commands/apply-edl.ts';
import { ASSUMED_COLOUR, colourTagsOf } from '../src/probe.ts';
import { SINE, TESTSRC, captureConsole, probeStream, scratchDir, synthClip } from './helpers/synth.ts';

const dir = scratchDir('colour');
const HLG = 'color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc';
const SDR = 'color_primaries=bt709:color_trc=bt709:colorspace=bt709';
const synth = (name: string, params: string | null) =>
  synthClip(dir, name, { video: TESTSRC, audio: SINE, seconds: 1, ...(params ? { vf: `setparams=${params}` } : {}) });

const hlg = synth('hlg.mp4', HLG);
const sdr = synth('sdr.mp4', SDR);
const untagged = synth('untagged.mp4', null);
const partial = synth('partial.mp4', 'color_primaries=bt2020');
const hdrPartial = synth('hdr-partial.mp4', 'color_trc=arib-std-b67');

await test('a source that declares its colour keeps it', () => {
  assert.deepEqual(colourTagsOf(hlg), {
    tags: { primaries: 'bt2020', transfer: 'arib-std-b67', space: 'bt2020nc' },
    assumed: false,
    declared: { primaries: 'bt2020', transfer: 'arib-std-b67', space: 'bt2020nc' },
  });
});

await test('a source that declares nothing, or only part, falls back whole and says so', () => {
  assert.deepEqual(colourTagsOf(untagged), { tags: ASSUMED_COLOUR, assumed: true, declared: {} });
  assert.deepEqual(colourTagsOf(partial), { tags: ASSUMED_COLOUR, assumed: true, declared: { primaries: 'bt2020' } });
});

await test('a declared axis the assumption would contradict is refused rather than relabelled bt709', () => {
  assert.throws(() => decideColour([{ id: 'x', colour: colourTagsOf(hdrPartial) }]), /declares transfer arib-std-b67 but not the rest/);
  assert.throws(() => decideColour([{ id: 'x', colour: colourTagsOf(partial) }]), /declares primaries bt2020 but not the rest/);
  // bt709 on one axis and nothing on the others agrees with the assumption, so it is assumed, not refused.
  const sdrPartial = synth('sdr-partial.mp4', 'color_trc=bt709');
  assert.equal(decideColour([{ id: 'x', colour: colourTagsOf(sdrPartial) }]).assumed, true);
});

await test('sources that disagree on colour are refused, naming both', () => {
  assert.throws(
    () => decideColour([{ id: 'a', colour: colourTagsOf(sdr) }, { id: 'b', colour: colourTagsOf(hlg) }]),
    /"a" is bt709\/bt709\/bt709 and "b" is bt2020\/arib-std-b67\/bt2020nc/,
  );
});

let n = 0;
const assemble = (sources: Record<string, string>, ids: string[]) => {
  const path = join(dir, `edl-${n++}.json`);
  const out = join(dir, `out-${n}.mp4`);
  writeFileSync(path, JSON.stringify({ sources, ranges: ids.map((source) => ({ source, start: 0, end: 0.5 })) }));
  captureConsole(() => applyEdl(['--edl', path, '--out', out]));
  return probeStream(out, 'v:0', 'color_primaries,color_transfer,color_space');
};

await test('the assembled file carries the sources\' declared tags', () => {
  assert.deepEqual(assemble({ a: 'hlg.mp4' }, ['a', 'a']), { color_primaries: 'bt2020', color_transfer: 'arib-std-b67', color_space: 'bt2020nc' });
});

await test('an untagged source is assembled as bt709, tagged rather than left unknown', () => {
  assert.deepEqual(assemble({ a: 'untagged.mp4' }, ['a']), { color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709' });
});

await test('a mixed EDL is refused by the command, not encoded under the first source\'s tags', () => {
  assert.throws(() => assemble({ a: 'sdr.mp4', b: 'hlg.mp4' }, ['a', 'b']), /sources disagree on colour/);
});
