// A platform's safe zone as a stylesheet beside the page: the stage at the shape's canvas, and a [data-safe]
// container on the zone as the page's text layer, whose defaults keep text the page leaves unstyled inside the
// zone and at the shape's minimum size.
//
//   openedit safe-zone tiktok --out runs/<key>
//   openedit safe-zone 9:16 --ad --out runs/<key>
//   openedit safe-zone instagram --out runs/<key> --canvas 1080x1350
//   openedit safe-zone 16:9 --out runs/<key> --canvas 1280x720
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { parseCanvas } from './concat-videos.ts';
import { SIZE_FLOOR } from '../verify/text.ts';

export interface Size {
  width: number;
  height: number;
}

/** A picture shape: what the stage's data-safe-zone says, whichever of the shape's zones is chosen. */
export type Shape = '9:16' | '16:9' | '4:3' | '1:1' | '4:5';

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Format {
  /** The zone's own name, as the command prints it: a shape for its default zone, else an app, or `9:16 ad`. */
  name: string;
  /** The stage's data-safe-zone and the stylesheet's selector. Every zone of a shape shares it, so a page moves to
   *  another zone of its shape by its stylesheet alone. */
  shape: Shape;
  /** Who shows a picture in this zone, for the stylesheet and the help. */
  platforms: string;
  /** What the zone keeps text clear of, exactly, for the stylesheet and the help. */
  keeps: string;
  aspect: Size;
  /** The canvas the insets were measured on, and the default one. */
  canvas: Size;
  /** How far in from each edge the sources keep text, in px of `canvas`, before the sides are evened out. */
  insets: Insets;
}

const SHAPES: Record<Shape, { aspect: Size; canvas: Size }> = {
  '9:16': { aspect: { width: 9, height: 16 }, canvas: { width: 1080, height: 1920 } },
  '16:9': { aspect: { width: 16, height: 9 }, canvas: { width: 1920, height: 1080 } },
  '4:3': { aspect: { width: 4, height: 3 }, canvas: { width: 1440, height: 1080 } },
  '1:1': { aspect: { width: 1, height: 1 }, canvas: { width: 1080, height: 1080 } },
  '4:5': { aspect: { width: 4, height: 5 }, canvas: { width: 1080, height: 1350 } },
};

function zone(name: string, shape: Shape, platforms: string, keeps: string, insets: Insets): Format {
  return { name, shape, platforms, keeps, ...SHAPES[shape], insets };
}

// A shape's default goes to several apps at once, so each side takes the deepest inset any of them needs there,
// which puts the default inside every app's own zone by construction.
function largest(zones: Format[]): Insets {
  const most = (side: keyof Insets) => Math.max(...zones.map((z) => z.insets[side]));
  return { top: most('top'), right: most('right'), bottom: most('bottom'), left: most('left') };
}

// An ordinary post's own UI, measured on the apps' own images of it: the platforms publish safe zones for ads only.
const TIKTOK = zone('tiktok', '9:16', 'TikTok',
  'clear of TikTok\'s tabs, button column and caption block (up to four caption lines) on an ordinary post',
  { top: 240, right: 183, bottom: 442, left: 52 });
const REELS = zone('reels', '9:16', 'Instagram and Facebook Reels',
  'clear of the Reels header, button column and caption block, and of Instagram\'s floating tab bar, on an ordinary Reel',
  { top: 206, right: 200, bottom: 396, left: 97 });
const SHORTS = zone('shorts', '9:16', 'YouTube Shorts',
  'clear of the Shorts search and menu icons, button column and channel and title rows on an ordinary Short',
  { top: 221, right: 198, bottom: 281, left: 69 });

