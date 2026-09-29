import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { crc32, deflateSync } from 'node:zlib';
import { scanFrames } from '../src/commands/veed-project.ts';
import {
  BOOKMARKLET, BUNDLE_VERSION, PULL_BOOKMARKLET, PlanError, audioItem, bookmarkletUrl, captionCues, captionItems, checkPlan, edlParts, encodeBundle, imageItem, isVeedId,
  mixParts, movedBox, place, planFromPulled, previewSafeSize, textItem, veedMediaUrl, videoItem, visibleSpans, type Bundle, type Plan, type PulledItem,
} from '../src/veed/editor-project.ts';

const W = 1920, H = 1080;
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('veed-project: a clip the preview would scale is padded to a size that scales to whole, even pixels', () => {
  // Sizes whose preview copies came out with an opaque edge in the editor.
  for (const [w, h] of [[1144, 302], [1830, 74], [1856, 80], [1152, 320], [900, 1500], [700, 1302], [2500, 300]]) {
    const s = previewSafeSize(w, h);
    assert.ok(s.w >= w && s.h >= h, `${w}x${h} is never cut`);
    const long = Math.max(s.w, s.h), scaled = (Math.min(s.w, s.h) * 1024) / long;
    assert.ok(Number.isInteger(scaled) && scaled % 2 === 0, `${w}x${h} -> ${s.w}x${s.h} scales to ${scaled}`);
    assert.ok(s.w % 2 === 0 && s.h % 2 === 0, 'even, for 4:2:0 video');
  }
  assert.deepEqual(previewSafeSize(962, 856), { w: 962, h: 856 }, 'a clip the preview keeps as it is stays as it is');
  assert.deepEqual(previewSafeSize(1920, 1080), { w: 1920, h: 1080 }, 'full HD already scales cleanly');
});

test('veed-project: an element is one clip across short gaps and a new clip after a long one', () => {
  const at = (ts: number[]) => ts.map((t) => ({ t, peak: 255 }));
  const frames = [...at([0, 0.04, 0.08]), { t: 0.12, peak: 0 }, ...at([0.16, 0.2]), ...at([1, 1.04])];
  assert.deepEqual(visibleSpans(frames, 0.04, 0.25).map((s) => [s.at, +s.to.toFixed(2)]), [[0, 0.24], [1, 1.08]]);
  assert.equal(visibleSpans([{ t: 0, peak: 3 }], 0.04, 0.25).length, 1, 'any alpha counts');
  assert.deepEqual(visibleSpans([0, 1, 2, 9, 10].map((t) => ({ t, peak: 1 })), 1, 6), [{ at: 0, to: 11 }], 'in frame indices, a bridge of 6 frames joins a 6-frame gap');
});

test('veed-project: a plan is refused before anything renders when a part cannot be made', () => {
  const plan = (...parts: unknown[]): Plan => ({ name: 'p', width: W, height: H, duration: 10, page: 'index.html', parts } as Plan);
  const refused: [string, unknown][] = [
    ['a misspelt type', { type: 'vidoe', file: 'a.mp4', at: 0 }],
    ['a layer with no selector', { type: 'layer' }],
    ['a layer with no end', { type: 'layer', select: '#a', at: 12 }],
    ['a shift that is not a number', { type: 'layer', select: '#a', shift: 'late' }],
    ['a zero-size box to move from', { type: 'layer', select: '#a', moved: { from: { x: 0, y: 0, w: 0, h: 1 }, to: { x: 0, y: 0, w: 1, h: 1 } } }],
    ['an image with no box', { type: 'image', file: 'a.png', at: 0, to: 1 }],
    ['a box in the wrong shape', { type: 'video', file: 'a.mp4', at: 0, box: { x: 0, y: 0, width: 10, height: 10 } }],
    ['an out before the in', { type: 'video', file: 'a.mp4', at: 0, in: 5, out: 2 }],
    ['text ending before it starts', { type: 'text', text: 'hi', at: 2, to: 1, x: 0, y: 0, size: 10 }],
    ['text with no size', { type: 'text', text: 'hi', at: 0, to: 1, x: 0, y: 0 }],
    ['an animation the editor lacks', { type: 'text', text: 'hi', at: 0, to: 1, x: 0, y: 0, size: 10, animation: 'spin' }],
    ['an empty file', { type: 'audio', file: '', at: 0 }],
    ['captions with no transcript', { type: 'captions' }],
  ];
  for (const [what, part] of refused) assert.throws(() => checkPlan(plan(part)), PlanError, what);
  checkPlan(plan({ type: 'layer', select: '#a' }, { type: 'edl', file: 'e.json' }, { type: 'mix', file: 'm.json' }, { type: 'captions', transcript: 't.json', words: 4 }));
});

