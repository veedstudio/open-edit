// The renderer's parts that need no browser: frame arithmetic, the blank-frame reader, the zip reader,
// the browser pin, and the page server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { connect } from 'node:net';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { FFMPEG } from '../src/config.ts';
import {
  fpsLabel, frameAtTime, frameSpan, frameTime, framesForDuration, parseFps, planSegments, segmentFramesFor,
  segmentsTouching, splitContiguous, splitFrames, workersFor,
} from '../src/render/timing.ts';
import { inspectPng, showsSomething } from '../src/render/png.ts';
import { extractZip } from '../src/render/unzip.ts';
import { CHROME, chromePlatform, installChrome } from '../src/render/browser.ts';
import { hidden, hiddenOnDisk, requestedFile, startPageServer, unsafeRoot } from '../src/render/server.ts';
import { launchProxy, sandboxRefused, withSandbox } from '../src/render/session.ts';
import { acquireLock, defaultWorkers, pageRoots } from '../src/commands/render.ts';
import { scratchDir } from './helpers/synth.ts';

const scratch = (prefix: string) => scratchDir(`render-${prefix}`);

test('render: a rate is an integer or an exact rational, and a decimal is refused with the rational it meant', () => {
  assert.deepEqual(parseFps('30'), { num: 30, den: 1 });
  assert.deepEqual(parseFps('30000/1001'), { num: 30000, den: 1001 });
  assert.equal(fpsLabel(parseFps('24000/1001')), '24000/1001');
  assert.equal(fpsLabel(parseFps('60')), '60');
  assert.throws(() => parseFps('29.97'), /30000\/1001/);
  assert.throws(() => parseFps('0'), /not a usable/);
  assert.throws(() => parseFps('abc'), /integer or an exact rational/);
});

test('render: frame i sits at i·den/num seconds, and the rational never drifts', () => {
  const ntsc = parseFps('30000/1001');
  assert.equal(frameTime(0, ntsc), 0);
  assert.equal(frameTime(30000, ntsc), 1001);
  assert.equal(frameAtTime(frameTime(12345, ntsc), ntsc), 12345);
  assert.equal(framesForDuration(2, ntsc), 60);
  assert.equal(framesForDuration(19.5, parseFps('60')), 1170);
});

test('render: segments tile the frames, and a patch range takes every segment it touches', () => {
  const fps = parseFps('30');
  assert.equal(segmentFramesFor(2, fps), 60);
  const segs = planSegments(150, 60);
  assert.deepEqual(segs.map((s) => [s.start, s.frames]), [[0, 60], [60, 60], [120, 30]]);
  // 1.9..2.1 s straddles the boundary at frame 60, so both neighbours are re-rendered.
  const span = frameSpan(1.9, 2.1, fps, 150);
  assert.deepEqual(span, { from: 57, to: 63 });
  assert.deepEqual(segmentsTouching(segs, span.from, span.to).map((s) => s.index), [0, 1]);
  // A range inside one segment takes only that one.
  const inner = frameSpan(2.5, 3, fps, 150);
  assert.deepEqual(segmentsTouching(segs, inner.from, inner.to).map((s) => s.index), [1]);
});

test('render: frames are cut into equal contiguous runs, splitting a segment when workers outnumber segments', () => {
  // A patch of two 48-frame segments on eight workers: every worker gets 12 frames.
  const segs = planSegments(480, 48).slice(4, 6);
  const runs = splitFrames(segs, 8);
  assert.equal(runs.length, 8);
  assert.deepEqual(runs.map((r) => r.reduce((n, p) => n + p.to - p.from, 0)), Array(8).fill(12));
  const covered = runs.flat().flatMap((p) => Array.from({ length: p.to - p.from }, (_, k) => p.from + k));
  assert.deepEqual(covered, Array.from({ length: 96 }, (_, k) => 192 + k), 'every frame once, in order');
  // Fewer workers than segments: whole segments where the cut allows, a shared one where it does not.
  const three = splitFrames(planSegments(100, 25), 3);
  assert.deepEqual(three.map((r) => r.map((p) => [p.segment.index, p.from, p.to])), [
    [[0, 0, 25], [1, 25, 33]], [[1, 33, 50], [2, 50, 67]], [[2, 67, 75], [3, 75, 100]],
  ]);
});

test('render: work is split into contiguous runs of near-equal length, with a worker per 12 frames at most', () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  const groups = splitContiguous(items, 4);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups.flat(), items, 'every item once, in order');
  assert.ok(Math.max(...groups.map((g) => g.length)) - Math.min(...groups.map((g) => g.length)) <= 1);
  assert.deepEqual(splitContiguous([1, 2], 8), [[1], [2]], 'never more groups than items');
  assert.equal(defaultWorkers(1), 1);
  assert.equal(defaultWorkers(6), 3, 'half the cores');
  assert.equal(defaultWorkers(64), 8, 'eight at most');
  assert.equal(workersFor(24, 8, 12), 2, 'no worker gets fewer than 12 frames');
  assert.equal(workersFor(5, 8, 12), 1, 'a short range still gets one');
  assert.equal(workersFor(960, 6, 12), 6, 'never more than asked for');
});

function png(filter: string, pixFmt: string): Buffer {
  return execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', filter, '-frames:v', '1', '-pix_fmt', pixFmt, '-pred', 'mixed', '-f', 'image2pipe', '-c:v', 'png', '-']);
}

