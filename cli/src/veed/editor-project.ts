// A finished edit as a VEED editor project, and a project read back as a plan. Footage cuts, text, images and audio
// become the editor's own items, and a page's graphics become transparent clips cut to their boxes, so a person can
// take the edit apart in VEED and the agent can pick it up again from what they left.
import type { MixSpec } from '../commands/mix-audio.ts';
import type { SnappedRange } from '../edl.ts';
import type { TranscriptChunk, TranscriptWord } from '../transcript/transcript-types.ts';

export interface Box {
  /** Top-left corner and size, in canvas pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Timed {
  /** When it starts on the project's timeline, in seconds. */
  at: number;
  /** Stacking order; higher draws on top. */
  z?: number;
  name?: string;
  /**
   * Read back from VEED: what the file was made from when it was sent there. It changes nothing in the project; for a
   * file copied from the source project, veed-project carries it into the new project's record for the next pull.
   */
  origin?: Origin;
}

/**
 * What a file sent to VEED was made from: a local file, or a clip of a page layer (the element, the page, and the
 * stretch of page time the clip shows). A layer's clip is only its picture; to change what the element draws,
 * render the element again from the page.
 */
export type Origin = { file: string } | {
  layer: string; page: string; plan: string; at: number; to: number; box: Box;
  /** Read back: this part as a `layer` part, rendered again from the page where and when the person left it. */
  asLayer?: LayerPart;
};

export interface VideoPart extends Timed {
  type: 'video';
  file: string;
  /** The span of the file it plays, in the file's own seconds (default: all of it). */
  in?: number;
  out?: number;
  volume?: number;
  /** Where it sits; the whole canvas when absent. */
  box?: Box;
}

export interface LayerPart extends Omit<Timed, 'at'> {
  type: 'layer';
  /** CSS selector of the page elements that are this layer, drawn together. */
  select: string;
  /** The page it lives in (default: the plan's page). Page time is project time, unless `shift` moves it. */
  page?: string;
  /** PAGE time to look in (default: the whole plan); each stretch the element is visible becomes its own clip. */
  at?: number;
  to?: number;
  /** Seconds added to the element's page time to place it on the project timeline (default 0). */
  shift?: number;
  /** Where a person moved or resized the element: each clip is mapped as the box `from` was mapped to `to`. */
  moved?: { from: Box; to: Box };
}

/** A clip's box after the element was moved or resized as `moved` says. */
export function movedBox(b: Box, moved: { from: Box; to: Box } | undefined): Box {
  if (!moved) return b;
  const sx = moved.to.w / moved.from.w, sy = moved.to.h / moved.from.h;
  return { x: moved.to.x + (b.x - moved.from.x) * sx, y: moved.to.y + (b.y - moved.from.y) * sy, w: b.w * sx, h: b.h * sy };
}

export interface ImagePart extends Timed {
  type: 'image';
  file: string;
  to: number;
  box: Box;
}

export interface TextPart extends Timed {
  type: 'text';
  text: string;
  to: number;
  /** Centre of the text, in canvas pixels. */
  x: number;
  y: number;
  /** Font size in canvas pixels. */
  size: number;
  font?: string;
  color?: string;
  align?: 'left' | 'center' | 'right';
  bold?: boolean;
  italic?: boolean;
  /** One of the editor's own text animations (fade, pop, rise, typewriter, slideUp, ...). */
  animation?: string;
}

export interface AudioPart extends Timed {
  type: 'audio';
  file: string;
  in?: number;
  out?: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
}

/** An edit decision list: each kept range becomes a clip of its source, laid end to end, so the cuts stay editable. */
export interface EdlPart {
  type: 'edl';
  file: string;
  /** Where the first range starts on the project timeline (default 0). */
  at?: number;
  z?: number;
  volume?: number;
}

/** A mix-audio spec: every track of it (voice, music, each effect) becomes its own audio item. */
export interface MixPart {
  type: 'mix';
  file: string;
}

export interface CaptionsPart {
  type: 'captions';
  /** A transcript.json whose times are already on the project's timeline. */
  transcript: string;
  z?: number;
  x?: number;
  y?: number;
  size?: number;
  font?: string;
  color?: string;
  bold?: boolean;
  animation?: string;
  /** Most words on screen at once (default 5): a cue with word times is split, and a pause of half a second breaks it early. */
  words?: number;
}

