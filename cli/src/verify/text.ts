// The text check: on-screen text smaller than a phone's body text, or too close in brightness to what is behind it.
// Sizes come from the record the render wrote; contrast is measured on the video's own pixels on and around each
// text's glyphs at the sampled frames, so a backing, a stroke, a shadow or a calm patch of footage all count.
import { spawn } from 'node:child_process';
import { FFMPEG } from '../config.ts';
import { sampleSeconds, recordSeconds, timeOf, type TextEntry, type TextRecord } from '../render/text-record.ts';
import type { CheckReport, Found, ReviewContext, TextRecordInput } from './checks.ts';
import { fromTo, listed, quoted, skippedFor } from './report.ts';

/**
 * The smallest font size, as a fraction of the frame's shorter side: 4.5% is about 49 px on a 1080-wide 9:16 or a
 * 1080-high 16:9 frame, which is a phone's 17 pt body text when the video fills a screen whose short side is 375 pt,
 * turned to the video's orientation (375 / 1080 × 49 ≈ 17). It is stricter than the safe zone's minimum, Apple's
 * smallest text size, because it is the size text is read at with ease, not the least it can be read at.
 */
export const SIZE_FLOOR = 0.045;

/**
 * The lowest contrast ratio, WCAG 2.2's 3:1 for large-scale text (SC 1.4.3), since text that clears SIZE_FLOOR is
 * large-scale as WCAG measures size, by visual angle: 17 pt (about 1/163 in each) on a phone at about 30 cm subtends
 * about 23.7 CSS reference pixels (1/96 in at 71 cm), past the 18.7 px threshold for bold text, which captions and
 * titles mostly are, and within a pixel of the 24 px for regular.
 */
export const CONTRAST_FLOOR = 3;

/**
 * About one fixation: a failing stretch shorter than this cannot have been read anyway, so it is a passing flash
 * behind the text, not a text shown that way; a text whose whole time on screen fails is reported however short.
 */
export const MIN_SECONDS = 0.25;

// Pixels within this RGB distance of the text's colour are taken as its glyphs: the H.264 encode moves the inside of
// a glyph by a few levels, and anti-aliased edges, which are mixtures, fall outside.
const GLYPH_TOLERANCE = 24;

// A fill more transparent than this moves its glyphs toward what is behind them by more than 9 levels (2% of the 441
// between black and white), too much of GLYPH_TOLERANCE to leave for the encode.
const OPAQUE = 0.98;

// How far around the glyphs, in ems, a stroke, a shadow or a backing is looked for, and the bounds in pixels: at
// least two rings past the anti-aliased edge, and no further than a heavy stroke or a tight shadow reaches on any
// caption size.
const RING_EM = 0.15;
const RING_PX = { min: 2, max: 16 } as const;

// Fewer glyph pixels than this is too few to give their colour a median: the text is covered or not drawn in its colour.
const MIN_GLYPH = { pixels: 6, share: 0.01 } as const;

// A ring of fewer pixels than this is the frame's edge cutting it off, not a surround.
const MIN_RING = 8;

const LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});

/** WCAG's relative luminance of an sRGB colour. */
const luminance = (r: number, g: number, b: number): number => 0.2126 * LINEAR[r] + 0.7152 * LINEAR[g] + 0.0722 * LINEAR[b];

const contrastRatio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

const median = (values: number[]): number => {
  const sorted = Float64Array.from(values).sort();
  return sorted[sorted.length >> 1];
};

/** A decoded picture: RGB, three bytes a pixel, row by row. */
export interface RgbFrame {
  width: number;
  height: number;
  rgb: Uint8Array;
}

/**
 * The contrast of one text against what is around its glyphs, or null when that cannot be measured: its colour is
 * not found in its box (covered, or drawn otherwise), or nothing around the glyphs is in the frame. The glyphs are
 * the box's pixels in the text's colour; each ring of pixels at one distance from them is judged by its median, and
 * the best ring counts, so a stroke, a shadow or a backing right around the glyphs reads as what makes them stand out.
 */
