// The speaker layer, and the layers around it. A stage that names a cut-out (data-cutout="<file>") holds its content
// in layers the page fills: [data-layer="footage"], [data-layer="behind"] (graphics the speaker stands in front of)
// and [data-layer="front"] (captions, small text). The CLI fills the stage with each, isolates each, stacks them in
// that order whatever the page's z-index, and draws the cut-out in a layer of its own between behind and front. So a
// render, a check and a preview show the same layering, and nothing inside a layer can reach across another. A
// transform on the footage layer (a punch-in) is the speaker's too, so the cut-out stays in register with the
// footage it was cut from. The render runtime runs this inside its own closure and is handed the cut-out there; a
// page loads the same source as speaker.js to preview.
//
// Kept as plain JavaScript source, not a function to be stringified: a transpiler may wrap named functions in
// helpers that do not exist inside the page.

/** The speaker layer's box, as a layer selector. */
export const SPEAKER_BOX = '[data-oe-speaker]';

/**
 * The layer's source as a function expression of two arguments: a function the render runtime passes to be handed
 * the cut-out and the layer's sync, or null in a browser, where the layer previews on its own clock; and a key the
 * cut-out carries inside its closed shadow root, by which the session finds it through the debugging protocol.
 */
export const SPEAKER_FN = String.raw`function (adopt, key) {
  if (window.__oeSpeaker) return;
  Object.defineProperty(window, '__oeSpeaker', { value: true });
  var ORDER = { footage: 1, behind: 2, front: 4 };
  var LAYER = 'position:absolute!important;inset:0!important;margin:0!important;isolation:isolate!important;';
  var STYLE = Object.keys(ORDER).map(function (k) {
    return '[data-oe-stage]>[data-layer="' + k + '"]{' + LAYER + 'z-index:' + ORDER[k] + '!important}';
  }).join('');
  // The cut-out lies in a closed shadow root, handed only to the runtime, so a page's rules and scripts aimed at every
  // video, or at the stage, leave it be. Its box is in the page's tree, so what places and paints the box is pinned
  // here: an !important rule inside a shadow root outranks what the page declares on its host, inline !important too.
  var PINNED = {
    display: 'block', position: 'absolute', inset: '0', width: 'auto', height: 'auto', margin: '0', padding: '0',
    border: '0', 'border-radius': '0', outline: 'none', 'box-shadow': 'none', background: 'none', isolation: 'isolate',
    'z-index': '3', 'pointer-events': 'none', opacity: '1', visibility: 'visible', 'content-visibility': 'visible',
    filter: 'none', 'backdrop-filter': 'none', 'clip-path': 'none', clip: 'auto', mask: 'none', '-webkit-mask': 'none',
    '-webkit-mask-box-image': 'none', '-webkit-box-reflect': 'none', 'mix-blend-mode': 'normal', animation: 'none',
    transition: 'none', overflow: 'visible', contain: 'none', zoom: '1', 'offset-path': 'none', perspective: 'none',
    'transform-style': 'flat', 'backface-visibility': 'visible', 'image-rendering': 'auto', 'view-transition-name': 'none',
    'min-width': '0', 'min-height': '0', 'max-width': 'none', 'max-height': 'none', 'aspect-ratio': 'auto',
    'position-anchor': 'auto', 'position-area': 'none', 'position-try-fallbacks': 'none', columns: 'auto',
  };
  var SHADOW = ':host{' + Object.keys(PINNED).map(function (k) { return k + ':' + PINNED[k] + '!important'; }).join(';') + '}'
    + 'video{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;object-fit:cover;object-position:50% 50%;display:block}';
  // Taken before the page's scripts run, so a page that wraps it does not see the root made.
  var attach = Element.prototype.attachShadow;
  // What of the footage layer's placing the speaker's layer takes, so a punch-in carries both.
  var FOLLOW = { transform: 'none', 'transform-origin': '50% 50%', translate: 'none', rotate: 'none', scale: 'none' };

  function fail(message) { throw new Error('speaker layer: ' + message); }
  function findStage() { return document.querySelector('#stage') || document.querySelector('[data-stage]'); }

  function build() {
    var stage = findStage();
    if (!stage || !stage.hasAttribute('data-cutout')) return;
    var file = stage.getAttribute('data-cutout');
    if (!file) fail('the stage names no cut-out: give it data-cutout="<file>"');
    var style = document.createElement('style');
    style.textContent = STYLE;
    (document.head || document.documentElement).appendChild(style);
    var box = document.createElement('div');
    box.setAttribute('data-oe-speaker', '');
    var root = attach.call(box, { mode: 'closed' });
    var sheet = document.createElement('style');
    sheet.textContent = SHADOW;
    var placing = document.createElement('style');
    var video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = file;
    if (key) video.setAttribute('data-oe-key', key);
    root.append(sheet, placing, video);
    function lay(on) {
      stage = on;
      stage.setAttribute('data-oe-stage', '');
      if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative';
    }
    lay(stage);
    stage.appendChild(box);
    // Checked every frame, since a script may replace the stage, or add a layer or a graphic, at any time.
    function check() {
      var now = findStage();
      if (now !== stage) {
        if (!now) fail('the page removed its stage (#stage or [data-stage]), which the speaker is laid on');
        if (now.getAttribute('data-cutout') !== file) fail('the page replaced its stage with one that does not name the cut-out ' + file);
        lay(now);
      }
      document.querySelectorAll('[data-layer]').forEach(function (l) {
        if (!stage.contains(l)) fail('a [data-layer] lies outside the stage; each layer is a child of the stage');
        if (l.parentElement !== stage) fail('a [data-layer] lies inside another element of the stage; each layer is a child of the stage');
        if (!(l.getAttribute('data-layer') in ORDER)) fail('data-layer="' + l.getAttribute('data-layer') + '" is not a layer: footage, behind or front');
      });
      document.querySelectorAll('[data-behind]').forEach(function (g) {
        if (!g.closest('[data-layer="behind"]')) fail('a data-behind graphic lies outside the behind layer, <div data-layer="behind">, so the speaker is not in front of it');
      });
    }
    // Run every frame: the box takes the footage layer's placing as it now stands, and a box a script dropped (a
    // framework rebuilding the stage) goes back. True when it went back, as its picture has then to be drawn again.
    function sync() {
      check();
      var back = box.parentElement !== stage;
      if (back) stage.appendChild(box);
      var footage = stage.querySelector(':scope > [data-layer="footage"]');
      var cs = footage && getComputedStyle(footage);
      var rule = ':host{' + Object.keys(FOLLOW).map(function (p) { return p + ':' + (cs ? cs.getPropertyValue(p) : FOLLOW[p]) + '!important'; }).join(';') + '}';
      if (placing.textContent !== rule) placing.textContent = rule;
      return back;
    }
    sync();
    if (adopt) adopt({ video: video, sync: sync });
    else preview(video, sync);
  }

  // In an ordinary browser nothing drives the page's clock: the cut-out plays from the page's start, as a render
  // shows it at page time, whatever the page does with its footage.
  function preview(video, sync) {
    var start = performance.now();
    video.play().catch(function () {});
    (function tick() {
      var t = (performance.now() - start) / 1000;
      var end = isFinite(video.duration) ? video.duration : Infinity;
      if (t < end && Math.abs(video.currentTime - t) > 0.05) video.currentTime = t;
      sync();
      requestAnimationFrame(tick);
    })();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
}`;

/** speaker.js, for a page to load so it previews in an ordinary browser as it renders. */
export function speakerScript(): string {
  return `(${SPEAKER_FN})(null, null);\n`;
}
