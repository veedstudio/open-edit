// The numbers check: a number on screen that neither the speech nor the user's own words say, such as a recipe card's
// "Ready in 15 min" over narration of "about 10 minutes" and "about two minutes more". A figure worked out, rounded
// up or guessed while the video was made is what it reports, to be confirmed against the source or taken off.
// Numbers are compared by value, in digits or in English words, so "15 min", "fifteen minutes" and "0:15" agree, and
// a number a viewer would not take for a claim is set aside: a list's own numbering, a clock or a count running in
// one place, one passing too fast to read, and digits that are part of a name.
import type { TextEntry, TextRecord } from '../render/text-record.ts';
import { sampleSeconds, timeOf } from '../render/text-record.ts';
import type { BriefInput, CheckReport, Found, ReviewContext, TextRecordInput, TranscriptInput } from './checks.ts';
import { fromTo, listed, quoted, skippedFor } from './report.ts';
import { MIN_SECONDS } from './text.ts';
import { blocksOf, type Edges } from './text-blocks.ts';

/**
 * A number on screen with at least this many significant digits matches a source value that rounds to it at the
 * precision shown ("33%" for a third, "1.4M" for 1,423,000); one with fewer must match exactly, since a lone "2" is
 * as likely another count as a rounding of 1.5.
 */
export const ROUNDED_DIGITS = 2;

/**
 * An element whose glyphs stand taller than this many font sizes is taken to hold more than one line: two lines clear
 * it even at a tight line height, and a single line passes it only in the tallest script faces. The record runs an
 * element's text together either side of a `<br>`, so there letters running into digits are a line break, not a name.
 */
export const MULTI_LINE = 1.9;

/** The fewest numbers in a row, 1 to n, that make a list's numbering rather than figures. */
export const LIST_RUN = 2;

/** The fewest consecutive whole numbers one element shows for it to be a clock or a count running in place. */
export const COUNTER_RUN = 3;

type Table = Readonly<Record<string, number>>;

const UNITS: Table = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS: Table = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Table = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Table = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
const ORDINALS: Table = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11,
  twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19,
  twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90,
};
const FRACTIONS: Table = { half: 1 / 2, halves: 1 / 2, third: 1 / 3, thirds: 1 / 3, quarter: 1 / 4, quarters: 1 / 4 };
const DECADES: Table = { twenties: 20, thirties: 30, forties: 40, fifties: 50, sixties: 60, seventies: 70, eighties: 80, nineties: 90 };
// Words the speech says for a number that are not number words: a score "to nothing", "a couple of minutes".
const SAID_AS: Table = { nothing: 0, nil: 0, couple: 2, pair: 2, dozen: 12 };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// Glued to a number these letters may scale it (7k, 1.5m) or name a unit (15m of minutes, a 5k run), so both readings count.
const SCALE_LETTERS: Table = { k: 1e3, m: 1e6, mn: 1e6, b: 1e9, bn: 1e9 };
const TIME_UNITS: Readonly<Record<string, 'h' | 'min' | 's'>> = {
  h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h', min: 'min', mins: 'min', minute: 'min', minutes: 'min',
  s: 's', sec: 's', secs: 's', second: 's', seconds: 's',
};
const CENTS = new Set(['cent', 'cents', 'penny', 'pence']);
const CURRENCY = new Set(['$', '€', '£', '¥', '₹']);
const VULGAR: Readonly<Record<string, string>> = { '½': 'a half', '¼': 'a quarter', '¾': 'three quarters', '⅓': 'a third', '⅔': 'two thirds' };
const VIDEO_HEIGHTS = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320];
// Web addresses, e-mail, handles and tags with a letter in them, and 24/7: digits in them name something, they do not count it.
const ADDRESSES = /(?:https?:\/\/|www\.)\S+|\S+@\S+\.\S+|[@#][\p{L}\p{N}_]*\p{L}[\p{L}\p{N}_]*|[\p{L}\p{N}-]+\.(?:com|org|net|io|ai|co|app|tv|me|ly|gg|uk|de|fr|es|it|nl|eu|us|ca|au)\b\S*|\b24\/7\b/giu;

/** A word's value in a table, never one of Object's own properties ("constructor" is no number). */
const of = (table: Table, word: string | null | undefined): number | undefined =>
  (word != null && Object.hasOwn(table, word) ? table[word] : undefined);
const isIn = (table: Table, word: string | null | undefined): word is string => of(table, word) !== undefined;
const timeUnit = (word: string | null | undefined) => (word != null && Object.hasOwn(TIME_UNITS, word) ? TIME_UNITS[word] : null);

/** Fractions spelled out and compatibility forms folded, so "2½" reads "2 and a half", "№" reads "No" and every dash is "-". */
const folded = (text: string): string => text
  .replace(/(\d?)([½¼¾⅓⅔])/g, (_, whole: string, f: string) => ` ${whole}${whole ? ' and ' : ''}${VULGAR[f]} `)
  .normalize('NFKC')
  .replace(/[‐-―−]/g, '-')
  .replace(/⁄/g, '/');

/** A folded text as the parser reads it: lower case and addresses blanked, every character where it was. */
const parsed = (text: string): string => [...text].map((c) => (c.toLowerCase().length === c.length ? c.toLowerCase() : c)).join('')
  .replace(ADDRESSES, (m) => ' '.repeat(m.length));

const normalized = (text: string): string => parsed(folded(text));

interface Token {
  kind: 'num' | 'word' | 'sym';
  text: string;
  at: number;
  end: number;
}

const TOKEN = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)|(\p{L}+)|(\S)/gu;

