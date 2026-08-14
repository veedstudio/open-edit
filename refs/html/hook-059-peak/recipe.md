# RECIPE — hook-059-peak (16:9 · 1280×720 @ 24fps)

RESOLUTION: px are authored at the 16:9 reference canvas 1280×720. FIRST STEP: SCALE = W/1280 from
`meta.json` (require |H − 720·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE (positions/tops round to int; computed gap/letter-spacing px keep
2 decimals); `em` values, scaleY factors and ms timings never scale; the manifest carries the run's
real W/H.

Prefab is 960×720 on a flat #101010 background; the composition below is RE-COMPOSED for the wide
1280×720 frame over footage: the prefab's vertical geometry (720 high) supplies the two-row and peak
ink-band centers verbatim, the one- and three-row bands are composed against the same 720 height, and
the row widths are refit to the wider canvas. Copy numbers as written, never rescale against the
prefab.

## 1. IDENTITY

A brutalist full-bleed type poster: every beat is giant red Anton caps stretched tall (static scaleY)
to span the frame edge to edge over the footage. The beat SPLITS AT ITS ACCENT — the words spoken
before it form the row above, the accent unit stands alone in its own row, the words after it form
the row below — so the rows always run in the sentence's own order. EVERY row is justified to fill
the container width, so a two-letter word sits exactly as wide as the long row above it. The LAST
beat swaps to the prefab's peak composition — a small lowercase Baloo counter line, one monumental
letter-spaced headline word, and a three-line red Hanken credits block fading in beneath. Words pop
in hard on their spoken timings; each poster hard-cuts to the next at the beat boundary.

## 2. SKELETON

Paste this whole document as `runs/<key>/final/template.wv`, then add one `.cue` block per beat
(section 3) after the `<video>` element. Replace only `{videoPath}` (from `meta.json`). Canvas: see
RESOLUTION at the top of this sheet.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@700;900&family=Baloo+2:wght@700&family=Anton&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:1280px; height:720px; overflow:hidden; background:#101010; }
  body { position:relative; font-family:'Hanken Grotesk', system-ui, sans-serif; }
  .vid { position:absolute; inset:0; width:1280px; height:720px; object-fit:cover; }

  /* beat gate — the one safe reveal recipe; z-index + delay + duration come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position:absolute; inset:0; opacity:0;
         animation-name:cueWin; animation-timing-function:linear; animation-fill-mode:forwards; }

  .col { position:absolute; left:0; width:1280px; display:flex; flex-direction:column;
         align-items:center; color:#f50200; line-height:1; z-index:2; }

  /* giant stretched row — the scaleY is STATIC (inline, per row); word reveals ride the inner spans.
     The dark halo grounds the flat red on bright footage (the prefab's #101010 bg does it for free). */
  .bigline { font-family:'Anton', 'Archivo Black', sans-serif; font-weight:400; color:#f50200;
             white-space:nowrap; display:inline-block; transform-origin:center;
             text-shadow:0 0.02em 0.12em rgba(0,0,0,0.55); }

  /* word spans: vertical padding is descender headroom — an animating span rasterizes at its
     line-height:1 box and glyph bottoms clip without it. Ink extents are calibrated WITH it. */
  @keyframes popIn { 0%{opacity:0} 100%{opacity:1} }
  @keyframes wordIn { 0%{opacity:0; transform:translateY(0.1em)} 100%{opacity:1; transform:translateY(0)} }
  @keyframes fadeIn { 0%{opacity:0} 100%{opacity:1} }
  .w  { display:inline-block; position:relative; z-index:1; opacity:0; padding:0.06em 0 0.14em;
        animation-name:popIn; animation-timing-function:linear; animation-fill-mode:both; }
  .wc { display:inline-block; position:relative; z-index:1; opacity:0; padding:0.06em 0 0.14em;
        animation-name:wordIn; animation-timing-function:cubic-bezier(.2,.7,.3,1); animation-fill-mode:both; }
  .wh { display:inline-block; position:relative; z-index:1; opacity:0; padding:0.06em 0 0.14em;
        animation-name:wordIn; animation-timing-function:cubic-bezier(.2,.7,.3,1); animation-fill-mode:both; }

  /* peak counter line — the prefab's small lowercase Baloo word over the monumental headline */
  .from { font-family:'Baloo 2', system-ui, sans-serif; font-weight:700; color:#f50200;
          letter-spacing:-0.009em; white-space:nowrap;
          text-shadow:0 0.02em 0.1em rgba(0,0,0,0.6); }

  /* credits block — fixed dressing, fades in once with the last beat and rides its gate */
  .subblock { gap:1px; z-index:3; opacity:0;
              animation-name:fadeIn; animation-duration:600ms; animation-timing-function:ease-out;
              animation-fill-mode:both; }
  .cr { font-family:'Hanken Grotesk', sans-serif; font-weight:700; font-size:18px;
        letter-spacing:-0.3px; line-height:22px; color:#e8121a; transform:scaleX(0.9);
        transform-origin:center; white-space:nowrap; text-shadow:0 1px 4px rgba(0,0,0,0.6); }
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

One `.cue` per beat in `word-timings.json`. `{winMs}` = next beat's `cueDelayMs` − this beat's (last
beat: round(`durationSec`×1000) − its `cueDelayMs`).

**Word prep (before counting anything):** strip trailing `.` and `,` from each token (keep `?` `!`
`'` `£` and internal punctuation; drop tokens that strip to nothing); UPPERCASE every unit yourself
(never rely on `text-transform`). GLUE: a leading-`-` token merges with the previous word into ONE
unit for counting (rendered as two adjacent spans, previous span's gap zeroed, each keeping its own
verbatim `delayMs`).

**Accent split (the counter-accent device):** exactly ONE accent unit per beat — any digit-bearing
unit (the first if several), else the most characters (punctuation counted), tie → the LATER unit.
The beat then splits AT the accent, IN READING ORDER: the units spoken BEFORE it become row
`b{N}r1`, the accent alone becomes row `b{N}r2`, the units spoken AFTER it become row `b{N}r3`.
An empty side is simply omitted — the ids stay pinned to reading position, never renumbered: an
accent-first beat renders `r2`+`r3`, an accent-last beat renders `r1`+`r2`, a single-unit beat
renders `r2` alone. Never reorder units; a beat's tail words never sit above its accent.

**STANDARD beat (every beat except the last):**

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N};animation-delay:{cueDelayMs}ms;animation-duration:{winMs}ms">
  <div class="col" style="top:{T1}px"><div class="bigline" id="b{N}r1" data-node-id="b{N}r1" data-node-role="text" style="font-size:{f}px;transform:scaleY(2.27)"><span class="w" style="animation-delay:{delayMs}ms;animation-duration:{popMs}ms;margin-right:{gapPx}px">{WORD BEFORE THE ACCENT}</span><!-- more words, no whitespace between spans, last span has no margin --></div></div>
  <div class="col" style="top:{T2}px"><div class="bigline" id="b{N}r2" data-node-id="b{N}r2" data-node-role="text" style="font-size:{f}px;transform:scaleY(2.17);letter-spacing:{lsPx}px;position:relative;left:{lsPx/2}px"><span class="w" style="animation-delay:{delayMs}ms;animation-duration:{popMs}ms">{ACCENT}</span></div></div>
  <div class="col" style="top:{T3}px"><div class="bigline" id="b{N}r3" data-node-id="b{N}r3" data-node-role="text" style="font-size:{f}px;transform:scaleY(2.27)"><span class="w" style="animation-delay:{delayMs}ms;animation-duration:{popMs}ms;margin-right:{gapPx}px">{WORD AFTER THE ACCENT}</span><!-- more words --></div></div>
