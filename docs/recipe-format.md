# Recipe format — compiled modules (`refs/html/<id>/recipe.ts`) + prose sheets (`refs/html/<id>/recipe.md`)

A recipe ships as **compiled code**: a generator module at `refs/html/<id>/recipe.ts` (next to the ref's
prefab and prose sheet) implementing the `RecipeGenerator` interface from `pipeline/recipes/lib.ts` —
`generate(meta, wordTimings, {demote}) → {wv, manifest}`. The fast path
(`npx @veedstudio/openedit-cli generate-recipe`) runs ONLY the module: deterministic, zero tokens, no model at run
time; `hasRecipe`/`--recipes-only` key on the module existing. `lib.ts` owns the invariant rules every
recipe shares (uppercase + VEED glue, char counting, paging, balanced line split, size ladder + the verify
loop's demotion lever, gate window + page-fade math, accent pick, SCALE); a module carries only its
skeleton template, its constants (anchor, ladder, caps), and local quirks.

The **prose sheet** (`refs/html/<id>/recipe.md`) is the authored design document a module is derived from —
the same content in instruction form for its live readers (module derivation offline; creative-pass craft
substrate and REMIX donors at run time). Both are authored + validated OFFLINE by a smart model, once
per ref: sheet → module → rendered validation (below). Goal unchanged: eliminate per-run analysis; the
thinking is encoded offline, the run just executes. Where a sheet rule needs judgment, the sheet has failed
its purpose — and it cannot compile.

## Resolution (not frozen — reference canvas + SCALE)

Sheets are aspect-specific (a portrait composition does not transpose to landscape; the sampler's
aspect-matched pool guarantees a recipe only ever runs on its own aspect) but resolution-AGNOSTIC within
the aspect. Every px in a sheet is authored at the aspect's reference canvas (9:16 → 736×1312 · 16:9 →
1280×720, @ the run's fps). `lib.scaleFor` + `lib.pxScaler` implement this in the compiled form — a module
scales every emitted px through them. The rule:

- `SCALE = W / W_ref` (9:16 → W_ref 736 · 16:9 → W_ref 1280), with `meta.json`'s W/H. REQUIRE
  `|H − H_ref·SCALE| ≤ 2%·H` (H_ref 1312 / 720) — a mismatched aspect is a STOP-and-report, never an
  improvised re-layout.
- If SCALE = 1 (the standard prep canvas): use the sheet's numbers verbatim.
- Else multiply EVERY px value in the sheet by SCALE and round: positions, widths/heights, font sizes,
  px letter-spacings, px text-shadow offsets/blurs, px margins/tops. `em`-based values are left alone
  (they ride the font size). Timing (ms) and z-index never scale.

## Required sheet sections (in order)

Each maps 1:1 onto the compiled module: SKELETON → the template literal · PER-BEAT ASSEMBLY / WORDS +
TIMING / EMPHASIS → `generate()` over the lib helpers · VERIFY LOOP → the generate-recipe command's mechanical
fix loop · DO NOT → simply how the code behaves.

1. **IDENTITY** — one sentence: what the prefab looks like + its signature devices.
2. **SKELETON** — a complete, ready-to-paste document skeleton in one fenced block: font `<link>`s /
   `@import`s copied from the prefab; `<style>` with the universal reset, `body {width;height}` (sheet px
   are authored at the aspect's REFERENCE canvas — 9:16 → 736×1312 · 16:9 → 1280×720 — with the
   prefab→reference factor, e.g. ×1.022 for a 720-wide portrait prefab, precomputed IN the sheet, never
   recomputed downstream), `.vid` at z0,
   the `.cue` gate recipe
   (`cueWin` keyframes + explicit z-index — the opacity-trap-safe pattern), and the ref's caption classes
   COPIED (already rescaled) with their reveal `@keyframes`. Placeholders only for run values:
   `{W} {H} {FPS} {DUR} {videoPath}`.
3. **PER-BEAT ASSEMBLY** — one fenced markup template per beat with placeholders (`{N}` beat number,
   `{cueDelayMs}` `{cueDurMs}` from `word-timings.json`), plus the deterministic rules:
   - how the beat's words map onto the ref's structures (lines/cards/slots);
   - **capacity**: the max units a structure holds + the regroup rule for long beats (balanced by chars,
     word ORDER preserved);
   - **sizing table**: font-size by longest-line character count (precomputed numbers — the widths must be
     budgeted HERE, never discovered via verify);
   - placement: exact `left/top/width` values inside the brief's safe margins (9:16 → top≥11% bottom≥17%
     left≥6% right≥11% · 16:9 → ~6% inset all round), varied per beat if the design calls for it.
4. **WORDS + TIMING** — the invariant rules: one span per word (or per glyph, if the ref is glyph-level),
   each span's `animation-delay` = that word's `delayMs` from `word-timings.json` **VERBATIM**; the beat's
   `.cue` gets `animation-delay:{cueDelayMs}ms; animation-duration:{cueDurMs}ms`. Word spacing per the
   engine limits (spacer span or margin — inter-span whitespace is not what sets the gap here; `display:inline-block`).
5. **EMPHASIS** — the ref's own device for hero words + a deterministic pick rule (e.g. "the longest
   content word of the beat; numbers win; last beat's last content word") so no judgment is needed.
6. **VERIFY LOOP** — verbatim commands:
   `{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify` → per failure class a MECHANICAL fix
   (bounds → which value to change by how much; never-visible → what to check; occluded → z rule), re-run
   to exit 0, ≤2 fix cycles → `--record`. Manifest line included verbatim.
