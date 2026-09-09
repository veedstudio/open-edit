# RECIPE — template-034 (9:16 · 736×1312 @ 30fps) — Countdown board

RESOLUTION: px below are authored at the source template's own canvas, 480×864; the compiled module
scales them per run (`pipeline/recipes/template-lib.ts`, `canvasFor`): portrait SCALE = W/480 for sizes
and horizontal offsets, H/864 for vertical anchors; landscape SCALE = (H/864)×1.6. `em` values and ms
timings never scale; the manifest carries the run's real W/H. The reference 9:16 canvas 736×1312 is
SCALE 1.533.

## 1. IDENTITY

Archivo Black caps on a left-aligned board, one or two words a line, white with a hard 3×4px offset
shadow; each word rises 0.3em in. The beat's strongest word pops in on a yellow plate (overshoot
ease), and the closing beat's short tail after its last sentence end lands on red plates at 72px, one
word a line. When the opening beat announces a count ("three ways", "5 tips"), the beats that follow
carry giant red numerals top-right.

## 2. SKELETON

```
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&display=swap" rel="stylesheet">
<style>
  (universal reset · body · .vid · cueWin/.cue · .pg as in template-030)
  .board { left:34px; bottom:210px; width:392px; z-index:2; }
  .cl  { display:block; text-align:left; font-family:'Archivo Black'; letter-spacing:-.02em; line-height:1; padding:0 0 6px; }
  .clC { display:block; text-align:left; font-family:'Archivo Black'; letter-spacing:-.03em; line-height:1; padding:0 0 9px; }
  .w { display:inline-block; opacity:0; line-height:1; margin-right:.22em; padding:5px 0 10px; color:#FFF;
       text-shadow:3px 4px 0 #101010, 0 3px 13px rgba(25,25,25,.38), 0 1px 3px rgba(25,25,25,.3);
       animation:wIn 200ms cubic-bezier(.2,.7,.3,1) both; }
  @keyframes wIn { 0%{opacity:0; transform:translateY(.3em)} 100%{opacity:1; transform:none} }
  .hl { background:#FFE500; color:#101010; padding:5px 11px 10px; text-shadow:none; box-shadow:(the .w shadow); animation-name:wPop; animation-duration:260ms; animation-timing-function:cubic-bezier(.34,1.4,.64,1); }
  .cta { background:#FF2E12; color:#101010; padding:6px 13px 12px; text-shadow:none; box-shadow:4px 5px 0 #101010, …; animation-name:wPop; … }
  @keyframes wPop { 0%{opacity:0; transform:translateY(.18em) scale(.86)} 100%{opacity:1; transform:none} }
  .lead { margin-left:-11px; }  .leadC { margin-left:-13px; }
  .idx { position:absolute; right:34px; top:34px; width:380px; text-align:right; z-index:3; }
  .ig { display:inline-block; opacity:0; line-height:1; padding:0 0 .06em; font-family:'Archivo Black'; letter-spacing:-.045em; color:#FF2E12;
        text-shadow:0 7px 32px rgba(25,25,25,.38), 0 4px 7px rgba(25,25,25,.3); animation:idxIn 420ms cubic-bezier(.2,.7,.3,1) both; }
  @keyframes idxIn { 0%{opacity:0; transform:translateY(26px) scale(1.06)} 100%{opacity:1; transform:none} }
</style>
```

## 3. PER-BEAT ASSEMBLY

```
<div class="cue" id="cue{N}" …>
  <div class="idx" id="b{N}n" style="font-size:340px"><span class="ig" style="animation-delay:{cueDelayMs}ms">{numeral}</span></div>
  <div class="pg board" id="b{N}p1" style="animation:cueWin linear forwards;animation-delay:{firstDelayMs}ms;animation-duration:{pageMs}ms;">
    <div class="cl" id="b{N}p1l1" style="font-size:52px"><span class="w hl lead" id="b{N}w1" style="animation-delay:{delayMs}ms">TWICE</span></div>
    <div class="cl" id="b{N}p1l2" style="font-size:52px">…</div>
  </div>
</div>
```
- Font 52px; advance 0.70em → maxChars = floor(392 / (0.70 × 52)) = 10 per line, 2 lines a page (page
  cap 2×maxChars − 1 chars, 4 units). Overflow (a line over maxChars) → demote ×0.92, up to 5 rows.
- Each page is its own gate: from its first word to the next page's first word (last page → cue end).
- CTA: in the LAST beat, the units after its last sentence end (≤ 2 units, each ≤ 7 chars) form the final
  page, one unit a line at 72px (`.clC`) on `.cta` plates.
- Numerals: count = the first number word / digit (> 1) in beat 1; beat k (2 ≤ k ≤ count + 1) shows
  k − 1 at 340px (two digits at 238px). No announced count → no numerals.

## 4. WORDS + TIMING

One span per word at its `delayMs` VERBATIM; the numeral fires at the beat's `cueDelayMs`.

## 5. EMPHASIS

Plate word = `accentIndex` → `.hl` (+ `.lead` when it starts its line). CTA plates as above.

## BOUNDED VARIETY

None beyond the count-driven numerals.

## 6. VERIFY LOOP

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```
bounds on a `b{N}…` id → the runner demotes that beat one row (font × 0.92, capacities recomputed) and
regenerates; ≤ 2 cycles → `--record`. Manifest: `{"render":{"width":W,"height":H,"fps":FPS,"duration":DUR}}`.
Ids sit on the element that wraps the text (`.cl` lines, `.hw`/`.sw` titles); demotion is keyed per beat.

## 7. DO NOT

No fonts, colours or keyframes beyond this sheet; no invented timing; no reading the frames; no depth
compositing (the source's behind-the-presenter layers are drawn on top here); never hand-edit the output.
