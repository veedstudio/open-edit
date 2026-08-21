// THE GATE CHAIN, as one command.
//
// `generate-recipe.ts` already drives this for a compiled recipe. Every other path — the inline
// creative pass, a remix, a run with no footage — retyped the five gates below into every brief. All
// 52 agent briefs of the launch session carried them by hand, which is 52 chances to drop the probe,
// reorder the record, or forget that the engine needs a real desktop session.
//
//   node --import tsx pipeline/scripts/gates.ts <run-dir> [--doc <subdir>] [--audio <file>] [--no-mux] [--no-probe] [--no-expect] [--no-design] [--no-wcag]
//   (gates.sh is the POSIX shim onto this file)
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
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VEED_ENGINE_BIN } from '../../config.ts';

const usage = 'usage: gates.ts <run-dir> [--doc <subdir>] [--audio <file>] [--no-mux] [--no-probe] [--no-expect] [--no-design] [--no-wcag]';
const [dir, ...rest] = process.argv.slice(2);
if (!dir) {
  console.error(usage);
  process.exit(2);
}

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
      if (!value) { console.error('--doc needs a subdirectory'); process.exit(2); }
      doc = value;
      if (doc !== 'final') docGiven = true;
      break;
    }
    case '--audio': {
      const value = rest.shift();
      if (!value) { console.error('--audio needs a file'); process.exit(2); }
      audio = value;
      break;
    }
    case '--no-mux': noMux = true; break;
    case '--no-probe': noProbe = true; break;
    case '--no-expect': noExpect = true; break;
    case '--no-design': noDesign = true; break;
    case '--no-wcag': noWcag = true; break;
    default:
      console.error(`gates: unknown flag ${flag}`);
      process.exit(2);
  }
}

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const final = join(dir, doc);
const tpl = join(final, 'template.wv');

if (!existsSync(tpl)) {
  console.error(`gates: no ${tpl} — author the document first`);
  process.exit(2);
}
if (!existsSync(join(final, 'manifest.json'))) {
  console.error(`gates: no ${join(final, 'manifest.json')} — the render block is required`);
  process.exit(2);
}

const fail = (name: string): never => {
  console.error(`gates: FAILED at ${name} — fix that, then re-run the gate chain`);
  process.exit(1);
};

const runTsx = (script: string, args: string[], opts: { quietStdout?: boolean } = {}) =>
  spawnSync(process.execPath, ['--import', 'tsx', join(root, script), ...args], {
    stdio: ['inherit', opts.quietStdout ? 'ignore' : 'inherit', 'inherit'],
  }).status === 0;
const runEngine = (args: string[]) =>
  spawnSync(VEED_ENGINE_BIN, args, { stdio: 'inherit' }).status === 0;

if (!noDesign) {
  console.log('gates: design');
  const args = docGiven ? [dir, '--doc', doc] : [dir];
  if (!runTsx('pipeline/scripts/design-gate.ts', args)) fail('design');
}

console.log('gates: lint');
if (!runTsx('pipeline/scripts/lint-template.ts', [tpl])) fail('lint');

// Derive the timing assertions from the document's own gates, unless the manifest already carries a
// hand-written set. Without them --verify only checks what IS drawn; with them it also checks WHEN.
// `--write` stamps what it derived, so a re-run can replace its own work and leave a hand-written block
// alone. Without the stamp the guard saw any `verify` block as authored and every later run gated the
// document against the timings of an earlier one.
const manifest = readFileSync(join(final, 'manifest.json'), 'utf8');
if (!noExpect && (!manifest.includes('"verify"') || manifest.includes('"derivedBy"'))) {
  if (!runTsx('pipeline/scripts/expect-windows.ts', [dir, '--doc', doc, '--write'], { quietStdout: true })) fail('expect-windows');
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
    if (!runTsx('pipeline/scripts/wcag-pass.ts', ['--run', dir])) {
      console.error('gates: wcag could not run (engine missing, below the version floor, or crashed) — contrast is UNCHECKED for this render');
    }
  }
}

console.log('gates: record');
if (!runEngine([final, '--progress-output', '--record', join(final, 'out.silent.mp4')])) fail('--record');

if (!noProbe) {
  console.log('gates: probe-qa');
  if (!runTsx('pipeline/scripts/probe-qa.ts', [dir, '--doc', doc])) fail('probe-qa');
} else {
  console.log('gates: probe-qa skipped (no source footage to diff against)');
}

if (!noMux) {
  console.log('gates: mux');
  const muxArgs = [dir, '--doc', doc, ...(audio ? ['--audio', audio] : [])];
  if (!runTsx('pipeline/scripts/mux-audio.ts', muxArgs)) fail('mux');
} else {
  copyFileSync(join(final, 'out.silent.mp4'), join(final, 'out.mp4'));
  console.log('gates: no soundtrack to restore — silent render copied to out.mp4');
}

console.log(`gates: clean → ${join(final, 'out.mp4')}`);
