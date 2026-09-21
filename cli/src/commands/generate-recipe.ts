// Recipe runner — the fast path's DESIGN + RENDER for recipe-backed picks. Loads the compiled recipe for the
// run's sampled ref (refs/html/<id>/recipe.ts), generates runs/<key>/final/{template.wv,
// manifest.json} deterministically (zero tokens), then optionally drives the full gate chain:
// lint → --verify (mechanical ladder fix loop) → --record → probe-qa. Run OUTSIDE any sandbox when
// passing --verify/--record (the engine needs the window-server).
//   openedit generate-recipe --run <runDir> [--verify] [--record] [--module <path>]
// --module runs a specific recipe module (standalone runs — no style.json needed — or a CUSTOMISED
// copy). Never edit a library recipe (refs/html/<id>/recipe.ts) for one run: copy it to the scratchpad,
// rewrite its relative lib import to the absolute pipeline/recipes/lib.ts path, edit the copy, pass it here.
// Exit: 0 done · 1 a gate failed (lint error, verify after the fix cycles, record, or probe FAIL) ·
// 2 usage, or a refused input (a --module that does not exist, a style.json pointing outside the
// recipe library) · 3 no compiled recipe for the sampled ref (caller runs the from-scratch inline pass).
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { wcagPass } from './wcag-pass.ts';
import { contentRoot, engineBinPath, engineEnv, workspaceRoot } from '../config.ts';
import { probeRun } from './probe-qa.ts';
import { readStylePick } from './sample-style.ts';
import { compiledGeneratorRelPath, generatorRelPath, type RecipeGenerator, type RunMeta } from '../recipes-contract.ts';
import type { WordTimings } from '../prep/synth-word-timings.ts';
import { reexecFailureReason, reexecWithStripTypes, tsxImportUrl } from '../ts-runtime.ts';

const MAX_FIX_CYCLES = 2;

