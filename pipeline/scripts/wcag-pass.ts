// WCAG text-contrast pass — DEFAULT gate on creative runs (face-1 AND remix),
// opt-in on the recipe fast path (generate-recipe.ts --wcag). Level AA.
//
// STATISTICS-NATIVE, two modes:
//  DETECT (default): sample real backgrounds (veed-engine-cli --contrast-audit)
//    → analyze (wcag-contrast --statistics → the policy-free
//    final/contrast-statistics.json) → score verdicts and policy IN TS
//    (verdicts.ts + policy.ts) → summarize and RETURN. Renders nothing,
//    changes nothing, promotes nothing. Clean → status 'pass'; low-contrast
//    elements → status 'attention' with the counts, the --apply offer, and one
//    review line per non-passing selector.
//  APPLY (--apply): DETECT, then remediate, re-audit the candidate, and
//    promote. With a studio/chat choice at final/wcag-choice.json the applier
//    is driven by that explicit choice (--choice) and ALWAYS runs — a clicked
//    choice always takes effect and promotes unconditionally. With NO choice it
//    falls back to the automatic hue-preserving colour plan (within-bar
//    recolors only), promoted only on MEASURED improvement (strictly fewer
//    failing runs).
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
//   wcag-remediation-plan.json + contrast-statistics{,.remediated}.json
// No directory copies, no video artifacts — the pass renders nothing. A
// promoted final/ is re---verify'd before the pass returns.
//
// TRANSPARENCY IS THE CONTRACT: every non-passing selector is listed with its
// disposition (will fix / no colour satisfies / halo recommended /
// indeterminate) — nothing failing goes unlisted, and missing tooling is a
// HARD failure (exit 1), never a skip.
//
//   node --import tsx pipeline/scripts/wcag-pass.ts --run runs/<key> [--apply]
//
// Requires (until releases bundle them — see config.ts): a weave-renderer
// checkout providing the wcag-contrast binary.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VEED_ENGINE_BIN, WCAG_CONTRAST_BIN, WCAG_REMEDIATE } from '../../config.ts';
import {
  effectiveThreshold,
  guaranteedFix,
  relativeLuminance,
  rollUpPolicy,
  type ClassPolicyResult,
  type RecOption,
  type RunPolicyInput,
} from './wcag/policy.ts';
import { resolveCreditedVerdicts } from './wcag/credited-verdicts.ts';
import { hex, type RemediationPlan } from './wcag/remediate.ts';
import { parseElementClasses, resolveVerdicts, type Statistics } from './wcag/verdicts.ts';

// The analyzer CLI's default knobs; the gate scores with the same values.
export const DEFAULT_BAR = 0.1;
export const DEFAULT_MIN_LEAD_RATIO = 2.0;

// --- pure helpers (unit-tested in tests/wcag-pass.test.ts) ------------------

export interface WcagRunSummary {
  passed: boolean;
  totalRuns: number;
  failingRuns: number;
  indeterminateRuns: number;
  /** True when ANY within-bar recolor exists at class OR exception level —
   * i.e. the applier would change at least one rule. */
  anyApplicable: boolean;
  /** EXHAUSTIVE per-selector dispositions — every class/exception that is not
   * already passing gets a line; nothing is ever suppressed. */
  dispositions: string[];
}

// The roll-up key rule: classed -> `.name`, class-less -> `#id`.
const keyFor = (r: RunPolicyInput) => (r.className !== null ? `.${r.className}` : `#${r.id}`);

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

// One selector's outcome: the within-bar recolor the auto path applies (or
// null), and its disposition line. The single source both the summary and the
// remediation plan are built from.
interface SelectorOutcome {
  selector: string;
  applied: RecOption | null;
  disposition: string;
}