function tokensOf(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN)) out.push({ kind: m[1] ? 'num' : m[2] ? 'word' : 'sym', text: m[0], at: m.index, end: m.index + m[0].length });
  return out;
}

/** One number as the source may say it: its value, and how far off a source value may be and still be it. */
export interface Reading {
  value: number;
  tolerance: number;
}

/** One number in a text. */
export interface Mention {
  /** As written, with its currency sign and unit, for the report. */
  literal: string;
  /** Its own digits or first word, lower case, to find the element that shows it. */
  core: string;
  /** Every value it may stand for, all of them taken as said when the source says it. */
  values: number[];
  /**
   * On screen, the ways the source may bear it out: it is borne out when every reading of one of them is said. Null
   * for a mention that is no claim on screen: a lone "one", an ordinal or a fraction in words, or a format (1080p, 3D).
   */
  claim: Reading[][] | null;
  /** The word it is part of when letters run into it (MP4, COVID-19): a name, when one element's own text runs them together. */
  name: string | null;
  /** Its first and last token. */
  first: number;
  last: number;
}

const exact = (value: number): Reading => ({ value, tolerance: 1e-9 * Math.max(1, Math.abs(value)) });

/** A number shown to some precision, matched by rounding when it shows ROUNDED_DIGITS significant digits or more. */
function shown(digitsAsWritten: string, value: number, scale: number): Reading {
  const digits = digitsAsWritten.replace(/\D/g, '').replace(/^0+/, '');
  const decimals = digitsAsWritten.includes('.') ? digitsAsWritten.split('.')[1].length : 0;
  return digits.length >= ROUNDED_DIGITS ? { value, tolerance: (10 ** -decimals * scale) / 2 } : exact(value);
}

const glued = (a: Token | undefined, b: Token | undefined): boolean => !!a && !!b && a.end === b.at;
const wordAt = (tokens: Token[], i: number): string | null => (tokens[i]?.kind === 'word' ? tokens[i].text : null);
const scaleAt = (tokens: Token[], i: number): number | undefined => of(SCALES, wordAt(tokens, i));

/** The time unit of the word at `i`, a number's unit when it follows one: "15 min", "two hours"; a lone letter only glued. */
function unitAt(tokens: Token[], i: number): 'h' | 'min' | 's' | null {
  const w = wordAt(tokens, i);
  return w && (w.length > 1 || glued(tokens[i - 1], tokens[i])) ? timeUnit(w) : null;
}

/** A value and the same amount in the neighbouring time units, so "90 minutes" also says 1.5 hours. */
function inUnits(value: number, unit: 'h' | 'min' | 's' | null): number[] {
  if (unit === 'h') return [value, value * 60];
  if (unit === 'min') return [value, value * 60, value / 60];
  if (unit === 's') return [value, value / 60];
  return [value];
}

