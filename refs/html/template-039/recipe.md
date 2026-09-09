# RECIPE — template-039 (9:16 · 736×1312 @ 30fps) — Headline stack

RESOLUTION: px below are authored at the source template's own canvas, 480×864; the compiled module
scales them per run (`pipeline/recipes/template-lib.ts`, `canvasFor`): portrait SCALE = W/480 for sizes
and horizontal offsets, H/864 for vertical anchors; landscape SCALE = (H/864)×1.6. `em` values and ms
timings never scale; the manifest carries the run's real W/H. The reference 9:16 canvas 736×1312 is
SCALE 1.533. The shell (reset · body · .vid · cueWin/.cue · .pg with pgOn/pgOff/pgMid) is the shared
one in `template-lib.ts` `docShell`; the SKELETON lists what this recipe adds.

## 1. IDENTITY

Heavy italic Jost caps, every word on a square red plate with an offset black shadow box, stacked
left from mid-frame and rising in; the beat's strongest word stamps in at 1.37× black-on-yellow with an
overshoot, and a number takes the 2.2× bleed plate that runs off the left edge.

## 2. SKELETON

```
fonts: Jost:ital,wght@1,900
.stack { left:26px; right:26px; top:520px; z-index:2; 'Jost' italic 900; left }   .ln { block; line-height:1; padding-bottom:9px }
.w { inline-block; bottom; margin-right:9px; opacity:0; forwards; pre; transform-origin:left center }   .bleed { margin-left:-26px }
.rc { 54px; letter-spacing:-.015em; padding:4px 10px 6px; background:#FF1F0F; color:#FFF; box-shadow:5px 5px 0 #0A0A0A; animation:wIn 130ms cubic-bezier(.16,.84,.3,1) }
.rh { 74px; letter-spacing:-.025em; padding:6px 14px 9px; background:#E9FF00; color:#0A0A0A; box-shadow:7px 7px 0 #0A0A0A; animation:hIn 210ms cubic-bezier(.34,1.3,.64,1) }
.rb { 118px; letter-spacing:-.035em; padding:9px 22px 14px; background:#E9FF00; color:#0A0A0A; box-shadow:11px 11px 0 #0A0A0A; animation:hIn 300ms }
@keyframes wIn { from{opacity:0; translateY(.24em)} }  @keyframes hIn { from{opacity:0; scale(.8)} }
```

## 3. PER-BEAT ASSEMBLY

- Plate width = chars × 0.6em × rung font + rung padding (20 / 28 / 44px), 9px gap; lines wrap to
  428px, 2 lines a page (cap 22 chars, 5 units); overflow → demote ×0.92 (all rungs together).

## 4. WORDS + TIMING

One span per word (glyph spans where the recipe types), `animation-delay` = `delayMs` VERBATIM; the cue gets `{cueDelayMs}` and a window running to the next beat's start (the last beat to the video's end). Mid-beat pages switch at the successor's first word.

## 5. EMPHASIS

Hero = `accentIndex`: digit-bearing → `.rb` (bleed when it starts its line), else `.rh`; every other word `.rc`.

## BOUNDED VARIETY

None.

## 6. VERIFY LOOP

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```
bounds on a `b{N}…` id → the runner demotes that beat one row (font × 0.92, capacities recomputed) and
regenerates; ≤ 2 cycles → `--record`. Manifest: `{"render":{"width":W,"height":H,"fps":FPS,"duration":DUR}}`.
Ids sit on the element that wraps the text; demotion is keyed per beat.

## 7. DO NOT

No fonts, colours or keyframes beyond this sheet; no invented timing; no reading the frames; no depth
compositing (layers the source composited behind the presenter are drawn on top here); never hand-edit
the output.
