// The captions check: stretches of speech with no caption on screen, in a video the page captions. Nothing on the
// page is marked as a caption: a text is one when it shows the words spoken while it is up, or, in another language
// than the voice, when it is one of a run of texts in one place that each hold for a phrase while words are spoken.
import type { TextEntry, TextRecord } from '../render/text-record.ts';
import { recordSeconds, sampleSeconds, timeOf } from '../render/text-record.ts';
import type { CheckReport, Found, ReviewContext, TextRecordInput, TranscriptInput } from './checks.ts';
import { TAIL_SECONDS } from './dead-tail.ts';
import { fromTo, quoted, seconds, skippedFor } from './report.ts';

/**
 * How short and how long one caption holds, from subtitling practice (Netflix's timed text style guide: at least
 * 5/6 s, at most 7 s per event), the lower end taken down to half a second for captions paced faster than subtitles.
 */
export const HOLD = { min: 0.5, max: 7 } as const;

/** A caption in another language is told by its rhythm only, so it takes this many phrases in a row to count. */
export const PHRASES_IN_STEP = 3;

/**
 * Speech uncaptioned for less than this is timing, a caption up a beat late or cleared a beat early, not a caption
 * missing; a silence this long also ends one uncaptioned stretch and starts the next. It is the dead-tail check's
 * second, where a silence starts to read as something gone wrong.
 */
export const MIN_UNCAPTIONED = TAIL_SECONDS;

/**
 * A video is taken as captioned when captions are up for at least this share of its spoken words; below it, a text
 * that matches the speech is a title echoing a line, not a caption track. A judgement, not a measurement.
 */
export const CAPTIONED_SHARE = 1 / 3;

// The longest empty stretch between two phrases of one caption track; texts further apart start a new run. It does not
// tell back-to-back cards from captions: three or more cards in one place, each up for a phrase of speech, count.
const NEXT_PHRASE = 1.5;

// A caption may come and go a beat ahead of its words, so words said up to this long after it leaves still count as its own.
const EARLY = 1;

/** Words for matching: lower case, accents dropped, split at anything that is not a letter or a digit. */
export const tokensOf = (text: string): string[] =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Left, top, right, bottom. */
type Edges = [number, number, number, number];

interface Block {
  text: string;
  tokens: string[];
  edges: Edges;
}

const edgesOf = (e: TextEntry): Edges => [e.box[0], e.box[1], e.box[0] + e.box[2], e.box[1] + e.box[3]];

/**
 * A frame's texts gathered into blocks as a reader would see them: texts on one line close enough to be one phrase,
 * and lines of one size stacked one under the next. A caption laid out one element per word, or per letter, reads as
 * its whole phrase.
 */
export function blocksOf(texts: TextEntry[]): Block[] {
  const parent = texts.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const edges = texts.map(edgesOf);
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const [a, b] = [edges[i], edges[j]];
      const em = Math.max(texts[i].fontSize, texts[j].fontSize);
      const across = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
      const down = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
      const sameLine = down >= 0.5 * Math.min(a[3] - a[1], b[3] - b[1]) && -across <= em;
      const sizes = em / Math.max(0.1, Math.min(texts[i].fontSize, texts[j].fontSize));
      const stacked = across > 0 && -down <= 0.8 * em && sizes <= 1.5;
      if (sameLine || stacked) parent[root(i)] = root(j);
    }
  }
  const groups = new Map<number, number[]>();
  texts.forEach((_, i) => {
    const group = groups.get(root(i)) ?? [];
    group.push(i);
    groups.set(root(i), group);
  });
  return [...groups.values()].map((members) => {
    const byMiddle = [...members].sort((i, j) => (edges[i][1] + edges[i][3]) - (edges[j][1] + edges[j][3]));
    const lines: number[][] = [];
    for (const i of byMiddle) {
      const line = lines.at(-1);
      const ref = line && edges[line[0]];
      const mid = (edges[i][1] + edges[i][3]) / 2;
      if (ref && Math.abs(mid - (ref[1] + ref[3]) / 2) < 0.5 * Math.min(ref[3] - ref[1], edges[i][3] - edges[i][1])) line.push(i);
      else lines.push([i]);
    }
    // Pieces set closer than a word space are one word, as letters set one element each are.
    const text = lines.map((line) => line.sort((i, j) => edges[i][0] - edges[j][0]).reduce((said, i, k) => {
      if (k === 0) return texts[i].text;
      const gap = edges[i][0] - edges[line[k - 1]][2];
      return said + (gap < 0.15 * Math.max(texts[i].fontSize, texts[line[k - 1]].fontSize) ? '' : ' ') + texts[i].text;
    }, '')).join(' ');
    const all = members.map((i) => edges[i]);
    return {
      text,
      tokens: tokensOf(text),
      edges: [Math.min(...all.map((b) => b[0])), Math.min(...all.map((b) => b[1])), Math.max(...all.map((b) => b[2])), Math.max(...all.map((b) => b[3]))],
    };
  });
}

