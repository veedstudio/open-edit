// Where the picture is empty, for every cue — measured by a script, so nobody writes a detector.
//
//   openedit measure-placement <runDir> [--no-sheet] [--json]
//
// WHY THIS EXISTS. Placement is decided against the picture, and nothing measured the picture: every
// authored run wrote its own face and energy probes, re-ran them, and read a dozen frames one at
// a time to check them. The measurement is mechanical; the placement DECISION stays with the
// author, who gets the numbers and one sheet to check them against instead of a blank page.
//
// Three signals per cue, on a small grid: MOTION between two instants of the cue (on a locked-off shot
// only the speaker moves), DETAIL (local gradient) in its middle frame, and SKIN chroma in that same
// frame. The subject box comes from motion when motion is confined to part of the frame, and from
// detail otherwise — a handheld shot moves everywhere and a frozen speaker moves nowhere; where motion
// gave no subject the head is looked for by skin. All are estimates, and each entry says which it is.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { FFMPEG } from '../config.ts';
import { safeZone } from '../safe-zone.ts';
import { assertTile, tilePath, tileSheet, withTileDir } from '../sheet.ts';

export interface Box { x: number; y: number; w: number; h: number }
export interface Band {
  name: string; yPx: number; hPx: number;
  /** Mean gray level 0..255 of the footage behind the band: what the ink has to separate from. */
  luma: number;
  /** p95 - p5 of that level: a wide spread means no single ink colour holds across the band. */
  spread: number;
  detail: number; motion: number;
  overHead: boolean;
  /** Fraction of the band's area the subject box covers. */
  overSubject: number;
}
export interface FrameMeasure {
  subjectBox: Box | null; headBox: Box | null;
  subjectFrom: 'motion' | 'detail' | null;
  /** What the head box was read from. `detail` is a guess on a busy background: check it on the sheet. */
  headFrom: 'motion' | 'skin' | 'detail' | null;
  bands: Band[];
  /** The band with the least detail and motion that does not cross the head. */
  calmest: string;
}
export interface CueMeasure extends FrameMeasure { cue: number; tSec: number }

const GRID_LONG = 192; // long side of the measuring grid; the short side follows the canvas aspect

function percentile(sorted: number[], p: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
}

interface Component { box: Box; cells: number; members: number[] }

