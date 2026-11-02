// A clip's decoded picture as it is shown, for a filter graph that cuts, joins or lays it.

/**
 * ffmpeg turns a rotated clip upright before any filter but leaves the rotation on its frames, which a graph's
 * encoder writes out again, so it is dropped; pixels that are not square are stretched to square ones.
 */
export function asShown(s: { width: number; height: number; sar: number }): string[] {
  return ['sidedata=mode=delete:type=DISPLAYMATRIX', ...(s.sar === 1 ? [] : [`scale=${s.width}:${s.height}`, 'setsar=1'])];
}
