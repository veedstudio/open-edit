---
name: open-edit
description: Orchestrate a video run rendered by VEED's engine — stylized captions over footage, edits and reframes, layered motion graphics, or graphics with no footage at all. Takes any number of source videos, including none. Use when the user wants video made, edited, or captioned by an agent.
---

# open-edit — video orchestrator

Renders video with `veed-engine-cli` (the veed render engine). Stylized captions over real footage —
subtitles across every spoken beat — is the best-travelled path and most of what follows details it, but
captions are one capability, not the boundary: edits, reframes, layered motion graphics, and compositions
with no footage at all are the same engine and the same gates.

The engine renders a `.wv` document, which **is an extension of CSS and can be treated as such**: an HTML
fragment plus a `<style>` block, standard CSS throughout, no JavaScript and no proprietary timeline —
`@keyframes` and `animation-delay` ARE the timeline. Your CSS knowledge transfers directly; only the
engine's unimplemented parts have to be learned (`pipeline/director-brief.md` § ENGINE LIMITS).

**INPUTS — any number of videos, INCLUDING NONE.** Footage is a layer inside that document — an optional
one. What the input count changes is **how much of the work arrives already
scripted, never whether the work is supported.**

- **One video** — recommended, and the best-travelled path. The transcript, the canvas (dims + fps) and
  the base frames are all derived from the file, which is what lets a compiled recipe run at zero tokens.
- **Several videos** — ONE batch, not one run each. `prep/transcribe.ts`, `veed/go.ts` and `prep/prep.ts`
  all take `<video.mp4> [...]` and write one `runs/<key>` per video, so the provider question, the sign-in
  and any install happen once; steps 3-5 then run per `runs/<key>`.
- **No video — FULLY SUPPORTED, not a degraded mode.** Motion graphics, stills, slides, generated
  imagery, audio-only sources. Author the `.wv` INLINE per `pipeline/director-brief.md` and run the SAME
  gates as every other run: `lint-template.ts` → `veed-engine-cli <dir> --verify` → `--record` (step 4's
  RENDER + VERIFY block — none of it reads `meta.json`). Choose `<key>` from the ask, take the canvas and
  duration from the ask rather than from ffprobe, and drop only the steps that have no subject: the recipe
  draw (no footage to derive facets from), `probe-qa` (it diffs frames against source footage) and
  mux-audio (no audio track). `generate-recipe.ts` is the scripted convenience for 1+ videos, NOT the
  definition of a supported run — its absence costs you the shortcut, nothing else.

The captioned run is **fully scripted end to end**: recipes are COMPILED CODE (`refs/html/<id>/recipe.ts`),
so a recipe-backed pick generates, verifies, and renders with zero tokens. The only spawned agent left is
the OPT-IN vision-analysis pass (style-refine requests); the CREATIVE path face-1 (the user brought their
OWN reference/brand/concept — their materials are the design authority) is authored INLINE by the
orchestrator, and creative iteration on a delivered result is REMIXED inline (no subagent). There are **no per-shot intermediates and no
user-approval gate**. Read `docs/FLOW.md` for the map.

Default run (the FAST PATH) = steps 0 → 1 → 3 → 4 → 5 (step 2 is SKIPPED). Vibe/genre/energy come from the
transcript; placement comes from the brief's safe margins; the style is SAMPLED by script; word reveal
timings are precomputed (`word-timings.json`). The runtime index is recipes-only, so a default run's step 4
is always `pipeline/scripts/generate-recipe.ts` — a SCRIPT, no model, no subagent: the recipe already did
the design thinking, offline, and the code does the assembly + the full gate chain (lint → verify → record
→ probe). Creative face-1 is authored INLINE by the orchestrator; the only spawned agent is the opt-in analyse pass.
REFINEMENT is declared by `analysis.json` existing (step 2 ran on user request) — placement then composes
from it instead of the safe margins.

## User-facing output — talk like a product, not a pipeline
The user asked for a video, not a pipeline tour. Internals are NEVER surfaced: run keys,
ref/style ids (`hook-…`), "recipe"/"recipe-backed", seeds, facets, energy scores, beat counts, frame
counts, gate names (lint / `--verify` / probe-qa), engine details. A fresh user has no idea what
any of that means.
- **Never name the style — and never expose the mechanics of choosing it.** The ref id, its metadata,
  and the sampling machinery ("the sampled pick", "the draw", seeds, alternates) are all internal.
  Talk about "the style" as an abstract thing that exists for this video: "the style centres text
  mid-frame, so I'm switching to one that anchors low" — not "the sampled pick is…". Describe a
  delivered look only in plain visual terms (colour, size, placement).
- **No step-by-step progress.** Don't announce transcript/prep/sampling/verify/probe/mux as they
  happen. One line when starting, then the deliverable with the preview URL. Silence in
  between is fine.
- **"Render complete" = audio muxed.** Muxing is not a separate user-visible step; say the render is
  done only once `final/out.mp4` exists.
- **No recap.** The delivery message is the `out.mp4` path plus at most a sentence or two about the
  result (on creative runs, the look you committed). Never a "What happened" list of stages, gates,
  counts, or QA results.
- **Failures are the exception.** When a gate fails and you must stop, explain in plain terms what is
  wrong on screen and the options; quote raw FAIL lines only if the user asks.
- Questions you must ask (renderer update consent, coverage gaps, probe failures) also stay in plain
  language: what it means for their video, not exit codes.