test('veed-project: items carry the editor\'s own placement, sizes and neutral filters', () => {
  assert.deepEqual(place({ x: 1280, y: 40, w: 600, h: 338 }, W, H), { translationX: 1580 / W, translationY: 209 / H, width: 600 / W, height: 338 / H });
  const items = [
    videoItem({ assetId: 'v', at: 1, in: 0, out: 2, volume: 1 }, W, H),
    imageItem({ type: 'image', file: 'a.png', at: 1, to: 3, box: { x: 0, y: 0, w: 100, h: 100 } }, 'i', W, H),
    audioItem({ type: 'audio', file: 'a.wav', at: 0 }, 'a', 4),
    textItem({ type: 'text', text: 'Hi', at: 0, to: 2, x: 960, y: 540, size: 96 }, W, H),
  ];
  for (const i of items) assert.equal((i.filters as { opacity: number }).opacity, 100, `${i.category}: an item stored without filters draws nearly transparent`);
  assert.deepEqual(items.map((i) => i.to), [null, 3, null, 2]);
  assert.equal((items[3].metadata as { size: number }).size, 96 / W, 'text size is a share of the canvas width');
});

test('veed-project: an EDL\'s ranges are laid end to end from the part\'s start', () => {
  const parts = edlParts({ type: 'edl', file: 'e.json', at: 2, volume: 0.5 }, [
    { source: 'a', start: 10, end: 12.5, note: 'intro', fps: 24 }, { source: 'a', start: 20, end: 21, fps: 24 },
  ], (id) => `/media/${id}.mp4`);
  assert.deepEqual(parts.map((p) => [p.file, p.at, p.in, p.out, p.name, p.volume]), [['/media/a.mp4', 2, 10, 12.5, 'intro', 0.5], ['/media/a.mp4', 4.5, 20, 21, 'cut 2', 0.5]]);
});

test('veed-project: a mix spec\'s tracks play as mix-audio plays them', () => {
  const lengths: Record<string, number> = { 'voice.wav': 8, 'music.wav': 180, 'sting.wav': 1 };
  const { parts, notes } = mixParts({
    durationSec: 30,
    tracks: [
      { path: 'voice.wav', atSec: 1, gainDb: 0 },
      { path: 'music.wav', atSec: 0, gainDb: -6, fadeOutSec: 2, duck: true, role: 'music' },
      { path: 'sting.wav', atSec: 10, gainDb: 6, fadeOutSec: 2 },
      { path: 'sting.wav', atSec: 31 },
    ],
  }, (p) => lengths[p]);
  assert.equal(parts.length, 3, 'a track that starts after the film ends is left out');
  const [voice, music, sting] = parts;
  assert.equal(voice.volume, 1);
  assert.deepEqual([music.volume, music.out, music.fadeOut, music.name], [0.501, 30, 2, 'music: music.wav'], 'the bed stops and fades where the film does');
  assert.deepEqual([sting.volume, sting.out, sting.fadeOut], [1.995, 1, undefined], 'a track over before the film\'s fade is not faded');
  assert.deepEqual(notes, ['music.wav: ducking under the voice is not carried; it plays at its own gain']);
});

test('veed-project: long transcript chunks become short captions, broken at pauses and sentence ends', () => {
  const w = (text: string, a: number, b: number) => ({ text, timestamp: [a, b] as [number, number] });
  const words = [w('one', 0, 0.2), w('two', 0.25, 0.4), w('three.', 0.45, 0.6), w('four', 0.7, 0.8), w('five', 0.85, 1), w('six', 1.05, 1.2),
    w('seven', 1.25, 1.4), w('eight', 1.45, 1.6), w('nine', 1.65, 1.8), w('ten', 3, 3.2)];
  const cues = captionCues({ chunks: [{ text: 'all of it', timestamp: [0, 3.2], words }, { text: 'untimed', timestamp: [4, 5] }] }, 4);
  assert.deepEqual(cues.map((c) => c.text), ['one two three.', 'four five six seven', 'eight nine', 'ten', 'untimed']);
  assert.deepEqual(cues[1].timestamp, [0.7, 1.4]);
  const items = captionItems({ type: 'captions', transcript: 't.json' }, { chunks: [{ text: 'hello there', timestamp: [0, 1] }, { text: ' ', timestamp: [1, 2] }] }, W, H);
  assert.deepEqual(items.map((i) => [i.name, i.zIndex, i.translationY]), [['caption 1', 50, 0.85]], 'a blank cue is dropped; captions sit low, above the rest');
});

