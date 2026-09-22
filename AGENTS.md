# AGENTS.md

This repo is a video creation and editing system powered by `veed-engine-cli` (the veed render engine).
It is not limited to captions: edit, cut and reframe footage; layer motion graphics and visual elements
(shapes, images, animations, not just text); turn slides or websites into video; capture web pages;
compose stylized output over real footage. Video is not always required: stills, slides, websites,
generated imagery, audio-only sources or pure motion graphics all serve when they fit the ask. Use any
video or image generating service and any available MCP server when it helps, not only the local engine
and recipe path. Be creative: match the ask; prototype, explore alternatives and invent when the brief
is open rather than collapsing every ask onto the captioned-recipe default. Captioned video via the
`open-edit` skill (`.claude/skills/open-edit/SKILL.md`) is one common path among many; use the full
engine surface when the work calls for edits, motion graphics or other compositions.

## To run a video
When the user says "run the open-edit skill on `<video.mp4>`", follow
`.claude/skills/open-edit/SKILL.md` exactly (the FAST PATH). The default caption run is scripted end to
end, zero tokens:
- **preflight**: prepare the workspace without asking (the CLI package carries the content itself);
  ask before global installs or updates.
- **prep**: `npx @veedstudio/openedit-cli transcribe` (recorded provider; `--provider veed` for the
  hosted route), then `npx @veedstudio/openedit-cli prep`: `meta.json`, `word-timings.json` from the
  transcript's real per-word times, base frames.
- **sample ONE style**: `npx @veedstudio/openedit-cli sample-style`: facet-scored seeded draw from the
  recipes-only runtime index `refs/tags.json`, writes `style.json`.
- **design + render**: `npx @veedstudio/openedit-cli generate-recipe --run runs/<key> --record`: the
  compiled recipe emits the .wv document, then lint, `--verify` with the mechanical ladder fix loop,
  records `out.silent.mp4`.
- **mux audio**: `npx @veedstudio/openedit-cli mux-audio`. Deliverable: `runs/<key>/final/out.mp4`.

The CREATIVE PASS routes on the shape of the ask: **face-1**, the prompt arrives with the user's own
reference/brand/concept, so the orchestrator authors design+render inline per the brief, no subagent,
the user's materials as design authority (per the hard rules). **face-2**, iteration on a delivered
result: any creative input is a REMIX, inline per the brief's REMIX MODE (fresh `runs/<key>-remix`,
same gates); "show me more options / N versions" with zero creative input is a RE-ROLL (N seeded draws
through the script path); defects are fixed at the source and re-gated (agent-authored templates
patched directly; recipe outputs regenerated via inputs, the refine path or a `--module` copy, never
hand-edited).
The **analyse** step (nameless background vision subagent writing `analysis.json`) is opt-in: run it
only when the user asks to refine the style, then re-run design+render as the from-scratch inline pass
and re-mux; `analysis.json` existing is the fast-path/refinement switch.

## How the pieces relate
- `.claude/skills/open-edit/`: the orchestrator (the flow).
- `pipeline/director-brief.md`: the engine contract the from-scratch design pass obeys; also carries REMIX MODE
  (the inline donor-blend contract) and the user-materials Method.
- `refs/html/<id>/recipe.ts`: the compiled recipes, one generator module per ref beside its prose sheet, built on
  `pipeline/recipes/lib.ts` (shared assembly rules); turns `meta.json` + `word-timings.json` into the final .wv
  document deterministically. Authored and validated offline, derived from the sheet; `hasRecipe` keys on the
  module existing.
- `pipeline/scripts/`: `lint-template.ts` (the mechanical gate on how a document is built, plus what the installed engine's own feature-support.md declares unsupported), `synth-word-timings.ts` (types only, the `word-timings.json` contract;
  synthesis lives in the CLI prep command), `npx @veedstudio/openedit-cli gates` (the chain in one command:
  lint -> `--verify` with the triaged safe-zone check -> contrast -> `--record` -> mux; `--doc` gates one chapter of a longer
  piece), `preflight.mjs` (a thin shim onto `npx @veedstudio/openedit-cli init`; the sibling `.sh` is its POSIX
  twin). Run the gates command rather than retyping the gates it drives.
- `pipeline/design/`: the authored path's substrate; `system.ts` is the per-run design system
  (`runs/<key>/design/system.json`): fonts, the type ladder with tracking per rung, palette, spacing, named easings
  and durations, the reveal unit, the devices in play, and `donors` (the recipe ids it was seeded
  from). `captions.ts` builds a caption block from the real per-word times (glyphs at
  each word's own delay, every page of a long cue rendered, a cursor whose windows meet so one bar travels
  the line, lines as block elements).
- `pipeline/recipes/type.ts`, `devices.ts`, `geometry.ts`: the craft as arithmetic. `opticalTracking(px)` is the
  measured tracking curve; `devices.ts` carries the compositional vocabulary; `geometry.ts` is arcs, lattices,
  springs and clip polygons.
