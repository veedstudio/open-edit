# RECIPE — template-040 (9:16 · 736×1312 @ 30fps) — Left block

RESOLUTION: px below are authored at the source template's own canvas, 480×864; the compiled module
scales them per run (`pipeline/recipes/template-lib.ts`, `canvasFor`): portrait SCALE = W/480 for sizes
and horizontal offsets, H/864 for vertical anchors; landscape SCALE = (H/864)×1.6. `em` values and ms
timings never scale; the manifest carries the run's real W/H. The reference 9:16 canvas 736×1312 is
SCALE 1.533. The shell (reset · body · .vid · cueWin/.cue · .pg with pgOn/pgOff/pgMid) is the shared
one in `template-lib.ts` `docShell`; the SKELETON lists what this recipe adds.

## 1. IDENTITY

A left-aligned all-caps Instrument Sans block low in the frame, wide tracking and generous leading;
each word fades and rises 0.3em over 280ms then holds dead still until the cut. The beat's strongest
word takes the mint accent colour and nothing else changes.

## 2. SKELETON

```
fonts: Instrument+Sans:wght@500
.cap { left:44px; right:44px; bottom:132px; left; 'Instrument Sans' 500; letter-spacing:.05em; line-height:1.38; color:#F5F1E6;
       text-shadow:0 2px 14px rgba(20,17,14,.62), 0 1px 3px rgba(20,17,14,.48) }
.g { inline-block; opacity:0; animation:capG 280ms cubic-bezier(.2,.7,.3,1) forwards }  @keyframes capG { 0%{opacity:0; translateY(.3em)} }
.ac { color:#7FD5AA }
```

## 3. PER-BEAT ASSEMBLY

- 36px; advance 0.67em → maxChars = floor(392 / (0.67 × 36)) = 16 per line, 2 lines a page (cap
  2×maxChars − 2, 8 units); overflow → demote ×0.92.

## 4. WORDS + TIMING

One span per word (glyph spans where the recipe types), `animation-delay` = `delayMs` VERBATIM; the cue gets `{cueDelayMs}` and a window running to the next beat's start (the last beat to the video's end). Mid-beat pages switch at the successor's first word.

## 5. EMPHASIS

Accent = `accentIndex` → `.ac` on the unit (colour only).

## BOUNDED VARIETY

None.

## 6. VERIFY LOOP

```
{engine} {repo}/runs/<key>/final --verify
```
bounds on a `b{N}…` id → the runner demotes that beat one row (font × 0.92, capacities recomputed) and
regenerates; ≤ 2 cycles → `--record`. Manifest: `{"render":{"width":W,"height":H,"fps":FPS,"duration":DUR}}`.
Ids sit on the element that wraps the text; demotion is keyed per beat.

## 7. DO NOT

No fonts, colours or keyframes beyond this sheet; no invented timing; no reading the frames; no depth
compositing (layers the source composited behind the presenter are drawn on top here); never hand-edit
the output.
