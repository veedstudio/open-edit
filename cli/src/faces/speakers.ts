// A speakers file read as faces' own shots and boxes. Such a file is made for one clip by an analysis that hears it
// as well as sees it: the shots, a track per face in each shot with a box and whether it is speaking at every
// analysed frame, and per shot the runs of whom to show. It is mapped here into what faces.json holds, the way
// whisper-mapper.ts maps a transcript made elsewhere, so a clip that comes with one needs no face detection.
//
// Its times are seconds on the clock the clip's frames are timed by, rounded to the millisecond, ends exclusive.
// Its boxes are [x, y, width, height] in display pixels. A track lives in one shot, and the time between two shots
// (a transition) is in neither.
import { statSync } from 'node:fs';
import { isNum, readJsonFile } from '../json-file.ts';
import { errorText } from '../proxy.ts';
import { inSpan, NEAR, SAME_CLIP_SEC, toDisplay, type FaceBox, type Rect, type ShowRun } from './page-script.ts';
import { median } from './shot-size.ts';

const VERSION = 1;

// Counted up whenever the same file would map to other shots or boxes, so a faces.json says which mapping wrote it.
// Provenance only: nothing reads it.
const MAPPING = 3;

/** What faces.json records as the source of boxes mapped from a speakers file. */
export const SPEAKERS_MODEL = `speakers-file-v${VERSION}-mapping-${MAPPING}`;

export interface SpeakersFrame { t: number; bbox: [number, number, number, number]; speaking: boolean }
export interface SpeakersTrack { id: number; start: number; end: number; frames: SpeakersFrame[] }
interface SpeakersRun { start: number; end: number; show: number[] }
export interface SpeakersShot { start: number; end: number; tracks: SpeakersTrack[]; suggested: SpeakersRun[] }
/** The fields faces reads; a file may hold more. */
export interface SpeakersFile { version: number; duration: number; width: number; height: number; first_frame: number; shots: SpeakersShot[] }

/**
 * A speakers file faces will not map. With `another`, one made for this clip as it is now would be read: this one is
 * not a speakers file, or is another clip's. Without, it is past what faces maps: its version, its size, its tracks.
 */
export class SpeakersRefused extends Error {
  constructor(message: string, readonly another = true) {
    super(message);
  }
}

/** A speakers file that could not be opened, which says nothing of what is in it. */
export class SpeakersUnread extends Error {}

// The largest speakers file read. The largest measured is 1.1 MB, and a file is parsed whole and costs about ten
// times its size in memory, so one past this is refused unread.
export const SPEAKERS_BYTES = 32 << 20;

// A median needs this many frames to leave an outlier out; with fewer the box is read between the frames either side.
const MEDIAN_LEAST = 3;

// The most tracks one shot may hold. The format follows five faces at once at most and starts a new track when a
// face comes back, and the files measured hold three in a shot at most: a hundred is twenty returns of each of
// five, and keeps what one sample costs bounded whatever the file says.
const TRACKS_MOST = 100;

const isSpan = (v: { start?: unknown; end?: unknown } | null | undefined): boolean => isNum(v?.start) && isNum(v?.end) && v.end > v.start;
/** Whether each of `spans` starts no earlier than the one ahead of it ends. */
const inOrder = (spans: { start: number; end: number }[]): boolean => spans.every((span, k) => !k || span.start >= spans[k - 1].end - NEAR);

/** What is wrong with one shot of a file, or null: named so no reader trips on a field deep inside. */
function shotProblem(shot: SpeakersShot | null | undefined): string | null {
  if (!shot || typeof shot !== 'object' || !isSpan(shot)) return 'no start and end, or an end not after its start';
  if (!Array.isArray(shot.tracks)) return 'no tracks';
  if (!Array.isArray(shot.suggested)) return 'no suggested runs';
  const ids = new Set<number>();
  for (const track of shot.tracks) {
    if (!Number.isInteger(track?.id) || ids.has(track.id)) return 'a track without an id of its own';
    ids.add(track.id);
    if (!isSpan(track)) return `track ${track.id} has no start and end`;
    if (!Array.isArray(track.frames) || !track.frames.length) return `track ${track.id} has no frames`;
    const broken = track.frames.some((f, i) => !isNum(f?.t) || !Array.isArray(f.bbox) || f.bbox.length !== 4 || !f.bbox.every(isNum)
      || typeof f.speaking !== 'boolean' || (i > 0 && f.t <= track.frames[i - 1].t));
    if (broken) return `track ${track.id} has a frame without its time, box or speaking flag, or not after the frame ahead of it`;
  }
  if (shot.suggested.some((run) => !isSpan(run) || !Array.isArray(run.show) || run.show.some((id) => !ids.has(id)))) {
    return 'a suggested run without its start and end, or showing a track the shot does not have';
  }
  return inOrder(shot.suggested) ? null : 'a suggested run that starts before the one ahead of it ends';
}