// An ad draws more over the picture than an ordinary post does (a call-to-action, a sponsor label), so it keeps the
// published ad zones, every inset the largest of YouTube's sheet and Meta's figures.
const AD = zone('9:16 ad', '9:16', 'ads on TikTok, Instagram and Facebook Reels, and YouTube Shorts',
  'inside both YouTube\'s vertical ad safe zone and Meta\'s Reels ad margins, with YouTube\'s right margin, the wider '
    + 'of the two sides, on both',
  { top: 288, right: 192, bottom: 672, left: 65 });

const YOUTUBE = zone('16:9', '16:9', 'YouTube',
  'between YouTube\'s title row and control bar, as its horizontal ad safe zone marks them, and inside that zone\'s '
    + 'side margins, its right one (the wider) on both sides; the corners that zone also keeps for an ad\'s own '
    + 'call-to-action and skip button are not kept clear',
  { top: 166, right: 152, bottom: 143, left: 38 });

// A feed player draws its controls along the bottom only, at a fixed size, so they take the most of the frame on a
// phone, where the player is narrowest. No UI reaches the other edges, which keep the television title-safe margin.
const TITLE_SAFE = 'inside the television title-safe margin (5%) where no UI reaches';
const LINKEDIN_WIDE = zone('linkedin 16:9', '16:9', 'LinkedIn\'s feed',
  `clear of LinkedIn's player controls (progress bar and buttons) at a phone's width, ${TITLE_SAFE}`,
  { top: 54, right: 96, bottom: 289, left: 96 });
const X_WIDE = zone('x', '16:9', 'X\'s feed',
  `clear of X's duration, view count and sound button at a phone's width, ${TITLE_SAFE}`,
  { top: 54, right: 96, bottom: 190, left: 96 });
const FACEBOOK_WIDE = zone('facebook 16:9', '16:9', 'Facebook\'s feed',
  `clear of Facebook's sound button at a phone's width, ${TITLE_SAFE}`,
  { top: 54, right: 96, bottom: 217, left: 96 });

// A 4:3 picture plays pillarboxed in the 16:9 player, so it shares that player's top and bottom bands; no UI
// reaches its sides, which keep the television title-safe margin.
const FOUR_THREE = zone('4:3', '4:3', 'a 4:3 picture in a 16:9 player such as YouTube\'s',
  'between the 16:9 player\'s title row and control bar, inside the television title-safe margin (5%) at the sides, '
    + 'where no player UI reaches',
  { top: 166, right: 72, bottom: 143, left: 72 });

const INSTAGRAM_FEED = `clear of Instagram's sound and tag buttons in the bottom corners at a phone's width, ${TITLE_SAFE}`;
const FACEBOOK_FEED = `clear of Facebook's sound button at a phone's width, ${TITLE_SAFE}`;
const LINKEDIN_FEED = `clear of LinkedIn's player controls (progress bar and buttons) at a phone's width, ${TITLE_SAFE}`;
const INSTAGRAM_SQUARE = zone('instagram 1:1', '1:1', 'Instagram\'s feed', INSTAGRAM_FEED, { top: 54, right: 54, bottom: 111, left: 54 });
const FACEBOOK_SQUARE = zone('facebook 1:1', '1:1', 'Facebook\'s feed', FACEBOOK_FEED, { top: 54, right: 54, bottom: 122, left: 54 });
const LINKEDIN_SQUARE = zone('linkedin 1:1', '1:1', 'LinkedIn\'s feed', LINKEDIN_FEED, { top: 54, right: 54, bottom: 162, left: 54 });
const INSTAGRAM_PORTRAIT = zone('instagram 4:5', '4:5', 'Instagram\'s feed', INSTAGRAM_FEED, { top: 68, right: 54, bottom: 111, left: 54 });
const FACEBOOK_PORTRAIT = zone('facebook 4:5', '4:5', 'Facebook\'s feed', FACEBOOK_FEED, { top: 68, right: 54, bottom: 122, left: 54 });
const LINKEDIN_PORTRAIT = zone('linkedin 4:5', '4:5', 'LinkedIn\'s feed', LINKEDIN_FEED, { top: 68, right: 54, bottom: 162, left: 54 });

