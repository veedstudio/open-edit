// Safe zones per platform format: the published geometry, the stylesheet `safe-zone` writes, and what its
// container's defaults do to a page in the pinned headless Chrome. The browser tests are skipped when it is
// not installed (`openedit install-browser`), unless OPENEDIT_REQUIRE_BROWSER is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { FFMPEG } from '../src/config.ts';
import { chromePlatform, installedChrome } from '../src/render/browser.ts';
import { FORMATS, formatNamed, minText, stylesheet, zoneFor } from '../src/commands/safe-zone.ts';
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

test('safe-zone: each format on its own canvas keeps the published ad safe-zone and title-safe margins, under every name it answers to', () => {
  // 9:16: YouTube's Shorts margins (top 288, bottom 672, right 192), the right one on both sides.
  assert.deepEqual(rect(zoneFor(formatNamed('9:16'), { width: 1080, height: 1920 })), [192, 288, 888, 1248]);
  // 16:9: YouTube's title row (166), control bar (143) and right margin (152) on both sides; 4:3 shares the
  // bands, with 5% title-safe sides.
  assert.deepEqual(rect(zoneFor(formatNamed('16:9'), { width: 1920, height: 1080 })), [152, 166, 1768, 937]);
  assert.deepEqual(rect(zoneFor(formatNamed('4:3'), { width: 1440, height: 1080 })), [72, 166, 1368, 937]);
  for (const name of ['tiktok', 'Reels', 'shorts', '9x16']) assert.equal(formatNamed(name).name, '9:16', name);
  for (const name of ['youtube', '16x9']) assert.equal(formatNamed(name).name, '16:9', name);
  assert.equal(formatNamed('4x3').name, '4:3');
  // Instagram's feed is 4:5 or 1:1, so the name alone does not mean 9:16.
  assert.throws(() => formatNamed('instagram'), /names no safe-zone format/);
  assert.throws(() => formatNamed('1:1'), /"1:1" names no safe-zone format, so a page of that shape \(1:1 or 4:5, say\) skips this step; the formats are 9:16, 16:9, 4:3, tiktok/);
  for (const f of FORMATS) assert.equal(zoneFor(f, f.canvas).minText, 32, `${f.name} minimum on its own canvas`);
});

test('safe-zone: another canvas of the shape scales the zone and rounds it inward; another shape is refused', () => {
  const z = zoneFor(formatNamed('9:16'), { width: 720, height: 1280 });
  assert.deepEqual(rect(z), [128, 192, 592, 832]);
  assert.equal(z.minText, 22);
  assert.equal(minText({ width: 1920, height: 1080 }), 32);
  // Footage sized to a 16-pixel grid is still 9:16.
  assert.doesNotThrow(() => zoneFor(formatNamed('9:16'), { width: 1088, height: 1920 }));
  assert.throws(() => zoneFor(formatNamed('9:16'), { width: 1920, height: 1080 }), /a 1920x1080 canvas is not 9:16/);
});

