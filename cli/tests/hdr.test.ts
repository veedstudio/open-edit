// HDR footage, converted to SDR wherever the CLI decodes it, against clips made here from a test pattern: what
// comes out is tagged BT.709, carries no HDR10 metadata, and is the picture the reference in helpers/hdr.ts
// computes from the standards, clearly apart from the same reference with any parameter moved.
//   Run:  node --import tsx --test cli/tests/hdr.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CONVERTED, stampColour } from '../src/colour.ts';
import { applyEdl, rangeGraph } from '../src/commands/apply-edl.ts';
import { concatVideos, filterGraph } from '../src/commands/concat-videos.ts';
import { extractFrames } from '../src/commands/frames.ts';
import { FFMPEG } from '../src/config.ts';
import { SDR_PARAMS, describeHdr, filterPath, hdrKind, toSdr } from '../src/hdr.ts';
import { BT709 as BT709_TAGS, colourTagsOf } from '../src/probe.ts';
import { countFrames } from '../src/render/encode.ts';
import {
  SDR_NEIGHBOURS, SDR_REFERENCE, assertConverted, expectedLuma, hdr10Data, hdrClip, lumaOf, type Transfer,
} from './helpers/hdr.ts';
import {
  SINE, TESTSRC, captureConsoleAsync, meanAbsDiff, probeStream, rawFrame, scratchDir, synthClip,
} from './helpers/synth.ts';