const FEEDS = 'Instagram\'s, Facebook\'s and LinkedIn\'s feeds';
const DEEPEST_FEED = `clear of what each of the three feeds draws over a video at a phone's width, the deepest of them, ${TITLE_SAFE}`;
const VERTICAL = zone('9:16', '9:16', 'TikTok, Instagram and Facebook Reels, and YouTube Shorts',
  'clear of what each of the three apps draws over an ordinary post, the deepest of them on each side',
  largest([TIKTOK, REELS, SHORTS]));
const SQUARE = zone('1:1', '1:1', FEEDS, DEEPEST_FEED, largest([INSTAGRAM_SQUARE, FACEBOOK_SQUARE, LINKEDIN_SQUARE]));
const PORTRAIT = zone('4:5', '4:5', FEEDS, DEEPEST_FEED, largest([INSTAGRAM_PORTRAIT, FACEBOOK_PORTRAIT, LINKEDIN_PORTRAIT]));

/** Every zone, a shape's default first, then its apps' own. */
export const FORMATS: readonly Format[] = [
  VERTICAL, TIKTOK, REELS, SHORTS, AD,
  YOUTUBE, LINKEDIN_WIDE, X_WIDE, FACEBOOK_WIDE,
  FOUR_THREE,
  SQUARE, INSTAGRAM_SQUARE, FACEBOOK_SQUARE, LINKEDIN_SQUARE,
  PORTRAIT, INSTAGRAM_PORTRAIT, FACEBOOK_PORTRAIT, LINKEDIN_PORTRAIT,
];

const DEFAULTS: Record<Shape, Format> = { '9:16': VERTICAL, '16:9': YOUTUBE, '4:3': FOUR_THREE, '1:1': SQUARE, '4:5': PORTRAIT };

// What an app's name means in each shape it is posted in. `alone` is the shape it means when no canvas says
// otherwise; an app posted in several shapes without one needs the canvas to say which.
const APPS: Record<string, { zones: Partial<Record<Shape, Format>>; alone?: Shape }> = {
  tiktok: { zones: { '9:16': TIKTOK } },
  reels: { zones: { '9:16': REELS } },
  shorts: { zones: { '9:16': SHORTS } },
  youtube: { zones: { '16:9': YOUTUBE, '9:16': SHORTS }, alone: '16:9' },
  x: { zones: { '16:9': X_WIDE } },
  instagram: { zones: { '9:16': REELS, '1:1': INSTAGRAM_SQUARE, '4:5': INSTAGRAM_PORTRAIT } },
  facebook: { zones: { '9:16': REELS, '16:9': FACEBOOK_WIDE, '1:1': FACEBOOK_SQUARE, '4:5': FACEBOOK_PORTRAIT } },
  linkedin: { zones: { '16:9': LINKEDIN_WIDE, '1:1': LINKEDIN_SQUARE, '4:5': LINKEDIN_PORTRAIT } },
};

const SPELLINGS: Record<string, string> = {
  '9x16': '9:16', '16x9': '16:9', '4x3': '4:3', '1x1': '1:1', '4x5': '4:5', twitter: 'x',
};

/** Every name the command takes, for help and refusals. */
export const FORMAT_NAMES = [...Object.keys(SHAPES), ...Object.keys(APPS), ...Object.keys(SPELLINGS)];

function shapeOf(canvas: Size, among: Shape[]): Shape | undefined {
  return among.find((s) => fits(SHAPES[s], canvas));
}

const sized = (s: Shape) => `${SHAPES[s].canvas.width}x${SHAPES[s].canvas.height}`;

/**
 * The zone a name stands for: a shape (`9:16`, or `9x16` for the shell) for its default zone, or an app (`tiktok`)
 * for that app's own. An app posted in several shapes takes its shape from the canvas. `ad` asks for the ad zone,
 * which only 9:16 has.
 */