export type Part = VideoPart | LayerPart | ImagePart | TextPart | AudioPart | MixPart | EdlPart | CaptionsPart;

export interface Plan {
  name: string;
  width: number;
  height: number;
  fps?: number;
  /** Length in seconds; needed when a layer does not say where it ends. */
  duration?: number;
  /** The composition page the layers are rendered from. */
  page?: string;
  /**
   * The VEED project the plan was read from, and the asset each of its files already is there: those are
   * copied inside VEED rather than uploaded again, which for a long screen recording is most of the wait.
   */
  source?: { project: string; assets: Record<string, SourceAsset> };
  parts: Part[];
}

/**
 * A file downloaded from a VEED project, as it was when downloaded: one changed on disk since (another size or
 * modification time) is uploaded as the change rather than copied. `path` is the asset's storage path, which copies
 * of it keep, so what it was made from can be found again after a round trip.
 */
export interface SourceAsset { asset: string; path?: string; bytes: number; mtimeMs: number }

export type VeedItem = Record<string, unknown> & { assetId?: string };

const ANIMATIONS = new Set(['none', 'fade', 'slideRight', 'slideLeft', 'slideUp', 'slideDown', 'block', 'zoomIn', 'typewriter', 'rise', 'pop', 'drop', 'compress', 'bounce', 'wave', 'fall']);

export class PlanError extends Error {}

// What VEED's ids look like; anything else read from a file or the clipboard is refused before it names a path.
const ID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
export const isVeedId = (s: unknown): s is string => typeof s === 'string' && new RegExp(ID_PATTERN, 'i').test(s);

/** Text from a project or a plan, safe to print: control characters (escape sequences among them) become spaces. */
export const printable = (s: unknown): string => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

/** What veed-project records about a project it made: what each file was made from, by asset id and by storage path. */
export interface HandoffRecord {
  plan: string;
  assets: Record<string, Origin>;
  /** Files copied in from another project, known by the storage path the copy keeps under its new id. */
  paths: Record<string, Origin>;
}

/** `url` when it is an https address on VEED's own domain (the site or one of its hosts), else null. */
export function veedMediaUrl(url: unknown, origin: string): URL | null {
  if (typeof url !== 'string') return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const domain = new URL(origin).hostname.replace(/^www\./, '');
  return u.protocol === 'https:' && (u.hostname === domain || u.hostname.endsWith(`.${domain}`)) ? u : null;
}

const need = (ok: unknown, msg: string): void => {
  if (!ok) throw new PlanError(msg);
};

const PART_TYPES = new Set(['video', 'layer', 'image', 'text', 'audio', 'edl', 'mix', 'captions']);
const isBox = (b: unknown): b is Box => !!b && typeof b === 'object' && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite((b as Record<string, unknown>)[k])) && (b as Box).w > 0 && (b as Box).h > 0;
const optional = (v: unknown, ok: (n: number) => boolean) => v === undefined || (typeof v === 'number' && ok(v));