## PREFLIGHT — ALWAYS run at session start
An installed skill contains this file plus `scripts/preflight.sh`; the full runtime may not exist yet.
Resolve **SKILL_ROOT** as the directory containing this `SKILL.md`. Then resolve **WORKSPACE** by the first
rule that applies:

1. **If SKILL_ROOT sits inside an Open Edit checkout, WORKSPACE is that checkout** — preflight reuses it,
   and the run exercises that code.
2. **Otherwise** WORKSPACE is the user's current project root, or the current directory outside a project —
   preflight creates its own runtime at `<WORKSPACE>/.open-edit/runtime` and every step below runs there.

Preflight names which of the two it resolved (`reusing the local checkout at …` or `will use a managed clone
at …`); read that line before trusting a run to be testing your changes. Resolve the supplied video to an
absolute path from WORKSPACE before changing working directories.

At the start of EVERY session, before doing Open Edit work, run:
```
bash "$SKILL_ROOT/scripts/preflight.sh" --dry --workspace "$WORKSPACE"
```
Then run bare preflight to perform all safe, first-time workspace-local setup automatically:
```
bash "$SKILL_ROOT/scripts/preflight.sh" --workspace "$WORKSPACE"
```
This installs the project-local SessionStart hooks, performs the first full runtime clone, installs pinned
repository dependencies, and installs the renderer when their prerequisites already exist. It is idempotent.

**Approval law — never weaken this:** machine-global dependencies and updates to existing code are never
applied by bare preflight. If `--dry` or bare preflight prints `APPROVAL REQUIRED`, communicate EVERY exact
action to the user and wait for an explicit affirmative response. Only when the user approves ALL reported
actions may you run:
```
bash "$SKILL_ROOT/scripts/preflight.sh" --auto-approve --workspace "$WORKSPACE"
```
`--auto-approve` means the user agreed to every currently proposed global install and clean update. Never infer
approval from the original render request. If the user approves only selected actions, perform only those exact
commands yourself, then rerun `--dry`. If nothing needs approval, do not mention preflight.

Exit **0** means stdout is **OPEN_EDIT_ROOT**; use it for every repo-relative command below. It does **not**
mean setup is finished — a `--dry` run exits 0 while listing the `WOULD APPLY LOCALLY` work that bare
preflight performs itself, and then ends on `not ready yet — run bare preflight …`. Read the final
`preflight:` line, not the exit code: `ready — OPEN_EDIT_ROOT=…` means go. Exit **10** means **only** that
`APPROVAL REQUIRED` was printed and the user must approve every listed action first. Exit **1** is a hard
invariant/install error.
For development, `--repository <URL-or-local-path> --ref <branch>` overrides the initial clone source. A managed
clone records its origin, branch, and commit and rejects conflicting later overrides. A clean checkout is offered
a fast-forward update; any local or untracked changes are reported and left untouched.

Immediately after resolving OPEN_EDIT_ROOT, read `$OPEN_EDIT_ROOT/AGENTS.md` completely and follow it before
running any repository command. Do this explicitly on every agent; never rely on Claude, Codex, Gemini, or another
client discovering instructions inside the newly cloned runtime automatically.

## The flow

Written for the footage case, and steps 0, 4 and 5.5 hold for every run. Steps **1** (transcript, frames,
meta), **3** (style draw) and **5** (mux) derive from a source file, so a run with no video simply has no
subject for them — see INPUTS: authoring, lint, `--verify` and `--record` are unchanged.

### 0. PREFLIGHT — completed above  · SCRIPT
Do not run a second dependency implementation. `pipeline/scripts/preflight.sh` is only a compatibility wrapper
around the skill-bundled preflight. The provider choice — and any sign-in or install it implies —
remains the interactive step 1.

### 1. PREP — transcript, then frames + meta  · SCRIPT
The transcript comes from the provider the user chose, and either way lands at
`runs/<key>/transcript.json` (**each chunk = one beat**; chunks carry REAL per-word timings in
`words: [{text, timestamp:[start,end]}]`). Nothing downstream cares which provider ran. **`<key>` is the
video's filename without its extension, whitespace replaced by `_`** — every step below takes the same
`runs/<key>`, and each entry point prints the path it wrote.

For a batch (see INPUTS above), pass every video to ONE call: a failure stops the batch with the finished
transcripts left in place.

PROVIDER CHOICE — this whole question exists to caption speech, so **when nothing has to be transcribed
(no footage, silent source, a graphics-only ask) do not ask it at all** and do not record anything.
Otherwise read `$OPEN_EDIT_ROOT/.open-edit-prefs.json` first (**the runtime root preflight
printed, not the user's project root** — under a managed clone those differ, and looking in the wrong
one re-asks on every run). **If it records a provider, use it and ask
nothing.** Only on a cold start (no file, or nothing usable in it) ask ONCE, offering exactly these four.
**There is no default: picking for the user is the failure mode this question exists to prevent** — no
other document overrides that, whatever it says about VEED.

