// The on-disk shape of runs/<key>/transcript.json — the seam every transcription
// provider writes and everything downstream reads, agent-authored pages included.
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
