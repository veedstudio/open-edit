// The cut-out of the speaker the CLI makes for a page that lays a graphic behind the speaker and has none. The model
// is a stand-in everywhere: a function in this process, a fake fal over HTTP for the key route, and a `fal` command
// on PATH for the command route, each answering with the white column of the stretch it was sent, in blue, so a
// frame shows whether the cut-out is the clip's. Two tests start the renderer's Chrome, for what only a page can
// show, and fail rather than skip under OPENEDIT_REQUIRE_BROWSER.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BAR, behind, checkBehind } from '../src/commands/behind.ts';
import { FFMPEG, FFPROBE } from '../src/config.ts';
import { clipFolder, facesFolder } from '../src/faces/folder.ts';
import type { FacesClip } from '../src/faces/page-script.ts';
import type { Http } from '../src/providers/fal.ts';
import type { Ran, Runner } from '../src/providers/fal-command.ts';
import type { FalRoute } from '../src/providers/fal-route.ts';
import { chromePlatform, installedChrome, resolveChrome } from '../src/render/browser.ts';
import { countFrames } from '../src/render/encode.ts';
import { probeFootage, type Footage } from '../src/render/footage.ts';
import { BUDGET_MS, EPOCH, openLead, SEED, type SessionBase } from '../src/render/lead.ts';
import { alphaInputOf, mediaCache } from '../src/render/media.ts';
import type { ReadyInfo } from '../src/render/page-runtime.ts';
import { startPageServer, type PageServer } from '../src/render/server.ts';
import { newTimings } from '../src/render/session.ts';
import {
  askedBy, clipFrameAt, covering, CUTOUT_ENV, CutoutFailed, cutoutFor, cutoutSwitchedOn, drawnWith, estimateOf, grown, matrixOf, matteShare, merged,
  MOST_ANSWER_BYTES, MOST_SECONDS, MOST_STRETCHES, notCutoutOf, overCap, padded, pageCutout, runModel, runsOf, shownFor, unevenlyTimed, withFaces, without,
  type Answer, type CutoutDeps, type Made, type ModelRun, type PageCutout, type Run, type Sent,
} from '../src/render/speaker-cutout.ts';
import type { Fps } from '../src/render/timing.ts';
import { rotatedCopy, scratchDir } from './helpers/synth.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
// A run stopped by a signal still leaves through `exit`, where every scratch folder of this file is removed.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => process.exit(1));
// One workspace for this file: the clips' folders, the job ledgers and the media cache of every test are its own.
process.env.OPEN_EDIT_ROOT = scratchDir('cutout-workspace');
delete process.env[CUTOUT_ENV];
const W = 320;
const H = 180;
const MODEL = 'veed/video-background-removal/fast';
const ON = { [CUTOUT_ENV]: '1' };
const ten: Fps = { num: 10, den: 1 };
const keyed = (): FalRoute => ({ how: 'key', key: 'k'.repeat(24) });

const encoded = new Map<string, Buffer>();
/**
 * A clip at 10 fps whose speaker is a white column 20 px wide at x 5n on frame n, on grey; `tone` changes its bytes
 * and nothing shown. Each kind is encoded once for the file and written out wherever a test wants it.
 */
function clip(dir: string, o: { frames?: number; name?: string; tone?: number; rate?: number } = {}): string {
  const file = join(dir, o.name ?? 'clip.mp4');
  const [n, rate, tone] = [o.frames ?? 40, o.rate ?? 10, o.tone ?? 0];
  const kind = `${n}-${rate}-${tone}`;
  if (!encoded.has(kind)) {
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      `color=c=gray:s=${W}x${H}:r=${rate}:d=${n / rate},format=yuv420p,geq=lum='if(between(X\\,5*N\\,5*N+19)\\,235\\,128)':cb=128:cr=128`,
      '-frames:v', String(n), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', `comment=${tone}`, file]);
    encoded.set(kind, readFileSync(file));
  } else writeFileSync(file, encoded.get(kind)!);
  return file;
}

/** What the model would answer for a stretch: its white column, in blue, the rest transparent; `then` filters or cuts it further. */
function cutOut(sent: string, out: string, then: string[] = []): string {
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', sent, '-filter_complex', "[0:v]format=yuva420p,geq=lum=41:cb=240:cr=110:a='255*gt(lum(X,Y),200)'[v]",
    '-map', '[v]', ...then, '-c:v', 'libvpx-vp9', '-lossless', '1', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-an', out]);
  return out;
}

/** The model as a function: each call's stretches and whether the line that says a fal account is about to be charged was printed by then. */
interface Call { runs: Run[]; route: FalRoute; runDir: string; announced: boolean }
function standIn(lines: string[] = [], answer: (s: Sent, o: ModelRun) => Answer = (s, o) => {
  mkdirSync(join(o.dir, s.name), { recursive: true });
  return { file: cutOut(s.file, join(o.dir, s.name, 'output.webm')), requestId: `req-${s.from}` };
}): { model: NonNullable<CutoutDeps['model']>; calls: Call[] } {
  const calls: Call[] = [];
  const model: NonNullable<CutoutDeps['model']> = async (sent, o, take) => {
    calls.push({ runs: sent.map(({ from, to }) => ({ from, to })), route: o.route, runDir: o.runDir, announced: lines.some((line) => /making a cut-out of the speaker/.test(line)) });
    sent.forEach((s, i) => take(i, answer(s, o)));
  };
  return { model, calls };
}