test('veed-pull: a project read back from the editor is the plan that made it', () => {
  const items = [
    videoItem({ assetId: 'rec', at: 0, in: 2, out: 7.5, volume: 1, z: 0, name: 'recording' }, W, H),
    videoItem({ assetId: 'rec', at: 5.5, in: 9, out: 12, volume: 0.8, box: { x: 1280, y: 40, w: 600, h: 338 }, z: 3, name: 'inset' }, W, H),
    textItem({ type: 'text', at: 1, to: 4, text: 'Hello', x: 960, y: 900, size: 64, color: '#ff0000', bold: true, animation: 'pop', z: 9 }, W, H),
    audioItem({ type: 'audio', file: 'music.mp3', at: 0, volume: 0.3, fadeOut: 1.5, z: 0 }, 'music', 20),
    { category: 'shape', name: 'arrow', from: 2, zIndex: 4, translationX: 0.5, translationY: 0.5, width: 0.1, height: 0.1 },
  ].map((i) => ({ ...i, visibleUntil: (i.from as number) + 3 })) as unknown as PulledItem[];
  const files: Record<string, string> = { rec: 'media/rec.mp4', music: 'media/music.mp3' };
  const made = { music: { file: '/work/audio/music.mp3' } };
  const { plan, left } = planFromPulled({ id: 'p1', name: 'Recording', aspect: [W, H], fps: 30 }, items, (id) => files[id], (id) => made[id as 'music']);
  assert.deepEqual([plan.width, plan.height, plan.fps], [W, H, 30]);
  assert.equal(plan.parts.length, 4, 'the shape has no part to become');
  const [rec, music, text, inset] = plan.parts;
  assert.deepEqual(rec, { type: 'video', at: 0, z: 0, name: 'recording', file: 'media/rec.mp4', in: 2, out: 7.5, volume: 1 }, 'full-canvas footage carries no box');
  assert.deepEqual(music, { type: 'audio', at: 0, z: 0, name: 'audio', origin: { file: '/work/audio/music.mp3' }, file: 'media/music.mp3', in: 0, out: 20, volume: 0.3, fadeOut: 1.5 },
    'a file sent from this machine says what it was made from');
  assert.deepEqual(text, { type: 'text', at: 1, z: 9, name: 'text', to: 4, text: 'Hello', x: 960, y: 900, size: 64, font: 'Inter', color: '#ff0000', align: 'center', bold: true, animation: 'pop' });
  assert.deepEqual(inset, { type: 'video', at: 5.5, z: 3, name: 'inset', file: 'media/rec.mp4', in: 9, out: 12, volume: 0.8, box: { x: 1280, y: 40, w: 600, h: 338 } });
  assert.deepEqual(left, ['shape "arrow" at 2.00 s: nothing the plan can carry']);
  assert.equal(plan.duration, 20, 'the plan runs to the end of its longest part');
  checkPlan(plan);
  assert.equal(planFromPulled({ id: 'p2', aspect: [9, 16] }, [], () => undefined).plan.height, 1920, 'a ratio is scaled up to canvas pixels');
});

test('veed-pull: what a person set that the plan cannot carry is named, and never breaks the plan', () => {
  const base = videoItem({ assetId: 'rec', at: 0, in: 1, out: 4, volume: 1, name: 'rec' }, W, H);
  const items = [
    { ...base, rotation: 15, filters: { ...(base.filters as object), opacity: 60 }, metadata: { ...(base.metadata as object), crop: [0, 0.1, 0, 0], playbackRate: 2 } },
    { ...videoItem({ assetId: 'rec', at: 8, in: 3, out: 0, volume: 1, name: 'open-ended' }, W, H), metadata: { trimStart: 3 }, visibleUntil: 10 },
    { ...textItem({ type: 'text', at: 0, to: 1, text: ' ', x: 0, y: 0, size: 10 }, W, H), visibleUntil: 1 },
    { ...textItem({ type: 'text', at: 0, to: 1, text: 'no end', x: 0, y: 0, size: 10 }, W, H), to: null },
  ] as unknown as PulledItem[];
  const { plan, left } = planFromPulled({ id: 'p', aspect: [W, H] }, items, () => 'media/rec.mp4');
  assert.deepEqual(left, [
    'video "rec" at 0.00 s: rotation 15 is not carried',
    'video "rec" at 0.00 s: its opacity 60 is not carried',
    'video "rec" at 0.00 s: its crop is not carried',
    'video "rec" at 0.00 s: plays at 2x in VEED; the plan plays it at 1x',
    'text "text" at 0.00 s: it holds no text',
    'text "text" at 0.00 s: it has no end on the timeline',
  ]);
  const openEnded = plan.parts.find((p) => 'name' in p && p.name === 'open-ended') as { in: number; out: number };
  assert.deepEqual([openEnded.in, openEnded.out], [3, 5], 'no trim end: it plays from its trim start for as long as it is on the timeline');
  checkPlan(plan);
});

