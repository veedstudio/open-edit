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

Your execution contract (the filled DESIGN + RENDER variant B contract from the SKILL) gives: the run dir, `meta.json` (canvas W/H/fps + `durationSec` + all paths),
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
- **IF YOU HAVE NOT RELOADED THE `open-edit` SKILL FOR THIS PASS, DO IT BEFORE YOU AUTHOR ANYTHING —
  AND AGAIN BEFORE EVERY AUTHORING TOUCH AFTER IT** — the whole skill, invoked again, not a section
  recalled. You are reading this inside the pass, so "before" means before the first thing you write. Authoring is necessarily the last thing that
  happens, so it is always the work with the most behind it; the rules that bind it were read long ago
  and are competing with several hundred tool results. Reloading puts them back on top at the moment
  they bind. A touch on any caption, graphic, plate, chart, mark, title or motion is an authoring
  touch, however small it looks — but a mechanical fix to the element a gate flagged is NOT one, and
  needs no reload. **Reloading is not permission to redesign**: the system is committed once, and what
  you reload is the contract you author within.
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
- LEARN THE REPERTOIRE FIRST. Open two or three refs under `refs/html/` — the sheet AND the document —
  and read what the engine is shown doing: a beat set as a COLUMN OF SEPARATE TEXT BLOCKS so one word
  can take another size, how an underline is drawn, what arrows, brackets, corner marks and badges look
  like when made well, which faces are proven. It is a bank of what is possible, never a template: see
  how it is done, then do better. Skipping it means designing from defaults, and the default is a
  centred line at one size.
- PLACEMENT IS DECIDED PER BEAT and written down: where the block sits, why there — what is behind it,
  which way the subject faces, where the frame is empty — and what changed since the last beat. A block
  that holds one position for a whole piece is the defect. Emphasis is carried by the word that takes
  the beat, not by a phrase in bolder type.
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
- Write the colour into the SVG shape: `stroke=var()` paints NOTHING (probe: svg-stroke-var) and
  `stroke="currentColor"` paints black (probe: svg-currentcolor-stroke). `fill="none"` for strokes.
  Inline `<svg>` and SVG `<text>` both RENDER, and so does an `<img>` whose src is an `.svg` file
  beside the document (probe: img-src-svg) — inline is the convenient form, not the only one. Position a child with the `transform`
  ATTRIBUTE (`transform="translate(x,y)"`) — a CSS `transform:translateY()` on an SVG child does not move it.
- Word spacing: whitespace between inline `<span>`s IS kept, and margin and inline-block remain the
  precise controls when you want an exact gap. **`<br>` breaks a line of ordinary inline text, and does
  NOT break a run of `display:inline-block` spans** (probe: br-between-inline-blocks) — which is what the
  ONE SAFE REVEAL RECIPE below emits, so a caption relying on it overruns its box and fails `--verify`
  with `bounds`. Give each caption line its OWN block element. `text-align:center` DOES centre a
  wrapping block (probe: centered-wrapped-text) — one div per line is still the better construction,
  because it lets a line take its own size and edge, but that is a composition choice and not a
  repair. CSS Grid is unsupported (use flex).
- Use FLAT single-class selectors — style each text node with its OWN class. This is a
  legibility-of-source rule and nothing more: a descendant selector applies its style (probe:
  descendant-selector-style) and carries an `animation-delay` (probe: descendant-animation-delay) just
  as CSS says. Flat classes are what let a document be read back against its own design system.