test('render: the frame reader tells a flat frame from a drawn one, and reads alpha', () => {
  const flat = inspectPng(png('color=c=0x336699:s=64x32', 'rgb24'));
  assert.equal(flat.uniform, true);
  assert.equal(showsSomething(flat), false);
  const drawn = inspectPng(png('testsrc=s=64x32', 'rgb24'));
  assert.equal(drawn.uniform, false);
  assert.equal(showsSomething(drawn), true);
  const clear = inspectPng(png('color=c=black@0:s=64x32,format=rgba', 'rgba'));
  assert.equal(clear.alphaMax, 0);
  assert.equal(showsSomething(clear), false);
  const dot = inspectPng(png("color=c=black@0:s=64x32,format=rgba,geq=r=255:g=255:b=255:a='if(gt(X\\,60)*gt(Y\\,28)\\,255\\,0)'", 'rgba'));
  assert.equal(dot.alphaMax, 255);
  assert.equal(showsSomething(dot), true);
});

/** A zip built by hand: stored and deflated entries, unix modes, a directory, an empty file. */
function zipOf(entries: { name: string; data?: string; mode?: number; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data ?? '');
    const body = e.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name);
    const crc = 0; // the reader trusts the archive's MD5, checked before it unpacks
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('render: the zip reader unpacks stored and deflated entries with their modes', async () => {
  const dir = scratch('zip');
  const zip = join(dir, 'a.zip');
  writeFileSync(zip, zipOf([
    { name: 'top/', mode: 0o040755 },
    { name: 'top/run.sh', data: '#!/bin/sh\necho hi\n'.repeat(50), mode: 0o100755, deflate: true },
    { name: 'top/data.txt', data: 'plain' },
    { name: 'top/sub/empty.txt', data: '' },
  ]));
  const out = join(dir, 'out');
  assert.equal(await extractZip(zip, out), 3);
  assert.equal(readFileSync(join(out, 'top', 'run.sh'), 'utf8'), '#!/bin/sh\necho hi\n'.repeat(50));
  assert.equal(readFileSync(join(out, 'top', 'data.txt'), 'utf8'), 'plain');
  assert.equal(statSync(join(out, 'top', 'sub', 'empty.txt')).size, 0);
  if (process.platform !== 'win32') assert.equal(statSync(join(out, 'top', 'run.sh')).mode & 0o111, 0o111, 'the executable bit survives');
});

test('render: the zip reader refuses an entry that climbs out of the destination, by name or by link', async () => {
  const dir = scratch('slip');
  const zip = join(dir, 'evil.zip');
  writeFileSync(zip, zipOf([{ name: '../evil.txt', data: 'x' }]));
  await assert.rejects(extractZip(zip, join(dir, 'out')), /escapes the destination/);
  assert.equal(existsSync(join(dir, 'evil.txt')), false);
  writeFileSync(zip, zipOf([{ name: '/tmp/evil.txt', data: 'x' }]));
  await assert.rejects(extractZip(zip, join(dir, 'abs')), /escapes the destination/);
  if (process.platform === 'win32') return;
  // A link inside the destination is kept; one that points out is refused before anything lands through it.
  writeFileSync(zip, zipOf([{ name: 'top/sub/a.txt', data: 'a' }, { name: 'top/cur', data: 'sub', mode: 0o120777 }]));
  await extractZip(zip, join(dir, 'ok'));
  assert.equal(readlinkSync(join(dir, 'ok', 'top', 'cur')), 'sub');
  writeFileSync(zip, zipOf([{ name: 'top/up', data: '../../..', mode: 0o120777 }, { name: 'top/up/evil.txt', data: 'x' }]));
  await assert.rejects(extractZip(zip, join(dir, 'link')), /links outside the destination/);
  // A link to the destination itself passes the name check, but `..` beneath it would climb out.
  writeFileSync(zip, zipOf([{ name: 'here', data: '.', mode: 0o120777 }, { name: 'here/up', data: '..', mode: 0o120777 }, { name: 'here/up/evil/', mode: 0o040755 }]));
  await assert.rejects(extractZip(zip, join(dir, 'loop', 'out')), /zip entry here\/up links outside the destination: \.\./);
  assert.equal(existsSync(join(dir, 'loop', 'evil')), false);
  // Each link is spelled inside, yet c leads to the destination's parent on disk: a/b is the destination.
  writeFileSync(zip, zipOf([{ name: 'a/', mode: 0o040755 }, { name: 'a/b', data: '..', mode: 0o120777 }, { name: 'c', data: 'a/b/..', mode: 0o120777 }, { name: 'c/evil.txt', data: 'x' }]));
  await assert.rejects(extractZip(zip, join(dir, 'chain', 'out')), /escapes the destination through a link: c\/evil\.txt/);
  assert.equal(existsSync(join(dir, 'chain', 'evil.txt')), false);
  // The same chain as the name of a later file entry, written through the link unless the write refuses one.
  writeFileSync(zip, zipOf([{ name: 'd', data: '.', mode: 0o120777 }, { name: 'e', data: 'd/../victim', mode: 0o120777 }, { name: 'e', data: 'x' }]));
  await assert.rejects(extractZip(zip, join(dir, 'over', 'out')), /zip entry e would write over what already stands at its path/);
  assert.equal(existsSync(join(dir, 'over', 'victim')), false);
});

