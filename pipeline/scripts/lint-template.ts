// Mechanical anti-pattern lint for authored .wv documents — runs BEFORE `--verify` in the gate
// chain (lint → verify → record; generate-recipe.ts and the inline creative pass alike). Each check
// enforces a rule the engine contract states in prose
// (pipeline/director-brief.md ENGINE LIMITS / the opacity trap) or a recipe-format authoring rule:
// prompt discipline can drift, a regex can't. `error` = the engine renders it wrong or verify can't
// work with it (exit 1); `warn` = a known shear/legibility risk worth a look (exit 0).
//
// NOT covered here (semantic, stays a sheet/brief rule): color-animation-as-reveal (stylistic colour
// shifts are legit), shrink-to-fit flex around animated children (needs layout, not regex).
//   node --import tsx pipeline/scripts/lint-template.ts <template.wv> [--json]
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Finding { rule: string; severity: 'error' | 'warn'; message: string }

function keyframesBlocks(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // consume nested braces of the keyframes block
    let depth = 1, i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    out.push({ name: m[1], body: src.slice(re.lastIndex, i - 1) });
  }
  return out;
}

// Tags that never wrap caption markup — skipped by the ancestor walk.
const VOID_TAGS = new Set(['br', 'img', 'source', 'track', 'input', 'meta', 'link', 'hr', 'area', 'base', 'col', 'embed', 'wbr']);

// TRUE when every element carrying `cls` is safe from the stacking trap via its surroundings: it sits
// inside an ancestor that establishes a stacking context ABOVE the z0 video (inline z-index >= 1, or a
// class whose CSS rule sets z-index >= 1), or carries its own inline z >= 1. Stack-walks the tag
// stream — .wv documents are machine-generated, well-formed HTML.
function classCoveredByAncestor(src: string, cls: string, zClasses: Set<string>): boolean {
  const bodyAt = src.search(/<body\b/i);
  const markup = bodyAt >= 0 ? src.slice(bodyAt) : src;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const zStack: boolean[] = [];
  let zDepth = 0;
  let seen = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markup))) {
    const tag = m[2].toLowerCase();
    if (VOID_TAGS.has(tag)) continue;
    if (m[1] === '/') {
      if (zStack.pop()) zDepth--;
      continue;
    }
    const attrs = m[3];
    const classes = attr(attrs, 'class').split(/\s+/).filter(Boolean);
    const inlineZ = attrs.match(/style=(?:"[^"]*|'[^']*)z-index\s*:\s*(-?\d+)/i);
    const carries = (inlineZ !== null && Number(inlineZ[1]) >= 1) || classes.some((c) => zClasses.has(c));
    if (classes.includes(cls)) {
      seen++;
      if (zDepth === 0 && !carries) return false; // an occurrence with no z cover anywhere → the trap applies
    }
    if (/\/\s*$/.test(attrs)) continue; // self-closing — not an ancestor
    zStack.push(carries);
    if (carries) zDepth++;
  }
  return seen > 0;
}

/** Canvas facts from the run's manifest. Timing rules cannot be decided without them. */
export interface Render { fps: number; duration: number; width?: number; height?: number }

/** Milliseconds from a CSS time token; undefined when the token is not a time. */
function ms(tok: string): number | undefined {
  const m = tok.match(/^(-?[\d.]+)(ms|s)$/);
  if (!m) return undefined;
  return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
}

/** The first two time tokens of an `animation` shorthand are duration then delay, in that order. */
function animTiming(shorthand: string): { dur: number; delay: number } | undefined {
  const times = shorthand.trim().split(/\s+/).map(ms).filter((v): v is number => v !== undefined);
  if (!times.length) return undefined;
  return { dur: times[0], delay: times[1] ?? 0 };
}

/** One finding per element whose closing gate lands on an exact frame instant. */
function reportBoundary(f: Finding[], selector: string, name: string, delay: number, dur: number, frameMs: number, fps: number, durationMs: number) {
  const end = delay + dur;
  const n = end / frameMs;
  if (Math.abs(n - Math.round(n)) > 1e-6) return;
  // A gate closing at the END of the document loses nothing: there is no next frame to lose. Only a
  // window that closes MID-timeline drops a frame a viewer sees.
  if (end >= durationMs - frameMs / 2) return;
  const msg = `"${selector}" closes ${name} at ${end}ms — exactly frame ${Math.round(n)} at ${fps}fps, so that frame renders blank and --verify cannot see it; end the window a few ms earlier`;
  if (!f.some((x) => x.rule === 'gate-on-frame-boundary' && x.message === msg)) {
    f.push({ rule: 'gate-on-frame-boundary', severity: 'warn', message: msg });
  }
}