test('safe-zone: the command writes the stylesheet for a platform, and refuses a canvas of another shape', () => {
  const dir = scratchDir('safe-zone-cmd');
  const r = cli(['safe-zone', 'tiktok', '--out', dir]);
  assert.equal(r.code, 0, r.err);
  const css = readFileSync(join(dir, 'safe-zone.css'), 'utf8');
  assert.match(css, /\[data-safe-zone="9:16"\] \{\n {2}position: relative;\n {2}width: 1080px;\n {2}height: 1920px;/);
  assert.match(css, /\[data-safe-zone="9:16"\] \[data-safe\] \{\n {2}position: absolute;\n {2}left: 192px;\n {2}top: 288px;\n {2}width: 696px;\n {2}height: 960px;/);
  assert.match(css, /--min-text: 32px;/);
  // Only the container's place is specific; every default after it has no specificity, so the page's rules win.
  assert.match(css, /height: 960px;\n {2}box-sizing: border-box;\n {2}container-type: size;\n\}/);
  assert.match(css, /:where\(\[data-safe-zone="9:16"\] \[data-safe\]\) \{\n {2}font-size: var\(--min-text\);\n {2}overflow-wrap: break-word;/);
  assert.doesNotMatch(css, /overflow:\s*(clip|hidden)/, 'the container never clips: clipping would truncate text silently');
  assert.match(r.out, /text area: 696x960 at 192,288, clear of 288 px at the top, 672 at the bottom, 192 on the left and 192 on the right/);
  assert.match(r.out, /data-safe-zone="9:16"/);

  const wrong = cli(['safe-zone', '9:16', '--out', dir, '--canvas', '1920x1080']);
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /a 1920x1080 canvas is not 9:16/);
  assert.equal(cli(['safe-zone', 'vine', '--out', dir]).code, 1);
});

/** A page linking the stylesheet `safe-zone` writes, the stage black and its text white, with no layout of its own. */
function zonePage(dir: string, name: string, format: string, canvas: { width: number; height: number }, body: string, style = ''): string {
  writeFileSync(join(dir, 'safe-zone.css'), stylesheet(zoneFor(formatNamed(format), canvas)));
  const file = join(dir, name);
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="safe-zone.css"><style>
html,body{margin:0;background:#000}
#stage{background:#000;color:#fff;font-family:Arial,sans-serif}
${style}</style></head><body><div id="stage" data-safe-zone="${format}">${body}</div></body></html>`);
  return file;
}

/** The box around every pixel brighter than `level` in a still, as [left, top, right, bottom]. */
function brightBox(png: string, width: number, height: number, level: number): number[] {
  const g = execFileSync(FFMPEG, ['-v', 'error', '-i', png, '-vf', 'format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  let [left, top, right, bottom] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (g[y * width + x] <= level) continue;
      left = Math.min(left, x);
      right = Math.max(right, x + 1);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y + 1);
    }
  }
  return [left, top, right, bottom];
}

const ZONES = [
  { format: '9:16', canvas: { width: 1080, height: 1920 }, zone: [192, 288, 888, 1248] },
  { format: '16:9', canvas: { width: 1920, height: 1080 }, zone: [152, 166, 1768, 937] },
  { format: '4:3', canvas: { width: 1440, height: 1080 }, zone: [72, 166, 1368, 937] },
];

for (const c of ZONES) {
  test(`render: the ${c.format} container sits on the zone, and unstyled text inside it stays inside it`, { skip }, () => {
    const dir = scratchDir(`safe-zone-${c.format.replace(':', 'x')}`);
    const { width: w, height: h } = c.canvas;
    // The container painted white, measured off the picture rather than the stylesheet.
    const box = cli(['render', zonePage(dir, 'box.html', c.format, c.canvas, '<div data-safe style="background:#fff"></div>'), '--out', join(dir, 'box'), '--stills', '0']);
    assert.equal(box.code, 0, box.err);
    assert.deepEqual(brightBox(join(dir, 'box', 'f000000-0.000s.png'), w, h, 200), c.zone);

    // A heading of one word longer than any line, and a long paragraph, with no layout of their own: every glyph
    // the defaults set lands inside the container.
    const word = 'Unbreakable'.repeat(12);
    const prose = 'Cut the first second, because nobody waits for a slow open on a feed that scrolls on without them. '.repeat(3);
    const text = cli(['render', zonePage(dir, 'text.html', c.format, c.canvas, `<div data-safe><h1>${word}</h1><p>${prose}</p></div>`), '--out', join(dir, 'text'), '--stills', '0']);
    assert.equal(text.code, 0, text.err);
    const [l, t, r, b] = brightBox(join(dir, 'text', 'f000000-0.000s.png'), w, h, 40);
    assert.ok(r > l && b > t, 'the text was drawn');
    assert.ok(l >= c.zone[0] && t >= c.zone[1] && r <= c.zone[2] && b <= c.zone[3], `glyphs at ${[l, t, r, b]}, zone ${c.zone}`);
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
  // Unsized text, and the elements a browser sets smaller, start at the minimum; cqw and cqh measure the zone.
  const floor = zonePage(dir, 'floor.html', '9:16', canvas,
    '<div data-safe><p id="plain">Plain</p><small id="small">Small</small><h6 id="h6">Six</h6><button id="button" style="background:#fff;padding:8px">Go</button>'
    + '<h1 id="head">Head</h1><p id="sized" style="font-size:max(var(--min-text), 10cqw)">Sized</p><div id="full" style="width:100cqw;height:100cqh"></div></div>');
  assert.deepEqual(await inChrome(floor, `(() => { ${size} const r = document.getElementById('full').getBoundingClientRect();
    return [size('plain'), size('small'), size('h6'), size('button'), size('head'), size('sized'), r.width, r.height]; })()`),
  ['32px', '32px', '32px', '32px', '64px', '69.6px', 696, 960]);

  // A size the page sets on the container, by element or by class, wins; its place on the zone holds.
  for (const css of ['[data-safe]{font-size:48px}', '.cap{font-size:48px;top:auto;bottom:100px;height:200px}']) {
    const page = zonePage(dir, 'own.html', '9:16', canvas, '<div data-safe class="cap"><p id="plain">Plain</p></div>', css);
    assert.deepEqual(await inChrome(page, `(() => { ${size} const r = document.querySelector('[data-safe]').getBoundingClientRect();
      return [size('plain'), r.top, r.height]; })()`), ['48px', 288, 960], css);
  }
});

test('browser: boxes inside keep within the container unless they ask not to, a ticker runs whole, pictures keep their shape, an svg its size', { skip }, async () => {
  const dir = scratchDir('safe-zone-boxes');
  const page = zonePage(dir, 'boxes.html', '9:16', { width: 1080, height: 1920 }, '<div data-safe>'
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
  assert.deepEqual(got, { wide: 696, free: 900, img: [696, 348], svg: 1000, oneLine: true, apart: true });
});
