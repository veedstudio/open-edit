// A camera for a screen recording: where it is clicked, and a zoom on each click strong enough that the text there reaches
// the canvas's minimum text size, written as zoom.js for the page to apply frame by frame, as faces.js is.
//
//   openedit zoom <video> [--clicks <clicks.json>] [--aspect 16:9,9:16] [--out <dir>] [--every 0.1] [--json]
//
// The page applies it rather than a render cropping the clip: the page places callouts and rings beside each click and
// so needs where the click is on its own stage at every moment, and Chrome draws the move between whole pixels where an
// ffmpeg crop steps a pixel at a time. Which clicks to zoom, the callouts and the cut stay the agent's: the camera only
// makes each click legible.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { numberFlag, parseUsage, usageLine, type Usage } from '../args.ts';
import { clipFolder } from '../faces/folder.ts';
import { probeSquareSize, probeVideoSpan } from '../probe.ts';
import { writeAtomic, writeTextAtomic } from '../providers/exclusive-files.ts';
import { resolveVideoArg } from '../resolve-video.ts';
import { canvasFor } from '../verify/canvas.ts';
import { SIZE_FLOOR } from '../verify/text.ts';
import { readActivity, workSize, type Activity, type Box } from '../zoom/activity.ts';
import { greyFrameAt, readChanges } from '../zoom/frames.ts';
import { zoomApi, zoomScript, type ZoomClick, type ZoomClip } from '../zoom/page-script.ts';
import { textNear } from '../zoom/text.ts';
import { parseAspect } from './reframe.ts';

export const usage = {
  summary: 'Find the clicks in a screen recording and write zoom.js, a camera that zooms in on each until the text there reaches the canvas\'s minimum size',
  positionals: '<video>',
  flags: {
    clicks: { type: 'string', value: '<clicks.json>', help: 'The points to zoom on instead of the clicks found: [{"t": <sec>, "x": <px>, "y": <px>}, ...] in the clip\'s seconds and display pixels, any moment and point included' },
    aspect: { type: 'string', value: 'W:H[,W:H...]', help: 'The shapes the summary gives each zoom for, at the platforms\' 1080 px canvas (default 16:9,9:16); zoom.js plans for whatever frame it is applied in' },
    out: { type: 'string', value: '<dir>', help: 'Where zoom.json and zoom.js are written (default runs/<key>/zoom-<hash>/ of the workspace, a folder of the clip\'s own by its real path)' },
    every: { type: 'string', value: '<sec>', help: 'Seconds between the frames compared (default 0.1)' },
    json: { type: 'boolean', help: 'Print zoom.json instead of the summary' },
  },
  notes: [
    'A click is where the drawn cursor rests and the screen changes near it, or changes wholesale soon after it arrives;',
    'with no cursor drawn, the first change after half a second of none. The camera holds each click zoomed so the text',
    'nearest it reaches the minimum text size of the stage it is shown on, shares a hold between clicks close by, eases',
    'between holds and pulls back to the whole picture when the screen changes wholesale or nothing happens for a while.',
    'Run it on the clip the page plays, after any cut. Load zoom.js with a <script> tag and in __seek call',
    'openeditZoom.apply(el, t): el shows the clip at its own pixel size (its <video>, or a wrapper holding it and anything',
    'drawn in the clip\'s pixels), its parent is the frame the camera fills, and t is seconds of the clip.',
    'openeditZoom.point(el, x, y, t) is where a pixel of the clip lands in that frame (a callout beside a click),',
    'openeditZoom.at(el, t) the part of the clip shown, openeditZoom.clicks() the clicks. Footage the page moves renders',
    'without --footage. The summary lists each click\'s text size and zoom per shape, and the stretches where nothing changes.',
  ].join('\n'),
} satisfies Usage;

/** The clicks a --clicks file lists, refused by name when one is not a time and a point inside the clip. */
export function parseClicks(text: string, file: string, size: { width: number; height: number; durationSec: number }): { t: number; x: number; y: number }[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not JSON: ${(e as Error).message}`, { cause: e });
  }
  const list = Array.isArray(data) ? data : (data as { clicks?: unknown })?.clicks;
  if (!Array.isArray(list) || !list.length) throw new Error(`${file} lists no clicks: give [{"t": <sec>, "x": <px>, "y": <px>}, ...]`);
  return list.map((c, i) => {
    const { t, x, y } = (c ?? {}) as Record<string, unknown>;
    const ok = [t, x, y].every((v) => typeof v === 'number' && Number.isFinite(v));
    if (!ok || (t as number) < 0 || (t as number) > size.durationSec || (x as number) < 0 || (x as number) > size.width
      || (y as number) < 0 || (y as number) > size.height) {
      throw new Error(`${file}: click ${i + 1} (${JSON.stringify(c)}) is not {"t", "x", "y"} within the clip's ${size.durationSec.toFixed(2)} s `
        + `and ${size.width}x${size.height} pixels`);
    }
    return { t: t as number, x: x as number, y: y as number };
  });
}