/** "and a half" or "and a quarter" at token `i`, and the token after it. */
function andAFraction(tokens: Token[], i: number): { add: number; next: number } | null {
  if (wordAt(tokens, i) !== 'and') return null;
  const article = wordAt(tokens, i + 1) === 'a' || wordAt(tokens, i + 1) === 'an' ? 1 : 0;
  const f = wordAt(tokens, i + 1 + article);
  return f === 'half' || f === 'quarter' ? { add: of(FRACTIONS, f)!, next: i + 2 + article } : null;
}

const isPercent = (tokens: Token[], i: number): boolean =>
  tokens[i]?.text === '%' || wordAt(tokens, i) === 'percent' || wordAt(tokens, i) === 'pct' || (wordAt(tokens, i) === 'per' && wordAt(tokens, i + 1) === 'cent');

type Last = 'unit' | 'teen' | 'tens' | 'hundred' | 'scale' | null;

/**
 * A number spelled in English words from token `i`, or null; hyphens join its words ("twenty-five"). `scale` is the
 * scale word it ends on, 1 for none, so "a million and a half" takes half of a million.
 */
function readWords(tokens: Token[], i: number): { value: number; next: number; ordinal: boolean; lone: boolean; scale: number } | null {
  let total = 0;
  let current = 0;
  let last: Last = null;
  let scale = 1;
  let j = i;
  let ordinal = false;
  let words = 0;
  while (j < tokens.length) {
    const t = tokens[j];
    if (t.text === '-' && last === 'tens' && glued(tokens[j - 1], t) && glued(t, tokens[j + 1])) {
      j++;
      continue;
    }
    const w = wordAt(tokens, j);
    const after = wordAt(tokens, j + 1);
    if (isIn(UNITS, w) && (last === null || last === 'hundred' || last === 'scale' || last === 'tens')) {
      current += of(UNITS, w)!;
      last = 'unit';
    } else if ((isIn(TEENS, w) || isIn(TENS, w)) && (last === null || last === 'hundred' || last === 'scale')) {
      current += of(TEENS, w) ?? of(TENS, w)!;
      last = isIn(TEENS, w) ? 'teen' : 'tens';
    } else if (w === 'hundred' && (last === 'unit' || last === 'teen' || last === 'tens') && current < 100) {
      current *= 100;
      last = 'hundred';
    } else if (isIn(SCALES, w) && (last === 'unit' || last === 'teen' || last === 'tens' || last === 'hundred')) {
      scale = of(SCALES, w)!;
      total += current * scale;
      current = 0;
      last = 'scale';
    } else if ((w === 'a' || w === 'an') && last === null && (after === 'hundred' || isIn(SCALES, after))) {
      current = 1;
      last = 'unit';
    } else if (w === 'and' && (last === 'hundred' || last === 'scale') && (isIn(UNITS, after) || isIn(TEENS, after) || isIn(TENS, after))) {
      j++;
      continue;
    } else if (isIn(ORDINALS, w) && (last === null || last === 'hundred' || last === 'scale' || (last === 'tens' && of(ORDINALS, w)! < 10))) {
      current += of(ORDINALS, w)!;
      ordinal = true;
      words++;
      j++;
      break;
    } else {
      break;
    }
    words++;
    j++;
  }
  if (words === 0) return null;
  let value = total + current;
  if (!ordinal && last !== null && wordAt(tokens, j) === 'point') {
    let digits = '';
    while (isIn(UNITS, wordAt(tokens, j + 1 + digits.length))) digits += of(UNITS, wordAt(tokens, j + 1 + digits.length));
    if (digits) {
      value = Number(`${value}.${digits}`);
      j += 1 + digits.length;
      // The main loop stops at "point", so a scale after the decimals is read here: "one point four million" is 1.4M.
      const scaled = scaleAt(tokens, j);
      if (scaled) {
        value *= scaled;
        scale = scaled;
        last = 'scale';
        j++;
      }
    }
  }
  return { value, next: j, ordinal, lone: words === 1 && value === 1 && !ordinal, scale: last === 'scale' ? scale : 1 };
}