</div>
```

`r1`/`r3` are TOP rows (scaleY 2.27, TOP ladder); `r2`, the accent row, is a BOTTOM row (scaleY 2.17,
BOTTOM ladder) wherever it lands. Each row is fitted independently — sibling rows share no font size.
A row that is a solo unit gets the letter-spacing block (`r1`/`r3` included); a solo unit of 1
character gets none (`font-size` + `scaleY` only).

**PEAK beat (the LAST beat only):** counter line (the non-accent units, typed in lowercase) +
monumental headline (the accent unit) + the credits block:

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N};animation-delay:{cueDelayMs}ms;animation-duration:{winMs}ms">
  <div class="col" style="top:{TC}px"><div class="from" id="b{N}c" data-node-id="b{N}c" data-node-role="text" style="font-size:{f}px"><span class="wc" style="animation-delay:{delayMs}ms;animation-duration:{inMs}ms;margin-right:{0.25·f}px">{word}</span><!-- more lowercase words --></div></div>
  <div class="col" style="top:{TH}px"><div class="bigline" id="b{N}h" data-node-id="b{N}h" data-node-role="text" style="font-size:{f}px;transform:scaleY(1.56);letter-spacing:{lsPx}px;position:relative;left:{lsPx/2}px"><span class="wh" style="animation-delay:{delayMs}ms;animation-duration:{inMs}ms">{ACCENT}</span></div></div>
  <div class="col subblock" style="top:506px;animation-delay:{crDelayMs}ms">
    <div class="cr" id="cr1" data-node-id="cr1" data-node-role="text">WRITTEN, FILMED, DIRECTED AND PRODUCED BY YOURS TRULY</div>
    <div class="cr" id="cr2" data-node-id="cr2" data-node-role="text">FOR THIS VERY FEED, WITH LOVE</div>
    <div class="cr" id="cr3" data-node-id="cr3" data-node-role="text">MADE ON THE INTERNET</div>
  </div>
</div>
```

