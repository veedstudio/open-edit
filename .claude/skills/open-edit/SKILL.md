---
name: open-edit
description: Orchestrate a video run rendered by VEED's engine — stylized captions over footage, edits and reframes, layered motion graphics, or graphics with no footage at all. Takes any number of source videos, including none. Use when the user wants video made, edited, or captioned by an agent.
---

# open-edit — video orchestrator

**INPUTS: any number of videos, including none.** Footage is an optional layer; the count changes only
how much work arrives already scripted.

- **One video** (recommended): transcript, canvas (dims + fps) and base frames all derive from the file.
- **Several videos**: one batch, not one run each. `npx @veedstudio/openedit-cli transcribe` (either
  provider) and `npx @veedstudio/openedit-cli prep` take `<video.mp4> [...]` and write one
  `runs/<key>` per video, so provider question, sign-in and install happen once; SAMPLE ONE STYLE,
  DESIGN + RENDER and MUX AUDIO run per `runs/<key>`.
- **No video** (motion graphics, stills, slides, generated imagery, audio-only): fully supported. Author
  the `.wv` inline per `pipeline/director-brief.md` and run the same chain,
  `npx @veedstudio/openedit-cli gates runs/<key> --no-mux` (the RENDER + VERIFY block in `DESIGN.md`;
  none of it reads `meta.json`). Take `<key>`, canvas and duration from the ask, not ffprobe. Skip only the steps
  with no subject: the recipe draw and mux-audio. `generate-recipe` is the scripted
  shortcut for 1+ videos, not the definition of a supported run.

**Several images are ONE look.** When the user brought more than a couple of pictures (references,
screenshots, a brand kit), do not open them one by one: `npx @veedstudio/openedit-cli frames --images
<dir or files>` writes a single sheet plus `images.json` (tile number, file, native size). Open an image on
its own only when a detail is unreadable on the sheet. The same command pulls frames out of a video onto
one sheet: `frames <video> --at 1.2,3.8 --width 480 --sheet`, or `--every 2`.

Recipes are compiled code (`refs/html/<id>/recipe.ts`) and the runtime index is recipes-only, so a
default run's DESIGN + RENDER is always `npx @veedstudio/openedit-cli generate-recipe`: a script, zero
tokens, no subagent, running lint → verify → record. Creative face-1 and remixes are authored
inline. No per-shot intermediates, no user-approval gate. Map: `docs/FLOW.md`.

Default run (the FAST PATH) = PREFLIGHT → PREP → SAMPLE ONE STYLE → DESIGN + RENDER → MUX AUDIO
(ANALYSE is skipped): vibe/genre/energy from the transcript, placement from the brief's safe margins,
style sampled by script, word timings from `word-timings.json`. REFINEMENT = `analysis.json` exists
(ANALYSE ran on user request); placement then composes from it instead of the safe margins.

## User-facing output — talk like a product, not a pipeline
Never surface internals: run keys, ref/style ids (`hook-…`), "recipe"/"recipe-backed", seeds, facets,
energy scores, beat counts, frame counts, gate names (lint / `--verify`), engine details.
The CLASSIC POOL is internal too: never say "classic", "preset", "route" or a preset id (`simple`,
`glass`, …). Say you're on it, then deliver.
- Never name the style or how it was chosen (ref id, metadata, "the sampled pick", "the draw", seeds,
  alternates). Say "the style": "the style centres text mid-frame, so I'm switching to one that
  anchors low", not "the sampled pick is…". Describe a delivered look only in plain visual terms
  (colour, size, placement).
- No step-by-step progress (transcript/prep/sampling/verify/record/mux): one line when starting, then
  the deliverable with the preview URL. Silence in between is fine.
- "Render complete" = audio muxed: muxing is not a separate user-visible step; say the render is done
  only once `final/out.mp4` exists.
- No recap: deliver the `out.mp4` path plus at most a sentence or two on the result (on creative runs,
  the look you committed), never a list of stages, gates, counts or QA results.
- If a gate fails and you must stop, say in plain terms what is wrong on screen and the options; quote
  raw FAIL lines only if the user asks.
