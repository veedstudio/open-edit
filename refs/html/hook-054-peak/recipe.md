# RECIPE — hook-054-peak (9:16 · 736×1312 @ 25fps)

RESOLUTION: px are authored at the 9:16 reference canvas 736×1312. FIRST STEP: SCALE = W/736 from
`meta.json` (require |H − 1312·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE and round: `left/top` (cx, cy), the radius R, the arc per-cue
font-size, the payoff font-sizes, `top`/`left`/`width`, and the px text-shadow offsets/blurs. Arc **angles
are degrees — they NEVER scale**; `em` values and ms timings never scale; the manifest carries the run's
real W/H. This sheet is authored DIRECTLY at 736×1312 — copy the numbers as written, never rescale again
for SCALE = 1.

## 1. IDENTITY

A **two-register** caption. Per beat, the first 2–3 words ride a gold italic-serif ACCENT arc — deep-gold
Cormorant (`#e9bd2b`), letters on a shallow crown that hangs high over the subject's head (per-glyph
rotation, tight tracking), words rising in one at a time on their real spoken timing, defined by a crisp
dark STROKE (no glow). The remaining words land as a clean white **BODY** payoff (Archivo bold, `#f7f5f3`)
anchored in the lower third — each word rising on its beat, the hero word turning pure white 800. Both
registers reveal within ONE cue and HOLD ON SCREEN TOGETHER for the whole beat (arc above, body below); the
cue gate cuts both at the next beat's start. The beat's hero: on the arc it turns hot-amber (`#e89a1c`) and
a number-hero also enlarges (the prefab's "big 6" accent); in the body it turns white 800.

## 2. SKELETON

Paste this whole document as `runs/<key>/final/template.wv`, then insert one `.cue` block per BEAT
(section 3) after the `<video>`, in time order. Replace only `{videoPath}` (from `meta.json`). Canvas: see
RESOLUTION at the top of this sheet. All px below are at SCALE = 1; multiply by SCALE otherwise.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700;800&family=Cormorant+Garamond:ital,wght@1,600;1,700&display=swap" rel="stylesheet" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 736px; height: 1312px; overflow: hidden; }
  body { position: relative; background: #000; font-family: "Cormorant Garamond", Georgia, serif; }
  .vid { position: absolute; inset: 0; width: 736px; height: 1312px; object-fit: cover; z-index: 0; }

  /* cue gate — the one safe reveal recipe; opacity-only (never a transform ancestor over animated words).
     Hard cut at the successor's start. delay+duration+z-index set inline per cue (section 3). */
  @keyframes cueWin { 0%, 99.99% { opacity: 1; } 100% { opacity: 0; } }
  .cue { position: absolute; inset: 0; opacity: 0; pointer-events: none;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* ---- ARC: gold Cormorant italic accent crown (upper zone, above the head) ---- */
  /* font-size is set INLINE on the .arc container (the C size ladder) and INHERITED by the arc-chars. */
  .arc { position: absolute; inset: 0; }
  .arc-char { position: absolute; left: 368px; top: 520px;
    font-style: italic; font-weight: 700; line-height: 1; color: #e9bd2b; white-space: pre;
    text-shadow:
      -1px -1px 0 #15100a, 1px -1px 0 #15100a, -1px 1px 0 #15100a, 1px 1px 0 #15100a,
      0 -1.7px 0 #15100a, 0 1.7px 0 #15100a, -1.7px 0 0 #15100a, 1.7px 0 0 #15100a; }
  .arc-char.hero { color: #e89a1c; }     /* the beat's hero word, if it rides the arc (section 5) */
  .arc-char.big  { font-size: 1.32em; }  /* number-hero accent only (section 5) */

  /* arc word reveal — carried on an INNER span so each glyph's static arc transform is untouched (the
     two-span unit; never animate the .arc-char itself). padding = shear headroom at line-height 1. */
  .w { display: inline-block; opacity: 0; padding: 0.1em 0 0.18em;
       animation: wordIn .42s cubic-bezier(.2,.7,.3,1) both; }
  @keyframes wordIn { 0% { opacity: 0; transform: translateY(0.28em); } 100% { opacity: 1; transform: translateY(0); } }

  /* ---- BODY: clean white Archivo payoff (lower third) — the hook-230 payoff register ---- */
  .pay { position: absolute; left: 68px; top: 852px; width: 600px; }   /* centered on the frame axis (x=368) */
  .payline { display: block; width: 600px; text-align: center; white-space: nowrap; line-height: 1.0;
             font-family: 'Archivo', system-ui, sans-serif; font-weight: 700; letter-spacing: -0.5px; color: #f7f5f3;
             text-shadow: 0 2px 7px rgba(0,0,0,.6), 0 0 3px rgba(0,0,0,.55); }   /* soft dark ground for light footage */
  .pw { display: inline-block; opacity: 0; margin-right: 0.24em;   /* word gap (inter-span whitespace is dropped) */
        animation: payIn .42s cubic-bezier(.2,.7,.3,1) both; }
  @keyframes payIn { 0% { opacity: 0; transform: translateY(0.28em); } 100% { opacity: 1; transform: translateY(0); } }
  .pw.hero { color: #ffffff; font-weight: 800; }   /* body hero word only (section 5) */

  /* PAYOFF size ladder (Archivo 700; advance budget 0.60·fs/char incl. gaps; line budget 600px) —
     art-director pass: ×0.8 on every step (class names kept as the original ladder's px for lookup). */
  .p54 { font-size: 43px; } .p52 { font-size: 42px; } .p50 { font-size: 40px; } .p47 { font-size: 38px; }
  .p45 { font-size: 36px; } .p43 { font-size: 34px; } .p41 { font-size: 33px; } .p40 { font-size: 32px; }
  .p38 { font-size: 30px; } .p37 { font-size: 30px; } .p35 { font-size: 28px; } .p33 { font-size: 26px; }
  .p31 { font-size: 25px; } .p29 { font-size: 23px; } .p27 { font-size: 22px; }
</style>
</head>
<body>
  <video class="vid" src="{videoPath}" muted></video>
  <!-- one .cue block per BEAT goes here, in time order -->
</body>
</html>
```

`manifest.json` (verbatim; W/H/FPS/DUR from `meta.json`, DUR = `durationSec`):

```json
{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}
```

## 3. PER-BEAT ASSEMBLY

One `.cue` per BEAT `{N}` of `word-timings.json`. Inside it: one `.arc` crown (the accent words) then one
`.pay` block (the body words, 1–2 lines). Both are gated by the SAME cue and hold together for the beat.

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N}; animation-delay:{cueDelayMs}ms; animation-duration:{winMs}ms">
  <div class="arc" id="b{N}k" data-node-id="b{N}k" style="font-size:{FONT}px">
    <!-- one .arc-char per CHARACTER of the accent text (incl. the single space between accent words),
         in order, angles from the section-3 table; a SPACE is a bare arc-char with NO inner .w -->
    <span class="arc-char" data-node-id="b{N}a{i}" data-node-role="text"
          style="transform:translate(-50%,-50%) rotate({ANGLE}deg) translateY(-325px);transform-origin:50% 50%"><span class="w" style="animation-delay:{delayMs}ms">{char}</span></span>
    <span class="arc-char" data-node-id="b{N}a{i}"
          style="transform:translate(-50%,-50%) rotate({ANGLE}deg) translateY(-325px);transform-origin:50% 50%"> </span>
  </div>
  <div class="pay" id="b{N}p" data-node-id="b{N}p">
    <div class="payline p{P}" id="b{N}l1" data-node-id="b{N}l1" data-node-role="text">
      <span class="pw" style="animation-delay:{delayMs}ms">word</span>…more .pw…
    </div>
    <!-- second .payline id b{N}l2 only if the body needs 2 lines -->
  </div>
</div>
```

**Word prep:** keep each word's ORIGINAL case and punctuation (`invite,` `meetings.` `10,000` render
as-is). GLUE a token starting with `-` (e.g. `-do` after `to`) to the previous word as ONE unit for the
split/count; render it as two adjacent glyphs on the arc (no space between them, each half keeps its OWN
`delayMs`) or two adjacent `.pw` spans in the body (facing gap zeroed: `margin-right:0` on the first,
`margin-left:0` on the `-` span). Never reorder or drop words.

**Accent / body split — deterministic, ORDER PRESERVED:**
- `n` = the beat's word count (after GLUE).
- ACCENT (arc) = the first `k` words, `k = min(3, ceil(n/2))`; if `k ≥ n`, use `k = n − 1` (body keeps ≥1
  word). BODY = the remaining words. (n=3→2+1, n=4→2+2, n=6→3+3, n=7→3+4, n=9→3+6. n=1→ accent 1, body
  empty: omit the `.pay` div.) The arc carries at most 3 words — a stable short crown, never the whole cue.

**ARC assembly + sizing.** Build the accent CHARACTER stream: the accent words joined by ONE space; emit
one `.arc-char` per character (letters, digits, punctuation, AND the inter-word spaces) left→right. `C` =
that character count (incl. spaces). Set `font-size:{FONT}px` on the `.arc` div; emit the C arc-chars with
the ANGLES read straight off this row (no arithmetic — the k-th arc-char takes the k-th angle). Radius
R = 325 for every row (already in the skeleton's `translateY(-325px)`; scale with SCALE). Every character
of a word shares that word's `delayMs`; the word rises as a unit. A SPACE gets NO `.w` (bare arc-char).

| C | FONT | ANGLES (deg, left→right — one per character incl. spaces) |
|---|------|-----------------------------------------------------------|
| 1 | 125 | 0.00 |
| 2 | 125 | -6.61, 6.61 |
| 3 | 125 | -13.22, 0.00, 13.22 |
| 4 | 125 | -19.83, -6.61, 6.61, 19.83 |
| 5 | 118 | -24.96, -12.48, 0.00, 12.48, 24.96 |
| 6 | 118 | -31.20, -18.72, -6.24, 6.24, 18.72, 31.20 |
| 7 | 106 | -33.64, -22.42, -11.21, 0.00, 11.21, 22.42, 33.64 |
| 8 | 106 | -39.24, -28.03, -16.82, -5.61, 5.61, 16.82, 28.03, 39.24 |
| 9 | 99 | -41.89, -31.42, -20.94, -10.47, 0.00, 10.47, 20.94, 31.42, 41.89 |
| 10 | 99 | -47.12, -36.65, -26.18, -15.71, -5.24, 5.24, 15.71, 26.18, 36.65, 47.12 |
| 11 | 93 | -49.19, -39.35, -29.51, -19.67, -9.84, 0.00, 9.84, 19.67, 29.51, 39.35, 49.19 |
| 12 | 90 | -52.36, -42.84, -33.32, -23.80, -14.28, -4.76, 4.76, 14.28, 23.80, 33.32, 42.84, 52.36 |
| 13 | 86 | -54.58, -45.48, -36.39, -27.29, -18.19, -9.10, 0.00, 9.10, 18.19, 27.29, 36.39, 45.48, 54.58 |
| 14 | 83 | -57.07, -48.29, -39.51, -30.73, -21.95, -13.17, -4.39, 4.39, 13.17, 21.95, 30.73, 39.51, 48.29, 57.07 |
| 15 | 80 | -59.24, -50.77, -42.31, -33.85, -25.39, -16.92, -8.46, 0.00, 8.46, 16.92, 25.39, 33.85, 42.31, 50.77, 59.24 |

(Closed form the table was built from, for reference only — READ the table, don't recompute:
`angle(k) = (k − (C−1)/2) × step`, k = 0…C−1, `step(deg) = 0.60 × FONT × 180/π ÷ 325` — the 0.60 em/char
angular advance is the TIGHT tracking. FONT is the ORIGINAL ladder ×1.6 (art-director pass: bigger accent,
re-solved for the tight-tracking step so glyphs still don't overlap), rounded. Accent is ≤3 words so C
rarely exceeds 15; a C>15 crown uses FONT=80 with the C=15 step and is caught by `--verify` bounds if it
ever overflows.)

**ARC placement is FIXED by the geometry:** center `left:368px; top:520px`, radius 325 — the crown apex sits
at y≈195 (≥11% safe top); the widest row (C=15) reaches x≈643/y≈373 (measured on rendered frames, incl.
glyph extent), clear of the dead-center face and inside the safe margins (left ≥54, right ≤655 — the 11%
frame margin). Do NOT move it per beat.

**BODY assembly + sizing** (the hook-230 payoff register):
- For COUNTING: a word's char-length = its glyphs after stripping ONE trailing `.` or `,`; keep `?` `!` `'`
  `-` and any INTERNAL comma (`10,000` = 6). `C_tot` = Σ(body word lengths) + (body word count − 1) gaps.
- **Lines: `C_tot ≤ 20` → 1 line** (all body words). **`C_tot > 20` → 2 lines**: start line 1 empty
  (running = 0); take body words IN ORDER, for each `add = length + (1 if line 1 already holds a word else
  0)` — if `running + add ≤ ceil(C_tot/2)` append to line 1 and add to `running`, else STOP; all remaining
  words go to line 2 (line 1 always keeps ≥ its first word).
- One `.pw` span per body word; `.pw { margin-right:0.24em }` IS the gap (no literal spaces).
- **BODY size** `{P}` — `C` = char count of the LONGEST body line (Σ its word lengths + its gaps). Look up
  (both lines share the ONE class):

  | C ≤18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28–29 | 30–31 | 32–33 | 34–35 | ≥36 |
  |-------|----|----|----|----|----|----|----|----|----|-------|-------|-------|-------|-----|
  | p54 | p52 | p50 | p47 | p45 | p43 | p41 | p40 | p38 | p37 | p35 | p33 | p31 | p29 | p27 |

- **BODY placement is FIXED:** `.pay` at `left:68 top:852 width:600`, `.payline` CENTER-aligned — the lower
  band, centered on the frame axis (x=368), clear of the dead-center head. Safe check: box left 68 ≥ 44
  (6%), box right edge 668 ≤ 655+~13 (11%) — the box itself is a hair wider than the strict margin, but
  centered text-align means the RENDERED line (never the full 600px box) is what sits symmetric about x=368,
  and the ladder's actual sizes (post ×0.8 pass) keep every real line comfortably inside; a 2-line p54 body
  at the smaller ladder + `line-height:1.0` bottoms well above 1089 (17%). `line-height` was requested at
  ⅓ tighter (0.8) but that measurably overlaps a stacked 2-line body's ascender/descender on this font at
  this size (verified on rendered frames) — 1.0 is the tightest value that still reads clean; ship 1.0, not
  0.8. The ladder guarantees the 600px fit — never discover a fit via `--verify`.

**`{z}` (paint order):** `{z} = 10 + N` (beat number). Cues never overlap in time; ascending z keeps
handoffs clean.

## 4. WORDS + TIMING

Delays are ABSOLUTE ms on the single timeline — paste `word-timings.json` values as-is, never re-zero,
never invent. Let `gateClose = cueDelayMs + winMs` (the moment this beat's cue cuts).

- **Cue gate.** `{cueDelayMs}` = the beat's `cueDelayMs`. `{winMs}` = NEXT beat's `cueDelayMs` − this
  beat's. LAST beat: `{winMs}` = `round(durationSec×1000)` − this beat's `cueDelayMs` (it holds full to the
  end — the gate cuts it, no fade). The `.cue` gets inline `z-index:{10+N}; animation-delay:{cueDelayMs}ms;
  animation-duration:{winMs}ms`.
- **Arc glyphs.** Every `.w`'s `animation-delay` = its WORD's `delayMs` VERBATIM (all glyphs of a word
  share it). SPACE arc-chars carry no `.w`.
- **Body words.** Each `.pw`'s `animation-delay` = that word's `delayMs` VERBATIM.
- **Gate-compress (one closed form).** For ANY animated unit (a `.w` or a `.pw`) with base entrance
  `bd = 420` and its `animation-delay = delay`: if `delay + 420 > gateClose`, give THAT unit inline
  `animation-duration: max(gateClose − delay, 250)ms` (so a word spoken close to the gate still reaches
  full opacity before the cut; never below 250). Units that already finish before `gateClose` carry NO
  inline duration (they use the CSS default `.42s`).

Word spacing on the arc is native (a SPACE occupies its own angular slot — that IS the gap; each glyph is
placed independently, so words never fuse). Body spacing is the `.pw` `margin-right` — never literal spaces.

## 5. EMPHASIS

Both registers ARE the emphasis system (the gold arc accents the setup; the bold white body lands the
payoff). On top of that, mark exactly ONE hero word per BEAT — pick rule, NO judgment, over ALL the beat's
words:
1. If any word contains a digit, that token is the hero (first such token).
2. Otherwise the word with the most LETTERS (a–z, ignoring punctuation); a tie → the LATER word.

Style it by WHICH register it lands in:
- Hero in the **ARC**: add class `hero` to its every arc-char → hot-amber `#e89a1c` (same stroke); AND if
  it is a DIGIT token, also add `big` → its glyphs enlarge to 1.32em (the prefab's "big number" accent).
- Hero in the **BODY**: add `hero` to its `.pw` (`class="pw hero"`) → pure-white Archivo 800.

Nothing else changes for the hero — same register, same angles/size, same word timing.

## 6. BOUNDED VARIETY

One axis (default first). State the choice in the REPORT. When in doubt, take the default.
- **DEVICE INTENSITY** — how loud the number accent is:
  - `standard` (default): a digit-hero on the arc gets `big` (section 5 as written).
  - `calm`: a digit-hero on the arc turns hot-amber only — do NOT add `big` (drop the `big` class
    everywhere). Use for a restrained/formal read; strictly a subset of `standard`, so it stays verify- and
    margin-clean.

No axis may touch fonts, the palette, keyframe mechanics, timing, geometry, the accent/body split, or
anything under DO NOT.

## 7. WORKED EXAMPLE (beat 1: `So I built an app that does one thing.`, cueDelay 320, next beat 2080)

n=9 → accent `k = min(3, ceil(9/2)) = 3` → accent `So I built`, body `an app that does one thing.`.
Hero of the beat = most letters, tie `built`/`thing` → later `thing` (in the BODY → white 800).
`{winMs}` = 2080 − 320 = 1760; gateClose = 2080. z = 11.

ARC: accent stream `So I built` → `S o (sp) I (sp) b u i l t` = C=10 → FONT=99, the C=10 angle row.
Delays: `So`=320, `I`=400, `built`=520 (all glyphs of a word share its delay; no gate-compress — 520+420 <
2080). First three arc-chars:

```html
<div class="cue" id="cue1" data-node-id="cue1" style="z-index:11; animation-delay:320ms; animation-duration:1760ms">
  <div class="arc" id="b1k" data-node-id="b1k" style="font-size:99px">
    <span class="arc-char" data-node-id="b1a0" data-node-role="text" style="transform:translate(-50%,-50%) rotate(-47.12deg) translateY(-325px);transform-origin:50% 50%"><span class="w" style="animation-delay:320ms">S</span></span>
    <span class="arc-char" data-node-id="b1a1" data-node-role="text" style="transform:translate(-50%,-50%) rotate(-36.65deg) translateY(-325px);transform-origin:50% 50%"><span class="w" style="animation-delay:320ms">o</span></span>
    <span class="arc-char" data-node-id="b1a2" style="transform:translate(-50%,-50%) rotate(-26.18deg) translateY(-325px);transform-origin:50% 50%"> </span>
    <!-- …I (rotate -15.71, delay 400) · space -5.24 · built b/u/i/l/t (5.24/15.71/26.18/36.65/47.12, delay 520) -->
  </div>
```

BODY: `an app that does one thing.` → lengths an2 app3 that4 does4 one3 thing5 (trailing `.` stripped),
C_tot = 21 + 5 = 26 > 20 → 2 lines, half = 13. Line 1 fills `an app that` (running 11); line 2
`does one thing.`. Longest line C=14 → **p54**. Words keep THEIR delays (`an` 720, `app` 840, …
`thing.` 1680); `thing.` gets gate-compress (1680 + 420 = 2100 > 2080 → duration max(2080−1680,250)=400).

```html
  <div class="pay" id="b1p" data-node-id="b1p">
    <div class="payline p54" id="b1l1" data-node-id="b1l1" data-node-role="text"><span class="pw" style="animation-delay:720ms">an</span><span class="pw" style="animation-delay:840ms">app</span><span class="pw" style="animation-delay:1000ms">that</span></div>
    <div class="payline p54" id="b1l2" data-node-id="b1l2" data-node-role="text"><span class="pw" style="animation-delay:1160ms">does</span><span class="pw" style="animation-delay:1400ms">one</span><span class="pw hero" style="animation-delay:1680ms; animation-duration:400ms">thing.</span></div>
  </div>
</div>
```

## 8. VERIFY LOOP

Run (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

The engine prints a benign `ancestor-rotation-overflow-clip-omitted` warning for every arc-char (rotate on
a positioned ancestor) — EXPECTED, not a failure; bounds stay clean. Exit 0 → record. Otherwise apply the
MECHANICAL fix for the named element and re-run; at most 2 fix cycles:
- `FAIL[bounds] #b{N}k glyph {k} …outside` → the arc crown overflowed a margin: move that beat's row DOWN
  one line in the section-3 arc table (next smaller FONT + its ANGLE row — re-emit the arc-chars with the
  new angles + set the new `font-size` inline). If it fails again, step down once more.
- `FAIL[bounds] #b{N}l{L} … left/right outside` → that body line overran 600px: move `{P}` ONE step
  smaller on the payoff ladder (p54→p52). Re-run; if it fails again, step once more.
- `FAIL[bounds] … top/bottom outside` → a `.pay` `top` drifted: restore `top:852px` (the arc only lifts UP
  into the empty upper band, so a top failure means a moved anchor, not the crown).
- `FAIL[never-visible] #b{N}k` or `#b{N}l{L}` → its units sit outside the cue window: confirm the `.cue`
  carries inline `z-index:{10+N}` and its `animation-delay`/`-duration` match section 4, the glyph/word
  `animation-delay`s match `word-timings.json`, and `<video class="vid">` is the first body element.
- `FAIL[occluded] #b{N}…` → two cue windows overlap: re-check every `{winMs}` = next `cueDelayMs` − this,
  and that `{z}` = 10 + N (ascending, no duplicates; the transparent `.cue` never occludes on its own).

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --record {repo}/runs/<key>/final/out.silent.mp4
```

Treat ANY font warning in verify/record output as a STOP (a silent font fallback falsifies the sizing math —
seed the font cache first). `manifest.json` shape is in section 2.

## 9. DO NOT

- No fonts, colours, shadows, sizes, radii, or keyframes beyond this sheet — Cormorant Garamond italic 700
  (arc) + Archivo 700/800 (body), the ink hexes (`#e9bd2b` arc base, `#e89a1c` arc hero, `#15100a` arc
  stroke; `#f7f5f3` body, `#ffffff` body hero), the arc DARK-STROKE text-shadow stack + the body
  soft-ground stack, `cueWin`/`wordIn`/`payIn`, and the section-3 tables are the whole system. The arc's
  8-direction dark stroke is load-bearing legibility (light gold vanishes on bright footage without it) and
  is ALSO the whole shadow — do NOT add a glow/halo/ambient layer back (it reads dirty), and never trim the
  stroke.
- No invented timing: every `delayMs` comes VERBATIM from `word-timings.json`; durations only via the
  section-4 gate-compress form; arc angles only from the section-3 table.
- Never animate the `.arc-char` itself — the rise lives on the inner `.w` ONLY (an ancestor transform over
  an animating word is the two-span unit; a single animated span there is nondeterministic on the engine).
  The `.cue`/`.arc` ancestors carry opacity/position only, NEVER a transform.
- Never animate `color`; no `var()` in transforms/keyframes; no `vw` font sizes; no CSS grid/outline; no
  `<br>`; no descendant selectors — flat classes only (arc font-size is set INLINE on the `.arc` div and
  inherited, never via a descendant size class).
- No per-word spacer spans; body gaps are the `.pw` `margin-right`, arc gaps are the space slots; no
  reordering/dropping words; keep original case + punctuation; no uppercasing. Never lay body words out in
  shrink-to-fit flex (the engine mis-lays-out animated flex children) — plain block `.payline`s.
- Never read the video frames; never move the crown centre/radius or the `.pay` anchor; the accent/body
  split and both registers holding together through the cue are the design — do not turn the arc back into
  a per-page turn-taking stream.
- No redesign after a render or verify failure — only the mechanical fixes in section 8.
