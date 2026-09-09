# RECIPE — template-031 (9:16 · 736×1312 @ 30fps) — Glyph rise + hero

RESOLUTION: px below are authored at the source template's own canvas, 480×864; the compiled module
scales them per run (`pipeline/recipes/template-lib.ts`, `canvasFor`): portrait SCALE = W/480 for sizes
and horizontal offsets, H/864 for vertical anchors; landscape SCALE = (H/864)×1.6. `em` values and ms
timings never scale; the manifest carries the run's real W/H. The reference 9:16 canvas 736×1312 is
SCALE 1.533.

## 1. IDENTITY

All-caps wide-tracked Space Grotesk captions centred low in the frame; each glyph fades and rises
0.42em into place on a 22ms stagger from its word and holds until the cue's cut. The beat's strongest
word leaves the caption and lands at the top as a white Bodoni Moda hero under a rule that draws in
from the left, drifting up 3.5% over the beat.

## 2. SKELETON

```
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=Bodoni+Moda:wght@700&display=swap" rel="stylesheet">
<style>
  (universal reset · body · .vid · cueWin/.cue · .pg/pgOn/pgOff as in template-030)
  .cap { left:24px; right:24px; bottom:150px; text-align:center; font-family:'Space Grotesk'; font-weight:700;
         letter-spacing:0.05em; color:#F5EFE3; line-height:1.25; text-shadow:0 1px 0 rgba(11,14,24,.62), 0 3px 14px rgba(11,14,24,.52); }
  .cl { display:block; }  .u, .sp { display:inline-block; white-space:pre; }
  .g { display:inline-block; opacity:0; animation:capRise 150ms cubic-bezier(.16,.84,.32,1) both; }
  @keyframes capRise { 0%{opacity:0; transform:translateY(.42em)} 100%{opacity:1; transform:none} }
  .hw { position:absolute; left:24px; right:24px; z-index:3; text-align:center; white-space:nowrap; line-height:1.2;
        font-family:'Bodoni Moda'; font-weight:700; color:#FFF; text-shadow:0 2px 0 rgba(11,14,24,.26), 0 12px 30px rgba(11,14,24,.3);
        opacity:0; animation-name:cueWin, heroDrift; animation-fill-mode:forwards, forwards; }
  .hx { display:inline-block; opacity:0; animation:heroIn 300ms cubic-bezier(.16,.84,.32,1) both; }
  .rg { position:absolute; left:0; width:{W}px; height:3px; z-index:2; opacity:0; animation:cueWin linear forwards; }
  .rb { display:block; width:{W}px; height:3px; background:rgba(255,255,255,.92); transform-origin:0 50%; animation:ruleIn 460ms cubic-bezier(.16,.84,.32,1) both; }
  @keyframes heroIn { 0%{opacity:0; transform:translateY(18px) scale(.955)} 100%{opacity:1; transform:none} }
  @keyframes heroDrift { 0%{transform:scale(1)} 100%{transform:scale(1.035)} }
  @keyframes ruleIn { 0%{transform:scaleX(0)} 100%{transform:scaleX(1)} }
</style>
```

## 3. PER-BEAT ASSEMBLY

```
<div class="cue" id="cue{N}" …>
  <div class="rg" id="b{N}r" style="top:{rule}px;animation-delay:{heroStart}ms;animation-duration:{heroDur}ms"><span class="rb" style="animation-delay:{heroStart+40}ms"></span></div>
  <div class="hw" id="b{N}h" style="top:{top}px;font-size:{heroFont}px;letter-spacing:{ls};animation-delay:{heroStart}ms,{heroStart}ms;animation-duration:{heroDur}ms,{heroDur}ms"><span class="hx" style="animation-delay:{heroDelayMs}ms">{HERO}</span></div>
  <div class="pg cap" id="b{N}p1" style="font-size:28px;opacity:1;">
    <div class="cl" id="b{N}p1l1"><span class="u"><span class="g" style="animation-delay:{delayMs}ms">T</span>…</span><span class="sp"> </span>…</div>
  </div>
</div>
```
- Caption font 28px; advance 0.71em (caps + tracking) → maxChars = floor(432 / (0.71 × 28)) = 21 per
  line, 2 lines a page (page cap 2×maxChars − 2 chars, 8 units). Overflow → demote ×0.92 per row.
- Hero rungs by length: ≤4 chars 140px / −0.02em / top 2 / rule 146 · ≤6 chars 100px / −0.015em / top 12 /
  rule 118 · longer 52px / 0.03em / top 25 / rule 86; and never wider than 432px (advance 0.66em).
- Hero window: starts 30ms before the word (clamped to the cue start), runs to the beat's end.

## 4. WORDS + TIMING

Glyph spans: word `delayMs` + 22ms × glyph index, VERBATIM base. Cue delay/duration per beat as in
template-030. The hero's `.hx` fires at the word's own `delayMs`.

## 5. EMPHASIS

Hero = `accentIndex` of beats with ≥ 3 units; it is REMOVED from the caption and drops trailing
sentence punctuation. Beats of 1-2 units keep every word in the caption and draw no hero.

## BOUNDED VARIETY

Hero rung choice follows word length only.

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
