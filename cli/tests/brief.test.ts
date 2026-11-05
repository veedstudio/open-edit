// The brief: `openedit brief` writing a piece's brief.json, and the tools that read it when they are not told,
// each run as a command on real files in a workspace of its own: review's length check, safe-zone's zone,
// reframe's shape and render's length line. The render case runs in the pinned headless Chrome and is skipped
// when it is not installed, unless OPENEDIT_REQUIRE_BROWSER is set.
//   Run:  node --import tsx --test cli/tests/brief.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findBrief } from '../src/brief.ts';
import { chromePlatform, installedChrome } from '../src/render/browser.ts';
import { probeStream, scratchDir, synthClip, TESTSRC } from './helpers/synth.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
// Resolved here, since the commands run from the workspace, where no tsx is installed.
const TSX = import.meta.resolve('tsx');
const platform = chromePlatform();
const noChrome = platform && existsSync(installedChrome(platform)) ? null : 'Chrome Headless Shell is not installed (openedit install-browser)';
if (noChrome && process.env.OPENEDIT_REQUIRE_BROWSER) throw new Error(`${noChrome}, and OPENEDIT_REQUIRE_BROWSER is set`);

// Spelled as on disk, as the tools print a brief's path: the temporary directory is a symlink on macOS and a
// short 8.3 name on Windows, which only the native realpath expands.
const dir = realpathSync.native(scratchDir('brief'));
const workspace = join(dir, 'workspace');
mkdirSync(join(workspace, 'runs'), { recursive: true });

/** A command run from the workspace, as an agent runs one, with relative paths. */
function cli(...args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
    cwd: workspace, encoding: 'utf8', timeout: 240_000, env: { ...process.env, OPEN_EDIT_ROOT: workspace },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const briefOf = (key: string) => JSON.parse(readFileSync(join(workspace, 'runs', key, 'brief.json'), 'utf8'));
const briefPath = (key: string) => join(workspace, 'runs', key, 'brief.json');
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A four-second clip with sound, in a folder of the workspace. */
function clip(folder: string, name = 'out.mp4'): string {
  const at = join(workspace, folder);
  mkdirSync(at, { recursive: true });
  return synthClip(at, name, { video: TESTSRC, audio: 'sine=frequency=220:sample_rate=48000', seconds: 4 });
}

/** A 320x180 clip outside every piece's folder, as an upload is. */
const source = (() => {
  mkdirSync(join(workspace, 'inputs'), { recursive: true });
  return synthClip(join(workspace, 'inputs'), 'wide.mp4', { video: 'testsrc=size=320x180:rate=25', seconds: 1 });
})();

await test('brief writes the piece\'s brief.json, keeps what an earlier call set, and prints it when given nothing', () => {
  const first = cli('brief', 'runs/kept', '--length', '60');
  assert.equal(first.code, 0, first.err);
  assert.deepEqual(briefOf('kept'), { length: 60 });
  const second = cli('brief', 'runs/kept', '--platform', 'TikTok', '--words', 'Doors open at 7');
  assert.equal(second.code, 0, second.err);
  assert.deepEqual(briefOf('kept'), { length: 60, platform: 'tiktok', words: 'Doors open at 7' });
  const shown = cli('brief', 'runs/kept');
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /^ {2}length: 60 s$/m);
  assert.match(shown.out, /^ {2}platform: tiktok \(TikTok, 9:16\)$/m);
  assert.match(shown.out, /^ {2}words: "Doors open at 7"$/m);
});

await test('brief refuses a platform that names no one zone, and a length that is not one, and writes nothing', () => {
  const several = cli('brief', 'runs/refused', '--platform', 'linkedin');
  assert.equal(several.code, 1);
  assert.match(several.err, /--platform linkedin is posted in 3 shapes, each with its own zone and size: name it with its shape, as "linkedin 16:9", "linkedin 1:1" or "linkedin 4:5"/);
  assert.match(cli('brief', 'runs/refused', '--platform', 'vine').err, /"vine" names no safe-zone format/);
  assert.match(cli('brief', 'runs/refused', '--length', '0').err, /--length wants seconds above 0/);
  assert.equal(existsSync(briefPath('refused')), false);
  // Named with its shape, the same app is one zone.
  assert.equal(cli('brief', 'runs/refused', '--platform', 'linkedin 1:1').code, 0);
  assert.deepEqual(briefOf('refused'), { platform: 'linkedin 1:1' });
});

await test('review without --length compares with the brief\'s length, from the video\'s folder or one above it, never a sibling\'s', () => {
  assert.equal(cli('brief', 'runs/short', '--length', '6').code, 0);
  const own = new RegExp(`^length +FOUND +the video is 4\\.00s, 2\\.00s shorter than the 6\\.00s asked for \\(${escaped(briefPath('short'))}\\), more than the 1\\.00s allowed$`, 'm');
  clip('runs/short');
  const r = cli('review', 'runs/short/out.mp4');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, own);
  clip('runs/short/drafts');
  assert.match(cli('review', 'runs/short/drafts/out.mp4').out, own);
  clip('runs/sibling');
  assert.match(cli('review', 'runs/sibling/out.mp4').out, /^length +skipped +skipped: the length asked for: none given with --length or in a brief\.json for this piece$/m);
});

