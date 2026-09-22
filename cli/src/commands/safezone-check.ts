// The safe-zone verdict, triaged by arithmetic instead of by the author.
//
//   openedit safezone-check <run-dir> [--doc final] [--json]
//
// WHY THIS EXISTS. The engine reports how deep a word sits outside the safe area but not on WHICH SIDE,
// and the triage that followed (transient, minor, major, the exact nudge) was sixty lines of prose an
// author executed by hand on every failure. Both are arithmetic. The side comes from asking the engine
// the same question with the margin cut into four keep-out bands: one walk, the same numbers, and each
// violation now names its edge. Everything after that is a formula, so it is computed here and the
// author receives one line per element saying what to move, which way and by how many pixels.
//
// RUN OUTSIDE ANY SANDBOX: the walk needs a real desktop session, like every engine invocation.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { engineBinPath, engineEnv, workspaceRoot } from '../config.ts';
import { safeZone } from '../safe-zone.ts';

export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Verdict = 'chrome' | 'transient' | 'minor' | 'major' | 'warn';

export interface Violation {
  element: string; zone: string; mode?: string; severity?: string;
  ink_intruding_fraction: number; max_intrusion_px: number;
  longest_run_frames?: number; offending_frames?: number; alpha_at_max_intrusion?: number;
  frame?: number; window?: { from: number; to: number };
}
export interface Triaged {
  element: string; side: Side | null; verdict: Verdict;
  depthPx: number; inkOut: number;
  /** Longest contiguous run outside the zone, in frames; null when the report carries no way to tell. */
  heldFrames: number | null;
  visible: boolean;
  worstFrame: number | null; window: [number, number] | null;
  /** What to do, in one line. Empty for a verdict that asks for nothing. */
  action: string;
}

const SIDES: Side[] = ['top', 'bottom', 'left', 'right'];
const INWARD: Record<Side, string> = { top: 'down', bottom: 'up', left: 'right', right: 'left' };
const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/** The generic preset for this canvas as four keep-out margins, so a violation names its edge. */
export function edgeZones(w: number, h: number): { zones: { name: string; rect: { x: number; y: number; w: number; h: number }; mode: 'keep-out'; severity: 'error' }[] } {
  const z = safeZone(w, h);
  const pct = (v: number) => Math.round(v * 10000) / 100;
  const band = (name: Side, x: number, y: number, bw: number, bh: number) =>
    ({ name: `edge-${name}`, rect: { x: pct(x), y: pct(y), w: pct(bw), h: pct(bh) }, mode: 'keep-out' as const, severity: 'error' as const });
  return { zones: [
    band('top', 0, 0, 1, z.y0), band('bottom', 0, z.y1, 1, 1 - z.y1),
    band('left', 0, 0, z.x0, 1), band('right', z.x1, 0, 1 - z.x1, 1),
  ] };
}

/**
 * Transient, minor or major, from the numbers and never by eye.
 *
 * TRANSIENT: out for under `hold` (a quarter of a second) with at most 5% of its ink: a word crossing
 * the margin on its way in, however deep the crossing. MINOR: held, but no deeper than `edge` (2% of
 * the canvas's shorter side) and with at most a quarter of its ink out. MAJOR: anything else — the
 * block was placed there, and a nudge will not bring it back.
 */
