// A PQ or HLG clip whose signal is read as SDR comes out flat, grey and off in hue, and the CLI encodes and
// sends SDR BT.709, so HDR is converted to SDR wherever the CLI decodes or sends a clip. It is placed by
// BT.2408's reference white, with highlights rolled off rather than clipped, so the picture keeps the source's look.
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { FFMPEG, stateDir } from './config.ts';
import { cubeFile, knownPrimaries, toBt709, toLinearText, toSdrSignalText, type SdrParams } from './hdr-lut.ts';
import { BT709, colourTagsOf, type ColourReport, type ColourTags } from './probe.ts';

/** The transfers that make a picture HDR, by the names people know them by. */
const HDR_TRANSFERS: Readonly<Record<string, string>> = { smpte2084: 'PQ', 'arib-std-b67': 'HLG' };

/** `PQ` or `HLG` when the source declares an HDR transfer, whatever else it leaves unset; else null. */
export function hdrKind(colour: ColourReport): string | null {
  return HDR_TRANSFERS[colour.declared.transfer ?? ''] ?? null;
}

/**
 * Placed by BT.2408's reference white (203 cd/m2), so 18% grey (26 cd/m2) lands at Y 109 and skin and midtones
 * keep the source's look. Light above 70% of reference white is rolled off by a Mobius curve that reaches SDR
 * white at 1000 cd/m2, which also brings reference white itself to 86% of SDR white in light: measured Y 222 of
 * 235 where the curves give 221.2, because swscale reads 10-bit input about 0.4% low and writes 8-bit 0.4% high.
 */
export const SDR_PARAMS: Readonly<SdrParams> = Object.freeze({ referenceWhite: 203, knee: 0.7, peak: 1000 });

/**
 * A path as a filter option's value, absolute since ffmpeg may run elsewhere: escaped once for the option and once
 * for the graph around it.
 */
