// Just enough of a PNG decoder to ask one question of a captured frame: does it show anything?
// A page that failed to draw renders as one flat colour (or, with a transparent background, as
// nothing at all), and a video of that is the one failure that otherwise looks like success.
import { inflateSync } from 'node:zlib';

export interface Blankness {
  /** Every pixel is the same colour. */
  uniform: boolean;
  /** The largest alpha in the frame; 0 means nothing was drawn on a transparent background. */
  alphaMax: number;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function inspectPng(png: Buffer): Blankness {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
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
    off += 12 + len;
  }
  const channels = CHANNELS[colour];
  if (depth !== 8 || !channels || interlace !== 0) throw new Error(`unsupported PNG layout (depth ${depth}, colour type ${colour}, interlace ${interlace})`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const hasAlpha = colour === 4 || colour === 6;
  let prev = Buffer.alloc(stride);
  let row = Buffer.alloc(stride);
  const first = Buffer.alloc(channels);
  let uniform = true;
  let alphaMax = hasAlpha ? 0 : 255;

  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base];
    for (let x = 0; x < stride; x++) {
      const cur = raw[base + 1 + x];
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev[x];
      let v: number;
      switch (filter) {
        case 0: v = cur; break;
        case 1: v = cur + a; break;
        case 2: v = cur + b; break;
        case 3: v = cur + ((a + b) >> 1); break;
        case 4: {
          const c = x >= channels ? prev[x - channels] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`corrupt PNG: filter ${filter} on row ${y}`);
      }
      row[x] = v & 0xff;
    }
    if (y === 0) row.copy(first, 0, 0, channels);
    for (let x = 0; x < stride; x += channels) {
      if (hasAlpha) {
        const alpha = row[x + channels - 1];
        if (alpha > alphaMax) alphaMax = alpha;
      }
      if (uniform) {
        for (let c = 0; c < channels; c++) {
          if (row[x + c] !== first[c]) { uniform = false; break; }
        }
      }
    }
    // Once a frame is known to vary, only a transparent one still needs reading, for its alpha.
    if (!uniform && (!hasAlpha || alphaMax === 255)) break;
    [prev, row] = [row, prev];
  }
  return { uniform, alphaMax };
}

/** Whether a frame counts as drawn: something varies, and on a transparent background something is visible. */
export const showsSomething = (b: Blankness): boolean => !b.uniform && b.alphaMax > 0;
