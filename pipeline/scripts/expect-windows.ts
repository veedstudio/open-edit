// Turn the document's own gate timings into assertions `--verify` can fail on.
//
// The engine already accepts a `verify.expect` block in the manifest — "this element must be visible
// from 2.1s to 3.4s" — and it has gone essentially unused, because writing the list by hand for forty
// cues is nobody's idea of a good time. The document already states every window, so the list can be
// derived rather than written.
//
// This closes the corpus's largest class. `timing-offset` is 30 recorded corrections — a reveal
// that starts late, a beat that holds too long, a caption still up when the next one arrives — and
// none of them are visible to `--verify` today, because verify checks what IS drawn and every one of
// these documents draws something. An expectation is what makes "drawn at the wrong time" a failure.
//
//   expect-windows.ts <run-dir> [--write] [--tolerance-ms 40]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFlags } from '../../veed/args.ts';

export interface Expectation {
  element: string;
  visible: boolean;
  from: number;
  to: number;
}

/** ms from a CSS time token. */
function ms(tok: string | undefined): number | undefined {
  const m = tok?.trim().match(/^(-?[\d.]+)(ms|s)$/);
  if (!m) return undefined;
  return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
}

function keyframeNames(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    let depth = 1, i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    out.set(m[1], css.slice(re.lastIndex, i - 1));
  }
  return out;
}

/**
 * Every element with an id whose gate holds it visible across a window, as an assertion.
 *
 * A gate is a keyframes block that ENDS hidden (`100% { opacity: 0 }`) — the cue-window idiom. The
 * assertion is sampled INSIDE the window by `toleranceMs` at each end, because an assertion that
 * straddles the flip instant tests the engine's rounding rather than the design's timing.
 */
/** Tags that never wrap anything, so they never open a level. */
const VOID = new Set(['br', 'img', 'source', 'track', 'input', 'meta', 'link', 'hr', 'area', 'base', 'col', 'embed', 'wbr']);

/**
 * Every id-carrying element with its TRUE inner html.
 *
 * A non-greedy `([\s\S]*?)<\/\1>` stops at the first closing tag of the same name, which for a div
 * holding a div is the inner one. The leftover text then read as the parent's own ink, so the
 * "skip elements with no ink of their own" guard never fired and the gate emitted assertions that
 * FAIL on documents which render perfectly — 18 of them across this repository's own accepted corpus.
 */
export function elementsWithId(wv: string): { open: string; attrs: string; id: string; inner: string }[] {
  const out: { open: string; attrs: string; id: string; inner: string }[] = [];
  // Blanked rather than removed, so every offset and line number downstream stays true. A commented-out
  // element is not in the document, and asserting on its id fails a render that is perfectly correct.
  wv = wv.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const opens: { name: string; attrs: string; id?: string; innerStart: number; openTag: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(wv))) {
    const [whole, slash, name, attrs] = m;
    const lower = name.toLowerCase();
    if (VOID.has(lower)) continue;
    if (slash) {
      // Close the most recent open of this name; unbalanced markup simply yields nothing for it.
      for (let i = opens.length - 1; i >= 0; i--) {
        if (opens[i].name !== lower) continue;
        const o = opens.splice(i, 1)[0];
        if (o.id) out.push({ open: o.openTag, attrs: o.attrs, id: o.id, inner: wv.slice(o.innerStart, m.index) });
        break;
      }
      continue;
    }
    if (/\/\s*$/.test(attrs)) continue; // self-closing
    opens.push({
      name: lower,
      attrs,
      id: attrs.match(/\bid="([^"]+)"/)?.[1],
      innerStart: m.index + whole.length,
      openTag: whole,
    });
  }
  return out;
}