/** Every number in a text, in digits or in words, with what it may stand for and whether it is a claim on screen. */
export function mentionsIn(text: string): Mention[] {
  const original = folded(text);
  const tokens = tokensOf(parsed(original));
  const out: Mention[] = [];
  let i = 0;
  while (i < tokens.length) {
    const found = tokens[i].kind === 'num' ? digitsAt(tokens, i) : tokens[i].kind === 'word' ? wordsAt(tokens, i) : null;
    if (!found) {
      i++;
      continue;
    }
    // The literal keeps the text's own case, with a currency sign before it and a unit after it.
    const before = tokens[i - 1];
    const from = before && CURRENCY.has(before.text) && glued(before, tokens[i]) ? before.at : tokens[i].at;
    let to = found.last;
    const unit = tokens[to + 1];
    if (unit && (unit.text === '%' || unit.text === '×' || (unit.text === 'x' && glued(tokens[to], unit)) || unitAt(tokens, to + 1) || unit.text === 'percent')) to++;
    let start = i;
    while (found.name && start > 0 && glued(tokens[start - 1], tokens[start]) && (tokens[start - 1].kind === 'word' || tokens[start - 1].text === '-')) start--;
    const name = found.name ? original.slice(tokens[start].at, tokens[found.last].end) : null;
    out.push({ ...found, name, literal: original.slice(from, tokens[to].end), core: tokens[i].text });
    i = found.last + 1;
  }
  return out;
}

type Found_ = Omit<Mention, 'literal' | 'core' | 'name'> & { name: boolean };

/** A number written in digits at token `i`, with what follows it: a time, a fraction, a scale, a unit or a suffix. */
function digitsAt(tokens: Token[], i: number): Found_ {
  const t = tokens[i];
  const value = Number(t.text.replace(/,/g, ''));
  const prev = tokens[i - 1];
  // Letters run into digits, or joined to them by a hyphen, make a name: MP4, H264, COVID-19.
  const name = (prev?.kind === 'word' && glued(prev, t))
    || (prev?.text === '-' && glued(prev, t) && tokens[i - 2]?.kind === 'word' && glued(tokens[i - 2], prev));
  const mention = (last: number, values: number[], claim: Reading[][] | null): Found_ => ({ values, claim, name, first: i, last });

  const next = tokens[i + 1];
  // 1:30, 0:15, 1:02:30: each part as a number, and the whole in its lower unit and in its higher one.
  const twoDigits = (k: number) => tokens[k]?.kind === 'num' && /^\d\d$/.test(tokens[k].text) && tokens[k - 1]?.text === ':'
    && glued(tokens[k - 2], tokens[k - 1]) && glued(tokens[k - 1], tokens[k]);
  if (twoDigits(i + 2)) {
    const parts = [value, Number(tokens[i + 2].text)];
    let last = i + 2;
    if (twoDigits(last + 2)) {
      parts.push(Number(tokens[last + 2].text));
      last += 2;
    }
    const lower = parts.reduce((sum, p) => sum * 60 + p, 0);
    const higher = lower / 60 ** (parts.length - 1);
    return mention(last, [...parts, lower, higher], [parts.filter((p) => p !== 0).map(exact), [exact(lower)], [exact(higher)]]);
  }
  // 1/2, 3/5: the fraction, or both of its numbers.
  if (next?.text === '/' && glued(t, next) && tokens[i + 2]?.kind === 'num' && glued(next, tokens[i + 2])) {
    const below = Number(tokens[i + 2].text.replace(/,/g, ''));
    const ratio = below ? value / below : value;
    return mention(i + 2, [value, below, ratio], [[exact(ratio)], [exact(value), exact(below)]]);
  }
  const after = wordAt(tokens, i + 1);
  const touching = glued(t, next);
  if (after && touching) {
    if (/^(st|nd|rd|th)$/.test(after)) return mention(i + 1, [value], [[exact(value)]]);
    // Video heights, 3D, network generations: 1080p, 3D, 5G name a format, they count nothing.
    if (after === 'd' || (after === 'p' && VIDEO_HEIGHTS.includes(value)) || (after === 'g' && value >= 2 && value <= 6)) {
      return { values: [value], claim: null, name: true, first: i, last: i + 1 };
    }
    // 1990s, 90s: the decade either way.
    if (after === 's' && value % 10 === 0) {
      const other = value < 100 ? value + 1900 : value % 100;
      return mention(i + 1, [value, other, value < 100 ? value + 2000 : value], [[exact(value)], [exact(other)]]);
    }
    const letterScale = of(SCALE_LETTERS, after);
    if (letterScale) return mention(i + 1, [value, value * letterScale], [[shown(t.text, value * letterScale, letterScale)], [exact(value)]]);
  }
  let last = i;
  let amount = value;
  let scale = 1;
  const scaleWord = after === 'hundred' ? 100 : of(SCALES, after) ?? 0;
  if (scaleWord) {
    amount *= scaleWord;
    scale = scaleWord;
    last = i + 1;
  }
  const half = andAFraction(tokens, last + 1);
  if (half) {
    amount += half.add * scale;
    last = half.next - 1;
    const scaled = scale === 1 ? scaleAt(tokens, last + 1) : undefined;
    if (scaled) {
      amount *= scaled;
      last++;
    }
  }
  const values = new Set<number>([value, amount, ...inUnits(amount, unitAt(tokens, last + 1))]);
  if (isPercent(tokens, last + 1) || CENTS.has(wordAt(tokens, last + 1) ?? '')) values.add(amount / 100);
  return mention(last, [...values], [[half ? exact(amount) : shown(t.text, amount, scale)]]);
}

