# open-edit: authored design and render (DESIGN + RENDER variants B, REMIX and NO VIDEO)

Read this whole file once, before the first thing you author (the section below says when to read it
again). The routing between variants and the compiled-recipe
variant A are in `SKILL.md` under DESIGN + RENDER.

## When to read this file

**On the authored variants (B, REMIX, NO VIDEO), read this whole file once, before the first thing you
author.** It binds by what you do, not by the variant: a recipe run that reaches CUSTOMISING or a
classic PARAMETER AMEND is authoring too; only a recipe run that touches nothing reads nothing.

Read it again only when the contract is no longer in front of you:

- your context was compacted or summarised since you read it;
- you are starting a NEW document: a chapter of a longer piece, a remix, a second variant.

A touch on a document you are already authoring (a caption, a graphic, a plate, a title, a motion)
needs no re-read. What holds the design together across touches is not memory of this file: it is
`design/system.json`. Every font, size, tracking, colour and easing you author comes out of that file;
read the system back before a touch, not this contract.

**The system is committed once and not reopened**; a later touch places, sizes and times what the
system decided. A mechanical fix to the element a gate flagged (step the rung down, close the window,
apply the pixel shift a safe-zone line names) changes nothing else.

A re-read replays no step this run has already finished:

- a recorded transcription provider is used and nothing is asked;
- the style draw is deterministic on the run key;
- preflight is idempotent;
- if `runs/<key>` already holds the footage, the FOOTAGE step is done and none of its gates are
  re-entered.

## Contract B and the gates

**B. FROM-SCRATCH (creative face-1)**: the base design contract driven by the user's materials (reference
video/images/brand kit/described concept), with 1-2 nearest recipe sheets from the runtime index as
engine-proven craft substrate. Execute it inline yourself per CREATIVE PASS (no subagent): read
`pipeline/director-brief.md`, study the materials, author and gate the .wv document in this session.
Commit one design system in one pass (no aesthetic re-litigation), author one single-timeline `.wv`
over the full footage, self-verify with lint + `veed-engine-cli --verify`, then render. Raw prefabs are not inputs. Refine re-runs after
ANALYSE use this same variant; ANALYSE says how to fill the materials slot.