const keptIn = (file: string) => {
  try {
    return readdirSync(clipFolder(file, 'cutout')).filter((name) => /^stretch-.*\.webm$/.test(name)).sort();
  } catch {
    return [];
  }
};
const keptFiles = (file: string) => keptIn(file).map((name) => name.replace(/^stretch-[0-9a-f]{16}-/, 'stretch-')).sort();
const keptPath = (file: string, from: number, to: number) => join(clipFolder(file, 'cutout'), keptIn(file).find((name) => name.endsWith(`-${from}-${to}.webm`))!);
/** Where the speaker's column starts on the middle row of frame `n` of a file with alpha: 5 times the clip's frame it was cut from. */
function columnAt(file: string, n: number): number {
  const alpha = execFileSync(FFMPEG, ['-v', 'error', '-c:v', 'libvpx-vp9', '-i', file, '-vf', `select=eq(n\\,${n}),alphaextract,format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  return alpha.subarray((H / 2) * W, (H / 2 + 1) * W).findIndex((a) => a > 128);
}
/** Frames 7 to 22 of a clip as the model is sent them, for an answer made by hand. */
function stretchOf(file: string, out: string): string {
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', file, '-vf', 'trim=start_frame=7:end_frame=23,setpts=PTS-STARTPTS', '-r', '10', '-fps_mode', 'cfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}

// --- the arithmetic --------------------------------------------------------------------------------------------

test('cut-out: the switch is on only where the environment says so, and a value that says neither is refused', () => {
  for (const off of [undefined, '', ' ', '0', 'off', 'false', 'No']) assert.equal(cutoutSwitchedOn({ [CUTOUT_ENV]: off }), false, `${off}`);
  for (const on of ['1', 'true', 'ON', ' yes ']) assert.equal(cutoutSwitchedOn({ [CUTOUT_ENV]: on }), true, on);
  assert.throws(() => cutoutSwitchedOn({ [CUTOUT_ENV]: 'veed/some-model' }), /OPEN_EDIT_SPEAKER_CUTOUT is "veed\/some-model", which switches the automatic cut-out neither on \(1\) nor off \(0\)/);
});

test('cut-out: it is drawn for the clip\'s frames under the page frames a graphic is on, and bought a quarter second wider, joined where that touches', () => {
  assert.deepEqual(runsOf([1, 2, 4]), [{ from: 1, to: 3 }, { from: 4, to: 5 }]);
  assert.deepEqual(merged([{ from: 8, to: 12 }, { from: 0, to: 3 }, { from: 3, to: 5 }, { from: 11, to: 14 }, { from: 20, to: 20 }]), [{ from: 0, to: 5 }, { from: 8, to: 14 }]);
  const eight = { fps: ten, frames: 80 };
  // Two graphics, on at 1.0-2.0 s and 6.0-7.0 s of a page at the clip's own rate: those frames of the clip, and no other.
  const shown = shownFor([{ from: 10, to: 20 }, { from: 60, to: 70 }], ten, 0, eight);
  assert.deepEqual(shown, [{ from: 10, to: 20 }, { from: 60, to: 70 }]);
  assert.deepEqual(padded(shown, eight), [{ from: 7, to: 23 }, { from: 57, to: 73 }]);
  // Two graphics 0.4 s apart: their pads meet, so they are one stretch and one request.
  assert.deepEqual(padded([{ from: 10, to: 20 }, { from: 24, to: 30 }], eight), [{ from: 7, to: 33 }]);
  // The pad stops at the clip's first frame and at the last frame the piece draws.
  assert.deepEqual(padded([{ from: 0, to: 5 }, { from: 75, to: 80 }], eight), [{ from: 0, to: 8 }, { from: 72, to: 80 }]);
  assert.deepEqual(padded([{ from: 10, to: 20 }], { fps: ten, frames: 21 }), [{ from: 7, to: 21 }]);
  assert.deepEqual(padded(shown, eight, 0), shown);
  // Footage laid from page frame 30 (render --footage-at 3): page seconds 4-5 are the clip's 1-2.
  assert.deepEqual(shownFor([{ from: 40, to: 50 }], ten, 30, eight), [{ from: 10, to: 20 }]);
  assert.equal(clipFrameAt(30, ten, 30, eight), 0);
  // A page stepped at 30 fps over a clip at 24: each page frame's own clip frame, as the layer finds it.
  const film = { fps: { num: 24, den: 1 }, frames: 240 };
  assert.deepEqual([30, 31, 32, 59].map((i) => clipFrameAt(i, { num: 30, den: 1 }, 0, film)), [24, 24, 25, 47]);
  assert.deepEqual(shownFor([{ from: 30, to: 60 }], { num: 30, den: 1 }, 0, film), [{ from: 24, to: 48 }]);
  // A page stepped at 5 fps over a clip at 10 draws every other frame of it: the frames between are the stretch's too.
  assert.deepEqual(shownFor([{ from: 5, to: 8 }], { num: 5, den: 1 }, 0, eight), [{ from: 10, to: 15 }]);
  // A page frame past the clip's last shows its last, and no frame past it is asked for.
  assert.deepEqual(shownFor([{ from: 78, to: 85 }], ten, 0, eight), [{ from: 78, to: 80 }]);
});

test('cut-out: only the frames nothing kept holds are bought, a short remainder is grown, a run is laid from the stretches that hold it, and the caps name themselves', () => {
  const kept = [{ from: 7, to: 23, file: 'a' }, { from: 23, to: 40, file: 'b' }, { from: 30, to: 60, file: 'c' }];
  assert.deepEqual(without([{ from: 7, to: 23 }], kept), []);
  assert.deepEqual(without([{ from: 0, to: 30 }, { from: 55, to: 70 }], kept), [{ from: 0, to: 7 }, { from: 60, to: 70 }]);
  assert.deepEqual(without([{ from: 5, to: 9 }], []), [{ from: 5, to: 9 }]);
  // Shorter than a second: grown about its middle, kept inside the clip, and joined with a neighbour it then reaches.
  assert.deepEqual(grown([{ from: 20, to: 24 }], 10, 80), [{ from: 17, to: 27 }]);
  assert.deepEqual(grown([{ from: 0, to: 4 }, { from: 78, to: 80 }], 10, 80), [{ from: 0, to: 10 }, { from: 70, to: 80 }]);
  assert.deepEqual(grown([{ from: 20, to: 24 }, { from: 28, to: 31 }], 10, 80), [{ from: 17, to: 35 }]);
  assert.deepEqual(grown([{ from: 10, to: 30 }], 10, 80), [{ from: 10, to: 30 }]);
  assert.deepEqual(grown([{ from: 2, to: 4 }], 10, 6), [{ from: 0, to: 6 }], 'a clip shorter than a second is sent whole');
  assert.deepEqual(covering([{ from: 10, to: 50 }], kept), [
    { from: 10, to: 23, file: 'a', keptFrom: 7 }, { from: 23, to: 40, file: 'b', keptFrom: 23 }, { from: 40, to: 50, file: 'c', keptFrom: 30 },
  ]);
  assert.equal(covering([{ from: 10, to: 61 }], kept), null, 'one frame in none of them');
  // 1.5 units to each 30 frames, a request's total rounded up: 72 frames are 3.6, so 4; two stretches round up each.
  assert.deepEqual(estimateOf([72]), { units: 4, usd: 0.032 });
  assert.deepEqual(estimateOf([20, 20]), { units: 2, usd: 0.016 });
  assert.deepEqual(estimateOf([40]), { units: 2, usd: 0.016 });
  // One render buys at most 12 stretches and 60 s, and a cut-out is made for at most 60 s of a piece.
  const many = Array.from({ length: MOST_STRETCHES + 1 }, (_, k) => ({ from: 40 * k, to: 40 * k + 10 }));
  assert.equal(overCap(many.slice(0, MOST_STRETCHES), ten, true), null);
  assert.equal(overCap(many, ten, true), 'the cut-out would be bought in 13 stretches, and at most 12 are bought for one render');
  assert.equal(overCap(many, ten, false), null, 'how many times a graphic comes and goes is no limit on what is drawn');
  assert.equal(overCap([{ from: 0, to: 10 * MOST_SECONDS }], ten, true), null);
  assert.equal(overCap([{ from: 0, to: 10 * MOST_SECONDS + 1 }], ten, true), 'the cut-out would be bought for 60.1 s of the clip, and at most 60 s are bought for one render');
  assert.equal(overCap([{ from: 0, to: 10 * MOST_SECONDS + 1 }], ten, false), 'graphics are behind the speaker for 60.1 s of the clip, and a cut-out is made for at most 60 s of a piece');
});

test('cut-out: a stretch with no face in it is left out where faces has run on the clip, and a clip whose frames are unevenly timed is refused', () => {
  const samples = Array.from({ length: 32 }, (_, k) => ({ sec: 0.125 + 0.25 * k, faces: 0.125 + 0.25 * k >= 4 ? [{ x: 10, y: 10, w: 40, h: 40 }] : [] }));
  const faces = { every: 0.25, shots: [{ start: 0, end: 8, samples }] } as unknown as FacesClip;
  const footage = { fps: ten, frames: 80 } as Footage;
  const [early, late] = [{ from: 10, to: 20 }, { from: 60, to: 70 }];
  assert.deepEqual(withFaces([early, late], footage, faces), { kept: [late], empty: [early] });
  assert.deepEqual(withFaces([early, late], footage, null), { kept: [early, late], empty: [] }, 'with no faces found for the clip, every stretch stands');
  assert.deepEqual(withFaces([{ from: 39, to: 41 }], footage, faces), { kept: [{ from: 39, to: 41 }], empty: [] }, 'a face on one of its samples is a face in it');
  assert.deepEqual(withFaces([early], footage, { every: 0.25, shots: [] } as unknown as FacesClip), { kept: [early], empty: [] }, 'no sample there says nothing');
  // 225 frames that last 6 s are not at the 60 fps the file names: their times cannot be told from the rate.
  const phone = { file: '/clips/phone.mp4', fps: { num: 60, den: 1 }, frames: 225 };
  assert.match(unevenlyTimed(phone, 6) ?? '', /^phone\.mp4 holds 225 frames in 6\.000 s, which is not its 60 fps: its frames are unevenly timed, and a cut-out is laid on evenly timed frames\./);
  assert.equal(unevenlyTimed(phone, 3.75), null);
  assert.equal(unevenlyTimed(phone, 3.77), null, 'a container\'s own rounding is not an uneven rate');
});

test('cut-out: a page asks with a footage layer, a behind layer holding a data-behind graphic, no cut-out that is there, and a clip it may read', async () => {
  const dir = realpathSync(scratchDir('cutout-asks'));
  const [inside, outside] = [join(dir, 'page'), join(dir, 'elsewhere')];
  for (const d of [inside, outside, join(inside, '.hidden')]) mkdirSync(d);
  const [footage, other, named, secret, dotted] = [join(inside, 'clip.mp4'), join(inside, 'other.mp4'), join(inside, 'cutout.webm'), join(outside, 'secret.mp4'), join(inside, '.hidden', 'clip.mp4')];
  for (const file of [footage, other, secret, dotted]) writeFileSync(file, 'a clip');
  // The page's own server, with its own rules for what a page may read.
  const server = await startPageServer({ roots: [inside] });
  try {
    const url = (file: string) => server.urlFor(file);
    const info = (o: Partial<Pick<ReadyInfo, 'cutout' | 'behind'>>): ReadyInfo => ({ cutout: null, behind: { footage: [[url(footage)]], loops: false, graphics: 1 }, ...o } as ReadyInfo);
    const layer = (footages: string[][], graphics = 1) => info({ behind: { footage: footages, loops: false, graphics } });
    assert.deepEqual(await askedBy(info({}), server, null), { clip: footage });
    // A cut-out the stage names and that is not there asks as naming none does; one that is there, or on another server, does not.
    assert.deepEqual(await askedBy(info({ cutout: { url: url(named), playable: false } }), server, null), { clip: footage });
    writeFileSync(named, 'a file');
    assert.equal(await askedBy(info({ cutout: { url: url(named), playable: true } }), server, null), null);
    assert.equal(await askedBy(info({ cutout: { url: 'https://elsewhere.example/cutout.webm', playable: true } }), server, null), null);
    // Without both layers, or with no graphic marked data-behind in the behind layer, nothing is asked for.
    assert.equal(await askedBy(info({ behind: null }), server, null), null);
    assert.equal(await askedBy(layer([[url(footage)]], 0), server, null), null);
    // The clip is render's --footage when there is one, else the one video the footage layer plays.
    assert.deepEqual(await askedBy(layer([], 2), server, other), { clip: other });
    assert.deepEqual(await askedBy(layer([[url(join(inside, 'gone.mp4')), url(footage)]]), server, null), { clip: footage }, 'the source that is a file');
    assert.deepEqual(await askedBy(layer([[url(footage)], [url(footage)]]), server, null), { clip: footage }, 'two videos of one file');
    assert.deepEqual(await askedBy(layer([]), server, null), { why: 'its footage layer plays no video to cut the speaker from' });
    assert.deepEqual(await askedBy(layer([[url(footage)], [url(other)]]), server, null), { why: 'its footage layer plays 2 videos, and the speaker is cut from one clip' });
    assert.deepEqual(await askedBy(layer([['https://elsewhere.example/clip.mp4']]), server, null), { why: 'its footage layer\'s video is not a file on this machine' });
    // A file the page's server would refuse the page is not cut, sent to the model and drawn back to it.
    assert.deepEqual(await askedBy(layer([[url(secret)]]), server, null), { why: `its footage layer's video ${secret} is one the page may not read (outside the served roots)` });
    assert.deepEqual(await askedBy(layer([[url(dotted)]]), server, null), { why: `its footage layer's video ${dotted} is one the page may not read (hidden (dot) path refused)` });
    // The clip render --footage names is the user's own word, wherever it lies.
    assert.deepEqual(await askedBy(layer([[url(secret)]]), server, secret), { clip: secret });
  } finally {
    await server.close();
  }
});

