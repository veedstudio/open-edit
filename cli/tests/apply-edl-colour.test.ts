// Colour through apply-edl, against clips ffmpeg synthesises: what a source declares, and what the
// assembled file ends up tagged with — the second cannot be asserted on a string, and the encoder takes
// its tags from the frames it is handed rather than from output options.
//   Run:  node --import tsx tests/apply-edl-colour.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { joinColour } from '../src/colour.ts';
import { applyEdl } from '../src/commands/apply-edl.ts';
import { reframe } from '../src/commands/reframe.ts';
import { FFMPEG } from '../src/config.ts';
import { ASSUMED_COLOUR, colourTagsOf, decodedColourOf } from '../src/probe.ts';
import { FLAT_RGB, SINE, TESTSRC, captureConsole, captureConsoleAsync, flatClip, probeStream, scratchDir, shownRgb, synthClip } from './helpers/synth.ts';

const dir = scratchDir('colour');
const HLG = 'color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc';
const SDR = 'color_primaries=bt709:color_trc=bt709:colorspace=bt709';
const SD = 'color_primaries=smpte170m:color_trc=smpte170m:colorspace=smpte170m';
const synth = (name: string, params: string | null) =>
  synthClip(dir, name, { video: TESTSRC, audio: SINE, seconds: 1, ...(params ? { vf: `setparams=${params}` } : {}) });

const hlg = synth('hlg.mp4', HLG);
const sdr = synth('sdr.mp4', SDR);
const sd = synth('sd.mp4', SD);
const untagged = synth('untagged.mp4', null);
const partial = synth('partial.mp4', 'color_primaries=bt2020');
const hdrPartial = synth('hdr-partial.mp4', 'color_trc=arib-std-b67');
const wideMatrix = synth('wide-matrix.mp4', 'colorspace=bt2020nc');
const mixedPartial = synth('mixed-partial.mp4', 'color_primaries=bt2020:colorspace=bt470bg');

/**
 * A VP8 clip re-encoded to H.264, as reframe and every other re-encode of one makes it: VP8's decoder hands on
 * BT.601's matrix and nothing else, so the file declares its colour space and no primaries or transfer.
 */
function spaceOnly(name: string): string {
  const vp8 = join(dir, `${name}.webm`);
  const out = join(dir, name);
  execFileSync(FFMPEG, ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', TESTSRC, '-f', 'lavfi', '-i', SINE,
    '-t', '1', '-c:v', 'libvpx', '-b:v', '2M', '-c:a', 'libopus', vp8]);
  execFileSync(FFMPEG, ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-i', vp8, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out]);
  return out;
}
const bt601Only = spaceOnly('space-only.mp4');

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

/** joinColour on the sources as apply-edl reads them, none of them HDR. */
const joinOf = (...files: string[]) => joinColour(files.map((f, i) => ({ id: 'abcd'[i], colour: decodedColourOf(f), sdr: false })));

await test('a source that declares only an SD or HD matrix is assumed bt709 whole, and a join converts it from that matrix', () => {
  // ffprobe leaves out an axis the file does not declare.
  assert.deepEqual(probeStream(bt601Only, 'v:0', 'color_primaries,color_transfer,color_space'), { color_space: 'bt470bg' },
    'the fixture is what a VP8 re-encode makes');
  assert.deepEqual(colourTagsOf(bt601Only), { tags: ASSUMED_COLOUR, assumed: true, declared: { space: 'bt470bg' } });
  const joined = joinOf(bt601Only);
  assert.deepEqual(joined.tags, ASSUMED_COLOUR);
  assert.match(joined.stamps[0][0], /^colorspace=ispace=bt470bg:space=bt709:/);
});

await test('a declared axis the assumption would contradict is refused rather than relabelled bt709', () => {
  assert.throws(() => joinOf(hdrPartial), /declares transfer arib-std-b67 but not the rest/);
  assert.throws(() => joinOf(partial), /declares primaries bt2020 but not the rest/);
  // A wide-gamut matrix alone belongs to a picture the bt709 primaries do not describe, and an SD matrix does not
  // excuse a contradicted primaries beside it.
  assert.throws(() => joinOf(wideMatrix), /declares space bt2020nc but not the rest/);
  assert.throws(() => joinOf(mixedPartial), /declares primaries bt2020 but not the rest/);
  // bt709 on one axis and nothing on the others agrees with the assumption, so it is assumed, not refused.
  const sdrPartial = synth('sdr-partial.mp4', 'color_trc=bt709');
  assert.deepEqual(joinOf(sdrPartial).tags, ASSUMED_COLOUR);
});

