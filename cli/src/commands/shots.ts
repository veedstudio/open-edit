// A video as a shot list: where each shot starts, how long it holds, what is said in it and its shot size, with
// a storyboard of every shot's frames beside it.
//
//   openedit shots <video> [--threshold 0.1] [--min-shot 0.333] [--faces <faces.json>] [--json]
//
// A few stills show moments, not where the cuts fall or how long each shot holds, so a plan built from
// them guesses the pacing. This measures the cuts and lays the video's transcript over them; the storyboard
// (storyboard.ts) shows what the list cannot say: on-screen text, and the framing to check its shot sizes against.
//
// A cut is a frame whose ffmpeg scene score (select's `scene`) reaches the threshold. That score is the
// smaller of the frame's difference from the last one and the change in that difference, so a hard cut
// is a single spike and steady motion stays low. A fade spreads its change over many frames, so a fade
// through black is found by its black frames instead (blackdetect, in the same decode); a dissolve is not
// a cut to either.
// Speech is read from the transcript already on disk and never transcribed here: a hosted provider
// bills for it, and that call is made where transcription is run. Shot size is read from the face boxes `faces`
// wrote, and MediaPipe is never run here: it is a large install the user agrees to first.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { numberFlag, parseUsage, usageLine, type Usage } from '../args.ts';
import { FFMPEG, runsDir } from '../config.ts';
import { facesPathFor, ownFaces, sameFile } from '../faces/folder.ts';
import type { FacesClip } from '../faces/page-script.ts';
import { CLOSE_UP_MIN, MEDIUM_MIN, shotSizeOf, type SizeReading } from '../faces/shot-size.ts';
import {
  audioDurationOf, hasAudioStream, ownVideoDurationOf, probeDisplaySize, probeFrameRate, probeSquareSize, probeVideoSpan,
} from '../probe.ts';
import { writeAtomic } from '../providers/exclusive-files.ts';
import { resolveVideoArg, runKeyOf } from '../resolve-video.ts';
import { shellArg } from '../shell-arg.ts';
import {
  LEASE_MS, MAX_SHEETS, SHEET_SIDE, startStoryboard, sweepStoryboards, THREE_FRAMES_FROM_SEC, writeStoryboard, type StoryboardResult,
} from '../storyboard.ts';
import { readTranscriptFile, type TranscriptRead } from '../transcript/read-transcript.ts';
import { transcriptPathFor } from '../transcript/transcript-cache.ts';
import type { Transcript } from '../transcript/transcript-types.ts';
import { notFacesOf, readFaces } from './faces.ts';
import { frameShowing } from './frames.ts';

// Low enough for jump cuts, which score low (16 of 24 measured reach 0.1, 7 reach 0.2), where hard cuts on two
// films scored 0.30 or more. The price is flicker inside effects read as cuts, 2 in 240 s of film; ffmpeg's own
// advice (0.2 to 0.5 on this scale) is for hard cuts alone.
export const DEFAULT_THRESHOLD = 0.1;

// Two candidate cuts closer than this are one cut and flicker beside it, and the stronger is kept. A third
// of a second matches the three-flashes-a-second limit of the WCAG and broadcast rules (a flash being a
// pair of changes).
export const DEFAULT_MIN_SHOT_SEC = 1 / 3;

// The score is a per-pixel mean, so a small copy keeps a hard cut's spike for a fraction of the work. The
// threshold was measured at this width.
const SCORE_WIDTH = 256;

// A black frame has all but one pixel in a thousand under blackdetect's default tenth of full brightness. Its
// default 98% reads a title or a logo on black, and dark scenes, as black (measured on Sintel's trailer). One
// black frame is enough: a dip between two shots is often only a few frames long.
const BLACK = 'blackdetect=d=0:pix_th=0.10:pic_th=0.999';

// Rows that stay black through the whole clip may be bars around a letterboxed picture: cropdetect's box, never reset,
// grows to every row any frame lights. On the score's small copy, since a bar is a share of the height, with
// cropdetect's own default limit, 24 in 255, as a fraction so any bit depth is judged alike.
const CROP = 'cropdetect=limit=0.094:round=2:skip=0:reset=0';

