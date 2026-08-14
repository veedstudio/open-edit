# RECIPE — hook-091 Pre-comp 1-peak (16:9 · 1280×720 @ 24fps)

RESOLUTION: px are authored at the 16:9 reference canvas 1280×720. FIRST STEP: SCALE = W/1280 from
`meta.json` (require |H − 720·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px value by SCALE — font sizes, row tops, gaps AND the text-shadow terms
(authored integers round; DERIVED values — row tops, gap px — keep 2 decimals, never force-round);
`em` values (the per-rung letter-spacing, span padding, the slabIn rise) and ms timings never scale;
the manifest carries the run's real W/H.

Prefab is 960×720 (same 720 height): the composition below is RE-COMPOSED for the wide 1280×720 frame
over full-bleed footage — the three rows center on 640 and justify across the wider frame, and the whole
stack is BOTTOM-ANCHORED (it hangs off one baseline pin low in the frame, it does not sit at the prefab's
vertical pins). Copy numbers as written, never rescale against the prefab.

## 1. IDENTITY

A brutalist Anton-caps type poster over full-bleed footage, sitting LOW in the frame: a sparse row of
small words scattered wide, ONE giant slab word (the beat's accent) under them arriving with a
restrained reveal — opacity plus a short rise, nothing else — and the trailing words in a small centered
line riding under the slab's ink. The ink is poster neon yellow — `#fff402` with two yellow glow layers
over one dark grounding layer — the same treatment at every size. The three rows run on ONE leading:
every adjacent pair sits the same 26px apart, measured baseline → ink top, so the stack reads as one
block whatever the beat's sizes are. Tracking is optical, not linear: each size rung carries its own
letter-spacing off a falling curve, open at caption sizes and NEGATIVE on the display slab. Every word
pops on its own spoken timing, the poster accumulates, and the beat gate cuts it.

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
<link href="https://fonts.googleapis.com/css2?family=Anton&display=swap" rel="stylesheet">
<style>
  html, body { margin: 0; padding: 0; }
  body { width: 1280px; height: 720px; background: #1a1410; overflow: hidden; position: relative; }
  .vid { position: absolute; inset: 0; width: 1280px; height: 720px; object-fit: cover; }

  /* window gate — the one safe reveal recipe; delay+duration+z come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position: absolute; inset: 0; opacity: 0; z-index: 11;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* full-width centered row + inline-block spans — the layout construct. This wrapper is load-bearing:
     a bare absolutely-positioned inline-block in body flow gets page-coupled ink offsets in this
     engine — always center through .row, never translate(-50%). Tracking is NOT set here: every size
     class carries its own (the optical curve), so the value falls as the size rises. */
  .row { position: absolute; left: 0; width: 1280px; text-align: center; line-height: 1; z-index: 2;
         font-family: 'Anton', sans-serif; font-weight: 400; }

  /* word spans: the vertical padding is descender headroom (an animating span rasterizes at its
     line-height:1 box and glyph edges clip without it); ink extents are calibrated WITH it.
     ONE ink for every word at every size — poster neon yellow: two yellow glow layers over a dark
     grounding layer that holds the type off bright footage. */
  @keyframes fadeIn { 0% { opacity: 0; } 100% { opacity: 1; } }
  @keyframes slabIn { 0% { opacity: 0; transform: translateY(0.09em); } 100% { opacity: 1; transform: translateY(0); } }
  .w { display: inline-block; white-space: nowrap; padding: 0.06em 0 0.14em; opacity: 0; color: #fff402;
       text-shadow: 0 0 14px rgba(255,225,0,.55), 0 0 4px rgba(255,225,0,.7), 0 2px 12px rgba(0,0,0,.7);
       animation-name: fadeIn; animation-timing-function: cubic-bezier(.2,.7,.3,1); animation-fill-mode: both; }
  .b { display: inline-block; white-space: nowrap; padding: 0.06em 0 0.14em; opacity: 0; color: #fff402;
       text-shadow: 0 0 14px rgba(255,225,0,.55), 0 0 4px rgba(255,225,0,.7), 0 2px 12px rgba(0,0,0,.7);
       animation-name: slabIn; animation-timing-function: cubic-bezier(.2,.7,.3,1); animation-fill-mode: both; }

  /* size + its OWN tracking (section 3, the optical curve) — never one flat row value */
  .f49{font-size:49px;letter-spacing:-0.0007em} .f45{font-size:45px;letter-spacing:0.0011em}
  .f41{font-size:41px;letter-spacing:0.0032em} .f38{font-size:38px;letter-spacing:0.0051em}
  .f34{font-size:34px;letter-spacing:0.0081em} .f31{font-size:31px;letter-spacing:0.0109em}
  .f29{font-size:29px;letter-spacing:0.0131em} .f26{font-size:26px;letter-spacing:0.017em}
  .f24{font-size:24px;letter-spacing:0.0201em} .f21{font-size:21px;letter-spacing:0.026em}
  .g113{font-size:113px;letter-spacing:-0.012em} .g104{font-size:104px;letter-spacing:-0.0113em}
  .g95{font-size:95px;letter-spacing:-0.0104em} .g88{font-size:88px;letter-spacing:-0.0096em}
  .g81{font-size:81px;letter-spacing:-0.0086em} .g74{font-size:74px;letter-spacing:-0.0075em}
  .g69{font-size:69px;letter-spacing:-0.0065em} .g63{font-size:63px;letter-spacing:-0.0051em}
  .g58{font-size:58px;letter-spacing:-0.0038em} .g53{font-size:53px;letter-spacing:-0.0022em}
  .g49{font-size:49px;letter-spacing:-0.0007em} .g45{font-size:45px;letter-spacing:0.0011em}
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

One `.cue` per beat `{N}` of `word-timings.json`. A beat is ONE poster — up to three rows that
accumulate (no paging, no turn-taking; the gate cuts the stack). Beat template (omit any row whose
slot is empty):

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N};animation-delay:{cueDelayMs}ms;animation-duration:{cueDurMs}ms">
  <div class="row {TS}" id="b{N}t" data-node-id="b{N}t" data-node-role="text" style="top:{topTop}px"><span class="w" style="animation-delay:{delayMs}ms;animation-duration:{inMs}ms;margin-right:{gapPx}px">{WORD}</span><!-- more spans, no whitespace between, last span has no margin --></div>
  <div class="row {GS}" id="b{N}g" data-node-id="b{N}g" data-node-role="text" style="top:{bigTop}px"><span class="b" style="animation-delay:{delayMs}ms;animation-duration:{inMs}ms">{BIG}</span></div>
  <div class="row {SS}" id="b{N}s" data-node-id="b{N}s" data-node-role="text" style="top:{subTop}px"><span class="w" style="animation-delay:{delayMs}ms;animation-duration:{inMs}ms;margin-right:{gapPx}px">{WORD}</span><!-- more spans --></div>
</div>
```

**Word prep (before counting anything):** UPPERCASE every token yourself (never text-transform); strip
a trailing `.` or `,`; keep `?` `!` `'` and any INTERNAL punctuation (`£55`, `10,000` stay as is); drop
tokens that strip to nothing. GLUE: a token starting with `-` (e.g. `-DO` after `TO`) merges with the
previous word into ONE unit for mapping and char counting (`TO-DO` = 5 chars) and renders as two
ADJACENT spans with the first span's `margin-right:0`, each keeping its own verbatim `delayMs`.

**Slot mapping — deterministic, word order always preserved.** Let `a` = the beat's accent index
(section 5):
- **BIG** = the accent unit alone.
- **TOP** = ALL units before `a`, in order, one scattered row (omit when empty).
- **SUB** = ALL units after `a`, in order, one line (omit when empty).

**Tracking — the optical curve (needed before any width math).** Letter-spacing is NOT one value for
the poster: the eye reads inter-letter distance non-linearly, so the em value that is right on the small
words is blown open once the word is a display slab. Every rung carries its own, off a FALLING curve

> **track(f) = 0.98/f − 0.0207 em**, rounded to 4 decimals

which is +0.026em at f21, crosses zero between f45 and f49, and reaches −0.012em at g113. Values are
baked into the size classes in section 2; use the rung's own value in every width computation below.

| f | 21 | 24 | 26 | 29 | 31 | 34 | 38 | 41 | 45 | 49 | 53 | 58 | 63 | 69 | 74 | 81 | 88 | 95 | 104 | 113 |
| track (em) | .0260 | .0201 | .0170 | .0131 | .0109 | .0081 | .0051 | .0032 | .0011 | −.0007 | −.0022 | −.0038 | −.0051 | −.0065 | −.0075 | −.0086 | −.0096 | −.0104 | −.0113 | −.0120 |

**Sizing — one class per row from its ladder.** All rows share the width budget **B = 1088px**
(centered on 640 → x 96..1184, inside the ~6% verify band). The ladder px are the prefab's cap heights
÷ 0.87 (Anton's cap/em) — the poster keeps its optical scale under the new face. Per row compute, in
this order:
1. C: TOP → TL + 3·(n−1) · BIG → unit chars · SUB → TL + 2·(n−1), where TL = the row's summed unit
   chars and n = its unit count (the +3/+2 terms charge the gaps).
2. Coarse pick — first ladder column whose maxC ≥ C (maxC = ⌊B/(0.51·f)⌋, a per-char width budget that
   stays an upper bound at every rung: Anton caps average 0.479em bare and the widest rung tracking is
   +0.026em → 0.505em; ladders ordered for the fix-loop stepping):

   TOP and SUB (`{TS}`/`{SS}`, f-classes):
   | f | 49 | 45 | 41 | 38 | 34 | 31 | 29 | 26 | 24 | 21 |
   | maxC | 43 | 47 | 52 | 56 | 62 | 68 | 73 | 82 | 88 | ∞ |

   BIG (`{GS}`, g-classes):
   | f | 113 | 104 | 95 | 88 | 81 | 74 | 69 | 63 | 58 | 53 | 49 | 45 |
   | maxC | 18 | 20 | 22 | 24 | 26 | 28 | 30 | 33 | 36 | 40 | 43 | ∞ |

3. Exact-fit floor with the REAL advances AT EACH RUNG'S TRACKING: Σraw = the row's summed per-character
   BARE advances (em, table below) over all its units, K = the row's character count, and
   **Amin(f) = Σraw + K·track(f) + minGap·(n−1)** with minGap = 1.2 (TOP) / 0 (BIG) / 0.75 (SUB).
   Starting at the coarse pick, step DOWN the ladder while f > B/Amin(f), recomputing Amin at each rung
   (the tracking falls as you step up, so the check is per rung, never once); clamp at the last row.
4. Gaps (`margin-right` on every span but the row's last; glued spans keep 0), with
   Σadv = Σraw + K·track(f) at the row's FINAL f:
   - TOP → gapPx = clamp((B/f − Σadv)/(n−1), 1.2, 7)·f — the wide scatter justifies the row toward
     the full budget; 2 decimals, n = 1 → no gap.
   - SUB → fixed gapPx = 0.75·f.
   - BIG → single unit, no gap.

**Placement — ONE leading (closed-form, reference px; f1/F/f2 = the px sizes behind `{TS}`/`{GS}`/`{SS}`;
2 decimals, fractional values stay fractional).** Calibration (engine render of this skeleton's exact
classes): ink top = rowTop + 0.115em, baseline = rowTop + 0.985em (cap height 0.87em), descenders (`,`
`Q` `J` `;`) reach 1.095em; Anton caps average 0.479em bare (the maxC tables budget 0.51).

The stack is BOTTOM-ANCHORED — it hangs off ONE pin, **BASE = 648 = the BASELINE of the lowest row
present** — so the poster sits low in the frame at every size, and a demotion pulls it tighter and
lower instead of leaving it stranded mid-frame. The rhythm between rows is ONE number, **LEAD = 26px**:
EVERY adjacent pair measures *baseline of the upper row → ink top of the lower row* = LEAD, whatever the
two sizes are (this is what makes the three rows read as one block — never derive a gap from the
prefab's ink-top-to-ink-top or baseline-to-baseline distances, they drift with the sizes). Derive
UPWARD, in this order:
- `subTop = 648 − 0.985·f2` (SUB present only) → the SUB's ink top is `648 − 0.87·f2`.
- slab baseline `slabBase = 648 − 0.87·f2 − 26` (SUB present) or `648` (SUB absent).
- `bigTop = slabBase − 0.985·F` → the slab's ink top is `bigTop + 0.115·F`.
- `topTop = bigTop + 0.115·F − 26 − 0.985·f1` (TOP present only).
- HEIGHT is budgeted by construction: the deepest ink is the 648 pin (a descender adds 0.11·f; the
  slab's 0.09em rise sits 0.09·F lower for the length of its reveal) and the tallest stack
  (F = 113, f1 = 49) starts at ink y 412.4 — inside the 43..676 safe band. Clearances follow from the
  one LEAD: the top row's deepest descender clears the slab's ink top by 26 − 0.11·f1 ≥ 20.6px, and the
  slab's deepest ink clears the sub line's ink top by 26 − 0.11·F ≥ 13.6px (≥ 3.4px even mid-rise).

**Worked example (landscape-main fixture, beat 1 — `This is a Philips Hue smart bulb.`, cueDelayMs 160,
cueDurMs 1560 → cueEnd 1720; delays 160/240/320/440/840/1120/1400):** units THIS IS A PHILIPS HUE SMART
BULB; accent = PHILIPS (7 chars, longest) → BIG, C=7 → `g113`, Σraw 2.735, K=7,
Amin(113) = 2.735 − 0.084 = 2.651 (B/Amin = 410 → no floor). SUB = HUE SMART BULB: TL=12, n=3, C=16 →
`f49`; Σraw = 1.375 + 2.553 + 1.816 = 5.744, K=12; Amin(49) = 5.744 − 0.0084 + 1.5 = 7.2356,
B/Amin = 150.4 → no floor; gapPx = 0.75·49 = 36.75; subTop = 648 − 48.265 = 599.74. Slab:
slabBase = 648 − 42.63 − 26 = 579.37 → bigTop = 579.37 − 111.305 = 468.06. TOP = THIS IS A: TL=7, n=3,
C=13 → `f49`; Σraw = 1.573 + 0.683 + 0.484 = 2.740, K=7; Amin(49) = 2.740 − 0.0049 + 2.4 = 5.135 → no
floor; Σadv = 2.7351; gapEm = clamp((22.204 − 2.735)/2, 1.2, 7) = 7 → gapPx 343;
topTop = 468.065 + 12.995 − 26 − 48.265 = 406.80. Leading check: slab ink top 481.06 − top baseline
455.06 = 26; sub ink top 605.37 − slab baseline 579.37 = 26. Entrances (§4): THIS/IS/A/HUE/SMART 350,
PHILIPS 500, BULB min(350, max(220, 1720−1400−80)) = 240.

Anton 400 BARE advances (em/char at letter-spacing 0 — the rung's track(f) is added per character on
top; unknown char → 0.51):
A .484 B .475 C .473 D .489 E .409 F .396 G .483 H .495 I .224 J .464 K .470 L .395 M .741 N .494
O .484 P .469 Q .491 R .474 S .459 T .395 U .471 V .469 W .710 X .484 Y .446 Z .409 · 0 .493 1 .329
2 .493 3 .491 4 .494 5 .493 6 .493 7 .490 8 .493 9 .493 · ' .211 ? .490 ! .226 £ .471 , .234 . .226
- .309 & .518 % 1.055 $ .460 + .354 : .239 ; .243 " .426

## 4. WORDS + TIMING

- Delays are absolute on the single timeline — paste as-is from `runs/<key>/word-timings.json`, never
  re-zero, never invent.
- Each beat's `.cue` gets inline `animation-delay:{cueDelayMs}ms;animation-duration:{cueDurMs}ms`
  verbatim, plus `z-index:{10+N}`.
- The WORD is the animated unit: each span gets inline `animation-delay:{delayMs}ms` VERBATIM and
  `animation-duration:{inMs}ms` with `inMs = min(D0, max(220, cueEnd − delayMs − 80))`,
  cueEnd = cueDelayMs + cueDurMs, D0 = 500 for the BIG slab (`.b`) and 350 for every other word
  (`.w`) — the entrance compresses so a late word still lands before the gate.
- Word gaps are the computed `margin-right` px — inter-span whitespace is not what sets the gap here, the
  margins ARE the gaps. Write spans adjacent with no whitespace between them.
- Words accumulate — every landed word HOLDS at full opacity; the beat's gate cuts the whole poster
  at the window end. No fade-outs anywhere (nothing shares an anchor mid-beat).

## 5. EMPHASIS

One device, structural, from ONE pick: the accent unit renders as the giant slab (one-big-bold) while
everything else stays small — the size contrast IS the counter-accent (the ink is identical: same
yellow, same glow, at every size). Its reveal is the `slabIn` rise: opacity 0→1 with
`translateY(0.09em)→0` over 500ms, and NOTHING else — no scale, no stretch, no overshoot. Pick rule, no
judgment: any digit-bearing unit (the FIRST if several), else the most characters (punctuation counted),
tie → the LATER unit. Exactly one accent per beat; nothing else is styled differently.

## 6. VERIFY LOOP

Run (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Otherwise apply the mechanical fix for the flagged element and re-run; at most 2 fix
cycles:
- `FAIL[bounds] #b{N}t / #b{N}s … left/right outside` → that row's f-class one step DOWN the ladder
  (recompute its tracking, gap and top for the new f; a SUB demotion moves the whole stack — re-derive
  `bigTop` and `topTop` too).
- `FAIL[bounds] #b{N}g … left/right outside` → that beat's `{GS}` one step DOWN the g-ladder
  (recompute `bigTop` AND `topTop` for the new F).
- `FAIL[bounds] … top/bottom outside` → an arithmetic slip, not a design problem: re-check that
  beat's `subTop`/`bigTop`/`topTop` against the section-3 closed forms for its ACTUAL f/F values
  (the band is inside 43..676 by construction); never move the BASE 648 pin and never retune LEAD 26.
- `FAIL[never-visible]` → check that cue's inline `animation-delay`/`animation-duration` match
  `word-timings.json`, the `<video>` is the first body element with `style="z-index:0"`, and every
  span's class is exactly `w` or `b` (a typo'd `fadeIn`/`slabIn`/`cueWin` never animates in).
- `FAIL[occluded] #b{N}…` → cue windows overlap: cue N's `animation-duration` must not exceed
  `cueDelayMs(N+1) − cueDelayMs(N)`; if it does, set it to that difference. Confirm inline z-index is
  10+N in beat order.

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --progress-output --record {repo}/runs/<key>/final/out.silent.mp4
```

Manifest line (already given in section 2): `{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}` — W/H/FPS/DUR from `meta.json`.

## 7. DO NOT

- No fonts, colors, shadows, sizes, or keyframes beyond this sheet — Anton 400, `#fff402`, the one
  3-layer yellow glow, `cueWin`/`fadeIn`/`slabIn` and the two ladders are the whole system. Never
  return the type to white, never give the slab a different ink from the small words, never add a
  fourth shadow layer or drop the dark grounding layer (it is what holds the yellow off bright footage).
- The three rows run on ONE leading: never hand-space a pair, never re-introduce a prefab
  ink-top-to-ink-top or baseline-to-baseline gap, and never let two pairs in the same poster differ.
  Retuning LEAD means retuning it for the whole recipe, in this sheet.
- Tracking comes from the curve, per rung — never one flat `letter-spacing` on `.row`, never a value
  that rises with the size, never the same em on a caption word and on the display slab.
- The prefab's bottom fine-print caption row (`powergrade and LUT along with guide will be available
  soon` — demo promo copy) is deliberately NOT carried over; never re-add it and never fill that slot
  from the transcript. Oswald (its font) is not loaded.
- The prefab's flat `#1a1410` background is replaced by the full-bleed footage; never paint it back.
- The slab's reveal is opacity + the 0.09em rise on the word span only — never a `scale`/`scaleY`
  (growing out of its own middle reads as a stretch), never park a transform on `.row` or `.cue`, and
  never squeeze a row's layout with a static scale (the verifier measures ink PRE-transform; the
  layout font must fit the canvas by itself).
- Never center with `translate(-50%,-50%)` and never use flex — the full-width `.row` +
  `text-align:center` + inline-block spans is the layout; there are no bare absolute spans.
- The stack hangs off the BASE 648 baseline pin — never re-anchor it to the top of the frame, never
  give a row a hand-picked `top`, and never raise BASE to buy room for a bigger size (step the ladder
  down instead).
- Words never share a slot across rows: TOP is everything before the accent, SUB everything after —
  never rebalance, never move a word between rows, never page a beat (long rows shrink down the
  ladders instead).
- No invented timing: every `delayMs`/`cueDelayMs`/`cueDurMs` comes verbatim from
  `word-timings.json`; derived numbers ONLY via the closed forms in sections 3–4.
- Words accumulate and the gate cuts the beat — never add fade-outs.
- Never animate `color`; no
  `-webkit-text-stroke`; no `steps()` timing; single-value border-radius only (none is used here).
- Never read the video frames; never re-derive layout; no redesign after a render or verify failure —
  only the mechanical fixes in section 6.
