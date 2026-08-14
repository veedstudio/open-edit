# RECIPE — hook-071 (0-00-02-21) (16:9 · 1280×720 @ 24fps)

RESOLUTION: px are authored at the 16:9 reference canvas 1280×720. FIRST STEP: SCALE = W/1280 from
`meta.json` (require |H − 720·SCALE| ≤ 0.02·H, else STOP — wrong aspect). Compute EVERY number in this
sheet at the reference canvas first; if SCALE = 1 use them verbatim, otherwise, as the LAST step,
multiply EVERY px value in the document by SCALE and round (positions, widths, font sizes). `em`
values (shadows, travels, margins) and ms timings never scale; the manifest carries the run's real W/H.

The prefab is a 1276×720 dark title card with a dead-center giant script word; the composition below is
RE-COMPOSED for footage with a center/center-right subject — ONE cohesive CENTER-ALIGNED lockup held in
the lower band (kicker phrase centered directly above the script hero, caption phrase tucked directly
under it, all three registers sharing ONE vertical axis at x=640, the frame's optical center).
The lockup is a tight, single composed unit — ONE 12px rhythm unit of air on each side of the hero's
OPTICAL band, so the three registers read as one block and never as three floating substances; script
TAILS overhang that air rather than pushing the caption away (section 3). Copy numbers as written,
never rescale against the prefab.

## 1. IDENTITY

An elegant, premium two-font stack, CENTER-ALIGNED as one lockup in the lower band: tiny white Inter
**Bold 700** lines (lowercase, ONE fixed body size everywhere) centered above and below ONE
display-size acid `#96FF1A` Pinyon Script word per beat — a hard editorial hierarchy, small quiet body
against a script accent that fills the frame. The body is BOLD, not Medium: at 24px over live footage
Medium reads as a caption artefact next to a 260px script glyph, Bold holds its own as the lockup's
second register. The sans words rise in on their spoken timings (kicker settles down from
above, caption rises up from below) and the script hero fades in with a soft scale-in pop from its own
center. Shadows are INTERFACE-GRADE: ONE SINGLE-LAYER tight, low-opacity drop on each register — no
halos, no outlines, no offset copies, no stacked layers, nothing that reads as a glow.

The accent is the composition. It lands at the SAME display size on every beat (see section 3): word
length is not a size input, only the frame budget is.

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
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Pinyon+Script&display=swap" rel="stylesheet">
<style>
  html, body { margin: 0; padding: 0; }
  body { width: 1280px; height: 720px; background: #000; overflow: hidden; position: relative; }
  .vid { position: absolute; inset: 0; width: 1280px; height: 720px; object-fit: cover; }

  /* window gate — the one safe reveal recipe; delay+duration+z come inline per cue.
     The cue is the CENTERING FRAME: full-frame, so every row is a full-width block with
     text-align:center and all three registers center on x=640 (a full-width block + text-align:center
     centres animated children without letting the line resize with them — shrink-to-fit reflows
     animating lines). NOTHING overflows: the hero's ink budget (section 3) keeps the widest glyph
     box inside the frame at every size, so --verify judges real glyph bounds with room to spare. */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position: absolute; left: 0; top: 0; width: 1280px; height: 720px; opacity: 0; z-index: 11;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  .row  { position: absolute; left: 0; width: 100%; text-align: center; white-space: nowrap; }
  /* ONE restrained shadow idiom composition-wide: a SINGLE-LAYER tight low-opacity drop (blur ≈ 2-3×
     offset, never more) on both registers — enough to hold white ink and thin script strokes on live
     footage, never a halo. Solid rims, unblurred offset copies and stacked shadow layers are
     FORBIDDEN: on a script glyph they read as a broken doubled print, on 24px body text they turn to
     mud. */
  .sans { font-family: 'Inter', sans-serif; font-weight: 700; letter-spacing: 0.02em;
          line-height: 1.3; text-transform: lowercase; color: #ffffff;
          text-shadow: 0 0.05em 0.14em rgba(0,0,0,0.5); }
  /* the hero div is the ANIMATED node; its letters are static per-letter runs (keeps every glyph
     texture small — the prefab's load-bearing quirk). Every keyframe ends at identity, so the
     composed and uncomposed geometries coincide — bounds are budgeted at the untransformed width.
     transform-origin is 50% 60% so the scale-in pops from the lockup's shared center axis. */
  .hero { font-family: 'Pinyon Script', cursive; font-weight: 400; line-height: 1.2; letter-spacing: 0;
          color: #96FF1A; text-shadow: 0 0.016em 0.036em rgba(0,0,0,0.45);
          opacity: 0; z-index: 1; transform-origin: 50% 60%;
          animation-name: heroIn; animation-timing-function: cubic-bezier(.2,.7,.3,1);
          animation-fill-mode: both; }
  .hl { display: inline-block; }
  .w  { display: inline-block; opacity: 0; margin-right: 0.35em;
        animation-timing-function: cubic-bezier(.2,.7,.3,1); animation-fill-mode: both; }
  .wk { animation-name: riseK; }
  .wc { animation-name: riseC; }

  @keyframes heroIn { 0% { opacity: 0; transform: scale(0.94); } 100% { opacity: 1; transform: scale(1); } }
  @keyframes riseK  { 0% { opacity: 0; transform: translateY(-0.22em); } 100% { opacity: 1; transform: none; } }
  @keyframes riseC  { 0% { opacity: 0; transform: translateY(0.22em); }  100% { opacity: 1; transform: none; } }
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

One `.cue` per beat in `word-timings.json`. Beat template — `{N}` = beat `i`; omit the kicker div when
there are no PRE words, omit the caption div when there are no POST words; a kicker/caption div splits
to a 2nd line (`b{N}k2` / `b{N}c2`) only per the split rule below:

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N};animation-delay:{cueDelayMs}ms;animation-duration:{cueDurMs}ms">
  <div class="row sans" id="b{N}k" data-node-id="b{N}k" data-node-role="text" style="top:{kickerTop}px;font-size:24px"><span class="w wk" style="animation-delay:{delayMs}ms;animation-duration:{riseMs}ms">{word}</span><!-- more kicker line-1 words, no whitespace between spans; the row's LAST span adds ;margin-right:0 --></div>
  <div class="row sans" id="b{N}k2" data-node-id="b{N}k2" data-node-role="text" style="top:{kickerTop+31}px;font-size:24px"><!-- kicker line 2 words --></div>
  <div class="row hero" id="b{N}h" data-node-id="b{N}h" data-node-role="text" style="top:{heroTop}px;font-size:{H}px;animation-delay:{heroDelayMs}ms;animation-duration:{heroMs}ms"><span class="hl">{L1}</span><span class="hl">{L2}</span><!-- one .hl span per character of the hero word, adjacent, no whitespace --></div>
  <div class="row sans" id="b{N}c" data-node-id="b{N}c" data-node-role="text" style="top:{captionTop}px;font-size:24px"><span class="w wc" style="animation-delay:{delayMs}ms;animation-duration:{riseMs}ms">{word}</span><!-- more caption line-1 words --></div>
  <div class="row sans" id="b{N}c2" data-node-id="b{N}c2" data-node-role="text" style="top:{captionTop+31}px;font-size:24px"><!-- caption line 2 words --></div>
</div>
```

**Word prep (before counting anything):** strip a trailing `.` or `,` from each word; keep `?` `!` `'`
and any INTERNAL punctuation (`10,000` stays as is). GLUE: a token starting with `-` merges with the
previous word into ONE unit for mapping and counting, rendered as two adjacent spans (previous span
gets inline `margin-right:0`), each keeping its OWN verbatim `delayMs`.

**Word mapping — deterministic, word order always preserved:** pick the beat's HERO word (section 5).
Every word BEFORE the hero (in spoken order) is a KICKER word (top band); every word AFTER it is a
CAPTION word (bottom band); the hero itself is the script row. The sans rows render lowercase (the CSS
does it); the hero is written per-letter with its FIRST character uppercased and the rest lowercased
(digits/punctuation unchanged: `10,000` stays `10,000`).

**Body sizing — ONE FIXED SIZE (24px Inter Bold 700) for every kicker and caption line, always.** There
is no per-line sizing: the whole composition uses exactly TWO type sizes — this 24px body and the hero
accent (below). A sans row is normally ONE line. SPLIT to 2 lines ONLY when its character count
**C > 34** (C = sum of the row's words' stripped lengths + 1 per gap between words): at 24px that is the
widest line that stays inside the 536px measure column the body keeps under the much wider script.
The threshold is DERIVED FROM THE BODY WEIGHT, not a free number — Inter Bold is ~2-3% wider per glyph
than Medium (`data/font-cache/Inter-VariableFont_wght.ttf` hmtx), so the char budget steps down from
Medium's 36 to 34; re-derive it again if the body weight ever changes. Split point: between consecutive
words, minimizing |left chars − right chars| (counting gaps; tie → fewer words on line 1). Never more
than 2 lines. Both lines keep font-size 24px.

**Hero sizing — METRIC-EXACT, and length-independent by design.** The old per-length size table is
gone: it made short heroes huge and long heroes small, which is exactly the defect this recipe must not
have. Every accent word takes the SAME display size (`H_MAX = 260px`) unless a frame budget physically
stops it. Three per-word numbers come from Pinyon Script's own metrics (`PINYON` in `recipe.ts` —
per-glyph advance + ink box, measured from the shipped TTF at upm 2048; letters render as adjacent
inline-blocks so there is NO kerning and a word's advance box is the plain sum of advances):

- `asc` — the word's tallest ink above the baseline, in em (max glyph yMax). Pinyon has no ascending
  outlier — every glyph tops out between 0.62 and 0.80em — so the ink top IS the optical top.
- `desc` — the word's deepest ink below the baseline, in em (max −yMin, ≥ 0), TAILS INCLUDED. It is a
  FRAME budget only: it never places anything.
- `desc_opt` — the OPTICAL bottom: the deepest ink that is not a TAIL, i.e. where the letterform
  bodies stop. A glyph carries a TAIL when it is a LETTER whose ink drops more than **0.08em** below
  the baseline — Pinyon's letters split cleanly there (non-tail letters bottom out within 0.0229em of
  the baseline: plain overshoot; tails start at 0.1123em — the `Y` `C` `E` `Q` cap swashes, then
  `p` `J` `f` `g` `j` `q` `y` `z` at 0.3462-0.3843). FIGURES and PUNCTUATION are never tails: a digit
  hero is a short, centered word, so its dip (`7` 0.2661, `5` 0.1548, `,` 0.104) lands exactly where
  the caption goes and must be cleared. An unknown glyph takes the fallback's deep descent, so it
  reads as a tail — it can only push the caption UP and the hero's size DOWN.
