# DIRECTOR — the engine contract (read this + your execution contract)

You are executing the DESIGN + RENDER pass for ONE short-form video. Usually that means ONE continuous
captioned composition over the real footage, rendered to an MP4. Author it as a single `.wv`
document (HTML/CSS, a Chrome subset rendered by `veed-engine-cli`) that plays across the WHOLE clip —
each spoken caption shown only in its own cue window. No per-beat files: one timeline,
one render.

**A `.wv` is an extension of CSS and can be treated as such** — an HTML fragment plus a `<style>` block,
standard CSS throughout, no JavaScript and no proprietary timeline format. The motion IS CSS motion:
`@keyframes` + `animation` + `animation-delay` are the timeline. So everything you already know about CSS
applies directly here; the only thing to learn is which parts of it this engine does not implement (ENGINE
LIMITS below).

Footage is a LAYER in that document, never a prerequisite for it. A run with no source video (motion
graphics, stills, slides, generated imagery) authors the same single `.wv` with no footage layer, and every
rule below applies to it unchanged.

Commit ONE design system in a single pass — do NOT re-litigate the aesthetic once chosen. You verify with
`veed-engine-cli --verify` (an analytic playback check — see RENDER + VERIFY), then render. You do NOT
extract frames / eyeball the video / run any visual self-check unless the execution contract EXPLICITLY tells you
to. You do not redesign based on renders, run legibility passes, or chase timing.

Your execution contract (the filled step-4B contract from the SKILL) gives: the run dir, `meta.json` (canvas W/H/fps + `durationSec` + all paths),
`transcript.json` (captions + windows), the USER'S MATERIALS (their reference/brand/concept — the design
authority) plus 1-2 recipe SHEETS as craft substrate, the video path, the DIRECTION, the ENGAGEMENT mode,
and the ANIMATION LEVEL. `analysis.json` (per-beat composition facts) exists ONLY on style-refine runs — when
present it is authoritative for placement; when absent, place by the safe margins below.
With no source video there is no `meta.json`, `transcript.json` or video path to hand you: the contract
carries the canvas, the duration and the content from the ASK instead, and there are no cue windows to
honour. That is a complete contract, not a missing one — proceed on it.

(Recipe-backed picks never reach this pass: recipes are compiled code — `refs/html/<id>/recipe.ts`, run
by `pipeline/scripts/generate-recipe.ts` — so you execute this contract only for a CREATIVE run: face-1 (the user
brought their own reference/brand/concept — their materials are the design authority) or a style-refine
re-run. The engine rules below are the same rules the compiled recipes encode.)

**REMIX MODE** (the DEFAULT creative-iteration answer — the user iterated on a delivered result with any
creative input; re-rolls are reserved for "show me more variants" asks; executed INLINE by the
orchestrator, no subagent): compose ONE NEW design system STRICTLY from the 2-3 INGREDIENT SHEETS named
in your instructions (validated recipe sheets `refs/html/<id>/recipe.md` from the runtime index — nothing
else exists):
- **SKELETON DONOR (sheet A)**: take its cue/window skeleton, gating, z-discipline and every engine
  workaround VERBATIM — the structural spine is already verify-proven; do not re-architect it.
- **TYPE + PALETTE DONOR (sheet B)**: its font families and its color story (ink/accent/grounding).
  Recompute EVERY width/size budget from B's measured calibration numbers (each sheet carries its
  advance/ink metrics) at the sizes you choose — never reuse A's budgets for B's fonts. CAUTION: a
  donor's calibration binds to the exact weight/case it was measured at (700 sentence-case numbers do
  NOT fit 800 CAPS — a live remix once overflowed the canvas this way); if your usage differs, re-derive
  the advance from a rendered frame before trusting any width math.
- **DEVICE / MOTION DONOR (sheet C, optional)**: ONE recurring device or entrance mechanic, implemented
  via C's documented engine-safe idiom (copy the mechanic, restyle to B's palette).
**CROSS-ASPECT DONORS.** Only the SKELETON donor (A) must share the run's aspect — its bands, safe
margins and placement constants are canvas geometry. B and C may be sheets from the OTHER aspect: a
type pairing, a colour story, a device, an entrance mechanic and the engine gotcha that made it work
are all aspect-free, and half the proven craft in the pool lives on the other side. What does NOT
cross without rework is every NUMBER tied to a canvas — ladder px, band centres, margins, line
pitches, advance budgets: re-derive them at this run's W/H from the donor's own calibration ratios,
never paste them. The same applies to the craft substrate a face-1 pass reads.

