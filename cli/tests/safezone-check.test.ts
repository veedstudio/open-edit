import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDocInsideRun, edgeZones, explainNoReport, nextCycle, triage, type Violation } from '../src/commands/safezone-check.ts';

const W = 1080, H = 1920, FPS = 30; // edge = 21.6px, hold = 8 frames
const v = (over: Partial<Violation>): Violation => ({
  element: 'cap3', zone: 'edge-bottom', severity: 'error', ink_intruding_fraction: 0.1, max_intrusion_px: 10,
  longest_run_frames: 40, alpha_at_max_intrusion: 1, ...over,
});

test('edgeZones: the four margins tile exactly what the generic 9:16 preset keeps out', () => {
  const z = Object.fromEntries(edgeZones(W, H).zones.map((e) => [e.name, e.rect]));
  assert.deepEqual(z['edge-top'], { x: 0, y: 0, w: 100, h: 11 });
  assert.deepEqual(z['edge-bottom'], { x: 0, y: 83, w: 100, h: 17 });
  assert.deepEqual(z['edge-left'], { x: 0, y: 0, w: 6, h: 100 });
  assert.deepEqual(z['edge-right'], { x: 89, y: 0, w: 11, h: 100 });
});

test('triage: a short, shallow crossing is an entry animation, not a placement — nothing to fix', () => {
  const [t] = triage([v({ longest_run_frames: 5, ink_intruding_fraction: 0.04, alpha_at_max_intrusion: 0.2 })], W, H, FPS);
  assert.equal(t.verdict, 'transient');
  assert.equal(t.action, '');
  assert.equal(t.visible, false, 'a slide-in still fading up is not a visible flick');
});

test('triage: a held line just over the margin is nudged inward by its depth plus 4px, on its own side', () => {
  const [t] = triage([v({ max_intrusion_px: 10.3 })], W, H, FPS);
  assert.equal(t.verdict, 'minor');
  assert.equal(t.side, 'bottom');
  assert.match(t.action, /up by 15px$/);
  const [r] = triage([v({ zone: 'edge-right', max_intrusion_px: 6.7 })], W, H, FPS);
  assert.match(r.action, /left by 11px$/);
});

test('triage: deeper than 2% of the short side, or over a quarter of the ink, is a re-placement', () => {
  assert.equal(triage([v({ max_intrusion_px: 34 })], W, H, FPS)[0].verdict, 'major');
  const [t] = triage([v({ max_intrusion_px: 8, ink_intruding_fraction: 0.4 })], W, H, FPS);
  assert.equal(t.verdict, 'major');
  assert.match(t.action, /top = 1594 - block height - 8/, 'the bottom band ends at 83% of 1920');
});

test('triage: each threshold sits where the rule says, on both sides of it', () => {
  const verdict = (over: Partial<Violation>) => triage([v({ max_intrusion_px: 60, ...over })], W, H, FPS)[0].verdict;
  // a quarter of a second at 30 fps is 8 frames: 7 is a flick, 8 is held
  assert.equal(verdict({ longest_run_frames: 7, ink_intruding_fraction: 0.05 }), 'transient');
  assert.equal(verdict({ longest_run_frames: 8, ink_intruding_fraction: 0.05 }), 'major');
  assert.equal(verdict({ longest_run_frames: 7, ink_intruding_fraction: 0.051 }), 'major');
  // 2% of the shorter side is 21.6px, and a quarter of the ink
  assert.equal(verdict({ max_intrusion_px: 21.6, ink_intruding_fraction: 0.25 }), 'minor');
  assert.equal(verdict({ max_intrusion_px: 21.7, ink_intruding_fraction: 0.25 }), 'major');
  assert.equal(verdict({ max_intrusion_px: 21.6, ink_intruding_fraction: 0.251 }), 'major');
});