- Questions you must ask (renderer update consent, coverage gaps): plain language,
  what it means for their video, not exit codes.

## PREFLIGHT — ALWAYS run at session start
This file ships in an installed skill (`scripts/preflight.sh` is the macOS shim that bootstraps Node);
setup is the published CLI's init, and the CLI package carries all Open Edit content (recipes, briefs,
docs) inside itself; there is no runtime to clone. SKILL_ROOT is the directory containing this `SKILL.md`. WORKSPACE, by the first rule that applies:

1. SKILL_ROOT inside an Open Edit checkout: that checkout (init reuses it; the run exercises that code).
2. Otherwise the current project root, or the current directory outside a project; init makes it an
   ordinary npm project (a fresh empty folder works) and every step below runs there.

Init prints which (`reusing the local checkout at …` or `uses the packaged content …`); read it before
trusting a run to test your changes. Resolve the supplied video to an absolute path from WORKSPACE
before changing directories.

A session-opening note saying preflight is ready and naming `OPEN_EDIT_ROOT` is the preflight: take the
root from it, read `AGENTS.md`, start work; running init again only repeats what was already answered.
Otherwise, before any Open Edit work, report what setup would do (init also keeps the workspace's
SessionStart hooks current when it applies; a hook problem never blocks a run):
```
npx --yes @veedstudio/openedit-cli init --dry --workspace "$WORKSPACE"
```
Then run bare init, idempotent:
```
npx --yes @veedstudio/openedit-cli init --workspace "$WORKSPACE"
```
On the package path it npm-ifies the workspace (a minimal private `package.json` when none exists, this
CLI exact-pinned as a devDependency, `git init` when git is available, committable `.gitignore` entries
for `runs/`, `.open-edit-prefs.json` and the legacy `.open-edit/`, the skill refreshed) and installs the
renderer. A fresh or effectively-empty folder gets all of that with no questions. If the folder already
holds unrelated files (or is some other npm project), bare init prints `APPROVAL REQUIRED — use <folder>
as the OpenEdit project …`: relay it, then either re-run with `--auto-approve` to use the folder or pass
`--workspace <their choice>` (a fresh subfolder is the easy proposal). A workspace that already chose
OpenEdit (the pinned dep, recorded prefs, or the installed skill) is never re-asked. It also applies clean
patch/minor updates of the CLI itself; a major release, or one whose engine floor is not met, waits for
approval like everything else. In a checkout it reuses that checkout's code wholesale.

**Approval law:** bare init never installs machine-global dependencies. The one update it applies itself
is the clean patch/minor of this CLI above (declared engine floor met; a major, a raised floor, or an
undeclared floor waits); every other update to existing code waits too. If `--dry` or bare init prints
`APPROVAL REQUIRED`, tell the user every exact action and wait for an explicit yes. Only once all are
approved run:
```
npx --yes @veedstudio/openedit-cli init --auto-approve --workspace "$WORKSPACE"
```
`--auto-approve` means the user agreed to every proposed global install and clean update; never infer
it from the render request. If only some actions are approved, run only those exact commands yourself,
then rerun `--dry`. If nothing needs approval, do not mention preflight, with one exception: a `promoted
to packaged content` line means a runtime the user installed earlier stopped being read, so relay that
line and where the old clone still sits.

Exit 0: stdout is OPEN_EDIT_ROOT (the workspace on the package path, the checkout in contributor mode);
every `{repo}` below means this directory (runs/ and prefs anchor there). It does not mean setup
is done: `--dry` exits 0 while listing `WOULD APPLY LOCALLY` work that bare preflight performs, then
ends on `not ready yet — run bare preflight …`. Read the final `preflight:` line, not the exit code:
`ready — OPEN_EDIT_ROOT=…` means go. Exit 10: only that `APPROVAL REQUIRED` was printed; the user must
approve every listed action first. Exit 1: hard invariant/install error.
Dev: `--repository <URL-or-local-path> --ref <branch>` keeps the legacy managed-clone path: init clones
that source to `<WORKSPACE>/.open-edit/runtime` and runs it instead of the packaged content. A managed
clone records origin, branch and commit and rejects conflicting later overrides. A clean checkout is
offered a fast-forward update; local or untracked changes are reported and left untouched. A workspace
still carrying a managed clone from an earlier install is promoted automatically: its recorded
preferences move to the workspace, one line reports it, and the clone stays on disk, no longer read. A
clone with local changes, or moved off its recorded commit, is not promoted; init keeps running from it
and says so.