test('veed-pull: a page layer the person moved, resized, retimed and trimmed comes back as that layer, placed as they left it', () => {
  const sent = { x: 100, y: 800, w: 1280, h: 200 };
  // Sent as the clip of #caps for page time 6-13 s; the person dragged it 2 s later, trimmed 1 s off its start,
  // moved it up and made it half again as large.
  const item = { ...videoItem({ assetId: 'caps', at: 9, in: 1, out: 7, volume: 0, box: { x: 50, y: 300, w: 1920, h: 300 }, z: 9, name: 'captions' }, W, H), visibleUntil: 15 };
  const origin = { layer: '#caps', page: '/work/index.html', plan: '/work/veed-plan.json', at: 6, to: 13, box: sent };
  const { plan } = planFromPulled({ id: 'p', aspect: [W, H] }, [item] as unknown as PulledItem[], () => 'media/caps.webm', () => origin);
  const asLayer = (plan.parts[0] as { origin: { asLayer: unknown } }).origin.asLayer;
  assert.deepEqual(asLayer, {
    type: 'layer', select: '#caps', page: '/work/index.html', at: 7, to: 13, z: 9, name: 'captions', shift: 2,
    moved: { from: sent, to: { x: 50, y: 300, w: 1920, h: 300 } },
  });
  checkPlan({ ...plan, parts: [asLayer as Plan['parts'][number]] });
  // A clip of the re-rendered element that sits 20 px inside the sent box lands 30 px inside the new one.
  assert.deepEqual(movedBox({ x: 120, y: 800, w: 640, h: 100 }, { from: sent, to: { x: 50, y: 300, w: 1920, h: 300 } }), { x: 80, y: 300, w: 960, h: 150 });
  assert.deepEqual(movedBox(sent, undefined), sent, 'an element nobody moved stays where it is');
  const untouched = { ...videoItem({ assetId: 'caps', at: 6, in: 0, out: 7, volume: 0, box: sent, name: 'captions' }, W, H), visibleUntil: 13 };
  const again = (planFromPulled({ id: 'p', aspect: [W, H] }, [untouched] as unknown as PulledItem[], () => 'media/caps.webm', () => origin).plan.parts[0] as { origin: { asLayer: object } }).origin.asLayer;
  assert.ok(!('shift' in again) && !('moved' in again), 'an element nobody touched needs no shift and no move');
});

test('veed-pull: only VEED ids and VEED\'s own https hosts are taken from a saved project', () => {
  assert.ok(isVeedId(ID(1)));
  for (const bad of ['../../x', `${ID(1)}/..`, '', 42]) assert.ok(!isVeedId(bad), String(bad));
  assert.ok(veedMediaUrl('https://cdn-user.veed.io/srcVideo/a.mp4', 'https://www.veed.io'));
  for (const bad of ['https://evil.example/a.mp4', 'http://cdn-user.veed.io/a.mp4', 'https://veed.io.evil.example/a', 'file:///etc/passwd', 'not a url', undefined]) {
    assert.equal(veedMediaUrl(bad, 'https://www.veed.io'), null, String(bad));
  }
});

