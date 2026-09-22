// Is the file about to be delivered the file that was meant?
//
//   openedit check-delivery <run-dir> [--doc final] [--samples 3] [--json]
//
// WHY THIS EXISTS. At the end of a run an author checks the deliverable by hand: a few frames pulled
// from it and from the source and differenced in a script, an ebur128 pass for the loudness. Each is a
// retyped ffmpeg line, and ffmpeg run from a headless session without `-nostdin` waits on a stdin that
// never comes, so a fourteen-second clip cost two minutes per check. This is those checks once:
// container, picture against source, loudness. It measures and reports; it changes nothing.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { numberFlag, parseUsage, usageLine, type Usage } from '../args.ts';
import { FFMPEG } from '../config.ts';
import { hasAudioStream, probeDisplaySize, probeFrameRate, videoDurationOf } from '../probe.ts';
import { assertDocInsideRun } from './safezone-check.ts';

const GRID = 48;
/** How far either side of the expected source frame the picture is searched for, in source frames. */
const REACH = 3;

export interface SyncSample { tSec: number; offsetFrames: number | null; diffAtZero: number; bestDiff: number }
export interface Loudness { integratedLufs: number; truePeakDb: number | null; rangeLu: number | null }
export interface Delivery {
  schema: 1;
  file: string;
  width: number; height: number; fps: string; durationSec: number; hasAudio: boolean;
  source: { file: string; width: number; height: number; fps: string; durationSec: number } | null;
  sync: SyncSample[];
  loudness: Loudness | null;
  findings: string[];
}

const ffmpeg = (args: string[]) => spawnSync(FFMPEG, ['-nostdin', '-v', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 24 });

/** One frame as a small grey grid: enough to tell two moments of a shot apart, cheap enough to take many. */
function greyFrame(video: string, tSec: number): Uint8Array | null {
  const r = ffmpeg(['-ss', String(Math.max(0, tSec)), '-i', video, '-frames:v', '1', '-vf', `scale=${GRID}:${GRID},format=gray`, '-f', 'rawvideo', '-']);
  return r.status === 0 && r.stdout.length >= GRID * GRID ? new Uint8Array(r.stdout.subarray(0, GRID * GRID)) : null;
}

export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/**
 * Which source frame a delivered frame is, relative to the one its time says it should be. Graphics
 * over the picture raise every difference alike, so the OFFSET of the minimum is what is read, never
 * its size. A shot too still to tell its own frames apart is reported as unknown, not as in sync.
 */
export function offsetOf(diffs: number[], reach: number): number | null {
  const best = Math.min(...diffs);
  const worst = Math.max(...diffs);
  if (worst - best < 0.5) return null;
  // The smallest |offset| among the near-ties: a static stretch must not read as a slip.
  const near = diffs.map((d, i) => ({ d, k: i - reach })).filter((x) => x.d - best < (worst - best) * 0.1);
  return near.sort((x, y) => Math.abs(x.k) - Math.abs(y.k))[0].k;
}

export function parseEbur128(stderr: string): Loudness | null {
  const tail = stderr.slice(stderr.lastIndexOf('Summary:'));
  const i = tail.match(/I:\s*(-?[\d.]+)\s*LUFS/);
  if (!i) return null;
  const peak = tail.match(/Peak:\s*(-?[\d.]+)\s*dBFS/);
  const lra = tail.match(/LRA:\s*(-?[\d.]+)\s*LU/);
  return { integratedLufs: Number(i[1]), truePeakDb: peak ? Number(peak[1]) : null, rangeLu: lra ? Number(lra[1]) : null };
}

const rate = (video: string): { text: string; value: number } => {
  const r = probeFrameRate(video);
  return { text: r.rate.replace(/\/1$/, ''), value: r.fps };
};

