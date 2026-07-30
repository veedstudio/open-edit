// Compiled recipe — hook-084 (0-00-06-16) · glowing serif movie-poster credits (9:16, authored at
// 736×1312 @25fps; prefab 882×1568 pre-rescaled ×0.8345). Source sheet: ./recipe.md. Fixed editorial
// chrome (Bodoni kickers, EB Garamond tagline + credit rows, JBO + Apple-pictogram tv+ logos) revealed
// once at clip start in 3-char clusters; the spoken beat is a monumental Bodoni Moda glow title whose
// lines land scattered (odd lines left 53, even 157) in 2-char pair-clusters on the real word timings,
// bracketed by two fixed EB Garamond asides riding the cue. gIn is opacity-ONLY (the prefab ramps
// filter:blur(6px→0) — the engine DROPS animated blur ramps, opacity carries the reveal); every glow
// carries one dark grounding text-shadow layer because footage replaces the prefab's flat bg. The
// 10-role system: 9 dressing roles are fixed; role 10 (title-cluster) is the only transcript-driven
// role — every spoken char, no exceptions. Emphasis is STRUCTURAL (the beat IS the title).
// NOT automated (report-only, the runner only demotes named ids): the sheet's never-visible/occluded
// checks stay manual per the verify loop.
import {
  type LadderRow, type RecipeGenerator, type RecipeOptions, type RunMeta, type Unit,
  charsOf, demotionFor, escapeHtml, manifestFor, pickRow, pxScaler, scaleFor, toUnits, winMsFor,
} from '../../../pipeline/recipes/lib.ts';
import type { WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

const LADDER: LadderRow[] = [
  { cls: 's125', maxC: 5 },
  { cls: 's112', maxC: 6 },
  { cls: 's100', maxC: 6 },
  { cls: 's88', maxC: 7 },
  { cls: 's76', maxC: 8 },
  { cls: 's66', maxC: 10 },
  { cls: 's58', maxC: 11 },
  { cls: 's51', maxC: 13 },
  { cls: 's45', maxC: 14 },
  { cls: 's40', maxC: 16 },
  { cls: 's36', maxC: 18 },
  { cls: 's32', maxC: Infinity },
];
const FS: Record<string, number> = {
  s125: 125, s112: 112, s100: 100, s88: 88, s76: 76, s66: 66,
  s58: 58, s51: 51, s45: 45, s40: 40, s36: 36, s32: 32,
};
// Curation 2026-07-21 recomposition: title stack + note-b dropped to the lower half (T0 720), credits
// pushed toward the bottom (992+), tagline raised to 276, AN ORIGINAL note cut, title lines CENTERED.
// height caps: the first ladder row a beat with L lines may use (keeps stack + note-b above the credits
// chrome — the window is now 992−720 = 272px, hence the tighter caps)
const L_CAP_ROW: Record<number, number> = { 1: 0, 2: 2, 3: 5, 4: 7 };
const T0 = 720; // title stack top
const ADV = 1.1133; // line advance ×fs (prefab 167px @ fs150·0.8345)
const INK_H = 1.17; // measured Bodoni ink bottom ×fs (incl old-style digit descenders)
const CENTER_FACTOR = 498 / 640; // ladder maxC is calibrated to the 498px budget; centered lines get 640px
const K_TITLE = 130;
const K_TITLE_TIGHT = 60;
const TITLE_IN_MS = 300;
const DUR_FLOOR_MS = 200;
// v3: IN REAL TIME is STATIC bottom chrome now (one reveal at clip start, kicker styling) — the old
// per-beat aside re-revealed the same words every beat, which read as a glitch.

// ---- the 10-role system (reversed from the prefab) ----
export type Role084 =
  | 'kicker-left' | 'kicker-right' | 'tagline' | 'credit' | 'footer' | 'title-cluster';

// Chrome reveal wave base ms (one-time at clip start; prefab order, prefab cluster cadences). credit is
// per-index (creditBaseMs084); note-a/b are per-beat (cueDelayMs + offset); title-cluster rides the
// verbatim word delays — null here.
export const ROLE_BASE_MS_084: Record<Role084, number | null> = {
  'kicker-left': 0, 'kicker-right': 150, tagline: 300, credit: null,
  footer: 1500, 'title-cluster': null,
};

export function creditBaseMs084(index: number): number {
  return 450 + 120 * index;
}

// Role assignment is total and deterministic by node id — spoken content only ever lands in b{N}l{k}.
export function roleFor084(nodeId: string): Role084 {
  if (nodeId === 'kickl') return 'kicker-left';
  if (nodeId === 'kickr') return 'kicker-right';
  if (nodeId === 'tagline') return 'tagline';
  if (/^cr\d$/.test(nodeId)) return 'credit';
  if (nodeId === 'footer') return 'footer';
  if (/^b\d+l\d$/.test(nodeId)) return 'title-cluster';
  throw new Error(`hook-084 (0-00-06-16): no role for node id "${nodeId}"`);
}

// ---- title assembly ----
export function lineCount084(n: number): number {
  if (n <= 2) return 1;
  if (n <= 6) return 2;
  if (n <= 11) return 3;
  return 4;
}

// Closed-form L-way split: cut k at the unit boundary whose cumulative rendered chars is closest to
// k·total/L (tie → earlier); each cut leaves ≥1 unit per remaining line. Never reorder.
export function splitLines084(units: Unit[], L: number): Unit[][] {
  const n = units.length;
  const Leff = Math.max(1, Math.min(L, n));
  if (Leff === 1) return [units];
  const total = charsOf(units);
  const cuts: number[] = [];
  let prev = 0;
  for (let k = 1; k < Leff; k++) {
    const target = (k * total) / Leff;
    let best = prev + 1;
    let bestD = Infinity;
    for (let c = prev + 1; c <= n - (Leff - k); c++) {
      const d = Math.abs(charsOf(units.slice(0, c)) - target);
      if (d < bestD) { best = c; bestD = d; } // strict < : earlier boundary wins ties
    }
    cuts.push(best);
    prev = best;
  }
  const lines: Unit[][] = [];
  let s = 0;
  for (const c of cuts) { lines.push(units.slice(s, c)); s = c; }
  lines.push(units.slice(s));
  return lines;
}

// Effective char count vs the ladder's 498px calibration: every centered line has the 640px budget.
export function ceff084(lines: Unit[][]): number {
  return Math.max(...lines.map((ln) => charsOf(ln) * CENTER_FACTOR));
}

// Size row: first row fitting Ceff at or below the height cap for L lines, then demotion steps down.
export function rowFor084(lines: Unit[][], demoteRows = 0): LadderRow {
  return pickRow(LADDER.slice(L_CAP_ROW[lines.length] ?? 0), ceff084(lines), demoteRows);
}

// 2-char pair-clusters for title spans (odd char count → last cluster is 1 char); 3-char for dressing.
export function clustersOf084(text: string, size: number): string[] {
  const chars = [...text];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

// Pair-cluster stagger, ONE guard per span: K=130 (the prefab's title cadence) unless the run + entrance
// would overrun the gate, then K=60 (if 60 still overruns, keep 60 — the mid-reveal cut is accepted).
export function clusterK084(delayMs: number, clusterCount: number, gateEndMs: number): number {
  return delayMs + (clusterCount - 1) * K_TITLE + TITLE_IN_MS > gateEndMs ? K_TITLE_TIGHT : K_TITLE;
}

// End-of-beat compression: a cluster whose entrance crosses the gate gets a shortened inline duration
// so it lands before the cut; null = the skeleton's duration applies.
export function compressDurMs084(delayMs: number, inMs: number, gateEndMs: number): number | null {
  return delayMs + inMs > gateEndMs ? Math.max(gateEndMs - delayMs, DUR_FLOOR_MS) : null;
}


function clusterSpan(text: string, delayMs: number, big: boolean, gap: boolean, durMs: number | null): string {
  const cls = `g${big ? ' big' : ''}${gap ? ' gp' : ''}`;
  let style = `animation-delay:${delayMs}ms`;
  if (durMs !== null) style += `; animation-duration:${durMs}ms`;
  return `<span class="${cls}" style="${style}">${escapeHtml(text)}${gap ? '&#160;' : ''}</span>`;
}

// One .g.big span per 2-char cluster; a glued unit is one continuous cluster run (each span keeps its
// verbatim delay base). The unit's last cluster carries the word gap (gp + &#160;) unless line-final.
function unitClusterSpans(unit: Unit, gateEndMs: number, lineFinal: boolean): string {
  const out: string[] = [];
  unit.spans.forEach((span, si) => {
    const clusters = clustersOf084(span.text, 2);
    const K = clusterK084(span.delayMs, clusters.length, gateEndMs);
    clusters.forEach((cl, j) => {
      const gap = !lineFinal && si === unit.spans.length - 1 && j === clusters.length - 1;
      const d = span.delayMs + j * K;
      out.push(clusterSpan(cl, d, true, gap, compressDurMs084(d, TITLE_IN_MS, gateEndMs)));
    });
  });
  return out.join('');
}

function cueHtml(p: (n: number) => number, beatN: number, cueDelayMs: number, winMs: number, units: Unit[], demote: Record<string, number>): string {
  const gateEnd = cueDelayMs + winMs;
  const lines = splitLines084(units, lineCount084(units.length));
  const row = rowFor084(lines, demotionFor(
    demote, `b${beatN}l1`, `b${beatN}l2`, `b${beatN}l3`, `b${beatN}l4`,
  ));
  const fs = FS[row.cls];
  const body = lines.map((ln, k) => {
    const id = `b${beatN}l${k + 1}`;
    const top = p(T0 + k * ADV * fs);
    const spans = ln.map((u, i) => unitClusterSpans(u, gateEnd, i === ln.length - 1)).join('');
    return `  <div class="tt glow ${row.cls}" id="${id}" data-node-id="${id}" data-node-role="text" style="top:${top}px">${spans}</div>`;
  }).join('\n');
  return `<div class="cue" id="cue${beatN}" data-node-id="cue${beatN}"
     style="z-index:${10 + beatN}; animation-delay:${cueDelayMs}ms; animation-duration:${winMs}ms">
${body}
</div>`;
}

// ---- chrome (fixed dressing; 3-char clusters, prefab cadences) ----
// v3: the bottom logos are GONE — a deterministic recipe cannot know whose logo to show. In their
// place: static IN REAL TIME, styled exactly like the top kickers, revealed once at clip start.

function chromeClusters(text: string, baseMs: number, K: number): string {
  return clustersOf084(text, 3).map((cl, j) => clusterSpan(cl, baseMs + j * K, false, false, null)).join('');
}

interface Credit { role: string; name: string; }
const CREDIT_ROWS: Credit[][] = [
  [{ role: 'Directed By', name: 'THE ALGORITHM' }, { role: 'Camera By', name: 'A TRIPOD' }, { role: 'Audio By', name: 'THE MIC' }],
  [{ role: 'Script By', name: 'NO ONE' }, { role: 'Editor By', name: 'CAFFEINE' }, { role: 'Art Director By', name: 'VIBES' }],
  [{ role: 'Stylish By', name: 'DEFAULT' }, { role: 'VFX By', name: 'NONE, SORRY' }],
];

function creditHtml(c: Credit, index: number, last: boolean): string {
  const base = creditBaseMs084(index);
  const roleClusters = clustersOf084(c.role, 3);
  const roleSpans = roleClusters.map((cl, j) => clusterSpan(cl, base + j * 32, false, false, null)).join('');
  const nameSpans = clustersOf084(c.name, 3)
    .map((cl, j) => clusterSpan(cl, base + (roleClusters.length + j) * 32, false, false, null)).join('');
  const id = `cr${index + 1}`;
  return `<span class="credit${last ? ' last' : ''}" id="${id}" data-node-id="${id}" data-node-role="text"><span class="role">${roleSpans}</span><span class="name">${nameSpans}</span></span>`;
}

function generate(meta: RunMeta, timings: WordTimings, opts: RecipeOptions = {}) {
  const p = pxScaler(scaleFor(meta, 736, 1312));
  const demote = opts.demote ?? {};

  const cues = timings.beats
    .map((beat, i) => beat.words.length
      ? cueHtml(p, beat.i, beat.cueDelayMs, winMsFor(timings.beats, i, meta.durationSec), toUnits(beat.words), demote)
      : '')
    .filter(Boolean);

  let creditIndex = 0;
  const crows = CREDIT_ROWS.map((row, r) => {
    const credits = row.map((c, i) => creditHtml(c, creditIndex++, i === row.length - 1)).join('');
    return `  <div id="crow${r + 1}" class="crow soft-glow">${credits}</div>`;
  }).join('\n');

  const wv = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:wght@400;500;600;700&family=EB+Garamond:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${p(736)}px; height: ${p(1312)}px; background: #000; overflow: hidden; }
  body { position: relative; font-family: 'EB Garamond', serif; color: #fff; }
  .vid { position: absolute; inset: 0; width: ${p(736)}px; height: ${p(1312)}px; object-fit: cover; z-index: 0; }

  /* white halo glow (prefab) + one dark grounding layer (footage replaces the prefab's flat bg) */
  .glow { text-shadow: 0 0 ${p(12)}px rgba(255,255,255,.75), 0 0 ${p(23)}px rgba(255,255,255,.5), 0 ${p(2)}px ${p(10)}px rgba(0,0,0,.65); }
  .soft-glow { text-shadow: 0 0 ${p(7)}px rgba(255,255,255,.6), 0 ${p(1)}px ${p(6)}px rgba(0,0,0,.65); }

  /* char-cluster reveal — opacity ONLY (the prefab's blur ramp is a no-op in-engine) */
  .g { display: inline-block; white-space: pre; opacity: 0;
       animation: gIn .24s cubic-bezier(.2,.7,.3,1) both; }
  .g.big { animation-duration: .3s; }
  @keyframes gIn { 0% { opacity: 0; } 100% { opacity: 1; } }
  .gp { margin-right: 0.32em; }

  /* ---- chrome: fixed dressing, one reveal wave at clip start, persistent ---- */
  #kickl { position: absolute; z-index: 2; left: ${p(58)}px; top: ${p(67)}px; font-family: 'Bodoni Moda', serif; font-weight: 700; font-size: ${p(17)}px; letter-spacing: ${p(1)}px; }
  #kickr { position: absolute; z-index: 2; right: ${p(52)}px; top: ${p(67)}px; font-family: 'Bodoni Moda', serif; font-weight: 600; font-size: ${p(15)}px; letter-spacing: ${p(1)}px; }
  #tagline { position: absolute; z-index: 2; left: 0; top: ${p(206)}px; width: ${p(736)}px; text-align: center; font-weight: 600; font-size: ${p(23)}px; letter-spacing: ${p(3)}px; } /* v3: a third closer to the kickers */
  .crow { position: absolute; z-index: 2; left: 0; width: ${p(736)}px; text-align: center; font-size: ${p(14)}px; }
  #crow1 { top: ${p(992)}px; } #crow2 { top: ${p(1019)}px; } #crow3 { top: ${p(1046)}px; }
  .credit { display: inline-block; white-space: nowrap; margin-right: ${p(38)}px; }
  .credit.last { margin-right: 0; }
  .credit .role { font-weight: 400; opacity: 0.92; }
  .credit .name { font-weight: 700; letter-spacing: 0.5px; margin-left: ${p(5)}px; }
  /* bottom footer — kicker styling (Bodoni, same weight/tracking as THE INTERNET / PRESENTS) */
  #footer { position: absolute; z-index: 2; left: 0; top: ${p(1200)}px; width: ${p(736)}px; text-align: center;
            font-family: 'Bodoni Moda', serif; font-weight: 700; font-size: ${p(17)}px; letter-spacing: ${p(1)}px; }

  /* ---- beat gate — the one safe reveal recipe; z-index + delay + duration come inline per cue ---- */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position: absolute; inset: 0; opacity: 0;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* title line — absolute full-width block, ink centered by text-align (curation 2026-07-21) */
  .tt { position: absolute; z-index: 2; left: 0; width: ${p(736)}px; text-align: center;
        white-space: nowrap; font-family: 'Bodoni Moda', serif;
        font-weight: 500; line-height: 1.3333; letter-spacing: ${p(1)}px; }
  /* size ladder (picked by the sheet's rule only — width and height budgets baked in) */
  .s125{font-size:${p(125)}px} .s112{font-size:${p(112)}px} .s100{font-size:${p(100)}px} .s88{font-size:${p(88)}px}
  .s76{font-size:${p(76)}px} .s66{font-size:${p(66)}px} .s58{font-size:${p(58)}px} .s51{font-size:${p(51)}px}
  .s45{font-size:${p(45)}px} .s40{font-size:${p(40)}px} .s36{font-size:${p(36)}px} .s32{font-size:${p(32)}px}

</style>
</head>
<body>
  <video class="vid" src="${meta.videoPath}" muted></video>

  <div id="kickl" class="glow" data-node-id="kickl" data-node-role="text">${chromeClusters('THE INTERNET', ROLE_BASE_MS_084['kicker-left']!, 70)}</div>
  <div id="kickr" class="glow" data-node-id="kickr" data-node-role="text">${chromeClusters('PRESENTS', ROLE_BASE_MS_084['kicker-right']!, 70)}</div>

  <div id="tagline" class="glow" data-node-id="tagline" data-node-role="text">${chromeClusters('A CREATOR! JOINT', ROLE_BASE_MS_084.tagline!, 65)}</div>

${crows}

  <div id="footer" class="glow" data-node-id="footer" data-node-role="text">${chromeClusters('IN REAL TIME', ROLE_BASE_MS_084.footer!, 70)}</div>

${cues.join('\n')}
</body>
</html>
`;
  return { wv, manifest: manifestFor(meta) };
}

const recipe: RecipeGenerator = { refId: 'hook-084 (0-00-06-16)', generate };
export default recipe;