// A within-bar recolor leads and is the auto-appliable fix; otherwise a
// guaranteed halo/backing (recommended, never auto-applied — colours-only
// policy); otherwise the honest negatives.
function outcomeFor(
  selector: string, opts: RecOption[], kind: 'class' | 'exception',
  haloInput: { fg: RunPolicyInput['fg']; r: number; a: number },
): SelectorOutcome {
  const lead = opts[0];
  if (lead && lead.withinBar) {
    return { selector, applied: lead, disposition: `${selector}: will fix (${kind} recolor)` };
  }
  const gf = guaranteedFix(haloInput.fg, haloInput.r, haloInput.a);
  const disposition = gf
    ? `${selector}: ${gf.kind === 'halo' ? 'halo' : 'recolor+backing'} recommended — not auto-applied (colours-only policy), human review`
    : lead
      ? `${selector}: no colour satisfies AA within policy (best colour above bar) — human review`
      : `${selector}: no feasible fix computed — human review`;
  return { selector, applied: null, disposition };
}

// TS verdicts + the class roll-up over the statistics, walked into per-selector
// outcomes. Pure.
function analyzeStatistics(stats: Statistics, classOf: (id: string) => string | null) {
  const verdicts = resolveVerdicts(stats);
  const passing = new Map(verdicts.elements.map((e) => [e.id, e.aa]));
  const inputs = stats.elements.map((elt) =>
    policyInput(elt, passing.get(elt.id) ?? false, classOf(elt.id)),
  );
  const byId = new Map(inputs.map((i) => [i.id, i]));
  const members = new Map<string, RunPolicyInput[]>();
  for (const i of inputs) {
    const key = keyFor(i);
    if (!members.has(key)) members.set(key, []);
    members.get(key)!.push(i);
  }

  const classes: ClassPolicyResult[] = rollUpPolicy(inputs, DEFAULT_BAR, DEFAULT_MIN_LEAD_RATIO);
  const outcomes: SelectorOutcome[] = [];
  for (const c of classes) {
    if (c.recolorOptions.length === 0 && c.exceptions.length === 0) continue; // tier 0 — passing
    // Class-level halo check mirrors rollupClass's option inputs: the first
    // determinate member's fg/alpha at the class's strictest required ratio.
    // A class line is emitted whenever a determinate member fails — even with
    // no recolor options (the halo/no-fix negatives still need saying).
    const determinate = (members.get(c.classKey) ?? []).filter((m) => !m.indeterminate);
    if (determinate.some((m) => !m.passes)) {
      const maxR = determinate.reduce((r, m) => Math.max(r, m.requiredRatio), 0.0);
      const halo = { fg: determinate[0].fg, r: maxR, a: determinate[0].fgAlpha };
      outcomes.push(outcomeFor(c.classKey, c.recolorOptions, 'class', halo));
    }
    for (const e of c.exceptions) {
      if (e.indeterminate) {
        outcomes.push({
          selector: `#${e.id}`,
          applied: null,
          disposition: `#${e.id}: indeterminate — background unsampleable; no sound fix`,
        });
        continue;
      }
      const m = byId.get(e.id)!;
      const halo = { fg: m.fg, r: m.requiredRatio, a: m.fgAlpha };
      outcomes.push(outcomeFor(`#${e.id}`, e.recolorOptions, 'exception', halo));
    }
  }
  return { verdicts, outcomes };
}

// Compress the statistics into what the gate reasons about. Pure.
export function summarizeStatistics(
  stats: Statistics, classOf: (id: string) => string | null,
): WcagRunSummary {
  const { verdicts, outcomes } = analyzeStatistics(stats, classOf);
  return {
    passed: verdicts.failingAA === 0,
    totalRuns: stats.elements.length,
    failingRuns: verdicts.failingAA,
    indeterminateRuns: verdicts.indeterminateCount,
    anyApplicable: outcomes.some((o) => o.applied !== null),
    dispositions: outcomes.map((o) => o.disposition),
  };
}

