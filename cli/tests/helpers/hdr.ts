// HDR fixtures and the reference the conversion is judged against, both computed here, with nothing but
// filters every ffmpeg build has: the CLI's own conversion is not trusted to check itself, and zscale, which
// could, is missing from stock builds. The reference re-implements the transform from the standards, so a
// change to the CLI's parameters or curve fails the tests.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FFMPEG, FFPROBE } from '../../src/config.ts';
import { SINE, TESTSRC, rawFrame } from './synth.ts';

export type Transfer = 'arib-std-b67' | 'smpte2084';

/** What the CLI must do, written out: BT.2408's reference white, a Mobius knee at 70% of it, a 1000 cd/m2 peak. */
export interface SdrReference { referenceWhite: number; knee: number | null; peak: number }
export const SDR_REFERENCE: SdrReference = { referenceWhite: 203, knee: 0.7, peak: 1000 };
/** Each parameter moved to a neighbouring value, and the same placement clipped: output must be clearly further from these. */
export const SDR_NEIGHBOURS: SdrReference[] = [
  { ...SDR_REFERENCE, referenceWhite: 253 },
  { ...SDR_REFERENCE, knee: 0.6 },
  { ...SDR_REFERENCE, knee: null },
];

/** The primaries an HDR fixture is made in: BT.2100's own, or P3 with a D65 white, as some HDR10 masters carry. */
export type Primaries = 'bt2020' | 'smpte432';

// Linear RGB to BT.709's and from it: ITU-R BT.2087's matrices for BT.2020, and for P3-D65 the same derivation
// from SMPTE EG 432-1's primaries.
const TO_709: Record<Primaries, number[][]> = {
  bt2020: [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]],
  smpte432: [[1.2249, -0.2249, 0], [-0.0421, 1.0421, 0], [-0.0196, -0.0786, 1.0983]],
};
const FROM_709: Record<Primaries, number[][]> = {
  bt2020: [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.0880, 0.8956]],
  smpte432: [[0.8225, 0.1775, 0], [0.0332, 0.9668, 0], [0.0171, 0.0724, 0.9105]],
};
const apply = (m: number[][], v: number[]) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);

const PQ = { m1: 2610 / 16384, m2: (2523 / 4096) * 128, c1: 3424 / 4096, c2: (2413 / 4096) * 32, c3: (2392 / 4096) * 32 };
const pqNits = (e: number) => {
  const p = Math.max(e, 0) ** (1 / PQ.m2);
  return 10000 * (Math.max(p - PQ.c1, 0) / (PQ.c2 - PQ.c3 * p)) ** (1 / PQ.m1);
};
const pqSignal = (nits: number) => {
  const y = Math.min(Math.max(nits / 10000, 0), 1) ** PQ.m1;
  return ((PQ.c1 + PQ.c2 * y) / (1 + PQ.c3 * y)) ** PQ.m2;
};
const HLG = { a: 0.17883277, b: 1 - 4 * 0.17883277, c: 0.5 - 0.17883277 * Math.log(4 * 0.17883277) };
// The system gamma on each channel, on a 1000 cd/m2 display, as the CLI applies it.
const hlgNits = (e: number) => {
  const x = Math.max(e, 0);
  return 1000 * (x <= 0.5 ? (x * x) / 3 : (Math.exp((x - HLG.c) / HLG.a) + HLG.b) / 12) ** 1.2;
};
const hlgSignal = (nits: number) => {
  const s = Math.min(Math.max(nits / 1000, 0), 1) ** (1 / 1.2);
  return s <= 1 / 12 ? Math.sqrt(3 * s) : HLG.a * Math.log(12 * s - HLG.b) + HLG.c;
};

function mobius(x: number, j: number, peak: number): number {
  if (x <= j) return x;
  const a = (-j * j * (peak - 1)) / (j * j - 2 * j + peak);
  const b = (j * j - 2 * j * peak + peak) / (peak - 1);
  return (((b * b + 2 * b * j + j * j) / (b - a)) * (x + a)) / (x + b);
}

