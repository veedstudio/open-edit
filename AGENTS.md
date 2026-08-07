# AGENTS.md

This repo is a **video creation and editing system** powered by `veed-engine-cli` (the veed render engine).
It is not limited to captions: agents can edit, cut, and reframe footage; layer motion graphics and
visual elements (shapes, images, animations — not just text); turn slides or websites into video;
capture web pages; and compose rich stylized output over real footage.

**Video is not always required.** Work from stills, slides, websites, generated imagery, audio-only
sources, or pure motion graphics when that fits the ask — source footage is optional, not assumed.

**Use the full toolbox.** Reach for any video or image generating service, and any available MCP
server, when it helps — don't limit yourself to the local engine and recipe path.

**Be creative and fluid.** Try new ideas and avenues. Prototype, explore alternatives, and follow
promising directions rather than collapsing every ask onto the captioned-recipe default. Match the
ask; invent when the brief is open.

One common path is stylized captioned video via the `open-edit` skill
(`.claude/skills/open-edit/SKILL.md`) The default (recipe-backed)
caption run is **scripted end to end** — recipes are compiled code (`refs/html/<id>/recipe.ts`), zero
tokens at run time; subagents remain only for the opt-in vision analysis (run when the user asks to
refine the style); the CREATIVE path face-1 (the user brought their own reference/brand/concept) is
authored INLINE by the orchestrator, and creative iteration on a delivered result is REMIXED inline.
Treat captions as one capability among many — match the ask, and use the full engine surface when
the work calls for edits, motion graphics, or other compositions.

## To run a video
When the user says "run the open-edit skill on `<video.mp4>`", follow
`.claude/skills/open-edit/SKILL.md` exactly (the FAST PATH):
**preflight** (automatically prepare the workspace-local runtime; ask before global installs or updates) →
**prep** (transcript from the recorded provider — `veed/go.ts` or `prep/transcribe.ts` — then `prep/prep.ts`: `meta.json` + `word-timings.json` from
the transcript's real per-word times + base frames) → **sample ONE style** (`sample-style.ts`, facet-scored, seeded,
zero tokens → `style.json`; the pool is the recipes-only runtime index `refs/tags.json`, so the draw is
always recipe-backed) → **design + render** (`pipeline/scripts/generate-recipe.ts --run runs/<key>
--record`, a SCRIPT driving the full gate chain: the compiled recipe emits the .wv document → lint → `--verify`
with the mechanical ladder fix loop → records `out.silent.mp4` → probe-qa frame QA) → **mux audio**
(`pipeline/scripts/mux-audio.sh`). Deliverable → `runs/<key>/final/out.mp4`.
The **CREATIVE PASS** routes on the SHAPE of the ask (the user never learns recipes exist):
**face-1** — the prompt arrives WITH the user's own reference/brand/concept → the orchestrator authors
design+render INLINE per the brief (no subagent: nothing to orphan in headless runs, and the design stays
in the session's context so follow-up tweaks iterate instantly); the USER'S materials are the design
authority (they get looked at); 1-2 nearest recipe sheets ride along as craft
substrate (mechanics only) + a DIRECTION (content/mood/placement, never fonts/palette/device).
**face-2** — iteration on a delivered result: ANY creative input ("make it more interesting", a mood, an
aesthetic change) → REMIX, inline per the brief's REMIX MODE (donor sheets from the index, fresh
`runs/<key>-remix`, same gates); "show me more options / N versions" (zero creative input) → RE-ROLL
(N seeded draws through the script path); defect repairs → fix at the source + re-run the gates
(agent-authored templates are patched directly; recipe outputs are script-owned — regenerate via
inputs, the refine path, or a `--module` copy, never hand-edits).
The **analyse** step (nameless bg vision subagent → `analysis.json`) is OPT-IN: run it only when the user asks
to refine the style, then re-run design+render as the from-scratch inline pass (compiled recipes ignore
`analysis.json`; the pass composes from it) and re-mux — `analysis.json` existing IS the
fast-path/refinement switch.

## How the pieces relate
- `.claude/skills/open-edit/` — the orchestrator (the flow).
- `pipeline/director-brief.md` — the engine contract the from-scratch design pass obeys (the crown
  jewel); also carries REMIX MODE (the inline donor-blend contract) and the user-materials Method.
- `refs/html/<id>/recipe.ts` — the COMPILED recipes: one generator module per ref, next to its prose sheet,
  built on `pipeline/recipes/lib.ts` (the shared assembly rules); turns `meta.json` + `word-timings.json`
  into the final .wv document deterministically. Authored + validated offline (derived from the sheet);
  `hasRecipe` keys on the module existing.
