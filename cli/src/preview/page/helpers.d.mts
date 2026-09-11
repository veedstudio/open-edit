// Declarations for helpers.mjs (kept plain JS so the preview page loads it directly).

export interface CueChunk {
  timestamp: number[]; // [startSec, endSec]
  text?: string;
  words?: unknown[];
}

export function chunkIndexAtTime(chunks: CueChunk[], tSec: number): number;
export function nextCueTime(chunks: CueChunk[], tSec: number): number | null;
export function prevCueTime(chunks: CueChunk[], tSec: number): number;
export function fitWidth(
  availWidth: number,
  availHeight: number,
  videoWidth: number,
  videoHeight: number,
): number;
export function focalFraction(viewportCentre: number, canvasStart: number, canvasSize: number): number;
export function refocusScrollDelta(
  viewportCentre: number,
  canvasStart: number,
  canvasSize: number,
  fraction: number,
): number;
export function rearmDecoder(video: HTMLVideoElement, userAgent?: string): boolean;
export function cueBlockGeometry(
  chunk: CueChunk,
  durationSec: number | undefined,
): { leftPct: number; widthPct: number } | null;
