# RECIPE — template-035 (9:16 · 736×1312 @ 30fps) — Verdict stamp

RESOLUTION: px below are authored at the source template's own canvas, 480×864; the compiled module
scales them per run (`pipeline/recipes/template-lib.ts`, `canvasFor`): portrait SCALE = W/480 for sizes
and horizontal offsets, H/864 for vertical anchors; landscape SCALE = (H/864)×1.6. `em` values and ms
timings never scale; the manifest carries the run's real W/H. The reference 9:16 canvas 736×1312 is
SCALE 1.533. The shell (reset · body · .vid · cueWin/.cue · .pg with pgOn/pgOff/pgMid) is the shared
one in `template-lib.ts` `docShell`; the SKELETON lists what this recipe adds.

## 1. IDENTITY

Condensed all-caps Barlow Semi Condensed captions low in the frame, each word fading and rising in
over 150ms with a hard ink seat and a wide low halo; the beat's strongest word leaves the caption and
slams in above it as an Anton stamp on an orange slab with a hard offset shadow, tilted −2.4° / 1.9°
by beat, a die-drop squash on impact, holding until the beat ends.

## 2. SKELETON

```
fonts: Anton · Barlow+Semi+Condensed:wght@700
.cap { left:53px; right:53px; bottom:150px; center; 'Barlow Semi Condensed' 700; letter-spacing:.03em; color:#F4EFE6;
       text-shadow:0 2px 0 rgba(22,19,15,.92), 0 0 12px rgba(22,19,15,.6) }   .cl { line-height:1.08; padding:1px 0 }
.g { inline-block; opacity:0; animation:capG 150ms cubic-bezier(.2,.7,.3,1) forwards }  @keyframes capG { 0%{opacity:0; translateY(10px)} 100%{opacity:1} }
.st { absolute; left:0; right:0; bottom:243px; flex; center; z-index:6; opacity:0; animation:cueWin linear forwards }
.sr { inline-block; transform:rotate(±) }  .sk { block; 'Anton'; line-height:.86; letter-spacing:-.03em; color:#16130F; background:#FF6A13;
      padding:14px 18px 12px; box-shadow:6px 6px 0 #16130F; animation:stHit 230ms cubic-bezier(.3,.9,.2,1) both }
@keyframes stHit { 0%{scale(1.14,1.3)} 52%{scale(1.03,.93)} 78%{scale(.99,1.02)} 100%{scale(1)} }
```

## 3. PER-BEAT ASSEMBLY

- Caption 30px; advance 0.58em → maxChars = floor(374 / (0.58 × 30)) = 21 per line, 2 lines a page (cap
  2×maxChars − 2 chars, 8 units); overflow → demote ×0.92 per row.
- Stamp 96px Anton, advance 0.5em, shrunk so the slab (36px padding) stays inside 408px; window from the
  word's delay to the beat's end; tilt −2.4° on odd beats, 1.9° on even.

## 4. WORDS + TIMING

One span per word (glyph spans where the recipe types), `animation-delay` = `delayMs` VERBATIM; the cue gets `{cueDelayMs}` and a window running to the next beat's start (the last beat to the video's end). Mid-beat pages switch at the successor's first word.

## 5. EMPHASIS

Stamp = `accentIndex` of beats with ≥ 2 units, REMOVED from the caption; a one-word beat stays in the caption.

## BOUNDED VARIETY

Tilt alternation only.

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