Rules: ONE system, ONE single pass, no aesthetic re-litigation; word delays VERBATIM from
`word-timings.json`; ingredients come ONLY from the named sheets (no fonts/palette/devices from outside
them); CRAFT RULES bind (one shadow idiom, cohesive registers, device craft); WV CONTRACT + ENGINE
LIMITS + the lint → verify → record → probe gates bind exactly as in any run. The blend must not read
as any single donor — name the new aesthetic in one line before authoring, then hold it across every beat.

## Method
- Read `meta.json` for W/H/fps/durationSec. Captions + windows (and real per-word timings) come from
  `transcript.json`. If `analysis.json` exists (refine runs only) also read it — it carries, per beat and in
  CANVAS px: `shot`, `subjectBbox`, `faceBbox`, `negSpaceRect` (largest clean zone for type), `brightness`.
  COMPOSE FROM THOSE NUMBERS when present; when absent, place by the safe margins below and vary position
  per beat. NEVER read the frames or re-derive framing yourself.
- Study the USER'S MATERIALS — they are the DESIGN AUTHORITY. Learn the design DNA from what they brought:
  positions, fonts, weights, sizes, colours, letter-spacing, shadows, mood (OPEN their images/files — this is
  the one place you look at supplied visuals; the footage frames stay off-limits). Then read the CRAFT
  SUBSTRATE sheets (validated recipes, `refs/html/<id>/recipe.md`) and lift their MECHANICS only — timing
  idioms, grounding, width budgets, the engine workarounds — never their look, unless the user's materials
  point the same way.
- LOCK ONE system: NAME the aesthetic (within the DIRECTION), fix 2-3 Google `@import` fonts + a limited
  palette + ONE recurring device, all pulled FROM the user's materials. The DIRECTION sets the lane, mood and
  placement — it never dictates fonts/palette/device, and if it appears to, the user's materials win. Hold the
  system across every beat; vary scale/composition per beat, escalate hook → close. Do NOT drift to a generic
  default-UI look.
- Compose AROUND the subject. With `analysis.json`: keep type inside the canvas and OFF the `faceBbox`; land
  it in `negSpaceRect`. Without it: stay inside the safe margins, keep type off the dead-center (a talking
  head lives there), favour the lower/upper bands (9:16) or left/right thirds (16:9).
  Legibility = shadow on a clean zone, never a scrim box.

## WV CONTRACT (real engine constraints — use W/H/fps/durationSec from meta.json)
- `body { width:{W}px; height:{H}px; position:relative; overflow:hidden; margin:0 }`
- Base video is the FIRST element at z0: `<video class="vid" style="z-index:0" src="{videoPath}" muted></video>`
  with `.vid { position:absolute; inset:0; width:{W}px; height:{H}px; object-fit:cover }`.
- EVERY text/graphic layer: `position:absolute` + explicit `z-index >= 1` (else it paints UNDER the video).
- Fonts via `@import` Google Fonts at the top of `<style>`.
- LEGIBILITY = shadow. `text-shadow` / `box-shadow` / `filter:drop-shadow` all render. Do NOT put a solid
  box/scrim plate behind the spoken caption just for legibility (an intentional graphic card as a DEVICE is fine).
- Effects (use where the DIRECTION wants them): layered-glow (NEON), stacked-offset (EXTRUDE), engraved
  (EMBOSS), 8-way faux-outline (OUTLINE), chromatic-split (GLITCH), multi-colour stack (STACK) — all via
  text-shadow; soft halo via `filter:drop-shadow`; ring/inset via `box-shadow`.
- Keep MONUMENTAL headlines INSIDE the canvas — stack to 2-3 lines or size down rather than clip an edge.
  Keep the spoken caption in safe margins (9:16 → top>=11% bottom>=17% left>=6% right>=11%; 16:9 → ~6% inset
  all sides, keep type off the dead-center face, use the left/right thirds).
- SVG inline only; `stroke="currentColor"` or a hex + `color:<hex>` (NEVER `stroke=var()`); `fill="none"`
  for strokes; no `translateY()`/percentage transforms inside `<svg>` (use px).
