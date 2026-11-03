// Tests src/commands/review.ts: the one report every delivery check prints into, where it finds the
// transcript, and that it changes nothing. Each check's own measurements are tested beside its module; one
// render in the pinned headless Chrome, skipped when it is not installed unless OPENEDIT_REQUIRE_BROWSER is
// set, runs the dead-tail check's end card through render, mux-audio and review.
//   Run:  node --import tsx --test cli/tests/review.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { muxAudio } from '../src/commands/mux-audio.ts';
import { review, reviewReport, transcriptFor } from '../src/commands/review.ts';
import { chromePlatform, installedChrome } from '../src/render/browser.ts';
import type { Transcript } from '../src/transcript/transcript-types.ts';
import { CHECKS, type Check, type ReviewContext } from '../src/verify/checks.ts';
import { SINE, TESTSRC, captureConsoleAsync, scratchDir, synthClip } from './helpers/synth.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const platform = chromePlatform();
const noChrome = platform && existsSync(installedChrome(platform)) ? null : 'Chrome Headless Shell is not installed (openedit install-browser)';
if (noChrome && process.env.OPENEDIT_REQUIRE_BROWSER) throw new Error(`${noChrome}, and OPENEDIT_REQUIRE_BROWSER is set`);

const dir = scratchDir('review');
// The workspace transcribe writes a file's transcript into, by file name: here, so a real one is never touched.
const workspace = join(dir, 'workspace');
process.env.OPEN_EDIT_ROOT = workspace;

/** A tone until `until` seconds, then digital silence. */
const toneUntil = (until: number) => `aevalsrc=exprs='if(lt(t,${until}),0.3*sin(2*PI*220*t),0)':s=48000`;

/** A context for a report built from stand-in checks, which read nothing from it. */
const STAND_IN: ReviewContext = { video: 'out.mp4', duration: 1, transcript: { missing: 'none' }, askedLength: { missing: 'none' }, textRecord: { missing: 'none' } };

const transcriptEndingAt = (end: number): Transcript => ({
  text: 'the last line',
  chunks: [{ text: 'the last line', timestamp: [0.5, end], words: [{ text: 'line', timestamp: [end - 0.3, end] }] }],
});

/** A piece's folder as the skill lays it out: the render, and the transcript beside it unless told not to. */
function piece(name: string, opts: { toneUntil: number; seconds: number; lastWord?: number }): string {
  const folder = join(dir, name);
  mkdirSync(folder, { recursive: true });
  const video = synthClip(folder, 'out.mp4', { video: TESTSRC, audio: toneUntil(opts.toneUntil), seconds: opts.seconds });
  if (opts.lastWord !== undefined) {
    writeFileSync(join(folder, 'transcript.json'), JSON.stringify(transcriptEndingAt(opts.lastWord)));
  }
  return video;
}

await test('a render with a dead tail gets a report that names it, and the review still exits 0', async () => {
  const video = piece('dead', { toneUntil: 3, seconds: 6, lastWord: 2.9 });
  const { result, out } = await captureConsoleAsync(() => review([video]));
  assert.equal(result, 0);
  const lines = out.trimEnd().split('\n');
  assert.equal(lines[0], `review: ${video}`);
  assert.match(lines[1], /^dead-tail {5}FOUND {4}the last 3\.00s are silent: nothing is heard after 3\.00s/);
  // Each further line of a check sits under its first, past the name and the verdict.
  assert.match(lines[2], /^ {23}the last spoken word, "line", ends at 2\.90s \(.*dead[\\/]transcript\.json\)$/);
  assert.match(out, /^blank-frames {2}pass {5}opens on a picture, no flash/m);
  assert.equal(lines.at(-1), 'Checks: 1 found something, 1 passed, 3 skipped, 0 could not run. The video was not changed: each finding is '
    + 'yours to judge, and one you leave in place is worth a word to the user.');
});