export function contrastOf(frame: RgbFrame, entry: TextEntry): number | null {
  const { width: W, height: H, rgb } = frame;
  const [bx, by, bw, bh] = entry.box;
  const x0 = Math.max(0, Math.floor(bx));
  const y0 = Math.max(0, Math.floor(by));
  const x1 = Math.min(W, Math.ceil(bx + bw));
  const y1 = Math.min(H, Math.ceil(by + bh));
  if (x1 <= x0 || y1 <= y0) return null;
  const ring = Math.min(RING_PX.max, Math.max(RING_PX.min, Math.round(entry.fontSize * RING_EM)));
  const rx0 = Math.max(0, x0 - ring);
  const ry0 = Math.max(0, y0 - ring);
  const rw = Math.min(W, x1 + ring) - rx0;
  const rh = Math.min(H, y1 + ring) - ry0;
  const [tr, tg, tb] = entry.color;
  const distance = new Uint8Array(rw * rh).fill(255);
  const queue = new Int32Array(rw * rh);
  let head = 0;
  let tail = 0;
  const glyph: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * W + x) * 3;
      const dr = rgb[p] - tr;
      const dg = rgb[p + 1] - tg;
      const db = rgb[p + 2] - tb;
      if (dr * dr + dg * dg + db * db > GLYPH_TOLERANCE * GLYPH_TOLERANCE) continue;
      const k = (y - ry0) * rw + (x - rx0);
      distance[k] = 0;
      queue[tail++] = k;
      glyph.push(luminance(rgb[p], rgb[p + 1], rgb[p + 2]));
    }
  }
  if (glyph.length < Math.max(MIN_GLYPH.pixels, MIN_GLYPH.share * (x1 - x0) * (y1 - y0))) return null;
  const rings: number[][] = Array.from({ length: ring + 1 }, () => []);
  while (head < tail) {
    const k = queue[head++];
    const d = distance[k] + 1;
    if (d > ring) continue;
    const x = k % rw;
    const y = (k - x) / rw;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
        const n = ny * rw + nx;
        if (distance[n] <= d) continue;
        distance[n] = d;
        queue[tail++] = n;
        const p = ((ny + ry0) * W + nx + rx0) * 3;
        rings[d].push(luminance(rgb[p], rgb[p + 1], rgb[p + 2]));
      }
    }
  }
  const glyphLuminance = median(glyph);
  const judged = rings.slice(1).filter((r) => r.length >= MIN_RING);
  return judged.length ? Math.max(...judged.map((r) => contrastRatio(glyphLuminance, median(r)))) : null;
}

