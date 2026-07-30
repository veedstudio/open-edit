# RECIPE — hook-126 Comp 1-peak (16:9 · 1280×720 @ 24fps)

RESOLUTION: px are authored at the 16:9 reference canvas 1280×720. FIRST STEP: SCALE = W/1280 from
`meta.json` (require |H − 720·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE (positions, side offsets, font sizes) — authored integers round,
DERIVED tops stay fractional (never force-round a computed top); `em` values (the whole text-shadow,
the gap, the rise) and ms timings never scale; the manifest carries the run's real W/H.

Prefab is 960×720 (same 720 height): font sizes and the vertical rhythm below are the prefab's own;
the horizontal composition is RE-COMPOSED for the wide 1280 frame as side-edge offsets pushed OUT
against the frame edge (the prefab's scatter hugs its right edge, which leaves no width headroom for
real words at 1280) — copy numbers as written, never rescale against the prefab.

## 1. IDENTITY

An editorial serif word-scatter over full-bleed footage, pushed OUT against one frame edge: each
spoken word rises ~0.28em and fades in at its own absolute spot, the words interlocking into a loose
descending staircase hugging the frame's LEFT edge (odd beats) or its RIGHT edge (even beats), the
outer edge ragged and the inward run hard-clamped so the centre band of the frame never carries ink —
the subject stays clear. Short beats (≤ 2 slots) take the tighter offsets and go right out to the
frame edge. Bright yellow Lora serif in the prefab's mixed sizes (one oversized opening line, smaller
followers), verbatim lowercase-heavy case, the ink fattened by an 8-way same-ink text-shadow at full
strength over two dark layers pulled well back — they ground the ink over light footage, they are not
a second darker typeface. The beat's closing word SAGS in when it stands alone — the bottom corner
sitting ON that beat's own anchored edge is pinned to the line (bottom-LEFT while the scatter hugs the
left edge, bottom-RIGHT while it hugs the right), the word lands level, and then the FREE end — always
the one pointing INTO the frame — drops into that beat's own angle with an overshoot settle. Because
the side alternates, so does the pinned corner: two consecutive beats never fall from the same one.
The fall is ALWAYS downward whichever corner is pinned, and deep enough to read (10–20°, varying beat
to beat); a word that cannot afford its angle takes a smaller one, never a smaller safe area. Words
accumulate and the beat gate cuts the stack.

## 2. SKELETON

