// zoom.js: a screen recording's clicks, the size of the text at each, its wholesale changes, and the code that moves a
// camera over it so that text reaches the canvas's minimum size at every click. The page loads it with a <script> tag; the
// command's summary and the tests evaluate the same source in Node, so what they report is what the page shows.
//
// Kept as plain JavaScript source, not a function to be stringified: a transpiler may wrap named functions in helpers
// that do not exist inside the page.
import { runInNewContext } from 'node:vm';

export interface ZoomClick {
  /** Seconds of the clip, and the point in its display pixels. */
  t: number;
  x: number;
  y: number;
  /** The font size of the text nearest the point, in display pixels; null where none was found. */
  em: number | null;
}

export interface ZoomClip {
  video: string;
  name: string;
  width: number;
  height: number;
  durationSec: number;
  /** The smallest text size as a share of the canvas's shorter side. */
  floor: number;
  clicks: ZoomClick[];
  /** Stretches in which the screen changed wholesale, and the box it changed in. */
  wide: { from: number; to: number; x: number; y: number; w: number; h: number }[];
  /** Changes that are neither the cursor nor wholesale: [sec, x, y, w, h]. */
  local: [number, number, number, number, number][];
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }
export interface Key extends Rect { t: number }
export interface Planned extends ZoomClick {
  /** Box pixels per pixel of the clip while the camera holds on the click. */
  scale: number;
  rect: Rect;
  /** The text's size on the canvas there, in its pixels; null where no text was found. */
  shown: number | null;
}
export interface Plan { keys: Key[]; clicks: Planned[]; floor: number; fit: number }

export interface ZoomApi {
  add(clip: ZoomClip): void;
  plan(clip: ZoomClip, box: Size, canvas?: Size): Plan;
  rectAt(plan: Plan, t: number, clip: ZoomClip, box: Size): Rect;
}