test('cut-out: a page that asks gets none, and one line, with the switch off, no clip, footage that loops past its end or frames unevenly timed; nothing is opened or spent', async () => {
  const dir = scratchDir('cutout-page');
  const footage = clip(dir);
  const url = (file: string) => `http://page/${file}`;
  const server = { fileFor: (u: string) => (u.startsWith('http://page/') ? u.slice('http://page/'.length) : null), refusalOf: async () => null } as unknown as PageServer;
  const asks = { cutout: null, behind: { footage: [[url(footage)]], loops: false, graphics: 1 } } as ReadyInfo;
  let routed = 0;
  // No session to step the page in is given: one opened to find the stretches would throw here.
  const ask = (info: ReadyInfo, env: NodeJS.ProcessEnv, more: Partial<PageCutout> = {}) => pageCutout({
    page: join(dir, 'index.html'), info, server, base: undefined as never, canvas: undefined as never, footage: null, footageAt: 0, say: () => {},
    deps: { env, route: () => { routed++; return keyed(); } }, ...more,
  });
  for (const env of [{}, { [CUTOUT_ENV]: '0' }]) {
    const off = await ask(asks, env);
    assert.ok(off && 'none' in off);
    assert.match(off.none, /^the environment does not have the automatic cut-out switched on; npx @veedstudio\/openedit-cli background-removal \S*clip\.mp4'? makes one to name on the stage \(data-cutout="<file>"\)$/);
  }
  // A page that asks for nothing is passed over whatever the switch says: a cut-out it names, or nothing behind the speaker.
  writeFileSync(join(dir, 'cutout.webm'), 'a file');
  assert.equal(await ask({ ...asks, cutout: { url: url(join(dir, 'cutout.webm')), playable: true } } as ReadyInfo, ON), null);
  assert.equal(await ask({ ...asks, behind: null } as ReadyInfo, ON), null);
  // With the switch on and no clip to cut from, the reason is the page's.
  assert.deepEqual(await ask({ ...asks, behind: { footage: [], loops: false, graphics: 1 } } as ReadyInfo, ON), { none: 'its footage layer plays no video to cut the speaker from' });
  // Footage that loops plays on past the clip's 4 s, where a cut-out has nothing to show.
  const looping = { ...asks, behind: { ...asks.behind!, loops: true } } as ReadyInfo;
  assert.deepEqual(await ask(looping, ON, { until: 6 }), { none: 'its footage loops past the clip\'s end, and a cut-out runs once from the clip\'s first frame' });
  // A clip whose frames are not where its rate puts them: 40 frames at a nominal 10 fps with two seconds missing in the middle.
  const uneven = join(dir, 'uneven.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', footage, '-vf', "setpts='N/10/TB+gte(N\\,20)*2/TB'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', uneven]);
  const none = await ask({ ...asks, behind: { footage: [[url(uneven)]], loops: false, graphics: 1 } } as ReadyInfo, ON);
  assert.ok(none && 'none' in none);
  assert.match(none.none, /^uneven\.mp4 holds 40 frames in [56]\.\d+ s, which is not its 10 fps: its frames are unevenly timed/);
  assert.equal(routed, 0, 'no fal is looked for');
  await assert.rejects(ask(asks, { [CUTOUT_ENV]: 'maybe' }), /switches the automatic cut-out neither on \(1\) nor off \(0\)/);
});

// --- kept, bought and laid -------------------------------------------------------------------------------------

test('cut-out: it is said before the model is called, on which fal and at what estimate; the stretch is bought with its pad, kept, and laid in the clip\'s matrix', async () => {
  const dir = scratchDir('cutout-made');
  const file = clip(dir);
  const footage = probeFootage(file);
  const lines: string[] = [];
  const fal = standIn(lines);
  const got = await cutoutFor(footage, [{ from: 10, to: 20 }], (line) => lines.push(line), { route: keyed, model: fal.model });
  assert.ok('laid' in got, JSON.stringify(got));
  assert.deepEqual(fal.calls, [{ runs: [{ from: 7, to: 23 }], route: keyed(), runDir: join(process.env.OPEN_EDIT_ROOT!, 'runs', 'clip'), announced: true }]);
  assert.match(lines[0], /^making a cut-out of the speaker for 1\.6 s of clip\.mp4 \(16 frames in 1 stretch: 0\.700-2\.300 s\) with veed\/video-background-removal\/fast, on the fal account of the fal key this run reads, never on a VEED workspace\. An estimate, not a charge: about \$0\.0080 \(1 unit\(s\) at fal's listed \$0\.008 per 30 frames, 1\.5 unit\(s\) per 30 frames with edge refinement on, each stretch rounded up\)\. Each answer is waited for up to 15 minutes$/);
  // Kept under a name of its own: for the clip's bytes and how the cut-out is made, and the clip's frames it holds.
  assert.match(lines[1], /^the cut-out of 0\.700-2\.300 s came back in \d+ s \(request req-7\) with the 16 frame\(s\) sent; kept at .*cutout-[0-9a-f]{8}[\\/]stretch-[0-9a-f]{16}-7-23\.webm$/);
  assert.deepEqual(keptFiles(file), ['stretch-7-23.webm']);
  // Laid in the media cache, under its rules: the kept stretch whole, and where its frames sit in the file.
  assert.ok(got.laid.file.startsWith(mediaCache()), got.laid.file);
  assert.deepEqual(got.laid.stretches, [{ from: 7, to: 23, at: 0 }]);
  assert.equal(countFrames(got.laid.file), 16);
  assert.ok(alphaInputOf(got.laid.file), 'the laid file keeps the alpha');
  // A clip of this size is drawn by BT.601, which the laid file names, so Chrome draws the speaker in the footage's colours.
  assert.equal(execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_space', '-of', 'csv=p=0', got.laid.file], { encoding: 'utf8' }).trim(), 'smpte170m');
  assert.deepEqual([matrixOf({ matrix: 'bt709', colour: { declared: {} } as Footage['colour'] }), matrixOf({ matrix: 'auto', colour: { declared: { space: 'bt470bg' } } as Footage['colour'] }),
    matrixOf({ matrix: 'auto', colour: { declared: { space: 'bt2020nc' } } as Footage['colour'] })], ['bt709', 'bt470bg', undefined]);
  // The stretch as sent and the answer's own folder are gone once the answer is kept.
  assert.deepEqual(readdirSync(join(clipFolder(file, 'cutout'), 'sent')), []);
  assert.deepEqual(readdirSync(join(clipFolder(file, 'cutout'), 'answers')), []);

  // Through the environment's own command, the line says so, before the command is asked for anything.
  const said: string[] = [];
  await cutoutFor(footage, [{ from: 30, to: 40 }], (line) => said.push(line),
    { route: () => ({ how: 'command', fal: '/bin/fal' }), model: async () => { assert.equal(said.length, 1); throw new CutoutFailed('stopped here'); } });
  assert.match(said[0], /\(13 frames in 1 stretch: 2\.700-4\.000 s\) with veed\/video-background-removal\/fast, through the fal command the environment gives in place of a key, which prices and approves it and bills as that environment arranges\. An estimate, not a charge/);
  assert.doesNotMatch(said[0], /VEED workspace/);
});

test('cut-out: frames inside what is kept buy nothing whatever its pad, one more stretch buys only that stretch, nothing is bought past the piece\'s end, and a changed clip is cut out again', async () => {
  const dir = scratchDir('cutout-kept');
  const file = clip(dir, { frames: 80 });
  let footage = probeFootage(file);
  const lines: string[] = [];
  const fal = standIn(lines);
  const run = (shown: Run[], within?: number) => cutoutFor(footage, shown, (line) => lines.push(line), { route: keyed, model: fal.model }, within);
  const first = await run([{ from: 10, to: 20 }]);
  assert.equal(fal.calls.length, 1);
  lines.length = 0;
  const second = await run([{ from: 10, to: 20 }]);
  assert.equal(fal.calls.length, 1, 'nothing is bought for frames that are kept');
  assert.deepEqual(lines.map((line) => line.replace(/ in \S+, so/, ' in <folder>, so')), ['the cut-out of the speaker for 1.0 s of clip.mp4 (1.000-2.000 s) is kept in <folder>, so none is made']);
  assert.deepEqual(second, first, 'and the same laid file is drawn');
  // The graphic moved three frames, and blinks once more: its frames are inside the stretch bought with its pad.
  const nudged = await run([{ from: 7, to: 19 }, { from: 21, to: 23 }]);
  assert.equal(fal.calls.length, 1);
  assert.ok('laid' in nudged && 'laid' in first);
  assert.deepEqual([nudged.laid.file, nudged.laid.stretches], [first.laid.file, first.laid.stretches], 'the same file, drawn in other frames');
  // One more graphic later in the clip: its stretch alone is sent, and the file is laid from both.
  const more = await run([{ from: 10, to: 20 }, { from: 52, to: 60 }]);
  assert.deepEqual(fal.calls.at(-1)!.runs, [{ from: 49, to: 63 }]);
  assert.ok('laid' in more);
  assert.deepEqual(more.laid.stretches, [{ from: 7, to: 23, at: 0 }, { from: 49, to: 63, at: 16 }]);
  assert.equal(countFrames(more.laid.file), 30);
  // Each frame of the laid file is the clip's frame the list says: the speaker's column is at 5 times that frame.
  for (const [n, frame] of [[0, 7], [15, 22], [16, 49], [29, 62]]) assert.ok(Math.abs(columnAt(more.laid.file, n) - 5 * frame) <= 1, `laid frame ${n} is the clip's ${frame}: ${columnAt(more.laid.file, n)}`);
  // The first graphic held to frame 26: the remainder alone is bought, padded and grown to a second.
  await run([{ from: 10, to: 26 }]);
  assert.deepEqual(fal.calls.at(-1)!.runs, [{ from: 20, to: 30 }]);
  // A graphic up to the piece's last frame, 72: nothing past that frame is bought, since none would be drawn.
  await run([{ from: 68, to: 72 }], 72);
  assert.deepEqual(fal.calls.at(-1)!.runs, [{ from: 62, to: 72 }]);
  assert.equal(fal.calls.length, 4);
  assert.deepEqual(keptFiles(file), ['stretch-20-30.webm', 'stretch-49-63.webm', 'stretch-62-72.webm', 'stretch-7-23.webm']);

  // The clip made again at the same path, size and length: what is kept is another picture's.
  clip(dir, { frames: 80, tone: 1 });
  footage = probeFootage(file);
  lines.length = 0;
  const again = await run([{ from: 10, to: 20 }]);
  assert.match(lines[0], /^4 stretch\(es\) of a cut-out kept in .* are not used \(not made for this clip as its bytes are now, or not as a cut-out is made now\)$/);
  assert.deepEqual(fal.calls.at(-1)!.runs, [{ from: 7, to: 23 }]);
  assert.equal(fal.calls.length, 5);
  assert.ok('laid' in again && 'laid' in first && again.laid.file !== first.laid.file, 'laid again from the new stretch');
});

test('cut-out: no fal, a refusal, a timeout and an answer that is not a cut-out each leave none and give the reason; a refused answer is not bought again, and each answer is kept as it comes', async () => {
  const dir = scratchDir('cutout-failed');
  const file = clip(dir, { frames: 80 });
  const footage = probeFootage(file);
  const folder = clipFolder(file, 'cutout');
  const lines: string[] = [];
  const none = async (deps: CutoutDeps, shown: Run[] = [{ from: 10, to: 20 }]) => {
    const got = await cutoutFor(footage, shown, (line) => lines.push(line), { route: keyed, ...deps });
    assert.ok('none' in got, 'no cut-out');
    return got.none;
  };
  let asked = 0;
  assert.equal(await none({ route: () => ({ how: 'none', why: 'no fal key is readable here, and the environment gives no fal command of its own' }), model: async () => { asked++; } }),
    'no fal key is readable here, and the environment gives no fal command of its own');
  assert.deepEqual([asked, lines], [0, []], 'with no fal to run on nothing is announced and nothing is sent');
  const answering = (answer: (s: Sent, o: ModelRun) => Answer) => standIn([], answer).model;
  assert.match(await none({ model: answering(() => ({ failed: 'the environment\'s fal command did not run it (exit 3): fal: refused: this generation was not approved' })) }),
    /^the model gave no cut-out for 1 of 1 stretch\(es\) after \d+ s \(0\.700-2\.300 s: the environment's fal command did not run it \(exit 3\): fal: refused: this generation was not approved\)$/);
  assert.match(await none({ model: answering(() => ({ failed: 'fal job req-9 did not finish within the deadline; it may still complete. Re-running the same command resumes request req-9; it does not buy it again.' })) }),
    /0\.700-2\.300 s: fal job req-9 did not finish within the deadline/);
  assert.match(await none({ model: async () => { throw new CutoutFailed('fal answered 401: the key was refused'); } }), /^the model gave no cut-out for 1 of 1 stretch\(es\) after \d+ s \(fal answered 401: the key was refused\)$/);
  assert.deepEqual([keptFiles(file), readdirSync(folder).filter((name) => name.startsWith('rejected-'))], [[], []], 'a failure keeps nothing and records nothing: the next run may ask again');
  // An error that is not the model failing is not swallowed into a fallback.
  await assert.rejects(cutoutFor(footage, [{ from: 10, to: 20 }], () => {}, { route: keyed, model: async () => { throw new TypeError('a bug of this run'); } }), /a bug of this run/);

  // An answer with no alpha would cover the graphics: it is bought, refused, and recorded, so no later run buys it again.
  let sent = 0;
  assert.match(await none({ model: answering((s) => { sent++; return { file: s.file, requestId: 'req-flat' }; }) }),
    /0\.700-2\.300 s: its answer is not used \(it has no alpha channel, so it does not say where the speaker is\), and the stretch is not bought again while the clip and the model are the same\)$/);
  const record = join(folder, readdirSync(folder).find((name) => /^rejected-[0-9a-f]{16}-7-23\.json$/.test(name))!);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(record, 'utf8'))), ['why', 'at', 'requestId']);
  assert.equal(await none({ model: answering((s) => { sent++; return { file: s.file }; }) }),
    `the model's answer for 0.700-2.300 s was refused before (it has no alpha channel, so it does not say where the speaker is), and the same stretch is not bought again while the clip and the model are the same: remove ${record} to send it again`);
  assert.equal(sent, 1, 'the stretch whose answer was refused is not sent a second time');
  rmSync(record);

  // What the check refuses: a frame missing, another size, a matte that covers nothing.
  mkdirSync(join(dir, 'answers'));
  const stretch: Sent = { from: 7, to: 23, name: 'x', file: stretchOf(file, join(dir, 'sent.mp4')) };
  const answer = (then: string[]) => cutOut(stretch.file, join(dir, 'answers', `${then.join('').replace(/\W+/g, '_')}.webm`), then);
  const size = { width: W, height: H };
  assert.equal(notCutoutOf(answer([]), stretch, size), null);
  assert.equal(notCutoutOf(answer(['-frames:v', '15']), stretch, size), 'it holds 15 frame(s), and the stretch sent 16, so its frames would not line up with the clip\'s');
  assert.equal(notCutoutOf(answer(['-s', '160x90']), stretch, size), 'it is 160x90, and the stretch sent 320x180');
  assert.match(notCutoutOf(join(dir, 'gone.webm'), stretch, size) ?? '', /^it could not be read as video/);
  const empty = join(dir, 'answers', 'empty.webm');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black@0:s=${W}x${H}:r=10:d=1.6,format=yuva420p`, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', empty]);
  assert.equal(notCutoutOf(empty, stretch, size), 'its matte covers 0.00% of the frame, so it holds nobody to stand in front of a graphic');
  assert.ok(Math.abs(matteShare(answer([])) - 20 / W) < 0.01, 'the stand-in\'s column is a sixteenth of the frame');

  // Two stretches, the run stopped while the second was out: the first is kept already, and the next run buys only the second.
  const fal = standIn();
  const two = [{ from: 10, to: 20 }, { from: 52, to: 60 }];
  await assert.rejects(cutoutFor(footage, two, () => {}, { route: keyed, model: async (stretches, o, take) => { await fal.model(stretches.slice(0, 1), o, take); throw new Error('stopped'); } }), /stopped/);
  assert.deepEqual(keptFiles(file), ['stretch-7-23.webm'], 'kept as it came, before the run was stopped');
  const got = await cutoutFor(footage, two, () => {}, { route: keyed, model: fal.model });
  assert.ok('laid' in got);
  assert.deepEqual(fal.calls.at(-1)!.runs, [{ from: 49, to: 63 }]);
});

test('cut-out: a kept stretch that is cut short, of another size or without its alpha is named, removed and not laid; a laid file cut short is made again', async () => {
  const dir = scratchDir('cutout-damaged');
  const file = clip(dir);
  const footage = probeFootage(file);
  const fal = standIn();
  const run = () => cutoutFor(footage, [{ from: 10, to: 20 }], () => {}, { route: keyed, model: fal.model });
  const first = await run();
  assert.ok('laid' in first);
  const kept = keptPath(file, 7, 23);
  const whole = readFileSync(kept);
  const sent = stretchOf(file, join(dir, 'sent.mp4'));
  const damaged = async (make: () => void, why: RegExp) => {
    make();
    const got = await run();
    assert.ok('none' in got, 'a damaged stretch is not laid');
    assert.match(got.none, why);
    assert.ok(got.none.startsWith(`the kept stretch ${kept} could not be read (`) && got.none.endsWith(') and was removed, so the next run cuts it out again'), got.none);
    assert.ok(!existsSync(kept), 'removed, so the next run buys it again');
    writeFileSync(kept, whole);
  };
  await damaged(() => { cutOut(sent, kept, ['-frames:v', '15']); }, /it holds 15 frame\(s\), not the 16 it was kept with/);
  await damaged(() => { cutOut(sent, kept, ['-s', '160x90']); }, /it is 160x90, and the clip 320x180/);
  await damaged(() => { execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', sent, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-f', 'webm', kept]); }, /it has no alpha channel/);
  await damaged(() => { writeFileSync(kept, whole.subarray(0, 200)); }, /could not be read \(/);
  assert.equal(fal.calls.length, 1, 'none of these bought anything');
  // The laid file cut short on disk: it is made again from the kept stretch, not played as it is.
  assert.deepEqual(await run(), first);
  truncateSync(first.laid.file, Math.floor(statSync(first.laid.file).size / 2));
  assert.deepEqual(await run(), first);
  assert.equal(countFrames(first.laid.file), 16);
});

test('cut-out: a page past the caps gets none and buys nothing; a turned clip is sent upright and an HDR clip as its SDR copy, and a copy that cannot be made is a reason', async () => {
  const dir = scratchDir('cutout-sent');
  const file = clip(dir);
  const footage = probeFootage(file);
  let asked = 0;
  const never: NonNullable<CutoutDeps['model']> = async () => { asked++; };
  const hour = { ...footage, frames: 36_000 };
  // An always-on graphic over an hour's clip, and one that blinks every four seconds through it.
  assert.deepEqual(await cutoutFor(hour, [{ from: 0, to: 36_000 }], () => {}, { route: keyed, model: never }),
    { none: 'graphics are behind the speaker for 3600.0 s of the clip, and a cut-out is made for at most 60 s of a piece' });
  assert.deepEqual(await cutoutFor(hour, Array.from({ length: 13 }, (_, k) => ({ from: 40 * k, to: 40 * k + 1 })), () => {}, { route: keyed, model: never }),
    { none: 'the cut-out would be bought in 13 stretches, and at most 12 are bought for one render' });
  assert.equal(asked, 0);

  // What the model is sent for a clip stored turned, and for one stored in pixels twice as wide as high: the picture
  // as it is shown, upright and in square pixels, with no turn left to apply.
  const turned = probeFootage(rotatedCopy(file, join(dir, 'turned.mp4'), 90));
  assert.deepEqual([turned.width, turned.height, turned.turned], [H, W, true]);
  const wide = join(dir, 'wide.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', file, '-vf', 'setsar=2/1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', wide]);
  const probe = (video: string) => (JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,sample_aspect_ratio,color_transfer:stream_side_data=rotation',
    '-of', 'json', video], { encoding: 'utf8' })) as { streams: { width: number; height: number; sample_aspect_ratio?: string; color_transfer?: string; side_data_list?: unknown[] }[] }).streams[0];
  const sentAs: ReturnType<typeof probe>[] = [];
  const looking = standIn([], (s) => { sentAs.push(probe(s.file)); return { failed: 'looked at, not answered' }; }).model;
  await cutoutFor(turned, [{ from: 10, to: 20 }], () => {}, { route: keyed, model: looking });
  assert.deepEqual([sentAs[0].width, sentAs[0].height, sentAs[0].side_data_list], [H, W, undefined]);
  await cutoutFor(probeFootage(wide), [{ from: 10, to: 20 }], () => {}, { route: keyed, model: looking });
  assert.deepEqual([sentAs[1].width, sentAs[1].height, sentAs[1].sample_aspect_ratio], [2 * W, H, '1:1']);

  // An HDR clip is sent as the SDR copy a render shows.
  const hdr = join(dir, 'hdr.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', file, '-vf', 'setparams=color_trc=smpte2084:color_primaries=bt2020:colorspace=bt2020nc', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', hdr]);
  await cutoutFor(probeFootage(hdr), [{ from: 10, to: 20 }], () => {}, { route: keyed, model: looking });
  assert.equal(sentAs[2].color_transfer, 'bt709');
  // Where that copy cannot be made, no stretch is sent and the reason is one line, not an error out of the render.
  const stuck = join(dir, 'stuck.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', hdr, '-c', 'copy', stuck]);
  mkdirSync(clipFolder(stuck, 'cutout'), { recursive: true });
  writeFileSync(join(clipFolder(stuck, 'cutout'), 'sdr'), 'a file where the copies\' folder would be');
  const none = await cutoutFor(probeFootage(stuck), [{ from: 10, to: 20 }], () => {}, { route: keyed, model: looking });
  assert.ok('none' in none && /, so no stretch was sent$/.test(none.none), JSON.stringify(none));
  assert.equal(sentAs.length, 3);
});

test('cut-out: what a segment was drawn with names the kept stretches under its frames and the frames they are drawn in, and nothing where none is', () => {
  const dir = scratchDir('cutout-drawn');
  const [a, b] = [join(dir, 'stretch-a-7-23.webm'), join(dir, 'stretch-a-49-63.webm')];
  writeFileSync(a, 'one');
  writeFileSync(b, 'another');
  const made = (on: Run[], pieces = [{ from: 10, to: 20, file: a, keptFrom: 7 }, { from: 52, to: 60, file: b, keptFrom: 49 }]): Made => ({
    made: { url: 'x', num: 10, den: 1, stretches: [], on }, laid: { file: 'laid', stretches: [], pieces }, clip: { fps: ten, frames: 80 } as Footage, fps: ten, first: 0,
  });
  const both = made([{ from: 10, to: 20 }, { from: 52, to: 60 }]);
  const before = drawnWith(both, 0, 20);
  assert.equal(drawnWith(both, 20, 40), undefined, 'a segment the cut-out is not drawn in');
  assert.match(before ?? '', /^[0-9a-f]{16}$/);
  assert.equal(before, drawnWith(made([{ from: 10, to: 20 }], both.laid.pieces.slice(0, 1)), 0, 20), 'a stretch added elsewhere changes nothing here');
  assert.notEqual(before, drawnWith(made([{ from: 12, to: 20 }, { from: 52, to: 60 }]), 0, 20), 'drawn in other frames');
  assert.notEqual(before, drawnWith(both, 40, 60), 'another stretch');
  writeFileSync(a, 'one, bought again');
  assert.notEqual(before, drawnWith(both, 0, 20), 'the stretch under these frames is another file now');
});

// --- the two routes --------------------------------------------------------------------------------------------

/** A fal that answers every route a stretch touches, counting the requests bought; `status` is what a request's status reads, `upload` the status storage answers with. */
function fakeFal(answer: string, o: { status?: () => string; upload?: number; declares?: number } = {}): { http: Http; submits: number; bodies: unknown[] } {
  const reply = (code: number, body: unknown, bytes = new Uint8Array(), headers: Record<string, string> = {}) => ({
    status: code, json: async () => body, header: (name: string) => headers[name] ?? null,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  });
  const fal: { http: Http; submits: number; bodies: unknown[] } = { submits: 0, bodies: [], http: async () => { throw new Error('not set'); } };
  fal.http = async (url, init) => {
    const u = new URL(url);
    if (u.host === 'api.fal.ai' && u.pathname === '/v1/models/pricing') return reply(200, { prices: [] });
    if (u.host === 'api.fal.ai') return reply(403, { error: 'no' });
    if (u.host === 'rest.fal.ai') return reply(o.upload ?? 200, { upload_url: 'https://upload.example/stretch?sig=1', file_url: 'https://cdn.example/stretch.mp4' });
    if (u.host === 'upload.example') return reply(200, {});
    if (u.host === 'queue.fal.run' && init.method === 'POST') {
      fal.submits++;
      fal.bodies.push(JSON.parse(String(init.body)));
      const id = `req-${fal.submits}`;
      return reply(200, { request_id: id, status_url: `https://queue.fal.run/veed/video-background-removal/requests/${id}/status`, response_url: `https://queue.fal.run/veed/video-background-removal/requests/${id}` });
    }
    if (u.host === 'queue.fal.run' && u.pathname.endsWith('/status')) return reply(200, { status: (o.status ?? (() => 'COMPLETED'))() });
    if (u.host === 'queue.fal.run') {
      return reply(200, { video: [{ url: 'https://files.example/output.webm', content_type: 'application/octet-stream', file_name: 'output.webm' }] }, undefined, { 'x-fal-billable-units': '1' });
    }
    if (u.host === 'files.example') return reply(200, {}, new Uint8Array(readFileSync(answer)), o.declares ? { 'content-length': String(o.declares) } : {});
    throw new Error(`the fake fal has no route for ${url}`);
  };
  return fal;
}

test('cut-out: on a fal key a stretch is bought once, its billed units said beside the estimate, a refused upload buys nothing, and one that timed out is resumed, not bought again', async () => {
  const dir = scratchDir('cutout-key');
  const file = clip(dir);
  const sentFile = stretchOf(file, join(dir, 'sent.mp4'));
  const answer = cutOut(sentFile, join(dir, 'answer.webm'));
  const sent: Sent[] = [{ from: 7, to: 23, name: 'a-7-23', file: sentFile }];
  const run = async (out: string, fal: { http: Http }, waitMs?: number) => {
    const got: Answer[] = [];
    await runModel(sent, { runDir: join(dir, 'runs', 'clip'), dir: join(dir, out), route: { how: 'key', key: 'k'.repeat(24) }, log: () => {}, http: fal.http, sleep: async () => {}, waitMs },
      (i, a) => { got[i] = a; });
    return got;
  };
  // Storage refuses the upload: the stretch never reaches the model, and nothing is bought.
  const refusing = fakeFal(answer, { upload: 403 });
  const [refused] = await run('refused', refusing);
  assert.ok('failed' in refused && refusing.submits === 0, JSON.stringify(refused));
  // The request is accepted, and so bought, and then never finishes while this run waits.
  const held = fakeFal(answer, { status: () => 'IN_PROGRESS' });
  const [late] = await run('first', held, 30);
  assert.ok('failed' in late);
  assert.match(late.failed, /fal job req-1 did not finish within the deadline; it may still complete\. Re-running the same command resumes request req-1; it does not buy it again\./);
  assert.equal(held.submits, 1);
  assert.deepEqual(held.bodies, [{ video_url: 'https://cdn.example/stretch.mp4', refine_foreground_edges: true }], 'the stretch is uploaded, and the model run with edge refinement on');
  // The next run finds the request in the clip's ledger, and takes its answer when it is there.
  const done = fakeFal(answer);
  const [got] = await run('second', done);
  assert.deepEqual(got, { file: join(dir, 'second', 'a-7-23', 'output.webm'), requestId: 'req-1', units: 1 });
  assert.equal(done.submits, 0, 'resumed, not bought again');

  // An answer that says it is larger than a cut-out may be is not taken into memory: the stretch has none.
  const huge = fakeFal(answer, { declares: 2e9 });
  const tooBig: Answer[] = [];
  await runModel(sent, { runDir: join(dir, 'runs', 'huge'), dir: join(dir, 'huge'), route: { how: 'key', key: 'k'.repeat(24) }, log: () => {}, http: huge.http, sleep: async () => {} },
    (i, a) => { tooBig[i] = a; });
  assert.ok('failed' in tooBig[0] && /is over the 512000000 bytes taken for it, and is not downloaded/.test(tooBig[0].failed), JSON.stringify(tooBig));

  // Through the whole of it, on a clip of its own: the units fal's result counts are said beside the units estimated.
  const lines: string[] = [];
  const whole = fakeFal(answer);
  const laid = await cutoutFor(probeFootage(clip(dir, { name: 'own.mp4' })), [{ from: 10, to: 20 }], (line) => lines.push(line), { route: keyed, http: whole.http, sleep: async () => {} });
  assert.ok('laid' in laid, JSON.stringify(laid));
  assert.equal(whole.submits, 1);
  assert.match(lines.find((line) => /came back/.test(line)) ?? '', /\(request req-1\) with the 16 frame\(s\) sent; fal's result counts 1 billable unit\(s\) for it, against 1 estimated; kept at /);

});

test('cut-out: the environment\'s own fal command is run for each stretch in a folder of that run\'s own, each answer handed over before the next is asked for, and a refusal stops the rest', async () => {
  const dir = realpathSync(scratchDir('cutout-command'));
  const sent: Sent[] = [{ from: 0, to: 10, name: 'a-0-10', file: '/clips/a.mp4' }, { from: 30, to: 40, name: 'a-30-40', file: '/clips/b.mp4' }];
  const calls: { args: string[]; timeoutMs: number; taken: number }[] = [];
  const got: Answer[] = [];
  // A stand-in for the command: it leaves `files` in the folder it is given, prints `stderr`, and ends as it is told.
  const answering = (each: (n: number) => Partial<Ran> & { stderr?: string[]; files?: string[]; bytes?: number }): Runner => async (_, args, o) => {
    calls.push({ args, timeoutMs: o.timeoutMs, taken: got.filter(Boolean).length });
    const { stderr, files, bytes, ...r } = each(calls.length);
    for (const name of files ?? []) {
      writeFileSync(join(args[args.indexOf('--out') + 1], name), 'the answer');
      if (bytes) truncateSync(join(args[args.indexOf('--out') + 1], name), bytes);
    }
    for (const line of stderr ?? []) o.onLine(line);
    return { status: 0, signal: null, timedOut: false, ...r };
  };
  const logged: string[] = [];
  const run = async (runner: Runner) => {
    calls.length = 0;
    got.length = 0;
    await runModel(sent, { runDir: dir, dir, route: { how: 'command', fal: '/bin/fal' }, log: (line) => logged.push(line), run: runner }, (i, a) => { got[i] = a; });
    return [...got];
  };
  const done = await run(answering((n) => ({ files: ['fal-result.json', 'output.webm'], stderr: [`fal: queued ${MODEL} as 019-${n}`, 'fal: COMPLETED'] })));
  // Its answer is the video it left in the folder made for that run, under the stretch's own.
  assert.deepEqual(done, [{ file: join(calls[0].args[4], 'output.webm'), requestId: '019-1' }, { file: join(calls[1].args[4], 'output.webm'), requestId: '019-2' }]);
  assert.deepEqual(calls.map((c) => c.args.slice(0, 4)), [
    ['run', MODEL, '{"video_url":"/clips/a.mp4","refine_foreground_edges":true}', '--out'],
    ['run', MODEL, '{"video_url":"/clips/b.mp4","refine_foreground_edges":true}', '--out'],
  ]);
  assert.deepEqual(calls.map((c) => [basename(join(c.args[4], '..')), /^run-/.test(basename(c.args[4]))]), [['a-0-10', true], ['a-30-40', true]]);
  assert.deepEqual(calls.map((c) => c.taken), [0, 1], 'the first answer is in hand, to be kept, before the second stretch is sent');
  assert.equal(calls[0].timeoutMs, 15 * 60_000);
  assert.deepEqual(logged, [`fal: queued ${MODEL} as 019-1`, 'fal: COMPLETED', `fal: queued ${MODEL} as 019-2`, 'fal: COMPLETED'], 'a run held for approval says so through these lines');
  // A refusal ends with nothing charged; the stretch after it is not asked for, as each may wait on someone's approval.
  const refused = await run(answering(() => ({ status: 3, stderr: ['fal: refused: this generation was not approved'] })));
  assert.deepEqual(refused, [
    { failed: 'the environment\'s fal command did not run it (exit 3): fal: refused: this generation was not approved' },
    { failed: 'not asked for after the stretch before it failed' },
  ]);
  assert.equal(calls.length, 1);
  const one = async (r: Partial<Ran> & { stderr?: string[]; files?: string[]; bytes?: number }) => (await run(answering(() => r)))[0];
  const held = await one({ status: null, signal: 'SIGKILL', timedOut: true, stderr: [`fal: queued ${MODEL} as 019-held`] });
  assert.ok('failed' in held && /^the environment's fal command gave no answer in 15 minutes and was stopped; request 019-held may still run and be billed/.test(held.failed), JSON.stringify(held));
  // Its answer is what it left in the folder: with no video there, the stretch has none.
  assert.deepEqual(await one({ files: ['fal-result.json'] }), { failed: 'the environment\'s fal command left no video in the folder it was given' });
  // A file larger than a cut-out may be is not taken, however it is named.
  assert.deepEqual(await one({ files: ['output.webm'], bytes: MOST_ANSWER_BYTES + 1 }),
    { failed: 'the environment\'s fal command left no video in the folder it was given (1 thing(s) there are not a plain file of at most 512 MB)' });
});

// --- on a page -------------------------------------------------------------------------------------------------

const platform = chromePlatform();
const noChrome = platform && existsSync(installedChrome(platform)) ? null : 'Chrome Headless Shell is not installed (openedit install-browser)';
if (noChrome && process.env.OPENEDIT_REQUIRE_BROWSER) throw new Error(`${noChrome}, and OPENEDIT_REQUIRE_BROWSER is set`);
const skip = noChrome ?? false;

/** A graphic, red, on screen only from `from` to `to` seconds of the page. */
const graphic = (name: string, from: number, to: number, box: string) =>
  `<div class="g" data-behind="${name}" style="${box};animation:${name} 100s steps(1) both"></div><style>@keyframes ${name}{0%{opacity:0}${from}%{opacity:1}${to}%{opacity:0}}</style>`;

/** A page of three layers laid as the CLI would lay them, so its picture is the same with and without a speaker layer; `layers` replaces them. */
function page(dir: string, behind: string, o: { cutout?: string; video?: string | false; front?: string; script?: string; layers?: string; name?: string } = {}): string {
  const file = join(dir, o.name ?? 'index.html');
  const footage = o.video === false ? '' : `<video src="clip.mp4" muted playsinline${o.video ?? ''}></video>`;
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body,#stage{margin:0;background:transparent}
#stage{position:relative;width:${W}px;height:${H}px;overflow:hidden}
[data-layer]{position:absolute;inset:0}
video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.g{position:absolute;background:#f00}
</style></head><body><div id="stage" data-stateless${o.cutout ? ` data-cutout="${o.cutout}"` : ''}>
${o.layers ?? `<div data-layer="footage">${footage}</div>
<div data-layer="behind">${behind}</div>
<div data-layer="front"><div style="position:absolute;left:0;top:150px;width:320px;height:20px;background:#0f0"></div>${o.front ?? ''}</div>`}
</div><script>${o.script ?? ''}</script></body></html>`);
  return file;
}

const BAND = 'left:0;top:10px;width:320px;height:40px';

test('page: the stretches bought follow the graphics that are on screen, the footage\'s place, the page\'s rate, the piece\'s end, the stills asked for and the faces found', { skip }, async () => {
  const dir = realpathSync(scratchDir('cutout-on-page'));
  const footage = clip(dir, { frames: 80 });
  const chrome = await resolveChrome(undefined, () => {});
  const server = await startPageServer({ roots: [dir] });
  // A session as behind opens it: the page's own videos stood down as it loads.
  const base = (file: string, fps: Fps): SessionBase => ({
    chrome, server, page: file, transparent: true, capture: 'png', footage: null, layers: null, fps, seed: SEED, videosIn: '[data-behind]',
    cutout: { at: 0, until: null }, epoch: EPOCH, budgetMs: BUDGET_MS, failedLoads: new Set(), refused: new Set(), timings: newTimings(), givenZone: {},
  });
  /** What a page asks to buy, the model never answering, or why it buys nothing; with what was said. */
  const asking = async (file: string) => {
    const opened = await openLead(base(file, ten));
    const said: string[] = [];
    return {
      info: opened.lead.info,
      said,
      close: () => opened.lead.close(),
      buys: async (more: Partial<PageCutout> = {}): Promise<Run[] | string | null> => {
        let bought: Run[] = [];
        const got = await pageCutout({
          page: file, info: opened.lead.info, server, base: base(file, more.fps ?? ten), canvas: opened.canvas, footage: null, footageAt: 0, say: (line) => said.push(line),
          deps: { env: ON, route: keyed, model: async (sent, _, take) => { bought = sent.map(({ from, to }) => ({ from, to })); sent.forEach((_s, i) => take(i, { failed: 'not answered' })); } },
          ...more,
        });
        return got === null ? null : 'none' in got && !bought.length ? got.none : bought;
      },
    };
  };
  try {
    // Two graphics, at 1-2 s and 6-7 s, among three that are never on screen: one with no box, one under a faded wrapper
    // and one parked off the stage. The page sets its footage to its own clock.
    const main = await asking(page(dir, [
      graphic('early', 1, 2, BAND), graphic('late', 6, 7, BAND),
      `<div class="g" data-behind="boxless" style="${BAND};display:none"></div>`,
      `<div style="opacity:0"><div class="g" data-behind="faded" style="${BAND}"></div></div>`,
      '<div class="g" data-behind="parked" style="left:-400px;top:10px;width:320px;height:40px"></div>',
    ].join('\n'), { script: 'window.__seek=(t)=>{document.querySelector("video").currentTime=t}' }));
    try {
      assert.deepEqual(main.info.behind, { footage: [[server.urlFor(footage)]], loops: false, graphics: 5 }, 'the footage layer\'s video, stood down, by the source it had chosen');
      assert.deepEqual(await main.buys(), [{ from: 7, to: 23 }, { from: 57, to: 73 }]);
      // Under render --footage-at 1 the clip's first frame shows a second in: the same graphics are over the clip's frames a second earlier.
      assert.deepEqual(await main.buys({ footage, footageAt: 1 }), [{ from: 0, to: 13 }, { from: 47, to: 63 }]);
      // Stepped at 20 fps, the page asks for the same frames of the clip.
      assert.deepEqual(await main.buys({ fps: { num: 20, den: 1 } }), [{ from: 7, to: 23 }, { from: 57, to: 73 }]);
      // A piece that ends at 3 s has one graphic; one that ends at 1.5 s buys nothing past its last frame.
      assert.deepEqual(await main.buys({ until: 3 }), [{ from: 7, to: 23 }]);
      assert.deepEqual(await main.buys({ until: 1.5 }), [{ from: 5, to: 15 }]);
      // Stills are looked at, and bought for, at their own frames alone.
      assert.deepEqual(await main.buys({ only: [3, 12, 40] }), [{ from: 8, to: 18 }]);
      // faces found nobody in the clip's first four seconds: the first graphic's stretch is left out, and said.
      const samples = Array.from({ length: 32 }, (_, k) => ({ sec: 0.125 + 0.25 * k, faces: 0.125 + 0.25 * k >= 4 ? [{ x: 10, y: 10, w: 40, h: 40 }] : [] }));
      mkdirSync(facesFolder(footage), { recursive: true });
      writeFileSync(join(facesFolder(footage), 'faces.json'), JSON.stringify({ video: footage, name: 'clip.mp4', width: W, height: H, fps: 10, frameRate: '10', durationSec: 8, model: 'x', every: 0.25,
        textMargin: 0.25, shots: [{ start: 0, end: 8, samples }] }));
      main.said.length = 0;
      assert.deepEqual(await main.buys(), [{ from: 57, to: 73 }]);
      assert.equal(main.said[0], 'no face is found in 1.000-2.000 s of clip.mp4, so the speaker is not cut out there');
      rmSync(join(facesFolder(footage), 'faces.json'));
    } finally {
      await main.close();
    }

    // A page that plays its footage two seconds ahead of its own clock, in a loop: the clip's frames are not where a cut-out would lay them.
    const off = await asking(page(dir, graphic('early', 1, 2, BAND), { video: ' loop', script: 'window.__seek=(t)=>{document.querySelector("video").currentTime=t+2}' }));
    try {
      assert.equal(off.info.behind?.loops, true);
      assert.equal(await off.buys(), 'the page sets its footage to 2.000 s at 0.000 s of its own clock, and a cut-out runs on the page\'s clock from the clip\'s first frame');
      assert.equal(await off.buys({ until: 12 }), 'its footage loops past the clip\'s end, and a cut-out runs once from the clip\'s first frame');
    } finally {
      await off.close();
    }

    // A stage the speaker layer would refuse once a cut-out is laid on it gets none, and nothing is bought for it: a
    // graphic marked data-behind in the front layer or a layer of another name as the page loads, or a graphic a
    // script puts outside the behind layer three seconds in.
    const late = 'window.__seek=(t)=>{const f=document.querySelector(\'[data-layer="front"]\'),g=f.querySelector("[data-behind]");'
      + 'if(t>=3&&!g){const d=document.createElement("div");d.setAttribute("data-behind","late");f.appendChild(d)}else if(t<3&&g)g.remove()}';
    const outside = 'a data-behind graphic lies outside the behind layer, <div data-layer="behind">, so the speaker is not in front of it';
    const refused: [string, string][] = [
      [page(dir, graphic('early', 1, 2, BAND), { front: `<div class="g" data-behind="in-front" style="${BAND}"></div>`, name: 'in-front.html' }), `as it loads): ${outside}`],
      [page(dir, '', { layers: `<div data-layer="footage"><video src="clip.mp4" muted playsinline></video></div><div data-layer="behind">${graphic('early', 1, 2, BAND)}</div><div data-layer="middle"></div>`, name: 'middle.html' }),
        'as it loads): data-layer="middle" is not a layer: footage, behind or front'],
      [page(dir, graphic('early', 1, 2, BAND), { script: late, name: 'late.html' }), `at 3.000 s): ${outside}`],
    ];
    for (const [file, why] of refused) {
      const broken = await asking(file);
      try {
        assert.equal(await broken.buys(), `its stage does not keep to the layers a cut-out is laid in (${why}`, basename(file));
        // Every frame drawn is held to the rules, the ones before the footage starts too.
        assert.equal(await broken.buys({ footage, footageAt: 4 }), `its stage does not keep to the layers a cut-out is laid in (${why}`, `${basename(file)}, its footage from 4 s`);
      } finally {
        await broken.close();
      }
    }

    // A page asks only with both layers, and with a graphic marked data-behind in its behind layer.
    const layerless = await asking(page(dir, '', { layers: `<div data-layer="behind">${graphic('early', 1, 2, BAND)}</div>` }));
    const unmarked = await asking(page(dir, '<div class="g" style="left:0;top:10px;width:320px;height:40px"></div>', { front: `<div class="g" data-behind="in-front" style="${BAND}"></div>` }));
    try {
      assert.deepEqual([layerless.info.behind, await layerless.buys()], [null, null]);
      assert.deepEqual([unmarked.info.behind?.graphics, await unmarked.buys()], [0, null]);
    } finally {
      await layerless.close();
      await unmarked.close();
    }
  } finally {
    await server.close();
  }
});

const at = (rgb: Buffer, x: number, y: number) => [...rgb.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
const isBlue = ([r, , b]: number[]) => b > 180 && r < 80;
const isRed = ([r, g, b]: number[]) => r > 180 && g < 80 && b < 80;
const isWhite = ([r, g, b]: number[]) => r > 200 && g > 200 && b > 200;
const isGreen = ([r, g, b]: number[]) => g > 200 && r < 60 && b < 60;
const row = (rgb: Buffer, y: number) => Array.from({ length: W }, (_, x) => at(rgb, x, y));
/** Where the speaker's column starts on a row, by colour: within a pixel of 5n, as 4:2:0 chroma lets it be told. */
const column = (rgb: Buffer, y: number, is: (p: number[]) => boolean) => row(rgb, y).findIndex(is);
const near = (x: number, want: number) => Math.abs(x - want) <= 1;
/** Every frame of a rendered video as RGB. */
function framesOf(video: string): Buffer[] {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', video, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
  return Array.from({ length: raw.length / (W * H * 3) }, (_, i) => raw.subarray(i * W * H * 3, (i + 1) * W * H * 3));
}

/** A `fal` command for PATH that says it runs a model on its input, answers as cutOut does, and logs each call it gets. */
function falCommand(dir: string): { path: string; calls: () => { model: string; input: { video_url: string } }[] } {
  const bin = join(dir, 'bin');
  const log = join(dir, 'fal-calls.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'fal'), `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--help') { console.log('usage: fal run MODEL_ID INPUT_JSON [--out DIR]'); process.exit(0); }
const out = args[args.indexOf('--out') + 1];
const input = JSON.parse(args[2]);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ model: args[1], input }) + '\\n');
fs.mkdirSync(out, { recursive: true });
process.stderr.write('fal: queued ' + args[1] + ' as req-1\\n');
execFileSync(${JSON.stringify(FFMPEG)}, ['-v', 'error', '-y', '-i', input.video_url, '-filter_complex', "[0:v]format=yuva420p,geq=lum=41:cb=240:cr=110:a='255*gt(lum(X,Y),200)'[v]",
  '-map', '[v]', '-c:v', 'libvpx-vp9', '-lossless', '1', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-an', out + '/output.webm']);
console.log('saved ' + out + '/output.webm');
`, { mode: 0o755 });
  return { path: bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []) };
}

// The renders cover what only the command can show: the line and the fallback with the switch off, a patch that
// renders again what was drawn without the cut-out, the layer drawing it in the graphic's frames alone through the
// environment's real fal command, and behind reading the cut-out the render kept.
test('render: off, the page is drawn as it was with one line; on, a patch draws the speaker in front for the graphic\'s frames alone, and behind reads the same cut-out', { skip }, async () => {
  const dir = realpathSync(scratchDir('cutout-render'));
  const footage = clip(dir, { frames: 36, rate: 24 });
  const fal = falCommand(dir);
  // The clip is laid from 0.5 s of the page, frame 12, and the page plays no video of its own. The graphic is up from
  // 1.0 s to 1.5 s, page frames 24 to 35 and the clip's 12 to 23, in the third of four half-second segments.
  const file = page(dir, graphic('title', 1, 1.5, BAND), { video: false });
  const out = join(dir, 'out.mp4');
  const { FAL_KEY: _key, FAL_API_KEY: _api, OPEN_EDIT_FAL_KEY_FILE: _file, ...rest } = process.env;
  const render = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ['--import', 'tsx', CLI, 'render', ...args, '--footage', footage, '--footage-at', '0.5'],
    { encoding: 'utf8', timeout: 240_000, env: { ...rest, PATH: `${fal.path}${delimiter}${process.env.PATH}`, ...env } });
  const video = [file, '--out', out, '--segment', '0.5', '--workers', '2'];
  const drawn = (frames: Buffer[], cut: boolean) => {
    assert.equal(frames.length, 48);
    frames.forEach((rgb, k) => {
      const [on, c] = [k >= 24 && k < 36, k - 12];
      // The cut-out is the clip's frame under the page's, drawn only while the graphic is up: the speaker's column, in
      // blue, where the footage's white one is. Before the clip starts the page is over black.
      if (cut && on) assert.ok(near(column(rgb, 120, isBlue), 5 * c) && column(rgb, 120, isWhite) === -1, `frame ${k}: the cut-out of clip frame ${c}, at ${column(rgb, 120, isBlue)}`);
      else assert.ok(column(rgb, 120, isBlue) === -1 && (c < 0 ? column(rgb, 120, isWhite) === -1 : near(column(rgb, 120, isWhite), 5 * c)), `frame ${k}: the footage alone, no cut-out`);
      const red = row(rgb, 30).filter(isRed).length;
      if (on && cut) assert.ok(red >= W - 22 && red <= W - 18 && near(column(rgb, 30, isBlue), 5 * c), `frame ${k}: the speaker in front of the graphic (${red} px of it show)`);
      else assert.equal(red, on ? W : 0, `frame ${k}: ${on ? 'the graphic over the speaker' : 'no graphic'}`);
      assert.ok(isGreen(at(rgb, 160, 160)), `frame ${k}: the front layer over everything`);
    });
  };

  // The switch unset: nothing is spent, one line names the command, and the page is drawn as it was.
  const off = render(video, {});
  assert.equal(off.status, 0, off.stderr);
  const said = off.stderr.split('\n').filter((line) => /cut-out/.test(line));
  assert.equal(said.length, 1, off.stderr);
  assert.match(said[0], /^render: index\.html lays a graphic behind the speaker and has no cut-out of the speaker, so it is drawn without the speaker in front: the environment does not have the automatic cut-out switched on; npx @veedstudio\/openedit-cli background-removal \S*clip\.mp4'? makes one to name on the stage \(data-cutout="<file>"\)$/);
  assert.deepEqual(fal.calls(), [], 'nothing is spent unasked');
  drawn(framesOf(out), false);
  // behind refuses the same page the same way, naming the clip its --footage gave it.
  const [log, printed] = [console.log, [] as string[]];
  console.log = (...a: unknown[]) => { printed.push(a.join(' ')); };
  try {
    assert.equal(await behind([file, '--footage', footage, '--footage-at', '0.5', '--json']), 1);
  } finally {
    console.log = log;
  }
  assert.match((JSON.parse(printed.join('\n')) as { error: string }).error, /stage names no cut-out: give it data-cutout="<file>", the background-removed clip; none was made for it \(the environment does not have the automatic cut-out switched on; npx @veedstudio\/openedit-cli background-removal \S*clip\.mp4'? makes one/);

  // The switch on, and a patch of the last segment alone: the cut-out is made, and the segment the graphic is in, drawn
  // without it before, is rendered again though it lies outside the range.
  const on = render([...video, '--from', '1.5', '--to', '2'], ON);
  assert.equal(on.status, 0, on.stderr);
  const lines = on.stderr.split('\n');
  const announced = lines.findIndex((line) => /^render: making a cut-out of the speaker for 1\.0 s of clip\.mp4 \(24 frames in 1 stretch: 0\.250-1\.250 s\) with veed\/video-background-removal\/fast, through the fal command the environment gives in place of a key/.test(line));
  const queued = lines.findIndex((line) => /^render: fal: queued veed\/video-background-removal\/fast as req-1$/.test(line));
  assert.ok(announced >= 0 && queued > announced, on.stderr);
  assert.match(on.stderr, /^render: also rendering segment\(s\) 2 outside --from\/--to again: the speaker's cut-out they were rendered with is not the one made for the page now \(none then, one now\)$/m);
  assert.match(on.stdout, /segments: 2 rendered, 2 reused/);
  assert.equal(fal.calls().length, 1);
  assert.match(fal.calls()[0].input.video_url, /cutout-[0-9a-f]{8}[\\/]sent[\\/][0-9a-f]{16}-6-30\.mp4$/);
  drawn(framesOf(out), true);

  // behind, given the render's footage, reads the cut-out the render kept: it has no fal to buy another on.
  const error = console.error;
  const told: string[] = [];
  console.error = (...a: unknown[]) => { told.push(a.join(' ')); };
  try {
    const report = await checkBehind(file, { bar: BAR, footage, footageAt: 0.5, cutout: { env: ON, route: () => ({ how: 'none', why: 'no fal here' }) } });
    assert.deepEqual([report.checkedFrames, report.frameRate, report.graphics.length, report.graphics[0].measuredFrames, report.graphics[0].start, report.pass], [48, '24', 1, 12, 1, true]);
    assert.ok(Math.abs(report.graphics[0].worst.share - 300 / 320) <= 0.01, `the speaker's 20 px of the title's 320: ${report.graphics[0].worst.share}`);
    assert.match(told.join('\n'), /behind: the cut-out of the speaker for 0\.5 s of clip\.mp4 \(0\.500-1\.000 s\) is kept in /);
  } finally {
    console.error = error;
  }
  assert.equal(fal.calls().length, 1);

  // A stage the speaker layer would refuse, a graphic marked data-behind in its front layer, its title over frames of
  // the clip nothing kept holds: with the switch on it is drawn as with the switch off, pixel for pixel, with one line
  // saying why, and nothing more is asked of fal.
  const refused = page(dir, graphic('title', 1.5, 2, BAND), { video: false, front: `<div class="g" data-behind="in-front" style="${BAND}"></div>`, name: 'refused.html' });
  const still = (to: string, env: NodeJS.ProcessEnv) => {
    const r = render([refused, '--out', join(dir, to), '--stills', '1.9'], env);
    assert.equal(r.status, 0, r.stderr);
    const names = readdirSync(join(dir, to)).filter((name) => name.endsWith('.png'));
    assert.equal(names.length, 1);
    return { stderr: r.stderr, png: readFileSync(join(dir, to, names[0])) };
  };
  const [without, switched] = [still('refused-off', {}), still('refused-on', ON)];
  assert.ok(switched.png.equals(without.png), 'the same picture as with the switch off');
  assert.match(switched.stderr, /^render: refused\.html lays a graphic behind the speaker and has no cut-out of the speaker, so it is drawn without the speaker in front: its stage does not keep to the layers a cut-out is laid in \(as it loads\): a data-behind graphic lies outside the behind layer/m);
  assert.doesNotMatch(switched.stderr, /making a cut-out|fal: queued/);
  assert.equal(fal.calls().length, 1, 'nothing is bought for a page that would be refused');
  // behind refuses that page as it does with the switch off, and buys nothing either.
  let asked = 0;
  await assert.rejects(checkBehind(refused, { bar: BAR, footage, footageAt: 0.5, cutout: { env: ON, route: keyed, model: async () => { asked++; } } }),
    /stage names no cut-out: give it data-cutout="<file>", the background-removed clip; none was made for it \(its stage does not keep to the layers a cut-out is laid in \(as it loads\): a data-behind graphic lies outside the behind layer/);
  assert.equal(asked, 0);

  // A stage that names a cut-out that is not there, with the switch off: the line says none is made in its place, and the render fails as it did.
  const missing = render([page(dir, graphic('title', 1, 1.5, BAND), { video: false, cutout: 'not-there.webm', name: 'missing.html' }), '--out', join(dir, 'stills'), '--stills', '1.2'], {});
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /^render: missing\.html lays a graphic behind the speaker and its stage names a cut-out that is not there, and none is made in its place: the environment does not have the automatic cut-out switched on/m);
  assert.match(missing.stderr, /the speaker layer's cut-out .*not-there\.webm could not be played/);
});
