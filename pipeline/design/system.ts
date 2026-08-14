// The design system of one run, as a file.
//
// WHY THIS EXISTS. A 12-minute film was delivered with a system font on a translucent plate, one
// easing curve used 934 times, a caption block that never moved for 217 cues, and no lower third on
// any of its interview footage — with every rule it broke available to it, in full, throughout.
//
// The cause was ORDER, not knowledge. The type system was written from a blank page early, while the
// content it was for did not yet exist, and by the time the content arrived the design was already a
// fact nobody revisited. A rule that lives only in a document cannot prevent that: it is a memory
// competing with several hundred tool results by the time it binds.
//
// This is the artifact. It is written from the content, never before it (`assertGrounded` refuses a
// system built without the run's facts on disk), and `check()` reads back every authored document
// and fails the ones using anything the system does not declare. A generic default cannot slip in
// unnoticed, because a value that is not in the system is a finding rather than a judgement call.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { opticalTracking, trackingDeviation } from '../recipes/type.ts';

/** One rung of the type ladder. Tracking belongs to the rung, not to the element that uses it. */
export interface Rung {
  /** What this size is FOR. A ladder of unnamed numbers gets used arbitrarily. */
  role: string;
  px: number;
  weight: number;
  /** Optical tracking in em. Bigger type takes tighter tracking; the sign flips around body size. */
  trackingEm: number;
  /** Uppercase settings need their own tracking, which is why case is part of the rung. */
  case?: 'upper' | 'sentence' | 'title';
}

export interface Device {
  /** The name a document refers to it by, and the name a finding will print. */
  name: string;
  /** What it does for the viewer, in one line. A device nobody can describe is decoration. */
  purpose: string;
  /** Where its geometry came from — a recipe id, a delivered document, or `authored`. */
  from: string;
}

export interface MotionSpec {
  /** Named easings. An unnamed curve typed at the point of use is how 934 identical ones happen. */
  easings: Record<string, string>;
  /** Named durations in ms, so a reveal and a hold are decisions rather than two typed numbers. */
  durationsMs: Record<string, number>;
  /**
   * The unit a text reveal advances by. `word` requires real per-word times; the run that motivated
   * this had 1872 of them on disk and revealed per cue anyway.
   */
  revealUnit: 'word' | 'character' | 'line' | 'cue';
}

export interface DesignSystem {
  runKey: string;
  /** The one-line intent this system serves. A system with no direction is a palette with no reason. */
  direction: string;
  canvas: { width: number; height: number; fps: number };
  /** Families as they appear in `font-family`. A family not listed cannot appear in a document. */
  fonts: string[];
  ladder: Rung[];
  /** Named colours. A hex outside this map is a finding, including inside a gradient or a shadow. */
  palette: Record<string, string>;
  spacing: { unit: number; safeX: number; safeY: number };
  motion: MotionSpec;
  devices: Device[];
  /**
   * Recipe ids this system was seeded from. They must exist in the runtime index, which turns "I used
   * the recipes" from a sentence in a report into a field that can be wrong.
   */
  donors: string[];
  /** The content facts this system was built from. Empty means it was built from nothing. */
  groundedIn: string[];
  /**
   * Where the subject is, per cue, measured off the run's own picture. REQUIRED when the run has
   * footage, because `groundedIn` alone does not distinguish the two kinds of fact: a system can name
   * the transcript, the cues and the word times, satisfy every existing check, and still have been
   * authored without anyone looking at the frames. That is exactly what happened — the run that
   * motivated this listed five grounding files, all of them text, and then placed six of eight
   * captions on the same edge and two across a face.
   */
  placement?: { measuredIn: string; cues: number };
}

export function systemPath(runDir: string): string {
  return join(runDir, 'design', 'system.json');
}

export function readSystem(runDir: string): DesignSystem | undefined {
  const p = systemPath(runDir);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, 'utf8')) as DesignSystem;
}

export function writeSystem(runDir: string, sys: DesignSystem): void {
  const p = systemPath(runDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(sys, null, 2) + '\n');
}

