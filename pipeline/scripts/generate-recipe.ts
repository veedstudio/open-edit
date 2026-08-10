// Recipe runner — the fast path's DESIGN + RENDER for recipe-backed picks. Loads the compiled recipe for the
// run's sampled ref (refs/html/<id>/recipe.ts), generates runs/<key>/final/{template.wv,
// manifest.json} deterministically (zero tokens), then optionally drives the full gate chain:
// lint → --verify (mechanical ladder fix loop) → --record → probe-qa. Run OUTSIDE any sandbox when
// passing --verify/--record (the engine needs the window-server).
//   node --import tsx pipeline/scripts/generate-recipe.ts --run <runDir> [--verify] [--record] [--module <path>]
// --module runs a specific recipe module (standalone runs — no style.json needed — or a CUSTOMISED
// copy). Never edit a library recipe (refs/html/<id>/recipe.ts) for one run: copy it to the scratchpad,
// rewrite its relative lib import to the absolute pipeline/recipes/lib.ts path, edit the copy, pass it here.
// Exit: 0 done · 1 a gate failed (lint error, verify after the fix cycles, record, or probe FAIL) ·
// 2 usage, or a refused input (a --module that does not exist, a style.json pointing outside the
// recipe library) · 3 no compiled recipe for the sampled ref (caller runs the from-scratch inline pass).
import { parseFlags } from '../../veed/args.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, VEED_ENGINE_BIN } from '../../config.ts';
import { lintTemplate } from './lint-template.ts';
import { probeRun } from './probe-qa.ts';
import { readStylePick } from './sample-style.ts';
import { generatorRelPath, type RecipeGenerator, type RunMeta } from '../recipes/lib.ts';
import type { WordTimings } from './synth-word-timings.ts';

const MAX_FIX_CYCLES = 2;

