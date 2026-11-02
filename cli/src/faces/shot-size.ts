// A shot's size from the face boxes `faces` found in it: how tall the largest face stands against the picture.
import type { Sample } from './page-script.ts';

export type ShotSize = 'close-up' | 'medium' | 'wide' | 'no face';

/** A size and the face share it was read from: every size but no face has one. */
export type SizeReading = { shotSize: 'no face'; faceShare: null } | { shotSize: Exclude<ShotSize, 'no face'>; faceShare: number };

// Shot sizes are named for where the frame's bottom edge cuts the body, and each threshold is midway between the
// face shares two neighbouring sizes leave (adult proportions, a face box two thirds of the head's height), inside
// the gap shots labelled by eye left between those sizes.
export const CLOSE_UP_MIN = 0.24;
export const MEDIUM_MIN = 0.16;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * A shot's size from its samples, or null when it has none: no face when fewer than half of them show one (such
 * finds are mostly false, on titles, effects and the backs of heads), else the median share, which one turned head
 * or a short push in does not move.
 */
export function shotSizeOf(samples: Sample[], pictureHeight: number): SizeReading | null {
  if (!samples.length) return null;
  const tallest = samples.map((s) => s.faces.reduce((h, f) => Math.max(h, f.h), 0)).filter((h) => h > 0);
  if (tallest.length * 2 < samples.length) return { shotSize: 'no face', faceShare: null };
  // A box can run into a letterbox's bars, past the picture it is measured against.
  const faceShare = Number(Math.min(1, median(tallest) / pictureHeight).toFixed(3));
  return { shotSize: faceShare >= CLOSE_UP_MIN ? 'close-up' : faceShare >= MEDIUM_MIN ? 'medium' : 'wide', faceShare };
}
