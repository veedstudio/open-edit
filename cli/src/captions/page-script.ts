// captions.js: the words of one transcript and the code that lays them out as caption cues on the page's clock. The
// page loads it with a <script> tag and gives it an empty element marked data-captions; the script fills that element
// with the cue on screen, one element per line and per word, and sets each frame's state on them as attributes and
// custom properties for the page's own CSS. It owns which words, in which cues, shown when, and which of them are
// emphasised; the look is the page's.
//
// Kept as plain JavaScript source, not a function to be stringified: a transpiler may wrap named functions in helpers
// that do not exist inside the page. The cue shaping runs in Node too, from the same source, for the command and tests.
import { runInNewContext } from 'node:vm';
import { HOLD } from '../verify/captions.ts';
import { PHRASE_PAUSE } from '../verify/dead-tail.ts';

/** Most lines a cue takes, and most characters a line holds: Netflix's timed text style guides. */
export const LINES = 2;
export const LINE_CHARS = 42;

/** A cue stays up this long past its last word: Netflix's half second of lag-out past the end of the audio. */
export const LAG_OUT = 0.5;

/**
 * A gap shorter than this between one cue and the next is closed, the first held until the next comes up: Netflix's
 * half second. With LAG_OUT the screen clears only in a silence of a second or more, the captions check's second.
 */
export const CLOSE_GAP = 0.5;

/** Most key words a line emphasises: past two, none of them stands out from the rest. */
export const KEY_WORDS = 2;

/** One word as the page gets it: its text and its spoken span, seconds of the transcript. */
export type CaptionWord = [text: string, start: number, end: number];

export interface CaptionTrack {
  /** The transcript's file name, which a page with several tracks names on its container. */
  name: string;
  /** The transcript's absolute path. */
  path: string;
  words: CaptionWord[];
}

/**
 * A cue as shaped: its words by index into the track's words, in lines, and when it is up, seconds of the transcript;
 * `emphasis` is the key words it marks.
 */
export interface Cue { index: number; start: number; end: number; words: number[]; lines: number[][]; emphasis: number[] }

export interface CaptionsApi {
  add(track: CaptionTrack): void;
  /** Cues of a track at these options, lines fitted by characters alone, as no page is there to measure. */
  cues(name?: string, options?: { lines?: number; words?: number; chars?: number; from?: number; to?: number; keyWords?: string }): Cue[];
}

const CONFIG = { lines: LINES, chars: LINE_CHARS, holdMin: HOLD.min, holdMax: HOLD.max, lagOut: LAG_OUT, closeGap: CLOSE_GAP, pause: PHRASE_PAUSE, keyWords: KEY_WORDS };