test('triage: a block failing on both of its sides steps down a rung before it is placed', () => {
  const out = triage([v({ zone: 'edge-left', max_intrusion_px: 60 }), v({ zone: 'edge-right', max_intrusion_px: 60 })], W, H, FPS);
  assert.equal(out.length, 2);
  assert.ok(out.every((t) => /one rung down the size ladder/.test(t.action)));
});

test('triage: dressing is never fixed, and a warn zone never blocks', () => {
  assert.equal(triage([v({ element: 'credits-chrome', max_intrusion_px: 200, ink_intruding_fraction: 1 })], W, H, FPS)[0].verdict, 'chrome');
  assert.equal(triage([v({ severity: 'warn', max_intrusion_px: 200 })], W, H, FPS)[0].verdict, 'warn');
});

test('triage: a report without run counters falls back to the window, which can only overstate', () => {
  const [t] = triage([v({ longest_run_frames: undefined, window: { from: 1, to: 1.1 }, ink_intruding_fraction: 0.03 })], W, H, FPS);
  assert.equal(t.heldFrames, 3);
  assert.equal(t.verdict, 'transient');
});

test('triage: a custom zone has no edge, so the fix names the shortest way out instead of a side', () => {
  const [t] = triage([v({ zone: 'logo-corner' })], W, H, FPS);
  assert.equal(t.side, null);
  assert.match(t.action, /shortest way/);
});

test('triage: a report with neither run counters nor a window is never called transient', () => {
  const [t] = triage([v({ longest_run_frames: undefined, window: undefined, ink_intruding_fraction: 0.01, max_intrusion_px: 3 })], W, H, FPS);
  assert.equal(t.heldFrames, null, 'unknown stays unknown, not a sentinel number');
  assert.equal(t.verdict, 'minor');
});

test('triage: a run of text with no id keeps its quotes and is never prefixed with #', () => {
  const [t] = triage([v({ element: '"ROOM"' })], W, H, FPS);
  assert.equal(t.element, '"ROOM"');
  assert.equal(triage([v({ element: '"credits-chrome"' })], W, H, FPS)[0].verdict, 'chrome');
});

test('nextCycle: counts consecutive blocking checks and a clean one clears it', () => {
  assert.equal(nextCycle(0, 2), 1);
  assert.equal(nextCycle(2, 1), 3, 'the third is the one the message calls over budget');
  assert.equal(nextCycle(3, 0), 0);
});

test('explainNoReport: each cause is named as itself, never as "your engine is too old"', () => {
  const base = { status: 1, signal: null, stderr: '', knowsRules: true };
  assert.match(explainNoReport({ ...base, error: 'spawn ENOENT' }), /could not be started.*install-engine/);
  assert.match(explainNoReport({ ...base, status: null, signal: 'SIGKILL' }), /killed by SIGKILL/);
  assert.match(explainNoReport({ ...base, knowsRules: false }), /probably predates the safe-zone check/);
  // what the engine itself said outranks the guess from its help text
  assert.match(explainNoReport({ ...base, knowsRules: false, stderr: 'no window server\n' }), /no window server/);
  assert.match(explainNoReport({ ...base, knowsRules: false, stderr: 'no window server\n' }), /no window server.*install-engine/, 'and the update is still offered');
  assert.doesNotMatch(explainNoReport({ ...base, stderr: 'no window server\n' }), /install-engine/);
  const sandboxed = explainNoReport({ ...base, stderr: 'a\nb\nno window server\n' });
  assert.match(sandboxed, /no window server/, "the engine's own words reach the reader");
  assert.match(sandboxed, /outside one/);
});

test('assertDocInsideRun: a chapter path is fine, one that climbs out of the run is refused', () => {
  assert.equal(assertDocInsideRun('final'), 'final');
  assert.equal(assertDocInsideRun('chapters/act-3'), 'chapters/act-3');
  for (const bad of ['../other', 'chapters/../../x', '/etc', '']) assert.throws(() => assertDocInsideRun(bad), /not a directory under the run/);
});