test('render: a verified download is unpacked whole, replacing a broken install', { skip: process.platform === 'win32' && 'a shell-script stand-in cannot run on Windows' }, async () => {
  const dir = scratch('install');
  const root = join(dir, 'browser', 'chrome-headless-shell-x');
  mkdirSync(join(root, 'leftover'), { recursive: true });
  const fake = zipOf([{ name: 'chrome-headless-shell-mac-arm64/chrome-headless-shell', data: '#!/bin/sh\necho "Chrome Headless Shell 1.2.3"\n', mode: 0o100755 }]);
  const build = { bytes: fake.length, md5: createHash('md5').update(fake).digest('base64') };
  const serve = (async () => new Response(new Uint8Array(fake))) as typeof fetch;
  const exe = await installChrome({ platform: 'mac-arm64', root, build, log: () => {}, fetchImpl: serve });
  assert.equal(exe, join(root, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'));
  assert.equal(existsSync(join(root, 'leftover')), false, 'the broken install is replaced whole');
  assert.deepEqual(readdirSync(join(dir, 'browser')), ['chrome-headless-shell-x'], 'no staged tree or archive is left');
  const refused = (async () => new Response(null, { status: 503 })) as typeof fetch;
  await assert.rejects(installChrome({ platform: 'mac-arm64', root: join(dir, 'browser', 'other'), build, log: () => {}, fetchImpl: refused }), /HTTP 503/);
  assert.deepEqual(readdirSync(join(dir, 'browser')), ['chrome-headless-shell-x'], 'a failed download leaves nothing either');
});

test('render: the browser pin is the build the driver library was released against, and the driver is pinned exactly', () => {
  const manifest = createRequire(import.meta.url).resolve('playwright-core/package.json');
  const browsers = JSON.parse(readFileSync(join(manifest, '..', 'browsers.json'), 'utf8')) as { browsers: { name: string; browserVersion?: string }[] };
  const shell = browsers.browsers.find((b) => b.name === 'chromium-headless-shell');
  assert.equal(CHROME.version, shell?.browserVersion);
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
  assert.match(pkg.dependencies['playwright-core'], /^\d+\.\d+\.\d+$/, 'a range would let the driver move away from the pinned browser');
  assert.deepEqual(Object.keys(CHROME.builds).sort(), ['linux-arm64', 'linux64', 'mac-arm64', 'mac-x64', 'win64']);
  assert.equal(chromePlatform('darwin', 'arm64'), 'mac-arm64');
  assert.equal(chromePlatform('linux', 'arm64'), 'linux-arm64');
  assert.equal(chromePlatform('win32', 'x64'), 'win64');
  assert.equal(chromePlatform('win32', 'arm64'), null);
});

test('render: a download that does not match the pinned build is refused and leaves nothing behind', async () => {
  const dir = scratch('pin');
  const root = join(dir, 'browser', 'chrome-headless-shell-x');
  const fake = zipOf([{ name: 'chrome-headless-shell-mac-arm64/chrome-headless-shell', data: '#!/bin/sh\necho fake\n', mode: 0o100755 }]);
  const lines: string[] = [];
  await assert.rejects(
    installChrome({ platform: 'mac-arm64', root, log: (l) => lines.push(l), fetchImpl: (async () => new Response(new Uint8Array(fake))) as typeof fetch }),
    /does not match the pinned build/,
  );
  assert.match(lines[0], /downloading Chrome Headless Shell .* 94\.3 MB/, 'the size is announced before the download');
  assert.deepEqual(existsSync(join(dir, 'browser')) ? readdirSync(join(dir, 'browser')) : [], [], 'no staged tree or archive is left');
});

test('render: the page server answers ranged reads, and nothing outside its token', async () => {
  const dir = scratch('srv');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'clip.bin'), Buffer.from('0123456789'));
  writeFileSync(join(dir, 'other.bin'), Buffer.from('abcdefghij'));
  const server = await startPageServer({ roots: [dir] });
  try {
    const url = server.urlFor(join(dir, 'sub', 'clip.bin'));
    assert.equal(server.fileFor(url), join(dir, 'sub', 'clip.bin'));
    assert.equal(server.named(`video ${url}: no picture; also ${url}`), `video ${join(dir, 'sub', 'clip.bin')}: no picture; also ${join(dir, 'sub', 'clip.bin')}`);
    const whole = await fetch(url);
    assert.equal(whole.status, 200);
    assert.equal(await whole.text(), '0123456789');
    const part = await fetch(url, { headers: { range: 'bytes=2-5' } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), '2345');
    // A relative reference out of the page's directory resolves as it would on disk.
    const sibling = await fetch(new URL('../other.bin', url));
    assert.equal(await sibling.text(), 'abcdefghij');
    const origin = new URL(url).origin;
    assert.equal((await fetch(`${origin}/not-the-token${new URL(url).pathname.replace(/^\/[^/]+/, '')}`)).status, 404);
    assert.equal((await fetch(server.urlFor(join(dir, 'missing.bin')))).status, 404);
    server.substitute(join(dir, 'sub', 'clip.bin'), join(dir, 'other.bin'));
    assert.equal(await (await fetch(url)).text(), 'abcdefghij', 'a substitute is served under the original URL');
  } finally {
    await server.close();
  }
});

