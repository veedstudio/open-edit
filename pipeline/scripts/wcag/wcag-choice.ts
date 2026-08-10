// wcag-choice.json — the PINNED contract for user-chosen remediations, shared by
// the studio page (emits entries), the preview server (validates + persists), and
// the applier (reads + applies). One record per run at runs/<key>/final/.
//
// USER DECISION: a clicked choice ALWAYS takes effect — the click is the human
// approval, so a chosen option is applied even when it is not a colours-only
// recolor (halo / background). Colours-only stays the applier's DEFAULT (the
// report path with no --choice); the click is what unlocks halo/background.
//
//   { "schema": 1, "chosen": [ { level, group, kind, hex, backingHex?, selector? } ] }
//
// Dedup key is `group` (corpus | outliers): last click on a group replaces its
// entry, so there are at most two chosen entries.

export type ChoiceLevel = "AA" | "AAA";
export type ChoiceGroup = "corpus" | "outliers";
export type ChoiceKind = "colour" | "shadow" | "outline" | "background";

export interface ChoiceEntry {
  level: ChoiceLevel;
  group: ChoiceGroup;
  kind: ChoiceKind;
  /** Text colour (colour recolor / halo colour / background text anchor). #rrggbb. */
  hex: string;
  /** Solid plate colour — REQUIRED for kind "background". #rrggbb. */
  backingHex?: string;
  /** CSS selector(s) the choice applies to (corpus class key, or the outlier id
   * list as a comma-joined selector). Carried so the applier needs no re-derivation. */
  selector?: string;
  /** Per-selector split for a HETEROGENEOUS group (outlier halo/background, where
   * each element's fg solves to its OWN halo/anchor colour). When present the
   * applier emits one rule per split part instead of a single rule for `selector`.
   * `hex` = the applied text colour (halo colour, or the background text anchor);
   * `backingHex` = the plate colour (background only). */
  split?: { selector: string; hex: string; backingHex?: string }[];
  /** The solved SHADOW recipe (kind "shadow" only): the applier emits `layers`
   * stacked `0 0 {blur}px` shadows of `hex` at the shadow alpha. */
  recipe?: { layers: number; blur: number };
}

export interface ChoiceFile {
  schema: 1;
  chosen: ChoiceEntry[];
}

// SSOT fallback recipe for a shadow choice that carries no `recipe` (an older or
// hand-written entry). Consumers (applier, credited resolver, studio specimens)
// import this — never hard-code the pair — so the emitted CSS, the credited
// rating, and the preview can never drift apart.
export const DEFAULT_SHADOW_RECIPE: { layers: number; blur: number } = { layers: 3, blur: 8 };

const HEX = /^#[0-9a-fA-F]{6}$/;
const LEVELS: readonly string[] = ["AA", "AAA"];
const GROUPS: readonly string[] = ["corpus", "outliers"];
const KINDS: readonly string[] = ["colour", "shadow", "outline", "background"];

// Validate ONE entry against the contract. Returns an error string (loud, names
// the offending field) or null when valid. Rejects unknown level/group/kind and
// malformed hex; a background choice must carry a valid backingHex.
export function validateChoiceEntry(x: unknown): string | null {
  if (typeof x !== "object" || x === null) return "entry must be an object";
  const e = x as Record<string, unknown>;
  if (!LEVELS.includes(e.level as string)) return `invalid level ${JSON.stringify(e.level)} (AA|AAA)`;
  if (!GROUPS.includes(e.group as string)) return `invalid group ${JSON.stringify(e.group)} (corpus|outliers)`;
  if (!KINDS.includes(e.kind as string)) return `invalid kind ${JSON.stringify(e.kind)} (colour|shadow|outline|background)`;
  if (typeof e.hex !== "string" || !HEX.test(e.hex)) return `invalid hex ${JSON.stringify(e.hex)} (#rrggbb)`;
  if (e.kind === "background") {
    if (typeof e.backingHex !== "string" || !HEX.test(e.backingHex)) {
      return `background choice requires backingHex (#rrggbb), got ${JSON.stringify(e.backingHex)}`;
    }
  } else if (e.backingHex !== undefined && (typeof e.backingHex !== "string" || !HEX.test(e.backingHex))) {
    return `invalid backingHex ${JSON.stringify(e.backingHex)} (#rrggbb)`;
  }
  if (e.selector !== undefined && typeof e.selector !== "string") return "selector must be a string";
  if (e.split !== undefined) {
    if (!Array.isArray(e.split) || e.split.length === 0) return "split must be a non-empty array";
    for (let i = 0; i < e.split.length; i++) {
      const p = e.split[i] as Record<string, unknown>;
      if (typeof p !== "object" || p === null) return `split[${i}] must be an object`;
      if (typeof p.selector !== "string" || p.selector.length === 0) return `split[${i}] needs a selector`;
      if (typeof p.hex !== "string" || !HEX.test(p.hex)) return `split[${i}] invalid hex ${JSON.stringify(p.hex)}`;
      if (e.kind === "background") {
        if (typeof p.backingHex !== "string" || !HEX.test(p.backingHex)) return `split[${i}] background needs backingHex`;
      } else if (p.backingHex !== undefined && (typeof p.backingHex !== "string" || !HEX.test(p.backingHex))) {
        return `split[${i}] invalid backingHex`;
      }
    }
  }
  if (e.recipe !== undefined) {
    const rc = e.recipe as Record<string, unknown>;
    if (typeof rc !== "object" || rc === null) return "recipe must be an object";
    if (!Number.isInteger(rc.layers) || (rc.layers as number) < 1) return `recipe.layers must be a positive integer, got ${JSON.stringify(rc.layers)}`;
    if (typeof rc.blur !== "number" || !(rc.blur as number > 0)) return `recipe.blur must be a positive number, got ${JSON.stringify(rc.blur)}`;
  }
  return null;
}

export const emptyChoiceFile = (): ChoiceFile => ({ schema: 1, chosen: [] });

// Read-modify-write ONE entry, last-write-wins per group (drops any prior entry
// for the same group, then appends). Pure — the server does the IO around it.
export function upsertChoice(file: ChoiceFile, entry: ChoiceEntry): ChoiceFile {
  return { schema: 1, chosen: [...file.chosen.filter((c) => c.group !== entry.group), entry] };
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