export const PAGE_SOURCE = String.raw`
(function () {
  if (window.openeditCaptions) return;
  var CFG = __CONFIG__;
  var tracks = [];
  var SENTENCE = /[.!?\u2026]["'\u201d\u2019\u00bb)\]]*$/;
  var CLAUSE = /[,;:\u2013\u2014]["'\u201d\u2019\u00bb)\]]*$/;
  // Punctuation a page may hide (a style without it) is set in an element of its own; marks inside a word stay.
  var LEAD = /^["'\u201c\u2018\u201e\u00ab(\[\u00bf\u00a1]+/;
  var TRAIL = /[.,!?;:\u2026"'\u201d\u2019\u00bb)\]]+$/;

  function fail(message) { throw new Error('openeditCaptions: ' + message); }

  function pick(name) {
    var names = tracks.map(function (t) { return t.name; }).join(', ') || 'none';
    if (name) {
      var hits = tracks.filter(function (t) { return t.path === name || t.name === name; });
      if (hits.length === 1) return hits[0];
      fail((hits.length ? hits.length + ' transcripts are named "' + name + '"; name one by its path' : 'no transcript "' + name + '" is loaded') + ' (loaded: ' + names + ')');
    }
    if (tracks.length === 1) return tracks[0];
    fail(tracks.length ? 'several transcripts are loaded; name one with data-transcript (loaded: ' + names + ')' : 'no transcript is loaded');
  }

  // Words i to j-1 of a track as cues: each fits its lines, holds no longer than a caption may, and breaks where speech
  // does (a sentence's end, a pause, a clause) rather than inside a phrase. 'fit' says whether words i to j-1 fit one
  // line and how full it is (0-1). A silence long enough to clear the screen always ends a cue.
  function shape(words, o, fit) {
    var n = words.length;
    var gap = function (k) { return words[k + 1].start - words[k].end; };
    var clear = CFG.lagOut + CFG.closeGap;
    // What breaking between word k and k+1 costs, and what running a cue across it costs, against a cue's 100: a
    // sentence's end breaks unless the cue before it would be too short to read, a pause the longer it is.
    var cut = [], span = [], hard = [];
    for (var k = 0; k + 1 < n; k++) {
      var g = gap(k), text = words[k].text;
      hard[k] = g >= clear;
      var sentence = SENTENCE.test(text), clause = CLAUSE.test(text);
      span[k] = sentence ? 300 : g >= CFG.pause ? 50 + 150 * Math.min(1, (g - CFG.pause) / CFG.pause) : clause ? 25 : 0;
      cut[k] = sentence || clause ? 0 : 50 * (1 - Math.min(1, Math.max(0, g) / CFG.pause));
    }
    function upFor(i, j) {
      var end = words[j - 1].end + CFG.lagOut;
      if (j < n && words[j].start - end < CFG.closeGap) end = words[j].start;
      return end - words[i].start;
    }
    // The fewest lines words i to j-1 take, each filled as far as it goes, and how full they are between them.
    function greedy(i, j) {
      var count = 0, full = 0, k = i;
      while (k < j) { var e = k + 1; while (e < j && fit(k, e + 1).fits) e++; count++; full += fit(k, e).full; k = e; }
      return { count: count, full: full };
    }
    var best = [0], back = [0], laid = [null];
    for (var j = 1; j <= n; j++) {
      best[j] = Infinity;
      var spanned = 0;
      for (var i = j - 1; i >= 0; i--) {
        if (i < j - 1) {
          if (hard[i]) break;
          spanned += span[i];
          if (o.words && j - i > o.words) break;
          if (words[j - 1].end - words[i].start > CFG.holdMax) break;
        }
        var lines = greedy(i, j);
        if (i < j - 1 && lines.count > o.lines) break;
        var cost = best[i] + 100 + spanned + (j < n ? cut[j - 1] : 0) + (upFor(i, j) < CFG.holdMin ? 250 : 0) + 20 * Math.pow(1 - Math.min(1, lines.full / o.lines), 2);
        if (cost < best[j]) { best[j] = cost; back[j] = i; laid[j] = lines.count; }
      }
    }
    var cues = [];
    for (var at = n; at > 0; at = back[at]) cues.unshift({ from: back[at], to: at, lines: laid[at] });
    return cues.map(function (c) {
      var list = [];
      for (var w = c.from; w < c.to; w++) list.push(w);
      return { words: list, lines: linesIn(words, c.from, c.to, c.lines, fit, cut) };
    });
  }

  // Words i to j-1 broken into exactly 'count' lines as even as they go, each break after punctuation or at a pause
  // where one can be, and a shorter line over a longer one where it cannot be even.
  function linesIn(words, i, j, count, fit, cut) {
    var memo = {};
    function go(a, left) {
      var key = a + ':' + left;
      if (key in memo) return memo[key];
      var res = null;
      if (left === 1) {
        var f = fit(a, j);
        res = f.fits || a === j - 1 ? { cost: Math.pow(1 - f.full, 2), lines: [[a, j]] } : null;
      } else {
        for (var e = a + 1; e <= j - left + 1; e++) {
          var f2 = fit(a, e);
          if (!f2.fits && e > a + 1) break;
          var rest = go(e, left - 1);
          if (!rest) continue;
          var lower = fit(e, rest.lines[0][1]).full;
          var cost = Math.pow(1 - f2.full, 2) + rest.cost + (cut[e - 1] / 100) * 0.1 + (f2.full > lower ? 0.01 : 0);
          if (!res || cost < res.cost) res = { cost: cost, lines: [[a, e]].concat(rest.lines) };
        }
      }
      memo[key] = res;
      return res;
    }
    var found = go(i, count) || { lines: [[i, j]] };
    return found.lines.map(function (r) { var out = []; for (var k = r[0]; k < r[1]; k++) out.push(k); return out; });
  }

  // When each cue is up, seconds of the transcript: from its first word to LAG_OUT past its last, held until the next
  // comes up when the gap between them is under CLOSE_GAP, and never past 'to'.
  function timed(words, shaped, to) {
    return shaped.map(function (c, k) {
      var first = words[c.words[0]], last = words[c.words[c.words.length - 1]];
      var next = shaped[k + 1] && words[shaped[k + 1].words[0]];
      var end = last.end + CFG.lagOut;
      if (next && next.start - end < CFG.closeGap) end = next.start;
      return { index: k, start: first.start, end: Math.min(end, to), words: c.words, lines: c.lines };
    });
  }

  // The characters of words i to j-1 set on one line, a space between each.
  function charCount(words) {
    var sum = [0];
    words.forEach(function (w, k) { sum.push(sum[k] + w.text.length); });
    return function (i, j) { return sum[j] - sum[i] + j - i - 1; };
  }

  function windowed(track, from, to) {
    var out = [];
    track.words.forEach(function (w, k) { if (w.start >= from && w.start < to) out.push({ text: w.text, start: w.start, end: Math.min(w.end, to), index: k }); });
    return out;
  }

  // A word as it is named and matched: its punctuation off the ends, in lower case.
  function plain(text) {
    var t = String(text), lead = LEAD.exec(t), body = t.slice(lead ? lead[0].length : 0).replace(TRAIL, '');
    return (body || t).toLowerCase();
  }

  // The key words named as word@seconds, each its text and start as openedit words prints them, as indices into the
  // track's words in the order named. Words repeat, so the start finds the word, to the precision it is written in.
  // A name no word matches is left out and its note added to 'missed': a typo costs that word its mark, not the render.
  function keyWordsOf(raw, track, missed) {
    var keys = [];
    String(raw || '').split(/\s+/).filter(Boolean).forEach(function (token) {
      var at = token.lastIndexOf('@'), sec = /^\d+(?:\.(\d+))?$/.exec(token.slice(at + 1));
      if (at < 1 || !sec) fail('data-key-words: "' + token + '" is not word@seconds, a word and its start as openedit words prints them (forty@12.34)');
      var text = plain(token.slice(0, at)), t = Number(sec[0]), near = 0.5 * Math.pow(10, -(sec[1] || '').length) + 1e-6, best = -1;
      var off = function (k) { return Math.abs(track.words[k].start - t); };
      track.words.forEach(function (w, k) {
        if (off(k) <= near && (plain(w.text) === text || plain(w.heard) === text) && (best < 0 || off(k) < off(best))) best = k;
      });
      if (best < 0) {
        var nearest = track.words.map(function (w, k) { return k; }).sort(function (a, b) { return off(a) - off(b); }).slice(0, 3);
        if (missed) missed.push('data-key-words: no "' + token.slice(0, at) + '" starts at ' + sec[0] + ' s in ' + track.name +
          ', so it is not emphasised; the words that start nearest it are ' + nearest.map(function (k) { return named(track, k); }).join(', '));
        return;
      }
      if (keys.indexOf(best) < 0) keys.push(best);
    });
    return keys;
  }
  function named(track, k) { return track.words[k].heard + '@' + track.words[k].start.toFixed(2); }

  // Marks each cue's key words, at most CFG.keyWords a line: where a line holds more, the first named keep it, so no
  // list a page names can break the cap. Returns the key words that lost it, in the order named.
  function emphasise(cues, keys) {
    var rank = {}, dropped = [];
    keys.forEach(function (k, i) { rank[k] = i; });
    var byRank = function (a, b) { return rank[a] - rank[b]; };
    cues.forEach(function (c) {
      var kept = [];
      c.lines.forEach(function (line) {
        line.filter(function (w) { return w in rank; }).sort(byRank).forEach(function (w, i) { (i < CFG.keyWords ? kept : dropped).push(w); });
      });
      c.emphasis = kept.sort(function (a, b) { return a - b; });
    });
    return dropped.sort(byRank);
  }

  // Cues by characters alone, for Node, where no page measures the words.
  function byChars(track, o) {
    var words = windowed(track, o.from, o.to), count = charCount(words);
    var fit = function (i, j) {
      var c = count(i, j);
      return { fits: c <= o.chars, full: Math.min(1, c / o.chars) };
    };
    var cues = reindexed(words, timed(words, shape(words, o, fit), o.to));
    emphasise(cues, keyWordsOf(o.keyWords, track));
    return cues;
  }
  function reindexed(words, cues) {
    return cues.map(function (c) {
      var map = function (k) { return words[k].index; };
      return { index: c.index, start: c.start, end: c.end, words: c.words.map(map), lines: c.lines.map(function (l) { return l.map(map); }) };
    });
  }

  // ---- the page -------------------------------------------------------------------------------------------------

  var state = typeof WeakMap === 'function' ? new WeakMap() : null;
  var fonts = 0;
  if (typeof document !== 'undefined' && document.fonts && document.fonts.addEventListener) {
    document.fonts.addEventListener('loadingdone', function () { fonts++; });
  }
  // Only what keeps the structure: lines stay the lines laid, and a word takes a transform. No rule has specificity,
  // so any rule of the page's wins.
  var STRUCTURE = ':where([data-captions] [data-line]){display:block;white-space:nowrap}:where([data-captions] [data-word]){display:inline-block}';
  function structure() {
    if (document.getElementById('openedit-captions-structure')) return;
    var style = document.createElement('style');
    style.id = 'openedit-captions-structure';
    style.textContent = STRUCTURE;
    (document.head || document.documentElement).appendChild(style);
  }

  function number(el, name, fallback, ok, wants) {
    var raw = el.getAttribute('data-' + name);
    if (raw === null || raw === '') return fallback;
    var v = Number(raw);
    if (!isFinite(v) || !ok(v)) fail('data-' + name + '="' + raw + '" is not ' + wants);
    return v;
  }
  function optionsOf(el) {
    var whole = function (v) { return v >= 1 && Math.floor(v) === v; };
    return {
      lines: number(el, 'lines', CFG.lines, whole, 'a whole number of 1 or more'),
      words: number(el, 'words', 0, whole, 'a whole number of 1 or more'),
      chars: number(el, 'chars', CFG.chars, whole, 'a whole number of 1 or more'),
      at: number(el, 'at', 0, function () { return true; }, 'a number of seconds'),
      from: number(el, 'from', 0, function (v) { return v >= 0; }, 'a number of seconds, 0 or more'),
      to: number(el, 'to', Infinity, function (v) { return v > 0; }, 'a number of seconds above 0'),
    };
  }

  function span(tag, attr, value) {
    var el = document.createElement(tag);
    el.setAttribute(attr, value);
    return el;
  }
  function wordEl(word, index, marks) {
    var el = span('span', 'data-word', String(index));
    if (marks[index]) el.setAttribute('data-emphasis', '');
    var text = word.text, lead = LEAD.exec(text), trail = TRAIL.exec(text.slice(lead ? lead[0].length : 0));
    var body = text.slice(lead ? lead[0].length : 0, text.length - (trail ? trail[0].length : 0));
    if (!body) { lead = null; trail = null; body = text; }
    if (lead) el.appendChild(span('span', 'data-punct', 'lead')).textContent = lead[0];
    el.appendChild(document.createTextNode(body));
    if (trail) el.appendChild(span('span', 'data-punct', 'trail')).textContent = trail[0];
    return el;
  }
  function lineEl(words, list, k, marks) {
    var line = span('div', 'data-line', String(k));
    list.forEach(function (w, i) {
      if (i) line.appendChild(document.createTextNode(' '));
      line.appendChild(wordEl(words[w], w, marks));
    });
    return line;
  }
  function marksOf(list) {
    var marks = {};
    list.forEach(function (w) { marks[w] = true; });
    return marks;
  }
  // The settled look, every word said, which is how a cue is measured and placed whatever frame first shows it.
  function rest(cueEl) {
    setVars(cueEl, { '--cue-since': 1000, '--cue-until': 1000, '--cue-progress': 1 });
    cueEl.querySelectorAll('[data-word]').forEach(function (w) { w.setAttribute('data-state', 'said'); setVars(w, { '--since': 1000, '--progress': 1 }); });
  }
  function setVars(el, vars) {
    for (var k in vars) el.style.setProperty(k, String(Math.round(vars[k] * 1000) / 1000));
  }

  // The size floor a render holds text to (0 in a browser): the words are measured at it, as they will be drawn.
  function floorOf() {
    var api = typeof window !== 'undefined' && window.__openedit;
    return api && typeof api.textFloor === 'function' ? api.textFloor() : 0;
  }
  function atFloor(root, floor) {
    if (!floor) return;
    root.querySelectorAll('[data-word]').forEach(function (w) {
      if (parseFloat(getComputedStyle(w).fontSize) < floor) w.style.setProperty('font-size', floor + 'px', 'important');
    });
  }

  // The words measured as the page lays them out, so lines fit the room the container gives them, in its own font.
  // Every key word named is measured as emphasised: one the cap leaves plain then takes no more room than it had.
  function measure(el, track, words, chars, keys) {
    el.textContent = '';
    var probe = span('div', 'data-cue', '');
    el.appendChild(probe);
    var wide = span('div', 'data-line', '0');
    wide.style.whiteSpace = 'normal';
    for (var m = 0; m < 400; m++) { var w = span('span', 'data-word', ''); w.textContent = 'M'; wide.appendChild(w); wide.appendChild(document.createTextNode(' ')); }
    probe.appendChild(wide);
    rest(probe);
    var cs = getComputedStyle(wide);
    var room = wide.offsetWidth - ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce(function (s, p) { return s + (parseFloat(cs[p]) || 0); }, 0);
    probe.textContent = '';
    var line = lineEl(track.words, words.map(function (w) { return w.index; }), 0, marksOf(keys));
    probe.appendChild(line);
    rest(probe);
    atFloor(line, floorOf());
    var spans = line.querySelectorAll(':scope > [data-word]');
    var left = [], right = [];
    for (var k = 0; k < spans.length; k++) { left.push(spans[k].offsetLeft); right.push(spans[k].offsetLeft + spans[k].offsetWidth); }
    el.textContent = '';
    var count = charCount(words);
    return function (i, j) {
      var c = count(i, j);
      var width = right[j - 1] - left[i];
      // A container with no width (hidden, say) has nothing to measure against, so the characters alone decide. A
      // pixel of slack, as layout reports whole pixels.
      var wide = room > 0 && width > room + 1;
      return { fits: c <= chars && !wide, full: Math.min(1, Math.max(c / chars, room > 0 ? width / room : 0)) };
    };
  }

  function layout(el, s) {
    var o = optionsOf(el), track = pick(el.getAttribute('data-transcript')), listed = el.getAttribute('data-key-words');
    var key = [track.path, o.lines, o.words, o.chars, o.from, o.to, listed, el.offsetWidth, fonts, floorOf()].join('|');
    if (s.key === key) return;
    var words = windowed(track, o.from, o.to), missed = [], keys = keyWordsOf(listed, track, missed);
    var fit = measure(el, track, words, o.chars, keys);
    s.key = key;
    s.track = track;
    s.o = o;
    s.cues = reindexed(words, timed(words, shape(words, o, fit), o.to));
    var dropped = emphasise(s.cues, keys).map(function (k) { return named(track, k); });
    var notes = missed.map(function (m) { return 'openeditCaptions: ' + m; });
    if (dropped.length) notes.push('openeditCaptions: a line emphasises at most ' + CFG.keyWords + ' key words, the first named, so ' +
      dropped.join(', ') + (dropped.length === 1 ? ' is' : ' are') + ' not emphasised');
    // A layout runs again when the width or fonts change; a note already given is not repeated.
    notes.forEach(function (n) { if ((s.notes || []).indexOf(n) < 0) console.warn(n); });
    s.notes = notes;
    s.shown = -1;
    s.cueEl = null;
    s.placing = null;
  }

  function cueAt(cues, c) {
    var lo = 0, hi = cues.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (cues[mid].end <= c) lo = mid + 1;
      else if (cues[mid].start > c) hi = mid - 1;
      else return mid;
    }
    return -1;
  }

  function cueNode(s, k) {
    var cue = s.cues[k], words = s.track.words;
    var cueEl = span('div', 'data-cue', String(k));
    var marks = marksOf(cue.emphasis);
    cue.lines.forEach(function (list, i) { cueEl.appendChild(lineEl(words, list, i, marks)); });
    return cueEl;
  }

  // Where cue k is laid out, settled, unmoved and at the size the render holds text to: built alone in the container,
  // which holds no other cue while the placer measures, and taken out again whatever happens.
  function measureCue(el, s, k) {
    var probe = cueNode(s, k);
    el.appendChild(probe);
    try {
      rest(probe);
      atFloor(probe, floorOf());
      var r = probe.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    } finally {
      el.removeChild(probe);
    }
  }

  // A faces.js from before placer(), loaded first, is the one whose openeditFaces the page has.
  function older() {
    var loaded = [].slice.call(document.querySelectorAll('script[src]')).map(function (sc) { return sc.getAttribute('src'); })
      .filter(function (src) { return /faces[^\/?#]*\.js([?#]|$)/.test(src); });
    fail((loaded.length > 1 ? 'of ' + loaded.join(', ') + ', the first loaded' : (loaded[0] || 'the page\'s faces.js')) +
      ' was written by an older openedit and has no openeditFaces.placer, which captions.js needs: load the faces.js that "openedit faces <clip>" prints instead');
  }

  // The cues as one faces.js placer, so they hold one place through each shot: made again when the cues, or the clip,
  // video or [data-safe] the container names, change.
  function placerOf(el, s) {
    var faces = window.openeditFaces, within = el.closest('[data-safe]'), clip = el.getAttribute('data-clip'), named = el.getAttribute('data-video');
    var video = named ? document.querySelector(named) : null;
    if (named && !video) fail('data-video="' + named + '" matches no element');
    if (s.placing && s.placing.within === within && s.placing.clip === clip && s.placing.video === video) return s.placing.placer;
    if (typeof faces.placer !== 'function') older();
    // A note said once stays said when the cues are laid again.
    var notes = s.faceNotes = s.faceNotes || {};
    var options = { what: 'the captions', say: function (line) { if (!notes[line]) { notes[line] = true; console.warn(line); } } };
    if (clip) options.clip = clip;
    if (video) options.video = video;
    var spans = s.cues.map(function (c) { return { from: c.start, to: c.end }; });
    s.placing = { within: within, clip: clip, video: video, placer: faces.placer(spans, function (k) { return measureCue(el, s, k); }, options) };
    return s.placing.placer;
  }
  function placeCue(placer, s, k, c) {
    s.part = placer.part(k, c);
    placer.place(s.cueEl, k, c);
  }

  function show(el, s, k, c) {
    el.textContent = '';
    s.cueEl = null;
    s.shown = k;
    if (k < 0) return;
    // The cues of the shots this one is up in are measured now, while the container is empty, so measuring never
    // touches a cue on screen.
    var placer = window.openeditFaces ? placerOf(el, s) : null;
    if (placer) placer.prepare(k);
    var cueEl = cueNode(s, k);
    el.appendChild(cueEl);
    rest(cueEl);
    s.cueEl = cueEl;
    if (placer) placeCue(placer, s, k, c);
  }

  // The cue on screen at page second t, and each word's state in it.
  function draw(el, t) {
    var s = state.get(el);
    if (!s) { s = {}; state.set(el, s); }
    layout(el, s);
    // A microsecond on, so a frame due at the very instant a word starts, rounded a hair low, shows it.
    var c = t - s.o.at + s.o.from + 1e-6;
    var k = cueAt(s.cues, c);
    if (k !== s.shown || (k >= 0 && s.cueEl && s.cueEl.parentNode !== el)) show(el, s, k, c);
    // A cue up across a cut takes the next shot's place there, left in the state it is drawn in.
    else if (k >= 0 && s.placing && s.placing.placer.part(k, c) !== s.part) placeCue(s.placing.placer, s, k, c);
    if (k < 0) return;
    var cue = s.cues[k], words = s.track.words;
    setVars(s.cueEl, { '--cue-since': c - cue.start, '--cue-until': cue.end - c, '--cue-progress': Math.min(1, Math.max(0, (c - cue.start) / (cue.end - cue.start))) });
    var spans = s.cueEl.querySelectorAll('[data-word]');
    cue.words.forEach(function (w, i) {
      var word = words[w], next = cue.words[i + 1] !== undefined ? words[cue.words[i + 1]] : null;
      var said = next ? c >= next.start : c >= word.end;
      spans[i].setAttribute('data-state', c < word.start ? 'next' : said ? 'said' : 'now');
      var long = word.end - word.start;
      setVars(spans[i], { '--since': c - word.start, '--progress': long > 0 ? Math.min(1, Math.max(0, (c - word.start) / long)) : c >= word.start ? 1 : 0 });
    });
    // A look the page gives a cue as it is said, larger than the settled one it was placed for, can reach a face.
    if (s.placing) s.placing.placer.check(s.cueEl, k, c);
  }

  function tick(ms) {
    var t = ms / 1000;
    structure();
    document.querySelectorAll('[data-captions]').forEach(function (el) { draw(el, t); });
    requestAnimationFrame(tick);
  }

  window.openeditCaptions = {
    add: function (track) {
      // 'heard' keeps the text as transcribed, by which a key word is still named once the page changes 'text'.
      var words = track.words.map(function (w) { return { text: String(w[0]), heard: String(w[0]), start: w[1], end: w[2] }; });
      tracks = tracks.filter(function (t) { return t.path !== track.path; }).concat([{ name: track.name, path: track.path, words: words }]);
    },
    // The track's words, text and times. A page may change a word's text here before its first frame, to show it
    // another way (a number in digits, say); its times are the speech's.
    words: function (name) { return pick(name).words; },
    cues: function (name, options) {
      var o = options || {};
      return byChars(pick(name), { lines: o.lines || CFG.lines, words: o.words || 0, chars: o.chars || CFG.chars, from: o.from || 0, to: o.to === undefined ? Infinity : o.to, keyWords: o.keyWords });
    },
    // The cues a container lays, in page seconds, and the cue and word on screen there at page second t.
    laid: function (el) {
      var s = state && state.get(el);
      if (!s || !s.cues) return [];
      return s.cues.map(function (c) { return { index: c.index, start: c.start - s.o.from + s.o.at, end: c.end - s.o.from + s.o.at, words: c.words, lines: c.lines, emphasis: c.emphasis }; });
    },
  };
  if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined') requestAnimationFrame(tick);
})();
`.replace('__CONFIG__', JSON.stringify(CONFIG));