export function formatNamed(name: string, opts: { canvas?: Size; ad?: boolean } = {}): Format {
  const raw = name.trim().toLowerCase();
  const key = Object.hasOwn(SPELLINGS, raw) ? SPELLINGS[raw] : raw;
  let found: Format;
  if (Object.hasOwn(SHAPES, key)) {
    found = DEFAULTS[key as Shape];
  } else if (Object.hasOwn(APPS, key)) {
    const app = APPS[key];
    const shapes = Object.keys(app.zones) as Shape[];
    const shape = (opts.canvas && shapeOf(opts.canvas, shapes)) ?? (shapes.length === 1 ? shapes[0] : app.alone);
    if (!shape && opts.canvas) {
      throw new Error(`a ${opts.canvas.width}x${opts.canvas.height} canvas is none of the shapes ${key} has a zone for: `
        + shapes.map((s) => `${s} (${sized(s)})`).join(', '));
    }
    if (!shape) {
      const feed = shapes.filter((s) => s === '1:1' || s === '4:5');
      const ways = [
        ...(app.zones['9:16'] === REELS ? ['name reels for a Reel'] : []),
        ...(feed.length ? [`name the feed shape (${listed(feed)})`] : []),
        `pass --canvas with the piece's size (${listed(shapes.map(sized))})`,
      ];
      throw new Error(`${key} is posted as ${listed(shapes.map((s) => app.zones[s] === REELS ? `${s} (a Reel)` : s))}, each with its own zone: `
        + ways.join(', or '));
    }
    found = app.zones[shape]!;
  } else {
    throw new Error(`${JSON.stringify(name)} names no safe-zone format, so a page of a shape with none (2:3 or 21:9, say) `
      + `skips this step; the names are ${FORMAT_NAMES.join(', ')}`);
  }
  if (opts.ad) {
    if (found.shape !== '9:16') {
      throw new Error(`--ad asks for the 9:16 ad zone, and ${JSON.stringify(name)} is ${found.shape}, which has no separate ad zone`);
    }
    return AD;
  }
  return found;
}