**Row fitting — layout font `f` + static scaleY, never a giant font + scaleX** (the engine clips
glyphs whose PRE-transform layout position leaves the canvas, so the layout box must fit and the
stretch happen in the transform). Every Anton row displays at width budget **B = 1088px**:

0. **Bands + ladder start by ROW COUNT** (how many of `r1`/`r2`/`r3` the split produced). The bands
   are the rows' ink-band centers, assigned top to bottom in reading order; a three-row beat needs
   tighter bands, so its rows START further down their ladder (skip the first 7 columns → TOP begins
   at f 112, BOTTOM at f 115) to keep the stretched ink from colliding:

   | rows | ids | band centers (top → bottom) | ladder start |
   | 1 | r2 | 360 | column 1 |
   | 2 | r1+r2 or r2+r3 | 181 · 537 | column 1 |
   | 3 | r1+r2+r3 | 140 · 360 · 580 | column 8 |

   The BOTTOM descender rule below still applies to `r2`: its start is the LATER of the row-count
   start and the descender start (on a three-row beat the descender start is already subsumed).

1. C = character count of the row's units (unit chars + 1 per gap). Pick `f` from the row's ladder
   (first column at or after the start whose maxC ≥ C):

   TOP (scaleY 2.27):
   | f | 161 | 153 | 145 | 138 | 131 | 125 | 118 | 112 | 107 | 101 | 96 | 92 | 87 | 83 | 79 | 75 | 71 | 67 | 64 | 61 | 58 | 55 | 52 | 49 | 47 | 45 | 42 | 40 | 38 | 36 |
   | maxC | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 25 | 26 | 27 | 29 | 30 | 32 | 33 | 35 | 37 | 39 | 41 | 43 | 46 | 48 | 51 | 53 | 56 | 60 | 63 | 66 | ∞ |

   BOTTOM (scaleY 2.17; a descender glyph `Q J , ;` in the unit → start the ladder at 148):
   | f | 164 | 156 | 148 | 141 | 134 | 127 | 121 | 115 | 109 | 103 | 98 | 93 | 89 | 84 | 80 | 76 | 72 | 69 | 65 | 62 | 59 | 56 | 53 | 50 | 48 | 45 | 43 | 41 | 39 | 37 |
   | maxC | 14 | 15 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 24 | 25 | 26 | 28 | 29 | 31 | 32 | 34 | 36 | 38 | 40 | 42 | 44 | 47 | 49 | 52 | 55 | 57 | 60 | ∞ |

   HEADLINE (scaleY 1.56):
   | f | 206 | 196 | 186 | 177 | 168 | 159 | 151 | 144 | 137 | 130 | 123 | 117 | 111 | 106 | 100 | 95 | 91 | 86 | 82 | 78 | 74 | 70 | 67 | 63 | 60 | 57 | 54 | 52 | 49 | 47 |
   | maxC | 11 | 12 | 12 | 13 | 14 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 27 | 28 | 30 | 31 | 33 | 35 | 37 | 39 | 41 | 43 | 45 | 48 | ∞ |

   COUNTER line (Baloo, no transform):
   | f | 58 | 52 | 47 | 42 | 38 | 34 | 31 | 28 | 25 | 23 | 21 |
   | maxC | 39 | 43 | 48 | 53 | 59 | 66 | 73 | 80 | 90 | 98 | ∞ |

2. Exact-fit floor: Σadv = the row's summed per-character advances (em, tables below; unknown char →
   0.55 Anton / 0.60 Baloo). Amin = Σadv + 0.18·(units−1) (Anton rows) or Σadv + 0.25·(units−1)
   (counter). If the table's `f` > B/Amin, step DOWN the same ladder to the first f ≤ B/Amin.
