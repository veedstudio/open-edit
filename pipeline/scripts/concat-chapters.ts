// Chapters into a film.
//
// A long piece is authored one document per chapter, because one `.wv` holding twelve minutes is a
// document nobody can gate, fix or re-render in part. Each chapter goes through the gate chain and
// lands its own `out.mp4` — and then nothing joined them WITHOUT TRANSCODING. The gate chain says it
// runs "design → lint → verify → record → probe → mux"; that is true of a chapter and stops there.
//
// `concat-videos.ts` also joins mp4s, and is the wrong tool here: it exists for generated clips that
// disagree — different shapes, some without audio — so it re-encodes onto one canvas and normalises the
// frame rate. Engine renders agree by construction, and a twelve-minute film must not be transcoded
// once per assembly, nor have its fps resampled.
//
// The concat demuxer copies streams rather than re-encoding, which is what keeps a twelve-minute film
// from being transcoded once per assembly. It requires every part to share codec parameters — the
// engine renders them identically and `mux-audio.ts` encodes aac for all of them, so they do. That
// requirement is checked rather than assumed: a mismatch here produces a file that plays for one
// chapter and then glitches, which is the kind of defect nobody sees until the whole thing is watched.
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFlags } from '../../veed/args.ts';
import { FFMPEG, FFPROBE } from '../../config.ts';

/** The demuxer's list format. Single quotes in a path are escaped the way ffmpeg expects. */
export function concatList(parts: string[]): string {
  if (!parts.length) throw new Error('concat: no chapters given');
  return parts.map((p) => `file '${resolve(p).replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

export interface StreamShape {
  codec: string;
  width: number;
  height: number;
  fps: string;
  audioCodec: string;
  sampleRate: string;
  channels: number;
}

export function shapeOf(file: string): StreamShape {
  const out = execFileSync(FFPROBE, [
    '-v', 'error', '-show_entries',
    'stream=codec_name,codec_type,width,height,r_frame_rate,sample_rate,channels',
    '-of', 'json', file,
  ], { encoding: 'utf8' });
  const streams = (JSON.parse(out) as { streams: Record<string, unknown>[] }).streams;
  const v = streams.find((s) => s.codec_type === 'video') ?? {};
  const a = streams.find((s) => s.codec_type === 'audio') ?? {};
  return {
    codec: String(v.codec_name ?? ''),
    width: Number(v.width ?? 0),
    height: Number(v.height ?? 0),
    fps: String(v.r_frame_rate ?? ''),
    audioCodec: String(a.codec_name ?? ''),
    sampleRate: String(a.sample_rate ?? ''),
    channels: Number(a.channels ?? 0),
  };
}

/** What differs between two parts, in words a person can act on. */
export function shapeDiff(a: StreamShape, b: StreamShape): string[] {
  const out: string[] = [];
  if (a.codec !== b.codec) out.push(`video codec ${a.codec} vs ${b.codec}`);
  if (a.width !== b.width || a.height !== b.height) out.push(`canvas ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  if (a.fps !== b.fps) out.push(`fps ${a.fps} vs ${b.fps}`);
  if (a.audioCodec !== b.audioCodec) out.push(`audio codec ${a.audioCodec || 'none'} vs ${b.audioCodec || 'none'}`);
  if (a.sampleRate !== b.sampleRate) out.push(`sample rate ${a.sampleRate} vs ${b.sampleRate}`);
  if (a.channels !== b.channels) out.push(`channels ${a.channels} vs ${b.channels}`);
  return out;
}

export function concat(parts: string[], outPath: string, listPath: string): string {
  for (const p of parts) if (!existsSync(p)) throw new Error(`concat: no such chapter render — ${p}`);
  const shapes = parts.map(shapeOf);
  for (let i = 1; i < shapes.length; i++) {
    const d = shapeDiff(shapes[0], shapes[i]);
    if (d.length) {
      throw new Error(
        `concat: ${parts[i]} does not match ${parts[0]} — ${d.join(', ')}. Copying streams needs them ` +
        'identical; re-render the odd chapter at the film\'s canvas and fps rather than transcoding here.',
      );
    }
  }
  mkdirSync(dirname(listPath), { recursive: true });
  writeFileSync(listPath, concatList(parts));
  mkdirSync(dirname(outPath), { recursive: true });
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy', '-movflags', '+faststart', outPath,
  ]);
  return outPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseFlags({
    args: process.argv.slice(2),
    options: { doc: { type: 'string', multiple: true }, out: { type: 'string' } },
    allowPositionals: true,
  });
  const [runDir] = positionals;
  const docs = (values.doc as string[] | undefined) ?? [];
  if (!runDir || !docs.length) {
    console.error('usage: concat-chapters.ts <run-dir> --doc chapters/act-1 --doc chapters/act-2 [...] [--out final/out.mp4]');
    process.exit(2);
  }
  // Order is the order the flags were given. Deriving it from a directory listing would put act-10
  // before act-2, and a film whose chapters play in the wrong order is not a failure anyone notices
  // in a gate.
  const parts = docs.map((d) => join(runDir, d, 'out.mp4'));
  const out = join(runDir, values.out ?? 'final/out.mp4');
  concat(parts, out, join(runDir, 'final', 'concat.txt'));
  console.log(`concat: ${parts.length} chapters → ${out}`);
}
