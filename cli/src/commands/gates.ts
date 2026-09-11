// THE GATE CHAIN, as one command.
//
//   openedit gates <run-dir> [--doc <subdir>] [--audio <file>] [--no-mux] [--no-loudnorm] [--no-probe] [--no-expect] [--no-design] [--no-wcag]
//
// design → lint → --verify → WCAG → --record → probe-qa → mux. Stops at the first failure and names it.
// RUN OUTSIDE ANY SANDBOX: --verify and --record need a real desktop session (the window-server on macOS).
//
// --no-probe   the run has no source footage to diff frames against
// --no-mux     the run has no soundtrack to restore (the silent render is copied to out.mp4, so the
//              deliverable path is the same on every path)
// --no-expect  skip deriving `verify.expect` from the document's own gates. Do not reach for this to
//              make a failure go away: an expect-visible failure means a cue is off screen inside the
//              window the document itself declares, which is a real defect no other gate can see.
// --no-design  the run has no design/system.json — true only of a compiled-recipe run, where the
//              recipe IS the system. An authored run without one is the defect this gate exists for.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentRoot, engineBinPath, engineEnv, workspaceRoot } from '../config.ts';
import { tsxImportUrl } from '../ts-runtime.ts';
import { expectWindows } from './expect-windows.ts';
import { probeQaCommand } from './probe-qa.ts';
import { muxAudio } from './mux-audio.ts';
import { wcagPass } from './wcag-pass.ts';

const usage = 'usage: openedit gates <run-dir> [--doc <subdir>] [--audio <file>] [--no-mux] [--no-loudnorm] [--no-probe] [--no-expect] [--no-design] [--no-wcag]';

class GateExit extends Error {
  constructor(readonly code: number, msg = '') { super(msg); }
}
const die = (msg: string, code: number): never => { throw new GateExit(code, msg); };
const fail = (name: string): never =>
  die(`gates: FAILED at ${name} — fix that, then re-run the gate chain`, 1);

export function gates(argv: string[]): number {
  try {
    run(argv);
    return 0;
  } catch (error) {
    if (error instanceof GateExit) {
      if (error.message) console.error(error.message);
      return error.code;
    }
    throw error;
  }
}

// The design and lint gates are CONTENT: they enforce the design substrate's own rules (the design
// system, the engine-limit lints the substrate is written against), co-versioned with the recipes
// they govern. A published install carries them compiled, so they run as plain node; a checkout
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