- Word spacing via margin or inline-block (inter-`<span>` whitespace is dropped). `<br>` is ignored → use
  sibling block divs. Centered WRAPPED text is flaky → keep each caption line in its own div or left-align.
  CSS Grid + the CSS `outline` property are unsupported (use flex; faux-outline via 8-way text-shadow).
- Use FLAT single-class selectors — style each text node with its OWN class. Descendant/specificity-dependent
  selectors (`.parent span`, nested overrides) and partial-width side columns render unreliably.

## SINGLE TIMELINE — the whole clip in one document
Lay every beat on ONE timeline over the footage; each caption visible ONLY in its cue window (the
transcript chunk's start/end), the rest hidden. Do NOT render beats to clips and stitch — the engine plays one
document across `durationSec`; sequencing is by CSS `animation-delay`/`animation-duration`.

**THE OPACITY / STACKING-CONTEXT TRAP (the #1 multi-beat bug).** A positioned element animating `opacity:0→1`
with NO explicit z-index LOSES its stacking context at opacity 1.0 and paints UNDER the z0 video → invisible.
In a multi-beat timeline this reads as a phantom whole-timeline offset (blank start, beats late, tail clipped)
— it is NOT a clock bug. FIX BY CONSTRUCTION: every animated text element is `position:absolute` + explicit
`z-index` above the video; gate visibility on each leaf/cue that already carries its z-index — NEVER via a
full-canvas no-z-index wrapper animating opacity.

**THE ONE SAFE REVEAL RECIPE (do not invent another):**
```
@keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }    /* cue visible across its window */
@keyframes wIn    { 0%{opacity:0; transform:translateY(.4em)} 100%{opacity:1; transform:none} }
.cue   { position:absolute; z-index:12; opacity:0;
         animation:cueWin <win> linear <start> forwards; }
.cue .w{ display:inline-block; opacity:0; color:<LITERAL hex>; /* STATIC colour */
         animation:wIn .4s cubic-bezier(.2,.7,.3,1) <wstart> both; }
```
The cue/window gating (`cueWin` + the z-index rule) is FIXED. The word ENTRANCE (`wIn`) is where the design's
character lives — swap its keyframes for the entrance mechanic your system adopted (from the user's materials,
implemented via a craft-substrate sheet's proven timing idiom): eased rise+fade, scale-overshoot pop, per-glyph
stagger; a continuous wiggle is an EXTRA comma-separated
transform-only `infinite` animation on the same element. Entrances animate opacity+transform together in ONE
eased keyframes block with `both` fill; the word stays `display:inline-block` (a fading centered flex item clips
mid-fade). A bare step opacity snap (`0%,99.99%{opacity:0} 100%{opacity:1}` + `step-end`) shows text with NO
motion — that is the ANIMATION LEVEL `none` mechanic; at `word`/`cue` level it is a DEFECT (it reads as plain
subtitles, not a designed system).
Keep `text-shadow` on the cue for legibility — `opacity:0` hides the shadow too. HARD RULES: never animate
`color` for reveal (it recolours, doesn't hide; with text-shadow the unrevealed words ghost their shadow).
Never put `var()` inside a `@keyframes` — it does not resolve and the unit stays invisible.

**ANIMATION LEVEL** (given in the execution contract):
- word (default) → per-word entrance in reading order on the REAL word timings; the entrance mechanic comes
  from your locked system (craft-substrate sheets carry proven, engine-safe examples of each).
- cue/line → the whole caption line enters per beat (fade+rise on an absolutely-positioned element).
- none → captions cut in/out with step opacity only (no per-unit entrance, no motion).

**WORD TIMINGS.** Use REAL ones — VEED transcripts carry them: each chunk in `transcript.json` has
`words: [{text, timestamp:[start,end]}]` (seconds, true spoken windows). Animate each word on ITS OWN window;
that is the whole point of word-level animation. ONLY IF a chunk has no `words` array,
FAKE them: split the cue's window evenly across its words (each word = cueDuration/wordCount, back-to-back from cue start).

## ENGINE LIMITS (engine 0.6.x — author within these; full matrix = `.veed-engine/feature-support.md`)
- No animated `filter:blur` (holds the keyframe's initial value → slides are fade-only). Static blur renders.
- `var()` in `transform` CRASHES — bake static rotates literally into each keyframe.
- Opacity fade CLIPS a centered flex item mid-fade — fade absolutely-positioned / inline-block elements, or scale.
- `border-radius` draws a straight 45° chamfer, not a curve (and slash syntax renders square) — use
  %-only clip-path polygons for real corners. No `repeating-linear-gradient` / stacked
  gradient layers. No `vw` font sizes, no CSS grid / `mix-blend-mode` / `outline`,
  no SVG `<text>`. Never rely on `-webkit-text-stroke` — construct-dependent (drops on animated or
  tilted spans); ground with an 8-way `text-shadow`.
  `line-height<1` not collapsed (use negative margins). `align-items:baseline` stacks (use `flex-end`).
- The partial-opacity glyph-clip bug: `filter:drop-shadow` under `<1` opacity clips glyphs → never fade an
  element carrying drop-shadow; legibility on fading text = `text-shadow`/`box-shadow`.

## RENDER + VERIFY (needs the window-server → run OUTSIDE any sandbox)
The binary is `{run dir}/../../.veed-engine/veed-engine-cli` (the preflight-managed veed-engine-cli, NOT on PATH).
0. LINT (mechanical, no engine): `node --import tsx pipeline/scripts/lint-template.ts {run}/final/template.wv`
   — catches the engine-limit anti-patterns above (var-in-keyframes, animated blur, the stacking trap, missing
   cue ids) before the slower verify. Exit 1 → fix the flagged rule, re-lint.
1. VERIFY (analytic, fast, no video — the ONLY self-check you perform by default; reads the manifest render block):
   `.veed-engine/veed-engine-cli {run}/final --verify`. It replays the whole timeline offscreen and checks the REAL
   draw list. Exit 0 = clean. Exit 1 = one stdout line per problem, naming the element id, e.g.:
     `frame 3 t=0.400s FAIL[bounds] #cap3 glyph 14 right 3.1px outside (8.42% of glyph box) viewport 736x1312`
     `FAIL[never-visible] #cap5 glyph 2 ink in 300 frames, never fully visible (best 0.00% at frame 0 ...)`
     `frame 2 t=0.200s FAIL[occluded] #cap2 glyph 5 fully covered by later opaque rect`
   The rules map to the real defects: bounds (type off the viewport), never-visible (type clipped away EVERY frame,
   e.g. stuck behind a mask/box), occluded (type fully hidden under a later opaque layer — the z-order/opacity trap).
   Fix ONLY the flagged element (nudge inside the safe zone / fix z-order or the mask) and re-run --verify until exit
   0. Do NOT change the aesthetic, colours, fonts, device, animation, or timing. (exit 2 = engine render failure = a
   real authoring error.) Every text layer needs a unique `id` so the failure lines name it. OPTIONAL word-reveal
   timing: add `"verify":{"expect":[{"element":"cap3","visible":true,"from":2.1,"to":3.4}]}` to manifest.json to make
   --verify FAIL[expect-visible]/[expect-hidden] when a caption is on/off screen at the wrong time.
2. RECORD the deliverable — ONLY after --verify is clean. --verify and --record are mutually exclusive, so this is a
   SECOND invocation: `.veed-engine/veed-engine-cli {run}/final --progress-output --record {run}/final/out.silent.mp4` (W/H/fps/duration
   from manifest.json). --progress-output prints `progress: N/M frames (X%)` lines as it renders — the record can take
   minutes, so run it in the foreground and relay progress to the user rather than going silent.
Do NOT extract frames or run any ffmpeg/visual self-check unless the execution contract EXPLICITLY instructs it — --verify
is the self-check. Author the timeline correctly up front using the recipe + limits above so --verify passes on the
first pass; it is a safety net, not a design loop. (The last gate, `probe-qa` — mechanical frame QA vs the source —
runs right after the record (SKILL step 4, same turn); it is not part of this verify loop and never a licence to
eyeball frames.)

## OUTPUT
- `{run}/final/template.wv` — the single-timeline document.
- `{run}/final/manifest.json` — EXACT: `{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{durationSec}}}`
  (duration covers the FULL clip).
- `{run}/final/out.silent.mp4` — the render (video only; audio is muxed in step 5).

## REPORT (fold into your summary — after probe-qa + mux, same turn, no preamble)
- aesthetic name + fonts + hex palette + recurring device.
- animation level used.
- any element you fixed for a --verify failure (which rule + why), or "verify clean (exit 0)".
