> **AUTHORITY NOTE (2026-07-21):** `recipe.ts` next door is the single source of truth — the
> curation pass (design rounds v2–v6) edited the MODULE only and this sheet has NOT been synced.
> Do not recompile the module from this sheet until it is re-derived.

# hook-244-peak — recipe (9:16 · 736×1312 @ 25fps)

RESOLUTION: px are authored at the 9:16 reference canvas 736×1312. FIRST STEP: SCALE = W/736 from
`meta.json` (require |H − 1312·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE and round (positions, sizes, fonts, px spacing/shadows/margins/tops);
`em` values and ms timings never scale; the manifest carries the run's real W/H.

## 1. IDENTITY

Retro pixel-arcade headline: ALL-CAPS Press Start 2P (wide tech-mono), cream fill with a 5-step
orange-red extruded "echo trail" (pure `text-shadow`, no extra DOM), per-GLYPH neon light-up reveal
(rise + glow flash), an oversized accent numeral when a beat leads with a number, and one oversized
hero word per beat.

## 2. SKELETON

Prefab was 720×1280; every px below is already rescaled ×1.022 to the 736×1312 canvas — copy as-is.
Fill only `{videoPath}` (from `meta.json`). The echo/trail is EXACTLY the `text-shadow` stack on
`.ext`/`.exts` — glyph spans inherit it; the neon reveal glow uses `filter:drop-shadow` so it never
disturbs the extrude. Do not add any other shadow markup.

```html
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');

  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:736px; height:1312px; overflow:hidden; }
  body { position:relative; background:#000; font-family:'Press Start 2P', monospace; }
  .vid { position:absolute; inset:0; width:736px; height:1312px; object-fit:cover; z-index:0; }

  /* beat gate — THE one safe reveal recipe (opacity-trap-safe: explicit z-index on the gate) */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position:absolute; left:70px; z-index:12; opacity:0;
         display:flex; flex-direction:column; align-items:flex-start; gap:14px; }

  /* extruded pixel headline — the echo trail IS this shadow stack */
  .ext  { color:#fae3bb; line-height:1.2; letter-spacing:-0.06em; white-space:nowrap;
          text-shadow: 1px 1px 0 #b74933, 2px 2px 0 #b74933, 3px 3px 0 #ad4530,
                       4px 4px 0 #a8412e, 5px 5px 0 #9a3b2a; }
  /* small-size variant (2-step trail) — its OWN flat class, never a compound selector */
  .exts { color:#fae3bb; line-height:1.2; letter-spacing:-0.06em; white-space:nowrap;
          text-shadow: 1px 1px 0 #b74933, 2px 2px 0 #a8412e; }

  /* accent-numeral row (Layout B only) */
  .row { display:flex; flex-direction:row; align-items:flex-start; gap:49px; }
  .col { display:flex; flex-direction:column; align-items:flex-start; gap:14px; }

  /* per-glyph neon light-up (verbatim from prefab — do not edit) */
  .ch { display:inline-block; opacity:0; animation:neon .42s cubic-bezier(.2,.7,.3,1) both; }
  .sp { display:inline-block; width:0.6em; }
  @keyframes neon {
    0%   { opacity:0; transform:translateY(0.6em);
           filter:drop-shadow(0 0 0 rgba(255,224,138,0)); }
    55%  { opacity:1;
           filter:drop-shadow(0 0 10px rgba(255,210,90,0.95)) drop-shadow(0 0 22px rgba(255,150,40,0.7)); }
    100% { opacity:1; transform:translateY(0);
           filter:drop-shadow(0 0 0 rgba(255,224,138,0)); }
  }
</style>

<video class="vid" src="{videoPath}" muted></video>

<!-- append one .cue block per beat (Section 3) -->
```

`manifest.json` (DUR = `durationSec` from `meta.json`):

```json
{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json
```

## 3. PER-BEAT ASSEMBLY

All caption text is UPPERCASE. Punctuation stays attached to its word; each `words[]` entry in
`word-timings.json` is one word, verbatim (including entries like `-DO`).

**Line count = chars.** "L" for a line = its character count INCLUDING single spaces between its
words. Max width budget is 550px (left 70 → right edge ≤ 620, inside the 9:16 safe margins with
24px inset + 5px shadow bleed). Press Start 2P is a full-width mono: budget 1.0 × font-size per
character — the tables below already do.

**Step 1 — pick the EMPHASIS word** (Section 5 rule). It gets the HERO line, alone.

**Step 2 — group the rest.** Words BEFORE the hero word = before-group; words AFTER = after-group.
Word order is never changed; reading order top→bottom is: before lines, hero line, after lines.
Per group (chars incl. spaces):
- ≤ 20 chars → 1 line.
- 21–68 chars → 2 lines, split at the word boundary nearest the char midpoint.
- 69+ chars (rare) → 3 lines, same balanced split; force all three to 16px `.exts`.

**Step 3 — size each line from the tables** (font-size by that line's L):

Hero line (the emphasis word alone):
| L (chars) | font-size |
|---|---|
| ≤ 6 | 64px |
| 7–8 | 56px |
| 9–10 | 48px |
| 11–12 | 44px |
| ≥ 13 | 36px |

Support lines:
| L (chars) | class | font-size |
|---|---|---|
| ≤ 20 | `.ext` | 27px |
| 21–26 | `.ext` | 21px |
| 27–34 | `.exts` | 16px |
| ≥ 35 | — | never: re-split into more lines first |

**Step 4 — place.** `left` is fixed at 70px (in `.cue`). `top` alternates:
- odd beats (1, 3, 5, …) → `top:165px`
- even beats (2, 4, 6, …) → `top:800px`

(Max stack = 2 + hero + 2 lines ≈ 256px tall → both bands stay inside top≥145 / bottom≤1089.)

### Layout A (default) — beat template

```html
<div class="cue" id="b{N}" style="top:{TOP}px; animation:cueWin {cueDurMs}ms linear {cueDelayMs}ms forwards;">
  <div class="ext"  id="b{N}l1"   style="font-size:{Fpx};"><!-- before-group line 1 glyphs --></div>
  <div class="ext"  id="b{N}l2"   style="font-size:{Fpx};"><!-- before-group line 2 glyphs --></div>
  <div class="ext"  id="b{N}hero" style="font-size:{FHpx};"><!-- hero word glyphs --></div>
  <div class="ext"  id="b{N}l3"   style="font-size:{Fpx};"><!-- after-group line 1 glyphs --></div>
  <div class="ext"  id="b{N}l4"   style="font-size:{Fpx};"><!-- after-group line 2 glyphs --></div>
</div>
```

Omit line divs a beat doesn't need. Use `.exts` instead of `.ext` for 16px lines. `{cueDelayMs}` /
`{cueDurMs}` come from that beat in `word-timings.json`, verbatim.

### Layout B (accent numeral) — ONLY when the beat's FIRST word, punctuation stripped, is a pure
1–2-digit number ("3", "10"). The number becomes the giant accent; the words between it and the
hero word fill the side column; hero + anything after continue full-width below the row.

```html
<div class="cue" id="b{N}" style="top:{TOP}px; animation:cueWin {cueDurMs}ms linear {cueDelayMs}ms forwards;">
  <div class="row">
    <div class="ext" id="b{N}num" style="font-size:86px; line-height:0.95;"><!-- number glyphs --></div>
    <div class="col">
      <div class="ext" id="b{N}c1" style="font-size:{Fpx};"><!-- col line 1 glyphs --></div>
      <div class="ext" id="b{N}c2" style="font-size:{Fpx};"><!-- col line 2 glyphs --></div>
    </div>
  </div>
  <div class="ext" id="b{N}hero" style="font-size:{FHpx};"><!-- hero word glyphs --></div>
</div>
```

Column line sizing (narrower budget — accent + 49px gap eat width):
| digits | L ≤ → 27px `.ext` | L ≤ → 21px `.ext` | L ≤ → 16px `.exts` |
|---|---|---|---|
| 1 | 15 | 19 | 25 |
| 2 | 12 | 15 | 20 |

Column holds ≤ 3 lines. If the between-words don't fit those 3 lines, ABANDON Layout B for this
beat and use Layout A (the number is then just a normal word). If the number itself is the
emphasis word, there is no separate hero line — the 86px accent is the hero.

## 4. WORDS + TIMING

Glyph-level ref → one `.ch` span PER CHARACTER; between words insert exactly one
`<span class="sp"></span>` (inter-span whitespace is dropped by the engine — the spacer is the
space).

Each glyph's `animation-delay` is derived from its WORD's `delayMs` in `word-timings.json`
(the word onset is VERBATIM — never invented):

```
JIT   = [0, 120, 40, 160, 80, 20, 140, 60, 100, 180]      (fixed scramble cycle)
CLAMP = cueDelayMs + cueDurMs - 500                        (per beat)
glyph k of a word (k = 0,1,2,… within that word):
  delay = min( word.delayMs + JIT[k mod 10], CLAMP )
```

The clamp guarantees every glyph finishes its .42s entrance ≥ 80ms before the cue gate closes
(otherwise `--verify` reports it never fully visible). Do NOT add per-word `wIn` animations — the
`.ch` neon animation IS the word entrance; the `.cue` gate carries
`animation:cueWin {cueDurMs}ms linear {cueDelayMs}ms forwards` and nothing else animates opacity.

Worked example — beat 3 of a run (`cueDelayMs:3811, cueDurMs:1300` → CLAMP 4611), words
`actually(3811) hate(4170) Mondays.(4530)`; emphasis = ACTUALLY (8 letters, longest content word)
→ hero 56px on top, after-group `HATE MONDAYS.` (L=13 → 27px) below:

```html
<div class="cue" id="b3" style="top:165px; animation:cueWin 1300ms linear 3811ms forwards;">
  <div class="ext" id="b3hero" style="font-size:56px;"><span class="ch" style="animation-delay:3811ms">A</span><span class="ch" style="animation-delay:3931ms">C</span><span class="ch" style="animation-delay:3851ms">T</span><span class="ch" style="animation-delay:3971ms">U</span><span class="ch" style="animation-delay:3891ms">A</span><span class="ch" style="animation-delay:3831ms">L</span><span class="ch" style="animation-delay:3951ms">L</span><span class="ch" style="animation-delay:3871ms">Y</span></div>
  <div class="ext" id="b3l1" style="font-size:27px;"><span class="ch" style="animation-delay:4170ms">H</span><span class="ch" style="animation-delay:4290ms">A</span><span class="ch" style="animation-delay:4210ms">T</span><span class="ch" style="animation-delay:4330ms">E</span><span class="sp"></span><span class="ch" style="animation-delay:4530ms">M</span><span class="ch" style="animation-delay:4611ms">O</span><span class="ch" style="animation-delay:4570ms">N</span><span class="ch" style="animation-delay:4611ms">D</span><span class="ch" style="animation-delay:4610ms">A</span><span class="ch" style="animation-delay:4550ms">Y</span><span class="ch" style="animation-delay:4611ms">S</span><span class="ch" style="animation-delay:4590ms">.</span></div>
</div>
```

(Note `MONDAYS.` glyphs hitting the 4611 clamp — that is correct behaviour.)

## 5. EMPHASIS

The hero device is SIZE only (never a colour change). Pick rule, no judgment:

1. A pure-number token in the beat always wins (and, if it is the FIRST word, triggers Layout B).
2. Otherwise: the longest CONTENT word by letter count (strip punctuation before counting; ties →
   the LATER word). Content = any word not in this stoplist:
   `a an the to of in on at my we so and or but is are was it its i me you your how just one with for`.
3. On the LAST beat only: the last content word of the beat wins regardless of length.

## 6. VERIFY LOOP

Write `runs/<key>/final/template.wv` + `runs/<key>/final/manifest.json`
(`{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json`), then:

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Exit 1 → apply the MECHANICAL fix for each flagged element id, re-run; at most 2
fix cycles:

- `FAIL[bounds] … right … outside` → drop the named line ONE font-size tier in its table (hero
  56→48→44→36; support 27→21→16 switching class `.ext`→`.exts` at 16). Never move `left`.
- `FAIL[bounds] … bottom …` → set that beat's `top` to the other band value (800 → 165).
- `FAIL[never-visible]` → that glyph's `animation-delay` exceeds its beat's CLAMP — recompute
  `min(word.delayMs + JIT[k mod 10], cueDelayMs + cueDurMs − 500)` for the named element's glyphs.
- `FAIL[occluded]` → the named element's `.cue` lost its gate: confirm the cue div has `z-index:12`
  (it must come from the `.cue` class) and that its `animation:` line matches the template exactly.

Then, clean run only:

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --record {repo}/runs/<key>/final/out.silent.mp4
```

## 7. DO NOT

- No fonts, colours, shadows, or `@keyframes` beyond this sheet; no second animation on any element.
- No invented timing: every word onset is its `delayMs` from `word-timings.json`; only the JIT/CLAMP
  arithmetic of Section 4 may modify a glyph's delay.
- Never read the run's frames or the video; never re-litigate placement beyond the two `top` bands.
- Never use compound/descendant selectors (`.ext.sm`, `.cue span`) — only the flat classes above.
- Never put a scrim/box behind text; the extrude shadow is the legibility device.
- Never let a line exceed its table's max L — re-split instead; never widen past left 70 / right 620.
