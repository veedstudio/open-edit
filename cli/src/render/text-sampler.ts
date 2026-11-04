// The script that lists the text a page draws, and the <video> elements it shows, injected beside the page runtime.
// The renderer calls it right after capturing a frame, so it reads the layout that frame was drawn from: the static
// HTML cannot answer this, since text animates, appears, moves and changes. It reads layout and style only, so the
// next frame draws the same.
//
// Kept as plain JavaScript source for the same reason as the page runtime: a transpiler may wrap named functions in
// helpers that do not exist inside the page.

/** A <video> the frame shows, measured in the output video's pixels: its source URL, its second, and where its picture lies. */
export interface SampledVideo {
  src: string;
  time: number;
  box: [number, number, number, number];
  shown: [number, number, number, number];
}

/** What the sampler reads off one frame. */
export interface SampledFrame { texts: TextEntry[]; videos: SampledVideo[] }

/** One text the frame shows: an element's own text nodes, measured in the output video's pixels. */
export interface TextEntry {
  /** The element's own text as drawn: whitespace collapsed, a line break between its pieces read as a space, its text-transform applied. */
  text: string;
  /** Left, top, width and height of the glyphs, clipped to the canvas, to overflow and to an inset() clip-path. */
  box: [number, number, number, number];
  /** The font size as drawn: the computed size times every transform and zoom on the element and its ancestors, times the capture scale. */
  fontSize: number;
  /**
   * The glyphs' solid fill, red, green and blue 0-255 and alpha 0-1, in sRGB. Alpha 0 when they have none of their
   * own: a background clipped to the text, or only a stroke or a shadow.
   */
  color: [number, number, number, number];
  /** The product of the element's opacity and its ancestors'. */
  opacity: number;
  /**
   * How opaque the backgrounds the page paints under the glyphs are, 0-1: the element's own and those of every element
   * below it down to a <video>, an image or a canvas, at the least covered of five points of its box. Absent in a record
   * written before it was measured.
   */
  backing?: number;
  /** A CSS selector for the element, so one text can be followed from frame to frame. */
  selector: string;
  /** Set on text inside a [data-captions] element: the page's caption track, which captions.js fills. */
  caption?: true;
  /** Drawn by an SVG element, to its picture's own scale, so neither render nor the review holds it to the size floor. */
  svg?: true;
}

