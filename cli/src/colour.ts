// The colour a re-encode writes: all four tags (primaries, transfer, matrix, range), never some of them. The encoder
// writes whatever the frames carry, and a decoder labels some axes on its own (VP8 its matrix and range alone), so an
// encode that stamps nothing passes on a partial set, which describes no picture and which apply-edl refuses.
import { hdrKind, hdrTags, MATRICES } from './hdr.ts';
import { BT709, SDR_MATRICES, type ColourTags, type DecodedColour } from './probe.ts';

/** Pictures the colorspace filter cannot read: RGB, and YUV whose format says full range. */
const SWSCALE_ONLY = /^(rgb|bgr|gbr|argb|abgr|0rgb|0bgr|x2rgb|x2bgr|pal8|yuvj)/;

/** A YUV matrix both swscale and the colorspace filter convert from and to; RGB (`gbr`) is no matrix. */
const yuvMatrix = (space: string) => space !== 'gbr' && Object.hasOwn(MATRICES, space);

/**
 * The tags a re-encode of a source writes (see decodedColourOf for what it declares): all three, when it declares them;
 * else BT.709's on the axes it leaves unset, as every command assumes them (an HDR source's are BT.2020's, as its
 * conversion reads them), with the primaries or transfer it does declare kept. A declared matrix is converted rather
 * than kept: the YUV values are coded in it, so stampColour can make BT.709's true of them.
 */
export function settledTags(colour: DecodedColour): ColourTags {
  const { primaries = BT709.primaries, transfer = BT709.transfer } = colour.declared;
  const tags = !colour.assumed ? colour.tags : hdrKind(colour) ? hdrTags(colour) : { primaries, transfer, space: BT709.space };
  return yuvMatrix(tags.space) ? tags : { ...tags, space: BT709.space };
}

/**
 * The filters, last in a chain, that bring a picture of `colour` to `to` in 8-bit 4:2:0, limited range, and label all
 * four axes on its frames. The matrix it is coded in (BT.709 when it declares none, BT.2020 for HDR) is converted to
 * `to`'s by the colorspace filter, matrix and range only, which is exact and costs next to nothing: swscale's default
 * rounding takes two levels off a grey it converts between matrices, and its accurate one is many times slower.
 * swscale codes what colorspace cannot read, as it codes a render's frames.
 */
export function stampColour(colour: DecodedColour, to: ColourTags): string[] {
  const label = `setparams=color_primaries=${to.primaries}:color_trc=${to.transfer}:colorspace=${to.space}:range=tv`;
  const declared = colour.declared.space ?? (hdrKind(colour) ? 'bt2020nc' : BT709.space);
  const from = yuvMatrix(declared) ? declared : undefined;
  if (SWSCALE_ONLY.test(colour.pixFmt)) {
    return [`scale=${from ? `in_color_matrix=${MATRICES[from]}:` : ''}out_color_matrix=${MATRICES[to.space]}:out_range=tv`, 'format=yuv420p', label];
  }
  if ((from ?? to.space) === to.space && !colour.full) return ['format=yuv420p', label];
  // Primaries and transfer are named alike on both sides, so nothing but the matrix and range is converted.
  return [`colorspace=ispace=${from ?? to.space}:space=${to.space}:irange=${colour.full ? 'pc' : 'tv'}:range=tv`
    + ':iprimaries=bt709:primaries=bt709:itrc=bt709:trc=bt709:fast=1', 'format=yuv420p', label];
}

/** A picture toSdr has converted: SDR BT.709 on every axis, for stampColour. */
export const CONVERTED: DecodedColour = Object.freeze({ tags: BT709, assumed: false, declared: BT709, full: false, pixFmt: 'yuv420p' });

const describeTags = (t: ColourTags) => `${t.primaries}/${t.transfer}/${t.space}`;

/**
 * The colour a join of `sources` comes out in, and the filters that bring each source to it, for every command that
 * joins: the first source's settled tags, which are BT.709's for an untagged or partly tagged source and for an HDR
 * one converted first (`sdr`), with each source's matrix and range converted to them by stampColour and its frames
 * labelled with them. SD and HD primaries and transfer are near enough to be relabelled, as players treat them; a
 * wide-gamut source among narrow ones, or the other way round, is refused, as is one that declares only part of its
 * colour where the BT.709 assumption contradicts it.
 */
export function joinColour(sources: { id: string; colour: DecodedColour; sdr: boolean }[]): { tags: ColourTags; stamps: string[][] } {
  for (const { id, colour, sdr } of sources) {
    if (sdr || !colour.assumed) continue;
    // A lone SD or HD matrix only says how the picture was coded, so the join converts from it; anything else declared
    // alone describes a picture the BT.709 primaries and transfer do not.
    const contradicted = (Object.entries(colour.declared) as [keyof ColourTags, string][])
      .filter(([axis, value]) => (axis === 'space' ? !SDR_MATRICES.has(value) : value !== BT709[axis]));
    if (contradicted.length > 0) {
      throw new Error(
        `source "${id}" declares ${contradicted.map(([axis, value]) => `${axis} ${value}`).join(' and ')} but not the rest — ` +
          'stamping bt709 over it would mislabel the picture. Tag the file completely before assembling.',
      );
    }
  }
  const settled = sources.map(({ colour, sdr }) => (sdr ? CONVERTED.tags : settledTags(colour)));
  const tags = settled[0];
  const wide = (t: ColourTags) => t.primaries === 'bt2020' || t.transfer.startsWith('bt2020');
  sources.forEach(({ id }, i) => {
    if (wide(settled[i]) !== wide(tags)) {
      throw new Error(
        `sources disagree on colour: "${sources[0].id}" is ${describeTags(tags)} and "${id}" is ${describeTags(settled[i])} — ` +
          'one is wide-gamut, which a join does not convert. Convert them to one colour space before assembling.',
      );
    }
  });
  return { tags, stamps: sources.map(({ colour, sdr }) => stampColour(sdr ? CONVERTED : colour, tags)) };
}