/** An HDR R'G'B' value, 0..1, to the BT.709 SDR R'G'B' the reference says it becomes. */
export function referenceSdr(transfer: Transfer, p: SdrReference, rgb: number[], primaries: Primaries = 'bt2020'): number[] {
  const nits = rgb.map(transfer === 'smpte2084' ? pqNits : hlgNits);
  const lin = apply(TO_709[primaries], nits).map((v) => v / p.referenceWhite);
  if (p.knee !== null) {
    const top = Math.max(...lin, 1e-6);
    const k = mobius(top, p.knee, p.peak / p.referenceWhite) / top;
    for (let i = 0; i < 3; i++) lin[i] *= k;
  }
  return lin.map((v) => Math.min(Math.max(v, 0), 1) ** (1 / 2.4));
}

/** An SDR BT.709 R'G'B' value placed in HDR as BT.2408 places it: SDR white at 203 cd/m2. */
function lift(transfer: Transfer, rgb: number[], primaries: Primaries): number[] {
  const nits = apply(FROM_709[primaries], rgb.map((v) => v ** 2.4 * 203));
  return nits.map(transfer === 'smpte2084' ? pqSignal : hlgSignal);
}

export interface HdrClipSpec {
  transfer: Transfer;
  primaries?: Primaries;
  /** An SDR lavfi source naming its size and rate, lifted into HDR. */
  video?: string;
  seconds?: number;
  /** A lavfi audio source, or null for none. */
  audio?: string | null;
  audioArgs?: string[];
  /** All three tags, or the transfer alone, as a transcode that dropped the rest leaves it. */
  tags?: 'all' | 'transfer';
  /** Frames between keyframes. */
  gop?: number;
  /** HDR10 mastering and light-level boxes in the MP4's sample entry, where a camera's file carries them. */
  hdr10?: boolean;
  /** The encoded pixel format, `yuv420p` unless given: `yuv420p10le` for a 10-bit clip, as cameras record HDR. */
  pixFmt?: string;
}

/** An HDR clip, H.264 so every build can make it, from an SDR test pattern. */
export function hdrClip(dir: string, name: string, o: HdrClipSpec): string {
  const video = o.video ?? TESTSRC;
  const size = /size=(\d+)x(\d+)/.exec(video);
  const rate = /rate=(\d+)/.exec(video);
  if (!size || !rate) throw new Error(`name the size and rate in ${video}`);
  const seconds = String(o.seconds ?? 1);
  const sdr = execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', video, '-t', seconds, '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-'],
    { maxBuffer: 1 << 29 });
  const hdr = Buffer.alloc(sdr.length);
  for (let i = 0; i < sdr.length; i += 6) {
    const out = lift(o.transfer, [sdr.readUInt16LE(i) / 65535, sdr.readUInt16LE(i + 2) / 65535, sdr.readUInt16LE(i + 4) / 65535], o.primaries ?? 'bt2020');
    for (let c = 0; c < 3; c++) hdr.writeUInt16LE(Math.round(out[c] * 65535), i + 2 * c);
  }
  const tags = o.tags === 'transfer'
    ? `color_primaries=unknown:color_trc=${o.transfer}:colorspace=unknown`
    : `color_primaries=${o.primaries ?? 'bt2020'}:color_trc=${o.transfer}:colorspace=bt2020nc`;
  const audio = o.audio === null ? [] : ['-f', 'lavfi', '-i', o.audio ?? SINE];
  const path = join(dir, name);
  // The frames go through a file, not stdin: a synchronous child fed megabytes on a pipe has been seen to stall
  // with ffmpeg waiting in read() for the rest.
  const raw = `${path}.rgb48`;
  writeFileSync(raw, hdr);
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-s', `${size[1]}x${size[2]}`, '-r', rate[1], '-i', raw,
    ...audio, '-t', seconds, '-vf', `scale=out_color_matrix=bt2020:out_range=tv,format=${o.pixFmt ?? 'yuv420p'},setparams=${tags}:range=tv`,
    '-c:v', 'libx264', '-pix_fmt', o.pixFmt ?? 'yuv420p', ...(o.gop ? ['-g', String(o.gop)] : []),
    ...(o.audio === null ? [] : o.audioArgs ?? ['-c:a', 'aac']), path], { stdio: ['ignore', 'ignore', 'pipe'] });
  rmSync(raw);
  if (o.hdr10) withHdr10Boxes(path);
  return path;
}

