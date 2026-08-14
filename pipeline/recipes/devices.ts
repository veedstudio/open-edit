// Compositional devices, derived from documents that were delivered and accepted.
//
// A device is not a style. It is a small assembly with a job — separate two zones, name a speaker,
// buy legibility over unknown footage — and the reason to keep them here is that the difference
// between a designed instance and a typed one lives in details nobody reconstructs under time
// pressure. Read across 85 delivered documents, the differences are specific and countable:
//
//   · Plenty of the delivered documents DO draw a plain opaque bar — of the 424 bars in the corpus no
//     taller than 4px, 165 are fully opaque. The ones worth copying do not: the canonical rule is a compound —
//     a hairline under 50% alpha, a shadow beneath it, and a short opaque stub at its origin — and it
//     DRAWS with scaleX from a named origin rather than fading in — two documents use all three of
//     those together (`rx2-FR`, `rx4-IT`). This library offers the better
//     instance, not the average one; that is the whole reason to have a library.
//   · Contrast is bought with shadow far more often than with a plate: 42 documents over footage ground
//     their ink with a text-shadow rather than a plate, 36 of them two-layer, with alpha following
//     WEIGHT rather than size. Ten put a plate behind ink.
//   · The median document uses three distinct colours, and the second signal colour appears once.
//
// Geometry is given at the canvas it was measured on and scaled by the caller, the same way compiled
// recipes handle it.
import type { DesignSystem, Rung } from '../design/system.ts';
import { escapeHtml } from './lib.ts';

export interface DeviceOutput {
  html: string;
  css: string;
}

/** The canvas the corpus numbers below were measured on. */
export const REF_CANVAS = { width: 720, height: 1280 };

/** Scale a reference-canvas length to the run's canvas, on the width axis. */
export function scaleTo(sys: DesignSystem, px: number, refWidth = REF_CANVAS.width): number {
  return Math.max(1, Math.round((px * sys.canvas.width) / refWidth));
}

function rgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