test('render: the page server outlives a read the browser cancels while the file is looked up', async () => {
  const dir = scratch('cancel');
  writeFileSync(join(dir, 'clip.bin'), Buffer.alloc(100_000));
  const server = await startPageServer({ roots: [dir] });
  try {
    const url = new URL(server.urlFor(join(dir, 'clip.bin')));
    // The request and the hang-up arrive together, so the socket is gone by the time the file is found.
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((done) => {
        const s = connect(Number(url.port), '127.0.0.1', () => {
          s.end(`GET ${url.pathname} HTTP/1.1\r\nHost: x\r\nRange: bytes=0-\r\n\r\n`);
          s.destroy();
          done();
        });
      });
    }
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await fetch(url)).status, 200, 'and still answers the next one');
  } finally {
    await server.close();
  }
});

test('render: the page server refuses what lies outside its roots, any hidden name, and the CLI state', async () => {
  const dir = scratch('roots');
  // Spelled long: a Windows TEMP can carry an 8.3 short name (RUNNER~1), which is never offered as a --root.
  const outside = realpathSync.native(scratch('outside'));
  writeFileSync(join(dir, 'ok.txt'), 'ok');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  mkdirSync(join(dir, '.ssh'));
  writeFileSync(join(dir, '.ssh', 'id_ed25519'), 'key');
  writeFileSync(join(dir, '.env'), 'TOKEN=x');
  const state = join(dir, 'state');
  mkdirSync(state);
  writeFileSync(join(state, 'token.json'), '{}');
  // With no workspace, runs live in the state dir, and a page kept there must still load.
  mkdirSync(join(state, 'runs', 'k'), { recursive: true });
  writeFileSync(join(state, 'runs', 'k', 'page.html'), '<p>run</p>');
  writeFileSync(join(dir, 'fal-key.txt'), 'key');
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, '.git', 'config'), '[remote]');
  const linked = process.platform !== 'win32';
  if (linked) {
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.txt'));
    // A name without the dot that reaches a dot entry, as a Windows 8.3 short name does.
    symlinkSync(join(dir, '.git'), join(dir, 'alias'));
  }
  const env: Record<string, string> = { OPENEDIT_STATE_DIR: state, OPEN_EDIT_ROOT: state, OPEN_EDIT_FAL_KEY_FILE: join(dir, 'fal-key.txt') };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const server = await startPageServer({ roots: [dir] }).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const get = async (file: string) => {
    const r = await fetch(server.urlFor(file));
    await r.arrayBuffer();
    return `${r.status} ${r.statusText}`;
  };
  try {
    assert.equal(await get(join(dir, 'ok.txt')), '200 OK');
    assert.match(await get(join(outside, 'secret.txt')), /^403 Outside the served roots/);
    assert.deepEqual(server.refusalFor(server.urlFor(join(outside, 'secret.txt'))), { reason: 'Outside the served roots', root: outside },
      'a refusal is kept with the --root that would admit it');
    assert.equal(server.refusalFor(server.urlFor(join(dir, 'ok.txt'))), null);
    assert.match(await get(join(outside, 'missing.txt')), /^403 /, 'a refusal does not say whether the file exists');
    assert.deepEqual(server.refusalFor(server.urlFor(join(outside, 'missing.txt'))), { reason: 'Outside the served roots', root: outside },
      'nor does the render, since nothing outside the roots is looked up');
    mkdirSync(join(outside, '.cache'));
    writeFileSync(join(outside, '.cache', 'pic.png'), 'x');
    await get(join(outside, '.cache', 'pic.png'));
    assert.deepEqual(server.refusalFor(server.urlFor(join(outside, '.cache', 'pic.png'))), { reason: 'Outside the served roots', folder: 'a hidden folder' },
      'a hidden folder is never offered as a --root');
    writeFileSync(join(outside, '.env'), 'x');
    await get(join(outside, '.env'));
    assert.deepEqual(server.refusalFor(server.urlFor(join(outside, '.env'))), { reason: 'Hidden (dot) path refused' },
      'a dot file is not offered a --root that would refuse it anyway');
    const home = realpathSync.native(scratch('home-file'));
    writeFileSync(join(home, 'talk.mp4'), 'x');
    const savedHome = [process.env.HOME, process.env.USERPROFILE];
    process.env.HOME = process.env.USERPROFILE = home;
    try {
      await get(join(home, 'talk.mp4'));
    } finally {
      for (const [k, v] of [['HOME', savedHome[0]], ['USERPROFILE', savedHome[1]]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    assert.deepEqual(server.refusalFor(server.urlFor(join(home, 'talk.mp4'))), { reason: 'Outside the served roots', folder: 'your home directory' },
      'nor is the home directory');
    const climb = await fetch(new URL(`../${basename(outside)}/secret.txt`, server.urlFor(join(dir, 'ok.txt'))));
    assert.equal(climb.status, 403, 'a relative climb out of the root is refused');
    assert.match(await get(join(dir, '.ssh', 'id_ed25519')), /^403 Hidden/);
    assert.match(await get(join(dir, '.env')), /^403 Hidden/);
    assert.match(await get(join(state, 'token.json')), /^403 The CLI state/);
    assert.equal(await get(join(state, 'runs', 'k', 'page.html')), '200 OK', 'a run kept in the state dir is served');
    assert.match(await get(join(dir, 'fal-key.txt')), /^403 The fal key file/, 'wherever the key file is kept');
    if (linked) {
      assert.match(await get(join(dir, 'link.txt')), /^403 Outside the served roots through a link/);
      assert.match(await get(join(dir, 'alias', 'config')), /^403 Hidden/, 'a dot entry is refused by its real path too');
    }
  } finally {
    await server.close();
  }
  const wider = await startPageServer({ roots: [dir, outside] });
  try {
    assert.equal(await (await fetch(wider.urlFor(join(outside, 'secret.txt')))).text(), 'secret', 'another root widens what is served');
  } finally {
    await wider.close();
  }
});

test('render: the page server looks up nothing a request names outside its roots, and no UNC share at all', async () => {
  const dir = scratch('unread');
  const outside = scratch('unread-outside');
  writeFileSync(join(dir, 'ok.txt'), 'ok');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  const server = await startPageServer({ roots: [dir] });
  const prefix = new URL(server.urlFor(join(dir, 'ok.txt'))).pathname.split('/')[1];
  const origin = new URL(server.urlFor(dir)).origin;
  const promises = fs.promises as unknown as Record<string, unknown>;
  const sync = fs as unknown as Record<string, unknown>;
  const saved = { stat: promises.stat, realpath: promises.realpath, statSync: sync.statSync, realpathSync: sync.realpathSync, createReadStream: sync.createReadStream };
  const looked: string[] = [];
  const spy = (name: string, real: unknown) => (...args: unknown[]) => {
    looked.push(`${name} ${String(args[0])}`);
    return (real as (...a: unknown[]) => unknown)(...args);
  };
  promises.stat = spy('stat', saved.stat);
  promises.realpath = spy('realpath', saved.realpath);
  sync.statSync = spy('statSync', saved.statSync);
  sync.realpathSync = Object.assign(spy('realpathSync', saved.realpathSync), { native: spy('realpathSync.native', fs.realpathSync.native) });
  sync.createReadStream = spy('createReadStream', saved.createReadStream);
  syncBuiltinESMExports();
  const statuses: number[] = [];
  try {
    for (const path of [server.urlFor(join(outside, 'secret.txt')), server.urlFor(join(outside, 'missing.txt')),
      `${origin}/${prefix}/%5C%5Cattacker.example%5Cshare%5Cx.png`, `${origin}/${prefix}/%5C/attacker.example/share/x.png`]) {
      const r = await fetch(path);
      await r.arrayBuffer();
      statuses.push(r.status);
    }
  } finally {
    Object.assign(promises, { stat: saved.stat, realpath: saved.realpath });
    Object.assign(sync, { statSync: saved.statSync, realpathSync: saved.realpathSync, createReadStream: saved.createReadStream });
    syncBuiltinESMExports();
    await server.close();
  }
  assert.deepEqual(looked, [], 'a path outside the roots is refused by its spelling, never looked up');
  assert.deepEqual(statuses, process.platform === 'win32' ? [403, 403, 404, 404] : [403, 403, 403, 403]);

  // On Windows a lookup of \\host\share opens a connection to that host, so only a drive path names a file.
  for (const unc of ['/\\\\attacker.example\\share\\x.png', '/\\/attacker.example/share/x.png', '//\\\\attacker.example/share', '/\\\\?\\C:\\x', '/\\\\.\\pipe\\x', '/C:x']) {
    assert.equal(requestedFile(unc, 'win32'), null, unc);
  }
  assert.equal(requestedFile('/C:/Users/me/clip.mp4', 'win32'), 'C:\\Users\\me\\clip.mp4');
  assert.equal(requestedFile('/Users/me/clip.mp4', 'darwin'), '/Users/me/clip.mp4');
  // Nothing is looked up to expand a Windows 8.3 short name, so one that may stand for a dot folder is not offered.
  assert.ok(unsafeRoot('C:\\Users\\me\\SSH~1', [], 'win32'));
  assert.equal(unsafeRoot('C:\\Users\\me\\footage', [], 'win32'), null);
});

test('render: a package pnpm links out of node_modules/.pnpm is served, and a link to a dot entry still is not', { skip: process.platform === 'win32' && 'needs symlinks' }, async () => {
  const ws = scratch('pnpm');
  const store = join(ws, 'node_modules', '.pnpm', 'pkg@1.0.0', 'node_modules', 'pkg');
  mkdirSync(join(store, 'dist'), { recursive: true });
  writeFileSync(join(store, 'dist', 'pkg.min.js'), 'window.pkg = 1;');
  // Relative, as pnpm links them.
  symlinkSync(join('.pnpm', 'pkg@1.0.0', 'node_modules', 'pkg'), join(ws, 'node_modules', 'pkg'));
  mkdirSync(join(ws, '.git'));
  writeFileSync(join(ws, '.git', 'config'), '[remote]');
  symlinkSync(join(ws, '.git'), join(ws, 'alias'));
  symlinkSync(join(ws, '.git'), join(ws, 'node_modules', 'evil'));
  const server = await startPageServer({ roots: [ws] });
  const get = async (file: string) => {
    const r = await fetch(server.urlFor(file));
    return `${r.status} ${r.status === 200 ? await r.text() : r.statusText}`;
  };
  try {
    assert.equal(await get(join(ws, 'node_modules', 'pkg', 'dist', 'pkg.min.js')), '200 window.pkg = 1;');
    assert.match(await get(join(ws, 'alias', 'config')), /^403 Hidden/);
    assert.match(await get(join(ws, 'node_modules', 'evil', 'config')), /^403 Hidden/, 'a link kept in node_modules is judged by where it leads');
  } finally {
    await server.close();
  }
  assert.equal(hiddenOnDisk(join('node_modules', 'pkg', '.git', 'config')), true, 'only a dot entry directly inside node_modules is exempt');
});

test('render: a hidden name is a dot name, and a real name with a tilde is not one', () => {
  assert.equal(hidden(join('a', '.env')), true);
  assert.equal(hidden(join('sub', 'clip.mp4')), false);
  assert.equal(hidden('proj\\.git\\config', 'win32'), true);
  assert.equal(hidden('proj\\clip.mp4', 'win32'), false);
  // A short name that stands for a dot entry is caught on the file's real path instead.
  assert.equal(hidden('footage\\interview~2.mp4', 'win32'), false);
  assert.equal(hidden('footage/take~1.mov', 'win32'), false);
});

test('render: the page server compares a root and the state dir by their spelling on disk, not as typed', { skip: process.platform !== 'darwin' && 'needs a case-insensitive filesystem, the macOS default' }, async (t) => {
  const dir = scratch('case');
  const upper = dir.toUpperCase();
  if (!existsSync(upper) || realpathSync.native(upper) !== realpathSync.native(dir)) {
    t.skip('this volume is case-sensitive');
    return;
  }
  writeFileSync(join(dir, 'ok.txt'), 'ok');
  const state = join(dir, 'state');
  mkdirSync(state);
  writeFileSync(join(state, 'token.json'), '{}');
  const saved = process.env.OPENEDIT_STATE_DIR;
  process.env.OPENEDIT_STATE_DIR = state.toUpperCase();
  const server = await startPageServer({ roots: [upper] }).finally(() => {
    if (saved === undefined) delete process.env.OPENEDIT_STATE_DIR;
    else process.env.OPENEDIT_STATE_DIR = saved;
  });
  const get = async (file: string) => {
    const r = await fetch(server.urlFor(file));
    await r.arrayBuffer();
    return `${r.status} ${r.statusText}`;
  };
  try {
    assert.equal(await get(join(upper, 'ok.txt')), '200 OK', 'a root typed in another case still serves what is beneath it');
    assert.match(await get(join(upper, 'state', 'token.json')), /^403 The CLI state/, 'a state dir typed in another case is still refused');
  } finally {
    await server.close();
  }
});

test('render: no root exposes the home directory, an ancestor of it or the filesystem root unless a --root names it', () => {
  const base = scratch('home');
  const home = join(base, 'me');
  const proj = join(home, 'proj');
  mkdirSync(proj, { recursive: true });
  const served = (page: string, extra: string[], cwd: string, h = home) => pageRoots(page, extra, { cwd, home: h });

  const inside = served(join(proj, 'page.html'), [], proj);
  assert.deepEqual(inside.roots, [proj, proj], 'a project inside home serves its folder and the working directory');
  assert.deepEqual(inside.notes, []);

  assert.throws(() => served(join(home, 'page.html'), [], proj), /the page sits in .*your home directory.*--root/);
  assert.throws(() => served(join(base, 'page.html'), [], proj), /an ancestor of your home directory/);
  assert.throws(() => served('/page.html', [], proj), /the filesystem root/);

  assert.deepEqual(served(join(proj, 'page.html'), [], base).roots, [proj], 'a working directory above home is left out');
  assert.deepEqual(served(join(proj, 'page.html'), [], home, `${home}/`).roots, [proj], 'however home is spelled');
  assert.deepEqual(served(join(proj, 'page.html'), [], '/').roots, [proj], 'and so is the filesystem root');
  if (process.platform !== 'win32') {
    const link = join(base, 'home-link');
    symlinkSync(home, link);
    assert.deepEqual(served(join(proj, 'page.html'), [], home, link).roots, [proj], 'a home reached through a link is still home');
  }

  const asked = served(join(home, 'page.html'), [home], proj);
  assert.deepEqual(asked.roots, [home, proj, home], 'a --root that names home serves it');
  assert.match(asked.notes.join('\n'), /--root .* is your home directory; every script on the page can read/);
  assert.match(served(join(proj, 'page.html'), [base], proj).notes.join('\n'), /is an ancestor of your home directory/);
});

test('render: Chrome runs sandboxed everywhere, and without its sandbox only where that sandbox cannot start', async () => {
  const SEATBELT = 'sandbox initialization failed: Operation not permitted';
  const ROOT = 'Running as root without --no-sandbox is not supported.';
  const run = async (o: { platform: NodeJS.Platform; state: { starts?: Promise<boolean> }; sandboxed: 'works' | 'refused' | 'fails' | 'unasked'; why?: string }) => {
    const calls: boolean[] = [];
    const lines: string[] = [];
    let asked = 0;
    const launch = async (sandbox: boolean) => {
      calls.push(sandbox);
      if (sandbox && o.sandboxed !== 'works') throw new Error('Target crashed');
      return sandbox ? 'sandboxed' : 'bare';
    };
    const refused = async () => {
      asked++;
      if (o.sandboxed === 'unasked') throw new Error('Chrome would not start');
      return o.sandboxed === 'refused' ? o.why ?? (o.platform === 'darwin' ? SEATBELT : ROOT) : null;
    };
    const result = await withSandbox(launch, { platform: o.platform, state: o.state, say: (l) => lines.push(l), refused })
      .catch((e: Error) => `threw ${e.message}`);
    return { result, calls, lines, asked };
  };
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    assert.deepEqual(await run({ platform, state: {}, sandboxed: 'works' }), { result: 'sandboxed', calls: [true], lines: [], asked: 1 }, platform);
  }

  const state = {};
  const inside = await run({ platform: 'darwin', state, sandboxed: 'refused' });
  assert.deepEqual([inside.result, inside.calls], ['bare', [false]], 'the driver never launches a Chrome whose sandbox cannot start');
  assert.equal(inside.lines.length, 1);
  assert.match(inside.lines[0], /sandbox cannot start inside the sandbox this command runs in; running Chrome without it/);
  assert.deepEqual(await run({ platform: 'darwin', state, sandboxed: 'refused' }), { result: 'bare', calls: [false], lines: [], asked: 0 },
    'the next worker goes straight to the launch that works, and says nothing more');

  const unlisted = await run({ platform: 'darwin', state: {}, sandboxed: 'refused', why: 'Check failed: bootstrap_check_in' });
  assert.match(unlisted.lines[0], /cannot start here \(Check failed: bootstrap_check_in\); running Chrome without it, so nothing confines the page/,
    'on macOS an outer sandbox is claimed only when Chrome\'s refusal proves one');

  const container = await run({ platform: 'linux', state: {}, sandboxed: 'refused' });
  assert.deepEqual([container.result, container.calls], ['bare', [false]]);
  assert.match(container.lines[0], /cannot start here \(Running as root without --no-sandbox is not supported\.\); running Chrome without it, so nothing confines the page/,
    'off macOS no outer sandbox is claimed, and Chrome\'s own reason is passed on');

  const shared = {};
  const both = await Promise.all([run({ platform: 'darwin', state: shared, sandboxed: 'refused' }), run({ platform: 'darwin', state: shared, sandboxed: 'refused' })]);
  assert.deepEqual(both.map((r) => [r.calls, r.asked, r.lines.length]), [[[false], 1, 1], [[false], 0, 0]], 'workers opened together ask once and say it once');

  assert.deepEqual(await run({ platform: 'darwin', state: {}, sandboxed: 'fails' }), { result: 'threw Target crashed', calls: [true], lines: [], asked: 1 },
    'a failure Chrome does not put down to its sandbox is not retried without it');
  assert.deepEqual(await run({ platform: 'linux', state: {}, sandboxed: 'unasked' }), { result: 'threw Target crashed', calls: [true], lines: [], asked: 1 },
    'a Chrome that cannot be asked keeps its sandbox');
});