const SOURCE = String.raw`
(() => {
  if (window.__oeText) return;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'TITLE', 'OPTION']);
  const r1 = (v) => Math.round(v * 10) / 10;
  const r2 = (v) => Math.round(v * 100) / 100;
  let ctx = null;
  const colours = new Map();
  // Any CSS colour the page may use (a name, hsl, oklch, display-p3) as sRGB bytes, through a canvas.
  function rgba(css) {
    let c = colours.get(css);
    if (c) return c;
    if (!ctx) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    ctx.clearRect(0, 0, 1, 1);
    // A value the canvas cannot parse (a gradient's url()) leaves the fill transparent: no solid fill.
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    c = [d[0], d[1], d[2], r2(d[3] / 255)];
    colours.set(css, c);
    return c;
  }
  function cased(text, how) {
    if (how === 'uppercase') return text.toUpperCase();
    if (how === 'lowercase') return text.toLowerCase();
    if (how === 'capitalize') return text.replace(/(^|\s)(\S)/g, (_, a, b) => a + b.toUpperCase());
    return text;
  }
  const meet = (a, b) => (a ? [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])] : b);
  const DEG = { deg: 1, rad: 180 / Math.PI, turn: 360, grad: 0.9 };
  // An inset() clip-path of plain lengths, the shape of a wipe reveal, as the part of the element's box it leaves;
  // any other shape, or an inset with calc(), clips nothing here.
  function inset(clipPath, r) {
    const m = /^inset\(([-\d.%px\s]+?)(?:\s+round\b[^)]*)?\)$/.exec(clipPath);
    if (!m) return null;
    const v = m[1].trim().split(/\s+/);
    if (!v.every((s) => /^-?[\d.]+(px|%)?$/.test(s))) return null;
    const [t, rt = t, b = t, l = rt] = v;
    const len = (s, of) => (s.endsWith('%') ? (parseFloat(s) / 100) * of : parseFloat(s));
    return [r.left + len(l, r.width), r.top + len(t, r.height), r.right - len(rt, r.width), r.bottom - len(b, r.height)];
  }

  const sample = (clip, viewWidth, viewHeight, scale) => {
    // The canvas in viewport pixels: a clip is placed on the document, so the page's scroll moves it.
    const ox = clip ? clip.x - window.scrollX : 0;
    const oy = clip ? clip.y - window.scrollY : 0;
    const canvas = [ox, oy, ox + (clip ? clip.width : viewWidth), oy + (clip ? clip.height : viewHeight)];
    const seen = new Map();
    const styleOf = (el) => {
      let s = seen.get(el);
      if (!s) { s = { cs: getComputedStyle(el) }; seen.set(el, s); }
      return s;
    };
    function opacityOf(el) {
      const s = styleOf(el);
      if (s.opacity === undefined) s.opacity = parseFloat(s.cs.opacity) * (el.parentElement ? opacityOf(el.parentElement) : 1);
      return s.opacity;
    }
    // CSS applies translate, rotate, scale, then transform, and none of them to an inline box.
    function matrixOf(el) {
      const s = styleOf(el);
      if (s.matrix) return s.matrix;
      let m = el.parentElement ? matrixOf(el.parentElement) : new DOMMatrix();
      const cs = s.cs;
      if (cs.display !== 'inline') {
        const turn = /^(-?[\d.]+)(deg|rad|turn|grad)$/.exec(cs.rotate);
        if (turn) m = m.rotate(parseFloat(turn[1]) * DEG[turn[2]]);
        if (cs.scale && cs.scale !== 'none') {
          const [x, y = x] = cs.scale.split(' ').map(parseFloat);
          m = m.scale(x, y);
        }
        if (cs.transform && cs.transform !== 'none') m = m.multiply(new DOMMatrix(cs.transform));
      }
      s.matrix = m;
      return m;
    }
    function scaleOf(el) {
      if (el instanceof SVGGraphicsElement && el.ownerSVGElement) {
        const m = el.getScreenCTM();
        return m ? Math.hypot(m.c, m.d) : 1;
      }
      const m = matrixOf(el);
      return Math.hypot(m.c, m.d) * zoomOf(el);
    }
    // Chrome reports font-size without the zoom of the element and its ancestors, which the boxes include.
    function zoomOf(el) {
      const s = styleOf(el);
      if (s.zoom === undefined) s.zoom = (parseFloat(s.cs.zoom) || 1) * (el.parentElement ? zoomOf(el.parentElement) : 1);
      return s.zoom;
    }
    // What clips an element's painting: its own overflow and clip-path, then those of each containing block up the
    // chain, so an absolutely placed caption escapes a wrapper that is not positioned, as it does on screen.
    function ownClip(el) {
      const cs = styleOf(el).cs;
      const overflows = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
      if (!overflows && cs.clipPath === 'none') return null;
      const r = el.getBoundingClientRect();
      const c = overflows ? [r.left, r.top, r.right, r.bottom] : null;
      const shape = cs.clipPath !== 'none' && inset(cs.clipPath, r);
      return shape ? meet(c, shape) : c;
    }
    function clipOf(el) {
      const s = styleOf(el);
      if (s.clip !== undefined) return s.clip;
      let c = el === document.body || el === document.documentElement ? null : ownClip(el);
      const pos = s.cs.position;
      let p = pos === 'fixed' ? null : el.parentElement;
      if (pos === 'absolute') while (p && styleOf(p).cs.position === 'static' && styleOf(p).cs.transform === 'none') p = p.parentElement;
      const up = p ? clipOf(p) : null;
      if (up) c = meet(c, up);
      s.clip = c;
      return c;
    }
    // -webkit-text-fill-color inherits and background-clip does not, so a span inside gradient text shows through
    // its parent's clipped background.
    function clippedToText(el) {
      for (let n = el; n; n = n.parentElement) {
        const cs = styleOf(n).cs;
        if (cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text') return true;
      }
      return false;
    }
    // Whether what stands between two of an element's own text nodes ends a line: a <br> or a block in the flow, met
    // directly or inside an inline child. Anything else leaves them on one line, so a word split around it stays whole.
    function breaksLine(from, to) {
      for (let n = from; n && n !== to; n = n.nextSibling) {
        if (n.nodeType !== Node.ELEMENT_NODE) continue;
        const cs = styleOf(n).cs;
        if (cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed' || cs.float !== 'none') continue;
        if (n.tagName === 'BR') return true;
        if (cs.display === 'inline' || cs.display === 'contents') {
          if (n instanceof HTMLElement && breaksLine(n.firstChild, null)) return true;
        } else if (!/^(inline|ruby)/.test(cs.display)) return true;
      }
      return false;
    }
    const selectors = new Map();
    function selectorOf(el) {
      let p = selectors.get(el);
      if (p) return p;
      if (el === document.body || !el.parentElement) p = el.tagName.toLowerCase();
      else if (el.id && document.getElementById(el.id) === el) p = '#' + CSS.escape(el.id);
      else {
        let k = 1;
        for (let n = el.previousElementSibling; n; n = n.previousElementSibling) k++;
        p = selectorOf(el.parentElement) + '>' + el.tagName.toLowerCase() + ':nth-child(' + k + ')';
      }
      selectors.set(el, p);
      return p;
    }

    const own = new Map();
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || SKIP.has(el.tagName) || !/\S/.test(n.data)) continue;
      let list = own.get(el);
      if (!list) own.set(el, (list = []));
      list.push(n);
    }
    // How opaque one element's own backgrounds are: its colour and each gradient layer at its most transparent stop.
    function paints(el) {
      const cs = styleOf(el).cs;
      let clear = 1 - rgba(cs.backgroundColor)[3];
      const image = cs.backgroundImage;
      if (image && image !== 'none') {
        let depth = 0, cur = '';
        const layers = [];
        for (const c of image) {
          if (c === '(') depth++;
          if (c === ')') depth--;
          if (c === ',' && depth === 0) { layers.push(cur); cur = ''; } else cur += c;
        }
        layers.push(cur);
        for (const layer of layers) {
          if (!/gradient\(/.test(layer)) continue;
          const stops = layer.match(/rgba?\([^)]*\)|transparent/g) || [];
          if (stops.length) clear *= 1 - Math.min(...stops.map((c) => rgba(c)[3]));
        }
      }
      return (1 - clear) * opacityOf(el);
    }
    // The elements painted under 'el' at a point, its own first, down to the first picture: by hit-testing, or, where the
    // element takes no hits (pointer-events: none), its ancestors.
    const PICTURE = new Set(['VIDEO', 'IMG', 'CANVAS', 'svg', 'SVG']);
    function under(el, x, y) {
      const stack = document.elementsFromPoint(x, y);
      const at = stack.indexOf(el);
      const below = [];
      if (at >= 0) {
        for (let i = at; i < stack.length; i++) {
          if (PICTURE.has(stack[i].tagName) || stack[i] === document.body || stack[i] === document.documentElement) break;
          below.push(stack[i]);
        }
        return below;
      }
      for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) below.push(n);
      return below;
    }
    function backing(el, b) {
      let least = 1;
      for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.25], [0.8, 0.25], [0.2, 0.75], [0.8, 0.75]]) {
        let clear = 1;
        for (const n of under(el, b[0] + fx * (b[2] - b[0]), b[1] + fy * (b[3] - b[1]))) clear *= 1 - paints(n);
        least = Math.min(least, 1 - clear);
      }
      return r2(least);
    }
    const range = document.createRange();
    const out = [];
    for (const [el, nodes] of own) {
      const cs = styleOf(el).cs;
      if (cs.visibility !== 'visible') continue;
      const opacity = opacityOf(el);
      if (opacity < 0.01) continue;
      const svg = el instanceof SVGElement;
      let color = rgba(svg ? cs.fill : (cs.webkitTextFillColor || cs.color));
      if (svg) color = [color[0], color[1], color[2], r2(color[3] * parseFloat(cs.fillOpacity))];
      const stroked = svg ? cs.stroke !== 'none' && parseFloat(cs.strokeWidth) > 0 : parseFloat(cs.webkitTextStrokeWidth) > 0;
      if (color[3] === 0 && !stroked && cs.textShadow === 'none' && !clippedToText(el)) continue;
      let box = null;
      for (const n of nodes) {
        // The glyphs only: a word span's own trailing space would otherwise close the gap to the next word.
        const from = n.data.search(/\S/);
        range.setStart(n, from);
        range.setEnd(n, n.data.trimEnd().length);
        for (const q of range.getClientRects()) {
          if (q.width <= 0 || q.height <= 0) continue;
          box = box ? [Math.min(box[0], q.left), Math.min(box[1], q.top), Math.max(box[2], q.right), Math.max(box[3], q.bottom)] : [q.left, q.top, q.right, q.bottom];
        }
      }
      if (!box) continue;
      box = meet(meet(clipOf(el), canvas), box);
      if (box[2] <= box[0] || box[3] <= box[1]) continue;
      const entry = {
        text: cased(nodes.map((n, k) => (k && breaksLine(nodes[k - 1].nextSibling, n) ? ' ' : '') + n.data).join('').replace(/\s+/g, ' ').trim(), cs.textTransform),
        box: [r1((box[0] - ox) * scale), r1((box[1] - oy) * scale), r1((box[2] - box[0]) * scale), r1((box[3] - box[1]) * scale)],
        fontSize: r1(parseFloat(cs.fontSize) * scaleOf(el) * scale),
        color,
        opacity: r2(opacity),
        backing: backing(el, box),
        selector: selectorOf(el),
        ...(svg ? { svg: true } : {}),
      };
      if (el.closest('[data-captions]')) entry.caption = true;
      out.push(entry);
    }
    const toOut = (b) => [r1((b[0] - ox) * scale), r1((b[1] - oy) * scale), r1((b[2] - b[0]) * scale), r1((b[3] - b[1]) * scale)];
    const videos = [];
    for (const v of document.querySelectorAll('video')) {
      const src = v.currentSrc || v.src;
      if (!src || !v.videoWidth || !v.videoHeight) continue;
      const cs = styleOf(v).cs;
      if (cs.visibility !== 'visible' || opacityOf(v) < 0.01) continue;
      // A turned or skewed picture has no box to carry the clip's pixels through.
      const m = matrixOf(v);
      if (Math.abs(m.b) > 1e-6 || Math.abs(m.c) > 1e-6) continue;
      const r = v.getBoundingClientRect();
      const w = v.offsetWidth, h = v.offsetHeight;
      if (!(r.width > 0 && r.height > 0 && w > 0 && h > 0)) continue;
      // The element's own pixels to the viewport's, through every scale and translate on it and its ancestors.
      const kx = r.width / w, ky = r.height / h;
      const px = (name) => parseFloat(cs[name]) || 0;
      const cx = px('borderLeftWidth') + px('paddingLeft'), cy = px('borderTopWidth') + px('paddingTop');
      const cw = w - cx - px('borderRightWidth') - px('paddingRight'), ch = h - cy - px('borderBottomWidth') - px('paddingBottom');
      if (!(cw > 0 && ch > 0)) continue;
      const contain = Math.min(cw / v.videoWidth, ch / v.videoHeight);
      const fit = cs.objectFit;
      const k = fit === 'cover' ? Math.max(cw / v.videoWidth, ch / v.videoHeight) : fit === 'none' ? 1
        : fit === 'scale-down' ? Math.min(1, contain) : fit === 'fill' ? null : contain;
      const pw = k === null ? cw : v.videoWidth * k, ph = k === null ? ch : v.videoHeight * k;
      const at = position(cs.objectPosition || '', cw - pw, ch - ph);
      if (!at) continue;
      const left = r.left + (cx + at[0]) * kx, top = r.top + (cy + at[1]) * ky;
      const box = [left, top, left + pw * kx, top + ph * ky];
      const content = [r.left + cx * kx, r.top + cy * ky, r.left + (cx + cw) * kx, r.top + (cy + ch) * ky];
      const shown = meet(meet(meet(clipOf(v), canvas), content), box);
      if (shown[2] <= shown[0] || shown[3] <= shown[1]) continue;
      videos.push({ src, time: Math.round(v.currentTime * 1e6) / 1e6, box: toOut(box), shown: toOut(shown) });
    }
    return { texts: out, videos };
  };
  const KEYWORD = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };
  // A computed object-position's offsets across the slack either way, or null for a form it does not know: never a guess.
  function position(value, freeX, freeY) {
    const parts = [];
    let depth = 0, cur = '';
    for (const c of value) {
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ' ' && depth === 0) { if (cur) parts.push(cur); cur = ''; } else cur += c;
    }
    if (cur) parts.push(cur);
    const along = (token, free) => {
      const m = /^calc\((-?[\d.]+)%\s*([+-])\s*(-?[\d.]+)px\)$/.exec(token);
      if (m) return (free * parseFloat(m[1])) / 100 + (m[2] === '-' ? -1 : 1) * parseFloat(m[3]);
      if (/^-?[\d.]+%$/.test(token)) return (free * parseFloat(token)) / 100;
      if (/^-?[\d.]+px$/.test(token)) return parseFloat(token);
      if (token in KEYWORD) return free * KEYWORD[token];
      return token ? NaN : free / 2;
    };
    const x = along(parts[0] || '', freeX), y = along(parts[1] || '', freeY);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  }
  // Fixed, so a page's own global of that name cannot stand in for it and write a record of its choosing.
  Object.defineProperty(window, '__oeText', { value: sample, writable: false, configurable: false });
})();
`;

export const TEXT_SAMPLER_SCRIPT = SOURCE;