/** A colour darkened toward black by `amount` (0..1) — the corpus's shadow colour rule. */
export function darken(hex: string, amount = 0.86): string {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const ch = [0, 2, 4].map((i) => Math.round(parseInt(n.slice(i, i + 2), 16) * (1 - amount)));
  return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

// The shared vocabulary. A device names its colours, sizes and curves THROUGH the system, so a run is
// redesigned by editing one artifact instead of nine graphics — and so a value nobody decided on is a
// finding rather than a judgement call.

/** The house entrance curve — 32 documents, 109 uses. Reached only when the system names no easing. */
const HOUSE_ENTRANCE = 'cubic-bezier(.2,.7,.3,1)';
/** The curve bars and rules draw on — 6 documents, 39 uses. */
const DRAW_CURVE = 'cubic-bezier(.16,.84,.3,1)';
/**
 * The corpus's most-shared reveal duration: 420ms in 12 documents, against a 414ms median.
 *
 * Count it with `grep -l` for `animation-duration: 420ms` across the corpus templates: 12 documents.
 * Counting any `420ms` token instead gives 24, which is the figure an earlier census reported and is
 * not the same question: a delay is not a duration.
 */
const REVEAL_MS = 420;
/** The canvas the `_card*` family was measured on — its numbers scale from 1080, not from 720. */
const CARD_REF = 1080;
/** The canvas `_card3` was measured on. */
const SCENE_REF = 1920;
/**
 * Descender headroom for display type (`hp-IT`; `rx-DE` runs .08em/.16em).
 * The raster box clips without it, which is a defect nobody sees until the render.
 */
const SHEAR_PAD = '.06em 0 .18em';

// Every rule below that positions an element AND animates its opacity carries `z-index:1` as a floor,
// with the element's real z inline (inline wins). Not because the engine demands it — it does not
// (probe: opacity-anim-no-z, REFUTED) — but because a device that leaves its z to document order
// covers, or is covered by, whatever the caller happens to emit next.

function ease(sys: DesignSystem, name: string, fallback = HOUSE_ENTRANCE): string {
  return sys.motion.easings[name] ?? sys.motion.easings.standard ?? fallback;
}

/** A family the system declares, by index — a device cannot name a face the system has not. */
function family(sys: DesignSystem, i = 0): string {
  const f = sys.fonts[i];
  if (!f) throw new Error(`devices: the system declares ${sys.fonts.length} font(s) (${sys.fonts.join(', ')}); there is no index ${i}`);
  return f;
}

/**
 * The rung a device sets its type on, by preference order.
 *
 * A device names the rung it WANTS and the ones it can live on. Demanding a literal role made six of
 * these throw against the ladder `type.ts` itself emits — a library that only works with a ladder
 * nobody documents is a library nobody can reach, which is the failure this whole vocabulary exists
 * to fix. Every chain ends on a role a default ladder always has.
 */
function rungOf(sys: DesignSystem, roles: string | string[]): Rung {
  const wanted = Array.isArray(roles) ? roles : [roles];
  for (const role of wanted) {
    const r = sys.ladder.find((x) => x.role === role);
    if (r) return r;
  }
  throw new Error(
    `devices: the system has none of the "${wanted.join('", "')}" rungs — ladder is ${sys.ladder.map((x) => x.role).join(', ')}`,
  );
}

function hexOf(sys: DesignSystem, key: string): string {
  const v = sys.palette[key];
  if (!v) throw new Error(`devices: "${key}" is not in the palette (${Object.keys(sys.palette).join(', ')})`);
  return v;
}

const inkKey = (sys: DesignSystem) => Object.keys(sys.palette)[0];
const accentKey = (sys: DesignSystem) => Object.keys(sys.palette)[1] ?? Object.keys(sys.palette)[0];
const groundKey = (sys: DesignSystem) => Object.keys(sys.palette).at(-1)!;

/**
 * Size, weight and tracking, emitted as one declaration.
 *
 * They travel together because the LADDER owns tracking: a rung is a size with its tracking, and the
 * film that read as crude had split them and set display tracking on reading text.
 */
function typeCss(sys: DesignSystem, r: Rung, fontIndex = 0, weight = r.weight): string {
  return `font-family:${family(sys, fontIndex)};font-weight:${weight};font-size:${r.px}px;letter-spacing:${r.trackingEm}em` +
    (r.case === 'upper' ? ';text-transform:uppercase' : '');
}

/**
 * The trailing track a flushed line has to give back.
 *
 * letter-spacing is added after the LAST glyph too, so a tracked label flushed to a column lands that
 * far short of it — `rx2-DE` declares `right:85px` against an 88px grid to cancel 0.30em at 11px.
 */
function trailingTrackPx(r: Rung): number {
  return Math.round(r.trackingEm * r.px);
}

export interface DividerOptions {
  id: string;
  /** Top-left of the rule, in run-canvas px. */
  x: number;
  y: number;
  /** Rule length in run-canvas px. */
  width: number;
  /** When the rule starts drawing. */
  delayMs?: number;
  /** Corpus range is 840–900ms. */
  drawMs?: number;
  /** Palette key for the stub. The second signal colour, used once in the document. */
  accent?: string;
  /** Palette key for the hairline. */
  ink?: string;
  /** Corpus range is 0.22–0.78; every value but one sits at or below 0.55. */
  alpha?: number;
  /** Left, or right for a rule that reads from the other edge. */
  origin?: 'left' | 'right';
  /** The stub is what stops this being a grey line. Off only with a reason. */
  stub?: boolean;
}

/**
 * A hairline rule with an opaque stub at its origin, drawn rather than faded.
 *
 * The stub is 5.1% of the rule's length and three times its weight in the canonical instances. It is
 * the whole difference between a rule that reads as typography and one that reads as a `<hr>`.
 */
export function divider(sys: DesignSystem, o: DividerOptions): DeviceOutput {
  const {
    id, x, y, width,
    delayMs = 0,
    drawMs = 870,
    accent = Object.keys(sys.palette)[1] ?? Object.keys(sys.palette)[0],
    ink = Object.keys(sys.palette)[0],
    alpha = 0.46,
    origin = 'left',
    stub = true,
  } = o;

  const weight = scaleTo(sys, 1);
  const stubW = Math.max(weight * 3, Math.round(width * 0.051));
  const stubH = weight * 3;
  const inkHex = sys.palette[ink];
  const accentHex = sys.palette[accent];
  const curve = ease(sys, 'draw', DRAW_CURVE);
  const stubX = origin === 'left' ? x : x + width - stubW;

  const html =
    `<div class="dv" id="${id}" style="left:${x}px;top:${y}px;width:${width}px;height:${weight}px;` +
    `transform-origin:${origin} center;animation-delay:${delayMs}ms;animation-duration:${drawMs}ms"></div>` +
    (stub
      ? `<div class="dvs" id="${id}-stub" style="left:${stubX}px;top:${y - weight}px;width:${stubW}px;height:${stubH}px;` +
        `animation-delay:${delayMs + 300}ms;animation-duration:420ms"></div>`
      : '');

  const css = [
    `.dv{position:absolute;background:${rgba(inkHex, alpha)};box-shadow:0 ${weight}px ${weight * 3}px ${rgba(darken(inkHex), 0.6)};`,
    `transform:scaleX(0);animation-name:dvDraw;animation-fill-mode:forwards;animation-timing-function:${curve};z-index:2}`,
    stub ? `.dvs{position:absolute;background:${accentHex};transform:scaleX(0);transform-origin:${origin} center;animation-name:dvDraw;animation-fill-mode:forwards;animation-timing-function:${curve};z-index:3}` : '',
    `@keyframes dvDraw{from{transform:scaleX(0)}to{transform:scaleX(1)}}`,
  ].filter(Boolean).join('\n');

  return { html, css };
}

export interface GroundShadowOptions {
  /** The weight of the type this grounds. Alpha follows weight, not size. */
  weight: number;
  /**
   * Palette key for the document's ground; the shadow is that colour darkened.
   *
   * Most of the 42 corpus documents that ground their ink over footage reach for pure black anyway.
   * This follows the minority that does not, because a shadow in the ground's own colour reads as
   * depth where a black one reads as a sticker — but the majority is not on that side, so it is a
   * choice, not a law.
   */
  ground?: string;
  /** Multiplies both radii, for type much larger or smaller than body. */
  scale?: number;
}

/**
 * The two-layer text-shadow that buys legibility over footage without a plate.
 *
 * One layer wide and soft for separation from the picture, one tight and dark for the glyph edge.
 * Alpha follows WEIGHT: a 900-weight hero needs less help than a 700-weight paragraph, which is the
 * opposite of what size-based scaling would do, and it is what the delivered documents actually do.
 */
export function groundShadow(sys: DesignSystem, o: GroundShadowOptions): string {
  const { weight, ground = Object.keys(sys.palette).at(-1)!, scale = 1 } = o;
  const base = darken(sys.palette[ground] ?? '#000000', 0.9);
  // 700 → .38/.30, 900 → .20/.14, linear between and clamped outside.
  const t = Math.max(0, Math.min(1, (weight - 700) / 200));
  const soft = Number((0.38 + (0.2 - 0.38) * t).toFixed(2));
  const edge = Number((0.3 + (0.14 - 0.3) * t).toFixed(2));
  const r1 = Math.round(9 * scale);
  const r2 = Math.round(2 * scale);
  return `0 ${Math.round(2 * scale)}px ${r1}px ${rgba(base, soft)}, 0 ${Math.round(1 * scale)}px ${r2}px ${rgba(base, edge)}`;
}

/**
 * The glow-then-offset stack `rx-DE` gives its accent word.
 *
 * The glow layers are listed FIRST so they paint over the hard offset instead of under it — reversing
 * them puts a dark edge on top of the halo and the word reads dirty.
 */
function hardOffsetShadow(sys: DesignSystem, ink: string, ground: string): string {
  const i = hexOf(sys, ink);
  const g = darken(hexOf(sys, ground));
  const p = (n: number) => scaleTo(sys, n);
  return `0 0 ${p(3)}px ${rgba(i, 0.85)}, 0 0 ${p(12)}px ${rgba(i, 0.5)}, 0 0 ${p(30)}px ${rgba(i, 0.28)}, ` +
    `${p(7)}px ${p(9)}px 0 ${rgba(g, 0.66)}, 0 ${p(4)}px ${p(16)}px ${rgba(g, 0.45)}`;
}

/** Five executions, one job. Which one a document uses is a style decision; having one is not. */
export type AccentExecution = 'plate' | 'underline' | 'pop' | 'offset' | 'register';

/** The hold before the peak: `rx-DE` runs its support words to 1360ms and lands the accent at 1800ms. */
export const ACCENT_HOLD_MS = 440;

/**
 * The padding EVERY word in the run carries when the accent is underlined.
 *
 * `rx2-DE` gives the whole line the marked word's padding-bottom, so the rule sits at one fixed
 * distance below the cap line in every beat instead of riding whichever word happens to be marked.
 */
export const ACCENT_UNDERLINE_PAD_EM = 0.02;

/** The plate's padding as a fraction of the type size — asymmetric, optically centred on the cap. */
const PLATE_PAD = { top: 0.026, side: 0.184, bottom: 0.079 };

/** The corpus's pop window is 180–340ms; 340 is also one of its most-shared durations. */
const POP_MS = 340;

export interface AccentWordOptions {
  id: string;
  text: string;
  /** Top-left of the word's own box, in run-canvas px. */
  x: number;
  y: number;
  /** The rung it is set on. The corpus breaks SIZE and treatment together, never treatment alone. */
  role?: string | string[];
  execution?: AccentExecution;
  /** Palette key for the signal colour. */
  accent?: string;
  ink?: string;
  /** Palette key for the ground — plate ink, and the colour every shadow is darkened from. */
  ground?: string;
  /** Absolute delay. It lands ACCENT_HOLD_MS after the last support word of its own beat. */
  delayMs?: number;
  /** Corpus range is 280–460ms for the two-span entry. */
  riseMs?: number;
  /** Index into the system's fonts. The register break takes the second family by default. */
  fontIndex?: number;
  z?: number;
}

/**
 * One word per beat, marked so the beat has a peak.
 *
 * Two things make this a device rather than a bold tag. It changes TWO attributes at once — the rung
 * carries the size break, the execution carries the treatment — and it arrives last, after a hold.
 * The entry is `rx-DE`'s two-span idiom: an outer span sliding in from its anchor side and an inner
 * one rising and fading, because one span can only do one of those.
 *
 * Only the plate execution recolours the word. The other four mark it with treatment and leave the
 * run's ink alone, which is what keeps a peak legible over footage nobody has seen yet.
 */
export function accentWord(sys: DesignSystem, o: AccentWordOptions): DeviceOutput {
  const {
    id, text, x, y,
    role = ['accent', 'headline', 'display', 'body'],
    execution = 'plate',
    accent = accentKey(sys),
    ink = inkKey(sys),
    ground = groundKey(sys),
    delayMs = 0,
    fontIndex = execution === 'register' ? 1 : 0,
    z = 5,
  } = o;
  const riseMs = o.riseMs ?? (execution === 'pop' ? POP_MS : REVEAL_MS);
  const r = rungOf(sys, role);
  const curve = ease(sys, 'standard');
  const slide = scaleTo(sys, 32);
  const pop = execution === 'pop';
  const shadow = groundShadow(sys, { weight: r.weight, ground });

  // The underline is drawn on the span's own wrapper so its width is the word's, not the line's.
  const paint =
    execution === 'plate'
      ? `background:${hexOf(sys, accent)};color:${hexOf(sys, ground)};` +
        `padding:${PLATE_PAD.top}em ${PLATE_PAD.side}em ${PLATE_PAD.bottom}em;` +
        `box-shadow:0 ${scaleTo(sys, 6)}px ${scaleTo(sys, 18)}px ${rgba(darken(hexOf(sys, ground)), 0.34)};` +
        `transform:rotate(-2deg)`
      : execution === 'underline'
        ? `color:${hexOf(sys, ink)};border-bottom:${scaleTo(sys, 2)}px solid ${hexOf(sys, accent)};` +
          `padding:0 0 ${ACCENT_UNDERLINE_PAD_EM}em;text-shadow:${shadow}`
        : execution === 'offset'
          ? `color:${hexOf(sys, ink)};padding:${SHEAR_PAD};text-shadow:${hardOffsetShadow(sys, ink, ground)}`
          : `color:${hexOf(sys, ink)};${execution === 'register' ? 'font-style:italic;' : ''}` +
            `padding:${SHEAR_PAD};text-shadow:${shadow}`;

  const html =
    `<span class="aw${pop ? '' : ' aws'}" id="${id}" style="left:${x}px;top:${y}px;z-index:${z}` +
    (pop ? '' : `;animation-delay:${delayMs}ms;animation-duration:${riseMs}ms`) + `">` +
    `<span class="${pop ? 'awp' : 'awi'}" style="animation-delay:${delayMs}ms;animation-duration:${riseMs}ms">` +
    `<span class="awt">${escapeHtml(text)}</span></span></span>`;

  const css = [
    `.aw{position:absolute}`,
    pop
      ? `.awp{display:inline-block;opacity:0;transform:scale(.4);transform-origin:50% 75%;animation-name:awPop;animation-fill-mode:both;animation-timing-function:${curve}}`
      : `.aws{transform:translateX(-${slide}px);animation-name:awSlide;animation-fill-mode:both;animation-timing-function:${curve}}\n` +
        `.awi{display:inline-block;opacity:0;transform:translateY(0.12em);animation-name:awRise;animation-fill-mode:both;animation-timing-function:${curve}}`,
    `#${id} .awt{display:inline-block;${typeCss(sys, r, fontIndex)};${paint}}`,
    pop
      ? `@keyframes awPop{0%{opacity:0;transform:scale(.4)}55%{opacity:1;transform:scale(1.28)}100%{opacity:1;transform:scale(1)}}`
      : `@keyframes awSlide{from{transform:translateX(-${slide}px)}to{transform:translateX(0)}}\n` +
        `@keyframes awRise{from{opacity:0;transform:translateY(0.12em)}to{opacity:1;transform:translateY(0)}}`,
  ].join('\n');

  return { html, css };
}

/** `_card4`: the marker square's top sits 8.3px under a 20px label's, centred on its cap height. */
const MARKER_DROP_EM = 0.415;
/** `_card4`: 13px, the rise it gives every row in its stack, inside the kicker's own 7–16px range. */
const LABEL_RISE_PX = 13;
/** The kicker arrives behind the block it labels — the middle of the corpus's 140–520ms. */
const KICKER_BEHIND_MS = 330;
/** `_ugc2-chair`: a 32px pitch between two stacked labels at 20px. */
const LABEL_PITCH_RATIO = 32 / 20;

export interface KickerOptions {
  id: string;
  text: string;
  /** Left edge of the text; with align `right`, the inset from the canvas's right edge. */
  x: number;
  y: number;
  /** An uppercase label rung. The label register is +0.10 to +0.30em, median +0.163em. */
  role?: string | string[];
  /** Signal at full strength, or the ink held back. Those are the corpus's only two options. */
  tone?: 'signal' | 'ink';
  accent?: string;
  ink?: string;
  ground?: string;
  /** Ink tone only. The corpus sets 0.55–0.62. */
  alpha?: number;
  /** The square that anchors the label to the grid. Skipped when the label is centred. */
  marker?: boolean;
  align?: 'left' | 'right' | 'center';
  /** Required by `center`, which needs a box to centre inside. */
  width?: number;
  delayMs?: number;
  /** Corpus range is 280–520ms. */
  riseMs?: number;
  /** Off when the label sits on a flat ground rather than over footage. */
  shadow?: boolean;
  fontIndex?: number;
  z?: number;
}

/**
 * The eyebrow that carries chapter, section, location or speaker so the headline need not.
 *
 * The marker square is what stops it floating: it hangs on the grid line the text is measured from.
 * It is filled rather than the ring `_card4` describes because a filled square reads at this size, not
 * because the engine cannot draw a ring: a spread-only `box-shadow: 0 0 0 Npx` DOES paint a keyline
 * (probe: box-shadow-spread-keyline, REFUTED). The four-element keyline frame elsewhere in the corpus
 * predates that measurement and is not evidence of a limit.
 */
export function kicker(sys: DesignSystem, o: KickerOptions): DeviceOutput {
  const {
    id, text, x, y,
    role = ['kicker', 'micro', 'body'],
    tone = 'signal',
    accent = accentKey(sys),
    ink = inkKey(sys),
    ground = groundKey(sys),
    alpha = 0.62,
    marker = true,
    align = 'left',
    delayMs = 0,
    riseMs = REVEAL_MS,
    shadow = true,
    fontIndex = 0,
    z = 4,
  } = o;

  const r = rungOf(sys, role);
  if (align === 'center' && o.width === undefined) {
    throw new Error('kicker: a centred label needs a width to centre inside');
  }
  const rise = scaleTo(sys, LABEL_RISE_PX, CARD_REF);
  const side = scaleTo(sys, 11, CARD_REF);
  const gap = scaleTo(sys, 24, CARD_REF);
  const drop = Math.round(MARKER_DROP_EM * r.px);
  const flush = x - trailingTrackPx(r);
  const box =
    align === 'right' ? `right:${flush}px` :
    align === 'center' ? `left:${x}px;width:${o.width}px;text-align:center` :
    `left:${x}px`;
  const colour = tone === 'signal' ? hexOf(sys, accent) : rgba(hexOf(sys, ink), alpha);
  const withMarker = marker && align !== 'center';
  const markerBox = align === 'right' ? `right:${flush - gap}px` : `left:${x - gap}px`;
  const timing = `animation-delay:${delayMs}ms;animation-duration:${riseMs}ms`;

  const html =
    `<div class="kk" id="${id}" style="${box};top:${y}px;z-index:${z};${timing}">${escapeHtml(text)}</div>` +
    (withMarker
      ? `<div class="kk" id="${id}-marker" style="${markerBox};top:${y + drop}px;width:${side}px;height:${side}px;z-index:${z};${timing}"></div>`
      : '');

  const css = [
    `.kk{position:absolute;z-index:1;opacity:0;animation-name:kkIn;animation-fill-mode:both;animation-timing-function:${ease(sys, 'standard')}}`,
    `#${id}{${typeCss(sys, r, fontIndex)};color:${colour}` +
      (shadow ? `;text-shadow:${groundShadow(sys, { weight: r.weight, ground })}` : '') + `}`,
    withMarker ? `#${id}-marker{background:${hexOf(sys, accent)}}` : '',
    `@keyframes kkIn{from{opacity:0;transform:translateY(${rise}px)}to{opacity:1;transform:translateY(0)}}`,
  ].filter(Boolean).join('\n');

  return { html, css };
}

/** `rx2-FR`'s left grid and measure, the same document the canonical rule was measured on. */
const GRID_X = 48;
const MEASURE = 592;
/** `shopping-IT`: a 90px line pitch at 51px type. A rule takes a line slot like any other row. */
const CAPTION_PITCH_RATIO = 90 / 51;
/** `rx2-FR`: the chip under the base rule starts 12px below it. */
const UNDER_RULE_PX = 12;
/** The caption stack rises 0.16–0.42em — the middle of it, in em so it scales with the type. */
const CAPTION_RISE_EM = 0.29;

export interface LowerThirdOptions {
  id: string;
  /** The display line — a name, a place, a claim. */
  name: string;
  /** The label line under the rule. Omitted when the name carries the whole job. */
  kicker?: string;
  /** Left grid, top of the name line, and the measure the rule declares. */
  x?: number;
  y: number;
  width?: number;
  nameRole?: string | string[];
  kickerRole?: string | string[];
  ink?: string;
  accent?: string;
  ground?: string;
  delayMs?: number;
  riseMs?: number;
  fontIndex?: number;
  z?: number;
}

/**
 * The name plate: a caption row anchored to a fixed slot, a rule under it, a kicker under that.
 *
 * It is a COMPOSITION, not a new device — the corpus builds it from three things it already has
 * (`_card4` eyebrow plus statement, `_ugc2-chair` key plus value), so this assembles the divider and
 * the kicker rather than redrawing them. The rule takes the line slot the second caption row would
 * have taken, which is why the block reads as typography rather than as a graphic with a line in it.
 */
export function lowerThird(sys: DesignSystem, o: LowerThirdOptions): DeviceOutput {
  const {
    id, name, y,
    nameRole = ['name', 'subhead', 'body'],
    kickerRole = ['kicker', 'micro', 'body'],
    ink = inkKey(sys),
    accent = accentKey(sys),
    ground = groundKey(sys),
    delayMs = 0,
    riseMs = REVEAL_MS,
    fontIndex = 0,
    z = 4,
  } = o;

  const x = o.x ?? scaleTo(sys, GRID_X);
  const width = o.width ?? scaleTo(sys, MEASURE);
  const nr = rungOf(sys, nameRole);
  const ruleY = y + Math.round(CAPTION_PITCH_RATIO * nr.px);

  const rule = divider(sys, { id: `${id}-rule`, x, y: ruleY, width, delayMs, accent, ink });
  // No marker square: the rule already anchors the label to the grid, and two anchors on one line is
  // the kind of redundancy that reads as decoration.
  const eyebrow = o.kicker
    ? kicker(sys, {
      id: `${id}-kicker`, text: o.kicker, x, y: ruleY + scaleTo(sys, UNDER_RULE_PX),
      role: kickerRole, accent, ink, ground, marker: false, fontIndex, z,
      delayMs: delayMs + KICKER_BEHIND_MS,
    })
    : undefined;

  const html =
    `<div class="lt" id="${id}" style="left:${x}px;top:${y}px;width:${width}px;z-index:${z};` +
    `animation-delay:${delayMs}ms;animation-duration:${riseMs}ms">${escapeHtml(name)}</div>` +
    rule.html + (eyebrow?.html ?? '');

  const css = [
    `.lt{position:absolute;z-index:1;opacity:0;animation-name:ltIn;animation-fill-mode:both;animation-timing-function:${ease(sys, 'standard')}}`,
    `#${id}{${typeCss(sys, nr, fontIndex)};color:${hexOf(sys, ink)};padding:${SHEAR_PAD};` +
      `text-shadow:${groundShadow(sys, { weight: nr.weight, ground })}}`,
    `@keyframes ltIn{from{opacity:0;transform:translateY(${CAPTION_RISE_EM}em)}to{opacity:1;transform:translateY(0)}}`,
    rule.css,
    eyebrow?.css ?? '',
  ].filter(Boolean).join('\n');

  return { html, css };
}

/** `rx2-FR`: the rail rises 7px. */
const RAIL_RISE_PX = 7;

export interface RailItem {
  text: string;
  /** Left, or right for the counterweight at the other end of the measure. */
  align?: 'left' | 'right';
  /**
   * The rung this item is set on. A timecode wants its own: it is the only near-zero-tracking item
   * on the rail, and that contrast is what makes the numeral read as the quiet register.
   */
  role?: string | string[];
  /** Defaults to the rung's weight for the first item and one step lighter for the rest. */
  weight?: number;
  /** Corpus range is 0.80–1.0. */
  alpha?: number;
  italic?: boolean;
}

export interface DataRailOptions {
  id: string;
  /** Top of the rail, in run-canvas px. */
  y: number;
  x?: number;
  width?: number;
  items: RailItem[];
  role?: string | string[];
  ink?: string;
  ground?: string;
  delayMs?: number;
  /** Corpus range is 480–520ms. */
  riseMs?: number;
  staggerMs?: number;
  fontIndex?: number;
  z?: number;
}

/**
 * A rail of mono technical text — identity, constant, section, timecode — on the document's measure.
 *
 * It costs four small text elements and turns a caption into a document. The two ends are
 * deliberately not the same: the left item carries the rung's weight at full strength and the right
 * one sits a weight lighter and dimmer, so the rail reads as a header and its counterweight rather
 * than as two labels that happened to land on one line.
 */
export function dataRail(sys: DesignSystem, o: DataRailOptions): DeviceOutput {
  const {
    id, y, items,
    role = ['rail', 'micro', 'kicker', 'body'],
    ink = inkKey(sys),
    ground = groundKey(sys),
    delayMs = 0,
    riseMs = 500,
    staggerMs = 80,
    fontIndex = 0,
    z = 3,
  } = o;

  const x = o.x ?? scaleTo(sys, GRID_X);
  const width = o.width ?? scaleTo(sys, MEASURE);
  const rise = scaleTo(sys, RAIL_RISE_PX);
  const inkHex = hexOf(sys, ink);

  const html = items.map((it, i) => {
    const r = rungOf(sys, it.role ?? role);
    const right = it.align === 'right';
    // A right-flushed item gives back its own trailing track, so the last glyph lands on the column.
    const box = right ? `left:${x}px;width:${width - trailingTrackPx(r)}px;text-align:right` : `left:${x}px`;
    return `<div class="dr" id="${id}-${i + 1}" style="${box};top:${y}px;z-index:${z};` +
      `animation-delay:${delayMs + i * staggerMs}ms;animation-duration:${riseMs}ms">${escapeHtml(it.text)}</div>`;
  }).join('');

  const perItem = items.map((it, i) => {
    const r = rungOf(sys, it.role ?? role);
    const weight = it.weight ?? (i === 0 ? r.weight : Math.max(100, r.weight - 100));
    const alpha = it.alpha ?? (i === 0 ? 1 : 0.8);
    return `#${id}-${i + 1}{${typeCss(sys, r, fontIndex, weight)};color:${rgba(inkHex, alpha)};` +
      (it.italic ? 'font-style:italic;' : '') +
      `text-shadow:${groundShadow(sys, { weight, ground })}}`;
  });

  const css = [
    `.dr{position:absolute;z-index:1;opacity:0;animation-name:drIn;animation-fill-mode:both;animation-timing-function:${ease(sys, 'standard')}}`,
    ...perItem,
    `@keyframes drIn{from{opacity:0;transform:translateY(${rise}px)}to{opacity:1;transform:translateY(0)}}`,
  ].join('\n');

  return { html, css };
}

/** `_card4`: three columns on a 158px pitch, 14.6% of the canvas width. */
const STAT_PITCH_FRACTION = 158 / 1080;
/** `_card4`: the label sits 46.21px under a 30px figure. */
const FIGURE_TO_LABEL_EM = 46.21 / 30;

export interface Stat {
  figure: string;
  label: string;
}

export interface StatBlockOptions {
  id: string;
  /** Top-left of the first column, in run-canvas px. */
  x: number;
  y: number;
  stats: Stat[];
  figureRole?: string | string[];
  labelRole?: string | string[];
  /** Column pitch in run-canvas px. Defaults to the corpus's 14.6% of the canvas width. */
  pitch?: number;
  ink?: string;
  ground?: string;
  delayMs?: number;
  riseMs?: number;
  /** 300ms per column — half the row stagger of an index list, because a trio is one gesture. */
  staggerMs?: number;
  fontIndex?: number;
  z?: number;
}

/**
 * Headline numbers side by side, so a spec becomes a claim.
 *
 * The pair works because the two rungs disagree in every way at once: the figure is large, heavy and
 * tracked negative, the label small, lighter and tracked out — a swing from −0.01 to +0.12em in
 * `_card4`. A column animates as ONE element rather than as two lines, which is what makes three
 * columns read as a single gesture.
 */
export function statBlock(sys: DesignSystem, o: StatBlockOptions): DeviceOutput {
  const {
    id, x, y, stats,
    figureRole = ['figure', 'subhead', 'headline', 'body'],
    labelRole = ['statLabel', 'kicker', 'micro', 'body'],
    ink = inkKey(sys),
    ground = groundKey(sys),
    delayMs = 0,
    riseMs = 440,
    staggerMs = 300,
    fontIndex = 0,
    z = 4,
  } = o;

  const fr = rungOf(sys, figureRole);
  const lr = rungOf(sys, labelRole);
  const pitch = o.pitch ?? Math.round(STAT_PITCH_FRACTION * sys.canvas.width);
  const rise = scaleTo(sys, LABEL_RISE_PX, CARD_REF);
  const labelTop = Math.round(FIGURE_TO_LABEL_EM * fr.px);
  const inkHex = hexOf(sys, ink);

  const html = stats.map((s, i) =>
    `<div class="sb" id="${id}-${i + 1}" style="left:${x + i * pitch}px;top:${y}px;z-index:${z};` +
    `animation-delay:${delayMs + i * staggerMs}ms;animation-duration:${riseMs}ms">` +
    `<div class="sbf">${escapeHtml(s.figure)}</div>` +
    `<div class="sbl" style="top:${labelTop}px">${escapeHtml(s.label)}</div></div>`,
  ).join('');

  const css = [
    `.sb{position:absolute;z-index:1;opacity:0;animation-name:sbIn;animation-fill-mode:both;animation-timing-function:${ease(sys, 'standard')}}`,
    `.sbf{position:absolute;left:0;top:0;white-space:pre;${typeCss(sys, fr, fontIndex)};color:${inkHex};` +
      `text-shadow:${groundShadow(sys, { weight: fr.weight, ground })}}`,
    `.sbl{position:absolute;left:0;white-space:pre;${typeCss(sys, lr, fontIndex)};color:${inkHex};` +
      `text-shadow:${groundShadow(sys, { weight: lr.weight, ground })}}`,
    `@keyframes sbIn{from{opacity:0;transform:translateY(${rise}px)}to{opacity:1;transform:translateY(0)}}`,
  ].join('\n');

  return { html, css };
}

/** `_card3`: overshoot, undershoot, overshoot, settle — a spring baked into the keyframe values. */
const HERO_SCALE = [1.104, 1.066, 1.030, 1.002, 0.985, 0.988, 1.004, 1.006, 1.000];
/** Its paired lift, in px at the 1920-wide canvas it was measured on. */
const HERO_LIFT_PX = [-6, -3, -1, 1, 0];
/** The whole settle happens inside 14% of the window; the rest of it holds. */
const HERO_SETTLE = 0.14;
/** `_card1`: 285px line height on 228px type. */
const HERO_LINE_HEIGHT = 1.25;
/** `_card3`'s hero box, as fractions of its canvas: 1200x394 at (360, 649) on 1920x1440. */
const HERO_BOX = { x: 360 / 1920, width: 1200 / 1920, y: 649 / 1440 };

export interface HeroFigureOptions {
  id: string;
  text: string;
  /** The box the figure is optically centred in, in run-canvas px. */
  x: number;
  y: number;
  width: number;
  role?: string | string[];
  ink?: string;
  ground?: string;
  delayMs?: number;
  /** The window the settle happens inside; it takes the first 14% of it. */
  windowMs?: number;
  align?: 'left' | 'center';
  /** Off when the figure sits on a flat ground — matted ink needs no shadow at all. */
  shadow?: boolean;
  fontIndex?: number;
  z?: number;
}

/**
 * One number at a scale nothing else reaches.
 *
 * The motion is `_card3`'s hand-baked spring rather than an overshooting bezier: nine scale stops
 * that overshoot, undershoot and overshoot again before settling, on a LINEAR timing function so the
 * keyframes own the shape. Only two documents in the whole corpus put an overshoot in the curve — the
 * rest bake it into the values, and this is the one worth keeping.
 */
export function heroFigure(sys: DesignSystem, o: HeroFigureOptions): DeviceOutput {
  const {
    id, text, x, y, width,
    role = ['hero', 'display', 'headline', 'body'],
    ink = inkKey(sys),
    ground = groundKey(sys),
    delayMs = 0,
    windowMs = 3142,
    align = 'center',
    shadow = true,
    fontIndex = 0,
    z = 4,
  } = o;

  const r = rungOf(sys, role);
  const lift = (px: number) => Math.round((px * sys.canvas.width) / SCENE_REF);
  // The lift has five stops against the scale's nine. It settles first and HOLDS at its settled
  // value; interpolating four more numbers would invent motion the document never had.
  const stops = HERO_SCALE.map((s, i) => {
    const at = ((i / (HERO_SCALE.length - 1)) * HERO_SETTLE * 100).toFixed(2).replace(/\.?0+$/, '');
    const dy = lift(HERO_LIFT_PX[i] ?? 0);
    return `${at}%{transform:translateY(${dy}px) scale(${s})}`;
  });

  const html =
    `<div class="hf" id="${id}" style="left:${x}px;top:${y}px;width:${width}px;z-index:${z};` +
    `animation-delay:${delayMs}ms;animation-duration:${windowMs}ms">${escapeHtml(text)}</div>`;

  const css = [
    `.hf{position:absolute;animation-name:hfSpring;animation-fill-mode:both;animation-timing-function:linear}`,
    `#${id}{${typeCss(sys, r, fontIndex)};color:${hexOf(sys, ink)};line-height:${HERO_LINE_HEIGHT};text-align:${align}` +
      // At hero scale the shadow is the same two-layer stack at twice the radii — a 900-weight face
      // needs the separation and not the alpha.
      (shadow ? `;text-shadow:${groundShadow(sys, { weight: r.weight, ground, scale: 2 })}` : '') + `}`,
    `@keyframes hfSpring{${stops.join('')}100%{transform:translateY(0px) scale(1)}}`,
  ].join('\n');

  return { html, css };
}

export interface TitleCardOptions {
  id: string;
  headline: string;
  kicker?: string;
  /** The beat gate's own window. Successive cards carry ascending z, so a cut is never a cross-fade. */
  delayMs?: number;
  durationMs: number;
  z?: number;
  /** Block geometry; the defaults are `_card3`'s hero box as fractions of its canvas. */
  x?: number;
  y?: number;
  width?: number;
  headlineRole?: string | string[];
  kickerRole?: string | string[];
  ink?: string;
  accent?: string;
  ground?: string;
  /**
   * A window onto the footage, in run-canvas px. Without one the card sits on a flat ground; with
   * one the ground becomes four mats around it.
   */
  window?: { x: number; y: number; width: number; height: number };
  fontIndex?: number;
}

/**
 * The opening title, the chapter break and the end card, in one implementation.
 *
 * Three things it is made of are already here — the beat gate, the hero figure and the kicker — and
 * the fourth is the matte: the ground is the document's own colour rather than black, so the mat and
 * the letterbox read as one surface. Nothing on this card carries a text-shadow, because the ink only
 * ever sits on that flat ground; a shadow over a flat field is the tell of a graphic pasted on.
 */
export function titleCard(sys: DesignSystem, o: TitleCardOptions): DeviceOutput {
  const {
    id, headline, durationMs,
    delayMs = 0,
    z = 11,
    headlineRole = ['hero', 'display', 'headline', 'body'],
    kickerRole = ['kicker', 'micro', 'body'],
    ink = inkKey(sys),
    accent = accentKey(sys),
    ground = groundKey(sys),
    fontIndex = 0,
  } = o;

  const { width: cw, height: ch } = sys.canvas;
  const x = o.x ?? Math.round(HERO_BOX.x * cw);
  const width = o.width ?? Math.round(HERO_BOX.width * cw);
  const y = o.y ?? Math.round(HERO_BOX.y * ch);
  const kr = rungOf(sys, kickerRole);
  const groundHex = hexOf(sys, ground);

  // Four mats, or one plate. The mats are the complement of the window, so a caller cannot leave a
  // band of bare canvas by moving the window and forgetting one of them.
  const w = o.window;
  const plates = w
    ? [
      [0, 0, cw, w.y],
      [0, w.y + w.height, cw, ch - w.y - w.height],
      [0, w.y, w.x, w.height],
      [w.x + w.width, w.y, cw - w.x - w.width, w.height],
    ]
    : [[0, 0, cw, ch]];

  const mats = plates
    .filter(([, , pw, ph]) => pw > 0 && ph > 0)
    .map(([px, py, pw, ph], i) =>
      `<div class="tcm" id="${id}-mat${i + 1}" style="left:${px}px;top:${py}px;width:${pw}px;height:${ph}px;z-index:1"></div>`)
    .join('');

  // The kicker leads by one label line, so the headline starts where the second label would have.
  const kickerY = y;
  const heroY = y + Math.round(LABEL_PITCH_RATIO * kr.px);
  const eyebrow = o.kicker
    ? kicker(sys, {
      id: `${id}-kicker`, text: o.kicker, x, y: kickerY, width, align: 'center',
      role: kickerRole, accent, ink, ground, shadow: false, fontIndex, z: 2,
    })
    : undefined;
  const hero = heroFigure(sys, {
    id: `${id}-hero`, text: headline, x, y: heroY, width, role: headlineRole,
    ink, ground, shadow: false, windowMs: durationMs, fontIndex, z: 2,
  });

  const html =
    `<div class="cue" id="${id}" style="z-index:${z};animation-delay:${delayMs}ms;animation-duration:${durationMs}ms">` +
    mats + (eyebrow?.html ?? '') + hero.html + `</div>`;

  const css = [
    `.cue{position:absolute;left:0;top:0;width:100%;height:100%;z-index:1;opacity:1;animation-name:cueWin;animation-fill-mode:forwards;animation-timing-function:linear}`,
    `.tcm{position:absolute;background:${groundHex}}`,
    `@keyframes cueWin{0%,99.99%{opacity:1}100%{opacity:0}}`,
    eyebrow?.css ?? '',
    hero.css,
  ].filter(Boolean).join('\n');

  return { html, css };
}

/**
 * `_card2`'s two backing plates, as fractions of the badge side.
 *
 * Each grows the square, grows its radius, and shifts left and down — so the badge reads as a stack
 * with thickness rather than as a sticker with a drop shadow under it.
 */
const BADGE_PLATES = [
  { side: 116 / 112, radius: 28 / 116, dx: -2 / 112, dy: 3 / 112, alpha: 0.13 },
  { side: 122 / 112, radius: 31 / 122, dx: -5 / 112, dy: 3 / 112, alpha: 0.10 },
];

export interface BadgeLockupOptions {
  id: string;
  /** Top-left of the badge itself, in run-canvas px. */
  x: number;
  y: number;
  /** The badge's side. The three parameters that cover the corpus are side, radius and inset. */
  side: number;
  /** `_card2` 0.232, `_card3` 0.25. */
  radiusFraction?: number;
  /** The mark occupies 58.9% of the side, leaving 20.5% clear on every edge. */
  markFraction?: number;
  /** Markup for the mark itself, placed and sized by the badge. */
  mark?: string;
  accent?: string;
  ground?: string;
  /** The backing plates. Off only for a badge that is genuinely flat. */
  plates?: boolean;
  delayMs?: number;
  fadeMs?: number;
  z?: number;
}

/**
 * The identity mark in a corner, with physical thickness.
 *
 * Its motion is a fade and nothing else: the badge is the first thing on screen and it never moves,
 * so any entrance would make it compete with the film. Radius is a single value because per-corner
 * and slash radii drop the whole declaration in this engine and the box renders square.
 */
export function badgeLockup(sys: DesignSystem, o: BadgeLockupOptions): DeviceOutput {
  const {
    id, x, y, side,
    radiusFraction = 0.232,
    markFraction = 0.589,
    accent = accentKey(sys),
    ground = groundKey(sys),
    plates = true,
    delayMs = 300,
    fadeMs = 420,
    z = 4,
  } = o;

  const groundHex = hexOf(sys, ground);
  const timing = `animation-delay:${delayMs}ms;animation-duration:${fadeMs}ms`;
  const markSide = Math.round(markFraction * side);
  const inset = Math.round((side - markSide) / 2);

  const backing = plates
    ? BADGE_PLATES.map((p, i) => {
      const s = Math.round(p.side * side);
      return `<div class="bl" id="${id}-plate${i + 1}" style="left:${x + Math.round(p.dx * side)}px;` +
        `top:${y + Math.round(p.dy * side)}px;width:${s}px;height:${s}px;` +
        `border-radius:${Math.round(p.radius * s)}px;background:${rgba(groundHex, p.alpha)};` +
        `z-index:${z};${timing}"></div>`;
    }).join('')
    : '';

  const html = backing +
    `<div class="bl" id="${id}" style="left:${x}px;top:${y}px;width:${side}px;height:${side}px;` +
    `border-radius:${Math.round(radiusFraction * side)}px;background:${hexOf(sys, accent)};` +
    `z-index:${z + 1};${timing}"></div>` +
    (o.mark
      ? `<div class="bl" id="${id}-mark" style="left:${x + inset}px;top:${y + inset}px;` +
        `width:${markSide}px;height:${markSide}px;z-index:${z + 2};${timing}">${o.mark}</div>`
      : '');

  const css = [
    `.bl{position:absolute;z-index:1;opacity:0;animation-name:blIn;animation-fill-mode:forwards;animation-timing-function:linear}`,
    `@keyframes blIn{from{opacity:0}to{opacity:1}}`,
  ].join('\n');

  return { html, css };
}

/** `rx2-DE`: interior ticks 6px, the two ends 9px and lifted 3px above the rule. */
const TICK_INTERIOR_PX = 6;
const TICK_END_PX = 9;
const TICK_RAISE_PX = 3;

export interface TickScaleOptions {
  id: string;
  /** The rule the scale stands on: its left end, its top, and its measure. */
  x: number;
  y: number;
  width: number;
  count?: number;
  /** Tick weight in run-canvas px — `rx2-DE` sets 1, `rx2-FR` sets 2. */
  weight?: number;
  ink?: string;
  /** `rx2-DE` sets 0.30 against a 0.22 rule; `rx2-FR` sets 0.55 against a 0.46 one. */
  alpha?: number;
  delayMs?: number;
  drawMs?: number;
  /** 55ms, deliberately shorter than the word stagger so the scale reads as one gesture. */
  staggerMs?: number;
  z?: number;
}

/**
 * The ticks that turn a rule into a measure.
 *
 * The last tick lands ON the right end of the rule rather than continuing the interval — `rx2-DE`'s
 * fifth tick sits at 631 on a 576px measure from 56, and `rx2-FR`'s at 638 on a 592px one from 48.
 * A scale whose last division falls short of the measure it divides reads as an accident, and this is
 * the one place the corpus breaks its own interval to avoid it.
 *
 * The two end ticks are longer and lifted, so the measure has ends rather than just divisions.
 */
export function tickScale(sys: DesignSystem, o: TickScaleOptions): DeviceOutput {
  const {
    id, x, y, width,
    count = 5,
    ink = inkKey(sys),
    alpha = 0.3,
    delayMs = 0,
    drawMs = 320,
    staggerMs = 55,
    z = 3,
  } = o;

  if (count < 2) throw new Error(`tickScale: a measure needs at least two ticks, got ${count}`);
  const weight = o.weight ?? scaleTo(sys, 1);
  const interior = scaleTo(sys, TICK_INTERIOR_PX);
  const end = scaleTo(sys, TICK_END_PX);
  const raise = scaleTo(sys, TICK_RAISE_PX);
  const fill = rgba(hexOf(sys, ink), alpha);

  const html = Array.from({ length: count }, (_, i) => {
    const isEnd = i === 0 || i === count - 1;
    const left = i === count - 1 ? x + width - weight : x + Math.round((i * width) / (count - 1));
    return `<div class="tk" id="${id}-${i + 1}" style="left:${left}px;top:${isEnd ? y - raise : y}px;` +
      `width:${weight}px;height:${isEnd ? end : interior}px;background:${fill};z-index:${z};` +
      `animation-delay:${delayMs + i * staggerMs}ms;animation-duration:${drawMs}ms"></div>`;
  }).join('');

  const css = [
    `.tk{position:absolute;transform:scaleY(0);transform-origin:top center;animation-name:tkDraw;` +
      `animation-fill-mode:forwards;animation-timing-function:${ease(sys, 'draw', DRAW_CURVE)}}`,
    `@keyframes tkDraw{from{transform:scaleY(0)}to{transform:scaleY(1)}}`,
  ].join('\n');

  return { html, css };
}