/** A number in words at token `i`, or a word the speech says for one; null when the word is no number. */
function wordsAt(tokens: Token[], i: number): Found_ | null {
  const w = tokens[i].text;
  const sourceOnly = (values: number[], last = i): Found_ => ({ values, claim: null, name: false, first: i, last });
  if (isIn(SAID_AS, w)) return sourceOnly([of(SAID_AS, w)!]);
  const decade = of(DECADES, w);
  if (decade) return sourceOnly([decade, 1900 + decade, 2000 + decade]);
  const month = MONTHS.indexOf(w);
  if (month >= 0) return sourceOnly([month + 1]);
  const article = w === 'a' || w === 'an' ? 1 : 0;
  // "half", "a quarter", "half an hour": a fraction, also as a percentage, and in a time unit when it is of one.
  const fraction = wordAt(tokens, i + article);
  if (isIn(FRACTIONS, fraction) && (article || fraction === 'half' || fraction === 'quarter')) {
    const value = of(FRACTIONS, fraction)!;
    let last = i + article;
    if (wordAt(tokens, last + 1) === 'of') last++;
    if (wordAt(tokens, last + 1) === 'a' || wordAt(tokens, last + 1) === 'an') last++;
    const unit = unitAt(tokens, last + 1);
    return sourceOnly([value, value * 100, ...inUnits(value, unit)], unit ? last + 1 : i + article);
  }
  // "an hour", "a minute and a half".
  const unit = article ? unitAt(tokens, i + 1) : null;
  if (unit) {
    const extra = andAFraction(tokens, i + 2);
    return sourceOnly(inUnits(1 + (extra?.add ?? 0), unit), extra ? extra.next - 1 : i + 1);
  }
  const read = readWords(tokens, i);
  if (!read) return null;
  let value = read.value;
  let last = read.next - 1;
  const values = new Set<number>();
  // "two thirds", "three quarters".
  const parts = read.ordinal ? undefined : of(FRACTIONS, wordAt(tokens, read.next));
  if (parts) {
    values.add(value);
    value *= parts;
    last = read.next;
  }
  const half = read.ordinal ? null : andAFraction(tokens, last + 1);
  if (half) {
    value += half.add * read.scale;
    last = half.next - 1;
    // "One and a half million": a scale after the fraction scales the whole, as "1.5 million" does.
    const scaled = read.scale === 1 ? scaleAt(tokens, last + 1) : undefined;
    if (scaled) {
      value *= scaled;
      last++;
    }
  }
  for (const v of inUnits(value, unitAt(tokens, last + 1))) values.add(v);
  // "third" is a fraction as well as an ordinal.
  if (read.ordinal && w === 'third') values.add(1 / 3);
  if (isPercent(tokens, last + 1) || CENTS.has(wordAt(tokens, last + 1) ?? '')) values.add(value / 100);
  // In words on screen only a cardinal other than a lone "one" reads as a figure: "one" and "first" are mostly no count.
  const claim = read.ordinal || read.lone || parts ? null : [[exact(value)]];
  return { values: [...values], claim, name: false, first: i, last };
}

/**
 * Every value a text says: each number's values, and two numbers in words said as one, as a year, a price or a time
 * is ("twenty eighteen", "five ninety-nine", "eight thirty", "twenty oh five").
 */