Execution contract (follow it yourself, filling {...}):
```
Author one captioned composition over the footage as a single-timeline .wv document, verify it with
--verify, then render it.
CONTRACT (obey exactly): read {content}/pipeline/director-brief.md, the full engine contract (paint order,
the opacity/stacking trap, the one safe reveal recipe, engine limits, single timeline, render+verify).
INPUTS:
  - {repo}/runs/{key}/meta.json: canvas W/H/fps + durationSec + paths (authoritative for the manifest).
  - {repo}/runs/{key}/analysis.json, only if it exists (refine runs): per-beat facts in canvas px (shot,
    subjectBbox, faceBbox, negSpaceRect, brightness, caption text + start/end/mid/midFrame). If present,
    compose from these numbers; if absent (the default), from {repo}/runs/{key}/design/placement.json
    (the measure-placement step below) + the brief's safe margins. Either way, never read the base
    frames one by one; the placement sheet is the one footage picture this pass opens.
  - {repo}/runs/{key}/transcript.json: captions + windows; chunks carry real per-word timings in
    `words: [{text, timestamp:[start,end]}]`. Animate each word on its own window; even-split only if a
    chunk has no `words` array.
  - video {videoPath} (in meta.json).
METHOD: the USER MATERIALS below are the design authority. Open them (images/files included) and study
their design DNA. Several images are ONE look, not one read each:
  npx @veedstudio/openedit-cli frames --images {dir or files}
writes a single sheet plus `images.json` (tile number, file, native size); open an image on its own only when
a detail is unreadable on the sheet. The same command pulls frames from a video you need to see
(`frames {video} --at 1.2,3.8 --width 480 --sheet`, or `--every 2`), one sheet instead of a read per frame. Study: positions, fonts, weights, sizes, colours, letter-spacing, shadows, mood. Translate it
into an engine-safe system; adopt and remix, never copy their content verbatim. From the CRAFT SUBSTRATE
sheets lift mechanics (timing idioms, grounding, width budgets, engine workarounds), not their look,
unless the user's materials point the same way.
USER MATERIALS (design authority): {paths / links / the user's described concept}.
CRAFT SUBSTRATE (recipe sheets, engine-proven; nearest by facets):
  1. {content}/refs/html/{idA}/recipe.md   2. {content}/refs/html/{idB}/recipe.md
DIRECTION = {content angle + mood + placement intent; no fonts/palette/device}.
ENGAGEMENT MODE = {seed copy, verbatim}.
ANIMATION LEVEL = {word | cue | none}.
TASK: write the system down first, then author against it. Author
  {repo}/runs/{key}/design/system.json before any .wv: 2-3 Google @import fonts, a type ladder (each rung a role + size + its own optical
  tracking; `opticalTracking(px)` in {content}/pipeline/recipes/type.ts gives the measured curve), a named
  palette, spacing, named easings and durations, the reveal unit, the devices in play, and `donors` = the
  recipe ids you took mechanics from. `groundedIn` names the run's own content files the system was
  built from. A value typed into a document that the system does not declare is drift: add it to the
  system deliberately or use what is there.
Learn the repertoire first, from the two CRAFT SUBSTRATE refs above (sheet and `template.wv`, one read
  each): what the engine is shown doing there: a word set at a different size from its neighbours (a
  beat is a column of separate text blocks, not one styled line), underlines, arrows, brackets, corner
  marks, rules and badges made well, which faces are already proven to render. `donors` in the system
  is the record of what you took; no separate write-up. A bank of what is possible, not a template:
  look at how something is done, then do it better for the piece in hand.
COMPOSE, don't type: {content}/pipeline/recipes/devices.ts (dividers, ground shadow; a rule is a hairline +
  shadow + stub that draws, never a lone grey line), {content}/pipeline/design/captions.ts (per-word reveal
  off the real timings, travelling cursor, lines as blocks; every glyph gets a unique id, which is what the contrast audit reads, and
  `idPrefix` names them yourself when two blocks share a cue), {content}/pipeline/recipes/geometry.ts (arcs,
  lattices, springs, clip polygons), {content}/pipeline/recipes/type.ts (ladder, tracking curve). Contrast
  over footage comes from the two-layer ground shadow, not a scrim box.
Placement is measured by a script, then decided by you. With footage, run once, before the system:
    npx @veedstudio/openedit-cli measure-placement {repo}/runs/{key}
  It writes {repo}/runs/{key}/design/placement.json (per cue, canvas px: `subjectBox`, `headBox`, and
  the safe zone cut into bands, each with the `luma` and `spread` of the footage behind it, `detail`,
  `motion`, `overHead`, `overSubject`, plus the `calmest` band clear of the head) and ONE sheet,
  design/placement.jpg (a tile per cue in cue order; lime subject, red head, cyan calmest band). Look at
  the sheet once: it is the check on the numbers and the only frames this pass needs. A cue whose
  `headFrom` is `detail` is a guess; where a box is wrong on the sheet, correct that cue's entry in the
  file by hand. Do not write your own detector and do not read frames one by one.
  Placement is a per-beat decision: add an `anchor` to each cue's entry (the band or px position the
  block takes), chosen from what is behind it, which way the subject faces and where the frame is empty.
  The entry is the record; no prose justification. One position held for the whole piece is a defect.
  Emphasis is the word that takes the beat, not a phrase in bolder type.
Not across the face: type passes behind a person, never across their eyes; `headBox` is the area to
  keep clear. When the empty ground runs out, use a smaller rung, a re-broken line, a different anchor
  or a later window, never the face.
Graphics go where the content asks, not everywhere and never as decoration: a number spoken in the
  script invites a count, bar, scale or comparison; so does anything a picture states faster than the
  sentence. Whether to use them at all: if the reference carries graphics between the talking, that is
  the permission and the measure of how much; if the user's ask implies them, the same. Where neither
  does, don't.
A device that appears twice needs a logic: it follows a rule the piece keeps (every subject turn, every
  figure, every change of speaker) or it does not appear at all. A recurring device varies: same logic,
  different corner, different scale.
Lines are separate blocks, so give them different edges: lines all starting at the same x are a
  paragraph, not a composition. An indent, a hang or a step is free; use it, and let the size change
  inside the block so one word carries the beat.
Hold the system across all beats; vary scale/composition per beat; escalate hook to close. Author one
{repo}/runs/{key}/final/template.wv (z0 base video first; every text layer position:absolute + explicit
z-index>=1 + a unique `id` e.g. id="cap3", see the opacity trap; the id makes --verify name the element
in its failure lines; each caption visible only in its cue window) +
{repo}/runs/{key}/final/manifest.json {"render":{"width":W,"height":H,"fps":FPS,"duration":durationSec}}.
FPS is meta.json's `frameRate` verbatim: an integer, or when the source rate is fractional (23.976, 29.97,
59.94) the exact fraction as a STRING, e.g. "fps":"24000/1001". Never a decimal: the engine rejects it.
RENDER + VERIFY (outside any sandbox). ONE command runs the whole chain and is how this pass finishes:
    npx @veedstudio/openedit-cli gates {repo}/runs/{key}
  lint → verify (timing windows derived from the document, bounds and the triaged safe-zone check, one
  walk) → contrast → record → mux, stopping at the first failure and naming the gate. The record is the slow part, so iterate on the two cheap gates
  by hand first (seconds each), then run the chain once; it repeats them, and it is the only thing that
  runs the contrast step. What each gate prints, and what to do about it:
  LINT (mechanical, no engine): npx @veedstudio/openedit-cli lint {repo}/runs/{key}/final/template.wv
     Engine-limit anti-patterns (animated blur, the stacking trap, missing cue ids, per-corner radius).
     Exit 1: fix the flagged rule, re-lint before verifying.
  VERIFY + SAFE-ZONE CHECK (analytic, seconds, no video, reads the manifest render block), one walk:
       npx @veedstudio/openedit-cli safezone-check {repo}/runs/{key}
     It replays the whole timeline offscreen against the real draw list and writes final/verify.json.
     Bounds family, printed as the engine's own lines naming the element id, e.g.:
       frame 3 t=0.400s FAIL[bounds] #cap3 glyph 14 right 3.1px outside (8.42% of glyph box) viewport 736x1312
       FAIL[never-visible] #cap5 glyph 2 ink in 300 frames, never fully visible (best 0.00% at frame 0 ...)
       frame 2 t=0.200s FAIL[occluded] #cap2 glyph 5 fully covered by later opaque rect
     Rules: bounds (type off the viewport), never-visible (type clipped away in every frame, e.g. behind
     a mask/box), occluded (type fully hidden under a later opaque layer, the z-order/opacity trap). Fix
     only the flagged element and re-run. Exit 2 = engine render failure = a real authoring error.
     Safe-zone family (glyph ink against the platform-safe area; plates, boxes, images, video and
     semi-transparent fills are not observed), printed ALREADY TRIAGED, one line per element:
       MINOR #w2_3 — right 9.4px deep, 6.7% of ink, held 34 frames 2.68..4s → does not block; if you are touching this line anyway, move the container that positions it left by 14px
       MAJOR #w5_4 — right 34px deep, 41.5% of ink, held 44 frames 7.32..9.04s → re-place its block inside the right edge: right = 87px
       TRANSIENT #cap1 — ... → crosses the margin on entry: deliver, mention in one clause
     Do what the line says and nothing else: the element named is the innermost id'd element carrying
     the ink (often a word span), so move the line or block that positions it; the words of one line
     move together. Never resize, recolour or re-time anything else. Only a MAJOR line blocks. MINOR,
     TRANSIENT, CHROME and WARN lines ask for no fix: mention them in one clause at delivery ("two lines cross the safe margin for a few
     frames on entry", "the credits strip runs under the feed UI"). After a MAJOR tell the user what
     moved and by how much in plain terms, not the rule name; if `analysis.json` or placement.json
     puts the new position on the head, take the other band.
     A MAJOR exits 1; MINOR, TRANSIENT, CHROME and WARN never do. The command counts correction cycles
     itself and after two says STOP: stop correcting then. To deliver the document as it is, re-run the
     chain with `--no-safezones` and say in plain terms what sits outside the safe area. A line that
     says NOT CHECKED means the walk never ran (engine missing, too old, or no desktop session inside a
     sandbox): fix that, never read it as clean.
     Chrome: an id ending in `-chrome` is dressing (kickers, credits, film-strip labels and marks,
     stickers), not the spoken line, and is never fixed. Put the suffix on the element that directly
     wraps the text (the engine labels a run by its direct parent's id).
     Zones: the generic preset by canvas aspect: 9:16 = x 6..89% / y 11..83% (the band feed UI covers);
     16:9 = 6% inset; 1:1 = 5% inset. Custom zones when the user's platform or brand says so: a
     `"verify":{"safezones":{"zones":[{"name":"...","rect":{"x":%,"y":%,"w":%,"h":%},"mode":"keep-inside|keep-out","severity":"error|warn"}],"exempt":["id"]}}`
     block in manifest.json (`keep-out` = a rect ink must stay out of: a logo corner, a sticker band;
     `warn` reports and never blocks; `exempt` = ids whose bleed is the design, a full-bleed title or a
     ticker, never an id you want to stop failing). With custom zones a line names the zone instead of
     an edge. To see a worst frame ({engine} = the path `npx @veedstudio/openedit-cli engine-path` prints;
     it is not on PATH):
     `{engine} {repo}/runs/{key}/final --headless --frame-num-until-exit {frame} --exit-screenshot {path}.png`.
     If the line says the safe-zone check did NOT run (an engine that predates `--verify=<rules>`), say
     so plainly; never fake it from a screenshot. On a compiled-recipe run the document is script-owned
     and a safezone line is a recipe geometry bug: CHROME, TRANSIENT and MINOR are delivered and
     mentioned; MAJOR is fixed on a `--module` copy (the CUSTOMISING route), never in
     `final/template.wv` by hand. If asked to check a delivered result ("is this inside the safe
     zones?"), run the same command on its run dir; an mp4 with no run dir has nothing to replay, so
     say so rather than judging frames by eye.
  EXPECT WINDOWS, word-reveal timing: the chain derives them from the document's own gates and stamps
     them into manifest.json, so there is nothing to write. To assert one yourself, add a "verify" block
     alongside "render" (a hand-written block is left alone; `--no-expect` skips the derivation, never
     to silence a failure):
     {"verify":{"expect":[{"element":"cap3","visible":true,"from":2.1,"to":3.4}]}}. --verify then
     FAILs[expect-visible]/[expect-hidden] if a word isn't on-screen when it should be; ids only (a word
     with no id can't be targeted).
  CONTRAST runs inside `gates`, before the record: nothing to run by hand and nothing to ask. The chain
     samples the real footage behind the text and, where a class of text falls below WCAG AA and a
     ground shadow measurably fixes it, adds that shadow (colour, size and face untouched), then lints
     and verifies the document again. It prints `status: pass|remediated|residual|not-improved|attention` and an
     `auto-shadow:` line: relay that in one clause at delivery ("added a soft shadow under the captions
     so they read on the bright shots"). Classes no shadow fixes are named: say so at delivery, do not
     redesign. `0 runs audited` means the text carries no ids (captions.ts gives them). If the
     chain prints `the contrast step did not complete`, it still delivers: contrast is unremediated for
     that render, so say so at delivery, and a missing engine is `npx @veedstudio/openedit-cli install-engine`.
     Only when the USER asks for a different treatment (a recolour, a solid box):
     `npx @veedstudio/openedit-cli wcag-pass --run {repo}/runs/{key}` prints the options per class; write
     final/wcag-choice.json (`{"schema":1,"chosen":[{level:"AA",selector,kind:"colour"|"shadow"|"background",hex,backingHex?,recipe?}]}`,
     `selector` and `recipe` copied verbatim from the `propose:` line, `backingHex` required for
     `background`), run the same command with `--apply`, then re-run the chain.
  RECORD and MUX are the chain's last two steps. The record prints `progress: N/M frames (X%)` lines and
     is long-running: watch them to confirm it is alive, but don't narrate them to the user. With no
     source soundtrack pass `--no-mux`; with a built one, `--audio {path}` (the built-soundtrack block).
  Change nothing else: no aesthetic/colour/font/device/animation/timing edits; --verify is a safety net,
  not a design loop.
OUTPUT: {repo}/runs/{key}/final/{template.wv, manifest.json, out.silent.mp4, out.mp4}.
CHECK THE DELIVERABLE with one command, not with hand-written ffmpeg:
    npx @veedstudio/openedit-cli check-delivery {repo}/runs/{key}
  It measures the container (size, frame rate, duration, audio), the picture against the source at a
  few moments, and the loudness, in seconds. Fix a FINDING at its source, re-run the chain, and check again.
THEN (same turn, no pause): note the locked system so you can describe the delivered look in plain terms
(aesthetic, fonts, palette, device, not gate status), note any shadow the contrast step added, and
deliver `final/out.mp4`.
```