Paste this whole document as `runs/<key>/final/template.wv`, then add one `.cue` block per beat
(section 3) after the `<video>` element. Replace only `{videoPath}` (from `meta.json`) and `{DUR}`
(`durationSec` from `meta.json`, manifest only). Canvas: see RESOLUTION at the top of this sheet.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1280px; height: 720px; }
  body { background: #0e060b; overflow: hidden; position: relative;
         font-family: "Lora", Georgia, "Times New Roman", serif; }
  .vid { position: absolute; inset: 0; width: 1280px; height: 720px; object-fit: cover; }

  /* window gate — the one safe reveal recipe; delay+duration+z come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position: absolute; inset: 0; opacity: 0; z-index: 11;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* a slot = one absolutely positioned nowrap line of the scatter; side offset / top / font-size
     come inline per slot. line-height 1.35 is the prefab's own AND the shear headroom — never
     tighten it. The yellow ink is fattened by an 8-way same-ink text-shadow (the engine has no text
     stroke) — that is what carries the letterforms' weight, so it stays at full strength. The two dark
     layers under it only GROUND the ink over light footage and are pulled well back: tight offset,
     small blur, low alpha, so they read as contact, not as a second darker typeface. em units, so the
     whole shadow scales with the type and never with the canvas. */
  .ln { position: absolute; white-space: nowrap; line-height: 1.35; font-weight: 400;
        color: #ffd400;
        text-shadow: 0.012em 0 0 #ffd400, -0.012em 0 0 #ffd400,
                     0 0.012em 0 #ffd400, 0 -0.012em 0 #ffd400,
                     0.0085em 0.0085em 0 #ffd400, -0.0085em 0.0085em 0 #ffd400,
                     0.0085em -0.0085em 0 #ffd400, -0.0085em -0.0085em 0 #ffd400,
                     0 0.018em 0.05em rgba(0,0,0,0.24), 0 0 0.14em rgba(0,0,0,0.18); }

  /* word span — the ANIMATED unit (the prefab reveals word by word); .wg is the inter-unit gap. */
  .w  { display: inline-block; opacity: 0; animation-name: wIn;
        animation-timing-function: cubic-bezier(.2,.7,.3,1); animation-fill-mode: both; }
  .wg { margin-right: 0.3em; }
  @keyframes wIn { 0% { opacity: 0; transform: translateY(0.28em); }
                   100% { opacity: 1; transform: none; } }

  /* the SAG — the beat's closing lone word, in the two mirrored families. .sagL* pins the word's
     bottom-LEFT corner (transform-origin 0 100%) and rotates POSITIVE, dropping the free right end;
     .sagR* pins the bottom-RIGHT corner (100% 100%) and rotates NEGATIVE, dropping the free left end.
     A beat takes the family matching its anchored edge, which alternates every beat, so the word never
     falls from the same corner twice running — and the sign always follows the corner, so the free end
     goes DOWN either way and never rises. Both land LEVEL at 28%, overshoot at 72% and settle.
     One keyframes per angle per corner, rotation composed INSIDE the keyframe on the animating span
     itself — never a static transform on an ancestor of animating children. */
  .sagL1 { transform-origin: 0 100%; animation-name: wSagL1;
           animation-timing-function: cubic-bezier(.4,0,.25,1); }
  .sagL2 { transform-origin: 0 100%; animation-name: wSagL2;
           animation-timing-function: cubic-bezier(.4,0,.25,1); }
  .sagL3 { transform-origin: 0 100%; animation-name: wSagL3;
           animation-timing-function: cubic-bezier(.4,0,.25,1); }
  .sagL4 { transform-origin: 0 100%; animation-name: wSagL4;
           animation-timing-function: cubic-bezier(.4,0,.25,1); }
  .sagL5 { transform-origin: 0 100%; animation-name: wSagL5;
           animation-timing-function: cubic-bezier(.4,0,.25,1); }
  .sagL6 { transform-origin: 0 100%; animation-name: wSagL6;
           animation-timing-function: cubic-bezier(.4,0,.25,1); }
  .sagR1 { transform-origin: 100% 100%; animation-name: wSagR1;
           animation-timing-function: cubic-bezier(.4,0,.25,1); }
  .sagR2 { transform-origin: 100% 100%; animation-name: wSagR2;
           animation-timing-function: cubic-bezier(.4,0,.25,1); }
  .sagR3 { transform-origin: 100% 100%; animation-name: wSagR3;
           animation-timing-function: cubic-bezier(.4,0,.25,1); }
  .sagR4 { transform-origin: 100% 100%; animation-name: wSagR4;
           animation-timing-function: cubic-bezier(.4,0,.25,1); }
  .sagR5 { transform-origin: 100% 100%; animation-name: wSagR5;
           animation-timing-function: cubic-bezier(.4,0,.25,1); }
  .sagR6 { transform-origin: 100% 100%; animation-name: wSagR6;
           animation-timing-function: cubic-bezier(.4,0,.25,1); }
  @keyframes wSagL1 { 0% { opacity: 0; transform: rotate(0deg) translateY(0.28em); }
                       28% { opacity: 1; transform: rotate(0deg); }
                       72% { opacity: 1; transform: rotate(18.4deg); }
                       100% { opacity: 1; transform: rotate(16deg); } }
  @keyframes wSagL2 { 0% { opacity: 0; transform: rotate(0deg) translateY(0.28em); }
                       28% { opacity: 1; transform: rotate(0deg); }
                       72% { opacity: 1; transform: rotate(11.5deg); }
                       100% { opacity: 1; transform: rotate(10deg); } }
  @keyframes wSagL3 { 0% { opacity: 0; transform: rotate(0deg) translateY(0.28em); }
                       28% { opacity: 1; transform: rotate(0deg); }
                       72% { opacity: 1; transform: rotate(23deg); }
                       100% { opacity: 1; transform: rotate(20deg); } }
  @keyframes wSagL4 { 0% { opacity: 0; transform: rotate(0deg) translateY(0.28em); }
                       28% { opacity: 1; transform: rotate(0deg); }
                       72% { opacity: 1; transform: rotate(13.8deg); }
                       100% { opacity: 1; transform: rotate(12deg); } }
  @keyframes wSagL5 { 0% { opacity: 0; transform: rotate(0deg) translateY(0.28em); }
                       28% { opacity: 1; transform: rotate(0deg); }
                       72% { opacity: 1; transform: rotate(20.7deg); }
                       100% { opacity: 1; transform: rotate(18deg); } }
  @keyframes wSagL6 { 0% { opacity: 0; transform: rotate(0deg) translateY(0.28em); }
                       28% { opacity: 1; transform: rotate(0deg); }
                       72% { opacity: 1; transform: rotate(16.1deg); }
                       100% { opacity: 1; transform: rotate(14deg); } }
  @keyframes wSagR1 { 0% { opacity: 0; transform: rotate(0deg) translateY(0.28em); }
                       28% { opacity: 1; transform: rotate(0deg); }
                       72% { opacity: 1; transform: rotate(-18.4deg); }
                       100% { opacity: 1; transform: rotate(-16deg); } }
  @keyframes wSagR2 { 0% { opacity: 0; transform: rotate(0deg) translateY(0.28em); }
                       28% { opacity: 1; transform: rotate(0deg); }
                       72% { opacity: 1; transform: rotate(-11.5deg); }
                       100% { opacity: 1; transform: rotate(-10deg); } }
  @keyframes wSagR3 { 0% { opacity: 0; transform: rotate(0deg) translateY(0.28em); }
                       28% { opacity: 1; transform: rotate(0deg); }
                       72% { opacity: 1; transform: rotate(-23deg); }
                       100% { opacity: 1; transform: rotate(-20deg); } }
  @keyframes wSagR4 { 0% { opacity: 0; transform: rotate(0deg) translateY(0.28em); }
                       28% { opacity: 1; transform: rotate(0deg); }
                       72% { opacity: 1; transform: rotate(-13.8deg); }
                       100% { opacity: 1; transform: rotate(-12deg); } }
  @keyframes wSagR5 { 0% { opacity: 0; transform: rotate(0deg) translateY(0.28em); }
                       28% { opacity: 1; transform: rotate(0deg); }
                       72% { opacity: 1; transform: rotate(-20.7deg); }
                       100% { opacity: 1; transform: rotate(-18deg); } }
  @keyframes wSagR6 { 0% { opacity: 0; transform: rotate(0deg) translateY(0.28em); }
                       28% { opacity: 1; transform: rotate(0deg); }
                       72% { opacity: 1; transform: rotate(-16.1deg); }
                       100% { opacity: 1; transform: rotate(-14deg); } }
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

