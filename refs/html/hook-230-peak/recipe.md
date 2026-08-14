> **AUTHORITY NOTE (2026-07-21):** `recipe.ts` next door is the single source of truth — the
> curation pass (design rounds v2–v6) edited the MODULE only and this sheet has NOT been synced.
> Do not recompile the module from this sheet until it is re-derived.

# RECIPE — hook-230-peak (9:16 · 736×1312 @ 25fps)

RESOLUTION: px are authored at the 9:16 reference canvas 736×1312. FIRST STEP: SCALE = W/736 from
`meta.json` (require |H − 1312·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE and round: the arc centre (cx, cy), the radius R, every ladder
font-size, `left/top`, and the px text-shadow offsets/blurs. Arc **angles are degrees — they NEVER
scale**; `em` values and ms timings never scale; the manifest carries the run's real W/H.
Prefab is 720×1280; every px below is ALREADY rescaled ×1.022 — copy numbers as written, never rescale again.

## 1. IDENTITY

A **two-register** caption over full-bleed footage. Per beat, the FIRST HALF of the words ride a glowing
white TITLE ARC — Archivo Narrow 500 (`#f8f6f4`, layered white glow), per-character glyphs tracked out
along a small circle hanging in the upper-left band, cascading in character by character on the spoken
timing. The SECOND HALF lands as a straight bold HEADLINE — Archivo 700 (`#f7f5f3`), 1–3 left-aligned
nowrap lines anchored right-of-centre in the lower-middle band, words rising in on their real delays,
the hero word turning pure white 800. Both registers reveal within ONE cue and HOLD TOGETHER for the
whole beat; the cue gate cuts both at the next beat's start.

## 2. SKELETON

Paste this whole document as `runs/<key>/final/template.wv`, then insert one `.cue` block per BEAT
(section 3) after the `<video>`, in time order. Replace only `{videoPath}` (from `meta.json`). Canvas:
see RESOLUTION at the top of this sheet. All px below are at SCALE = 1.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700;800&family=Archivo+Narrow:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 736px; height: 1312px; overflow: hidden; }
  body { position: relative; background: #101010; font-family: 'Archivo', system-ui, sans-serif; }
  .vid { position: absolute; inset: 0; width: 736px; height: 1312px; object-fit: cover; z-index: 0; }

  /* cue gate — the one safe reveal recipe; opacity-only (never a transform ancestor over animated
     words). Hard cut at the successor's start. delay+duration+z-index set inline per cue (section 3). */
  @keyframes cueWin { 0%, 99.99% { opacity: 1; } 100% { opacity: 0; } }
  .cue { position: absolute; inset: 0; opacity: 0; pointer-events: none;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* ---- TITLE ARC: glowing white Archivo Narrow, glyphs on a circle (centre 307/424, radius 176) ---- */
  /* font-size is set INLINE on the .arc container (section-3 arc table) and INHERITED by the .ch glyphs.
     The last shadow layer is a dark ground — the white glow vanishes over light footage without it. */
  .arc { position: absolute; inset: 0; }
  .ch { position: absolute; left: 307px; top: 424px;
    font-family: 'Archivo Narrow', 'Archivo', sans-serif; font-weight: 500; line-height: 1;
    color: #f8f6f4; white-space: pre;
    text-shadow: 0 0 4px #fff, 0 0 9px rgba(255,255,255,0.95), 0 0 18px rgba(255,255,255,0.7),
                 0 0 31px rgba(255,255,255,0.45), 0 1px 6px rgba(0,0,0,0.55); }

  /* arc glyph reveal — carried on an INNER span so each glyph's static arc transform is untouched
     (the two-span unit; never animate the .ch itself). Symmetric padding = descender headroom at
     line-height 1 that keeps the glyph optically centred on its circle point. */
  .g { display: inline-block; opacity: 0; padding: 0.2em 0;
       animation: chIn .5s cubic-bezier(.2,.7,.3,1) both; }
  @keyframes chIn { 0% { opacity: 0; transform: translateY(0.5em); } 100% { opacity: 1; transform: translateY(0); } }

  /* ---- HEADLINE: straight bold Archivo block, left-aligned, right-of-centre ---- */
  /* PLAIN BLOCK lines on purpose (the prefab's flex column reflows as its animated children reveal). */
  .head { position: absolute; left: 248px; top: 722px; }
  .hl { display: block; white-space: nowrap; line-height: 1; text-align: left;
        font-family: 'Archivo', system-ui, sans-serif; font-weight: 700; letter-spacing: -0.5px;
        color: #f7f5f3;
        text-shadow: 0 1px 5px rgba(0,0,0,0.55), 0 0 2px rgba(0,0,0,0.4); }
  .hg { margin-top: -0.17em; }   /* lines 2+: restores the prefab's 1.06 leading under the .hw padding */
  .hw { display: inline-block; opacity: 0; margin-right: 0.26em;   /* word gap (inter-span whitespace is not what sets the gap here) */
        padding: 0.08em 0 0.15em;
        animation: wIn .42s cubic-bezier(.2,.7,.3,1) both; }
  @keyframes wIn { 0% { opacity: 0; transform: translateY(0.28em); } 100% { opacity: 1; transform: translateY(0); } }
  .hw.hero { color: #ffffff; font-weight: 800; }   /* headline hero word only (section 5) */

  /* HEADLINE size ladder (Archivo 700; advance budget 0.56·fs/char incl. gaps; ink budget 407px
     from left 248 to the 11% right margin 655) */
  .f46 { font-size: 46px; } .f42 { font-size: 42px; } .f38 { font-size: 38px; } .f35 { font-size: 35px; }
  .f32 { font-size: 32px; } .f29 { font-size: 29px; } .f26 { font-size: 26px; } .f23 { font-size: 23px; }
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

One `.cue` per BEAT `{N}` of `word-timings.json`. Inside it: one `.arc` title (the first half of the
words) then one `.head` block (the rest, 1–3 lines). Both are gated by the SAME cue and hold together.

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N}; animation-delay:{cueDelayMs}ms; animation-duration:{winMs}ms">
  <div class="arc" id="b{N}k" data-node-id="b{N}k" style="font-size:{FONT}px">
    <!-- one .ch per CHARACTER of the arc text (incl. the single space between arc words), in order,
         angles from the section-3 arc table; a SPACE is a bare .ch with NO inner .g -->
    <span class="ch" data-node-id="b{N}a{i}" data-node-role="text"
          style="transform:translate(-50%,-50%) rotate({ANGLE}deg) translateY(-176px);transform-origin:50% 50%"><span class="g" style="animation-delay:{glyphDelayMs}ms">{char}</span></span>
    <span class="ch" data-node-id="b{N}a{i}"
          style="transform:translate(-50%,-50%) rotate({ANGLE}deg) translateY(-176px);transform-origin:50% 50%"> </span>
  </div>
  <div class="head" id="b{N}h" data-node-id="b{N}h">
    <div class="hl f{F}" id="b{N}h1" data-node-id="b{N}h1" data-node-role="text">
      <span class="hw" style="animation-delay:{delayMs}ms">word</span>…more .hw…
    </div>
    <!-- lines 2 and 3 (ids b{N}h2, b{N}h3) only when the split rule produces them; each extra line
         adds class hg: <div class="hl f{F} hg" id="b{N}h2" …> -->
  </div>
</div>
```

**Word prep:** keep each word's ORIGINAL case and punctuation (`invite,` `meetings.` `10,000` render
as-is). GLUE a token starting with `-` (e.g. `-do` after `to`) to the previous word as ONE unit for the
split/count; on the arc it renders as adjacent glyphs with NO space between the halves (each half's
glyphs cascade from its OWN `delayMs`); in the headline it renders as two adjacent `.hw` spans with the
facing gap zeroed (`margin-right:0` on the first span). Never reorder or drop words.

**Title / headline split — deterministic, ORDER PRESERVED:**
- `n` = the beat's word count (after GLUE). `k = ceil(n/2)`; then while `k > 1` AND the arc character
  stream of the first `k` words (words joined by ONE space, glued halves adjacent) exceeds **26
  characters**, decrement `k`. ARC = the first `k` words; HEADLINE = the rest.
- `n = 1` → the lone word rides the arc; omit the `.head` div entirely.

**ARC assembly + sizing.** Build the arc CHARACTER stream (letters, digits, punctuation, AND the
inter-word spaces) left→right; `C` = its length. Set `font-size:{FONT}px` on the `.arc` div; emit the C
`.ch` glyphs with the ANGLES read straight off this row (no arithmetic — the i-th `.ch` takes the i-th
angle). Radius R = 176 for every row (already in the skeleton's `translateY(-176px)`; scale with SCALE);
centre 307/424 is fixed in the `.ch` class. A SPACE gets NO `.g` (bare `.ch`).

| C | FONT | ANGLES (deg, left→right — one per character incl. spaces) |
|---|------|-----------------------------------------------------------|
| 1 | 32 | -29.00 |
| 2 | 32 | -31.83, -26.17 |
| 3 | 32 | -34.67, -29.00, -23.33 |
| 4 | 32 | -37.50, -31.83, -26.17, -20.50 |
| 5 | 32 | -40.34, -34.67, -29.00, -23.33, -17.66 |
| 6 | 32 | -43.17, -37.50, -31.83, -26.17, -20.50, -14.83 |
| 7 | 32 | -46.00, -40.34, -34.67, -29.00, -23.33, -17.66, -12.00 |
| 8 | 32 | -48.84, -43.17, -37.50, -31.83, -26.17, -20.50, -14.83, -9.16 |
| 9 | 32 | -51.67, -46.00, -40.34, -34.67, -29.00, -23.33, -17.66, -12.00, -6.33 |
| 10 | 32 | -54.51, -48.84, -43.17, -37.50, -31.83, -26.17, -20.50, -14.83, -9.16, -3.49 |
| 11 | 32 | -57.34, -51.67, -46.00, -40.34, -34.67, -29.00, -23.33, -17.66, -12.00, -6.33, -0.66 |
| 12 | 32 | -60.17, -54.51, -48.84, -43.17, -37.50, -31.83, -26.17, -20.50, -14.83, -9.16, -3.49, 2.17 |
| 13 | 32 | -63.01, -57.34, -51.67, -46.00, -40.34, -34.67, -29.00, -23.33, -17.66, -12.00, -6.33, -0.66, 5.01 |
| 14 | 32 | -65.84, -60.17, -54.51, -48.84, -43.17, -37.50, -31.83, -26.17, -20.50, -14.83, -9.16, -3.49, 2.17, 7.84 |
| 15 | 32 | -68.68, -63.01, -57.34, -51.67, -46.00, -40.34, -34.67, -29.00, -23.33, -17.66, -12.00, -6.33, -0.66, 5.01, 10.68 |
| 16 | 32 | -71.51, -65.84, -60.17, -54.51, -48.84, -43.17, -37.50, -31.83, -26.17, -20.50, -14.83, -9.16, -3.49, 2.17, 7.84, 13.51 |
| 17 | 32 | -74.34, -68.68, -63.01, -57.34, -51.67, -46.00, -40.34, -34.67, -29.00, -23.33, -17.66, -12.00, -6.33, -0.66, 5.01, 10.68, 16.34 |
| 18 | 32 | -77.18, -71.51, -65.84, -60.17, -54.51, -48.84, -43.17, -37.50, -31.83, -26.17, -20.50, -14.83, -9.16, -3.49, 2.17, 7.84, 13.51, 19.18 |
| 19 | 32 | -80.01, -74.34, -68.68, -63.01, -57.34, -51.67, -46.00, -40.34, -34.67, -29.00, -23.33, -17.66, -12.00, -6.33, -0.66, 5.01, 10.68, 16.34, 22.01 |
| 20 | 32 | -82.85, -77.18, -71.51, -65.84, -60.17, -54.51, -48.84, -43.17, -37.50, -31.83, -26.17, -20.50, -14.83, -9.16, -3.49, 2.17, 7.84, 13.51, 19.18, 24.85 |
| 21 | 32 | -85.68, -80.01, -74.34, -68.68, -63.01, -57.34, -51.67, -46.00, -40.34, -34.67, -29.00, -23.33, -17.66, -12.00, -6.33, -0.66, 5.01, 10.68, 16.34, 22.01, 27.68 |
| 22 | 32 | -88.52, -82.85, -77.18, -71.51, -65.84, -60.17, -54.51, -48.84, -43.17, -37.50, -31.83, -26.17, -20.50, -14.83, -9.16, -3.49, 2.17, 7.84, 13.51, 19.18, 24.85, 30.52 |
| 23 | 32 | -91.35, -85.68, -80.01, -74.34, -68.68, -63.01, -57.34, -51.67, -46.00, -40.34, -34.67, -29.00, -23.33, -17.66, -12.00, -6.33, -0.66, 5.01, 10.68, 16.34, 22.01, 27.68, 33.35 |
| 24 | 29 | -88.07, -82.94, -77.80, -72.66, -67.53, -62.39, -57.25, -52.12, -46.98, -41.84, -36.71, -31.57, -26.43, -21.29, -16.16, -11.02, -5.88, -0.75, 4.39, 9.53, 14.66, 19.80, 24.94, 30.07 |
| 25 | 29 | -90.64, -85.50, -80.37, -75.23, -70.09, -64.96, -59.82, -54.68, -49.55, -44.41, -39.27, -34.14, -29.00, -23.86, -18.73, -13.59, -8.45, -3.32, 1.82, 6.96, 12.09, 17.23, 22.37, 27.50, 32.64 |
| 26 | 26 | -86.57, -81.96, -77.36, -72.75, -68.15, -63.54, -58.93, -54.33, -49.72, -45.12, -40.51, -35.91, -31.30, -26.70, -22.09, -17.49, -12.88, -8.28, -3.67, 0.93, 5.54, 10.15, 14.75, 19.36, 23.96, 28.57 |

(Closed form the table was built from, for reference only — READ the table, don't recompute:
`angle(i) = -29 + (i − (C−1)/2) × step`, i = 0…C−1, `step(deg) = 0.5441 × FONT × 180/π ÷ 176` — the
0.5441 em/char angular advance is the prefab's tracked-out spacing (C=22 at FONT 32 reproduces the
prefab's −88°…+30° demo arc). The FONT ladder is 32 → 29 → 26 → 24 → 22 → 20, base row by C:
≤23→32, 24–25→29, 26–28→26, 29–30→24, 31–33→22, ≥34→20 — each row keeps the total sweep
`(C−1)·step ≤ 126°`. A C>26 stream only happens via one giant glued unit; it uses the ladder font for
its C with angles from the closed form.)

**ARC placement is FIXED by the geometry:** centre `left:307px; top:424px`, radius 176 — the sweep stays
inside a in [−92°, +34°]: leftmost glyph ≈ (131, 428), topmost ≈ (307, 248), rightmost ≈ (404, 277), all
inside the safe margins (top ≥ 144, left ≥ 44, right ≤ 655). Do NOT move it per beat.

**HEADLINE assembly + sizing:**
- For COUNTING: a word's char-length = its glyphs after stripping ONE trailing `.` or `,`; keep `?` `!`
  `'` `-` and any INTERNAL comma (`10,000` = 6). `C_tot` = Σ(headline word lengths) + (headline word
  count − 1) gaps.
- **Lines:** `L = 1` if `C_tot ≤ 17`, `L = 2` if `C_tot ≤ 34`, else `L = 3`. Fill greedily with
  `target = ceil(C_tot/L)`: take headline words IN ORDER, for each `add = length + (1 if the line
  already holds a word else 0)` — if the line is non-empty and `running + add > target` and fewer than
  L lines are open, start the next line (reset running); every line keeps ≥ 1 word; all remaining words
  go on the last line.
- One `.hw` span per headline word; `.hw { margin-right:0.26em }` IS the gap (no literal spaces).
  Lines 2 and 3 add class `hg`.
- **HEADLINE size** `{F}` — `C` = char count of the LONGEST line (Σ its word lengths + its gaps). Look
  up (all lines share the ONE class):

  | C ≤15 | 16–17 | 18–19 | 20 | 21–22 | 23–25 | 26–27 | ≥28 |
  |-------|-------|-------|----|-------|-------|-------|-----|
  | f46 | f42 | f38 | f35 | f32 | f29 | f26 | f23 |

- **HEADLINE placement is FIXED:** `.head` at `left:248 top:722`, lines LEFT-aligned nowrap — the
  prefab's right-of-centre lower-middle block, clear of the dead-centre face. The ladder guarantees the
  407px fit (box right edge ≤ 655, the 11% margin); a 3-line f46 block bottoms ≈ 876, far above 1089
  (17%). Never discover a fit via `--verify`.

**`{z}` (paint order):** `{z} = 10 + N` (beat number). Cues never overlap in time; ascending z keeps
handoffs clean.

## 4. WORDS + TIMING

Delays are ABSOLUTE ms on the single timeline — paste `word-timings.json` values as-is, never re-zero,
never invent. Let `gateClose = cueDelayMs + winMs` (the moment this beat's cue cuts).

- **Cue gate.** `{cueDelayMs}` = the beat's `cueDelayMs`. `{winMs}` = NEXT beat's `cueDelayMs` − this
  beat's. LAST beat: `{winMs}` = `round(durationSec×1000)` − this beat's `cueDelayMs` (it holds full to
  the end — the gate cuts it, no fade). The `.cue` gets inline `z-index:{10+N};
  animation-delay:{cueDelayMs}ms; animation-duration:{winMs}ms`.
- **Arc glyphs — the 45ms cascade (one closed form).** The j-th glyph of an arc word (j = 0,1,2,… within
  that word; a glued half restarts j from ITS own delay):
  `glyphDelay = max(delayMs, min(delayMs + 45·j, gateClose − 250))` — the word's `delayMs` VERBATIM plus
  the prefab's 45ms/character cadence, clamped so every glyph still starts ≥250ms before the cut. SPACE
  `.ch`s carry no `.g` and no delay.
- **Headline words.** Each `.hw`'s `animation-delay` = that word's `delayMs` VERBATIM.
- **Gate-compress (one closed form per register).** For an arc `.g` (base entrance 500) with delay `d`:
  if `d + 500 > gateClose`, give it inline `animation-duration: max(gateClose − d, 250)ms`. For a
  headline `.hw` (base entrance 420) with delay `d`: if `d + 420 > gateClose`, inline
  `animation-duration: max(gateClose − d, 250)ms`. Units that already finish before `gateClose` carry
  NO inline duration.
- Both registers HOLD after revealing — no fade-outs anywhere; the beat's structures are its LAST
  structures and the cue gate cuts them.

Word spacing on the arc is native (a SPACE occupies its own angular slot — that IS the gap; each glyph
is placed independently, so words never fuse). Headline spacing is the `.hw` `margin-right` — never
literal spaces.

## 5. EMPHASIS

The two registers ARE the emphasis system (the glowing arc accents the setup; the bold headline lands
the payoff). On top of that, mark exactly ONE hero word per BEAT, picked over the HEADLINE words only
(the arc is a uniform glow device and never carries a hero; a beat with no headline has no hero):
1. If any headline word contains a digit, that token is the hero (first such token).
2. Otherwise the headline word with the most LETTERS (a–z, ignoring punctuation); a tie → the LATER word.

Style: add class `hero` to its `.hw` (`class="hw hero"`) → pure-white Archivo 800. Nothing else changes
— same line, same size, same word timing.

## 6. WORKED EXAMPLE (portrait-main beat 1: `So I built an app that does one thing.`, cueDelay 320, next beat 2080)

n=9 → `k = ceil(9/2) = 5`; arc stream `So I built an app` C=17 ≤ 26 → keep k=5. HEADLINE
`that does one thing.`. `{winMs}` = 2080 − 320 = 1760; gateClose = 2080; z = 11.

ARC: C=17 → FONT 32, the C=17 angle row. Glyph delays (45ms cascade, no clamp — all < 1830):
`So` → S 320, o 365 · `I` → I 400 (j restarts per word) · `built` → b 520,
u 565, i 610, l 655, t 700 · `an` → a 720, n 765 · `app` → a 840, p 885, p 930. No gate-compress
(930 + 500 < 2080). First three `.ch`s:

```html
<div class="cue" id="cue1" data-node-id="cue1" style="z-index:11; animation-delay:320ms; animation-duration:1760ms">
  <div class="arc" id="b1k" data-node-id="b1k" style="font-size:32px">
    <span class="ch" data-node-id="b1a0" data-node-role="text" style="transform:translate(-50%,-50%) rotate(-74.34deg) translateY(-176px);transform-origin:50% 50%"><span class="g" style="animation-delay:320ms">S</span></span>
    <span class="ch" data-node-id="b1a1" data-node-role="text" style="transform:translate(-50%,-50%) rotate(-68.68deg) translateY(-176px);transform-origin:50% 50%"><span class="g" style="animation-delay:365ms">o</span></span>
    <span class="ch" data-node-id="b1a2" style="transform:translate(-50%,-50%) rotate(-63.01deg) translateY(-176px);transform-origin:50% 50%"> </span>
    <!-- …I (rotate -57.34, delay 400) · space -51.67 · built b/u/i/l/t (-46.00/-40.34/-34.67/-29.00/-23.33,
         delays 520/565/610/655/700) · space -17.66 · an a/n (-12.00/-6.33, 720/765) · space -0.66 ·
         app a/p/p (5.01/10.68/16.34, 840/885/930) -->
  </div>
```

HEADLINE: `that does one thing.` → lengths that4 does4 one3 thing5 (trailing `.` stripped), C_tot =
16 + 3 = 19 > 17 → L=2, target 10. Line 1 fills `that does` (running 9); line 2 `one thing.`. Longest
line C = 9 → **f46**. Hero: letters that4 does4 one3 thing5 → `thing.`. Words keep THEIR delays;
`thing.` gets gate-compress (1680 + 420 = 2100 > 2080 → duration max(2080−1680, 250) = 400).

```html
  <div class="head" id="b1h" data-node-id="b1h">
    <div class="hl f46" id="b1h1" data-node-id="b1h1" data-node-role="text"><span class="hw" style="animation-delay:1000ms">that</span><span class="hw" style="animation-delay:1160ms">does</span></div>
    <div class="hl f46 hg" id="b1h2" data-node-id="b1h2" data-node-role="text"><span class="hw" style="animation-delay:1400ms">one</span><span class="hw hero" style="animation-delay:1680ms; animation-duration:400ms">thing.</span></div>
  </div>
</div>
```

## 7. VERIFY LOOP

Run (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

The engine prints a benign `ancestor-rotation-overflow-clip-omitted` warning for every `.ch` (rotate on
a positioned ancestor) — EXPECTED, not a failure. Exit 0 → record. Otherwise apply the MECHANICAL fix
for the named element and re-run; at most 2 fix cycles:
- `FAIL[bounds] #b{N}k …outside` → the arc overflowed a margin: step that beat's arc DOWN one font on
  the ladder (32→29→26→24→22→20) and RE-SOLVE the angles with the section-3 closed form at the new
  FONT (smaller font = tighter sweep — the demotion pulls both the glyphs and the arc ends inward).
  If it fails again, step down once more.
- `FAIL[bounds] #b{N}h{L} … left/right outside` → that headline line overran 407px: move `{F}` ONE step
  smaller on the headline ladder (f46→f42). All lines share the one class. Re-run; if it fails again,
  step once more.
- `FAIL[bounds] … top/bottom outside` → an anchor drifted: restore `.head` `top:722px` / the arc centre
  `307/424` (neither ever moves per beat).
- `FAIL[never-visible] #b{N}k` or `#b{N}h{L}` → its units sit outside the cue window: confirm the
  `.cue` carries inline `z-index:{10+N}` and its `animation-delay`/`-duration` match section 4, the
  glyph/word delays match the section-4 closed forms, and `<video class="vid">` is the first body
  element.
- `FAIL[occluded] #b{N}…` → two cue windows overlap: re-check every `{winMs}` = next `cueDelayMs` −
  this, and that `{z}` = 10 + N (ascending, no duplicates).

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --record {repo}/runs/<key>/final/out.silent.mp4
```

Treat ANY font warning in verify/record output as a STOP (a silent font fallback falsifies the sizing
math — seed the font cache first). `manifest.json` shape is in section 2.

## 8. DO NOT

- No fonts, colours, shadows, sizes, or keyframes beyond this sheet — Archivo Narrow 500 (arc) +
  Archivo 700/800 (headline), the ink hexes (`#f8f6f4` arc, `#f7f5f3` headline, `#ffffff` hero), the
  arc's white-glow stack + its one dark ground layer (never trim it — the glow vanishes over light
  footage), the headline's soft-ground stack, `cueWin`/`chIn`/`wIn`, and the section-3 tables are the
  whole system.
- No invented timing: every delay derives VERBATIM from `word-timings.json` via the section-4 closed
  forms (the 45ms cascade and the two gate-compress forms are the ONLY arithmetic); arc angles only
  from the section-3 table / closed form.
- Never animate the `.ch` itself — the rise lives on the inner `.g` ONLY. The `.cue`/`.arc`/`.head`
  ancestors carry opacity/position only, NEVER a transform.
- Never lay headline words out in flex (the prefab's flex column reflows as its animated children reveal) —
  plain block `.hl` lines. Never animate `color`; no CSS grid; no `<br>`; no descendant selectors — flat classes only (arc font-size is
  INLINE on the `.arc` div and inherited).
- No per-word spacer spans (the prefab's `.sp` spacers are replaced by the `.hw` margin — spacer spans
  collapse unpredictably); arc gaps are the space slots. No reordering/dropping words; keep original
  case + punctuation; no uppercasing.
- Never read the video frames; never move the arc centre/radius or the `.head` anchor; the half/half
  split and both registers holding together through the cue are the design — no turn-taking pages, no
  fade-outs.
- No redesign after a render or verify failure — only the mechanical fixes in section 7.