export function valuesSaid(text: string): number[] {
  const tokens = tokensOf(normalized(text));
  const mentions = mentionsIn(text);
  const values: number[] = [];
  mentions.forEach((m, k) => {
    values.push(...m.values);
    const n = mentions[k + 1];
    if (!n || n.first !== m.last + 1 || tokens[m.first].kind !== 'word' || tokens[n.first].kind !== 'word') return;
    const [a, b] = [m.values[0], n.values[0]];
    if (Number.isInteger(a) && Number.isInteger(b) && a >= 1 && a <= 99 && b >= 1 && b <= 99) values.push(a * 100 + b, a + b / 100);
  });
  for (let k = 0; k + 2 < tokens.length; k++) {
    const a = of(TEENS, tokens[k].text) ?? of(TENS, tokens[k].text);
    const b = of(UNITS, tokens[k + 2].text);
    if (tokens[k + 1].text === 'oh' && a !== undefined && b !== undefined) values.push(a * 100 + b);
  }
  return values;
}

const said = (reading: Reading, values: number[]): boolean => values.some((v) => Math.abs(v - reading.value) <= reading.tolerance);

/** Whether the source bears a claim out: every reading of one of its ways is said. */
export const borneOut = (claim: Reading[][], values: number[]): boolean => claim.some((way) => way.every((r) => said(r, values)));

/** A text that is only a list's number, with the word it numbers: "tip 2", "01", "Mythe n°3", "4."; or null. */
function listNumber(text: string): { group: string; value: number } | null {
  const m = /^(?:(\p{L}+)\s*)?(?:#|n[°º]\s*|no\.?\s*|nr\.?\s*)?0*(\d{1,2})\s*[.):]?$/u.exec(normalized(text).trim());
  return m ? { group: m[1] ?? '', value: Number(m[2]) } : null;
}

/** The number a text opens with as a list item does: "1. Chop the onions", "2) Simmer"; or null. */
function leadingNumber(text: string): number | null {
  const m = /^\s*(\d{1,2})[.)]\s+\p{L}/u.exec(normalized(text));
  return m ? Number(m[1]) : null;
}

/** The value of a text that is one number and nothing else, a time in its lower unit; or null. */
function soleValue(text: string): number | null {
  const mentions = mentionsIn(text);
  if (mentions.length !== 1 || !mentions[0].claim || /[^\d\s.,:%$€£+-]/u.test(normalized(text))) return null;
  const parts = normalized(text).trim().split(':');
  return parts.length > 1 ? parts.reduce((sum, p) => sum * 60 + Number(p.replace(/[^\d.]/g, '')), 0) : mentions[0].values[0];
}

/** An element holding more than one line, with a space put where the record ran one line's letters into the next's digits. */
const split = (e: TextEntry): TextEntry =>
  (e.box[3] > MULTI_LINE * e.fontSize ? { ...e, text: e.text.replace(/(\p{L})(\d)/gu, '$1 $2') } : e);

const inside = (box: TextEntry['box'], edges: Edges): boolean => {
  const x = box[0] + box[2] / 2;
  const y = box[1] + box[3] / 2;
  return x >= edges[0] - 1 && x <= edges[2] + 1 && y >= edges[1] - 1 && y <= edges[3] + 1;
};

/** One number in one element over consecutive samples. */
interface Showing {
  selector: string;
  literal: string;
  claim: Reading[][];
  /** The longest text the number was shown in, for the report. */
  text: string;
  edges: Edges;
  /** The element's own text when it first showed the number. */
  own: string;
  first: number;
  last: number;
}

/** Where on the frame a block sits, in thirds. */
function where(edges: Edges, record: TextRecord): string {
  const x = (edges[0] + edges[2]) / 2 / record.width;
  const y = (edges[1] + edges[3]) / 2 / record.height;
  return `${y < 1 / 3 ? 'top' : y < 2 / 3 ? 'middle' : 'bottom'} ${x < 1 / 3 ? 'left' : x < 2 / 3 ? 'centre' : 'right'}`;
}