/**
 * Refuse a system that was not built from the run's own content.
 *
 * This is the rule that could not be written as a sentence. The failing run authored its whole type
 * system before the transcript, the cut and the scene facts existed, precisely because that work was
 * available to do while waiting, and writing it early does not feel like breaking the rule. Requiring
 * the files to exist on disk makes the early version impossible to produce rather than discouraged.
 */
export function assertGrounded(runDir: string, sys: DesignSystem): void {
  if (!sys.groundedIn.length) {
    throw new Error('design system: groundedIn is empty — name the content files this was built from');
  }
  const missing = sys.groundedIn.filter((rel) => !existsSync(join(runDir, rel)));
  if (missing.length) {
    throw new Error(
      `design system: it claims to be built from files that do not exist — ${missing.join(', ')}. ` +
      'A system authored before the content is a system authored from nothing.',
    );
  }
  assertPlacementMeasured(runDir, sys);
}

const VIDEO = /\.(mp4|mov|webm|mkv|m4v|avi)$/i;

/**
 * Video the run composes over.
 *
 * `meta.json` is asked FIRST, because on an ordinary captioned run the source is never copied into
 * the run at all — prep records `videoPath` pointing at wherever the user's file lives. A version of
 * this that only globbed the run directory returned false for every prep run and for the 12-minute
 * film whose 20 clips sit under `footage/`, which is to say for exactly the runs the placement gate
 * was written to catch. It reported clean and the skill said it would refuse.
 */
export function runHasFootage(runDir: string): boolean {
  const meta = join(runDir, 'meta.json');
  if (existsSync(meta)) {
    try {
      const m = JSON.parse(readFileSync(meta, 'utf8')) as { videoPath?: unknown; videos?: unknown[] };
      // NOT gated on the file being reachable: an unmounted volume or a moved source does not make a
      // run footage-free, and reading it that way let the placement gate fall silent on exactly the
      // runs it exists for.
      if (typeof m.videoPath === 'string' && m.videoPath) return true;
      if (Array.isArray(m.videos) && m.videos.length) return true;
    } catch {
      throw new Error(
        `${meta} is not readable JSON — whether this run has footage cannot be decided, and guessing ` +
        'no would skip the placement gate. Fix or delete the file.',
      );
    }
  }
  // The run's own products are not footage. `gates.sh` records `<doc>/out.silent.mp4` and copies it to
  // `<doc>/out.mp4`, both of which the walk reached — so a graphics-only run passed the gate, rendered,
  // and then failed every gate after it demanding a subject be measured in footage it never had.
  // `out.tmp.mp4` is what mux-audio.sh writes before its rename; a mux that dies leaves it behind,
  // and from then on the run demanded placement for footage it never had.
  const PRODUCT = /^out(\.silent|\.tmp)?\.(mp4|mov|webm|mkv)$/i;
  const walk = (dir: string, depth: number): boolean => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return false; }
    for (const name of entries) {
      if (name === 'node_modules' || name.startsWith('.') || name === 'qa') continue;
      const p = join(dir, name);
      let stat;
      try { stat = statSync(p); } catch { continue; }
      if (stat.isDirectory()) { if (depth > 0 && walk(p, depth - 1)) return true; }
      else if (VIDEO.test(name) && !PRODUCT.test(name)) return true;
    }
    return false;
  };
  return walk(runDir, 3);
}

/** How many cues this run actually has, from whatever prep wrote. */
function cueCount(runDir: string): number | undefined {
  for (const [file, key] of [['word-timings.json', 'beats'], ['cues.json', 'cues']] as const) {
    const p = join(runDir, file);
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
      const list = parsed[key];
      if (Array.isArray(list)) return list.length;
    } catch { /* fall through to the next source */ }
  }
  return undefined;
}

/**
 * A run with footage must have measured where the subject is before it designed anything.
 *
 * The count is checked against the run's OWN cue count, not against a number the same pass chose.
 * The first version compared the claim to the file it named and accepted an array, a `.cues` array or
 * the key count of any object — so `{ measuredIn: 'notes.json', cues: 3 }` passed against
 * `{"measured":true,"by":"eye"}`, and `cues: 0` passed against anything. Measuring the
 * picture for every cue IS the work; a gate that takes the author's word for it gates nothing.
 */
