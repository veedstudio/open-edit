# RECIPE — template-041 (9:16 · 736×1312 @ 30fps) — Standfirst

RESOLUTION: px below are authored at the source template's own canvas, 480×864; the compiled module
scales them per run (`pipeline/recipes/template-lib.ts`, `canvasFor`): portrait SCALE = W/480 for sizes
and horizontal offsets, H/864 for vertical anchors; landscape SCALE = (H/864)×1.6. `em` values and ms
timings never scale; the manifest carries the run's real W/H. The reference 9:16 canvas 736×1312 is
SCALE 1.533. The shell (reset · body · .vid · cueWin/.cue · .pg with pgOn/pgOff/pgMid) is the shared
one in `template-lib.ts` `docShell`; the SKELETON lists what this recipe adds.

## 1. IDENTITY

A centred Fraunces serif block just below mid-frame, one position and one fixed 52px pitch for every
beat; words fade and rise 0.22em into place then hold; the beat's pivot word changes register into the
face's own italic in gold, same size, same baseline.

## 2. SKELETON

```
fonts: Fraunces:ital,wght@0,600;1,600
.cap { left:56px; top:518px; width:368px; center; 'Fraunces' 600; letter-spacing:.004em; color:#F7F1E6;
       text-shadow:0 2px 14px rgba(36,28,21,.62), 0 1px 3px rgba(36,28,21,.5) }   .cl { block; nowrap; line-height:52px }
.w { inline-block; pre; opacity:0; line-height:52px; animation:wordIn 260ms cubic-bezier(.2,.7,.3,1) both }  @keyframes wordIn { 0%{opacity:0; translateY(.22em)} }
.a { italic; color:#FEC719 }
```

## 3. PER-BEAT ASSEMBLY

- 34px; advance 0.5em → maxChars = floor(368 / (0.5 × 34)) = 21 per line, 2 lines a page (cap
  2×maxChars − 2, 9 units); overflow → demote ×0.92 (pitch scales with the font).

## 4. WORDS + TIMING

One span per word (glyph spans where the recipe types), `animation-delay` = `delayMs` VERBATIM; the cue gets `{cueDelayMs}` and a window running to the next beat's start (the last beat to the video's end). Mid-beat pages switch at the successor's first word.

## 5. EMPHASIS

Accent = `accentIndex` → `.a`.

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