/** Runs a bookmarklet the way a click does, against a stand-in page and API. */
async function click(code: string, o: { origin?: string; path?: string; clipboard?: string; api?: (method: string, path: string, body: unknown) => { status?: number; json?: unknown } }) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const alerts: string[] = [];
  const location = { origin: o.origin ?? 'https://www.veed.io', pathname: o.path ?? '/', href: '/' };
  const context = vm.createContext({
    location, alert: (m: string) => alerts.push(m), prompt: () => null, crypto: { randomUUID: () => 'fresh' },
    navigator: { clipboard: { readText: async () => o.clipboard ?? '' } }, atob, TextDecoder, Uint8Array, JSON, URL,
    fetch: async (path: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      const r = o.api?.(method, path, body) ?? {};
      return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => JSON.stringify(r.json ?? {}), json: async () => r.json ?? {} };
    },
  });
  const url = bookmarkletUrl(code, 'https://www.veed.io');
  await vm.runInContext(decodeURIComponent(url.slice('javascript:'.length)), context);
  return { calls, alerts, location };
}

test('veed-project: the hand-off bookmark lays the timeline only in a fresh project, with copied media remapped', async () => {
  const bundle: Bundle = { v: BUNDLE_VERSION, project: ID(1), items: [{ assetId: ID(7), category: 'video' }, { category: 'text', metadata: { value: 'Привет — ok ✓' } }], copy: { from: ID(2), assets: [ID(7)] } };
  const handoff = `openedit=${encodeBundle(bundle)}`;
  const api = (method: string, path: string) => (path.endsWith('/timeline/') ? { json: { data: [] } } : path === '/api/v1/asset/duplicate' ? { json: { data: { assetMappings: { [ID(7)]: ID(8) } } } } : {});
  const ok = await click(BOOKMARKLET, { clipboard: handoff, api });
  assert.deepEqual(ok.alerts, []);
  const put = ok.calls.find((c) => c.method === 'PUT')!;
  assert.equal(put.path, `/api/v1/project/${ID(1)}/`);
  assert.deepEqual(put.body, { privacy: 'private', timelineItems: [{ assetId: ID(8), category: 'video', id: 'fresh' }, { category: 'text', metadata: { value: 'Привет — ok ✓' }, id: 'fresh' }] });
  assert.equal(ok.location.href, `/edit/${ID(1)}`);

  const refusals: [string, Parameters<typeof click>[1], RegExp][] = [
    ['another site', { origin: 'https://veed.io.evil.example', clipboard: handoff }, /click this bookmark on https:\/\/www\.veed\.io/],
    ['the right host on another port', { origin: 'https://www.veed.io:8443', clipboard: handoff }, /click this bookmark on/],
    ['an item naming a file that is not an id', { clipboard: `openedit=${encodeBundle({ ...bundle, items: [{ assetId: '../../x', category: 'video' }] })}`, api }, /not a project or file id/],
    ['a project id that walks the API', { clipboard: `openedit=${encodeBundle({ ...bundle, project: '../../v1/workspace/x' })}`, api }, /not a project or file id/],
    ['a project that already has a timeline', { clipboard: handoff, api: (m, p) => (p.endsWith('/timeline/') ? { json: { data: [{ id: 'x' }] } } : {}) }, /already has a timeline/],
    ['a copy that lost a file', { clipboard: handoff, api: (m, p) => (p.endsWith('/timeline/') ? { json: { data: [] } } : { json: { data: { assetMappings: {} } } }) }, /1 of the files were not copied/],
    ['a hand-off from another version', { clipboard: `openedit=${encodeBundle({ ...bundle, v: BUNDLE_VERSION - 1 } as unknown as typeof bundle)}`, api }, /install it again/],
    ['an id with something before it', { clipboard: `openedit=${encodeBundle({ ...bundle, project: `x${ID(1)}` })}`, api }, /not a project or file id/],
    ['an id with something after it', { clipboard: `openedit=${encodeBundle({ ...bundle, project: `${ID(1)}/..` })}`, api }, /not a project or file id/],
  ];
  for (const [what, o, why] of refusals) {
    const r = await click(BOOKMARKLET, o);
    assert.ok(r.alerts.some((a) => why.test(a)), `${what}: ${r.alerts.join(' | ')}`);
    assert.ok(!r.calls.some((c) => c.method === 'PUT'), `${what}: nothing is written`);
  }
});

test('veed-project: the "Send to Claude" bookmark runs only on the VEED site it was made for, and asks only for files by id', async () => {
  const saved: string[] = [];
  const pulled = await click(PULL_BOOKMARKLET, {
    path: `/edit/${ID(1)}`,
    api: (method, path) => (path.includes('/timeline/') ? { json: { data: [{ assetId: ID(5) }, { assetId: '../../v1/me' }, { assetId: null }] } } : { json: { data: [] } }),
  });
  for (const c of pulled.calls) saved.push(c.path);
  assert.ok(saved.includes(`/api/v1/asset/${ID(5)}`) && !saved.some((p) => p.includes('/me')), saved.join(' '));
  const r = await click(PULL_BOOKMARKLET, { origin: 'https://example.com' });
  assert.deepEqual([r.alerts, r.calls], [['OpenEdit: click this bookmark on https://www.veed.io'], []]);
  assert.throws(() => bookmarkletUrl(BOOKMARKLET, "https://a$'b.io"), /not an address a bookmark can be made for/);
});