/** An attribute in either quoting. Single quotes are legal and were invisible to every reader here. */
function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, 'i'));
  return m?.slice(1).find((v) => v !== undefined) ?? '';
}

const styleAttr = (tag: string): string => attr(tag, 'style');

export function lintTemplate(src: string, render?: Render): Finding[] {
  const f: Finding[] = [];
  // Property rules read `css`, and a document that puts its geometry in `style="..."` attributes was
  // invisible to every one of them — which is most generated documents. Inline declarations are
  // appended as synthetic blocks so a regex that stops at `}` still terminates on its own element.
  const styleBlocks = src.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi) ?? [];
  const inlineDecls = [...src.matchAll(/<[^>]*\sstyle=("([^"]*)"|'([^']*)')[^>]*>/gi)]
    .map((m) => `.inline{${m[2] ?? m[3] ?? ''}}`);
  const css = styleBlocks.length || inlineDecls.length ? [...styleBlocks, ...inlineDecls].join('\n') : src;
  const frames = keyframesBlocks(css);

  for (const kf of frames) {
    if (/filter:[^;]*blur/.test(kf.body)) {
      // WARN, not error: the engine HOLDS the initial value (static blur renders fine — measured
      // 2026-07-14) — degraded fidelity, not breakage; validated recipes ship with
      // held ramps (hook-015). Surfaced so a fresh author doesn't design around motion that won't happen.
      f.push({ rule: 'animated-blur', severity: 'warn', message: `@keyframes ${kf.name}: animated filter:blur holds its initial value (no ramp) — prefer opacity/transform` });
    }
  }

  // Every rule below is settled by a control-render probe, named in the rule's own id. A rule
  // asserting a limit no probe supports removes real capability from every run that lints clean, so
  // it is a defect of the same class as an invented limitation in the brief.
  // Retired here because the engine imposes none of them as stated (0.8.0, probe-decided). `br-tag`
  // is retired for ordinary inline text ONLY: `<br>` is inert between display:inline-block spans
  // (probe: br-between-inline-blocks), which is why captions put each line in its own block.
  // var-in-keyframes,
  // br-tag, css-outline, blend-mode, repeating-gradient, vw-font-size.
  const unsupported: [RegExp, string, 'error' | 'warn', string][] = [
    [/display:\s*(inline-)?grid|grid-template/i, 'css-grid', 'error', 'CSS grid is unsupported — use flex'],
    [/-webkit-text-stroke/i, 'text-stroke', 'error', '-webkit-text-stroke never paints, on any construct (probe: webkit-text-stroke-never-paints) — ground with an 8-way text-shadow'],
    [/border-radius:[^;}]*\//, 'radius-slash', 'error', 'border-radius slash syntax renders square — single-value only'],
    [/border-radius:[ \t]*[^\s;}(]+[ \t]+[^\s;}(]+/, 'radius-per-corner', 'error', 'a border-radius with more than ONE value drops the whole declaration and the box renders square — measured on the two-value form as well as the four — use a single value, or a clip-path polygon for asymmetric corners'],
    [/transform:[^;]*\b(skewX|skewY|matrix)\s*\(/i, 'skew-ignored', 'warn', 'skewX is silently ignored — the element renders axis-aligned (probe: skew-ignored); skewY and matrix are caught by the same rule but were never probed, so treat them as unverified rather than broken. Build the slant with a clip-path polygon if the design needs it'],
    [/radial-gradient|(?:^|[^-\w])mask(?:-image)?\s*:/im, 'unsupported-paint', 'error', 'radial-gradient and the CSS mask property do not paint — use a clip-path polygon or a flat/linear/conic fill'],
  ];
  for (const [re, rule, severity, message] of unsupported) {
    if (re.test(css)) f.push({ rule, severity, message });
  }

  // @import must precede every rule or the engine drops the WHOLE stylesheet — the document then
  // renders as unstyled flow, which reads as a layout bug rather than a font problem.
  for (const block of src.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi) ?? []) {
    const inner = block.replace(/<\/?style[^>]*>/gi, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const firstImport = inner.search(/@import/i);
    if (firstImport < 0) continue;
    const before = inner.slice(0, firstImport);
    if (/[^\s@][^{}]*\{/.test(before)) {
      f.push({ rule: 'import-not-first', severity: 'error', message: '@import must be the FIRST statement inside <style> — a rule before it drops the entire stylesheet' });
    }
  }

  // A positioned element that animates opacity and states no z-index leaves its paint order to
  // document order. This was carried for months as an engine limit — "loses its stacking context at
  // opacity 1" — and the probe refutes it (opacity-anim-no-z): the element paints above the video as
  // CSS says. So this is a WARN about drift, not an error about a limit.
  // NOT flagged (an enclosing stacking context settles the order for them):
  // non-positioned spans inside their cue, AND any element all of whose occurrences sit under an
  // ancestor carrying z-index >= 1 (the compiled-recipe cue idiom: inline z per cue, positioned .pg
  // pages inside — they paint within the cue's context and cannot fall under the video).
  const opacityFrames = new Set(frames.filter((k) => /(?:^|[^-\w])opacity\s*:/.test(k.body)).map((k) => k.name));
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const zClasses = new Set<string>();
  for (const m of cssNoComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().split('\n').pop()!.trim();
    const z = m[2].match(/z-index\s*:\s*(-?\d+)/);
    const c = sel.match(/^\.([\w-]+)$/)?.[1];
    if (c && z && Number(z[1]) >= 1) zClasses.add(c);
  }
  for (const m of cssNoComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().split('\n').pop()!.trim();
    const body = m[2];
    if (selector.startsWith('@')) continue;
    const anim = body.match(/animation(?:-name)?:\s*([^;]+)/);
    if (!anim) continue;
    const names = anim[1].split(',').map((s) => s.trim().split(/\s+/).find((tok) => opacityFrames.has(tok))).filter(Boolean);

    // TWO ANIMATIONS, ONE PROPERTY. No probe backs this one and none is needed: the defect is a
    // contradiction the DOCUMENT states about itself, decidable by reading it. Two animations on one
    // element each declare an opacity timeline, so the document names two different visibilities for
    // the same instant; whichever the engine keeps, the other declared window is discarded and
    // nothing reports it. One film shipped 22 graphics that never turned off this way. Exactly one
    // animation may own opacity; every other animation on the element animates transform only.
    // (Reproduced by the opacity-owned-twice fixture.)
    if (names.length > 1) {
      f.push({ rule: 'opacity-owned-twice', severity: 'error', message: `rule "${selector}" runs ${names.length} animations that all drive opacity (${names.join(', ')}) — the document declares two visibilities for the same instant and one of them is silently discarded; let ONE animation own opacity and make the others transform-only` });
    }

    if (!names.length) continue;
    const positioned = /position\s*:\s*(absolute|fixed|relative)/.test(body);
    if (positioned && !/z-index\s*:/.test(body)) {
      // The z-index may live INLINE per element (some sheets set z per cue: style="z-index:11"),
      // or on an ANCESTOR (the compiled-recipe idiom). Only flag when neither covers every occurrence.
      const cls = selector.match(/^\.([\w-]+)$/)?.[1];
      let coveredInline = false;
      let coveredByAncestor = false;
      if (cls) {
        const tags = [...src.matchAll(new RegExp(`<[^>]*class=(?:"[^"]*|'[^']*)\\b${cls}\\b[^>]*>`, 'gi'))];
        coveredInline = tags.length > 0 && tags.every((t) => /style=(?:"[^"]*|'[^']*)z-index/.test(t[0]));
        coveredByAncestor = classCoveredByAncestor(src, cls, zClasses);
      }
      if (!coveredInline && !coveredByAncestor) {
        f.push({ rule: 'opacity-anim-no-z', severity: 'warn', message: `rule "${selector}" is positioned and animates opacity (${names.join(', ')}) without an explicit z-index — its paint order is left to document order, so reordering the markup silently changes what covers what` });
      }
    }
    if (/line-height:\s*(0?\.\d+|1(?:\.0*)?|1\.1\d*)(?![\d.])/.test(body) && !/padding/.test(body)) {
      // The shear this rule was named for does not happen (probe: lineheight-shear, REFUTED). What a
      // line-height under 1.2 does is bring a descender within a pixel or two of the next line's caps,
      // which is a typographic call and not an engine defect — so it is worth saying once, and worth
      // nobody's build.
      f.push({ rule: 'tight-line-height', severity: 'warn', message: `rule "${selector}": text at line-height < 1.2 with no padding headroom — descenders come within a pixel of the next line's caps (give ~0.1em top / 0.15em bottom, or line-height >= 1.2)` });
    }
  }

  // --verify names failures by element id: every animated caption element needs a unique id.
  const ids = new Set<string>();
  for (const tag of src.matchAll(/<(?:div|span|h\d|p)\b[^>]*class=(?:"[^"]*|'[^']*)\b(?:cue|cap|word|w)\b[^>]*>/gi)) {
    const id = tag[0].match(/\bid="([^"]+)"/)?.[1];
    if (id === undefined) continue; // per-word spans may share classes; only cue-level ids are required
    if (ids.has(id)) f.push({ rule: 'duplicate-id', severity: 'error', message: `duplicate element id "${id}" — --verify failure lines become ambiguous` });
    ids.add(id);
  }
  // A gate whose keyframe closes EXACTLY on a frame boundary loses that frame, and --verify cannot
  // see it: it checks the draw list, and the draw list is correct — the frame simply lands on the
  // instant the gate flips. One launch card rendered the last frame of every beat blank this way.
  // Confirmed by probe `frame-boundary-gate-loss`.
  //
  // WARN, not error, and the reason is scope rather than doubt: 43 gates across 13 accepted
  // deliverables land on the grid, because 26 of the 28 compiled recipes emit `animation-duration`
  // inline from the beat's own spoken window. Moving the gate off the grid is one arithmetic change
  // repeated across those modules plus ~53 pinned golden tests — a scoped job of its own, not
  // something to half-do from here. Until then this surfaces every instance without blocking a path
  // whose output is otherwise correct.
  //
  // Generated documents put the gate's TIMING INLINE on each element and keep only the name in CSS
  // (`style="z-index:11; animation-delay:160ms; animation-duration:2000ms"`), so a rule that reads
  // CSS rule bodies alone never fires. Both places are read here.
  if (render?.fps) {
    const frameMs = 1000 / render.fps;
    const closing = new Set(
      frames
        .filter((k) => /(?:\b100%|\bto)\s*\{[^}]*opacity\s*:\s*0(?![.\d])/.test(k.body))
        .map((k) => k.name),
    );

    // class -> the closing gate it carries, plus whatever timing the CSS rule itself fixes
    const gated = new Map<string, { name: string; dur?: number; delay?: number }>();
    for (const m of cssNoComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim().split('\n').pop()!.trim();
      const body = m[2];
      if (selector.startsWith('@')) continue;
      const cls = selector.match(/^\.([\w-]+)$/)?.[1];
      const short = body.match(/animation\s*:\s*([^;]+)/);
      const named = body.match(/animation-name\s*:\s*([\w-]+)/);
      const name = short?.[1].trim().split(/\s+/)[0] ?? named?.[1];
      if (!name || !closing.has(name)) continue;
      const t = short ? animTiming(short[1].replace(name, '')) : undefined;
      const dur = t?.dur ?? ms(body.match(/animation-duration\s*:\s*([^;]+)/)?.[1]?.trim() ?? '');
      const delay = t?.delay ?? ms(body.match(/animation-delay\s*:\s*([^;]+)/)?.[1]?.trim() ?? '');
      if (cls) gated.set(cls, { name, dur, delay });
      if (!cls && dur !== undefined) reportBoundary(f, selector, name, delay ?? 0, dur, frameMs, render.fps, render.duration * 1000);
    }

    // Only CUE-LEVEL gates. A per-glyph caret window closing on a frame instant loses a frame nobody
    // can see; the defect that shipped was a BEAT losing its last frame. The brief already requires a
    // unique id on every cue-level element, so the id is the marker for "a window a viewer watches".
    for (const tag of src.matchAll(/<[^>]*class=(?:"([^"]*)"|'([^']*)')[^>]*>/gi)) {
      if (!/\bid="/.test(tag[0])) continue;
      const style = styleAttr(tag[0]);
      for (const cls of tag[1].split(/\s+/).filter(Boolean)) {
        const g = gated.get(cls);
        if (!g) continue;
        const short = style.match(/animation\s*:\s*([^;"]+)/);
        const t = short ? animTiming(short[1].replace(g.name, '')) : undefined;
        const dur = t?.dur ?? ms(style.match(/animation-duration\s*:\s*([^;"]+)/)?.[1]?.trim() ?? '') ?? g.dur;
        const delay = t?.delay ?? ms(style.match(/animation-delay\s*:\s*([^;"]+)/)?.[1]?.trim() ?? '') ?? g.delay ?? 0;
        if (dur === undefined) continue;
        reportBoundary(f, `.${cls}`, g.name, delay, dur, frameMs, render.fps, render.duration * 1000);
      }
    }
  }

  // An element whose entrance starts at or after the document ends never plays. It costs nothing at
  // render time and reads as a missing beat, which is why it survives review: --verify only checks
  // what IS drawn, so an element that is never drawn raises nothing. Corpus class `timing-offset`.
  if (render?.duration) {
    const durMs = render.duration * 1000;
    for (const tag of src.matchAll(/<[^>]*\sstyle=(?:"[^"]*"|'[^']*')[^>]*>/gi)) {
      const style = styleAttr(tag[0]);
      const delay = ms(style.match(/animation-delay\s*:\s*([^;'"]+)/)?.[1]?.trim() ?? '');
      if (delay === undefined || delay < durMs) continue;
      const who = tag[0].match(/\bid=(?:"([^"]+)"|'([^']+)')/)?.slice(1).find((v) => v !== undefined)
        ?? tag[0].match(/class=(?:"([^"]+)"|'([^']+)')/)?.slice(1).find((v) => v !== undefined) ?? 'element';
      f.push({ rule: 'starts-after-end', severity: 'error', message: `"${who}" has animation-delay ${delay}ms on a ${durMs}ms timeline — it never plays, and --verify cannot see an element that is never drawn` });
    }
  }

  // A full-canvas backing layer that is not the canvas size. The launch session resized a set of
  // scenes from 1080 to 1440 high and left masks and plates at the old height; the band that opened
  // up was found by eye, scene by scene. Only layers ANCHORED at the origin are judged — a graphic
  // deliberately bleeding past an edge is design, not a defect. Corpus class `layer-leak`.
  if (render?.width && render?.height) {
    for (const m of cssNoComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim().split('\n').pop()!.trim();
      const body = m[2];
      if (selector.startsWith('@')) continue;
      if (!/position\s*:\s*absolute/.test(body)) continue;
      if (!/(?:^|[;{\s])left\s*:\s*0(?:px)?\s*(?:;|$)/.test(body) || !/(?:^|[;{\s])top\s*:\s*0(?:px)?\s*(?:;|$)/.test(body)) continue;
      const w = Number(body.match(/(?:^|[;{\s])width\s*:\s*(\d+)px/)?.[1]);
      const h = Number(body.match(/(?:^|[;{\s])height\s*:\s*(\d+)px/)?.[1]);
      if (!w || !h) continue;
      // A designed strip covers one axis and a small fraction of the other; a layer left behind by a
      // canvas resize covers most of it and stops short. Only the second leaves a visible band, and a
      // layer BIGGER than the canvas is deliberate bleed, never a gap.
      const gapY = w === render.width && h < render.height && h >= render.height * 0.5;
      const gapX = h === render.height && w < render.width && w >= render.width * 0.5;
      if (gapY || gapX) {
        const band = gapY ? `${render.height - h}px of bare canvas below it` : `${render.width - w}px of bare canvas beside it`;
        f.push({ rule: 'stale-canvas-layer', severity: 'error', message: `rule "${selector}" is anchored at the origin at ${w}x${h} on a ${render.width}x${render.height} canvas, leaving ${band} — a backing layer left behind by a canvas resize` });
      }
    }
  }

  const cueTags = [...src.matchAll(/<div\b[^>]*class=(?:"[^"]*|'[^']*)\bcue\b[^>]*>/gi)];
  const cuesWithoutId = cueTags.filter((t) => !/\bid="/.test(t[0])).length;
  if (cuesWithoutId > 0) {
    f.push({ rule: 'cue-missing-id', severity: 'error', message: `${cuesWithoutId} .cue element(s) without a unique id — --verify cannot name them in failure lines` });
  }

  return f;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: node --import tsx pipeline/scripts/lint-template.ts <template.wv> [--json]'); process.exit(2); }
  // The manifest sits next to the document; without it the timing rules cannot run.
  let render: Render | undefined;
  try {
    const mf = join(dirname(file), 'manifest.json');
    if (existsSync(mf)) render = JSON.parse(readFileSync(mf, 'utf8')).render;
  } catch { /* a malformed manifest is the renderer's error to report, not this gate's */ }
  const findings = lintTemplate(readFileSync(file, 'utf8'), render);
  if (argv.includes('--json')) console.log(JSON.stringify(findings, null, 2));
  else for (const x of findings) console.log(`${x.severity.toUpperCase()}[${x.rule}] ${x.message}`);
  const errors = findings.filter((x) => x.severity === 'error').length;
  if (!argv.includes('--json')) console.log(errors ? `lint: ${errors} error(s), ${findings.length - errors} warning(s)` : `lint: clean (${findings.length} warning(s))`);
  process.exit(errors ? 1 : 0);
}