export function assertPlacementMeasured(runDir: string, sys: DesignSystem): void {
  if (!runHasFootage(runDir)) return;
  const p = sys.placement;
  if (!p?.measuredIn) {
    throw new Error(
      'design system: this run has footage, so `placement.measuredIn` is required — measure where the ' +
      'subject is in every cue and name the file. Grounding in the transcript and the cue times is ' +
      'grounding in the words; placement is decided against the picture.',
    );
  }
  const f = join(runDir, p.measuredIn);
  if (!existsSync(f)) throw new Error(`design system: placement.measuredIn "${p.measuredIn}" does not exist`);
  let entries: number;
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as unknown;
    const list = Array.isArray(parsed) ? parsed
      : Array.isArray((parsed as { cues?: unknown[] })?.cues) ? (parsed as { cues: unknown[] }).cues
      : undefined;
    if (!list) {
      throw new Error(
        `design system: placement.measuredIn "${p.measuredIn}" is not a list of measurements — it must be ` +
        'an array, or an object with a `cues` array. An object of loose keys counts as whatever it holds.',
      );
    }
    entries = list.length;
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error(`design system: placement.measuredIn "${p.measuredIn}" is not readable JSON`);
    throw e;
  }
  if (!entries) throw new Error(`design system: placement.measuredIn "${p.measuredIn}" measures nothing`);

  const real = cueCount(runDir);
  if (real !== undefined && entries < real) {
    throw new Error(
      `design system: this run has ${real} cues and "${p.measuredIn}" measures ${entries} — every cue is placed, ` +
      'so every cue is measured',
    );
  }
  if (p.cues !== entries) {
    throw new Error(
      `design system: it claims ${p.cues} cues were measured for placement and "${p.measuredIn}" holds ${entries}`,
    );
  }
}

export interface Finding { rule: string; severity: 'error' | 'warn'; message: string }

/**
 * The ladder itself, against the measured optical curve.
 *
 * Checking documents against the system is not enough on its own: a system is free to declare a bad
 * ladder, and then every document conforms to it perfectly. All-caps rungs are exempt because caps
 * genuinely want more tracking than the curve — that is a typographic fact, not a loophole.
 */
export function checkLadder(sys: DesignSystem): Finding[] {
  const out: Finding[] = [];
  for (const r of sys.ladder) {
    if (r.case === 'upper') continue;
    const off = trackingDeviation(r.px, r.trackingEm);
    if (Math.abs(off) > 0.01) {
      out.push({
        rule: 'rung-off-curve',
        severity: 'error',
        message: `the ${r.px}px "${r.role}" rung is set to ${r.trackingEm}em; the optical curve gives ${opticalTracking(r.px)}em at that size, a difference of ${off}em`,
      });
    }
  }
  return out;
}

/**
 * The other direction: a rung, a family or a palette colour the system DECLARES and no document uses.
 * Devices are NOT checked here — a device is a shape, not a token, and nothing in a document names it.
 *
 * `check()` only asks that everything used is declared, which lets a system promise a two-typeface
 * contrast and a nine-rung ladder while the render comes back monotone. That is not hypothetical —
 * one run declared two serif rungs and set the serif once in thirty seconds, and every gate passed.
 * A promise nobody kept is as much a defect as a value nobody declared.
 */