await test('a render ending on a card over music passes as an end card; over a silent tail, or without its record, it is reported', { skip: noChrome ?? false }, async () => {
  const folder = join(dir, 'end-card');
  mkdirSync(folder, { recursive: true });
  // Captions under three seconds of speech, then "Follow for more" to the end of six.
  const page = join(folder, 'index.html');
  writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#000}
#stage{position:relative;width:180px;height:320px;overflow:hidden;background:#123;font:700 18px Helvetica,Arial,sans-serif;color:#fff}
#cap{position:absolute;left:0;right:0;bottom:60px;text-align:center}
#card{position:absolute;left:0;right:0;top:140px;text-align:center;font-size:22px}
</style></head><body><div id="stage" data-stateless><div id="cap"></div><div id="card"></div></div>
<script>const cues=[[0,1.5,'we made this'],[1.5,3,'in a single day']];
window.__seek=(t)=>{const c=cues.find(([a,b])=>t>=a&&t<b);document.getElementById('cap').textContent=c?c[2]:'';
document.getElementById('card').textContent=t>=3?'Follow for more':''}</script></body></html>`);
  const silent = join(folder, 'out.mp4');
  const rendered = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'render', page, '--out', silent, '--fps', '10', '--duration', '6'], { encoding: 'utf8', timeout: 240_000 });
  assert.equal(rendered.status, 0, rendered.stderr);
  writeFileSync(join(folder, 'transcript.json'), JSON.stringify(transcriptEndingAt(3)));
  const muxed = (name: string, until: number) => {
    const music = synthClip(folder, `${name}.m4a`, { audio: toneUntil(until), seconds: 6 });
    const out = join(folder, `${name}.mp4`);
    assert.equal(muxAudio(['--video', silent, '--audio', music, '--out', out, '--no-loudnorm']), 0);
    return out;
  };

  const { out: card } = await captureConsoleAsync(() => review([muxed('final', 6)]));
  assert.match(card, /^dead-tail +pass +ends on a 3\.00s end card with sound to the last frame, within the 4\.00s allowed for its 3 words: "Follow for more"$/m);
  const { out: quiet } = await captureConsoleAsync(() => review([muxed('quiet', 3)]));
  assert.match(quiet, /^dead-tail +FOUND +the last 3\.00s are silent: nothing is heard after 3\.00s/m);
  // A copy carries no record beside it, so its tail cannot be told from background left running.
  const copied = join(folder, 'copied.mp4');
  copyFileSync(join(folder, 'final.mp4'), copied);
  const { out: bare } = await captureConsoleAsync(() => review([copied]));
  assert.match(bare, /^dead-tail +FOUND +the picture runs 3\.00s past the last spoken word, with sound under it to 6\.\d\ds: fine for a deliberate outro/m);
  assert.match(bare, /^ +skipped: whether the tail is an end card: no record of on-screen text at .*copied\.mp4\.text\.json: /m);
});

await test('a render that ends on its last line gets a report with nothing found', async () => {
  const video = piece('clean', { toneUntil: 5.8, seconds: 6, lastWord: 5.7 });
  const { out } = await captureConsoleAsync(() => review([video, '--length', '6']));
  assert.match(out, /^dead-tail +pass +ends on time/m);
  assert.match(out, /^length +pass +on length/m);
  assert.match(out, /Checks: 0 found something, 3 passed, 2 skipped, 0 could not run\. The video was not changed\.$/m);
});

await test('without a transcript the review still runs, and says what it skipped', async () => {
  const video = piece('no-transcript', { toneUntil: 3, seconds: 6 });
  const { out } = await captureConsoleAsync(() => review([video]));
  assert.match(out, /^dead-tail +FOUND +the last 3\.00s are silent/m);
  assert.match(out, /skipped: the last spoken word: no transcript at .*no-transcript[\\/]transcript\.json, and none named with --transcript/);
});

await test('a pass with a comparison skipped is counted as such, so it never reads as a full one', async () => {
  const video = piece('clean-no-transcript', { toneUntil: 5.8, seconds: 6 });
  const { out } = await captureConsoleAsync(() => review([video]));
  assert.match(out, /^dead-tail +pass +ends on time: the picture ends 0\.20s after the last sound$/m);
  assert.match(out, /Checks: 0 found something, 2 passed \(1 with a comparison skipped\), 3 skipped, 0 could not run\./);
});

await test('a transcript keyed by the file\'s name is not read: another piece\'s render of that name may have written it', async () => {
  const video = piece('keyed-elsewhere', { toneUntil: 5.8, seconds: 6 });
  mkdirSync(join(workspace, 'runs', 'out'), { recursive: true });
  writeFileSync(join(workspace, 'runs', 'out', 'transcript.json'), JSON.stringify(transcriptEndingAt(1)));
  const { out } = await captureConsoleAsync(() => review([video]));
  assert.match(out, /^dead-tail +pass/m);
  assert.doesNotMatch(out, /runs[\\/]out[\\/]transcript\.json/);
});

await test('the dead-tail check is given the picture\'s length the review probed, not one it probes again', async () => {
  const video = piece('duration', { toneUntil: 5.8, seconds: 6 });
  const deadTail = CHECKS.find((check) => check.name === 'dead-tail')!;
  const report = await deadTail.run({ video, duration: 20, transcript: { missing: 'none' }, askedLength: { missing: 'none' }, textRecord: { missing: 'none' } });
  assert.match(report.lines[0], /nothing is heard after 5\.80s, and the picture runs to 20\.00s/);
});

await test('a render shorter than the length asked for gets a report naming both durations', async () => {
  const video = piece('short', { toneUntil: 3.9, seconds: 4 });
  const { result, out } = await captureConsoleAsync(() => review([video, '--length', '6']));
  assert.equal(result, 0);
  assert.match(out, /^length +FOUND +the video is 4\.00s, 2\.00s shorter than the 6\.00s asked for/m);
  assert.match(out, /Checks: 1 found something, 2 passed \(1 with a comparison skipped\), 2 skipped, 0 could not run\./);
});

await test('a render within the tolerance of the length asked for passes', async () => {
  const video = piece('near-length', { toneUntil: 5.8, seconds: 6 });
  const { out } = await captureConsoleAsync(() => review([video, '--length', '6.5']));
  assert.match(out, /^length +pass +on length: 6\.00s against the 6\.50s asked for, 0\.50s off, within the 1\.00s allowed$/m);
});

await test('without --length the length check is skipped with a line saying so, and the review still exits 0', async () => {
  const video = piece('no-length', { toneUntil: 5.8, seconds: 6 });
  const { result, out } = await captureConsoleAsync(() => review([video]));
  assert.equal(result, 0);
  assert.match(out, /^length +skipped +skipped: the length asked for: none given with --length$/m);
});

await test('a --length that is not a length stops the review instead of being skipped, before the video is probed', async () => {
  const video = piece('bad-length', { toneUntil: 3, seconds: 4 });
  for (const value of ['--length=abc', '--length=0', '--length=-3', '--length=']) {
    const run = await captureConsoleAsync(() => review([video, value]).catch((error: Error) => error));
    assert.ok(run.result instanceof Error, value);
    assert.match(run.result.message, /^--length wants seconds above 0/, value);
    assert.equal(run.out, '', value);
  }
  // A file ffprobe cannot read would stop the review with its own error; the call's mistake is named first.
  const unreadable = join(dir, 'bad-length', 'unreadable.mp4');
  writeFileSync(unreadable, 'not a video');
  await assert.rejects(review([unreadable, '--length=abc']), /^Error: --length wants seconds above 0/);
});

await test('--transcript is read instead of the one in the folder', async () => {
  // The folder's transcript would put the last word 5s before the end; the named one ends on the line.
  const video = piece('named', { toneUntil: 5.8, seconds: 6, lastWord: 1 });
  const named = join(dir, 'named-on-timeline.json');
  writeFileSync(named, JSON.stringify(transcriptEndingAt(5.7)));
  const { out } = await captureConsoleAsync(() => review([video, '--transcript', named]));
  assert.match(out, /^dead-tail +pass/m);
  assert.match(out, /named-on-timeline\.json/);
});

await test('a named transcript that is missing or damaged stops the review instead of being skipped', async () => {
  const video = piece('bad-named', { toneUntil: 3, seconds: 4 });
  await assert.rejects(review([video, '--transcript', join(dir, 'nowhere.json')]), /transcript not found: .*nowhere\.json/);
  const damaged = join(dir, 'damaged-named.json');
  writeFileSync(damaged, '{"chunks":"no"}');
  await assert.rejects(review([video, '--transcript', damaged]), /damaged-named\.json is not a transcript\.json/);
});

await test('a damaged transcript in the folder is set aside with its file named, not trusted', () => {
  const cases = [
    ['damaged', '{"chunks": "no"}', 'is not a transcript\\.json'],
    ['null', 'null', 'is not a transcript\\.json'],
    ['null-chunk', '{"chunks": [null]}', 'is not a transcript\\.json'],
    ['null-word', '{"chunks": [{"words": [null]}]}', 'is not a transcript\\.json'],
    ['not-json', '{"chunks": [', ':'],
  ];
  for (const [name, content, why] of cases) {
    const folder = join(dir, `folder-${name}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'transcript.json'), content);
    const input = transcriptFor(join(folder, 'out.mp4'), undefined);
    assert.ok('missing' in input, name);
    assert.match(input.missing, new RegExp(`folder-${name}[\\\\/]transcript\\.json ?${why}`), name);
  }
});