> Before I can add captions I need a transcript. Four ways to get one:
>
> 1. **VEED** — best quality. One-time browser sign-in. A free account covers about 2 minutes of
>    transcription a month; beyond that it needs a plan (https://www.veed.io/pricing).
> 2. **WhisperX, better quality** — free, runs locally, nothing leaves your machine. Slower, and the
>    first run installs it plus a model — around 2 GB of disk.
> 3. **WhisperX, fastest** — same, but quicker; weaker on names and jargon, which captions show off.
> 4. **Your own transcription service** — point me at it and I'll wire that up instead.
>
> I'll remember your pick.

Record the answer with the command — never hand-author that JSON, and **always include the tier** for
WhisperX so a later run cannot drift onto a different model:

| They chose | Record it as |
| --- | --- |
| 1 · VEED | `node --import tsx prep/transcribe.ts --record veed` |
| 2 · WhisperX, better | `node --import tsx prep/transcribe.ts --record whisperx --model medium` |
| 3 · WhisperX, fastest | `node --import tsx prep/transcribe.ts --record whisperx --model small.en` |
| 4 · their own service | `node --import tsx prep/transcribe.ts --record custom` |

If they answer "WhisperX" without choosing a tier, take **fastest** (`small.en`), record it, and say which
one you took — they can switch later. Never record `whisperx` with no tier.

- **veed** → `node --import tsx veed/go.ts <video.mp4> [...]`, login flow below. When the browser opens, say
  exactly: "I've opened a VEED login tab in your browser — click Allow if it asks. I'll wait here;
  there's nothing to paste."
- **whisperx** → `node --import tsx prep/transcribe.ts <video.mp4> [...]` — the recorded tier applies; pass
  `--model medium|small.en` only to override it. If the binary is missing, ASK before installing: "WhisperX isn't installed. It's a local
  Python tool — the install pulls in PyTorch and the first run downloads a model, so expect a slow first
  pass and around 2 GB of disk. It goes in its own isolated environment, not your system Python and not
  this project, and `uv tool uninstall whisperx` removes it again. Install it now?" On yes run
  `bash pipeline/scripts/install-whisperx.sh` and stream its output.
- **custom** → the user's service is yours to drive: get a Whisper-family JSON out of it (their MCP,
  their CLI, their API — their credentials, never handled here), then
  `node --import tsx prep/whisper.ts <json> <video.mp4>` — one json per video, repeated in pairs for a
  batch. We ship no helper for this.

OFFERING THE ALTERNATIVE — once, and in these words, so the user hears the actual trade rather than a
second nag:

- VEED sign-in declined → "No problem, I'll leave VEED alone. I can run WhisperX locally instead: free,
  offline, nothing leaves your machine. It needs a one-off install that pulls in PyTorch, so the first
  pass is slow. Want that?"
- WhisperX install declined → "Then I'll skip the local route. VEED transcription needs a one-time
  browser sign-in and runs on your VEED account's limits. Shall I open that instead?"
- Both declined → "Then I can't add captions — every caption is built from a transcript, and I won't
  invent one. Say the word if you change your mind about either option." Then stop.
- No audio track → "That clip has no audio track, so there's nothing to transcribe. Captions need speech
  to align to."

WHEN A RUN FAILS — classify it, because the right move differs and none of them is a silent retry:

- **Out of credits** (`veed/go.ts` says "out of transcription credits") → the account is the blocker, not
  the choice, so go back to the Q1 question with VEED still on the table: "VEED is out of transcription
  credits for this workspace — a free account covers about 2 minutes a month. You can add a plan at
  https://www.veed.io/pricing and I'll retry, or I can run WhisperX locally instead: free, offline, and
  it installs on first use. Which would you like?" Do not rewrite the recorded provider until something
  succeeds.
- **Login failed or expired** → run the login flow once more. If it fails again, treat it as declined and
  offer the alternative in the words above.
- **Anything else** (upload failure, poll timeout, network) → retry the command ONCE, then offer the
  alternative. A blip must not cost the user their provider choice.

Report the provider in ONE line once the transcript lands — "Transcribed with WhisperX (medium),
locally." or "Transcribed with VEED." — and relay any warning the run printed, e.g. "12 of 340 words came
back without timings, so those reveals are approximate; the text is complete." That single line is
allowed; step-by-step progress is not.

Re-ask only when the recorded provider is gone (token revoked, WhisperX uninstalled), when the user asks
to switch, or when a run failed and the alternative has not been offered yet; "switch transcription
provider" means rewrite that file.

LOGIN (if `go.ts` says "No VEED login found"): OAuth needs the user to authenticate in a browser once,
but you (the agent) launch it — do NOT just tell the user to run a command. Preferred flow (refreshable
token, ~30-day):
- Run `node --import tsx veed/login.ts` in the background — it starts a local catcher, prints an
  authorize URL, and OPENS THAT URL IN THE USER'S BROWSER ITSELF (`execFile('open', …)`). You open
  nothing: watch its output for `Logged in.` and meanwhile tell the user a VEED login tab has opened
  and to click "Allow" if a consent screen appears (usually it auto-approves — they're likely already
  signed into veed.io). The browser redirects to `http://127.0.0.1:8977/callback`, the running
  login.ts catches it, and stores the token. No pasting needed. If this box has no browser `open` can
  reach (headless/SSH), use `VEED_LOGIN_MANUAL=1 …` instead and paste the redirected URL back to it.
- If the OAuth flow misbehaves, re-run it. NEVER read the user's browser cookies or local storage
  to obtain a token, and never ask them to paste one out of DevTools.

Then the rest of prep (needs the transcript above for the beat times, whichever provider wrote it):
`node --import tsx prep/prep.ts <video.mp4> [...]`
Auto-detects aspect from the source and writes, under `runs/<key>/`:
- `meta.json` — the single source of truth downstream: canvas `width/height/fps`, `durationSec`, and all paths
  (`videoPath`, `transcriptPath`, `wordTimingsPath`, `framesDir`). Canvas = the source's own dims
  (rotation-corrected) and fps, probed by prep; `aspect` = portrait (9:16) or landscape (16:9) label.