- `half` — half of the ink width the frame must hold: with the row centered on its ADVANCE box,
  `half = max(adv/2 − inkLeft, inkRight − adv/2)` where inkLeft/inkRight accumulate the per-glyph
  xMin/xMax at their pen positions (script glyphs overhang their advances — `g` to the left, the
  capitals to the right).

```
capWidth = floor(1140 / (2·half))                                         ← ink budget, frame-centered
capAbove = floor((560 − 44 − (kLines ? 12 + kLines·31 : 0)) / asc)
capBelow = floor((700 − 560 − (cLines ? 12 + cLines·31 : 0)) / desc_opt)  ← ∞ when desc_opt = 0
capTail  = floor((700 − 560) / desc)                                      ← ∞ when desc = 0
H        = min(capWidth, round(max(88, min(260, capAbove, capBelow, capTail)) · 0.9^demote))
```

(260 becomes `round(1.12·260) = 291` on a punch-close last beat — section 6. `0.9^demote` is the
verify loop's only hero lever — section 7. The width cap is applied LAST so it always wins: it is the
one budget `--verify` can see. `capTail` is the tail's only budget — it keeps the overhang inside the
frame, and at 140/0.3843 = 364 it sits above both display caps, so a `g` never shrinks a hero.)

**Placement (all closed-form, reference px — the three registers form ONE tight center-aligned lockup
on the x=640 axis; the hero's BASELINE is pinned at y=560, the composition's single fixed anchor, and
both body rows sit ONE 12px rhythm unit off the hero's OPTICAL band — the same gap above and below, so
the stack reads as a single block):**
- Hero row: `heroTop = 560 − round(0.8395·H)`. (0.8395em is the baseline offset inside a
  `line-height: 1.2` row box for Pinyon's metrics: half-leading `(1.2 − (1768+787)/2048)/2` + ascent
  `1768/2048`. Verified against a real render to the pixel.)