One `.cue` per beat `{N}` of `word-timings.json`; inside it one `.ln` slot per packed line, in order.
A beat is ONE structure — slots accumulate word by word and the gate cuts the whole stack; there is
NO paging and nothing ever shares an anchor mid-beat.

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N};animation-delay:{cueDelayMs}ms;animation-duration:{winMs}ms">
  <div class="ln" id="b{N}s1" data-node-id="b{N}s1" data-node-role="text" style="{side}:{off_1}px;top:{top_1}px;font-size:{fs_1}px"><span class="w wg" style="animation-delay:{delayMs}ms;animation-duration:{inMs}ms">This&#160;</span><!-- …one span per word… --></div>
  <!-- more .ln slots: b{N}s2 … b{N}s5, each with ITS OWN off/top/fs -->
</div>
```

**Word prep:** keep every word's case and punctuation VERBATIM (the prefab's copy is lowercase serif —
never uppercase, never strip). GLUE: a token starting with `-` merges with the previous word into ONE
unit for packing/counting; its spans render adjacent with the gap zeroed, each keeping its own verbatim
`delayMs`. Char count of a rendered line = unit chars + 1 per inter-unit gap.

**Packing — greedy, deterministic, word order always preserved.** Walk the caps escalation table
`(maxChars, maxUnits)` = (12,3) → (16,4) → (20,4) → (26,5) → (34,6) and greedy-pack the beat's units
(a slot takes units while BOTH caps hold; an oversized first unit still gets a slot of its own); the
FIRST row whose pack yields ≤ 5 slots is the law. If even (34,6) exceeds 5 (does not happen for
spoken beats), all units form ONE slot and the width cap below absorbs it. L = slot count.

**Placement — the composition lives in the OUTER band, never across frame centre.** The beat's side
ALTERNATES: ODD beats anchor LEFT (every slot positioned `left:{off_k}px`), EVEN beats anchor RIGHT
(`right:{off_k}px`). The anchored side carries the ink's outer edge, so the offset family IS the
ragged edge of the scatter — two families, by slot count:

| L | off_1 | off_2 | off_3 | off_4 | off_5 |
|---|-------|-------|-------|-------|-------|
| ≥ 3 (the staircase) | 40 | 132 | 24 | 100 | 60 |
| ≤ 2 (short beat — right out to the edge) | 24 | 72 | — | — | — |

Tops: `top_1 = 48`; `top_{k+1} = top_k + 1.31·fs_k − 0.28·fs_{k+1}` (fractional stays fractional).
0.28 / 1.31 are Lora's measured ink band inside the 1.35 line box (baseline 1.041 em from box top,
tallest ink 0.765 em above it, descender 0.271 below): the pitch stacks slots ink-to-ink, safe for
ANY text — the prefab demo's tighter interlock only works because its exact words dodge each other
horizontally. Height is budgeted by construction: the tallest stack (all five bases at mult 1) has its
last slot at top 412.22 and bottoms out at 412.22 + 1.31·80 = 517.02 ≤ 676; every cap/demotion only
shrinks it.

**Sizing — per slot k (1-based), all at reference px.** Slot base sizes `B = [108, 76, 86, 76, 80]`
(the prefab's five words: an oversized opener, smaller followers). Calibration: Lora 400 measured off
the shipped TTF — lowercase mean 0.524 em/char, caps mean 0.668, digits 0.534, worst glyph `m` 0.894;
right ink overhang ≤ 0.056 em (`f`) — budget `ADV = 0.60` em per counted char (the 0.3em gap +
`&#160;` ≈ 0.56 em rides as its counted char).