await test('a --length given to review wins over the brief, and the report says which it used', () => {
  assert.equal(cli('brief', 'runs/override', '--length', '30').code, 0);
  clip('runs/override');
  const r = cli('review', 'runs/override/out.mp4', '--length', '4');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^length +pass +on length: 4\\.00s against the 4\\.00s asked for \\(--length, over the 30\\.00s in ${escaped(briefPath('override'))}\\), 0\\.00s off`, 'm'));
});

await test('a brief is looked for no higher than the workspace, and outside it only in the file\'s own folder', () => {
  const outside = join(dir, 'outside');
  mkdirSync(join(outside, 'sub'), { recursive: true });
  writeFileSync(join(outside, 'brief.json'), JSON.stringify({ length: 6 }));
  writeFileSync(join(dir, 'brief.json'), JSON.stringify({ length: 6 }));
  const previous = process.env.OPEN_EDIT_ROOT;
  process.env.OPEN_EDIT_ROOT = workspace;
  try {
    assert.equal(findBrief(join(outside, 'out.mp4')), join(outside, 'brief.json'));
    assert.equal(findBrief(join(outside, 'sub', 'out.mp4')), null);
    // The brief above the workspace is not the workspace's.
    assert.equal(findBrief(join(workspace, 'runs', 'sibling', 'out.mp4')), null);
  } finally {
    process.env.OPEN_EDIT_ROOT = previous;
  }
});

await test('safe-zone with no zone named writes the zone of the brief\'s platform; a zone named wins, and each says which', () => {
  assert.equal(cli('brief', 'runs/zone', '--platform', 'tiktok').code, 0);
  const fromBrief = cli('safe-zone', '--out', 'runs/zone');
  assert.equal(fromBrief.code, 0, fromBrief.err);
  const css = () => readFileSync(join(workspace, 'runs', 'zone', 'safe-zone.css'), 'utf8');
  // TikTok's own zone: its tabs (240) above, its button column (183) on both sides.
  assert.match(css(), /\[data-safe\] \{\n {2}position: absolute;\n {2}left: 183px;\n {2}top: 240px;/);
  assert.match(fromBrief.out, new RegExp(`^ {2}zone: the platform tiktok in ${escaped(briefPath('zone'))}$`, 'm'));
  const named = cli('safe-zone', 'reels', '--out', 'runs/zone');
  assert.equal(named.code, 0, named.err);
  assert.match(css(), /\[data-safe\] \{\n {2}position: absolute;\n {2}left: 200px;\n {2}top: 206px;/);
  assert.match(named.out, /^ {2}zone: reels as named, over the platform tiktok in /m);
  // An app named with its shape gives that shape's stage.
  assert.equal(cli('safe-zone', '--out', 'runs/refused').code, 0);
  assert.match(readFileSync(join(workspace, 'runs', 'refused', 'safe-zone.css'), 'utf8'), /^ {2}width: 1080px;\n {2}height: 1080px;/m);
  const neither = cli('safe-zone', '--out', 'runs/nothing');
  assert.equal(neither.code, 2);
  assert.match(neither.err, /no zone named and no brief\.json for this piece: name the zone, or record where the piece is posted with npx @veedstudio\/openedit-cli brief runs\/nothing --platform <zone>/);
});

await test('reframe with no --aspect cuts to the shape of the brief\'s platform; --aspect wins, and each says which', () => {
  const sizeOf = (file: string) => {
    const s = probeStream(join(workspace, file), 'v:0', 'width,height');
    return `${s.width}x${s.height}`;
  };
  // The brief is found from the clip reframe writes, in the piece's folder, not from the source.
  const tall = cli('reframe', source, '--out', 'runs/zone/tall.mp4');
  assert.equal(tall.code, 0, tall.err);
  assert.equal(sizeOf('runs/zone/tall.mp4'), '1080x1920');
  assert.match(tall.out, new RegExp(`^reframe: shape 9:16, the shape of the platform tiktok in ${escaped(briefPath('zone'))}$`, 'm'));
  assert.equal(cli('reframe', source, '--out', 'runs/refused/square.mp4').code, 0);
  assert.equal(sizeOf('runs/refused/square.mp4'), '1080x1080');
  const named = cli('reframe', source, '--aspect', '1:1', '--out', 'runs/zone/square.mp4');
  assert.equal(named.code, 0, named.err);
  assert.equal(sizeOf('runs/zone/square.mp4'), '1080x1080');
  assert.match(named.out, /^reframe: shape 1:1 from --aspect, over the 9:16 of the platform tiktok in /m);
  const neither = cli('reframe', source, '--out', 'runs/nothing/tall.mp4');
  assert.equal(neither.code, 2);
  assert.match(neither.err, /no --aspect, and no platform in a brief\.json for .*tall\.mp4: pass --aspect/);
});

await test('render prints one line when the video misses the brief\'s length by more than review allows, and none within it', { skip: noChrome ?? false }, () => {
  mkdirSync(join(workspace, 'runs', 'timed'), { recursive: true });
  writeFileSync(join(workspace, 'runs', 'timed', 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0}#stage{width:180px;height:320px;background:#234;color:#fff;font:700 24px sans-serif}
</style></head><body><div id="stage" data-stateless>Two seconds</div></body></html>`);
  const render = () => cli('render', 'runs/timed/index.html', '--out', 'runs/timed/out.mp4', '--fps', '10', '--duration', '2');
  assert.equal(cli('brief', 'runs/timed', '--length', '6').code, 0);
  const short = render();
  assert.equal(short.code, 0, short.err);
  const lines = short.out.trimEnd().split('\n');
  assert.equal(lines.at(-1), `  length: the video is 2.00s, 4.00s shorter than the 6.00s asked for (${briefPath('timed')}), more than the 1.00s allowed`);
  assert.equal(cli('brief', 'runs/timed', '--length', '2.5').code, 0);
  const near = render();
  assert.equal(near.code, 0, near.err);
  assert.doesNotMatch(near.out, /length:/);
});
