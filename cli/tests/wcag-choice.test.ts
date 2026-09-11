// Tests for the wcag-choice.json contract (validator / upsert / parser). Plain
// node: timeout 60 node --test tests/wcag-choice.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  emptyChoiceFile,
  parseChoiceFile,
  upsertChoice,
  validateChoiceEntry,
  type ChoiceEntry,
} from "../src/wcag/wcag-choice.ts";

const colour: ChoiceEntry = { level: "AA", kind: "colour", hex: "#956a05", selector: ".w" };
const shadow: ChoiceEntry = { level: "AA", kind: "shadow", hex: "#000000", selector: ".w" };
const background: ChoiceEntry = { level: "AA", kind: "background", hex: "#ffffff", backingHex: "#000000", selector: "#kicker" };

test("validateChoiceEntry accepts each well-formed kind", () => {
  assert.equal(validateChoiceEntry(colour), null);
  assert.equal(validateChoiceEntry(shadow), null);
  assert.equal(validateChoiceEntry(background), null);
});

// Nothing solves AAA any more — buildRungs works at the AA thresholds only — so
// an entry labelled AAA would carry an AA-grade value and be reported as applied.
test("validateChoiceEntry rejects AAA: the gate solves AA only", () => {
  assert.match(validateChoiceEntry({ ...colour, level: "AAA" })!, /invalid level/);
});

test("validateChoiceEntry rejects unknown enums and malformed hex loudly", () => {
  assert.match(validateChoiceEntry({ ...colour, kind: "glow" })!, /invalid kind/);
  assert.match(validateChoiceEntry({ ...colour, level: "AAAA" })!, /invalid level/);
  assert.match(validateChoiceEntry({ ...colour, hex: "956a05" })!, /invalid hex/); // no '#'
  assert.match(validateChoiceEntry({ ...colour, hex: "#95g" })!, /invalid hex/);
  assert.match(validateChoiceEntry("not an object")!, /must be an object/);
});

// The outline rung was removed with the studio: a shadow or a box is what a
// class that no colour can fix is offered, so "outline" must not survive as a
// silently-accepted kind.
test("validateChoiceEntry rejects the retired outline kind", () => {
  assert.match(validateChoiceEntry({ ...colour, kind: "outline" })!, /invalid kind/);
});

test("validateChoiceEntry requires a class-key selector on every entry", () => {
  assert.match(validateChoiceEntry({ ...colour, selector: undefined })!, /invalid selector/);
  assert.match(validateChoiceEntry({ ...colour, selector: "w" })!, /invalid selector/); // no . or #
  assert.match(validateChoiceEntry({ ...colour, selector: ".a, .b" })!, /invalid selector/); // one class per entry
  assert.equal(validateChoiceEntry({ ...colour, selector: "#kicker" }), null);
});

test("validateChoiceEntry requires a valid backingHex for kind background", () => {
  assert.match(validateChoiceEntry({ ...background, backingHex: undefined })!, /requires backingHex/);
  assert.match(validateChoiceEntry({ ...background, backingHex: "#000" })!, /requires backingHex/);
  // a stray backingHex on a non-background entry must still be well-formed.
  assert.match(validateChoiceEntry({ ...colour, backingHex: "nope" })!, /invalid backingHex/);
});

test("upsertChoice is last-write-wins per class (at most one entry per selector)", () => {
  let f = emptyChoiceFile();
  f = upsertChoice(f, colour); // .w colour
  f = upsertChoice(f, background); // #kicker background
  assert.equal(f.chosen.length, 2);
  // A second pick for .w replaces the first, not the #kicker one.
  f = upsertChoice(f, shadow); // .w shadow (AAA)
  assert.equal(f.chosen.length, 2);
  const w = f.chosen.filter((c) => c.selector === ".w");
  assert.equal(w.length, 1);
  assert.deepEqual(w[0], shadow);
  assert.equal(f.chosen.filter((c) => c.selector === "#kicker").length, 1);
});

test("validateChoiceEntry validates an optional shadow recipe (positive int layers, positive blur)", () => {
  const base: ChoiceEntry = { level: "AA", kind: "shadow", hex: "#000000", selector: ".w" };
  assert.equal(validateChoiceEntry({ ...base, recipe: { layers: 2, blur: 8 } }), null);
  assert.match(validateChoiceEntry({ ...base, recipe: { layers: 0, blur: 8 } })!, /recipe\.layers/);
  assert.match(validateChoiceEntry({ ...base, recipe: { layers: 1.5, blur: 8 } })!, /recipe\.layers/);
  assert.match(validateChoiceEntry({ ...base, recipe: { layers: 2, blur: 0 } })!, /recipe\.blur/);
});

// A hard ring only counts where it REACHES the 1px ring the standard asks about:
// reach = offset * cos(pi/directions). Short of that it paints nothing adjacent
// to the glyph, so the analytic evaluation scores the treatment as no change at
// all — and a chosen option promotes unconditionally, so the pass would ship the
// ORIGINAL template and report it as remediated.
test("validateChoiceEntry rejects a hard ring that never reaches the adjacent ring", () => {
  const base: ChoiceEntry = { level: "AA", kind: "shadow", hex: "#000000", selector: ".w" };
  assert.equal(validateChoiceEntry({ ...base, recipe: { style: "hard", directions: 8, offset: 1.5 } }), null);
  // 8-way at 1px reaches only 0.924px.
  assert.match(validateChoiceEntry({ ...base, recipe: { style: "hard", directions: 8, offset: 1 } })!, /never reaches/);
  // 4-way at 1.2px reaches only 0.849px.
  assert.match(validateChoiceEntry({ ...base, recipe: { style: "hard", directions: 4, offset: 1.2 } })!, /never reaches/);
});

test("parseChoiceFile enforces the schema and validates every entry", () => {
  assert.deepEqual(parseChoiceFile({ schema: 1, chosen: [colour, background] }).chosen.length, 2);
  assert.throws(() => parseChoiceFile({ schema: 2, chosen: [] }), /unsupported schema/);
  assert.throws(() => parseChoiceFile({ schema: 1, chosen: "x" }), /must be an array/);
  assert.throws(() => parseChoiceFile({ schema: 1, chosen: [{ ...colour, kind: "bogus" }] }), /chosen\[0\] invalid kind/);
  assert.throws(() => parseChoiceFile(null), /not a JSON object/);
});
