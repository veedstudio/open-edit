// The on-disk shape of runs/<key>/transcript.json — the seam every transcription
// provider writes and everything downstream reads. Declared here (rather than
// imported) because the artifact, not a module, is the contract between codebases.
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