export function checkDeclaredUsed(docs: string[], sys: DesignSystem): Finding[] {
  // Read DECLARATIONS, and compare the way `check()` compares. A first version scanned the raw
  // document text and matched literally: a `font-size` in a comment counted as used, a family whose
  // quoting differed by one character counted as unused, a rung one third of a pixel off its
  // declared size counted as unused, and a palette colour a document paints as `rgb()` or `white`
  // counted as unused. All four are ERRORs, so a conforming document failed its own system's gate.
  const css = docs.map((d) => expandFontShorthand(declarations(d))).join('\n');
  const out: Finding[] = [];

  const firstFamily = (stack: string) => stack.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
  const setFamilies = new Set(
    [...css.matchAll(/font-family:\s*([^;}]+)/gi)].map((m) => firstFamily(m[1])),
  );
  for (const family of sys.fonts) {
    if (!setFamilies.has(firstFamily(family))) {
      out.push({
        rule: 'font-declared-unused',
        severity: 'error',
        message: `"${family}" is declared and no document sets it — either use the contrast the system promises, or stop declaring it`,
      });
    }
  }

  const setSizes = [...css.matchAll(/font-size:\s*([\d.]+)px/gi)].map((m) => Number(m[1]));
  for (const r of sys.ladder) {
    if (!setSizes.some((px) => Math.abs(px - r.px) < 0.51)) {
      out.push({
        rule: 'rung-declared-unused',
        severity: 'error',
        message: `the ${r.px}px "${r.role}" rung is declared and no document sets it`,
      });
    }
  }

  const painted = new Set(
    [...css.matchAll(PAINTS)].flatMap((m) =>
      [...m[2].replace(/\b(?:url|var)\([^)]*\)/gi, ' ').matchAll(COLOUR_TOKEN)]
        .map((t) => rgbKey(t[0]))
        .filter((k): k is string => Boolean(k))),
  );
  for (const [name, hex] of Object.entries(sys.palette)) {
    const key = rgbKey(hex);
    if (key && !painted.has(key)) {
      out.push({
        rule: 'colour-declared-unused',
        severity: 'warn',
        message: `palette colour "${name}" (${hex}) is declared and no document paints it`,
      });
    }
  }

  return out;
}

/** CSS generics. The engine resolves families through Google and has its own fallback for misses. */
const GENERIC = new Set(['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace']);

/**
 * A generic at the end of a stack never resolves and warns on every render. Harmless on its own, but
 * it is a standing warning in the log that a REAL font failure then hides behind.
 */