/**
 * A stand-in Chrome: with its sandbox it prints `refusal` and exits 1 (or, given `works`, starts; given
 * `flaky`, fails only its first start); without it, it starts unless `broken`.
 */
function fakeChrome(o: { refusal?: string; works?: boolean; broken?: boolean; flaky?: boolean; script?: string }): string {
  const dir = scratchDir('fake-chrome');
  const exe = join(dir, 'chrome');
  const page = 'echo "<html><head></head><body></body></html>"; exit 0';
  const sandboxed = o.script ?? (o.works ? page
    : o.flaky ? `if [ -e "${dir}/tried" ]; then ${page}; fi; touch "${dir}/tried"; echo '[1:1:ERROR:gpu.cc:1] GPU process crashed' >&2; exit 1`
      : `echo '${o.refusal ?? '[1:1:ERROR:launcher.cc:1] Failed to launch'}' >&2; exit 1`);
  writeFileSync(exe, `#!/bin/sh
case " $* " in *" --no-sandbox "*) ${o.broken ? 'echo "[1:1:ERROR:gpu.cc:1] GPU process crashed" >&2; exit 1' : page};; esac
${sandboxed}
`, { mode: 0o755 });
  return exe;
}

test('render: Chrome\'s refusal is read in each platform\'s words, and one never seen before still falls back', { skip: process.platform === 'win32' && 'needs a POSIX shell' }, async () => {
  assert.equal(await sandboxRefused(fakeChrome({ works: true })), null);
  assert.equal(await sandboxRefused(fakeChrome({ refusal: '[0929/121141.961593:ERROR:content/browser/zygote_host/zygote_host_impl_linux.cc:102] Running as root without --no-sandbox is not supported. See https://crbug.com/638180.' })),
    'Running as root without --no-sandbox is not supported. See https://crbug.com/638180.');
  assert.equal(await sandboxRefused(fakeChrome({ refusal: '[1:1:FATAL:zygote_host_impl_linux.cc:128] No usable sandbox! Update your kernel.' })), 'No usable sandbox! Update your kernel.');
  assert.equal(await sandboxRefused(fakeChrome({ refusal: '[1:1:FATAL:sandbox.mm:1] sandbox initialization failed: Operation not permitted' })), 'sandbox initialization failed: Operation not permitted');
  assert.equal(await sandboxRefused(fakeChrome({ refusal: '[1:1:FATAL:credentials.cc:1] Check failed: userns setup refused by the sandbox layer' })),
    'Check failed: userns setup refused by the sandbox layer', 'an unlisted refusal counts once Chrome starts without the sandbox');
  assert.equal(await sandboxRefused(fakeChrome({ broken: true })), null, 'a Chrome broken either way keeps its sandbox, so the real error surfaces');
  assert.equal(await sandboxRefused(fakeChrome({ flaky: true })), null, 'a failure that does not repeat never turns the sandbox off');

  // Chrome writes its refusal in two pieces and then hangs, as a zygote waiting on its children does.
  const split = fakeChrome({ script: `printf '[1:1:ERROR:zygote.cc:1] Running as root without --no-sandbox is not supported' >&2; sleep 0.3; printf '. See https://crbug.com/638180.\\n' >&2; sleep 30` });
  const started = Date.now();
  assert.equal(await sandboxRefused(split), 'Running as root without --no-sandbox is not supported. See https://crbug.com/638180.', 'the reason is read to the end of its line');
  assert.ok(Date.now() - started < 5_000, 'and a Chrome that hangs after it is not waited on');
});