/** Every number shown on screen as a claim, element by element, and the names whose digits were set aside. */
function showingsOf(record: TextRecord): { showings: Showing[]; names: Set<string> } {
  const done: Showing[] = [];
  const names = new Set<string>();
  const cache = new Map<string, Mention[]>();
  const mentionsOf = (text: string) => cache.get(text) ?? cache.set(text, mentionsIn(text)).get(text)!;
  let open = new Map<string, Showing>();
  record.samples.forEach((sample, k) => {
    const texts = sample.texts.map(split);
    const next = new Map<string, Showing>();
    for (const block of blocksOf(texts)) {
      const members = texts.filter((e) => inside(e.box, block.edges));
      for (const m of mentionsOf(block.text)) {
        const entry = members.find((e) => normalized(e.text).includes(m.core)) ?? members[0];
        // A block runs separate elements together where they stand close, so only an element's own text makes a name.
        if (m.name && (!m.claim || (entry && mentionsOf(entry.text).some((n) => n.name && n.core === m.core)))) {
          names.add(m.name);
          continue;
        }
        if (!m.claim) continue;
        const selector = entry?.selector ?? '';
        const key = `${selector}\u0000${m.literal}`;
        const showing = next.get(key) ?? open.get(key)
          ?? { selector, literal: m.literal, claim: m.claim, text: block.text, edges: block.edges, own: entry?.text ?? block.text, first: k, last: k };
        showing.last = k;
        if (block.text.length > showing.text.length) showing.text = block.text;
        next.set(key, showing);
      }
    }
    for (const [key, showing] of open) if (!next.has(key)) done.push(showing);
    open = next;
  });
  done.push(...open.values());
  return { showings: done.sort((a, b) => a.first - b.first), names };
}

/** Per kind of item ("" for bare numbers), the n of a list numbered 1 to n somewhere in the video, when n >= LIST_RUN. */
function listRuns(record: TextRecord): Map<string, number> {
  const seen = new Map<string, Set<number>>();
  for (const sample of record.samples) {
    for (const text of [...sample.texts.map((e) => e.text), ...blocksOf(sample.texts.map(split)).map((b) => b.text)]) {
      const n = listNumber(text);
      if (!n) continue;
      seen.set(n.group, (seen.get(n.group) ?? new Set<number>()).add(n.value));
    }
  }
  const runs = new Map<string, number>();
  for (const [group, values] of seen) {
    let n = 0;
    while (values.has(n + 1)) n++;
    if (n >= LIST_RUN) runs.set(group, n);
  }
  return runs;
}

/**
 * The element and value of every number that runs as a clock or a count does: COUNTER_RUN or more in a row in one
 * element, among those held long enough to read, so a count racing up to a figure still leaves that figure to check.
 */
function counters(showings: Showing[]): Set<string> {
  const values = new Map<string, Set<number>>();
  for (const s of showings) {
    const v = soleValue(s.own);
    if (v !== null && Number.isInteger(v)) values.set(s.selector, (values.get(s.selector) ?? new Set<number>()).add(v));
  }
  const out = new Set<string>();
  for (const [selector, set] of values) {
    for (const v of set) {
      let low = v;
      while (set.has(low - 1)) low--;
      let high = v;
      while (set.has(high + 1)) high++;
      if (high - low + 1 >= COUNTER_RUN) out.add(`${selector}\u0000${v}`);
    }
  }
  return out;
}

/** The transcript's words as one text, in order. */
function spoken({ transcript }: Found<TranscriptInput>): string {
  const words = transcript.chunks.flatMap((c) => c.words ?? []);
  return words.length ? words.map((w) => w.text).join(' ') : transcript.chunks.map((c) => c.text).join(' ') || transcript.text || '';
}

