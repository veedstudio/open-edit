// Probe-frame QA — the mechanical eye that `--verify` doesn't have. Verify replays the draw list
// (bounds/occlusion); it cannot see "no caption on screen mid-beat" (dead-air) or "white text on a
// white mug" (low contrast). This tool samples frames at each beat's MID and TAIL (end − 120ms),
// diffs the RENDER against the SOURCE at the same timestamp (the diff mask ≈ the painted overlay ink),
// and checks: ink-present (mid-beat must show a caption) + WCAG-ish contrast of the ink against its
// immediate surroundings. Verdict JSON + exit code; run by generate-recipe.ts as the last gate after
// the record.
//
// Calibration notes: exit-fade tails read as low-opacity captions in
// ±120ms probes BY DESIGN → tail probes only WARN; thresholds are conservative-lenient v1, tune on
// known-good sheets. Double-print detection is NOT implemented (needs cluster analysis) — sheet rule.
//   node --import tsx pipeline/scripts/probe-qa.ts <runDir> [--json]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FFMPEG } from '../../config.ts';

// Probes are compared on a small fixed grayscale grid — enough to see captions, cheap to extract.
export const GRID_W = 90;
export const GRID_H = 160; // portrait; landscape uses 160x90 (set per meta)
const DIFF_THRESHOLD = 24;   // |render - source| above this = overlay ink
const INK_MIN_PCT = 0.3;     // a visible caption paints well above this fraction of the frame (%)
const CONTRAST_FAIL = 2.0;   // below = unreadable against its own surroundings
const CONTRAST_WARN = 3.5;   // WCAG large-text is 3.0; captions are large — warn band above fail

export interface ProbeStats { inkPct: number; contrast: number | null }
export interface ProbeResult {
  beat: number; probe: 'mid' | 'tail'; tSec: number;
  inkPct: number; contrast: number | null;
  verdict: 'pass' | 'warn' | 'fail'; notes: string[];
}

// diff mask + ink fraction + text-vs-surroundings contrast over two same-size grayscale buffers.
export function probeStats(render: Uint8Array, source: Uint8Array, w: number, h: number): ProbeStats {
  const n = Math.min(render.length, source.length, w * h);
  const mask = new Uint8Array(n);
  let ink = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(render[i] - source[i]) > DIFF_THRESHOLD) { mask[i] = 1; ink++; }
  }
  const inkPct = (ink / n) * 100;
  if (ink === 0) return { inkPct, contrast: null };

  // Two readability signals, take the BEST — text is readable if it separates from EITHER:
  // (a) RING contrast: mask average vs the 2px ring around it (pure text sitting on footage);
  // (b) INNER contrast: the mask's bright half vs dark half (card devices — the mask covers card +
  //     text, so the average washes out, but the internal split captures text-on-card separation).
  let textSum = 0, ringSum = 0, ringN = 0;
  for (let i = 0; i < n; i++) {
    if (mask[i]) { textSum += render[i]; continue; }
    const x = i % w, y = (i / w) | 0;
    let nearInk = false;
    for (let dy = -2; dy <= 2 && !nearInk; dy++) {
      for (let dx = -2; dx <= 2 && !nearInk; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < w && yy >= 0 && yy < h && mask[yy * w + xx]) nearInk = true;
      }
    }
    if (nearInk) { ringSum += render[i]; ringN++; }
  }
  const lum = (v: number) => Math.pow(v / 255, 2.2); // gamma-approx relative luminance
  const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const meanText = textSum / ink;
  const ringContrast = ratio(lum(meanText), lum(ringN ? ringSum / ringN : 0));
  // Inner split by PERCENTILE, not mean: on an opaque-card design the mask is dominated by the card,
  // so a mean split washes small text into the card class (hook-072 false-FAIL). Top decile ≈ the
  // text ink, bottom half ≈ the fill it sits on.
  const vals: number[] = [];
  for (let i = 0; i < n; i++) if (mask[i]) vals.push(render[i]);
  vals.sort((a, b) => a - b);
  const meanOf = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const topDecile = vals.slice(Math.floor(vals.length * 0.9));
  const bottomHalf = vals.slice(0, Math.max(1, Math.floor(vals.length * 0.5)));
  const innerContrast = topDecile.length && bottomHalf.length
    ? ratio(lum(meanOf(topDecile)), lum(meanOf(bottomHalf)))
    : 1;
  const contrast = Math.max(ringContrast, innerContrast);
  return { inkPct, contrast: Math.round(contrast * 100) / 100 };
}

export function judge(probe: 'mid' | 'tail', s: ProbeStats): { verdict: 'pass' | 'warn' | 'fail'; notes: string[] } {
  const notes: string[] = [];
  let verdict: 'pass' | 'warn' | 'fail' = 'pass';
  if (s.inkPct < INK_MIN_PCT) {
    notes.push(`ink ${s.inkPct.toFixed(2)}% < ${INK_MIN_PCT}% — no visible caption`);
    // dead-air mid-beat is a defect; a thin tail is a known non-defect (exit fades) → warn
    verdict = probe === 'mid' ? 'fail' : 'warn';
    return { verdict, notes };
  }
  if (s.contrast !== null) {
    if (s.contrast < CONTRAST_FAIL) { verdict = 'fail'; notes.push(`contrast ${s.contrast} < ${CONTRAST_FAIL} — unreadable on this footage`); }
    else if (s.contrast < CONTRAST_WARN) { verdict = 'warn'; notes.push(`contrast ${s.contrast} < ${CONTRAST_WARN} — borderline, eyeball it`); }
  }
  return { verdict, notes };
}