3. Justify the slack so the row FILLS B, slackEm = B/f − Σadv:
   - multi-unit Anton row → gapPx = clamp(slackEm/(units−1), 0.18, 2.6)·f on every span but the last;
   - solo Anton unit (≥2 chars) → lsPx = clamp(slackEm/chars, 0, 2.6)·f as the div's letter-spacing,
     plus `position:relative;left:{lsPx/2}px` (letter-spacing trails the last glyph too — the left
     re-centers by half of it);
   - the MAX clamps are deliberately generous: EVERY row spans the container width, so a two-letter
     word stretches exactly as wide as the long row above it. That stretch IS the poster idiom, not
     an overflow risk — the slack is computed to FILL B, never to exceed it;
   - counter line → fixed gapPx = 0.25·f, no justification (the prefab's `from` is not full-width).
4. Row tops from the row's band (step 0; ink extents off the calibration render): TOP rows (`r1`,
   `r3`) T = band − 0.4865·f · ACCENT row (`r2`) T = band − 0.4915·f · headline TH = 298 − 0.522·f ·
   counter TC = 81 − 0.5925·f (round to int).

Anton 400 advances (em/char, engine calibration render, letter-spacing 0):
A .484 B .475 C .473 D .489 E .409 F .396 G .483 H .495 I .224 J .464 K .470 L .395 M .741 N .494
O .484 P .469 Q .491 R .474 S .459 T .395 U .471 V .469 W .710 X .484 Y .446 Z .409 · 0 .493 1 .329
2 .493 3 .491 4 .494 5 .493 6 .493 7 .490 8 .493 9 .493 · ' .211 ? .490 ! .226 £ .471 , .234 . .226
- .309 & .518 % 1.055 $ .460 + .354 : .239 ; .243 " .426

Baloo 2 700 advances (the counter line is typed lowercase):
a .529 b .574 c .469 d .571 e .538 f .411 g .553 h .570 i .266 j .273 k .534 l .269 m .833 n .568
o .574 p .570 q .571 r .391 s .476 t .380 u .568 v .538 w .774 x .510 y .541 z .474 · 0 .595 1 .384
2 .514 3 .516 4 .606 5 .518 6 .551 7 .498 8 .558 9 .553 · ' .198 ? .486 ! .279 - .358 , .224 . .218

**Worked example** (landscape-main fixture, beat 2 of 14 — `And I had to pay £55 to buy one`,
cueDelayMs 1720, next beat 4600 → winMs 2880, gateEnd 4600): units = AND I HAD TO PAY £55 TO BUY ONE;
accent = £55 (digit, unit 6 of 9) → the split gives THREE rows, bands 140 · 360 · 580, ladders
started at column 8 (TOP 112 / BOTTOM 115).

- `r1` AND I HAD TO PAY: C = 16 → f 112; Σadv 5.437em; slackEm = 1088/112 − 5.437 = 4.277 → gap =
  4.277/4 = 1.069em → gapPx 119.76; T = 140 − 0.4865·112 = 85.51 → 86.
- `r2` £55: C 3, no descender → f 115; Σadv 1.457; slackEm = 1088/115 − 1.457 = 8.004 → ls =
  8.004/3 = 2.668 → clamp 2.6 → lsPx = 2.6·115 = 299, left 149.5; T = 360 − 0.4915·115 = 303.48 → 303.
- `r3` TO BUY ONE: C = 10 → f 112; Σadv 3.658em; slackEm = 9.714 − 3.658 = 6.056 → gap = 3.028 →
  clamp 2.6 → gapPx 291.2; T = 580 − 0.4865·112 = 525.51 → 526.

All pops = 100ms (every avail > 180). Peak beat 14 (`opens up into an entire gaming station. Where
are you?`, cueDelayMs 31920, durEnd 37531 → winMs 5611): accent = STATION (7 chars, longest); counter
= `opens up into an entire gaming where are you?` C 45 → Baloo f 47, gapPx 11.75, TC = 53; headline
STATION → f 206, Σadv 2.935, slackEm = 1088/206 − 2.935 = 2.347 → ls = 2.347/7 = 0.335em → lsPx
69.06, left 34.53, TH = 190; credits delay = min(33680 + 750, 37531 − 700) = 34430.

## 4. WORDS + TIMING

- Delays are absolute on the single timeline — paste as-is from `runs/<key>/word-timings.json`,
  never re-zero, never invent.
