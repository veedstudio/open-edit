# RECIPE — hook-242-peak · scattered Caveat handwriting over footage (16:9 · 1280×720 @ 24fps)

RESOLUTION: px are authored at the 16:9 reference canvas 1280×720. FIRST STEP: SCALE = W/1280 from
`meta.json` (require |H − 720·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE and round once at emission (positions, font sizes, shadow
offsets/blurs, the pitch/offset/jitter tables); each `.s*` class carries its OWN letter-spacing and
that value is scale-multiplied UNROUNDED (kept to 2 dp — see §5, optical tracking);
`em` values and ms timings never scale; the manifest carries the run's real W/H.

Prefab is 960×720; the composition below is RE-COMPOSED for the wide 1280×720 frame (the gap and
offset tables derive from the prefab's ×4/3 center pitches) — copy numbers as written, never rescale
against the prefab. Type runs well above the prefab's own 30px — 42px at the top of the ladder, 73px
at the accent — so the notes hold the wide frame.

## 1. IDENTITY

Loose handwritten notes scattered over full-bleed footage: each spoken word is its own Caveat 600
warm-white (`#fdf7f4`) word in spoken sentence case, absolutely placed on 1–6 ragged rows with
big irregular horizontal gaps and a tiny per-word vertical jitter. Beat to beat the scatter MOVES around
the frame — it works the left or right edge, holds one side clear of the centre, or takes the middle —
never the same composition twice running. Every word rises 0.28em and fades in
at the moment it is spoken and ACCUMULATES until the beat's gate cuts the whole scatter. ONE word a
beat is singled out and SCALE is the whole device: the accent unit renders at ×1.74 of the beat's
ladder size with a hand-drawn underline swept under it (§5). Nothing else ever marks a word — no
plates, no color accents, no weight change, no rotation; the airy scatter and the handwriting ARE the
style. A two-layer dark
text-shadow grounds the light ink over any footage (the prefab's flat dark demo bg is replaced by the
footage per the overlay-on-subject policy).

## 2. SKELETON

Paste this whole document as `runs/<key>/final/template.wv`, then add one `.cue` block per beat after
the `<video>` element (section 3). Replace only `{videoPath}` (from `meta.json`) and `{DUR}`
(`durationSec` from `meta.json`, manifest only). Canvas: see RESOLUTION at the top of this sheet.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1280px; height: 720px; }
  body { background: #000; overflow: hidden; position: relative; font-family: 'Caveat', cursive; }
  .vid { position: absolute; inset: 0; width: 1280px; height: 720px; object-fit: cover; }

  /* window gate — the one safe reveal recipe; delay+duration+z come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position: absolute; left: 0; top: 0; width: 1280px; height: 720px; opacity: 0;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* one scattered handwritten note per word — positioned by its LEFT ink edge (no -50% translate:
     --verify measures ink pre-transform, a centering translate would false-fail bounds).
     padding-bottom 0.2em = rise headroom (descender ink reaches 1.31em; +0.28em rise passes the
     1.5em line box). The two-layer dark shadow grounds the warm-white ink over any footage. */
  .word { position: absolute; color: #fdf7f4; font-weight: 600; line-height: 1.5;
          white-space: nowrap; padding-bottom: 0.2em;
          text-shadow: 0 1px 3px rgba(0,0,0,0.55), 0 2px 10px rgba(0,0,0,0.45);
          opacity: 0; animation-name: wIn; animation-duration: 420ms;
          animation-timing-function: cubic-bezier(.2,.7,.3,1); animation-fill-mode: both; }
  .s73{font-size:73px;letter-spacing:-0.67px}
  .s66{font-size:66px;letter-spacing:-0.52px}
  .s59{font-size:59px;letter-spacing:-0.37px}
  .s52{font-size:52px;letter-spacing:-0.22px}
  .s44{font-size:44px;letter-spacing:-0.05px}
  .s42{font-size:42px;letter-spacing:0px}
  .s38{font-size:38px;letter-spacing:0.08px}
  .s34{font-size:34px;letter-spacing:0.17px}
  .s30{font-size:30px;letter-spacing:0.26px}
  .s25{font-size:25px;letter-spacing:0.36px}
  @keyframes wIn {
    0% { opacity: 0; transform: translateY(0.28em); }
    100% { opacity: 1; transform: translateY(0); }
  }

  /* the accent's hand-drawn underline: ONE element statically clipped to the beat's spline outline
     (clip-path: polygon() in %, so one outline holds at any word width and any SCALE), swept
     left→right by scaleX 0→1 from its left edge — the sweep is what keeps that single percent
     outline exact at every word width, not a repair for a ramp the engine refuses. The
     drop-shadow sits on the whole stroke at once. */
  .ul { position: absolute; background: #fdf7f4; transform: scaleX(0); transform-origin: 0 50%;
        filter: drop-shadow(0 1px 4px rgba(0,0,0,0.55));
        animation: ulDraw 520ms cubic-bezier(.25,.8,.35,1) both; }
  @keyframes ulDraw { 0% { transform: scaleX(0); } 100% { transform: scaleX(1); } }
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

One `.cue` per beat in `word-timings.json`; inside it one `.word` div per word, in spoken order,
grouped conceptually into rows by the packing below, plus exactly ONE `.ul` div — the accent's
underline, emitted immediately after the accent word it belongs to. Beat template (`{N}` = beat `i`):

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N};animation-delay:{cueDelayMs}ms;animation-duration:{winMs}ms">
  <div class="word {SIZE}" id="b{N}w{k}" data-node-id="b{N}w{k}" data-node-role="text"
       style="left:{left}px;top:{top}px;animation-delay:{delayMs}ms">WordText</div>
  <!-- the ONE accent word of the beat (k = a) rides the accent class, and its stroke follows it -->
  <div class="word {ACCENT_SIZE}" id="b{N}w{a}" data-node-id="b{N}w{a}" data-node-role="text"
       style="left:{left}px;top:{top}px;animation-delay:{delayMs}ms">AccentWord</div>
  <div class="ul" id="b{N}u" data-node-id="b{N}u" data-node-role="text"
       style="left:{ulLeft}px;top:{ulTop}px;width:{ulW}px;height:{ulH}px;clip-path:polygon({pts});animation-delay:{ulDelay}ms"></div>
  <!-- … one div per word, k = 0-based word index in the BEAT -->
</div>
```

**Window** (pure subtraction): `{winMs}` = next beat's `cueDelayMs` − this beat's `cueDelayMs`; last
beat: round(`durationSec`×1000) − its `cueDelayMs`. `cueEnd` = `cueDelayMs + winMs` (entrance
compression, section 4).

**Word prep (before counting or grouping):** strip trailing `.` and `,` from each token (keep `?` `!`
`'` and internal punctuation); KEEP the spoken case exactly — never uppercase or lowercase. GLUE: a
token starting with `-` (e.g. `-do` after `to`) concatenates into the previous word as ONE word whose
`delayMs` is the FIRST token's. charLen = the prepped text length.

**The beat's PATTERN — the shape of the scatter itself.** `PATTERNS[(N − 1) mod 6]`:

| # | id | pack (chars/words/rows) | leading | gapScale | anchor + rowShift | shape |
|---|---|---|---|---|---|---|
| 0 | cascade | 13 / 3 / 5 | 86, 96 | 0.55 | 108 + [0, 104, 208, 312, 416] | a staircase: each row steps far along the last |
| 1 | column | 11 / 2 / 6 | 76, 88 | 0.42 | 120 + [0, 34, 12, 48, 20, 40] | a narrow ragged column, tight leading |
| 2 | pairs | 14 / 2 / 5 | 92, 104 | 0.3 | centre line + [0, 34, 14, 52] | one word left of centre, one right, a 420px hole in the middle |
| 3 | split | 24 / 4 / 4 | 98, 112 | 0.3 | 92 + [0, 18, 6, 26] | the row breaks 2+2 across a 260px middle, 30px off both frame edges |
| 4 | stack | rhythm 2·1·1, 4 rows | 96, 112 | 0.4 | 130 + [0, 128, 56, 184] | rows of 2 then 1 then 1, each stepped well clear of the last |
| 5 | arc | 14 / 4 / 4 | 96, 108 | 0.8 | 130 + [0, 40, 14, 58] | rows bow: middle words ride up `dy` −26 |

`MIRROR[(N − 1) mod 7]` = `[false, true, false, true, true, false, true]` reflects each finished row's
ink box about the band midline (translation only — run, order and gaps untouched), so every shape has
a left-home and a right-home reading. Periods 6 / 7 / 5 (pattern / mirror / band offset) are coprime:
a video runs 3-6 visibly different compositions before anything repeats.

A pattern may carry a `rhythm` instead of char caps — a fixed words-per-row cycle (the stack shape
uses 2 · 1 · 1). If the beat then overruns that pattern's row budget, every count grows by one and the
rhythm is re-applied.

**Row packing — greedy, order preserved, caps from the PATTERN:** a row takes words while its char
count (Σ charLens + 1 per gap) ≤ `maxChars` AND its word count ≤ `maxWords`; the first violation
closes the row. L = row count. If L > the pattern's `maxRows`, re-pack the whole beat with the caps
grown to (maxChars + 4, maxWords + 1), then +4 chars each round until it fits — the vertical band
budget. Longer rows land lower on the size ladder, so the shapes carry different type sizes by
construction.

**Size — one ladder class per BEAT, plus that rung's accent class.** C = charsOf the beat's LONGEST
row. Every word of the beat takes the ladder class; the ONE accent word (§5) takes the accent class
on the same rung — ten `.s*` classes in all, and both rungs step down together on a demotion:

| C | ≤ 14 | 15–18 | 19–22 | 23–26 | ≥27 |
|---|---|---|---|---|---|
| beat | `s42` (42) | `s38` (38) | `s34` (34) | `s30` (30) | `s25` (25) |
| accent (×1.74) | `s73` (73) | `s66` (66) | `s59` (59) | `s52` (52) | `s44` (44) |

**Measured coefficients (Caveat 600 through the engine).** Advance per char: lowercase 0.366em ·
uppercase 0.511em · digit 0.455em · anything else 0.46em. Estimated word advance
`W = size × Σ coeff(ch)`. Swash overhang beyond the advance: right ≤ 0.20em (worst measured: final
'f' 0.19em), left ≤ 0.10em ('j' 0.09em) — every width/edge budget below includes these.

**Vertical placement.** Row-center pitch cycles the PATTERN's `leading` pair down the frame
(pitch(r→r+1) = `leading[(r−1) mod 2]`); the block of L row centers is centered on
`cy = 396 + VBAND[(N − 1) mod 5]`, `VBAND = [0, −46, 34, −22, 58]` (the beat's band offset — the
scatter does not sit at the same height every beat). CLAMP cy into
`43 + pad … 677 − pad` with `pad = 0.9·ACCENT size + 3 + |dy| + (Σ pitches)/2` (the ink half-height
plus the word jitter and the arc bow), taking the midpoint if the two bounds cross. **The pad is
computed from the ACCENT size, never the beat's ladder size** — the accent is the tallest ink in the
beat, so it is what the vertical budget has to clear (an `s42` beat pads 0.9·73 = 65.7, not 0.9·42).
Then `y1 = cy − (Σ pitches)/2`,
`y(r+1) = y(r) + pitch` (keep fractional). Each word additionally jitters by `TJIT[k mod 5]`,
`TJIT = [0, −2, 3, −3, 2]` (k = beat word index) and, on the arc, rides
`dy·(1 − 4(t − ½)²)` with `t = i/(k−1)` across its row: `cy_i = y(r) + TJIT[k mod 5] + bow`. Word div
`top = cy_i − 0.75·(that word's OWN size)` (the line-box center anchor — the accent anchors off 73,
its row-mates off 42), rounded once. The clamp is what keeps the ink
inside y 43..677 for every shape, every L and every offset.

**Horizontal placement (per row r (0-based), words i=1..k with advances W_i):** each `W_i` uses that
word's OWN size, so the accent's advance is measured at 73 — that is how a bigger word opens its own
room. The swash budgets below (`0.10·size`, `0.20·size`, `0.30·size`) stay on the BEAT's ladder size
for every word of the row, accent included.
- Center-to-center pitches from the cycled table `XPITCH = [275, 400, 325, 210, 385, 285]` scaled by
  the pattern: gap g (0-based) gets `base_g = XPITCH[(N + r + 1 + g + 1) mod 6] · gapScale`, floored at
  `floor_g = W_g/2 + W_{g+1}/2 + 0.30·size + 35` (ink gap ≥ 35px incl. both swash overhangs):
  `pitch_g = max(base_g, floor_g)`.
- Row ink span `S = eL + Σ pitch + eR` with `eL = W_1/2 + 0.10·size`, `eR = W_k/2 + 0.20·size`.
- FIT to the 90..1190 band: if S > 1100, rescale `pitch_g = max(floor_g, base_g · f)` with
  `f = (1100 − eL − eR)/Σ base`; if S is still > 1100 use the floors outright.
- Place the row: `x0 = anchor + rowShift[r mod rowShift.length]`, clamped into `90 … 1190 − S`.
  First word center `c_1 = x0 + eL`; `c_{g+1} = c_g + pitch_g`. Word div `left = c_i − W_i/2`,
  rounded once.
- SPLIT rows instead break at `⌈k/2⌉` and hang the two halves either side of a protected middle:
  - `edges` (split): half A pressed to `90 + inset + rowShift`, half B to `1190 − inset − S_B −
    rowShift`, each fitted into `(1100 − gap)/2`. The inset keeps a word off the frame edge.
  - `centred` (pairs): half A's ink ends at `640 − v/2`, half B's starts at `640 + v/2`, with
    `v = gap + rowShift[r]` — the void breathes row to row, and NO word ever crosses the centre line.
  - If the halves would still collide (gap < 70) or a half runs past the band, the row falls back to
    one ordinary run. A lone word hangs off one side of the void outright, alternating by row.
- MIRROR (per beat) then reflects the finished row's ink box `[lo, hi]` about the band midline —
  translate every center by `1280 − hi − lo`, re-clamped into 90..1190. Pitches, order and gaps are
  untouched; only the side changes, so a cascade steps the other way and a column hugs the far edge.

**Worked example — beat 1** (REAL landscape-main fixture, `This is a Philips Hue smart bulb.`,
cueDelayMs 160, delays 160/240/320/440/840/1120/1400, next beat 1720 → winMs 1560, cueEnd 1720):
- Pattern = `PATTERNS[0]` = CASCADE (13 chars / 3 words / 5 rows), MIRROR[0] = false.
- prep → `This is a Philips Hue smart bulb` (7 words). Pack at the cascade caps: `This is a` (9) →
  r1 (+Philips = 17 > 13); `Philips Hue` (11) → r2 (+smart = 17); `smart bulb` (10) → r3. L = 3,
  C = 11 → `s42`. ACCENT = no digit unit, so the longest: `Philips` (k = 3) → `s73`
  (42 × 1.74 = 73.08 → 73) plus its underline; the other six words stay at 42.
- Y: leading 86 + 96 = 182; pad = 0.9·**73** + 3 + 0 + 91 = 159.7 (the ACCENT sets the budget) →
  clamp band 202.7 … 517.3; cy = 396 + VBAND[0] = 396, already inside → row centers 305 / 391 / 487.
  Tops = cy_i − 0.75·(own size), TJIT by k:
  This 274 · is 272 · a 277 · **Philips 333** (388 − 0.75·73) · Hue 362 · smart 456 · bulb 454.
- Row 1 X: W = 67.578 / 30.744 / 15.372 (This = 42×(0.511 + 3·0.366)). Gap indices (1+0+1+g+1) mod 6 =
  3, 4 → bases 210·0.55 = 115.5, 385·0.55 = 211.75 (floors 96.761, 70.658 — bases win). eL 37.989,
  eR 16.086, S 381.325. x0 = 108 + 0 → centers 145.989 / 261.489 / 473.239 →
  lefts **112 / 246 / 466**.
- Row 2 X: W 197.611 (`Philips` measured at 73) / 52.206 (`Hue` at 42); gap index 4 → base 211.75,
  floor 172.5085 (the swash terms still off 42) — the base wins. eL 103.0055, eR 34.503.
  x0 = 108 + 104 = 212 → centers 315.0055 / 526.7555 → lefts **216 / 501**. The accent's own advance
  is what pushes `Hue` clear — a bigger word opens its own room instead of colliding.
- Row 3 X: W 76.86 / 61.488; gap index 5 → base 285·0.55 = 156.75, floor 116.774 — the base wins;
  x0 = 108 + 208 = 316 → centers 358.63 / 515.38 → lefts **320 / 485**. The three rows step down and
  along — that is the cascade.
- The accent's UNDERLINE (`b1u`, spline 0 = the rising smile, all off the 73px accent size):
  left = 315.0055 − 98.8055 − 0.1·73 = 208.9 → **209**; top = 388 − 0.75·73 + 1.02·73 = 407.71 →
  **408**; width = 197.611 + 2·0.1·73 = 212.211 → **212**; height = 0.42·73 = 30.66 → **31**;
  delay = min(max(440 − 130, 160), max(1720 − 520, 160)) = **310ms** — the stroke opens 130ms ahead
  of the word and `Philips` lands into it.
- Compression: bulb has cueEnd − 1400 = 320 < 420 → inline `animation-duration:320ms`; all others
  keep the default 420ms (no inline duration).

## 4. WORDS + TIMING

- One `.word` div per prepped word, inline `animation-delay:{delayMs}ms` — that word's `delayMs` from
  `runs/<key>/word-timings.json` VERBATIM (absolute on the single timeline — never re-zero, never
  invent). A glued pair is ONE div, first token's delay.
- ENTRANCE COMPRESSION (mechanical, per word): d = min(420, max(cueEnd − delayMs, 250)). If d < 420,
  append inline `animation-duration:{d}ms`; d = 420 → no inline duration.
- Words ACCUMULATE — a revealed word HOLDS until the cue gate cuts the beat. No fade-outs anywhere;
  the gate (`cueWin`) is the only exit, and the beat's full scatter rides it to `winEnd`.
- The beat's `.cue` gets inline `z-index:{10+N}; animation-delay:{cueDelayMs}ms;
  animation-duration:{winMs}ms` exactly as in section 3.
- Words never share a container line — every word is its own absolutely-positioned div, so no word
  gaps, spacers, or `&#160;` are needed; the ≥35px floored ink gap in section 3 is the separation.

## 5. EMPHASIS

ONE accent word per beat — SIZE plus its underline are the whole device, never a colour, a weight, a
plate or a rotation. The accent unit is the shared counter-accent rule (digit-bearing unit first, else
the longest, tie → the later one) and it renders at **×1.74 of the beat's ladder size** (42 → 73,
38 → 66, 34 → 59, 30 → 52, 25 → 44). Its placement falls out of the same row maths: the row's pitches
use the accent's advance at its OWN size and the beat's vertical pad is `0.9 · accent size` (§3), so a
bigger word opens its own room instead of colliding. A demotion steps both rungs down together.