test('render: of two renders that find the same dead holder, only one takes the lock, and neither removes the other\'s', () => {
  const dir = scratch('lock');
  const lock = join(dir, '.lock');
  const live = String(process.ppid);
  writeFileSync(lock, '2147483646');
  // Right after this render reads the dead holder, another takes the lock over first.
  const realRead = fs.readFileSync;
  let raced = false;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    const out = realRead(...args);
    if (!raced && args[0] === lock) {
      raced = true;
      fs.rmSync(lock);
      fs.writeFileSync(lock, live, { flag: 'wx' });
    }
    return out;
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => acquireLock(dir), new RegExp(`another render \\(pid ${live}\\)`));
  } finally {
    fs.readFileSync = realRead;
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(lock, 'utf8'), live, 'the render that took it over keeps it');
  assert.deepEqual(readdirSync(dir), ['.lock'], 'and nothing is left beside it');

  rmSync(lock);
  const release = acquireLock(dir);
  writeFileSync(lock, live);
  release();
  assert.equal(readFileSync(lock, 'utf8'), live, 'a release removes only a lock that is still its own');
});

test('render: Chrome is launched with the proxy server and bypass list, never the proxy\'s credentials', () => {
  assert.equal(launchProxy({}), undefined);
  const http = launchProxy({ HTTPS_PROXY: 'http://alice:s3cret@proxy.corp:3128', NO_PROXY: '.corp' });
  assert.deepEqual(http, { server: 'http://proxy.corp:3128', bypass: '.corp,127.0.0.1' });
  // The driver refuses to launch with credentials for a socks proxy at all.
  const socks = launchProxy({ HTTPS_PROXY: 'socks5://alice:s3cret@gw:1080' });
  assert.deepEqual(socks, { server: 'socks5://gw:1080', bypass: '127.0.0.1' });
  assert.doesNotMatch(JSON.stringify([http, socks]), /alice|s3cret/);
});