// --verify's bounds failures name a beat-scoped caption element. Id shapes vary per recipe
// (#b3p1l2, #b3p1, #b3l2, #b3l1r2, …) but all are `b<beat>` + letter+digit segments; the runner
// passes the EXACT id as a demotion key and each recipe maps it to its own ladder scope via
// demotionFor. Anything else failing means a generator bug — report, never improvise.
function boundsLineIds(verifyOut: string): string[] {
  return [...verifyOut.matchAll(/FAIL\[bounds\] #(b\d+(?:[a-z]+\d*)*)\b/g)].map((m) => m[1]);
}

async function main(): Promise<number> {
  // Strict: an unknown flag is an error, never a no-op. This script once accepted --style, ignored it,
  // and re-rendered the previously sampled ref — printing the OLD id while looking like it had worked.
  // A flag that changes nothing must say so rather than let a run look like it obeyed.
  const { values } = parseFlags({
    args: process.argv.slice(2),
    options: {
      run: { type: 'string' },
      module: { type: 'string' },
      record: { type: 'boolean' },
      verify: { type: 'boolean' },
      wcag: { type: 'boolean' },
      'wcag-apply': { type: 'boolean' },
      'progress-output': { type: 'boolean' },
    },
  });
  const runArg = values.run;
  if (!runArg) {
    console.error('usage: node --import tsx pipeline/scripts/generate-recipe.ts --run <runDir> [--verify] [--record] [--wcag] [--wcag-apply] [--module <path>]');
    return 2;
  }
  const runDir = resolve(runArg);
  const doRecord = values.record ?? false;
  const doVerify = (values.verify ?? false) || doRecord; // record only ever happens on a clean verify
  // --wcag: opt-in WCAG AA contrast pass between verify and record (DEFAULT on
  // the creative faces, which run the gates by hand — see the skill; opt-in
  // here so the recipe fast path stays byte-identical until asked). It runs
  // DETECT-ONLY: it audits real rendered contrast + emits contrast-statistics.json
  // and reports, but changes nothing. It only makes sense inside the gate
  // chain — bare --wcag would run without a rendered final/ to audit.
  // --wcag-apply implies --wcag and runs the pass in APPLY mode (remediate +
  // promote a remediated final/template.wv on measured improvement).
  const doWcagApply = values['wcag-apply'] ?? false;
  const doWcag = (values.wcag ?? false) || doWcagApply;
  if (doWcag && !doVerify) {
    console.error('[generate-recipe] --wcag requires --verify or --record (the WCAG pass runs after a clean verify)');
    return 2;
  }

  // --module needs no style.json (independent/standalone runs); the sampled-ref path requires it.
  const moduleOverride = values.module;
  let modPath: string;
  if (moduleOverride) {
    modPath = resolve(moduleOverride);
    if (!existsSync(modPath)) { console.error(`[generate-recipe] --module ${modPath} does not exist`); return 2; }
    console.log(`[generate-recipe] module ${modPath}`);
  } else {
    const style = readStylePick(runDir);
    modPath = join(REPO_ROOT, generatorRelPath(style.refId));
    // Last line before import(): whatever style.json said, a library module lives under refs/html/.
    // --module is exempt by design — an explicit operator path (the scratchpad copy) is the point.
    const libraryRoot = join(REPO_ROOT, 'refs', 'html') + sep;
    if (!modPath.startsWith(libraryRoot)) {
      console.error(`[generate-recipe] refusing to load ${modPath}: outside ${libraryRoot}`);
      return 2;
    }
    if (!style.hasRecipe || !existsSync(modPath)) {
      console.error(`[generate-recipe] no compiled recipe for "${style.refId}" (${modPath}) — run the from-scratch inline pass (SKILL: DESIGN + RENDER variant B)`);
      return 3;
    }
  }
  const recipe = (await import(pathToFileURL(modPath).href)).default as RecipeGenerator;
  const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')) as RunMeta;
  const timings = JSON.parse(readFileSync(join(runDir, 'word-timings.json'), 'utf8')) as WordTimings;

  const finalDir = join(runDir, 'final');
  mkdirSync(finalDir, { recursive: true });
  const demote: Record<string, number> = {};
  const tplPath = join(finalDir, 'template.wv');
  const manifestPath = join(finalDir, 'manifest.json');
  const write = () => {
    const out = recipe.generate(meta, timings, { demote });
    writeFileSync(tplPath, out.wv);
    writeFileSync(manifestPath, out.manifest);
  };
  write();
  console.log(`[generate-recipe] ${recipe.refId}: ${timings.beats.length} beats → ${tplPath}`);

  // Gate 1 — LINT (pure, no engine; runs on every generate): a generated document violating engine
  // limits is a generator bug — fix the recipe module (or lib), never the output.
  const lint = () => lintTemplate(readFileSync(tplPath, 'utf8'));
  const findings = lint();
  for (const x of findings) console.log(`${x.severity.toUpperCase()}[${x.rule}] ${x.message}`);
  if (findings.some((x) => x.severity === 'error')) {
    console.error('[generate-recipe] lint failed — fix the recipe module, never the generated document');
    return 1;
  }
  if (!doVerify) return 0;

  // Folder mode discovers template.wv (engine >= 0.7.1) and picks up manifest.json alongside it.
  for (let cycle = 0; ; cycle++) {
    const r = spawnSync(VEED_ENGINE_BIN, [finalDir, '--verify'], { encoding: 'utf8' });
    if (r.error) { console.error(`[generate-recipe] cannot run ${VEED_ENGINE_BIN}: ${r.error.message}`); return 1; }
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.status === 0) { console.log(`[generate-recipe] verify clean (exit 0)${cycle ? ` after ${cycle} fix cycle(s)` : ''}`); break; }
    const lineIds = boundsLineIds(out);
    if (r.status !== 1 || !lineIds.length || cycle >= MAX_FIX_CYCLES) {
      console.error(out.trim());
      console.error(`[generate-recipe] verify failed (exit ${r.status})${lineIds.length ? '' : ' — no mechanical fix applies (not a bounds failure on a caption line)'}`);
      return 1;
    }
    for (const key of lineIds) demote[key] = (demote[key] ?? 0) + 1;
    console.log(`[generate-recipe] FAIL[bounds] → ladder step down: ${lineIds.join(', ')} (cycle ${cycle + 1}/${MAX_FIX_CYCLES})`);
    write();
  }

  // The ladder loop regenerates on demotion — re-check the final document (errors only; warns shown above).
  if (Object.keys(demote).length && lint().some((x) => x.severity === 'error')) {
    console.error('[generate-recipe] lint failed after ladder demotion — generator bug; report, never hand-edit');
    return 1;
  }

  // Gate 3.5 — WCAG: audit real rendered contrast + emit contrast-statistics.json,
  // then report. DETECT-ONLY: status 'attention' lists every low-contrast
  // selector but changes nothing — record still consumes the verified final/.
  if (doWcag) {
    const { runWcagPass } = await import('./wcag-pass.ts');
    try {
      const d = runWcagPass(runDir, { apply: doWcagApply });
      console.log(`[generate-recipe] wcag: ${d.status}${d.promoted ? ' (remediated template promoted into final/template.wv)' : ''}`);
      for (const n of d.notes) console.log(`[generate-recipe] wcag: ${n}`);
    } catch (e) {
      console.error(String((e as Error).message ?? e));
      return 1;
    }
  }

  if (doRecord) {
    const outMp4 = join(finalDir, 'out.silent.mp4');
    const r = spawnSync(VEED_ENGINE_BIN, [finalDir, '--progress-output', '--record', outMp4], { stdio: 'inherit' });
    if (r.status !== 0) { console.error(`[generate-recipe] record failed (exit ${r.status})`); return 1; }
    console.log(`[generate-recipe] recorded ${outMp4}`);

    // Gate 4 — PROBE: mechanical frame QA vs the source (the defects --verify can't see: dead-air
    // mid-beat, unreadable ink). FAIL → do NOT redesign and do NOT auto-re-render; report honestly
    // and offer a --seed/--style re-run. Warns are FYI — mention them and proceed.
    const probes = probeRun(runDir);
    for (const p of probes.filter((x) => x.verdict !== 'pass')) {
      console.log(`[probe-qa] beat ${p.beat} ${p.probe}@${p.tSec}s ink=${p.inkPct}% contrast=${p.contrast ?? '-'} ${p.verdict.toUpperCase()}${p.notes.length ? ' — ' + p.notes.join('; ') : ''}`);
    }
    const probeFails = probes.filter((x) => x.verdict === 'fail');
    if (probeFails.length) {
      console.error(`[generate-recipe] probe-qa: ${probeFails.length} FAIL — report honestly; offer a --seed/--style re-run`);
      return 1;
    }
    console.log(`[generate-recipe] probe-qa clean (${probes.filter((x) => x.verdict === 'warn').length} warn)`);
  }
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