**Optical tracking.** Letter-spacing is NOT one value: every reachable size carries its own, off the
falling line `0.9 − 0.0215 · size` px (reference canvas, scale-multiplied unrounded). Bigger type ⇒
tighter tracking, negative at the accent sizes — the eye reads inter-letter distance non-linearly and
one em value looks blown out once the size grows.

**The accent's underline.** A hand-drawn stroke swept under the accent word, starting 130ms BEFORE
the word lands (the stroke leads, the word arrives into it) and taking 520ms to cross. Geometry in em
of the accent size: box top `+1.02`, box height `0.42`, `0.1` overshoot each side of the advance,
stroke thickness 0.115 of the box height. The shape is ONE element clipped to a `clip-path: polygon()`
in percent tracing the centreline of one of four splines (cycled by beat: a rising smile, an inverted
bow, a shallow S, a near-straight drop), and it grows by `transform: scaleX(0 → 1)` from
`transform-origin: 0 50%`.

WHY those three choices, and never "simplify" them back:
- Growth is scaleX because ONE percent outline then stays exact at every word width. A `width`
  keyframe animates on this engine (probe: width-keyframes-static, refuted) — it is simply not this
  ref's device.
- An animated `clip-path` also interpolates (probe: animated-clip-path, refuted, measured on
  `polygon()`; `inset()` was never probed). The static clip-path here carries the spline outline, so
  animating it would fight the geometry, not the engine.
