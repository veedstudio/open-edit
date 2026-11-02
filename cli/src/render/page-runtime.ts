// The script injected into every page before any of its own code runs. It replaces the page's sense
// of time with a virtual clock the renderer advances one frame at a time, so a frame is a function of
// its index alone: not of how fast the machine is, and not of which worker rendered it.
//
// Kept as plain JavaScript source, not a function to be stringified: a transpiler may wrap named
// functions in helpers that do not exist inside the page.

import { SPEAKER_FN } from './speaker.ts';

export interface RuntimeConfig {
  seed: number;
  /** Date.now() at frame 0, in ms since the epoch. */
  epoch: number;
  num: number;
  den: number;
  /** The fraction of the canvas each frame is captured at: a CSS pixel is drawn at this times the device's pixels. */
  captureScale: number;
  /** Marks the speaker layer's cut-out inside its closed shadow root, where the session finds it to show or hide it. */
  speakerKey: string;
}

/** What `__openedit.ready()` reports back once the page has loaded. */
export interface ReadyInfo {
  stage: { width: number; height: number; left: number; top: number } | null;
  /** Each URL a playable <video> on the page plays, once. */
  videos: {
    url: string;
    /** The picture's own size, as the page sees it (a rotated clip is already upright). */
    width: number;
    height: number;
    /**
     * The largest ratio of a box the picture is drawn in to the picture, over the elements playing it;
     * null when any of them is hidden, since a hidden video may be drawn into a canvas at full size.
     */
    scale: number | null;
  }[];
  /** The URLs of <video> elements that could not be played: a format Chrome has no decoder for, or a failed load. */
  unplayable: string[];
  /** The speaker layer's cut-out, when the stage names one, and whether Chrome could play it. */
  cutout: { url: string; playable: boolean } | null;
  /** Media that could not be played, for the warning list. */
  problems: string[];
  /** The page carries a `data-stateless` mark: it draws each frame from the time alone, so a worker may jump to any frame. */
  stateless: boolean;
}

/** What a frame fails with when it draws a video larger than the smaller copy the video is served from. */
export const DRAWN_LARGER = 'is drawn larger than the copy made at the size the page showed it on load';