// Padding is centred, so black rows are taken for bars only when there are some both above and below the picture and
// the two match to this share of the height, or to 2 rows of the small copy where that is more: a dark backdrop above
// a head, or a dark body below it, is no bar.
const BAR_SLACK = 0.02;

// Words may run this far past the end of the media before the transcript is taken for another video's.
const TRANSCRIPT_OVERRUN_SEC = 0.5;

export interface FrameScore {
  /** Seconds on ffmpeg's clock for the file, which `frames --at` and `frames --frame` share. */
  sec: number;
  score: number;
}

/** A run of black frames: `end` is the first frame after it. */
export interface Black {
  start: number;
  end: number;
}

export type Transition = 'cut' | 'dip to black';

export interface Cut {
  sec: number;
  /** The scene score at the cut; null for a dip to black, which has no spike. */
  score: number | null;
  transition: Transition;
}

export type Shot = {
  shot: number;
  start: number;
  end: number;
  duration: number;
  /** The index `frames --frame` shows the shot's first picture at. */
  startFrame: number;
  /** How the shot opens; null for the first. */
  transition: Transition | null;
  /** The scene score of the frame that opened the shot; null for the first, and for a dip found by its black frames alone. */
  cutScore: number | null;
  /** What is said in the shot, by word midpoint; null when nothing is, or when there is no transcript. */
  speech: string | null;
  // shotSize and faceShare are both null when there is no usable faces.json, or no sample falls in the shot.
} & (SizeReading | { shotSize: null; faceShare: null });

export type Source =
  | { path: string; /** The format it was mapped from, when it was not a transcript.json. */ mappedFrom?: string }
  | { path: null; why: string };

export interface ShotList {
  video: string;
  fps: number;
  frameRate: string;
  /** Where the last shot ends, on the same clock as every shot's start. */
  durationSec: number;
  width: number;
  height: number;
  /**
   * The rows the picture fills, in `height`'s pixels: between matching black bars above and below that stay black
   * through the whole clip, else `height`. Measured on the decode's small copy, so it can be a few rows off.
   */
  pictureHeight: number;
  threshold: number;
  minShotSec: number;
  /** Where each per-shot field came from, or why it is empty. */
  sources: { speech: Source; shotSize: Source };
  shots: Shot[];
}

/** What shots.json holds: the list and its storyboard. */
export type ShotListFile = ShotList & { storyboard: StoryboardResult };

/**
 * What ffmpeg's metadata filter prints: `frame:N pts:P pts_time:T`, then that frame's keys. A black run still
 * open at the last frame runs into the end of the picture, which is no dip between shots, so it is dropped.
 */
export function parseFrames(text: string): { scores: FrameScore[]; blacks: Black[]; picture: { top: number; bottom: number } | null } {
  const scores: FrameScore[] = [];
  const blacks: Black[] = [];
  let sec: number | null = null;
  let blackFrom: number | null = null;
  let top = NaN;
  let bottom = NaN;
  for (const line of text.split('\n')) {
    const head = line.match(/^frame:\d+\s+pts:\S+\s+pts_time:(\S+)/);
    if (head) {
      sec = Number.isFinite(Number(head[1])) ? Number(head[1]) : null;
      continue;
    }
    if (sec === null) continue;
    const score = line.match(/^lavfi\.scene_score=(\S+)/);
    if (score) scores.push({ sec, score: Number(score[1]) });
    else if (line.startsWith('lavfi.black_start=')) blackFrom = sec;
    else if (line.startsWith('lavfi.black_end=') && blackFrom !== null) {
      blacks.push({ start: blackFrom, end: sec });
      blackFrom = null;
    } else if (line.startsWith('lavfi.cropdetect.y1=')) top = Number(line.slice(20));
    else if (line.startsWith('lavfi.cropdetect.y2=')) bottom = Number(line.slice(20));
  }
  // A clip black throughout leaves the box empty, and its picture is then the whole frame.
  return { scores, blacks, picture: bottom >= top ? { top, bottom } : null };
}