function listed(items: string[]): string {
  return items.length < 3 ? items.join(' or ') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

/** Whether a canvas has the shape, give or take the rounding of an even-sided or 16-aligned size. */
export function fits(format: { aspect: Size }, canvas: Size): boolean {
  const want = format.aspect.width / format.aspect.height;
  return Math.abs(canvas.width / canvas.height / want - 1) <= 0.02;
}

export interface Zone {
  format: Format;
  canvas: Size;
  /** The text area, in px of `canvas` from its top-left corner. */
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** The format's smallest text size, in px, which text inside it is set at by default. */
  minText: number;
}

/**
 * The format's zone on a canvas of its shape, the insets scaled to it and rounded up, so on a smaller canvas
 * the zone shrinks rather than grows.
 */
export function zoneFor(format: Format, canvas: Size): Zone {
  if (!fits(format, canvas)) {
    throw new Error(`a ${canvas.width}x${canvas.height} canvas is not ${format.shape}; the ${format.shape} safe zone is for a canvas such as ${format.canvas.width}x${format.canvas.height}`);
  }
  const sx = canvas.width / format.canvas.width;
  const sy = canvas.height / format.canvas.height;
  const i = format.insets;
  // Both sides take the larger inset, so a title centred in the container sits on the frame's centre: worth
  // more than the width the narrower side would give back.
  const side = Math.ceil(Math.max(i.left, i.right) * sx);
  return {
    format, canvas,
    left: side, top: Math.ceil(i.top * sy), right: canvas.width - side, bottom: canvas.height - Math.ceil(i.bottom * sy),
    minText: minText(canvas),
  };
}

// The review's size floor, so text left at the container's default, or sized no smaller than it, passes the text
// check: 49 px on a 1080 px side.
export function minText(canvas: Size): number {
  return Math.ceil(Math.min(canvas.width, canvas.height) * SIZE_FLOOR);
}

/** The stylesheet `openedit safe-zone` writes: the stage at the canvas size, and `[data-safe]` on the zone with its defaults. */
export function stylesheet(zone: Zone): string {
  const { format, canvas } = zone;
  const sel = `[data-safe-zone="${format.shape}"]`;
  return `/* openedit safe-zone ${format.name}: ${format.platforms}, on a ${canvas.width}x${canvas.height} canvas.
   [data-safe] is the text layer: it keeps text ${format.keeps}.
   The stage stays the whole frame, for footage, backgrounds and full-bleed pictures. */
${sel} {
  position: relative;
  width: ${canvas.width}px;
  height: ${canvas.height}px;
  --safe-top: ${zone.top}px;
  --safe-right: ${canvas.width - zone.right}px;
  --safe-bottom: ${canvas.height - zone.bottom}px;
  --safe-left: ${zone.left}px;
  --min-text: ${zone.minText}px;
}
/* The container's place on the zone, and a size container so cqw and cqh measure the zone for what is inside it.
   This rule is specific on purpose: a page rule must outrank it to move the container or change these properties. */
${sel} [data-safe] {
  position: absolute;
  left: ${zone.left}px;
  top: ${zone.top}px;
  width: ${zone.right - zone.left}px;
  height: ${zone.bottom - zone.top}px;
  box-sizing: border-box;
  container-type: size;
}
/* Every rule below has no specificity, so any rule the page writes for the same property wins. Text without a
   size of its own, and the elements a browser sets smaller, start at the format's minimum; a word too long
   for its line breaks rather than sticking out. Nothing is clipped. */
:where(${sel} [data-safe]) {
  font-size: var(--min-text);
  overflow-wrap: break-word;
}
:where(${sel} [data-safe]) :where(small, sub, sup, h5, h6, button, input, select, textarea) {
  font-size: var(--min-text);
}
/* A box inside keeps within the width it is given, padding included. One meant to run past the zone, such as
   a ticker's track, sets width: max-content and max-width: none. An svg keeps the size it is given, since its
   picture is drawn to that size and clamping it would cut it. */
:where(${sel} [data-safe]) :where(*:not(svg, svg *)) {
  box-sizing: border-box;
  max-width: 100%;
}
/* A picture narrowed to fit keeps its proportions, over the height its attributes give it. */
:where(${sel} [data-safe]) :where(img, video, canvas) {
  height: auto;
}
`;
}

// How a zone is asked for, where its printed name ("linkedin 1:1") is not itself a name the command takes.
function askedAs(f: Format): string {
  if (f === AD) return '--ad, with 9:16 or an app posted in it';
  const [app, shape] = f.name.split(' ');
  return shape ? `${app} with a ${shape} canvas` : f.name;
}

export const usage = {
  summary: 'Write the stylesheet that sizes the stage for a platform\'s shape and gives the page its safe-zone text layer',
  positionals: '<zone>',
  flags: {
    out: { type: 'string', required: true, value: '<dir>', help: 'Directory for safe-zone.css, usually the piece\'s own runs/<key>' },
    canvas: { type: 'string', value: 'WxH', help: 'The canvas, when it is not the shape\'s usual one (footage\'s own size, say); it must have the zone\'s shape, and it picks the shape for an app posted in several' },
    ad: { type: 'boolean', help: 'The ad zone, for a 9:16 video that runs as an ad: the published ad margins, which keep far more of the top and bottom clear than an ordinary post\'s UI takes' },
  },
  notes: [
    'Which zone: the app the brief names; with none named, or several, the shape\'s own name. 9:16, 1:1 and 4:5 are',
    'clear of every app listed for them; 16:9 is YouTube\'s player, so a 16:9 piece for a feed names that feed\'s app.',
    'Add --ad when a 9:16 video is an ad; other shapes have no ad zone, so an ad in them takes the ordinary one.',
    'Instagram is posted as a Reel or a feed post: name reels for a 9:16 Reel or the feed shape (1:1 or 4:5), or',
    'pass the piece\'s size with --canvas. Facebook and LinkedIn, posted in several shapes too, take --canvas the',
    'same way; with a 9:16 canvas, instagram and facebook mean reels and youtube means shorts. The zones:',
    ...FORMATS.map((f) => `- ${askedAs(f)}: ${f.platforms}, ${f.canvas.width}x${f.canvas.height}; keeps text ${f.keeps}.`),
    `Also accepted: ${Object.keys(SPELLINGS).join(', ')}. Every zone gives both sides the larger of its two side margins,`,
    'so text centred in the container sits on the frame\'s centre.',
    'Link the stylesheet, mark the stage with the zone\'s shape (<div id="stage" data-safe-zone="9:16">), and put',
    'all text inside <div data-safe>, the text layer on the zone; the stage stays the whole frame for footage,',
    'backgrounds and full-bleed pictures. The container\'s own rule (its place on the zone, box-sizing and',
    'container-type) is specific, so a page rule must outrank it to change them. Its other defaults have no',
    'specificity, so a rule the page writes for the same property wins:',
    '- Text inside it starts at --min-text, the shape\'s smallest size, and so do small, sub, sup, h5, h6 and form',
    '  controls, which a browser sets smaller. Set base text sizes on [data-safe] or inside it: one on body or #stage',
    '  does not reach in, since the container sets its own. Size text in cqw and cqh no smaller than the minimum, as',
    '  font-size: max(var(--min-text), 6cqw); on elements inside the container they measure the zone, while on the',
    '  container itself they measure the viewport.',
    '- A word too long for its line breaks; a row of word spans keeps words whole with flex-wrap: wrap.',
    '- A box inside keeps within the container\'s width, so one set wider is narrowed to it, unless it sets max-width:',
    '  none. A ticker\'s track meant to run past the zone sets width: max-content and max-width: none. An svg keeps the',
    '  size it is given, and a picture narrowed to fit keeps its proportions.',
    '- Nothing is clipped: text the page carries out of the container by its own position, white-space: nowrap or',
    '  max-width: none shows outside it.',
    '--safe-top, --safe-right, --safe-bottom and --safe-left are the zone\'s distance from each edge. A shape with no',
    'zone here, such as 2:3 or 21:9, skips this step.',
  ].join('\n'),
} satisfies Usage;

export async function safeZone(argv: string[]): Promise<number> {
  const { values, positionals } = parseUsage('safe-zone', usage, argv);
  if (positionals.length !== 1 || !values.out) {
    console.error(usageLine('safe-zone', usage));
    return 2;
  }
  const asked = values.canvas ? parseCanvas(values.canvas) : undefined;
  const format = formatNamed(positionals[0], { canvas: asked, ad: values.ad });
  const canvas = asked ?? format.canvas;
  const zone = zoneFor(format, canvas);
  const dir = resolve(values.out);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'safe-zone.css');
  writeFileSync(file, stylesheet(zone));
  const { width, height } = canvas;
  console.log(`safe-zone: ${format.name} (${format.platforms}), ${width}x${height} → ${file}`);
  console.log(`  text area: ${zone.right - zone.left}x${zone.bottom - zone.top} at ${zone.left},${zone.top}, clear of ${zone.top} px at the top, `
    + `${height - zone.bottom} at the bottom, ${zone.left} on the left and ${width - zone.right} on the right`);
  console.log(`  keeps text ${format.keeps}`);
  console.log(`  minimum text size: ${zone.minText} px, where text inside the container starts unless the page sizes it there`);
  console.log(`  page: <link rel="stylesheet" href="safe-zone.css">, <div id="stage" data-safe-zone="${format.shape}">, all text inside <div data-safe>`);
  return 0;
}
