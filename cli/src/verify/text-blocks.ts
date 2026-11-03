// A frame's texts as a reader sees them: the record holds each element's own text, so a phrase set one element per
// word or per letter is gathered back into the words it spells. The captions check matches these words against the
// speech, and the dead-tail check counts them to judge how long an end card takes to read.
import type { TextEntry } from '../render/text-record.ts';

/** Words for matching: lower case, accents dropped, split at anything that is not a letter or a digit. */
export const tokensOf = (text: string): string[] =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Left, top, right, bottom. */
export type Edges = [number, number, number, number];

export interface Block {
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