- `word-timings.json` — per beat: `cueDelayMs`/`cueDurMs` + every word's absolute-ms `delayMs`, synthesized
  from the VEED chunks' real per-word times (even split only if a transcript has none). Step 4 pastes
  these VERBATIM — compiled recipes by construction, the inline creative passes per the director brief;
  timing is never re-derived.
- `frames/beat-N.png` — one clean still per beat at the chunk MID time, emitted at HALF canvas (×2 → canvas).

### 2. ANALYSE — frames + transcript → analysis.json  · AGENT (vision) — OPT-IN, refine only
**SKIP this step by default.** Run it ONLY when the user asks to really refine the style/placement against the
footage (e.g. "refine the style", "tuck the captions into the negative space"). On such a request: run this
step, then re-run step 4 as the FROM-SCRATCH inline pass (variant B — compiled recipes are deterministic and
ignore `analysis.json`; the pass finds the file and composes from it), then step 5. On a refine-only re-run (no
user-brought materials) fill the execution contract's USER MATERIALS slot with `none — hold the delivered run's system;
compose placement from analysis.json` and use the delivered pick's sheet + its nearest alternate as the
craft substrate.

When run: spawn ONE **nameless background** vision subagent (never a named teammate — a teammate hangs after
finishing and is slower; a nameless background subagent self-exits and writes to disk). This is the **only
vision pass** — the design pass composes from `analysis.json`, not the frames. It reads `meta.json` +
`transcript.json` + EVERY `frames/beat-N.png` and writes `runs/<key>/analysis.json`. The frame is HALF
canvas → **×2 every pixel** to canvas px.

Spawn prompt (fill {…}):
```
You are the SHOT-ANALYSIS agent for ONE short-form video. Read inputs, write ONE JSON file, return a summary. No design.
INPUTS: {repo}/runs/{key}/meta.json (canvas W/H/fps/durationSec) · {repo}/runs/{key}/transcript.json (chunks = beats, in order)
        · every {repo}/runs/{key}/frames/beat-N.png (the still at each beat's mid).
The frames are HALF canvas ({W/2}×{H/2}); report everything in CANVAS px → ×2 every pixel you read off a frame.
For EACH beat N (1-indexed, matching chunk N) record: shot (wide|med|close); subjectBbox [x,y,w,h]; faceBbox [x,y,w,h]
or null (close-ups only); negSpaceRect [x,y,w,h] = the LARGEST clean rect where type can live off the subject/face;
brightness of that zone (light|mid|dark|busy).
WRITE {repo}/runs/{key}/analysis.json EXACTLY:
  {"beats":[{"i":1,"text":"…","startSec":s,"endSec":s,"midSec":s,"midFrame":round(midSec*{FPS}),
             "shot":"…","subjectBbox":[x,y,w,h],"faceBbox":[x,y,w,h]|null,"negSpaceRect":[x,y,w,h],
             "brightness":"…"}, …]}
  (startSec/endSec/midSec from transcript chunk N's timestamp; midSec=(start+end)/2.)
RETURN tight: video format (9:16|16:9) · overall vibe/genre · subject + setting · energy (calm|hype). No preamble.
```

### 3. SAMPLE ONE STYLE — deterministic, zero tokens  · SCRIPT
`node --import tsx pipeline/scripts/sample-style.ts --run runs/<key>`
Facet-scored seeded draw of ONE aspect-matched ref from `refs/tags.json` (v3: the RUNTIME INDEX —
recipes only; `fit` is the aspect SOT). Vibe comes from the transcript automatically (energy from word
rate/caps/exclamations — no LLM, no frames) and weights the draw; same run key → same ref. Writes
`runs/<key>/style.json` `{refId, refPath, facets, hasRecipe, seed, energy, coverage, alternates}`.
The script's `recipe=yes|no` OUTPUT is the routing decision for step 4 — never parse or hand-edit
`style.json` yourself (the index is fully compiled, so an implicit draw always prints `recipe=yes`).
The drawn ref id and everything in `style.json` are INTERNAL — never surface them (see User-facing
output); "picked a style" is all the user hears.
Overrides: `--seed N` (browse alternatives), `--style <id>` (the user asked for a look — must be an
index id; anything outside the index is not a runtime pick and the script rejects it).
- **THE INDEX IS THE RUNTIME UNIVERSE**: every entry ships a validated sheet (`refs/html/<id>/recipe.md`)
  + its compiled module (`recipe.ts`) — the script fail-louds on any entry missing either, or missing
  its prefab.
- **COVERAGE MODE** (`coverage.filtered:false` — possible only if curation ever shrinks an aspect below
  the threshold): STOP and tell the user honestly the aspect isn't covered by recipes; options are
  `--style` by their explicit pick or cancel. NEVER reach for the from-scratch pass to paper over a coverage gap.
- **RECIPES ARE THE PRODUCT**: the draw, `--style`, and `alternates` are all RECIPE-BACKED only —
  the runtime index contains nothing else.
- **CREATIVE PASS, two faces**: the user does NOT know recipes exist and never needs to — route on the
  SHAPE of the ask, never on whether they said "mix".
  **face-1** — the prompt ARRIVES WITH the user's OWN reference/brand/concept (an image, a brand kit, a
  described idea): skip the draw-and-ship — run the from-scratch INLINE pass (step 4 variant B). The USER'S
  materials are the design authority (their files/links must be OPENED and looked at); 1-2
  nearest recipe SHEETS (picked from `refs/tags.json` by facets — closest type/energy; `alternates`
  in style.json is a ready shortlist) ride along as engine-proven craft substrate — mechanics only,
  never their look. Those sheets may come from EITHER aspect: a mechanic, an engine workaround or a
  calibration note is not aspect-bound, and the pool is small enough that locking to one `fit`
  throws away half the proven craft. Anything GEOMETRIC taken from an off-aspect sheet (bands,
  margins, ladder px, placement constants) is re-derived at this run's canvas — see the cross-aspect
  rule in `director-brief.md`. Set a **DIRECTION** — content angle, mood/energy,
  placement intent ONLY (never fonts/palette/device — those come from the user's materials; on any
  collision the user's materials win).
  **face-2** — the user iterates on a DELIVERED result:
  - **REMIX is the DEFAULT creative answer.** ANY iteration carrying creative input — "make it more
    interesting", "surprise me", a mood/direction, a concrete aesthetic change — goes STRAIGHT to
    REMIX on the first ask. No re-roll step in between. (Inline, at session effort — you compose it
    yourself, no subagent): pick 2-3 INGREDIENT sheets from the runtime index — the current pick is
    the SKELETON donor (A); choose a TYPE+PALETTE donor (B) with a DIFFERENT `type` facet and
    (optionally) a DEVICE donor (C) with a DIFFERENT `device` facet (read `refs/tags.json` facets to
    pick contrast deliberately). **A must match the run's aspect** — its skeleton carries the canvas
    geometry. **B and C may come from EITHER aspect**: type, palette, device and motion ideas are
    aspect-free, so a landscape run draws on portrait recipes and vice versa; re-derive every
    geometric number from that donor at this canvas. Execute per `director-brief.md` REMIX
    MODE in a fresh run dir `runs/<key>-remix` — then the same gates: lint → verify → record →
    probe → mux (commands in step 4). Never a raw prefab, never an id outside the index.
  - **RE-ROLL only when the user asks for VARIANTS, not for creative input**: "show me more options",
    "another style", "make 5 different versions" (that's N draws — run them as N `--seed`s through
    step 4A, parallel when N>1). Re-roll serves the user who never had an idea in the first place;
    the moment the ask carries ANY creative direction it is a REMIX, never a re-roll.
  - Defect repairs (typo, overlap, out-of-sync word) are neither — fix at the SOURCE, then re-run the
    gates. Creative-run output (face-1/REMIX — agent-authored) → patch the run's template directly.
    Recipe-run output → NEVER hand-edit the generated .wv document (generate-recipe.ts owns it): a text/timing
    defect = fix transcript/word-timings and re-run the script; placement-vs-footage = the refine path
    (step 2); a deliberate one-run tweak = the CUSTOMISING `--module` copy (step 4A).

Then, for FACE-1 runs only, set:
- **ENGAGEMENT mode** — pass the seed copy VERBATIM to step 4 (see below; wording changes output).
- **ANIMATION LEVEL** — `word` (default; almost always) / `cue` line (titles, or plain/corporate) / `none`
  (minimal/corporate). Respect any stated user preference; ask if genuinely unsure.
(Recipe runs need NONE of these — the compiled recipe fixes engagement, animation, and design. A REMIX
needs neither: its look comes from the donor sheets per the brief's REMIX MODE.)

### 4. DESIGN + RENDER — SCRIPT (recipe) / INLINE (creative face-1 · remix)
Route by the SHAPE of the run (step 3's script output + the creative-pass routing own this decision):
- variant A (`recipe=yes` — every default run): **SCRIPT — no agent, no model, zero tokens.** The recipe
  is compiled code. (Rerun the step-3 script if you no longer have its output — same run key → same result.)
- variant B (creative face-1; also refine re-runs after step 2): INLINE — you execute the from-scratch
  contract (B below) YOURSELF, no subagent. A default run can NEVER route here: the runtime index is
  recipes-only, so an implicit draw always has a recipe.
- REMIX (face-2 creative iteration): INLINE — you author the donor blend yourself per
  `director-brief.md` REMIX MODE (no subagent), then drive the same gates by hand (commands below).
- NO VIDEO (see INPUTS): INLINE — there was no step 1 or 3, so there is no recipe to route to and nothing
  to route on. Author per `director-brief.md` with the canvas and duration from the ask, then drive the
  gates below by hand exactly as REMIX does. A footage-free run is as supported as any other; what it
  lacks is a source file to derive from, not a path through this step.

**A. COMPILED RECIPE (`hasRecipe:true`)** — the recipe did the design thinking offline; code does the
assembly. Run (OUTSIDE any sandbox — the engine needs the window-server):
```
node --import tsx pipeline/scripts/generate-recipe.ts --run runs/<key> --record
```
One invocation runs the FULL gate chain: loads the ref's compiled recipe (`refs/html/<id>/recipe.ts`),
generates `runs/<key>/final/{template.wv, manifest.json}` from `meta.json` + `word-timings.json` (word
delays pasted verbatim by construction), LINTS it (engine-limit anti-patterns — a lint error is a
generator bug, never hand-fixed), runs `--verify` with the mechanical fix loop (a `FAIL[bounds]` on a
title line steps that page down the size ladder and regenerates; ≤2 cycles), records
`final/out.silent.mp4` (`--progress-output` lines stream — watch them to see it's alive; don't narrate
them to the user), then PROBES
the render (`probe-qa`: per-beat mid + tail frames vs the source — caption present, WCAG-ish contrast —
the defects `--verify` can't see). Exits:
**0** → step 5 · **1** = a gate failed — report the failure honestly in plain terms (raw FAIL lines only
on request); on a probe FAIL offer a
`--seed`/`--style` re-run; never redesign or hand-edit the .wv document · **3** = the sampled ref has no compiled
recipe (stale `style.json`; rerun step 3).

CUSTOMISING (only when the user explicitly asks for a tweak to a recipe run): **NEVER edit a library
recipe (`refs/html/<id>/recipe.ts`) in place** — it is validated, shared by every run. COPY it to your
scratchpad first, rewrite its relative lib import to the absolute path of
`{repo}/pipeline/recipes/lib.ts`, edit the copy, then run the same command with `--module <copy path>`.
The default run needs none of this — no copy, no edit; just run the command above.

**B. FROM-SCRATCH (creative face-1)** — the base design contract driven by the USER'S materials (their
reference video/images/brand kit/described concept), with 1-2 nearest recipe SHEETS from the runtime
index as engine-proven craft substrate. Execute it INLINE yourself — NO subagent, exactly like the remix
face: read `pipeline/director-brief.md`, study the user's materials, then author and gate the .wv document in
THIS session. (Inline is what keeps the flow alive in one-shot/headless runs — nothing to orphan when the
turn ends — and keeps the design in YOUR context so the user's follow-up tweaks iterate instantly.)
Commit ONE design system in a single pass (no aesthetic re-litigation), author ONE single-timeline
`.wv` document over the FULL footage, then self-verify with lint + `veed-engine-cli --verify` and render. The
engine contract (`pipeline/director-brief.md`) is the crown jewel — obey it exactly. Raw prefabs are NOT
inputs here — the user's materials are the design authority; our contribution is validated craft, not
uncured references. (Refine re-runs after step 2 use this same variant — see step 2 for how to fill the
materials slot then.)

Execution contract (follow it YOURSELF, filling {…}):
```
Author ONE captioned composition over the
footage as a single-timeline .wv document, verify it with --verify, then render it.
CONTRACT (obey exactly): READ {repo}/pipeline/director-brief.md — it is the full engine contract (paint order,
the opacity/stacking trap, the one safe reveal recipe, engine limits, the single-timeline mechanic, render+verify).
INPUTS:
  - {repo}/runs/{key}/meta.json — canvas W/H/fps + durationSec + paths (authoritative for the manifest).
  - {repo}/runs/{key}/analysis.json — ONLY IF IT EXISTS (refine runs): per-beat composition facts in CANVAS px
    (shot, subjectBbox, faceBbox, negSpaceRect, brightness, caption text + start/end/mid/midFrame). If present,
    COMPOSE FROM THESE NUMBERS. If absent (the default), compose from the transcript + the brief's safe
    margins. EITHER WAY you never read the frames.
  - {repo}/runs/{key}/transcript.json — captions + windows; chunks carry REAL per-word timings in
    `words: [{text, timestamp:[start,end]}]` — animate each word on ITS OWN window (fake by even-split
    ONLY in the unlikely case a chunk has no `words` array).
  - video {videoPath} (in meta.json).
METHOD: the USER'S MATERIALS below ARE the design authority — OPEN them (images/files included) and study
their design DNA: positions, fonts, weights, sizes, colours, letter-spacing, shadows, mood. Translate it into
an engine-safe system; adopt and REMIX, never copy their content verbatim. The CRAFT SUBSTRATE sheets are
validated, engine-proven recipes from our bank — lift their MECHANICS (timing idioms, grounding, width
budgets, engine workarounds), NOT their look, unless the user's materials point the same way.
USER MATERIALS (design authority): {paths / links / the user's described concept — whatever they brought}.
CRAFT SUBSTRATE (recipe sheets, engine-proven; nearest by facets):
  1. {repo}/refs/html/{idA}/recipe.md   2. {repo}/refs/html/{idB}/recipe.md
DIRECTION = {the aesthetic lane: content angle + mood + placement intent; NO fonts/palette/device}.
ENGAGEMENT MODE = {seed copy — verbatim}.
ANIMATION LEVEL = {word | cue | none}.
TASK: LOCK ONE system (2-3 Google @import fonts + limited palette + ONE recurring device, pulled FROM the
user's materials — craft-substrate sheets supply the engine-safe mechanics);
hold it across all beats; vary scale/composition per beat; escalate hook → close. Author ONE
{repo}/runs/{key}/final/template.wv (z0 base video FIRST; EVERY text layer position:absolute + explicit
z-index>=1 + a UNIQUE `id` e.g. id="cap3" — see the opacity trap; the id makes --verify name the element in
its failure lines; each caption visible only in its cue window) +
{repo}/runs/{key}/final/manifest.json {"render":{"width":W,"height":H,"fps":FPS,"duration":durationSec}}.
RENDER + VERIFY (OUTSIDE any sandbox — needs the window-server; binary = {repo}/.veed-engine/veed-engine-cli, NOT on PATH):
  0. LINT (mechanical, no engine): node --import tsx {repo}/pipeline/scripts/lint-template.ts {repo}/runs/{key}/final/template.wv
     — engine-limit anti-patterns (var-in-keyframes, animated blur, the stacking trap, missing cue ids).
     Exit 1 → fix the flagged rule, re-lint before verifying.
  1. VERIFY (analytic, fast, no video, reads manifest render block):
       {repo}/.veed-engine/veed-engine-cli {repo}/runs/{key}/final --verify
     It replays the whole timeline offscreen and checks the REAL draw list. Exit 0 = clean. Exit 1 = it prints ONE
     stdout line per problem, naming the element id, e.g.:
       frame 3 t=0.400s FAIL[bounds] #cap3 glyph 14 right 3.1px outside (8.42% of glyph box) viewport 736x1312
       FAIL[never-visible] #cap5 glyph 2 ink in 300 frames, never fully visible (best 0.00% at frame 0 ...)
       frame 2 t=0.200s FAIL[occluded] #cap2 glyph 5 fully covered by later opaque rect
     Built-in rules = the exact defects this pipeline hits: bounds (type off the viewport), never-visible (type
     clipped away in EVERY frame — e.g. stuck behind a mask/box), occluded (type fully hidden under a later opaque
     layer — the z-order/opacity trap). Fix ONLY the flagged element (nudge inside the safe zone / fix z-order or the
     mask) and re-run --verify until exit 0. (exit 2 = engine render failure = a real authoring error, not a nit.)
  2. (OPTIONAL) word-reveal TIMING: to assert a caption is shown/hidden in a time window, add a "verify" block to
     manifest.json alongside "render": {"verify":{"expect":[{"element":"cap3","visible":true,"from":2.1,"to":3.4}]}}.
     --verify then FAILs[expect-visible]/[expect-hidden] if a word isn't on-screen when it should be. Use when a
     beat's reveal timing is subtle; ids only (a word with no id can't be targeted).
  3. RECORD the deliverable — ONLY after --verify is clean. --verify and --record are mutually exclusive, so this is a
     SECOND invocation:
       {repo}/.veed-engine/veed-engine-cli {repo}/runs/{key}/final --progress-output --record {repo}/runs/{key}/final/out.silent.mp4
     --progress-output prints `progress: N/M frames (X%)` lines during the record; recording is long-running —
     watch these to confirm it's alive, but don't narrate them to the user.
  Change NOTHING else — no aesthetic/colour/font/device/animation/timing edits. Author correctly up front (recipe +
  limits in the brief) so --verify passes first try; it is a safety net, not a design loop. (probe-qa — the
  mechanical frame QA — comes right AFTER the record step; it is not part of the verify loop.)
OUTPUT: {repo}/runs/{key}/final/{template.wv, manifest.json, out.silent.mp4}.
THEN (same turn, no pause): note the locked system so you can describe the delivered look in plain
terms (aesthetic, fonts, palette, device — not gate status) and continue straight to probe-qa + mux.
```

After recording: run the last gate —
`node --import tsx pipeline/scripts/probe-qa.ts runs/<key>` (mechanical frame QA: per-beat mid + tail
probes vs the source — caption present, WCAG-ish contrast). FAIL → do NOT redesign and do NOT
auto-re-render: report honestly in plain terms and pick the fix WITH the user. Warns → proceed to mux;
surface one only if it's likely visible in the deliverable.

**REMIX EXECUTION (face-2, inline — no subagent).** Set up a fresh run dir `runs/<key>-remix`: copy
`meta.json`, `transcript.json`, `word-timings.json` from `runs/<key>` (same footage, same timings; update
the `key` field inside `meta.json` to `<key>-remix` so downstream paths stay coherent). Pick donors per
step 3 (A = current pick's sheet as skeleton, same aspect; B = different `type` facet; optional C =
different `device` facet — B and C may be off-aspect, geometry re-derived at this canvas; sheets at
`refs/html/<id>/recipe.md`), author
`runs/<key>-remix/final/{template.wv, manifest.json}` per `director-brief.md` REMIX MODE, then drive
the gates yourself (verify/record OUTSIDE any sandbox):
  1. `node --import tsx pipeline/scripts/lint-template.ts runs/<key>-remix/final/template.wv` — exit 1 →
     fix the flagged rule, re-lint.
  2. `.veed-engine/veed-engine-cli runs/<key>-remix/final --verify` — fix ONLY flagged elements, re-run to
     exit 0 (≤2 fix cycles, then stop and report honestly).
  3. `.veed-engine/veed-engine-cli runs/<key>-remix/final --progress-output --record runs/<key>-remix/final/out.silent.mp4`
     — the `progress:` lines confirm it's alive; don't narrate them.
  4. `node --import tsx pipeline/scripts/probe-qa.ts runs/<key>-remix` — FAIL → report honestly in plain
     terms, never redesign; warns → proceed.
Then step 5 (mux) on `runs/<key>-remix`. The deliverable lives next to the original — the user compares.

### 5. MUX AUDIO — restore the soundtrack  · SCRIPT
the engine renders video only. `bash pipeline/scripts/mux-audio.sh runs/<key>` muxes the original audio onto
`final/out.silent.mp4` → **`runs/<key>/final/out.mp4`** (the deliverable). `-map 1:a:0?` tolerates a source with
no audio track; `-shortest` trims to video length. Deliver `out.mp4` to the user — this is the FIRST
moment the run is presented as done (never announce the silent render or muxing separately).
With NO source video there is no soundtrack to restore and no source for the script to read: copy
`final/out.silent.mp4` to `final/out.mp4` and deliver that, so the deliverable path is the same for
every run. A silent deliverable is a complete one here, not a failed mux.

### 5.5 PREVIEW — open the localhost preview  · SCRIPT (parallel, non-blocking)
As soon as render is DONE, launch the preview server in the BACKGROUND, OUTSIDE any sandbox, and continue
immediately:
`node --import tsx preview/server.ts runs/<key>`
(OUTSIDE the sandbox because recursive fs.watch needs FSEvents, which the sandbox's filesystem
interception blocks; if launched sandboxed anyway, the server falls back to 2s polling.)
It prints `preview: http://127.0.0.1:<port>/` and opens the user's browser (VEED_PREVIEW_NO_OPEN=1 to
just print). NEVER set VEED_PREVIEW_NO_OPEN yourself — the auto-open IS the live-preview experience, on
EVERY path (recipe and creative alike); suppress it only when the user explicitly asks for no browser.
Share the URL with the user in one line. The preview is READ-ONLY in V1; transcript changes go through
YOU in chat, not the page. The page live-updates (when user requests amends) off the run dir as later
steps write files and swaps to `final/out.mp4` on its own — do NOT re-open or restart it for re-renders
of the SAME run dir. The preview is PINNED to the run dir it was launched with: creative-pass outputs
live in SIBLING dirs (`runs/<key>-remix`, re-roll variants) and never appear in it — share the
sibling's `final/out.mp4` path directly, or launch a second preview on the new dir (it self-selects a
free port; the printed URL is the truth — an old tab on :8978 may belong to an earlier server).

Kill the server(s) when the session wraps up.

## Engagement modes — keep the seed copy VERBATIM (wording changes output)
- **scroll-stopping** (default, social): "the first frame must STOP the thumb — big numbers, oversized, chrome/neon, saturated; optimize for a feed."
- **wow**: "push the WOW ceiling — oversized, bleed past edges, heavy effects."
- **design-grade**: "gallery-quality AND maximally engaging — high-design, premium, crisp."
- **variety / bold-broadcast** (good for 16:9 landscape): "loud broadcast / sports-lower-third energy; big type in the landscape thirds; heavy effects."

## Gotchas
- veed-engine-cli is checked by Step 0 (preflight) — keep it current via `bash pipeline/scripts/install-veed-engine.sh`; macOS-arm64 binary. Older builds lose features (e.g. pre-0.3 = no shadows = major degrade).
- Sandbox: step 1 (veed/go.ts) needs network egress to `*.veed.io` — a sandboxed
  `fetch failed` there means the sandbox blocked the call; re-run it outside the sandbox. Step 4's
  engine `--verify`/`--record` always runs OUTSIDE the sandbox (it needs the window-server).
- Recipes are COMPILED CODE (`refs/html/<id>/recipe.ts` over the shared `pipeline/recipes/lib.ts`),
  authored + validated OFFLINE, one-time per ref (derived from the ref's prose sheet
  `refs/html/<id>/recipe.md` — which doubles as the creative pass's craft-substrate/donor material) —
  the fast path only ever RUNS them via `generate-recipe.ts`. The runtime index is recipes-only, so
  implicit runs are always scripted end to end; the from-scratch inline pass runs only for creative face-1
  (and refine re-runs).
- **USER MATERIALS GET OPENED** (creative face-1): the design pass OPENS and studies the user's
  files/links (that's the point). The opt-in ANALYSE pass stays
  the only agent that reads the FOOTAGE frames.
- Word timing is NEVER invented — step 4 pastes `word-timings.json` delays verbatim (compiled recipes do
  this by construction).
- The preview server (step 5.5) is loopback-only and additive — if its default port 8978 is busy (an
  orphan from a dead session), it self-selects an ephemeral port; trust the URL it prints.
- TRANSCRIPTION WARNINGS (local provider) — read them precisely, same discipline as the font rules below.
  A WhisperX run prints a wall of `Could not load libtorchcodec`, `dlopen` failures and
  `Library not loaded: @rpath/libavutil.<N>.dylib` for several FFmpeg majors, plus a Lightning
  checkpoint-upgrade notice. Those are pyannote probing FFmpeg builds it cannot find and are HARMLESS —
  they look fatal and are not. The signal that transcription actually worked is the line
  `[transcribe] whisperx: <N> words -> <path>`: if it appears, the transcript is written and you continue.
  If it does NOT appear, the run failed for a real reason — read the last error, not the dlopen wall.
- Rendering fetches Google Fonts over the network (the .wv documents use a `<link>` to `fonts.googleapis.com`);
  an offline box = font fallback.
  FONT WARNINGS — read them precisely, don't chase noise: `no data/font-cache seed found`, generic-keyword
  lines — `'sans-serif'`, `'serif'`, `'cursive'`, `'monospace'`, `'system-ui'` `unresolved by Google` — and
  `has no italic face; substituting upright` come
  from unsourceable fallback-chain members and are HARMLESS. A warning naming YOUR display family
  (`'<Family>' unresolved by Google — rendering with embedded variable fallback`) is REAL — the type
  identity is gone; stop and fix the import/network before recording. (The engine's bundled
  `.veed-engine/data/fonts/` registry ships as dead Git-LFS pointers in current releases — upstream packaging
  bug; only live Google fetches resolve real families.)
- Ref pool = `refs/tags.json` (v3, the RUNTIME INDEX — recipes only; every entry ships
  `template.wv` + `recipe.md` + `recipe.ts`).
- DIRECTION never names fonts/palette/device — on creative runs those come from the USER'S materials
  (the design authority); craft-substrate sheets contribute mechanics only.
- **Don't scan the bulk asset dir** — `refs/html/` is data, not code. Never `ls -R`/glob it broadly; pick via `refs/tags.json`.