/** One box: its type and where it and its payload lie. */
interface Box { type: string; start: number; end: number }

function children(buf: Buffer, start: number, end: number): Box[] {
  const out: Box[] = [];
  for (let at = start; at + 8 <= end;) {
    const size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const length = size === 1 ? Number(buf.readBigUInt64BE(at + 8)) : size === 0 ? end - at : size;
    out.push({ type, start: at, end: at + length });
    at += length;
  }
  return out;
}

const box = (type: string, payload: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
};

/**
 * Adds 'mdcv' (mastering display) and 'clli' (content light level) to the video sample entry of an MP4 whose
 * index follows its media, as ffmpeg writes one, so no chunk offset moves. ffmpeg reads them back as the
 * stream's own HDR10 metadata; no encoder every build has will write them.
 */
export function withHdr10Boxes(path: string): void {
  const buf = readFileSync(path);
  const top = children(buf, 0, buf.length);
  const moov = top.find((b) => b.type === 'moov');
  const mdat = top.find((b) => b.type === 'mdat');
  if (!moov || !mdat || moov.start < mdat.start) throw new Error(`${path}: expected the media before the index`);
  const chain: Box[] = [moov];
  const into = (b: Box, type: string) => children(buf, b.start + 8, b.end).filter((c) => c.type === type);
  const trak = into(moov, 'trak').find((t) => {
    const hdlr = into(into(t, 'mdia')[0], 'hdlr')[0];
    return buf.toString('latin1', hdlr.start + 16, hdlr.start + 20) === 'vide';
  })!;
  const mdia = into(trak, 'mdia')[0];
  const minf = into(mdia, 'minf')[0];
  const stbl = into(minf, 'stbl')[0];
  const stsd = into(stbl, 'stsd')[0];
  // stsd is a full box with an entry count; its first entry is the video sample entry.
  const entry = children(buf, stsd.start + 16, stsd.end)[0];
  chain.push(trak, mdia, minf, stbl, stsd, entry);
  const mdcv = Buffer.alloc(24);
  [13250, 34500, 7500, 3000, 34000, 16000, 15635, 16450].forEach((v, i) => mdcv.writeUInt16BE(v, 2 * i));
  mdcv.writeUInt32BE(10000000, 16);
  mdcv.writeUInt32BE(1, 20);
  const clli = Buffer.alloc(4);
  clli.writeUInt16BE(1000, 0);
  clli.writeUInt16BE(400, 2);
  const added = Buffer.concat([box('mdcv', mdcv), box('clli', clli)]);
  for (const b of chain) buf.writeUInt32BE(buf.readUInt32BE(b.start) + added.length, b.start);
  writeFileSync(path, Buffer.concat([buf.subarray(0, entry.end), added, buf.subarray(entry.end)]));
}

/** A video frame's Y plane, limited range, in 8-bit full-range units. */
function yPlane(file: string, index: number): Float64Array {
  const yuv = rawFrame(file, index);
  return Float64Array.from(yuv.subarray(0, (yuv.length * 2) / 3), (y) => ((y - 16) * 255) / 219);
}

/** A frame's luma as BT.709 Y' in 8-bit full-range units: from a video's Y plane, or a still's RGB. */
export function lumaOf(file: string, index: number, kind: 'video' | 'still'): Float64Array {
  if (kind === 'video') return yPlane(file, index);
  const rgb = rawFrame(file, index, undefined, 'rgb24');
  const out = new Float64Array(rgb.length / 3);
  for (let i = 0; i < out.length; i++) out[i] = 0.2126 * rgb[3 * i] + 0.7152 * rgb[3 * i + 1] + 0.0722 * rgb[3 * i + 2];
  return out;
}