/** The first line of every captions.js, by which the command knows a file it may write over. */
export const HEADER = '// openedit captions:';

/** The words of a transcript as the page takes them: trimmed, timed, in the order spoken. */
export function trackOf(path: string, name: string, words: { text: string; timestamp: [number, number] }[]): CaptionTrack {
  const ms = (s: number) => Math.round(s * 1000) / 1000;
  const list = words
    .filter((w) => w.text.trim() && Number.isFinite(w.timestamp[0]))
    .map((w): CaptionWord => [w.text.trim(), ms(w.timestamp[0]), ms(Math.max(w.timestamp[0], Number.isFinite(w.timestamp[1]) ? w.timestamp[1] : w.timestamp[0]))]);
  return { name, path, words: list.map((w, i) => [w, i] as const).sort((a, b) => a[0][1] - b[0][1] || a[1] - b[1]).map(([w]) => w) };
}

/** The captions.js a page loads for this track. */
export function captionsScript(track: CaptionTrack): string {
  // ASCII throughout, so a page that declares no charset still reads every word as written.
  const data = JSON.stringify(track).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `${HEADER} ${track.path.replace(/[^\x20-\x7e]/g, '?')}\n${PAGE_SOURCE.trim()}\nwindow.openeditCaptions.add(${data});\n`;
}

/** The cue shaping, evaluated in Node from the same source the page runs. */
export function captionsApi(...add: CaptionTrack[]): CaptionsApi {
  const window: { openeditCaptions?: CaptionsApi } = {};
  runInNewContext(PAGE_SOURCE, { window });
  const api = window.openeditCaptions!;
  for (const track of add) api.add(track);
  // Plain data out of the context, so the cues compare and print like any other value.
  return { add: (track) => api.add(track), cues: (name, options) => JSON.parse(JSON.stringify(api.cues(name, options))) as Cue[] };
}
