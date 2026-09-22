// THE GATE CHAIN, as one command.
//
//   openedit gates <run-dir> [--doc <subdir>] [--audio <file>] [--no-mux] [--no-loudnorm] [--no-expect] [--no-wcag] [--no-safezones]
//
// lint → expect-windows → --verify → contrast → --record → mux. Stops at the first failure and names it.
// RUN OUTSIDE ANY SANDBOX: --verify and --record need a real desktop session (the window-server on macOS).
//
// --no-mux     the run has no soundtrack to restore (the silent render is copied to out.mp4, so the
//              deliverable path is the same on every path)
// --no-expect  skip deriving `verify.expect` from the document's own gates. Do not reach for this to
//              make a failure go away: an expect-visible failure means a cue is off screen inside the
//              window the document itself declares, which is a real defect no other gate can see.
// --no-safezones  verify the bounds family only: a piece whose type is meant to bleed (and whose
//              manifest does not exempt it by id) or a canvas with no platform chrome to clear.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { contentRoot, engineBinPath, engineDocPath, engineEnv, workspaceRoot } from '../config.ts';
import { tsxImportUrl } from '../ts-runtime.ts';
import { expectWindows } from './expect-windows.ts';
import { muxAudio } from './mux-audio.ts';
import { runWcagPass } from './wcag-pass.ts';
import { assertDocInsideRun, printCheck, safezoneCheck } from './safezone-check.ts';

export const usage = {
  summary: 'THE gate chain: lint → expect-windows → verify → contrast → record → mux, one command',
  positionals: '<run-dir>',
  flags: {
    doc: { type: 'string', value: '<subdir>', help: 'Document under the run to gate: one chapter of a film (default final)' },
    audio: { type: 'string', value: '<file>', help: "A built soundtrack to mux instead of the source clip's own track" },
    'no-mux': { type: 'boolean', help: 'The run has no soundtrack to restore; the silent render is copied to out.mp4' },
    'no-loudnorm': { type: 'boolean', help: 'Skip levelling the muxed audio to the delivery loudness' },
    'no-expect': { type: 'boolean', help: 'Skip deriving verify.expect from the document; never to silence an expect-visible failure' },
    'no-wcag': { type: 'boolean', help: 'Skip the contrast audit' },
    'no-safezones': { type: 'boolean', help: 'Verify the bounds family only, without the triaged safe-zone check' },
  },
  notes: 'Stops at the first failure and names it. Run outside any sandbox: verify and record need a real desktop session.',
} satisfies Usage;

type Gate = 'lint' | 'expect-windows' | '--verify' | '--record' | 'mux';

class GateExit extends Error {
  constructor(readonly code: number, msg = '', readonly gate?: Gate, readonly ledger?: string) { super(msg); }
}
const die = (msg: string, code: number): never => { throw new GateExit(code, msg); };

// Two corrections per gate, then stop. The rule was prose ("at most twice, then report"), and a run
// nobody was watching re-ran a full chain five times against one gate. Counted per document, so the
// third failure says so itself; a clean pass clears it.
const BUDGET = 2;

/** Records one more failure at `gate` and returns how many it has now failed in a row. */
export function recordFailure(ledger: string, gate: string): number {
  let prior: { gate?: string; count?: number } = {};
  try { prior = JSON.parse(readFileSync(ledger, 'utf8')) as typeof prior; } catch { /* first failure, or an unreadable ledger */ }
  const count = prior.gate === gate ? (prior.count ?? 0) + 1 : 1;
  writeFileSync(ledger, JSON.stringify({ gate, count }) + '\n');
  return count;
}

/** The line a third failure in a row adds. The count shapes this message and never the exit code. */
export function budgetLine(gate: string, count: number): string | null {
  return count > BUDGET
    ? `gates: failure ${count} in a row at ${gate} — the ${BUDGET} correction cycles are spent. STOP: do not redesign and do not re-run again; report this failure in plain terms, with the file if one exists`
    : null;
}

export function gates(argv: string[]): number {
  try {
    rmSync(run(argv), { force: true });
    return 0;
  } catch (error) {
    if (error instanceof GateExit) {
      if (error.message) console.error(error.message);
      if (error.gate && error.ledger) {
        const line = budgetLine(error.gate, recordFailure(error.ledger, error.gate));
        if (line) console.error(line);
      }
      return error.code;
    }
    throw error;
  }
}

// The lint gate is CONTENT: it checks how a document is built, the rules the substrate is written against,
// co-versioned with the recipes it governs. A published install carries them compiled, so it runs as plain node; a checkout
// carries only .ts and needs tsx. Same script, same arguments, either way.
function runContentGate(script: string, args: string[]): boolean {
  const root = contentRoot();
  const compiled = join(root, `${script}.js`);
  const source = join(root, `${script}.ts`);
  const path = existsSync(compiled) ? compiled : source;
  if (!existsSync(path)) {
    die(`gates: ${script} not found under ${root} — the content root carries no gates; point OPEN_EDIT_ROOT at an Open Edit checkout or reinstall the package`, 2);
  }
  const runtime = path.endsWith('.js') ? [path] : ['--import', tsxImportUrl(root), path];
  return spawnSync(process.execPath, [...runtime, ...args], { stdio: 'inherit', cwd: workspaceRoot() }).status === 0;
}

// cwd is the workspace root so the engine finds its data/font-cache seed there — the same place
// every other run artifact anchors.
const runEngine = (args: string[]) =>
  spawnSync(engineBinPath(), args, { stdio: 'inherit', env: engineEnv(), cwd: workspaceRoot() }).status === 0;