const BT709 = { color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709' };
const TAGS = 'color_primaries,color_transfer,color_space';
const W = 320;

const dir = scratchDir('hdr');
const hlg = hdrClip(dir, 'hlg.mp4', { transfer: 'arib-std-b67' });
const pq = hdrClip(dir, 'pq.mp4', { transfer: 'smpte2084', hdr10: true });
const sdr = synthClip(dir, 'sdr.mp4', { video: TESTSRC, audio: SINE, seconds: 1, vf: 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709' });
const untagged = synthClip(dir, 'untagged.mp4', { video: TESTSRC, audio: SINE, seconds: 1 });
// HLG declared on the transfer alone, as a transcode that dropped the other two tags leaves it.
const transferOnly = hdrClip(dir, 'transfer-only.mp4', { transfer: 'arib-std-b67', tags: 'transfer' });
const p3 = hdrClip(dir, 'p3.mp4', { transfer: 'smpte2084', primaries: 'smpte432' });
// A 10-bit grey ramp, as a camera records HLG, and a clip smaller than the canvas.
const ramp10 = hdrClip(dir, 'ramp10.mp4', { transfer: 'arib-std-b67', pixFmt: 'yuv420p10le',
  video: "color=black:size=320x240:rate=25,format=gray16le,geq=lum='X/W*65535'" });
const small = hdrClip(dir, 'small.mp4', { transfer: 'arib-std-b67', video: 'testsrc=size=160x120:rate=25' });

/**
 * A copy of `source` declaring other primaries or matrix, by H.273 code and ffmpeg name, as a camera or encoder
 * may write them: in the H.264 stream and in the MP4's colour box, which ffprobe 8.1 and 9.0 read in preference
 * to the stream, so a stream retagged alone still reads as it was there.
 */
const retag = (source: string, name: string, o: { primaries?: [number, string]; matrix?: [number, string] }) => {
  const out = join(dir, name);
  const stream = [o.primaries && `colour_primaries=${o.primaries[0]}`, o.matrix && `matrix_coefficients=${o.matrix[0]}`].filter(Boolean);
  const box = [...(o.primaries ? ['-color_primaries', o.primaries[1]] : []), ...(o.matrix ? ['-colorspace', o.matrix[1]] : [])];
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', source, '-c', 'copy', '-bsf:v', `h264_metadata=${stream.join(':')}`, ...box, out]);
  return out;
};

const converted = (source: string, frame: number, got: Float64Array, transfer: Transfer, what: string, tolerance = 1.5) =>
  assertConverted(source, frame, got, { transfer, width: W, tolerance, what });

await test('PQ and HLG are HDR, whatever else the source leaves unset, and nothing else is', () => {
  assert.equal(hdrKind(colourTagsOf(hlg)), 'HLG');
  assert.equal(hdrKind(colourTagsOf(pq)), 'PQ');
  assert.equal(hdrKind(colourTagsOf(transferOnly)), 'HLG');
  assert.equal(hdrKind(colourTagsOf(sdr)), null);
  assert.equal(hdrKind(colourTagsOf(untagged)), null);
});

await test('the conversion is BT.2408\'s placement with a Mobius roll-off to 1000 cd/m2, built from filters every build has', () => {
  assert.deepEqual({ ...SDR_PARAMS }, SDR_REFERENCE);
  const chain = toSdr(colourTagsOf(hlg));
  assert.match(chain, /^scale=in_color_matrix=bt2020,format=gbrpf32le,lut1d=file=.*hlg-to-linear-\w+\.cube:interp=linear,/);
  assert.match(chain, /colorchannelmixer=rr=1\.6604\d+:rg=-0\.5876\d+:rb=-0\.0728\d+:/);
  assert.match(chain, /,tonemap=tonemap=mobius:param=0\.7:desat=0:peak=4\.926108,lut1d=file=/);
  assert.match(chain, /setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA,sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL$/);
  assert.doesNotMatch(chain, /zscale/);
  // An unset matrix is read as BT.2020's, which BT.2100 defines PQ and HLG with.
  assert.match(toSdr(colourTagsOf(transferOnly)), /^scale=in_color_matrix=bt2020,/);
  // Other primaries get their own matrix, and BT.709's none.
  assert.match(toSdr(colourTagsOf(p3)), /colorchannelmixer=rr=1\.2249\d+:rg=-0\.2249\d+:rb=-?0\.000000:/);
  const bt709Hlg = { tags: BT709_TAGS, assumed: false, declared: { primaries: 'bt709', transfer: 'arib-std-b67', space: 'bt709' } };
  assert.doesNotMatch(toSdr(bt709Hlg), /colorchannelmixer/);
  // A white other than D65 (DCI's, illuminant C) is adapted to it, so every set keeps the source's white white.
  const pqIn = (primaries: string, space = 'bt2020nc') => ({ tags: BT709_TAGS, assumed: false, declared: { primaries, transfer: 'smpte2084', space } });
  for (const primaries of ['bt2020', 'smpte432', 'smpte431', 'ebu3213', 'jedec-p22', 'bt470m', 'film']) {
    const gains = /colorchannelmixer=([^,]+)/.exec(toSdr(pqIn(primaries)))![1].split(':').map((g) => Number(g.split('=')[1]));
    for (const row of [0, 3, 6]) assert.ok(Math.abs(gains[row] + gains[row + 1] + gains[row + 2] - 1) < 1e-5, `${primaries}: ${gains}`);
  }
  assert.notEqual(toSdr(pqIn('smpte431')), toSdr(pqIn('smpte432')), 'DCI-P3 is not P3-D65');
  // Primaries it cannot convert from are read as BT.2020's, and the line says so.
  assert.equal(toSdr(pqIn('smpte428')), toSdr(pqIn('bt2020')));
  assert.match(describeHdr('x.mp4', pqIn('smpte428')), /^x\.mp4 is HDR \(PQ, smpte428 \(read as bt2020\)\/smpte2084\/bt2020nc\)/);
});

await test('EBU Tech 3213 primaries are converted from, under the name ffprobe gives them', (t) => {
  const ebu = colourTagsOf(retag(pq, 'ebu.mp4', { primaries: [22, 'jedec-p22'] }));
  if (!/^(ebu3213|jedec-p22)$/.test(ebu.declared.primaries ?? '')) {
    t.skip(`this ffmpeg did not carry EBU 3213 primaries into the fixture: ffprobe reads ${ebu.declared.primaries}`);
    return;
  }
  assert.match(toSdr(ebu), /colorchannelmixer=rr=1\.025252:rg=-0\.026548:/);
  assert.match(describeHdr('ebu.mp4', ebu), /^ebu\.mp4 is HDR \(PQ, (ebu3213|jedec-p22)\/smpte2084\/bt2020nc\): converted/);
});

await test('a LUT whose path has a space, a quote, a comma, brackets or a colon is still read', () => {
  const odd = join(dir, process.platform === 'win32' ? "state a 'b',[c];d" : "state a 'b',[c];d:e");
  mkdirSync(odd, { recursive: true });
  const before = process.env.OPENEDIT_STATE_DIR;
  process.env.OPENEDIT_STATE_DIR = odd;
  try {
    const chain = toSdr(colourTagsOf(hlg));
    assert.ok(chain.includes(filterPath(join(odd, 'luts'))), chain);
    execFileSync(FFMPEG, ['-v', 'error', '-i', hlg, '-frames:v', '1', '-vf', chain, '-f', 'null', '-']);
  } finally {
    if (before === undefined) delete process.env.OPENEDIT_STATE_DIR; else process.env.OPENEDIT_STATE_DIR = before;
  }
});

await test('a state folder named relative to where the CLI runs is still read by an ffmpeg run from a folder beside it', () => {
  // As the joins run ffmpeg, from a folder of their own: a LUT path left relative would be looked for there.
  const base = join(dir, 'relative-state');
  mkdirSync(join(base, 'elsewhere'), { recursive: true });
  const [before, cwd] = [process.env.OPENEDIT_STATE_DIR, process.cwd()];
  process.chdir(base);
  process.env.OPENEDIT_STATE_DIR = 'state';
  try {
    execFileSync(FFMPEG, ['-v', 'error', '-i', hlg, '-frames:v', '1', '-vf', toSdr(colourTagsOf(pq)), '-f', 'null', '-'], { cwd: join(base, 'elsewhere'), stdio: 'pipe' });
  } finally {
    process.chdir(cwd);
    if (before === undefined) delete process.env.OPENEDIT_STATE_DIR; else process.env.OPENEDIT_STATE_DIR = before;
  }
});

await test('apply-edl: only an HDR source\'s ranges are converted, before they are scaled, and every range is labelled for the join', () => {
  const range = (source: string, start: number) => ({ source, start, end: start + 0.4, fps: 25 });
  const chain = toSdr(colourTagsOf(hlg));
  const graph = (source: string, start: number, hdr?: string) => rangeGraph(range(source, start), 0, { width: 320, height: 240 }, stampColour(CONVERTED, BT709_TAGS), '25/1', { hdr });
  assert.doesNotMatch(graph('a', 0), /lut1d/);
  assert.ok(graph('b', 0, chain).includes(`setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop=5,${chain},scale=320:240`), 'converted, then scaled');
  for (const g of [graph('a', 0), graph('b', 0, chain), graph('a', 0.4)]) assert.match(g, /setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv\[v\]$/);
});

let n = 0;
async function assemble(sources: Record<string, string>, ids: string[], args: string[] = []): Promise<{ out: string; printed: string }> {
  const edl = join(dir, `edl-${n}.json`);
  const out = join(dir, `cut-${n++}.mp4`);
  // Ten frames a range at 25 fps, so frame k of the second range is frame 10 + k of the cut.
  writeFileSync(edl, JSON.stringify({ sources, ranges: ids.map((source) => ({ source, start: 0, end: 0.4 })) }));
  return { out, printed: (await captureConsoleAsync(() => applyEdl(['--edl', edl, '--out', out, ...args]))).out };
}

await test('apply-edl: HDR sources of another bit depth or size are each converted on their own range, before it is scaled', async () => {
  const chain = toSdr(colourTagsOf(hlg));
  // Encoded losslessly after an 8-bit 320x240 clip, each range is exactly its source converted first. Converted
  // after a join or a scale instead, the ramp is cut to 8 bits and the small clip scaled as HLG, and both move.
  const lanczos = 'scale=320:240:force_original_aspect_ratio=decrease:flags=lanczos';
  const y = (file: string, frame: number, vf?: string) => rawFrame(file, frame, vf).subarray(0, W * 240);
  for (const [name, first, after] of [['ramp10.mp4', chain, `format=yuv420p,${chain}`], ['small.mp4', `${chain},${lanczos}`, `${lanczos},${chain}`]]) {
    const source = join(dir, name);
    const right = y(source, 5, first);
    assert.ok(meanAbsDiff(right, y(source, 5, after)) > 0.15, `${name}: the two orders differ on this clip`);
    const got = y((await assemble({ a: 'hlg.mp4', b: name }, ['a', 'b'], ['--crf', '0'])).out, 15);
    const off = meanAbsDiff(got, right);
    assert.ok(off < 0.05, `${name}: ${off.toFixed(3)} levels from its source converted before the join`);
  }
});

await test('apply-edl: an HLG source comes out SDR, tagged bt709, as the reference converts it', async () => {
  const { out, printed } = await assemble({ a: 'hlg.mp4' }, ['a', 'a']);
  assert.deepEqual(probeStream(out, 'v:0', TAGS), BT709);
  assert.match(printed, /colour bt709\/bt709\/bt709\.\n {2}source "a" is HDR \(HLG, bt2020\/arib-std-b67\/bt2020nc\): converted to SDR BT\.709/);
  converted(hlg, 5, lumaOf(out, 5, 'video'), 'arib-std-b67', 'the cut');
  converted(hlg, 2, lumaOf(out, 12, 'video'), 'arib-std-b67', 'its second range');
});

await test('HDR coded with a matrix ffmpeg cannot decode is refused by name, and nothing says it was converted', async (t) => {
  const space = colourTagsOf(retag(pq, 'cl.mp4', { matrix: [10, 'bt2020c'] })).declared.space;
  if (space !== 'bt2020c') {
    t.skip(`this ffmpeg did not carry the bt2020c matrix into the fixture: ffprobe reads ${space}`);
    return;
  }
  let printed = '';
  await assert.rejects(async () => { printed = (await assemble({ a: 'cl.mp4' }, ['a'])).printed; },
    /source "a" is HDR coded with the bt2020c matrix, which ffmpeg cannot decode, so it cannot be converted to SDR/);
  assert.doesNotMatch(printed, /converted/);
  assert.throws(() => extractFrames(join(dir, 'cl.mp4'), { out: join(dir, 'cl-stills'), frame: ['1'] }), /cl\.mp4 is HDR coded with the bt2020c matrix/);
});

await test('apply-edl: an HDR10 source loses its metadata with its HDR, and a count of frames reads past side data', async () => {
  assert.deepEqual(hdr10Data(pq, 'stream'), ['Mastering display metadata', 'Content light level metadata'], 'the fixture carries HDR10 boxes');
  // ffprobe prints an empty field for the stream's side data after the count.
  assert.equal(countFrames(pq), 25);
  const { out, printed } = await assemble({ a: 'pq.mp4' }, ['a']);
  assert.deepEqual(probeStream(out, 'v:0', TAGS), BT709);
  assert.deepEqual([hdr10Data(out, 'stream'), hdr10Data(out, 'frame')], [[], []]);
  assert.match(printed, /source "a" is HDR \(PQ, bt2020\/smpte2084\/bt2020nc\)/);
  converted(pq, 5, lumaOf(out, 5, 'video'), 'smpte2084', 'the cut');
});

await test('apply-edl: an untagged SDR clip beside an HLG one is left as it was, and the HLG one is converted', async () => {
  const { out, printed } = await assemble({ a: 'untagged.mp4', b: 'hlg.mp4' }, ['a', 'b']);
  assert.deepEqual(probeStream(out, 'v:0', TAGS), BT709);
  assert.doesNotMatch(printed, /source "a" is HDR/);
  // Converting it too, or relabelling it in the join, moves it far more than one re-encode does (0.2).
  const kept = meanAbsDiff(rawFrame(out, 2), rawFrame(untagged, 2));
  assert.ok(kept < 0.6, `the untagged range moved ${kept.toFixed(2)} levels`);
  converted(hlg, 2, lumaOf(out, 12, 'video'), 'arib-std-b67', 'the HLG range', 2);
  assert.deepEqual(probeStream((await assemble({ a: 'hlg.mp4', b: 'pq.mp4' }, ['a', 'b'])).out, 'v:0', TAGS), BT709, 'HLG joins PQ');
});

await test('apply-edl and frames: HDR declared on the transfer alone is converted as BT.2020, and said to be', async () => {
  const { out, printed } = await assemble({ a: 'transfer-only.mp4' }, ['a']);
  assert.deepEqual(probeStream(out, 'v:0', TAGS), BT709);
  assert.match(printed, /colour bt709\/bt709\/bt709\.\n {2}source "a" is HDR \(HLG, bt2020 \(unset\)\/arib-std-b67\/bt2020nc \(unset\)\)/);
  assert.doesNotMatch(printed, /assumed/, 'a converted source is not one whose colour was assumed');
  converted(transferOnly, 5, lumaOf(out, 5, 'video'), 'arib-std-b67', 'the cut');
  const plan = extractFrames(transferOnly, { out: join(dir, 'transfer-only-stills'), frame: ['5'] });
  converted(transferOnly, 5, lumaOf(plan.stills[0].path, 0, 'still'), 'arib-std-b67', 'the still');
});

await test('apply-edl and frames: PQ in P3 primaries is converted from P3, not read as BT.2020', async () => {
  const { out, printed } = await assemble({ a: 'p3.mp4' }, ['a']);
  assert.deepEqual(probeStream(out, 'v:0', TAGS), BT709);
  assert.match(printed, /source "a" is HDR \(PQ, smpte432\/smpte2084\/bt2020nc\)/);
  assertConverted(p3, 5, lumaOf(out, 5, 'video'), { transfer: 'smpte2084', primaries: 'smpte432', width: W, tolerance: 1.5, what: 'the cut' });
  const plan = extractFrames(p3, { out: join(dir, 'p3-stills'), frame: ['5'] });
  assertConverted(p3, 5, lumaOf(plan.stills[0].path, 0, 'still'), { transfer: 'smpte2084', primaries: 'smpte432', width: W, tolerance: 1.5, what: 'the still' });
});

await test('frames: an HDR still is the converted picture, and says so', () => {
  for (const [clip, transfer, kind] of [[hlg, 'arib-std-b67', 'HLG'], [pq, 'smpte2084', 'PQ']] as const) {
    const plan = extractFrames(clip, { out: join(dir, `stills-${kind}`), frame: ['5'] });
    assert.match(plan.hdr ?? '', new RegExp(`is HDR \\(${kind}, `));
    converted(clip, 5, lumaOf(plan.stills[0].path, 0, 'still'), transfer, `the ${kind} still`);
  }
  assert.equal(extractFrames(sdr, { out: join(dir, 'sdr-stills'), frame: ['5'] }).hdr, undefined);
});

await test('concat-videos: an HDR clip is converted before it is fitted, and every clip is labelled BT.709 before the join', async () => {
  const stamp = stampColour(CONVERTED, BT709_TAGS);
  const graph = filterGraph({ width: 320, height: 240 }, 'letterbox', [{ hasAudio: true, duration: 1 }, { hasAudio: true, duration: 1 }],
    [null, toSdr(colourTagsOf(hlg))], [stamp, stamp]);
  assert.match(graph, /^\[0:v\]scale=320:240:/);
  assert.match(graph, /\[1:v\]scale=in_color_matrix=bt2020,format=gbrpf32le,lut1d=/);
  for (const i of [0, 1]) assert.match(graph, new RegExp(`fps=30,.*setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv\\[v${i}\\]`));
  // Untagged first, so the label would otherwise be the first clip's: none at all.
  const out = join(dir, 'joined.mp4');
  const printed = await captureConsoleAsync(() => concatVideos([untagged, hlg, pq], out));
  assert.match(printed.out, /hlg\.mp4 is HDR \(HLG/);
  assert.match(printed.out, /pq\.mp4 is HDR \(PQ/);
  assert.deepEqual(probeStream(out, 'v:0', TAGS), BT709);
  assert.deepEqual(hdr10Data(out, 'stream'), []);
  // 25 fps sources at 30 fps: the untagged clip's frame 0 is frame 0, the HLG clip's 30, the PQ clip's 60.
  assert.ok(meanAbsDiff(rawFrame(out, 0), rawFrame(untagged, 0)) < 0.6, 'the untagged clip is left as it was');
  converted(hlg, 0, lumaOf(out, 30, 'video'), 'arib-std-b67', 'the HLG clip', 2);
  converted(pq, 0, lumaOf(out, 60, 'video'), 'smpte2084', 'the PQ clip', 2);
  const sd = synthClip(dir, 'sd.mp4', { video: TESTSRC, audio: SINE, seconds: 1, vf: 'setparams=color_primaries=smpte170m:color_trc=smpte170m:colorspace=smpte170m' });
  // An SD clip first: the converted HDR clip joins under its colour, as any SD and HD clips do.
  const mixed = join(dir, 'mixed.mp4');
  await captureConsoleAsync(() => concatVideos([sd, hlg], mixed));
  assert.deepEqual(probeStream(mixed, 'v:0', TAGS), { color_primaries: 'smpte170m', color_transfer: 'smpte170m', color_space: 'smpte170m' });
});

await test('the conversion check has teeth: a frame left unconverted, or converted with any parameter moved, fails it', () => {
  assert.throws(() => converted(hlg, 5, lumaOf(hlg, 5, 'video'), 'arib-std-b67', 'unconverted'), /unconverted: .* from the conversion/);
  for (const neighbour of SDR_NEIGHBOURS) {
    const moved = expectedLuma(hlg, 5, 'arib-std-b67', neighbour);
    assert.throws(() => converted(hlg, 5, moved, 'arib-std-b67', 'neighbour'), /neighbour: /, JSON.stringify(neighbour));
  }
  const asBt2020 = expectedLuma(p3, 5, 'smpte2084', SDR_REFERENCE, 'bt2020');
  assert.throws(() => assertConverted(p3, 5, asBt2020, { transfer: 'smpte2084', primaries: 'smpte432', width: W, tolerance: 1.5, what: 'P3 read as BT.2020' }),
    /P3 read as BT\.2020: /);
});