export function triage(violations: Violation[], canvasW: number, canvasH: number, fps: number): Triaged[] {
  const edge = Math.min(canvasW, canvasH) * 0.02;
  const hold = Math.round(fps * 0.25);
  const z = safeZone(canvasW, canvasH);
  const out = violations.map((v): Triaged => {
    const side = SIDES.find((s) => v.zone === `edge-${s}`) ?? null;
    // An engine that predates the run counters reports only the window; its length overstates two
    // flashes far apart and never understates a held line, so it errs toward the fix.
    const held = v.longest_run_frames ?? (v.window ? Math.round((v.window.to - v.window.from) * fps) : null);
    const depth = v.max_intrusion_px, frac = v.ink_intruding_fraction;
    const id = v.element.startsWith('"') ? v.element : `#${v.element.replace(/^#/, '')}`;
    let verdict: Verdict;
    if (/-chrome"?$/.test(v.element)) verdict = 'chrome';
    else if (v.severity === 'warn') verdict = 'warn';
    else if (held !== null && held < hold && frac <= 0.05) verdict = 'transient';
    else if (depth <= edge && frac <= 0.25) verdict = 'minor';
    else verdict = 'major';
    const where = side ? `${side} edge` : `zone ${v.zone}`;
    const move = side ? `move the container that positions it ${INWARD[side]}` : 'move the container that positions it out of the zone the shortest way';
    let action = '';
    if (verdict === 'minor') action = `${move} by ${Math.ceil(depth) + 4}px`;
    if (verdict === 'major') {
      switch (side) {
        case 'bottom': action = `re-place its block inside the ${where}: top = ${Math.round(z.y1 * canvasH)} - block height - 8px`; break;
        case 'top': action = `re-place its block inside the ${where}: top = ${Math.round(z.y0 * canvasH) + 8}px`; break;
        case 'left': action = `re-place its block inside the ${where}: left = ${Math.round(z.x0 * canvasW) + 8}px`; break;
        case 'right': action = `re-place its block inside the ${where}: right = ${Math.round((1 - z.x1) * canvasW) + 8}px`; break;
        default: action = move;
      }
    }
    return {
      element: id, side, verdict, depthPx: Math.round(depth * 10) / 10, inkOut: Math.round(frac * 1000) / 1000,
      heldFrames: held, visible: (v.alpha_at_max_intrusion ?? 1) > 0.5,
      worstFrame: v.frame ?? null, window: v.window ? [Math.round(v.window.from * 100) / 100, Math.round(v.window.to * 100) / 100] : null,
      action,
    };
  });
  // A block wider than the zone fails on both of its sides, and no position fixes that: it steps a rung
  // down the size ladder first, then is placed.
  for (const t of out) {
    if (t.verdict !== 'major' || !t.side) continue;
    if (out.some((o) => o.element === t.element && o.side === OPPOSITE[t.side!] && o.verdict === 'major')) {
      t.action = `wider than the safe area: step its block one rung down the size ladder, then ${t.action}`;
    }
  }
  return out;
}

/**
 * What the walk could say. "Could not run" is its own outcome with its own exit code: a caller that
 * reads only "no failures" must never take an unchecked document for a clean one.
 */
export type CheckResult =
  | { ran: false; exit: 2 | 3; reason: string; detail: string[] }
  | { ran: true; exit: 0 | 1; triaged: Triaged[]; otherFails: string[]; score: number | null; cycle: number; overBudget: boolean };

const BUDGET = 2;

/** Consecutive checks of this document that ended with a blocking safe-zone finding. */
export function nextCycle(prior: number, blocking: number): number {
  return blocking > 0 ? prior + 1 : 0;
}

/** Why the engine wrote no report, from what the process itself said. Pure, so every branch is tested. */
export function explainNoReport(r: { error?: string; status: number | null; signal: string | null; stderr: string; knowsRules: boolean }): string {
  const said = r.stderr.trim().split('\n').slice(-3).join(' | ');
  if (r.error) return `the engine could not be started (${r.error}) — install it with \`npx @veedstudio/openedit-cli install-engine\``;
  if (r.signal) return `the engine was killed by ${r.signal}${said ? `: ${said}` : ''}`;
  // What the engine said outranks a guess from its help text, whose wording is not a contract.
  if (said) {
    const old = r.knowsRules ? '' : ' Its --help does not list --verify=<rules> either: if it predates the safe-zone check, update it with `npx @veedstudio/openedit-cli install-engine`';
    return `the engine exited ${r.status} and wrote no report: ${said}. Inside a sandbox it has no desktop session to draw in: run this outside one.${old}`;
  }
  if (!r.knowsRules) return 'the engine wrote no report and its --help does not list --verify=<rules>, so it probably predates the safe-zone check — update it with `npx @veedstudio/openedit-cli install-engine`';
  return `the engine exited ${r.status} and wrote no report. Inside a sandbox it has no desktop session to draw in: run this outside one`;
}

/** `--doc` names a directory under the run. One that climbs out is refused, not normalised. */
export function assertDocInsideRun(doc: string): string {
  if (doc === '' || doc.startsWith('/') || /^[A-Za-z]:/.test(doc) || doc.split(/[\\/]/).includes('..')) {
    throw new Error(`--doc "${doc}" is not a directory under the run: name a subdirectory such as final or chapters/act-3`);
  }
  return doc;
}

export function safezoneCheck(runDir: string, doc = 'final'): CheckResult {
  const final = join(runDir, assertDocInsideRun(doc));
  const manifestPath = join(final, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`safezone-check: no ${manifestPath} — the render block is required`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { render: { width: number; height: number; fps: number }; verify?: { safezones?: unknown } };
  const { width, height, fps } = manifest.render;
  const spawnOpts = { encoding: 'utf8' as const, env: engineEnv(), cwd: workspaceRoot(), maxBuffer: 1 << 26 };

  const tmp = mkdtempSync(join(tmpdir(), 'openedit-safezone-'));
  try {
    // A manifest that declares its own zones wins over any flag, so the edge bands are not offered:
    // the verdicts still triage, only without a side.
    const own = manifest.verify?.safezones !== undefined;
    const zonesFile = join(tmp, 'edges.json');
    if (!own) writeFileSync(zonesFile, JSON.stringify(edgeZones(width, height)));
    const report = join(final, 'verify.json');
    rmSync(report, { force: true });
    const res = spawnSync(engineBinPath(), [final, `--verify=bounds,safezones${own ? '' : `:${zonesFile}`}`, '--verify-report', report], spawnOpts);
    const stdout = res.stdout ?? '';
    if (res.status === 2) {
      return { ran: false, exit: 2, reason: 'the engine could not play the document back — a real authoring error, not a safe-zone verdict', detail: `${stdout}\n${res.stderr ?? ''}`.split('\n').filter(Boolean).slice(-20) };
    }
    if (!existsSync(report)) {
      const help = res.error ? '' : spawnSync(engineBinPath(), ['--help'], spawnOpts).stdout ?? '';
      return { ran: false, exit: 3, detail: [], reason: explainNoReport({ error: res.error?.message, status: res.status, signal: res.signal, stderr: res.stderr ?? '', knowsRules: help.includes('--verify[=<rules>]') }) };
    }
    const parsed = JSON.parse(readFileSync(report, 'utf8')) as { violations?: (Violation & { kind?: string })[]; safezones?: { overall_score?: number; ran?: boolean } };
    if (!Array.isArray(parsed.violations) || parsed.safezones?.ran === false) {
      return { ran: false, exit: 3, detail: [], reason: `the engine wrote ${report} without a safe-zone verdict in it (no violations list, or safezones.ran is false)` };
    }
    const triaged = triage(parsed.violations.filter((v) => v.kind === 'safezone'), width, height, fps);
    const otherFails = stdout.split('\n').filter((l) => l.includes('FAIL[') && !l.includes('FAIL[safezone]'));
    // Only a MAJOR blocks. A MINOR is a few pixels over a margin nobody watching will see, and making
    // it a failure bought a correction cycle and a second walk for it on every run that had one.
    const blocking = triaged.filter((t) => t.verdict === 'major').length;

    // The count shapes the MESSAGE and never the verdict. An earlier version let a spent budget pass
    // the check, and the count outlives the document: a re-rolled design inherited it and shipped its
    // first MAJOR unexamined. Delivering as-is is a decision someone states with --no-safezones.
    const ledger = join(final, 'safezone-triage.json');
    let prior = 0;
    try { prior = (JSON.parse(readFileSync(ledger, 'utf8')) as { cycle?: number }).cycle ?? 0; } catch { /* first check of this document */ }
    const cycle = nextCycle(prior, blocking);
    const score = parsed.safezones?.overall_score ?? null;
    writeFileSync(ledger, JSON.stringify({ schema: 1, cycle, canvas: [width, height], fps, score, triaged }, null, 2));
    return { ran: true, exit: otherFails.length || blocking ? 1 : 0, triaged, otherFails, score, cycle, overBudget: cycle > BUDGET };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function printCheck(r: CheckResult): void {
  if (!r.ran) {
    for (const l of r.detail) console.log(l);
    console.log(`safezone-check: NOT CHECKED — ${r.reason}`);
    return;
  }
  for (const l of r.otherFails) console.log(l);
  const order: Verdict[] = ['major', 'minor', 'transient', 'warn', 'chrome'];
  for (const t of [...r.triaged].sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict))) {
    const at = t.window ? ` ${t.window[0]}..${t.window[1]}s` : '';
    const facts = `${t.side ?? 'zone'} ${t.depthPx}px deep, ${(t.inkOut * 100).toFixed(1)}% of ink, held ${t.heldFrames ?? '?'} frames${at}`;
    const tail = t.verdict === 'transient' ? `crosses the margin on entry${t.visible ? ', a visible flick' : ', too faint to see'}: deliver, mention in one clause`
      : t.verdict === 'chrome' ? 'dressing, not the spoken line: never fixed, name it in one clause at delivery'
      : t.verdict === 'warn' ? 'a warn zone: never blocks'
      : t.verdict === 'minor' ? `does not block; if you are touching this line anyway, ${t.action}`
      : t.action;
    console.log(`${t.verdict.toUpperCase()} ${t.element} — ${facts} → ${tail}`);
  }
  const blocking = r.triaged.filter((t) => t.verdict === 'major').length;
  if (blocking && r.overBudget) console.log(`safezone-check: ${blocking} still out after ${BUDGET} correction cycles — STOP correcting. To deliver as it is, re-run the chain with --no-safezones and say in plain terms what sits outside the safe area`);
  else if (blocking) console.log(`safezone-check: ${blocking} to fix (cycle ${r.cycle} of ${BUDGET}) — apply each MAJOR line above to the named element only, resize/recolour/re-time nothing else, then re-run`);
  else if (r.otherFails.length) console.log('safezone-check: the safe zones are clear; the FAIL lines above are the bounds family');
  else console.log(`safezone-check: clean${r.score !== null ? ` (score ${Math.round(r.score)})` : ''}${r.triaged.length ? ' — nothing to fix; mention the lines above at delivery' : ''}`);
}

export const usage = {
  summary: 'Bounds + safe zones in one walk, triaged: each line names the edge and the fix in px',
  positionals: '<run-dir>',
  flags: {
    doc: { type: 'string', value: '<subdir>', help: 'Document under the run to check (default final)' },
    json: { type: 'boolean', help: 'Print the triage as JSON' },
  },
  notes: 'Run outside any sandbox: the walk needs a real desktop session.',
} satisfies Usage;

export function safezoneCheckCommand(argv: string[]): number {
  const { values, positionals } = parseUsage('safezone-check', usage, argv);
  const runDir = positionals[0];
  if (!runDir || positionals.length > 1) { console.error(usageLine('safezone-check', usage)); return 2; }
  const r = safezoneCheck(runDir, values.doc ?? 'final');
  if (values.json) console.log(JSON.stringify(r, null, 2)); else printCheck(r);
  return r.exit;
}