const SOURCE = String.raw`
(() => {
  if (window.__openedit) return;
  const CFG = __CONFIG__;
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  const RealDate = window.Date;
  let now = 0;

  let seed = CFG.seed >>> 0;
  Math.random = function random() {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  window.performance.now = function now_() { return now; };

  function VirtualDate(...args) {
    if (!new.target) return new RealDate(CFG.epoch + now).toString();
    return Reflect.construct(RealDate, args.length ? args : [CFG.epoch + now], new.target);
  }
  VirtualDate.prototype = RealDate.prototype;
  VirtualDate.now = function dateNow() { return CFG.epoch + now; };
  VirtualDate.parse = RealDate.parse;
  VirtualDate.UTC = RealDate.UTC;
  window.Date = VirtualDate;

  // A report must not interrupt the frame that raised it, and must still reach the renderer as an
  // uncaught error, the way it would have in a real frame.
  const report = (e) => realSetTimeout(() => { throw e; });

  let nextTimer = 1;
  let inTimer = false;
  const timers = new Map();
  function addTimer(fn, delay, args, repeat) {
    if (typeof fn !== 'function') { const code = String(fn); fn = () => (0, eval)(code); }
    let d = Number(delay) || 0;
    if (d < 0) d = 0;
    // A timer armed from a timer, or an interval, waits at least 1 ms, so a callback that re-arms
    // itself at 0 advances virtual time instead of spinning at one instant.
    if (inTimer || repeat) d = Math.max(d, 1);
    const id = nextTimer++;
    timers.set(id, { id, due: now + d, fn, args, repeat: repeat ? d : 0 });
    return id;
  }
  window.setTimeout = function setTimeout(fn, delay, ...args) { return addTimer(fn, delay, args, false); };
  window.setInterval = function setInterval(fn, delay, ...args) { return addTimer(fn, delay, args, true); };
  window.clearTimeout = function clearTimeout(id) { timers.delete(id); };
  window.clearInterval = function clearInterval(id) { timers.delete(id); };
  function runTimers(t) {
    for (;;) {
      let next = null;
      for (const tm of timers.values()) {
        if (tm.due <= t && (!next || tm.due < next.due || (tm.due === next.due && tm.id < next.id))) next = tm;
      }
      if (!next) return;
      now = Math.max(now, next.due);
      if (next.repeat) next.due += next.repeat; else timers.delete(next.id);
      inTimer = true;
      try { next.fn.apply(window, next.args); } catch (e) { report(e); } finally { inTimer = false; }
    }
  }

  let nextRaf = 1;
  let rafQueue = new Map();
  window.requestAnimationFrame = function requestAnimationFrame(cb) { const id = nextRaf++; rafQueue.set(id, cb); return id; };
  window.cancelAnimationFrame = function cancelAnimationFrame(id) { rafQueue.delete(id); };
  function runRaf(t) {
    const q = rafQueue;
    rafQueue = new Map();
    for (const cb of q.values()) { try { cb(t); } catch (e) { report(e); } }
  }

  // An animation's local time is measured from when it began in virtual time: page load for any
  // that exist before the first frame, creation for element.animate(), first sighting for the rest.
  const born = new WeakMap();
  let started = false;
  const realAnimate = Element.prototype.animate;
  Element.prototype.animate = function animate(...args) {
    const a = realAnimate.apply(this, args);
    born.set(a, now);
    return a;
  };
  // Each frame seeks animations twice, before __seek and after it. The second seek pins only what the
  // first could not have (animations __seek or the turn after it started), and never overrides a time
  // the page set after the first: that is how __seek places a scene that starts later than frame 0.
  let pinned = new WeakSet();
  let placed = new WeakMap();
  let seeking = false;
  for (const prop of ['currentTime', 'startTime']) {
    const d = Object.getOwnPropertyDescriptor(Animation.prototype, prop);
    Object.defineProperty(Animation.prototype, prop, {
      ...d,
      set(v) {
        d.set.call(this, v);
        // A start time places the animation against the document timeline, which runs on in real time
        // until the capture, so the time it produced is read back and kept.
        if (!seeking) placed.set(this, prop === 'currentTime' ? v : this.currentTime);
      },
    });
  }
  function seekAnimations(t, again) {
    if (!again) pinned = new WeakSet();
    seeking = true;
    try {
      for (const a of document.getAnimations()) {
        if (a.timeline && a.timeline !== document.timeline) continue;
        let b = born.get(a);
        if (b === undefined) { b = t; born.set(a, b); }
        try {
          if (again && placed.has(a)) {
            // Frozen where the page put it, since a playing animation moves on in real time before the capture.
            const given = placed.get(a);
            if (a.playState !== 'paused') a.pause();
            if (given !== null) a.currentTime = given;
            continue;
          }
          if (again && pinned.has(a) && a.playState === 'paused') continue;
          if (a.playState !== 'paused') a.pause();
          a.currentTime = t - b;
          pinned.add(a);
        } catch (e) {
          problems.add('animation ' + (a.animationName || a.transitionProperty || a.id || '(unnamed)') + ' refused a seek: ' + e.message);
        }
      }
    } finally {
      seeking = false;
    }
    // Only a time set from here on, in __seek or the turn after it, is the page's placement for this frame.
    if (!again) placed = new WeakMap();
  }

  let gsapTuned = false;
  function gsapOf() {
    const g = window.gsap;
    return g && g.globalTimeline && typeof g.globalTimeline.seek === 'function' ? g : null;
  }
  function tuneGsap() {
    const g = gsapOf();
    // Lag smoothing reads a jump in time as a stall and slows the clock; a seek is not a stall.
    if (g && !gsapTuned && g.ticker && typeof g.ticker.lagSmoothing === 'function') { g.ticker.lagSmoothing(0); gsapTuned = true; }
  }

  function within(promise, ms, what, hint) {
    let timer;
    const late = what + ' did not finish within ' + Math.round(ms / 1000) + ' s' + (hint ? '; ' + hint : '');
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = realSetTimeout(() => reject(new Error(late)), ms); }),
    ]).finally(() => realClearTimeout(timer));
  }
  const videoName = (v) => v.currentSrc || v.src || (v.querySelector('source') || {}).src || '<video>';
  // How much of the picture Chrome draws: its box over its frame, with the cover factor for every fit
  // but 'none', since cover needs at least what contain does. A hidden one (no box, invisible, or
  // transparent anywhere up the tree) may be drawn into a canvas at full size, so it reports unknown.
  function drawnScale(v) {
    if (!v.videoWidth || !v.videoHeight) return null;
    const r = v.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    // One off the viewport, or a few pixels across, may be there only to feed a canvas, whose size its box does not tell.
    if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight || r.width < 8 || r.height < 8) return null;
    const own = getComputedStyle(v);
    // Visibility is inherited and the computed value is the one that counts; opacity is not, so a
    // transparent ancestor hides the video without showing in its own style.
    if (own.visibility === 'hidden') return null;
    for (let n = v; n && n.nodeType === 1; n = n.parentElement) if (parseFloat(getComputedStyle(n).opacity) === 0) return null;
    if (own.objectFit === 'none') return 1;
    const dpr = (window.devicePixelRatio || 1) * CFG.captureScale;
    return Math.max((r.width * dpr) / v.videoWidth, (r.height * dpr) / v.videoHeight);
  }
  function playing(videos) {
    const byUrl = new Map();
    for (const v of videos) {
      const scale = drawnScale(v);
      const seen = byUrl.get(v.currentSrc);
      if (!seen) { byUrl.set(v.currentSrc, { url: v.currentSrc, width: v.videoWidth, height: v.videoHeight, scale }); continue; }
      seen.scale = seen.scale === null || scale === null ? null : Math.max(seen.scale, scale);
    }
    return [...byUrl.values()];
  }
  const once = (el, names) => new Promise((resolve) => {
    const done = () => { for (const n of names) el.removeEventListener(n, done); resolve(); };
    for (const n of names) el.addEventListener(n, done);
  });

  // 0.1 ms past the frame's own time: i/fps rounds either side of a video frame that starts at exactly
  // that instant, and Chrome shows the frame before it whenever it rounds low.
  function videoTarget(v, sec) {
    const t = sec + 1e-4;
    const d = v.duration;
    if (!Number.isFinite(d) || d <= 0) return t;
    if (v.loop) return t % d;
    return Math.min(t, Math.max(0, d - 0.001));
  }
  // A video that cannot load or decode is reported, not fatal: the frame renders without it, the way a
  // missing image does, and the renderer lists it at the end.
  const problems = new Set();
  // A <video> whose <source> children all fail fires its errors at them and sets none of its own. Its
  // NETWORK_NO_SOURCE state cannot tell that apart from a load() still starting, which passes through the
  // same state for a task, so the failures are counted from the <source> elements themselves.
  const failedSources = new WeakSet();
  window.addEventListener('error', (e) => { if (e.target instanceof HTMLSourceElement) failedSources.add(e.target); }, true);
  window.addEventListener('loadstart', (e) => {
    if (e.target instanceof HTMLMediaElement) for (const s of e.target.querySelectorAll('source')) failedSources.delete(s);
  }, true);
  const sourceless = (v) => !v.srcObject && !v.hasAttribute('src') && [...v.querySelectorAll('source')].every((s) => failedSources.has(s));
  const playable = (v) => !v.error && !sourceless(v);
  // Videos with no source at all when the page became ready. Timers, requestAnimationFrame and __seek run
  // only in frames, and any of them may give one a source, so the verdict waits for the first frame.
  const unsourced = new Set();
  // Files served from a copy smaller than the source, made at the size the page showed them on load, keyed
  // as the server keys them: by path, whatever query or fragment a later URL adds.
  let shrunk = new Set();
  const fileKey = (url) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; } };
  // Videos the renderer lays under the frames itself: hidden, unloaded, and never seeked or reported.
  const stoodDown = new WeakSet();
  let lastVideos = [];
  // The speaker layer, when the stage names a cut-out: handed over inside this closure, since its cut-out lies in a
  // closed shadow root that document queries do not reach.
  let speaker = null;
  const speakerVideo = () => (speaker ? [speaker.video] : []);
  const liveVideos = () => [...document.querySelectorAll('video'), ...speakerVideo()].filter((v) => !stoodDown.has(v));

  // Chrome fires 'seeked' before the compositor holds the new picture, so a capture straight after it
  // can show the previous one. Each video's presented-frame count is followed, and a frame whose seek
  // moved a video waits until a picture newer than that seek has been presented. Chrome presents one
  // after every seek, hidden or detached videos included, so one that never comes fails the frame
  // rather than let it show the previous picture.
  const presented = new WeakMap();
  function track(v) {
    let s = presented.get(v);
    if (s) return s;
    s = { count: 0, waiters: [] };
    presented.set(v, s);
    const loop = (_, meta) => {
      s.count = meta.presentedFrames;
      for (const w of s.waiters.splice(0)) w();
      v.requestVideoFrameCallback(loop);
    };
    v.requestVideoFrameCallback(loop);
    return s;
  }
  function presentedAfter(v, count, ms) {
    const s = track(v);
    if (s.count > count) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = realSetTimeout(() => resolve(false), ms);
      s.waiters.push(() => { realClearTimeout(timer); resolve(true); });
    });
  }
  // A <video> whose <source> children all fail to load fires its errors at them, never at itself, so
  // the wait also ends once the element has no source left to try.
  async function loaded(v, budget) {
    let settled = false;
    const sourceless = new Promise((resolve) => {
      const poll = () => { if (settled) return; if (!playable(v)) resolve(); else realSetTimeout(poll, 50); };
      realSetTimeout(poll, 50);
    });
    try {
      await within(Promise.race([once(v, ['seeked', 'loadeddata', 'error']), sourceless]), budget, 'video ' + videoName(v));
    } finally {
      settled = true;
    }
  }
  async function presentVideo(v, budget, before) {
    if (playable(v) && (v.seeking || v.readyState < 2)) await loaded(v, budget);
    if (v.error) {
      problems.add('video ' + videoName(v) + ' could not be played: ' + (v.error.message || 'media error ' + v.error.code));
      return;
    }
    if (before && Math.abs(v.currentTime - before.time) > 1e-6 && !(await presentedAfter(v, before.count, budget))) {
      throw new Error('video ' + videoName(v) + ' presented no picture within ' + Math.round(budget / 1000) + ' s of its seek to '
        + v.currentTime.toFixed(3) + ' s, so the frame would show the previous one');
    }
  }
  function drainProblems() {
    const out = [...problems];
    problems.clear();
    return out;
  }

  async function settleImages(budget) {
    // A broken image counts as complete, so one that has nothing to show is asked too; decode() then
    // tells it from an SVG without a size of its own, which decodes.
    const pending = [...document.images].filter((im) => !im.complete || (im.currentSrc && im.naturalWidth === 0));
    const shown = (im) => im.decode().catch(() => { problems.add('image ' + (im.currentSrc || im.src) + ' could not be loaded or decoded'); });
    if (pending.length) await within(Promise.all(pending.map(shown)), budget, pending.length + ' image(s)');
  }
  async function settleFonts(budget) {
    void (document.body && document.body.offsetHeight);
    if (document.fonts.status === 'loading') await within(document.fonts.ready, budget, 'fonts');
  }

  // Videos the page set a time on in this frame. A time of 0 is as much a placement as any other (a
  // scene that starts on this frame), so it is the write that counts, not the value it left.
  let pageTimed = new WeakSet();
  const mediaTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    ...mediaTime,
    set(v) {
      mediaTime.set.call(this, v);
      pageTimed.add(this);
    },
  });

  async function frame(i, budget) {
    const t = (i * CFG.den * 1000) / CFG.num;
    const sec = t / 1000;
    // The first frame a worker runs need not be 0 (a stateless page is jumped into), so whatever
    // animates before it is dated from the page's load, not from this frame.
    if (!started) { for (const a of document.getAnimations()) born.set(a, 0); started = true; }
    pageTimed = new WeakSet();
    runTimers(t);
    now = t;
    tuneGsap();
    runRaf(t);
    seekAnimations(t, false);
    const g = gsapOf();
    if (g) g.globalTimeline.seek(sec, false);
    // The speaker's box, if a script of the page dropped it, goes back before its picture is sought.
    let speakerBack = speaker ? speaker.sync() : false;
    // A video plays from frame 0 by default; a page that places one elsewhere sets its time in __seek,
    // which runs after this and wins.
    let videos = liveVideos();
    const snapshot = () => {
      const at = new Map();
      for (const v of videos) if (playable(v)) at.set(v, { count: track(v).count, time: v.currentTime });
      return at;
    };
    const before = snapshot();
    for (const v of videos) {
      if (!playable(v)) continue;
      if (!v.paused) v.pause();
      const target = videoTarget(v, sec);
      if (Math.abs(v.currentTime - target) > 1e-6) mediaTime.set.call(v, target);
    }
    // The default seek's picture is presented before __seek can move the video again. A picture Chrome
    // presents late for it would otherwise count as the one for __seek's time, and the frame would show
    // the default time's picture (the clip's last, once the page time is past its end) for one frame.
    await Promise.all(videos.map((v) => presentVideo(v, budget, before.get(v))));
    if (typeof window.__seek === 'function') {
      const placed = snapshot();
      await within(Promise.resolve(window.__seek(sec)), budget, 'window.__seek(' + sec + ')',
        'the clock stands still while it runs, so it must not wait on requestAnimationFrame or a timer');
      await Promise.all(videos.map((v) => presentVideo(v, budget, placed.get(v))));
    }
    // A video __seek gave a source to, or made, plays from frame 0 like any other: it is put at this
    // frame's time unless the page set its time in this frame. Either way it is sought once it has data
    // and its picture waited for: a time set before then is only a start position, which Chrome need not
    // present a picture for, so the frame it appeared in would show none.
    videos = liveVideos();
    await Promise.all(videos.filter((v) => !before.has(v) && playable(v)).map(async (v) => {
      if (v.readyState < 2) await loaded(v, budget);
      if (!playable(v)) return presentVideo(v, budget, null);
      if (!v.paused) v.pause();
      // The load's own picture, when Chrome presents one now, must not pass for the seek's.
      await presentedAfter(v, track(v).count, 250);
      const at = pageTimed.has(v) ? v.currentTime : videoTarget(v, sec);
      const was = { count: track(v).count, time: -1 };
      mediaTime.set.call(v, at);
      await presentVideo(v, budget, was);
    }));
    // One task's turn, so work a framework queued behind this frame (React's scheduler posts to a
    // MessageChannel) lands before the capture rather than after it.
    await new Promise((resolve) => { const ch = new MessageChannel(); ch.port1.onmessage = () => resolve(); ch.port2.postMessage(0); });
    for (const v of unsourced) if (!v.srcObject && !v.hasAttribute('src') && !v.querySelector('source')) problems.add('video ' + videoName(v) + ': it has no source');
    unsourced.clear();
    // Animations that __seek or that turn started are pinned to this frame too, not left running.
    seekAnimations(t, true);
    // The speaker layer takes the footage layer's placing as it now stands, whatever the page did this frame. A box
    // that went back has no picture until one is presented again: Chrome skips a seek to the time already shown, so
    // the cut-out is sought a hair later, to the same picture, and waited for like any other.
    if (speaker && speaker.sync()) speakerBack = true;
    if (speakerBack && playable(speaker.video)) {
      const v = speaker.video;
      const was = { count: track(v).count, time: -1 };
      mediaTime.set.call(v, videoTarget(v, sec) + 1e-4);
      await presentVideo(v, budget, was);
    }
    await settleImages(budget);
    await settleFonts(budget);
    // A copy made at the size a video was shown on load cannot show it larger: the frame fails, and the
    // renderer makes the render again from full-size copies.
    for (const v of liveVideos()) {
      if (!playable(v) || !shrunk.has(fileKey(v.currentSrc))) continue;
      const s = drawnScale(v);
      if (s !== null && s > 1 + 2 / Math.min(v.videoWidth, v.videoHeight)) throw new Error('video ' + videoName(v) + ' ' + ${JSON.stringify(DRAWN_LARGER)});
    }
    return drainProblems();
  }

  window.__openedit = {
    shrunk(urls) {
      shrunk = new Set(urls.map(fileKey));
    },
    // The URLs each <video> would play, for the renderer to match against the footage it lays itself:
    // the one chosen when a choice has been made, else every candidate.
    videoSources() {
      lastVideos = [...document.querySelectorAll('video')];
      return lastVideos.map((v) => (v.currentSrc ? [v.currentSrc] : [v.src, ...[...v.querySelectorAll('source')].map((s) => s.src)].filter(Boolean)));
    },
    // Unloads and hides the videos flagged among the last videoSources(): the element stays, so the page's
    // layout does, but Chrome holds no decoder for it and no frame seeks it.
    standDown(flags) {
      lastVideos.forEach((v, i) => {
        if (!flags[i]) return;
        stoodDown.add(v);
        v.removeAttribute('src');
        for (const s of v.querySelectorAll('source')) s.remove();
        v.load();
        v.style.setProperty('visibility', 'hidden', 'important');
      });
    },
    async ready(budget) {
      for (const v of [...document.querySelectorAll('video, audio'), ...speakerVideo()]) { v.autoplay = false; v.muted = true; if (!v.paused) v.pause(); }
      await within(Promise.all([...document.fonts].map((f) => f.load().catch(() => {}))), budget, 'loading fonts');
      await within(document.fonts.ready, budget, 'fonts');
      for (const f of document.fonts) {
        if (f.status === 'error') problems.add('font ' + f.family + ' ' + f.weight + ' ' + f.style + ' failed to load, so its text falls back to another face');
      }
      await settleImages(budget);
      const videos = liveVideos();
      for (const v of videos) { if (v.preload !== 'auto') v.preload = 'auto'; if (v.readyState === 0 && v.networkState !== 3) v.load(); }
      await Promise.all(videos.map((v) => presentVideo(v, budget, null)));
      for (const v of videos) {
        if (playable(v)) { track(v); continue; }
        if (v.error) continue;
        const sources = [...v.querySelectorAll('source')];
        if (!sources.length) { unsourced.add(v); continue; }
        // Blaming the format only when every source declares one Chrome refuses: a source that did not
        // load is already named by its own failed-load line, and transcoding would not bring it back.
        const unplayable = sources.every((s) => s.type && v.canPlayType(s.type) === '');
        problems.add('video ' + videoName(v) + (unplayable ? ': none of its sources is one Chrome can play' : ': none of its sources loaded'));
      }
      const el = document.querySelector('#stage, [data-stage]');
      let stage = null;
      if (el) {
        const r = el.getBoundingClientRect();
        const width = Math.round(el.offsetWidth || r.width);
        const height = Math.round(el.offsetHeight || r.height);
        if (width > 0 && height > 0) stage = { width, height, left: Math.round(r.left + window.scrollX), top: Math.round(r.top + window.scrollY) };
      }
      const owned = speakerVideo()[0];
      const cutout = owned ? { url: owned.currentSrc || owned.src, playable: playable(owned) && owned.videoWidth > 0 } : null;
      const unplayable = videos.filter((v) => !playable(v)).map((v) => v.currentSrc || v.src).filter(Boolean);
      return { stage, videos: playing(videos.filter(playable)), unplayable, cutout, problems: drainProblems(), stateless: document.querySelector('[data-stateless]') !== null };
    },
    frame,
    async preroll(from, to, budget) {
      const seen = [];
      for (let i = from; i < to; i++) seen.push(...await frame(i, budget));
      return seen;
    },
  };
  (${SPEAKER_FN})((parts) => { speaker = parts; }, CFG.speakerKey);
})();
`;

export function runtimeScript(cfg: RuntimeConfig): string {
  return SOURCE.replace('__CONFIG__', JSON.stringify(cfg));
}