await test('a file with no picture stops the review non-zero', async () => {
  const audio = synthClip(dir, 'sound-only.m4a', { audio: SINE, seconds: 1 });
  await assert.rejects(review([audio]), /^Error: cannot review .*sound-only\.m4a: it has no video stream$/);
});

await test('a video ffprobe cannot read stops the review non-zero, rather than passing with nothing checked', async () => {
  const video = piece('truncated', { toneUntil: 3, seconds: 4 });
  const broken = join(dir, 'truncated', 'broken.mp4');
  copyFileSync(video, broken);
  truncateSync(broken, 2000);
  const run = await captureConsoleAsync(() => review([broken]).catch((error: Error) => error));
  assert.ok(run.result instanceof Error);
  assert.match(run.result.message, /^cannot review .*broken\.mp4: ffprobe cannot read it/);
  assert.equal(run.out, '', 'no report is printed for a file nothing could measure');
});

await test('a check with nothing to compare is counted as skipped, so the footer never reads as a clean review', async () => {
  const skipped: Check[] = [{ name: 'only', run: () => ({ verdict: 'skipped', lines: [], skipped: ['nothing to compare'] }) }];
  const lines = await reviewReport(STAND_IN, skipped);
  assert.equal(lines.at(-1), 'Checks: 0 found something, 0 passed, 1 skipped, 0 could not run. The video was not changed.');
});