/** Largest 4-connected component of a boolean grid. */
function largestComponent(on: Uint8Array, gw: number, gh: number): Component | null {
  const seen = new Uint8Array(on.length);
  let best: Component | null = null;
  for (let i = 0; i < on.length; i++) {
    if (!on[i] || seen[i]) continue;
    const members: number[] = [];
    const stack = [i]; seen[i] = 1;
    while (stack.length) {
      const c = stack.pop() as number;
      const x = c % gw, y = (c / gw) | 0;
      members.push(c);
      for (const n of [x > 0 ? c - 1 : -1, x < gw - 1 ? c + 1 : -1, y > 0 ? c - gw : -1, y < gh - 1 ? c + gw : -1]) {
        if (n >= 0 && on[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
    if (!best || members.length > best.cells) best = { box: { x: 0, y: 0, w: 0, h: 0 }, cells: members.length, members };
  }
  return best;
}

/**
 * The box holding the middle 90% of a component's signal on each axis. A plain bounding box follows
 * one flickering lamp to the edge of the frame; the mass of the signal stays on the speaker.
 */
function massBox(members: number[], weight: Float32Array, gw: number, gh: number): Box {
  const col = new Float64Array(gw), row = new Float64Array(gh);
  let total = 0;
  for (const c of members) { const v = weight[c] + 1; col[c % gw] += v; row[(c / gw) | 0] += v; total += v; }
  const span = (acc: Float64Array): [number, number] => {
    let run = 0, lo = 0, hi = acc.length - 1;
    for (let i = 0; i < acc.length; i++) { run += acc[i]; if (run >= total * 0.05) { lo = i; break; } }
    run = 0;
    for (let i = acc.length - 1; i >= 0; i--) { run += acc[i]; if (run >= total * 0.05) { hi = i; break; } }
    return [lo, Math.max(lo, hi)];
  };
  const [x0, x1] = span(col), [y0, y1] = span(row);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** A coarse blur, so a moving mouth and a moving shoulder join into one subject rather than two specks. */
function dilate(on: Uint8Array, gw: number, gh: number, r: number): Uint8Array {
  const out = new Uint8Array(on.length);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    if (!on[y * gw + x]) continue;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < gw && yy >= 0 && yy < gh) out[yy * gw + xx] = 1;
    }
  }
  return out;
}

/**
 * Measure one cue from three same-size gray frames: early, middle and late in the cue.
 * Pure, so the arithmetic is tested on synthetic frames with no ffmpeg in the loop.
 */
export function measureFrame(
  early: Uint8Array, mid: Uint8Array, late: Uint8Array,
  gw: number, gh: number, canvasW: number, canvasH: number,
  midRgb?: Uint8Array,
): FrameMeasure {
  const n = gw * gh;
  const detail = new Float32Array(n), motion = new Float32Array(n);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = y * gw + x;
    const dx = x < gw - 1 ? Math.abs(mid[i] - mid[i + 1]) : 0;
    const dy = y < gh - 1 ? Math.abs(mid[i] - mid[i + gw]) : 0;
    detail[i] = dx + dy;
    motion[i] = Math.abs(early[i] - late[i]);
  }

  // Motion is trusted only when it is confined: under 1% the speaker held still between the two
  // instants, over 45% the camera moved and the diff outlines the whole scene.
  const MOTION_ON = 14;
  const moving = new Uint8Array(n);
  let movingCells = 0;
  for (let i = 0; i < n; i++) if (motion[i] > MOTION_ON) { moving[i] = 1; movingCells++; }
  const movingFrac = movingCells / n;
  let subjectFrom: FrameMeasure['subjectFrom'] = null;
  let comp: Component | null = null;
  let signal: Float32Array = motion;
  // A component under 2% of the frame is texture, not a person. Checked HERE, per signal: a speck of
  // motion (grain, foliage, codec flicker) used to end the search and the detail pass never ran, so an
  // ordinary shot reported no subject and the top band was offered over the speaker's face.
  const person = (c: Component | null) => (c && c.cells >= n * 0.02 ? c : null);
  if (movingFrac >= 0.01 && movingFrac <= 0.45) {
    comp = person(largestComponent(dilate(moving, gw, gh, 3), gw, gh));
    if (comp) subjectFrom = 'motion';
  }
  if (!comp) {
    const sorted = Array.from(detail).sort((a, b) => a - b);
    const cut = Math.max(12, percentile(sorted, 0.8));
    const busy = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (detail[i] >= cut) busy[i] = 1;
    comp = person(largestComponent(dilate(busy, gw, gh, 2), gw, gh));
    if (comp) { subjectFrom = 'detail'; signal = detail; }
  }
  if (comp) comp.box = massBox(comp.members, signal, gw, gh);

  const sx = canvasW / gw, sy = canvasH / gh;
  const toCanvas = (b: Box): Box => ({ x: Math.round(b.x * sx), y: Math.round(b.y * sy), w: Math.round(b.w * sx), h: Math.round(b.h * sy) });
  const subjectBox = comp ? toCanvas(comp.box) : null;
  // The head is the top of the subject's box: three quarters as tall as the box is wide, capped at 40% of
  // its height, 60% of
  // its width (shoulders are wider than a face), centred on where the signal sits in those top rows
  // rather than on the box — a speaker who leans is not under the middle of their own shoulders.
  let headBox: Box | null = null;
  let headFrom: FrameMeasure['headFrom'] = null;
  if (comp && subjectBox) {
    const hh = Math.round(Math.min(subjectBox.h * 0.4, subjectBox.w * 0.75));
    const hw = Math.round(subjectBox.w * 0.6);
    const topRows = comp.box.y + Math.max(1, Math.round(hh / sy));
    let mass = 0, mx = 0;
    for (const c of comp.members) {
      const y = (c / gw) | 0;
      if (y < comp.box.y || y >= topRows) continue;
      const v = signal[c] + 1; mass += v; mx += v * (c % gw);
    }
    const cx = mass ? (mx / mass) * sx : subjectBox.x + subjectBox.w / 2;
    const x = Math.round(Math.min(Math.max(cx - hw / 2, subjectBox.x), subjectBox.x + subjectBox.w - hw));
    headBox = { x, y: subjectBox.y, w: hw, h: hh };
    headFrom = subjectFrom;
  }
  // Detail cannot tell a speaker from a street behind them. Where motion gave no subject, a face is
  // looked for by its chroma instead: the classic Cb/Cr skin range holds across skin tones because it
  // drops luminance. The largest such blob in the upper three quarters is taken, and grown upward for
  // hair or a hat. A terracotta wall also passes this test, which is why motion is asked first.
  if (subjectFrom !== 'motion' && midRgb && midRgb.length >= n * 3) {
    const skin = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = midRgb[i * 3], g = midRgb[i * 3 + 1], b = midRgb[i * 3 + 2];
      const cb = 128 - 0.169 * r - 0.331 * g + 0.5 * b, cr = 128 + 0.5 * r - 0.419 * g - 0.081 * b;
      if (cb >= 77 && cb <= 127 && cr >= 135 && cr <= 173 && ((i / gw) | 0) < gh * 0.75) skin[i] = 1;
    }
    const face = largestComponent(skin, gw, gh);
    if (face && face.cells >= n * 0.004 && face.cells <= n * 0.2) {
      const ones = new Float32Array(n);
      const fb = toCanvas(massBox(face.members, ones, gw, gh));
      const grow = Math.round(fb.h * 0.35);
      const y = Math.max(0, fb.y - grow);
      headBox = { x: fb.x, y, w: fb.w, h: fb.y + fb.h - y };
      headFrom = 'skin';
    }
  }

  const zone = safeZone(canvasW, canvasH);
  const bandCount = canvasH > canvasW ? 6 : 4;
  const gx0 = Math.floor(zone.x0 * gw), gx1 = Math.ceil(zone.x1 * gw);
  const bands: Band[] = [];
  for (let b = 0; b < bandCount; b++) {
    const f0 = zone.y0 + ((zone.y1 - zone.y0) * b) / bandCount;
    const f1 = zone.y0 + ((zone.y1 - zone.y0) * (b + 1)) / bandCount;
    const gy0 = Math.floor(f0 * gh), gy1 = Math.max(gy0 + 1, Math.floor(f1 * gh));
    const lum: number[] = [];
    let d = 0, m = 0;
    for (let y = gy0; y < gy1; y++) for (let x = gx0; x < gx1; x++) {
      const i = y * gw + x;
      lum.push(mid[i]); d += detail[i]; m += motion[i];
    }
    lum.sort((a, c) => a - c);
    const cells = Math.max(1, lum.length);
    const yPx = Math.round(f0 * canvasH), hPx = Math.round((f1 - f0) * canvasH);
    const crosses = (box: Box | null) => !!box && box.y < yPx + hPx && box.y + box.h > yPx;
    let overSubject = 0;
    if (subjectBox && crosses(subjectBox)) {
      const zx0 = zone.x0 * canvasW, zx1 = zone.x1 * canvasW;
      const ix = Math.max(0, Math.min(subjectBox.x + subjectBox.w, zx1) - Math.max(subjectBox.x, zx0));
      const iy = Math.max(0, Math.min(subjectBox.y + subjectBox.h, yPx + hPx) - Math.max(subjectBox.y, yPx));
      overSubject = Math.round(((ix * iy) / ((zx1 - zx0) * hPx)) * 100) / 100;
    }
    bands.push({
      name: `band-${b + 1}`, yPx, hPx,
      luma: Math.round(lum.reduce((s, v) => s + v, 0) / cells),
      spread: percentile(lum, 0.95) - percentile(lum, 0.05),
      detail: Math.round((d / cells) * 10) / 10, motion: Math.round((m / cells) * 10) / 10,
      overHead: crosses(headBox), overSubject,
    });
  }
  const open = bands.filter((b) => !b.overHead);
  const calmest = (open.length ? open : bands).reduce((a, b) => (b.detail + b.motion < a.detail + a.motion ? b : a)).name;
  return { subjectBox, headBox, subjectFrom, headFrom, bands, calmest };
}

