// The HDR-to-SDR transform's curves, computed here and handed to ffmpeg as 1D LUT files (lut1d), because the
// filter that converts HDR natively (zscale, from zimg) is missing from stock builds such as Homebrew's. The
// rest of the transform is filters every build has: a matrix (colorchannelmixer) and the roll-off (tonemap).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type HdrTransfer = 'pq' | 'hlg';

/**
 * What the transform does. `referenceWhite` is the cd/m2 that would land at SDR white unrolled (BT.2408
 * puts HDR's reference white at 203); light above `knee` times it is rolled off by a Mobius curve that
 * reaches SDR white at `peak` cd/m2 instead of clipping, which also pulls reference white itself below SDR
 * white. With `knee` null, light above `referenceWhite` is clipped.
 */
export interface SdrParams {
  referenceWhite: number;
  knee: number | null;
  peak: number;
}

/**
 * Points per curve: the fewest that keep each within one 8-bit code of the exact curve, since lut1d
 * interpolates linearly on a uniform grid and parses its whole file for every filter it sets up (65,536 lines
 * take about 80 ms). The BT.709 curve's slope is infinite at black, where a uniform grid errs most, so it needs
 * forty times the points of the transfer curves, which are flat there.
 */
export const TO_LINEAR_POINTS = 1024;
export const TO_SIGNAL_POINTS = 40000;

const PQ_M1 = 2610 / 16384;
const PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = (2413 / 4096) * 32;
const PQ_C3 = (2392 / 4096) * 32;

/** SMPTE ST 2084: signal to display light in cd/m2. */
export function pqToNits(e: number): number {
  const p = Math.max(e, 0) ** (1 / PQ_M2);
  return 10000 * (Math.max(p - PQ_C1, 0) / (PQ_C2 - PQ_C3 * p)) ** (1 / PQ_M1);
}

const HLG_A = 0.17883277;
const HLG_B = 1 - 4 * HLG_A;
const HLG_C = 0.5 - HLG_A * Math.log(4 * HLG_A);

/**
 * HLG signal to display light in cd/m2 on BT.2100's 1000 cd/m2 reference display. Its system gamma of 1.2 is
 * applied to each channel, as zimg does by default, rather than to luminance as BT.2100 has it, because a 1D
 * LUT carries one channel at a time.
 */
export function hlgToNits(e: number): number {
  const x = Math.max(e, 0);
  const scene = x <= 0.5 ? (x * x) / 3 : (Math.exp((x - HLG_C) / HLG_A) + HLG_B) / 12;
  return 1000 * scene ** 1.2;
}

type Rgb = [number, number, number];
type Matrix = [Rgb, Rgb, Rgb];
type Xy = [number, number];

/** A chromaticity as XYZ with Y = 1. */
const xyz = ([x, y]: Xy): Rgb => [x / y, 1, (1 - x - y) / y];

/** RGB to XYZ for primaries and a white given as xy chromaticities. */
function rgbToXyz(p: Xy[], white: Xy): Matrix {
  const c = p.map(xyz);
  const m = [[c[0][0], c[1][0], c[2][0]], [c[0][1], c[1][1], c[2][1]], [c[0][2], c[1][2], c[2][2]]];
  // Each primary scaled so the three sum to white.
  const s = solve3(m, xyz(white));
  return m.map((row) => row.map((v, i) => v * s[i])) as Matrix;
}

function solve3(m: number[][], v: number[]): number[] {
  const det = (a: number[][]) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
    + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det(m);
  return [0, 1, 2].map((c) => det(m.map((row, r) => row.map((x, k) => (k === c ? v[r] : x)))) / d);
}

function invert3(m: Matrix): Matrix {
  const cols = [0, 1, 2].map((c) => solve3(m, [0, 1, 2].map((r) => (r === c ? 1 : 0))));
  return [0, 1, 2].map((r) => [cols[0][r], cols[1][r], cols[2][r]]) as Matrix;
}

const mul = (a: Matrix, b: Matrix): Matrix =>
  [0, 1, 2].map((r) => [0, 1, 2].map((c) => a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c])) as Matrix;

const D65: Xy = [0.3127, 0.329];
const C: Xy = [0.31, 0.316];
const DCI: Xy = [0.314, 0.351];

const EBU3213 = { rgb: [[0.63, 0.34], [0.295, 0.605], [0.155, 0.077]] as Xy[], white: D65 };

