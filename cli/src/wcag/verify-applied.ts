// STRUCTURAL post-apply check — the proof that what the pass SCORED is what
// actually landed in the template it promotes.
//
// The outcome of a remediation is computed ANALYTICALLY, from the treatments
// (treat.ts), against the samples taken once in detect. That is deliberate — a
// decoration is painted over the footage rather than repainting it, so
// re-sampling would answer a different question. But it leaves a gap: `after`
// describes the TREATMENTS and says nothing about the applier's output. A
// stylesheet that targeted the wrong elements, emitted the wrong declaration, or
// never got injected would still show the same improvement, and promote.
//
// So the promotion gate is structural, not statistical: the block exists, every
// rule targets text the audit actually measured, and the emitted rules are
// exactly the treatments that were scored — no fewer, no more, none altered.
//
// Pure. The expected declarations are built with the applier's OWN formatters,
// so a change to the emitted CSS cannot drift away from what is checked.

import { DEFAULT_SHADOW_RECIPE } from "./wcag-choice.ts";
import { REMEDIATION_BLOCK_ID, shadowStack } from "./remediate.ts";
import type { Treatment } from "./treat.ts";

/** One rule of the emitted stylesheet, whitespace-normalised. */
export interface AppliedRule {
  selector: string;
  decls: string;
}

/** The rules of a remediation stylesheet. Comments carry the evidence trail and
 * the not-applied notes; neither is a rule. Pure. */
export function parseCssRules(css: string): AppliedRule[] {
  const out: AppliedRule[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, " ");
    if (selector) out.push({ selector, decls: m[2].trim().replace(/\s+/g, " ") });
  }
  return out;
}

/** The declarations a treatment MUST have produced — built with the applier's
 * own formatters rather than a second copy of them. Pure. */
export function declarationsFor(t: Treatment): string {
  if (t.kind === "colour") return `color: ${t.hex};`;
  if (t.kind === "shadow") return `text-shadow: ${shadowStack(t.hex, t.recipe ?? DEFAULT_SHADOW_RECIPE)};`;
  return `color: ${t.hex}; background-color: ${t.backingHex};`;
}

/** Check the applier's output against the treatments that were scored. Returns
 * an error string naming what disagrees, or null when they match exactly. Pure. */
export function checkApplied(opts: {
  css: string;
  template: string;
  treatments: readonly Treatment[];
  auditedIds: ReadonlySet<string>;
}): string | null {
  if (!opts.template.includes(`<style id="${REMEDIATION_BLOCK_ID}">`)) {
    return "the remediation stylesheet was not injected into the template";
  }
  const rules = parseCssRules(opts.css);

  // Every number in the report rests on the audit; styling text it never
  // measured is a claim with no evidence under it. Ids are also the only shape
  // allowed here — a bare class key as CSS reaches beyond the roll-up class that
  // was grouped, measured and offered.
  for (const r of rules) {
    for (const tok of r.selector.split(",").map((s) => s.trim())) {
      if (!tok.startsWith("#")) {
        return `emitted rule targets ${tok}, which is not an element id — only resolved ids may be styled`;
      }
      if (!opts.auditedIds.has(tok.slice(1))) {
        return `emitted rule targets ${tok}, which the contrast audit never measured`;
      }
    }
  }

  const remaining = [...rules];
  for (const t of opts.treatments) {
    if (!t.ids?.length) {
      return `the ${t.kind} treatment ${t.hex} has no resolved ids — nothing to check its rule against`;
    }
    const want = t.ids.map((id) => `#${id}`).join(", ");
    const decls = declarationsFor(t);
    const i = remaining.findIndex((r) => r.selector === want && r.decls === decls);
    if (i < 0) {
      const near = remaining.find((r) => r.selector === want);
      return near
        ? `the emitted rule for ${want} is "${near.decls}", not the ${t.kind} treatment that was scored ("${decls}")`
        : `no emitted rule applies the ${t.kind} treatment scored for ${want}`;
    }
    remaining.splice(i, 1);
  }
  if (remaining.length > 0) {
    const r = remaining[0];
    return `the applier emitted a rule nothing scored: ${r.selector} { ${r.decls} }`;
  }
  return null;
}
