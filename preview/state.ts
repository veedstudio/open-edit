// Pure "what does the run dir say" derivation for the preview server. Stage machine per the
// design spec: waiting (no transcript+meta yet) → cooking (style cooking) → rendered
// (final/out.mp4 exists and is no older than the final/template.wv it came from). Rendered is
// not a latch: a later edit to the .wv document puts the run back in cooking until the new render lands.
// The preview is read-only in V1 — it displays the transcript and plays the source/render.
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { TranscriptChunk } from '../veed/transcript-mapper.ts';

export type Stage = 'waiting' | 'cooking' | 'rendered';

interface VideoMeta {
  videoPath: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
}

export interface PreviewState {
  key: string;
  stage: Stage;
  chunks: TranscriptChunk[] | null;
  video: VideoMeta | null;
  styleRef: string | null;
  stageStartedAtMs: number | null;
  renderMtimeMs: number | null;
}

// Malformed JSON (e.g. a file caught mid-write) — callers keep their last good state.
export class RunStateError extends Error {}

async function readJson(path: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null; // absent file is a normal stage, not an error
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new RunStateError(`unparseable JSON (mid-write?): ${path}`);
  }
}

async function mtimeMs(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

function isChunk(v: unknown): v is TranscriptChunk {
  const c = v as TranscriptChunk;
  return typeof c?.text === 'string' && Array.isArray(c?.timestamp) && c.timestamp.length === 2;
}

function chunksOf(v: unknown): TranscriptChunk[] | null {
  const t = v as { chunks?: unknown };
  if (!t || !Array.isArray(t.chunks)) return null;
  // All-or-nothing: any invalid chunk means the transcript isn't readable yet, so the page
  // never sees a compacted list whose indices skew from the file.
  return t.chunks.every(isChunk) ? (t.chunks as TranscriptChunk[]) : null;
}

function videoOf(v: unknown): VideoMeta | null {
  const m = v as VideoMeta;
  if (!m || typeof m.videoPath !== 'string') return null;
  if (![m.width, m.height, m.fps, m.durationSec].every((n) => typeof n === 'number')) return null;
  return { videoPath: m.videoPath, width: m.width, height: m.height, fps: m.fps, durationSec: m.durationSec };
}

function styleRefOf(v: unknown): string | null {
  const s = v as { refId?: unknown };
  return typeof s?.refId === 'string' ? s.refId : null;
}

export async function readRunState(runDir: string): Promise<PreviewState> {
  const [transcriptJson, metaJson, styleJson, renderMtimeMs, metaMtime, wvMtimeMs] = await Promise.all([
    readJson(join(runDir, 'transcript.json')),
    readJson(join(runDir, 'meta.json')),
    readJson(join(runDir, 'style.json')),
    mtimeMs(join(runDir, 'final', 'out.mp4')),
    mtimeMs(join(runDir, 'meta.json')),
    mtimeMs(join(runDir, 'final', 'template.wv')),
  ]);

  const chunks = transcriptJson === null ? null : chunksOf(transcriptJson);
  const video = metaJson === null ? null : videoOf(metaJson);
  // A delivered run goes back to work when the user asks for a change: the .wv document is rewritten and
  // re-rendered in place, leaving the render older than its own source. The render stays served
  // and copyable throughout — only the stage regresses.
  const renderIsStale = renderMtimeMs !== null && wvMtimeMs !== null && wvMtimeMs > renderMtimeMs;
  const stage: Stage = renderMtimeMs !== null && !renderIsStale
    ? 'rendered'
    : chunks !== null && video !== null ? 'cooking' : 'waiting';
  const cookingSince = renderIsStale ? wvMtimeMs : metaMtime; // the edit is when this cook began

  return {
    key: basename(runDir),
    stage,
    chunks,
    video,
    styleRef: styleJson === null ? null : styleRefOf(styleJson),
    stageStartedAtMs: stage === 'rendered' ? renderMtimeMs : stage === 'cooking' ? cookingSince : null,
    renderMtimeMs,
  };
}
