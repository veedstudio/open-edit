# RECIPE — hook-224-peak (9:16 · 736×1312 @ 25fps)

RESOLUTION: px are authored at the 9:16 reference canvas 736×1312. FIRST STEP: SCALE = W/736 from
`meta.json` (require |H − 1312·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE and round (positions, sizes, fonts, px spacing/shadows/margins/tops);
`em` values and ms timings never scale; the manifest carries the run's real W/H.
<!-- v2: dark grounding layer added to the glow shadow (v1's pure-white glow vanished on light
     footage — white mug, invisible to --verify); end-of-beat ignite compression (a word spoken
     <550ms before the gate closes was caught mid-flicker, never fully lit); '-' token glue rule. -->

Prefab is 720×1280; every px below is ALREADY rescaled ×1.022 — copy numbers as written, never rescale again.

## 1. IDENTITY

A neon-filament caption lockup in the lower-middle band: white glowing Schibsted Grotesk text on the footage — a small
semibold kicker line, a monumental extra-bold hero word whose characters strike on one by one like bulb
filaments (opacity gutters, then holds lit), and a centered bold closer line — every word/char flickering
alive on its own real timing inside a soft layered white glow.

## 2. SKELETON

Paste this whole document as `runs/<key>/final/template.wv`, then insert one `.cue` block per beat
(section 3) after the `<video>`. Replace only `{W} {H} {FPS} {DUR}` from `meta.json` (expect 736 / 1312 /
25) and `{videoPath}`. NOTE: the prefab's `ignite` animated `filter: drop-shadow`; the one animated
`filter` this engine was measured on, `blur`, holds its initial value and never ramps, and animated
`drop-shadow` was never probed, so this sheet's `ignite` is opacity-ONLY and the glow lives entirely in
the static `.txt` text-shadow (engine-safe under fades). Do not re-add any `filter`.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@600;700;800;900&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: {W}px; height: {H}px; background: #101010; overflow: hidden; position: relative;
         font-family: 'Schibsted Grotesk', 'Helvetica Neue', Arial, sans-serif; }
  .vid { position: absolute; inset: 0; width: {W}px; height: {H}px; object-fit: cover; }

  /* beat gate — the one safe reveal recipe; delay+duration + z-index come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position: absolute; left: 79px; top: 683px; width: 574px;
         display: flex; flex-direction: column; align-items: flex-start;
         opacity: 0; animation-name: cueWin; animation-timing-function: linear;
         animation-fill-mode: forwards; }

  /* shared glow text — the 3 white layers are the prefab's neon, copied verbatim; the 4th dark
     layer is GROUNDING so white type survives light footage (white-on-white is invisible to
     --verify). Never edit or drop any layer. */
  .txt { color: #fbf9f7; line-height: 1.2; letter-spacing: -0.01em; white-space: nowrap;
         text-shadow: 0 0 3px rgba(255,255,255,0.9), 0 0 7px rgba(255,255,255,0.55),
                      0 0 16px rgba(255,255,255,0.3), 0 2px 14px rgba(0,0,0,0.65); }
  .line1 { font-weight: 600; font-size: 32px; margin-left: 7px; margin-top: 12px; line-height: 0.93; }
  .line2 { font-weight: 800; font-size: 121px; letter-spacing: -0.03em; margin-top: -12px; }
  .line3 { align-self: center; text-align: center; font-weight: 700; font-size: 50px; margin-top: 20px; line-height: 0.93; }
  /* BOUNDED VARIETY — arrangement axis, value B: centers the hero alongside the closer (section 6) */
  .arrB { align-self: center; text-align: center; }

  /* size-down rows (pick by char count — see sizing tables; never invent other sizes) */
  .h101 { font-size: 101px; }  .h85 { font-size: 85px; }  .h68 { font-size: 68px; }  .h58 { font-size: 58px; }
  .k26 { font-size: 26px; }
  .t39 { font-size: 39px; }  .t31 { font-size: 31px; }  .t25 { font-size: 25px; }

  /* filament strike-on: opacity gutters then holds lit. OPACITY ONLY — no filter, because an
     animated blur holds its initial value here and an animated drop-shadow was never measured. */
  @keyframes ignite { 0%{opacity:0} 10%{opacity:.9} 20%{opacity:.08} 34%{opacity:.7}
                      46%{opacity:.2} 62%{opacity:1} 100%{opacity:1} }
  .w  { display: inline-block; opacity: 0; margin-right: 0.28em; padding: 0.1em 0 0.15em 0;
        animation: ignite .55s linear both; }
  .ch { display: inline-block; opacity: 0; animation: ignite .55s linear both; }
