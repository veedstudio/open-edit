// What a video render says about the picture it has just made, while the page is still open to change: a first frame
// that makes a poor cover, and each still held longer than its words allow. It measures as the review's blank-frames and
// dead-air checks do, on the render's own output and its record of on-screen text, and it never fails the render.
import { FADE_RATE, findOpening, openingLevelsIn, type Opening } from '../verify/blank-frames.ts';
import {
  changesIn, heldStill, lengthOf, SCAN_RATE, STILL_WINDOW, stillLimit, stillsOf, type HeldStill, type Span,
} from '../verify/dead-air.ts';
import { END_CARD_CAP } from '../verify/dead-tail.ts';
import { recordPath, type TextRecord } from './text-record.ts';

/**
 * The opening is read this far in: a fade-in climbs FADE_RATE levels a second or faster, so the slowest one blank-frames
 * recognises, from black to white (16 to 235), ends within it.
 */
export const OPENING_SECONDS = Math.ceil((235 - 16) / FADE_RATE);

/**
 * A patch is scanned this far either side of the stretch it re-rendered: the longest any still may hold, and the span
 * of the medians that class a change as still. A still the scan's edge cuts has then held too long by the time the
 * stretch starts, so the scan of the whole picture that measures it whole is spent only on a still to report.
 */
export const CONTEXT_SECONDS = END_CARD_CAP + STILL_WINDOW / SCAN_RATE;

/** The stills listed before the rest are only counted: past a few they share one cause. */
export const LISTED_STILLS = 3;

export interface PictureOptions {
  /** Seconds of picture. */
  duration: number;
  /** The record of on-screen text the render wrote beside the video, or null when the page's text could not be read. */
  record: TextRecord | null;
  /** For a patch, the stretch it re-rendered: only a still overlapping it, and the first frame when it starts at 0, is looked at. */
  range: Span | null;
}

const NO_VOICE = { missing: 'a render has no transcript' } as const;
const t1 = (sec: number) => sec.toFixed(1);
const t2 = (sec: number) => sec.toFixed(2);

export function stillNote(held: HeldStill, recorded: boolean): string {
  const { kind, span, words } = held;
  const allows = words > 0 ? `its ${words} word${words === 1 ? ' allows' : 's allow'}` : recorded ? 'a still with no page text allows' : 'a still allows';
  return `${kind} ${t1(span.start)}-${t1(span.end)} s (${t1(lengthOf(span))} s, over the ${t1(stillLimit(words))} s ${allows})`;
}

/** `read`: how far in the opening was read, when that stops short of the video's end. */
export function openingNote(o: Opening, read: number | null): string {
  const until = read !== null && o.until >= read - 1e-6 ? `past ${t2(read)} s` : `${t2(o.until)} s`;
  const flat = o.colour ? `flat ${o.colour}` : 'one flat colour';
  let what: string;
  if (o.fading && o.first === 'dim') what = `mid-fade, ${Math.round(100 * o.fraction)}% as bright as where the fade-in ends at ${until}`;
  else if (o.fading) what = `${o.first === 'blank' ? `blank, ${flat},` : 'near-black,'} fading in until ${until}`;
  else what = o.first === 'blank' ? `blank, ${flat} until ${until}` : `near-black until ${until}`;
  return `frame 0 is ${what}; platforms show it as the cover`;
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

async function heldStillsIn(video: string, o: PictureOptions): Promise<HeldStill[]> {
  const textRecord = o.record ? { path: recordPath(video), record: o.record } : { missing: 'the page\'s text could not be read' };
  const judge = (changes: Awaited<ReturnType<typeof changesIn>>, end: number) => stillsOf(changes, end)
    .filter((still) => !o.range || overlaps(still, o.range)).flatMap((still) => heldStill(still, NO_VOICE, textRecord) ?? []);
  if (!o.range) return judge(await changesIn(video), o.duration);
  const scan = { start: Math.max(0, o.range.start - CONTEXT_SECONDS), end: Math.min(o.duration, o.range.end + CONTEXT_SECONDS) };
  const held = judge(await changesIn(video, scan), scan.end);
  const cut = held.some(({ span }) => (scan.start > 0 && span.start <= scan.start + 1e-6) || (scan.end < o.duration && span.end >= scan.end - 1e-6));
  return cut ? judge(await changesIn(video), o.duration) : held;
}

async function openingNoteOf(video: string, o: PictureOptions): Promise<string[]> {
  if (o.range && o.range.start > 0) return [];
  const read = Math.min(o.duration, OPENING_SECONDS);
  const opening = findOpening(await openingLevelsIn(video, read), read);
  return opening ? [openingNote(opening, read < o.duration ? read : null)] : [];
}

/** At most a few short lines; none when the picture opens on a picture and holds no still too long. */
export async function pictureNotes(video: string, o: PictureOptions): Promise<string[]> {
  const [opening, held] = await Promise.all([openingNoteOf(video, o), heldStillsIn(video, o)]);
  const stills = held.slice(0, LISTED_STILLS).map((h) => stillNote(h, o.record !== null));
  if (held.length > LISTED_STILLS) stills.push(`and ${held.length - LISTED_STILLS} more still(s), the last at ${t1(held.at(-1)!.span.start)} s`);
  return [...opening, ...stills];
}
