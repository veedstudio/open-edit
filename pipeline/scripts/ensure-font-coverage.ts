// Guarantee the generated document can draw every script the transcript uses.
//
// Every library recipe declares a Latin webfont stack (Archivo, Playfair, …)
// with Latin system tails. The engine resolves only the webfonts it fetches —
// it does not fall back to system fonts per glyph — so a Chinese, Japanese or
// Korean transcript renders as tofu boxes on every caption, and probe-qa
// cannot tell (it measures ink and contrast, and tofu has both).
//
// This is a deterministic post-pass inside the one writer of the final
// document: when the transcript contains CJK and the document's font stacks
// name no CJK-capable family, the matching Noto family is added to the
// Google Fonts request and appended to each font-family list, ahead of the
// generic keyword. A Latin transcript, or a recipe that already covers the
// script, passes through byte-identical.

const HAN = /[㐀-鿿豈-﫿]/;
const KANA = /[぀-ヿ]/;
const HANGUL = /[가-힯ᄀ-ᇿ]/;

// Han without kana or hangul is undecidable between Traditional and
// Simplified from codepoints alone; Traditional is the default here and a
// recipe (or operator copy) that names its own CJK family always wins.
const FAMILIES: Record<string, { sans: string; serif: string; axis: string }> = {
  tc: { sans: 'Noto Sans TC', serif: 'Noto Serif TC', axis: 'wght@400;500;700;900' },
  jp: { sans: 'Noto Sans JP', serif: 'Noto Serif JP', axis: 'wght@400;500;700;900' },
  kr: { sans: 'Noto Sans KR', serif: 'Noto Serif KR', axis: 'wght@400;500;700;900' },
};

export function cjkScriptOf(text: string): 'tc' | 'jp' | 'kr' | null {
  if (KANA.test(text)) return 'jp';
  if (HANGUL.test(text)) return 'kr';
  if (HAN.test(text)) return 'tc';
  return null;
}

const COVERING = /Noto (Sans|Serif) (TC|SC|JP|KR|HK)|PingFang|Hiragino|Microsoft (JhengHei|YaHei)|Yu Gothic|Malgun|Source Han|思源/;

export function ensureFontCoverage(wv: string, transcriptText: string): string {
  const script = cjkScriptOf(transcriptText);
  if (!script) return wv;
  if (COVERING.test(wv)) return wv;
  const { sans, serif, axis } = FAMILIES[script];

  let out = wv;

  // 1. The webfont request. Extend an existing css2 URL so the fonts arrive
  //    over the connection the recipe already opens; add a link only when
  //    the document loads no webfonts at all.
  const css2 = /(https:\/\/fonts\.googleapis\.com\/css2\?[^"']*?)(&display=[a-z]+)?(["'])/;
  const familyParams =
    `&family=${sans.replace(/ /g, '+')}:${axis}` +
    `&family=${serif.replace(/ /g, '+')}:${axis}`;
  if (css2.test(out)) {
    out = out.replace(css2, (_m, url, display, quote) =>
      `${url}${familyParams}${display ?? ''}${quote}`);
  } else {
    const link =
      `<link rel="preconnect" href="https://fonts.googleapis.com">\n` +
      `<link href="https://fonts.googleapis.com/css2?family=${sans.replace(/ /g, '+')}:${axis}` +
      `&family=${serif.replace(/ /g, '+')}:${axis}&display=swap" rel="stylesheet">\n`;
    out = out.includes('<style') ? out.replace('<style', `${link}<style`) : link + out;
  }

  // 2. Every font-family list gains the covering family just before its
  //    generic keyword, so the declared webfonts keep styling Latin and the
  //    Noto face catches only the glyphs they lack. A serif stack gets the
  //    serif face; everything else the sans.
  out = out.replace(/font-family\s*:\s*([^;}]+)/g, (match, raw: string) => {
    const families = raw.trim();
    if (COVERING.test(families)) return match;
    const wanted = /(^|,)\s*serif\s*($|,)/.test(families) ? serif : sans;
    const generic = families.match(/,\s*(sans-serif|serif|monospace|system-ui)\s*$/);
    if (generic) {
      const head = families.slice(0, generic.index);
      return `font-family:${head},"${wanted}"${generic[0]}`;
    }
    return `font-family:${families},"${wanted}"`;
  });

  return out;
}
