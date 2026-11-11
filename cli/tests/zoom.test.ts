// The zoom command's parts on drawn frames: the patches two frames differ in, the cursor followed through them, the
// clicks, wholesale changes and still stretches read from them, the font size read off a line of text, the camera planned
// over the clicks, and zoom.js applying it to an element.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { parseClicks } from '../src/commands/zoom.ts';
import { changedBlobs, CursorTracker, readActivity, type Blob, type Change } from '../src/zoom/activity.ts';
import { PAGE_SOURCE, zoomApi, type ZoomClip } from '../src/zoom/page-script.ts';
import { textNear } from '../src/zoom/text.ts';

const W = 320, H = 180;
const PAPER = 240, INK = 20;

/** A light frame with dark boxes drawn on it, [x, y, w, h] each, and arrows (a triangle 6 wide and 10 tall) at [x, y]. */
function frame(boxes: [number, number, number, number][], width = W, height = H, fill = PAPER, arrows: [number, number][] = []): Uint8Array {
  const f = new Uint8Array(width * height).fill(fill);
  for (const [x, y, w, h] of boxes) for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) f[j * width + i] = INK;
  for (const [x, y] of arrows) for (let j = 0; j < 10; j++) for (let i = 0; i <= Math.min(j, 5); i++) f[(y + j) * width + x + i] = INK;
  return f;
}
/** A frame with the cursor's arrow at x, y, and dark boxes. */
const withArrow = (x: number, y: number, boxes: [number, number, number, number][] = []) => frame(boxes, W, H, PAPER, [[x, y]]);

test('zoom: two frames differ in patches, and a caret blinking is not one', () => {
  const blobs = changedBlobs(withArrow(20, 20), withArrow(100, 60, [[200, 40, 1, 12]]), W, H);
  assert.deepEqual(blobs.map((b) => [b.x, b.y, b.w, b.h]).sort((a, b) => a[0] - b[0]), [[20, 20, 6, 10], [100, 60, 6, 10]]);
});

test('zoom: the cursor is followed by pairs of its outline, not by typing, and found again after a small move', () => {
  const tracker = new CursorTracker(W, H);
  const letter: [number, number, number, number] = [200, 100, 5, 8];
  const frames = [
    withArrow(20, 20),
    withArrow(60, 40),
    withArrow(100, 60),
    withArrow(140, 80),
    // A letter typed far from it: no pair, so it stays.
    withArrow(140, 80, [letter]),
    // A move of a few pixels leaves one patch where it was; its picture finds it.
    withArrow(144, 83, [letter]),
    // The screen answers beside it: a rule under it appears, the arrow does not move.
    withArrow(144, 83, [letter, [130, 96, 30, 2]]),
  ];
  const seen: (Blob | null)[] = [];
  const moved: boolean[] = [];
  for (let i = 1; i < frames.length; i++) {
    const r = tracker.step(frames[i - 1], frames[i], changedBlobs(frames[i - 1], frames[i], W, H), false);
    seen.push(r.cursor);
    moved.push(r.moved);
  }
  assert.equal(seen[0], null, 'one pair is not enough to take a cursor');
  assert.deepEqual([seen[1]?.x, seen[1]?.y], [100, 60], 'a second pair moving on from the first is');
  assert.deepEqual([seen[2]?.x, seen[2]?.y], [140, 80]);
  assert.deepEqual([seen[3]?.x, seen[3]?.y, moved[3]], [140, 80, false], 'typing does not move it');
  assert.deepEqual([seen[4]?.x, seen[4]?.y, moved[4]], [144, 83, true], 'its picture finds it after a small move');
  assert.deepEqual([seen[5]?.x, seen[5]?.y, moved[5]], [144, 83, false]);
});