Resolve `{content}`, the directory the style bank, recipes, briefs and docs live in:
```
npx --yes @veedstudio/openedit-cli content-root
```
(the packaged content inside the installed CLI; in a checkout it equals OPEN_EDIT_ROOT).

After resolving OPEN_EDIT_ROOT, read `{content}/AGENTS.md` completely and follow it before any
repository command, explicitly on every agent; never rely on the client finding it automatically.

## The flow

Written for the footage case. PREFLIGHT, FOOTAGE, DESIGN + RENDER and PREVIEW hold for every run. PREP,
SAMPLE ONE STYLE and MUX AUDIO derive from a source file, so a run with no video has no subject for them
(see INPUTS; authoring, lint, `--verify` and `--record` are unchanged). CUT runs only when there is an
edit to make; it splits PREP.

Each step below is complete for the default run. Some situations need a companion file beside this one
(`$SKILL_ROOT/<file>`); read the whole file when its row applies, before acting:

| When | Read |
| --- | --- |
| No recorded transcription provider, a command reports "No VEED login found", or a transcription run fails | `TRANSCRIPTION.md` |
| The deliverable is not one source file played end to end (remove, reorder or join) | `CUT.md` |
| The user brought no video | `GENERATION.md` |
| The initial prompt asks for a simple/standard look; the user brought their own reference, brand or concept; they iterate on a delivered result; or they ask to refine the style | `STYLE.md` |
| Before the first authoring touch of a run (variant B, REMIX, NO VIDEO, a CUSTOMISING `--module` copy, a classic PARAMETER AMEND); `DESIGN.md` itself says when to read it again | `DESIGN.md` |

### PREFLIGHT — completed above  · SCRIPT
Do not run a second dependency implementation: `pipeline/scripts/preflight.mjs` (and its `.sh` twin) is
only a compatibility wrapper around the init command. If `node` is missing, installing it is an
APPROVAL REQUIRED action (macOS: `brew install node`, which the shim reports itself; Windows:
`winget install --id OpenJS.NodeJS.LTS`). The provider choice, and any sign-in or install it implies,
stays in the interactive PREP step.

### CUT  · SCRIPT (only when there is an edit to make; splits PREP)
If the deliverable is not one source file played end to end (dead air, filler or a weak take to remove,
beats to reorder, several clips to join), read `CUT.md`. It splits PREP: transcribe the sources, cut,
then run `prep` on the assembled file. A single clip captioned as-is skips it.

### FOOTAGE  · SCRIPT (only when the user brought none; runs before PREP)
If the user supplied a video, continue to PREP unchanged. Otherwise read `GENERATION.md` before anything
else: it settles whether a video is needed at all, and drives VEED Fabric generation (three stop-and-ask
gates, one of which spends credits) or another model.

### PREP — transcript, then frames + meta  · SCRIPT
Whichever provider ran (nothing downstream cares which), the transcript lands at
`runs/<key>/transcript.json`: each chunk = one beat, with real per-word timings in
`words: [{text, timestamp:[start,end]}]`. `<key>` = the video's filename without extension, whitespace
replaced by `_`; every step below takes the same `runs/<key>`, and each entry point prints the path it
wrote.

Batch (see INPUTS above): pass every video to one call. Hosted runs four at a time, finishes what it
can, and exits non-zero naming the failures; local stops at the first failure. Finished transcripts stay
in place and a re-run skips them.