/** The luma `source`'s frame becomes under `p`, from its signal as the CLI decodes it, in the units lumaOf reads. */
export function expectedLuma(source: string, index: number, transfer: Transfer, p: SdrReference, primaries: Primaries = 'bt2020'): Float64Array {
  const raw = rawFrame(source, index, 'scale=in_color_matrix=bt2020:in_range=tv:flags=accurate_rnd+full_chroma_int,format=rgb48le', 'rgb48le');
  const out = new Float64Array(raw.length / 6);
  for (let i = 0; i < out.length; i++) {
    const sdr = referenceSdr(transfer, p, [raw.readUInt16LE(6 * i) / 65535, raw.readUInt16LE(6 * i + 2) / 65535, raw.readUInt16LE(6 * i + 4) / 65535], primaries);
    out[i] = 255 * (0.2126 * sdr[0] + 0.7152 * sdr[1] + 0.0722 * sdr[2]);
  }
  return out;
}

/** Mean absolute difference over the pixels whose column is below `columns` of `width`. */
function off(a: Float64Array, b: Float64Array, width: number, columns = width): number {
  if (a.length !== b.length) throw new Error(`frames differ in size: ${a.length} and ${b.length} pixels`);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % width >= columns) continue;
    sum += Math.abs(a[i] - b[i]);
    n++;
  }
  return sum / n;
}

/**
 * Asserts that `got` (lumaOf an output frame) is `source`'s frame converted as SDR_REFERENCE says: within
 * `tolerance` levels of it, clearly further from every neighbour (unless `neighbours` is false, for a
 * picture they barely move), and far from the frame read as SDR unconverted. `columns` keeps the left part
 * of each frame, where the output shows nothing over the footage. A source in other primaries than BT.2020's
 * must also be clearly further from the same frame read as BT.2020.
 */
export function assertConverted(source: string, sourceFrame: number, got: Float64Array,
  o: { transfer: Transfer; primaries?: Primaries; width: number; tolerance: number; columns?: number; neighbours?: false; what: string }): void {
  const primaries = o.primaries ?? 'bt2020';
  const d = (p: SdrReference, as = primaries) => off(got, expectedLuma(source, sourceFrame, o.transfer, p, as), o.width, o.columns);
  const at = d(SDR_REFERENCE);
  if (!(at < o.tolerance)) throw new Error(`${o.what}: ${at.toFixed(2)} levels from the conversion on average, over ${o.tolerance}`);
  const neighbours: [string, number][] = (o.neighbours === false ? [] : SDR_NEIGHBOURS).map((n) => [JSON.stringify(n), d(n)]);
  if (primaries !== 'bt2020') neighbours.push(['its frame read as BT.2020', d(SDR_REFERENCE, 'bt2020')]);
  for (const [name, near] of neighbours) {
    if (!(near > 2 * at && near > 1)) throw new Error(`${o.what}: as close to ${name} (${near.toFixed(2)}) as to the conversion (${at.toFixed(2)})`);
  }
  const raw = off(got, yPlane(source, sourceFrame), o.width, o.columns);
  if (!(raw > Math.max(3, 4 * at))) throw new Error(`${o.what}: only ${raw.toFixed(2)} levels from the frame read as SDR unconverted`);
}

/** HDR10 metadata ffprobe reports on the first video stream, or on its first frame, by type. */
export function hdr10Data(file: string, on: 'stream' | 'frame'): string[] {
  const args = on === 'stream' ? ['-show_entries', 'stream_side_data=side_data_type']
    : ['-show_frames', '-read_intervals', '%+#1', '-show_entries', 'frame_side_data=side_data_type'];
  const parsed = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', ...args, '-of', 'json', file], { encoding: 'utf8' }));
  const list = (on === 'stream' ? parsed.streams : parsed.frames)?.[0]?.side_data_list ?? [];
  return (list as { side_data_type: string }[]).map((s) => s.side_data_type).filter((t) => /Mastering|light level/i.test(t));
}