test('zoom: a rest the screen answers is a click, a wholesale change a wide stretch, and nothing changing a still one', () => {
  const at = (x: number, y: number): Blob => ({ x, y, w: 6, h: 10, n: 40 });
  const changes: Change[] = Array.from({ length: 40 }, (_, i) => ({ sec: (i + 1) / 10, blobs: [], cursor: null, moved: false }));
  // Seen at 10,10, then moving in for five samples, each leaving where it was, and resting at 100,58.
  Object.assign(changes[0], { blobs: [at(10, 10)], cursor: at(10, 10), moved: true });
  for (let i = 1; i < 6; i++) Object.assign(changes[i], { blobs: [at(10 + 18 * (i - 1), 10 + 12 * (i - 1)), at(10 + 18 * i, 10 + 12 * i)], cursor: at(10 + 18 * i, 10 + 12 * i), moved: true });
  for (let i = 6; i < 40; i++) changes[i].cursor = changes[5].cursor;
  changes[9].blobs = [{ x: 90, y: 72, w: 60, h: 8, n: 200 }];
  changes[14].blobs = [{ x: 0, y: 0, w: W, h: H, n: W * H }];
  const activity = readActivity(changes, { width: W, height: H }, { width: 2 * W, height: 2 * H });
  assert.equal(activity.sightings, 6);
  assert.deepEqual(activity.clicks.map((c) => [c.t, c.before, c.x, c.y]), [[1, 0.9, 2 * 100, 2 * 70]]);
  assert.deepEqual(activity.wide.map((w) => [w.from, w.to]), [[1.5, 1.5]]);
  assert.deepEqual(activity.local.map((l) => l[0]), [1], 'the cursor\'s own patches are not something happening');
  assert.deepEqual(activity.still.map((s) => [s.from, s.to]), [[1.5, 4]]);
});

/** A line of glyph-like strokes from `top` to the baseline, with taller ones every third and descenders every fifth. */
function textLine(f: Uint8Array, width: number, x0: number, x1: number, top: number, xHeight: number, capHeight: number) {
  const base = top + capHeight;
  for (let x = x0, k = 0; x < x1; x += 3, k++) {
    const from = k % 3 === 0 ? top : base - xHeight;
    const to = k % 5 === 0 ? base + 3 : base;
    for (let y = from; y <= to; y++) f[y * width + x] = INK;
  }
}

test('zoom: the font size is read from a line\'s top to its baseline, past a box around it, and never over-read', () => {
  const big = { width: 1920, height: 1080 };
  const f = frame([], big.width, big.height, 255);
  textLine(f, big.width, 800, 1000, 500, 7, 10);
  const line = textNear(f, big.width, big.height, 900, 505);
  assert.ok(line, 'the line is found');
  // A capital 10 px tall is about 14 px type; the reading errs below it.
  assert.ok(line!.em > 12 && line!.em <= 14, `em ${line!.em}`);
  const boxed = frame([[780, 485, 240, 2], [780, 525, 240, 2], [780, 485, 2, 42], [1018, 485, 2, 42]], big.width, big.height, 255);
  textLine(boxed, big.width, 800, 1000, 500, 7, 10);
  assert.equal(textNear(boxed, big.width, big.height, 900, 505)?.em, line!.em, 'a field\'s border is not text');
  assert.equal(textNear(frame([], big.width, big.height, 255), big.width, big.height, 900, 505), null);
});

const clipOf = (over: Partial<ZoomClip> = {}): ZoomClip => ({
  video: '/rec/screen.mp4', name: 'screen.mp4', width: 1920, height: 1080, durationSec: 60, floor: 0.045,
  clicks: [], wide: [], local: [], ...over,
});
const TALL = { w: 1080, h: 1920 }, WIDE = { w: 1920, h: 1080 };

test('zoom: each click is held zoomed until its text reaches the canvas\'s minimum, inside the picture', () => {
  const api = zoomApi();
  const clip = clipOf({ clicks: [{ t: 10, x: 600, y: 40, em: 14 }, { t: 30, x: 1500, y: 900, em: 24 }, { t: 45, x: 900, y: 500, em: null }] });
  for (const box of [TALL, WIDE]) {
    const plan = api.plan(clip, box, box);
    assert.equal(plan.floor, 49);
    for (const c of plan.clicks) {
      assert.ok(c.rect.x >= 0 && c.rect.y >= 0 && c.rect.x + c.rect.w <= 1920 + 1e-6 && c.rect.y + c.rect.h <= 1080 + 1e-6, JSON.stringify(c.rect));
      assert.ok(c.x >= c.rect.x && c.x <= c.rect.x + c.rect.w && c.y >= c.rect.y && c.y <= c.rect.y + c.rect.h, 'the click is in view');
    }
    assert.ok(plan.clicks[0].shown! >= 49 - 1e-6 && plan.clicks[1].shown! >= 49 - 1e-6, JSON.stringify(plan.clicks.map((c) => c.shown)));
    // No text found near the last: the smallest found elsewhere stands in.
    assert.ok(Math.abs(plan.clicks[2].scale - 49 / 14) < 1e-6);
    assert.deepEqual(api.rectAt(plan, 0, clip, box), plan.keys[0]);
    // Between clicks twenty seconds apart the camera pulls back to the whole picture.
    assert.ok(Math.abs(api.rectAt(plan, 20, clip, box).w - plan.keys[0].w) < 1e-6);
  }
  assert.ok(Math.abs(api.plan(clip, TALL, TALL).clicks[0].rect.w - 1080 / 3.5) < 1e-6);
  assert.ok(Math.abs(api.plan(clip, WIDE, WIDE).clicks[0].rect.w - 1920 / 3.5) < 1e-6);
});