Provider: read `$OPEN_EDIT_ROOT/.open-edit-prefs.json` (the root preflight printed: the workspace on the
package path, the checkout in contributor mode; a legacy managed clone's choice was promoted there by
init). If it records a provider, use it and ask nothing. If it records none, a command reports
"No VEED login found", or a run fails, read `TRANSCRIPTION.md` (the provider question in its exact wording,
the record commands, the login flow, failure handling). When nothing needs transcribing (no footage, silent
source, graphics-only ask) skip the question and record nothing.
- veed: `npx @veedstudio/openedit-cli transcribe --provider veed <video> [...]`
- whisperx: `npx @veedstudio/openedit-cli transcribe <video> [...]` (the recorded tier applies)
- custom: `npx @veedstudio/openedit-cli whisper <json> <video>` on the JSON the user's own service produced

Once the transcript lands, report the provider in one line ("Transcribed with VEED." or "Transcribed with
WhisperX (medium), locally.") and relay any warning the run printed; no other progress.

Then `npx @veedstudio/openedit-cli prep <video> [...]` (needs the transcript above for the beat times).
It auto-detects aspect from the source and writes, under `runs/<key>/`:
- `meta.json`: the single source of truth downstream: canvas `width/height/fps`, `frameRate` (the exact
  rational, `"24000/1001"`, for the manifest), `durationSec`, and all paths (`videoPath`, `transcriptPath`,
  `wordTimingsPath`, `framesDir`). Canvas = the source's own dims (rotation-corrected) and fps, probed by
  prep; `aspect` = portrait (9:16) or landscape (16:9) label.
- `word-timings.json`: per beat, `cueDelayMs`/`cueDurMs` plus every word's absolute-ms `delayMs`,
  synthesized from the VEED chunks' real per-word times (even split only if a transcript has none).
  DESIGN + RENDER pastes these verbatim; timing is never re-derived.
- `frames/beat-N.png`: one clean still per beat at the chunk mid time, at half canvas (×2 → canvas).

### SAMPLE ONE STYLE — deterministic, zero tokens  · SCRIPT
`npx @veedstudio/openedit-cli sample-style --run runs/<key>`
Facet-scored seeded draw of one aspect-matched ref from `refs/tags.json` (v3, the runtime index,
recipes only; `fit` is the aspect SOT). Transcript energy (no LLM, no frames) weights the draw; same
run key, same ref. Writes `runs/<key>/style.json`
`{refId, refPath, facets, hasRecipe, seed, energy, coverage, alternates}`. Its `recipe=yes|no` output
routes DESIGN + RENDER (an implicit draw always prints `recipe=yes`); never parse or hand-edit
`style.json`. The ref id and `style.json` are internal (User-facing output); the user hears only
"picked a style".
Overrides: `--seed N` (browse alternatives), `--style <id>` (the user asked for a look; must be an
index id, else rejected), `--exclude <id>` (repeatable).
**A SET MUST NOT LAND TWICE ON ONE STYLE.** For pieces made together (variants, languages, a
campaign) pass every taken id as `--exclude` (state them once); never reseed until a collision
stops happening; never keep the list in your head.
- **THE INDEX IS THE RUNTIME UNIVERSE; RECIPES ARE THE PRODUCT**: every entry ships a validated sheet
  (`refs/html/<id>/recipe.md`) and compiled module (`recipe.ts`); the script fail-louds on an entry
  missing either or its prefab. The draw, `--style` and `alternates` are recipe-backed only, so a
  default run's DESIGN + RENDER is always `generate-recipe`, zero tokens.
- **COVERAGE MODE** (`coverage.filtered:false`, only if curation shrinks an aspect below the
  threshold): stop, tell the user the aspect isn't covered by recipes, and offer `--style` by their
  explicit pick, an authored-from-scratch run if they ask for one, or cancel. Never substitute the
  from-scratch pass without the user choosing it.
- Read `STYLE.md` before the draw when the user's initial prompt asks for a simple/standard look
  (CLASSIC POOL), brought their own reference/brand/concept (face-1), iterates on a delivered result
  (face-2), or asks to refine the style (ANALYSE). It also sets ENGAGEMENT mode and ANIMATION LEVEL for
  face-1 runs.

### DESIGN + RENDER — SCRIPT (recipe) / INLINE (creative face-1 · remix)

Before the first authoring touch of a run (variant B, REMIX, NO VIDEO, a CUSTOMISING copy, a classic
PARAMETER AMEND) read `DESIGN.md` in full: when to read it again, contract B, the RENDER + VERIFY block with the SAFE-ZONE CHECK
and the CONTRAST step, REMIX EXECUTION, and the engagement seed copy.

Route by the run's shape (SAMPLE ONE STYLE's output and the creative-pass routing decide):

