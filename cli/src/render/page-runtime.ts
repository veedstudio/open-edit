// The script injected into every page before any of its own code runs. It replaces the page's sense
// of time with a virtual clock the renderer advances one frame at a time, so a frame is a function of
// its index alone: not of how fast the machine is, and not of which worker rendered it.
//
// Kept as plain JavaScript source, not a function to be stringified: a transpiler may wrap named
// functions in helpers that do not exist inside the page.

export interface RuntimeConfig {
  seed: number;
  /** Date.now() at frame 0, in ms since the epoch. */
  epoch: number;
  num: number;
  den: number;
}

/** What `__openedit.ready()` reports back once the page has loaded. */
export interface ReadyInfo {
  stage: { width: number; height: number; left: number; top: number } | null;
  /** The URL each playable <video> on the page plays. */
  videos: string[];
  /** Media that could not be played, for the warning list. */
  problems: string[];
}

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
  // that exist before frame 0, creation for element.animate(), first sighting for the rest.
  const born = new WeakMap();
  let started = false;
  const realAnimate = Element.prototype.animate;
  Element.prototype.animate = function animate(...args) {
    const a = realAnimate.apply(this, args);
    born.set(a, started ? now : 0);
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
        if (b === undefined) { b = started ? t : 0; born.set(a, b); }
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

  async function frame(i, budget) {
    const t = (i * CFG.den * 1000) / CFG.num;
    const sec = t / 1000;
    runTimers(t);
    now = t;
    tuneGsap();
    runRaf(t);
    seekAnimations(t, false);
    started = true;
    const g = gsapOf();
    if (g) g.globalTimeline.seek(sec, false);
    // A video plays from frame 0 by default; a page that places one elsewhere sets its time in __seek,
    // which runs after this and wins.
    const videos = [...document.querySelectorAll('video')];
    const before = new Map();
    for (const v of videos) {
      if (!playable(v)) continue;
      before.set(v, { count: track(v).count, time: v.currentTime });
      if (!v.paused) v.pause();
      const target = videoTarget(v, sec);
      if (Math.abs(v.currentTime - target) > 1e-6) v.currentTime = target;
    }
    if (typeof window.__seek === 'function') {
      await within(Promise.resolve(window.__seek(sec)), budget, 'window.__seek(' + sec + ')',
        'the clock stands still while it runs, so it must not wait on requestAnimationFrame or a timer');
    }
    await Promise.all(videos.map((v) => presentVideo(v, budget, before.get(v))));
    // One task's turn, so work a framework queued behind this frame (React's scheduler posts to a
    // MessageChannel) lands before the capture rather than after it.
    await new Promise((resolve) => { const ch = new MessageChannel(); ch.port1.onmessage = () => resolve(); ch.port2.postMessage(0); });
    for (const v of unsourced) if (!v.srcObject && !v.hasAttribute('src') && !v.querySelector('source')) problems.add('video ' + videoName(v) + ': it has no source');
    unsourced.clear();
    // Animations that __seek or that turn started are pinned to this frame too, not left running.
    seekAnimations(t, true);
    await settleImages(budget);
    await settleFonts(budget);
    return drainProblems();
  }

  window.__openedit = {
    async ready(budget) {
      for (const v of document.querySelectorAll('video, audio')) { v.autoplay = false; v.muted = true; if (!v.paused) v.pause(); }
      await within(Promise.all([...document.fonts].map((f) => f.load().catch(() => {}))), budget, 'loading fonts');
      await within(document.fonts.ready, budget, 'fonts');
      for (const f of document.fonts) {
        if (f.status === 'error') problems.add('font ' + f.family + ' ' + f.weight + ' ' + f.style + ' failed to load, so its text falls back to another face');
      }
      await settleImages(budget);
      const videos = [...document.querySelectorAll('video')];
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
      return { stage, videos: videos.filter(playable).map((v) => v.currentSrc), problems: drainProblems() };
    },
    frame,
    async preroll(from, to, budget) {
      const seen = [];
      for (let i = from; i < to; i++) seen.push(...await frame(i, budget));
      return seen;
    },
  };
})();
`;

export function runtimeScript(cfg: RuntimeConfig): string {
  return SOURCE.replace('__CONFIG__', JSON.stringify(cfg));
}
