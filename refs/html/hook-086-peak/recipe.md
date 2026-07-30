# RECIPE — hook-086-peak (16:9 · 1280×720 @ 24fps)

RESOLUTION: px are authored at the 16:9 reference canvas 1280×720. FIRST STEP: SCALE = W/1280 from
`meta.json` (require |H − 720·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE and round (positions, sizes, fonts, the keyframe slide, the ghost
blur radii); `em` values (tracking, margins) and ms timings never scale; the manifest carries the run's
real W/H.

Prefab is 1276×720 (×1.0031 to reference — sub-px, numbers carried verbatim).

## 1. IDENTITY

Bold Inter phrases resolving word-by-word at dead center over FULL-BLEED footage. Nothing else is on
screen — no plate, no card, no panel, no backdrop, no closing badge: plain type on the picture from the
first beat to the last. Type is MID-SIZE, not display-giant (the ladder tops out at 118px and a line
fills roughly half the 1140px measure) — the air around the phrase is the point, and tracking is a
function of size, tightening as the type grows.

The reveal is an Apple-style FOCUS PULL: each word slides in from the RIGHT on a cubic ease-out while a
softly defocused copy of it resolves into the sharp one. The defocus is a STEPPED relay of three
stacked copies — this engine cannot animate a blur (section 7, ENGINE FACTS) — and the steps are
shallow with overlapping opacity ramps, so it reads as one gentle softening, never as three copies.

Colour is monochrome: ONE Apple off-white `#f5f5f7` at two luminance levels — recessive body words, the
beat's single accent word at full strength. No hue anywhere. The only shadow is one tight low-alpha
contact shadow on the ink: enough to lift white type off live footage, light enough that it never reads
as grime. Ghost copies carry NO shadow.

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
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1280px; height: 720px; overflow: hidden; }
  body { position: relative; background: #000; font-family: 'Inter', Arial, Helvetica, sans-serif; }
  .vid { position: absolute; inset: 0; width: 1280px; height: 720px; object-fit: cover; z-index: 0; }

  /* beat gate — the one safe reveal recipe; delay+duration+z come inline per cue */
  @keyframes cueWin { 0%, 99.99% { opacity: 1; } 100% { opacity: 0; } }
  .cue { position: absolute; inset: 0; opacity: 0; animation-name: cueWin;
         animation-timing-function: linear; animation-fill-mode: forwards; }

  /* a page = ONE centered nowrap line; pages of a beat take turns at the card's center.
     letter-spacing is NOT set here — it rides the size class, because tracking is a function of size */
  .pg { position: absolute; left: 70px; width: 1140px; text-align: center; white-space: nowrap;
        font-weight: 700; line-height: 1.3; }
  .po { animation-name: pgOut; animation-timing-function: linear; animation-fill-mode: both; }
  @keyframes pgOut { 0% { opacity: 1; } 100% { opacity: 0; } }

  /* THE FOCUS PULL — three parts, and only the first one moves.
     1. the wrapper slides right-to-left and settles on a cubic ease-out. Both ends authored; it
        carries NO opacity, or that opacity would multiply into the ghosts and kill the defocus. */
  @keyframes wIn { 0% { transform: translateX(28px); } 100% { transform: translateX(0px); } }
  .w  { display: inline-block; position: relative; margin-right: 0.3em;
        animation-name: wIn; animation-timing-function: cubic-bezier(0.215, 0.61, 0.355, 1); animation-fill-mode: both; }
  /*  2. the two ghosts: STATICALLY blurred copies stacked over the ink (an ANIMATED blur renders its
        end state from frame one on this engine, and filter ignores em — so the ramp is a relay of
        opacity across copies whose px radii are written inline per ladder row).
        The three stages OVERLAP rather than meet at a point — a ghost is still dissolving while the
        next stage is already coming up, so the pull reads as one continuous softening rather than as
        three stacked copies handing off. No text-shadow on a ghost: a shadow under a blurred copy is
        exactly what reads as grime.
        Explicit z-index — a positioned element animating opacity with none falls under the video. */
  @keyframes g1In { 0% { opacity: 0; } 20% { opacity: 1; } 55% { opacity: 0; } 100% { opacity: 0; } }
  @keyframes g2In { 0% { opacity: 0; } 16% { opacity: 0; } 50% { opacity: 1; } 84% { opacity: 0; } 100% { opacity: 0; } }
  .g1 { position: absolute; left: 0; top: 0; z-index: 3; opacity: 0; color: rgba(245,245,247,0.8);
        animation-name: g1In; animation-timing-function: linear; animation-fill-mode: both; }
  .g2 { position: absolute; left: 0; top: 0; z-index: 2; opacity: 0; color: rgba(245,245,247,0.85);
        animation-name: g2In; animation-timing-function: linear; animation-fill-mode: both; }
  /*  3. the ink: sharp, in flow (it is the wrapper's box), arriving as the soft ghost dissolves. Two
        luminance levels of ONE off-white are the whole colour system — no hue, ever. The shadow is a
        single tight contact shadow at low alpha: enough to lift plain white type off the footage,
        light enough that it never reads as dirt. */
  @keyframes ikIn { 0% { opacity: 0; } 46% { opacity: 0; } 82% { opacity: 1; } 100% { opacity: 1; } }
  .ik { display: inline-block; opacity: 0; color: rgba(245,245,247,0.9);
        text-shadow: 0 1px 3px rgba(0,0,0,0.3);
        animation-name: ikIn; animation-timing-function: linear; animation-fill-mode: both; }
  .ia { display: inline-block; opacity: 0; color: #f5f5f7;
        text-shadow: 0 1px 3px rgba(0,0,0,0.34);
        animation-name: ikIn; animation-timing-function: linear; animation-fill-mode: both; }

  .p118{font-size:118px;letter-spacing:-0.012em} .p108{font-size:108px;letter-spacing:-0.0092em} .p98{font-size:98px;letter-spacing:-0.0063em} .p90{font-size:90px;letter-spacing:-0.0041em}
  .p83{font-size:83px;letter-spacing:-0.0021em} .p77{font-size:77px;letter-spacing:-0.0004em} .p72{font-size:72px;letter-spacing:0.001em} .p67{font-size:67px;letter-spacing:0.0024em}
  .p63{font-size:63px;letter-spacing:0.0035em} .p60{font-size:60px;letter-spacing:0.0044em} .p57{font-size:57px;letter-spacing:0.0052em} .p54{font-size:54px;letter-spacing:0.0061em}
  .p51{font-size:51px;letter-spacing:0.0069em} .p49{font-size:49px;letter-spacing:0.0075em} .p47{font-size:47px;letter-spacing:0.0081em} .p45{font-size:45px;letter-spacing:0.0086em}
  .p43{font-size:43px;letter-spacing:0.0092em} .p41{font-size:41px;letter-spacing:0.0098em} .p40{font-size:40px;letter-spacing:0.01em} .p38{font-size:38px;letter-spacing:0.0106em}
  .p37{font-size:37px;letter-spacing:0.0109em} .p36{font-size:36px;letter-spacing:0.0112em} .p35{font-size:35px;letter-spacing:0.0115em} .p34{font-size:34px;letter-spacing:0.0117em}
  .p33{font-size:33px;letter-spacing:0.012em} .p32{font-size:32px;letter-spacing:0.0123em} .p31{font-size:31px;letter-spacing:0.0126em} .p30{font-size:30px;letter-spacing:0.0129em}
  .p29{font-size:29px;letter-spacing:0.0132em} .p28{font-size:28px;letter-spacing:0.0134em} .p27{font-size:27px;letter-spacing:0.0137em} .p26{font-size:26px;letter-spacing:0.014em}
</style>
</head>
<body>
  <video class="vid" src="{videoPath}" muted></video>
  <!-- one .cue block per beat goes here, in beat order -->
</body>
</html>
```

`manifest.json` (verbatim, `{DUR}` = `durationSec` from `meta.json`):

```json
{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json
```

## 3. PER-BEAT ASSEMBLY

One `.cue` per beat `{N}` of `word-timings.json`; inside it one `.pg` div per PAGE. A MID page (one with
a successor in the same beat) carries `po` + the fade-out timing; the beat's LAST page has neither and
rides the cue gate. There is NO badge and NO special final page — the last beat is assembled exactly
like every other beat.

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N};animation-delay:{cueDelayMs}ms;animation-duration:{winMs}ms">
  <div class="pg {SIZE} po" style="top:{TOP}px;animation-delay:{pgOutDelayMs}ms;animation-duration:120ms" id="b{N}p1" data-node-id="b{N}p1" data-node-role="text">{word spans}</div>
  <div class="pg {SIZE}" style="top:{TOP}px" id="b{N}p2" data-node-id="b{N}p2" data-node-role="text">{word spans}</div>
</div>
```

(The class + inline `style` come BEFORE `id` on a `.pg` — the `po` attribute block is one string; keep
the emitted order.)

**One word = three stacked copies inside ONE wrapper.** The `.w` wrapper carries the slide only; inside
it, in this order, the heavy ghost, the soft ghost and the sharp ink. All four spans repeat the SAME
`animation-delay`/`animation-duration`; the ghosts add their blur radius inline:

```html
<span class="w" style="animation-delay:{delayMs}ms;animation-duration:{inMs}ms"><span class="g1" style="animation-delay:{delayMs}ms;animation-duration:{inMs}ms;filter:blur({B1}px)">{word}</span><span class="g2" style="animation-delay:{delayMs}ms;animation-duration:{inMs}ms;filter:blur({B2}px)">{word}</span><span class="ik" style="animation-delay:{delayMs}ms;animation-duration:{inMs}ms">{word}</span></span>
```

`{B1}` = `max(2, round(0.09·fs))`, `{B2}` = `max(1, round(0.032·fs))`, with `fs` = the PAGE's font size
in px. The radii are inline and in px because `filter` ignores `em` (section 7) — they cannot ride the
font-size cascade, so every ladder row gets its own pair. The accent word's third copy uses `ia`
instead of `ik` (section 5); the ghosts are identical either way.

**Word prep (before counting anything):** strip a trailing `.` or `,` from each word; keep `?` `!` `'`
and internal punctuation (`£55` stays as is); words keep their original case. GLUE: a token starting
with `-` (e.g. `-do` after `to`) merges with the previous word into ONE unit for paging and counting;
it renders as two adjacent `.w` wrappers — the previous wrapper gets inline `margin-right:0` — each
keeping its OWN verbatim `delayMs`.

**Paging:** a page takes consecutive units, order preserved, while plain chars (unit lengths + 1 per
gap) ≤ 30 AND units ≤ 5; a page that would exceed either cap starts the next page (an oversized first
unit still gets a page of its own).

**Sizing — one `{SIZE}` per page, by EFFECTIVE chars C\*:** C\* = ceil( Σ per char (1.3 if the char
matches `[A-Z0-9£$€@#%&]`, else 1) + 1 per inter-unit gap ). The 1.3 weight budgets the wide
caps/digits (measured Inter-700: lowercase 0.512em/char, caps 0.675em/char). The ladder is HALF the old
display sizes — the line now fills roughly 570px of the 1140px box:

| C\* ≤9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 |
|------|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| p118 | p108 | p98 | p90 | p83 | p77 | p72 | p67 | p63 | p60 | p57 | p54 | p51 | p49 | p47 | p45 |

| C\* 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38 | 39 | ≥40 |
|------|----|----|----|----|----|----|----|----|----|----|----|----|----|----|-----|
| p43 | p41 | p40 | p38 | p37 | p36 | p35 | p34 | p33 | p32 | p31 | p30 | p29 | p28 | p27 | p26 |

**Tracking is a function of SIZE, not a constant** — the eye reads inter-letter distance non-linearly,
so tracking tightens as type grows and opens as it shrinks. It is LINEAR between the ladder's two ends
and baked into each size class (never on `.pg`):

```
letter-spacing = round4( 0.014 + (fs − 26)·(−0.026/92) ) em     ← −0.012em at p118, +0.014em at p26
```

**Page placement:** `{TOP}` = round(360 − 0.65·fs) with fs = the `{SIZE}` class's px — the single
nowrap line optically centered on the frame's vertical middle (360). Left/width are fixed by `.pg`.

**Worked example** (beat 2 of the 14-beat landscape-main run; 9 words `And I had to pay £55 to buy
one`, cueDelayMs 1720, next beat 4600 → winMs 2880, cueEnd 4600): pages: `And I had to pay` (chars 16,
5 units — adding `£55` would make 6) then `£55 to buy one` (14, 4 units). p1 C\* = ceil(3.3+1.3+3+2+3
+4 gaps) = ceil(16.6) = 17 → p63, top = round(360 − 0.65·63) = 319, ghosts blur(6px)/blur(2px); p2
C\* = ceil(3.9+2+3+3+3) = ceil(14.9) = 15 → p72, top 313, ghosts blur(6px)/blur(2px). p1 fades out at
max(2720−120, 2240) = 2600 for 120ms (`£55` starts p2 at 2720); p2 is the beat's last page — no fade,
the gate cuts it at 4600. `one`@4360: avail = 240 → inMs = 260; `buy`@4120: avail 480 → 400; every
earlier word 560. Accent = `£55` (digit rule) → its ink copy is `ia`, everything else `ik`.

## 4. WORDS + TIMING

- Delays are absolute on the single timeline — paste as-is from `runs/<key>/word-timings.json`, never
  re-zero, never invent.
- **Gate windows:** `{winMs}` = next beat's `cueDelayMs` − this beat's; the LAST beat runs to the video
  end: round(`durationSec` × 1000) − its `cueDelayMs`. There is no beat-1 special case (the blue
  backdrop it existed for is gone).
- cueEnd = `cueDelayMs` + `{winMs}` (beat-level). Per word: avail = cueEnd − `delayMs`;
  `{inMs}` = min(560, max(260, avail − 80)). The reveal is longer than a pop — a focus pull needs room
  to resolve — but it still compresses so a late word lands before its gate cuts it.
- Word spacing is the `.w` `margin-right: 0.3em` — inter-span whitespace is dropped by the engine;
  write spans adjacent with no whitespace between them.
- **Turn-taking:** a MID page gets `po` with `animation-delay` = max(nextStart − 120, its own last
  word's `delayMs`) and `animation-duration: 120ms`, nextStart = the successor page's first word
  `delayMs` — the fade COMPLETES at the successor's start. The beat's LAST page holds; the cue gate
  cuts it.
- The slide is 28px of right-to-left travel at the reference canvas (it scales with SCALE) on
  `cubic-bezier(0.215, 0.61, 0.355, 1)`, ending at `translateX(0px)` — identity, always.

## 5. EMPHASIS

Exactly ONE accent unit per beat — EVERY beat, including the first and the last. Pick rule, no
judgment: a digit-bearing unit first (the first one), else the unit with the most chars (punctuation
counted), tie → the later unit. The accent is a LUMINANCE step, not a hue: its span(s) render their
sharp copy with class `ia` (`#f5f5f7`, contact shadow alpha 0.34) instead of `ik`
(`rgba(245,245,247,0.9)`, alpha 0.3). Nothing else about the accent differs — same ghosts, same
timings, same size. There is no coloured flash copy anywhere in this recipe.

## 6. VERIFY LOOP

Run (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Otherwise apply the MECHANICAL fix for the named element and re-run; at most 2 fix
cycles:
- `FAIL[bounds] #b{N}p{P} … left/right outside` → that page's `{SIZE}` one column RIGHT in its
  section-3 table (next smaller class); `{TOP}`, the class's tracking and BOTH ghost radii recompute
  from the new fs.
- `FAIL[bounds] … top/bottom outside` → re-check `{TOP}` = round(360 − 0.65·fs) against the class
  actually emitted.
- `FAIL[never-visible] #b{N}p{P}` → re-check the page's word delays sit inside ITS beat's cue window,
  the cue carries inline `z-index:{10+N}`, and the ghosts kept their explicit `z-index` 3/2 (a
  positioned element animating opacity with none falls under the video).
- `FAIL[occluded] #b{N}p{P}` → cue windows overlap: re-check every `{winMs}` formula (section 4) and
  that cue z-indexes are exactly `10+N` in beat order.

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --progress-output --record {repo}/runs/<key>/final/out.silent.mp4
```

`manifest.json`, verbatim shape (`{DUR}` = `durationSec` from `meta.json`):

```json
{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json
```

## 7. DO NOT

- **ENGINE FACT A — never replace the stepped pull with a blur keyframe.** Measured on a fixture: an
  ANIMATED `filter: blur()` renders its END state from frame one on this engine — exactly like animated
  `clip-path`. Only a STATIC filter renders. `opacity` and `transform` in the SAME keyframes interpolate
  normally, which is why the ramp is a RELAY of opacity across three statically-blurred copies. A
  `@keyframes` that interpolates `filter` would render as a permanently blurred word, not as a pull.
  This is not a simplification opportunity — it is the only way the effect exists.
- **ENGINE FACT B — filter lengths are px, never `em`.** Measured on the same fixture: `blur(0.2em)`
  renders perfectly SHARP while the equivalent `blur(23.6px)` renders. So the defocus cannot ride the
  font-size cascade: both radii are computed per ladder row from that row's px size
  (`max(2, round(0.09·fs))` / `max(1, round(0.032·fs))`) and written INLINE on the ghost spans. Never
  move them into a class, never express them in `em`.
- No fonts, colors, shadows, sizes, or keyframes beyond this sheet — Inter 700, ONE off-white
  `#f5f5f7` at two luminance levels (plus the two ghost alphas), `cueWin`/`pgOut`/`wIn`/`g1In`/`g2In`/
  `ikIn` and the single p-ladder are the whole system. NO hue anywhere: no blue, no black ink, no
  coloured accent copy.
- Never bring back a plate: no `.frame`, no `.card`, no `#blue` backdrop, no closing `.badge` and no
  badge f-ladder. The footage is full-bleed at z0 with type straight on it, first beat to last.
- The wrapper `.w` carries the SLIDE only — never add opacity to it, or that opacity multiplies into
  the ghosts and flattens the pull into a glow. Never put a `text-shadow` on a ghost (a shadow under a
  blurred copy is what reads as grime); the ink's single tight contact shadow is the only shadow.
- Never re-double the type ladder or set a constant `letter-spacing` on `.pg`: tracking is a function
  of size and lives on the size class.
- No per-word or per-line fade-outs beyond the single 120ms page-out; the beat's last page rides the
  cue gate.
- No invented timing: every `delayMs`/`cueDelayMs` comes VERBATIM from `word-timings.json`; derived
  numbers ONLY via the closed forms in sections 3-5.
- No flex anywhere (pages are absolute full-width `text-align:center` blocks); spans stay
  `display:inline-block`; `line-height: 1.3` on `.pg` is the mid-reveal shear headroom — never tighten
  it. Every animated transform ENDS at identity.
- No `var()` in transforms or keyframes; no `vw` font sizes; no descendant selectors — flat classes
  only.
- Never read the video frames; never re-derive layout; no redesign after a render or verify failure —
  only the mechanical fixes in section 6.