export function checkFonts(sys: DesignSystem): Finding[] {
  const out: Finding[] = [];
  for (const stack of sys.fonts) {
    for (const fam of stack.split(',').map((f) => f.trim().replace(/^['"]|['"]$/g, '').toLowerCase())) {
      if (GENERIC.has(fam)) {
        out.push({ rule: 'generic-family', severity: 'warn', message: `"${stack}" ends in the generic "${fam}", which the engine cannot resolve — it warns on every render, and a real font failure looks the same` });
      }
    }
  }
  return out;
}

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

/**
 * Declarations from both the stylesheet and the inline attributes — generated documents use both.
 *
 * Each inline set is wrapped in a synthetic block. Joined raw, one element's `font-size` paired with
 * the NEXT element's `letter-spacing` when the pairing below split on braces, so the gate compared
 * values that never met. Single quotes count too: a `style='…'` attribute is legal and was invisible.
 */
function declarations(src: string): string {
  const blocks = src.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi) ?? [];
  const inline = [...src.matchAll(/<[^>]*\sstyle=("([^"]*)"|'([^']*)')[^>]*>/gi)]
    .map((m) => `.inline{${m[2] ?? m[3] ?? ''}}`);
  return [...blocks, ...inline].join('\n');
}

/** Named colours a person actually types by hand. A full CSS list would be noise. */
const NAMED: Record<string, string> = {
  white: '#ffffff', black: '#000000', red: '#ff0000', blue: '#0000ff', green: '#008000',
  gray: '#808080', grey: '#808080', silver: '#c0c0c0', gold: '#ffd700', orange: '#ffa500',
  yellow: '#ffff00', purple: '#800080', navy: '#000080', teal: '#008080', crimson: '#dc143c',
};

/** Every colour to `r,g,b`, so a palette written in hex still recognises itself written as rgb(). */
/** `font: 700 96px/1.1 Inter, sans-serif` → the same declaration written as longhands beside it. */
function expandFontShorthand(css: string): string {
  return css.replace(/(?:^|([;{\s]))font:\s*([^;}]+)/gi, (whole, lead: string | undefined, value: string) => {
    const size = value.match(/([\d.]+)(px|r?em|%|v[wh])(?:\s*\/\s*[\d.]+\w*)?/i);
    if (!size) return whole;
    const family = value.slice(size.index! + size[0].length).trim();
    const parts = [`font-size:${size[1]}${size[2]}`];
    if (family) parts.push(`font-family:${family}`);
    return `${lead ?? ''}${whole.trim()};${parts.join(';')}`;
  });
}

function rgbKey(value: string): string | undefined {
  const v = value.trim().toLowerCase();
  const named = NAMED[v];
  const hex = (named ?? v).match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    const raw = hex[1].length === 4 || hex[1].length === 8 ? hex[1].slice(0, hex[1].length === 4 ? 3 : 6) : hex[1];
    if (raw.length !== 3 && raw.length !== 6) return undefined;
    const h = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(',');
  }
  const fn = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (fn) return [1, 2, 3].map((i) => Math.round(Number(fn[i]))).join(',');
  return undefined;
}

/** Properties whose value paints. A colour anywhere else is not a colour decision. */
const PAINTS = /(?:^|[;{\s])(-{0,2}[a-z-]*(?:color|background|shadow|fill|stroke|outline|border|gradient|filter)[a-z-]*)\s*:\s*([^;}]+)/gi;

/** A colour as it appears inside a paint declaration. Both directions of the palette gate read it. */
const COLOUR_TOKEN = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b[a-z]{3,12}\b/gi;

/**
 * The rungs at a size. More than one is normal and correct: an all-caps kicker and a sentence-case
 * label can share a size and still want different tracking, which is typography rather than drift.
 */
function rungsFor(sys: DesignSystem, px: number): Rung[] {
  return sys.ladder.filter((r) => Math.abs(r.px - px) < 0.51);
}

/**
 * Every way an authored document can leave its own system.
 *
 * Tracking is checked against the RUNG rather than against a global rule, because the optical law is
 * that tracking follows size: the same em value is right at one size and wrong at another. The size
 * check is the one that bites hardest in practice — the film this came from used 23 distinct sizes,
 * and this gate returns over a thousand errors on its eight documents, most of them a size nobody
 * decided on. (Run it to see today's figure; it rises as the gate learns to see more of a document.)
 */
export function check(src: string, sys: DesignSystem): Finding[] {
  const f: Finding[] = [];
  // The `font:` shorthand sets family and size at once. Reading only the longhands let a document
  // evade this gate through the shorthand while the other direction blamed it for not using the
  // ladder — the two checks have to read the same declarations. Rewritten as longhands so every rule
  // below sees them without being taught the shorthand's grammar twice.
  const css = expandFontShorthand(declarations(src));

  for (const m of css.matchAll(/font-family:\s*([^;}]+)/gi)) {
    const stack = m[1].trim();
    const first = stack.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
    if (!sys.fonts.some((known) => known.split(',')[0].trim().replace(/^['"]|['"]$/g, '') === first)) {
      f.push({ rule: 'font-off-system', severity: 'error', message: `font-family "${first}" is not in the system's fonts (${sys.fonts.join(', ')})` });
    }
  }

  for (const m of css.matchAll(/font-size:\s*([\d.]+)(px|r?em|%|v[wh])/gi)) {
    if (m[2] !== 'px') {
      f.push({ rule: 'size-not-px', severity: 'error', message: `font-size ${m[1]}${m[2]} is relative — the ladder and the canvas are both in px, so this size was never actually decided` });
      continue;
    }
    const px = Number(m[1]);
    if (!rungsFor(sys, px).length) {
      const ladder = sys.ladder.map((r) => `${r.px} (${r.role})`).join(', ');
      f.push({ rule: 'size-off-ladder', severity: 'error', message: `font-size ${px}px is not a rung of the ladder — ${ladder}` });
    }
  }

  // Pair each tracking with the size declared nearest before it; a rule sets both together.
  for (const block of css.split('}')) {
    const size = block.match(/font-size:\s*([\d.]+)px/i);
    const track = block.match(/letter-spacing:\s*(-?[\d.]+)em/i);
    if (!size || !track) continue;
    const rungs = rungsFor(sys, Number(size[1]));
    if (!rungs.length) continue;
    const got = Number(track[1]);
    if (!rungs.some((r) => Math.abs(got - r.trackingEm) <= 0.004)) {
      const allowed = rungs.map((r) => `${r.trackingEm}em ("${r.role}")`).join(' or ');
      f.push({
        rule: 'tracking-off-rung',
        severity: 'error',
        message: `letter-spacing ${got}em at ${rungs[0].px}px, where the ladder sets ${allowed} — tracking follows size, and this is the value a reader feels as crude`,
      });
    }
  }

  // A palette in hex must recognise itself written as `rgb()` or as `white`; comparing the literal
  // text meant every non-hex form was simply invisible to the gate.
  const known = new Set(Object.values(sys.palette).map((v) => rgbKey(v)).filter(Boolean) as string[]);
  const palette = Object.entries(sys.palette).map(([k, v]) => `${k} ${v}`).join(', ');
  const sources = [...known].map((k) => k.split(',').map(Number));

  /**
   * A colour is in-system when it IS a palette entry, or when it is one darkened toward black by a
   * single factor. That is the corpus's grounding rule — the shadow is the document's own colour
   * darkened, never pure black — and a gate that rejected it would push authors back to `#000`.
   */
  const derived = (rgb: string): boolean => {
    const [r, g, b] = rgb.split(',').map(Number);
    return sources.some(([sr, sg, sb]) => {
      const ks = [[r, sr], [g, sg], [b, sb]].filter(([, sv]) => sv > 8).map(([v, sv]) => v / sv);
      if (!ks.length) return false;
      const k = ks[0];
      // A floor as well as a ceiling: at k = 0 every source "derives" pure black, which is the one
      // colour the grounding rule names as wrong.
      // A BAND, not just a ceiling. Unbounded below, every grey derived from a white palette entry —
      // 252 of 256 of them — so the one gate that exists to notice an undecided value could not see a
      // grey. The corpus grounds by darkening to roughly a tenth; this is that, with room either side.
      if (k > 0.4 || k < 0.04) return false;
      return ks.every((x) => Math.abs(x - k) <= 0.06)
        && [[r, sr], [g, sg], [b, sb]].every(([v, sv]) => Math.abs(v - sv * k) <= 1.5);
    });
  };
  for (const decl of css.matchAll(PAINTS)) {
    // Derivation is the GROUNDING rule — the shadow is the document's own colour darkened — so it
    // applies where grounding happens and nowhere else. Allowed everywhere, a near-white palette entry
    // would "derive" most of the greys, and the one gate that exists to notice an undecided value
    // could not see one.
    const grounding = /shadow|filter/i.test(decl[1]);
    // A url() or a var() is not a colour. Reading their contents as words made a background image and
    // a design token into off-palette findings, which stops a run at the first gate over neither.
    const value = decl[2].replace(/\b(?:url|var)\([^)]*\)/gi, ' ');
    for (const token of value.matchAll(COLOUR_TOKEN)) {
      const key = rgbKey(token[0]);
      if (!key || known.has(key) || (grounding && derived(key))) continue;
      f.push({ rule: 'colour-off-palette', severity: 'error', message: `${token[0]} is not in the palette (${palette})` });
    }
  }

  const easings = new Set(Object.values(sys.motion.easings).map((v) => v.replace(/\s+/g, '')));
  for (const m of css.matchAll(/cubic-bezier\([^)]*\)/gi)) {
    const curve = m[0].replace(/\s+/g, '');
    if (!easings.has(curve)) {
      f.push({ rule: 'easing-off-system', severity: 'error', message: `${m[0]} is not one of the system's named easings (${Object.keys(sys.motion.easings).join(', ')})` });
    }
  }

  // A film with no declared device is a film that typed every graphic fresh, which is what "it looks
  // like a default" describes. Warn rather than error: a short clip legitimately has none.
  if (!sys.devices.length) {
    f.push({ rule: 'no-devices', severity: 'warn', message: 'the system declares no devices — every graphic in this document was composed at the point of use' });
  }

  return f;
}
