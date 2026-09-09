# RECIPE — template-042 (9:16 · 736×1312 @ 30fps) — Driftwood

RESOLUTION: px below are authored at the source template's own canvas, 480×864; the compiled module
scales them per run (`pipeline/recipes/template-lib.ts`, `canvasFor`): portrait SCALE = W/480 for sizes
and horizontal offsets, H/864 for vertical anchors; landscape SCALE = (H/864)×1.6. `em` values and ms
timings never scale; the manifest carries the run's real W/H. The reference 9:16 canvas 736×1312 is
SCALE 1.533. The shell (reset · body · .vid · cueWin/.cue · .pg with pgOn/pgOff/pgMid) is the shared
one in `template-lib.ts` `docShell`; the SKELETON lists what this recipe adds.

## 1. IDENTITY

Dark slate Instrument Sans typed glyph by glyph (36ms) in a fixed centred block below mid-frame, a
thin grey-blue caret trailing each glyph and parking after the word until the next one types; the
beat's strongest word switches to Instrument Serif italic on the same baseline. Type is grounded by
the preset's shadow stack: one soft dark drop shadow under three widening cream glows, never a plate.

## 2. SKELETON

```
fonts: Instrument+Sans:wght@500 · Instrument+Serif:ital@1
.cap { left:96px; top:646px; width:288px; center; 'Instrument Sans' 500; letter-spacing:.0081em; color:#1A2A2F;
       text-shadow: 0 5px 6px rgba(26,42,47,.65), 0 0 7px rgba(251,244,222,.35), 0 0 12px rgba(251,244,222,.25), 0 0 17px rgba(251,244,222,.2) }
.cl { block; line-height:45px }   .g { inline-block; opacity:0; animation:capG 100ms cubic-bezier(.2,.7,.3,1) forwards }
.acc { 'Instrument Serif'; italic }
.cur { inline-block; width:2px; height:.8em; margin:0 -3px 0 1px; background:#4C6274; opacity:0; animation:capCur linear forwards }
@keyframes capCur { 0%,99.9%{opacity:.82} 100%{opacity:0} }
```

## 3. PER-BEAT ASSEMBLY

- 34px; advance 0.52em → maxChars = floor(288 / (0.52 × 34)) = 16 per line, 2 lines a page (cap
  2×maxChars − 2, 9 units); overflow → demote ×0.92 (pitch scales with the font).
- Shadow stack = the preset's four layers, blur and offset as fractions of the 480px canvas width
  (0.012 / 0.015 / 0.025 / 0.035 blur, 0.01 offset).

## 4. WORDS + TIMING

One span per word (glyph spans where the recipe types), `animation-delay` = `delayMs` VERBATIM; the cue gets `{cueDelayMs}` and a window running to the next beat's start (the last beat to the video's end). Mid-beat pages switch at the successor's first word.

## 5. EMPHASIS

Glyph k of a word fires at `delayMs` + 36k; its caret runs to the next glyph, the word's last caret to the next word (or the page end). Accent = `accentIndex` → `.acc` on every glyph of the unit.

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
