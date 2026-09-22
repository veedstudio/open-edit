import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildRemediationPlan,
  DEFAULT_BAR,
  droppedSelectors,
  DEFAULT_MIN_LEAD_RATIO,
  expandSelector,
  humaniseSelector,
  resolveChoiceTargets,
  isMainModule,
  missingToolError,
  planPromotion,
  proposalLine,
  readFreshStatistics,
  shouldRunApplier,
  summarizeStatistics,
  wcagDetectDecision,
  wcagPassDecision,
  type ClassProposal,
  type Rung,
  type WcagRunSummary,
} from '../src/commands/wcag-pass.ts';
import { validateChoiceEntry, type ChoiceEntry } from '../src/wcag/wcag-choice.ts';
import { scoreWindow, slidingWindows, windowSize } from '../src/wcag/windows.ts';
import { effectiveThreshold } from '../src/wcag/policy.ts';
import type {
  ClusterStat, ElementStat, FrameStat, Statistics,
} from '../src/wcag/verdicts.ts';
import {
  compositeLuminance,
  ratioFromLuminance,
  relativeLuminance,
  type Rgba,
  type Srgb8,
} from '../src/wcag/policy.ts';

const hexToRgb = (h: string): Srgb8 => ({
  r: parseInt(h.slice(1, 3), 16),
  g: parseInt(h.slice(3, 5), 16),
  b: parseInt(h.slice(5, 7), 16),
});

const rgb = (r: number, g: number, b: number): Srgb8 => ({ r, g, b });
const WHITE = rgb(255, 255, 255);
const BLACK = rgb(0, 0, 0);
const Z3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

const cluster = (color: Srgb8, weight = 1.0): ClusterStat => ({ color, weight, covariance: Z3 });

const frame = (fg: Rgba, clusters: ClusterStat[], over: Partial<FrameStat> = {}): FrameStat => ({
  frame: 0, fg, font_size: 16, font_weight: 400, unsampled: false, clusters, ...over,
});

const element = (id: string, fg: Rgba, clusters: ClusterStat[], over: Partial<ElementStat> = {}): ElementStat => ({
  id,
  rect: { x: 0, y: 0, w: 100, h: 20 },
  font_size: 16,
  font_weight: 400,
  steady_alpha: fg.a,
  fg,
  total_samples: 100,
  total_frames: 1,
  unscored_transient_frames: 0,
  sampled_transient_frames: 0,
  indeterminate: false,
  clusters: clusters.map((c) => ({ ...c, frames: [0] })),
  frames: [frame(fg, clusters)],
  ...over,
});

const stats = (...elements: ElementStat[]): Statistics => ({
  version: 1, fps: 30, budget_overflow_frames: 0, elements,
});

const classOf = (map: Record<string, string>) => (id: string) => map[id] ?? null;
const opaque = (c: Srgb8): Rgba => ({ ...c, a: 1.0 });
const GRAY = rgb(0x99, 0x99, 0x99); // ~2.85:1 on white — fails AA normal

// The gate scores with the analyzer's CLI defaults.
test('gate knobs mirror the analyzer defaults', () => {
  assert.equal(DEFAULT_BAR, 0.1);
  assert.equal(DEFAULT_MIN_LEAD_RATIO, 2.0);
});

// ---------------------------------------------------------------------------
// humaniseSelector — the group label the agent reads out.
// ---------------------------------------------------------------------------

test('humaniseSelector: drops the key sigil, separates on -/_/., sentence-cases', () => {
  assert.equal(humaniseSelector('.caption-emph'), 'Caption emph');
  assert.equal(humaniseSelector('.big_text'), 'Big text');
  assert.equal(humaniseSelector('#kicker'), 'Kicker');
  // A COMPOSITE class key is dot-joined (rollup parity) — the dot is a separator,
  // not part of a word.
  assert.equal(humaniseSelector('.fade.w'), 'Fade w');
  // Degenerate input is returned as-is rather than becoming an empty label.
  assert.equal(humaniseSelector('.'), '.');
});

// ---------------------------------------------------------------------------
// summarizeStatistics — the per-class proposal, on engineered statistics.
// Every text of a class takes the SAME remediation, so a class gets ONE offer.
// ---------------------------------------------------------------------------

const kinds = (p: ClassProposal) => p.rungs.map((r) => r.kind);

test('summarize: all passing -> passed, no proposals', () => {
  const s = summarizeStatistics(stats(element('a', opaque(BLACK), [cluster(WHITE)])), classOf({}));
  assert.equal(s.passed, true);
  assert.equal(s.failingRuns, 0);
  assert.equal(s.anyApplicable, false);
  assert.deepEqual(s.proposals, []);
});

test('summarize: an audit that examined NOTHING is not a pass', () => {
  // The engine writes its own report beside the statistics and calls zero audited runs a failure;
  // this layer does not read that report, so nothing else can contradict a wrong verdict here.
  // `failingAA === 0` alone made an empty audit the strongest possible result, and three benchmark
  // runs shipped "WCAG AA: all text runs pass" over a statistics file with no elements in it.
  const s = summarizeStatistics(stats(), classOf({}));
  assert.equal(s.totalRuns, 0);
  assert.equal(s.failingRuns, 0);
  assert.equal(s.passed, false, 'zero runs audited is a failed audit, not a clean one');
});

