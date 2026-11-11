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
/**
 * One of several elements shown in turn that share a move: where it is laid out and what it must stay off while it is
 * up, both in the same pixels.
 */
export interface HeldItem { rect: Rect; avoid: Rect[] }
/**
 * Items `from` up to `to` (indices, `to` past the last), moved together by `dx`, `dy`; `stuck` lists those no move
 * clears, which take this move anyway, and `clear` is whether there are none.
 */
export interface Stretch { from: number; to: number; dx: number; dy: number; clear: boolean; moved: boolean; stuck: number[] }

/** The helpers available without a DOM: what the command and the tests use. */
export interface FacesApi {
  clips: Record<string, FacesClip>;
  add(clip: FacesClip): void;
  boxes(from: number, to?: number, clip?: string): Rect[];
  graphics(from: number, to?: number, clip?: string): Rect[];
  clear(rect: Rect, avoid: Rect[], bounds: Rect): Placement;
  hold(items: HeldItem[], bounds: Rect): Stretch[];
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
      if (shown) out = out.concat(facesIn(shot, from, to, clip));
    });
    return out;
  }
  function facesIn(shot, from, to, clip) {
    var pool = [], before = null, after = null;
    shot.samples.forEach(function (x) {
      if (x.sec < from) before = x;
      else if (x.sec > to) { if (!after) after = x; }
      else pool.push(x);
    });
    if (before) pool.push(before);
    if (after) pool.push(after);
    var raw = [];
    pool.forEach(function (x) { raw = raw.concat(x.faces); });
    return group(raw).map(function (b) { return pad(b, clip); });
  }

  // One move for every item, the nearest that keeps each inside 'bounds' and off its own 'avoid'. The answer leaves
  // each coordinate unmoved, or puts some item at a bound or just past one of its boxes' edges, so those are the only
  // candidates.
  function clearAll(items, bounds) {
    var eps = 1e-6;
    function across(d, at, size, lo, room) {
      for (var k = 0; k < items.length; k++) {
        var r = items[k].rect, v = r[at] + d;
        if (v < lo - eps || v + r[size] > lo + room + eps) return false;
      }
      return true;
    }
    var insideX = function (dx) { return across(dx, 'x', 'w', bounds.x, bounds.w); };
    var insideY = function (dy) { return across(dy, 'y', 'h', bounds.y, bounds.h); };
    function fits(dx, dy) {
      for (var k = 0; k < items.length; k++) {
        var r = items[k].rect, moved = { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }, avoid = items[k].avoid;
        for (var i = 0; i < avoid.length; i++) if (overlaps(moved, avoid[i])) return false;
      }
      return true;
    }
    if (insideX(0) && insideY(0) && fits(0, 0)) return { dx: 0, dy: 0, clear: true, moved: false };
    var xs = [0], ys = [0];
    items.forEach(function (it) {
      var r = it.rect;
      xs.push(bounds.x - r.x, bounds.x + bounds.w - r.w - r.x);
      ys.push(bounds.y - r.y, bounds.y + bounds.h - r.h - r.y);
      it.avoid.forEach(function (b) {
        xs.push(b.x - r.w - GAP - r.x, b.x + b.w + GAP - r.x);
        ys.push(b.y - r.h - GAP - r.y, b.y + b.h + GAP - r.y);
      });
    });
    var once = function (list, ok) { var seen = new Set(); return list.filter(function (v) { if (seen.has(v)) return false; seen.add(v); return ok(v); }); };
    xs = once(xs, insideX);
    ys = once(ys, insideY);
    var best = null;
    xs.forEach(function (dx) {
      var ax = Math.abs(dx);
      ys.forEach(function (dy) {
        var d = dx * dx + dy * dy;
        if (best && (d > best.d || (d === best.d && ax >= best.ax))) return;
        if (fits(dx, dy)) best = { dx: dx, dy: dy, d: d, ax: ax };
      });
    });
    return best ? { dx: best.dx, dy: best.dy, clear: true, moved: true } : { dx: 0, dy: 0, clear: false, moved: false };
  }

  // The nearest position for 'rect' inside 'bounds' that overlaps none of 'avoid'.
  function clear(rect, avoid, bounds) {
    var res = clearAll([{ rect: rect, avoid: avoid }], bounds);
    return { x: rect.x + res.dx, y: rect.y + res.dy, clear: res.clear, moved: res.moved };
  }

  // The fewest stretches of consecutive 'items' one move each clears, each as long as it can be from where the last
  // ended. An item no move clears on its own overlaps wherever it sits, so it splits no stretch: it takes the move of
  // the stretch it falls in, and is listed in that stretch's 'stuck'.
  function hold(items, bounds) {
    var firm = [], stuck = [];
    if (!items.length) return [];
    items.forEach(function (it, n) {
      (clearAll([it], bounds).clear ? firm : stuck).push(n);
    });
    var only = firm.map(function (n) { return items[n]; }), runs = [], all = clearAll(only, bounds);
    if (all.clear) runs.push({ from: 0, move: all });
    // Firm items i to lo-1 share a move and i to hi-1 do not, or hi is past the end. A move that clears a stretch
    // clears every part of it, so the end is found by doubling, then halving; the whole run was tried first.
    for (var i = 0; !all.clear && i < only.length;) {
      var lo = i + 1, hi = i ? only.length + 1 : only.length, got = clearAll(only.slice(i, lo), bounds);
      for (var step = 1; lo + step < hi; step *= 2) {
        var r = clearAll(only.slice(i, lo + step), bounds);
        if (!r.clear) { hi = lo + step; break; }
        lo += step;
        got = r;
      }
      while (hi - lo > 1) {
        var mid = (lo + hi) >> 1, m = clearAll(only.slice(i, mid), bounds);
        if (m.clear) { lo = mid; got = m; } else hi = mid;
      }
      runs.push({ from: i, move: got });
      i = lo;
    }
    // An item before the first firm one belongs to the first stretch, and any other to the stretch before it.
    return runs.map(function (r, k) {
      var from = k ? firm[r.from] : 0, to = k + 1 < runs.length ? firm[runs[k + 1].from] : items.length;
      var mine = stuck.filter(function (n) { return n >= from && n < to; });
      return { from: from, to: to, dx: r.move.dx, dy: r.move.dy, clear: !mine.length, moved: r.move.moved, stuck: mine };
    });
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

  var stageOf = function () { return document.querySelector('#stage') || document.querySelector('[data-stage]') || document.documentElement; };

  // Puts 'el' back at the page's own translate, kept as its computed tokens, since a percentage is of the element's
  // own size and cannot be added to as pixels. An inline translate other than the one this file last wrote is the
  // page's own, written since, and becomes the base.
  function unmoved(el) {
    var state = placed.get(el);
    if (!state) { state = { inline: el.style.translate, wrote: el.style.translate }; placed.set(el, state); }
    if (el.style.translate !== state.wrote) state.inline = el.style.translate;
    el.style.translate = state.inline;
    state.wrote = el.style.translate;
    var base = parts(getComputedStyle(el).translate || 'none');
    if (base[0] === 'none') base = ['0px'];
    return function (dx, dy) {
      el.style.translate = !dx && !dy ? state.inline
        : 'calc(' + base[0] + ' + ' + dx + 'px) calc(' + (base[1] || '0px') + ' + ' + dy + 'px)' + (base[2] ? ' ' + base[2] : '');
      state.wrote = el.style.translate;
    };
  }

  // For text 'el' over a clip: what it keeps inside, and where the <video> playing the clip (options.video, else the
  // one on show) or the stage draws the picture, to map the clip's boxes onto the page. 'key' changes when either box
  // moves, so a plan made for the old ones is made again.
  function sceneOf(el, clip, options) {
    var stage = stageOf(), frame = drawn(options.video || playing(clip) || stage, clip), bound = boundsOf(el, stage, options.within);
    var sx = frame.w / clip.width, sy = frame.h / clip.height;
    return {
      bound: bound,
      key: [frame.x, frame.y, frame.w, frame.h, bound.rect.x, bound.rect.y, bound.rect.w, bound.rect.h].join(' '),
      page: function (list) { return list.map(function (b) { return { x: frame.x + b.x * sx, y: frame.y + b.y * sy, w: b.w * sx, h: b.h * sy }; }); },
    };
  }
  var sec2 = function (s) { return s.toFixed(2); };
  var spanOf = function (from, to) { return sec2(from) + ' to ' + sec2(to === undefined ? from : to) + ' s of the clip'; };

  // Moves 'el' the least distance that keeps it clear of every face on screen, and every graphic burned into the
  // footage that is up, from 'from' to 'to' seconds of the clip (its own time, not the page's), inside what boundsOf
  // names. It starts from where the page put the element each time, so calling it again, every frame from __seek
  // included, gives the same answer for the same layout. The result is where the element ended, as measured.
  function place(el, from, to, options) {
    options = options || {};
    var clip = pick(options.clip, options.video), at = unmoved(el), rect = rectOf(el);
    var scene = sceneOf(el, clip, options), avoid = scene.page(boxes(from, to, clip.video));
    var res = clearAll([{ rect: rect, avoid: avoid }], scene.bound.rect);
    return settle(el, at, rect, res, { avoid: avoid, bound: scene.bound, span: spanOf(from, to), clear: res.clear, say: function (line) { console.warn(line); } });
  }

  // Moves 'el', laid out at 'rect', by 'move' (dx and dy, in screen pixels; none when it is not 'moved'), and reports
  // where it ended. What is checked against 'o.avoid' and 'o.bound' is 'o.basis', the box the move was found for, moved
  // as far as 'el' went: the element as drawn can differ (a word being said set larger), which no move is to blame for.
  // 'o.clear' is whether the move was found to clear it, without which it is only said that no place does.
  function settle(el, at, rect, move, o) {
    if (!o.clear) {
      o.say('openeditFaces.place: no place inside ' + o.bound.name + ' keeps this element off every face and graphic from ' + o.span +
        ', so it ' + (move.moved ? 'takes the place held from ' + o.held + ', and overlaps there' : 'stays where the page put it') +
        ': make it smaller or shorten its span');
    }
    var wr = o.bound.rect, want = move.moved ? [move.dx, move.dy] : [0, 0];
    if (move.moved) {
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
    if (move.moved && !went) { at(0, 0); end = rectOf(el); }
    var b = o.basis || rect, moved = { x: b.x + end.x - rect.x, y: b.y + end.y - rect.y, w: b.w, h: b.h };
    var inside = moved.x >= wr.x - 0.5 && moved.y >= wr.y - 0.5 && moved.x + moved.w <= wr.x + wr.w + 0.5 && moved.y + moved.h <= wr.y + wr.h + 0.5;
    var hit = o.avoid.some(function (a) { return overlaps(moved, a); });
    if (move.moved && !went) {
      if (Math.abs(want[0]) >= 0.25 || Math.abs(want[1]) >= 0.25) {
        o.say('openeditFaces.place: could not move this element for ' + o.span + ': its translate is set by an animation or an ' +
          '!important rule, which an inline translate cannot override. Move it in the page, or give it a wrapper to place');
      }
    } else if (o.clear && (hit || !inside)) {
      o.say('openeditFaces.place: moved this element for ' + o.span + ', but it ' + (hit ? 'still overlaps a face or graphic' : 'now leaves ' + o.bound.name) +
        ': a transform on it or an ancestor (a rotation, say) turns the move. Place it without that transform');
    }
    return { x: end.x, y: end.y, clear: o.clear && !hit && inside, moved: went };
  }

  function fail(message) { throw new Error('openeditFaces.placer: ' + message); }

  // Elements shown in turn in one spot, a caption track's cues say, take one move through each shot of the clip, the
  // least that keeps each clear while it is up, so they can move only at a cut, or as few times as a shot that no one
  // move clears needs, said once on the console. 'spans' are their {from, to}, seconds of the clip, in time order and
  // not overlapping. 'measure(i)' lays element i out alone where it is shown, unmoved, and gives its box {x, y, w, h}
  // (or a DOMRect) in viewport pixels; it is called from prepare(i), which the caller runs while none of the elements is
  // on screen, so laying one out disturbs nothing; a caller that never prepares has place() measure instead, each time.
  // The caller places an element again whenever 'part(i, sec)' changes, as it does at each cut the element is up across,
  // and may call 'check(el, i, sec)' as it draws, to hear of an element drawn larger than it was measured.
  function placer(spans, measure, options) {
    options = options || {};
    if (!Array.isArray(spans) || spans.some(function (s, n) { return !s || !(s.from <= s.to) || (n > 0 && !(s.from >= spans[n - 1].to)); })) {
      fail('spans must be an array of {from, to} seconds of the clip, from no later than to, in time order and not overlapping');
    }
    if (typeof measure !== 'function') fail('measure must be a function giving the box {x, y, w, h} element i is laid out in, in viewport pixels');
    var clip = pick(options.clip, options.video), what = options.what || 'these elements';
    if (options.say !== undefined && typeof options.say !== 'function') fail('say must be a function that is given each line to print');
    var said = {}, say = options.say || function (line) { if (!said[line]) { said[line] = true; console.warn(line); } };
    var shots = clip.shots.slice().sort(function (a, b) { return a.start - b.start; });
    if (!shots.length) shots = [{ start: 0, end: Infinity, samples: [] }];
    var starts = shots.map(function (s) { return s.start; });
    // A second belongs to the last shot started by then: one held on its last picture past its end or in a gap, and
    // the first shot before it starts.
    function shotAt(sec) {
      var lo = 1, hi = starts.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (starts[mid] <= sec) lo = mid + 1; else hi = mid; }
      return lo - 1;
    }
    // Each element is a part in each shot it is up in, split where the next shot starts.
    var parts = {};
    var pieces = spans.map(function (s, i) {
      var list = [], from = s.from, k = shotAt(from);
      var add = function (to) { var list2 = parts[k] = parts[k] || [], p = { i: i, from: from, to: to, shot: k, slot: list2.length }; list.push(p); list2.push(p); };
      for (; k + 1 < starts.length && starts[k + 1] < s.to; k++) { add(starts[k + 1]); from = starts[k + 1]; }
      add(s.to);
      return list;
    });
    function indexed(i) {
      if (!(typeof i === 'number' && i >= 0 && i < spans.length && Math.floor(i) === i)) fail(i + ' is not the index of one of the ' + spans.length + ' elements');
    }
    function pieceOf(i, sec) {
      indexed(i);
      var list = pieces[i], k = shotAt(sec);
      for (var n = 0; n < list.length; n++) if (list[n].shot === k) return list[n];
      return sec < list[0].from ? list[0] : list[list.length - 1];
    }
    var near = function (a, b) { return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5; };
    var or = function (a, b) { return a !== undefined ? a : b; };
    function box(i) {
      var r = measure(i), b = r && { x: or(r.x, r.left), y: or(r.y, r.top), w: or(r.w, r.width), h: or(r.h, r.height) };
      if (!b || ![b.x, b.y, b.w, b.h].every(function (v) { return typeof v === 'number' && isFinite(v); })) {
        fail('measure(' + i + ') gave ' + JSON.stringify(r) + ', not a box {x, y, w, h} in viewport pixels');
      }
      return b;
    }
    // The boxes of every element of a shot, made again when one of them, measured afresh, has moved or changed size: in
    // prepare() once a caller prepares, else in place() each time.
    var measured = {}, prepared = false;
    function measureShots(i) {
      var mine = box(i), seen = {};
      seen[i] = mine;
      pieces[i].forEach(function (p) {
        var had = measured[p.shot];
        if (had && near(had[p.slot], mine)) return;
        measured[p.shot] = parts[p.shot].map(function (q) { return seen[q.i] || (seen[q.i] = box(q.i)); });
      });
    }
    var plans = {};
    function planFor(k, scene) {
      var list = parts[k], shot = shots[k], had = plans[k];
      if (had && had.key === scene.key && had.rects === measured[k]) return had;
      var rects = measured[k];
      var items = list.map(function (q, n) {
        var avoid = scene.page(graphics(q.from, q.to, clip.video).concat(facesIn(shot, q.from, q.to, clip)));
        return { rect: rects[n], avoid: avoid };
      });
      var held = hold(items, scene.bound.rect), of = [];
      held.forEach(function (st, n) { for (var j = st.from; j < st.to; j++) of[j] = n; });
      // Stretches in a row never share a move, since one move clearing both would have made them one stretch.
      if (held.length > 1) {
        var to = k + 1 < starts.length ? starts[k + 1] : Math.max(shot.end, list[list.length - 1].to);
        say('openeditFaces: no one place inside ' + scene.bound.name + ' keeps ' + what + ' off every face and graphic through the shot from ' +
          sec2(shot.start) + ' to ' + sec2(to) + ' s of the clip, so ' + what + ' take ' + held.length + ' places in it, moving at ' +
          held.slice(1).map(function (st) { return sec2(list[st.from].from); }).join(', ') + ' s');
      }
      plans[k] = { key: scene.key, rects: rects, items: items, held: held, of: of };
      return plans[k];
    }
    return {
      // Opaque: changes at each cut, and only there.
      part: function (i, sec) { return pieceOf(i, sec).shot; },
      // Measures element i, and measures every element of each shot it is up in again when element i's own box differs
      // from the one that shot was measured with, or the shot was never measured; run while none of the elements is on
      // screen, before showing element i.
      prepare: function (i) { indexed(i); prepared = true; measureShots(i); },
      // Places 'el', element i, where the elements are at 'sec' seconds of the clip; the result is place()'s.
      place: function (el, i, sec) {
        var p = pieceOf(i, sec), at = unmoved(el), rect = rectOf(el), scene = sceneOf(el, clip, options);
        if (!prepared || !measured[p.shot]) measureShots(i);
        var plan = planFor(p.shot, scene), st = plan.held[plan.of[p.slot]], item = plan.items[p.slot], list = parts[p.shot];
        return settle(el, at, rect, st, {
          avoid: item.avoid, bound: scene.bound, span: spanOf(p.from, p.to), basis: item.rect, say: say,
          clear: st.stuck.indexOf(p.slot) < 0, held: spanOf(list[st.from].from, list[st.to - 1].to),
        });
      },
      // Says once when 'el', element i as drawn at 'sec', is larger than the box it was placed for and meets a face or
      // graphic that box clears: a look the page gives it then, larger than the one measured, which no place allows for.
      check: function (el, i, sec) {
        var p = pieceOf(i, sec), plan = plans[p.shot];
        if (!plan) return;
        var st = plan.held[plan.of[p.slot]], item = plan.items[p.slot], b = item.rect, now = rectOf(el);
        if (st.stuck.indexOf(p.slot) >= 0 || (now.w <= b.w + 0.5 && now.h <= b.h + 0.5)) return;
        if (!item.avoid.some(function (a) { return overlaps(now, a); })) return;
        say('openeditFaces.place: this element is drawn larger than the ' + Math.round(b.w) + 'x' + Math.round(b.h) + ' px box it was placed for, from ' +
          spanOf(p.from, p.to) + ', and so meets a face or graphic: keep it within the size it is measured at, or measure it at its largest');
      },
    };
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
    hold: hold,
    place: place,
    placer: placer,
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