export function filterPath(path: string): string {
  return resolve(path).replace(/[\\':]/g, (c) => `\\${c}`).replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}

const chains = new Map<string, string>();

/**
 * The matrices swscale decodes, by ffprobe's name, as swscale names them; `gbr` is an RGB picture, which no
 * matrix touches. The rest (bt2020c, ictcp, ycgco, ...) are refused, since ffmpeg cannot read them as RGB.
 */
export const MATRICES: Readonly<Record<string, string>> = {
  bt709: 'bt709', smpte170m: 'bt601', bt470bg: 'bt601', bt2020nc: 'bt2020', fcc: 'fcc', smpte240m: 'smpte240m', gbr: 'bt2020',
};

/** swscale's name for a YUV picture's matrix, by ffprobe's name, or undefined for one swscale cannot read as RGB. */
export const yuvMatrix = (space: string): string | undefined => (space !== 'gbr' && Object.hasOwn(MATRICES, space) ? MATRICES[space] : undefined);

/** Refuses, by `name`, an HDR source coded with a matrix ffmpeg cannot decode, rather than converting it wrongly. */
export function assertConvertible(colour: ColourReport, name: string): void {
  const { space } = colour.declared;
  if (space !== undefined && !Object.hasOwn(MATRICES, space)) {
    throw new Error(`${name} is HDR coded with the ${space} matrix, which ffmpeg cannot decode, so it cannot be converted to SDR`);
  }
}

/**
 * The conversion for one HDR source, as a filter chain on 32-bit float RGB: the transfer curve to linear light
 * (a 1D LUT this CLI computes), the source's primaries to BT.709's, the roll-off (tonemap's Mobius curve), and
 * the BT.709 curve back (another 1D LUT). Every filter in it is in every ffmpeg build; zscale, which does this
 * natively, is missing from stock builds such as Homebrew's. BT.2100 defines PQ and HLG with BT.2020 primaries
 * and matrix, so an axis the source leaves unset, or primaries this cannot convert from, are taken as BT.2020's
 * (describeHdr says so); a matrix ffmpeg cannot decode is refused, naming `name`. HDR10's mastering and
 * light-level metadata is dropped from the frames; ffmpeg before 7.1 copies a lone source stream's own copy into
 * the output whatever the frames say (see oneSourceFree).
 */
export function toSdr(colour: ColourReport, name = 'an HDR source'): string {
  assertConvertible(colour, name);
  const { primaries, space } = colour.declared;
  const transfer = hdrKind(colour) === 'PQ' ? 'pq' : 'hlg';
  const matrix = space === undefined ? 'bt2020' : MATRICES[space];
  const dir = join(stateDir(), 'luts');
  const asked = [dir, transfer, matrix, primaries].join();
  const known = chains.get(asked);
  if (known) return known;
  const { referenceWhite, knee, peak } = SDR_PARAMS;
  const linear = cubeFile(dir, `${transfer}-to-linear`, toLinearText(transfer, referenceWhite));
  const signal = cubeFile(dir, 'linear-to-bt709', toSdrSignalText());
  const m = toBt709(primaries);
  const gains = m && ['r', 'g', 'b'].flatMap((to, i) => ['r', 'g', 'b'].map((from, j) => `${to}${from}=${m[i][j].toFixed(6)}`));
  const mix = gains ? `colorchannelmixer=${gains.join(':')},` : '';
  const rolloff = knee === null ? '' : `tonemap=tonemap=mobius:param=${knee}:desat=0:peak=${(peak / referenceWhite).toFixed(6)},`;
  const chain = `scale=in_color_matrix=${matrix},format=gbrpf32le,lut1d=file=${filterPath(linear)}:interp=linear,${mix}${rolloff}`
    + `lut1d=file=${filterPath(signal)}:interp=linear,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,`
    + 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,'
    + 'sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA,sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL';
  chains.set(asked, chain);
  return chain;
}

/**
 * Inputs and a graph that run `chain` on input 0's picture into `[v]`, beside a silent second input the
 * graph also reads. ffmpeg before 7.1 copies the stream side data of a graph's only source into its output,
 * HDR10's included; with two sources there is none to copy from.
 */
export function oneSourceFree(file: string, chain: string): string[] {
  return ['-i', file, '-f', 'lavfi', '-t', '0.04', '-i', 'anullsrc', '-filter_complex', `[0:v:0]${chain}[v];[1:a]anullsink`, '-map', '[v]'];
}

/** An HDR source's own tags, an axis it leaves unset read as BT.2020's, as the conversion reads it. */
export const hdrTags = (colour: ColourReport): ColourTags => ({
  primaries: colour.declared.primaries ?? 'bt2020', transfer: colour.declared.transfer ?? '', space: colour.declared.space ?? 'bt2020nc',
});

/** What a source is once converted: BT.709 on every axis, whatever it declared. */
export const converted = (colour: ColourReport): ColourReport =>
  hdrKind(colour) ? { tags: BT709, assumed: false, declared: colour.declared } : colour;

/** One line for the user's report: which source was HDR, what it was, and primaries read as BT.2020's. */
export function describeHdr(name: string, colour: ColourReport): string {
  const { primaries: p, transfer, space = 'bt2020nc (unset)' } = colour.declared;
  const primaries = p === undefined ? 'bt2020 (unset)' : knownPrimaries(p) ? p : `${p} (read as bt2020)`;
  return `${name} is HDR (${hdrKind(colour)}, ${primaries}/${transfer}/${space}): converted to SDR BT.709, its look kept and its highlights rolled off`;
}

// A service is sent a high-quality copy, and x264's output depends on its thread count, so the count is
// fixed: a copy made again is the same bytes. The sound is AAC in MP4 whatever the source carried: MOV
// refuses Opus, and every service takes MP4.
const SERVICE_ENCODE: readonly string[] = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-threads', '4',
  '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];

/** The copy to send in place of a file, and the ffmpeg arguments that make it when it is not made yet. */
interface Copy { path: string; args?: string[] }

/** What a copy goes through after the conversion: a filter (a scale), and its encode, a service's unless given. */
export interface CopyOptions { after?: string; encode?: readonly string[] }

/**
 * What to send in place of `file`: the file itself when it is SDR, else an SDR copy under `dir`, converted
 * as a render converts it. A file ffprobe cannot read is sent as it is, and whoever receives it judges it, as
 * before; that is said. The copy is made once per source version and reused, so a re-run sends the same bytes
 * and resumes a job it already bought.
 */
function copyFor(file: string, dir: string, say: (line: string) => void, { after, encode = SERVICE_ENCODE }: CopyOptions): Copy {
  let colour: ColourReport;
  try {
    colour = colourTagsOf(file);
  } catch (e) {
    say(`could not read the colour of ${basename(file)} (${(e as Error).message}); sending it unconverted`);
    return { path: file };
  }
  if (!hdrKind(colour)) return { path: file };
  const chain = after ? `${toSdr(colour, basename(file))},${after}` : toSdr(colour, basename(file));
  const st = statSync(file);
  const key = createHash('sha1').update(JSON.stringify([file, st.size, st.mtimeMs, chain, encode])).digest('hex').slice(0, 16);
  const path = join(dir, `${basename(file, extname(file)).replace(/[^\w.-]+/g, '_')}.sdr-${key}.mp4`);
  say(describeHdr(basename(file), colour));
  if (existsSync(path)) return { path };
  mkdirSync(dir, { recursive: true });
  return { path, args: ['-v', 'error', '-y', ...oneSourceFree(file, chain), '-map', '0:a?', ...encode] };
}

const failed = (file: string, e: unknown) =>
  new Error(`could not make an SDR copy of ${file}: ${(e as { stderr?: Buffer }).stderr?.toString().trim() || (e as Error).message}`);

/** copyFor, made here and now: for a command that sends one file and waits for it anyway. */
export function sendable(file: string, dir: string, say: (line: string) => void, o: CopyOptions = {}): string {
  const copy = copyFor(file, dir, say, o);
  if (!copy.args) return copy.path;
  const tmp = `${copy.path}.${process.pid}.tmp.mp4`;
  try {
    execFileSync(FFMPEG, [...copy.args, tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
    renameSync(tmp, copy.path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw failed(file, e);
  }
  return copy.path;
}

/** copyFor, made without holding up the uploads already under way. */
export async function sendableLater(file: string, dir: string, say: (line: string) => void, o: CopyOptions = {}): Promise<string> {
  const copy = copyFor(file, dir, say, o);
  if (!copy.args) return copy.path;
  const tmp = `${copy.path}.${process.pid}.tmp.mp4`;
  try {
    await promisify(execFile)(FFMPEG, [...copy.args, tmp]);
    renameSync(tmp, copy.path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw failed(file, e);
  }
  return copy.path;
}