/** Checks the fields every part needs, so a bad plan fails before anything renders or uploads. */
export function checkPlan(plan: Plan): void {
  need(typeof plan.name === 'string' && plan.name, 'the plan needs a name');
  need([plan.width, plan.height].every((n) => Number.isInteger(n) && n > 0), 'the plan needs width and height, the canvas in whole pixels');
  need(!plan.source || (isVeedId(plan.source.project) && Object.values(plan.source.assets ?? {}).every((a) => isVeedId(a?.asset))),
    'the plan\'s "source" names a project or file that is not a VEED id');
  need(optional(plan.fps, (n) => Number.isFinite(n) && n > 0), 'the plan\'s fps must be a positive number');
  need(optional(plan.duration, (n) => Number.isFinite(n) && n > 0), 'the plan\'s duration must be a positive number of seconds');
  need(Array.isArray(plan.parts) && plan.parts.length, 'the plan has no parts');
  plan.parts.forEach((p, i) => {
    need(p && typeof p === 'object', `part ${i + 1} is not an object`);
    const at = `part ${i + 1} (${p.type})`;
    need(PART_TYPES.has(p.type), `${at}: the type must be one of ${[...PART_TYPES].join(', ')}`);
    const time = (v: unknown) => optional(v, (n) => Number.isFinite(n) && n >= 0);
    if (p.type !== 'captions' && p.type !== 'layer' && p.type !== 'mix' && p.type !== 'edl') need(Number.isFinite(p.at) && p.at >= 0, `${at}: "at" must be a time in seconds`);
    if (p.type === 'video' || p.type === 'audio') {
      need(time(p.in) && time(p.out) && (p.out === undefined || p.out > (p.in ?? 0)), `${at}: "in" and "out" are seconds of the file, "out" after "in"`);
      need(optional(p.volume, (n) => n >= 0), `${at}: "volume" must be 0 or more`);
    }
    if (p.type === 'video') need(p.box === undefined || isBox(p.box), `${at}: "box" is {x, y, w, h} in canvas pixels`);
    if (p.type === 'image') need(isBox(p.box), `${at}: needs "box", {x, y, w, h} in canvas pixels`);
    if (p.type === 'audio') need(time(p.fadeIn) && time(p.fadeOut), `${at}: "fadeIn" and "fadeOut" are seconds`);
    if (p.type === 'layer') {
      need(p.select && (p.page ?? plan.page), `${at}: needs "select" and a page`);
      need(time(p.at) && time(p.to) && (p.to ?? plan.duration ?? 0) > (p.at ?? 0), `${at}: give "to", or the plan's duration`);
      need(p.shift === undefined || Number.isFinite(p.shift), `${at}: "shift" must be a number of seconds`);
      need(!p.moved || (isBox(p.moved.from) && isBox(p.moved.to)), `${at}: "moved" needs two boxes, "from" and "to"`);
    }
    if (p.type === 'edl') need(time(p.at), `${at}: "at" must be a time in seconds`);
    if (p.type === 'image' || p.type === 'text') need(Number.isFinite(p.to) && p.to > p.at, `${at}: "to" must come after "at"`);
    if (p.type === 'text') need(p.text && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.size) && p.size > 0, `${at}: needs text, x, y and size`);
    if ('animation' in p && p.animation) need(ANIMATIONS.has(p.animation), `${at}: animation must be one of ${[...ANIMATIONS].join(', ')}`);
    if ('file' in p) need(typeof p.file === 'string' && p.file, `${at}: needs "file"`);
    if (p.type === 'captions') need(p.transcript && optional(p.words, (n) => Number.isInteger(n) && n > 0), `${at}: needs "transcript"; "words" is a whole number`);
  });
}

/**
 * The stretches a layer is visible in, from its per-frame alpha peaks, in the frames' own unit (seconds, or frame
 * indices with `step` 1): a gap of up to `bridge` is kept inside one clip, so an element that blinks does not split
 * into slivers. Any alpha counts, so the faint tail of a shadow or a fade is never cut at a straight edge.
 */
