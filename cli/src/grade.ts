// The grade apply-edl puts on a range: the corrections an editor reaches for, each a filter in every ffmpeg the
// CLI runs on. No filter string of the agent's own is taken, since one could change a range's length, size or
// colour tags behind the cut's back, and the range cache could not tell what it depends on.
import { describeValue } from './args.ts';

export interface Grade {
  /** Stops of gain on the picture: 1 doubles it, 0 leaves it. */
  exposure?: number;
  /** Contrast around mid-grey: 1 leaves it. */
  contrast?: number;
  /** Colour saturation: 1 leaves it, 0 is black and white. */
  saturation?: number;
  /** The colour temperature of the light the picture is shown under, in kelvin: 6500 leaves it, lower is warmer. */
  temperature?: number;
  /** A 3D LUT file (.cube, .3dl, .dat, .m3d, .csp), applied after the rest. Relative paths resolve against the EDL. */
  lut?: string;
  /** Film grain on the brightness, a whole number: 0 is none. */
  grain?: number;
}

/** A range's own grade over the cut's: a key set to null drops the cut's value for that range. */
export type GradeOverride = { [K in keyof Grade]?: Grade[K] | null };

type NumberKey = Exclude<keyof Grade, 'lut'>;

/** Each number's accepted range, mostly its filter's own, and the value that changes nothing. */
export const GRADE_NUMBERS: Readonly<Record<NumberKey, { min: number; max: number; neutral: number; integer?: true }>> = Object.freeze({
  exposure: { min: -3, max: 3, neutral: 0 },
  contrast: { min: 0, max: 3, neutral: 1 },
  saturation: { min: 0, max: 3, neutral: 1 },
  temperature: { min: 1000, max: 40000, neutral: 6500 },
  grain: { min: 0, max: 100, neutral: 0, integer: true },
});

const KEYS = [...Object.keys(GRADE_NUMBERS), 'lut'];

/** LUT formats lut3d reads, by extension; it picks its parser from the extension and fails mid-encode on any other. */
export const LUT_EXTENSIONS = ['.cube', '.3dl', '.dat', '.m3d', '.csp'] as const;

/** Shape-check a grade; `override` admits the nulls a range's grade may carry. `where` names it in every message. */
export function parseGrade(raw: unknown, where: string, override: boolean): GradeOverride {
  const bad = (what: string, value: unknown) => new Error(`${where}: ${what} — got ${describeValue(value)}`);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad(`a grade is an object of ${KEYS.join(', ')}`, raw);
  const out: GradeOverride = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KEYS.includes(key)) throw bad(`"${key}" is not a grade setting; the settings are ${KEYS.join(', ')}`, key);
    if (value === null) {
      if (!override) throw bad(`"${key}" is null; null only drops the cut's value in a range's own grade`, value);
      out[key as keyof Grade] = null;
      continue;
    }
    if (key === 'lut') {
      const lower = typeof value === 'string' ? value.toLowerCase() : '';
      if (!LUT_EXTENSIONS.some((ext) => lower.endsWith(ext))) throw bad(`"lut" must be the path of a ${LUT_EXTENSIONS.join(', ')} file`, value);
      out.lut = value as string;
      continue;
    }
    const { min, max, integer } = GRADE_NUMBERS[key as NumberKey];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw bad(`"${key}" must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}`, value);
    }
    out[key as NumberKey] = value;
  }
  return out;
}

/** The cut's grade with a range's own over it, key by key, keeping only the keys that change the picture. */
export function mergeGrade(cut: Grade | undefined, own: GradeOverride | undefined): Grade {
  const merged: GradeOverride = { ...cut, ...own };
  const grade: Grade = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value === null || value === undefined) continue;
    if (key === 'lut') grade.lut = value as string;
    else if (value !== GRADE_NUMBERS[key as NumberKey].neutral) grade[key as NumberKey] = value as number;
  }
  return grade;
}

/**
 * The grade as filters. `tone` runs on the range's frames as its source has them; `grain` runs after the speed
 * change, so every frame the cut plays, repeated or drawn, has grain of its own instead of a frozen pattern.
 * Contrast and saturation run on the YUV picture; exposure, temperature and the LUT on float RGB, reached and left
 * through `matrix` (swscale's name for the picture's YUV matrix), so the trip reads and writes the picture's own
 * colours rather than swscale's BT.601 default. `lut` is the LUT as a filter path.
 */
export function gradeFilters(grade: Grade, matrix: string, lut?: string): { tone: string[]; grain: string[] } {
  const tone: string[] = [];
  const eq = [
    grade.contrast !== undefined && `contrast=${grade.contrast}`,
    grade.saturation !== undefined && `saturation=${grade.saturation}`,
  ].filter(Boolean);
  if (eq.length) tone.push(`eq=${eq.join(':')}`);
  const rgb = [
    grade.exposure !== undefined && `exposure=exposure=${grade.exposure}`,
    // Lightness kept, so a warmer picture is warmer rather than also darker.
    grade.temperature !== undefined && `colortemperature=temperature=${grade.temperature}:pl=1`,
    grade.lut !== undefined && lut && `lut3d=file=${lut}`,
  ].filter((f): f is string => Boolean(f));
  if (rgb.length) {
    tone.push(`scale=in_color_matrix=${matrix}`, 'format=gbrpf32le', ...rgb, `scale=out_color_matrix=${matrix}:out_range=tv`, 'format=yuv420p');
  }
  const grain = grade.grain === undefined ? [] : [`noise=c0s=${grade.grain}:c0f=t`];
  return { tone, grain };
}

/** The grade in a few words, for the line apply-edl prints. */
export function describeGrade(grade: Grade): string {
  const parts = [
    grade.exposure !== undefined && `exposure ${grade.exposure > 0 ? '+' : ''}${grade.exposure}`,
    grade.contrast !== undefined && `contrast ${grade.contrast}`,
    grade.saturation !== undefined && `saturation ${grade.saturation}`,
    grade.temperature !== undefined && `${grade.temperature}K`,
    grade.lut !== undefined && `LUT ${grade.lut}`,
    grade.grain !== undefined && `grain ${grade.grain}`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'none';
}