/** Runs the chain and returns the path of this document's failure ledger, which a clean pass clears. */
function run(argv: string[]): string {
  const { values, positionals: [dir] } = parseUsage('gates', usage, argv);
  if (!dir) die(usageLine('gates', usage), 2);

  const noLoudnorm = !!values['no-loudnorm'];
  const noMux = !!values['no-mux'];
  const noExpect = !!values['no-expect'];
  const noWcag = !!values['no-wcag'];
  const noSafezones = !!values['no-safezones'];
  // Which document under the run this call gates. A captioned clip has one; a film has one per
  // chapter, and hardcoding `final` was why a seven-chapter run found no route through here.
  const doc = values.doc ?? 'final';
  try { assertDocInsideRun(doc); } catch (e) { die((e as Error).message, 2); }
  // A built soundtrack rather than the source clip's track — a film has one, a captioned clip does not.
  const audio = values.audio ?? '';

  // A flag that cannot take effect is worse than one that is refused, and the complaint belongs here:
  // downstream it would print only after lint, verify and record had already run.
  if (noMux && noLoudnorm) console.warn('gates: --no-loudnorm has no effect with --no-mux — nothing is muxed');

  const final = join(dir!, doc);
  const ledger = join(final, 'gates-attempts.json');
  const fail = (gate: Gate, code = 1): never => {
    throw new GateExit(code, `gates: FAILED at ${gate} — fix that, then re-run the gate chain`, gate, existsSync(final) ? ledger : undefined);
  };
  const tpl = join(final, 'template.wv');

  if (!existsSync(tpl)) die(`gates: no ${tpl} — author the document first`, 2);
  if (!existsSync(join(final, 'manifest.json'))) {
    die(`gates: no ${join(final, 'manifest.json')} — the render block is required`, 2);
  }

  console.log('gates: lint');
  if (!runContentGate('pipeline/scripts/lint-template', [tpl, '--engine-doc', engineDocPath()])) fail('lint');

  // Derive the timing assertions from the document's own gates, unless the manifest already carries a
  // hand-written set. Without them --verify only checks what IS drawn; with them it also checks WHEN.
  // `--write` stamps what it derived, so a re-run can replace its own work and leave a hand-written block
  // alone. Without the stamp the guard saw any `verify` block as authored and every later run gated the
  // document against the timings of an earlier one.
  const manifest = readFileSync(join(final, 'manifest.json'), 'utf8');
  if (!noExpect && (!manifest.includes('"verify"') || manifest.includes('"derivedBy"'))) {
    if (expectWindows([dir!, '--doc', doc, '--write'], { quiet: true }) !== 0) fail('expect-windows');
  }

  // Bounds and safe zones are one playback walk, and the safe-zone verdict arrives already triaged:
  // an entry flicker or dressing passes, a placement error names its edge and its fix in pixels.
  // "Could not check" is a failure of its own, never a pass, and never a correction cycle either: a
  // missing engine is not something the author can fix in the document, so it stays off the ledger.
  const verify = (): void => {
    if (noSafezones) {
      if (!runEngine([final, '--verify'])) fail('--verify');
      return;
    }
    const check = safezoneCheck(dir!, doc);
    printCheck(check);
    if (check.exit === 3) die('gates: FAILED at --verify — the check could not run (see above); nothing in the document needs correcting for that', 1);
    if (check.exit !== 0) fail('--verify', check.exit);
  };
  console.log('gates: verify');
  verify();

  // Contrast adds a ground shadow where one brings failing text to AA, and asks nothing. A contrast step
  // that cannot run is reported as what it was and the chain goes on to a deliverable.
  //
  // It reads <run>/final and takes no document argument, so it has nothing to say about a chapter of a
  // longer piece.
  if (!noWcag) {
    if (doc !== 'final') {
      console.log(`gates: wcag skipped — it reads ${dir}/final and this run gates ${doc}; check contrast on the assembled film`);
    } else {
      console.log('gates: wcag');
      // Read back rather than trusted from the step's own report: a step that died half way through
      // promoting reports nothing, and its document still has to pass before it is recorded.
      const passed = readFileSync(tpl);
      try {
        const d = runWcagPass(dir!, { autoShadow: true });
        console.log(`[wcag-pass] status: ${d.status}${d.promoted ? ' (final/template.wv is now the remediated template; draft preserved)' : ''}`);
        for (const n of d.notes) console.log(`[wcag-pass] ${n}`);
      } catch (e) {
        console.error(`gates: the contrast step did not complete — ${e instanceof Error ? e.message : String(e)}`);
        console.error('gates: contrast is UNREMEDIATED for this render. Say so at delivery');
      }
      if (!readFileSync(tpl).equals(passed)) {
        // A shadow extends the ink outward, which is the quantity the walk above measured, and the
        // document about to be recorded is no longer the one that passed it. These two fail the chain
        // like their first run did, which is why they sit outside the catch above.
        console.log('gates: lint + verify, again, on the document the contrast step wrote');
        if (!runContentGate('pipeline/scripts/lint-template', [tpl, '--engine-doc', engineDocPath()])) fail('lint');
        verify();
      }
    }
  }

  console.log('gates: record');
  if (!runEngine([final, '--progress-output', '--record', join(final, 'out.silent.mp4')])) fail('--record');

  if (!noMux) {
    console.log('gates: mux');
    const muxArgs = [dir!, '--doc', doc, ...(audio ? ['--audio', audio] : []), ...(noLoudnorm ? ['--no-loudnorm'] : [])];
    if (muxAudio(muxArgs) !== 0) fail('mux');
  } else {
    copyFileSync(join(final, 'out.silent.mp4'), join(final, 'out.mp4'));
    console.log('gates: no soundtrack to restore — silent render copied to out.mp4');
  }

  console.log(`gates: clean → ${join(final, 'out.mp4')}`);
  return ledger;
}
