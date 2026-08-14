// Proves that an edit changed only what it was asked to change.
//
// "I told you to move nothing" is corpus class `regression`, 7 recorded corrections, and every
// instance of it is decidable from the two documents alone. It is the largest defect class in the
// corpus that is 100% static — the two others are one record each. --verify cannot help: both
// documents are valid, and a caption that moved 40ms is exactly as renderable as one that did not.
//
//   node --import tsx pipeline/scripts/scoped-edit.ts <baseline.wv> <candidate.wv> --allow .card3 --allow #cue2
//
// Exit 0 when every difference falls inside the allowed set, 1 otherwise. With no --allow the check
// is "nothing at all may differ", which is the right gate for a pure re-render.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseFlags } from '../../veed/args.ts';

export interface Drift {
  where: string;
  what: string;
  from: string;
  to: string;
}

/** The stylesheet with every @keyframes block cut out — its steps parse as rules otherwise, and one
 *  retimed keyframe would then be reported twice. */
/** The CSS inside every <style> block, tags stripped — `String.match` with /g returns whole matches,
 *  so keeping them would put `<style>` into the first selector of every document. */
function styleText(src: string): string {
  return (src.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? [])
    .map((b) => b.replace(/^<style\b[^>]*>/i, '').replace(/<\/style>$/i, ''))
    .join('\n');
}

function rulesOnly(src: string): string {
  const css = styleText(src);
  let out = '';
  let i = 0;
  const re = /@keyframes\s+[\w-]+\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    out += css.slice(i, m.index);
    let depth = 1, j = re.lastIndex;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    i = j;
    re.lastIndex = j;
  }
  return out + css.slice(i);
}

/** selector → its declaration block, flattened so ordering noise does not read as a change. */
function cssRules(src: string): Map<string, Map<string, string>> {
  const css = rulesOnly(src);
  const out = new Map<string, Map<string, string>>();
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().split('\n').map((s) => s.trim()).filter(Boolean).join(' ');
    if (!selector || selector.startsWith('@')) continue;
    const decls = out.get(selector) ?? new Map<string, string>();
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim().replace(/\s+/g, ' '));
    }
    out.set(selector, decls);
  }
  return out;
}

/** @keyframes name → its body, whitespace-normalised. Timing lives here as much as in the rules. */
function keyframes(src: string): Map<string, string> {
  const css = styleText(src);
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
    out.set(m[1], css.slice(re.lastIndex, i - 1).replace(/\s+/g, ' ').trim());
  }
  return out;
}

/** id → the element's own inline style and text, where generated documents keep per-beat timing. */
function elements(src: string): Map<string, { style: string; text: string }> {
  const out = new Map<string, { style: string; text: string }>();
  for (const m of src.matchAll(/<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>([^<]*)/g)) {
    const id = m[2].match(/\bid="([^"]+)"/)?.[1];
    if (!id) continue;
    out.set(id, {
      style: (m[2].match(/style=(?:"([^"]*)"|'([^']*)')/i)?.slice(1).find((v) => v !== undefined) ?? '').replace(/\s+/g, ' ').trim(),
      text: m[3].trim(),
    });
  }
  return out;
}

/**
 * TRUE when `where` is inside the edit's stated scope.
 *
 * EXACT, per namespace. A first version matched by substring, so `--allow .card` silently blessed
 * `.card3`, `.discard` and `@keyframes cardIn`, and `--allow ""` disabled the gate entirely — in the
 * one tool whose whole purpose is proving that only the named thing changed.
 */
