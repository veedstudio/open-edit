// One clean base frame per beat. Beats ARE the VEED transcript chunks (one per beat); each frame is
// taken at the chunk MID time so the design step composes against the subject framing at the instant the
// line plays. Pure ffmpeg — runs anywhere ffmpeg + the source video exist.
//
// Frames are emitted at HALF the canvas (canvasW/2 × canvasH/2): a fixed half-canvas grid independent of
// the source resolution, so the analysis step reads any coordinate then ×2 to land in canvas space — and
// study costs ~1/4 the image tokens of a full-canvas still.
//
// Importable (prep.ts calls extractBeatFrames) OR runnable:
//   node --import tsx pipeline/scripts/extract-beat-frames.ts <video.mp4> <transcript.json> <outDir> [canvasW canvasH]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FFMPEG } from '../../config.ts';

interface Chunk {
  // [startSec, endSec] of the spoken segment; the beat's render moment is the midpoint.
  timestamp: [number, number];
  text: string;
}
interface Transcript {
  chunks: Chunk[];
}

export function loadChunks(transcriptPath: string): Chunk[] {
  const raw = JSON.parse(readFileSync(transcriptPath, 'utf8')) as Transcript;
  if (!Array.isArray(raw.chunks) || raw.chunks.length === 0) {
    throw new Error(`extract-beat-frames: transcript has no chunks: ${transcriptPath}`);
  }
  raw.chunks.forEach((c, i) => {
    const ts = c.timestamp;
    if (!Array.isArray(ts) || ts.length !== 2 || typeof ts[0] !== 'number' || typeof ts[1] !== 'number') {
      throw new Error(`extract-beat-frames: chunk[${i}] has a malformed timestamp`);
    }
  });
  return raw.chunks;
}

export function extractBeatFrames(video: string, transcriptPath: string, outDir: string, canvasW?: number, canvasH?: number): number {
  const chunks = loadChunks(transcriptPath);
  mkdirSync(outDir, { recursive: true });
  // Half-canvas when canvas dims are given (clean ×2 back to canvas); else half the source's own size.
  const scale = canvasW && canvasH ? `scale=${Math.round(canvasW / 2)}:${Math.round(canvasH / 2)}` : 'scale=iw/2:ih/2';
  chunks.forEach((c, i) => {
    const midSec = (c.timestamp[0] + c.timestamp[1]) / 2;
    const out = join(outDir, `beat-${i + 1}.png`);
    // -ss BEFORE -i = ffmpeg input-seek (fast); -frames:v 1 grabs the single still at that instant.
    execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(midSec), '-i', video, '-frames:v', '1', '-vf', scale, out]);
    console.log(`beat-${i + 1}  mid=${midSec.toFixed(3)}s  ${out}`);
  });
  const grid = canvasW && canvasH ? `half-canvas ${Math.round(canvasW / 2)}x${Math.round(canvasH / 2)} (×2 -> ${canvasW}x${canvasH})` : 'half source size (×2 -> source)';
  console.log(`extracted ${chunks.length} base frames @ ${grid} -> ${outDir}`);
  return chunks.length;
}

function parseArgs(argv: string[]): { video: string; transcript: string; outDir: string; canvasW?: number; canvasH?: number } {
  const [video, transcript, outDir, w, h] = argv;
  if (!video || !transcript || !outDir) {
    throw new Error('usage: node --import tsx pipeline/scripts/extract-beat-frames.ts <video.mp4> <transcript.json> <outDir> [canvasW canvasH]');
  }
  const canvasW = w ? Number(w) : undefined;
  const canvasH = h ? Number(h) : undefined;
  if ((w && !Number.isFinite(canvasW)) || (h && !Number.isFinite(canvasH))) {
    throw new Error(`extract-beat-frames: canvas dims must be numbers, got "${w}" "${h}"`);
  }
  return { video, transcript, outDir, canvasW, canvasH };
}

// Run directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { video, transcript, outDir, canvasW, canvasH } = parseArgs(process.argv.slice(2));
  extractBeatFrames(video, transcript, outDir, canvasW, canvasH);
}