interface Cue { i: number; startSec: number; endSec: number }

function cuesOf(runDir: string): Cue[] {
  const wt = join(runDir, 'word-timings.json');
  if (existsSync(wt)) {
    const t = JSON.parse(readFileSync(wt, 'utf8')) as { beats: Cue[] };
    return t.beats.map((b) => ({ i: b.i, startSec: b.startSec, endSec: b.endSec }));
  }
  const tr = join(runDir, 'transcript.json');
  if (!existsSync(tr)) throw new Error(`${runDir}: no word-timings.json or transcript.json — run prep first; placement is measured per cue`);
  const parsed = JSON.parse(readFileSync(tr, 'utf8')) as { chunks: { timestamp: [number, number] }[] };
  return parsed.chunks.map((c, idx) => ({ i: idx + 1, startSec: c.timestamp[0], endSec: c.timestamp[1] }));
}

function frame(video: string, tSec: number, w: number, h: number, pixFmt: 'gray' | 'rgb24'): Uint8Array {
  const buf = new Uint8Array(execFileSync(FFMPEG, [
    '-v', 'error', '-ss', String(Math.max(0, tSec)), '-i', video, '-frames:v', '1',
    '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', pixFmt, '-',
  ], { maxBuffer: 1 << 24 }));
  // ffmpeg exits 0 with no bytes when the seek lands past the last decodable frame. Measuring an empty
  // buffer yields NaN everywhere, which JSON writes as null and a reader takes for a measurement.
  const want = w * h * (pixFmt === 'gray' ? 1 : 3);
  if (buf.length < want) throw new Error(`measure-placement: no frame at ${tSec.toFixed(2)}s of ${video} (got ${buf.length} of ${want} bytes) — is the clip shorter than meta.json says?`);
  return buf;
}