export const PAGE_SOURCE = String.raw`
(function () {
  if (window.openeditZoom) return;
  // In place this long before a click, so the click is seen; a move takes MOVE, or as little as MIN_MOVE when the
  // next hold comes sooner; a hold lasts LINGER past its last click and the last change in its frame.
  var LEAD = 0.5, MOVE = 0.8, MIN_MOVE = 0.35, LINGER = 1.5;
  // A hold squeezed shorter than this by the next is passed over: the camera cannot settle there.
  var MIN_HOLD = 0.6;
  // Clicks this close in time share a hold when one frame keeps them all MARGIN of it from its edges.
  var GROUP_GAP = 4, MARGIN = 0.1;
  // Between two holds this far apart, after both moves, the camera pulls back to the whole picture.
  var MIN_OUT = 1;
  var clips = {};
  var plans = {};

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function rectAround(clip, box, cx, cy, s) {
    var w = Math.min(clip.width, box.w / s), h = Math.min(clip.height, box.h / s);
    return { x: clamp(cx - w / 2, 0, clip.width - w), y: clamp(cy - h / 2, 0, clip.height - h), w: w, h: h };
  }
  function bounds(points) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    points.forEach(function (p) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + (p.w || 0)); y1 = Math.max(y1, p.y + (p.h || 0)); });
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function meets(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }
  function ease(u) { return u <= 0 ? 0 : u >= 1 ? 1 : u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; }

  function plan(clip, box, canvas) {
    canvas = canvas || box;
    var fit = Math.max(box.w / clip.width, box.h / clip.height);
    var floor = Math.ceil(Math.min(canvas.w, canvas.h) * clip.floor);
    var known = clip.clicks.map(function (c) { return c.em; }).filter(function (e) { return e; }).sort(function (a, b) { return a - b; });
    // Where no text was found near a click, the smallest found at another stands in for it.
    var fallback = known.length ? known[0] : null;
    function scaleFor(em) { return em ? Math.max(fit, floor / em) : fit; }
    var clicks = clip.clicks.slice().sort(function (a, b) { return a.t - b.t; });

    var groups = [];
    clicks.forEach(function (c) {
      var s = scaleFor(c.em || fallback);
      var g = groups[groups.length - 1];
      if (g && c.t - g.last <= GROUP_GAP) {
        var both = Math.max(g.s, s), all = bounds(g.points.concat([c]));
        if (all.w <= (box.w / both) * (1 - 2 * MARGIN) && all.h <= (box.h / both) * (1 - 2 * MARGIN)) {
          g.points.push(c); g.s = both; g.last = c.t;
          return;
        }
      }
      groups.push({ first: c.t, last: c.t, s: s, points: [c] });
    });

    var holds = groups.map(function (g) {
      var b = bounds(g.points);
      var r = rectAround(clip, box, b.x + b.w / 2, b.y + b.h / 2, g.s);
      var end = g.last + LINGER;
      clip.local.forEach(function (l) {
        if (l[0] > g.last && l[0] <= end && meets(r, { x: l[1], y: l[2], w: l[3], h: l[4] })) end = l[0] + LINGER;
      });
      clip.wide.forEach(function (w) { if (w.from > g.last && w.from < end) end = w.from; });
      return { from: Math.max(0, g.first - LEAD), to: end, r: r, group: g };
    });
    // A wholesale change after a hold pulls back to the whole picture until the next hold; one inside a hold is that
    // hold's business (a click that scrolls the page between two clicks of one group).
    clip.wide.forEach(function (w) {
      var inside = holds.some(function (h) { return h.group && w.from >= h.from && w.from < h.to; });
      if (!inside) holds.push({ from: w.from, to: w.to + LINGER, r: rectAround(clip, box, w.x + w.w / 2, w.y + w.h / 2, fit) });
    });
    holds.sort(function (a, b) { return a.from - b.from; });

    // Each hold ends where the next must start moving. A wholesale change right after a click waits for the click's hold
    // to last MIN_HOLD and LEAD past the click; any other hold squeezed below MIN_HOLD is passed over, since the camera
    // cannot settle there.
    var kept = [];
    holds.forEach(function (h) {
      var last = kept[kept.length - 1];
      if (last && !last.group && !h.group && h.from <= last.to) { last.to = Math.max(last.to, h.to); return; }
      if (last && last.to > h.from - MIN_MOVE) {
        if (last.group && !h.group) {
          last.to = Math.max(last.from + MIN_HOLD, last.group.last + LEAD, h.from - MIN_MOVE);
          h.from = last.to + MIN_MOVE;
          if (h.to < h.from) return;
        } else {
          last.to = h.from - MIN_MOVE;
          if (last.to - last.from < MIN_HOLD) kept.pop();
        }
      }
      kept.push(h);
    });

    var keys = [];
    function key(t, r) { keys.push({ t: t, x: r.x, y: r.y, w: r.w, h: r.h }); }
    var whole = rectAround(clip, box, clip.width / 2, clip.height / 2, fit);
    key(0, whole);
    var at = 0, prev = whole;
    kept.forEach(function (h, i) {
      var gap = h.from - at;
      if (i > 0 && kept[i - 1].group && gap >= 2 * MOVE + MIN_OUT) {
        var mid = rectAround(clip, box, (prev.x + prev.w / 2 + h.r.x + h.r.w / 2) / 2, (prev.y + prev.h / 2 + h.r.y + h.r.h / 2) / 2, fit);
        key(at + MOVE, mid); key(h.from - MOVE, mid);
        at = h.from - MOVE; gap = MOVE; prev = mid;
      }
      var start = gap >= MOVE ? h.from - MOVE : at;
      if (start > keys[keys.length - 1].t) key(start, prev);
      key(Math.max(h.from, start + Math.min(MOVE, Math.max(gap, MIN_MOVE))), h.r);
      if (h.to > keys[keys.length - 1].t) key(h.to, h.r);
      at = keys[keys.length - 1].t; prev = h.r;
    });
    var end = kept[kept.length - 1];
    if (end && end.group && clip.durationSec - at >= MOVE + MIN_OUT) {
      key(at + MOVE, rectAround(clip, box, end.r.x + end.r.w / 2, end.r.y + end.r.h / 2, fit));
    }

    var planned = clicks.map(function (c) {
      var r = rectAt({ keys: keys }, c.t, clip, box), s = box.w / r.w;
      return { t: c.t, x: c.x, y: c.y, em: c.em, scale: s, rect: r, shown: c.em ? c.em * s : null };
    });
    return { keys: keys, clicks: planned, floor: floor, fit: fit };
  }

  // The camera's rect at t: held between equal keys, eased between unequal ones, its size changing evenly in scale.
  function rectAt(p, t, clip, box) {
    var keys = p.keys;
    if (t <= keys[0].t) return keys[0];
    for (var i = 0; i + 1 < keys.length; i++) {
      var a = keys[i], b = keys[i + 1];
      if (t > b.t) continue;
      var u = ease((t - a.t) / Math.max(1e-6, b.t - a.t));
      var s = Math.exp(Math.log(box.w / a.w) + (Math.log(box.w / b.w) - Math.log(box.w / a.w)) * u);
      var cx = a.x + a.w / 2 + (b.x + b.w / 2 - a.x - a.w / 2) * u, cy = a.y + a.h / 2 + (b.y + b.h / 2 - a.y - a.h / 2) * u;
      return rectAround(clip, box, cx, cy, s);
    }
    return keys[keys.length - 1];
  }

  function pick(name) {
    var keys = Object.keys(clips);
    if (name) {
      var hits = keys.filter(function (k) { return k === name || clips[k].name === name || k.slice(-name.length - 1) === '/' + name; });
      if (hits.length === 1) return clips[hits[0]];
      throw new Error('openeditZoom: no zoom data for "' + name + '" (loaded: ' + (keys.join(', ') || 'none') + ')');
    }
    if (keys.length === 1) return clips[keys[0]];
    throw new Error('openeditZoom: ' + keys.length + ' clips are loaded; name one with {clip: "<file name>"}');
  }
  function sizeOf(el) { return { w: el.clientWidth, h: el.clientHeight }; }
  function stageSize(fallback) {
    var stage = document.querySelector('#stage, [data-stage]');
    return stage ? { w: stage.offsetWidth, h: stage.offsetHeight } : fallback;
  }
  function planFor(clip, box, canvas) {
    var k = clip.video + '|' + box.w + 'x' + box.h + '|' + canvas.w + 'x' + canvas.h;
    if (!plans[k]) plans[k] = plan(clip, box, canvas);
    return plans[k];
  }
  var framed = typeof WeakSet === 'function' ? new WeakSet() : null;
  // The camera's view of the clip at t seconds of it, for the element showing the clip at its own pixel size inside a
  // parent that frames it: the parent's box is what the camera fills.
  function view(el, t, opts) {
    var clip = pick(opts && opts.clip), parent = el.parentElement;
    if (!parent) throw new Error('openeditZoom: the element needs a parent to frame it');
    var box = sizeOf(parent), p = planFor(clip, box, stageSize(box));
    var r = rectAt(p, t, clip, box);
    return { clip: clip, parent: parent, rect: r, scale: box.w / r.w };
  }
  function apply(el, t, opts) {
    var v = view(el, t, opts);
    if (!framed || !framed.has(v.parent)) {
      if (getComputedStyle(v.parent).position === 'static') v.parent.style.position = 'relative';
      v.parent.style.overflow = 'hidden';
      if (framed) framed.add(v.parent);
    }
    var s = el.style;
    s.position = 'absolute'; s.left = '0px'; s.top = '0px'; s.maxWidth = 'none'; s.maxHeight = 'none';
    s.width = v.clip.width + 'px'; s.height = v.clip.height + 'px';
    s.transformOrigin = '0 0';
    s.transform = 'translate(' + (-v.rect.x * v.scale) + 'px, ' + (-v.rect.y * v.scale) + 'px) scale(' + v.scale + ')';
    return { x: v.rect.x, y: v.rect.y, w: v.rect.w, h: v.rect.h, scale: v.scale };
  }
  function at(el, t, opts) {
    var v = view(el, t, opts);
    return { x: v.rect.x, y: v.rect.y, w: v.rect.w, h: v.rect.h, scale: v.scale };
  }
  function point(el, x, y, t, opts) {
    var v = view(el, t, opts);
    return { x: (x - v.rect.x) * v.scale, y: (y - v.rect.y) * v.scale };
  }
  function add(clip) { clips[clip.video] = clip; }
  function clicks(opts) { return pick(opts && opts.clip).clicks.slice(); }

  window.openeditZoom = { clips: clips, add: add, apply: apply, at: at, point: point, clicks: clicks, plan: plan, rectAt: rectAt };
})();
`;

/** The zoom.js the command writes for one clip. */
export function zoomScript(clip: ZoomClip): string {
  return `${PAGE_SOURCE}\nwindow.openeditZoom.add(${JSON.stringify(clip)});\n`;
}

/** The planner, as the page runs it, outside a page. */
export function zoomApi(): ZoomApi {
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  runInNewContext(PAGE_SOURCE, sandbox);
  return sandbox.window.openeditZoom as ZoomApi;
}