/** The cursor's box at the last sample at or before `sec`, in display pixels. */
function cursorAt(activity: Activity, secs: number[], sec: number): Box | null {
  let k = -1;
  while (k + 1 < secs.length && secs[k + 1] <= sec + 1e-6) k++;
  return k >= 0 ? activity.cursor[k] : null;
}

const round = (v: number, places = 2) => Math.round(v * 10 ** places) / 10 ** places;

export async function zoom(argv: string[]): Promise<number> {
  const { values, positionals } = parseUsage('zoom', usage, argv);
  const [videoArg] = positionals;
  if (!videoArg || positionals.length > 1) {
    console.error(usageLine('zoom', usage));
    return 2;
  }
  const video = resolveVideoArg(videoArg);
  if (!existsSync(video)) throw new Error(`video not found: ${video}`);
  const every = numberFlag('every', values.every, 0.1, (n) => n > 0 && n <= 1, 'seconds between 0 and 1');
  const shapes = (values.aspect ?? '16:9,9:16').split(',').map((a) => a.trim()).filter(Boolean).map((a) => ({ name: a, ratio: parseAspect(a) }));
  const shown = probeSquareSize(video);
  const durationSec = probeVideoSpan(video).end;
  const given = values.clicks === undefined ? null
    : parseClicks(readFileSync(resolve(values.clicks), 'utf8'), values.clicks, { ...shown, durationSec });

  const size = workSize(shown.width, shown.height);
  const changes = await readChanges(video, shown, size, every);
  const activity = readActivity(changes, size, shown);
  const secs = changes.map((c) => c.sec);
  const points = given ?? activity.clicks.map((c) => ({ t: c.before, x: c.x, y: c.y }));
  const clicks: ZoomClick[] = points.map((p) => {
    const line = textNear(greyFrameAt(video, shown, p.t), shown.width, shown.height, Math.round(p.x), Math.round(p.y), cursorAt(activity, secs, p.t));
    return { t: round(p.t), x: Math.round(p.x), y: Math.round(p.y), em: line ? round(line.em, 1) : null };
  });
  const clip: ZoomClip = {
    video, name: basename(video), width: shown.width, height: shown.height, durationSec, floor: SIZE_FLOOR, clicks,
    wide: activity.wide.map((w) => ({ from: round(w.from), to: round(w.to), ...w.box })),
    local: activity.local.map(([t, ...box]) => [round(t), ...box] as [number, number, number, number, number]),
  };

  const dir = values.out === undefined ? clipFolder(video, 'zoom') : resolve(values.out);
  writeAtomic(join(dir, 'zoom.json'), { ...clip, still: activity.still.map((s) => ({ from: round(s.from), to: round(s.to) })) });
  writeTextAtomic(join(dir, 'zoom.js'), zoomScript(clip));
  if (values.json) {
    console.log(readFileSync(join(dir, 'zoom.json'), 'utf8'));
    return 0;
  }

  const api = zoomApi();
  const plans = shapes.map((s) => {
    const canvas = canvasFor(s.ratio);
    const box = { w: canvas.width, h: canvas.height };
    return { ...s, canvas, plan: api.plan(clip, box, box) };
  });
  const found = given ? `${clicks.length} click(s) from ${values.clicks}`
    : `${clicks.length} click(s) found${activity.drawn ? `, the cursor seen moving ${activity.sightings} times` : ', no cursor drawn, so at the first change after a quiet spell'}`;
  console.log(`zoom: ${basename(video)}, ${shown.width}x${shown.height}, ${durationSec.toFixed(2)} s: ${found}; the screen changes wholesale ${clip.wide.length} time(s)`);
  const still = activity.still.filter((s) => s.to - s.from >= 2);
  if (still.length) console.log(`  nothing changes for 2 s or more: ${still.map((s) => `${s.from.toFixed(1)}-${s.to.toFixed(1)}`).join(', ')} s`);
  for (const p of plans) console.log(`  ${p.name} at ${p.canvas.width}x${p.canvas.height}: text reaches ${p.plan.floor} px, the canvas's minimum, at every click held on`);
  clicks.forEach((c, i) => {
    const text = c.em === null ? 'no text found near' : `text ${c.em} px`;
    const per = plans.map((p) => {
      const at = p.plan.clicks[i];
      const shownPx = at.shown === null ? '' : ` → ${Math.round(at.shown)} px${at.shown < p.plan.floor - 0.5 ? ' (moving to the next click)' : ''}`;
      return `${p.name} ${Math.round(at.rect.w)}x${Math.round(at.rect.h)}${shownPx}`;
    });
    console.log(`  ${c.t.toFixed(2)} s at ${c.x},${c.y}: ${text}; ${per.join(', ')}`);
  });
  console.log(`  wrote ${join(dir, 'zoom.json')} and ${join(dir, 'zoom.js')}: load zoom.js with a <script> tag and call `
    + 'openeditZoom.apply(<the clip\'s video>, <seconds of the clip>) in __seek');
  return 0;
}