**REMIX EXECUTION (face-2, inline — no subagent).**
- Make a fresh run dir `runs/<key>-remix`: copy `meta.json`, `transcript.json`, `word-timings.json`
  from `runs/<key>` and set the `key` field in `meta.json` to `<key>-remix`.
- Pick donors per SAMPLE ONE STYLE: A = the current pick's sheet as skeleton, same aspect; B = a
  different `type` facet; optional C = a different `device` facet.
- Write `runs/<key>-remix/design/system.json` first, as on face-1: copy the original's, change what
  the brief asks to change, name the donors in `donors`.
- Author `runs/<key>-remix/final/{template.wv, manifest.json}` per `director-brief.md` REMIX MODE.
- Run the chain (outside any sandbox): `npx @veedstudio/openedit-cli gates runs/<key>-remix`
  It runs lint → verify (derived timing windows, bounds and the triaged safe-zone check, one walk) → contrast → `--record` → mux,
  stops at the first failure and names the gate.
- `--verify` failure: fix only the flagged element and re-run. The chain counts consecutive failures
  at one gate itself and says STOP after two corrections: stop then, and report honestly.
- The deliverable lands next to the original; the user compares.
- Contrast runs inside the chain (the CONTRAST block above): do not run it again and do not stop on it.

## MUX AUDIO for a built soundtrack

