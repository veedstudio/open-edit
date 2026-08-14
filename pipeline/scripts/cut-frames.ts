// The frames a uniform grid never looks at.
//
//   node --import tsx pipeline/scripts/cut-frames.ts <video> [--out <dir>] [--json] [--threshold 0.15]
//                                                    [--after 3] [--no-sheets]
//
// WHY THIS EXISTS. A run sampled its deliverable at 1.2, 3.8, 9.5, 15.0 and 21.5 seconds and called
// the composite clean. Its cuts were at 1.83, 5.29, 8.58, 10.75, 14.25, 19.54 and 20.67 — not one
// sample was within four tenths of a cut, and the defect it was looking for lives ONLY at a cut: the
// matted speaker lagged the background by a few frames, so for an instant a person from the previous
// shot stood in front of the next one. Evenly spaced frames are the wrong frames. A cut is where two
// layers can disagree, where a caption can survive a shot it was never meant to cross, and where a
// generated take shows its seams — so those are the frames to pull.
//
// Detection is ffmpeg's own scene score, and the frames come out as a contact sheet per cut: the last
// frame BEFORE it and the first few after, so a layer that arrives late is visible as itself rather
// than inferred.
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFlags } from '../../veed/args.ts';
import { FFMPEG, FFPROBE } from '../../config.ts';

export interface Cut { tSec: number; score: number }

/** Nominal fps, so a time can be named as a frame the way the rest of the pipeline names them. */
export function fpsOf(video: string): number {
  const r = execFileSync(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=r_frame_rate', '-of', 'default=nw=1:nk=1', video,
  ], { encoding: 'utf8' }).trim();
  const [n, d] = r.split('/').map(Number);
  const fps = d ? n / d : n;
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`${video}: ffprobe reports r_frame_rate "${r}" — no usable frame rate, so a cut cannot be named as a frame`);
  }
  return fps;
}

export function durationOf(video: string): number {
  const read = (entry: string) => execFileSync(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', entry, '-of', 'default=nw=1:nk=1', video,
  ], { encoding: 'utf8' }).trim();
  // A container with no format duration prints `N/A`, which reads as NaN — and every tile time then
  // fails `t < durationSec`, so the tool wrote no sheets at all and still exited 0 saying "LOOK at the
  // strips". The video stream carries its own duration when the container does not.
  for (const entry of ['format=duration', 'stream=duration']) {
    const v = Number(read(entry));
    if (Number.isFinite(v) && v > 0) return v;
  }
  throw new Error(`${video}: ffprobe reports no usable duration — a cut cannot be placed in a clip of unknown length`);
}

/** ffmpeg's metadata printer, as time/score pairs in time order. It deduplicates nothing. */
export function parseSceneMetadata(out: string): Cut[] {
  const raw: Cut[] = [];
  let pending: number | null = null;
  for (const line of out.split('\n')) {
    const t = line.match(/pts_time:([\d.]+)/);
    if (t) { pending = Number(t[1]); continue; }
    const s = line.match(/scene_score=([\d.]+)/);
    if (s && pending !== null) { raw.push({ tSec: pending, score: Number(s[1]) }); pending = null; }
  }
  return raw.sort((a, b) => a.tSec - b.tSec);
}

/**
 * Detections within two frames of each other are one cut seen twice — a dissolve scores on several
 * consecutive frames — so the strongest score of a run is kept at the time of its FIRST detection.
 *
 * The window slides from the most recent detection, not from the start of the run: measuring it from
 * the start split a four-frame dissolve into three cuts. But sliding alone is transitively closed, so
 * a strobe, a whip pan or `--threshold 0` produced an unbroken chain and the WHOLE CLIP reported as
 * one cut, swallowing every real boundary inside it. A run is therefore also capped.
 *
 * The cap is in SECONDS, because a dissolve is half a second whatever the frame rate is. Counted in
 * frames, one 0.5 s cross-dissolve came back as one cut at 24 fps, two at 30 and three at 60 — the
 * same edit, three answers, because the footage was shot faster.
 */
export function mergeAdjacent(cuts: Cut[], fps: number, maxRunSec = 0.5): Cut[] {
  const merged: Cut[] = [];
  // The window slides from the most recent DETECTION while the reported time stays at the first one:
  // a dissolve scores on a run of consecutive frames, and measuring the gap from the start of the run
  // instead split a four-frame dissolve into three cuts.
  let lastSeen = -Infinity;
  for (const c of cuts) {
    const last = merged[merged.length - 1];
    const withinGap = last !== undefined && c.tSec - lastSeen < 2 / fps;
    const withinRun = last !== undefined && c.tSec - last.tSec < maxRunSec + 0.5 / fps;
    if (withinGap && withinRun) {
      if (c.score > last.score) merged[merged.length - 1] = { tSec: last.tSec, score: c.score };
    } else merged.push(c);
    lastSeen = c.tSec;
  }
  return merged;
}