- multiplier by slot char count `C_k` (the demotion ladder, largest first):

  | C ≤6 | 7–8 | 9–10 | 11–13 | 14–16 | 17–20 | ≥21 |
  |------|-----|------|-------|-------|-------|-----|
  | 1.00 | 0.86 | 0.74 | 0.64 | 0.55 | 0.47 | 0.40 |

- `availW_k = 560 − off_k` — the run from the anchored edge to the CENTRE KEEP-CLEAR band, with
  `off_k` from the placement table; `fs_k = min(round(mult_k · B_k), floor(availW_k / (C_k · 0.60)))`.
  The width term is a HARD clamp, applied AFTER the multiplier, and it FLOORS (rounding it up leaks a
  couple of px past the gutter): a line's ink is `C_k · 0.60 · fs_k ≤ availW_k`, so `off_k + W_k ≤
  560` for every slot and the 160px band across frame centre (x 560…720) never carries caption ink on
  either side. Never widen 560 to "fit more type" — the clear middle IS the composition; a long line
  loses size, not the gutter.

**Sagging closer — the prefab's `feeds`, animated.** The beat's LAST slot renders sagging (its spans
use `class="w sagL{n}"` or `class="w sagR{n}"`, everything else identical) iff BOTH: (a) it holds
exactly ONE unit of ONE span (the swing pivots each span individually — multi-span slots must stay
level), and (b) it clears the safe band. The beat's angle MAGNITUDE and its keyframes index come from
the ANGLE TABLE by `(N − 1) mod 6`; the FAMILY (and with it the pinned corner and the sign) comes from
the beat's anchored side — the same `N` parity that placed the slot:

  | (N−1) mod 6 | 0 | 1 | 2 | 3 | 4 | 5 |
  |-------------|---|---|---|---|---|---|
  | class, ODD beat (LEFT edge) | `sagL1` | `sagL2` | `sagL3` | `sagL4` | `sagL5` | `sagL6` |
  | class, EVEN beat (RIGHT edge) | `sagR1` | `sagR2` | `sagR3` | `sagR4` | `sagR5` | `sagR6` |
  | angle magnitude | 16° | 10° | 20° | 12° | 18° | 14° |
  | overshoot (1.15×, at 72%) | 18.4° | 11.5° | 23° | 13.8° | 20.7° | 16.1° |

  **The pinned corner is the one sitting ON the beat's own anchored edge**, never the inward one:
  `sagL*` pins bottom-LEFT (`transform-origin: 0 100%`) and rotates POSITIVE (`+16°`, `+10°`, …),
  `sagR*` pins bottom-RIGHT (`100% 100%`) and rotates NEGATIVE (`-16°`, `-10°`, …). The table stores a
  MAGNITUDE; the SIGN belongs to the corner, and it is what keeps the fall downward in both families —
  clockwise off a bottom-left pivot, counter-clockwise off a bottom-right one, and in each case the
  free end (the one pointing INTO the frame) drops. A rising word is a bug, never a variation: pair a
  corner with the wrong sign and the word lifts. Because the side alternates with `N`, so does the
  corner — the closer never falls from the same corner twice running. The magnitude varies beat to beat
  (10–20°, never the same magnitude twice running) — that variation is the whole licence for change;
  the direction is fixed. The overshoot is a RATIO of the magnitude and is tuned so the excursion past
  the resting angle stays ~1.5–3° at these amplitudes: it reads as a settle, not a wobble. Raising the
  angles again means lowering that ratio again.

  **Fit — the angle yields, the safe area never does.** Measure everything as `d`, the distance INWARD
  from THAT BEAT'S OWN anchored edge — that is what makes ONE test cover both families. Evaluate at the
  OVERSHOOT angle θ (the swing's extreme) with `W_L = C_L · 0.60 · fs_L`, the pivot at
  `d = off_L`, `y = top_L + 1.35·fs_L`, and the ink reaching `1.07·fs_L` above that pivot (1.35 line box
  − 0.28 ink top):

  - BOTTOM — the free end is the lowest ink either way: `top_L + 1.35·fs_L + W_L·sin θ ≤ 676`.
  - INWARD — the free end swings back toward the pivot to `d = off_L + W_L·cos θ` while the ink's far
    TOP corner swings a further `1.07·fs_L·sin θ` inward; the sum is the slot's deepest reach and must
    hold `off_L + W_L·cos θ + 1.07·fs_L·sin θ ≤ 560`. Not monotone in θ (it peaks at
    `tan θ = 1.07·fs_L/W_L`), so test EVERY candidate angle, not just the largest.
  - TOP and the anchored edge need no test — a downward rotation puts the topmost ink at
    `pivot − 1.07·fs_L·cos θ`, below where it started, and the outermost point is the pivot itself,
    which does not move.

  **Why one inequality is enough — and when it would NOT be.** On a LEFT-hugging beat the pivot is
  bottom-left at `d = off_L` and the free RIGHT end is the inward one, so the deepest ink runs toward
  x 560. On a RIGHT-hugging beat the pivot is bottom-right — again the corner ON the edge, again
  `d = off_L` — and the free LEFT end is the inward one, so in screen x the whole thing mirrors and the
  ink reaches back toward x 720. Re-derived in `d` the two terms are identical (the pivot's arm is
  still `W_L`, the top corner's excursion is still `1.07·fs_L·sin θ`), which is exactly why the SAME
  inequality guards the centre gutter from either side. It would NOT if only one of the pair flipped:
  pin the INWARD corner instead and the deepest reach collapses back to `off_L + W_L` (already
  guaranteed by the width clamp) while the risk moves onto the FRAME edge at
  `off_L + W_L − W_L·cos θ − 1.07·fs_L·sin θ` — a different bound entirely. That pairing is never
  emitted: corner and sign always flip together with the side.

  A slot that fails either bound STEPS DOWN the angle table to the next SMALLER magnitude (rendering
  that entry's class, in its own family) and re-tests, `20 > 18 > 16 > 14 > 12 > 10`; only if the 10°
  step also fails does the slot render level (plain `class="w"`). Never widen 676 or 560 to keep an
  angle — the angle is the thing that gives. Across the whole layout space (every L, every C ≤ 40,
  every demotion row) every candidate sags at its OWN magnitude — the step-down never fires — and the
  worst case reaches 663.91 of 676 and 559.07 of 560, so the ladder is pure guard. `--verify` measures
  ink PRE-transform, so this budget is the ONLY guard on the swing.

**Worked example — beats 1 and 4 of the landscape-main fixture:**
- Beat 1 (`This is a Philips Hue smart bulb.`, cueDelayMs 160, next beat 6640 → winMs 6480, gateEnd
  6640; ODD → LEFT): pack (12,3): `This is a` (4+2+1+2 = 9, 3 units) / `Philips Hue` (11) /
  `smart bulb.` (11) → L=3 → the staircase offsets. fs: s1 C9 → min(round 0.74·108, floor 520/5.4) =
  min(80, 96) → 80; s2 C11 → min(round 0.64·76, floor 428/6.6) = min(49, 64) → 49; s3 C11 →
  min(round 0.64·86, floor 536/6.6) = min(55, 81) → 55. Tops: 48; top2 = 48 + 1.31·80 − 0.28·49 = 139.08;
  top3 = 139.08 + 1.31·49 − 0.28·55 = 187.87. Offsets left 40 / 132 / 24. Slot 3 has 2 units →
  no sag. Every word's inMs = 420 (the gate is 6640, all avails ≥ 500).
- Beat 4 (`That made me pretty angry.`, cueDelayMs 6640, last beat → winMs 30891, gateEnd 37531;
  EVEN → RIGHT): pack: `That made me` (12, 3 units) / `pretty` (6) / `angry.` (6) → L=3. fs: s1 C12
  → min(69, floor 520/7.2 = 72) → 69; s2 C6 → min(76, floor 428/3.6 = 118) → 76; s3 C6 →
  min(86, floor 536/3.6 = 148) → 86.
  Tops: 48 / 117.11 / 192.59. Offsets right 40 / 132 / 24. Slot 3 = one lone span and beat 4 →
  magnitude `(4−1) mod 6 = 3` → 12° (overshoot 13.8°); beat 4 is EVEN, so the family is the RIGHT one —
  `sagR4`, pinned bottom-RIGHT, rotating −12° (peak −13.8°) so the free LEFT end drops. W = 6·0.60·86 =
  309.6, measured inward from the right edge: bottom 192.59 + 116.1 + 309.6·sin(13.8°) = 382.5 ≤ 676,
  inward 24 + 309.6·cos(13.8°) + 1.07·86·sin(13.8°) = 346.6 ≤ 560 → both hold at its own magnitude, no
  step-down → `angry.` falls in (`w sagR4`), sagMs 620. Every other word's inMs = 420.
  (Beat 1 is ODD, so had ITS closer stood alone it would have taken the mirrored `sagL1` instead.)

## 4. WORDS + TIMING

- Delays are absolute on the single timeline — paste as-is from `runs/<key>/word-timings.json`,
  never re-zero, never invent.
- Each beat's `.cue` gets inline `animation-delay:{cueDelayMs}ms;animation-duration:{winMs}ms` plus
  `z-index:{10+N}`; `{winMs}` = the NEXT beat's `cueDelayMs` − this beat's (last beat:
  round(`durationSec`·1000) − its `cueDelayMs`) — the stack holds through pauses and the gate cuts it.
- One span per word: `animation-delay:{delayMs}ms` VERBATIM, `animation-duration:{inMs}ms` with
  `inMs = min(420, max(120, gateEnd − delayMs − 80))`, gateEnd = cueDelayMs + winMs (the 420 is the
  prefab's own entrance; the compression lands a late word before the gate). A word spoken < 200ms
  before the gate cannot fully land — report it, never retime.
- A SAGGING span takes the LONGER window `sagMs = min(620, max(200, gateEnd − delayMs − 80))` instead
  — the fall has to be watchable, and the keyframe spends only its last 72% on rotation. Same 80ms
  gate margin, so it still lands. Never shape the fall with the easing alone: under a front-loaded
  ease the rotation is over before the word is opaque and the tilt reads as static — the LEVEL stop at
  28% is what makes it a sag. Amplitude does the rest: below ~10° the drop reads as a crooked baseline
  rather than a fall.
- Word gaps: each unit's last span (except the slot-final unit's) takes `.wg` (`margin-right:0.3em`)
  PLUS a trailing `&#160;` in its span text — serif ink overhangs its advance and the engine trims
  bare trailing spaces. Glued spans inside a unit get neither. Spans stay `display:inline-block`.
