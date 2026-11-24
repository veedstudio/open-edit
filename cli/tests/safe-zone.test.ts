// Safe zones per shape and platform: the measured and published geometry, the stylesheet `safe-zone` writes, and what its
// container's defaults do to a page in the pinned headless Chrome. The browser tests are skipped when it is
// not installed (`openedit install-browser`), unless OPENEDIT_REQUIRE_BROWSER is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { FFMPEG } from '../src/config.ts';
import { chromePlatform, installedChrome } from '../src/render/browser.ts';
import { FORMATS, formatNamed, minText, stylesheet, zoneFor, type Format, type Size } from '../src/commands/safe-zone.ts';
import { facesScript, type FacesClip } from '../src/faces/page-script.ts';
import { readRecord, recordPath } from '../src/render/text-record.ts';
import { judgeText } from '../src/verify/text.ts';
import { scratchDir } from './helpers/synth.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const platform = chromePlatform();
const missing = platform && existsSync(installedChrome(platform)) ? null : 'Chrome Headless Shell is not installed (openedit install-browser)';
if (missing && process.env.OPENEDIT_REQUIRE_BROWSER) throw new Error(`${missing}, and OPENEDIT_REQUIRE_BROWSER is set`);
const skip = missing ?? false;

function cli(args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], { encoding: 'utf8', timeout: 240_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const rect = (z: { left: number; top: number; right: number; bottom: number }) => [z.left, z.top, z.right, z.bottom];

const TALL = { width: 1080, height: 1920 };
const WIDE = { width: 1920, height: 1080 };
const SQUARE = { width: 1080, height: 1080 };
const PORTRAIT = { width: 1080, height: 1350 };

// Every zone on its own canvas as [left, top, right, bottom], and the name (and canvas or --ad) that asks for it.
// Both sides take the larger side inset, so each zone is centred on the frame.
const ZONES: { label: string; name: string; opts?: { canvas?: Size; ad?: boolean }; canvas: Size; zone: number[] }[] = [
  // Ordinary 9:16 posts: TikTok's tabs (240) and caption block (442), the Reels button column (200) on both sides.
  { label: '9:16', name: '9:16', canvas: TALL, zone: [200, 240, 880, 1478] },
  { label: 'tiktok', name: 'tiktok', canvas: TALL, zone: [183, 240, 897, 1478] },
  { label: 'reels', name: 'reels', canvas: TALL, zone: [200, 206, 880, 1524] },
  { label: 'shorts', name: 'shorts', canvas: TALL, zone: [198, 221, 882, 1639] },
  // The ad zone, exactly the one 9:16 had before ordinary posts got their own: YouTube's Shorts ad margins (top 288,
  // bottom 672, right 192), the right one on both sides.
  { label: '9:16 ad', name: '9:16', opts: { ad: true }, canvas: TALL, zone: [192, 288, 888, 1248] },
  // YouTube's title row (166), control bar (143) and right margin (152) on both sides; 4:3 shares the bands, with 5%
  // title-safe sides.
  { label: '16:9', name: '16:9', canvas: WIDE, zone: [152, 166, 1768, 937] },
  { label: '4:3', name: '4:3', canvas: { width: 1440, height: 1080 }, zone: [72, 166, 1368, 937] },
  // Feed players: their bottom controls at a phone's width, title-safe (5%) elsewhere.
  { label: 'linkedin 16:9', name: 'linkedin', opts: { canvas: WIDE }, canvas: WIDE, zone: [96, 54, 1824, 791] },
  { label: 'x', name: 'x', canvas: WIDE, zone: [96, 54, 1824, 890] },
  { label: 'facebook 16:9', name: 'facebook', opts: { canvas: WIDE }, canvas: WIDE, zone: [96, 54, 1824, 863] },
  { label: '1:1', name: '1:1', canvas: SQUARE, zone: [54, 54, 1026, 918] },
  { label: 'instagram 1:1', name: 'instagram', opts: { canvas: SQUARE }, canvas: SQUARE, zone: [54, 54, 1026, 969] },
  { label: 'facebook 1:1', name: 'facebook', opts: { canvas: SQUARE }, canvas: SQUARE, zone: [54, 54, 1026, 958] },
  { label: 'linkedin 1:1', name: 'linkedin', opts: { canvas: SQUARE }, canvas: SQUARE, zone: [54, 54, 1026, 918] },
  { label: '4:5', name: '4:5', canvas: PORTRAIT, zone: [54, 68, 1026, 1188] },
  { label: 'instagram 4:5', name: 'instagram', opts: { canvas: PORTRAIT }, canvas: PORTRAIT, zone: [54, 68, 1026, 1239] },
  { label: 'facebook 4:5', name: 'facebook', opts: { canvas: PORTRAIT }, canvas: PORTRAIT, zone: [54, 68, 1026, 1228] },
  { label: 'linkedin 4:5', name: 'linkedin', opts: { canvas: PORTRAIT }, canvas: PORTRAIT, zone: [54, 68, 1026, 1188] },
];

test('safe-zone: each zone on its own canvas, under the name that asks for it', () => {
  assert.deepEqual(ZONES.map((c) => formatNamed(c.name, c.opts).name), ZONES.map((c) => c.label));
  for (const c of ZONES) assert.deepEqual(rect(zoneFor(formatNamed(c.name, c.opts), c.canvas)), c.zone, c.label);
  assert.equal(FORMATS.length, ZONES.length, 'every zone is in the table');
  for (const f of FORMATS) assert.equal(zoneFor(f, f.canvas).minText, 49, `${f.name} minimum on its own canvas`);
});

test('safe-zone: captions, cards and the hook step up from the floor in that order, on every zone and canvas', () => {
  const sizes = (z: { minText: number; captionText: number; cardText: number; hookText: number }) => [z.minText, z.captionText, z.cardText, z.hookText];
  // Full screen and a feed shown at a phone's full width read alike; a 16:9 feed's picture is shown smaller, so its
  // sizes are three steps up.
  for (const f of FORMATS) {
    const feed = ['linkedin 16:9', 'x', 'facebook 16:9'].includes(f.name);
    assert.deepEqual(sizes(zoneFor(f, f.canvas)), feed ? [49, 122, 147, 177] : [49, 71, 86, 104], f.name);
  }
  // The order holds by construction down to the smallest canvas of the shape, where rounding up could otherwise tie
  // two sizes.
  for (const f of FORMATS) {
    for (let k = 1; k <= 480; k++) {
      const canvas = { width: f.aspect.width * k, height: f.aspect.height * k };
      const [min, caption, card, hook] = sizes(zoneFor(f, canvas));
      assert.ok(min < caption && caption < card && card < hook, `${f.name} on ${canvas.width}x${canvas.height}: ${[min, caption, card, hook]}`);
    }
  }
  assert.deepEqual(sizes(zoneFor(formatNamed('9:16'), { width: 720, height: 1280 })), [33, 48, 58, 70]);
});

test('safe-zone: a shape\'s default lies inside each of its apps\' zones, and the ad zone is the same whichever app names it', () => {
  for (const shape of ['9:16', '1:1', '4:5']) {
    const d = zoneFor(formatNamed(shape), formatNamed(shape).canvas);
    for (const app of FORMATS.filter((f) => f.shape === shape && f.name !== shape && f.name !== '9:16 ad')) {
      const a = zoneFor(app, app.canvas);
      assert.ok(a.left <= d.left && a.top <= d.top && a.right >= d.right && a.bottom >= d.bottom, `${app.name} ${rect(a)} holds ${shape} ${rect(d)}`);
    }
  }
  for (const [name, opts] of [['tiktok', {}], ['Reels', {}], ['shorts', {}], ['9x16', {}], ['youtube', { canvas: TALL }], ['instagram', { canvas: TALL }]] as const) {
    assert.deepEqual(rect(zoneFor(formatNamed(name, { ...opts, ad: true }), TALL)), [192, 288, 888, 1248], name);
  }
  for (const name of ['16:9', 'youtube', '1:1', '4:3']) {
    assert.throws(() => formatNamed(name, { ad: true }), /--ad asks for the 9:16 ad zone, and "[^"]+" is [0-9:]+, which has no separate ad zone/, name);
  }
});

test('safe-zone: shell spellings, apps posted in one shape, and apps posted in several, which take the canvas', () => {
  for (const [name, zone] of [['9x16', '9:16'], ['16x9', '16:9'], ['4x3', '4:3'], ['1x1', '1:1'], ['4X5', '4:5'], ['TikTok', 'tiktok'], ['twitter', 'x'], ['youtube', '16:9']]) {
    assert.equal(formatNamed(name).name, zone, name);
  }
  // On a 9:16 canvas the apps that post Reels and Shorts mean those.
  assert.equal(formatNamed('instagram', { canvas: TALL }).name, 'reels');
  assert.equal(formatNamed('facebook', { canvas: { width: 720, height: 1280 } }).name, 'reels');
  assert.equal(formatNamed('youtube', { canvas: TALL }).name, 'shorts');
  // Footage sized to a 16-pixel grid still picks its shape.
  assert.equal(formatNamed('instagram', { canvas: { width: 1088, height: 1360 } }).name, 'instagram 4:5');
  assert.throws(() => formatNamed('instagram'), new RegExp('instagram is posted as 9:16 \\(a Reel\\), 1:1 or 4:5, each with its own zone: name reels for a Reel, '
    + 'or name the feed shape \\(1:1 or 4:5\\), or pass --canvas with the piece\'s size \\(1080x1920, 1080x1080 or 1080x1350\\)'));
  assert.throws(() => formatNamed('linkedin'), /linkedin is posted as 16:9, 1:1 or 4:5, each with its own zone: name the feed shape \(1:1 or 4:5\), or pass --canvas/);
  assert.throws(() => formatNamed('instagram', { canvas: WIDE }), /a 1920x1080 canvas is none of the shapes instagram has a zone for: 9:16 \(1080x1920\), 1:1 \(1080x1080\), 4:5 \(1080x1350\)/);
  assert.throws(() => zoneFor(formatNamed('tiktok', { canvas: SQUARE }), SQUARE), /a 1080x1080 canvas is not 9:16/);
  assert.throws(() => formatNamed('vine'), /"vine" names no safe-zone format, so a page of a shape with none \(2:3 or 21:9, say\) skips this step; the names are 9:16, 16:9, 4:3, 1:1, 4:5, tiktok/);
  for (const name of ['2:3', 'constructor', 'toString']) assert.throws(() => formatNamed(name), /names no safe-zone format/, name);
});

test('safe-zone: an app named with its shape is that shape\'s zone of the app, with no canvas needed', () => {
  for (const [name, zone] of [['linkedin 16:9', 'linkedin 16:9'], ['Facebook 1x1', 'facebook 1:1'], ['instagram  4:5', 'instagram 4:5'],
    ['instagram 9:16', 'reels'], ['youtube 9:16', 'shorts'], ['twitter 16:9', 'x'], ['tiktok 9:16', 'tiktok']]) {
    assert.equal(formatNamed(name).name, zone, name);
  }
  assert.throws(() => formatNamed('tiktok 1:1'), /^Error: tiktok has no 1:1 zone: it is posted as 9:16$/);
  // A canvas of another shape than the one named is refused where the zone is laid on it.
  assert.throws(() => zoneFor(formatNamed('linkedin 1:1', { canvas: WIDE }), WIDE), /a 1920x1080 canvas is not 1:1/);
  assert.throws(() => formatNamed('linkedin'), /or name linkedin with its shape \("linkedin 16:9", "linkedin 1:1" or "linkedin 4:5"\)/);
});

test('safe-zone: another canvas of the shape scales the zone and rounds it inward; another shape is refused', () => {
  const z = zoneFor(formatNamed('9:16'), { width: 720, height: 1280 });
  assert.deepEqual(rect(z), [134, 160, 586, 985]);
  assert.equal(z.minText, 33);
  assert.deepEqual(rect(zoneFor(formatNamed('9:16', { ad: true }), { width: 720, height: 1280 })), [128, 192, 592, 832]);
  assert.deepEqual(rect(zoneFor(formatNamed('instagram', { canvas: { width: 720, height: 900 } }), { width: 720, height: 900 })), [36, 46, 684, 826]);
  assert.equal(minText({ width: 1920, height: 1080 }), 49);
  // Footage sized to a 16-pixel grid is still 9:16.
  assert.doesNotThrow(() => zoneFor(formatNamed('9:16'), { width: 1088, height: 1920 }));
  assert.throws(() => zoneFor(formatNamed('9:16'), { width: 1920, height: 1080 }), /a 1920x1080 canvas is not 9:16/);
});

test('safe-zone: the command writes the stylesheet for a platform, and refuses a canvas of another shape', () => {
  const dir = scratchDir('safe-zone-cmd');
  const r = cli(['safe-zone', 'tiktok', '--out', dir]);
  assert.equal(r.code, 0, r.err);
  const css = readFileSync(join(dir, 'safe-zone.css'), 'utf8');
  assert.match(css, /^\/\* openedit safe-zone tiktok: TikTok, on a 1080x1920 canvas\./);
  assert.match(css, /\[data-safe-zone="9:16"\] \{\n {2}position: relative;\n {2}width: 1080px;\n {2}height: 1920px;/);
  assert.match(css, /\[data-safe-zone="9:16"\] \[data-safe\] \{\n {2}position: absolute;\n {2}left: 183px;\n {2}top: 240px;\n {2}width: 714px;\n {2}height: 1238px;/);
  assert.match(css, /--min-text: 49px;\n {2}--caption-text: 71px;\n {2}--card-text: 86px;\n {2}--hook-text: 104px;\n\}/);
  assert.match(r.out, /text sizes: captions 71 px, where a data-captions track starts unless the page sizes it, cards 86 px, hook 104 px \(--caption-text, --card-text, --hook-text\)/);
  // Only the container's place is specific; every default after it has no specificity, so the page's rules win.
  assert.match(css, /height: 1238px;\n {2}box-sizing: border-box;\n {2}container-type: size;\n\}/);
  assert.match(css, /:where\(\[data-safe-zone="9:16"\] \[data-safe\]\) \{\n {2}font-size: var\(--min-text\);\n {2}overflow-wrap: break-word;/);
  assert.match(css, /:where\(\[data-safe-zone="9:16"\] \[data-safe\]\) :where\(\[data-captions\]\) \{\n {2}font-size: var\(--caption-text\);\n\}/);
  assert.doesNotMatch(css, /overflow:\s*(clip|hidden)/, 'the container never clips: clipping would truncate text silently');
  assert.match(r.out, /text area: 714x1238 at 183,240, clear of 240 px at the top, 442 at the bottom, 183 on the left and 183 on the right/);
  assert.match(r.out, /data-safe-zone="9:16"/);

  // The ad zone writes exactly the stylesheet 9:16 wrote before ordinary posts got their own zone.
  const ad = cli(['safe-zone', '9:16', '--ad', '--out', dir]);
  assert.equal(ad.code, 0, ad.err);
  assert.match(readFileSync(join(dir, 'safe-zone.css'), 'utf8'),
    /\[data-safe-zone="9:16"\] \[data-safe\] \{\n {2}position: absolute;\n {2}left: 192px;\n {2}top: 288px;\n {2}width: 696px;\n {2}height: 960px;/);
  assert.match(ad.out, /safe-zone: 9:16 ad \(ads on TikTok, Instagram and Facebook Reels, and YouTube Shorts\), 1080x1920/);
  assert.match(ad.out, /text area: 696x960 at 192,288, clear of 288 px at the top, 672 at the bottom, 192 on the left and 192 on the right/);

  // An app posted in several shapes takes the canvas, and the stage is marked with that shape.
  const feed = cli(['safe-zone', 'instagram', '--out', dir, '--canvas', '1080x1350']);
  assert.equal(feed.code, 0, feed.err);
  assert.match(readFileSync(join(dir, 'safe-zone.css'), 'utf8'), /\[data-safe-zone="4:5"\] \[data-safe\] \{\n {2}position: absolute;\n {2}left: 54px;\n {2}top: 68px;\n {2}width: 972px;\n {2}height: 1171px;/);
  assert.match(feed.out, /data-safe-zone="4:5"/);
  const bare = cli(['safe-zone', 'instagram', '--out', dir]);
  assert.equal(bare.code, 1);
  assert.match(bare.err, /name reels for a Reel, or name the feed shape \(1:1 or 4:5\), or pass --canvas/);

  const wrong = cli(['safe-zone', '9:16', '--out', dir, '--canvas', '1920x1080']);
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /a 1920x1080 canvas is not 9:16/);
  assert.equal(cli(['safe-zone', 'vine', '--out', dir]).code, 1);
  assert.equal(cli(['safe-zone', '16:9', '--ad', '--out', dir]).code, 1);
});

/** A page linking the stylesheet `safe-zone` writes for a zone, the stage black and its text white, with no layout of its own. */
function zonePage(dir: string, name: string, format: Format, canvas: Size, body: string, style = ''): string {
  writeFileSync(join(dir, 'safe-zone.css'), stylesheet(zoneFor(format, canvas)));
  const file = join(dir, name);
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="safe-zone.css"><style>
html,body{margin:0;background:#000}
#stage{background:#000;color:#fff;font-family:Arial,sans-serif}
${style}</style></head><body><div id="stage" data-safe-zone="${format.shape}">${body}</div></body></html>`);
  return file;
}

/** The box around every pixel of a still that `keep` accepts, as [left, top, right, bottom]. */
function pixelBox(png: string, width: number, height: number, keep: (r: number, g: number, b: number) => boolean): number[] {
  const px = execFileSync(FFMPEG, ['-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 });
  let [left, top, right, bottom] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (!keep(px[i], px[i + 1], px[i + 2])) continue;
      left = Math.min(left, x);
      right = Math.max(right, x + 1);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y + 1);
    }
  }
  return [left, top, right, bottom];
}

for (const c of ZONES) {
  test(`render: the ${c.label} container sits on the zone, and unstyled text inside it stays inside it`, { skip }, () => {
    const dir = scratchDir(`safe-zone-${c.label.replace(/[: ]/g, '-')}`);
    const { width: w, height: h } = c.canvas;
    // One still per zone, measured off the picture rather than the stylesheet: the container's border drawn in pure
    // blue, and inside it a heading of one word longer than any line and a paragraph over several lines in white,
    // with no layout of their own.
    const word = 'Unbreakable'.repeat(4);
    const prose = 'Cut the first second, because nobody waits for a slow open on a feed.';
    const page = zonePage(dir, 'zone.html', formatNamed(c.name, c.opts), c.canvas,
      `<div data-safe style="border:2px solid #00f"><h1>${word}</h1><p>${prose}</p></div>`);
    const r = cli(['render', page, '--out', join(dir, 'still'), '--stills', '0']);
    assert.equal(r.code, 0, r.err);
    const still = join(dir, 'still', 'f000000-0.000s.png');
    assert.deepEqual(pixelBox(still, w, h, (red, green, blue) => blue > 200 && red < 40 && green < 40), c.zone);
    // Every glyph the defaults set lands inside the container.
    const [l, t, right, b] = pixelBox(still, w, h, (red) => red > 40);
    assert.ok(right > l && b > t, 'the text was drawn');
    assert.ok(l >= c.zone[0] && t >= c.zone[1] && right <= c.zone[2] && b <= c.zone[3], `glyphs at ${[l, t, right, b]}, zone ${c.zone}`);
  });
}

/** What Chrome makes of a page: `measure` is a page-side expression, given as a string because the test's
 * transpiler wraps functions in helpers the page does not have. */
async function inChrome(page: string, measure: string): Promise<unknown> {
  const browser = await chromium.launch({ executablePath: installedChrome(platform!), headless: true });
  try {
    const tab = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    await tab.goto(pathToFileURL(page).href);
    return await tab.evaluate(measure);
  } finally {
    await browser.close();
  }
}

test('browser: the defaults set unsized text at the minimum and lose to any rule the page writes', { skip }, async () => {
  const dir = scratchDir('safe-zone-defaults');
  const canvas = { width: 1080, height: 1920 };
  const size = 'const size = (id) => getComputedStyle(document.getElementById(id)).fontSize;';
  // Unsized text, and the elements a browser sets smaller, start at the minimum; cqw and cqh measure the zone; the
  // caption, card and hook sizes reach text inside the container, and an unsized caption track and its words start
  // at the caption size.
  const floor = zonePage(dir, 'floor.html', formatNamed('9:16'), canvas,
    '<div data-safe><p id="plain">Plain</p><small id="small">Small</small><h6 id="h6">Six</h6><button id="button" style="background:#fff;padding:8px">Go</button>'
    + '<h1 id="head">Head</h1><p id="sized" style="font-size:max(var(--min-text), 10cqw)">Sized</p><div id="full" style="width:100cqw;height:100cqh"></div>'
    + '<p id="caption" style="font-size:var(--caption-text)">Caption</p><p id="card" style="font-size:var(--card-text)">Card</p><p id="hook" style="font-size:var(--hook-text)">Hook</p>'
    + '<div data-captions id="track"><div data-cue="0"><div data-line="0"><span data-word="0" id="word">Said</span></div></div></div></div>');
  assert.deepEqual(await inChrome(floor, `(() => { ${size} const r = document.getElementById('full').getBoundingClientRect();
    return [size('plain'), size('small'), size('h6'), size('button'), size('head'), size('sized'), r.width, r.height, size('caption'), size('card'), size('hook'), size('track'), size('word')]; })()`),
  ['49px', '49px', '49px', '49px', '98px', '68px', 680, 1238, '71px', '86px', '104px', '71px', '71px']);

  // A size the page sets on the container, by element or by class, wins; its place on the zone holds. The caption
  // track keeps its own size, which only a rule for the track or its words changes.
  for (const css of ['[data-safe]{font-size:48px}', '.cap{font-size:48px;top:auto;bottom:100px;height:200px}']) {
    const page = zonePage(dir, 'own.html', formatNamed('9:16'), canvas, '<div data-safe class="cap"><p id="plain">Plain</p><div data-captions id="track"></div></div>', css);
    assert.deepEqual(await inChrome(page, `(() => { ${size} const r = document.querySelector('[data-safe]').getBoundingClientRect();
      return [size('plain'), size('track'), r.top, r.height]; })()`), ['48px', '71px', 240, 1238], css);
  }
  const tracks: [css: string, sizes: string[]][] = [['[data-captions]{font-size:60px}', ['60px', '60px']], ['.track [data-word]{font-size:90px}', ['71px', '90px']]];
  for (const [css, want] of tracks) {
    const page = zonePage(dir, 'track.html', formatNamed('9:16'), canvas,
      '<div data-safe><div data-captions class="track" id="track"><span data-word="0" id="word">Said</span></div></div>', css);
    assert.deepEqual(await inChrome(page, `(() => { ${size} return [size('track'), size('word')]; })()`), want, css);
  }
});

test('browser: text left at the defaults, or sized no smaller than the minimum, passes the review\'s size check', { skip }, async () => {
  const dir = scratchDir('safe-zone-review');
  // On a 360 px side the zone is 226 px wide, so 6cqw is 13.6 px and the minimum is what holds the size up.
  const page = zonePage(dir, 'defaults.html', formatNamed('9:16'), { width: 360, height: 640 },
    '<div data-safe><p>Plain text</p><small>Small print</small><h6>Sixth heading</h6>'
    + '<p style="font-size:max(var(--min-text), 6cqw)">Sized in cqw</p></div>');
  const out = join(dir, 'out.mp4');
  const r = cli(['render', page, '--out', out, '--fps', '30', '--duration', '0.5']);
  assert.equal(r.code, 0, r.err);
  const record = readRecord(recordPath(out));
  assert.deepEqual(record.samples[0].texts.map((e) => e.text).sort(), ['Plain text', 'Sixth heading', 'Sized in cqw', 'Small print']);
  const report = await judgeText(out, { path: recordPath(out), record });
  assert.doesNotMatch(report.lines.join('\n'), /smaller than a phone's body text/, report.lines.join('\n'));
});

test('browser: boxes inside keep within the container unless they ask not to, a ticker runs whole, pictures keep their shape, an svg its size', { skip }, async () => {
  const dir = scratchDir('safe-zone-boxes');
  const page = zonePage(dir, 'boxes.html', formatNamed('9:16'), { width: 1080, height: 1920 }, '<div data-safe>'
    + '<div id="wide" style="width:900px;height:10px"></div>'
    + '<div id="free" style="width:900px;height:10px;max-width:none"></div>'
    + '<img id="img" width="1000" height="500" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221000%22 height=%22500%22/%3E">'
    + '<svg id="svg" width="1000" height="100"><text x="10" y="60" font-size="40" fill="#fff">An svg drawn wider than the zone</text></svg>'
    // Word spans in a row that wraps: each word stays on one line, whatever its length.
    + '<div id="row" style="display:flex;flex-wrap:wrap;gap:12px;font-size:64px">'
    + 'Everything about this caption is one word per span'.split(' ').map((w) => `<span>${w}</span>`).join('')
    + '</div>'
    // Three headlines on a ticker's track, as the help says to build one: each keeps its own width, side by side.
    + '<div id="ticker" style="display:flex;gap:40px;white-space:nowrap;width:max-content;max-width:none;font-size:48px">'
    + '<span>Markets rally on the open</span><span>Rates hold for a third month</span><span>Storm heads up the coast</span>'
    // The same track left at the container's width: its headlines run past it rather than squeezing into it.
    + '</div><div class="ticker" style="display:flex;gap:40px;white-space:nowrap;max-width:none;font-size:48px">'
    + '<span>Markets rally on the open</span><span>Rates hold for a third month</span><span>Storm heads up the coast</span>'
    + '</div></div>');
  const got = await inChrome(page, `(() => {
    const box = (id) => document.getElementById(id).getBoundingClientRect();
    const spans = [...document.querySelectorAll('#row span')];
    const oneLine = spans.every((s) => s.getClientRects().length === 1 && Math.round(s.getBoundingClientRect().height) <= 80);
    const range = document.createRange();
    const apart = ['#ticker span', '.ticker span'].map((sel) => [...document.querySelectorAll(sel)]).every((heads) => heads.every((h, i) => {
      range.selectNodeContents(h);
      const text = range.getBoundingClientRect();
      const next = heads[i + 1];
      return text.right <= h.getBoundingClientRect().right + 1 && (!next || h.getBoundingClientRect().right <= next.getBoundingClientRect().left);
    }));
    return { wide: box('wide').width, free: box('free').width, img: [box('img').width, box('img').height], svg: box('svg').width, oneLine, apart };
  })()`);
  assert.deepEqual(got, { wide: 680, free: 900, img: [680, 340], svg: 1000, oneLine: true, apart: true });
});

/** A page with no safe-zone stylesheet: a 1080x1920 stage, black, its text white. */
function bare(dir: string, name: string, body: string, style = '', script = ''): string {
  const file = join(dir, name);
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#000}
#stage{position:relative;width:1080px;height:1920px;background:#000;color:#fff;font-family:Arial,sans-serif}
.at{position:absolute;left:100px}
${style}</style></head><body><div id="stage">${body}</div>${script}</body></html>`);
  return file;
}

const sizes = (out: string, frame: number) =>
  Object.fromEntries(readRecord(recordPath(out)).samples.find((s) => s.frame === frame)!.texts.map((e) => [e.text, e.fontSize]));

test('render: text under the floor is drawn at it, as a minimum, from the frame it appears in; --no-text-floor keeps the page\'s size', { skip }, async () => {
  const dir = scratchDir('text-floor');
  // A 32 px caption, a 64 px title, an arrow and an svg label under the floor, a line set in __seek, and one whose
  // class grows it past the floor partway.
  const page = bare(dir, 'floor.html',
    '<div class="at" style="top:1500px;font-size:32px">A caption at 32 px</div><div class="at" style="top:300px;font-size:64px">A title at 64 px</div>'
    + '<div class="at" style="top:500px;font-size:20px">→</div><div class="at" id="later" style="top:700px;font-size:30px"></div>'
    + '<div class="at grow" style="top:900px">Grows</div>'
    + '<svg style="position:absolute;left:100px;top:1100px" width="200" height="60"><text x="0" y="40" font-size="30" fill="#fff">svg label</text></svg>',
    '.grow{font-size:30px}.grow.on{font-size:80px}',
    '<script>window.__seek=(t)=>{document.getElementById(\'later\').textContent=t>=0.1?\'Set later\':\'\';document.querySelector(\'.grow\').classList.toggle(\'on\',t>=0.2);};</script>');
  const out = join(dir, 'out.mp4');
  const r = cli(['render', page, '--out', out, '--fps', '10', '--duration', '0.4']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(sizes(out, 0), { 'A caption at 32 px': 49, 'A title at 64 px': 64, '→': 20, 'Grows': 49, 'svg label': 30 });
  assert.deepEqual(sizes(out, 3), { 'A caption at 32 px': 49, 'A title at 64 px': 64, '→': 20, 'Set later': 49, 'Grows': 80, 'svg label': 30 });
  assert.match(r.out, /\n {2}text: raised 3 element\(s\) to 49 px, the floor for this canvas: "A caption at 32 px", "Grows", "Set later"\n/);
  const report = await judgeText(out, { path: recordPath(out), record: readRecord(recordPath(out)) });
  assert.doesNotMatch(report.lines.join('\n'), /smaller than a phone's body text/, report.lines.join('\n'));

  const kept = join(dir, 'kept.mp4');
  const k = cli(['render', page, '--out', kept, '--fps', '10', '--duration', '0.4', '--no-text-floor']);
  assert.equal(k.code, 0, k.err);
  assert.equal(sizes(kept, 0)['A caption at 32 px'], 32);
  assert.doesNotMatch(k.out, /text: raised/);
  // A patch keeps the floor of the render it patches, so one asked without it is refused rather than spliced in.
  const mixed = cli(['render', page, '--out', out, '--fps', '10', '--duration', '0.4', '--from', '0.2', '--no-text-floor']);
  assert.equal(mixed.code, 2, mixed.err);
  assert.match(mixed.err, /textFloor 49 → undefined/);
});

test('render: text whose transition covers font-size is held at the floor in every frame on every worker, and the page\'s own transitions still run', { skip }, () => {
  const dir = scratchDir('text-floor-transition');
  // One line twice, plain and under transition: all, caption words under one, and a line set in __seek under one. At
  // 0.5 s the words fade in and a 60 px title grows by their own linear 0.3 s transitions.
  const page = bare(dir, 'transition.html',
    '<div class="at" id="plain" style="top:300px;font-size:32px">Held at the floor</div>'
    + '<div class="at t" id="eased" style="top:600px;font-size:32px">Held at the floor</div>'
    + '<div class="at" id="words" style="top:900px;font-size:32px"><span class="t">Word</span> <span class="t">by</span> <span class="t">word</span></div>'
    + '<div class="at t" id="later" style="top:1200px;font-size:30px"></div><div class="at" id="big" style="top:1500px">Big</div>',
    '.t{transition:all .3s linear}#words .t{opacity:.2}#words.on .t{opacity:1}#big{font-size:60px;transition:font-size .3s linear}#big.on{font-size:90px}',
    '<script>window.__seek=(t)=>{document.getElementById(\'later\').textContent=t>=1.3?\'Set later\':\'\';'
    + 'for(const id of [\'words\',\'big\'])document.getElementById(id).classList.toggle(\'on\',t>=0.5);};</script>');
  const along = (f: number) => Math.min(Math.max(f - 5, 0) / 3, 1);
  const want = (f: number) => [
    '#plain 49 1', '#eased 49 1',
    ...[1, 2, 3].map((k) => `#words>span:nth-child(${k}) 49 ${Math.round((0.2 + 0.8 * along(f)) * 100) / 100}`),
    ...(f >= 13 ? ['#later 49 1'] : []), `#big ${60 + 30 * along(f)} 1`,
  ].sort();
  for (const workers of [1, 3]) {
    const out = join(dir, `w${workers}.mp4`);
    const r = cli(['render', page, '--out', out, '--fps', '10', '--duration', '3.6', '--workers', String(workers)]);
    assert.equal(r.code, 0, r.err);
    const record = readRecord(recordPath(out));
    assert.deepEqual(record.samples.map((s) => s.texts.map((e) => `${e.selector} ${e.fontSize} ${e.opacity}`).sort()),
      record.samples.map((s) => want(s.frame)), `${workers} worker(s)`);
    // The record reads the style after the capture, so the picture is measured too: the eased line's ink as wide as
    // the plain one's in every frame.
    const band = 400;
    const px = execFileSync(FFMPEG, ['-v', 'error', '-i', out, '-vf', `crop=1080:${band}:0:290`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 });
    const ink = (f: number, y0: number) => {
      let [left, right] = [1080, -1];
      for (let y = y0; y < y0 + 90; y++) {
        for (let x = 0; x < 1080; x++) if (px[(f * band + y) * 1080 + x] > 128) [left, right] = [Math.min(left, x), Math.max(right, x)];
      }
      return right - left + 1;
    };
    const frames = [...Array(px.length / (1080 * band)).keys()];
    assert.equal(frames.length, 36);
    assert.deepEqual(frames.map((f) => ink(f, 300)), frames.map((f) => ink(f, 0)), `${workers} worker(s)`);
  }
});

test('render: a raised text that wraps or runs past its box is named', { skip }, () => {
  const dir = scratchDir('text-floor-reflow');
  const page = bare(dir, 'reflow.html',
    '<div class="at" style="top:300px;width:300px;font-size:30px">Three short words</div>'
    + '<div class="at" style="top:600px;width:150px;font-size:30px;white-space:nowrap">Unbroken</div>'
    + '<div class="at" style="top:900px;font-size:30px">Room to spare</div>'
    // Raised, this one runs past the box drawn behind it, where it is wrapped: on more lines, and not past its box.
    + '<div class="at" style="top:1200px;width:200px;font-size:30px;white-space:nowrap;background:#333">Two words</div>');
  const r = cli(['render', page, '--out', join(dir, 'still'), '--stills', '0']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /text: raised 4 element\(s\) to 49 px, the floor for this canvas: "Three short words", "Unbroken", "Room to spare", "Two words"; 2 now run onto more lines: "Three short words", "Two words"; 1 now runs past its box or the stage: "Unbroken"\n {2}text: wrapped 1 line\(s\) the page set not to wrap, inside the box drawn behind it, which it ran past: "Two words"\n/);
});

const LONG = 'far too long to stay on one line of this zone';
// Text at 60 px in the 680 px 9:16 zone, where a pill holding LONG is narrowed to the zone and its line runs past it.
const PILLS = '[data-safe]{font-size:60px;line-height:1}.row{display:flex;justify-content:center}.pill{display:inline-block;white-space:nowrap;background:#333;padding:10px 30px}';
/** Each text of a frame by its first word: its glyphs' left and right, and how many 60 px lines they stand on. */
const linesAt = (out: string, frame: number) => Object.fromEntries(readRecord(recordPath(out)).samples.find((s) => s.frame === frame)!.texts
  .map((e) => [e.text.split(' ')[0], { left: e.box[0], right: e.box[0] + e.box[2], lines: Math.round(e.box[3] / 60) }]));

test('render: a line set not to wrap that runs past the box drawn behind it wraps inside that box, which keeps its width', { skip }, () => {
  const dir = scratchDir('text-in-box');
  // A pill in a centred row, its text in a wrapper with a background of no opacity, a pill centred by its own
  // position, a line in a card, a caption of word spans and a line set in __seek that later fits, each wider than the
  // zone lets its box be. Beside them, lines the render leaves alone: one that fits, one its box clips, one placed
  // out of the flow of its box, and one in a band whose edges are the stage's.
  const page = zonePage(dir, 'box.html', formatNamed('9:16'), TALL,
    `<div data-safe><div class="row"><span class="pill" id="row" style="background:#f00"><span style="display:inline-block;background:oklch(0.5 0.1 30 / 0)">Row ${LONG}</span></span></div>`
    + `<span class="pill" id="own" style="position:absolute;left:50%;top:400px;transform:translateX(-50%);background:#00f">Own ${LONG}</span>`
    + `<div class="card" style="margin-top:500px"><div>Card</div><div id="line" style="white-space:nowrap">Line ${LONG}</div></div>`
    + `<div class="row"><span class="pill" id="words">${`Words ${LONG}`.split(' ').map((w) => `<span>${w}</span>`).join(' ')}</span></div>`
    + '<div class="row"><span class="pill" id="later"></span></div>'
    + '<div class="row"><span class="pill" id="fits">Fits</span></div>'
    + `<div class="card" style="overflow:hidden;white-space:nowrap" id="clipped">Clipped ${LONG}</div>`
    + `<div class="card" style="position:relative;height:80px"><div id="placed" style="position:absolute;left:0;top:0;white-space:nowrap">Placed ${LONG}</div></div></div>`
    + `<div class="card" id="band" style="position:absolute;left:0;right:0;bottom:0;white-space:nowrap">Band ${LONG} and off the stage it goes</div>`
    + `<script>window.__seek=(t)=>{document.getElementById('later').textContent=t<0.2?'Later ${LONG}':'Later';};</script>`,
    `${PILLS}.card{background:#222;padding:10px 30px;font-size:60px;line-height:1}`);
  const out = join(dir, 'out.mp4');
  const r = cli(['render', page, '--out', out, '--fps', '10', '--duration', '0.4']);
  assert.equal(r.code, 0, r.err);
  const first = linesAt(out, 0);
  for (const id of ['Row', 'Own', 'Line', 'Later']) {
    assert.ok(first[id].right <= 880 - 30 && first[id].lines > 1, `${id}: ${JSON.stringify(first[id])}`);
  }
  // The caption's words wrap between the spans, each still whole on its own line.
  const words = readRecord(recordPath(out)).samples[0].texts.filter((e) => e.selector.startsWith('#words>'));
  assert.equal(words.length, 12);
  assert.ok(words.every((e) => e.box[0] + e.box[2] <= 880 - 30 && Math.round(e.box[3] / 60) === 1), JSON.stringify(words.map((e) => e.box)));
  assert.ok(new Set(words.map((e) => e.box[1])).size > 1, 'the words sit on more than one line');
  assert.deepEqual([first.Fits.lines, first.Clipped.lines, first.Placed.lines, first.Band.lines], [1, 1, 1, 1]);
  assert.ok(first.Placed.right > 880 && first.Band.right === 1080, JSON.stringify([first.Placed, first.Band]));
  // The line set shorter in __seek fits again: on one line, in a pill let go of the width it was held at, so centred.
  const later = linesAt(out, 2).Later;
  assert.ok(later.lines === 1 && Math.abs(later.left + later.right - 1080) <= 2, JSON.stringify(later));
  // Each line is named once and whole, the caption by all of its words: those wrapped as the page loaded, then the one set in __seek.
  assert.ok(r.out.includes('\n  text: wrapped 5 line(s) the page set not to wrap, inside the box drawn behind each, which they ran past: '
    + `"Line ${LONG}", "Own ${LONG}", "Row ${LONG}", "Words ${LONG}", "Later ${LONG}"\n`), r.out);

  // Each pill is as wide as the zone let it be, the one sized by its own position too; the size floor plays no part.
  const s = cli(['render', page, '--out', join(dir, 'still'), '--stills', '0', '--no-text-floor']);
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /\n {2}text: wrapped 5 line\(s\)/);
  const still = join(dir, 'still', 'f000000-0.000s.png');
  const sides = (box: number[]) => [box[0], box[2]];
  assert.deepEqual(sides(pixelBox(still, 1080, 1920, (red, green, blue) => red > 200 && green < 40 && blue < 40)), [200, 880]);
  assert.deepEqual(sides(pixelBox(still, 1080, 1920, (red, green, blue) => blue > 200 && red < 40 && green < 40)), [200, 880]);
});

test('render: a line wraps by where the page lays it out, all through an entrance and a transition that move it; not where a transform fits it or carries it out of a box it fits, nor in a box that would not hold it; and the page\'s scripts read the page\'s own layout', { skip }, () => {
  const dir = scratchDir('text-in-box-moving');
  // A pill with a border alone, one sliding in across the stage's right edge, words that scale up from nothing one
  // after another, a pill in a wrapper that a transition of the page's own carries across from 0.1 s, a word a
  // transform carries out of a pill it fits, a label on a bar narrower than it and one line high, a line scaled
  // down to fit its card, and a pill whose label goes from long to short at 0.3 s, its width read in __seek.
  const page = zonePage(dir, 'moving.html', formatNamed('9:16'), TALL,
    `<div data-safe><div class="row"><span class="pill" id="edge" style="background:none;border:4px solid #fff">Edge ${LONG}</span></div>`
    + `<div class="row"><span class="pill" id="slide">Slide ${LONG}</span></div>`
    + `<div class="row"><span class="pill" id="pop">${`Pop ${LONG}`.split(' ').map((w) => `<span>${w}</span>`).join(' ')}</span></div>`
    + `<div id="ease"><span class="pill" id="eased" style="max-width:400px">Eased ${LONG}</span></div>`
    + '<div class="row"><span class="pill"><span id="carried">Carried</span></span></div>'
    + '<div style="width:200px;height:70px;background:#333;white-space:nowrap">Bar label over it</div>'
    + `<div style="width:400px;background:#333"><span id="fitted">Fitted ${LONG}</span></div>`
    + '<div class="row"><span class="pill" id="cue"></span></div><div id="read"></div></div>'
    + `<script>window.__seek=(t)=>{const cue=document.getElementById('cue');cue.textContent=t<0.25?'Cue ${LONG}':'Cue';`
    + 'document.getElementById(\'read\').textContent=\'W\'+cue.offsetWidth;document.getElementById(\'ease\').classList.toggle(\'on\',t>=0.1);'
    + 'document.querySelectorAll(\'#pop span\').forEach((w,k)=>{w.style.transform=t*10>=k?\'none\':\'scale(0)\';});};</script>',
    `${PILLS}@keyframes in{from{transform:translateX(900px)}to{transform:none}}#slide{animation:in .4s linear both}#pop span{display:inline-block}`
    + '#ease{transition:transform .4s linear}#ease.on{transform:translateX(200px)}#carried{display:inline-block;transform:translateX(300px)}'
    + '#fitted{display:inline-block;white-space:nowrap;transform-origin:left;transform:scale(.25)}');
  const out = join(dir, 'out.mp4');
  const r = cli(['render', page, '--out', out, '--fps', '10', '--duration', '0.7']);
  assert.equal(r.code, 0, r.err);
  const rest = linesAt(out, 6);
  for (const id of ['Edge', 'Slide', 'Eased']) assert.ok(rest[id].lines > 1, `${id}: ${JSON.stringify(rest[id])}`);
  assert.ok(rest.Edge.right <= 880 - 34 && rest.Slide.right <= 880 - 30, JSON.stringify([rest.Edge, rest.Slide]));
  // Half way in, the pill's right side is past the stage's, and its line is on as many lines as it comes to rest on.
  const half = linesAt(out, 2).Slide;
  assert.ok(half.left > rest.Slide.left + 400 && half.lines === rest.Slide.lines, JSON.stringify([half, rest.Slide]));
  // The words are where they come to rest from the first of them, the ones not yet shown wrapped too.
  const tops = (frame: number) => readRecord(recordPath(out)).samples.find((s) => s.frame === frame)!.texts.filter((e) => e.selector.startsWith('#pop>')).map((e) => e.box[1]);
  assert.equal(tops(6).length, 7);
  assert.deepEqual(tops(1), tops(6).slice(0, 2));
  // The page's own transition runs on under the measuring: a quarter of the way further each frame.
  const eased = [1, 2, 3, 4, 5].map((frame) => linesAt(out, frame).Eased.left - linesAt(out, 0).Eased.left);
  assert.deepEqual(eased.map(Math.round), [0, 50, 100, 150, 200]);
  assert.ok(rest.Carried.lines === 1 && rest.Carried.left > 540, JSON.stringify(rest.Carried));
  // The bar would not hold its label on two lines, so the label stays on one, past the bar's side at 400.
  assert.ok(rest.Bar.lines === 1 && rest.Bar.right > 400 + 100, JSON.stringify(rest.Bar));
  const text = (frame: number, selector: string) => readRecord(recordPath(out)).samples.find((s) => s.frame === frame)!.texts.find((e) => e.selector === selector)!;
  // A quarter of its size, the line fits its card as drawn: one line, a quarter of 60 px high.
  assert.ok(text(6, '#fitted').box[3] < 30, JSON.stringify(text(6, '#fitted').box));
  // The frame the label turns short, __seek reads the short pill's width, not the one the long label was held at.
  assert.equal(text(2, '#read').text, 'W680');
  assert.ok(text(3, '#read').text !== 'W680' && text(3, '#read').text === text(6, '#read').text, `${text(3, '#read').text}, then ${text(6, '#read').text}`);
  assert.ok(r.out.includes('\n  text: wrapped 5 line(s) the page set not to wrap, inside the box drawn behind each, which they ran past: '
    + `"Eased ${LONG}", "Edge ${LONG}", "Pop ${LONG}", "Slide ${LONG}", "Cue ${LONG}"\n`), r.out);
});

test('render: a line whose letters are elements of their own is not cut inside a word; words that are elements with no space between them still wrap', { skip }, () => {
  const dir = scratchDir('text-in-box-letters');
  // Each letter an inline-block, as a page that moves them one by one sets them: Chrome breaks a line between any two.
  // Under it, words as inline-blocks kept apart by a margin, with no space between their elements.
  const page = zonePage(dir, 'letters.html', formatNamed('9:16'), TALL,
    `<div data-safe><div class="row"><span class="pill" id="letters">${[...'Announcement of extraordinary proportions'].map((c) => (c === ' ' ? c : `<i>${c}</i>`)).join('')}</span></div>`
    + `<div class="row"><span class="pill" id="words">${`Words ${LONG}`.split(' ').map((w) => `<b>${w}</b>`).join('')}</span></div></div>`,
    `${PILLS}i,b{display:inline-block;font:inherit}b{margin-right:16px}`);
  const out = join(dir, 'out.mp4');
  const r = cli(['render', page, '--out', out, '--fps', '10', '--duration', '0.1']);
  assert.equal(r.code, 0, r.err);
  const tops = (id: string) => new Set(readRecord(recordPath(out)).samples[0].texts.filter((e) => e.selector.startsWith(`#${id}>`)).map((e) => e.box[1]));
  assert.equal(tops('letters').size, 1, 'the letters stay on the one line the page set');
  assert.ok(tops('words').size > 1, 'the words sit on more than one line');
  assert.match(r.out, /\n {2}text: wrapped 1 line\(s\)/);
});

test('render: place() places a line by the box it is wrapped in, from the frame its text is set, and the scripts after it and the frames after it read the page\'s own layout', { skip }, () => {
  const dir = scratchDir('text-in-box-placed');
  // A face 20 px under where one line at the zone's top ends. The label set at 0.1 s is wrapped onto more lines
  // there, so it is clear of the face only where place() measured it wrapped.
  const face = { x: 300, y: 340, w: 400, h: 300 };
  const clip: FacesClip = {
    video: join(dir, 'clip.mp4'), name: 'clip.mp4', width: 1080, height: 1920, fps: 30, frameRate: '30', durationSec: 2,
    model: 'blaze_face_full_range', every: 1, threshold: 10, confidence: 0.5, textMargin: 0, shots: [{ start: 0, end: 2, samples: [{ sec: 0.5, faces: [face] }] }],
  };
  writeFileSync(join(dir, 'faces.js'), facesScript(clip));
  // Below it a tag placed in every frame, then a pill whose label turns short at 0.2 s and a rule the page draws as
  // wide as that pill, read after the tag is placed.
  const body = (mark: string) => `<div data-safe${mark}><span class="pill" id="p" style="background:#f00"></span><div><span class="pill" id="cue"></span></div>`
    + '<div id="rule" style="height:20px;background:#00f"></div><span class="pill" id="tag" style="position:absolute;left:0;top:900px">Tag</span></div>'
    + `<script src="faces.js"></script><script>window.__seek=(t)=>{const $=(id)=>document.getElementById(id),p=$('p'),text=t<0.05?'Short':'Label ${LONG}';`
    + `if(p.textContent!==text){p.textContent=text;openeditFaces.place(p,0,1);}openeditFaces.place($('tag'),0,1);`
    + `$('cue').textContent=t<0.19?'Cue ${LONG}':'Cue';$('rule').style.width=$('cue').offsetWidth+'px';};</script>`;
  const red = (png: string) => pixelBox(png, 1080, 1920, (r, g, b) => r > 200 && g < 40 && b < 40);
  const blue = (png: string) => pixelBox(png, 1080, 1920, (r, g, b) => b > 200 && r < 40 && g < 40);
  const stepped = zonePage(dir, 'stepped.html', formatNamed('9:16'), TALL, body(''), PILLS);
  const s = cli(['render', stepped, '--out', join(dir, 'stepped'), '--stills', '0,0.1,0.2,0.3']);
  assert.equal(s.code, 0, s.err);
  assert.deepEqual(red(join(dir, 'stepped', 'f000000-0.000s.png')).slice(0, 2), [200, 240]);
  for (const still of ['f000003-0.100s.png', 'f000009-0.300s.png']) {
    const [left, top, right, bottom] = red(join(dir, 'stepped', still));
    assert.ok(bottom - top > 80, `${still}: the label is on more than one line, ${bottom - top} px tall`);
    assert.ok(bottom <= face.y || top >= face.y + face.h, `${still}: the label at ${top} to ${bottom} is clear of the face`);
    assert.ok(left >= 200 && top >= 240 && right <= 880 && bottom <= 1478, `${still}: the label at ${[left, top, right, bottom]} is inside the zone`);
  }

  // What place() wrapped to measure the tag is off again for the script after it: the frame the pill's label turns
  // short, the rule is as wide as the short pill, not the 680 px the long label was held at.
  const rule = (still: string) => { const [left, , right] = blue(join(dir, 'stepped', still)); return right - left; };
  assert.equal(rule('f000003-0.100s.png'), 680);
  assert.ok(rule('f000006-0.200s.png') < 400 && rule('f000006-0.200s.png') === rule('f000009-0.300s.png'), `${rule('f000006-0.200s.png')} px, then ${rule('f000009-0.300s.png')} px`);

  // Jumped to, the frame is the one stepped to: the lines the frames before wrapped are not what place() measures.
  const jumped = zonePage(dir, 'jumped.html', formatNamed('9:16'), TALL, body(' data-stateless'), PILLS);
  const j = cli(['render', jumped, '--out', join(dir, 'jumped'), '--stills', '0.3']);
  assert.equal(j.code, 0, j.err);
  assert.doesNotMatch(j.out + j.err, /marked data-stateless, but/);
  assert.deepEqual(red(join(dir, 'jumped', 'f000009-0.300s.png')), red(join(dir, 'stepped', 'f000009-0.300s.png')));
});

test('render: a page that links no zone is given its stage shape\'s, text it places as it loads included; one that links its own keeps it', { skip }, () => {
  const dir = scratchDir('zone-given');
  // No face anywhere, so place() moves the red block only to bring it inside its bounds.
  const clip: FacesClip = {
    video: join(dir, 'clip.mp4'), name: 'clip.mp4', width: 1080, height: 1920, fps: 30, frameRate: '30', durationSec: 2,
    model: 'blaze_face_full_range', every: 1, threshold: 10, confidence: 0.5, textMargin: 0, shots: [{ start: 0, end: 2, samples: [{ sec: 0.5, faces: [] }] }],
  };
  writeFileSync(join(dir, 'faces.js'), facesScript(clip));
  const page = bare(dir, 'given.html',
    '<div data-safe style="border:2px solid #00f"><p>Inside the zone</p></div><div class="at" id="red" style="left:300px;top:1700px;width:200px;height:60px;background:#f00"></div>',
    '', '<script src="faces.js"></script><script>openeditFaces.place(document.getElementById(\'red\'), 0, 1);</script>');
  const r = cli(['render', page, '--out', join(dir, 'still'), '--stills', '0']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /zone: the page links no safe-zone stylesheet, so its 1080x1920 stage was given the 9:16 zone \(TikTok, Instagram and Facebook Reels, and YouTube Shorts\)/);
  const still = join(dir, 'still', 'f000000-0.000s.png');
  assert.deepEqual(pixelBox(still, 1080, 1920, (red, green, blue) => blue > 200 && red < 40 && green < 40), [200, 240, 880, 1478]);
  const [, , , bottom] = pixelBox(still, 1080, 1920, (red, green, blue) => red > 200 && green < 40 && blue < 40);
  assert.equal(bottom, 1478, 'placed as the page loaded, it was moved up to the zone\'s bottom');

  // With a brief that names the platform, the page is given that platform's zone, TikTok's narrower one here.
  const briefed = join(dir, 'briefed');
  mkdirSync(briefed);
  writeFileSync(join(briefed, 'brief.json'), JSON.stringify({ platform: 'tiktok' }));
  const tiktok = bare(briefed, 'given.html', '<div data-safe style="border:2px solid #00f"></div>');
  const t = cli(['render', tiktok, '--out', join(briefed, 'still'), '--stills', '0']);
  assert.equal(t.code, 0, t.err);
  assert.match(t.out, /zone: the page links no safe-zone stylesheet, so its 1080x1920 stage was given the tiktok zone \(TikTok\)/);
  assert.deepEqual(pixelBox(join(briefed, 'still', 'f000000-0.000s.png'), 1080, 1920, (red, green, blue) => blue > 200 && red < 40 && green < 40), [183, 240, 897, 1478]);

  const own = zonePage(dir, 'own.html', formatNamed('tiktok'), TALL, '<div data-safe style="border:2px solid #00f"></div>');
  const o = cli(['render', own, '--out', join(dir, 'own'), '--stills', '0']);
  assert.equal(o.code, 0, o.err);
  assert.doesNotMatch(o.out, /zone:/);
  assert.deepEqual(pixelBox(join(dir, 'own', 'f000000-0.000s.png'), 1080, 1920, (red, green, blue) => blue > 200 && red < 40 && green < 40), [183, 240, 897, 1478]);
});
