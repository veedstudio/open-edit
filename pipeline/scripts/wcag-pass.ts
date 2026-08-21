// WCAG text-contrast pass — DEFAULT gate on creative runs (face-1 AND remix),
// opt-in on the recipe fast path (generate-recipe.ts --wcag). Level AA.
//
// STATISTICS-NATIVE, two modes:
//  DETECT (default): sample real backgrounds and analyze them in ONE engine call
//    (veed-engine-cli --contrast-audit --statistics → the policy-free
//    final/contrast-statistics.json) → score verdicts and policy IN TS
//    (verdicts.ts + policy.ts) → summarize and RETURN. Renders nothing,
//    changes nothing, promotes nothing. Clean → status 'pass'; low-contrast
//    elements → status 'attention' with the counts and ONE offer line per
//    failing class.
//  APPLY (--apply): DETECT, then remediate, evaluate the result ANALYTICALLY
//    against those same samples (treat.ts), and promote. With a choice at
//    final/wcag-choice.json (written by the agent from what the user said) the
//    applier is driven by that explicit choice (--choice) and ALWAYS runs — a
//    chosen option always takes effect and promotes unconditionally. With NO
//    choice it falls back to the automatic hue-preserving colour plan
//    (within-bar recolors only), promoted only on improvement.
//
// SAMPLING IS A CONSTANT. It happens ONCE, in DETECT. The samples are a fixed
// stochastic model of the colour behind the text, and a decoration is painted
// OVER the footage rather than repainting it — so its effect is COMPUTED, never
// re-sampled. Nothing in this file audits a remediated render.
//
// READABILITY IS TEMPORAL. Every score — verdict, solver, applied outcome —
// judges one-second SLIDING windows (windows.ts), so a run is condemned for a
// bad second rather than a bad instant, and no rung can be offered that the
// verdict then rejects.
// The analyzer's compliance report is NEVER read — statistics + the TS policy
// layer are the whole runtime contract.
//
// FINAL IS FINAL. On promotion (--apply only), inside final/:
//   template.draft.wv                  — the pre-remediation original
//   template.draft.wcag-remediated.wv  — the remediation output (artifact)
//   template.wv                        — = the remediated content (the
//                                           engine's required entry name)
//   template.final.wv                  — clone of the shipping template
//   wcag-remediation.css               — per-rule evidence comments
//   wcag-remediation-plan.json + contrast-statistics.json (sampled ONCE, in detect)
// No directory copies, no video artifacts — the pass renders nothing. The
// remediated template is --verify'd BEFORE the first file moves, so a failure
// leaves final/ exactly as it was.
//
// TRANSPARENCY IS THE CONTRACT: every non-passing CLASS is listed with what it
// is offered (colour / shadow / box), or with why nothing reaches AA — nothing
// failing goes unlisted, and missing tooling is a HARD failure (exit 1), never
// a skip. Every text of a class takes the SAME remediation, solved at the
// class's common denominator, so a class is the unit the user chooses at.
//
//   node --import tsx pipeline/scripts/wcag-pass.ts --run runs/<key> [--apply]
//
// Requires the release engine only (the analyzer and its --statistics output ship
// in-engine since 0.8.0; the repo floor is 0.9.0); there is no second binary and
// no source checkout.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VEED_ENGINE_BIN, WCAG_REMEDIATE } from '../../config.ts';
import {
  betterAnchor,
  DEFAULT_BAR,
  DEFAULT_MIN_LEAD_RATIO,
  effectiveThreshold,
  optionWithinBar,
  relativeLuminance,
  rollUpPolicy,
  type ClassPolicyResult,
  type RunPolicyInput,
  type Srgb8,
} from './wcag/policy.ts';
import {
  scoreWindow,
  slidingWindows,
  windowPasses,
  windowSize,
  type SampleWindow,
} from './wcag/windows.ts';
import { shadowFailure, solveClassShadow } from './wcag/recommend.ts';
import { applyTreatment, type Treatment } from './wcag/treat.ts';
import { checkApplied } from './wcag/verify-applied.ts';
import { hex, type RemediationPlan } from './wcag/remediate.ts';
import {
  parseChoiceFile,
  type ChoiceEntry,
  type ChoiceKind,
  type ShadowChoiceRecipe,
} from './wcag/wcag-choice.ts';
import { parseElementClasses, resolveVerdicts, type Statistics } from './wcag/verdicts.ts';

// The analyzer CLI's default knobs. They live in policy.ts with the
// acceptability predicate they feed; re-exported here for the gate's consumers.
export { DEFAULT_BAR, DEFAULT_MIN_LEAD_RATIO };

// --- pure helpers (unit-tested in tests/wcag-pass.test.ts) ------------------

/** The three remediations a class can be offered, in recommendation order.
 *
 * DELIBERATELY the choice schema's own union: the agent transcribes a pick from
 * the printed line into wcag-choice.json, so a rung named anything the schema
 * rejects would abort the apply step. The user-facing word for `background` is
 * "box" — that lives in SKILL.md's prose, never in a value. */
export type RungKind = ChoiceKind;

/** ONE offered remediation, carrying everything the applier needs plus the
 * evidence a report line quotes. */
