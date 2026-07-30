# FLOW — the orchestration (read before building)

SCRIPT steps are deterministic; AGENT steps need an LLM. The default (recipe-backed) run is SCRIPT end to
end — the only agent is the opt-in analysis pass; creative face-1 (the user brought their own
reference/brand/concept) and creative iteration on a delivered result are authored inline by the orchestrator.
The whole thing is encoded executably in `.claude/skills/open-edit/SKILL.md` (the golden master) — this doc
is the conceptual map. One video → ONE captioned MP4. No per-shot intermediates, no user-approval gate.

| # | step | kind | what |
|---|------|------|------|
| 0 | preflight | SCRIPT | check `veed-engine-cli` vs the latest release; offer install if stale/missing |
| 1 | prep | SCRIPT | VEED transcript (`veed/go.ts`; chunks = beats, real per-word timings) → `word-timings.json` (per-word absolute-ms reveal delays, synthesized by `prep/prep.ts`) + base frames; auto-detect aspect → write `meta.json` (canvas + duration + paths) |
| 2 | analyse | AGENT (vision) | **OPT-IN, skipped by default** — run only when the user asks to refine the style; then ONE nameless bg subagent reads the frames + transcript → `analysis.json` (per-beat shot/bboxes/neg-space/brightness in CANVAS px), and step 4 re-runs with it. The **only** vision pass. `analysis.json` existing IS the fast-path/refinement switch. |
| 3 | sample ONE style | SCRIPT | `pipeline/scripts/sample-style.ts` — facet-scored seeded draw of one aspect-matched ref from `refs/tags.json` (v3 RUNTIME INDEX, recipes only; `fit` = aspect SOT; transcript energy weights the draw) → `style.json` (facets, energy, coverage, alternates). Zero tokens. The CREATIVE PASS routes here too: face-1 (user brought materials) → step 4 from-scratch; face-2 REMIX (any creative iteration) / RE-ROLL (variants asks) / patch (defects). |
| 4 | design + render | SCRIPT (recipe) · INLINE (creative face-1 · remix) | default → **compiled recipe** (`pipeline/scripts/generate-recipe.ts`: the generator module emits `final/template.wv` + `manifest.json` deterministically — word delays from `word-timings.json` by construction, zero tokens — then drives the gate chain: lint → `--verify` with the mechanical ladder fix loop (≤2 cycles) → `--record` → probe-qa); **face-1** (INLINE, orchestrator-authored: one design system from the USER'S materials, 1-2 recipe sheets as craft substrate, per `director-brief.md`; lint + `--verify` to exit 0, then `--record` → probe-qa); **REMIX** (inline donor blend per the brief's REMIX MODE in `runs/<key>-remix`, same gates) |
| 5 | mux audio | SCRIPT | ffmpeg muxes the source audio onto the silent render → `final/out.mp4` (the deliverable) |
| 5.5 | preview | SCRIPT (parallel) | `preview/server.ts runs/<key>` — localhost preview opened for the user (read-only): watch and scrub the footage, follow the transcript, preview the subtitles; auto-swaps to the new `final/out.mp4` when an amend re-render lands. Launched in the background; the pipeline never waits on it |

## Where quality lives (do not let these drift)
- **Prep (1)** transcribes via VEED (real per-word timings), then extracts the base
  frames and fixes the canvas from the source aspect; every downstream step reads `runs/<key>/meta.json`
  (never re-derives dims).
- **Analysis (2)** is opt-in — the default run derives vibe from the transcript and places by safe margins.
  When the user asks to refine the style it becomes the sole vision pass: structured per-beat facts in CANVAS px
  so the design pass composes from numbers, not pixels — the design pass never re-reads the frames.
- **Style selection (3)** is a seeded SCRIPT — same run key → same ref, `--seed/--style` to override
  (`--style` only takes index ids — the runtime pool is recipes-only); recipe coverage grows offline. On creative face-1 the USER'S
  materials are the design authority and the DIRECTION covers content/mood/placement only. Keep the
  engagement seed copy **verbatim** (wording changes output).
- **Design (4)** commits ONE design system in a single pass (no aesthetic re-litigation). Recipes exist to
  ELIMINATE per-run design analysis — and being compiled code, the per-run assembly is exact by construction
  (paging, sizing, gate/fade math, verbatim `word-timings.json` delays; the arithmetic-slip failure class is
  gone). Verification is engine-analytic (`--verify`) — the only fix is the mechanical ladder step-down; no
  redesign from renders. The from-scratch pass authors within the engine limits up front
  (`pipeline/director-brief.md`), so the first render is clean.

## Canvas conventions
The canvas IS the source: prep probes the video's width/height (rotation-corrected — phone footage with a
±90° side-data tag gets its dims swapped) and fps (nominal `r_frame_rate`, `avg_frame_rate` fallback).
`aspect` is an orientation label: 9:16 when h ≥ w, else 16:9.
Beat render frame = `round(beatMidSec * fps)`.
