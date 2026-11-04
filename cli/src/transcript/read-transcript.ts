// Every command that reads a transcript reads it here, so each one takes the same files the whisper command
// maps: a transcript.json as written, or a speech-to-text JSON mapped in memory. A reader that took only
// transcript.json sent agents to convert files by hand that the mapper beside it already reads.
import { readJsonFile } from '../json-file.ts';
import { wordCount } from './transcript-cache.ts';
import type { Transcript } from './transcript-types.ts';
import { mapWhisperTranscript, normaliseWhisperJson, type WhisperJson } from './whisper-mapper.ts';

export interface TranscriptRead {
  transcript: Transcript;
  /** What the file held, in words: `transcript.json`, or the format it was mapped from. */
  format: string;
  /** False for a transcript.json, which is returned exactly as written, a retimed one included. */
  mapped: boolean;
  /** Words given no usable times, whose windows the mapper inferred. */
  interpolated: number;
  /** Words whose times ran backwards and were reordered. */
  reordered: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A transcript.json checked only for the shape arithmetic on its word times touches, so a malformed file is
 * named rather than crashing mid-word. Not the providers' validator: a hosted transcript can carry overlapping
 * items it refuses, and a reader must not be stricter than the provider that wrote it.
 */
function nativeTranscript(raw: Record<string, unknown>, path: string): Transcript {
  const chunks = raw.chunks as unknown[];
  if (chunks.some((c) => !Array.isArray((c as { words?: unknown } | null)?.words))) {
    throw new Error(`${path} is not a transcript.json: expected chunks[] with words[] in each`);
  }
  const isWord = (w: unknown) => {
    const word = w as { text?: unknown; timestamp?: unknown } | null;
    return typeof word?.text === 'string' && Array.isArray(word.timestamp) && word.timestamp.length === 2
      && word.timestamp.every((t) => typeof t === 'number' && Number.isFinite(t));
  };
  if (chunks.some((c) => !(c as { words: unknown[] }).words.every(isWord))) {
    throw new Error(`${path} is not a transcript.json: every word needs text and a [start, end] timestamp in seconds`);
  }
  return raw as unknown as Transcript;
}

/** A parsed file as a transcript, whatever it was; `path` only names the file in an error. */
export function readTranscriptJson(raw: unknown, path: string): TranscriptRead {
  // openedit fal run keeps a model's answer under `response`, beside the model that gave it.
  if (isObject(raw) && typeof raw.model === 'string' && isObject(raw.response)) {
    const inner = readTranscriptJson(raw.response, path);
    return { ...inner, format: `${raw.model}'s response, ${inner.format}`, mapped: true };
  }
  // A transcript.json's chunks carry words; fal's whisper chunks carry only a timestamp. One with no chunks
  // is a transcript of silence either way.
  if (isObject(raw) && Array.isArray(raw.chunks) && (raw.chunks.length === 0 || raw.chunks.some((c) => isObject(c) && 'words' in c))) {
    return { transcript: nativeTranscript(raw, path), format: 'transcript.json', mapped: false, interpolated: 0, reordered: 0 };
  }
  if (!isObject(raw) || normaliseWhisperJson(raw as WhisperJson).format === undefined) {
    throw new Error(
      `${path} is not a transcript: expected a transcript.json (chunks[] with words[]) or speech-to-text JSON with word times ` +
        '(segments[].words, words[], chunks[].timestamp, transcription[].offsets or timestamps[].characters)',
    );
  }
  try {
    const { transcript, format, interpolated, reordered } = mapWhisperTranscript(raw as WhisperJson);
    return { transcript, format, mapped: true, interpolated, reordered };
  } catch (cause) {
    throw new Error(`${path}: ${(cause as Error).message.replace(/^mapWhisperTranscript: /, '')}`, { cause });
  }
}

export function readTranscriptFile(path: string): TranscriptRead {
  return readTranscriptJson(readJsonFile(path), path);
}

/** The one line a reader prints about a file it mapped; a transcript.json read as written gets none. */
export function mappedNote(path: string, read: TranscriptRead): string | undefined {
  if (!read.mapped) return undefined;
  const words = wordCount(read.transcript);
  const untimed = read.interpolated > 0 ? `, ${read.interpolated} of them without times of their own, so interpolated` : '';
  return `${path}: read as ${read.format}, mapped in memory (${words} words${untimed})`;
}
