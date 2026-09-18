# RECIPE — template-032 (9:16 · 736×1312 @ 30fps) — Typewriter + rotated title

RESOLUTION: px below are authored at the source template's own canvas, 480×864; the compiled module
scales them per run (`pipeline/recipes/template-lib.ts`, `canvasFor`): portrait SCALE = W/480 for sizes
and horizontal offsets, H/864 for vertical anchors; landscape SCALE = (H/864)×1.6. `em` values and ms
timings never scale; the manifest carries the run's real W/H. The reference 9:16 canvas 736×1312 is
SCALE 1.533.

## 1. IDENTITY

Right-aligned Archivo SemiBold captions in the lower third with a per-glyph typewriter fade on a 30ms
stagger, warm cream ink over a soft shadow. The beat's strongest word leaves the caption and runs down
a frame edge as a giant acid-green Cinzel Black title rotated 90°, glyphs sliding in on a 48ms stagger;
the edge alternates left / right every two beats.

## 2. SKELETON

```
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@600&family=Cinzel:wght@900&display=swap" rel="stylesheet">
<style>
  (universal reset · body · .vid · cueWin/.cue · .pg/pgOn/pgOff as in template-030)
  .cap { left:29px; right:29px; bottom:190px; text-align:right; font-family:'Archivo'; font-weight:600; letter-spacing:.0081em;
         color:#F4EDDF; line-height:1.28; text-shadow:0 2px 9px rgba(2,2,1,.38), 0 1px 2px rgba(2,2,1,.3); }
  .cl { display:block; }  .u, .sp { display:inline-block; white-space:pre; }
  .g { display:inline-block; opacity:0; animation:capG 120ms cubic-bezier(.2,.7,.3,1) forwards; }
  @keyframes capG { from{opacity:0} to{opacity:1} }
  .swg { position:absolute; inset:0; z-index:3; opacity:0; animation:cueWin linear forwards; }
  .sw { position:absolute; transform-origin:0 0; transform:rotate(90deg); white-space:nowrap; font-family:'Cinzel'; font-weight:900;
        letter-spacing:.01em; color:#96FF1A; text-shadow:0 4px 18px rgba(2,2,1,.38), 0 2px 4px rgba(2,2,1,.3); }
  .sc { display:inline-block; opacity:0; animation:scIn 380ms cubic-bezier(.16,.84,.28,1) both; }
  @keyframes scIn { 0%{opacity:0; transform:translateX(-.16em)} 100%{opacity:1; transform:none} }
</style>
```

## 3. PER-BEAT ASSEMBLY

```
<div class="cue" id="cue{N}" …>
  <div class="swg" id="b{N}t" style="animation-delay:{titleStart}ms;animation-duration:{titleDur}ms"><div class="sw" style="left:{left}px;top:64px;font-size:{titleFont}px"><span class="sc" style="animation-delay:{delayMs}ms">E</span>…</div></div>
  <div class="pg cap" id="b{N}p1" style="font-size:34px;opacity:1;"><div class="cl" id="b{N}p1l1">…glyph units…</div></div>
</div>
```
- Caption font 34px; advance 0.56em → maxChars = floor(422 / (0.56 × 34)) = 22 per line, 2 lines a page
  (page cap 2×maxChars − 2, 9 units). Overflow → demote ×0.92 per row.
- Title: 72px, uppercase, advance 0.75em; runs downward from top 64px; shrinks so chars × 0.75em ≤ 760px.
  `left` is the title's right edge (rotation about its top-left): 94px for beats 1-2, 476px for 3-4,
  alternating every two beats.
- Title window: starts 70ms before the word (clamped to the cue start), runs to the beat's end.

## 4. WORDS + TIMING

Glyph spans: word `delayMs` + 30ms × glyph index (caption) / + 48ms × glyph index (title), VERBATIM
base. Caption casing is the transcript's own.

## 5. EMPHASIS

Title = `accentIndex` of beats with ≥ 3 units; REMOVED from the caption; trailing sentence punctuation
dropped. Beats of 1-2 units draw no title.

## BOUNDED VARIETY

Side alternation is the only variety axis.

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