- Each beat's `.cue` gets inline `z-index:{10+N};animation-delay:{cueDelayMs}ms;
  animation-duration:{winMs}ms`. The cue window IS the lifetime bound: every poster dies exactly when
  the next beat's poster starts (the last runs to video end), so consecutive posters never coexist.
- Per word compute once: gateEnd = cueDelayMs + winMs; avail = gateEnd − delayMs.
- STANDARD word (`.w`): `animation-duration = min(100, max(40, avail − 40))` — the prefab's hard
  ~100ms pop, compressed when the gate is about to close.
- PEAK counter word (`.wc`): `min(350, max(150, avail − 80))`. PEAK headline (`.wh`):
  `min(400, max(250, avail − 80))`.
- CREDITS: `crDelayMs = max(cueDelayMs, min(headlineDelayMs + 750, durEndMs − 700))` (prefab: the
  block lands 750ms after the headline word), fixed 600ms fade, then holds — the gate cuts it at
  video end.
- Word gaps are the computed `margin-right` px — inter-span whitespace is not what sets the gap here, the
  margins ARE the gaps. Write spans adjacent with no whitespace between them. A glued `-` token keeps
  its OWN span and delay, placed immediately after its partner span with the partner's
  `margin-right:0` inline, so the pair renders joined.
- Words accumulate — every word HOLDS at full opacity until the cue gate cuts the beat. No fade-outs
  anywhere.

## 5. EMPHASIS

The counter-accent IS the layout (section 3's accent split): the accent unit renders alone at
monumental scale in its own row — standard beats keep it in its READING position, with the words
said before it above and the words after it below; the peak beat makes it the letter-spaced headline
— while the rest of the sentence runs in the neighbouring rows. Pick rule, no judgment: digit-bearing unit first
(the first if several), else most characters (punctuation counted), tie → the LATER unit. Exactly one
accent per beat; nothing else is styled differently.

## 6. VERIFY LOOP

Run from the repo root `{repo}` (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Exit 1 → apply the mechanical fix for the named element, re-run; at most 2 fix
cycles:

- `FAIL[bounds] #b{N}r1 / #b{N}r2 / #b{N}r3 / #b{N}h / #b{N}c …` → refit THAT row with the next
  ladder step down AND its width budget shrunk ×0.96 (recompute f, gap/ls, top from sections 3) —
  its band and the sibling rows are untouched; fails again → one step more.
- `FAIL[never-visible]` → check, in order: (1) the cue has all three inline values
  (`z-index:{10+N}`, delay, duration); (2) each span's class is `w`/`wc`/`wh` and its `delayMs`
  belongs to THIS beat; (3) the `<video>` is the first body element with `style="z-index:0"`;
  (4) no row uses a giant font + scaleX squeeze (pre-transform layout overflow reads as clipped);
  (5) no unclosed `</div>`.
- `FAIL[occluded] #b{N}…` → two windows overlap: confirm each `{winMs}` equals the NEXT beat's
  `cueDelayMs` minus this beat's, cues appear in DOM in beat order, inline z-index is `10+N`.
- Exit 2 → engine render failure: re-diff against the SKELETON block; the divergence is the bug.

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --progress-output --record {repo}/runs/<key>/final/out.silent.mp4
```

Manifest line (already given in section 2): `{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}` — W/H/FPS/DUR from `meta.json`.

## 7. DO NOT

- No fonts, colors, shadows, sizes, or keyframes beyond this sheet — Anton 400 + Baloo 2 700 +
  Hanken Grotesk 700, the two reds (`#f50200` type, `#e8121a` credits), the three shadow halos,
  `cueWin`/`popIn`/`wordIn`/`fadeIn` and the four ladders are the whole system.
- Never build a row as a giant font squeezed by scaleX (the prefab's own construction) — the layout
  box must fit the canvas and the stretch live in the static scaleY; never animate any transform on
  `.bigline`/`.from`/`.cr`.
- Never change or transcript-derive the credits text (`WRITTEN, FILMED… / FOR THIS VERY FEED… /
  MADE ON THE INTERNET` is final dressing) and never put a spoken word into it; it appears on the
  LAST beat only.
- The `.w`/`.wc`/`.wh` vertical padding and the `line-height:1` `.col` are calibrated as a pair —
  the tops formulas assume BOTH; never change one without the other.
- No invented timing: every `delayMs`/`cueDelayMs` comes verbatim from `word-timings.json`; derived
  numbers ONLY via the closed forms in sections 3-4. Words never fade out; the gate cuts the beat.
- Uppercase the Anton rows yourself; the peak counter line is typed lowercase.
- No descendant selectors, no animated `filter:blur`, no flex around animated shrink-to-fit lines
  beyond the skeleton's full-width `.col`s.
- Never read the video frames; never re-derive layout; no redesign after a render or verify failure —
  only the mechanical fixes in section 6.