test('veed-pull: a saved project\'s files are fetched only from VEED, saved only under their ids, and a failure fails the pull', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veed-pull-'));
  process.env.OPENEDIT_STATE_DIR = join(dir, 'state');
  mkdirSync(join(dir, 'state', 'veed-handoffs'), { recursive: true });
  const project = ID(1);
  // The project was made by copying from another, so its record knows the copy by its storage path only.
  writeFileSync(join(dir, 'state', 'veed-handoffs', `${project}.json`), JSON.stringify({ paths: { 'srcVideo/rec.mp4': { file: '/work/rec.mp4' } } }));
  const saved = join(dir, 'openedit.json');
  writeFileSync(saved, JSON.stringify({
    v: 1,
    project: { id: project, name: 'Rec', aspect: [W, H], fps: 30 },
    timeline: [{ ...videoItem({ assetId: ID(2), at: 0, in: 0, out: 3, volume: 1, name: 'rec' }, W, H), id: 'i1', visibleUntil: 3 }],
    subtitles: [{}],
    assets: [
      { id: ID(2), contentType: 'video/mp4', cdnUrl: 'https://cdn-user.veed.io/srcVideo/rec.mp4', filePath: 'srcVideo/rec.mp4' },
      { id: '../../../escape', contentType: 'video/mp4', cdnUrl: 'https://cdn-user.veed.io/a.mp4' },
      { id: ID(3), contentType: 'video/mp4', cdnUrl: 'https://evil.example/steal.mp4' },
    ],
  }));
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: URL, init: { headers: Record<string, string> }) => {
    asked.push({ url: String(url), headers: init.headers });
    return new Response(new Uint8Array([1, 2, 3]));
  }) as typeof fetch;
  const { veedPull } = await import('../src/commands/veed-pull.ts');
  let code: number;
  try {
    code = await veedPull([saved, '--out', join(dir, 'out')]);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.OPENEDIT_STATE_DIR;
  }
  assert.equal(code, 1, 'a file that did not download fails the pull');
  assert.deepEqual(asked.map((a) => a.url), ['https://cdn-user.veed.io/srcVideo/rec.mp4']);
  assert.ok(asked.every((a) => !('authorization' in a.headers)), 'no credential goes with a media download');
  const plan = JSON.parse(readFileSync(join(dir, 'out', 'plan.json'), 'utf8'));
  assert.deepEqual(plan.parts[0].origin, { file: '/work/rec.mp4' }, 'a copied file is known by its storage path');
  const asset = plan.source.assets[`media/${ID(2)}.mp4`];
  assert.deepEqual([asset.asset, asset.path, asset.bytes], [ID(2), 'srcVideo/rec.mp4', 3]);
});

/** A PNG of white pixels whose alpha `alpha(x, y)` gives. */
function png(w: number, h: number, alpha: (x: number, y: number) => number): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) raw.set([255, 255, 255, alpha(x, y)], y * (w * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('veed-project: a layer\'s frames give their true box, however thin or faint what they draw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'veed-scan-'));
  const frames = [
    png(64, 48, (x, y) => (y === 10 && x >= 8 && x < 48 ? 255 : 0)), // a hairline
    png(64, 48, (x, y) => (x >= 30 && x < 33 && y >= 20 && y < 23 ? 1 : 0)), // a dot at the faintest alpha
    png(64, 48, () => 0), // nothing
  ];
  frames.forEach((b, i) => writeFileSync(join(dir, `${String(i + 4).padStart(5, '0')}.png`), b));
  const scanned = await scanFrames(dir, 24, 4, 3);
  assert.deepEqual(scanned.slice(0, 2), [{ peak: 255, x1: 8, x2: 47, y1: 10, y2: 10 }, { peak: 1, x1: 30, x2: 32, y1: 20, y2: 22 }]);
  assert.equal(scanned[2].peak, 0);
  assert.ok(scanned[2].x2 < scanned[2].x1, 'an empty frame has no box');
});
