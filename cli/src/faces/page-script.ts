// faces.js: the face boxes of one clip, the graphics burned into it, and the code that keeps a page's text out of
// them. The page loads it with a <script> tag, so it works from file:// as well as under render, and one source
// serves the page, the faces command's summary and the tests, which evaluate it in Node.
//
// Kept as plain JavaScript source, not a function to be stringified: a transpiler may wrap named
// functions in helpers that do not exist inside the page.
import { runInNewContext } from 'node:vm';
import type { GraphicBox } from './graphics.ts';

export type { GraphicBox } from './graphics.ts';

export interface FaceBox { x: number; y: number; w: number; h: number; score?: number }
/** One sampled frame: `sec` is its presentation time, so variable-frame-rate footage reads true. */
export interface Sample { sec: number; faces: FaceBox[] }
export interface Shot {
  start: number;
  end: number;
  samples: Sample[];
  /** No frame of it was looked at, which is not the same as no face: a range of a cut whose source faces never ran on. */
  unknown?: true;
}

/** What the faces command writes: boxes in the clip's own display pixels, top-left origin. */
export interface FacesClip {
  /** The clip's absolute path: the key a page with several clips' faces.js tells them apart by. */
  video: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  frameRate: string;
  durationSec: number;
  model: string;
  every: number;
  threshold: number;
  confidence: number;
  /** Kept clear of text on every side of a face box, as a fraction of the box's size. */
  textMargin: number;
  /** Kept clear of text on every side of a graphic, as a fraction of the frame's shorter side. */
  graphicsMargin?: number;
  /** Graphics burned into the footage, each with the seconds it is up; absent from a faces.json written before they were looked for. */
  graphics?: GraphicBox[];
  shots: Shot[];
  detector?: { readyMs: number; frames: number; totalMs: number };
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface Placement { x: number; y: number; clear: boolean; moved: boolean }

/** The helpers available without a DOM: what the command and the tests use. */
export interface FacesApi {
  clips: Record<string, FacesClip>;
  add(clip: FacesClip): void;
  boxes(from: number, to?: number, clip?: string): Rect[];
  graphics(from: number, to?: number, clip?: string): Rect[];
  clear(rect: Rect, avoid: Rect[], bounds: Rect): Placement;
}

export const PAGE_SOURCE = String.raw`
(function () {
  if (window.openeditFaces) return;
  // A placed edge stops this far short of a face box, so rounding never leaves a hairline overlap.
  var GAP = 1;
  var clips = {};
  var placed = new WeakMap();

  function overlaps(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }
  function union(a, b) {
    var x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x: x, y: y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  }
  // Boxes that overlap are one face seen at several moments; boxes apart are different people.
  function group(list) {
    var out = [];
    list.forEach(function (b) {
      var r = { x: b.x, y: b.y, w: b.w, h: b.h };
      for (var again = true; again;) {
        again = false;
        for (var i = 0; i < out.length; i++) {
          if (overlaps(out[i], r)) { r = union(out[i], r); out.splice(i, 1); again = true; break; }
        }
      }
      out.push(r);
    });
    return out;
  }
  function pad(b, clip) {
    var mx = b.w * clip.textMargin, my = b.h * clip.textMargin;
    var x = Math.max(0, b.x - mx), y = Math.max(0, b.y - my);
    return { x: x, y: y, w: Math.min(clip.width, b.x + b.w + mx) - x, h: Math.min(clip.height, b.y + b.h + my) - y };
  }

  var slashed = function (p) { return String(p).replace(/\\/g, '/'); };
  function decoded(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }
  // The file a <video> or <img> shows. Its URL ends with the file's absolute path, both from file:// and
  // from the renderer's server.
  function fileOf(el) {
    var source = el.querySelector && el.querySelector('source');
    var src = el.currentSrc || el.getAttribute('src') || (source && source.getAttribute('src')) || '';
    if (!src) return '';
    var path;
    try { path = new URL(src, document.baseURI).pathname; } catch (e) { path = src.split(/[?#]/)[0]; }
    return decoded(path);
  }
  function matching(file) {
    return Object.keys(clips).filter(function (k) { var p = '/' + slashed(k).replace(/^\/+/, ''); return file.slice(-p.length) === p; });
  }
  // Each picture's clip, once known. A render stands a --footage video down by removing its source after
  // the page has loaded, so the clip is learned while the source is still there.
  var known = new WeakMap();
  function learn() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    document.querySelectorAll('video, img').forEach(function (el) {
      var file = fileOf(el), hits = file ? matching(file) : [];
      if (hits.length === 1) known.set(el, clips[hits[0]]);
    });
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', learn);
  }
  function pick(name, el) {
    var keys = Object.keys(clips);
    var loaded = ' (loaded: ' + (keys.join(', ') || 'none') + ')';
    var hits;
    if (name) {
      hits = keys.filter(function (k) { return slashed(k) === slashed(name) || clips[k].name === name; });
      if (hits.length === 1) return clips[hits[0]];
      throw new Error('openeditFaces: ' + (hits.length ? hits.length + ' clips are named "' + name + '"; name one by its path' : 'no face data for "' + name + '"') + loaded);
    }
    if (el && known.has(el)) return known.get(el);
    var file = el && /^(VIDEO|IMG)$/.test(el.tagName) ? fileOf(el) : '';
    if (file) {
      hits = matching(file);
      if (hits.length === 1) { known.set(el, clips[hits[0]]); return clips[hits[0]]; }
      throw new Error('openeditFaces: no face data for ' + file + loaded);
    }
    if (keys.length === 1) return clips[keys[0]];
    throw new Error('openeditFaces: ' + (keys.length ? 'face data for several clips is loaded; name one with {clip}' : 'no faces.js is loaded') + loaded);
  }

  // The graphics burned into the footage that are up at any moment from 'from' to 'to' seconds (at 'from' alone
  // when 'to' is left out), padded by the clip's graphics margin.
  function graphics(from, to, name) {
    var clip = pick(name);
    if (to === undefined) to = from;
    var m = (clip.graphicsMargin || 0) * Math.min(clip.width, clip.height);
    return (clip.graphics || []).filter(function (g) { return g.from <= to && g.to >= from; }).map(function (g) {
      var x = Math.max(0, g.x - m), y = Math.max(0, g.y - m);
      return { x: x, y: y, w: Math.min(clip.width, g.x + g.w + m) - x, h: Math.min(clip.height, g.y + g.h + m) - y };
    });
  }

  // What text is kept off from 'from' up to 'to' seconds (at 'from' alone when 'to' is left out): the faces on
  // screen, padded by the clip's text margin, and the graphics up. Within a shot the faces are every sample in
  // the span plus the nearest one on each side, since the face moves between them.
  function boxes(from, to, name) {
    var clip = pick(name);
    if (to === undefined) to = from;
    var out = graphics(from, to, clip.video);
    clip.shots.forEach(function (shot) {
      var shown = to > from ? shot.start < to && shot.end > from : shot.start <= from && from < shot.end;
      if (!shown) return;
      var s = shot.samples, pool = [], before = null, after = null;
      s.forEach(function (x) {
        if (x.sec < from) before = x;
        else if (x.sec > to) { if (!after) after = x; }
        else pool.push(x);
      });
      if (before) pool.push(before);
      if (after) pool.push(after);
      var raw = [];
      pool.forEach(function (x) { raw = raw.concat(x.faces); });
      group(raw).forEach(function (b) { out.push(pad(b, clip)); });
    });
    return out;
  }

  // The nearest position for 'rect' inside 'bounds' that overlaps none of 'avoid'. The answer has each
  // coordinate where it was, at a bound, or just past a box's edge, so those are the only candidates.
  function clear(rect, avoid, bounds) {
    var eps = 1e-6;
    function fits(x, y) {
      if (x < bounds.x - eps || y < bounds.y - eps || x + rect.w > bounds.x + bounds.w + eps || y + rect.h > bounds.y + bounds.h + eps) return false;
      var r = { x: x, y: y, w: rect.w, h: rect.h };
      for (var i = 0; i < avoid.length; i++) if (overlaps(r, avoid[i])) return false;
      return true;
    }
    if (fits(rect.x, rect.y)) return { x: rect.x, y: rect.y, clear: true, moved: false };
    var xs = [rect.x, bounds.x, bounds.x + bounds.w - rect.w], ys = [rect.y, bounds.y, bounds.y + bounds.h - rect.h];
    avoid.forEach(function (b) {
      xs.push(b.x - rect.w - GAP, b.x + b.w + GAP);
      ys.push(b.y - rect.h - GAP, b.y + b.h + GAP);
    });
    var best = null;
    xs.forEach(function (x) {
      ys.forEach(function (y) {
        if (!fits(x, y)) return;
        var dx = Math.abs(x - rect.x), dy = Math.abs(y - rect.y), d = dx * dx + dy * dy;
        if (!best || d < best.d || (d === best.d && dx < best.dx)) best = { x: x, y: y, d: d, dx: dx };
      });
    });
    return best ? { x: best.x, y: best.y, clear: true, moved: true } : { x: rect.x, y: rect.y, clear: false, moved: false };
  }

  var KEYWORD = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };
  // A computed object-position, split at its top-level spaces: 'calc(100% - 20px) 0px' is two parts.
  function parts(value) {
    var out = [], depth = 0, cur = '';
    for (var i = 0; i < value.length; i++) {
      var c = value[i];
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ' ' && depth === 0) { if (cur) out.push(cur); cur = ''; } else cur += c;
    }
    if (cur) out.push(cur);
    return out;
  }
  // One part's offset across 'free' pixels of slack; NaN for a form it does not know, never a guess.
  function along(token, free) {
    var m = /^calc\((-?[\d.]+)%\s*([+-])\s*(-?[\d.]+)px\)$/.exec(token);
    if (m) return free * parseFloat(m[1]) / 100 + (m[2] === '-' ? -1 : 1) * parseFloat(m[3]);
    if (/^-?[\d.]+%$/.test(token)) return free * parseFloat(token) / 100;
    if (/^-?[\d.]+px$/.test(token)) return parseFloat(token);
    if (token in KEYWORD) return free * KEYWORD[token];
    return token ? NaN : free / 2;
  }
  // Where the clip's picture is drawn on the page: inside a <video> or <img> per its object-fit and
  // object-position, else filling the element (the stage, for footage that fills it).
  function drawn(el, clip) {
    var r = el.getBoundingClientRect();
    var box = { x: r.left, y: r.top, w: r.width, h: r.height };
    if (!/^(VIDEO|IMG)$/.test(el.tagName)) {
      if (Math.abs(r.width / r.height - clip.width / clip.height) > 0.01 * clip.width / clip.height) {
        throw new Error('openeditFaces: the stage is ' + r.width + 'x' + r.height + ' and ' + clip.name + ' is ' + clip.width + 'x' + clip.height +
          ', so the footage does not fill it at its own shape: pass the element it is drawn in as {video}');
      }
      return box;
    }
    var shown = el.videoWidth || el.naturalWidth, tall = el.videoHeight || el.naturalHeight;
    if (shown && tall && Math.abs(shown / tall - clip.width / clip.height) > 0.01 * clip.width / clip.height) {
      throw new Error('openeditFaces: ' + fileOf(el) + ' is ' + shown + 'x' + tall + ' but the face data is for a ' + clip.width + 'x' + clip.height + ' clip');
    }
    var cs = getComputedStyle(el), fit = cs.objectFit;
    var contain = Math.min(r.width / clip.width, r.height / clip.height);
    var s = fit === 'contain' ? contain : fit === 'cover' ? Math.max(r.width / clip.width, r.height / clip.height)
      : fit === 'none' ? 1 : fit === 'scale-down' ? Math.min(1, contain) : null;
    if (s === null) return box;
    var w = clip.width * s, h = clip.height * s, pos = parts(cs.objectPosition || '');
    var out = { x: r.left + along(pos[0] || '', r.width - w), y: r.top + along(pos[1] || '', r.height - h), w: w, h: h };
    if (!isFinite(out.x) || !isFinite(out.y)) throw new Error('openeditFaces: cannot read object-position "' + cs.objectPosition + '" of ' + fileOf(el));
    return out;
  }
  var rectOf = function (el) { var r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  // The one <video> on show that plays this clip, else null. A render hides the video it lays as --footage, which then
  // fills the stage.
  function playing(clip) {
    if (typeof document === 'undefined' || !document.querySelectorAll) return null;
    var found = [];
    document.querySelectorAll('video').forEach(function (v) {
      var file = fileOf(v);
      var plays = known.get(v) === clip || (file && matching(file).indexOf(clip.video) >= 0);
      var r = v.getBoundingClientRect();
      if (plays && r.width > 0 && r.height > 0 && getComputedStyle(v).visibility === 'visible') found.push(v);
    });
    return found.length === 1 ? found[0] : null;
  }

  // What placed text keeps inside: options.within, else the [data-safe] container it sits in, else the zone a
  // safe-zone stylesheet marks on the stage with its --safe-* insets, else the stage.
  function boundsOf(el, stage, within) {
    if (within) return { rect: rectOf(within), name: 'options.within' };
    var safe = el.parentElement && el.parentElement.closest('[data-safe]');
    if (safe) return { rect: rectOf(safe), name: 'its [data-safe] container' };
    var r = rectOf(stage), cs = getComputedStyle(stage);
    var inset = ['top', 'right', 'bottom', 'left'].map(function (side) { return parseFloat(cs.getPropertyValue('--safe-' + side)); });
    if (!inset.every(isFinite) || !stage.offsetWidth || !stage.offsetHeight) return { rect: r, name: 'the stage' };
    var kx = r.w / stage.offsetWidth, ky = r.h / stage.offsetHeight;
    return { rect: { x: r.x + inset[3] * kx, y: r.y + inset[0] * ky, w: r.w - (inset[1] + inset[3]) * kx, h: r.h - (inset[0] + inset[2]) * ky }, name: 'the stage\'s safe zone' };
  }

  // Moves 'el' the least distance that keeps it clear of every face on screen, and every graphic burned into the
  // footage that is up, from 'from' to 'to' seconds of the clip (its own time, not the page's), inside what boundsOf
  // names. The clip's picture is where the <video> playing it draws it (options.video, else the one on show), or the
  // stage. It starts from where the page put the element each time, so calling it again, every frame from __seek
  // included, gives the same answer for the same layout. The result is where the element ended, as measured.
  function place(el, from, to, options) {
    options = options || {};
    var clip = pick(options.clip, options.video);
    var stage = document.querySelector('#stage') || document.querySelector('[data-stage]') || document.documentElement;
    // Back to the page's own translate, read afresh every call, and kept as its computed tokens: a percentage
    // is of the element's own size and cannot be added to as pixels. An inline translate other than the one
    // place() last wrote is the page's own, written since, and becomes the base.
    var state = placed.get(el);
    if (!state) { state = { inline: el.style.translate, wrote: el.style.translate }; placed.set(el, state); }
    if (el.style.translate !== state.wrote) state.inline = el.style.translate;
    el.style.translate = state.inline;
    state.wrote = el.style.translate;
    var base = parts(getComputedStyle(el).translate || 'none');
    if (base[0] === 'none') base = ['0px'];
    var at = function (dx, dy) {
      el.style.translate = !dx && !dy ? state.inline
        : 'calc(' + base[0] + ' + ' + dx + 'px) calc(' + (base[1] || '0px') + ' + ' + dy + 'px)' + (base[2] ? ' ' + base[2] : '');
      state.wrote = el.style.translate;
    };
    var rect = rectOf(el);
    var frame = drawn(options.video || playing(clip) || stage, clip);
    var sx = frame.w / clip.width, sy = frame.h / clip.height;
    var avoid = boxes(from, to, clip.video).map(function (b) {
      return { x: frame.x + b.x * sx, y: frame.y + b.y * sy, w: b.w * sx, h: b.h * sy };
    });
    var bound = boundsOf(el, stage, options.within);
    var wr = bound.rect;
    var res = clear(rect, avoid, wr);
    var span = from + ' to ' + (to === undefined ? from : to) + ' s of the clip';
    if (!res.clear) {
      console.warn('openeditFaces.place: no place inside ' + bound.name + ' keeps this element off every face and graphic from ' +
        span + ', so it stays where the page put it: make it smaller or shorten its span');
      return { x: rect.x, y: rect.y, clear: false, moved: false };
    }
    var want = res.moved ? [res.x - rect.x, res.y - rect.y] : [0, 0];
    if (res.moved) {
      // A CSS pixel of translate covers as many screen pixels as the ancestors' scale, which nothing reports
      // reliably: move, measure how far it went, and correct in proportion.
      var css = want.slice();
      for (var pass = 0; pass < 3; pass++) {
        at(css[0], css[1]);
        var now = rectOf(el), got = [now.x - rect.x, now.y - rect.y];
        if (Math.abs(got[0] - want[0]) < 0.25 && Math.abs(got[1] - want[1]) < 0.25) break;
        css = [0, 1].map(function (i) { return got[i] && css[i] ? css[i] * want[i] / got[i] : css[i] + want[i] - got[i]; });
      }
    }
    var end = rectOf(el);
    var went = Math.abs(end.x - rect.x) > 0.25 || Math.abs(end.y - rect.y) > 0.25;
    // Nothing moved, so an animation or !important rule owns the translate: the page's own inline value goes
    // back, or the corrections written above would throw the element off once that rule lets go.
    if (res.moved && !went) { at(0, 0); end = rectOf(el); }
    var inside = end.x >= wr.x - 0.5 && end.y >= wr.y - 0.5 && end.x + end.w <= wr.x + wr.w + 0.5 && end.y + end.h <= wr.y + wr.h + 0.5;
    var hit = avoid.some(function (b) { return overlaps(end, b); });
    if (res.moved && !went) {
      if (Math.abs(want[0]) >= 0.25 || Math.abs(want[1]) >= 0.25) {
        console.warn('openeditFaces.place: could not move this element for ' + span + ': its translate is set by an animation or an ' +
          '!important rule, which an inline translate cannot override. Move it in the page, or give it a wrapper to place');
      }
    } else if (hit || !inside) {
      console.warn('openeditFaces.place: moved this element for ' + span + ', but it ' + (hit ? 'still overlaps a face or graphic' : 'now leaves ' + bound.name) +
        ': a transform on it or an ancestor (a rotation, say) turns the move. Place it without that transform');
    }
    return { x: end.x, y: end.y, clear: !hit && inside, moved: went };
  }

  window.openeditFaces = {
    clips: clips,
    add: function (clip) {
      clips[clip.video] = clip;
      if (typeof document !== 'undefined' && document.readyState && document.readyState !== 'loading') learn();
    },
    boxes: boxes,
    graphics: graphics,
    clear: clear,
    place: place,
  };
})();
`;

/** The faces.js a page loads for this clip. */
export function facesScript(clip: FacesClip): string {
  return `${PAGE_SOURCE.trim()}\nwindow.openeditFaces.add(${JSON.stringify(clip)});\n`;
}

/** The page helpers, evaluated in Node from the same source the page runs. */
export function facesApi(...clipsToAdd: FacesClip[]): FacesApi {
  const window: { openeditFaces?: FacesApi } = {};
  runInNewContext(PAGE_SOURCE, { window });
  const api = window.openeditFaces!;
  for (const clip of clipsToAdd) api.add(clip);
  return api;
}