- variant A (`recipe=yes`, every default run): SCRIPT, no agent, no model, zero tokens. If you lost the
  SAMPLE ONE STYLE output, rerun the script (same run key, same result). The classic route
  (CLASSIC POOL) is this variant with `--module {content}/refs/html/classic/<id>/recipe.js` appended.
- variant B (creative face-1; also refine re-runs after ANALYSE): INLINE, you execute contract B in `DESIGN.md`
  yourself, no subagent. A default run never routes here (the index is recipes-only).
- REMIX (face-2 creative iteration): INLINE, you author the donor blend yourself per
  `director-brief.md` REMIX MODE (no subagent), then drive the same gates by hand (REMIX EXECUTION in `DESIGN.md`).
- NO VIDEO (see INPUTS): INLINE. Neither PREP nor SAMPLE ONE STYLE ran, so there is no recipe. Write
  `runs/<key>/design/system.json` first (`groundedIn` names the run's own facts: the brief, a script,
  a shot list). Author per `director-brief.md` with the canvas and duration from the ask, then run
  `npx @veedstudio/openedit-cli gates runs/<key> --no-mux` (no source track to restore). If the run has a built soundtrack, pass
  `--audio runs/<key>/audio/mix.m4a` instead of `--no-mux`. Place pictures
  with `<img src="asset.png">` — a file BESIDE the document renders, `object-fit` included (probe:
  img-file-src). A `data:` URI does NOT (probe: img-data-uri-blank), so write the bytes to the run and
  reference them by name rather than inlining them.

**A. COMPILED RECIPE (`hasRecipe:true`)**. Run (outside any sandbox):
```
npx @veedstudio/openedit-cli generate-recipe --run runs/<key> --record
```
One invocation runs the full gate chain:

- loads the ref's compiled recipe (`refs/html/<id>/recipe.ts`);
- generates `runs/<key>/final/{template.wv, manifest.json}` from `meta.json` + `word-timings.json`;
- lints how it is built and what the installed engine declares it will not render (a lint error is a generator bug, never hand-fixed);
- runs `--verify` with the mechanical fix loop (a `FAIL[bounds]` on a title line steps that page down
  the size ladder and regenerates; at most 2 cycles);
- records `final/out.silent.mp4` (`--progress-output` lines stream; watch them, do not narrate them).

Exits:

- 0: go to MUX AUDIO.
- 1: a gate failed. Report it in plain terms (raw FAIL lines only on request) and offer a
  `--seed`/`--style` re-run. Never redesign or hand-edit the .wv document.
- 3: the sampled ref has no compiled recipe (stale `style.json`); rerun SAMPLE ONE STYLE.

This chain's `--verify` runs the bounds family only. After exit 0, run
`npx @veedstudio/openedit-cli safezone-check runs/<key>` (seconds; no re-record on a clean result). Each
line arrives already triaged: CHROME, TRANSIENT and MINOR: deliver and mention; MAJOR: fix on a
`--module` copy and re-run the chain.

CUSTOMISING (only when the user explicitly asks for a tweak to a recipe run): never edit a library
recipe (`refs/html/<id>/recipe.ts`) in place. Copy it to your scratchpad, rewrite its relative lib
import to the absolute path of `{content}/pipeline/recipes/lib.js` (the compiled module: {content} sits
inside node_modules on the package path, where a `.ts` import is never type-stripped; `lib.ts` only when
{content} is a checkout), edit the copy, then run the same command with `--module <copy path>`. The default run needs none of this; just run the command above.