- Words accumulate — a landed word HOLDS until the cue gate cuts the beat. No fade-outs anywhere;
  no mid-beat turn-taking exists (every slot has its own anchor), so nothing ever double-prints.

## 5. EMPHASIS

The emphasis is POSITIONAL — the prefab's own devices, picked with no judgment: the beat's opening
slot carries the oversized 108 base (the `bite` register) and the beat's closing lone word falls in at
that beat's own downward angle, off the corner sitting on that beat's anchored edge (the `feeds`
register, gated by the section-3 fit rule). No accent
color, no weight change, no per-beat word pick — never introduce one.

## 6. VERIFY LOOP

Run (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Otherwise apply the mechanical fix for the flagged element and re-run; at most 2
fix cycles:
- `FAIL[bounds] #b{N}s{k} … left/right outside` → that slot's multiplier one column RIGHT in the
  section-3 table (fs and every later top recompute by the closed forms).
- `FAIL[bounds] … top/bottom outside` → an arithmetic slip, not a design problem: re-check that
  beat's tops against the section-3 pitch form for its ACTUAL fs values (the stack is ≤ 517.02 by
  construction); never move `top_1`.
- `FAIL[never-visible]` → check that cue's inline `animation-delay`/`animation-duration` match
  section 4, the `<video>` is the first body element with `style="z-index:0"`, and every span's
  class list is exactly `w` / `w wg` / `w sagL{n}` / `w sagR{n}` (a typo'd class never animates in —
  opacity stays 0), with the sag family matching the beat's anchored side; a word spoken < 200ms
  before the gate is the reported-not-fixed case of section 4.
