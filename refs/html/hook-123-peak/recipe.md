# RECIPE — hook-123-peak (16:9 · 1280×720 @ 24fps)

RESOLUTION: px are authored at the 16:9 reference canvas 1280×720. FIRST STEP: SCALE = W/1280 from
`meta.json` (require |H − 720·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE and round (positions, widths, font sizes, the `.sind` indent, the
underline thickness/offset/padding); `em` values and ms timings never scale (all keyframes here are
em-based); the manifest carries the run's real W/H.

Prefab is 960×720 on a flat dark background; the composition below is RE-COMPOSED for the wide
1280×720 frame over footage (a left-third neon column instead of the prefab's full-canvas poster) —
copy numbers as written, never rescale against the prefab.

## 1. IDENTITY

A neon-sign poster in the left third: an all-caps League Gothic condensed headline in hot red
(white-hot core, red rim + bloom) that STRIKES ON like a tube warming up (flickering opacity ramp),
with the rest of the sentence handwritten below in big Caveat script — words rising in on their spoken
timings with a tiny tilt; one hero script word per beat gets the prefab's hand-drawn underline. A hard
black plate + halo ground the headline; the script sits on a soft dark halo (the hard offset plate is
the headline's display idiom only).

## 2. SKELETON

Paste this whole document as `runs/<key>/final/template.wv`, then add one `.cue` block per beat
(section 3) after the `<video>` element. Replace only `{videoPath}` (from `meta.json`) and `{DUR}`
(`durationSec` from `meta.json`, manifest only). Canvas: see RESOLUTION at the top of this sheet.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=League+Gothic&family=Caveat:wght@700&display=swap" rel="stylesheet">
<style>
  html, body { margin: 0; padding: 0; }
  body { width: 1280px; height: 720px; background: #000; overflow: hidden; position: relative; font-kerning: none; }
  .vid { position: absolute; inset: 0; width: 1280px; height: 720px; object-fit: cover; }

  /* window gate — the one safe reveal recipe; delay+duration+z come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position: absolute; left: 77px; top: 140px; width: 520px; opacity: 0; z-index: 11;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* neon headline — color and every shadow layer are STATIC; only opacity ever animates.
     Layers 1-3 = the tube (white-hot rim, red rim, bloom); layers 4-5 = the dark plate + halo that
     ground the red on bright footage (probe-calibrated: thinner plates fail the frame QA). */
  .title { font-family: 'League Gothic', sans-serif; font-weight: 400; line-height: 1.2;
           letter-spacing: 0.01em; white-space: nowrap; text-transform: uppercase;
           color: #ff4d3d; margin-bottom: 0.04em;
           text-shadow: 0 0 0.025em rgba(255,225,210,0.75), 0 0 0.09em rgba(240,15,10,1),
                        0 0 0.32em rgba(220,20,16,0.75), 0.11em 0.13em 0 #000000, 0 0 0.18em #000000; }

  /* handwritten script — line-height 1.45 is load-bearing: Caveat's ascenders touch the very top
     of a 1.3 line box and an animating span shears at its box edge — NEVER reduce this value; the
     stack's tightness is tuned via the title/script margins instead. The shadow is a SOFT ambient
     halo only — the hard offset plate is the title's display idiom, never the script's */
  .script { font-family: 'Caveat', cursive; font-weight: 700; line-height: 1.45;
            letter-spacing: 0.05em; white-space: nowrap; color: #e9e6e6; margin-top: 0.1em;
            text-shadow: 0 0.04em 0.10em rgba(0,0,0,0.95), 0 0.02em 0.22em rgba(0,0,0,0.80),
                         0 0 0.45em rgba(0,0,0,0.55); }
  .sind { margin-left: 44px; }

  /* neon warm-up: opacity-only flicker, dips front-loaded (≤52%) so a beat's MID frame always
     catches ≥.9 — full at 55%, holds after */
  @keyframes ignite { 0% {opacity:0} 8% {opacity:.5} 18% {opacity:.1} 30% {opacity:.85}
                      42% {opacity:.4} 55% {opacity:1} 70% {opacity:.93} 82% {opacity:1} 100% {opacity:1} }
  @keyframes wordIn { 0% {opacity:0; transform:translateY(0.15em) rotate(-2deg);}
                      100% {opacity:1; transform:translateY(0) rotate(0);} }
  .tw { display: inline-block; opacity: 0; margin-right: 0.30em;
        animation-name: ignite; animation-timing-function: linear; animation-fill-mode: both; }
  .w  { display: inline-block; opacity: 0; margin-right: 0.45em;
        animation-name: wordIn; animation-timing-function: ease; animation-fill-mode: both; }
  /* hero underline — same ink + the tube's glow layers as .title (layers 1-3 + the grounding halo);
     the hard offset plate is EXCLUDED (title-only device — never an offset copy on the script) */
  .u  { text-decoration: underline; text-decoration-color: #ff4d3d; text-decoration-thickness: 3px;
        text-underline-offset: 9px; padding: 0 6px;
        text-shadow: 0 0 0.025em rgba(255,225,210,0.75), 0 0 0.09em rgba(240,15,10,1),
                     0 0 0.32em rgba(220,20,16,0.75), 0 0 0.18em #000000; }

  .t184{font-size:184px} .t170{font-size:170px} .t149{font-size:149px} .t132{font-size:132px}
  .t119{font-size:119px} .t108{font-size:108px} .t99{font-size:99px} .t91{font-size:91px}
  .t85{font-size:85px} .t79{font-size:79px} .t74{font-size:74px} .t70{font-size:70px}
  .t66{font-size:66px} .t62{font-size:62px} .t59{font-size:59px}
  .c60{font-size:60px} .c58{font-size:58px} .c55{font-size:55px} .c51{font-size:51px}
  .c48{font-size:48px} .c45{font-size:45px} .c43{font-size:43px} .c41{font-size:41px}
  .c39{font-size:39px} .c37{font-size:37px} .c35{font-size:35px} .c34{font-size:34px}
  .c33{font-size:33px} .c31{font-size:31px} .c30{font-size:30px} .c29{font-size:29px}
  .c28{font-size:28px} .c27{font-size:27px}
</style>
</head>
<body>
  <video class="vid" style="z-index:0" src="{videoPath}" muted></video>
  <!-- one .cue block per beat goes here, in beat order -->
</body>
</html>
```

`manifest.json` (verbatim, `{DUR}` = `durationSec` from `meta.json`):

```json
{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json
```

## 3. PER-BEAT ASSEMBLY

One `.cue` per beat in `word-timings.json`. Beat template — `{N}` = beat `i`; `{TS}`/`{SS}` from the
sizing tables; the `.title` div is always present, `.script` divs only when the beat has script words:

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N};animation-delay:{cueDelayMs}ms;animation-duration:{cueDurMs}ms">
  <div class="title {TS}" id="b{N}t" data-node-id="b{N}t" data-node-role="text"><span class="tw" style="animation-delay:{delayMs}ms;animation-duration:{rampMs}ms">{WORD}</span><!-- more title words, no whitespace between spans --></div>
  <div class="script sind {SS}" id="b{N}s1" data-node-id="b{N}s1" data-node-role="text"><span class="w" style="animation-delay:{delayMs}ms;animation-duration:{inMs}ms">{word}</span><!-- more words, no whitespace between spans --></div>
  <!-- more .script divs (NO sind — only line 1 is indented), ids b{N}s2, b{N}s3 -->
</div>
```

**Word prep (before counting anything):** strip a trailing `.` or `,` from each word; keep `?` `!` `'`
and any INTERNAL punctuation (`10,000` stays as is). GLUE: a token starting with `-` (e.g. `-do` after
`to`) merges with the previous word into ONE unit for mapping and char counting (`TO-DO` = 5 chars); it
renders as two adjacent spans — the previous span gets inline `margin-right:0` — each keeping its OWN
verbatim `delayMs`. n below = UNIT count. Write each word into its span as given (the title's CSS
uppercases it; script words keep their case).

**Title/script split — deterministic, word order always preserved:**
- The TITLE takes the longest PREFIX of the beat's units whose char count stays ≤ 10, and at least
  one unit. Char count of a prefix = sum of unit lengths (after stripping) + 1 per gap between units.
  Greedily add units while the count is ≤ 10; the first unit joins even if longer than 10 by itself.
- All remaining units are SCRIPT words. S = script unit count (S = 0 → no `.script` divs).

**Script line mapping:** L = min(3, ceil(S/3)) lines; base = floor(S/L); the first (S mod L) lines
take base+1 consecutive words, the rest take base.
- Examples: S=2 → one line · S=4 → 2,2 · S=5 → 3,2 · S=6 → 3,3 · S=7 → 3,2,2 · S=8 → 3,3,2.
- Only script line 1 gets class `sind`. Never reorder or drop words.

**Sizing — `{TS}` for the title, one `{SS}` shared by ALL the beat's script lines:**
1. C_t = title char count (unit lengths + 1 per gap). C_s = the LARGEST char count over the beat's
   script lines (same counting). Worked count: `email professionally` → 5 + 1 + 14 = 20.
2. Title class by C_t (League Gothic advance measured from a calibration render at letter-spacing 0:
   caps avg 0.352em/char, M-run worst 0.477, digits 0.327; the ladder budgets the 0.01em tracking and
   the 440px column — the short-line columns (C≤4) budget the M-run worst case; the 184 cap keeps the
   tallest title + a 3-line script stack inside the y≤676 margin by construction):

   | C_t ≤3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | ≥20 |
   |------|---|---|---|---|---|---|----|----|----|----|----|----|----|----|----|----|-----|
   | t184 | t184 | t184 | t184 | t170 | t149 | t132 | t119 | t108 | t99 | t91 | t85 | t79 | t74 | t70 | t66 | t62 | t59 |

3. Script class by C_s (Caveat advance budget 0.48em/char incl gaps, measured; budget 396px so the
   44px `sind` indent always fits):

   | C_s ≤13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | ≥30 |
   |-------|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|-----|
   | c60 | c58 | c55 | c51 | c48 | c45 | c43 | c41 | c39 | c37 | c35 | c34 | c33 | c31 | c30 | c29 | c28 | c27 |

4. The ladders, ordered (for stepping in fix rules and the punch-close arc):
   title: t59 t62 t66 t70 t74 t79 t85 t91 t99 t108 t119 t132 t149 t170 t184.
   script: c27 c28 c29 c30 c31 c33 c34 c35 c37 c39 c41 c43 c45 c48 c51 c55 c58 c60.

**Placement:** fixed by the `.cue` class — `left:77px; top:140px; width:520px`, every beat (anchor B
of section 6 is the ONLY sanctioned alternative). Title and script lines are left-flush BLOCK divs in
normal flow (no flex, no text-align — a shrink-to-fit line reflows as its children reveal and centered text
around animated inline-blocks). Anchor varies ONLY per BOUNDED VARIETY axis 1 (section 6, alternating
A/B by beat parity) — every beat's title AND all of its script lines share that ONE beat's anchor;
never split anchors within a single beat, never invent a third `left` value.

**Worked example** (beat 1 of a 5-beat run; 9 words `My most viral video took five minutes to make.`,
cueDelayMs 160, cueDurMs 2160 → cueEnd 2320): title prefix: `MY`(2) → +MOST → 2+1+4=7 ≤10 → +VIRAL →
7+1+5=13 >10, stop → title `MY MOST` (C_t=7 → t170); script S=7 → 3,2,2 → `viral video took` (C=16) /
`five minutes` (C=12) / `to make` (C=7) → C_s=16 → c51; hero = `minutes` (longest script word);
title ramps: MY avail 2160 → rampMs 1300, MOST avail 2040 → 1300; late script words: `to` (delayMs
1880, avail 440 → inMs 320), `make` (2040, avail 280 → inMs 200). Sub-cap title ramp: a title word
with avail 1340 → rampMs = min(1300, max(250, 1340 − 80)) = 1260 (the 1300 cap only applies when
avail − 80 ≥ 1300).

## 4. WORDS + TIMING

- Delays are absolute on the single timeline — paste as-is from `runs/<key>/word-timings.json`, never
  re-zero, never invent.
- Each beat's `.cue` gets inline `animation-delay:{cueDelayMs}ms;animation-duration:{cueDurMs}ms`
  verbatim, plus `z-index:{10+N}`.
- Per word compute once: cueEnd = cueDelayMs + cueDurMs (beat-level); avail = cueEnd − delayMs.
- TITLE word: `<span class="tw" style="animation-delay:{delayMs}ms;animation-duration:{rampMs}ms">{WORD}</span>`
  with `rampMs = min(1300, max(250, avail − 80))` — the warm-up compresses so the tube reaches full
  glow before the gate cuts it.
- SCRIPT word: `<span class="w" style="animation-delay:{delayMs}ms;animation-duration:{inMs}ms">{word}</span>`
  with `inMs = min(320, max(150, avail − 80))`.
- Words accumulate — every word HOLDS at full opacity until the cue gate cuts the beat. No fade-outs
  anywhere.
- Word spacing is the `.tw`/`.w` `margin-right` (0.30em title / 0.45em script): the margin IS the gap,
  so it is exact at every size. Write word spans adjacent with no whitespace
  between them. Spans stay `display:inline-block`; never `display:block`.

## 5. EMPHASIS

Exactly ONE hero word per beat, chosen among the SCRIPT words only (the title is already the loud
element; S=0 → no hero): add class `u` to its span (`class="w u"`) — the prefab's hand-drawn
underline. Pick rule, no judgment:
1. Any script word containing a digit wins (the FIRST such word if several).
2. Otherwise the LONGEST script word (length after stripping, internal punctuation counted:
   `have`(4) `been`(4) `an`(2) `email`(5) `professionally`(14) → `professionally`).
3. Tie → the LATER word.
Nothing else changes for the hero — same line, same size, same animation.

## 6. BOUNDED VARIETY

Pick per axis by the RULES below (computable from the run inputs — no judgment), state choices in the
REPORT.

1. **ANCHOR** — `A`: `.cue` at `left:77px` · `B`: `.cue` at `left:763px` (the same column mirrored
   into the right third, budgeted from the right margin; nothing else changes). Rule: ALTERNATE by
   beat parity, no judgment — beat 1 = `A`, beat 2 = `B`, beat 3 = `A`, ... (odd 1-indexed beat
   number → `A`, even → `B`). Engine workarounds (left-flush block flow, no ancestor transform,
   natural nowrap width budgeted from the anchor's own margin edge) apply identically under both.
2. **SCALE ARC** — `steady` (default: sizing exactly per section 3) · `punch-close`: the LAST beat's
   title class steps one UP the section-3 ordered title ladder (t184 stays t184); script classes
   untouched. Rule: punch-close when the last beat contains a digit word or a word ending in `!`;
   else steady.
3. **DEVICE INTENSITY** — `standard` (default: the ignite keyframes exactly as in section 2) ·
   `calm`: replace ignite's middle frames with the monotone ramp `8%{opacity:.3} 18%{opacity:.45}
   30%{opacity:.6} 42%{opacity:.8} 55%{opacity:1} 70%{opacity:1} 82%{opacity:1}` (0% and 100%
   unchanged — the tube warms up without flickering). Rule: calm only when the DIRECTION (execution contract)
   explicitly asks for calm/subtle energy; else standard.

## 7. VERIFY LOOP

Run (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Otherwise apply the mechanical fix for the flagged element and re-run; at most 2 fix
cycles:
- `FAIL[bounds] #b{N}t ... left/right outside` → that beat's title class one step DOWN the ordered
  title ladder. Fails again → one step more.
- `FAIL[bounds] #b{N}s{K} ... left/right outside` → that beat's `{SS}` one step DOWN the ordered
  script ladder on ALL its script lines.
- `FAIL[bounds] ... bottom outside` → the beat's stack is over-tall: re-check L ≤ 3, `{TS}`/`{SS}`
  against the section-3 tables, and `.cue` top = 140 (·SCALE).
- `FAIL[never-visible]` → check that cue's inline `animation-delay`/`animation-duration` match
  `word-timings.json`, the class list is exactly `cue`, the `<video>` is the first body element with
  `style="z-index:0"`, and every span's animation-name resolves (`ignite`/`wordIn` spelled exactly —
  a typo'd name never animates in).
- `FAIL[occluded] #b{N}...` → cue windows overlap: cue N's `animation-duration` must not exceed
  `cueDelayMs(N+1) − cueDelayMs(N)`; if it does, set it to that difference. Confirm inline z-index is
  10+N in beat order.

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --progress-output --record {repo}/runs/<key>/final/out.silent.mp4
```

Manifest line (already given in section 2): `{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}` — W/H/FPS/DUR from `meta.json`.

## 8. DO NOT

- No fonts, colors, shadows, sizes, or keyframes beyond this sheet — League Gothic 400 + Caveat 700,
  the two inks (`#ff4d3d`, `#e9e6e6`), the five title shadow layers + three script halo layers,
  `cueWin`/`ignite`/`wordIn` and the t/c ladders are the whole system.
- The title's hard plate (`0.11em/0.13em`) and the script's soft halo stack are probe-calibrated
  legibility hardware, not decoration — never slim them. The hard offset plate is the TITLE's display
  idiom only: never put an offset copy on the script (an offset copy of a script glyph reads as a
  broken double-print, and small text takes at most a soft ambient shadow).
- Never animate `color` or `text-shadow` — the neon ramp is OPACITY ONLY over a static glow (the
  engine interpolates only opacity/transform/background-color; a color ramp ghosts shadows on
  unrevealed words).
- No transform on ANY ancestor of a word span — the engine can composite an animating span WITHOUT an
  ancestor's static transform (video runs), so all width budgets here are natural, untransformed px.
- No `filter:drop-shadow` anywhere — that is this sheet's look. It is also the safe side of a real
  limit: on 0.8.0 drop-shadow under partial opacity DOES clip glyphs (probe: drop-shadow-opacity-clip),
  where on 0.7.3 it did not. Legibility here is the baked `text-shadow` layers only.
- No flex inside `.cue` and no `text-align` anywhere: title/script lines are left-flush BLOCK divs
  (the prefab's justify-between script row is deliberately NOT carried over — the engine reflows
  shrink-to-fit flex around animated children).
- Never move the column off its anchor (77px, or 763px under variety B) and never anchor at the right
  edge — a natural-width line must stay viewport-safe on its own.
- `line-height: 1.45` on `.script` is load-bearing (Caveat ascenders shear at a 1.3 box edge
  mid-animation) — never tighten it.
- No invented timing: every `delayMs`/`cueDelayMs`/`cueDurMs` comes verbatim from
  `word-timings.json`; derived numbers ONLY via the closed forms in sections 3-4.
- Words accumulate and the gate cuts the beat — never add per-word or per-line fade-outs.
- No descendant selectors — flat classes only.
- Never read the video frames; never re-derive layout; no redesign after a render or verify failure —
  only the mechanical fixes in section 7.