## SINGLE TIMELINE — the whole clip in one document
Lay every beat on ONE timeline over the footage; each caption visible ONLY in its cue window (the
transcript chunk's start/end), the rest hidden. Do NOT render beats to clips and stitch — the engine plays one
document across `durationSec`; sequencing is by CSS `animation-delay`/`animation-duration`.

**GIVE EVERY ANIMATED LAYER AN EXPLICIT z-index.** Not because the engine forces it — a positioned element
animating `opacity:0→1` with no z-index paints ABOVE the z0 video exactly as CSS says it should (probe:
opacity-anim-no-z, REFUTED, and it was asserted here for months as the "#1 multi-beat bug"). It is a
construction rule: paint order among several animated layers that all default to `auto` is decided by
document order, so one reordering silently changes what covers what, and the failure looks like a
phantom whole-timeline offset (blank start, beats late, tail clipped) rather than a paint-order
problem. State the order and it cannot drift. Gate visibility on each leaf or cue that carries its own
z-index rather than on a full-canvas wrapper animating opacity.

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
eased keyframes block with `both` fill; the word stays `display:inline-block` for layout control, not to
avoid a clip — a fading centered flex item does NOT clip (probe: flex-fade-clip). A bare step opacity snap (`0%,99.99%{opacity:0} 100%{opacity:1}` + `step-end`) shows text with NO
motion — that is the ANIMATION LEVEL `none` mechanic; at `word`/`cue` level it is a DEFECT (it reads as plain
subtitles, not a designed system).
Keep `text-shadow` on the cue for legibility — `opacity:0` hides the shadow too. HARD RULE: never animate
`color` for reveal (it recolours, doesn't hide; with text-shadow the unrevealed words ghost their shadow).
Write reveal values literally anyway — a custom property resolves fine, but a colour or offset spelled out
in the keyframe is what makes a `--verify` failure line readable.

**ANIMATION LEVEL** (given in the execution contract):
- word (default) → per-word entrance in reading order on the REAL word timings; the entrance mechanic comes
  from your locked system (craft-substrate sheets carry proven, engine-safe examples of each).
- cue/line → the whole caption line enters per beat (fade+rise on an absolutely-positioned element).
- none → captions cut in/out with step opacity only (no per-unit entrance, no motion).

**WORD TIMINGS.** Use REAL ones — VEED transcripts carry them: each chunk in `transcript.json` has
`words: [{text, timestamp:[start,end]}]` (seconds, true spoken windows). Animate each word on ITS OWN window;
that is the whole point of word-level animation. ONLY IF a chunk has no `words` array,
FAKE them: split the cue's window evenly across its words (each word = cueDuration/wordCount, back-to-back from cue start).

## ENGINE LIMITS — every line below is decided by a probe render, never by memory

Each statement is settled by a control-render probe — a document, a control rendering what the claim
predicts, and a pixel diff between them — and
`tests/engine-truth.test.ts` fails the build if this section drifts back to asserting something the
engine does not impose. **Do not add a limit here you have not rendered.** A limit you invent is
obeyed: it removes real capability from every run that reads this file.

**Real limits — author around these.**
- Animated `filter:blur` holds the keyframe's initial value and never ramps. Static blur renders.
- `box-shadow` renders but never animates.
- `skewX()` is silently ignored — build a parallelogram with a `clip-path` polygon. `skewY()` and
  `matrix()` were never probed: untested, not known-broken.
- An animated `transform` REPLACES a static `transform` on the same element: bake the static rotate
  into every keyframe of the animation.
- `animation-fill-mode: both` backfills the 0 % keyframe across the whole pre-delay window, so an
  element with inline `opacity:0` still paints if its 0 % keyframe says `opacity:1`. **Exactly one
  animation may own `opacity` on an element** — two owners is a contradiction the document cannot
  resolve, and it is the trap that left every graphic of one film on screen to the end.
- A gate whose keyframe closes exactly on a frame boundary LOSES that frame, and `--verify` does not
  see it. End a window a frame early, or land it off the boundary.
- `border-radius` slash syntax renders square, and a per-corner radius is ignored — use one value.
- `-webkit-text-stroke` never paints, on any construct. Ground with an 8-way `text-shadow`.
- A CSS `transform:translateY()` on an SVG child does not move it — measured on that function only;
  use the `transform` attribute, which does displace the shape.
- `@import` must be the FIRST statement inside `<style>` or the whole stylesheet is dropped.
- No CSS Grid (use flex), no `radial-gradient`, no CSS `mask`.
- An SVG path's counterform is filled SOLID — the hole in an O, a D or an e is lost, and `fill-rule`,
  `<mask>` and `<clipPath>` inside the SVG do not cut it (probe: svg-counterform-filled). A logo goes
  through `pipeline/recipes/svg-clip.ts` instead; see MARKS AND LOGOS below.
- `currentColor` does not inherit on an SVG `stroke`; it paints black. On `fill` it inherits correctly
  (probe: svg-currentcolor-stroke).
- `filter: drop-shadow` CLIPS what it is applied to: an inline-SVG child of the container it sits on
  (probe: drop-shadow-clips-inline-svg), and glyphs on an element that also carries opacity below 1
  (probe: drop-shadow-opacity-clip — this one did NOT hold on 0.7.3 and does on 0.8.0). Ground type
  with the two-layer text-shadow instead, and keep the filter off anything that fades.
- The engine cannot pause or retime a video layer — bake freezes and trims with ffmpeg beforehand.

**Capabilities the brief used to deny. They all render; use them.**
- Animated `clip-path`, and animated `width`/`height`.
- Nested transforms: a child rides its animated parent exactly, and `overflow:hidden` clipping follows
  an animated transform.
- `var()` inside `@keyframes` and inside `transform`, and fractional keyframe percentages.
- Descendant selectors for `animation-delay`.
- Inline `<svg>` and SVG `<text>`.
- CSS `outline`, `mix-blend-mode`, `repeating-linear-gradient`, and `conic-gradient`.
- `vw` font sizes, whitespace between inline spans, `line-height` below 1, and `align-items:baseline`.
- `<br>` — in ordinary inline text only. It is inert between `display:inline-block` spans, so it is a
  capability with a boundary rather than a capability (probe: br-between-inline-blocks).
- Google Fonts by `<link>` as well as by `@import`.
- `<img src="beside-the-document.png">`, `object-fit` included (probe: img-file-src). A `data:`
  URI draws NOTHING (probe: img-data-uri-blank) — write the bytes into the run and name the file.
- Fading a centered flex item does NOT clip it.
- `clip-path: polygon()` cuts a REAL transparent counterform (probe: clip-path-polygon-counterform) —
  which is what makes a vector logo possible at all. `clip-path: path()` does not: it renders solid.

A capability rendering is not a reason to reach for it. Prefer the plainest construct that expresses
the design — but never refuse work because this file once said the engine could not do it.

## MARKS AND LOGOS — vector, because the small sizes are the ones that matter

A mark is placed at 26px in a corner and at 90px on an end card, over 720p footage. A bitmap keyed out
of an export is mush at both — one run shipped exactly that, and the letters came back chewed.

The engine fills SVG counterforms solid (probe: svg-counterform-filled), so an inline `<svg>` logo
loses every hole it has. `clip-path: polygon()` does cut a real hole (probe:
clip-path-polygon-counterform), so that is the route:

```
import { svgToClip, clipLogoHtml } from '{repo}/pipeline/recipes/svg-clip.ts';
const logo = svgToClip('{run}/assets/logo.svg');            // paths → polygons, holes welded in
const { html } = clipLogoHtml(logo, { id: 'mark', left: 1140, top: 640, height: 26, colour: P.ink });
```

It takes any SVG — `<path>`, `<rect>`, `<circle>`, `<ellipse>`, `<polygon>`, groups and their
transforms, which it bakes into the points because the engine displaces a shape carrying a `transform`
attribute. One island per disjoint piece, all sharing one box, so the pieces stay registered. `colour`
overrides the file's own fill, since a mark over footage takes the document's ink. This is USER
material: whatever a brand hands over has to survive, so run it through and LOOK at the result at the
size it will be seen, not at 400px.

## LOOK AT THE CUTS — the frames a uniform grid never samples

```
node --import tsx {repo}/pipeline/scripts/cut-frames.ts <video> --out {run}/qa/cuts
```

It finds every shot boundary and writes one strip per cut: the frame before it, then the frames after.
A run that sampled its deliverable at 1.2, 3.8, 9.5, 15.0 and 21.5 seconds passed itself clean while
its cuts sat at 1.83, 5.29, 8.58, 10.75, 14.25, 19.54 and 20.67 — no sample came within four tenths of
one, and the defect it was carrying existed only there: a matted speaker lagging the background, so a
person from the previous shot stood in front of the next one for a few frames. Composite anything over
anything and this is the check; a caption that survives a shot it was never meant to cross shows up in
the same strips.

## RENDER + VERIFY (needs the window-server → run OUTSIDE any sandbox)
**One command drives the whole chain**, and it is the one to use unless you have a reason not to:
`bash pipeline/scripts/gates.sh <run-dir> [--doc <subdir>] [--audio <file>] [--no-design] [--no-wcag] [--no-expect] [--no-probe] [--no-mux]`
It runs design → lint → `--verify` → WCAG → `--record` → probe-qa → mux, stops at the first failure and names
the gate that failed. `--doc` picks the document under the run — it defaults to `final`, and a film
gates one chapter at a time (`--doc chapters/act-3`). When every chapter is gated, join them with
`pipeline/scripts/concat-chapters.ts`, which stream-copies and refuses parts whose format differs —
NOT `concat-videos.ts`, which re-encodes and normalises the frame rate because its inputs are
generated clips that disagree by nature. `--no-design` only when a compiled recipe IS the
system; an authored run without `design/system.json` is the defect that gate exists for. `--no-expect`
skips deriving the timing assertions, and is not a way to make a failure go away.
`--no-probe` when there is no source footage to diff frames against; `--no-mux` when there
is no soundtrack (the silent render is copied to `out.mp4`, so the deliverable path never changes).
The individual steps below are what it runs, and what a failure means.

It also derives `verify.expect` from the document's own gates before verifying, so `--verify` checks
not only WHAT is drawn but WHEN. A `FAIL[expect-visible]` means a cue is off screen inside the window
the document itself declares — a late reveal, a beat that closed early, a caption still up when the
next arrives. Nothing else in the chain can see that: every one of those documents draws something.
**Its reach is currently narrow.** On engine 0.8.0 `expect-visible` counts the ink of the element
carrying the id, so a gated cue whose words are child spans — the structure this brief prescribes and
every compiled recipe emits — reads as invisible inside its own window. Those elements are skipped
rather than asserted wrongly, which means the check fires today only where a caption carries its own
text. `tests/expect-visible-nested.test.ts` pins that behaviour; when it starts failing the engine has
learned to count descendant ink and the assertions cover the whole pool.
The binary is `{run dir}/../../.veed-engine/veed-engine-cli` (the preflight-managed veed-engine-cli, NOT on PATH).
0. LINT (mechanical, no engine): `node --import tsx pipeline/scripts/lint-template.ts {run}/final/template.wv`
   — catches the engine-limit anti-patterns above (animated blur, the stacking trap, a multi-value radius, missing
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
runs right after the record (the SKILL's DESIGN + RENDER step, same turn); it is not part of this verify loop and never a licence to
eyeball frames.)

## COMPUTED GEOMETRY — do not re-derive what is already a function
`pipeline/recipes/geometry.ts` carries the arithmetic behind computed forms, in canvas px, emitting no
CSS so nothing about the engine is baked into it:
- `alongArc` — N boxes seated on a circle, each rotated to its own angle (dials, tick rings, radial
  bursts, a crown of type). Angles run clockwise from 12 o'clock.
- `lattice` — points on a rotated, staggered lattice (a print screen is an OFFSET lattice at an angle,
  not a square grid; one delivered treatment read as polka dots until it was rebuilt that way).
- `insidePolygon` — clip a field to a shape, which is how tone lives INSIDE a device rather than
  floating over the picture.
- `arcRectPolygon` — a rectangle with sampled arc corners as a `%`-only clip-path, for corners a
  radius cannot describe.
- `sampleQuadratic` — points along a bowed path (dashed leaders, curved rails, arrow shafts).
- `springKeyframes` — a damped second-order response sampled as integer keyframe stops, for a needle
  settling or a card overshooting; the engine has no easing curve for this.
- `starPolygon` — regular star vertices.

These are COMPUTATIONS, not devices: a tick ring is one use of `alongArc`, not its purpose. Reach for
them before writing a one-off generator. These were reconstructed from delivered documents after the
scripts that produced them were thrown away, which is a bill nobody should pay twice.

## SCOPED EDITS — prove you changed only what was asked
When you are iterating on an accepted document rather than authoring a new one, keep the accepted
copy and check the result against it before reporting:
`node --import tsx pipeline/scripts/scoped-edit.ts <accepted.wv> <new.wv> --allow <selector-or-id>…`
Every difference outside the allowed set is printed with both values. This is a defect class no
render-time gate can catch: both documents are valid, and a caption that quietly shifted is exactly as
renderable as one that did not.

## OUTPUT
- `{run}/final/template.wv` — the single-timeline document.
- `{run}/final/manifest.json` — EXACT: `{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{durationSec}}}`
  (duration covers the FULL clip).
- `{run}/final/out.silent.mp4` — the render (video only; audio is muxed in the MUX AUDIO step).

## REPORT (fold into your summary — after probe-qa + mux, same turn, no preamble)
- aesthetic name + fonts + hex palette + recurring device.
- animation level used.
- any element you fixed for a --verify failure (which rule + why), or "verify clean (exit 0)".
