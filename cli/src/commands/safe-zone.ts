// A platform format's safe zone as a stylesheet beside the page: the stage at the format's canvas, and a
// [data-safe] container on the zone as the page's text layer, whose defaults keep text the page leaves unstyled
// inside the zone and at the format's minimum size.
//
//   openedit safe-zone tiktok --out runs/<key>
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

export interface Format {
  /** What the stage's data-safe-zone says, and the stylesheet's selector. */
  name: '9:16' | '16:9' | '4:3';
  /** Who shows a picture of this shape, for the stylesheet and the help. */
  platforms: string;
  /** What the zone keeps text clear of, exactly, for the stylesheet and the help. */
  keeps: string;
  aspect: Size;
  /** The canvas the insets were published on, and the default one. */
  canvas: Size;
  /** How far in from each edge the sources keep text, in px of `canvas`, before the sides are evened out. */
  insets: { top: number; right: number; bottom: number; left: number };
}

// One 9:16 zone for all three apps, since one file is posted to each: every inset is the largest of YouTube's
// sheet and Meta's (quoted) figures. A 4:3 picture plays pillarboxed in the 16:9 player, so it shares that
// player's top and bottom bands; no UI reaches its sides, which keep the television title-safe margin.
export const FORMATS: readonly Format[] = [
  {
    name: '9:16', platforms: 'TikTok, Instagram and Facebook Reels, and YouTube Shorts', aspect: { width: 9, height: 16 },
    keeps: 'inside both YouTube\'s vertical ad safe zone and Meta\'s Reels ad margins as guides quote them (TikTok publishes no '
      + 'figures), with YouTube\'s right margin, the wider of the two sides, on both',
    canvas: { width: 1080, height: 1920 }, insets: { top: 288, right: 192, bottom: 672, left: 65 },
  },
  {
    name: '16:9', platforms: 'YouTube', aspect: { width: 16, height: 9 },
    keeps: 'between YouTube\'s title row and control bar, as its horizontal ad safe zone marks them, and inside that zone\'s '
      + 'side margins, its right one (the wider) on both sides; the corners that zone also keeps for an ad\'s own '
      + 'call-to-action and skip button are not kept clear',
    canvas: { width: 1920, height: 1080 }, insets: { top: 166, right: 152, bottom: 143, left: 38 },
  },
  {
    name: '4:3', platforms: 'a 4:3 picture in a 16:9 player such as YouTube\'s', aspect: { width: 4, height: 3 },
    keeps: 'between the 16:9 player\'s title row and control bar, inside the television title-safe margin (5%) at the sides, '
      + 'where no player UI reaches',
    canvas: { width: 1440, height: 1080 }, insets: { top: 166, right: 72, bottom: 143, left: 72 },
  },
];

const ALIASES: Record<string, Format['name']> = {
  tiktok: '9:16', reels: '9:16', shorts: '9:16', youtube: '16:9',
  '9x16': '9:16', '16x9': '16:9', '4x3': '4:3',
};

/** Every name a format answers to, for help and refusals. */
export const FORMAT_NAMES = [...FORMATS.map((f) => f.name), ...Object.keys(ALIASES)];

/** The format a name stands for: its own (`9:16`), a shell-friendly spelling (`9x16`) or a platform (`tiktok`). */
export function formatNamed(name: string): Format {
  const key = name.trim().toLowerCase();
  const found = FORMATS.find((f) => f.name === (ALIASES[key] ?? key));
  if (!found) {
    throw new Error(`${JSON.stringify(name)} names no safe-zone format, so a page of that shape (1:1 or 4:5, say) skips this step; `
      + `the formats are ${FORMAT_NAMES.join(', ')}`);
  }
  return found;
}

/** Whether a canvas has the format's shape, give or take the rounding of an even-sided or 16-aligned size. */
export function fits(format: Format, canvas: Size): boolean {
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
    throw new Error(`a ${canvas.width}x${canvas.height} canvas is not ${format.name}; the ${format.name} safe zone is for a canvas such as ${format.canvas.width}x${format.canvas.height}`);
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
  const sel = `[data-safe-zone="${format.name}"]`;
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

export const usage = {
  summary: 'Write the stylesheet that sizes the stage for a platform format and gives the page its safe-zone text layer',
  positionals: '<format>',
  flags: {
    out: { type: 'string', required: true, value: '<dir>', help: 'Directory for safe-zone.css, usually the piece\'s own runs/<key>' },
    canvas: { type: 'string', value: 'WxH', help: 'The canvas, when it is not the format\'s usual one (footage\'s own size, say); it must have the format\'s shape' },
  },
  notes: [
    ...FORMATS.map((f) => `${f.name}, ${f.platforms}, ${f.canvas.width}x${f.canvas.height}: keeps text ${f.keeps}.`),
    `Also accepted: ${FORMAT_NAMES.filter((n) => !FORMATS.some((f) => f.name === n)).join(', ')}. 9:16 is one zone for all three apps,`,
    'since one file is posted to each: each edge keeps the largest margin of YouTube\'s published ad safe-zone sheet and',
    'Meta\'s quoted Reels figures (TikTok publishes none). Every format gives both sides the larger of its two side',
    'margins, so text centred in the container sits on the frame\'s centre.',
    'Link the stylesheet, mark the stage with the format\'s own name (<div id="stage" data-safe-zone="9:16">), and put',
    'all text inside <div data-safe>, the text layer on the zone; the stage stays the whole frame for footage,',
    'backgrounds and full-bleed pictures. The container\'s own rule (its place on the zone, box-sizing and',
    'container-type) is specific, so a page rule must outrank it to change them. Its other defaults have no',
    'specificity, so a rule the page writes for the same property wins:',
    '- Text inside it starts at --min-text, the format\'s smallest size, and so do small, sub, sup, h5, h6 and form',
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
    'format here, such as 1:1 or 4:5, skips this step.',
  ].join('\n'),
} satisfies Usage;

export async function safeZone(argv: string[]): Promise<number> {
  const { values, positionals } = parseUsage('safe-zone', usage, argv);
  if (positionals.length !== 1 || !values.out) {
    console.error(usageLine('safe-zone', usage));
    return 2;
  }
  const format = formatNamed(positionals[0]);
  const canvas = values.canvas ? parseCanvas(values.canvas) : format.canvas;
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
  console.log(`  page: <link rel="stylesheet" href="safe-zone.css">, <div id="stage" data-safe-zone="${format.name}">, all text inside <div data-safe>`);
  return 0;
}