</style>
</head>
<body>
  <video class="vid" style="z-index:0" src="{videoPath}" muted></video>
  <!-- one .cue block per beat goes here, in beat order -->
</body>
</html>
```

Placement is FIXED for every beat: `left:79px; top:683px; width:574px` (inside the 9:16 safe margins:
top ≥11% = 145px, left ≥6% = 45px, right edge 79+574 = 653 ≤ 655, and the tallest possible stack —
section 3 — bottoms out at ~1028px, under the 17% bottom line at 1089px; the 16px glow blur is shadow,
not glyph ink, and is budgeted in that slack). Do not move it per beat.

## 3. PER-BEAT ASSEMBLY

One `.cue` per beat `{N}` of `word-timings.json`. Each beat is ONE lockup: line1 (words before the hero),
line2 (the hero word, per-char), line3 (words after the hero). Omit any line with no words — never emit an
empty div.

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N}; animation-delay:{cueDelayMs}ms; animation-duration:{cueDurMs}ms">
  <div class="txt line1" id="b{N}l1r1" data-node-id="b{N}l1r1" data-node-role="text">
    <span class="w" style="animation-delay:{delayMs}ms">{word}</span><!-- one .w per word -->
  </div>
  <!-- optional 2nd row id="b{N}l1r2" (same classes) when the split rule below produces one -->
  <div class="txt line2 {H-SIZE}{ARR}" id="b{N}l2" data-node-id="b{N}l2" data-node-role="text">
    <span class="ch" style="animation-delay:{chDelayMs}ms">{char}</span><!-- one .ch per hero char -->
  </div>
  <div class="txt line3 {T-SIZE}" id="b{N}l3r1" data-node-id="b{N}l3r1" data-node-role="text">
    <span class="w" style="animation-delay:{delayMs}ms">{word}</span><!-- one .w per word -->
  </div>
  <!-- optional 2nd row id="b{N}l3r2" (same classes, same {T-SIZE}) -->
</div>
```