test('render: every flag refusal comes before Chrome is needed, with exit 2 and the reason', async () => {
  const dir = scratch('flags');
  const page = join(dir, 'page.html');
  writeFileSync(page, '<!doctype html><p>x</p>');
  const out = join(dir, 'out.mp4');
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const cases: [string[], RegExp][] = [
    [['--out', out, '--frames', '3'], /give exactly one page/],
    [[join(dir, 'nope.html'), '--out', out, '--frames', '3'], /nope\.html is not a file/],
    [[page, '--out', out, '--frames', '3', '--width', '320'], /give --width and --height together/],
    [[page, '--out', out, '--frames', '3', '--duration', '1'], /--duration or --frames, not both/],
    [[page, '--out', out], /give the length/],
    [[page, '--out', out, '--frames', '3', '--fps', '29.97'], /30000\/1001/],
    [[page, '--out', join(dir, 'out.avi'), '--frames', '3'], /must end in \.mp4 or \.mov/],
    [[page, '--out', out, '--frames', '3', '--transparent'], /needs a \.mov/],
    [[page, '--out', out, '--frames', '3', '--width', '321', '--height', '180'], /even width and height; got 321x180/],
    [[page, '--out', out, '--frames', '3', '--from', '0.05', '--to', '0.02'], /--to must be after --from/],
    [[page, '--out', out, '--frames', '3', '--from', '5'], /--from 5 is at or past the end/],
    [[page, '--out', out, '--frames', '3', '--segment', '0'], /--segment must be more than 0/],
    [[page, '--out', dir, '--sheet', join(dir, 's.jpg')], /--sheet tiles the --stills/],
    [[page, '--out', dir, '--stills', '1', '--from', '0'], /--stills renders no video/],
    [[page, '--out', out, '--frames', '3', '--root', join(dir, 'missing')], /--root .* is not a directory/],
  ];
  // A --chrome that is not there fails with exit 1 as soon as the browser is looked for, so a refusal
  // that came after that point would fail this test instead of downloading a browser.
  const noChrome = join(dir, 'no-chrome');
  const results = await Promise.all(cases.map(([args]) => new Promise<{ code: number | null; err: string }>((done) => {
    execFile(process.execPath, ['--import', 'tsx', cli, 'render', ...args, '--chrome', noChrome], { encoding: 'utf8' }, (e, _out, err) => done({ code: e ? (e.code as number) : 0, err }));
  })));
  results.forEach((r, i) => {
    assert.equal(r.code, 2, `${cases[i][0].join(' ')}: exit ${r.code}\n${r.err}`);
    assert.match(r.err, cases[i][1]);
  });
  assert.equal(existsSync(out), false);
});
