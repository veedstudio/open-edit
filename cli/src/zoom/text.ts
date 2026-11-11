// The size of the text around a point of a screen recording, from one full-size grey frame and no OCR: glyphs are dense
// in vertical strokes, so a line of text is a band of rows rich in steps from one column to the next, with quieter rows
// above and below it. The band nearest the point is its line, and its height from its top to its baseline gives the font
// size.

/** A line of text found near the point, in the frame's pixels, and the font size it is set at. */
export interface TextLine { x: number; y: number; w: number; h: number; em: number }

// A step of this many grey levels from one pixel to the next is an edge of a glyph: light grey placeholder text included.
const STEP = 20;
// A row of the window holds text where it has at least this many edges, and this share of the busiest row's: the sides
// of a button, a checkbox or a field cross a row twice, a line of text many times.
const ROW_EDGES = 3;
const ROW_SHARE = 0.15;
// A column with edges in more than this share of the window's rows is a rule or a box's side, not text.
const RULE = 0.6;
// The half-widths of the windows searched around the point, nearest first, on a 1920-wide frame: a label, then a
// control's neighbourhood, then the panel it sits in. The windows are half as tall as they are wide.
const REACHES = [120, 240, 480];
// A band of text rows on a 1920-wide frame is at least this tall (smaller is a rule, an underline, a scrap of a glyph or
// noise: interface text is seldom set under 10 px), at most this (taller is a picture or rows of text run together), and
// LINE_WIDE times as wide as it is tall (narrower is an icon, a close button or a checkbox).
const LINE_MIN = 8;
const LINE_MAX = 90;
const LINE_WIDE = 1.5;
// The font size is read from the line's top to its baseline, the last row of the letters' bodies (the last with at least
// BODY of the densest row's edges), so descenders, whose few strokes may or may not clear ROW_SHARE, play no part. That
// span is a capital's or an ascender's height less the row anti-aliasing smears past it, about EM_CAP of the font size in
// the common interface faces (Helvetica, Arial, San Francisco, Segoe, Roboto). A line of x-height letters alone reads
// smaller than it is, which errs on the side of zooming further in.
const EM_CAP = 0.72;
const BODY = 0.5;
// Quiet rows inside a line, a light face's thin strokes or a strikethrough's gap, up to this many on a 1920-wide frame.
const BRIDGE = 2;

/**
 * The text line nearest (x, y) in a grey frame of `width` x `height`, and its font size, or null when there is none in
 * reach. `hide` is the cursor's box, left out so that the arrow is not read as a glyph.
 */
export function textNear(frame: Uint8Array, width: number, height: number, x: number, y: number, hide: { x: number; y: number; w: number; h: number } | null = null): TextLine | null {
  const unit = Math.max(width, height) / 1920;
  const hidden = hide && { x0: hide.x - 2, y0: hide.y - 2, x1: hide.x + hide.w + 2, y1: hide.y + hide.h + 2 };
  for (const reach of REACHES) {
    const hw = Math.round(reach * unit), hh = Math.round((reach / 2) * unit);
    const x0 = Math.max(0, x - hw), x1 = Math.min(width - 2, x + hw);
    const y0 = Math.max(0, y - hh), y1 = Math.min(height - 1, y + hh);
    const rows = y1 - y0 + 1, cols = x1 - x0 + 1;
    if (rows < 3 || cols < 3) continue;
    const edge = new Uint8Array(rows * cols);
    const perColumn = new Int32Array(cols);
    for (let r = 0; r < rows; r++) {
      const yy = y0 + r;
      for (let c = 0; c < cols; c++) {
        const xx = x0 + c;
        if (hidden && xx >= hidden.x0 && xx <= hidden.x1 && yy >= hidden.y0 && yy <= hidden.y1) continue;
        const d = frame[yy * width + xx + 1] - frame[yy * width + xx];
        if (d >= STEP || d <= -STEP) { edge[r * cols + c] = 1; perColumn[c]++; }
      }
    }
    const perRow = new Int32Array(rows);
    const minX = new Int32Array(rows).fill(cols), maxX = new Int32Array(rows).fill(-1);
    for (let c = 0; c < cols; c++) {
      if (perColumn[c] > RULE * rows) continue;
      for (let r = 0; r < rows; r++) {
        if (!edge[r * cols + c]) continue;
        perRow[r]++;
        if (c < minX[r]) minX[r] = c;
        if (c > maxX[r]) maxX[r] = c;
      }
    }
    // Bands of text rows, a few quiet rows inside one bridged.
    const least = Math.max(ROW_EDGES, ROW_SHARE * Math.max(...perRow));
    const bridge = Math.max(1, Math.round(BRIDGE * unit));
    const busy = (k: number) => k < rows && perRow[k] >= least;
    const lines: TextLine[] = [];
    for (let r = 0; r < rows;) {
      if (!busy(r)) { r++; continue; }
      let end = r;
      for (let k = r + 1; k < rows && k - end <= bridge + 1; k++) if (busy(k)) end = k;
      const h = end - r + 1;
      let left = cols, right = -1, peak = 0;
      for (let k = r; k <= end; k++) { peak = Math.max(peak, perRow[k]); left = Math.min(left, minX[k]); right = Math.max(right, maxX[k]); }
      const line = { x: x0 + left, y: y0 + r, w: right - left + 1, h };
      // Cut by the window's edge, a band is part of a line and says nothing of its size; so is a scrap beside the
      // cursor's box no wider than two of it, a glyph the box hides most of.
      const cut = r === 0 || end === rows - 1 || (hidden && line.w < 2 * (hidden.x1 - hidden.x0) && line.x <= hidden.x1 + 1
        && line.x + line.w >= hidden.x0 - 1 && line.y <= hidden.y1 && line.y + line.h >= hidden.y0);
      if (h >= LINE_MIN * unit && h <= LINE_MAX * unit && line.w >= LINE_WIDE * h && !cut) {
        let baseline = end;
        while (baseline > r && perRow[baseline] < BODY * peak) baseline--;
        lines.push({ ...line, em: Math.max(1, baseline - r) / EM_CAP });
      }
      r = end + 1;
    }
    const distance = (l: TextLine) => Math.hypot(Math.max(0, l.x - x, x - (l.x + l.w)), 2 * Math.max(0, l.y - y, y - (l.y + l.h)));
    const near = lines.filter((l) => distance(l) <= hw).sort((a, b) => distance(a) - distance(b))[0];
    if (near) return near;
  }
  return null;
}