/** The speakers file at `path`, or a refusal naming the file and what about it faces cannot read. */
export function readSpeakers(path: string): SpeakersFile {
  const not = (why: string) => new SpeakersRefused(`${path} is not a speakers file faces can read (${why})`);
  let file: Partial<SpeakersFile> | null;
  let bytes: number;
  try {
    // Looked at before it is opened: a pipe under this name would never end, and a huge file would be parsed whole.
    const entry = statSync(path);
    if (!entry.isFile()) throw new Error('it is not a file');
    bytes = entry.size;
  } catch (e) {
    throw new SpeakersUnread(`${path} cannot be read (${errorText(e)})`, { cause: e });
  }
  if (bytes > SPEAKERS_BYTES) {
    throw new SpeakersRefused(`${path} is ${(bytes / (1 << 20)).toFixed(1)} MB, and faces reads a speakers file of at most ${SPEAKERS_BYTES >> 20} MB`, false);
  }
  try {
    file = readJsonFile(path) as Partial<SpeakersFile> | null;
  } catch (e) {
    // A truncated answer or a damaged kept file is a file to refuse like any other; one that cannot be opened is not.
    if (!(e instanceof SyntaxError || (e as Error).cause instanceof SyntaxError)) throw new SpeakersUnread(`${path} cannot be read (${errorText(e)})`, { cause: e });
    throw not('not JSON');
  }
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw not('not an object');
  if (!isNum(file.version)) throw not('no version');
  if (file.version !== VERSION) throw new SpeakersRefused(`${path} is a speakers file of version ${file.version}, and faces reads version ${VERSION}`, false);
  if (![file.width, file.height, file.duration].every((v) => isNum(v) && v > 0)) throw not('no width, height or duration');
  if (!isNum(file.first_frame) || file.first_frame < 0) throw not('no first_frame');
  const { shots } = file;
  // A file with no shot says nothing of the clip, and mapped it would read as a clip with no face in it.
  if (!Array.isArray(shots) || !shots.length) throw not('no shots');
  shots.forEach((shot, k) => {
    const problem = shotProblem(shot);
    if (problem) throw not(`shot ${k + 1} of ${shots.length}: ${problem}`);
  });
  if (!inOrder(shots)) throw not('a shot that starts before the one ahead of it ends');
  return file as SpeakersFile;
}

/**
 * A clip as a speakers file is held against it: its display size, where its picture starts and ends on the clock
 * its frames are timed by, how long one of its frames lasts, and its container's length when it declares one.
 */
export interface ClipMeasure { width: number; height: number; start: number; end: number; frame: number; container: number | null }

/**
 * Why `file` was not made for this clip as it is now, or null when it was: boxes in another picture's pixels, or
 * times on another clock, would be read as this clip's faces. Its duration may be the picture's end, the picture's
 * own length or the container's, each of which is a clip's length to some reader.
 */
export function notSpeakersOf(file: SpeakersFile, clip: ClipMeasure): string | null {
  const lengths = [clip.end, clip.end - clip.start, ...(clip.container === null ? [] : [clip.container])];
  if (file.width !== clip.width || file.height !== clip.height || !lengths.some((l) => Math.abs(l - file.duration) <= SAME_CLIP_SEC)) {
    return `is for a clip ${file.width}x${file.height} and ${file.duration.toFixed(3)} s long, not this one, ` +
      `${clip.width}x${clip.height} and ${clip.end.toFixed(3)} s long`;
  }
  // The file's times are used as they are, so its first frame has to be this clip's: half a frame off is another
  // frame, though never less than the file's own rounding, which a nominal rate that is a timebase would ask for.
  if (Math.abs(file.first_frame - clip.start) > Math.max(clip.frame / 2, NEAR)) {
    return `puts its first frame at ${file.first_frame.toFixed(3)} s where this clip's is at ${clip.start.toFixed(3)} s, so its times are on another clock`;
  }
  const late = file.shots.find((shot) => shot.start >= clip.end);
  if (late) return `has a shot from ${late.start.toFixed(3)} s, past this clip's end at ${clip.end.toFixed(3)} s`;
  const sliver = file.shots.find((shot) => (shot.end - shot.start + NEAR) / clip.frame < 1);
  return sliver ? `has a shot from ${sliver.start.toFixed(3)} to ${sliver.end.toFixed(3)} s, shorter than one frame of this clip` : null;
}

/** Why `file` holds more than faces maps, whichever clip it is for, or null. */
export function pastMapping(file: SpeakersFile): string | null {
  const crowded = file.shots.find((shot) => shot.tracks.length > TRACKS_MOST);
  return crowded ? `has ${crowded.tracks.length} tracks in the shot from ${crowded.start.toFixed(3)} s, and faces maps at most ${TRACKS_MOST} a shot` : null;
}