export interface Rung {
  kind: RungKind;
  /** Text colour to apply (#rrggbb) — the shadow colour for `shadow`, the text
   * anchor for `box`. */
  hex: string;
  /** Plate colour — `box` only. */
  backingHex?: string;
  /** Solved shadow recipe — `shadow` only. Soft stack or hard ring. */
  recipe?: ShadowChoiceRecipe;
  /** Estimated failing mass % under this option. */
  massPct: number;
  /** Worst per-cluster ratio under this option. */
  worstRatio: number;
}

/** ONE class's offer. Every text of the class takes the SAME remediation, so a
 * class is the unit the user chooses at. */
export interface ClassProposal {
  /** Class key: `.name`, or `#id` for class-less text. NOT a CSS selector — see
   * expandSelector. */
  selector: string;
  /** The class's member element ids, in roll-up order. What CSS actually targets. */
  ids: string[];
  /** The selector as a person reads it (`.caption-emph` -> "Caption emph"). */
  label: string;
  /** Members not passing AA — INCLUDING unsampleable ones, so the per-class
   * counts sum to the headline count the same report prints. */
  failing: number;
  total: number;
  /** True when no single colour covers the whole class — the pass says so and
   * offers only shadow and background. */
  colourRuledOut: boolean;
  /** How many of `failing` could not be measured at all. */
  unsampleable: number;
  /** Offered remediations, RECOMMENDED FIRST. Empty only when nothing reaches AA. */
  rungs: Rung[];
}

export interface WcagRunSummary {
  passed: boolean;
  totalRuns: number;
  failingRuns: number;
  indeterminateRuns: number;
  /** True when ANY class has a colour rung — i.e. the automatic colours-only
   * applier would change at least one rule. */
  anyApplicable: boolean;
  /** EXHAUSTIVE per-class offers — every class that is not already passing gets
   * one; nothing is ever suppressed. */
  proposals: ClassProposal[];
}

/** A class key as a person reads it: drop the leading `.`/`#`, turn separators
 * into spaces, sentence-case. The interior `.` counts as a separator because a
 * composite class key is dot-joined (`.fade.w`). Mechanical on purpose — the
 * template is the only place a better name could come from, and it does not
 * declare one. Pure. */
