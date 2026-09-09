# RECIPE — template-038 (9:16 · 736×1312 @ 30fps) — Ledgerboard

RESOLUTION: px below are authored at the source template's own canvas, 480×864; the compiled module
scales them per run (`pipeline/recipes/template-lib.ts`, `canvasFor`): portrait SCALE = W/480 for sizes
and horizontal offsets, H/864 for vertical anchors; landscape SCALE = (H/864)×1.6. `em` values and ms
timings never scale; the manifest carries the run's real W/H. The reference 9:16 canvas 736×1312 is
SCALE 1.533. The shell (reset · body · .vid · cueWin/.cue · .pg with pgOn/pgOff/pgMid) is the shared
one in `template-lib.ts` `docShell`; the SKELETON lists what this recipe adds.

## 1. IDENTITY

Dark Plex Mono caps on sharp cream chips, one chip per word popping in, stacked left in a block low
in the frame; the beat's strongest word leaves the chips and lands as huge cream Anton wall type at the
top of the frame with a soft drop shadow (drawn on top; the source composited it behind the presenter).

## 2. SKELETON

```
fonts: IBM+Plex+Mono:wght@600 · Anton
.blk { width:412px; z-index:2 }  .ln { block; height:45px; line-height:45px }  (second line margin-top:5px)
.w { inline-block; top; opacity:0; pre; 'IBM Plex Mono' 600; letter-spacing:.06em; line-height:1; color:#1A1512; background:#F0E6D2;
     padding:9px 10px; margin-right:7px; box-shadow:0 3px 10px rgba(24,23,21,.32); animation:chipIn 190ms cubic-bezier(.2,.7,.3,1) both }
@keyframes chipIn { from{opacity:0; translateY(7px)} }
.wall { absolute; z-index:3; opacity:0; nowrap; line-height:1; padding:.1em 0 .15em; 'Anton'; letter-spacing:-.02em; color:#F0E6D2;
        text-shadow:0 3px 22px rgba(24,23,21,.55), 0 1px 5px rgba(24,23,21,.4); animation:wallIn 340ms cubic-bezier(.16,1,.3,1) both }
@keyframes wallIn { from{opacity:0; translateY(18px)} }
```

## 3. PER-BEAT ASSEMBLY

- Chip width = chars × 0.66em × 27px + 20px, 7px gap; lines wrap to 412px, 2 lines a page (cap 30
  chars, 8 units); overflow → demote ×0.92. Block left 34; top 609 for two lines, 634 for one.
- Wall type 225px Anton (advance 0.46em) shrunk to fit 432px; top 24 at 200px+, else 43; window from
  the word's delay to the beat's end.

## 4. WORDS + TIMING

One span per word (glyph spans where the recipe types), `animation-delay` = `delayMs` VERBATIM; the cue gets `{cueDelayMs}` and a window running to the next beat's start (the last beat to the video's end). Mid-beat pages switch at the successor's first word.

## 5. EMPHASIS

Wall = `accentIndex` of beats with ≥ 2 units, REMOVED from the chips, trailing punctuation dropped.

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