### MUX AUDIO — restore the soundtrack  · SCRIPT
the engine renders video only. If the run's audio is the source clip's, `npx @veedstudio/openedit-cli mux-audio runs/<key>`
muxes it onto `final/out.silent.mp4` → **`runs/<key>/final/out.mp4`** (the deliverable), levelled to
-14 LUFS / -1 dBTP, and prints which correction ran. `--no-loudnorm` keeps the source level; `gates`
forwards it; pass it when gating one chapter of a longer piece. `-map 1:a:0?` tolerates a source with
no audio track. The deliverable takes the picture's length. Deliver `out.mp4`; that is the first
moment the run is presented as done. Never announce the silent render or the muxing separately.
If the audio is built rather than restored (narration, music, effects), see the built-soundtrack
block in `DESIGN.md`.
With no source video, copy `final/out.silent.mp4` to `final/out.mp4` and deliver that. A silent
deliverable is complete, not a failed mux.

### PREVIEW — open the localhost preview  · SCRIPT (parallel, non-blocking, runs alongside the rest)
As soon as render is done, launch the preview server in the background (outside any sandbox; if
sandboxed anyway it falls back to 2s polling) and continue immediately:
`npx @veedstudio/openedit-cli preview runs/<key>`
- It prints `preview: http://127.0.0.1:<port>/` and opens the user's browser. VEED_PREVIEW_NO_OPEN=1
  only prints; never set it yourself, on any path (recipe and creative), unless the user explicitly
  asks for no browser.
- It writes the URL to `runs/<key>/preview.url`; read that file when the background launcher does not
  surface the child's stdout. It is removed on clean shutdown, so a present file is a live server.
- Share the URL with the user in one line.
- The preview is read-only in V1; transcript changes go through you in chat, not the page.
- The page live-updates off the run dir as later steps and amends write files, and swaps to
  `final/out.mp4` on its own. Do not re-open or restart it for re-renders of the same run dir.
- The preview is pinned to the run dir it was launched with. Creative-pass outputs in sibling dirs
  (`runs/<key>-remix`, re-roll variants) never appear in it: share the sibling's `final/out.mp4` path
  directly, or launch a second preview on the new dir. It self-selects a free port; the printed URL is
  the truth.

Kill the server(s) when the session wraps up.

## Gotchas
- PREFLIGHT checks veed-engine-cli. Keep it current via `npx @veedstudio/openedit-cli install-engine`
  (macos-arm64 / windows-x64 binary). Older builds lose features (e.g. pre-0.3 = no shadows = major degrade).
- Sandbox: PREP (the veed transcribe run) needs network egress to `*.veed.io`; a sandboxed `fetch failed`
  there means the sandbox blocked the call, so re-run it outside the sandbox. Engine `--verify`/`--record`
  (DESIGN + RENDER), `gates` and preview always run outside any sandbox: the engine needs a real desktop
  session (the window-server on macOS); preview's recursive fs.watch needs FSEvents, which the sandbox
  blocks (launched sandboxed anyway, it falls back to 2s polling).
- The preview server (PREVIEW) is loopback-only and additive. If its default port 8978 is busy it
  self-selects an ephemeral port; trust the URL it prints.
- Rendering fetches Google Fonts over the network (the .wv documents use a `<link>` to `fonts.googleapis.com`);
  an offline box = font fallback.
  FONT WARNINGS: read them precisely, don't chase noise. Harmless (unsourceable fallback-chain members):
  `no data/font-cache seed found`, generic-keyword lines (`'sans-serif'`, `'serif'`, `'cursive'`,
  `'monospace'`, `'system-ui'` `unresolved by Google`) and `has no italic face; substituting upright`.
  Real: a warning naming your display family (`'<Family>' unresolved by Google — rendering with embedded
  variable fallback`) means the type identity is gone; stop and fix the import/network before recording.
  The engine's bundled `data/fonts/` registry ships as dead Git-LFS pointers in current
  releases (upstream packaging bug); only live Google fetches resolve real families.
- **Don't scan the bulk asset dir**: `refs/html/` is data, not code. Never `ls -R`/glob it broadly; pick via
  `refs/tags.json`.