export function checkDelivery(runDir: string, doc = 'final', samples = 3): Delivery {
  const file = join(runDir, assertDocInsideRun(doc), 'out.mp4');
  if (!existsSync(file)) throw new Error(`check-delivery: no ${file} — run the gate chain first`);
  const { width, height } = probeDisplaySize(file);
  const fps = rate(file);
  const durationSec = videoDurationOf(file);
  const findings: string[] = [];

  const metaPath = join(runDir, 'meta.json');
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) as { videoPath?: string } : {};
  const src = meta.videoPath ? resolve(runDir, meta.videoPath) : '';
  let source: Delivery['source'] = null;
  const sync: SyncSample[] = [];
  if (src && existsSync(src)) {
    const s = probeDisplaySize(src);
    const sFps = rate(src);
    source = { file: src, width: s.width, height: s.height, fps: sFps.text, durationSec: videoDurationOf(src) };
    if (fps.text !== sFps.text) {
      findings.push(`frame rate: delivered ${fps.text} fps, source ${sFps.text} fps — the manifest's fps should be meta.json's frameRate (${sFps.text})`);
    }
    if (Math.abs(source.durationSec - durationSec) > 2 / fps.value) {
      findings.push(`duration: delivered ${durationSec.toFixed(3)}s, source ${source.durationSec.toFixed(3)}s`);
    }
    for (let n = 1; n <= samples; n++) {
      const tSec = Math.round(((durationSec * n) / (samples + 1)) * 1000) / 1000;
      const out = greyFrame(file, tSec);
      if (!out) continue;
      const diffs: number[] = [];
      for (let k = -REACH; k <= REACH; k++) {
        const f = greyFrame(src, tSec + k / sFps.value);
        diffs.push(f ? meanAbsDiff(out, f) : Number.POSITIVE_INFINITY);
      }
      const finite = diffs.map((d) => (Number.isFinite(d) ? d : 255));
      sync.push({ tSec, offsetFrames: offsetOf(finite, REACH), diffAtZero: Math.round(finite[REACH] * 100) / 100, bestDiff: Math.round(Math.min(...finite) * 100) / 100 });
    }
    // Two rates sample one timeline at different instants, so a frame either way is the mismatch
    // already reported above and not a second defect.
    const slack = fps.text !== sFps.text ? 1 : 0;
    const slipped = sync.filter((x) => x.offsetFrames !== null && Math.abs(x.offsetFrames) > slack);
    if (slipped.length) findings.push(`picture: ${slipped.map((x) => `${x.offsetFrames! > 0 ? '+' : ''}${x.offsetFrames} frame(s) at ${x.tSec}s`).join(', ')} against the source`);
  }

  const hasAudio = hasAudioStream(file);
  let loudness: Loudness | null = null;
  if (hasAudio) {
    const r = spawnSync(FFMPEG, ['-nostdin', '-nostats', '-v', 'info', '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 26 });
    loudness = parseEbur128(r.stderr ?? '');
    if (!loudness) findings.push('loudness: could not be measured');
  } else findings.push('audio: the delivered file has no audio stream');

  return { schema: 1, file, width, height, fps: fps.text, durationSec, hasAudio, source, sync, loudness, findings };
}

export const usage = {
  summary: 'Measure the deliverable: container, picture against the source, loudness',
  positionals: '<run-dir>',
  flags: {
    doc: { type: 'string', value: '<subdir>', help: 'Document under the run whose out.mp4 is measured (default final)' },
    samples: { type: 'string', value: 'N', help: 'How many moments the picture is compared at (default 3)' },
    json: { type: 'boolean', help: 'Print the report as JSON' },
  },
  notes: 'Measures and reports, changes nothing. Exit 0 with nothing to say, 1 with findings. Writes <doc>/delivery.json.',
} satisfies Usage;

export function checkDeliveryCommand(argv: string[]): number {
  const { values, positionals: [dir] } = parseUsage('check-delivery', usage, argv);
  if (!dir) { console.error(usageLine('check-delivery', usage)); return 2; }
  let report: Delivery;
  try {
    const samples = numberFlag('samples', values.samples, 3, (n) => Number.isInteger(n) && n >= 1 && n <= 12, 'a whole number from 1 to 12');
    report = checkDelivery(resolve(dir), values.doc ?? 'final', samples);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  writeFileSync(join(resolve(dir), values.doc ?? 'final', 'delivery.json'), JSON.stringify(report, null, 2) + '\n');
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`delivery: ${report.width}x${report.height} @ ${report.fps} fps, ${report.durationSec.toFixed(3)}s, ${report.hasAudio ? 'with' : 'NO'} audio`);
    if (report.source) console.log(`source:   ${report.source.width}x${report.source.height} @ ${report.source.fps} fps, ${report.source.durationSec.toFixed(3)}s`);
    for (const s of report.sync) {
      console.log(`  picture at ${s.tSec}s: ${s.offsetFrames === null ? 'too still to tell' : s.offsetFrames === 0 ? 'on its source frame' : `${s.offsetFrames > 0 ? '+' : ''}${s.offsetFrames} frame(s)`}`);
    }
    if (report.loudness) console.log(`loudness: ${report.loudness.integratedLufs} LUFS integrated${report.loudness.truePeakDb === null ? '' : `, peak ${report.loudness.truePeakDb} dBFS`}${report.loudness.rangeLu === null ? '' : `, range ${report.loudness.rangeLu} LU`}`);
    for (const f of report.findings) console.log(`FINDING ${f}`);
    if (!report.findings.length) console.log('nothing to report');
  }
  return report.findings.length ? 1 : 0;
}