function allowed(where: string, allow: string[]): boolean {
  const kf = where.match(/^@keyframes\s+([\w-]+)$/)?.[1];
  const id = where.match(/^#([\w-]+)$/)?.[1];
  // A selector may be a list ('.a, .b'); every part must be covered for the change to be in scope.
  const parts = kf || id ? [] : where.split(',').map((x) => x.trim()).filter(Boolean);

  const covers = (token: string, target: string): boolean => {
    const t = token.trim();
    if (!t) return false;
    if (kf) return t === kf || t === `@keyframes ${kf}`;
    if (id) return t === `#${id}` || t === id;
    // A class token covers a selector whose own class is exactly that class.
    if (t.startsWith('.')) return target === t || target.split(/[\s>+~:]/)[0] === t;
    if (t.startsWith('#')) return target === t;
    return target === t;
  };

  if (kf || id) return allow.some((t) => covers(t, where));
  return parts.length > 0 && parts.every((part) => allow.some((t) => covers(t, part)));
}

export function scopedDrift(baseline: string, candidate: string, allow: string[]): Drift[] {
  const drift: Drift[] = [];

  const compare = (kind: string, a: Map<string, string>, b: Map<string, string>, where: string) => {
    for (const [k, v] of a) {
      const w = b.get(k);
      if (w === undefined) drift.push({ where, what: `${kind} ${k}`, from: v, to: '(removed)' });
      else if (w !== v) drift.push({ where, what: `${kind} ${k}`, from: v, to: w });
    }
    for (const [k, v] of b) if (!a.has(k)) drift.push({ where, what: `${kind} ${k}`, from: '(absent)', to: v });
  };

  const ra = cssRules(baseline), rb = cssRules(candidate);
  for (const [sel, decls] of ra) {
    if (allowed(sel, allow)) continue;
    const other = rb.get(sel);
    if (!other) { drift.push({ where: sel, what: 'rule', from: 'present', to: '(removed)' }); continue; }
    compare('declaration', decls, other, sel);
  }
  for (const sel of rb.keys()) {
    if (!ra.has(sel) && !allowed(sel, allow)) drift.push({ where: sel, what: 'rule', from: '(absent)', to: 'added' });
  }

  const ka = keyframes(baseline), kb = keyframes(candidate);
  for (const [name, body] of ka) {
    if (allowed(name, allow)) continue;
    const other = kb.get(name);
    if (other === undefined) drift.push({ where: `@keyframes ${name}`, what: 'block', from: 'present', to: '(removed)' });
    else if (other !== body) drift.push({ where: `@keyframes ${name}`, what: 'block', from: body, to: other });
  }

  const ea = elements(baseline), eb = elements(candidate);
  for (const [id, el] of ea) {
    if (allowed(`#${id}`, allow) || allowed(id, allow)) continue;
    const other = eb.get(id);
    if (!other) { drift.push({ where: `#${id}`, what: 'element', from: 'present', to: '(removed)' }); continue; }
    if (other.style !== el.style) drift.push({ where: `#${id}`, what: 'inline style', from: el.style, to: other.style });
    if (other.text !== el.text) drift.push({ where: `#${id}`, what: 'text', from: el.text, to: other.text });
  }
  for (const [id, el] of eb) {
    if (ea.has(id)) continue;
    if (allowed(`#${id}`, allow) || allowed(id, allow)) continue;
    drift.push({ where: `#${id}`, what: 'element', from: '(absent)', to: el.text || 'added' });
  }

  return drift;
}

/**
 * The markup this comparison never looks at.
 *
 * It reads CSS rules, keyframes, and the inline style and first text node of ELEMENTS THAT CARRY AN
 * ID. A generated caption puts its words and their per-word delays on unidentified spans, so all of it
 * fell outside every view — the tool reported "the documents are equivalent" after every glyph had
 * been retimed by 400ms and every word replaced. What it cannot attribute, it now says it cannot
 * attribute, instead of calling it equivalence.
 */
export function unattributed(src: string, allow: string[] = []): string {
  // An element the caller ALLOWED to change must leave the residual with its children, or `--allow`
  // could never pass: a retimed caption is unattributable by construction, so permitting it and then
  // reporting it as unattributed made the documented mode a constant failure.
  let out = src;
  for (const id of allow.map((a) => a.replace(/^#/, ''))) {
    out = removeElement(out, id);
  }
  return out
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')          // every rule is compared elsewhere
    .replace(/<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*\bid="[^"]+"(?:"[^"]*"|'[^']*'|[^>"'])*)>([^<]*)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** An id-carrying element and everything inside it, by tag depth rather than by the first close tag. */
function removeElement(src: string, id: string): string {
  const open = new RegExp(`<([a-zA-Z][\\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"(?:"[^"]*"|'[^']*'|[^>"'])*)>`);
  const m = open.exec(src);
  if (!m) return src;
  const tag = m[1].toLowerCase();
  const tagRe = new RegExp(`<(/?)(${tag})\\b((?:"[^"]*"|'[^']*'|[^>"'])*)>`, 'gi');
  tagRe.lastIndex = m.index + m[0].length;
  let depth = 1;
  let hit: RegExpExecArray | null;
  while ((hit = tagRe.exec(src))) {
    if (/\/\s*$/.test(hit[3])) continue;
    depth += hit[1] ? -1 : 1;
    if (depth === 0) return src.slice(0, m.index) + src.slice(tagRe.lastIndex);
  }
  return src.slice(0, m.index); // unbalanced markup: drop the rest rather than report it as drift
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseFlags({
    args: process.argv.slice(2),
    options: { allow: { type: 'string', multiple: true } },
    allowPositionals: true,
  });
  const files = positionals;
  const allow = (values.allow as string[] | undefined) ?? [];
  if (files.length < 2) {
    console.error('usage: node --import tsx pipeline/scripts/scoped-edit.ts <baseline.wv> <candidate.wv> [--allow <selector|id>]...');
    process.exit(2);
  }
  const baseline = readFileSync(files[0], 'utf8');
  const candidate = readFileSync(files[1], 'utf8');
  const drift = scopedDrift(baseline, candidate, allow);
  const blind = unattributed(baseline, allow) !== unattributed(candidate, allow);
  if (!drift.length && !blind) {
    console.log(allow.length
      ? `scoped-edit: clean — only ${allow.join(', ')} changed`
      : 'scoped-edit: clean — no change in the rules, the keyframes, or any element carrying an id');
    process.exit(0);
  }
  if (blind) {
    console.log(
      'DRIFT (unattributed) — the documents differ in markup this tool does not inspect: text and ' +
      'inline styles on elements with no id. That is where a generated caption keeps its words and ' +
      'their per-word delays, so this cannot be reported as equivalence.',
    );
  }
  for (const d of drift) console.log(`DRIFT ${d.where} — ${d.what}: ${d.from.slice(0, 60)} → ${d.to.slice(0, 60)}`);
  console.log(`scoped-edit: ${drift.length} attributed change(s)${blind ? ' plus unattributed markup' : ''} outside${allow.length ? ` ${allow.join(', ')}` : ' the stated scope'}`);
  process.exit(1);
}