/** One block of text on screen without a break: the same words, in about the same place, sample after sample. */
interface Shown {
  text: string;
  tokens: string[];
  start: number;
  end: number;
  /** Where it was last seen. */
  edges: Edges;
}

const near = (a: Edges, b: Edges): boolean => {
  const slack = 0.5 * Math.min(a[3] - a[1], b[3] - b[1]);
  return a[0] - slack < b[2] && b[0] - slack < a[2] && a[1] - slack < b[3] && b[1] - slack < a[3];
};

/** Every text a reader could read in the video, with when it was up: blocks with at least one letter in them. */
function shownTexts(record: TextRecord): Shown[] {
  const step = sampleSeconds(record);
  const done: Shown[] = [];
  let open: { shown: Shown; key: string }[] = [];
  for (const sample of record.samples) {
    const t = timeOf(record, sample.frame);
    const next: typeof open = [];
    for (const block of blocksOf(sample.texts)) {
      if (!/\p{L}/u.test(block.text)) continue;
      const key = block.tokens.join(' ');
      const at = open.findIndex((o) => o.key === key && near(o.shown.edges, block.edges));
      if (at >= 0) {
        const [o] = open.splice(at, 1);
        o.shown.end = t + step;
        o.shown.edges = block.edges;
        next.push(o);
      } else {
        next.push({ shown: { text: block.text, tokens: block.tokens, start: t, end: t + step, edges: block.edges }, key });
      }
    }
    done.push(...open.map((o) => o.shown));
    open = next;
  }
  done.push(...open.map((o) => o.shown));
  return done.sort((a, b) => a.start - b.start);
}

interface Word {
  text: string;
  tokens: string[];
  start: number;
  end: number;
}

function wordsOf(transcript: Found<TranscriptInput>['transcript'], before: number): Word[] {
  return transcript.chunks.flatMap((c) => c.words)
    .map((w) => ({ text: w.text.trim(), tokens: tokensOf(w.text), start: w.timestamp[0], end: Math.max(w.timestamp[0], w.timestamp[1]) }))
    .filter((w) => w.tokens.length > 0 && w.start < before)
    .sort((a, b) => a.start - b.start);
}

const spokenDuring = (words: Word[], from: number, to: number) => words.filter((w) => (w.start + w.end) / 2 >= from && (w.start + w.end) / 2 < to);

/**
 * Whether a text shows the words spoken while it is up: most of those words are in it, and most of its own words were
 * spoken around then (as early as a caption may hold, for one that builds up a word at a time).
 */
function showsTheWords(shown: Shown, words: Word[]): boolean {
  const spoken = spokenDuring(words, shown.start, shown.end);
  if (spoken.length === 0) return false;
  const own = new Set(shown.tokens);
  const heard = spoken.filter((w) => w.tokens.some((t) => own.has(t))).length;
  const around = new Set(words.filter((w) => w.end >= shown.start - HOLD.max && w.start <= shown.end + EARLY).flatMap((w) => w.tokens));
  const said = shown.tokens.filter((t) => around.has(t)).length;
  return heard >= spoken.length / 2 && said >= shown.tokens.length / 2;
}

