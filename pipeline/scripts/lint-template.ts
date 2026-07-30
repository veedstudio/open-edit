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
import { readFileSync } from 'node:fs';
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
    const classes = attrs.match(/class="([^"]*)"/i)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
    const inlineZ = attrs.match(/style="[^"]*z-index\s*:\s*(-?\d+)/i);
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

export function lintTemplate(src: string): Finding[] {
  const f: Finding[] = [];
  const css = src.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)?.join('\n') ?? src;
  const frames = keyframesBlocks(css);

  for (const kf of frames) {
    if (kf.body.includes('var(')) {
      f.push({ rule: 'var-in-keyframes', severity: 'error', message: `@keyframes ${kf.name}: var() never resolves inside keyframes (in transform it CRASHES the engine) — bake literal values` });
    }
    if (/filter:[^;]*blur/.test(kf.body)) {
      // WARN, not error: the engine HOLDS the initial value (static blur renders fine — measured
      // 2026-07-14) — degraded fidelity, not breakage; validated recipes ship with
      // held ramps (hook-015). Surfaced so a fresh author doesn't design around motion that won't happen.
      f.push({ rule: 'animated-blur', severity: 'warn', message: `@keyframes ${kf.name}: animated filter:blur holds its initial value (no ramp) — prefer opacity/transform` });
    }
  }

  if (/<br[\s/>]/i.test(src)) {
    f.push({ rule: 'br-tag', severity: 'error', message: '<br> is ignored by the engine — use sibling block divs' });
  }
  // Severities follow the MEASURED engine picture, not the oldest claim:
  // error = renders wrong / breaks layout; warn = a no-op or construct-dependent rule the render
  // survives (validated recipes knowingly emit some as dead prefab fidelity).
  const unsupported: [RegExp, string, 'error' | 'warn', string][] = [
    [/display:\s*(inline-)?grid|grid-template/i, 'css-grid', 'error', 'CSS grid is unsupported — use flex'],
    [/(?:^|[^-\w])outline:/im, 'css-outline', 'error', 'the CSS outline property is unsupported — faux-outline via 8-way text-shadow'],
    [/-webkit-text-stroke/i, 'text-stroke', 'warn', '-webkit-text-stroke is construct-dependent (renders on static captions, drops on animated/tilted spans — pixel-count proven) — ground with 8-way text-shadow, never rely on it'],
    [/mix-blend-mode/i, 'blend-mode', 'error', 'mix-blend-mode is unsupported'],
    [/repeating-linear-gradient/i, 'repeating-gradient', 'warn', 'repeating-linear-gradient does not paint (measured on a since-cut ref) — a dead rule; do not rely on it for a visible element'],
    [/font-size:[^;]*\dvw/i, 'vw-font-size', 'error', 'vw font sizes are unsupported — use px (recipes: px × SCALE)'],
    [/border-radius:[^;]*\//, 'radius-slash', 'error', 'border-radius slash syntax renders square — single-value only'],
  ];
  for (const [re, rule, severity, message] of unsupported) {
    if (re.test(css)) f.push({ rule, severity, message });
  }

  // The opacity/stacking trap bites POSITIONED elements: one that animates an opacity keyframes with
  // no explicit z-index loses its stacking context at opacity 1.0 and paints under the z0 video.
  // NOT flagged (both are the same engine truth — an enclosing stacking context above the video):
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
    if (!names.length) continue;
    const positioned = /position\s*:\s*(absolute|fixed|relative)/.test(body);
    if (positioned && !/z-index\s*:/.test(body)) {
      // The z-index may live INLINE per element (some sheets set z per cue: style="z-index:11"),
      // or on an ANCESTOR (the compiled-recipe idiom). Only flag when neither covers every occurrence.
      const cls = selector.match(/^\.([\w-]+)$/)?.[1];
      let coveredInline = false;
      let coveredByAncestor = false;
      if (cls) {
        const tags = [...src.matchAll(new RegExp(`<[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, 'gi'))];
        coveredInline = tags.length > 0 && tags.every((t) => /style="[^"]*z-index/.test(t[0]));
        coveredByAncestor = classCoveredByAncestor(src, cls, zClasses);
      }
      if (!coveredInline && !coveredByAncestor) {
        f.push({ rule: 'opacity-anim-no-z', severity: 'error', message: `rule "${selector}" is positioned and animates opacity (${names.join(', ')}) without an explicit z-index — it can paint UNDER the z0 video at opacity 1 (the stacking trap)` });
      }
    }
    if (/line-height:\s*(0?\.\d+|1(?:\.0*)?|1\.1\d*)(?![\d.])/.test(body) && !/padding/.test(body)) {
      f.push({ rule: 'lineheight-shear', severity: 'warn', message: `rule "${selector}": animated text at line-height < 1.2 without padding headroom — mid-reveal glyphs shear at the em-box (give ~0.1em top / 0.15em bottom padding or line-height >= 1.2)` });
    }
  }

  // --verify names failures by element id: every animated caption element needs a unique id.
  const ids = new Set<string>();
  for (const tag of src.matchAll(/<(?:div|span|h\d|p)\b[^>]*class="[^"]*\b(?:cue|cap|word|w)\b[^"]*"[^>]*>/gi)) {
    const id = tag[0].match(/\bid="([^"]+)"/)?.[1];
    if (id === undefined) continue; // per-word spans may share classes; only cue-level ids are required
    if (ids.has(id)) f.push({ rule: 'duplicate-id', severity: 'error', message: `duplicate element id "${id}" — --verify failure lines become ambiguous` });
    ids.add(id);
  }
  const cueTags = [...src.matchAll(/<div\b[^>]*class="[^"]*\bcue\b[^"]*"[^>]*>/gi)];
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
  const findings = lintTemplate(readFileSync(file, 'utf8'));
  if (argv.includes('--json')) console.log(JSON.stringify(findings, null, 2));
  else for (const x of findings) console.log(`${x.severity.toUpperCase()}[${x.rule}] ${x.message}`);
  const errors = findings.filter((x) => x.severity === 'error').length;
  if (!argv.includes('--json')) console.log(errors ? `lint: ${errors} error(s), ${findings.length - errors} warning(s)` : `lint: clean (${findings.length} warning(s))`);
  process.exit(errors ? 1 : 0);
}