test('summarize: failing gray-on-white class -> ONE offer for the class, colour leading', () => {
  // Derivation: #999999 on white is ~2.85 < 4.5 -> both members fail; the dark
  // recolor boundary (luminance <= 0.18333) clears white completely -> lead
  // within bar and NO exceptions, so one colour covers the whole class.
  const s = summarizeStatistics(
    stats(
      element('w1', opaque(GRAY), [cluster(WHITE)]),
      element('w2', opaque(GRAY), [cluster(WHITE)]),
      element('ok', opaque(BLACK), [cluster(WHITE)]),
    ),
    classOf({ w1: 'w', w2: 'w' }),
  );
  assert.equal(s.passed, false);
  assert.equal(s.totalRuns, 3);
  assert.equal(s.failingRuns, 2);
  assert.equal(s.anyApplicable, true);
  // ONE proposal for the whole class — never one per member.
  assert.equal(s.proposals.length, 1);
  const p = s.proposals[0];
  assert.equal(p.selector, '.w');
  assert.equal(p.failing, 2);
  assert.equal(p.total, 2);
  assert.equal(p.colourRuledOut, false);
  assert.equal(kinds(p)[0], 'colour', 'colour leads when it covers the class');
  assert.match(p.rungs[0].hex, /^#[0-9a-f]{6}$/);
  assert.ok(p.rungs[0].worstRatio >= 4.5, 'the offered colour actually clears AA');
});

test('summarize: a member the class colour cannot cover -> colour withheld for the WHOLE class', () => {
  // Derivation: member b sits on #595959 while the class colour optimizes the
  // pooled 99% white mass, so b lands in the roll-up's `exceptions`. Under the
  // common-denominator rule that means NO colour satisfies the class — the
  // offer drops to shadow/box rather than splitting per member.
  const s = summarizeStatistics(
    stats(
      element('a', opaque(GRAY), [cluster(WHITE)], { total_samples: 99 }),
      element('b', opaque(GRAY), [cluster(rgb(0x59, 0x59, 0x59))], { total_samples: 1 }),
    ),
    classOf({ a: 'w', b: 'w' }),
  );
  assert.equal(s.proposals.length, 1, 'no per-member exception proposal');
  const p = s.proposals[0];
  assert.equal(p.selector, '.w');
  assert.equal(p.colourRuledOut, true);
  assert.ok(!kinds(p).includes('colour'), 'a colour that fails one member is not offered');
  // No soft stack covers this pair, but a hard ring replaces the background
  // outright and does — so the class still gets a shadow to choose.
  assert.deepEqual(kinds(p), ['shadow', 'background']);
  assert.equal(p.rungs[0].recipe!.style, 'hard');
  assert.equal(s.anyApplicable, false, 'nothing for the automatic colours-only path to apply');
});

// policy.ts hands back TWO colour candidates: a subtle hue-preserving lead that
// is within bar on the POOLED clusters, and a strict mass-argmin alternative
// (typically the black/white anchor). Only the lead was window-tested, so a lead
// whose failing mass is concentrated in one second lost the class its colour rung
// even when the alternative would have cleared every window.
test('summarize: when the lead colour fails a window, the alternative is tried', () => {
  // Bimodal background: mostly dark, with a bright band the subtle lead cannot
  // cover. The anchor alternative clears both modes.
  const bright = cluster(WHITE, 0.35);
  const dark = cluster(rgb(12, 12, 12), 0.65);
  const s = summarizeStatistics(
    stats(
      element('w1', opaque(rgb(0x88, 0x88, 0x88)), [dark, bright]),
      element('w2', opaque(rgb(0x88, 0x88, 0x88)), [dark, bright]),
    ),
    classOf({ w1: 'w', w2: 'w' }),
  );
  const p = s.proposals[0];
  // Whatever colour is offered, it must clear every window — and if one exists,
  // the class must not be told no colour satisfies AA.
  const colour = p.rungs.find((r) => r.kind === 'colour');
  if (colour) assert.ok(colour.worstRatio >= 4.5, 'an offered colour must clear AA');
  assert.equal(p.colourRuledOut, !colour, 'colourRuledOut must agree with what was offered');
});

// The rung is ACCEPTED by a per-window test but REPORTED the roll-up's pooled
// estimate. The two are different numbers, and the reported one flows into the
// plan and the CSS evidence comment — so the evidence describes a composite the
// approval never used.
test('summarize: the colour rung reports the window that bound it, not a pooled estimate', () => {
  // Heterogeneous backgrounds so pooled and per-window genuinely differ, and mild
  // enough that a colour is still offered.
  const st = stats(
    element('w1', opaque(GRAY), [cluster(WHITE)]),
    element('w2', opaque(GRAY), [cluster(rgb(200, 200, 200))]),
  );
  const s = summarizeStatistics(st, classOf({ w1: 'w', w2: 'w' }));
  const colour = s.proposals[0].rungs.find((r) => r.kind === 'colour')!;
  assert.ok(colour, 'this fixture must offer a colour, or the test proves nothing');

  // Recompute the binding window independently: the worst score, over every
  // window of every member, for the colour that was actually offered.
  const k = windowSize(st);
  const hex = hexToRgb(colour.hex);
  let binding = Infinity;
  for (const e of st.elements) {
    for (const w of slidingWindows(e, k)) {
      const r = effectiveThreshold('AA', w.fontSize, w.fontWeight, null);
      binding = Math.min(binding, scoreWindow(w, hex, w.fgAlpha, r, DEFAULT_MIN_LEAD_RATIO).worstRatio);
    }
  }
  assert.ok(
    Math.abs(colour.worstRatio - binding) < 1e-9,
    `reported ${colour.worstRatio} but the binding window scored ${binding}`,
  );
});

test('summarize: a mid-tone background offers all three rungs, shadow with a solved recipe', () => {
  // Amber over mid-gray: a colour clears it, and the falloff solver finds a
  // recipe too — this is the case where the user really does get a choice.
  const s = summarizeStatistics(
    stats(element('x', opaque(rgb(230, 184, 102)), [cluster(rgb(150, 150, 150))])),
    classOf({}),
  );
  const p = s.proposals[0];
  assert.deepEqual(kinds(p), ['colour', 'shadow', 'background']);
  const shadow = p.rungs.find((r) => r.kind === 'shadow')!;
  // The shadow is SOLVED, not guessed: it carries the recipe that reaches AA.
  // A soft stack leads here, since one exists over this mid-tone background.
  const recipe = shadow.recipe!;
  assert.notEqual(recipe.style, 'hard', 'the lighter soft stack leads when it covers');
  assert.ok(recipe.style !== 'hard' && recipe.layers >= 1 && recipe.blur > 0);
  assert.ok(shadow.worstRatio >= 4.5, 'the offered shadow actually clears AA');
  assert.equal(shadow.hex, '#000000', 'a dark halo is what lifts light text off mid-grey');
});

// The common-denominator rule is the whole point of a per-class offer: the class
// colour is already validated against every member (rollupClass's exceptions),
// and shadow/background must be held to the same bar. Only backgrounds were
// pooled — the foreground came from one member — so a class mixing alphas was
// offered a fix that covers only the member it was solved from.
test('summarize: an offered rung clears AA for EVERY member, not just the first', () => {
  // Same white text twice; `#w2` is faded to alpha 0.30 by the template. A black
  // shadow/plate solved from the opaque member does not carry the faded one:
  // white at 0.30 over black composites to ~0.30 -> ~7:1, but at lower alphas the
  // gap is what this guards. Both members must clear their own threshold.
  const s = summarizeStatistics(
    stats(
      element('w1', { ...WHITE, a: 1.0 }, [cluster(WHITE)]),
      element('w2', { ...WHITE, a: 0.12 }, [cluster(WHITE)]),
    ),
    classOf({ w1: 'w', w2: 'w' }),
  );
  const p = s.proposals[0];
  assert.equal(p.selector, '.w');
  // Whatever survives must be sound for BOTH members. White at alpha 0.12 over a
  // black plate reaches only ~1.6:1, so the background rung cannot be offered.
  for (const r of p.rungs) {
    assert.notEqual(r.kind, 'background', `background solved from one member only: ${JSON.stringify(r)}`);
  }
});

test('summarize: rungs do not depend on the order the engine emitted elements', () => {
  // policy.ts sorts class members by id; the proposal walk must agree, or the
  // recommended colour flips between runs of an unchanged template.
  const a = element('a', opaque(rgb(0x99, 0x99, 0x99)), [cluster(WHITE)]);
  const z = element('z', opaque(rgb(0x33, 0x33, 0x33)), [cluster(WHITE)]);
  const forward = summarizeStatistics(stats(a, z), classOf({ a: 'cap', z: 'cap' }));
  const reverse = summarizeStatistics(stats(z, a), classOf({ a: 'cap', z: 'cap' }));
  assert.deepEqual(reverse.proposals, forward.proposals);
});

test('summarize: translucent white on grey -> no colour, no soft stack, but a hard ring', () => {
  // Derivation: white text at alpha 0.6 over grey #808080 (L 0.2159) composites
  // to 0.6 + 0.4*0.2159 = 0.6864 -> 2.77:1, and NO text colour reaches 4.5 at
  // that opacity (the darkest available is 0.4*0.2159 -> 1.95:1). The strongest
  // SOFT stack covers 0.855 of the ring, which the element's own 60% opacity cuts
  // to 0.513 -> 4.46:1, just short. A hard ring covers all of it, so 0.6 of the
  // adjacent colour becomes black -> 5.02:1, and the class keeps a lighter option
  // than the box.
  const s = summarizeStatistics(
    stats(element('t', { ...WHITE, a: 0.6 }, [cluster(rgb(128, 128, 128))])),
    classOf({}),
  );
  assert.equal(s.anyApplicable, false);
  const p = s.proposals[0];
  assert.equal(p.selector, '#t'); // class-less text is keyed by id
  assert.equal(p.colourRuledOut, true);
  assert.deepEqual(kinds(p), ['shadow', 'background']);
  assert.equal(p.rungs[0].recipe!.style, 'hard');
  assert.ok(p.rungs[0].worstRatio >= 4.5);
  const box = p.rungs[1];
  assert.deepEqual({ hex: box.hex, backingHex: box.backingHex }, { hex: '#ffffff', backingHex: '#000000' });
});

test('summarize: near-invisible text -> NO rungs at all (honest, nothing reaches AA)', () => {
  // Derivation: at alpha 0.02 every composite hugs the background: best
  // recolor ratio ~1.07, halo ~1.4, backing ~1.4 — nothing reaches 4.5.
  const s = summarizeStatistics(
    stats(element('t', { ...rgb(0x76, 0x76, 0x76), a: 0.02 }, [cluster(WHITE)])),
    classOf({}),
  );
  assert.equal(s.anyApplicable, false);
  assert.deepEqual(s.proposals[0].rungs, []);
  assert.match(proposalLine(s.proposals[0]), /no remediation reaches AA — human review/);
});

test('summarize: an unsampleable sibling is flagged but does NOT block the class offer', () => {
  const s = summarizeStatistics(
    stats(
      element('w1', opaque(GRAY), [cluster(WHITE)]),
      element('w2', opaque(GRAY), [], { indeterminate: true, frames: [] }),
    ),
    classOf({ w1: 'w', w2: 'w' }),
  );
  assert.equal(s.indeterminateRuns, 1);
  assert.equal(s.failingRuns, 2); // indeterminate fails AA too
  const p = s.proposals[0];
  assert.equal(p.unsampleable, 1);
  assert.equal(p.failing, 2, 'the unsampleable member counts as failing, as the header does');
  assert.equal(p.total, 2);
  // The measurable member still gets its colour — an unsampleable sibling must
  // not silently withdraw the offer for the rest of the class.
  assert.equal(kinds(p)[0], 'colour');
  assert.match(proposalLine(p), /\(1 unsampleable\)$/);
});

// The headline count and the per-class lines are read together by the user, so
// they have to describe the same set. The pass's stated contract is that nothing
// failing goes unlisted; class lines that cannot sum to the header break it.
test('summarize: the per-class failing counts sum to the headline count', () => {
  const s = summarizeStatistics(
    stats(
      element('w1', opaque(GRAY), [cluster(WHITE)]),
      element('w2', opaque(GRAY), [], { indeterminate: true, frames: [] }),
      element('k', { ...WHITE, a: 0.5 }, [cluster(WHITE)]),
      element('ok', opaque(BLACK), [cluster(WHITE)]),
    ),
    classOf({ w1: 'w', w2: 'w' }),
  );
  const summed = s.proposals.reduce((n, p) => n + p.failing, 0);
  assert.equal(summed, s.failingRuns, `class lines sum to ${summed}, header says ${s.failingRuns}`);
});

// ---------------------------------------------------------------------------
// A FLAT BACKGROUND OVERRIDES THE SAMPLES.
//
// The background rung puts the text on a solid plate, so what the sampler saw
// behind it stops mattering entirely — we control both the text colour and the
// plate, and the rating must depend on neither the clusters nor their weights.
//
// The fixtures are HOSTILE on purpose (one caption over bright sky AND dark
// shadow). Over ordinary backgrounds this comparison is vacuous: text that fails
// over white passes over black, so there is no case to compare across.
// ---------------------------------------------------------------------------

const HOSTILE: Record<string, ClusterStat[]> = {
  'sky+shadow': [cluster(WHITE, 0.5), cluster(BLACK, 0.5)],
  'three-way': [cluster(rgb(250, 250, 250), 0.34), cluster(BLACK, 0.33), cluster(rgb(128, 128, 128), 0.33)],
  'near-extremes': [cluster(rgb(240, 240, 240), 0.6), cluster(rgb(20, 20, 20), 0.4)],
};

// The reference rating, composed from the policy primitives rather than by
// calling the code under test.
const ratioOver = (fg: Srgb8, a: number, behind: Srgb8) => {
  const lB = relativeLuminance(behind);
  return ratioFromLuminance(compositeLuminance(relativeLuminance(fg), a, lB), lB);
};

const proposalOver = (fg: Rgba, clusters: ClusterStat[]) =>
  summarizeStatistics(stats(element('t', fg, clusters)), classOf({})).proposals[0];

const boxOf = (p?: ClassProposal) => p?.rungs.find((r) => r.kind === 'background');

test('background rung: identical over every sampled background', () => {
  const fg = opaque(rgb(0xc8, 0xc8, 0xc8));
  const boxes = Object.keys(HOSTILE).map((n) => JSON.stringify(boxOf(proposalOver(fg, HOSTILE[n]))));
  assert.equal(new Set(boxes).size, 1, `the plate must not move with the samples: ${boxes.join(' | ')}`);
  assert.notEqual(boxes[0], 'undefined', 'and it must actually be offered');
  // Discriminator: the COLOUR rung DOES read the samples, so the fixtures really
  // do differ — without this the test could pass on identical inputs.
  const colours = Object.keys(HOSTILE).map((n) =>
    String(proposalOver(fg, HOSTILE[n])?.rungs.find((r) => r.kind === 'colour')?.hex));
  assert.ok(new Set(colours).size > 1, `the colour rung should vary: ${colours.join(', ')}`);
});

test('background rung: its rating is fg-over-plate exactly, with no cluster term', () => {
  for (const v of [0x20, 0x76, 0xc8, 0xff]) {
    for (const a of [1.0, 0.8, 0.5]) {
      for (const name of Object.keys(HOSTILE)) {
        const box = boxOf(proposalOver({ ...rgb(v, v, v), a }, HOSTILE[name]));
        if (!box) continue; // withheld is a separate claim (see below)
        // EXACT: a plate replaces the background outright, so any cluster term
        // leaking in is a structural regression, not float noise.
        assert.equal(
          box.worstRatio,
          ratioOver(hexToRgb(box.hex), a, hexToRgb(box.backingHex!)),
          `#${v.toString(16)} a=${a} over ${name}`,
        );
      }
    }
  }
});

test('background rung: for OPAQUE text it is always offered and always clears AA', () => {
  for (let v = 0; v <= 255; v++) {
    for (const name of Object.keys(HOSTILE)) {
      const p = proposalOver(opaque(rgb(v, v, v)), HOSTILE[name]);
      if (!p) continue; // already passing — nothing to remediate
      const box = boxOf(p);
      assert.ok(box, `#${v.toString(16)} over ${name} must be offered a plate`);
      assert.ok(box!.worstRatio >= 4.5, `#${v.toString(16)} over ${name} plate must clear AA`);
    }
  }
});

// ...and the bound on that: the plate is painted BY the text element, so the
// element's opacity multiplies it exactly as it multiplies the glyph. A 40%
// caption shows a 40% plate with the footage still coming through, which is
// neither a blank slate nor enough to clear AA — offering it would ship a box
// the render never draws.
test('background rung: at reduced opacity the plate is diluted, and withheld', () => {
  for (const name of Object.keys(HOSTILE)) {
    const box = boxOf(proposalOver({ ...WHITE, a: 0.4 }, HOSTILE[name]));
    assert.equal(box, undefined, `a 40% plate must not be offered over ${name}: ${JSON.stringify(box)}`);
  }
  // The discriminator: the SAME text at full opacity is offered a plate.
  assert.ok(boxOf(proposalOver(opaque(WHITE), HOSTILE['sky+shadow'])), 'opaque text still gets its box');
});

// ---------------------------------------------------------------------------
// THE LADDER TERMINATES.
// ---------------------------------------------------------------------------

test('for OPAQUE text, some rung always clears AA — over any background', () => {
  for (let v = 0; v <= 255; v++) {
    for (const name of Object.keys(HOSTILE)) {
      const p = proposalOver(opaque(rgb(v, v, v)), HOSTILE[name]);
      if (!p) continue;
      assert.ok(
        p.rungs.some((r) => r.worstRatio >= 4.5),
        `#${v.toString(16)} over ${name} was offered nothing that reaches AA`,
      );
    }
  }
});

test('when the text\'s own alpha puts AA out of reach, no rung is invented', () => {
  // At alpha 0.15 white text composites almost entirely into whatever sits
  // behind it, so no plate and no ring can separate the two.
  const p = proposalOver({ ...WHITE, a: 0.15 }, [cluster(WHITE)]);
  assert.ok(p, 'the failure must still be reported');
  assert.deepEqual(p.rungs, [], 'and nothing may be offered that cannot be delivered');
  assert.match(proposalLine(p), /no remediation reaches AA — human review/);
});

// ---------------------------------------------------------------------------
// proposalLine — the report line each offer renders to.
// ---------------------------------------------------------------------------

test('proposalLine: names the class, the counts, and every rung in order', () => {
  const line = proposalLine({
    selector: '.w', label: 'W', ids: ['w1', 'w2'], failing: 2, total: 3, colourRuledOut: false, unsampleable: 0,
    rungs: [
      { kind: 'colour', hex: '#767676', massPct: 0, worstRatio: 4.6 },
      { kind: 'shadow', hex: '#000000', recipe: { layers: 3, blur: 8 }, massPct: 0, worstRatio: 5.1 },
      { kind: 'background', hex: '#ffffff', backingHex: '#000000', massPct: 0, worstRatio: 21 },
    ],
  });
  assert.equal(line, '.w (2/3 failing): colour #767676 | shadow #000000 x3 @ 8px | background #ffffff on #000000');
});

// The agent transcribes a pick from the printed line into wcag-choice.json, so a
// rung name the choice schema rejects makes the apply step abort. The two
// vocabularies must be the same words.
test('every rung kind the report prints is a kind the choice schema accepts', () => {
  const rungs: Rung[] = [
    { kind: 'colour', hex: '#767676', massPct: 0, worstRatio: 4.6 },
    { kind: 'shadow', hex: '#000000', recipe: { layers: 3, blur: 8 }, massPct: 0, worstRatio: 5.1 },
    { kind: 'background', hex: '#ffffff', backingHex: '#000000', massPct: 0, worstRatio: 21 },
  ];
  for (const r of rungs) {
    const entry = {
      level: 'AA', selector: '.w', kind: r.kind, hex: r.hex,
      ...(r.backingHex ? { backingHex: r.backingHex } : {}),
      ...(r.recipe ? { recipe: r.recipe } : {}),
    };
    assert.equal(validateChoiceEntry(entry), null, `kind ${r.kind} must be transcribable`);
  }
  // And the printed line uses those same tokens, never a synonym.
  const line = proposalLine({
    selector: '.w', label: 'W', ids: ['w1', 'w2'], failing: 1, total: 1, colourRuledOut: false, unsampleable: 0, rungs,
  });
  for (const r of rungs) assert.match(line, new RegExp(`\\b${r.kind}\\b`), `line must name ${r.kind}`);
});

test('proposalLine: says so plainly when no colour satisfies the class', () => {
  const line = proposalLine({
    selector: '.w', label: 'W', ids: ['w1', 'w2'], failing: 1, total: 1, colourRuledOut: true, unsampleable: 0,
    rungs: [{ kind: 'background', hex: '#ffffff', backingHex: '#000000', massPct: 0, worstRatio: 21 }],
  });
  assert.match(line, /no colour satisfies AA for the whole class — background #ffffff on #000000/);
});

// ---------------------------------------------------------------------------
// DETECT-mode decision (pure; the gate: report only, never promote).
// ---------------------------------------------------------------------------

const proposal = (over: Partial<ClassProposal> = {}): ClassProposal => ({
  selector: '.w',
  ids: ['w1', 'w2'],
  label: 'W',
  failing: 2,
  total: 2,
  colourRuledOut: false,
  unsampleable: 0,
  rungs: [{ kind: 'colour', hex: '#767676', massPct: 0, worstRatio: 4.6 }],
  ...over,
});

const summary = (over: Partial<WcagRunSummary>): WcagRunSummary => ({
  passed: false,
  totalRuns: 3,
  failingRuns: 2,
  indeterminateRuns: 0,
  anyApplicable: true,
  proposals: [proposal()],
  ...over,
});

test('detect: an audit of zero runs is attention with its own sentence, and offers nothing to apply', () => {
  const d = wcagDetectDecision(summary({ passed: false, totalRuns: 0, failingRuns: 0, proposals: [] }));
  assert.equal(d.status, 'attention');
  assert.equal(d.promoted, false);
  assert.match(d.notes[0], /0 runs audited/);
  assert.doesNotMatch(d.notes.join(' '), /0 of 0/);
  assert.equal(d.notes.length, 1, 'no offer line: there is no class to choose at');
});

test('detect: passing summary -> pass, never promoted', () => {
  const d = wcagDetectDecision(summary({ passed: true, failingRuns: 0, proposals: [] }));
  assert.equal(d.status, 'pass');
  assert.equal(d.promoted, false);
  assert.deepEqual(d.notes, ['WCAG AA: all text runs pass']);
});

test('detect: low-contrast summary -> attention, never promoted (detect writes nothing)', () => {
  const d = wcagDetectDecision(summary({}));
  assert.equal(d.status, 'attention');
  assert.equal(d.promoted, false); // detect NEVER promotes, even when a fix is applicable
});

test('detect note: leads with counts; one propose line per failing class follows', () => {
  const d = wcagDetectDecision(summary({}));
  // Counts come straight from the summary (failingRuns of totalRuns).
  assert.match(d.notes[0], /2 of 3 text elements are below AA/);
  // One line per class — not one per element.
  assert.deepEqual(d.notes.slice(1), ['propose: .w (2/2 failing): colour #767676']);
});

test('detect note: a second failing class gets its own line', () => {
  const d = wcagDetectDecision(summary({
    proposals: [
      proposal(),
      proposal({ selector: '.emph', label: 'Emph', failing: 1, total: 1, colourRuledOut: true, rungs: [
        { kind: 'shadow', hex: '#000000', recipe: { layers: 3, blur: 8 }, massPct: 0, worstRatio: 5.1 },
      ] }),
    ],
  }));
  assert.equal(d.notes.length, 3);
  assert.match(d.notes[2], /^propose: \.emph \(1\/1 failing\): no colour satisfies AA/);
});

test('isMainModule: matches the module own path, survives spaces in paths', () => {
  const own = join(tmpdir(), 'dir with space', 'wcag-pass.ts');
  const url = pathToFileURL(own).href;
  assert.equal(isMainModule(own, url), true);
  assert.equal(isMainModule(join(tmpdir(), 'other.ts'), url), false);
  assert.equal(isMainModule(undefined, url), false);
});

test('missing-tool errors name the env vars (actionable preflight)', () => {
  const engine = missingToolError('engine', '/x');
  assert.ok(engine.includes('VEED_ENGINE_BIN'));
  assert.ok(engine.includes('install-engine'));
  // The analyzer ships inside the engine now: nothing may send anyone to a
  // weave-renderer checkout or a cargo build.
  assert.doesNotMatch(engine, /cargo|weave-renderer|WCAG_CONTRAST_BIN/);
});

// ---------------------------------------------------------------------------
// Detect offer line — the --apply route.
// ---------------------------------------------------------------------------

test('detect offer line: names the apply route (the studio route is gone)', () => {
  const d = wcagDetectDecision(summary({}));
  assert.match(d.notes[0], /apply with wcag-pass --apply/);
  // The recommendation studio was removed: nothing may point a user at a page.
  assert.doesNotMatch(d.notes[0], /recommend\.ts|wcag-recommendations|\/wcag\//);
});

test('detect offer: NO pending clause when no choice exists (default arg)', () => {
  const d = wcagDetectDecision(summary({})); // choicePending defaults false
  assert.equal(d.status, 'attention');
  assert.doesNotMatch(d.notes[0], /choice is pending/);
});

test('detect offer: a pending choice adds an apply-it clause; still attention, never promoted', () => {
  const d = wcagDetectDecision(summary({}), true);
  assert.match(d.notes[0], /a choice is pending — apply it \(wcag-pass --apply\)/);
  assert.equal(d.status, 'attention');
  assert.equal(d.promoted, false);
});

test('detect: passing run WITH a pending choice -> attention (pending clause only)', () => {
  const d = wcagDetectDecision(summary({ passed: true, failingRuns: 0, proposals: [] }), true);
  assert.equal(d.status, 'attention');
  assert.equal(d.promoted, false);
  assert.match(d.notes[0], /a choice is pending — apply it \(wcag-pass --apply\)/);
  // Passing run has no below-AA offer and no proposals: the pending clause is
  // the ONLY note.
  assert.equal(d.notes.length, 1);
  assert.doesNotMatch(d.notes[0], /below AA/);
});

// ---------------------------------------------------------------------------
// buildRemediationPlan — the applier's input, from the same proposal walk the
// summary uses.
// ---------------------------------------------------------------------------

test('plan: passing statistics -> empty plan', () => {
  const p = buildRemediationPlan(stats(element('a', opaque(BLACK), [cluster(WHITE)])), classOf({}));
  assert.deepEqual(p, { level: 'AA', rules: [], notes: [] });
});

test('plan: within-bar class recolor -> one rule with evidence; hex is 6-digit lowercase', () => {
  // Derivation: #999999 on white fails (~2.85); the dark recolor lead clears
  // the single white cluster completely -> mass 0, one .w rule.
  const p = buildRemediationPlan(
    stats(
      element('w1', opaque(GRAY), [cluster(WHITE)]),
      element('w2', opaque(GRAY), [cluster(WHITE)]),
    ),
    classOf({ w1: 'w', w2: 'w' }),
  );
  assert.equal(p.rules.length, 1);
  // The class's own members, not the class key: as CSS `.w` would also match an
  // element whose classes are {fade, w}, which the roll-up scored separately.
  assert.equal(p.rules[0].selector, '#w1, #w2');
  assert.match(p.rules[0].hex, /^#[0-9a-f]{6}$/);
  assert.equal(p.rules[0].massPct, 0);
  assert.ok(p.rules[0].worstRatio >= 4.5, 'lead clears AA on its worst cluster');
  assert.deepEqual(p.notes, []);
});

test('plan: a member the class colour cannot cover -> NO rule at all, carried as a note', () => {
  // The automatic path applies one colour per CLASS. When no colour covers the
  // class, it must apply nothing rather than split into per-member rules.
  const p = buildRemediationPlan(
    stats(
      element('a', opaque(GRAY), [cluster(WHITE)], { total_samples: 99 }),
      element('b', opaque(GRAY), [cluster(rgb(0x59, 0x59, 0x59))], { total_samples: 1 }),
    ),
    classOf({ a: 'w', b: 'w' }),
  );
  // Empty IS the negative discriminator: the old behaviour emitted a `.w` class
  // rule plus a `#b` per-member rule here.
  assert.deepEqual(p.rules.map((r) => r.selector), []);
  assert.equal(p.notes.length, 1);
  assert.match(p.notes[0], /^\.w \(2\/2 failing\): no colour satisfies AA/);
});

test('plan: a background-only class -> no rule, carried as a note (colours-only policy)', () => {
  // #c8c8c8 at 80% over #b4b4b4: no colour clears, and neither a soft stack nor a
  // hard ring does once the element's own opacity dilutes it — only the box,
  // which also gets to recolour the text to its anchor.
  const p = buildRemediationPlan(
    stats(element('t', { ...rgb(0xc8, 0xc8, 0xc8), a: 0.8 }, [cluster(rgb(0xb4, 0xb4, 0xb4))])),
    classOf({}),
  );
  assert.deepEqual(p.rules, []);
  assert.equal(p.notes.length, 1);
  assert.match(p.notes[0], /no colour satisfies AA/);
  assert.match(p.notes[0], /background #ffffff on #000000/);
});

// ---------------------------------------------------------------------------
// shouldRunApplier / wcagPassDecision / planPromotion (pure APPLY-path layer).
// ---------------------------------------------------------------------------

test('shouldRunApplier: pending choice runs the applier even on a passing run', () => {
  assert.equal(shouldRunApplier(true, false, true), true, 'passing + choice must still run');
  assert.equal(shouldRunApplier(false, true, false), true); // auto: failing + applicable
  assert.equal(shouldRunApplier(false, false, true), true); // choice on a failing run
  // Negative discriminators: nothing to do.
  assert.equal(shouldRunApplier(true, true, false), false); // passing, no choice
  assert.equal(shouldRunApplier(false, false, false), false); // failing but nothing applicable, no choice
});

test('decision: passing template -> pass, no promotion', () => {
  const d = wcagPassDecision(summary({ passed: true, failingRuns: 0, proposals: [] }), null);
  assert.equal(d.status, 'pass');
  assert.equal(d.promoted, false);
});

test('decision: strictly fewer failing runs -> remediated + PROMOTED', () => {
  const before = summary({ failingRuns: 2, totalRuns: 3 });
  const after = summary({ passed: true, failingRuns: 0, proposals: [] });
  const d = wcagPassDecision(before, after);
  assert.equal(d.status, 'remediated');
  assert.equal(d.promoted, true);
  assert.ok(d.notes[0].includes('2 of 2 failing run(s) now pass'));
});

test('decision: partial improvement still promotes and lists the remaining residue', () => {
  const before = summary({ failingRuns: 2 });
  const after = summary({
    failingRuns: 1,
    proposals: [proposal({ selector: '#w2', label: 'W2', failing: 1, total: 1, unsampleable: 1, rungs: [] })],
  });
  const d = wcagPassDecision(before, after);
  assert.equal(d.status, 'remediated');
  assert.equal(d.promoted, true);
  assert.ok(d.notes.some((n) => n.startsWith('review (with your fix applied): #w2 (1/1 failing): indeterminate')));
});

test('decision: no measured improvement -> NOT promoted, original kept, honest note', () => {
  const d = wcagPassDecision(summary({ failingRuns: 2 }), summary({ failingRuns: 2 }));
  assert.equal(d.status, 'not-improved');
  assert.equal(d.promoted, false);
  assert.ok(d.notes[0].includes('did NOT improve'));
  assert.ok(d.notes[0].includes('original kept'));
});

test('decision: a user-chosen option promotes UNCONDITIONALLY, numbers as context', () => {
  const before = summary({ failingRuns: 2 });
  const after = summary({ failingRuns: 2 }); // 2 -> 2: no measured improvement
  const d = wcagPassDecision(before, after, { choiceApplied: true });
  assert.equal(d.status, 'remediated');
  assert.equal(d.promoted, true);
  assert.ok(d.notes[0].includes('your chosen option is applied'));
  assert.ok(d.notes[0].includes('2 -> 2 failing')); // honest context, not a veto
  // Negative discriminator: without choiceApplied the same inputs must still
  // be vetoed (the auto gate is unchanged).
  const auto = wcagPassDecision(before, after);
  assert.equal(auto.status, 'not-improved');
  assert.equal(auto.promoted, false);
});

test('decision: a choice on an ALREADY-passing run still promotes', () => {
  const passing = summary({ passed: true, failingRuns: 0, proposals: [] });
  const d = wcagPassDecision(passing, passing, { choiceApplied: true });
  assert.equal(d.status, 'remediated');
  assert.equal(d.promoted, true);
  assert.ok(d.notes[0].includes('your chosen option is applied'));
});

// The pass used to print TWO numbers — a raw re-sample that could not see a
// shadow, and a "credited" line that could. With the outcome computed against
// the constant samples there is nothing to reconcile, and reporting a second
// number would imply a second measurement that no longer happens.
test('decision note: ONE number, and it says what it was computed from', () => {
  const d = wcagPassDecision(summary({ failingRuns: 2 }), summary({ failingRuns: 0 }), { choiceApplied: true });
  assert.match(d.notes[0], /2 -> 0 failing \(computed against the original samples\)/);
  assert.doesNotMatch(d.notes[0], /re-audit|credited|measured directly|falloff/);
});

test('decision: nothing applicable -> residual, no promotion, residue reported', () => {
  const d = wcagPassDecision(summary({ failingRuns: 2, anyApplicable: false }), null);
  assert.equal(d.status, 'residual');
  assert.equal(d.promoted, false);
  assert.ok(d.notes[0].includes('no colour fix applies'));
  assert.ok(d.notes.some((n) => n.startsWith('review:')));
});

// ---------------------------------------------------------------------------
// expandSelector — a class KEY is not a CSS selector.
//
// The roll-up groups by the sorted composite class set, so `.w` names elements
// whose classes are exactly {w}; an element with class="fade w" forms its own
// class `.fade.w`. Emitted as CSS, `.w` would also match the latter — recolouring
// text that was passing and was never named in any proposal. Resolving the key to
// its member IDS makes what the applier targets identical to what the roll-up
// grouped, and an empty expansion IS the unmatched-selector error.
// ---------------------------------------------------------------------------

test('expandSelector: a class key resolves to exactly its own members', () => {
  const classOfComposite = (id: string) => ({ a: 'w', b: 'w', c: 'fade.w' }[id] ?? null);
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(expandSelector('.w', ids, classOfComposite), ['a', 'b']);
  // The composite class is a DIFFERENT class, not a member of `.w`.
  assert.deepEqual(expandSelector('.fade.w', ids, classOfComposite), ['c']);
  // Class-less text is keyed by id.
  assert.deepEqual(expandSelector('#c', ids, classOfComposite), ['c']);
});

test('expandSelector: an unknown key resolves to nothing (the unmatched-selector signal)', () => {
  const classOfComposite = (id: string) => ({ a: 'w' }[id] ?? null);
  assert.deepEqual(expandSelector('.caption_emph', ['a'], classOfComposite), []);
  assert.deepEqual(expandSelector('#nope', ['a'], classOfComposite), []);
});

// A hand-written choice that matches nothing would inject CSS selecting nothing,
// evaluate identically, and still promote — shipping an unchanged video reported
// as 'remediated'. It has to stop before the applier runs.
test('resolveChoiceTargets: a selector matching no element is a loud failure', () => {
  const classOfComposite = (id: string) => ({ a: 'w' }[id] ?? null);
  const audited = stats(element('a', opaque(WHITE), [cluster(WHITE)]));
  assert.throws(
    () => resolveChoiceTargets(
      [{ level: 'AA', selector: '.caption_emph', kind: 'colour', hex: '#ffffff' }],
      audited,
      classOfComposite,
    ),
    /\.caption_emph.*matches no audited text/s,
  );
  // A selector that does match resolves to its ids.
  assert.deepEqual(
    resolveChoiceTargets(
      [{ level: 'AA', selector: '.w', kind: 'colour', hex: '#ffffff' }],
      audited,
      classOfComposite,
    ),
    [{ selector: '#a', ids: ['a'] }],
  );
});

// The ids come from the STATISTICS, never from the template. A template carries
// ids the audit never measured — decorative nodes, and text the sampler skipped —
// and styling one of those is invisible to the analytic evaluation: the outcome
// is computed from the treatments, so the numbers improve while the promoted
// template holds a rule nothing ever scored.
test('resolveChoiceTargets: a class the audit never measured is refused', () => {
  // The template has both `.w` and `.hero`; the audit only ever saw `.w`.
  const classOfTemplate = (id: string) => ({ a: 'w', hero: 'hero' }[id] ?? null);
  const audited = stats(element('a', opaque(WHITE), [cluster(WHITE)]));
  assert.throws(
    () => resolveChoiceTargets(
      [{ level: 'AA', selector: '.hero', kind: 'colour', hex: '#ffffff' }],
      audited,
      classOfTemplate,
    ),
    /\.hero.*matches no audited text/s,
  );
});

// Two entries reaching the same element is not a merge: the applier emits both
// rules and CSS source-order picks the LAST, while the analytic evaluation takes
// the FIRST match. The number reported and the pixels shipped then describe
// different treatments.
test('resolveChoiceTargets: two entries on one element is a loud failure', () => {
  const classOfComposite = (id: string) => ({ a: 'w' }[id] ?? null);
  const audited = stats(element('a', opaque(WHITE), [cluster(WHITE)]));
  assert.throws(
    () => resolveChoiceTargets(
      [
        { level: 'AA', selector: '.w', kind: 'colour', hex: '#ffffff' },
        { level: 'AA', selector: '#a', kind: 'shadow', hex: '#000000' },
      ],
      audited,
      classOfComposite,
    ),
    /#a.*more than one/s,
  );
});

// Each apply REPLACES the whole injected block, so a second choice file is not
// additive: any class the earlier choice fixed and this one omits silently loses
// its remediation. A user asking to change one class would quietly undo the rest,
// and the pass would report the result as remediated either way.
test('droppedSelectors: names every class a new choice would silently un-fix', () => {
  const c = (selector: string): ChoiceEntry => ({ level: 'AA', selector, kind: 'colour', hex: '#000000' });
  assert.deepEqual(droppedSelectors([c('.w'), c('.hero')], [c('.w')]), ['.hero']);
  // Order and duplicates do not matter; the set does.
  assert.deepEqual(droppedSelectors([c('.hero'), c('.w'), c('.hero')], [c('.b'), c('.w')]), ['.hero']);
  // Nothing dropped: keeping everything, and adding to it, are both fine.
  assert.deepEqual(droppedSelectors([c('.w')], [c('.w'), c('.hero')]), []);
  assert.deepEqual(droppedSelectors([], [c('.w')]), []);
});

const hasOp = (plan: ReturnType<typeof planPromotion>, from: string, to: string) =>
  plan.some((o) => o.from === from && o.to === to);

test('planPromotion: FIRST promotion renames the original template to the draft', () => {
  const plan = planPromotion({ draftExists: false, choiceApplied: false, renderExists: false, muxedExists: false });
  assert.ok(hasOp(plan, 'template.wv', 'template.draft.wv'), 'first promotion must capture the original as draft');
  assert.ok(hasOp(plan, 'template.draft.wcag-remediated.wv', 'template.wv'), 'and promote the remediation');
  assert.ok(hasOp(plan, 'template.wv', 'template.final.wv'));
});

test('planPromotion: a REPEAT promotion never overwrites the existing draft', () => {
  const plan = planPromotion({ draftExists: true, choiceApplied: false, renderExists: false, muxedExists: false });
  assert.equal(hasOp(plan, 'template.wv', 'template.draft.wv'), false, 'must NOT clobber the preserved original');
  // It still re-points template.wv at the fresh remediation + re-clones final.
  assert.ok(hasOp(plan, 'template.draft.wcag-remediated.wv', 'template.wv'));
  assert.ok(hasOp(plan, 'template.wv', 'template.final.wv'));
});

test('planPromotion: FIRST promotion snapshots a pre-apply render (and muxed)', () => {
  const plan = planPromotion({ draftExists: false, choiceApplied: false, renderExists: true, muxedExists: true });
  assert.ok(hasOp(plan, 'out.silent.mp4', 'out.draft.silent.mp4'), 'pre-apply silent render must be snapshotted');
  assert.ok(hasOp(plan, 'out.mp4', 'out.draft.mp4'), 'pre-apply muxed render must be snapshotted');
  // No muxed present -> only the silent snapshot.
  const silentOnly = planPromotion({ draftExists: false, choiceApplied: false, renderExists: true, muxedExists: false });
  assert.ok(hasOp(silentOnly, 'out.silent.mp4', 'out.draft.silent.mp4'));
  assert.equal(hasOp(silentOnly, 'out.mp4', 'out.draft.mp4'), false);
  // A REPEAT promotion does NOT re-snapshot (the draft render already exists).
  const repeat = planPromotion({ draftExists: true, choiceApplied: false, renderExists: true, muxedExists: true });
  assert.equal(hasOp(repeat, 'out.silent.mp4', 'out.draft.silent.mp4'), false);
});

test('planPromotion: an applied choice is archived so it cannot re-promote', () => {
  const withChoice = planPromotion({ draftExists: false, choiceApplied: true, renderExists: false, muxedExists: false });
  assert.ok(hasOp(withChoice, 'wcag-choice.json', 'wcag-choice.applied.json'), 'consumed choice must be archived');
  // Negative discriminator: an AUTO promotion (no choice) archives nothing.
  const auto = planPromotion({ draftExists: false, choiceApplied: false, renderExists: false, muxedExists: false });
  assert.equal(hasOp(auto, 'wcag-choice.json', 'wcag-choice.applied.json'), false);
});

// The merged engine call exits 1 on FINDINGS, which is a valid outcome — so a
// crash that also exits 1 is indistinguishable by status alone. If the statistics
// file from a previous run is still on disk, scoring it would report measured
// evidence for an audit that never happened.
test('readFreshStatistics: refuses a file the run did not write', () => {
  const missing = join(tmpdir(), `wcag-fresh-${process.pid}-${Date.now()}.json`);
  assert.throws(
    () => readFreshStatistics(missing, () => {}),
    /wrote no statistics/,
  );
});

test('readFreshStatistics: clears a stale file BEFORE the run, so it cannot be scored', () => {
  const path = join(tmpdir(), `wcag-stale-${process.pid}-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify({ version: 1, fps: 30, budget_overflow_frames: 0, elements: [{ id: 'stale' }] }));
  // A run that writes nothing must not leave the previous file readable.
  assert.throws(() => readFreshStatistics(path, () => {}), /wrote no statistics/);
  // A run that does write is read back normally.
  const fresh = { version: 1, fps: 30, budget_overflow_frames: 0, elements: [] };
  const got = readFreshStatistics(path, () => writeFileSync(path, JSON.stringify(fresh)));
  assert.deepEqual(got.elements, []);
  rmSync(path, { force: true });
});

test('missing-tool: remediate names the in-repo applier path and its env var', () => {
  const msg = missingToolError('remediate', '/x');
  assert.ok(msg.includes('WCAG_REMEDIATE'));
  assert.ok(msg.includes('WCAG_REMEDIATE'));
});

test('autoShadowChoice: takes the shadow rung for every class that has one, and never a recolour or a plate', async () => {
  const { autoShadowChoice } = await import('../src/commands/wcag-pass.ts');
  const base = { ids: ['a'], failing: 1, total: 1, colourRuledOut: false, unsampleable: 0 };
  const soft = { kind: 'shadow' as const, hex: '#000000', recipe: { style: 'soft' as const, layers: 3, blur: 8 }, massPct: 0, worstRatio: 5 };
  const colour = { kind: 'colour' as const, hex: '#ffffff', massPct: 0, worstRatio: 7 };
  const plate = { kind: 'background' as const, hex: '#ffffff', backingHex: '#000000', massPct: 0, worstRatio: 21 };
  const { choice, left } = autoShadowChoice([
    { ...base, selector: '.cap', label: 'Cap', rungs: [colour, soft, plate] }, // colour is RECOMMENDED first and still not taken
    { ...base, selector: '.kicker', label: 'Kicker', rungs: [plate] },
  ]);
  assert.deepEqual(choice, { schema: 1, chosen: [{ level: 'AA', selector: '.cap', kind: 'shadow', hex: '#000000', recipe: soft.recipe }] });
  assert.deepEqual(left, ['Kicker'], 'a class with no shadow rung is left alone and named');
  assert.equal(autoShadowChoice([{ ...base, selector: '.k', label: 'K', rungs: [colour] }]).choice, null);
});