- `pipeline/scripts/` — `sample-style.ts` (facet-scored seeded style pick) · `generate-recipe.ts` (runs the compiled recipe: generate → lint → `--verify` fix loop → `--record` → probe) · `lint-template.ts` (mechanical engine-limit gate) · `probe-qa.ts` (frame QA vs the source) · `resolve-video.ts` (the video-arg resolution rule shared by both entry points) · `synth-word-timings.ts` (imported by prep) · `extract-beat-frames.ts` (imported by prep) · `mux-audio.sh`, `preflight.sh`, `install-veed-engine.sh` (deterministic).
- `veed/` — VEED-native transcription + login (one writer of `transcript.json`; real per-word timings). `prep/prep.ts` — `meta.json` + `word-timings.json` + base frames (needs a transcript from any provider). `refs/` — `html/` refs + `tags.json` (v3, the RUNTIME INDEX — recipes only, facet taxonomy, `fit` = aspect SOT) + per-ref `recipe.md` (the prose recipe sheet a compiled recipe is derived from — the fast path runs the compiled module, never the sheet; the creative pass reads sheets as craft substrate and REMIX donors).
- `config.ts` — all machine paths (ffmpeg / ffprobe / veed-engine). `docs/` — FLOW (orchestration) · recipe-format (the recipe law). Engine support matrix = the `feature-support.md` asset downloaded with the engine release into `.veed-engine/` (not vendored here).

## Hard rules (do not drift — these protect output quality)
- Recipe runs are **deterministic** — `generate-recipe.ts` is the only writer of the final .wv document; never
  hand-edit its output or "improve" a compiled recipe per-run. A gate failure (lint / `--verify` /
  probe-qa) gets the mechanical ladder fix (in the runner) or an honest report — never a redesign. If a
  run genuinely needs a customised recipe (explicit user ask), COPY `refs/html/<id>/recipe.ts` to the
  scratchpad, fix its relative lib import to the absolute path of `pipeline/recipes/lib.ts`, edit the
  copy, and run with `--module <copy>` — the library recipes in `refs/html/` are never edited per-run.
- **The runtime style pool is RECIPES-ONLY — architecturally.** `refs/tags.json` (v3) contains nothing
  but recipe-backed refs (`sample-style` fail-louds on an entry missing its sheet or module); Selection is by
  FACETS — never by image.
- On creative face-1 the **user's materials are the design authority** — they must reach the design pass
  and be looked at; recipe sheets contribute mechanics only; DIRECTION never names fonts/palette/device,
  and on any collision the user's materials win.
- The from-scratch design pass (INLINE, orchestrator-authored) commits ONE design system in a **single pass** — no
  aesthetic re-litigation. It renders, but its only self-checks are mechanical (lint + `--verify`) — no legibility
  passes, no timing chasing, no redesign from renders (probe-qa runs right after the record). It authors within
  the engine limits so the first render is clean.
- The ANALYSIS subagent — the only subagent in the flow — is spawned **NAMELESS and in the background** — never a
  named teammate (a teammate hangs after finishing and is much slower; a nameless background subagent self-exits
  and writes to disk). The from-scratch design pass is INLINE, never a subagent.
- The analysis subagent is **opt-in** (style-refine requests only) and, when run, the **only agent that
  reads the FOOTAGE frames** — it writes per-beat facts in CANVAS px to `analysis.json`; the design pass
  composes from those numbers when the file exists (safe margins otherwise) and never opens the frames.
  (User-SUPPLIED materials on face-1 are the one exception to "no vision in design" — studying them is the point.)
- Engine = `veed-engine-cli` (the veed render engine, downloaded directly from the upstream `veedstudio/weave-renderer-public-releases` repo into `.veed-engine/` via `pipeline/scripts/install-veed-engine.sh`; **Step 0 of the SKILL self-checks the version** vs the latest GitHub release).

## Conventions
- Canvas (probed by prep): the source's own width/height (rotation-corrected) and fps (nominal `r_frame_rate`); `aspect` is an orientation label — 9:16 when h ≥ w, else 16:9. Beat render frame = `round(beatMidSec * fps)`.
- Setup/run: see `SETUP.md`. Run the render step OUTSIDE any sandbox (it needs the window-server).
- **Don't scan the bulk asset dir** — `refs/html/` (28 ref folders, one per pool ref; each ships prefab
  `template.wv` + sheet + compiled recipe) is a bulk library, not browsing material. Never `ls -R` /
  glob it broadly; use `refs/tags.json` to choose refs and address a ref's files by id.

## VEED transcription internals

The `veed/` client uploads without a project and bills transcription to the authenticated user's
workspace. There is no project-scoped path: the no-project route is the only one it takes.

