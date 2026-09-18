# RECIPE — template-033 (9:16 · 736×1312 @ 30fps) — Ghost ink

RESOLUTION: px below are authored at the source template's own canvas, 480×864; the compiled module
scales them per run (`pipeline/recipes/template-lib.ts`, `canvasFor`): portrait SCALE = W/480 for sizes
and horizontal offsets, H/864 for vertical anchors; landscape SCALE = (H/864)×1.6. `em` values and ms
timings never scale; the manifest carries the run's real W/H. The reference 9:16 canvas 736×1312 is
SCALE 1.533.

## 1. IDENTITY

The whole beat stands in Newsreader Medium at 42% ink from the cue's start; each word takes on full
ink at the instant it is spoken (260ms ease) and holds. One italic accent per beat. A centred block
hanging from a fixed last baseline in the lower third, warm cream over a soft dark halo. No motion.

## 2. SKELETON

```
<link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,wght@0,500;1,500&display=swap" rel="stylesheet">
<style>
  (universal reset · body · .vid · cueWin/.cue · .pg/pgOn/pgOff as in template-030)
  .cap { left:34px; right:34px; bottom:116px; text-align:center; font-family:'Newsreader'; font-weight:500; letter-spacing:.0038em;
         line-height:1.34; color:#F5EFE4; text-shadow:0 .05em .42em rgba(26,18,11,.62); }
  .cl { display:block; white-space:nowrap; }
  .w { display:inline-block; margin-right:.26em; opacity:.42; animation-name:wLight; animation-timing-function:cubic-bezier(.22,.61,.36,1); animation-fill-mode:forwards; }
  .e { margin-right:0; }  .i { font-style:italic; }
  @keyframes wLight { 0%{opacity:.42} 100%{opacity:1} }
</style>
```

## 3. PER-BEAT ASSEMBLY

```
<div class="cue" id="cue{N}" …>
  <div class="pg cap" id="b{N}p1" style="font-size:40px;opacity:1;">
    <div class="cl" id="b{N}p1l1"><span class="w" id="b{N}w1" style="animation-delay:{delayMs}ms;animation-duration:{lightMs}ms">You</span>…<span class="w e">…</span></div>
  </div>
</div>
```
- Font 40px; advance 0.47em → maxChars = floor(412 / (0.47 × 40)) = 21 per line; a page takes up to
  2×maxChars chars / 10 units and may wrap to 3 lines (the block grows upward). Overflow → demote ×0.92.
- `lightMs` = min(260, cueEnd − delay), never below 60.

## 4. WORDS + TIMING

One span per word at its `delayMs` VERBATIM; the last word of a line carries `.e` (no trailing gap).

## 5. EMPHASIS

Accent = `accentIndex` → `.i` (italic only, same size, same ink).

## BOUNDED VARIETY

None: one face, one size, one motion.

## 6. VERIFY LOOP

```
{engine} {repo}/runs/<key>/final --verify
```
bounds on a `b{N}…` id → the runner demotes that beat one row (font × 0.92, capacities recomputed) and
regenerates; ≤ 2 cycles → `--record`. Manifest: `{"render":{"width":W,"height":H,"fps":FPS,"duration":DUR}}`.
Ids sit on the element that wraps the text (`.cl` lines, `.hw`/`.sw` titles); demotion is keyed per beat.

## 7. DO NOT

No fonts, colours or keyframes beyond this sheet; no invented timing; no reading the frames; no depth
compositing (the source's behind-the-presenter layers are drawn on top here); never hand-edit the output.