// The automatic colours-only remediation plan the applier consumes: one rule
// per within-bar recolor lead, every unapplied recommendation carried as a
// note so the emitted CSS keeps the full review trail. Pure.
export function buildRemediationPlan(
  stats: Statistics, classOf: (id: string) => string | null,
): RemediationPlan {
  const { outcomes } = analyzeStatistics(stats, classOf);
  return {
    level: 'AA',
    rules: outcomes
      .filter((o) => o.applied !== null)
      .map((o) => ({
        selector: o.selector,
        hex: hex(o.applied!.fix.color),
        massPct: o.applied!.estimatedFailure.mass * 100,
        worstRatio: o.applied!.estimatedFailure.worstRatio,
      })),
    notes: outcomes.filter((o) => o.applied === null).map((o) => o.disposition),
  };
}

export type WcagStatus = 'pass' | 'attention' | 'remediated' | 'not-improved' | 'residual';

export interface WcagDecision {
  status: WcagStatus;
  /** True iff the remediated template was PROMOTED into final/template.wv.
   * Always false in DETECT mode — detect never writes. */
  promoted: boolean;
  notes: string[];
}

// DETECT-mode decision (default): report only, never promote. Clean → 'pass';
// otherwise 'attention' whose FIRST note is a single product-voice offer line
// naming the two remediation routes (recommendation studio OR --apply),
// followed by the exhaustive per-selector dispositions. `runDir` is spliced
// into the recommend.ts command so the offer is copy-pasteable. `choicePending`
// (a wcag-choice.json the studio/chat wrote) adds a clause pointing at it — the
// caller passes the file-existence boolean; the pure layer does no I/O. Pure.
export function wcagDetectDecision(
  before: WcagRunSummary,
  runDir: string,
  choicePending = false,
): WcagDecision {
  if (before.passed) {
    // A passing run with NO pending choice is plainly clean. But a pending
    // studio/chat choice (e.g. an AAA tweak on an AA-passing run) must NOT be
    // silently dropped — surface it as 'attention' with the pending clause only.
    if (!choicePending) {
      return { status: 'pass', promoted: false, notes: ['WCAG AA: all text runs pass'] };
    }
    return {
      status: 'attention',
      promoted: false,
      notes: ['WCAG AA: all text runs pass at the current level; a studio choice is pending — apply it (wcag-pass --apply)'],
    };
  }
  const offer =
    `WCAG AA: ${before.failingRuns} of ${before.totalRuns} text elements have low contrast — ` +
    `see recommendations (node --import tsx pipeline/scripts/wcag/recommend.ts --run ${runDir}) ` +
    `or apply the automatic colour fixes (wcag-pass --apply)` +
    (choicePending ? `; a studio choice is pending — apply it (wcag-pass --apply)` : ``);
  return {
    status: 'attention',
    promoted: false,
    notes: [offer, ...before.dispositions.map((d) => `review: ${d}`)],
  };
}

// Whether the APPLY path runs the remediation applier. A pending studio/chat
// choice ALWAYS runs it — a clicked choice always takes effect, even on an
// AA-passing run carrying only an AAA tweak. With no choice, the AUTO path runs
// only when the run fails AND a colours-only fix is applicable. Pure.
export function shouldRunApplier(passed: boolean, anyApplicable: boolean, hasChoice: boolean): boolean {
  return hasChoice || (!passed && anyApplicable);
}