test('zoom: clicks close by share one hold, a wholesale change pulls back, and a click with no time to settle is passed over', () => {
  const api = zoomApi();
  const near = api.plan(clipOf({ clicks: [{ t: 10, x: 900, y: 500, em: 14 }, { t: 11, x: 960, y: 520, em: 14 }] }), TALL, TALL);
  assert.deepEqual(near.clicks[0].rect, near.clicks[1].rect);
  const paged = clipOf({ clicks: [{ t: 10, x: 900, y: 500, em: 14 }], wide: [{ from: 10.4, to: 11, x: 0, y: 0, w: 1920, h: 1080 }] });
  const plan = api.plan(paged, WIDE, WIDE);
  assert.ok(Math.abs(api.rectAt(plan, 10, paged, WIDE).w - 1920 / 3.5) < 1e-6, 'held through the click');
  assert.equal(api.rectAt(plan, 12, paged, WIDE).w, 1920, 'back to the whole page once it has loaded');
  const hurried = clipOf({ clicks: [{ t: 10, x: 100, y: 100, em: 14 }, { t: 10.4, x: 1800, y: 1000, em: 14 }] });
  const rushed = api.plan(hurried, WIDE, WIDE);
  assert.deepEqual(rushed.clicks[0].rect, rushed.clicks[1].rect, 'the camera is already on the second');
  for (let i = 1; i < rushed.keys.length; i++) assert.ok(rushed.keys[i].t >= rushed.keys[i - 1].t, 'keys run forward');
});

test('zoom: zoom.js frames the clip in the element\'s parent, and point() is where a pixel of the clip lands', () => {
  const parent = { clientWidth: 1080, clientHeight: 1920, style: {} as Record<string, string> };
  const el = { parentElement: parent, style: {} as Record<string, string> };
  const sandbox = {
    window: {} as Record<string, unknown>,
    document: { querySelector: () => ({ offsetWidth: 1080, offsetHeight: 1920 }) },
    getComputedStyle: () => ({ position: 'static' }),
  };
  runInNewContext(PAGE_SOURCE, sandbox);
  const zoom = sandbox.window.openeditZoom as {
    add(c: ZoomClip): void;
    apply(e: unknown, t: number): { x: number; y: number; w: number; scale: number };
    point(e: unknown, x: number, y: number, t: number): { x: number; y: number };
  };
  zoom.add(clipOf({ clicks: [{ t: 10, x: 600, y: 400, em: 14 }] }));
  const r = zoom.apply(el, 10);
  assert.ok(Math.abs(r.scale - 3.5) < 1e-6);
  assert.equal(parent.style.position, 'relative');
  assert.equal(parent.style.overflow, 'hidden');
  assert.deepEqual([el.style.width, el.style.height, el.style.transformOrigin], ['1920px', '1080px', '0 0']);
  assert.equal(el.style.transform, `translate(${-r.x * r.scale}px, ${-r.y * r.scale}px) scale(${r.scale})`);
  const p = zoom.point(el, 600, 400, 10);
  assert.ok(Math.abs(p.x - (600 - r.x) * r.scale) < 1e-6 && p.x > 0 && p.x < 1080 && p.y > 0 && p.y < 1920);
});

test('zoom: a click list is read as times and points inside the clip, and refused by name otherwise', () => {
  const size = { width: 1920, height: 1080, durationSec: 60 };
  assert.deepEqual(parseClicks('[{"t": 1.5, "x": 10, "y": 20}]', 'c.json', size), [{ t: 1.5, x: 10, y: 20 }]);
  assert.deepEqual(parseClicks('{"clicks": [{"t": 2, "x": 1, "y": 1}]}', 'c.json', size), [{ t: 2, x: 1, y: 1 }]);
  assert.throws(() => parseClicks('[{"t": 1, "x": 1, "y": 1}, {"t": 99, "x": 1, "y": 1}]', 'c.json', size), /c\.json: click 2 .* within the clip's 60\.00 s/);
  assert.throws(() => parseClicks('[]', 'c.json', size), /lists no clicks/);
  assert.throws(() => parseClicks('{', 'c.json', size), /c\.json is not JSON/);
});