/** The sampled frames of `video` in order, as the record numbers them, each handed to `each` before the next is decoded. */
async function eachSampledFrame(video: string, record: TextRecord, each: (index: number, frame: RgbFrame) => void): Promise<void> {
  const { width, height, framesPerSample } = record;
  const size = width * height * 3;
  // The render's own conversion, BT.709 limited range, read back to the sRGB the record's colours are in.
  const ffmpeg = spawn(FFMPEG, ['-v', 'error', '-i', video, '-map', '0:v:0', '-an',
    '-vf', `select=not(mod(n\\,${framesPerSample})),scale=in_color_matrix=bt709:in_range=tv,format=rgb24`,
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  ffmpeg.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>((done, fail) => {
    ffmpeg.on('error', fail);
    ffmpeg.on('close', done);
  });
  // Awaited only after the frames, so a spawn that fails at once must not reject with nothing listening.
  exited.catch(() => {});
  const rgb = new Uint8Array(size);
  let filled = 0;
  let index = 0;
  for await (const chunk of ffmpeg.stdout as AsyncIterable<Buffer>) {
    let at = 0;
    while (at < chunk.length) {
      const take = Math.min(size - filled, chunk.length - at);
      rgb.set(chunk.subarray(at, at + take), filled);
      filled += take;
      at += take;
      if (filled === size) {
        if (index < record.samples.length) each(index, { width, height, rgb });
        index++;
        filled = 0;
      }
    }
  }
  const code = await exited;
  if (code !== 0) throw new Error(`ffmpeg could not decode the frames of ${video}`, { cause: { stderr } });
  if (index !== record.samples.length) {
    throw new Error(`${video} decodes to ${index} sampled frame(s) where its text record has ${record.samples.length}`);
  }
}

interface Run {
  selector: string;
  text: string;
  /** Sample indices, consecutive. */
  first: number;
  last: number;
  entries: TextEntry[];
}

/** Each text's stretches on screen: the same element showing the same words in consecutive samples. */
function runsOf(record: TextRecord): Run[] {
  const done: Run[] = [];
  let open = new Map<string, Run>();
  record.samples.forEach((sample, k) => {
    const next = new Map<string, Run>();
    for (const entry of sample.texts) {
      const key = `${entry.selector}\u0000${entry.text}`;
      const run = open.get(key) ?? { selector: entry.selector, text: entry.text, first: k, last: k, entries: [] };
      run.last = k;
      run.entries.push(entry);
      next.set(key, run);
    }
    for (const [key, run] of open) if (!next.has(key)) done.push(run);
    open = next;
  });
  done.push(...open.values());
  return done;
}

interface Finding {
  selector: string;
  text: string;
  /** Sample indices. */
  first: number;
  last: number;
  value: number;
  /** Where the text stood when the stretch began, and its size, to join letters set one element each. */
  box: TextEntry['box'];
  fontSize: number;
}

/**
 * Letters set one element each are reported as the text they spell, not one by one: the single-letter findings under
 * one parent are joined in reading order, a space where they stand a word apart, over all their times, with `pick` of
 * their values (a size at its largest, a contrast at its lowest).
 */
function merged(findings: Finding[], pick: (a: number, b: number) => number): Finding[] {
  const letters = new Map<string, Finding[]>();
  const out: Finding[] = [];
  for (const f of findings) {
    if ([...f.text].length !== 1) {
      out.push(f);
      continue;
    }
    const parent = f.selector.replace(/>[^>]*$/, '');
    const group = letters.get(parent) ?? [];
    group.push(f);
    letters.set(parent, group);
  }
  const sameLine = (a: Finding, b: Finding) => Math.abs(a.box[1] - b.box[1]) < Math.max(a.fontSize, b.fontSize) / 2;
  for (const group of letters.values()) {
    const order = [...group].sort((a, b) => (sameLine(a, b) ? a.box[0] - b.box[0] : a.box[1] - b.box[1]));
    const text = order.map((f, i) => {
      const before = order[i - 1];
      if (!before) return f.text;
      const apart = !sameLine(before, f) || f.box[0] - (before.box[0] + before.box[2]) >= 0.15 * Math.max(before.fontSize, f.fontSize);
      return (apart ? ' ' : '') + f.text;
    }).join('');
    out.push({
      ...order[0], text, first: Math.min(...group.map((f) => f.first)), last: Math.max(...group.map((f) => f.last)),
      value: group.map((f) => f.value).reduce((a, b) => pick(a, b)),
    });
  }
  return out;
}

/** The contrast of each text at each sampled frame it is on screen, and what could not be measured. */
async function contrastsOf(video: string, record: TextRecord, runs: Run[]):
  Promise<{ values: (number | null)[][]; measured: Set<Run>; skipped: string[] }> {
  const values = runs.map((run) => Array<number | null>(run.last - run.first + 1).fill(null));
  const due = new Map<number, { run: number; entry: TextEntry }[]>();
  let unfilled = 0;
  let faint = 0;
  runs.forEach((run, r) => run.entries.forEach((entry, i) => {
    if (entry.color[3] === 0) unfilled++;
    else if (entry.color[3] * entry.opacity < OPAQUE) faint++;
    else {
      const list = due.get(run.first + i) ?? [];
      list.push({ run: r, entry });
      due.set(run.first + i, list);
    }
  }));
  const measured = new Set<Run>();
  let unseen = 0;
  if (due.size) {
    await eachSampledFrame(video, record, (index, frame) => {
      for (const { run, entry } of due.get(index) ?? []) {
        const value = contrastOf(frame, entry);
        if (value === null) unseen++;
        else measured.add(runs[run]);
        values[run][index - runs[run].first] = value;
      }
    });
  }
  const skipped: string[] = [];
  if (unfilled) skipped.push(`the contrast of ${unfilled} text sample(s) drawn without a solid fill of their own (a gradient or picture clipped to the text, or only a stroke or a shadow)`);
  if (faint) skipped.push(`the contrast of ${faint} text sample(s) under ${OPAQUE * 100}% opaque, whose glyphs cannot be told by their colour`);
  if (unseen) skipped.push(`the contrast of ${unseen} text sample(s) whose colour is not in their box, as when something is drawn over them, or with nothing around them in the frame`);
  return { values, measured, skipped };
}

export async function judgeText(video: string, { path, record }: Found<TextRecordInput>): Promise<CheckReport> {
  const runs = runsOf(record);
  if (runs.length === 0) return skippedFor(`the text: ${path} records no text on screen`);
  const step = sampleSeconds(record);
  const end = recordSeconds(record);
  const span = (f: Finding) => fromTo(timeOf(record, record.samples[f.first].frame), Math.min(end, timeOf(record, record.samples[f.last].frame) + step));

  const shorter = Math.min(record.width, record.height);
  const floor = SIZE_FLOOR * shorter;
  const small: Finding[] = [];
  for (const run of runs) {
    // Judged at its largest, so an entrance that grows a text from nothing is not taken for small text.
    const largest = Math.max(...run.entries.map((e) => e.fontSize));
    if (largest < floor) {
      small.push({ selector: run.selector, text: run.text, first: run.first, last: run.last, value: largest, box: run.entries[0].box, fontSize: largest });
    }
  }

  const skipped: string[] = [];
  const low: Finding[] = [];
  let measured = 0;
  if (record.transparent) {
    skipped.push('the contrast: the video is transparent, so what will be behind its text is not in it');
  } else {
    const contrasts = await contrastsOf(video, record, runs);
    skipped.push(...contrasts.skipped);
    measured = contrasts.measured.size;
    const fails = (v: number | null): v is number => v !== null && v < CONTRAST_FLOOR;
    runs.forEach((run, r) => {
      const v = contrasts.values[r];
      for (let k = 0; k < v.length; k++) {
        if (!fails(v[k])) continue;
        let j = k;
        while (j + 1 < v.length && fails(v[j + 1])) j++;
        if ((k === 0 && j === v.length - 1) || (j - k + 1) * step >= MIN_SECONDS - 1e-9) {
          const at = run.entries[k];
          const lowest = Math.min(...(v.slice(k, j + 1) as number[]));
          low.push({ selector: run.selector, text: run.text, first: run.first + k, last: run.first + j, value: lowest, box: at.box, fontSize: at.fontSize });
        }
        k = j;
      }
    });
  }

  const lines: string[] = [];
  if (small.length) {
    const found = merged(small, Math.max);
    lines.push(`${found.length} text(s) under ${floor.toFixed(0)}px, ${SIZE_FLOOR * 100}% of the frame's ${shorter}px shorter side, smaller than a phone's body text:`);
    lines.push(...listed(found.map((f) => ({ start: f.first, line: `${quoted(f.text)} is ${f.value.toFixed(0)}px ${span(f)}` }))));
  }
  if (low.length) {
    const found = merged(low, Math.min);
    lines.push(`${found.length} time(s) a text is under ${CONTRAST_FLOOR}:1 contrast with what is behind it, measured on the video's pixels:`);
    lines.push(...listed(found.map((f) => ({ start: f.first, line: `${quoted(f.text)} is ${f.value.toFixed(1)}:1 against what is behind it ${span(f)}` }))));
  }
  if (lines.length) return { verdict: 'found', lines, skipped };
  const contrast = measured ? `, and the ${measured} measured at least ${CONTRAST_FLOOR}:1 against what is behind them` : '';
  lines.push(`all ${runs.length} text(s) at least ${floor.toFixed(0)}px${contrast}, over ${record.samples.length} sampled frames`);
  return { verdict: 'pass', lines, skipped };
}

export async function measureText({ video, textRecord }: ReviewContext): Promise<CheckReport> {
  if ('missing' in textRecord) return skippedFor(`the text: ${textRecord.missing}`);
  return judgeText(video, textRecord);
}
