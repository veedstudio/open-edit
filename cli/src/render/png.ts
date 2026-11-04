// Just enough of a PNG decoder for what the renderer asks of a captured frame: does it show anything,
// does it cover what lies under it, and where does it draw (its alpha, which behind weighs)? A page that
// failed to draw renders as one flat colour (or, with a transparent background, as nothing at all), and a
// video of that is the one failure that otherwise looks like success. withAlpha re-encodes a frame for an
// encoder that must see one pixel format.
import { crc32, deflateSync, inflateSync } from 'node:zlib';

export interface Blankness {
  /** Every pixel is the same colour. */
  uniform: boolean;
  /** The largest alpha in the frame; 0 means nothing was drawn on a transparent background. */
  alphaMax: number;
  /** Every pixel is fully opaque: on a transparent background, the page painted over all of it. */
  opaque: boolean;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Parsed {
  width: number;
  height: number;
  colour: number;
  channels: number;
  /** The image data, still compressed. */
  idat: Buffer;
  /** Every chunk but IHDR, IDAT and IEND (colour space, gamma), whole, in order. */
  other: Buffer[];
}

function parse(png: Buffer): Parsed {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  const other: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('latin1', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colour = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    else other.push(png.subarray(off, off + 12 + len));
    off += 12 + len;
  }
  const channels = CHANNELS[colour];
  if (depth !== 8 || !channels || interlace !== 0) throw new Error(`unsupported PNG layout (depth ${depth}, colour type ${colour}, interlace ${interlace})`);
  return { width, height, colour, channels, idat: Buffer.concat(idat), other };
}

/** Undoes row y's filter, from `raw` (the inflated image data) into `row`, given the row above it. */
function unfilter(raw: Buffer, y: number, row: Buffer, prev: Buffer, channels: number): void {
  const stride = row.length;
  const base = y * (stride + 1) + 1;
  const filter = raw[base - 1];
  // One loop per filter rather than a switch per byte: this runs over every byte of a frame.
  switch (filter) {
    case 0:
      raw.copy(row, 0, base, base + stride);
      return;
    case 1:
      for (let x = 0; x < channels; x++) row[x] = raw[base + x];
      for (let x = channels; x < stride; x++) row[x] = (raw[base + x] + row[x - channels]) & 0xff;
      return;
    case 2:
      for (let x = 0; x < stride; x++) row[x] = (raw[base + x] + prev[x]) & 0xff;
      return;
    case 3:
      for (let x = 0; x < channels; x++) row[x] = (raw[base + x] + (prev[x] >> 1)) & 0xff;
      for (let x = channels; x < stride; x++) row[x] = (raw[base + x] + ((row[x - channels] + prev[x]) >> 1)) & 0xff;
      return;
    case 4:
      for (let x = 0; x < channels; x++) row[x] = (raw[base + x] + prev[x]) & 0xff;
      for (let x = channels; x < stride; x++) {
        const a = row[x - channels];
        const b = prev[x];
        const c = prev[x - channels];
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        row[x] = (raw[base + x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      return;
    default:
      throw new Error(`corrupt PNG: filter ${filter} on row ${y}`);
  }
}

export function inspectPng(png: Buffer): Blankness {
  const { width, height, colour, channels, idat } = parse(png);
  const raw = inflateSync(idat);
  const stride = width * channels;
  const hasAlpha = colour === 4 || colour === 6;
  let prev = Buffer.alloc(stride);
  let row = Buffer.alloc(stride);
  const first = Buffer.alloc(channels);
  let uniform = true;
  let alphaMax = hasAlpha ? 0 : 255;
  let alphaMin = 255;

  for (let y = 0; y < height; y++) {
    unfilter(raw, y, row, prev, channels);
    if (y === 0) row.copy(first, 0, 0, channels);
    for (let x = 0; x < stride; x += channels) {
      if (hasAlpha) {
        const alpha = row[x + channels - 1];
        if (alpha > alphaMax) alphaMax = alpha;
        if (alpha < alphaMin) alphaMin = alpha;
      }
      if (uniform) {
        for (let c = 0; c < channels; c++) {
          if (row[x + c] !== first[c]) { uniform = false; break; }
        }
      }
    }
    // Once a frame is known to vary, only a transparent one still needs reading, for its alpha: until
    // it has shown both an opaque pixel and one that is not.
    if (!uniform && (!hasAlpha || (alphaMax === 255 && alphaMin < 255))) break;
    [prev, row] = [row, prev];
  }
  return { uniform, alphaMax, opaque: alphaMin === 255 };
}

/** Each pixel's alpha, row by row from the top left; 255 throughout for a PNG without an alpha channel. */
export function alphaOf(png: Buffer): { width: number; height: number; alpha: Uint8Array } {
  const { width, height, colour, channels, idat } = parse(png);
  const alpha = new Uint8Array(width * height);
  if (colour !== 4 && colour !== 6) return { width, height, alpha: alpha.fill(255) };
  const raw = inflateSync(idat);
  const stride = width * channels;
  let prev = Buffer.alloc(stride);
  let row = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    unfilter(raw, y, row, prev, channels);
    for (let x = 0, o = y * width; x < width; x++, o++) alpha[o] = row[x * channels + channels - 1];
    [prev, row] = [row, prev];
  }
  return { width, height, alpha };
}

/** Where two pictures of one size differ: how many pixels, and the box around them. RGB counts as opaque RGBA. */
export function pngDifference(a: Buffer, b: Buffer): { pixels: number; total: number; box: [number, number, number, number] | null } {
  const pa = parse(a);
  const pb = parse(b);
  if (pa.width !== pb.width || pa.height !== pb.height) throw new Error(`the pictures differ in size (${pa.width}x${pa.height} and ${pb.width}x${pb.height})`);
  const ra = inflateSync(pa.idat);
  const rb = inflateSync(pb.idat);
  let prevA = Buffer.alloc(pa.width * pa.channels);
  let rowA = Buffer.alloc(pa.width * pa.channels);
  let prevB = Buffer.alloc(pb.width * pb.channels);
  let rowB = Buffer.alloc(pb.width * pb.channels);
  // A grey or grey-alpha PNG is read as one colour channel, so it compares with RGB on its value.
  const at = (row: Buffer, x: number, ch: number, c: number) => {
    const colourChannels = ch >= 3 ? 3 : 1;
    if (c < 3) return row[x * ch + (colourChannels === 3 ? c : 0)];
    return ch === 4 || ch === 2 ? row[x * ch + ch - 1] : 255;
  };
  let pixels = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < pa.height; y++) {
    unfilter(ra, y, rowA, prevA, pa.channels);
    unfilter(rb, y, rowB, prevB, pb.channels);
    for (let x = 0; x < pa.width; x++) {
      let same = true;
      for (let c = 0; c < 4 && same; c++) same = at(rowA, x, pa.channels, c) === at(rowB, x, pb.channels, c);
      if (same) continue;
      pixels++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
    [prevA, rowA] = [rowA, prevA];
    [prevB, rowB] = [rowB, prevB];
  }
  return { pixels, total: pa.width * pa.height, box: pixels ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null };
}

/** Whether a frame counts as drawn: something varies, and on a transparent background something is visible. */
export const showsSomething = (b: Blankness): boolean => !b.uniform && b.alphaMax > 0;

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(data, crc32(head.subarray(4))), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * The same picture as an RGBA PNG. Chrome writes a capture with no transparent pixel as RGB, and an
 * ffmpeg that sees a piped stream change pixel format (5.1, as Debian 12 ships) rebuilds its filter
 * graph and drops the page from the next frames of an overlay, so the footage shows through them.
 */
export function withAlpha(png: Buffer): Buffer {
  const { width, height, colour, channels, idat, other } = parse(png);
  if (colour === 6) return png;
  if (colour !== 2) throw new Error(`unsupported PNG colour type ${colour}`);
  const raw = inflateSync(idat);
  const stride = width * channels;
  let prev = Buffer.alloc(stride);
  let row = Buffer.alloc(stride);
  // Each output row starts with filter 0 (none), which the zeroed buffer already holds.
  const out = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    unfilter(raw, y, row, prev, channels);
    let o = y * (width * 4 + 1) + 1;
    for (let x = 0; x < stride; x += 3) {
      out[o++] = row[x];
      out[o++] = row[x + 1];
      out[o++] = row[x + 2];
      out[o++] = 255;
    }
    [prev, row] = [row, prev];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  // Stored, not compressed: the frame only crosses a pipe to ffmpeg, and compressing it would cost more than the copy.
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), ...other, chunk('IDAT', deflateSync(out, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}