- `go.ts` is the CLI entrypoint and writes `runs/<key>/transcript.json`.
- `orchestrate.ts` owns upload, readiness polling, transcription, and mapping.
- `api.ts` and `http.ts` are the typed API and authenticated transport layers.
- `oauth.ts`, `login.ts`, and `token-store.ts` own PKCE login, local token storage, and refresh.
- `transcript-mapper.ts` converts VEED captions to the pipeline's timestamped chunk shape.
- `readiness.ts` reports live-run prerequisites.

## Transcription providers

`runs/<key>/transcript.json` is the only seam. Anything that writes that shape is a valid provider and
nothing downstream can tell which one ran. **There is no default provider**: on a cold start the choice
belongs to the user (SKILL.md step 1), and picking one for them is a defect, not a shortcut. VEED is
listed first because it transcribes best, not because it wins ties.

| Provider | What it is | Entry point |
| --- | --- | --- |
| `veed` | Premium quality, hosted. One-time browser sign-in; limits are the VEED account's. | `veed/go.ts` |
| `whisperx` | Free, local, offline. Two tiers: `medium` (slower, better) and `small.en` (fastest, weaker on names). CPU-bound here — CTranslate2 has no GPU path on Apple Silicon. | `prep/transcribe.ts` |
| `custom` | The user's own service or MCP. **We provide no support code**: you obtain a Whisper-family JSON however their tool works, then map it. No credential ever passes through OpenEdit. | `prep/whisper.ts <json> <video>` |

The choice is recorded in `$OPEN_EDIT_ROOT/.open-edit-prefs.json` — the runtime root, which is not the
user's project root when the runtime is a managed clone — as `{ transcription: { provider, model? } }`, and is not
re-asked. Write it with `node --import tsx prep/transcribe.ts --record <provider> [--model <id>]` rather
than by hand; `prep/transcribe.ts` also exports `readPrefs` / `writePrefs` / `recordedModel` for
programmatic use. An absent, corrupt or unrecognised file reads as a cold start with a stated reason, and
a recorded `model` becomes the default tier for later runs.

Every provider entry point takes `<video.mp4> [...]`, like `prep/prep.ts`, and writes one `runs/<key>` per
video — so a batch asks the provider question, signs in, and installs once. A failure stops the batch and
leaves the transcripts already written in place.

```sh
# whisperx, installed on request only — isolated uv/pipx environment, ~2 GB with weights,
# removed again with `uv tool uninstall whisperx`
bash pipeline/scripts/install-whisperx.sh                       # uv/pipx, pinned interpreter
node --import tsx prep/transcribe.ts <video.mp4> [...] [--model medium] [--language de]

# custom: any Whisper-family JSON the user's service produced, one json per video
node --import tsx prep/whisper.ts transcription.json <video.mp4> [<json> <video.mp4> ...]
```

`prep/whisper-mapper.ts` accepts the Python Whisper family (WhisperX, openai-whisper,
whisper-timestamped, mlx-whisper), the OpenAI API's `verbose_json` with
`timestamp_granularities=["word"]`, and whisper.cpp's `-oj -ml 1` millisecond offsets.

**Per-word times are mandatory**, and a transcript with none at all is refused — `prep` would otherwise
even-split every cue and the word reveals would drift. Individual words a provider leaves untimed
(WhisperX does this whenever alignment cannot match a word) keep their text and get a window
interpolated from their timed neighbours, across segment boundaries where necessary; the count is
reported, because approximate timing is acceptable and missing words are not. The mapper asserts its own
output word count against its input and throws if they differ, so no future edit can reintroduce a
silent drop. A "word" containing whitespace — whisper.cpp without `-ml 1` emits whole sentences that way
— is split into tokens and counted as inferred, rather than passing as word-timed and being even-split
later. Provider order is not trusted: chunks are sorted, and words whose times run backwards are
reordered so the caption text and the reveals agree.

If a transcription MCP is available, prefer one that writes a file and returns its path. Routing
hundreds of timestamps through model context invites drift in the numbers themselves.

A failed VEED run is classified rather than retried blindly (SKILL.md step 1): out of credits returns to
the provider question with VEED still offered — a free account covers about 10 minutes a month, so
`veed/orchestrate.ts` names https://www.veed.io/pricing and the local alternative in the error itself; a
login failure retries the login once; anything else retries the command once. The recorded provider is
never rewritten on failure.

Run the isolated VEED tests without network access:

```sh
node --import tsx --test \
  tests/cli-entry.test.ts tests/oauth.test.ts tests/orchestrate.test.ts tests/token-store.test.ts \
  tests/transcript-mapper.test.ts
```