function grayOf(rgb: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgb.length / 3);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]);
  return out;
}

export function measureRun(runDir: string): { grid: [number, number]; canvas: [number, number]; cues: CueMeasure[]; videoPath: string } {
  const metaPath = join(runDir, 'meta.json');
  if (!existsSync(metaPath)) throw new Error(`${runDir}: no meta.json — run prep first; placement is measured against the run's own footage`);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { videoPath: string; width: number; height: number; durationSec: number };
  // Resolved, so a value that begins with a dash reaches ffmpeg as a path and never as an option.
  const videoPath = resolve(meta.videoPath);
  if (!existsSync(videoPath)) throw new Error(`${metaPath} names ${meta.videoPath}, which does not exist`);
  const list = cuesOf(runDir);
  if (!list.length) throw new Error(`${runDir}: the run has no cues, so there is no placement to measure`);
  const portrait = meta.height >= meta.width;
  const gw = portrait ? Math.round((GRID_LONG * meta.width) / meta.height) : GRID_LONG;
  const gh = portrait ? GRID_LONG : Math.round((GRID_LONG * meta.height) / meta.width);
  const last = meta.durationSec - 0.05;
  const cues = list.map((c) => {
    const midT = Math.min((c.startSec + c.endSec) / 2, last);
    // A short cue still needs two distinct instants, so the pair is never closer than 0.3s.
    const half = Math.max(0.15, Math.min(0.6, (c.endSec - c.startSec) / 2));
    const at = (t: number) => Math.min(Math.max(0, t), last);
    const rgb = frame(videoPath, at(midT), gw, gh, 'rgb24');
    const m = measureFrame(
      frame(videoPath, at(midT - half), gw, gh, 'gray'), grayOf(rgb), frame(videoPath, at(midT + half), gw, gh, 'gray'),
      gw, gh, meta.width, meta.height, rgb,
    );
    return { cue: c.i, tSec: Math.round(midT * 100) / 100, ...m };
  });
  return { grid: [gw, gh], canvas: [meta.width, meta.height], cues, videoPath };
}