await test('the review changes nothing: the folder holds the same files, byte for byte, after it', async () => {
  const video = piece('untouched', { toneUntil: 3, seconds: 4, lastWord: 2.9 });
  const folder = join(dir, 'untouched');
  const snapshot = () => readdirSync(folder).sort().map((name) => {
    const path = join(folder, name);
    return [name, statSync(path).mtimeMs, readFileSync(path).toString('base64')];
  });
  const before = snapshot();
  await captureConsoleAsync(() => review([video]));
  assert.deepEqual(snapshot(), before);
});

await test('a check that throws could not run, counted apart from one given nothing to compare, and the others still report', async () => {
  const checks: Check[] = [
    { name: 'broken', run: () => { throw new Error('could not read the audio\nffmpeg said a lot more'); } },
    { name: 'fine', run: async () => ({ verdict: 'found', lines: ['something to judge'], skipped: [] }) },
    { name: 'idle', run: () => ({ verdict: 'skipped', lines: [], skipped: ['nothing to compare'] }) },
  ];
  const lines = await reviewReport(STAND_IN, checks);
  assert.match(lines[1], /^broken +skipped +skipped: the whole check: could not read the audio$/);
  assert.match(lines[2], /^fine +FOUND +something to judge$/);
  assert.match(lines[3], /^idle +skipped +skipped: nothing to compare$/);
  assert.match(lines[4], /^Checks: 1 found something, 0 passed, 1 skipped, 1 could not run\./);
});

await test('a check whose tool failed is reported with the tool\'s own last word, not only the command it ran', async () => {
  // The shape a failed spawn throws: the command line first, the tool's stderr on the error, or on its cause.
  const spawnFailure = Object.assign(new Error('Command failed: ffmpeg -i out.mp4 -'), { stderr: Buffer.from('noise\nout.mp4: Invalid data found\n') });
  const checks: Check[] = [
    { name: 'direct', run: () => { throw spawnFailure; } },
    { name: 'wrapped', run: () => { throw new Error('could not read the audio streams of out.mp4', { cause: spawnFailure }); } },
  ];
  const lines = await reviewReport(STAND_IN, checks);
  assert.match(lines[1], /skipped: the whole check: Command failed: ffmpeg -i out\.mp4 - \(out\.mp4: Invalid data found\)$/);
  assert.match(lines[2], /skipped: the whole check: could not read the audio streams of out\.mp4 \(out\.mp4: Invalid data found\)$/);
});

await test('a missing video, no video at all and a stray positional are refused by name', async () => {
  await assert.rejects(review([join(dir, 'absent.mp4')]), /video not found/);
  await assert.rejects(review([]), /usage: openedit review/);
  await assert.rejects(review(['a.mp4', 'b.mp4']), /usage: openedit review/);
});