7. **DO NOT** — no fonts/colors/keyframes beyond the sheet; no invented timing; no reading the frames; no
   redesign.

Sheets carry NO version history: no rev markers, no changelogs, no incident retellings, no measurement
provenance — git diffs carry the rest. A fragile rule keeps at
most ONE why-clause naming the engine behavior it guards against (that clause is what stops a future
edit from "simplifying" the bug back in). Every sheet line is live input — to the module derivation
offline and to the creative pass at run time.

## Authoring rules (learned the hard way, on hook-097 and hook-210)
- Budget WIDTH and HEIGHT in the sizing table, including chrome (padding/margins/labels) which does NOT
  scale with font-size — a fix loop can't shrink a block by shrinking its text.
- Structures flush with the safe-margin edges + rotation + box-shadow bleed = coin-flip verify failures;
  inset decorative blocks ≥24px from the margin lines and keep rotations ≤1.5°.
- Prefab quirks are load-bearing: `display:block` on word spans stacks one word per line inside wide
  containers — pin `display:inline-block` in the skeleton when words must flow.
- **Same-anchor lifetime vs cadence** (hook-210): when multiple structures take turns at ONE position,
  bound each unit's animation lifetime by the NEXT occupant's start time (+ a small grace), never by the
  cue end — a prefab's sparse demo copy hides this invariant, and dense speech (8+ words/beat) piles 2–3
  structures into an unreadable stack. This failure class is INVISIBLE to `--verify` (nothing is out of
  bounds or occluded in its sense) — budget it in the sheet.
- **Turn-taking fades must COMPLETE at the successor's start**: "mostly faded" is not enough — a
  frame catching predecessor ≥50% + successor rising reads as double-print. Any
  hold term that can push a fade past `nextStart` (e.g. `max(nextStart−150, lastWord+250)`) re-creates the
  pile-up on dense speech; the trade goes the other way (a word spoken <250ms before the next page shows
  only briefly). Prefer ONE page-level fade-out over per-word fade-outs — staggered per-word exits catch
  two pages alive at once. Exit bands narrower than the last ~30% of the duration hold full opacity too
  deep into the successor's rise.
- **Prefer full-width blocks to shrink-to-fit flex for animated children.** Not because the engine
  mis-lays them out — it does not (probe: flex-shrink-to-fit-animated), though this was carried for
  months as fragments, stray offsets and ink clipped at the box edge. A shrink-to-fit line sizes itself
  from its content, so one word changing width moves everything beside it; a full-width block plus
  `text-align:center` holds its geometry while the content changes.
- **Give word spans vertical headroom at tight line-heights.** An animating span at `line-height:1`
  is NOT sheared at the em-box (probe: lineheight-shear) — that was asserted for months, and enforced
  by a lint rule, on a claim nothing had rendered. What a tight line-height does do is bring a
  descender within a pixel or two of the next line's caps, so ~0.1em top / 0.15-0.2em bottom padding,
  or line-height >= 1.2, is a typographic margin rather than a repair.
- **Word gaps must budget the font's ink overhang** (hook-078 42-23): italic display caps (Playfair T/G/Y)
  overhang their advance by up to ~0.5em — a nominal 0.3em margin or spacer renders as FUSED words.
  Neither margins, paddings, nor spacer spans differ here (the ink paints over all of them). A plain
  trailing space inside a span is NOT trimmed (probe: trailing-space-in-span) and does advance the next
  word, but a space is narrower than a half-em overhang, so it does not solve this alone. The validated
  pattern: `margin-right:0.45em` PLUS a trailing `&#160;` in the span text. Validate gaps by patch-rendering the worst pairs, not from advance
  tables.
- **Light-on-light needs a grounding layer** (hook-224): a prefab's pure-white glow vanishes over light
  footage (a white mug) — bake one dark `text-shadow` layer into the sheet; the prefab's demo footage
  hides this. Invisible to `--verify`.
- **Compress entrances near the gate** (hook-224): a word spoken less than its entrance duration before
  the cue closes never reaches full visibility — give the sheet a mechanical rule shortening the entrance
  to `max(cueEnd − delay, ~250ms)`.
- **A formula readable two ways WILL be read two ways** (two clean readings of one prose sentence
  produced 2541ms vs 2691ms): every derived quantity gets exactly one closed-form expression.
- **Glue VEED's leading-`-` tokens** (`to` + `-do`): merge into one unit for paging/counting; render as
  two adjacent spans (each keeping its verbatim `delayMs`) with the gap between them zeroed. An orphaned
  "-do" leading a line reads as broken text.
- **A beat's LAST structure holds; the gate cuts it**: fading the final page out "so it completes at
  gate close" leaves every beat caption-less for the fade duration — dead-air the late-frame
  probe catches. Only MID-beat structures need fade-outs (turn-taking); the last one rides the cue gate.
- **One content is not validation** (hook-215 among others passed the `fresh-test` fixture and failed
  the next video): word density/pacing changes which timing branches execute, and footage changes which
  placements collide. Validate every sheet on ≥2 contents with different beat densities before calling
  it done.
- Every run validates the RECIPE: if it fails, fix the sheet AND its module together (they must not drift).
- `--verify` is necessary, not sufficient: pile-ups, fused words, ghost stacking, light-on-light, and
  descender clearance are all invisible to it — a recipe is validated only after an offline frame-by-frame
  eyeball (mid-beat AND ~120ms-before-beat-end probes per beat). Compilation removes the arithmetic-slip
  class (the module also gets unit tests against the sheet's worked example), but these VISUAL
  classes still need the eyeball on ≥2 contents.