/** One tile per cue with its boxes drawn, row-major in cue order: the single image that checks the file. */
function writeSheet(runDir: string, videoPath: string, canvas: [number, number], cues: CueMeasure[]): { sheet: string; cols: number } {
  const portrait = canvas[1] >= canvas[0];
  const tileW = portrait ? 216 : 384;
  // Both sides fixed, so every tile is one size whatever the source's rounding does.
  const tileH = Math.round((tileW * canvas[1]) / canvas[0] / 2) * 2;
  const k = tileW / canvas[0];
  const px = (v: number) => Math.max(1, Math.round(v * k));
  const zone = safeZone(canvas[0], canvas[1]);
  const sheet = join(runDir, 'design', 'placement.jpg');
  const { cols } = withTileDir((dir) => {
    cues.forEach((c, idx) => {
      const draw: string[] = [];
      const box = (b: Box, colour: string) => draw.push(`drawbox=x=${px(b.x)}:y=${px(b.y)}:w=${px(b.w)}:h=${px(b.h)}:color=${colour}:t=2`);
      const calm = c.bands.find((b) => b.name === c.calmest);
      if (calm) box({ x: zone.x0 * canvas[0], y: calm.yPx, w: (zone.x1 - zone.x0) * canvas[0], h: calm.hPx }, 'cyan@0.9');
      if (c.subjectBox) box(c.subjectBox, 'lime@0.9');
      if (c.headBox) box(c.headBox, 'red@0.9');
      execFileSync(FFMPEG, ['-v', 'error', '-y', '-ss', String(c.tSec), '-i', videoPath, '-frames:v', '1',
        '-vf', [`scale=${tileW}:${tileH}`, ...draw, 'format=rgb24'].join(','), tilePath(dir, idx)]);
      assertTile(tilePath(dir, idx), `cue ${c.cue} at ${c.tSec}s`);
    });
    return tileSheet(dir, cues.length, portrait ? 6 : 4, sheet, 4);
  });
  return { sheet, cols };
}

export const usage = {
  summary: 'Per-cue subject, head and calm-band measurements → design/placement.json + one sheet',
  positionals: '<run-dir>',
  flags: {
    json: { type: 'boolean', help: 'Print the measurements as JSON' },
    'no-sheet': { type: 'boolean', help: 'Skip the contact sheet that checks the boxes' },
  },
} satisfies Usage;

export function measurePlacementCommand(argv: string[]): number {
  const { values, positionals } = parseUsage('measure-placement', usage, argv);
  const runDir = positionals[0];
  if (!runDir || positionals.length > 1) { console.error(usageLine('measure-placement', usage)); return 2; }
  const { grid, canvas, cues, videoPath } = measureRun(runDir);
  mkdirSync(join(runDir, 'design'), { recursive: true });
  const out = join(runDir, 'design', 'placement.json');
  const write = (sheet: { cols: number } | null) => writeFileSync(out, JSON.stringify({
    schema: 1,
    method: 'subject from motion between two instants of the cue, else from gradient detail of its middle frame; head from the subject, else from skin chroma; boxes are estimates in canvas px',
    grid, canvas, safeZone: safeZone(canvas[0], canvas[1]),
    sheet: sheet ? { path: 'design/placement.jpg', cols: sheet.cols, order: 'row-major by cue', legend: 'lime subject, red head, cyan calmest band' } : null,
    cues,
  }, null, 2));
  // The numbers are written first: they are the expensive half, and a sheet that fails to tile must
  // not take them with it.
  write(null);
  let sheet: { sheet: string; cols: number } | null = null;
  let sheetError = '';
  if (!values['no-sheet']) {
    try { sheet = writeSheet(runDir, videoPath, canvas, cues); write(sheet); }
    catch (e) { sheetError = e instanceof Error ? e.message : String(e); }
  }
  if (values.json) console.log(JSON.stringify({ placement: out, sheet: sheet?.sheet ?? null, sheetError: sheetError || null, cues }, null, 2));
  else {
    for (const c of cues) {
      const calm = c.bands.find((b) => b.name === c.calmest);
      const head = c.headBox ? `head y ${c.headBox.y}..${c.headBox.y + c.headBox.h}` : 'no subject found';
      console.log(`cue ${c.cue} @${c.tSec}s  ${head} (${c.headFrom ?? '-'}${c.headFrom === 'detail' ? ', a guess: check the sheet' : ''})  calmest ${c.calmest} y ${calm?.yPx}..${(calm?.yPx ?? 0) + (calm?.hPx ?? 0)} luma ${calm?.luma} spread ${calm?.spread}`);
    }
    console.log(`placement: ${out}  (${cues.length} cues)`);
    if (sheet) console.log(`sheet: ${sheet.sheet}  (${sheet.cols} per row, cue order; lime subject, red head, cyan calmest band)`);
  }
  if (sheetError) { console.error(`measure-placement: the numbers are written, but the sheet that checks them could not be made — ${sheetError}`); return 1; }
  return 0;
}
