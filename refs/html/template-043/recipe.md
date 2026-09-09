# RECIPE — template-043 (9:16 · 736×1312 @ 30fps) — Script hero

RESOLUTION: px below are authored at the source template's own canvas, 480×864; the compiled module
scales them per run (`pipeline/recipes/template-lib.ts`, `canvasFor`): portrait SCALE = W/480 for sizes
and horizontal offsets, H/864 for vertical anchors; landscape SCALE = (H/864)×1.6. `em` values and ms
timings never scale; the manifest carries the run's real W/H. The reference 9:16 canvas 736×1312 is
SCALE 1.533. The shell (reset · body · .vid · cueWin/.cue · .pg with pgOn/pgOff/pgMid) is the shared
one in `template-lib.ts` `docShell`; the SKELETON lists what this recipe adds.

## 1. IDENTITY

Centred EB Garamond caps typed glyph by glyph (34ms) with a honey caret, in a lockup of two blocks:
the words before the beat's strongest word in the upper block, the words after it in the lower one,
and the word itself handwritten between them in large honey Pinyon Script, scaling in over 640ms. The
closing beat's hero is set larger.

## 2. SKELETON

```
fonts: EB+Garamond:wght@600 · Pinyon+Script
.cap { left:53px; right:53px; center; 'EB Garamond' 600; letter-spacing:.06em; line-height:1.3; color:#F7F0E4;
       text-shadow:0 2px 9px rgba(4,3,2,.38), 0 1px 2px rgba(4,3,2,.3) }   upper block bottom:328px · lower block bottom:152px
.g { inline-block; opacity:0; animation:capG 120ms cubic-bezier(.2,.7,.3,1) forwards }
.cur { inline-block; width:2px; height:.85em; margin-left:2px; text-bottom; background:#FBF684; opacity:0; animation:capCur linear forwards }
.hrow { absolute; left:0; width:480px; top:540px; center; nowrap; z-index:3; 'Pinyon Script'; line-height:1.2; color:#FBF684;
        text-shadow:0 3px 15px rgba(4,3,2,.38), 0 2px 3px rgba(4,3,2,.3) }
.hw { inline-block; opacity:0; transform-origin:50% 60%; animation:heroIn 640ms cubic-bezier(.2,.7,.3,1) both }  @keyframes heroIn { 0%{opacity:0; scale(.94)} }
```

## 3. PER-BEAT ASSEMBLY

- 26px; advance 0.56em → maxChars = floor(374 / (0.56 × 26)) = 25 per line; each block ≤ 2 lines;
  overflow of either → demote ×0.92 (5 rows). Each block is its own gate from its first word to the
  beat's end.
- Hero 72px (88px on the last beat) Pinyon, lowercase, advance 0.42em, shrunk to fit 432px.

## 4. WORDS + TIMING

One span per word (glyph spans where the recipe types), `animation-delay` = `delayMs` VERBATIM; the cue gets `{cueDelayMs}` and a window running to the next beat's start (the last beat to the video's end). Mid-beat pages switch at the successor's first word.

## 5. EMPHASIS

Hero = `accentIndex` of beats with ≥ 2 units, REMOVED from the caption. The caret after each word runs from the word's delay to the next word's (the block's last to the beat's end).

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