/**
 * The texts in runs of at least PHRASES_IN_STEP different texts in one place, each held as long as a caption is while
 * words are spoken (or showing those words), each following the last within NEXT_PHRASE.
 */
function inStep(shown: Shown[], byWords: Set<Shown>, words: Word[], step: number): Shown[] {
  const paced = shown.filter((c) => byWords.has(c)
    || (c.end - c.start >= HOLD.min - 1e-9 && c.end - c.start <= HOLD.max + 1e-9 && spokenDuring(words, c.start, c.end).length > 0));
  const runs: Shown[][] = [];
  for (const c of paced) {
    let best: Shown[] | null = null;
    for (const run of runs) {
      const last = run.at(-1)!;
      const gap = c.start - last.end;
      // Half a sample of overlap is one text giving way to the next on the frame they share.
      if (gap < -step / 2 || gap > NEXT_PHRASE || last.tokens.join(' ') === c.tokens.join(' ') || !near(last.edges, c.edges)) continue;
      if (!best || last.end > best.at(-1)!.end) best = run;
    }
    if (best) best.push(c);
    else runs.push([c]);
  }
  return runs.filter((run) => run.length >= PHRASES_IN_STEP).flat();
}

export function judgeCaptions({ path, record }: Found<TextRecordInput>, transcript: Found<TranscriptInput>): CheckReport {
  const words = wordsOf(transcript.transcript, recordSeconds(record));
  if (words.length === 0) return skippedFor(`the speech: ${transcript.path} holds no words within the video`);
  const shown = shownTexts(record);
  const byWords = new Set(shown.filter((t) => showsTheWords(t, words)));
  const captions = new Set([...byWords, ...inStep(shown, byWords, words, sampleSeconds(record))]);
  const covered = (w: Word) => [...captions].some((c) => c.start < w.end + 1e-9 && c.end > w.start);
  const share = words.filter(covered).length / words.length;
  if (share < CAPTIONED_SHARE) {
    const why = captions.size ? `captions are up for ${Math.round(share * 100)}% of the spoken words, too few for the page to be captioning the speech`
      : 'no text the page draws shows the words spoken while it is up or changes in step with them';
    return skippedFor(`the captions: ${why}, so there are none to check (${path})`);
  }
  // Uncaptioned words in a row, split at a silence long enough to separate two stretches.
  const stretches: Word[][] = [];
  let run: Word[] = [];
  for (const w of words) {
    const last = run.at(-1);
    const isCovered = covered(w);
    if (isCovered || (last && w.start - last.end >= MIN_UNCAPTIONED)) {
      if (run.length) stretches.push(run);
      run = isCovered ? [] : [w];
    } else {
      run.push(w);
    }
  }
  if (run.length) stretches.push(run);
  const missing = stretches.filter((r) => r.at(-1)!.end - r[0].start >= MIN_UNCAPTIONED);
  const kinds = `${byWords.size} showing the words spoken, ${captions.size - byWords.size} changing in step with them`;
  if (missing.length === 0) {
    return { verdict: 'pass', lines: [`every stretch of speech has a caption on screen: ${captions.size} caption text(s), ${kinds}`, `the words: ${transcript.path}`], skipped: [] };
  }
  const total = missing.reduce((sum, r) => sum + r.at(-1)!.end - r[0].start, 0);
  return {
    verdict: 'found',
    lines: [
      `${missing.length} stretch(es) of speech with no caption on screen, ${seconds(total)} in all, in a video whose other speech is captioned (${kinds}):`,
      ...missing.map((r) => `${fromTo(r[0].start, r.at(-1)!.end)}, while ${quoted(r.map((w) => w.text).join(' '))} is said`),
      `the words: ${transcript.path}`,
    ],
    skipped: [],
  };
}

export function measureCaptions({ textRecord, transcript }: ReviewContext): CheckReport {
  const skipped: string[] = [];
  if ('missing' in textRecord) skipped.push(`the text: ${textRecord.missing}`);
  if ('missing' in transcript) skipped.push(`the speech: ${transcript.missing}`);
  if ('missing' in textRecord || 'missing' in transcript) return skippedFor(...skipped);
  return judgeCaptions(textRecord, transcript);
}