- The asset seam lives in the `@veedstudio/openedit-cli` package: the asset manifest
  (`runs/<key>/assets/manifest.json`; records append), the fal client (the user's own key; `submitOnce`
  refuses to buy an identical request twice), and the queue ledger (accepted submissions).
  `npx @veedstudio/openedit-cli stills` gives a real picture with its licence and credit (a file whose terms
  are absent reads as `unknown`, never as permissive): `stills search <query>`, `stills show <File:…>`,
  `stills save <File:…|url> --run <dir> --id <id>`.
- `npx @veedstudio/openedit-cli mix-audio`: one soundtrack from many pieces, for a run whose audio is not simply
  the source clip's; each track states where it starts and how loud it sits, and a bed marked `duck` is ducked by
  the `voice` tracks themselves, not by a guessed gain. mux-audio instead restores a single source track and levels
  the track it is given to the delivery loudness, which is what a film needs.
- `veed/`: VEED-native transcription + login (one writer of `transcript.json`; real per-word timings), plus
  Fabric generation and video background removal on the same login.
  `npx @veedstudio/openedit-cli background-removal` uses the live free VEED route by default, or fal's own
  `--fast` model on request; `npx @veedstudio/openedit-cli lipsync` (video + new audio -> re-lipsynced video) has
  no VEED-hosted route and always goes through fal; both fal-charged paths use the VEED login to host the local
  file for a URL, but the generation call bills the user's own fal key (the CLI's fal BYOK rail), never a VEED
  workspace.
- `npx @veedstudio/openedit-cli prep`: `meta.json` + `word-timings.json` + base frames; needs a transcript from
  any provider.
- `refs/`: `html/` refs + `tags.json` (v3, the runtime index: recipes only, facet taxonomy, `fit` = aspect
  SOT) + per-ref `recipe.md` (the prose sheet a compiled
  recipe is derived from; the creative pass reads sheets as craft substrate and REMIX donors).
- `cli/src/config.ts`: the machine paths the CLI resolves (ffmpeg, ffprobe, the engine) and the two roots it keeps
  apart: the content it reads (recipes, gates, brief: the package's own tree unless `OPEN_EDIT_ROOT` names a
  directory that really carries `refs/tags.json`) and the WORKSPACE it writes (`runs/`, the recorded provider
  choice). A checkout's top-level `config.ts` reads the same env vars for the substrate scripts run outside the CLI.
- `docs/`: FLOW (orchestration), recipe-format (the recipe law). Engine support matrix = the `feature-support.md` asset downloaded with the
  engine release into its install dir (not vendored here).

## Hard rules (do not drift — these protect output quality)
- Recipe runs are deterministic: generate-recipe is the only writer of the final .wv document; never
  hand-edit its output or "improve" a compiled recipe per-run. A gate failure (lint / `--verify`) gets the mechanical ladder fix (in the runner) or a plain report, never a redesign. If the
  user explicitly asks for a customised recipe, copy `refs/html/<id>/recipe.ts` to the scratchpad, fix
  its relative lib import to the absolute path of the content tree's `pipeline/recipes/lib.js` (the
  compiled module: an installed content tree sits inside node_modules where a `.ts` import is never
  type-stripped; `lib.ts` when that tree is a checkout), edit the copy, and run with `--module <copy>`;
  never edit the library recipes in `refs/html/` per-run.
- The runtime style pool is recipes-only: `refs/tags.json` (v3) holds only recipe-backed refs
  (`sample-style` fail-louds on an entry missing its sheet or module); Selection
  is by facets, never by image.
- Write the design system down (`runs/<key>/design/system.json`) before authoring a document, and
  author every value out of it. Compose from `pipeline/recipes/devices.ts` and
  `pipeline/design/captions.ts`; a value the system does not declare is drift, not a judgement call.
- On creative face-1 the user's materials are the design authority: they must reach the design pass
  and be looked at (the one exception to "no vision in design"), recipe sheets contribute mechanics
  only, DIRECTION never names fonts/palette/device, and on any collision the user's materials win.
- The from-scratch design pass is inline (orchestrator-authored, never a subagent) and commits one
  design system in a single pass, no aesthetic re-litigation. It renders; its only self-checks are
  mechanical (lint + `--verify`): no legibility passes, no timing chasing, no redesign from renders.
  It authors within the engine limits.
- The analysis subagent is opt-in (style-refine requests only), the only subagent in the flow, spawned
  nameless and in the background (never a named teammate), and the only agent that reads the base
  footage frames; it writes per-beat facts in canvas px to `analysis.json`, and the design pass
  composes from those numbers when the file exists. Otherwise it composes from
  `design/placement.json`, measured by `npx @veedstudio/openedit-cli measure-placement` (a script, zero
  tokens). The design pass opens exactly one derived picture, that command's sheet, to check the
  numbers; it never reads base frames and never writes its own detector.
- Engine = `veed-engine-cli`, downloaded from the upstream `veedstudio/weave-renderer-public-releases`
  repo into the CLI's app-data dir via `npx @veedstudio/openedit-cli install-engine` (picks the
  release asset for the platform: macos-arm64 or windows-x64); the SKILL's PREFLIGHT step self-checks
  the version against the latest GitHub release.

