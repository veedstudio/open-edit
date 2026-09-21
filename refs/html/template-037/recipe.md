# RECIPE — template-037 (9:16 · 736×1312 @ 30fps) — Interrupt

RESOLUTION: px below are authored at the source template's own canvas, 480×864; the compiled module
scales them per run (`pipeline/recipes/template-lib.ts`, `canvasFor`): portrait SCALE = W/480 for sizes
and horizontal offsets, H/864 for vertical anchors; landscape SCALE = (H/864)×1.6. `em` values and ms
timings never scale; the manifest carries the run's real W/H. The reference 9:16 canvas 736×1312 is
SCALE 1.533. The shell (reset · body · .vid · cueWin/.cue · .pg with pgOn/pgOff/pgMid) is the shared
one in `template-lib.ts` `docShell`; the SKELETON lists what this recipe adds.

## 1. IDENTITY

A poster per page. Cool-white Plex Mono sentence words rise in on a line above and a line below; the
beat's strongest word interrupts between them as huge dark Anton knocked out of a sharp colour block
that wipes open from the page's own side. Pages alternate left / right by beat (and within a beat); the
block is orange-red, ice-blue on every third beat.

## 2. SKELETON

```
fonts: Anton · IBM+Plex+Mono:wght@600
.ml { absolute; left:34px; width:412px; z-index:2; 'IBM Plex Mono' 600; letter-spacing:.08em; line-height:1.3; color:#E6F1F7; nowrap;
      text-shadow:0 2px 9px rgba(11,11,14,.52), 0 1px 2px rgba(11,11,14,.4) }
.w { inline-block; opacity:0; animation:wIn 220ms cubic-bezier(.2,.7,.3,1) both }  @keyframes wIn { 0%{opacity:0; translateY(9px)} }
.hero { absolute; left:34px; width:412px; z-index:3 }  .sw { inline-block; padding:2px 14px }
.wipeL / .wipeR { clip-path polygon from the side; animation 190ms cubic-bezier(.16,1,.3,1) both }
.sRed { background:#FF2D00 }  .sIce { background:#00E5FF }
.hw { inline-block; 'Anton'; line-height:.8; letter-spacing:.01em; padding:.08em 0 .06em; color:#0B0B0E; nowrap }
```

## 3. PER-BEAT ASSEMBLY

- Line A at top 520, hero at 561, line B at 690. Sentence 18px, advance 0.68em → each line ≤ floor(412 /
  (0.68 × 18)) = 33 chars; a page takes up to 2×maxChars chars / 9 units and splits at its own hero;
  if either line overflows → demote ×0.92 (5 rows).
- Hero 114px Anton, advance 0.46em, shrunk so word + 28px padding ≤ 412px.

## 4. WORDS + TIMING

One span per word (glyph spans where the recipe types), `animation-delay` = `delayMs` VERBATIM; the cue gets `{cueDelayMs}` and a window running to the next beat's start (the last beat to the video's end). Mid-beat pages switch at the successor's first word.

## 5. EMPHASIS

Hero = `accentIndex` of each PAGE (the page's words before it go above, after it below), trailing punctuation dropped.

## BOUNDED VARIETY

Side and colour cycles only.

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