/** The frame before the cut, then `after` frames from it — sampled at frame centres, clamped to the clip. */
export function tileTimes(cut: Cut, fps: number, durationSec: number, after: number): number[] {
  return [-1, ...Array.from({ length: Math.max(0, after) }, (_, k) => k)]
    .map((k) => cut.tSec + (k + 0.5) / fps)
    .filter((t) => t >= 0 && t < durationSec);
}

/** Every shot boundary, by scene score. */
export function cutsIn(video: string, threshold = 0.15): Cut[] {
  const out = execFileSync(FFMPEG, [
    '-v', 'error', '-i', video,
    '-filter_complex', `select='gt(scene,${threshold})',metadata=print:file=-`,
    '-an', '-f', 'null', '-',
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return mergeAdjacent(parseSceneMetadata(out), fpsOf(video));
}

/**
 * One contact sheet per cut: the frame before it and `after` frames from it on.
 *
 * The sheet is the deliverable of this tool. A number in a report ("7 cuts detected") is not
 * something anyone can be wrong in front of; a strip showing the same hand in two positions is.
 */
export function sheetsForCuts(
  video: string,
  cuts: Cut[],
  outDir: string,
  o: { after?: number; width?: number } = {},
): string[] {
  const after = o.after ?? 3;
  const width = o.width ?? 320;
  const fps = fpsOf(video);
  const dur = durationOf(video);
  mkdirSync(outDir, { recursive: true });

  const sheets: string[] = [];
  cuts.forEach((cut, i) => {
    const stem = `cut${String(i + 1).padStart(2, '0')}`;
    const tiles = tileTimes(cut, fps, dur, after).map((t, k) => {
      const p = join(outDir, `${stem}-${k}.png`);
      execFileSync(FFMPEG, ['-y', '-v', 'error', '-ss', String(t), '-i', video,
        '-frames:v', '1', '-vf', `scale=${width}:-1`, p]);
      // A seek past the end of the video stream exits 0 and writes nothing, so the file's existence
      // is not evidence that a frame came out of it.
      return existsSync(p) && statSync(p).size > 0 ? p : undefined;
    }).filter((p): p is string => p !== undefined);

    if (!tiles.length) return;
    const sheet = join(outDir, `${stem}.png`);
    // hstack takes two inputs at the minimum; a cut in the last frames of the clip can leave one.
    if (tiles.length === 1) copyFileSync(tiles[0], sheet);
    else {
      execFileSync(FFMPEG, ['-y', '-v', 'error',
        ...tiles.flatMap((t) => ['-i', t]),
        '-filter_complex', `hstack=inputs=${tiles.length}`, '-frames:v', '1', sheet]);
    }
    sheets.push(sheet);
  });
  return sheets;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseFlags({
    args: process.argv.slice(2),
    options: {
      out: { type: 'string' },
      json: { type: 'boolean' },
      threshold: { type: 'string' },
      after: { type: 'string' },
      'no-sheets': { type: 'boolean' },
    },
    allowPositionals: true,
  });
  const [video] = positionals;
  if (!video || !existsSync(video)) {
    console.error('usage: cut-frames.ts <video> [--out <dir>] [--json] [--threshold 0.15] [--after 3] [--no-sheets]');
    process.exit(2);
  }

  const num = (name: string, raw: string | undefined, min: number, max: number): number | undefined => {
    if (raw === undefined) return undefined;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < min || v > max) {
      console.error(`--${name} must be a number between ${min} and ${max}, got "${raw}"`);
      process.exit(2);
    }
    return v;
  };
  // A threshold of 0 fires on every frame and turns the whole clip into one merged run.
  const cuts = cutsIn(video, num('threshold', values.threshold, 0.01, 1));
  const fps = fpsOf(video);
  const outDir = values.out ?? join(process.cwd(), 'qa', `cuts-${basename(video).replace(/\.\w+$/, '')}`);
  const sheets = values['no-sheets'] ? [] : sheetsForCuts(video, cuts, outDir, {
    after: num('after', values.after, 0, 32),
  });

  if (values.json) {
    console.log(JSON.stringify({ video, fps, cuts, sheets }, null, 2));
  } else {
    console.log(`${cuts.length} cut(s) at ${fps} fps`);
    for (const [i, c] of cuts.entries()) {
      console.log(`  cut ${i + 1}: ${c.tSec.toFixed(3)}s (frame ${Math.round(c.tSec * fps)}) score ${c.score.toFixed(3)}`);
    }
    if (sheets.length) console.log(`\nOne strip per cut — the frame before it, then the frames after — in ${outDir}`);
    console.log('LOOK at the strips. A layer that changes on a different frame from the rest of the picture is the defect these frames exist to show.');
  }
}
