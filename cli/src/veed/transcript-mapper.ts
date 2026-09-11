// Maps VEED transcription output into the editor's on-disk transcript shape
// ({ text, chunks:[{ text, timestamp:[startSec,endSec] }] }) that the prep step
// consumes (one chunk = one beat, rendered at the chunk midpoint). VEED returns caption ITEMS keyed in a
// record; this is the only piece of pure logic in the VEED-native transcription path, hence fully tested.

export interface VeedWord {
  value: string;
  from?: number;
  to?: number;
}

// A VEED caption item. from/to are required (seconds) per the transcription API's schema.
export interface VeedItem {
  from: number;
  to: number;
  words: VeedWord[];
}

// VEED returns subtitles as Record<itemId, VeedItem>; key order is NOT guaranteed chronological.
export type VeedSubtitleTrack = Record<string, VeedItem>;

// The output shape is the one transcript.json contract every provider shares.
import type { Transcript, TranscriptChunk, TranscriptWord } from '../prep/transcript-types.ts';

export type { Transcript, TranscriptChunk, TranscriptWord };

export function mapVeedTranscript(subtitles: VeedSubtitleTrack): Transcript {
  const chunks: TranscriptChunk[] = Object.values(subtitles)
    .sort((a, b) => a.from - b.from)
    .map((item) => {
      const words: TranscriptWord[] = item.words
        .filter((w) => w.value.trim() !== '')
        .map((w) => ({ text: w.value.trim(), timestamp: [w.from ?? item.from, w.to ?? item.to] as [number, number] }));
      return {
        text: words.map((w) => w.text).join(' '),
        timestamp: [item.from, item.to] as [number, number],
        words,
      };
    })
    .filter((c) => c.text !== '');
  if (chunks.length === 0) {
    throw new Error('mapVeedTranscript: VEED transcription returned no usable caption items');
  }
  return { text: chunks.map((c) => c.text).join(' '), chunks };
}
