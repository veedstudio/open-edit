// What apply-edl says about the cut it just made, against clips ffmpeg synthesises: a range whose picture runs on
// past its last sound, and a stretch held still with nothing heard. Measured on real encodes, since a model of the
// scan would pass whatever the decode does. The clips are lossless, so the grain that keeps a still from being
// frozen survives to the scan whatever the build's encoder makes of it.
//   Run:  node --import tsx tests/apply-edl-notes.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyEdl } from '../src/commands/apply-edl.ts';
import { FFMPEG } from '../src/config.ts';
import { changesIn, quietStillsOf, STILL_SECONDS } from '../src/stillness.ts';
import { captureConsoleAsync, scratchDir, withRoot } from './helpers/synth.ts';

const dir = scratchDir('edl-notes');
const MOVING = 'testsrc=size=320x240:rate=25';
const TONE = 'sine=frequency=440:sample_rate=48000';

/**
 * `seconds` of picture and half a second more of sound, so every join has sound to cross over. The picture is
 * `moving` seconds of testsrc and then its last frame held, grained by `grain` when given; the sound is the tone for
 * `heard` seconds and then silence.
 */
function clip(name: string, o: { seconds: number; moving: number; heard: number; grain?: number }): string {
  const path = join(dir, name);
  const hold = o.seconds - o.moving;
  const picture = [`trim=duration=${o.moving}`, ...(hold > 0 ? [`tpad=stop_mode=clone:stop_duration=${hold}`] : []),
    ...(o.grain ? [`noise=alls=${o.grain}:allf=t`] : [])].join(',');
  execFileSync(FFMPEG, ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', MOVING, '-f', 'lavfi', '-i', TONE,
    '-filter_complex', `[0:v]${picture}[v];[1:a]atrim=duration=${o.seconds + 0.5},volume=0:enable='gte(t,${o.heard})'[a]`,
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path]);
  return path;
}

clip('talk.mp4', { seconds: 8, moving: 3, heard: 3 });
clip('voiced-still.mp4', { seconds: 5, moving: 0.04, heard: 5.5 });
clip('card.mp4', { seconds: 5, moving: 0.04, heard: 0, grain: 4 });
clip('broll.mp4', { seconds: 4, moving: 4, heard: 0 });
clip('short-tail.mp4', { seconds: 3, moving: 3, heard: 2.5 });

let n = 0;
const cut = async (ranges: { source: string; start: number; end: number; speed?: number }[]) => {
  const edl = join(dir, `edl-${n}.json`);
  const sources = Object.fromEntries(ranges.map((r) => [r.source, `${r.source}.mp4`]));
  writeFileSync(edl, JSON.stringify({ sources, ranges }));
  const out = join(dir, `cut-${n++}.mp4`);
  const { out: log } = await withRoot(dir, () => captureConsoleAsync(() => applyEdl(['--edl', edl, '--out', out, '--crf', '0'])));
  return { out, log };
};

/** The seconds a line about range `i` reports after `what`, or null when there is no such line. */
const figure = (log: string, i: number, what: RegExp): number | null => {
  const line = log.split('\n').find((l) => l.includes(`range ${i} of `) && what.test(l));
  return line ? Number(new RegExp(`${what.source}\\s*(?:for )?([\\d.]+)s`).exec(line)?.[1]) : null;
};
const near = (value: number | null, expected: number, slack: number, what: string) =>
  assert.ok(value !== null && Math.abs(value - expected) <= slack, `${what}: got ${value}, expected ${expected} within ${slack}`);

await test('a range that runs past its last sound says by how much and where in its source the sound ends', async () => {
  const { log } = await cut([{ source: 'talk', start: 0, end: 8 }, { source: 'short-tail', start: 0, end: 3 }]);
  near(figure(log, 0, /the picture runs/), 5, 0.15, 'the silent run after the tone');
  assert.match(log, /range 0 of "talk": the picture runs [\d.]+s past its last sound, which ends at 3\.\d\ds of the source/);
  // Half a second of picture after the tone is within a beat, so nothing is said of it.
  assert.equal(figure(log, 1, /the picture runs/), null, log);
});

await test('a frozen stretch with nothing heard is named, and a still with sound under it is not', async () => {
  const { log } = await cut([{ source: 'talk', start: 0, end: 8 }, { source: 'voiced-still', start: 0, end: 5 }]);
  near(figure(log, 0, /frozen with nothing heard/), 5, 0.25, 'the frozen, silent hold');
  assert.match(log, /range 0 of "talk": frozen with nothing heard for [\d.]+s, 3\.\d\d-8\.00s of the source/);
  assert.doesNotMatch(log, /range 1 of/, 'a held picture with sound under it is carried by the sound');
});

await test('a grained still is nearly still rather than frozen, and moving footage with no sound is only silent', async () => {
  const { log } = await cut([{ source: 'card', start: 0, end: 5 }, { source: 'broll', start: 0, end: 4 }]);
  near(figure(log, 0, /nearly still with nothing heard/), 5, 0.25, 'the grained card');
  assert.doesNotMatch(log, /range 0 of "card": frozen/);
  assert.match(log, /range 0 of "card": nothing in its 5\.00s is heard above the rest of the cut/);
  assert.match(log, /range 1 of "broll": nothing in its 4\.00s is heard above the rest of the cut/);
  assert.doesNotMatch(log, /range 1 of "broll": (nearly still|frozen)/);
});

await test('at another speed the source times are the range\'s own', async () => {
  // At half speed the tone's 3 s play for 6 and the 5 s hold for 10; the line still names 3 s of the source.
  const { log } = await cut([{ source: 'talk', start: 0, end: 8, speed: 0.5 }]);
  near(figure(log, 0, /the picture runs/), 10, 0.3, 'the slowed silent run');
  assert.match(log, /which ends at 3\.\d\ds of the source/);
});

await test('a hold shorter than the still bar is not reported, even with nothing heard', async () => {
  const changes = await changesIn(clip('blink.mp4', { seconds: 4, moving: 2, heard: 0 }));
  // Two seconds held is under STILL_SECONDS, so even with nothing heard it is not a still to report.
  assert.ok(STILL_SECONDS > 2);
  assert.deepEqual(quietStillsOf(changes, 0, 4, () => true), []);
});

test('a cut that misses the length in the piece\'s brief says so as it is made, and one within it says nothing', async () => {
  const brief = join(dir, 'brief.json');
  writeFileSync(brief, JSON.stringify({ length: 5 }));
  try {
    const short = await cut([{ source: 'broll', start: 0, end: 2 }]);
    assert.match(short.log, /^ {2}length: the cut is 2\.00s, 3\.00s shorter than the 5\.00s asked for \(.*brief\.json\), more than the 1\.00s allowed$/m);
    writeFileSync(brief, JSON.stringify({ length: 2.5 }));
    const close = await cut([{ source: 'broll', start: 0, end: 2 }]);
    assert.doesNotMatch(close.log, /length:/);
  } finally {
    rmSync(brief, { force: true });
  }
});