export function visibleSpans(frames: { t: number; peak: number }[], step: number, bridge: number): { at: number; to: number }[] {
  const spans: { at: number; to: number }[] = [];
  for (const f of frames) {
    if (f.peak <= 0) continue;
    const last = spans.at(-1);
    if (last && f.t - last.to <= bridge) last.to = f.t + step;
    else spans.push({ at: f.t, to: f.t + step });
  }
  return spans;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/**
 * The size to give a clip so the editor's preview copy has clean edges: the editor previews a clip longer than 1024
 * on a side from a copy scaled to 1024, and a short side that lands on a fraction of a pixel comes out as an opaque
 * line along the clip. So the clip is padded to a long side of 1280, 1536, 1920, 2048 or a multiple of 1024, and a
 * short side that scales to whole, even pixels.
 */
export function previewSafeSize(w: number, h: number): { w: number; h: number } {
  const long = Math.max(w, h), short = Math.min(w, h);
  if (long <= 1024) return { w, h };
  const target = [1280, 1536, 1920, 2048].find((t) => t >= long) ?? Math.ceil(long / 1024) * 1024;
  const g = gcd(1024, target), p = 1024 / g, q = target / g;
  const step = p % 2 ? 2 * q : q % 2 ? 2 * q : q;
  const side = Math.ceil(short / step) * step;
  return w >= h ? { w: target, h: side } : { w: side, h: target };
}

/** The editor's placement: centre and size as fractions of the canvas. */
export function place(box: Box | undefined, width: number, height: number) {
  const b = box ?? { x: 0, y: 0, w: width, h: height };
  return { translationX: (b.x + b.w / 2) / width, translationY: (b.y + b.h / 2) / height, width: b.w / width, height: b.h / height };
}

// Every item carries the editor's neutral filters: stored without them, an item's opacity reads as unset and
// the editor draws it nearly transparent.
const NEUTRAL_FILTERS = { blur: 0, brightness: 0, contrast: 0, exposure: 0, noise: 0, saturation: 0, sharpen: 0, vignette: 0, opacity: 100, hue: 0 };

const base = (p: Timed, fallbackName: string) => ({
  rotation: 0, name: p.name ?? fallbackName, zIndex: p.z ?? 0, flipX: false, flipY: false, animation: 'none', filters: { ...NEUTRAL_FILTERS },
});

export function videoItem(o: { assetId: string; at: number; in: number; out: number; volume: number; box?: Box; z?: number; name?: string }, width: number, height: number): VeedItem {
  return {
    ...base(o, 'video'), ...place(o.box, width, height), from: o.at, to: null, assetId: o.assetId, category: 'video',
    metadata: { loopingEnabled: false, playbackRate: 1, trimStart: o.in, trimEnd: o.out, volume: o.volume, fadeInDuration: 0, fadeOutDuration: 0, cornerRadius: [0, 0, 0, 0], crop: [0, 0, 0, 0] },
  };
}

export function imageItem(p: ImagePart, assetId: string, width: number, height: number): VeedItem {
  return { ...base(p, 'image'), ...place(p.box, width, height), from: p.at, to: p.to, assetId, category: 'image', metadata: { cornerRadius: [0, 0, 0, 0], crop: [0, 0, 0, 0] } };
}

export function audioItem(p: AudioPart, assetId: string, out: number): VeedItem {
  return {
    ...base(p, 'audio'), translationX: 0.5, translationY: 0.5, width: 1, height: 1, from: p.at, to: null, assetId, category: 'audioStream',
    metadata: {
      isRecording: false, isVoiceOver: false, loopingEnabled: false, playbackRate: 1, trimStart: p.in ?? 0, trimEnd: out, volume: p.volume ?? 1,
      fadeInDuration: p.fadeIn ?? 0, fadeOutDuration: p.fadeOut ?? 0,
    },
  };
}

/** Text the editor owns: retype it, restyle it, move it. Its size is stored as a share of the canvas width. */
export function textItem(p: TextPart, width: number, height: number): VeedItem {
  const styles = [...(p.bold ? ['bold'] : []), ...(p.italic ? ['italic'] : [])];
  return {
    ...base(p, 'text'), translationX: p.x / width, translationY: p.y / height, width: null, height: null, from: p.at, to: p.to, category: 'text',
    metadata: {
      value: p.text, font: p.font ?? 'Inter', size: p.size / width, color: p.color ?? '#ffffff', align: p.align ?? 'center', styles,
      textWrap: 'noWrap', wrapWidth: 0, lineHeight: 1.2, letterSpacing: 0, animatable: true, animation: p.animation ?? 'none',
    },
  };
}

/** A timeline item as the editor stores it, read back by the "Send to Claude" bookmark. */
export interface PulledItem {
  category: string;
  name?: string;
  assetId?: string | null;
  from: number;
  to?: number | null;
  visibleUntil?: number;
  zIndex?: number;
  translationX: number;
  translationY: number;
  width: number | null;
  height: number | null;
  metadata?: Record<string, unknown>;
}

// What the editor stores for an item nobody changed; anything else is named in `left`, since the plan cannot carry it.
const NEUTRAL: Record<string, unknown> = { rotation: 0, flipX: false, flipY: false };

/**
 * A project read back from the editor as a plan, so the way back is the way in: edit the plan, send it with
 * veed-project. `file` names each asset's downloaded file. Whatever the plan cannot carry is listed in `left`: an
 * item whose file is missing or whose kind has no part, and what a person set that no part has a field for.
 */
export function planFromPulled(
  project: { name?: string; id: string; aspect?: [number, number]; fps?: number },
  timeline: PulledItem[],
  file: (assetId: string) => string | undefined,
  origin: (assetId: string) => Origin | undefined = () => undefined,
): { plan: Plan; left: string[] } {
  // A ratio rather than a size (16:9) is scaled up, since the plan works in canvas pixels.
  const [aw, ah] = project.aspect ?? [1920, 1080];
  const k = Math.max(aw, ah) < 200 ? 1920 / Math.max(aw, ah) : 1;
  const W = Math.round(aw * k), H = Math.round(ah * k);
  const box = (i: PulledItem): Box | undefined => {
    const w = (i.width ?? 1) * W, h = (i.height ?? 1) * H;
    const b = { x: i.translationX * W - w / 2, y: i.translationY * H - h / 2, w, h };
    const r = (n: number) => Math.round(n * 100) / 100;
    return Math.abs(b.x) < 0.5 && Math.abs(b.y) < 0.5 && Math.abs(w - W) < 0.5 && Math.abs(h - H) < 0.5 ? undefined : { x: r(b.x), y: r(b.y), w: r(w), h: r(h) };
  };
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const parts: Part[] = [];
  const left: string[] = [];
  for (const i of [...timeline].sort((a, b) => a.from - b.from || (a.zIndex ?? 0) - (b.zIndex ?? 0))) {
    const m = i.metadata ?? {};
    const label = `${i.category} "${i.name ?? ''}" at ${i.from.toFixed(2)} s`;
    const until = i.to ?? i.visibleUntil;
    const trimIn = num(m.trimStart, 0);
    // An item with no trim end plays from its trim start for as long as it is on the timeline.
    const trimOut = num(m.trimEnd, until === undefined || until === null ? NaN : trimIn + until - i.from);
    for (const [k, v] of Object.entries(NEUTRAL)) if (k in i && (i as unknown as Record<string, unknown>)[k] !== v) left.push(`${label}: ${k} ${JSON.stringify((i as unknown as Record<string, unknown>)[k])} is not carried`);
    const filters = (i as unknown as { filters?: Record<string, unknown> }).filters ?? {};
    const changed = Object.entries(filters).filter(([k, v]) => k in NEUTRAL_FILTERS && v !== NEUTRAL_FILTERS[k as keyof typeof NEUTRAL_FILTERS]);
    if (changed.length) left.push(`${label}: its ${changed.map(([k, v]) => `${k} ${v}`).join(', ')} is not carried`);
    for (const k of ['crop', 'cornerRadius'] as const) if (Array.isArray(m[k]) && (m[k] as number[]).some((n) => n)) left.push(`${label}: its ${k} is not carried`);
    if (i.category !== 'text' && i.category !== 'audioStream' && typeof (i as unknown as { animation?: unknown }).animation === 'string' && (i as unknown as { animation: string }).animation !== 'none') left.push(`${label}: its animation is not carried`);
    if (i.category === 'video' && (num(m.fadeInDuration, 0) || num(m.fadeOutDuration, 0))) left.push(`${label}: its fades are not carried`);
    if (m.loopingEnabled === true) left.push(`${label}: its looping is not carried; it plays once`);
    const effects = (i as unknown as { effects?: unknown }).effects;
    if (Array.isArray(effects) && effects.length) left.push(`${label}: its ${effects.length} effect(s) are not carried`);
    if (i.category === 'text' && typeof m.animation === 'string' && m.animation !== 'none' && !ANIMATIONS.has(m.animation)) left.push(`${label}: its animation ${m.animation} is not carried`);
    let made = i.assetId ? origin(i.assetId) : undefined;
    if (made && 'layer' in made && made.box && i.category === 'video' && Number.isFinite(trimOut)) {
      // The clip plays its own time trimStart..trimEnd at i.from, and that clip time is page time made.at onwards.
      const start = made.at + trimIn, end = made.at + trimOut;
      const placed = box(i) ?? { x: 0, y: 0, w: W, h: H }, sent = made.box;
      const asLayer: LayerPart = {
        type: 'layer', select: made.layer, page: made.page, at: start, to: end, z: i.zIndex ?? 0, ...(i.name ? { name: i.name } : {}),
        ...(Math.abs(i.from - start) > 1e-6 ? { shift: i.from - start } : {}),
        ...(['x', 'y', 'w', 'h'].some((k) => Math.abs(placed[k as keyof Box] - sent[k as keyof Box]) > 0.5) ? { moved: { from: sent, to: placed } } : {}),
      };
      made = { ...made, asLayer };
    }
    const common = { at: i.from, z: i.zIndex ?? 0, ...(i.name ? { name: i.name } : {}), ...(made ? { origin: made } : {}) };
    if ((i.category === 'text' || i.category === 'image') && (until === undefined || until === null || until <= i.from)) {
      left.push(`${label}: it has no end on the timeline`);
      continue;
    }
    if (i.category === 'text' && !String(m.value ?? '').trim()) {
      left.push(`${label}: it holds no text`);
      continue;
    }
    if (i.category === 'text') {
      const styles = Array.isArray(m.styles) ? m.styles : [];
      parts.push({
        type: 'text', ...common, to: until!, text: String(m.value), x: i.translationX * W, y: i.translationY * H, size: Math.round(num(m.size, 0.04) * W),
        ...(typeof m.font === 'string' ? { font: m.font } : {}), ...(typeof m.color === 'string' ? { color: m.color } : {}),
        ...(m.align === 'left' || m.align === 'right' || m.align === 'center' ? { align: m.align } : {}),
        ...(styles.includes('bold') ? { bold: true } : {}), ...(styles.includes('italic') ? { italic: true } : {}),
        ...(typeof m.animation === 'string' && m.animation !== 'none' && ANIMATIONS.has(m.animation) ? { animation: m.animation } : {}),
      });
      continue;
    }
    const f = i.assetId ? file(i.assetId) : undefined;
    if (!f) {
      left.push(`${label}: ${i.assetId ? 'its file did not download' : 'nothing the plan can carry'}`);
      continue;
    }
    if (num(m.playbackRate, 1) !== 1) left.push(`${label}: plays at ${m.playbackRate}x in VEED; the plan plays it at 1x`);
    const span = Number.isFinite(trimOut) ? { in: trimIn, out: trimOut } : { in: trimIn };
    if (i.category === 'video') {
      const b = box(i);
      parts.push({ type: 'video', ...common, file: f, ...span, volume: num(m.volume, 1), ...(b ? { box: b } : {}) });
    } else if (i.category === 'audioStream') {
      const fadeIn = num(m.fadeInDuration, 0), fadeOut = num(m.fadeOutDuration, 0);
      parts.push({ type: 'audio', ...common, file: f, ...span, volume: num(m.volume, 1), ...(fadeIn ? { fadeIn } : {}), ...(fadeOut ? { fadeOut } : {}) });
    } else if (i.category === 'image') {
      parts.push({ type: 'image', ...common, file: f, to: until!, box: box(i) ?? { x: 0, y: 0, w: W, h: H } });
    } else {
      left.push(`${label}: the plan has no ${i.category} part`);
    }
  }
  const end = Math.max(0, ...parts.map((p) => ('to' in p && typeof p.to === 'number' ? p.to : p.type === 'video' || p.type === 'audio' ? (p.at ?? 0) + (p.out ?? 0) - (p.in ?? 0) : 0)));
  return { plan: { name: project.name ?? project.id, width: W, height: H, fps: project.fps ?? 30, duration: Math.round(end * 1000) / 1000, parts }, left };
}

/**
 * The ranges of an EDL as video parts on one timeline; `source` resolves a range's source to its file. Give the ranges
 * snapped to their sources' frames, as apply-edl cuts them, so the cuts land where a retimed transcript expects them.
 */
export function edlParts(p: EdlPart, ranges: SnappedRange[], source: (id: string) => string): VideoPart[] {
  let at = p.at ?? 0;
  return ranges.map((r, i) => {
    const part: VideoPart = { type: 'video', file: source(r.source), at, in: r.start, out: r.end, z: p.z ?? 0, volume: p.volume ?? 1, name: r.note ?? `cut ${i + 1}` };
    at += r.end - r.start;
    return part;
  });
}

/**
 * The tracks of a mix-audio spec as audio parts, as mix-audio plays them: gain as the editor's linear volume, each
 * track cut at the film's end, and its fade-out where the film's falls. `length` gives a track file's own length.
 * Ducking has no editor counterpart, so a ducked track is named in `notes` and plays at its own gain.
 */
export function mixParts(spec: MixSpec, length: (path: string) => number): { parts: AudioPart[]; notes: string[] } {
  const notes: string[] = [];
  const parts = spec.tracks.flatMap((t): AudioPart[] => {
    const end = Math.min(t.atSec + length(t.path), spec.durationSec);
    if (end <= t.atSec) return [];
    if (t.duck) notes.push(`${t.path}: ducking under the voice is not carried; it plays at its own gain`);
    // mix-audio fades every track over the film's last fadeOutSec, which reaches a track only if it is still playing then.
    const fadeOut = t.fadeOutSec ? Math.min(t.fadeOutSec, end - Math.max(t.atSec, spec.durationSec - t.fadeOutSec)) : 0;
    return [{
      type: 'audio', file: t.path, at: t.atSec, in: 0, out: end - t.atSec, name: `${t.role ?? 'audio'}: ${t.path.split('/').pop()}`,
      volume: Math.round(10 ** ((t.gainDb ?? 0) / 20) * 1000) / 1000,
      ...(t.fadeInSec ? { fadeIn: t.fadeInSec } : {}), ...(end >= spec.durationSec && fadeOut > 0 ? { fadeOut } : {}),
    }];
  });
  return { parts, notes };
}

/** A transcript's chunks, their words optional: a chunk without word times is shown whole. */
type Cued = { chunks: (Omit<TranscriptChunk, 'words'> & { words?: TranscriptWord[] })[] };

/** The cues to show: each chunk, split by its word times into lines of at most `most` words. */
export function captionCues(transcript: Cued, most = 5): { text: string; timestamp: [number, number] }[] {
  const cues: { text: string; timestamp: [number, number] }[] = [];
  for (const c of transcript.chunks) {
    const words = (c.words ?? []).filter((w) => w.text.trim() && Number.isFinite(w.timestamp[0]) && w.timestamp[1] >= w.timestamp[0]);
    if (!words.length) {
      cues.push({ text: c.text, timestamp: c.timestamp });
      continue;
    }
    let line: TranscriptWord[] = [];
    const flush = () => {
      if (line.length) cues.push({ text: line.map((w) => w.text.trim()).join(' '), timestamp: [line[0].timestamp[0], line.at(-1)!.timestamp[1]] });
      line = [];
    };
    for (const w of words) {
      const last = line.at(-1);
      if (line.length >= most || (last && (w.timestamp[0] - last.timestamp[1] >= 0.5 || /[.!?]$/.test(last.text.trim())))) flush();
      line.push(w);
    }
    flush();
  }
  return cues;
}

/** One native text item per cue, so every caption can be corrected in the editor like any other text. */
export function captionItems(p: CaptionsPart, transcript: Cued, width: number, height: number): VeedItem[] {
  return captionCues(transcript, p.words ?? 5)
    .filter((c) => c.text.trim() && c.timestamp[1] > c.timestamp[0])
    .map((c, i) => textItem({
      type: 'text', name: `caption ${i + 1}`, text: c.text.trim(), at: c.timestamp[0], to: c.timestamp[1], z: p.z ?? 50,
      x: p.x ?? width / 2, y: p.y ?? height * 0.85, size: p.size ?? Math.round(width * 0.035), font: p.font, color: p.color, bold: p.bold ?? true, animation: p.animation,
    }, width, height));
}

/**
 * The bookmark checks it, so one installed before a change to the hand-off's shape, or to the bookmark's own code,
 * asks to be installed again.
 */
export const BUNDLE_VERSION = 4;

/** What the browser step needs: the project the CLI made and filled with media, and the timeline to lay in it. */
export interface Bundle {
  v: typeof BUNDLE_VERSION;
  project: string;
  items: VeedItem[];
  /** Assets of another project the items use, copied into this one first; the items name the originals. */
  copy?: { from: string; assets: string[] };
}

export const encodeBundle = (b: Bundle): string => Buffer.from(JSON.stringify(b), 'utf8').toString('base64url');

/**
 * The bookmarklet that lays the timeline in the project the CLI made, in the user's own VEED session, since the CLI's
 * login may create a project but not write its timeline. It reads the hand-off from the clipboard (or a paste), takes
 * only ids that look like ids and only a project with no timeline yet, and renews the session's short-lived token first.
 */
export const BOOKMARKLET = `(async()=>{try{if(location.origin!=='__ORIGIN__'){alert('OpenEdit: click this bookmark on __ORIGIN__');return}
const U=new RegExp('__ID__','i');await fetch('/api/v1/auth/token/refresh',{method:'POST',credentials:'include'}).catch(()=>{});
let t='';try{t=await navigator.clipboard.readText()}catch(e){}
if(!/openedit=/.test(t)){t=prompt('Paste the OpenEdit hand-off (Cmd+V), then OK');if(t===null)return}
const m=t.match(/openedit=([A-Za-z0-9_-]+)/);if(!m)throw new Error('that is not an OpenEdit hand-off; copy the contents of handoff.txt and click again');
const B=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(m[1].replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))));
if(B.v!==__VERSION__)throw new Error('this bookmark does not match the CLI; install it again from the page openedit veed-project --install-bookmark opens');
if(!U.test(B.project)||B.items.some(i=>i.assetId&&!U.test(i.assetId))||(B.copy&&!(U.test(B.copy.from)&&B.copy.assets.every(a=>U.test(a)))))throw new Error('the hand-off names something that is not a project or file id');
const api=async(method,p,body)=>{const r=await fetch('/api/v1'+p,{method,credentials:'include',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const x=await r.text();if(!r.ok)throw new Error(method+' '+p+' '+r.status+' '+x.slice(0,300));const j=x?JSON.parse(x):null;return j&&j.data!==undefined?j.data:j};
if(((await api('GET','/project/'+B.project+'/timeline/'))||[]).length)throw new Error('that project already has a timeline; a hand-off only fills the new project veed-project made');
let map={};if(B.copy&&B.copy.assets.length){map=((await api('POST','/asset/duplicate',{sourceProjectId:B.copy.from,newProjectId:B.project,assetIds:B.copy.assets}))||{}).assetMappings||{};
const lost=B.copy.assets.filter(a=>!map[a]);if(lost.length)throw new Error(lost.length+' of the files were not copied from the project they came from')}
await api('PUT','/project/'+B.project+'/',{privacy:'private',timelineItems:B.items.map(i=>({...i,id:crypto.randomUUID(),...(i.assetId&&map[i.assetId]?{assetId:map[i.assetId]}:{})}))});
location.href='/edit/'+B.project}catch(e){alert('OpenEdit to VEED failed: '+e.message)}})();`;

/**
 * The way back: on a project open in the VEED editor, save its timeline, captions and the records of the files it
 * plays (with their download links) as openedit-<project id>.json in Downloads, for veed-pull to fetch.
 */
export const PULL_BOOKMARKLET = `(async()=>{try{if(location.origin!=='__ORIGIN__'){alert('OpenEdit: click this bookmark on __ORIGIN__');return}const U=new RegExp('__ID__','i');
await fetch('/api/v1/auth/token/refresh',{method:'POST',credentials:'include'}).catch(()=>{});const id=(location.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)||[])[0];if(!id){alert('OpenEdit: open a project in the VEED editor first');return}
const get=async p=>{const r=await fetch('/api'+p,{credentials:'include'});if(!r.ok)throw new Error('GET '+p+' '+r.status);const j=await r.json();return j&&j.data!==undefined?j.data:j};
const project=await get('/v1/project/'+id+'/');const timeline=await get('/v1/project/'+id+'/timeline/?expand=effects&expand=animations');const subtitles=await get('/v1/subtitles/?projectId='+id);
const assets=[];for(const a of [...new Set(timeline.map(i=>i.assetId).filter(a=>a&&U.test(a)))]){try{assets.push(await get('/v1/asset/'+a))}catch(e){assets.push({id:a,error:e.message})}}
const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(new Blob([JSON.stringify({v:1,project,timeline,subtitles,assets},null,2)],{type:'application/json'})),download:'openedit-'+id+'.json'});
document.body.appendChild(a);a.click();a.remove()}catch(e){alert('Send to Claude failed: '+e.message)}})();`;

/** A bookmarklet as a link, bound to the VEED site it may run on. */
export function bookmarkletUrl(code: string, origin: string): string {
  const site = new URL(origin).origin;
  // Spliced into the code as a string literal, so only a plain scheme-host-port may be.
  if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(site)) throw new Error(`${origin} is not an address a bookmark can be made for`);
  const filled = code.replace(/\n/g, '').replaceAll('__ORIGIN__', site).replaceAll('__ID__', ID_PATTERN.replaceAll('\\', '\\\\')).replaceAll('__VERSION__', String(BUNDLE_VERSION));
  return `javascript:${encodeURIComponent(filled)}`;
}
