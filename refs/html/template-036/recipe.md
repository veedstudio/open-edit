# RECIPE — template-036 (9:16 · 736×1312 @ 30fps) — Monogram

RESOLUTION: px below are authored at the source template's own canvas, 480×864; the compiled module
scales them per run (`pipeline/recipes/template-lib.ts`, `canvasFor`): portrait SCALE = W/480 for sizes
and horizontal offsets, H/864 for vertical anchors; landscape SCALE = (H/864)×1.6. `em` values and ms
timings never scale; the manifest carries the run's real W/H. The reference 9:16 canvas 736×1312 is
SCALE 1.533. The shell (reset · body · .vid · cueWin/.cue · .pg with pgOn/pgOff/pgMid) is the shared
one in `template-lib.ts` `docShell`; the SKELETON lists what this recipe adds.

## 1. IDENTITY

Cream IBM Plex Mono caps in a left-aligned block just below centre, wide tracking and open leading,
words rising 7px in; the beat's keyword flips to rust on a cream chip in-line, and the beat's strongest
word leaves the caption as huge dark-plum Bodoni Moda wall type across the top of the frame (drawn on
top; the source composited it behind the presenter).

## 2. SKELETON

```
fonts: IBM+Plex+Mono:wght@400;700 · Bodoni+Moda:wght@900
.cap { left:40px; top:544px; width:384px; left; 'IBM Plex Mono' 400; letter-spacing:.09em; line-height:1.45; color:#F6EDDF;
       text-shadow:0 3px 14px rgba(4,2,4,.38), 0 2px 3px rgba(4,2,4,.3) }
.w { inline-block; pre; opacity:0; animation:wIn 260ms cubic-bezier(.2,.7,.3,1) forwards }  @keyframes wIn { from{opacity:0; translateY(7px)} }
.pve { 700; color:#B25430; background:#F6EDDF; border-radius:3px; line-height:1; padding:.13em .2em .03em; margin:0 -.06em; text-shadow:none }
.mon { absolute; z-index:3; pre; opacity:0; animation:cueWin linear forwards }
.moni { inline-block; opacity:0; 'Bodoni Moda' 900; line-height:1; letter-spacing:.015em; padding:.06em 0 .18em; color:#25192B;
        animation:monIn 540ms cubic-bezier(.16,.84,.3,1) both }  @keyframes monIn { from{opacity:0; translateY(20px)} }
```

## 3. PER-BEAT ASSEMBLY

- Caption 30px; advance 0.69em → maxChars = floor(384 / (0.69 × 30)) = 18 per line, 2 lines a page (cap
  2×maxChars − 2, 8 units); overflow → demote ×0.92.
- Wall type at left 38 / top 128: 132px Bodoni, advance 0.62em, shrunk to fit 404px; window from the
  word's delay to the beat's end.

## 4. WORDS + TIMING

One span per word (glyph spans where the recipe types), `animation-delay` = `delayMs` VERBATIM; the cue gets `{cueDelayMs}` and a window running to the next beat's start (the last beat to the video's end). Mid-beat pages switch at the successor's first word.

## 5. EMPHASIS

Wall = `accentIndex` of beats with ≥ 4 units, REMOVED from the caption, trailing punctuation dropped. Chip = `accentIndex` of the remaining caption units.

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