- A rotated wrapper around a sized child renders many times too thick, and a chain of rotated boxes
  facets at every joint. One element, one clipped outline.

## 6. VERIFY LOOP

Run (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Otherwise apply the MECHANICAL fix for the named element and re-run; at most 2 fix
cycles:
- `FAIL[bounds] #b{N}w{k}` (any direction) → step that word's WHOLE BEAT one row DOWN the size ladder
  (`s42`→`s38`→…→`s25`, the accent rung falling with it) and recompute the beat's placement from the
  new size (smaller ink pulls every
  edge toward the row centers). Same beat again → one more row.
- `FAIL[never-visible]` → the word was pasted into the WRONG beat's `.cue`, or the cue is missing one
  of its three inline values, or a word div lost its `left/top/animation-delay`; confirm the `<video>`
  is the first body element at z0 and every cue carries `z-index:{10+N}`.
- `FAIL[occluded]` → cue windows overlap: re-check each `{winMs}` equals the next beat's `cueDelayMs`
  minus this beat's, cues appear in DOM in beat order, z-index is 10+N.
- Exit 2 → engine render failure: re-diff your file against the SKELETON block; the divergence is
  the bug.

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --progress-output --record {repo}/runs/<key>/final/out.silent.mp4
```

Manifest line (already given in section 2): `{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}` — W/H/FPS/DUR from `meta.json`.

## 7. DO NOT

- No fonts, colors, shadows, sizes, or keyframes beyond this sheet — Caveat 600, `#fdf7f4`, the one
  two-layer dark text-shadow, the underline's drop-shadow, `cueWin`/`wIn`/`ulDraw`, and the ten `.s*`
  classes (five ladder rungs + their five accent rungs) are the whole system. Never invent an
  eleventh size, and never give one word a size off its beat's rung.
- ONE accent a beat, and it is the ONLY marked word: no plates, boxes, rotations, per-word color or
  weight change on anything, accent included.
- The underline belongs to the accent alone — exactly one `.ul` per beat, exactly the §5 geometry
  (1.02 / 0.42 / 0.1 em of the accent size, 0.115 of the box height, four cycled splines). Never a
  second stroke, never a rule under an ordinary word, never a highlighter plate behind one.
- Never grow that stroke with `width`, an animated `clip-path` or an animated `inset()` — this is the
  sheet's rule, not an engine limit (the first two ramp fine: probes width-keyframes-static and
  animated-clip-path, both refuted). It is `scaleX(0 → 1)` from `transform-origin: 0 50%` with BOTH
  keyframe ends authored, on ONE element carrying a STATIC percent `clip-path` — never a chain of
  rotated segments (it facets at every joint) and never a rotated wrapper around a scaled child (it
  renders many times too thick).
- Never center a word with `translate(-50%,-50%)` or `text-align` — position by the computed LEFT px
  only (the one why-clause: `--verify` measures ink pre-transform).
- No invented timing: every `delayMs`/`cueDelayMs` comes verbatim from `word-timings.json`; derived
  numbers ({winMs}, compression d, lefts/tops) ONLY via the closed forms in sections 3–4.
- Words accumulate and the gate cuts the beat — never add per-word fade-outs, never fade the last
  scatter early.
- Keep the spoken case; never `text-transform`; never drop the `padding-bottom:0.2em` or thin the
  text-shadow.
- Never animate `color`; no flex anywhere; flat classes/ids exactly as in the skeleton.
- Never read the video frames; never re-derive layout; no redesign after a render or verify failure —
  only the mechanical fixes in section 6.