interface Beat { i: number; startSec: number; endSec: number; lastWordSec?: number }

function beatsOf(runDir: string): Beat[] {
  const wt = join(runDir, 'word-timings.json');
  if (existsSync(wt)) {
    const t = JSON.parse(readFileSync(wt, 'utf8')) as { beats: { i: number; startSec: number; endSec: number; words?: { delayMs: number }[] }[] };
    return t.beats.map((b) => ({
      i: b.i, startSec: b.startSec, endSec: b.endSec,
      lastWordSec: b.words?.length ? Math.max(...b.words.map((w) => w.delayMs)) / 1000 : undefined,
    }));
  }
  const tr = JSON.parse(readFileSync(join(runDir, 'transcript.json'), 'utf8')) as { chunks: { timestamp: [number, number] }[] };
  return tr.chunks.map((c, idx) => ({ i: idx + 1, startSec: c.timestamp[0], endSec: c.timestamp[1] }));
}

// The geometric midpoint can precede the beat's speech (a late hero word, a page hand-off, an
// arc-then-body build): a failing mid probe gets ONE second chance at the moment every word of the
// beat has landed. True dead-air still fails — ink is absent then too. 39-sample validation showed
// this artifact class produced every false FAIL on otherwise eyeball-clean renders.
export function midRetryTime(b: Beat): number | null {
  if (b.lastWordSec === undefined) return null;
  const t = Math.min(b.lastWordSec + 0.3, b.endSec - 0.12);
  return t > (b.startSec + b.endSec) / 2 + 0.05 ? t : null;
}

function grayFrame(video: string, tSec: number, w: number, h: number): Uint8Array {
  return new Uint8Array(execFileSync(FFMPEG, [
    '-v', 'error', '-ss', String(tSec), '-i', video, '-frames:v', '1',
    '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ], { maxBuffer: 1 << 24 }));
}

export function probeRun(runDir: string): ProbeResult[] {
  const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')) as { videoPath: string; width: number; height: number; durationSec: number };
  const render = join(runDir, 'final', 'out.silent.mp4');
  if (!existsSync(render)) throw new Error(`no ${render} — record first`);
  const portrait = meta.height >= meta.width;
  const [w, h] = portrait ? [GRID_W, GRID_H] : [GRID_H, GRID_W];
  const results: ProbeResult[] = [];
  for (const b of beatsOf(runDir)) {
    const probes: ['mid' | 'tail', number][] = [
      ['mid', (b.startSec + b.endSec) / 2],
      ['tail', Math.max(b.startSec, b.endSec - 0.12)],
    ];
    for (const [probe, tRaw] of probes) {
      const t = Math.min(tRaw, meta.durationSec - 0.05);
      let s = probeStats(grayFrame(render, t, w, h), grayFrame(meta.videoPath, t, w, h), w, h);
      let { verdict, notes } = judge(probe, s);
      let tUsed = t;
      if (probe === 'mid' && verdict === 'fail') {
        const t2 = midRetryTime(b);
        if (t2 !== null) {
          const t2c = Math.min(t2, meta.durationSec - 0.05);
          const s2 = probeStats(grayFrame(render, t2c, w, h), grayFrame(meta.videoPath, t2c, w, h), w, h);
          const r2 = judge(probe, s2);
          if (r2.verdict !== 'fail') {
            s = s2; verdict = r2.verdict; tUsed = t2c;
            notes = [...r2.notes, `mid resampled @${t2c.toFixed(2)}s — words land late in this beat (midpoint probe was pre-speech)`];
          }
        }
      }
      results.push({ beat: b.i, probe, tSec: Math.round(tUsed * 100) / 100, inkPct: Math.round(s.inkPct * 100) / 100, contrast: s.contrast, verdict, notes });
    }
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const runDir = argv.find((a) => !a.startsWith('--'));
  if (!runDir) { console.error('usage: node --import tsx pipeline/scripts/probe-qa.ts <runDir> [--json]'); process.exit(2); }
  const results = probeRun(runDir);
  if (argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
  else for (const r of results) {
    console.log(`beat ${r.beat} ${r.probe}@${r.tSec}s ink=${r.inkPct}% contrast=${r.contrast ?? '-'} ${r.verdict.toUpperCase()}${r.notes.length ? ' — ' + r.notes.join('; ') : ''}`);
  }
  const fails = results.filter((r) => r.verdict === 'fail');
  const warns = results.filter((r) => r.verdict === 'warn');
  // summary → stderr so --json stdout stays parseable
  console.error(fails.length ? `probe-qa: ${fails.length} FAIL, ${warns.length} warn` : `probe-qa: clean (${warns.length} warn)`);
  process.exit(fails.length ? 1 : 0);
}
