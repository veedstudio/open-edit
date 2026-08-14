# RECIPE — hook-215 Comp 1-peak (9:16 · 736×1312 @ 25fps)

RESOLUTION: px are authored at the 9:16 reference canvas 736×1312. FIRST STEP: SCALE = W/736 from
`meta.json` (require |H − 1312·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE and round (positions, sizes, fonts, px spacing/shadows/margins/tops);
`em` values and ms timings never scale; the manifest carries the run's real W/H.

Prefab is 720×1280; every px below is ALREADY rescaled ×1.022 — copy numbers as written, never rescale again.

## 1. IDENTITY

A clean-sans colour-story card: the footage plays inside a fixed window cut into a flat paper-cream
mat that hard-flips to royal blue, then signal red, at two narrative peaks; below the window, short
Bricolage-Grotesque-ExtraBold phrases (soft 1.5px blur edge) pop in one at a time at a single anchor — rise in,
hold, rise out — blue ink on cream, cream ink after the first flip.

## 2. SKELETON

Paste this whole document as `runs/<key>/final/template.wv`, then insert one `.cue` block per beat
(section 3) after the mat divs. Replace `{videoPath}` and `{DUR}` (`durationSec`, from `meta.json`)
and the two mat delays `{T2}` `{T3}` (formula below). Canvas: see RESOLUTION at the top of this sheet.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@700;800&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 736px; height: 1312px; overflow: hidden; }
  body { position: relative; background: #000; font-family: 'Bricolage Grotesque', Arial, Helvetica, sans-serif; }
  .vid { position: absolute; inset: 0; width: 736px; height: 1312px; object-fit: cover; z-index: 0; }

  /* colour mats — 4 opaque bands around the footage window (window = x26 y195 678×755).
     Base set is cream; the blue set fades in at {T2}ms, the red set at {T3}ms (section 5). */
  .m  { position: absolute; }
  .mt { left: 0;     top: 0;     width: 736px; height: 195px; }
  .mb { left: 0;     top: 950px; width: 736px; height: 362px; }
  .ml { left: 0;     top: 195px; width: 26px;  height: 755px; }
  .mr { left: 704px; top: 195px; width: 32px;  height: 755px; }
  .cb { background: #f4f1ea; z-index: 1; }
  .ob { background: #2b419b; z-index: 2; opacity: 0; animation: matIn 350ms ease {T2}ms both; }
  .rb { background: #c0281c; z-index: 3; opacity: 0; animation: matIn 350ms ease {T3}ms both; }
  @keyframes matIn { from { opacity: 0; } to { opacity: 1; } }

  /* rounded window corners — the window is negative space (wherever no mat covers), so a corner is
     rounded by patching a mat-coloured 28×28 square over each of its 4 corners, clipped by an ALL-%
     polygon that approximates a quarter-circle (a %-only clip-path polygon is used here so the corner
     geometry is stated explicitly rather than inferred from a radius). The rounded-off area reveals the video beneath, faking a rounded cutout. Same cb/ob/rb
     colour+animation classes as the straight mats keep the corners in the colour-flip narrative. */
  .ctl { left: 26px;  top: 195px; width: 28px; height: 28px;
         clip-path: polygon(0% 0%, 100% 0%, 69.1% 4.9%, 41.2% 19.1%, 19.1% 41.2%, 4.9% 69.1%, 0% 100%); }
  .ctr { left: 676px; top: 195px; width: 28px; height: 28px;
         clip-path: polygon(100% 0%, 0% 0%, 30.9% 4.9%, 58.8% 19.1%, 80.9% 41.2%, 95.1% 69.1%, 100% 100%); }
  .cbl { left: 26px;  top: 922px; width: 28px; height: 28px;
         clip-path: polygon(0% 100%, 0% 0%, 4.9% 30.9%, 19.1% 58.8%, 41.2% 80.9%, 69.1% 95.1%, 100% 100%); }
  .cbr { left: 676px; top: 922px; width: 28px; height: 28px;
         clip-path: polygon(100% 100%, 100% 0%, 95.1% 30.9%, 80.9% 58.8%, 58.8% 80.9%, 30.9% 95.1%, 0% 100%); }

  /* beat gate — the one safe reveal recipe; delay+duration set inline per beat */
  @keyframes cueWin { 0%, 99.99% { opacity: 1; } 100% { opacity: 0; } }
  .cue { position: absolute; left: 72px; top: 960px; width: 583px; height: 140px;
         opacity: 0; animation-name: cueWin; animation-timing-function: linear;
         animation-fill-mode: forwards; }

  /* a page = one short phrase; pages of a beat stack at the same origin and take turns */
  .ln { position: absolute; left: 0; top: 0; width: 583px; text-align: center;
        font-weight: 800; line-height: 1.15; letter-spacing: -0.045em;
        filter: blur(1.5px); opacity: 0;
        animation-name: capIO; animation-timing-function: ease; animation-fill-mode: both; }
  .hold { animation-name: capHold; }   /* final page of the final beat only */
  .blue  { color: #2b419b; }           /* beats before the first flip */
  .cream { color: #fbf9f7; }           /* beats from the first flip on */

  @keyframes capIO {
    0%   { opacity: 0; transform: translateY(14px); }
    18%  { opacity: 1; transform: translateY(0); }
    70%  { opacity: 1; transform: translateY(0); }
    100% { opacity: 0; transform: translateY(-10px); }
  }
  @keyframes capHold {
    0%   { opacity: 0; transform: translateY(14px); }
    18%  { opacity: 1; transform: translateY(0); }
    100% { opacity: 1; transform: translateY(0); }
  }

  /* size ladder — pick by the page's char count (section 3); width budget 583px is baked in */
  .s96 { font-size: 96px; } .s89 { font-size: 89px; } .s82 { font-size: 82px; }
  .s77 { font-size: 77px; } .s71 { font-size: 71px; } .s67 { font-size: 67px; }
  .s63 { font-size: 63px; } .s59 { font-size: 59px; } .s56 { font-size: 56px; }
  .s53 { font-size: 53px; } .s51 { font-size: 51px; } .s49 { font-size: 49px; }
  .s46 { font-size: 46px; } .s44 { font-size: 44px; } .s43 { font-size: 43px; }
  .s38 { font-size: 38px; }
</style>
</head>
<body>
  <video class="vid" src="{videoPath}" muted></video>
  <div class="m mt cb"></div><div class="m mb cb"></div><div class="m ml cb"></div><div class="m mr cb"></div>
  <div class="m mt ob"></div><div class="m mb ob"></div><div class="m ml ob"></div><div class="m mr ob"></div>
  <div class="m mt rb"></div><div class="m mb rb"></div><div class="m ml rb"></div><div class="m mr rb"></div>
  <div class="m ctl cb"></div><div class="m ctr cb"></div><div class="m cbl cb"></div><div class="m cbr cb"></div>
  <div class="m ctl ob"></div><div class="m ctr ob"></div><div class="m cbl ob"></div><div class="m cbr ob"></div>
  <div class="m ctl rb"></div><div class="m ctr rb"></div><div class="m cbl rb"></div><div class="m cbr rb"></div>
  <!-- one .cue block per beat goes here, in beat order -->
</body>
</html>
```

**Mat flip delays** — B = number of beats in `word-timings.json`:
- K2 = floor(B/3)+1, but never below 2. K3 = floor(2·B/3)+1, but never below K2+1.
- `{T2}` = `cueDelayMs` of beat K2, verbatim. `{T3}` = `cueDelayMs` of beat K3, verbatim.
- If K3 > B: delete the four `.rb` divs (no red phase). If K2 > B (a 1-beat run): delete the
  `.ob` divs too and give every page class `blue`.
- (B=6 → K2=3, K3=5.)

Placement is FIXED: `.cue` at `left:72px; top:960px; width:583px` sits centered under the footage
window with a clean gap below it (window bottom 950, gap 10px), on the bottom mat — inside the safe
margins (left 72 ≥ 44, right edge 655 ≤ 655, top 960 ≥ 144, lowest ink 960+14+110 = 1084 ≤ 1089). Do
not move it per beat.

## 3. PER-BEAT ASSEMBLY

One `.cue` per beat `{N}` of `word-timings.json`; inside it one `.ln` div per PAGE:

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N}; animation-delay:{cueDelayMs}ms; animation-duration:{winMs}ms;">
  <div class="ln {SIZE} {COL}" id="b{N}p1" data-node-id="b{N}p1" data-node-role="text"
       style="animation-delay:{pgStartMs}ms; animation-duration:{pgDurMs}ms;">{page-1 words}</div>
  <!-- more pages: b{N}p2, b{N}p3, … -->
</div>
```

**Window (the gate):** `{winMs}` = next beat's `cueDelayMs` − this beat's `cueDelayMs`.
Last beat: `{winMs}` = round(`durationSec`×1000 from `meta.json`) − its `cueDelayMs`.

**Paging rule** — split the beat's `words[]` into pages, ORDER PRESERVED, every token used once,
original case and punctuation kept (no uppercasing):
- n = word count. P = ceil(n/3). base = floor(n/P); the first (n mod P) pages take base+1
  consecutive words, the rest take base. (n=8 → 3,3,2 · n=11 → 3,3,3,2 · n=4 → 2,2 · n≤3 → 1 page.)
- A page is ONE line of plain text: words joined with single spaces inside the one `.ln` div
  (no per-word spans in this ref — the prefab pops whole phrases).

**Sizing — one `{SIZE}` class per page:** C = the page's char count = sum of word lengths
(punctuation included) + 1 per space. Look up (advance budget 0.54·fs per char incl. tracking;
line budget 583px — already baked in):

| C ≤11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | ≥26 |
|-------|----|----|----|----|----|----|----|----|----|----|----|----|----|----|-----|
| s96 | s89 | s82 | s77 | s71 | s67 | s63 | s59 | s56 | s53 | s51 | s49 | s46 | s44 | s43 | s38 |

**Ink colour `{COL}`:** beats i < K2 → `blue`; beats i ≥ K2 → `cream` (K2 from section 2 — the ink
flips to cream the moment the mat flips to blue, and stays cream through the red phase).

**Worked example** (a 6-beat sample run; beat 1 words `Okay, everyone posts their perfect little
morning routine.`, cueDelayMs 31, next beat 2991 → winMs 2960):
- p1 `Okay, everyone posts` (C=20 → s53), p2 `their perfect little` (C=20 → s53),
  p3 `morning routine.` (C=16 → s67); beats 1–2 `blue`, beats 3–6 `cream` (K2=3);
  T2 = beat 3's cueDelayMs = 3811, T3 = beat 5's = 6671.

## 4. WORDS + TIMING

This ref is PAGE-level (phrase pops), not word-level — timing attaches to pages:
- `{pgStartMs}` = the `delayMs` of the page's FIRST word, from `runs/<key>/word-timings.json`
  VERBATIM (delays are absolute on the single timeline — paste as-is, never re-zero, never invent).
- `{pgDurMs}` — the ONE-PAGE-AT-A-TIME invariant (pages share one anchor; a page must be GONE, not
  "mostly faded", when its successor rises — a later fade double-prints both phrases at the anchor,
  invisible to --verify):
  - page followed by another page in the SAME beat: `{pgDurMs}` = next page's `{pgStartMs}` −
    this page's `{pgStartMs}` — NO tail; the fade (last 30% of the duration) completes exactly as
    the successor starts;
  - the beat's LAST page (not the run's last): `{pgDurMs}` = next beat's `cueDelayMs` − this page's
    `{pgStartMs}` (the fade completes exactly as the gate closes);
  - floor every `{pgDurMs}` at 450 (never below; where the floor wins the brief overlap is accepted);
  - the FINAL page of the FINAL beat: add class `hold` and set `animation-duration:800ms` — it rises
    once and stays until the gate ends (the prefab's cueHold close). Its `animation-delay` is STILL
    the page's FIRST word's `delayMs`, like every other page.
- The beat's `.cue` gets inline `animation-delay:{cueDelayMs}ms; animation-duration:{winMs}ms`
  exactly as in section 3.
- Word spacing is plain text spaces inside the single `.ln` div (the prefab renders multi-word text
  nodes; the dropped-whitespace limit applies between sibling SPANS, which this ref does not use).
- Dense example (beat of 6 words starting 5351, next words at 5390/5630/5710/5810/6050, next beat
  6671): p1 `So here's how` start 5351, dur = max(5710−5351, 450) = 450 (floor wins); p2
  `I survive one.` start 5710 (its FIRST word `I`), dur = 6671−5710 = 961.

## 5. EMPHASIS

The emphasis device is GLOBAL, not per-word: the two mat flips (cream→blue at beat K2, blue→red at
beat K3) are the narrative peaks, and the ink flip blue→cream rides the first one. K2/K3 come from
the section-2 formula — no judgment. Do NOT add any per-word emphasis: no colour swaps inside a
page, no scale changes, no extra classes beyond `{SIZE}`, `{COL}`, and the one `hold`.

## 6. VERIFY LOOP

Run (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Otherwise apply the MECHANICAL fix for the named element and re-run; at most 2 fix
cycles:
- `FAIL[bounds] #b{N}p{P} … left/right outside` → move that page's `{SIZE}` one column RIGHT in the
  section-3 table (next smaller class). If it fails again and the overshoot is ≤ 4px, delete the
  `filter: blur(1.5px);` line from `.ln` instead (blur ink can spill the glyph box).
- `FAIL[bounds] … top/bottom outside` → the `.cue` `top` drifted: restore `top:960px` in the skeleton.
- `FAIL[never-visible] #b{N}p{P}` → that page's `animation-delay` is outside its beat's cue window:
  re-check it equals the page's first word `delayMs` and sits in the RIGHT beat's `.cue`; confirm the
  `.cue` carries its inline `z-index:{10+N}` and the `<video>` is the first body element with `.vid`.
- `FAIL[occluded] #b{N}p{P}` → two cue windows overlap: re-check every `{winMs}` equals the next
  beat's `cueDelayMs` minus this beat's, and that cue z-indexes are exactly `10+N` in beat order.
  (The mats sit at z 1–3 and never cover the caption band with anything above z 3.)

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --record {repo}/runs/<key>/final/out.silent.mp4
```

`manifest.json`, verbatim shape (`{DUR}` = `durationSec` from `meta.json`):

```json
{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json
```

## 7. DO NOT

- No fonts, colors, shadows, sizes, or keyframes beyond this sheet — Bricolage Grotesque 700/800, the four hexes
  (`#f4f1ea` `#2b419b` `#c0281c` `#fbf9f7`), `capIO`/`capHold`/`cueWin`/`matIn` and the s-ladder are
  the whole system. No text-shadow (the ink always sits on a flat mat).
- Never use `border-radius` for the window corners in this recipe; the four
  `.ctl`/`.ctr`/`.cbl`/`.cbr` clip-path polygons ARE the
  corner radius — keep every coordinate a `%` (px/unitless coords get silently dropped by the engine).
- No invented timing: every delay comes VERBATIM from `word-timings.json`; durations only via the
  section-4 formulas; the mat flips only at `{T2}`/`{T3}` from the K2/K3 rule.
- Do not animate `background-color` with keyframed percentages (the prefab's `bgshift` is replaced
  by the delayed `.ob`/`.rb` overlay fades — use those); never animate `color` or `filter:blur`.
- No per-word spans, no uppercasing, no reordering or dropping words; punctuation stays.
- Never read the video frames; never move the `.cue` anchor or the window geometry; no descendant selectors — flat classes only.
- No redesign after a render or verify failure — only the mechanical fixes in section 6.