function run(argv: string[]): void {
  const [dir, ...rest] = argv;
  if (!dir) die(usage, 2);

  let noLoudnorm = false;

  let noMux = false;
  let noProbe = false;
  let noExpect = false;
  let noDesign = false;
  let noWcag = false;
  // Which document under the run this call gates. A captioned clip has one; a film has one per
  // chapter, and hardcoding `final` was why a seven-chapter run found no route through here.
  let doc = 'final';
  // Whether --doc was actually GIVEN, which is a different question from which document is gated. The
  // default is `final`, so passing it on unconditionally told design-gate every run was one chapter of
  // a longer piece — and the declared-but-unused check, which only fires on a whole run, never ran at
  // all through this chain.
  let docGiven = false;
  // A built soundtrack rather than the source clip's track — a film has one, a captioned clip does not.
  let audio = '';
  while (rest.length > 0) {
    const flag = rest.shift();
    switch (flag) {
      // `--doc final` is the default written out, not a request to gate one chapter of many.
      case '--doc': {
        const value = rest.shift();
        if (!value) die('--doc needs a subdirectory', 2);
        doc = value!;
        if (doc !== 'final') docGiven = true;
        break;
      }
      case '--audio': {
        const value = rest.shift();
        if (!value) die('--audio needs a file', 2);
        audio = value!;
        break;
      }
      case '--no-mux': noMux = true; break;
      case '--no-loudnorm': noLoudnorm = true; break;
      case '--no-probe': noProbe = true; break;
      case '--no-expect': noExpect = true; break;
      case '--no-design': noDesign = true; break;
      case '--no-wcag': noWcag = true; break;
      default:
        die(`gates: unknown flag ${flag}`, 2);
    }
  }

  // A flag that cannot take effect is worse than one that is refused, and the complaint belongs here:
  // downstream it would print only after design, lint, verify, record and probe-qa had already run.
  if (noMux && noLoudnorm) console.warn('gates: --no-loudnorm has no effect with --no-mux — nothing is muxed');

  const final = join(dir!, doc);
  const tpl = join(final, 'template.wv');

  if (!existsSync(tpl)) die(`gates: no ${tpl} — author the document first`, 2);
  if (!existsSync(join(final, 'manifest.json'))) {
    die(`gates: no ${join(final, 'manifest.json')} — the render block is required`, 2);
  }

  if (!noDesign) {
    console.log('gates: design');
    const args = docGiven ? [dir!, '--doc', doc] : [dir!];
    if (!runContentGate('pipeline/scripts/design-gate', args)) fail('design');
  }

  console.log('gates: lint');
  if (!runContentGate('pipeline/scripts/lint-template', [tpl])) fail('lint');

  // Derive the timing assertions from the document's own gates, unless the manifest already carries a
  // hand-written set. Without them --verify only checks what IS drawn; with them it also checks WHEN.
  // `--write` stamps what it derived, so a re-run can replace its own work and leave a hand-written block
  // alone. Without the stamp the guard saw any `verify` block as authored and every later run gated the
  // document against the timings of an earlier one.
  const manifest = readFileSync(join(final, 'manifest.json'), 'utf8');
  if (!noExpect && (!manifest.includes('"verify"') || manifest.includes('"derivedBy"'))) {
    if (expectWindows([dir!, '--doc', doc, '--write'], { quiet: true }) !== 0) fail('expect-windows');
  }

  console.log('gates: verify');
  if (!runEngine([final, '--verify'])) fail('--verify');

  // Contrast is a REPORT, not a verdict. wcag-pass exits 1 only when the engine is missing or below the
  // version floor that carries the analyzer, or when the pass itself crashes,
  // and its own documentation calls that an environment problem rather than a design failure — so it is
  // said out loud and the run continues to a deliverable rather than dying without one.
  //
  // It reads <run>/final and takes no document argument, so it has nothing to say about a chapter of a
  // longer piece. Running it anyway would either abort on a directory that is not there or, worse, report
  // on a document this invocation never touched.
  if (!noWcag) {
    if (doc !== 'final') {
      console.log(`gates: wcag skipped — it reads ${dir}/final and this run gates ${doc}; check contrast on the assembled film`);
    } else {
      console.log('gates: wcag');
      if (wcagPass(['--run', dir!]) !== 0) {
        console.error('gates: wcag could not run (engine missing, below the version floor, or crashed) — contrast is UNCHECKED for this render');
      }
    }
  }

  console.log('gates: record');
  if (!runEngine([final, '--progress-output', '--record', join(final, 'out.silent.mp4')])) fail('--record');

  if (!noProbe) {
    console.log('gates: probe-qa');
    if (probeQaCommand([dir!, '--doc', doc]) !== 0) fail('probe-qa');
  } else {
    console.log('gates: probe-qa skipped (no source footage to diff against)');
  }

  if (!noMux) {
    console.log('gates: mux');
    const muxArgs = [dir!, '--doc', doc, ...(audio ? ['--audio', audio] : []), ...(noLoudnorm ? ['--no-loudnorm'] : [])];
    if (muxAudio(muxArgs) !== 0) fail('mux');
  } else {
    copyFileSync(join(final, 'out.silent.mp4'), join(final, 'out.mp4'));
    console.log('gates: no soundtrack to restore — silent render copied to out.mp4');
  }

  console.log(`gates: clean → ${join(final, 'out.mp4')}`);
}