/**
 * The primaries ffmpeg names and can be converted from, as xy chromaticities with their white. EBU Tech 3213's
 * have two names: ffprobe prints `ebu3213`, and `jedec-p22` is the one ffmpeg's options also take.
 */
const PRIMARIES: Readonly<Record<string, { rgb: Xy[]; white: Xy }>> = {
  bt709: { rgb: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], white: D65 },
  bt2020: { rgb: [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]], white: D65 },
  smpte432: { rgb: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]], white: D65 },
  smpte431: { rgb: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]], white: DCI },
  bt470bg: { rgb: [[0.64, 0.33], [0.29, 0.6], [0.15, 0.06]], white: D65 },
  smpte170m: { rgb: [[0.63, 0.34], [0.31, 0.595], [0.155, 0.07]], white: D65 },
  smpte240m: { rgb: [[0.63, 0.34], [0.31, 0.595], [0.155, 0.07]], white: D65 },
  ebu3213: EBU3213,
  'jedec-p22': EBU3213,
  bt470m: { rgb: [[0.67, 0.33], [0.21, 0.71], [0.14, 0.08]], white: C },
  film: { rgb: [[0.681, 0.319], [0.243, 0.692], [0.145, 0.049]], white: C },
};

/** Whether `primaries` are ones the conversion reads as they are, rather than as BT.2020's. */
export const knownPrimaries = (primaries: string): boolean => Object.hasOwn(PRIMARIES, primaries);

const BRADFORD: Matrix = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];

/** XYZ under one white to XYZ under another, by Bradford's cone response, as ffmpeg's colorspace filter adapts. */
function adapt(from: Xy, to: Xy): Matrix {
  const cone = (w: Xy) => {
    const v = xyz(w);
    return BRADFORD.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  };
  const [a, b] = [cone(from), cone(to)];
  const scale = [0, 1, 2].map((r) => [0, 1, 2].map((c) => (r === c ? b[r] / a[r] : 0))) as Matrix;
  return mul(invert3(BRADFORD), mul(scale, BRADFORD));
}

/**
 * Linear RGB in `primaries` to BT.709's, or null when they are BT.709 already. BT.2100 defines PQ and HLG with
 * BT.2020's, so unset or unknown primaries are read as those. A white other than D65 is adapted to it, so the
 * source's white stays white.
 */
export function toBt709(primaries: string | undefined): Matrix | null {
  if (primaries === 'bt709') return null;
  const from = primaries !== undefined && knownPrimaries(primaries) ? PRIMARIES[primaries] : PRIMARIES.bt2020;
  const toXyz = rgbToXyz(from.rgb, from.white);
  const inD65 = from.white === D65 ? toXyz : mul(adapt(from.white, D65), toXyz);
  return mul(invert3(rgbToXyz(PRIMARIES.bt709.rgb, D65)), inD65);
}

/** A curve as a 1D .cube file's text, the same on all three channels. */
function curveText(title: string, points: number, f: (x: number) => number): string {
  const n = points - 1;
  const lines = [`TITLE "${title}"`, `LUT_1D_SIZE ${points}`];
  for (let i = 0; i <= n; i++) {
    const v = f(i / n).toFixed(7);
    lines.push(`${v} ${v} ${v}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Signal to linear light in units of reference white: above 1 is brighter than SDR white. */
export const toLinearText = (transfer: HdrTransfer, referenceWhite: number): string =>
  curveText(`${transfer} to linear, ${referenceWhite} cd/m2 = 1`, TO_LINEAR_POINTS,
    (x) => (transfer === 'pq' ? pqToNits(x) : hlgToNits(x)) / referenceWhite);

/** Linear light to the BT.709 signal an SDR display decodes with BT.1886 (gamma 2.4, black at zero). */
export const toSdrSignalText = (): string => curveText('linear to BT.709 SDR', TO_SIGNAL_POINTS, (x) => x ** (1 / 2.4));

/**
 * `text` as a .cube under `dir`, written once and reused: its name is the hash of its own text, so a change
 * to a curve never serves a file made the old way. Written under a per-process name and renamed into place,
 * so concurrent runs never read half a file.
 */
export function cubeFile(dir: string, name: string, text: string): string {
  const path = join(dir, `${name}-${createHash('sha1').update(text).digest('hex').slice(0, 16)}.cube`);
  if (existsSync(path)) return path;
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return path;
}