If the audio is built rather than restored (narration, music, effects, anything with more than one
piece), write `runs/<key>/audio/mix.json`, build the track, and mux that:
```json
{ "durationSec": 726.8, "tracks": [
  { "path": "assets/vo-01.mp3",  "atSec": 0,    "role": "voice" },
  { "path": "assets/music-1.mp3","atSec": 12.4, "gainDb": -14, "fadeOutSec": 3, "role": "music", "duck": true },
  { "path": "assets/sfx-3.mp3",  "atSec": 88.2, "gainDb": -6,  "role": "sfx" } ] }
```
```
npx @veedstudio/openedit-cli mix-audio runs/<key>          # → runs/<key>/audio/mix.m4a
npx @veedstudio/openedit-cli mux-audio runs/<key> --audio runs/<key>/audio/mix.m4a
```
- The mix is levelled as a whole at mux; set the pieces' relative gains in `mix.json` and leave the
  overall level to it.
- `durationSec` is required and is the film's length; anything past it is trimmed.
- A bed marked `duck` is opened by the voice itself, not by a guessed gain.
- A fade-out is measured from the end of the film.
- `--print-graph` shows the filtergraph without running ffmpeg.

## Engagement modes — keep the seed copy VERBATIM (wording changes output)
- **scroll-stopping** (default, social): "the first frame must STOP the thumb — big numbers, oversized, chrome/neon, saturated; optimize for a feed."
- **wow**: "push the WOW ceiling — oversized, bleed past edges, heavy effects."
- **design-grade**: "gallery-quality AND maximally engaging — high-design, premium, crisp."
- **variety / bold-broadcast** (good for 16:9 landscape): "loud broadcast / sports-lower-third energy; big type in the landscape thirds; heavy effects."