// Promotion rule: AUTO remediation promotes ONLY on measured improvement —
// strictly fewer failing runs after remediation. A USER-CHOSEN option
// (choiceApplied) promotes unconditionally, EVEN on an otherwise-passing run:
// the click/chat pick IS the decision; the re-audit numbers are reported as
// context, never a veto. The note credits the falloff model ONLY when a
// shadow/outline was actually applied (the sampler can't see those); a
// colour/background choice is measured directly. Pure.
export function wcagPassDecision(
  before: WcagRunSummary, after: WcagRunSummary | null,
  opts: { choiceApplied?: boolean; appliedKinds?: string[] } = {},
): WcagDecision {
  // A user-chosen option, once applied (after !== null), always promotes —
  // checked BEFORE the passing short-circuit so a choice on a passing run is
  // never dropped.
  if (opts.choiceApplied && after) {
    const kinds = opts.appliedKinds ?? [];
    const creditsFalloff = kinds.some((k) => k === 'shadow' || k === 'outline');
    const creditPhrase = creditsFalloff
      ? '(shadows/outlines credited via the falloff model)'
      : '(measured directly)';
    return {
      status: 'remediated',
      promoted: true,
      notes: [
        `WCAG AA: your chosen option is applied — re-audit: ${before.failingRuns} -> ${after.failingRuns} failing ${creditPhrase}`,
        ...after.dispositions.map((d) => `review (post-remediation re-audit): ${d}`),
      ],
    };
  }
  if (before.passed) {
    return { status: 'pass', promoted: false, notes: ['WCAG AA: all text runs pass'] };
  }
  const residue = before.dispositions.map((d) => `review: ${d}`);
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
        // The re-audit's dispositions describe the PROMOTED template — "will
        // fix" there means a further pass could still improve it (single-pass
        // by design); the prefix keeps that context explicit.
        ...after.dispositions.map((d) => `review (post-remediation re-audit): ${d}`),
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
//    so a stale click cannot silently re-promote forever.
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
    ops.push({ kind: 'rename', from: 'wcag-choice.json', to: 'wcag-choice.applied.json', reason: 'archive consumed studio/chat choice' });
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

export function missingToolError(tool: 'engine' | 'analyzer' | 'remediate', p: string): string {
  switch (tool) {
    case 'engine':
      return `wcag-pass: veed-engine-cli not found at ${p} — run pipeline/scripts/install-veed-engine.sh or set VEED_ENGINE_BIN`;
    case 'analyzer':
      return `wcag-pass: analyzer not found at ${p} — build it (cd <weave-renderer>/src/crates/wcag-contrast && cargo build) or set WCAG_CONTRAST_BIN / WEAVE_RENDERER_ROOT`;
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

// Sample + analyze one template dir: engine --contrast-audit, then the
// analyzer for statistics only (no -o, so its unused report goes to stdout —
// silenced; exit 1 = failing runs, a valid outcome).
function audit(templateDir: string, samplesPath: string, statsPath: string): Statistics {
  sh(VEED_ENGINE_BIN, [templateDir, '--contrast-audit', samplesPath, '--audit-fps', '5'], [0]);
  sh(WCAG_CONTRAST_BIN, [samplesPath, '--statistics', statsPath], [0, 1], true);
  return JSON.parse(readFileSync(statsPath, 'utf8'));
}

function classOfDir(templateDir: string): (id: string) => string | null {
  const classes = parseElementClasses(readFileSync(path.join(templateDir, 'template.wv'), 'utf8'));
  return (id) => classes.get(id) ?? null;
}

export function runWcagPass(runDir: string, opts: { apply?: boolean } = {}): WcagDecision {
  const finalDir = path.join(runDir, 'final');
  const sibling = `${finalDir}.wcag-remediated`; // applier impl detail; removed before return
  // A studio click (or chat "apply ...") writes final/wcag-choice.json; when it
  // is present the applier is driven by that explicit choice (--choice) and
  // ALWAYS runs. Its presence also surfaces in the detect offer as a "choice
  // pending" clause.
  const choiceFile = path.join(finalDir, 'wcag-choice.json');
  const hasChoice = existsSync(choiceFile);
  // DETECT needs only the engine + analyzer; the remediation applier (and the
  // Node type-stripping it needs) is an APPLY-only requirement — checked there.
  for (const [tool, p] of [['engine', VEED_ENGINE_BIN], ['analyzer', WCAG_CONTRAST_BIN]] as const) {
    if (!existsSync(p)) throw new Error(missingToolError(tool, p));
  }

  const stats = audit(
    finalDir,
    path.join(finalDir, 'wcag-contrast-samples.json'),
    path.join(finalDir, 'contrast-statistics.json'),
  );
  const classOf = classOfDir(finalDir);
  const before = summarizeStatistics(stats, classOf);

  // DEFAULT: detect + report, no remediation, no promotion, no sibling dir.
  if (!opts.apply) {
    return wcagDetectDecision(before, runDir, hasChoice);
  }

  // APPLY: plan, remediate, re-audit, promote on measured improvement, re-verify.
  if (!existsSync(WCAG_REMEDIATE)) throw new Error(missingToolError('remediate', WCAG_REMEDIATE));
  if (!nodeVersionSupportsTsStripping(process.version)) {
    throw new Error(`wcag-pass: Node ${process.version} cannot run the remediation applier (needs native .ts type-stripping: >=22.18 or >=23)`);
  }

  let after: WcagRunSummary | null = null;
  try {
    if (shouldRunApplier(before.passed, before.anyApplicable, hasChoice)) {
      // --choice REPLACES --plan (the applier treats them as mutually exclusive
      // modes: auto colours vs user-chosen).
      let sourceArgs: string[];
      if (hasChoice) {
        sourceArgs = ['--choice', choiceFile];
      } else {
        const planPath = path.join(finalDir, 'wcag-remediation-plan.json');
        writeFileSync(planPath, JSON.stringify(buildRemediationPlan(stats, classOf), null, 2) + '\n');
        sourceArgs = ['--plan', planPath];
      }
      sh('node', [WCAG_REMEDIATE, ...sourceArgs, '--template-dir', finalDir], [0]);
      const afterStats = audit(
        sibling,
        path.join(sibling, 'wcag-contrast-samples.json'),
        path.join(finalDir, 'contrast-statistics.remediated.json'),
      );
      after = summarizeStatistics(afterStats, classOfDir(sibling));
      // Harvest the file artifacts out of the sibling before it is removed.
      copyFileSync(path.join(sibling, 'template.wv'), path.join(finalDir, 'template.draft.wcag-remediated.wv'));
      copyFileSync(path.join(sibling, 'wcag-remediation.css'), path.join(finalDir, 'wcag-remediation.css'));
    }
  } finally {
    rmSync(sibling, { recursive: true, force: true });
  }

  const appliedKinds =
    hasChoice && after !== null
      ? ((JSON.parse(readFileSync(choiceFile, 'utf8')).chosen ?? []) as { kind: string }[]).map((c) => String(c.kind))
      : [];
  const decision = wcagPassDecision(before, after, { choiceApplied: hasChoice && after !== null, appliedKinds });
  // CREDITED re-audit (falloff model IN THE TS RESOLVER): the sampler cannot
  // see an applied shadow/outline, so the resolver blends the falloff-covered
  // treatment over the re-audit's sampled clusters and reports the credited
  // counts alongside. Samples are used as-is. Colour/background-only choices
  // are measured directly by the re-audit — nothing to credit, so no resolver
  // line.
  if (hasChoice && after !== null && appliedKinds.some((k) => k === 'shadow' || k === 'outline')) {
    try {
      const stats = JSON.parse(readFileSync(path.join(finalDir, 'contrast-statistics.remediated.json'), 'utf8')) as Statistics;
      const entries = JSON.parse(readFileSync(choiceFile, 'utf8')).chosen;
      const classes = parseElementClasses(readFileSync(path.join(finalDir, 'template.draft.wcag-remediated.wv'), 'utf8'));
      const credited = resolveCreditedVerdicts(stats, entries, (id: string) => classes.get(id) ?? null);
      decision.notes.splice(1, 0, `credited re-audit (falloff model, TS resolver): ${credited.failingAA} of ${credited.elements.length} failing at AA`);
    } catch (e) {
      decision.notes.splice(1, 0, `credited re-audit unavailable: ${(e as Error).message ?? e}`);
    }
  }
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
    // The promoted final/ must hold the same structural guarantee the record
    // step relies on: verify-clean. Colours-only edits cannot move geometry,
    // so this is expected to pass; a failure here is loud (throw -> exit 1)
    // with template.draft.wv preserved for rollback.
    sh(VEED_ENGINE_BIN, [finalDir, '--verify'], [0]);
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
