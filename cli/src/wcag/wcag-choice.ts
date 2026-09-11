// wcag-choice.json — the PINNED contract for user-chosen remediations, shared by
// the agent (writes it from what the user said) and the applier (reads + applies).
// One record per run at runs/<key>/final/.
//
// USER DECISION: a chosen option ALWAYS takes effect — the user's word is the
// human approval, so a chosen option is applied even when it is not a
// colours-only recolor (shadow / background). Colours-only stays the applier's
// DEFAULT (the report path with no --choice); the choice is what unlocks the rest.
//
//   { "schema": 1, "chosen": [ { level, selector, kind, hex, backingHex?, recipe? } ] }
//
// `selector` is the CLASS KEY (`.name`, or `#id` for class-less text) and is both
// the dedup key and the selector the applier emits: one remediation per class is
// the rule, so a later entry for the same class replaces the earlier one.

// The ring geometry comes from the solver that emitted these recipes — a second
// copy of `offset * cos(pi/directions)` here is exactly the drift that would let
// a rejected recipe be accepted, or the reverse.
import { hardRingReaches } from "./recommend.ts";

/** AA only. The gate solves every rung at the AA thresholds, so an "AAA" label
 * would ride on an AA-grade value and be reported as applied — the schema
 * refuses to carry a claim nothing computes. */
export type ChoiceLevel = "AA";
export type ChoiceKind = "colour" | "shadow" | "background";

/** `layers` blurred copies at `blur` px, emitted at the modelled shadow alpha. */
export interface SoftChoiceRecipe { style?: "soft"; layers: number; blur: number }
/** `directions` zero-blur copies at `offset` px, emitted OPAQUE — the ring has to
 * replace the background, not tint it, or it does not reach AA. */
export interface HardChoiceRecipe { style: "hard"; directions: number; offset: number }
export type ShadowChoiceRecipe = SoftChoiceRecipe | HardChoiceRecipe;

export interface ChoiceEntry {
  level: ChoiceLevel;
  /** Class key AND CSS selector — `.name`, or `#id` for class-less text. */
  selector: string;
  kind: ChoiceKind;
  /** Text colour (colour recolor / shadow colour / background text anchor). #rrggbb. */
  hex: string;
  /** Solid plate colour — REQUIRED for kind "background". #rrggbb. */
  backingHex?: string;
  /** The solved SHADOW recipe (kind "shadow" only). Two shapes, because they are
   * different treatments: a SOFT stack of blurred copies tints what is behind the
   * text, while a HARD ring of zero-blur copies replaces it. */
  recipe?: ShadowChoiceRecipe;
  /** The element ids `selector` resolved to. Filled by wcag-pass, NEVER by hand:
   * a class key is not a CSS selector, so the applier targets these ids instead
   * of the key to avoid reaching elements in a different roll-up class. */
  ids?: string[];
}

export interface ChoiceFile {
  schema: 1;
  chosen: ChoiceEntry[];
}

// SSOT fallback recipe for a shadow choice that carries no `recipe` (a
// hand-written entry). Consumers (applier, credited resolver) import this —
// never hard-code the pair — so the emitted CSS and the credited rating can
// never drift apart.
export const DEFAULT_SHADOW_RECIPE: ShadowChoiceRecipe = { style: "soft", layers: 3, blur: 8 };