- Hero OPTICAL band: `inkTop = 560 − round(asc·H)`, `optBot = 560 + round(desc_opt·H)`. The tail's tip
  `560 + round(desc·H)` is NOT a placement input — it hangs past the caption's top edge by design.
- Kicker (kLines = 1 or 2): `kickerTop = inkTop − 12 − kLines·31`; kicker line 2: `kickerTop + 31`.
  (31 = round(1.30·24), the body line advance.)
- Caption (cLines = 1 or 2): `captionTop = optBot + 12`; caption line 2: `captionTop + 31`.
- **The rhythm is arithmetic, not eyeballing:** the kicker's last line BOTTOM is `inkTop − 12` and the
  caption's TOP is `optBot + 12`, both measured against the hero's OPTICAL extremes; a body row's own
  ink always sits inside its 31px box (Inter's content area is 1.21em inside a 1.30em line box). So
  every beat keeps exactly one 12px unit of clear air between the letterform bodies and the body rows,
  whatever the word, and the caption's drop under the baseline is bounded by the tail threshold
  (≤ 12 + round(0.08·H) on a letter hero) — it can never drift down with a descender. `capAbove` and
  `capBelow` are the same inequalities solved for H against the safe band (top 44, bottom 700), and
  `capTail` holds the overhang inside it, so growing the hero can never push anything off the frame.
- **The tail overhangs, deliberately.** A `g`/`y`/`p` sweeps past the caption's top edge; it is a thin
  stroke on the word's flank while the caption is a short centered line, so it reads as one interlocked
  lockup. Occasional proximity is ACCEPTED and is not a defect to fix — never re-base the caption on
  `desc` to buy clearance, that is the scattered layout this recipe replaced.

**Worked example** (beat 1 of the validated 5-beat run; 9 words `My most viral video took five minutes
to make.`, cueDelayMs 160, cueDurMs 2160 → cueEnd 2320): no digit word; longest stripped word =
`minutes` (7) → HERO, rendered `Minutes`. Kicker = `my most viral video took five` (C = 24 chars + 5
gaps = 29 ≤ 34 → ONE line, kLines = 1); caption = `to make` (C = 7, one line, cLines = 1).
`Minutes`: asc = 0.7261 (`M`), desc = desc_opt = 0.0112 (`s`), half = 1.5255 → capWidth = 373,
capAbove = 651, capBelow = 8660, capTail = 12500 → H = 260. heroTop = 560 − round(218.3) = 342;
inkTop = 560 − round(188.8) = 371 → kickerTop = 371 − 12 − 31 = 328; optBot = 560 + 3 = 563 →
captionTop = 575. Hero delay 1560, avail = 2320 − 1560 = 760 → heroMs = min(700, 640) = 640. `to`
(delay 1880, avail 440) → riseMs = min(400, max(180, 320)) = 320; `make` (2040, avail 280) → 180.
Every hero in that run lands at 260 — `Minutes`, `Phone` and `Polishing` alike: the `g` is a tail, so
it hangs to 660 (40px clear of the bottom safe line, 85px past the caption's top edge) instead of
shrinking the word to 241 and shoving `the bad ones` down to 669. Zero size spread, one rhythm.

## 4. WORDS + TIMING

- Delays are absolute on the single timeline — paste as-is from `runs/<key>/word-timings.json`, never
  re-zero, never invent.
- Each beat's `.cue` gets inline `animation-delay:{cueDelayMs}ms;animation-duration:{cueDurMs}ms`
  verbatim, plus `z-index:{10+N}`.
- Per word compute once: cueEnd = cueDelayMs + cueDurMs (beat-level); avail = cueEnd − delayMs.
- Sans word: `riseMs = min(400, max(180, avail − 120))` →
  `<span class="w wk" style="animation-delay:{delayMs}ms;animation-duration:{riseMs}ms">{word}</span>`
  (`wc` instead of `wk` in the caption row). When a sans row splits to 2 lines each word keeps its own
  verbatim `delayMs`/`riseMs`; the line break is purely positional.
- Hero: `heroMs = min(700, max(250, avail − 120))` — delay/duration go on the `.hero` DIV (the letters
  never animate individually).
- Words accumulate — every landed word HOLDS until the cue gate cuts the beat. No fade-outs anywhere.
- Word spacing is the `.w` `margin-right: 0.35em` — inter-span whitespace is not what sets the gap here,
  the margins ARE the gaps. Write word spans adjacent with no whitespace between them. The LAST span
  of each row adds `;margin-right:0` (a trailing margin would drag the centered line off the x=640
  axis). Hero letters are adjacent `.hl` spans with no margins (the script connects them).

## 5. EMPHASIS

Exactly ONE hero word per beat — the display-size Pinyon Script word IS the emphasis device. Pick rule,
no judgment:
1. Any word containing a digit wins (the FIRST such word if several).
2. Otherwise the LONGEST word of the beat (length after stripping).
3. Tie → the LATER word.
Nothing else changes for the hero — its row, size and animation come from sections 3-4.

## 6. BOUNDED VARIETY

Pick per axis by the RULES below (computable from the run inputs — no judgment), state choices in the
REPORT.

1. **SCALE ARC** — `steady` (default: the 260px display cap) · `punch-close`: the LAST beat's hero
   raises its cap to `round(1.12 · 260) = 291` (the frame budgets in section 3 still apply, and every
   top in that beat is recomputed from the resulting H — nothing else changes). Rule: punch-close when
   the last beat's hero contains a digit or any word of the last beat ends with `!`; else steady.
2. **DEVICE INTENSITY** — `standard` (default: `heroIn` exactly as in section 2) · `soft`: the
   `heroIn` 0% frame becomes `{ opacity: 0; transform: scale(0.97); }` (100% frame and everything else
   unchanged). Rule: soft only when the DIRECTION (execution contract) explicitly asks for calm/subtle energy; else
   standard.

## 7. VERIFY LOOP

Run (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Otherwise apply the mechanical fix for the flagged element and re-run; at most 2 fix
cycles:
- `FAIL[bounds] #b{N}h ... left/right outside` → take that beat's hero ONE demote step down
  (`H → round(0.9·H)`, section 3) and recompute that beat's heroTop, kickerTop and captionTop.
  (A `bottom outside` on a hero means its TAIL left the frame — same demote step, same recompute.)
- `FAIL[bounds] #b{N}k/k2/c/c2 ... left/right outside` → that body row exceeds the measure column:
  apply the C>34 split rule (or, if already split, re-balance the split point). Body size stays 24px
  Inter Bold.
- `FAIL[bounds] ... top/bottom outside` → re-check that row's top against the section-3 closed forms
  for the beat's ACTUAL sizes (an arithmetic slip, not a design problem).
- `FAIL[never-visible]` → check that cue's inline `animation-delay`/`animation-duration` match
  `word-timings.json`, the `<video>` is the first body element with `style="z-index:0"`, `.hero` kept
  its `z-index: 1`, and every class list is exactly as in the templates (a typo'd animation name never
  animates in).
- `FAIL[occluded] #b{N}...` → cue windows overlap: cue N's `animation-duration` must not exceed
  `cueDelayMs(N+1) − cueDelayMs(N)`; if it does, set it to that difference. Confirm inline z-index is
  10+N in beat order.

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --progress-output --record {repo}/runs/<key>/final/out.silent.mp4
```

Manifest line (already given in section 2): `{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}` — W/H/FPS/DUR from `meta.json`.

## 8. DO NOT

- No fonts, colors, shadows, sizes, or keyframes beyond this sheet — Pinyon Script 400 + Inter Bold
  700, the two inks (white `#ffffff`, acid `#96FF1A`), the ONE SINGLE-LAYER tight drop shadow per
  register (never add a solid rim, an unblurred offset layer, a wide halo, or a second shadow layer),
  `cueWin`/`heroIn`/`riseK`/`riseC`, the ONE body size (24px) and the metric-exact hero sizing are the
  whole system. Exactly two type sizes, exactly one body weight.
- Never change the body weight without re-deriving the split threshold: C > 34 is Inter BOLD's measure
  budget at 24px. A weight change silently makes every long row over- or under-split.
- Never size the hero from word length, and never re-introduce a per-length size table: the accent
  holds ONE display size across the whole video, and only the section-3 frame budgets may shrink it.
- Never place a body row by eye or by a fixed offset from the hero row: kicker and caption tops come
  ONLY from the hero's measured OPTICAL band (`asc`/`desc_opt`), which is what makes the 12px rhythm a
  guarantee rather than a hope. `desc` (tails included) is a frame budget, never a placement input —
  measuring the caption off a descender is what made the old lockup read as three floating parts.
- The hero is ALWAYS per-letter `.hl` spans inside the animated `.hero` div — never one text run, and
  never animate the letters individually (per-letter runs keep every glyph texture under the engine's
  ~512px limit; the parent carries the motion).
- Never move the lockup off the x=640 axis; every row is a full-width block with `text-align:center`
  and every top comes ONLY from the section-3 closed forms (the y=560 baseline anchor and the ink-band
  clearances ARE the design) — never invent placement, never detach a register from the lockup, never
  left-flush a row.
- Every animated transform must END at identity — never add a persistent scale/translate to a
  keyframes 100% frame (the engine can composite an animating node over `<video>` without an
  ancestor's static transform; identity finals make that harmless).
- No invented timing: every `delayMs`/`cueDelayMs`/`cueDurMs` comes verbatim from
  `word-timings.json`; derived numbers ONLY via the closed forms in sections 3-4.
- Words accumulate and the gate cuts the beat — never add per-word, per-row, or page fade-outs.
- No `text-align` other than the `center` baked into `.row` (rows are centered, never left-flush);
  letter-spacing stays 0.02em on sans and 0 on the hero; no descendant selectors — flat classes only.
- Never animate `color`.
- Never read the video frames; never re-derive layout; no redesign after a render or verify failure —
  only the mechanical fixes in section 7.