## Conventions
- Canvas (probed by prep): the source's own width/height (rotation-corrected) and fps (nominal
  `r_frame_rate`, as the number `fps` for arithmetic and the exact `frameRate` string the manifest takes);
  `aspect` is an orientation label, 9:16 when h >= w, else 16:9. Beat render frame = `round(beatMidSec * fps)`.
- Setup/run: see `SETUP.md`. Run the render step outside any sandbox.
- Don't scan the bulk asset dir: `refs/html/` (28 ref folders, one per pool ref, each with prefab
  `template.wv` + sheet + compiled recipe) is a library, not browsing material. Never `ls -R` or glob
  it broadly; choose refs via `refs/tags.json` and address a ref's files by id.

## VEED transcription internals

The VEED client uploads without a project and bills transcription to the authenticated user's
workspace; there is no project-scoped path.

- The whole VEED client lives in the `@veedstudio/openedit-cli` npm package:
  `npx @veedstudio/openedit-cli transcribe --provider veed <video>` writes
  `runs/<key>/transcript.json`.
- Only `args.ts` remains here: the strict flag parser shared by the workspace's own scripts (the
  design substrate's gates and installers). Everything else, `npx @veedstudio/openedit-cli readiness`
  included, is in the package.

## Transcription providers

`runs/<key>/transcript.json` is the only seam: anything that writes that shape is a valid provider.
There is no default provider: on a cold start the user chooses (the skill's `TRANSCRIPTION.md`); picking
one for them is a defect. VEED is listed first because it transcribes best, not because it wins ties.

| Provider | What it is | Entry point |
| --- | --- | --- |
| `veed` | Premium quality, hosted. One-time browser sign-in; limits are the VEED account's. | `npx @veedstudio/openedit-cli transcribe --provider veed` |
| `whisperx` | Free, local, offline. Two tiers: `medium` (slower, better) and `small.en` (fastest, weaker on names). CPU by default (CTranslate2 has no GPU path on Apple Silicon); a CUDA-capable box overrides via `OPEN_EDIT_WHISPERX_DEVICE` / `OPEN_EDIT_WHISPERX_COMPUTE`. | `npx @veedstudio/openedit-cli transcribe` |
| `custom` | The user's own service or MCP, and the route for GENERATED narration — the media argument may be an audio file, so a film's own voice track reaches `transcript.json` before any picture exists. **We provide no support code**: you obtain a Whisper-family JSON however their tool works, then map it. No credential ever passes through OpenEdit. | `npx @veedstudio/openedit-cli whisper <json> <media>` |

The choice is recorded in `$OPEN_EDIT_ROOT/.open-edit-prefs.json` (the root preflight printed: the
workspace itself, or the checkout in contributor mode) as `{ transcription: { provider, model? } }` and
is not re-asked. Write it with
`npx @veedstudio/openedit-cli transcribe --record <provider> [--model <id>]` rather than by hand.
An absent, corrupt or unrecognised file reads as a cold start with a stated reason. A recorded
`model` becomes the default tier for later runs.

Every provider entry point takes `<video.mp4> [...]`, like `prep`, and writes one `runs/<key>` per
video, so a batch asks the provider question, signs in and installs once. The hosted batch finishes
every file it can and exits non-zero naming the failures; the local batch stops at the first. Written
transcripts stay in place and a re-run skips them.

```sh
# whisperx, installed on request only — isolated uv/pipx environment, ~2 GB with weights,
# removed again with `uv tool uninstall whisperx`
npx @veedstudio/openedit-cli install-whisperx                   # uv/pipx, pinned interpreter
npx @veedstudio/openedit-cli transcribe <video.mp4> [...] [--model medium] [--language de]

# custom: any Whisper-family JSON the user's service produced, one json per video
npx @veedstudio/openedit-cli whisper transcription.json <media> [<json> <media> ...]   # media = video OR audio
```

The whisper command accepts the Python Whisper family (WhisperX, openai-whisper,
whisper-timestamped, mlx-whisper), the OpenAI API's `verbose_json` with
`timestamp_granularities=["word"]`, and whisper.cpp's `-oj -ml 1` millisecond offsets.

Per-word times are mandatory; a transcript with none at all is refused. Words a provider leaves
untimed (WhisperX does this whenever alignment cannot match a word) keep their text, get a window
interpolated from their timed neighbours across segment boundaries where needed, and the count is
reported. A "word" containing whitespace (whisper.cpp without `-ml 1`) is split into tokens and
counted as inferred. Chunks are sorted, words whose times run backwards are reordered, and the
mapper throws if its output word count differs from its input.

If a transcription MCP is available, prefer one that writes a file and returns its path.

Classify a failed VEED run per the skill's `TRANSCRIPTION.md`, never retry it blindly; the recorded
provider is never rewritten on failure. On out of credits the transcribe error itself names
https://www.veed.io/pricing and the local alternative.

Run the isolated VEED tests without network access:

```sh
node --import tsx --test \
  tests/cli-entry.test.ts
```