export function judgeNumbers({ path, record }: Found<TextRecordInput>, transcript: TranscriptInput, brief: BriefInput): CheckReport {
  const values = [
    ...('missing' in transcript ? [] : valuesSaid(spoken(transcript))),
    ...('missing' in brief ? [] : brief.sources.flatMap((s) => valuesSaid(s.text))),
  ];
  const skipped: string[] = [];
  if ('missing' in transcript) {
    skipped.push(`the speech: ${transcript.missing}, so the numbers were compared with the user's words only, and any the speech says are reported too`);
  }
  if ('missing' in brief) skipped.push(`the user's words: ${brief.missing}, so the numbers were compared with the transcript only`);
  const sources = [
    ...('missing' in transcript ? [] : [`the words of ${transcript.path}`]),
    ...('missing' in brief ? [] : [`the user's words (${brief.sources.map((s) => s.label).join(', ')})`]),
  ];
  const { showings, names } = showingsOf(record);
  const runs = listRuns(record);
  const step = sampleSeconds(record);
  const startOf = (s: Showing) => timeOf(record, record.samples[s.first].frame);
  const endOf = (s: Showing) => timeOf(record, record.samples[s.last].frame) + step;
  const readable = (s: Showing) => endOf(s) - startOf(s) >= MIN_SECONDS - 1e-9;
  const counting = counters(showings.filter(readable));
  const aside = { list: new Set<string>(), counter: new Set<string>(), brief: new Set<string>(), name: names };
  const claims: Showing[] = [];
  for (const s of showings) {
    const sole = s.claim.length === 1 && s.claim[0].length === 1 ? s.claim[0][0].value : null;
    const numbered = listNumber(s.own) ?? listNumber(s.text);
    const lead = leadingNumber(s.own) ?? leadingNumber(s.text);
    if ((numbered && numbered.value >= 1 && numbered.value <= (runs.get(numbered.group) ?? 0)) || (lead !== null && lead === sole && /^\d+$/.test(s.literal))) {
      aside.list.add(s.literal);
    } else if (sole !== null && /^\d+$/.test(s.literal) && [...runs.values()].includes(sole)) {
      // "3 myths" over a list numbered 1 to 3 counts the video's own items.
      aside.list.add(s.literal);
    } else if (counting.has(`${s.selector}\u0000${soleValue(s.own)}`)) {
      aside.counter.add(s.literal);
    } else if (!readable(s)) {
      aside.brief.add(s.literal);
    } else {
      claims.push(s);
    }
  }
  const few = (set: Set<string>) => [...set].slice(0, 6).map(quoted).join(', ') + (set.size > 6 ? `, and ${set.size - 6} more` : '');
  const notes = [
    aside.list.size ? `a list's own numbering or count, ${few(aside.list)}` : '',
    aside.counter.size ? `a clock or a count running in one place, ${few(aside.counter)}` : '',
    aside.brief.size ? `on screen under ${MIN_SECONDS}s, too briefly to read, ${few(aside.brief)}` : '',
    aside.name.size ? `part of a name, ${few(aside.name)}` : '',
  ].filter(Boolean);
  const tail = [...(notes.length ? [`set aside as no claim: ${notes.join('; ')}`] : []), `compared with ${sources.join(' and ')}`];
  const unsaid = claims.filter((s) => !borneOut(s.claim, values));
  const which = 'missing' in brief ? 'the transcript' : 'missing' in transcript ? "the user's words" : "the transcript or the user's words";
  const neither = 'missing' in brief ? 'the transcript never says' : 'missing' in transcript ? "the user's words never say"
    : "neither the transcript nor the user's words say";
  if (unsaid.length === 0) {
    const lead = claims.length === 0
      ? `no number on screen reads as a claim, over ${record.samples.length} sampled frames (${path})`
      : `every number on screen is said in ${which}: ${new Set(claims.map((c) => c.literal)).size} number(s)`;
    return { verdict: 'pass', lines: [lead, ...tail], skipped };
  }
  // One line per number in one element: its first showing, and how many more follow.
  const byKey = new Map<string, Showing[]>();
  for (const s of unsaid) byKey.set(`${s.selector}\u0000${s.literal}`, [...(byKey.get(`${s.selector}\u0000${s.literal}`) ?? []), s]);
  const findings = [...byKey.values()].map((all) => {
    const s = all[0];
    const context = normalized(s.text).trim() === normalized(s.literal).trim() ? '' : ` in ${quoted(s.text)}`;
    const more = all.length > 1 ? `, and ${all.length - 1} more time(s) to ${endOf(all.at(-1)!).toFixed(2)}s` : '';
    return { start: s.first, line: `${quoted(s.literal)}${context}, ${where(s.edges, record)}, ${fromTo(startOf(s), endOf(s))}${more}` };
  });
  return {
    verdict: 'found',
    lines: [`${findings.length} number(s) on screen that ${neither}, to confirm against the source or take off:`, ...listed(findings), ...tail],
    skipped,
  };
}

export function measureNumbers({ textRecord, transcript, brief }: ReviewContext): CheckReport {
  if ('missing' in textRecord) return skippedFor(`the text: ${textRecord.missing}`);
  if ('missing' in transcript && 'missing' in brief) return skippedFor(`the speech: ${transcript.missing}`, `the user's words: ${brief.missing}`);
  return judgeNumbers(textRecord, transcript, brief);
}