/**
 * Where faces' shots start and end for the file's: as many shots, the first from 0, since a player shows the first
 * frame until the picture starts, and the last to the clip's end.
 */
export function shotBounds(file: SpeakersFile, durationSec: number): number[] {
  const starts = file.shots.map((shot, k) => {
    if (k === 0) return 0;
    const before = file.shots[k - 1];
    if (shot.start - before.end <= NEAR) return shot.start;
    // Faces' shots leave no time out, so a transition goes to the shots either side of it. Where one of them has a
    // face and the other none, the face is on screen while it fades, and all of it goes to that shot; else each
    // runs to its middle, where reframe splits a dissolve it finds itself.
    const [had, has] = [before.tracks.length > 0, shot.tracks.length > 0];
    return had === has ? (before.end + shot.start) / 2 : had ? shot.start : before.end;
  });
  return [...starts, durationSec];
}

// What the detector's box is of the file's, in the median over faces both found: wider and taller, about the same
// centre across, its top edge higher by this share of the file's height. The ratios move with the pose and the clip.
const WIDER = 1.14;
const TALLER = 1.08;
const RAISED = 0.144;

/**
 * A box of the file as the box faces' detector draws for that face. The file's runs from brow to under the chin on
 * the face alone, and the detector's takes in the forehead and the sides of the head: every margin and threshold
 * that reads a face box was set on the detector's, so the file's is brought to that span before any of them sees it.
 */
export const asFaceBox = (box: Rect): Rect =>
  ({ x: box.x - ((WIDER - 1) * box.w) / 2, y: box.y - RAISED * box.h, w: box.w * WIDER, h: box.h * TALLER });

/** The index of the first frame at or after `t`. */
function firstFrom(frames: SpeakersFrame[], t: number): number {
  let [lo, hi] = [0, frames.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A track's box at `sec` and whether its face is speaking then, read over the frames within `half` seconds either
 * side, since the boxes jitter and the flag flickers from one frame to the next: the median of the box's centre
 * and of its size, and speaking when more than half of them are.
 */
function trackAt(track: SpeakersTrack, sec: number, half: number): { box: Rect; speaking: boolean } {
  const { frames } = track;
  const around = frames.slice(firstFrom(frames, sec - half - NEAR), firstFrom(frames, sec + half + NEAR));
  const speaking = (of: SpeakersFrame[]) => of.filter((f) => f.speaking).length * 2 > of.length;
  if (around.length >= MEDIAN_LEAST) {
    const mid = (pick: (b: SpeakersFrame['bbox']) => number) => median(around.map((f) => pick(f.bbox)));
    const [w, h] = [mid((b) => b[2]), mid((b) => b[3])];
    return { box: { x: mid((b) => b[0] + b[2] / 2) - w / 2, y: mid((b) => b[1] + b[3] / 2) - h / 2, w, h }, speaking: speaking(around) };
  }
  // Too few frames for a median: the frame at `sec`, or the box in proportion between the frames either side of it.
  const i = firstFrom(frames, sec - NEAR);
  const [a, b] = [frames[i - 1], frames[i]];
  const one = !b ? a : !a || b.t - sec <= NEAR ? b : null;
  if (one) return { box: { x: one.bbox[0], y: one.bbox[1], w: one.bbox[2], h: one.bbox[3] }, speaking: one.speaking };
  const k = (sec - a.t) / (b.t - a.t);
  const [x, y, w, h] = a.bbox.map((v, n) => v + (b.bbox[n] - v) * k);
  return { box: { x, y, w, h }, speaking: speaking([a, b]) };
}

/**
 * The faces of one of the file's shots at `sec`, as a sample of faces.json holds them: one box per track on screen
 * then, with its track and whether it is speaking, on whole pixels inside the `frame`; a box wholly outside is
 * dropped, as faces drops one at a frame's edge.
 */
export function facesAt(shot: SpeakersShot, sec: number, half: number, frame: { width: number; height: number }): FaceBox[] {
  return shot.tracks.filter((track) => inSpan(sec, track.start, track.end)).flatMap((track) => {
    const { box, speaking } = trackAt(track, sec, half);
    const { x, y, w, h } = asFaceBox(box);
    return toDisplay([[x, y, w, h]], 1, 1, frame.width, frame.height).map((on) => ({ x: on.x, y: on.y, w: on.w, h: on.h, track: track.id, speaking }));
  });
}

/** A shot's runs of whom to show, as faces.json holds them. */
export const showRuns = (shot: SpeakersShot): ShowRun[] => shot.suggested.map((run) => ({ start: run.start, end: run.end, tracks: [...run.show] }));