export function humaniseSelector(selector: string): string {
  const bare = selector.replace(/^[.#]/, '').replace(/[-_.]+/g, ' ').trim();
  if (!bare) return selector;
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

// The roll-up key rule: classed -> `.name`, class-less -> `#id`.
const keyFor = (r: RunPolicyInput) => (r.className !== null ? `.${r.className}` : `#${r.id}`);

/** The element ids a class KEY names, under the roll-up's own grouping rule.
 *
 * A class key is NOT a CSS selector. The roll-up groups by the sorted composite
 * class set, so `.w` names elements whose classes are exactly {w} — while as CSS
 * `.w` would also match `class="fade w"`, which the roll-up put in the separate
 * class `.fade.w`. Emitting the key verbatim therefore reaches text no proposal
 * ever mentioned. Resolving to ids keeps what is targeted identical to what was
 * grouped, measured and offered. Pure. */
export function expandSelector(
  selector: string, ids: string[], classOf: (id: string) => string | null,
): string[] {
  if (selector.startsWith('#')) {
    const want = selector.slice(1);
    return ids.filter((id) => id === want);
  }
  const want = selector.slice(1); // `.fade.w` -> the composite key `fade.w`
  return ids.filter((id) => classOf(id) === want);
}

/** One chosen entry resolved to the elements it will actually style. */
export interface ChoiceTarget {
  /** The id-list CSS selector the applier emits. */
  selector: string;
  ids: string[];
}

/** Resolve every chosen selector against the AUDITED elements, refusing one that
 * names nothing and one that reaches an element another entry already claims.
 *
 * The ids come from the STATISTICS, never from the template. A template also
 * carries ids the audit never measured — decorative nodes, and text the sampler
 * skipped — and styling one of those is invisible to the whole gate: the outcome
 * is computed from the treatments, so the numbers would improve while the
 * promoted template held a rule nothing ever scored.
 *
 * The choice file is written by the agent from what the user said, so a mistyped
 * class key is reachable. Injecting CSS that selects nothing would evaluate
 * identically and still promote — shipping an unchanged video reported as
 * remediated — so an unmatched selector has to stop the run.
 *
 * Two entries reaching one element is not a merge either: the applier emits both
 * rules and CSS source-order takes the LAST, while the analytic evaluation takes
 * the FIRST match. The number reported and the pixels shipped would describe
 * different treatments. Pure. */
export function resolveChoiceTargets(
  chosen: readonly ChoiceEntry[], statistics: Statistics, classOf: (id: string) => string | null,
): ChoiceTarget[] {
  const ids = statistics.elements.map((e) => e.id);
  const known = [...new Set(ids.map((id) => {
    const c = classOf(id);
    return c !== null ? `.${c}` : `#${id}`;
  }))].sort();
  // Keyed by index as well as selector: two entries can carry the SAME key, and
  // naming it twice reads as a typo rather than as a duplicate.
  const claimedBy = new Map<string, string>();
  return chosen.map((c, entry) => {
    const matched = expandSelector(c.selector, ids, classOf);
    if (matched.length === 0) {
      throw new Error(
        `wcag-pass: chosen selector ${c.selector} matches no audited text — ` +
        `valid keys: ${known.join(', ')}`,
      );
    }
    for (const id of matched) {
      const prior = claimedBy.get(id);
      if (prior !== undefined) {
        throw new Error(
          `wcag-pass: #${id} is claimed by more than one chosen entry ` +
          `(${prior} and chosen[${entry}] ${c.selector}) — one remediation per element is the rule`,
        );
      }
      claimedBy.set(id, `chosen[${entry}] ${c.selector}`);
    }
    return { selector: matched.map((id) => `#${id}`).join(', '), ids: matched };
  });
}

/** Classes a previously-applied choice covered that this one does not.
 *
 * A choice file is NOT additive. Each apply replaces the injected block
 * wholesale, so a class the earlier choice fixed and this one omits silently
 * loses its remediation — and the pass reports the run as remediated either way.
 * A user asking to change one class would quietly undo the others. Pure. */
export function droppedSelectors(
  applied: readonly ChoiceEntry[], next: readonly ChoiceEntry[],
): string[] {
  const keep = new Set(next.map((c) => c.selector));
  return [...new Set(applied.map((c) => c.selector))].filter((s) => !keep.has(s)).sort();
}

// One statistics element -> the roll-up's policy input. `passes` is the TS
// verdict at AA (verdicts.ts); `requiredRatio` is the STRICTEST per-frame
// threshold (font metrics may vary across peak frames).
function policyInput(
  elt: Statistics['elements'][number], passes: boolean, className: string | null,
): RunPolicyInput {
  const sampled = elt.frames.filter((f) => !f.unsampled);
  const requiredRatio = sampled.length
    ? Math.max(...sampled.map((f) => effectiveThreshold('AA', f.font_size, f.font_weight, null)))
    : effectiveThreshold('AA', elt.font_size, elt.font_weight, null);
  const anyUnsampled = elt.frames.some((f) => f.unsampled) || (elt.unsampled_frames?.n ?? 0) > 0;
  const clusters = elt.clusters.map((c) => ({ color: c.color, weight: c.weight }));
  return {
    id: elt.id,
    className,
    fg: { r: elt.fg.r, g: elt.fg.g, b: elt.fg.b },
    fgAlpha: elt.steady_alpha,
    requiredRatio,
    bgLums: clusters.map((c) => relativeLuminance(c.color)),
    clusters,
    totalSamples: elt.total_samples,
    indeterminate: elt.indeterminate || anyUnsampled,
    passes,
  };
}

// A plate covers the whole box rather than a 1px ring, so coverage 1 — but it is
// painted by the same element, so the element's own opacity still dilutes it
// (shadowFailure applies that). This is why the box is rated with the shadow
// math: they are the same treatment at different reach, not two models.
const PLATE_COVERAGE = [1];

const WHITE: Srgb8 = { r: 255, g: 255, b: 255 };
const BLACK: Srgb8 = { r: 0, g: 0, b: 0 };

// The rungs offered for ONE failing class, recommended first.
//
// EVERY rung is held to the same bar: it must clear AA for EVERY determinate
// member, each scored against its own foreground, alpha and backgrounds. A class
// takes ONE remediation, so a rung solved from a single member would ship text
// that never reached AA. The colour rung already works this way — the roll-up's
// `exceptions` are exactly the members its colour still fails — and shadow and
// background now match it.
function buildRungs(
  determinate: RunPolicyInput[], c: ClassPolicyResult, windowsOf: (id: string) => SampleWindow[],
): { rungs: Rung[]; colourRuledOut: boolean } {
  const rungs: Rung[] = [];

  // THE scoring units: every one-second window of every determinate member. A
  // rung is offered only if it clears all of them — the same windows, and the
  // same acceptability predicate, the verdict uses.
  const units = determinate.flatMap((m) =>
    windowsOf(m.id).map((w) => ({
      w,
      requiredRatio: effectiveThreshold('AA', w.fontSize, w.fontWeight, null),
    })),
  );

  // EVERY candidate is tried, not just the lead. policy.ts returns the subtle
  // hue-preserving lead first and a strict mass-argmin alternative second; testing
  // only the lead discarded a candidate that might clear every window.
  //
  // Validated directly against the windows rather than trusting the roll-up's own
  // pooled verdict: the candidate GENERATOR may pool, the acceptance test may not.
  let colour: Rung | null = null;
  for (const option of units.length > 0 ? c.recolorOptions : []) {
    const scores = units.map((u) =>
      scoreWindow(u.w, option.fix.color, u.w.fgAlpha, u.requiredRatio, DEFAULT_MIN_LEAD_RATIO),
    );
    if (!scores.every((s) => windowPasses(s, DEFAULT_BAR))) continue;
    // Evidence comes from the window that BOUND the decision, never the roll-up's
    // pooled estimate — the pooled figure is computed at member-0's alpha over
    // pooled clusters, so it can describe a composite the approval never used, and
    // it would not be comparable with the shadow/background rungs' own numbers.
    colour = {
      kind: 'colour',
      hex: hex(option.fix.color),
      massPct: Math.max(...scores.map((s) => s.mass)) * 100,
      worstRatio: Math.min(...scores.map((s) => s.worstRatio)),
    };
    break;
  }
  const colourCovers = colour !== null;
  if (colour) rungs.push(colour);

  // A window nothing was measured behind cannot be claimed as fixed by a
  // decoration either: there is no background to compute the result against.
  // The colour rung already fails closed on it inside scoreWindow.
  const unmeasured = units.some((u) => u.w.unscorable || u.w.clusters.length === 0);

  // SHADOW: only black and white are ever solvable halo colours, so try both and
  // keep the first whose recipe covers every window.
  const members = unmeasured
    ? []
    : units.map((u) => ({
        fg: { ...u.w.fg, a: u.w.fgAlpha },
        clusters: u.w.clusters,
        requiredRatio: u.requiredRatio,
      }));
  for (const shadowColour of [BLACK, WHITE]) {
    const solved = solveClassShadow(members, shadowColour, DEFAULT_MIN_LEAD_RATIO, DEFAULT_BAR);
    if (solved) {
      const r = solved.recipe;
      rungs.push({
        kind: 'shadow',
        hex: hex(shadowColour),
        recipe:
          r.style === 'hard'
            ? { style: 'hard', directions: r.directions, offset: r.offset }
            : { style: 'soft', layers: r.layers, blur: r.blur },
        massPct: solved.mass * 100,
        worstRatio: solved.worstRatio,
      });
      break;
    }
  }

  // BACKGROUND: the plate takes over what sits behind the text — outright at full
  // opacity, and diluted by the element's own alpha below it, which is why this is
  // scored against the samples rather than declared independent of them. Prefer
  // the anchor the class's own colours suggest, then the other.
  const preferred = betterAnchor(determinate[0].fg);
  const pairs: Array<[Srgb8, Srgb8]> =
    preferred.r === 255 ? [[WHITE, BLACK], [BLACK, WHITE]] : [[BLACK, WHITE], [WHITE, BLACK]];
  for (const [anchor, backing] of pairs) {
    if (units.length === 0 || unmeasured) break;
    const scores = units.map((u) =>
      shadowFailure(
        { ...anchor, a: u.w.fgAlpha }, backing, PLATE_COVERAGE,
        u.w.clusters, u.requiredRatio, DEFAULT_MIN_LEAD_RATIO,
      ),
    );
    const covers = scores.every(
      (s, i) => s.worstRatio >= units[i].requiredRatio && optionWithinBar(s.mass, s.massBelowFloor, DEFAULT_BAR),
    );
    if (!covers) continue;
    rungs.push({
      kind: 'background',
      hex: hex(anchor),
      backingHex: hex(backing),
      massPct: Math.max(...scores.map((s) => s.mass)) * 100,
      worstRatio: Math.min(...scores.map((s) => s.worstRatio)),
    });
    break;
  }

  return { rungs, colourRuledOut: !colourCovers };
}

// TS verdicts + the class roll-up over the statistics, walked into per-class
// proposals. Pure.
function analyzeStatistics(stats: Statistics, classOf: (id: string) => string | null) {
  const verdicts = resolveVerdicts(stats);
  const passing = new Map(verdicts.elements.map((e) => [e.id, e.aa]));
  const inputs = stats.elements.map((elt) =>
    policyInput(elt, passing.get(elt.id) ?? false, classOf(elt.id)),
  );
  const members = new Map<string, RunPolicyInput[]>();
  for (const i of inputs) {
    const key = keyFor(i);
    if (!members.has(key)) members.set(key, []);
    members.get(key)!.push(i);
  }
  // Sorted by id to match rollupClass, so the rungs are solved from the same
  // member the roll-up's colour was — and do not shift with the engine's
  // emission order for an unchanged template.
  for (const list of members.values()) list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Windowed ONCE, from the constant samples, and shared by every score below.
  const k = windowSize(stats);
  const byId = new Map(stats.elements.map((e) => [e.id, slidingWindows(e, k)]));
  const windowsOf = (id: string) => byId.get(id) ?? [];

  const classes: ClassPolicyResult[] = rollUpPolicy(inputs, DEFAULT_BAR, DEFAULT_MIN_LEAD_RATIO);
  const proposals: ClassProposal[] = [];
  for (const c of classes) {
    if (c.recolorOptions.length === 0 && c.exceptions.length === 0) continue; // tier 0 — passing
    const all = members.get(c.classKey) ?? [];
    const determinate = all.filter((m) => !m.indeterminate);
    const measurablyFailing = determinate.filter((m) => !m.passes).length;
    const unsampleable = all.length - determinate.length;
    // An unsampleable member fails AA in the verdicts too, so it counts here —
    // otherwise the class lines cannot sum to the headline count.
    const failing = measurablyFailing + unsampleable;
    if (failing === 0) continue;
    // With nothing determinate to solve against, the class is unsampleable
    // rather than unfixable — no rungs, and colour is not "ruled out" by policy.
    const solved =
      measurablyFailing > 0
        ? buildRungs(determinate, c, windowsOf)
        : { rungs: [], colourRuledOut: false };
    proposals.push({
      selector: c.classKey,
      ids: all.map((m) => m.id),
      label: humaniseSelector(c.classKey),
      failing,
      total: all.length,
      colourRuledOut: solved.colourRuledOut,
      unsampleable,
      rungs: solved.rungs,
    });
  }
  return { verdicts, proposals };
}

// ONE class's offer as a report line. Pure.
export function proposalLine(p: ClassProposal): string {
  const where = `${p.selector} (${p.failing}/${p.total} failing)`;
  if (p.rungs.length === 0) {
    // Nothing to offer reads two different ways: unmeasurable, or measured and
    // unfixable. Saying the wrong one sends the user chasing the wrong problem.
    return p.failing === p.unsampleable
      ? `${where}: indeterminate — background unsampleable; no sound fix`
      : `${where}: no remediation reaches AA — human review`;
  }
  const rungs = p.rungs.map(rungLabel).join(' | ');
  const lead = p.colourRuledOut ? 'no colour satisfies AA for the whole class — ' : '';
  const tail = p.unsampleable > 0 ? ` (${p.unsampleable} unsampleable)` : '';
  return `${where}: ${lead}${rungs}${tail}`;
}

function rungLabel(r: Rung): string {
  if (r.kind === 'colour') return `colour ${r.hex}`;
  if (r.kind === 'shadow') {
    const recipe = r.recipe!;
    return recipe.style === 'hard'
      ? `shadow ${r.hex} ${recipe.directions}-way @ ${recipe.offset}px`
      : `shadow ${r.hex} x${recipe.layers} @ ${recipe.blur}px`;
  }
  return `background ${r.hex} on ${r.backingHex}`;
}

// Compress the statistics into what the gate reasons about. Pure.
export function summarizeStatistics(
  stats: Statistics, classOf: (id: string) => string | null,
): WcagRunSummary {
  const { verdicts, proposals } = analyzeStatistics(stats, classOf);
  return {
    passed: verdicts.failingAA === 0,
    totalRuns: stats.elements.length,
    failingRuns: verdicts.failingAA,
    indeterminateRuns: verdicts.indeterminateCount,
    anyApplicable: proposals.some((p) => p.rungs.some((r) => r.kind === 'colour')),
    proposals,
  };
}

// The automatic colours-only remediation plan the applier consumes: one rule per
// class whose colour rung covers it, every un-applied class carried as a note so
// the emitted CSS keeps the full review trail. Pure.
export function buildRemediationPlan(
  stats: Statistics, classOf: (id: string) => string | null,
): RemediationPlan {
  const { proposals } = analyzeStatistics(stats, classOf);
  const rules: RemediationPlan['rules'] = [];
  const notes: string[] = [];
  for (const p of proposals) {
    const colour = p.rungs.find((r) => r.kind === 'colour');
    if (colour) {
      rules.push({
        // The class's own members, never the class key: as CSS a key can reach
        // elements the roll-up put in a different class and never measured here.
        selector: p.ids.map((id) => `#${id}`).join(', '),
        hex: colour.hex,
        massPct: colour.massPct,
        worstRatio: colour.worstRatio,
      });
    } else {
      notes.push(proposalLine(p));
    }
  }
  return { level: 'AA', rules, notes };
}

// Both decision paths report a clean run identically; one literal so they cannot drift.
const ALL_PASS_NOTE = 'WCAG AA: all text runs pass';

export type WcagStatus = 'pass' | 'attention' | 'remediated' | 'not-improved' | 'residual';

export interface WcagDecision {
  status: WcagStatus;
  /** True iff the remediated template was PROMOTED into final/template.wv.
   * Always false in DETECT mode — detect never writes. */
  promoted: boolean;
  notes: string[];
}

// DETECT-mode decision (default): report only, never promote. Clean → 'pass';
// otherwise 'attention' whose FIRST note states the scale of the problem,
// followed by ONE offer line per failing class. `choicePending` (a
// wcag-choice.json the agent wrote from what the user said) adds a clause
// pointing at it — the caller passes the file-existence boolean; the pure layer
// does no I/O. Pure.
export function wcagDetectDecision(
  before: WcagRunSummary,
  choicePending = false,
): WcagDecision {
  if (before.passed) {
    // A passing run with NO pending choice is plainly clean. But a pending
    // choice (e.g. an AAA tweak on an AA-passing run) must NOT be silently
    // dropped — surface it as 'attention' with the pending clause only.
    if (!choicePending) {
      return { status: 'pass', promoted: false, notes: [ALL_PASS_NOTE] };
    }
    return {
      status: 'attention',
      promoted: false,
      notes: ['WCAG AA: all text runs pass at the current level; a choice is pending — apply it (wcag-pass --apply)'],
    };
  }
  const offer =
    `WCAG AA: ${before.failingRuns} of ${before.totalRuns} text elements are below AA — ` +
    `one recommendation per class below; apply with wcag-pass --apply` +
    (choicePending ? `; a choice is pending — apply it (wcag-pass --apply)` : ``);
  return {
    status: 'attention',
    promoted: false,
    notes: [offer, ...before.proposals.map((p) => `propose: ${proposalLine(p)}`)],
  };
}

// Whether the APPLY path runs the remediation applier. A pending choice ALWAYS
// runs it — a chosen option always takes effect, even on an AA-passing run
// carrying only an AAA tweak. With no choice, the AUTO path runs only when the
// run fails AND a colours-only fix is applicable. Pure.
export function shouldRunApplier(passed: boolean, anyApplicable: boolean, hasChoice: boolean): boolean {
  return hasChoice || (!passed && anyApplicable);
}

// Promotion rule: AUTO remediation promotes ONLY on measured improvement —
// strictly fewer failing runs after remediation. A USER-CHOSEN option
// (choiceApplied) promotes unconditionally, EVEN on an otherwise-passing run:
// the user's pick IS the decision; the numbers are reported as context, never a
// veto. `after` is computed from the SAME samples as `before`, with the
// treatment applied — so the two are directly comparable. Pure.
export function wcagPassDecision(
  before: WcagRunSummary, after: WcagRunSummary | null,
  opts: { choiceApplied?: boolean } = {},
): WcagDecision {
  // A user-chosen option, once applied (after !== null), always promotes —
  // checked BEFORE the passing short-circuit so a choice on a passing run is
  // never dropped.
  if (opts.choiceApplied && after) {
    return {
      status: 'remediated',
      promoted: true,
      notes: [
        `WCAG AA: your chosen option is applied — ${before.failingRuns} -> ${after.failingRuns} failing (computed against the original samples)`,
        ...after.proposals.map((p) => `review (with your fix applied): ${proposalLine(p)}`),
      ],
    };
  }
  if (before.passed) {
    return { status: 'pass', promoted: false, notes: [ALL_PASS_NOTE] };
  }
  const residue = before.proposals.map((p) => `review: ${proposalLine(p)}`);
  if (!after) {
    return {
      status: 'residual',
      promoted: false,
      notes: [`WCAG AA: ${before.failingRuns} of ${before.totalRuns} run(s) fail and no colour fix applies`, ...residue],
    };
  }
  if (after.failingRuns < before.failingRuns) {
    return {
      status: 'remediated',
      promoted: true,
      notes: [
        `WCAG AA: remediation promoted — ${before.failingRuns - after.failingRuns} of ${before.failingRuns} failing run(s) now pass`,
        // These proposals describe the PROMOTED template — an offer
        // still listed there means a further pass could improve it (single-pass
        // by design); the prefix keeps that context explicit.
        ...after.proposals.map((p) => `review (with your fix applied): ${proposalLine(p)}`),
      ],
    };
  }
  return {
    status: 'not-improved',
    promoted: false,
    notes: [
      `WCAG AA: remediation did NOT improve (${before.failingRuns} -> ${after.failingRuns} failing) — original kept; artifacts retained for inspection`,
      ...residue,
    ],
  };
}

// One promotion file-operation, relative to final/. `rename` moves (and thus
// consumes the source); `copy` duplicates.
export interface PromotionOp {
  kind: 'rename' | 'copy';
  from: string;
  to: string;
  reason: string;
}

// PURE plan of the promotion file-ops, given the pre-promotion state of final/.
// Ordered so execution is a straight for-loop. Three lifecycle rules:
//  - NEVER overwrite an existing template.draft.wv: the draft is the ORIGINAL,
//    captured at the FIRST promotion only; later promotions leave it untouched
//    and just re-point template.wv at the new remediation.
//  - a CHOICE that was applied is ARCHIVED (wcag-choice.json -> .applied.json)
//    so a stale pick cannot silently re-promote forever.
//  - at the FIRST promotion, an existing pre-apply render is SNAPSHOTTED
//    (out.silent.mp4 -> out.draft.silent.mp4, and the muxed out.mp4 if present)
//    so a before/after comparison stays possible.
export function planPromotion(state: {
  draftExists: boolean;
  choiceApplied: boolean;
  renderExists: boolean;
  muxedExists: boolean;
}): PromotionOp[] {
  const ops: PromotionOp[] = [];
  const firstPromotion = !state.draftExists;
  if (firstPromotion && state.renderExists) {
    ops.push({ kind: 'rename', from: 'out.silent.mp4', to: 'out.draft.silent.mp4', reason: 'snapshot pre-apply silent render' });
    if (state.muxedExists) {
      ops.push({ kind: 'rename', from: 'out.mp4', to: 'out.draft.mp4', reason: 'snapshot pre-apply muxed render' });
    }
  }
  if (firstPromotion) {
    ops.push({ kind: 'rename', from: 'template.wv', to: 'template.draft.wv', reason: 'preserve pre-remediation original' });
  }
  ops.push({ kind: 'copy', from: 'template.draft.wcag-remediated.wv', to: 'template.wv', reason: 'promote remediated template' });
  ops.push({ kind: 'copy', from: 'template.wv', to: 'template.final.wv', reason: 'mark shipping template final' });
  // Archive a consumed choice so it cannot re-promote on a later bare --apply.
  if (state.choiceApplied) {
    ops.push({ kind: 'rename', from: 'wcag-choice.json', to: 'wcag-choice.applied.json', reason: 'archive consumed choice' });
  }
  return ops;
}

// Entry-point check that survives percent-encodable paths (spaces etc.). Pure.
export function isMainModule(argvPath: string | undefined, moduleUrl: string): boolean {
  return !!argvPath && path.resolve(argvPath) === fileURLToPath(moduleUrl);
}

// remediate.ts runs under plain node native type-stripping (>=22.18 / >=23).
export function nodeVersionSupportsTsStripping(version: string): boolean {
  const [maj, min] = version.replace(/^v/, '').split('.').map(Number);
  return maj >= 23 || (maj === 22 && min >= 18);
}

export function missingToolError(tool: 'engine' | 'remediate', p: string): string {
  switch (tool) {
    case 'engine':
      return `wcag-pass: veed-engine-cli not found at ${p} — run pipeline/scripts/install-veed-engine.mjs or set VEED_ENGINE_BIN`;
    case 'remediate':
      return `wcag-pass: remediation applier not found at ${p} — it ships in-repo at pipeline/scripts/wcag/remediate.ts; set WCAG_REMEDIATE to point at it`;
  }
}

// --- the pass (spawns real tools; not covered by unit tests) ----------------

function sh(bin: string, args: string[], okCodes: number[], quietStdout = false): void {
  const r = spawnSync(bin, args, { stdio: ['ignore', quietStdout ? 'ignore' : 'inherit', 'inherit'] });
  if (r.error) {
    throw new Error(`wcag-pass: failed to spawn ${bin}: ${r.error.message}`);
  }
  if (r.status === null || !okCodes.includes(r.status)) {
    const how = r.status === null ? `killed by signal ${r.signal}` : `exited ${r.status}`;
    throw new Error(`wcag-pass: ${bin} ${args.join(' ')} ${how}`);
  }
}

/** Run `produce` and read the statistics it wrote, REFUSING a file it did not.
 *
 * The audit call exits 1 on FINDINGS — a valid outcome the TS layer scores — so
 * a crash that also exits 1 cannot be told apart by status alone. A statistics
 * file left over from an earlier run would then be scored as if it were this
 * run's evidence, and could promote a template that was never audited. Clearing
 * first makes "the file exists" mean "this run wrote it". */
export function readFreshStatistics(statsPath: string, produce: () => void): Statistics {
  rmSync(statsPath, { force: true });
  produce();
  if (!existsSync(statsPath)) {
    throw new Error(
      `wcag-pass: the contrast audit wrote no statistics at ${statsPath} — treating it as a failed audit, not as a clean run`,
    );
  }
  return JSON.parse(readFileSync(statsPath, 'utf8'));
}

// Sample + analyze one template dir in ONE engine call: --contrast-audit samples
// the real backgrounds and runs the analyzer in-process, --statistics writes the
// policy-free stats this gate scores from. Exit 1 means "findings" (failing
// contrast) — a valid outcome here, since the TS layer does the scoring; 2/3/4
// are real failures and fail loudly. The report is written because the flag
// requires a path, and never read.
function audit(templateDir: string, reportPath: string, statsPath: string): Statistics {
  return readFreshStatistics(statsPath, () =>
    sh(
      VEED_ENGINE_BIN,
      [templateDir, '--contrast-audit', reportPath, '--audit-fps', '5', '--statistics', statsPath],
      [0, 1],
    ),
  );
}

function classOfDir(templateDir: string): (id: string) => string | null {
  const classes = parseElementClasses(readFileSync(path.join(templateDir, 'template.wv'), 'utf8'));
  return (id) => classes.get(id) ?? null;
}

export function runWcagPass(runDir: string, opts: { apply?: boolean } = {}): WcagDecision {
  const finalDir = path.join(runDir, 'final');
  const sibling = `${finalDir}.wcag-remediated`; // applier impl detail; removed before return
  // The agent writes final/wcag-choice.json from what the user said; when it is
  // present the applier is driven by that explicit choice (--choice) and ALWAYS
  // runs. Its presence also surfaces in the detect offer as a "choice pending"
  // clause.
  const choiceFile = path.join(finalDir, 'wcag-choice.json');
  const hasChoice = existsSync(choiceFile);
  // DETECT needs only the engine — it carries the analyzer now. The remediation
  // applier (and the Node type-stripping it needs) is an APPLY-only requirement,
  // checked there.
  if (!existsSync(VEED_ENGINE_BIN)) throw new Error(missingToolError('engine', VEED_ENGINE_BIN));

  const stats = audit(
    finalDir,
    path.join(finalDir, 'wcag-contrast-report.json'),
    path.join(finalDir, 'contrast-statistics.json'),
  );
  const classOf = classOfDir(finalDir);
  const before = summarizeStatistics(stats, classOf);

  // DEFAULT: detect + report, no remediation, no promotion, no sibling dir.
  if (!opts.apply) {
    return wcagDetectDecision(before, hasChoice);
  }

  // APPLY: plan, remediate, verify, evaluate analytically, promote on measured improvement.
  if (!existsSync(WCAG_REMEDIATE)) throw new Error(missingToolError('remediate', WCAG_REMEDIATE));
  if (!nodeVersionSupportsTsStripping(process.version)) {
    throw new Error(`wcag-pass: Node ${process.version} cannot run the remediation applier (needs native .ts type-stripping: >=22.18 or >=23)`);
  }

  let after: WcagRunSummary | null = null;
  let resolvedChoicePath = '';
  let appliedEntries: Treatment[] = [];
  try {
    if (shouldRunApplier(before.passed, before.anyApplicable, hasChoice)) {
      // --choice REPLACES --plan (the applier treats them as mutually exclusive
      // modes: auto colours vs user-chosen).
      let sourceArgs: string[];
      if (hasChoice) {
        // RESOLVE the authored class keys to the elements they name, and REFUSE a
        // selector that names none — an unmatched key would inject CSS selecting
        // nothing, evaluate identically, and still promote unconditionally. The
        // resolved copy is what the applier consumes and is kept as evidence of
        // what was actually targeted; the authored file is left as written.
        const authored = parseChoiceFile(JSON.parse(readFileSync(choiceFile, 'utf8')));
        // A choice file REPLACES the whole remediation block, so it is not
        // additive: a class an earlier apply fixed and this one omits would
        // silently lose its fix, and the run would still report as remediated.
        // The archive is what the current block was built from.
        const archive = path.join(finalDir, 'wcag-choice.applied.json');
        if (existsSync(archive)) {
          const prior = parseChoiceFile(JSON.parse(readFileSync(archive, 'utf8')));
          const dropped = droppedSelectors(prior.chosen, authored.chosen);
          if (dropped.length > 0) {
            throw new Error(
              `wcag-pass: this choice omits ${dropped.join(', ')}, which an earlier apply had fixed — ` +
              `each apply REPLACES the whole remediation, so an omitted class silently loses its fix. ` +
              `List every class you want kept in ${choiceFile} (the previous pick is in ${archive}).`,
            );
          }
        }
        const targets = resolveChoiceTargets(authored.chosen, stats, classOf);
        const resolved = {
          schema: 1 as const,
          chosen: authored.chosen.map((c, i) => ({ ...c, ids: targets[i].ids })),
        };
        resolvedChoicePath = path.join(finalDir, 'wcag-choice.resolved.json');
        writeFileSync(resolvedChoicePath, JSON.stringify(resolved, null, 2) + '\n');
        appliedEntries = resolved.chosen;
        sourceArgs = ['--choice', resolvedChoicePath];
      } else {
        const planPath = path.join(finalDir, 'wcag-remediation-plan.json');
        const plan = buildRemediationPlan(stats, classOf);
        writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n');
        // The same rules the applier emits, as treatments the analytic
        // evaluation can score — the plan's selectors are already id lists.
        appliedEntries = plan.rules.map((r) => ({
          kind: 'colour' as const,
          hex: r.hex,
          ids: r.selector.split(',').map((s) => s.trim().replace(/^#/, '')),
        }));
        sourceArgs = ['--plan', planPath];
      }
      sh('node', [WCAG_REMEDIATE, ...sourceArgs, '--template-dir', finalDir], [0]);
      // VERIFY BEFORE ANYTHING MOVES. The remediated template must hold the same
      // structural guarantee the record step relies on, and the sibling holds
      // exactly the bytes that would be promoted. Checking here means a failure
      // leaves final/ as it was; verifying after the promotion moves would have
      // needed a rollback nothing implemented.
      sh(VEED_ENGINE_BIN, [sibling, '--verify'], [0]);
      // ANALYTIC, never re-sampled. The decoration is painted over the footage,
      // so its effect is computed against the constant samples — see treat.ts.
      after = summarizeStatistics(applyTreatment(stats, appliedEntries, classOf), classOf);
      // Harvest the file artifacts out of the sibling before it is removed.
      const remediatedTemplate = path.join(finalDir, 'template.draft.wcag-remediated.wv');
      const remediationCss = path.join(finalDir, 'wcag-remediation.css');
      copyFileSync(path.join(sibling, 'template.wv'), remediatedTemplate);
      copyFileSync(path.join(sibling, 'wcag-remediation.css'), remediationCss);
      // THE PROMOTION GATE. `after` is computed from the treatments, so it would
      // report the same improvement whatever the applier actually wrote. What
      // makes the number mean something is this: the block landed, every rule
      // targets text the audit measured, and the rules ARE the treatments that
      // were scored. A mismatch is an applier defect, so it fails loudly rather
      // than downgrading to a quieter status.
      const structural = checkApplied({
        css: readFileSync(remediationCss, 'utf8'),
        template: readFileSync(remediatedTemplate, 'utf8'),
        treatments: appliedEntries,
        auditedIds: new Set(stats.elements.map((e) => e.id)),
      });
      if (structural) {
        throw new Error(
          `wcag-pass: what was scored is not what the applier emitted — ${structural}. ` +
          `Nothing was promoted; final/ is untouched.`,
        );
      }
    }
  } finally {
    rmSync(sibling, { recursive: true, force: true });
  }

  // ONE number, not two. The old pass printed a raw re-sample alongside a
  // "credited" line because the sampler could not see a shadow; with the outcome
  // computed against the constant samples there is nothing to reconcile.
  const decision = wcagPassDecision(before, after, { choiceApplied: hasChoice && after !== null });
  if (decision.promoted) {
    // FINAL IS FINAL: execute the pure promotion plan (draft preservation,
    // choice archival, pre-apply render snapshot — see planPromotion).
    const plan = planPromotion({
      draftExists: existsSync(path.join(finalDir, 'template.draft.wv')),
      choiceApplied: hasChoice && after !== null,
      renderExists: existsSync(path.join(finalDir, 'out.silent.mp4')),
      muxedExists: existsSync(path.join(finalDir, 'out.mp4')),
    });
    for (const op of plan) {
      const from = path.join(finalDir, op.from);
      const to = path.join(finalDir, op.to);
      if (op.kind === 'rename') renameSync(from, to);
      else copyFileSync(from, to);
    }
    // No verify here: the same bytes were verified in the sibling before the
    // first file moved, which is what keeps a failure from leaving final/ half
    // promoted.
  }
  return decision;
}

// --- CLI --------------------------------------------------------------------

if (isMainModule(process.argv[1], import.meta.url)) {
  const i = process.argv.indexOf('--run');
  const runDir = i >= 0 ? process.argv[i + 1] : undefined;
  const apply = process.argv.includes('--apply');
  if (!runDir) {
    console.error('usage: node --import tsx pipeline/scripts/wcag-pass.ts --run runs/<key> [--apply]');
    process.exit(1);
  }
  try {
    const d = runWcagPass(runDir, { apply });
    console.log(`[wcag-pass] status: ${d.status}${d.promoted ? ' (final/template.wv is now the remediated template; draft preserved)' : ''}`);
    for (const n of d.notes) console.log(`[wcag-pass] ${n}`);
    process.exit(0);
  } catch (e: any) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
}
