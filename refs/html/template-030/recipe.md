# RECIPE — template-030 (9:16 · 736×1312 @ 30fps) — Sticker

RESOLUTION: px below are authored at the source template's own canvas, 480×864; the compiled module
scales them per run (`pipeline/recipes/template-lib.ts`, `canvasFor`): portrait SCALE = W/480 for sizes
and horizontal offsets, H/864 for vertical anchors; landscape SCALE = (H/864)×1.6. `em` values and ms
timings never scale; the manifest carries the run's real W/H. The reference 9:16 canvas 736×1312 is
SCALE 1.533.

## 1. IDENTITY

Every word sits on its own rounded sand plate in Baloo 2 ExtraBold, popping in as it is spoken; the
beat's keyword sits in-line on a lavender plate in white italic Fraunces at 1.2×, and the closing beat's
payoff word takes the larger 1.47× plate. Blocks roam: centred, left with a stepped indent, centred,
right, by beat.

## 2. SKELETON

```
<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@800&family=Fraunces:ital,wght@1,900&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:{W}px; height:{H}px; position:relative; overflow:hidden; }
  .vid { position:absolute; inset:0; width:{W}px; height:{H}px; object-fit:cover; z-index:0; }
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position:absolute; inset:0; opacity:0; animation:cueWin linear forwards; }
  .pg { position:absolute; opacity:0; z-index:1; }
  @keyframes pgOn { to{opacity:1} }  @keyframes pgOff { to{opacity:0} }
  .cl { display:block; line-height:1; margin-bottom:8px; }
  .w { display:inline-block; opacity:0; font-family:'Baloo 2'; font-weight:800; letter-spacing:0.012em;
       color:#472B3F; background:#FFF4E1; border-radius:10px; padding:3px 10px 7px; margin:0 3px;
       box-shadow:0 3px 12px rgba(71,43,63,0.4); animation:wIn 240ms cubic-bezier(.2,.7,.3,1) both; }
  .kw { font-family:'Fraunces'; font-style:italic; font-weight:900; color:#FFFFFF; background:#7C5FC9; padding:3px 13px 8px; }
  .pay { font-family:'Fraunces'; font-style:italic; font-weight:900; color:#FFFFFF; background:#7C5FC9; padding:4px 16px 10px; }
  @keyframes wIn { 0%{opacity:0; transform:translateY(0.35em) scale(1.08)} 100%{opacity:1; transform:translateY(0) scale(1)} }
</style>
<video class="vid" src="{videoPath}" muted></video>
```

## 3. PER-BEAT ASSEMBLY

```
<div class="cue" id="cue{N}" style="z-index:{10+N};animation-delay:{cueDelayMs}ms;animation-duration:{winMs}ms;">
  <div class="pg" id="b{N}p1" style="{pos};bottom:{bottom}px;opacity:1;">
    <div class="cl" id="b{N}p1l1"><span class="w" id="b{N}w1" style="font-size:30px;animation-delay:{delayMs}ms">{word}</span>…</div>
  </div>
</div>
```
- Words lowercase. Font 30px; keyword 36px; payoff 44px. Plate width = chars × 0.57em (Fraunces 0.54em)
  + horizontal padding (20 / 26 / 32px) + 6px margin.
- Placement by beat number: alignment cycles centre · left · centre · right; `bottom` cycles
  170 · 195 · 285 · 235 · 260 · 185 px. Left blocks indent line j by 20j px. Measure = 392px.
- Capacity: a page takes up to 12 units / 50 chars; lines wrap by plate width to the measure, max 3
  lines; the payoff word always owns the last line. Overflow → demote (font × 0.92 per row, up to 4).
- Mid-beat pages switch at the successor's first word (`pgOn`/`pgOff`).

## 4. WORDS + TIMING

One span per word, `animation-delay` = `delayMs` VERBATIM; the cue gets `{cueDelayMs}` and a window that
runs to the next beat's start (last beat to the video's end). Inter-word gap is the plate margin.

## 5. EMPHASIS

Keyword = `accentIndex` (digit-bearing unit, else longest, tie → later) → `.kw`. In the LAST beat the
final unit takes `.pay` instead and no keyword is drawn.

## BOUNDED VARIETY

Colours, both fonts and sizes are fixed; the only variety axes are the alignment/bottom cycles above.

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