**Hero pick (deterministic — this also IS the emphasis rule, section 5):**
1. The first word of the beat containing a digit wins.
2. Otherwise the word with the most letters+digits (punctuation and hyphens don't count for the pick).
3. Tie → the LATER word.

**Word→line mapping (order preserved, every token used exactly once, case + punctuation VERBATIM):**
- GLUE first: a token starting with `-` (e.g. `-do` after `to`) merges with the previous word into
  ONE unit for counting and splitting (`to-do` = 5 chars); it renders as two adjacent spans — the
  previous span gets inline `margin-right:0` — each keeping its OWN verbatim `delayMs`.
- line1 = all units BEFORE the hero (omit if none) · line2 = the hero word alone · line3 = all
  units AFTER the hero (omit if none). A 1-word beat is line2 only.

**Side-line split (line1 and line3 independently):** char count C = rendered chars of all the line's words
(punctuation included) + 1 per gap. If C > 24, split into exactly 2 rows: walk the word boundaries and
break at the one whose first-row char count is closest to C/2 (tie → earlier boundary). Never 3 rows;
both rows keep the line's class and share one size class (the LONGER row decides).

**Sizing tables** (by the char count of the longest row/word, width budget 574px already baked in —
line2's per-char advance + tracking budget 0.64·fs; never invent other sizes):

| line2 (hero) chars | class | | line1 row chars | class | | line3 row chars | class |
|---|---|---|---|---|---|---|---|
| ≤ 7 | base (121px) | | ≤ 30 | base (32px) | | ≤ 19 | base (50px) |
| 8 | `h101` | | 31–37 | `k26` | | 20–24 | `t39` |
| 9–10 | `h85` | | | | | 25–30 | `t31` |
| 11–13 | `h68` | | | | | 31–37 | `t25` |
| 14–15 | `h58` | | | | | | |
| ≥ 16 | `h58` | | | | | | |

(Ladder recomputed from the sheet's own algebra — max chars at font-size fs = floor(574 / (0.64·fs)) —
after the 101px→121px (+20%) bump: 121→7, 101→8, 85→10, 68→13, 58→15, same open ≥16 acceptance as before.
The height budget is closed by construction: worst case 2 kicker rows + 121px hero + 2 closer rows
≈ 365px from top 683 → bottom ~1048 < 1089 — kicker/closer rows now carry line-height 0.93 (not 1.2) plus
`.w`'s small vertical padding (shear-safety headroom, section 6); the two roughly offset, so treat ≈345px
as still the working figure and let `--verify`'s bounds check on `#b{N}l1…`/`#b{N}l3…` be the ground truth
if a beat runs unusually dense. Nothing to compute per beat.)

**Worked example** (beat 1 of a sample run — `Okay,(31) everyone(410) posts(730) their(1090)
perfect(1270) little(1610) morning(1830) routine.(2130)`, cueDelayMs 31, cueDurMs 2680):
- hero = `everyone` (8 letters — longest). line1 = `Okay,` (5 chars → base 32px).
- line2 = `everyone` (8 chars → `h101` 101px), 8 `.ch` spans written contiguous (no whitespace between
  them), delays 410, 470, 530, 590, 650, 710, 770, 830 (K = 60, section 4).
- line3 = `posts their perfect little morning routine.` (C = 43 > 24 → split; boundary closest to 21.5 is
  after `perfect` at 19) → r1 `posts their perfect` (19) · r2 `little morning routine.` (23) → longest 23
  → `t39` on both rows. Word delays 730/1090/1270 and 1610/1830/2130 verbatim.

## 4. WORDS + TIMING

- The beat's `.cue` gets inline `z-index:{10+N}; animation-delay:{cueDelayMs}ms;
  animation-duration:{cueDurMs}ms` — both values from that beat in `word-timings.json`, VERBATIM (delays
  are absolute on the single timeline; the cue window bounds every element's lifetime, so consecutive
  beats never coexist at the shared anchor).
- **line1 / line3**: one `<span class="w">` per token, text VERBATIM (keep case, punctuation, leading
  hyphens like `-do`). Each span's `animation-delay` = that word's `delayMs`, VERBATIM, never recomputed.
  Word gaps are the `.w { margin-right: 0.28em }` — inter-span whitespace is not what sets the gap here, the
  margin IS the space. Spans stay `display:inline-block`; never `display:block`.
- **line2 (hero, per-char)**: split the hero word into single characters IN ORDER (punctuation is a char;
  the hero is one word, so no spaces). One `<span class="ch">` per char, written CONTIGUOUS in the markup
  — zero whitespace/newlines between adjacent `.ch` spans (unlike `.w`, inter-span whitespace here is NOT
  reliably dropped by the engine and renders as a visible letter gap — this is the actual source of wide
  tracking, not `letter-spacing` alone) — and no margins between them. Char
  delays derive from the hero word's `delayMs` (VERBATIM base — never adjusted) plus a fixed stagger:
  `chDelayMs = heroDelayMs + i × K` with i = 0-based char index and **K = 60**.
  ONE guard, computed once per beat: if `heroDelayMs + (C−1)×60 + 550 > cueDelayMs + cueDurMs`
  (C = hero char count), use **K = 30** for that beat instead (keeps the last chars fully lit before the
  gate closes; if 30 still overruns, keep 30 — the mid-flicker cut is accepted).
- Char span example (hero `everyone`, delayMs 410, K 60):
  `<span class="ch" style="animation-delay:530ms">e</span>` (i = 2).
- END-OF-BEAT COMPRESSION (per span, mechanical): if a span's `delay + 550 > cueDelayMs + cueDurMs`,
  give it inline `animation-duration:{max(cueDelayMs + cueDurMs − delay, 250)}ms` — the flicker
  compresses so the word is FULLY LIT before the gate closes (an uncompressed late word is caught
  dim, mid-gutter). All other spans use the skeleton's `ignite .55s linear both` with only
  `animation-delay` inline — no other animation values exist.

## 5. EMPHASIS

The emphasis device is STRUCTURAL and already produced by the mapping: the hero word (digit → longest →
later, section 3) lands alone in line2 — the monumental 800-weight line with the per-char filament
cascade — flanked by the quiet 600 kicker and the 700 closer (the prefab's mixed-weight
`These are the Six / SFX Sounds / TikTok.`). Do NOT add any other emphasis: no color swaps, no extra
scale, no per-char treatment outside line2, no per-word styling beyond the classes in the skeleton.

## 6. BOUNDED VARIETY

**ARRANGEMENT** (per-beat, deterministic, alternating — the only variety axis this sheet declares):
- **A: flush-left stack** (default) — no extra class; line2 renders exactly per the section-2 skeleton
  (`align-items:flex-start` inherited from `.cue`, hero flush-left under the kicker).
- **B: staggered mixed-alignment** — add `arrB` to line2's class list (`{ARR} = " arrB"`; section 3's
  `{H-SIZE}{ARR}`), giving it `.arrB`'s `align-self:center; text-align:center` — the hero now centers
  like line3 already does, and because each of line2/line3 independently shrinks-to-fit and centers on
  the same axis, unequal word widths stagger their edges (line1 stays flush-left either way).
- **Pick**: `beat N odd → A, beat N even → B` (beat 1 = A, matching the default). Mechanical, no judgment.
- Pre-validated: centering a box narrower than the 574px `.cue` inside it can only sit within the same
  x-range flush-left already clears, so B never introduces a NEW bounds risk over A — same size ladder,
  same width budget, only `align-self`/`text-align` change (no `transform`, no descendant selector, no
  touch to fonts/palette/keyframes/timing).

## 7. VERIFY LOOP

Run (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Otherwise apply the MECHANICAL fix for the named element and re-run; at most 2 fix
cycles:
- `FAIL[bounds] … left/right outside` on `#b{N}l2` → move that hero one row DOWN the line2 ladder
  (base → `h101` → `h85` → `h68` → `h58`).
- `FAIL[bounds] … left/right outside` on a `#b{N}l1…` / `#b{N}l3…` row → move BOTH rows of that line one
  row down its ladder (line1: base → `k26`; line3: base → `t39` → `t31` → `t25`).
- `FAIL[bounds] … bottom outside` → move that beat's line2 one row down the ladder; if the same beat
  fails again, also move its line3 rows one row down.
- `FAIL[never-visible]` → that span's `animation-delay` is outside its beat's cue window: re-check the
  word/char was pasted into the RIGHT beat's `.cue` with its own `delayMs` (chars: the K formula), and
  that the `.cue` carries its inline `z-index:{10+N}`.
- `FAIL[occluded]` → two cue windows overlap: re-check each cue's `animation-delay`/`animation-duration`
  equal that beat's `cueDelayMs`/`cueDurMs` verbatim; if a cue's duration exceeds the next beat's
  `cueDelayMs` minus its own, trim it to that difference.

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --record {repo}/runs/<key>/final/out.silent.mp4
```

`manifest.json`, verbatim shape:

```json
{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}
```

## 8. DO NOT

- No fonts, colors, shadows, sizes, or keyframes beyond this sheet — Schibsted Grotesk, `#fbf9f7` on `#101010`, the
  four-layer text-shadow (3 white glow layers + 1 dark grounding layer, copied verbatim, never edited
  or brightened) and the size ladders are the whole system.
- No `filter` anywhere — the prefab's animated `drop-shadow` is REMOVED on purpose (animated `blur` is
  measured to hold its initial value, animated `drop-shadow` is unmeasured); do not restore it, do not
  animate `text-shadow`.
- No invented timing: every `animation-delay` is a `word-timings.json` `delayMs` verbatim, or
  `heroDelayMs + i×K` with K from section 4; cue delay/duration verbatim from the beat.
- No uppercasing, no reordering, no dropping tokens — words render exactly as transcribed.
- No reading frames, no ffmpeg, no visual checks — `--verify` is the only self-check.
- No descendant selectors (`.line2 .ch`) — flat classes only, exactly as in the skeleton; spans stay
  `display:inline-block`.
- No redesign after render; fix only elements `--verify` names, only by the mechanical rules in section 7.