// Node raises its own code here, which the ERR_UNKNOWN_FILE_EXTENSION path below never sees.
export function moduleLoadHint(modPath: string, code: string | undefined): string | null {
  if (code !== 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING') return null;
  const compiled = modPath.replace(/\.ts$/, '.js');
  const sibling = compiled !== modPath && existsSync(compiled) ? ` — pass the compiled module instead: --module ${compiled}` : '';
  return `[generate-recipe] ${modPath} is TypeScript inside node_modules, which Node never type-strips${sibling}`;
}

// --verify's bounds failures name a beat-scoped caption element. Id shapes vary per recipe
// (#b3p1l2, #b3p1, #b3l2, #b3l1r2, …) but all are `b<beat>` + letter+digit segments; the runner
// passes the EXACT id as a demotion key and each recipe maps it to its own ladder scope via
// demotionFor. Anything else failing means a generator bug — report, never improvise.
function boundsLineIds(verifyOut: string): string[] {
  return [...verifyOut.matchAll(/FAIL\[bounds\] #(b\d+(?:[a-z]+\d*)*)\b/g)].map((m) => m[1]);
}

export const usage = {
  summary: "Run a workspace's compiled recipe for a sampled style, then drive the gate chain",
  flags: {
    run: { type: 'string', value: '<runDir>', required: true, help: 'The run whose style.json names the recipe' },
    module: { type: 'string', value: '<path>', help: 'A customised copy of the recipe to run instead of the library one' },
    verify: { type: 'boolean', help: "Run the engine's --verify with the mechanical fix ladder" },
    record: { type: 'boolean', help: 'Record out.silent.mp4 after a clean verify (implies --verify)' },
    wcag: { type: 'boolean', help: 'Contrast-audit the rendered final between verify and record, detect only' },
    'wcag-apply': { type: 'boolean', help: 'Also promote a remediated template on measured improvement (implies --wcag)' },
    'progress-output': { type: 'boolean', help: 'Stream the engine\'s progress lines' },
  },
} satisfies Usage;

export async function generateRecipe(argv: string[]): Promise<number> {
  // Strict: an unknown flag is an error, never a no-op. This script once accepted --style, ignored it,
  // and re-rendered the previously sampled ref — printing the OLD id while looking like it had worked.
  const { values } = parseUsage('generate-recipe', usage, argv);
  const runArg = values.run;
  if (!runArg) {
    console.error(usageLine('generate-recipe', usage));
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
    // node_modules is never type-stripped, and every ref ships its compiled module beside the source.
    if (modPath.endsWith(".ts") && modPath.split(sep).includes("node_modules")) {
      const compiled = modPath.replace(/\.ts$/, ".js");
      if (existsSync(compiled)) modPath = compiled;
    }
    console.log(`[generate-recipe] module ${modPath}`);
  } else {
    const style = readStylePick(runDir);
    const compiled = join(contentRoot(), compiledGeneratorRelPath(style.refId));
    modPath = existsSync(compiled) ? compiled : join(contentRoot(), generatorRelPath(style.refId));
    // Last line before import(): whatever style.json said, a library module lives under refs/html/.
    // --module is exempt by design — an explicit operator path (the scratchpad copy) is the point.
    const libraryRoot = join(contentRoot(), 'refs', 'html') + sep;
    if (!modPath.startsWith(libraryRoot)) {
      console.error(`[generate-recipe] refusing to load ${modPath}: outside ${libraryRoot}`);
      return 2;
    }
    if (!style.hasRecipe || !existsSync(modPath)) {
      console.error(`[generate-recipe] no compiled recipe for "${style.refId}" (${modPath}) — run the from-scratch inline pass (SKILL: DESIGN + RENDER variant B)`);
      return 3;
    }
  }
  // Recipe modules are workspace TypeScript. Try the load, then retry under the stripping flag,
  // rather than grading the runtime by version.
  let recipe: RecipeGenerator;
  try {
    recipe = (await import(pathToFileURL(modPath).href)).default as RecipeGenerator;
  } catch (e) {
    const hint = moduleLoadHint(modPath, (e as NodeJS.ErrnoException).code);
    if (hint) {
      console.error(hint);
      return 2;
    }
    if ((e as NodeJS.ErrnoException).code !== 'ERR_UNKNOWN_FILE_EXTENSION') throw e;
    // Node never strips types inside node_modules, on any version and under any flag, so re-running
    // an installed package's own .ts walks into the same wall a second time. Where the compiled
    // module ships beside the source — every ref in the pool — name it instead of retrying.
    const compiled = modPath.replace(/\.ts$/, '.js');
    if (compiled !== modPath && existsSync(compiled)) {
      console.error(`[generate-recipe] ${modPath} is TypeScript this Node cannot load — pass --module ${compiled}, the compiled module beside it`);
      return 2;
    }
    const outcome = reexecWithStripTypes();
    if (outcome.kind === 'ran') return outcome.code;
    console.error(`[generate-recipe] cannot load the recipe module ${modPath}: ${reexecFailureReason(outcome)}`);
    return 2;
  }
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
  // The manifest is written seven lines up, and three rules are decidable only with it — a run that
  // lints without it is running a strictly weaker gate than the shell path, silently.
  // The lint rules live in the workspace (substrate-owned, next to the recipes they govern);
  // --json hands back the same findings the old in-process import returned.
  const lint = (): { severity: string; rule: string; message: string }[] => {
    const base = join(contentRoot(), 'pipeline', 'scripts', 'lint-template');
    const lintPath = existsSync(`${base}.js`) ? `${base}.js` : `${base}.ts`;
    if (!existsSync(lintPath)) throw new Error(`[generate-recipe] ${lintPath} not found — the content root carries no gates; point OPEN_EDIT_ROOT at an Open Edit checkout or reinstall the package`);
    const runtime = lintPath.endsWith('.js') ? [lintPath] : ['--import', tsxImportUrl(contentRoot()), lintPath];
    const r = spawnSync(process.execPath, [...runtime, tplPath, '--json'], { encoding: 'utf8', cwd: workspaceRoot() });
    if (r.error || r.stdout === null) throw new Error(`[generate-recipe] lint could not run: ${r.error?.message ?? 'no output'}`);
    return JSON.parse(r.stdout);
  };
  const findings = lint();
  for (const x of findings) console.log(`${x.severity.toUpperCase()}[${x.rule}] ${x.message}`);
  if (findings.some((x) => x.severity === 'error')) {
    console.error('[generate-recipe] lint failed — fix the recipe module, never the generated document');
    return 1;
  }
  if (!doVerify) return 0;

  // Folder mode discovers template.wv (engine >= 0.7.1) and picks up manifest.json alongside it.
  for (let cycle = 0; ; cycle++) {
    const r = spawnSync(engineBinPath(), [finalDir, '--verify'], { encoding: 'utf8', env: engineEnv(), cwd: workspaceRoot() });
    if (r.error) { console.error(`[generate-recipe] cannot run ${engineBinPath()}: ${r.error.message}`); return 1; }
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.status === 0) { console.log(`[generate-recipe] verify clean (exit 0)${cycle ? ` after ${cycle} fix cycle(s)` : ''}`); break; }
    const lineIds = boundsLineIds(out);
    if (r.status !== 1 || !lineIds.length || cycle >= MAX_FIX_CYCLES) {
      console.error(out.trim());
      console.error(`[generate-recipe] verify failed (exit ${r.status})${lineIds.length ? '' : ' — no mechanical fix applies (not a bounds failure on a caption line)'}`);
      return 1;
    }
    // one row per failing element per cycle: --verify names the element once per offending frame
    for (const key of new Set(lineIds)) demote[key] = (demote[key] ?? 0) + 1;
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
    // Exit 1 is tooling (engine missing or below the analyzer floor) — the same hard fail as before.
    if (wcagPass(['--run', runDir, ...(doWcagApply ? ['--apply'] : [])]) !== 0) return 1;
  }

  if (doRecord) {
    const outMp4 = join(finalDir, 'out.silent.mp4');
    const r = spawnSync(engineBinPath(), [finalDir, '--progress-output', '--record', outMp4], { stdio: 'inherit', env: engineEnv(), cwd: workspaceRoot() });
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