await test('SD and HD sources join under the first one\'s colour, the others converted; a wide-gamut one among them is refused', () => {
  const mixed = joinOf(sdr, sd);
  assert.deepEqual(mixed.tags, { primaries: 'bt709', transfer: 'bt709', space: 'bt709' });
  assert.match(mixed.stamps[1][0], /^colorspace=ispace=smpte170m:space=bt709:/);
  const wide = synth('wide.mp4', 'color_primaries=bt2020:color_trc=bt2020-10:colorspace=bt2020nc');
  assert.throws(() => joinOf(sdr, wide), /"a" is bt709\/bt709\/bt709 and "b" is bt2020\/bt2020-10\/bt2020nc — one is wide-gamut/);
});

let n = 0;
const assemble = async (sources: Record<string, string>, ids: string[]) => {
  const path = join(dir, `edl-${n++}.json`);
  const out = join(dir, `out-${n}.mp4`);
  writeFileSync(path, JSON.stringify({ sources, ranges: ids.map((source) => ({ source, start: 0, end: 0.5 })) }));
  await captureConsoleAsync(() => applyEdl(['--edl', path, '--out', out]));
  return probeStream(out, 'v:0', 'color_primaries,color_transfer,color_space');
};

await test('the assembled file carries the sources\' declared tags', async () => {
  assert.deepEqual(await assemble({ a: 'sd.mp4' }, ['a', 'a']), { color_primaries: 'smpte170m', color_transfer: 'smpte170m', color_space: 'smpte170m' });
});

await test('an HDR source is assembled as SDR bt709, not under its own tags (hdr.test.ts checks the picture)', async () => {
  assert.deepEqual(await assemble({ a: 'hlg.mp4' }, ['a', 'a']), { color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709' });
});

await test('an untagged source is assembled as bt709, tagged rather than left unknown', async () => {
  assert.deepEqual(await assemble({ a: 'untagged.mp4' }, ['a']), { color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709' });
});

await test('a source that declares only its matrix is assembled as bt709, its picture converted from that matrix, and a line says so', async () => {
  const dir2 = scratchDir('colour-matrix');
  const matrix = flatClip(dir2, 'matrix');
  const path = join(dir2, 'edl.json');
  const out = join(dir2, 'out.mp4');
  writeFileSync(path, JSON.stringify({ sources: { v: matrix }, ranges: [{ source: 'v', start: 0, end: 0.5 }, { source: 'v', start: 0.5, end: 1 }] }));
  const { out: log } = await captureConsoleAsync(() => applyEdl(['--edl', path, '--out', out]));
  assert.match(log, /colour bt709\/bt709\/bt709 \(primaries and transfer assumed bt709 for "v", which declares only space bt470bg\)/);
  assert.match(log, /source "v" is coded otherwise \(matrix bt470bg\): its picture is converted to the cut's/);
  assert.deepEqual(probeStream(out, 'v:0', 'color_primaries,color_transfer,color_space'),
    { color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709' });
  const shown = shownRgb(out, 5);
  assert.ok(shown.every((v, i) => Math.abs(v - FLAT_RGB[i]) < 4), `shown as ${shown.map((v) => v.toFixed(1))}, made as ${FLAT_RGB}`);
});

await test('an EDL of SD and HD sources is assembled under the first one\'s colour, the other converted, not refused', async () => {
  assert.deepEqual(await assemble({ a: 'sdr.mp4', b: 'sd.mp4' }, ['a', 'b']), { color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709' });
});

await test('one EDL of a clip reframe made and that clip\'s own source plays both, each in the colour it was made', async () => {
  const dir2 = scratchDir('colour-reframed');
  const vp8 = flatClip(dir2, 'vp8');
  const tall = join(dir2, 'tall.mp4');
  assert.equal(captureConsole(() => reframe([vp8, '--aspect', '9:16', '--size', 'native', '--out', tall])).result, 0);
  // The VP8 upload as it arrives, and as any re-encode of it declares its colour: the BT.601 matrix alone.
  const reencoded = flatClip(dir2, 'matrix');
  const path = join(dir2, 'edl.json');
  const out = join(dir2, 'cut.mp4');
  writeFileSync(path, JSON.stringify({ sources: { tall, wide: vp8, again: reencoded }, ranges: [
    { source: 'tall', start: 0, end: 1 / 3 }, { source: 'wide', start: 1 / 3, end: 2 / 3 }, { source: 'again', start: 2 / 3, end: 1 },
  ] }));
  const { result, out: log } = await captureConsoleAsync(() => applyEdl(['--edl', path, '--out', out]));
  assert.equal(result, 0, log);
  assert.deepEqual(probeStream(out, 'v:0', 'color_primaries,color_transfer,color_space,color_range'),
    { color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709', color_range: 'tv' });
  // At 30 fps: frame 5 is the reframed clip's, 15 the VP8 source's and 25 its re-encode's.
  for (const frame of [5, 15, 25]) {
    const shown = shownRgb(out, frame);
    assert.ok(shown.every((v, i) => Math.abs(v - FLAT_RGB[i]) < 4), `frame ${frame}: shown as ${shown.map((v) => v.toFixed(1))}, made as ${FLAT_RGB}`);
  }
});
