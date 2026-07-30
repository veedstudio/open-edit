// Maps VEED transcription output into the editor's on-disk transcript shape
// ({ text, chunks:[{ text, timestamp:[startSec,endSec] }] }) that pipeline/scripts/extract-beat-frames.ts
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

// Per-word timing, mirroring the chunk's { text, timestamp } shape. Present when the
// API returns word-level from/to (it does); enables true word-level animation
// instead of even-splitting a cue window.
export interface TranscriptWord {
  text: string;
  timestamp: [number, number];
}

export interface TranscriptChunk {
  text: string;
  timestamp: [number, number];
  words: TranscriptWord[];
}

export interface Transcript {
  text: string;
  chunks: TranscriptChunk[];
}

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