export function expectationsFor(wv: string, durationMs: number, toleranceMs = 40): Expectation[] {
  const css = wv.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)?.join('\n') ?? '';
  const frames = keyframeNames(css);
  const closing = new Set(
    [...frames].filter(([, body]) => /(?:\b100%|\bto)\s*\{[^}]*opacity\s*:\s*0(?![.\d])/.test(body)).map(([n]) => n),
  );

  // class → the closing gate it names, and any timing the rule itself fixes.
  const gated = new Map<string, { dur?: number; delay?: number }>();
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().split('\n').pop()!.trim();
    const body = m[2];
    if (sel.startsWith('@') || sel.includes('%')) continue;
    const cls = sel.match(/^\.([\w-]+)$/)?.[1];
    if (!cls) continue;
    const short = body.match(/animation\s*:\s*([^;]+)/)?.[1];
    const name = short?.trim().split(/\s+/)[0] ?? body.match(/animation-name\s*:\s*([\w-]+)/)?.[1];
    if (!name || !closing.has(name)) continue;
    const times = (short ?? '').replace(name, '').trim().split(/\s+/).map(ms).filter((v): v is number => v !== undefined);
    gated.set(cls, {
      dur: times[0] ?? ms(body.match(/animation-duration\s*:\s*([^;]+)/)?.[1]),
      delay: times[1] ?? ms(body.match(/animation-delay\s*:\s*([^;]+)/)?.[1]),
    });
  }

  // The slowest ENTRANCE in the document — an animation that ends visible rather than hidden. Every
  // gate's assertion waits it out, because until it finishes the content inside the gate is mid-fade.
  let entranceMs = 0;
  for (const [name, body] of frames) {
    if (closing.has(name)) continue;
    if (!/opacity/.test(body)) continue;
    for (const m of css.matchAll(new RegExp(`animation\\s*:\\s*${name}([^;}]*)`, 'g'))) {
      const times = m[1].trim().split(/\s+/).map(ms).filter((v): v is number => v !== undefined);
      if (times.length) entranceMs = Math.max(entranceMs, (times[0] ?? 0) + (times[1] ?? 0));
    }
  }

  const out: Expectation[] = [];
  for (const el of elementsWithId(wv)) {
    const tag = [el.open] as unknown as RegExpMatchArray;
    (tag as unknown as string[])[1] = el.attrs.match(/class="([^"]*)"/)?.[1] ?? '';
    const id = el.id;
    const inner = el.inner;
    // `expect-visible` measures the ink of the element ITSELF. When the words live in child spans —
    // the cue/word structure the brief prescribes and every recipe emits — the parent has no ink of
    // its own and the assertion fails on a document that renders perfectly. Verified on engine 0.8.0
    // (`tests/expect-visible-nested.test.ts`), so those elements are skipped rather than asserted wrongly.
    const ownText = inner.replace(/<(\w+)[^>]*>[\s\S]*?<\/\1>/g, '').replace(/<[^>]*>/g, '').trim();
    if (!ownText) continue;
    const style = tag[0].match(/style=(?:"([^"]*)"|'([^']*)')/i)?.slice(1).find((v) => v !== undefined) ?? '';
    for (const cls of String(tag[1]).split(/\s+/).filter(Boolean)) {
      const g = gated.get(cls);
      if (!g) continue;
      const short = style.match(/animation\s*:\s*([^;"]+)/)?.[1];
      const times = (short ?? '').trim().split(/\s+/).map(ms).filter((v): v is number => v !== undefined);
      const dur = times[0] ?? ms(style.match(/animation-duration\s*:\s*([^;"]+)/)?.[1]) ?? g.dur;
      const delay = times[1] ?? ms(style.match(/animation-delay\s*:\s*([^;"]+)/)?.[1]) ?? g.delay ?? 0;
      if (dur === undefined) continue;
      // The gate opening is not the moment the content is ON SCREEN. Inside it, words are still
      // entering — at 40ms into a 380ms rise the glyph is at about a tenth of its opacity, and an
      // assertion there tests the entrance rather than the timing it exists to check. Start after the
      // slowest entrance in the document has finished.
      const from = delay + Math.max(toleranceMs, entranceMs + toleranceMs);
      const to = Math.min(delay + dur - toleranceMs, durationMs - toleranceMs);
      // A window too short to sample inside proves nothing; asserting on it would only be noise.
      if (to <= from) continue;
      out.push({ element: id, visible: true, from: Number((from / 1000).toFixed(3)), to: Number((to / 1000).toFixed(3)) });
      break;
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseFlags({
    args: process.argv.slice(2),
    options: { write: { type: 'boolean' }, 'tolerance-ms': { type: 'string' }, doc: { type: 'string' } },
    allowPositionals: true,
  });
  const dir = positionals[0];
  if (!dir) { console.error('usage: expect-windows.ts <run-dir> [--doc final] [--write] [--tolerance-ms 40]'); process.exit(2); }
  // A film has one document per chapter. Hardcoding `final` made the gate chain's own --doc flag a
  // lie: it reached lint and the engine and stopped here, on a path that does not exist.
  const doc = (values.doc as string | undefined) ?? 'final';
  const mfPath = join(dir, doc, 'manifest.json');
  const mf = JSON.parse(readFileSync(mfPath, 'utf8')) as { render: { duration: number }; verify?: { derivedBy?: string; expect: Expectation[] } };
  const wv = readFileSync(join(dir, doc, 'template.wv'), 'utf8');
  const tol = Number(values['tolerance-ms'] ?? 40);
  if (!Number.isFinite(tol) || tol < 0) {
    console.error(`--tolerance-ms must be a non-negative number, got "${values['tolerance-ms']}"`);
    process.exit(2);
  }
  const expect = expectationsFor(wv, mf.render.duration * 1000, tol);

  if (!expect.length) { console.log('expect-windows: no gated elements with ids — nothing to assert'); process.exit(0); }
  if (values.write) {
    // Stamped so a later run can tell its own work from a block somebody wrote on purpose. Without
    // this the gate chain saw any `verify` block as authored and kept a document gated against the
    // timings of an earlier render.
    mf.verify = { derivedBy: 'expect-windows', expect };
    writeFileSync(mfPath, JSON.stringify(mf, null, 2) + '\n');
    console.log(`expect-windows: wrote ${expect.length} expectation(s) into ${mfPath} — --verify now fails when a cue is off screen inside its own window`);
  } else {
    console.log(JSON.stringify({ verify: { expect } }, null, 2));
    console.log(`\nexpect-windows: ${expect.length} expectation(s); pass --write to put them in the manifest`);
  }
}
