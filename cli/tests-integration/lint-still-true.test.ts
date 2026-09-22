// LINT RULES AGAINST THE INSTALLED ENGINE. Every rule in lint-template that forbids a construct because
// this engine renders it wrong was confirmed on one release. Nothing else keeps it true, so each rule
// is rendered here through the engine that is installed now: the construct and a control, one frame
// each, compared as pixels. The moment the engine renders the construct the way a browser would, the
// test fails and names the rule to DELETE. A rule the engine has outgrown blocks real capability.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineBinPath, engineEnv, FFMPEG } from '../src/config.ts';
import { engineReady, tmp } from './harness.ts';

const W = 160, H = 90;
const ready = engineReady();

/** Mean luma of the first frame of a one-element document, 0..255. */
function frame(name: string, body: string, css = ''): Uint8Array {
  const dir = tmp(`openedit-it-rule-${name}-`);
  writeFileSync(join(dir, 'template.wv'), `<html><style>${css}</style><body style="width:${W}px;height:${H}px;margin:0;background:#000">${body}</body></html>`);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ render: { width: W, height: H, fps: 10, duration: 0.5 } }));
  const out = join(dir, 'out.mp4');
  const r = spawnSync(engineBinPath(), [dir, '--record', out], { env: engineEnv(), cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `engine could not render the ${name} probe: ${r.stderr}`);
  const raw = execFileSync(FFMPEG, ['-nostdin', '-v', 'error', '-ss', '0.2', '-i', out, '-frames:v', '1', '-vf', 'format=gray', '-f', 'rawvideo', '-']);
  return new Uint8Array(raw.subarray(0, W * H));
}
const mean = (px: Uint8Array) => px.reduce((s, v) => s + v, 0) / px.length;
const diff = (a: Uint8Array, b: Uint8Array) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
const same = (a: Uint8Array, b: Uint8Array) => diff(a, b) < 2;
const differs = (a: Uint8Array, b: Uint8Array) => diff(a, b) > 8;

const box = (extra = '', inner = '') => `<div id="a" style="position:absolute;left:30px;top:15px;width:100px;height:60px;background:#fff;z-index:1;${extra}">${inner}</div>`;

test('img-data-uri: an <img> with a data: URI still draws nothing', { skip: !ready && 'no engine installed' }, () => {
  // a 1x1 white png
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
  const withData = frame('data-uri', `<img id="a" src="data:image/png;base64,${png}" style="position:absolute;left:30px;top:15px;width:100px;height:60px;z-index:1">`);
  assert.ok(mean(withData) < 2, 'DELETE rule img-data-uri: the engine now draws a data: URI image');
});

test('clip-path-path-fn: clip-path: path() still does not produce the clipped shape', { skip: !ready && 'no engine installed' }, () => {
  // A correct clip leaves a 40x40 white square: mean luma about 28. The engine renders nothing (0.10.3).
  const clipped = frame('path-fn', box('clip-path:path("M0 0 L40 0 L40 40 L0 40 Z")'));
  const m = mean(clipped);
  assert.ok(m < 5 || m > 60, `DELETE rule clip-path-path-fn: the engine now clips with path() (mean ${m.toFixed(1)})`);
});

test('svg-stroke-var: a var() stroke still paints nothing', { skip: !ready && 'no engine installed' }, () => {
  const svg = (stroke: string) => `<svg id="a" style="position:absolute;left:0;top:0;z-index:1;color:#fff" width="${W}" height="${H}"><rect x="30" y="15" width="100" height="60" fill="none" stroke="${stroke}" stroke-width="20"/></svg>`;
  const literal = frame('stroke-literal', svg('#ffffff'));
  const viaVar = frame('stroke-var', svg('var(--c)'), ':root{--c:#ffffff}');
  assert.ok(mean(literal) > 20, 'the probe itself draws: a literal white stroke is visible');
  assert.ok(mean(viaVar) < 2, 'DELETE rule svg-stroke-var: the engine now resolves var() on an SVG stroke');
});

test('svg-css-transform: a CSS transform on an SVG child still does not move it', { skip: !ready && 'no engine installed' }, () => {
  const svg = (g: string) => `<svg id="a" style="position:absolute;left:0;top:0;z-index:1" width="${W}" height="${H}"><g ${g}><rect x="0" y="0" width="40" height="40" fill="#fff"/></g></svg>`;
  const still = frame('svg-still', svg(''));
  const css = frame('svg-css', svg('style="transform:translate(80px,40px)"'));
  const attr = frame('svg-attr', svg('transform="translate(80,40)"'));
  assert.ok(differs(still, attr), 'the probe itself works: the transform ATTRIBUTE moves the shape');
  assert.ok(same(still, css), 'DELETE rule svg-css-transform: the engine now applies a CSS transform to an SVG child');
});

test('radius-two-value: a two-value border-radius still renders square (one and four values round)', { skip: !ready && 'no engine installed' }, () => {
  const square = frame('radius-none', box());
  const round = frame('radius-one', box('border-radius:30px'));
  // Two equal values collapse to one and round; two UNEQUAL values are the form that drops out.
  const two = frame('radius-two', box('border-radius:30px 10px'));
  assert.ok(differs(square, round), 'the probe itself works: one radius value rounds the corners');
  assert.ok(same(square, two), 'DELETE rule radius-two-value: the engine now honours a two-value border-radius');
});

test('skew-ignored: skewX() still renders axis-aligned', { skip: !ready && 'no engine installed' }, () => {
  const straight = frame('skew-none', box());
  const skewed = frame('skew-x', box('transform:skewX(25deg)'));
  assert.ok(same(straight, skewed), 'DELETE rule skew-ignored: the engine now applies skewX()');
});

test('static-transform-wiped: an animated transform still replaces a static rotate()', { skip: !ready && 'no engine installed' }, () => {
  const kf = '@keyframes k{0%{transform:scale(1)}100%{transform:scale(1)}}';
  const rotated = frame('rot-static', box('transform:rotate(40deg)'));
  const animated = frame('rot-animated', box('transform:rotate(40deg);animation:k 1s linear both'), kf);
  const upright = frame('rot-none', box());
  assert.ok(differs(upright, rotated), 'the probe itself works: a static rotate shows');
  assert.ok(same(upright, animated), 'DELETE rule static-transform-wiped: the engine now composes a static rotate with an animated transform');
});