/** One decode of the picture: every frame's scene score, the runs of black frames, and the rows the picture fills. */
export function decodeFrames(video: string): ReturnType<typeof parseFrames> {
  const text = execFileSync(FFMPEG, ['-nostdin', '-v', 'error', '-i', video, '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', `scale=${SCORE_WIDTH}:-2,${CROP},${BLACK},select='gte(scene,0)',metadata=print:file=-`,
    '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
  const frames = parseFrames(text);
  if (!frames.scores.length) throw new Error(`ffmpeg decoded no frames from ${video}: is there a picture in it?`);
  return frames;
}

/**
 * The frames that open a shot. A fade through black, a black run with no cut at either edge, opens one at its
 * middle black frame, its darkest point. A run cut on one edge is split at that cut, which is still a dip to
 * black; one cut on both edges is a black shot of its own. Dips go first, then scene cuts strongest first, and
 * one closer than `minShotSec` to a cut already kept is flicker beside it: dropped, not merged, so every cut
 * kept is one the decode actually found. Last, a cut that close to the first frame or the end is dropped too.
 */
export function pickCuts(
  scores: FrameScore[],
  blacks: Black[],
  o: { threshold: number; minShotSec: number; startSec: number; endSec: number; fps: number },
): Cut[] {
  const apart = (a: number, b: number) => Math.abs(a - b) >= o.minShotSec - 1e-9;
  // A cut on the first black frame or the first frame after the run, with a frame's give either way.
  const edge = 1.5 / o.fps;
  let scene: Cut[] = scores
    .filter((s) => s.sec > o.startSec && s.score >= o.threshold)
    .map((s) => ({ ...s, transition: 'cut' }));
  const dips: Cut[] = [];
  for (const b of blacks) {
    if (b.start <= o.startSec) continue;
    const into = scene.filter((c) => Math.abs(c.sec - b.start) <= edge);
    const out = scene.filter((c) => Math.abs(c.sec - b.end) <= edge);
    if (into.length && out.length) continue;
    if (into.length || out.length) {
      for (const c of [...into, ...out]) c.transition = 'dip to black';
      continue;
    }
    const black = scores.filter((s) => s.sec >= b.start && s.sec < b.end);
    if (!black.length) continue;
    dips.push({ sec: black[Math.floor(black.length / 2)].sec, score: null, transition: 'dip to black' });
    scene = scene.filter((c) => c.sec < b.start - edge || c.sec > b.end + edge);
  }
  const ordered = [...dips, ...scene.sort((a, b) => b.score! - a.score! || a.sec - b.sec)];
  const kept: Cut[] = [];
  for (const c of ordered) if (kept.every((k) => apart(k.sec, c.sec))) kept.push(c);
  return kept.filter((c) => apart(c.sec, o.startSec) && apart(c.sec, o.endSec)).sort((a, b) => a.sec - b.sec);
}

const round = (n: number) => Number(n.toFixed(3));

/** The height of the decode's small copy: scale's -2 keeps the shape and rounds the height to an even number. */
const scoreRows = (width: number, height: number) => 2 * Math.round((SCORE_WIDTH * height) / width / 2);

/** The picture's share of the frame's height: between black bars when there are matching ones above and below, else 1. */
export function pictureShareOf(picture: { top: number; bottom: number } | null, rows: number): number {
  if (!picture || picture.bottom > rows - 1) return 1;
  const above = picture.top;
  const below = rows - 1 - picture.bottom;
  if (above <= 0 || below <= 0 || Math.abs(above - below) > Math.max(2, BAR_SLACK * rows)) return 1;
  return (picture.bottom - picture.top + 1) / rows;
}


export function shotsFrom(cuts: Cut[], o: { startSec: number; endSec: number; fps: number }): Shot[] {
  const opens: { sec: number; score: number | null; transition: Transition | null }[] = [{ sec: o.startSec, score: null, transition: null }, ...cuts];
  return opens.map((open, i) => {
    const end = i + 1 < opens.length ? opens[i + 1].sec : o.endSec;
    return {
      shot: i + 1,
      start: round(open.sec),
      end: round(end),
      duration: round(end - open.sec),
      startFrame: frameShowing(open.sec, o.fps),
      transition: open.transition,
      cutScore: open.score === null ? null : round(open.score),
      speech: null,
      shotSize: null,
      faceShare: null,
    };
  });
}

/** Each word goes to the shot its midpoint falls in, so a line spoken across a cut is split where the cut is. */
export function withSpeech(shots: Shot[], transcript: Transcript): Shot[] {
  const said: string[][] = shots.map(() => []);
  for (const chunk of transcript.chunks) {
    for (const w of chunk.words) {
      const mid = (w.timestamp[0] + w.timestamp[1]) / 2;
      const i = shots.findIndex((s, k) => mid < s.end || k === shots.length - 1);
      if (i >= 0 && mid >= shots[i].start) said[i].push(w.text.trim());
    }
  }
  return shots.map((s, i) => {
    const text = said[i].filter(Boolean).join(' ').replace(/\s+([,.!?;:])/g, '$1');
    return { ...s, speech: text || null };
  });
}

/**
 * Each sample goes to the shot whose frames it falls in, on the frames grid: faces finds its own cuts, so a sample
 * is placed by its time, never by the shot faces put it in. `pictureShare` is the picture's share of the frame's
 * height, so a face is measured against the picture inside any letterbox.
 */
export function withShotSize(shots: Shot[], clip: FacesClip, fps: number, pictureShare = 1): Shot[] {
  const samples = clip.shots.flatMap((s) => s.samples);
  return shots.map((s, i) => {
    const end = i + 1 < shots.length ? shots[i + 1].startFrame : Infinity;
    const mine = samples.filter((x) => {
      const at = frameShowing(x.sec, fps);
      return at >= s.startFrame && at < end;
    });
    return { ...s, ...(shotSizeOf(mine, clip.height * pictureShare) ?? { shotSize: null, faceShare: null }) };
  });
}

/**
 * The face boxes for this video, unless there are none, they cannot be read, or they are another clip's. A file named
 * with --faces was chosen on purpose, so anything wrong with it stops the command rather than emptying a column.
 */
function shotSizeSource(video: string, named: string | undefined): { source: Source; clip?: FacesClip } {
  const path = named ?? ownFaces(video) ?? facesPathFor(video);
  const run = (args: string) => `npx @veedstudio/openedit-cli ${args}`;
  const instead = `name the faces.json faces wrote for ${shellArg(video)}, or leave out --faces`;
  if (named && existsSync(named) && statSync(named).isDirectory()) {
    throw new Error(`--faces names the directory ${named}: name the file in it, as --faces ${shellArg(join(named, 'faces.json'))}`);
  }
  if (!existsSync(path)) {
    if (named) throw new Error(`no face boxes at ${path}: run ${run(`faces ${shellArg(video)} --out <dir>`)} first, or leave out --faces`);
    return {
      source: {
        path: null,
        why: `no face boxes at ${path}. Run ${run(`faces ${shellArg(video)}`)}, then run shots again, or name boxes kept ` +
          'elsewhere with --faces <faces.json>',
      },
    };
  }
  let clip: FacesClip;
  try {
    clip = readFaces(path);
  } catch (e) {
    if (named) throw new Error(`${(e as Error).message}: ${instead}`);
    return { source: { path: null, why: `${(e as Error).message}. Run ${run(`faces ${shellArg(video)}`)} again, then run shots again` } };
  }
  const other = notFacesOf(clip, video, probeSquareSize(video), probeVideoSpan(video).end);
  if (!other) return { source: { path }, clip };
  if (named) throw new Error(`${path} ${other}: ${instead}`);
  // faces will not overwrite another clip's boxes at its default place, so they go beside, and are named here.
  const why = sameFile(clip.video, video)
    ? `${path} ${other}: the video has changed since. Run ${run(`faces ${shellArg(video)}`)} again, then run shots again`
    : `${path} ${other}. Run ${run(`faces ${shellArg(video)} --out <dir>`)}, then ${run(`shots ${shellArg(video)} --faces <dir>/faces.json`)}`;
  return { source: { path: null, why } };
}

/** The transcript on disk for this video, unless there is none or it runs past the end of the media. */
function speechSource(video: string, pictureEnd: number): { source: Source; transcript?: Transcript } {
  if (!hasAudioStream(video)) return { source: { path: null, why: 'the video has no audio track' } };
  const path = transcriptPathFor(video);
  if (!existsSync(path)) {
    return {
      source: {
        path: null,
        why: `no transcript at ${path}. If the video has speech, transcribe it with npx @veedstudio/openedit-cli ` +
          `transcribe ${shellArg(video)} (VEED transcription consumes the VEED workspace's transcription credits; ` +
          'WhisperX is free), then run shots again',
      },
    };
  }
  let read: TranscriptRead;
  try {
    read = readTranscriptFile(path);
  } catch (error) {
    return { source: { path: null, why: `${(error as Error).message}. Speech is not listed` } };
  }
  const { transcript } = read;
  // reduce, not a spread: one argument per word throws RangeError on an hour-long transcript.
  const lastWord = transcript.chunks.reduce((t, c) => c.words.reduce((u, w) => Math.max(u, w.timestamp[1]), t), 0);
  // A recording whose header holds no lengths (a browser's, for one) leaves the picture's end to hold it to.
  let audioEnd = 0;
  try {
    audioEnd = audioDurationOf(video);
  } catch {
    // no length recorded for the audio
  }
  const mediaEnd = Math.max(pictureEnd, audioEnd);
  if (lastWord > mediaEnd + TRANSCRIPT_OVERRUN_SEC) {
    return {
      source: {
        path: null,
        why: `the transcript at ${path} has words until ${lastWord.toFixed(3)}s, but this video ends at ` +
          `${mediaEnd.toFixed(3)}s, so it belongs to another video with the same run key. Speech is not listed`,
      },
    };
  }
  return { source: read.mapped ? { path, mappedFrom: read.format } : { path }, transcript };
}

export function shotList(videoArg: string, o: { threshold: number; minShotSec: number; faces?: string }): ShotList {
  return measure(videoArg, o).list;
}

/** The shot list, and the time of every frame the decode found, which the storyboard picks its frames from. */
export function measure(videoArg: string, o: { threshold: number; minShotSec: number; faces?: string }): { list: ShotList; pts: number[] } {
  const video = resolveVideoArg(videoArg);
  if (!existsSync(video)) throw new Error(`video not found: ${video}`);
  const rate = probeFrameRate(video);
  const { width, height } = probeDisplaySize(video);
  // Before the decode, so a --faces that names the wrong file stops the command before a long reference is read.
  const faces = shotSizeSource(video, o.faces === undefined ? undefined : resolve(o.faces));
  const { scores, blacks, picture } = decodeFrames(video);
  const pictureShare = pictureShareOf(picture, scoreRows(width, height));
  // The picture starts at its first frame on ffmpeg's clock (later than zero when the audio leads), and
  // runs for the stream's own length from there.
  const startSec = scores[0].sec;
  const lastSec = scores[scores.length - 1].sec;
  const own = ownVideoDurationOf(video);
  const declaredEnd = own === null ? null : startSec + own;
  // A file cut short still decodes without an error exit, up to where its data stops; its header keeps the
  // whole length. Three frames of slack allow for how a variable-rate stream rounds its last one. Without
  // the stream's own length there is nothing to hold the decode to, since the container's counts the audio.
  const frame = 1 / Math.min(rate.fps, rate.averageFps);
  if (declaredEnd !== null && declaredEnd - (lastSec + frame) > 3 * frame) {
    throw new Error(`${video} declares ${declaredEnd.toFixed(3)}s of picture, but frames decode only until ` +
      `${lastSec.toFixed(3)}s: the file is cut short or damaged, so the shots after that cannot be listed`);
  }
  const endSec = Math.max(declaredEnd ?? 0, lastSec + 1 / rate.fps);
  const cuts = pickCuts(scores, blacks, { ...o, startSec, endSec, fps: rate.fps });
  const plain = shotsFrom(cuts, { startSec, endSec, fps: rate.fps });
  const { source, transcript } = speechSource(video, endSec);
  const said = transcript ? withSpeech(plain, transcript) : plain;
  const list: ShotList = {
    video,
    fps: rate.fps,
    frameRate: rate.rate.replace(/\/1$/, ''),
    durationSec: round(endSec),
    width,
    height,
    pictureHeight: Math.round(height * pictureShare),
    threshold: o.threshold,
    minShotSec: round(o.minShotSec),
    sources: { speech: source, shotSize: faces.source },
    shots: faces.clip ? withShotSize(said, faces.clip, rate.fps, pictureShare) : said,
  };
  return { list, pts: scores.map((s) => s.sec) };
}

export const usage = {
  summary: 'A video as a shot list: each shot\'s start and length, what is said in it, its shot size, and storyboard sheets of a few frames of every shot',
  positionals: '<video>',
  flags: {
    threshold: { type: 'string', value: '<0-1>', help: `Scene score a frame needs to count as a cut (default ${DEFAULT_THRESHOLD}); lower finds cuts between similar pictures and also more flicker; 0.2 drops flicker inside effects and most jump cuts` },
    'min-shot': { type: 'string', value: '<sec>', help: `Shortest shot kept; of two cuts closer than this, the weaker is read as flicker (default ${round(DEFAULT_MIN_SHOT_SEC)})` },
    faces: { type: 'string', value: '<faces.json>', help: 'The faces.json shot sizes are read from (default the clip\'s own, in runs/<key>/faces-<hash>/ where faces writes them, else in runs/<key>/faces.json when an older faces wrote them there for this clip); one named here that is missing, unreadable or another clip\'s stops the command' },
    json: { type: 'boolean', help: 'Print the shot list as JSON' },
  },
  notes: 'The list is also written to runs/<key>/shots.json. A shot opens on a hard cut or on a dip to black (a fade through ' +
    'black splits at its middle black frame). A dissolve is neither, so the two shots it joins read as one, and about one jump ' +
    'cut in three (one take with a stretch removed) scores under the default. Speech comes from the transcript at runs/<key>/transcript.json, ' +
    'and shot size from the face boxes the faces command writes to runs/<key>/faces-<hash>/faces.json (or the file --faces names); this command reads ' +
    'both and makes neither. Per shot, `faceShare` is the largest face\'s height as a share of the picture\'s height (0 to 1; the rows ' +
    'between black bars when the clip is letterboxed, `pictureHeight`), the median over the shot\'s samples that show a face, and ' +
    `\`shotSize\` reads it: close-up from ${CLOSE_UP_MIN}, medium from ${MEDIUM_MIN}, wide below, and no face when fewer than half the ` +
    'samples show one. Both are null when there is no usable faces.json, or no sample falls in the shot. The detector often misses a face ' +
    'the frame cuts through (an extreme close-up), one in shadow or behind something and one very small in a wide shot, reads a face in ' +
    'profile a size off now and then, and now and then finds a face in a title, an effect or the back of a head: check the sizes a plan ' +
    'leans on against the storyboard. Black rows count as bars only when they sit above and below the picture and match, as centred ' +
    'padding does; text or a blurred fill in the bars, or one frame lit edge to edge anywhere in the clip (a full-frame title, say), ' +
    'leaves the bars in, and every share then reads small. Inside bars faces are found on a smaller picture, so a wide shot can read ' +
    'medium. On-screen text is not read; the storyboard shows it, and the framing, at the frames it holds. Its sheets are ' +
    `runs/<key>/storyboard-<run>-<n>.jpg, at most ${MAX_SHEETS}, at most ${SHEET_SIDE} px a side (a later run removes those no list ` +
    `names once they are ${LEASE_MS / 60_000} minutes old), named in shots.json with every tile's ` +
    `shot, frame, time, sheet, row and column (from 1). A shot of ${THREE_FRAMES_FROM_SEC} s or more shows its first, middle and last frame, a ` +
    'shorter one its middle, each labelled #<shot> <seconds> above it, row by row in shot order with a shot\'s frames on one row. A tile ' +
    'is about 130,000 pixels of picture (480x270 at 16:9, 270x480 at 9:16, never wider than the source): up to 6 shots of three frames a ' +
    `sheet at 16:9 or 9:16. When three frames a shot do not fit ${MAX_SHEETS} sheets, every shot shows its middle frame (up to 96 shots at ` +
    '16:9, 84 at 9:16); past that the tiles shrink until every shot fits. storyboard.note says when either happens. A storyboard that cannot be made ' +
    'leaves the list whole and says why in storyboard.why.',
} satisfies Usage;

/** Lists the shots, then draws their storyboard; the list is written whether or not the storyboard can be. */
export async function shots(argv: string[], draw = writeStoryboard): Promise<number> {
  const { values, positionals } = parseUsage('shots', usage, argv);
  const [video] = positionals;
  if (!video || positionals.length > 1) {
    console.error(usageLine('shots', usage));
    return 2;
  }
  const threshold = numberFlag('threshold', values.threshold, DEFAULT_THRESHOLD, (n) => n > 0 && n <= 1, 'a score above 0 and at most 1');
  const minShotSec = numberFlag('min-shot', values['min-shot'], round(DEFAULT_MIN_SHOT_SEC), (n) => n >= 0, 'seconds');
  const { list: plain, pts } = measure(video, { threshold, minShotSec, faces: values.faces });
  const dir = join(runsDir(), runKeyOf(plain.video));
  const out = join(dir, 'shots.json');
  const run = startStoryboard(dir);
  let storyboard: StoryboardResult;
  try {
    storyboard = await draw(plain.video, plain.shots, pts, plain.fps, dir, run.attempt);
  } catch (e) {
    storyboard = { sheets: [], why: `it could not be made: ${failureOf(e)}` };
  }
  const list: ShotListFile = { ...plain, storyboard };
  try {
    writeAtomic(out, list);
  } finally {
    sweepStoryboards(run, out);
  }

  if (values.json) {
    console.log(JSON.stringify(list, null, 2));
    return 0;
  }
  console.log(`shots: ${list.shots.length} shot(s) in ${list.video} (${list.frameRate} fps, ${list.width}x${list.height}, ` +
    `${list.durationSec.toFixed(3)}s); a cut is a scene score of ${list.threshold} or more, a shot at least ${list.minShotSec}s`);
  const boxes = list.sources.shotSize;
  console.log('  shot     start    length  first frame  from    shot size       speech');
  for (const s of list.shots) {
    const said = s.speech === null ? '' : `"${s.speech}"`;
    const size = boxes.path === null ? '' : s.shotSize === null ? 'not sampled' : `${s.shotSize}${s.faceShare === null ? '' : ` ${s.faceShare.toFixed(3)}`}`;
    console.log((`  ${String(s.shot).padStart(4)}  ${`${s.start.toFixed(3)}s`.padStart(8)}  ${`${s.duration.toFixed(3)}s`.padStart(8)}  ` +
      `f${String(s.startFrame).padStart(6, '0')}      ${(s.transition === 'dip to black' ? 'black' : s.transition ?? 'start').padEnd(6)}  ` +
      `${size.padEnd(14)}  ${said}`).trimEnd());
  }
  const speech = list.sources.speech;
  console.log(speech.path === null ? `  speech: none listed: ${speech.why}`
    : `  speech: ${speech.path}${speech.mappedFrom ? `, read as ${speech.mappedFrom}, mapped in memory` : ''}`);
  if (boxes.path === null) console.log(`  shot size: none listed: ${boxes.why}`);
  else {
    const bars = list.pictureHeight < list.height
      ? `, the picture ${list.pictureHeight} of ${list.height} rows between black bars, where a wide shot can read medium` : '';
    console.log(`  shot size: ${boxes.path} (the largest face's height over the picture's${bars}: close-up from ${CLOSE_UP_MIN}, ` +
      `medium from ${MEDIUM_MIN}, wide below). A face the frame cuts through, in shadow or very small often reads as no face, one in ` +
      'profile now and then a size off, and a title or an effect now and then as a face: check those shots on the storyboard');
  }
  const board = list.storyboard;
  if ('why' in board) console.log(`  storyboard: none: ${board.why}`);
  else {
    const which = board.tiles.some((t) => t.at !== 'middle')
      ? `the first, middle and last of a shot of ${THREE_FRAMES_FROM_SEC}s or more, the middle of a shorter one`
      : 'the middle of each';
    console.log(`  storyboard: a few frames of every shot, labelled #<shot> <seconds> in shot order (${which}), on ` +
      `${board.sheets.length} sheet(s) of ${board.tile.width}x${board.tile.height} tiles; they show framing and on-screen text at those frames:`);
    for (const path of board.sheets) {
      const on = board.tiles.filter((t) => t.sheet === path);
      const [first, last] = [on[0].shot, on[on.length - 1].shot];
      console.log(`    ${path}  ${first === last ? `shot ${first}` : `shots ${first}-${last}`}`);
    }
    if (board.note) console.log(`  storyboard note: ${board.note}`);
  }
  console.log(`  list: ${out}`);
  return 0;
}

/** The line that says why: ffmpeg's own last word when it has one, else the error's first line. */
function failureOf(e: unknown): string {
  const stderr = String((e as { stderr?: unknown }).stderr ?? '').trim().split('\n').at(-1);
  return stderr || String((e as Error).message ?? e).split('\n')[0];
}
