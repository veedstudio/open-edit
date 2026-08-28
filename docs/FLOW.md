# FLOW — the orchestration (read before building)

SCRIPT steps are deterministic; AGENT steps need an LLM. The default (recipe-backed) run is SCRIPT end to
end — the only agent is the opt-in analysis pass; creative face-1 (the user brought their own
reference/brand/concept) and creative iteration on a delivered result are authored inline by the orchestrator.
The whole thing is encoded executably in `.claude/skills/open-edit/SKILL.md` (the golden master) — this doc
is the conceptual map. No per-shot intermediates IN THE RENDER — a generated set produces one clip per shot and joins them
before any of this — and no user-approval gate on the captioning itself —
the only gates are the FOOTAGE step's three, and they exist only when the user brought no footage.

**Inputs: any number of videos, INCLUDING NONE.** The captioned single-clip run is the shortest path
through here, not the definition of a run: footage is a layer inside the document, and a run can be built
from stills, slides, generated imagery, audio alone or pure motion graphics. A long piece has one
document per chapter, gates them one at a time (`npx @veedstudio/openedit-cli gates <run-dir> --doc chapters/act-3`) and joins the
gated chapters with `npx @veedstudio/openedit-cli concat-chapters`.

An AUTHORED run — creative face-1, a remix, or a run with no footage — writes `runs/<key>/design/system.json`
before it authors any document, and `pipeline/scripts/design-gate.ts` reads every document back against it.
A compiled recipe needs none of that: the recipe IS the system.

| step | kind | what |
|------|------|------|
| preflight | SCRIPT | check `veed-engine-cli` vs the latest release; offer install if stale/missing |
| footage | SCRIPT (the only step that STOPS to ask) | **only when the user supplied no footage** — generate one with VEED Fabric (`npx @veedstudio/openedit-cli generate`, same VEED login as prep) → `runs/<key>/<key>.mp4`, which the PREP step then treats as ordinary footage. Three gates, in order: FOOTAGE (generate a video, take a clip they have/will record, use another model, or build from other sources instead — a non-Fabric model gets the speech caveat, since silent clips transcribe to nothing) → WORKSPACE (whose AI Playground credits; never picked for the user) → the CREDIT APPROVAL (script + presenter + voice + framing + quoted cost in ONE yes — the only gate that spends; cost tracks the finished DURATION at ~4 credits a second, and how long a script runs depends on the voice). Confirm and spend are two passes; a charged job is collected with `--resume`, never re-paid. Procedure: the FOOTAGE step of SKILL.md |
| prep | SCRIPT | transcript from the chosen provider (VEED `npx @veedstudio/openedit-cli transcribe --provider veed`, local WhisperX `npx @veedstudio/openedit-cli transcribe`, or the user's own via `npx @veedstudio/openedit-cli whisper`; chunks = beats, real per-word timings) → `word-timings.json` (per-word absolute-ms reveal delays, synthesized by `npx @veedstudio/openedit-cli prep`) + base frames; auto-detect aspect → write `meta.json` (canvas + duration + paths) |
| analyse | AGENT (vision) | **OPT-IN, skipped by default** — run only when the user asks to refine the style; then ONE nameless bg subagent reads the frames + transcript → `analysis.json` (per-beat shot/bboxes/neg-space/brightness in CANVAS px), and the DESIGN + RENDER step re-runs with it. The **only** vision pass. `analysis.json` existing IS the fast-path/refinement switch. |
| sample ONE style | SCRIPT | `npx @veedstudio/openedit-cli sample-style` — facet-scored seeded draw of one aspect-matched ref from `refs/tags.json` (v3 RUNTIME INDEX, recipes only; `fit` = aspect SOT; transcript energy weights the draw) → `style.json` (facets, energy, coverage, alternates). Zero tokens. The CREATIVE PASS routes here too: face-1 (user brought materials) → the DESIGN + RENDER step, from-scratch; face-2 REMIX (any creative iteration) / RE-ROLL (variants asks) / patch (defects). |
| design system | INLINE (authored runs only) | `runs/<key>/design/system.json` — fonts, the type ladder with each rung's own optical tracking (`pipeline/recipes/type.ts`), palette, spacing, named easings and durations, the reveal unit, the devices in play, and `donors` (recipe ids, checked against the runtime index). Written FROM the run's content: `groundedIn` must name files that exist, so a system cannot be authored before the thing it is for. Compose the documents from `pipeline/recipes/devices.ts`, `pipeline/design/captions.ts` and `pipeline/recipes/geometry.ts` rather than typing each graphic at its point of use. |
| design + render | SCRIPT (recipe) · INLINE (creative face-1 · remix) | default → **compiled recipe** (`npx @veedstudio/openedit-cli generate-recipe`: the generator module emits `final/template.wv` + `manifest.json` deterministically — word delays from `word-timings.json` by construction, zero tokens — then drives the gate chain: lint → `--verify` with the mechanical ladder fix loop (≤2 cycles) → `--record` → probe-qa); **face-1** (INLINE, orchestrator-authored: one design system from the USER'S materials, 1-2 recipe sheets as craft substrate, per `director-brief.md`; lint + `--verify` to exit 0, then `--record` → probe-qa); **REMIX** (inline donor blend per the brief's REMIX MODE in `runs/<key>-remix`, same gates) |
| gates | SCRIPT | `npx @veedstudio/openedit-cli gates <run-dir> [--doc <subdir>] [--audio <file>]` — design → lint → `--verify` → WCAG → `--record` → probe-qa → mux, stopping at the first failure and naming the gate. The generate-recipe command drives the same chain for a compiled recipe; every other path calls this instead of retyping it. Runs OUTSIDE any sandbox. |
| mux audio | SCRIPT | ffmpeg muxes the source audio onto the silent render → `final/out.mp4` (the deliverable) |
| preview | SCRIPT (parallel) | `npx @veedstudio/openedit-cli preview runs/<key>` — localhost preview opened for the user (read-only): watch and scrub the footage, follow the transcript, preview the subtitles; auto-swaps to the new `final/out.mp4` when an amend re-render lands. Launched in the background; the pipeline never waits on it |

## Where quality lives (do not let these drift)
- **Footage** is the only step that spends the user's money, so it is the only one with gates: nothing
  generates without the footage answer, no workspace is ever picked for the user, and ONE approval covers the
  script, the presenter, the framing and the quoted cost. The charge is always reported, and a job already
  paid for is resumed, never re-bought.
- **Prep** transcribes with whichever provider the user chose — asked once, recorded in
  `.open-edit-prefs.json` at the runtime root (real per-word timings either way) — then extracts the base
  frames and fixes the canvas from the source aspect; every downstream step reads `runs/<key>/meta.json`
  (never re-derives dims).
- **Analysis** is opt-in — the default run derives vibe from the transcript and places by safe margins.
  When the user asks to refine the style it becomes the sole vision pass: structured per-beat facts in CANVAS px
  so the design pass composes from numbers, not pixels — the design pass never re-reads the frames.
- **Style selection** is a seeded SCRIPT — same run key → same ref, `--seed/--style` to override
  (`--style` only takes index ids — the runtime pool is recipes-only); recipe coverage grows offline. On creative face-1 the USER'S
  materials are the design authority and the DIRECTION covers content/mood/placement only. Keep the
  engagement seed copy **verbatim** (wording changes output).
- **Design** commits ONE design system in a single pass (no aesthetic re-litigation). Recipes exist to
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