- `FAIL[occluded] #b{N}…` → cue windows overlap: each `{winMs}` must equal the next beat's
  `cueDelayMs` minus this beat's; confirm inline z-index is 10+N in beat order.

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --progress-output --record {repo}/runs/<key>/final/out.silent.mp4
```

Manifest line (already given in section 2): `{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}` — W/H/FPS/DUR from `meta.json`.

## 7. DO NOT

- No fonts, colors, shadows, sizes, or keyframes beyond this sheet — Lora 400, the one yellow ink
  `#ffd400`, the one 8-way-at-full-strength-plus-two-pulled-back-dark-layers text-shadow,
  `cueWin`/`wIn`/`wSagL1…6`/`wSagR1…6`, the five slot bases, the two offset families and the
  multiplier table are the whole system. Never darken or thicken the two grounding layers back up —
  they are contact shadow, not a second typeface.
- The footage is full-bleed and always visible — never add an opaque stage, never render the
  prefab's flat `#0e060b` demo card above the video.
- Never let a slot cross the centre keep-clear band: `off_k + W_k ≤ 560` is the composition, not a
  safety margin. Never move the offsets or `top_1`; tops ONLY via the section-3 pitch form; sizes
  ONLY via the multiplier table + the 560 clamp; the sag ONLY when the section-3 gate passes.
