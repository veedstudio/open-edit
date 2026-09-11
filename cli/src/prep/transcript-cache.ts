// Where a transcript lives, whether one is already there, and how many words it holds — shared by
// every route that writes `runs/<key>/transcript.json`. The guard protects a RETIMED transcript:
// overwriting it with a fresh alignment of the source silently restores the drift the retime removed.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runsDir } from '../config.ts';
import { runKeyOf } from '../resolve-video.ts';
import type { Transcript } from './transcript-types.ts';

export function transcriptPathFor(video: string): string {
  return join(runsDir(), runKeyOf(video), 'transcript.json');
}

/** The transcript already on disk for this video, or null. */
export function cachedTranscriptPath(video: string): string | null {
  const path = transcriptPathFor(video);
  return existsSync(path) ? path : null;
}

export function cachedNote(path: string): string {
  return `${path} already exists (--force to transcribe it again)`;
}

export function wordCount(transcript: Transcript): number {
  return transcript.chunks.reduce((n, c) => n + c.words.length, 0);
}

/**
 * A run key is a basename without its extension, so `a/clip.mp4` and `b/clip.mp4` name the SAME
 * transcript. Left alone the second is skipped as already-transcribed and handed the first one's
 * words; transcribed at the same time, both upload and one of the two paid results is overwritten.
 * Returns the first colliding key and its videos, or null when the set is safe.
 */
export function collidingRunKey(videos: string[]): { key: string; videos: string[] } | null {
  const byKey = new Map<string, string[]>();
  for (const video of videos) {
    const key = runKeyOf(video);
    byKey.set(key, [...(byKey.get(key) ?? []), video]);
  }
  for (const [key, group] of byKey) {
    if (group.length > 1) return { key, videos: group };
  }
  return null;
}
