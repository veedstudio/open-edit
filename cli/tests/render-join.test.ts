// Segments made by the render's own encoder, laid over footage, joined and timed with the ffmpeg the CLI resolves:
// no Chrome, so it also runs on the ffmpeg the agent image ships (Debian bookworm's 5.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FFMPEG, FFPROBE } from '../src/config.ts';
import { concatList, joinSegments, startSegmentEncoder, timingProblems } from '../src/render/encode.ts';
import { overlayFor, probeFootage, seekArgs } from '../src/render/footage.ts';
import { parseFps, planSegments, type Fps } from '../src/render/timing.ts';
import { scratchDir } from './helpers/synth.ts';

const W = 64;
const H = 36;

/** A transparent page frame, as Chrome captures one over footage. */
const clear = execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=black@0:s=${W}x${H},format=rgba`, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-']);

/** Every frame's time, in decode order sorted to display order, in seconds. */
function frameTimes(file: string): number[] {
  const probed = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=time_base:packet=pts', '-of', 'json', file],
    { encoding: 'utf8' })) as { streams: { time_base: string }[]; packets: { pts: number }[] };
  const [n, d] = probed.streams[0].time_base.split('/').map(Number);
  return probed.packets.map((p) => (p.pts * n) / d).sort((a, b) => a - b);
}

/** Renders `segments` segments of `frames` frames each the way render --footage encodes them, and joins them. */
async function footageRender(name: string, fps: Fps, frames: number, segments: number): Promise<{ out: string; total: number }> {
  const dir = scratchDir(`render-join-${name}`);
  const total = frames * segments;
  const clip = join(dir, 'clip.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${fps.num}/${fps.den}`, '-frames:v', String(total + 5),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip]);
  const footage = probeFootage(clip);
  const parts: { file: string; frames: number }[] = [];
  for (const seg of planSegments(total, frames)) {
    const file = join(dir, `seg-${seg.index}.mp4`);
    const enc = startSegmentEncoder(file, fps, false, 'png', {
      file: clip, seek: seekArgs(seg.start, fps, footage.offset), overlay: overlayFor(footage, { width: W, height: H }, fps), frames: seg.frames,
    });
    for (let i = 0; i < seg.frames; i++) await enc.write(clear);
    await enc.finish();
    parts.push({ file, frames: seg.frames });
  }
  const out = join(dir, 'out.mp4');
  await joinSegments(parts, out, fps);
  return { out, total };
}

for (const rate of ['24000/1001', '30', '25']) {
  test(`render: segments laid over ${rate} fps footage join with every frame one frame after the last, and the timing check agrees`, async () => {
    const fps = parseFps(rate);
    const frames = Math.round((2 * fps.num) / fps.den);
    const { out, total } = await footageRender(rate.replace('/', '-'), fps, frames, 5);
    const times = frameTimes(out);
    assert.equal(times.length, total);
    const frame = fps.den / fps.num;
    // ffmpeg 7.1 writes such a segment a frame short, which repeated one timestamp at every join.
    const off = times.map((t, i) => ({ i, t })).filter(({ i, t }) => Math.abs(t - i * frame) > frame / 100);
    assert.deepEqual(off.slice(0, 3), [], `frames off their time: ${off.slice(0, 3).map(({ i, t }) => `frame ${i} at ${t.toFixed(4)} s`).join(', ')}`);
    const length = Number(execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }));
    assert.ok(Math.abs(length - total * frame) < frame / 2, `it lasts ${length} s, not ${total * frame} s`);
    assert.deepEqual(timingProblems(out, total, fps), []);
  });
}

test('render: the timing check names a join that starts a frame early, and a wrong count', async () => {
  const fps = parseFps('30');
  const { out } = await footageRender('early', fps, 30, 3);
  // The same segments joined as if each were a frame shorter: the next one starts a frame early, as ffmpeg 7.1's did.
  const dir = scratchDir('render-join-short');
  const list = join(dir, 'concat.txt');
  const segs = [0, 1, 2].map((k) => join(dirname(out), `seg-${k}.mp4`));
  writeFileSync(list, `ffconcat version 1.0\n${segs.map((f) => `file '${f}'\nduration 0.966667`).join('\n')}\n`);
  const early = join(dir, 'early.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', early]);
  const problems = timingProblems(early, 90, fps);
  assert.ok(problems.some((p) => /frame\(s\) are off the 30 fps grid, the first frame 30, due at 1\.000 s, 1\.00 frame\(s\) early/.test(p)), problems.join('; '));
  assert.ok(timingProblems(out, 91, fps).some((p) => /holds 90 frames, not 91/.test(p)));
});

test('render: the join list places each segment by its frames, rounded from the running time so no rounding adds up', () => {
  // A frame at 24000/1001 is 41708.33 us, which no whole number of microseconds holds.
  const list = concatList(Array.from({ length: 300 }, (_, k) => ({ file: `/c/seg-${k}.mp4`, frames: 1 })), parseFps('24000/1001'));
  const lengths = [...list.matchAll(/duration ([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 1e6));
  const sum = lengths.reduce((a, b) => a + b, 0);
  assert.equal(sum, Math.round((300 * 1001 * 1e6) / 24000), 'the segments end where 300 frames do, to the microsecond');
  assert.match(list, /^ffconcat version 1\.0\nfile 'seg-0\.mp4'\nduration 0\.041708\n/);
});