- Never anchor two consecutive beats to the same side — the side is `N`'s parity, nothing else — and
  never break the corner from the side: the sag pivots on the corner ON that beat's anchored edge,
  so consecutive beats fall from opposite corners for free.
- The word span is the ONLY animated element; the sag rotation lives ONLY in `wSagL{n}`/`wSagR{n}`'s
  keyframes on the span itself — never as a static `transform` on a slot div (a non-identity ancestor
  transform over animating children composites inconsistently), and never with `var()` anywhere.
  One magnitude per beat off the table — never one fixed angle for every beat, never a random one.
  Never mix the sign and the corner: `sagL*` is positive-only and `sagR*` is negative-only, because
  the sign belongs to the pivot. A `sagL*` with a negative angle (or a `sagR*` with a positive one)
  LIFTS the word and breaks the single device the closer exists to carry.
- Never keep an angle by moving a bound: a slot that misses 676 or 560 steps DOWN the angle table
  (section 3) and re-tests. The safe area is not a variable.
- Words keep verbatim case + punctuation — never uppercase, never strip, never reorder or drop
  tokens; never render the prefab's demo copy.
- `line-height:1.35` and `display:inline-block` spans are shear headroom — never tighten either;
  the word gap is `.wg` + trailing `&#160;` — never a bare margin, never an empty spacer span.
- Words accumulate and the gate cuts the beat — never add per-word or per-slot fade-outs, never
  page a beat (long beats shrink via the caps table and the multiplier ladder instead).
- No invented timing: every `delayMs`/`cueDelayMs` comes verbatim from `word-timings.json`; derived
  numbers ONLY via the closed forms in sections 3–4. No flex anywhere; no `text-align`; no `vw`
  sizes; single-value `border-radius` only (none is used here).
- Never read the video frames; never re-derive layout; no redesign after a render or verify
  failure — only the section-6 mechanical fixes.