const HEX = /^#[0-9a-fA-F]{6}$/;
// The class-key shapes wcag-pass rolls up by: `.class` or `#id`.
const SELECTOR = /^[.#][^\s,]+$/;
const LEVELS: readonly string[] = ["AA"];
const KINDS: readonly string[] = ["colour", "shadow", "background"];

// Validate ONE entry against the contract. Returns an error string (loud, names
// the offending field) or null when valid. Rejects unknown level/kind, a
// malformed selector or hex; a background choice must carry a valid backingHex.
export function validateChoiceEntry(x: unknown): string | null {
  if (typeof x !== "object" || x === null) return "entry must be an object";
  const e = x as Record<string, unknown>;
  if (!LEVELS.includes(e.level as string)) return `invalid level ${JSON.stringify(e.level)} (AA)`;
  if (typeof e.selector !== "string" || !SELECTOR.test(e.selector)) {
    return `invalid selector ${JSON.stringify(e.selector)} (a class key: .name or #id)`;
  }
  if (!KINDS.includes(e.kind as string)) return `invalid kind ${JSON.stringify(e.kind)} (colour|shadow|background)`;
  if (typeof e.hex !== "string" || !HEX.test(e.hex)) return `invalid hex ${JSON.stringify(e.hex)} (#rrggbb)`;
  if (e.kind === "background") {
    if (typeof e.backingHex !== "string" || !HEX.test(e.backingHex)) {
      return `background choice requires backingHex (#rrggbb), got ${JSON.stringify(e.backingHex)}`;
    }
  } else if (e.backingHex !== undefined && (typeof e.backingHex !== "string" || !HEX.test(e.backingHex))) {
    return `invalid backingHex ${JSON.stringify(e.backingHex)} (#rrggbb)`;
  }
  if (e.ids !== undefined) {
    if (!Array.isArray(e.ids) || e.ids.length === 0) return "ids must be a non-empty array when present";
    for (let i = 0; i < e.ids.length; i++) {
      if (typeof e.ids[i] !== "string" || (e.ids[i] as string).length === 0) return `ids[${i}] must be a non-empty string`;
    }
  }
  if (e.recipe !== undefined) {
    const rc = e.recipe as Record<string, unknown>;
    if (typeof rc !== "object" || rc === null) return "recipe must be an object";
    if (rc.style === "hard") {
      if (!Number.isInteger(rc.directions) || (rc.directions as number) < 1) return `recipe.directions must be a positive integer, got ${JSON.stringify(rc.directions)}`;
      if (typeof rc.offset !== "number" || !(rc.offset as number > 0)) return `recipe.offset must be a positive number, got ${JSON.stringify(rc.offset)}`;
      // A ring whose copies stop short of the 1px surface WCAG asks about paints
      // nothing adjacent to the glyph. Every analytic score then reads the
      // treatment as no change — and a chosen option promotes unconditionally,
      // so the pass would ship the ORIGINAL template reported as remediated.
      if (!hardRingReaches(rc.directions as number, rc.offset as number)) {
        return `recipe never reaches the adjacent ring: ${rc.directions}-way at ${rc.offset}px covers only ` +
          `${((rc.offset as number) * Math.cos(Math.PI / (rc.directions as number))).toFixed(3)}px of the 1px surface`;
      }
    } else {
      if (!Number.isInteger(rc.layers) || (rc.layers as number) < 1) return `recipe.layers must be a positive integer, got ${JSON.stringify(rc.layers)}`;
      if (typeof rc.blur !== "number" || !(rc.blur as number > 0)) return `recipe.blur must be a positive number, got ${JSON.stringify(rc.blur)}`;
    }
  }
  return null;
}

export const emptyChoiceFile = (): ChoiceFile => ({ schema: 1, chosen: [] });

// Read-modify-write ONE entry, last-write-wins per class (drops any prior entry
// for the same selector, then appends). Pure — the caller does the IO around it.
export function upsertChoice(file: ChoiceFile, entry: ChoiceEntry): ChoiceFile {
  return { schema: 1, chosen: [...file.chosen.filter((c) => c.selector !== entry.selector), entry] };
}

// Parse + fully validate a whole choice file (the applier's entry point). Throws
// loudly on any schema/shape violation.
export function parseChoiceFile(raw: unknown): ChoiceFile {
  if (typeof raw !== "object" || raw === null) throw new Error("wcag-choice: not a JSON object");
  const f = raw as Record<string, unknown>;
  if (f.schema !== 1) throw new Error(`wcag-choice: unsupported schema ${JSON.stringify(f.schema)} (expected 1)`);
  if (!Array.isArray(f.chosen)) throw new Error("wcag-choice: 'chosen' must be an array");
  f.chosen.forEach((e, i) => {
    const err = validateChoiceEntry(e);
    if (err) throw new Error(`wcag-choice: chosen[${i}] ${err}`);
  });
  return { schema: 1, chosen: f.chosen as ChoiceEntry[] };
}
