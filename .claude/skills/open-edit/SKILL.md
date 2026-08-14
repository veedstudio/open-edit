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
  and any install happen once; STYLE, DESIGN + RENDER and MUX then run per `runs/<key>`.
- **No video — FULLY SUPPORTED, not a degraded mode.** Motion graphics, stills, slides, generated
  imagery, audio-only sources. Author the `.wv` INLINE per `pipeline/director-brief.md` and run the SAME
  gates as every other run: `lint-template.ts` → `veed-engine-cli <dir> --verify` → `--record` (the DESIGN + RENDER step's
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

Default run (the FAST PATH) = PREFLIGHT → PREP → SAMPLE ONE STYLE → DESIGN + RENDER → MUX AUDIO (ANALYSE is SKIPPED). Vibe/genre/energy come from the
transcript; placement comes from the brief's safe margins; the style is SAMPLED by script; word reveal
timings are precomputed (`word-timings.json`). The runtime index is recipes-only, so a default run's DESIGN + RENDER step
is always `pipeline/scripts/generate-recipe.ts` — a SCRIPT, no model, no subagent: the recipe already did
the design thinking, offline, and the code does the assembly + the full gate chain (lint → verify → record
→ probe). Creative face-1 is authored INLINE by the orchestrator; the only spawned agent is the opt-in analyse pass.
REFINEMENT is declared by `analysis.json` existing (the ANALYSE step ran on user request) — placement then composes
from it instead of the safe margins.

## User-facing output — talk like a product, not a pipeline
The user asked for a video, not a pipeline tour. Internals are NEVER surfaced: run keys,
ref/style ids (`hook-…`), "recipe"/"recipe-backed", seeds, facets, energy scores, beat counts, frame
counts, gate names (lint / `--verify` / probe-qa), engine details. A fresh user has no idea what
any of that means. The CLASSIC POOL is equally internal: never say "classic", "preset", "route", or a
preset id (`simple`, `glass`, …) — "Classic route, 'simple' preset" is exactly the leak this section
bars. The user asked for clean captions; say you're on it, then deliver.
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

Written for the footage case. PREFLIGHT, FOOTAGE, DESIGN + RENDER and PREVIEW hold for every run; **PREP**
(transcript, frames, meta), **SAMPLE ONE STYLE** (the style draw) and **MUX AUDIO** derive from a source
file, so a run with no video simply has no subject for them — see INPUTS: authoring, lint, `--verify` and
`--record` are unchanged.

### PREFLIGHT — completed above  · SCRIPT
Do not run a second dependency implementation. `pipeline/scripts/preflight.sh` is only a compatibility wrapper
around the skill-bundled preflight. The provider choice — and any sign-in or install it implies —
remains the interactive PREP step.

### FOOTAGE — a video to work from, generate one, or none  · SCRIPT (only when the user brought none; runs before PREP)
This step is about VIDEO only — stills, screenshots, slides, images and audio are inputs too, and a run can
have them with no video at all. If the user supplied a video, continue to the PREP step unchanged. Otherwise do
NOT assume a video is needed — read the ask first:
- **They have a clip, or will record one** → take the path, waiting for the filename if it is still coming,
  then continue to the PREP step unchanged.
- **VEED Fabric** (recommend this when they want a talking head) → a talking-head clip from a script, billed to one of their VEED
  workspaces. **Fabric REUSES VEED transcription's authentication** — the same veed.io account, the same
  OAuth login, the same stored token. There is no Fabric connector and no second sign-in: if they are
  already signed in for VEED transcription, they are signed in for this. Continue below.
- **Another model** (Veo, Kling, Luma, anything on fal) → their auth and their bill, not ours; take the
  finished file into the PREP step. Say this in the SAME BREATH as that option, every time: captions come from
  TRANSCRIBING the clip's audio, so the clip must contain SPEECH. Veo 3 does. Veo 2, Kling, Luma and most of
  fal's catalogue are SILENT, and a silent clip yields an empty transcript and no captions. This is a
  warning, not a decision — say it, then let them proceed.
- **No video — work with other sources** → raster graphics (stills, screenshots, photos), vector graphics
  (logos, shapes, SVG), motion graphics (titles, kinetic type, animation), or generated imagery, in any
  combination. Build the piece from those: go straight to the DESIGN + RENDER step, which reads no footage. If
  they have AUDIO it can still be transcribed for captions; PREP, the style draw and MUX are skipped for want
  of a video subject.

Only when the ask is FOR a video of something but none is attached is there a real question — and even then
"no video" sometimes just means they forgot to attach the file, so if it is ambiguous, ask which of these it
is rather than guessing; a no-video answer is as good as any clip.

On the Fabric path exactly three things stop and ask: this footage question, WHOSE credits, and the credit
approval. Everything else — logging in, generating, reporting the charge — is a step: do it, say what
happened, keep moving.

**LOG IN BEFORE THE FIRST FABRIC COMMAND.** Every command below needs the VEED token — the SAME token VEED
transcription uses, not a second one — so establish the login here rather than discovering it is missing
mid-flow. If a command reports "No VEED login found", run the
browser flow YOURSELF exactly as the PREP step's LOGIN block below describes — you launch it, the user never runs a
command and never pastes a token. It is skipped when a token is already stored; one login covers generation
AND transcription and lasts about a month.

Draft the script yourself from their prompt and show it for edit. This is **two commands, and the script is
typed only in the first one.**

**WHOSE credits.** Generation spends the AI Playground credits of ONE
workspace. With exactly one on the account there is nothing to decide, so it is used and NAMED with what it
holds; with several and no prior answer the CLI stops and asks, and never picks. Run the confirm
command with NO workspace flag first:
`node --import tsx veed/generate.ts --script "<the script>" --key <key>`
With no workspace chosen it stops having spent nothing (exit 1) and prints every workspace with its name and
credit balance. Put that choice to the user in plain terms (the names and what each has left, not ids if you
can avoid them), then re-run naming the one they picked — that re-run is the PREP step below. That choice is
remembered at `veed/.veed-workspace.json`, but a remembered choice is never a settled one: a spend pass whose
workspace was only remembered REFUSES until the command names it again. Put the remembered workspace and its
balance to the user, get a yes, and carry `--workspace <id>` on the spend command — the same flag switches it
whenever they want a different one.

**WHAT IT COSTS.** Generating draws AI Playground credits TWICE: the speech is synthesized first, then
handed to **Fabric One Lipsync** (`veed/fabric-one-lipsync`), and both debits land on the same credit
allowance.
- **Fabric One Lipsync** — ~4 credits per SECOND of finished video, measured.
- **Speech synthesis** — 2 credits per minute of generated audio, rounded up to the whole minute, so any
  read up to a minute costs 2.

The quoted figure is the SUM of both. The script LENGTH is the lever, because it decides how long the
read is — but how long is a property of the VOICE, and measured voices run from about 11 to 18 characters
a second. So a 900-character script is a minute of video in one voice and a minute and a half in another,
which is the difference between roughly 200 and 320 credits. The tool quotes at the rate it has measured
for that voice, and quotes a RANGE when it has never heard it; repeat the range rather than flattening it
to its low end, and never anchor the user on a small number. Too expensive → redraft a shorter script, or
any of the other answers to the footage question; never a different workspace. The figure quoted before
the spend is OUR estimate; VEED quotes no per-job price.

**THE PRESENTER CAN BE THEIRS.** The 24 presets are a menu, not the boundary — the model takes an image,
and it does not care where it came from. `--image <url|path>` uses the user's own still INSTEAD of a
preset: a URL is fetched by VEED, a local file is uploaded from here. Reach for it whenever they brought
a face, a logo, a character sheet or a frame they like. A preset carries a default voice and a user image
does not, so `--voice` is required with `--image`.

**A SET of images is ONE approval.** Several stills is one video made of several shots, so it is one
question, not N. Write a shots file — `[{ id, script, image | character, voice }, …]` — and confirm the
whole set at once:
`node --import tsx veed/generate-set.ts --shots shots.json --key <key> --workspace <id>`
It prints every shot with its own share of the cost and ONE total, then spends the lot on a single
`--yes`. The approval is hashed over the whole set: edit a line, reorder two shots, swap an image or a
voice, and it refuses rather than buying something nobody saw. Each shot still runs under its own key, so
a failure halfway leaves the shots already paid for alone and `--resume` collects them. Then join:
`node --import tsx pipeline/scripts/concat-videos.ts <out.mp4> <clip1.mp4> <clip2.mp4> [...]`
It fits each clip into one canvas and pads the rest rather than cropping, because stills of different
shapes produce clips of different sizes and nothing should lose its framing to a join. The result is an
ordinary source file: transcribe it, caption it, render it like any other footage.

**That joiner is for SOURCE clips that disagree, and only those.** It re-encodes and normalises the
frame rate, which is right for generated clips of different shapes and wrong for anything else. The
finished chapters of a long piece are joined by `pipeline/scripts/concat-chapters.ts`, which
stream-copies and refuses parts whose format differs rather than transcoding a whole film — see the
DESIGN + RENDER step. Reaching for the wrong one costs a re-encode and silently resamples a 24 or 25
fps film to 30.

**WHO presents it.** If the user has no opinion about the presenter, do not paste 24 thumbnails at them:
`node --import tsx veed/sample-presenter.ts --key <key> [--gender male|female] [--locale <locale>] [--portrait|--landscape]`
PROPOSES one character + voice, prints two or three alternates with thumbnail and audio-preview links, and
ends with the ready-to-run confirm command carrying that pair. `--portrait`/`--landscape` is how FRAMING gets
chosen (the character IS the framing — there is no aspect parameter), so pass the one the user's format needs.
It proposes, it never decides — it costs 0 credits, writes nothing, and the user overrules it with `--seed N`
or by editing the two ids. Show them the pick and the alternates and get a yes before you run the confirm
command.

1. CONFIRM (spends NOTHING):
   `node --import tsx veed/generate.ts --script "<the script>" --key <key> --workspace <id>`
   It prints the script, the character, voice, framing ("portrait 9:16"), the workspace being billed with its
   balance, and the exact credit cost, records that approval at `runs/<key>/.fabric-pending.json`, and prints
   the exact next command. Show the user the cost in plain terms and get an explicit yes.
   NOT ENOUGH CREDITS is checked HERE too, before anything is written: if the workspace's balance is below the
   quote this step refuses, names both figures, and records no approval — so it never hands you a "run exactly"
   command for the ANALYSE step that is guaranteed to fail.
2. SPEND (only after that yes) — copy the command it printed, **with no `--script`**:
   `node --import tsx veed/generate.ts --key <key> --yes`
   It re-confirms against the server and REFUSES to spend if the fresh quote is above the cost that was
   approved, if the recorded script no longer matches its hash, if the approval is over an hour old, or if a
   `--workspace` here disagrees with the one that was approved. In any of those cases nothing is charged:
   re-run the PREP step and get a fresh yes for the new figure.
   That yes binds the SCRIPT, the FIGURE (character, voice, framing, quoted cost) and the WORKSPACE together
   for one hour; if any of the three drifts the run refuses rather than charging something the user never saw.
   A quote that came in LOWER proceeds — only a rise refuses.
   NOT ENOUGH CREDITS is checked again HERE, against the balance as it stands right now (it can have moved
   since the PREP step) — the balance is what actually guards the money, and it refuses, names both figures, and
   charges nothing. That goes back to the workspace question — top the workspace up, shorten the script, or
   re-confirm against a workspace the user explicitly names. NEVER move the run to a richer workspace on their
   behalf; a balance that simply cannot be read is not a refusal and proceeds, on either step.

Passing `--script` together with `--yes` is an ERROR — re-typing the script is how the billed words drift
away from the priced ones, so pass 2 reads them off disk instead. A spent approval is deleted: one yes buys
one video.

**Say what it cost — and how much to trust the figure.** The number the run stands behind is OUR ESTIMATE
from the script's length — VEED quotes no per-job price and reports no per-job charge, so there is nothing
to confirm it against. That figure, and which workspace it came out of, go to the user in plain terms once
the video lands ("about 380 credits from <workspace>"), and never as a figure VEED confirmed. The run also
reads the workspace balance either side of the create call and offers the movement as CORROBORATION —
that balance is workspace-wide, so it moves for anything else billing the same workspace and can never be
stated as "this run cost N". Pass it on the same way the run prints it:
- The movement AGREES with the quote → give both, the quote as the figure and the movement as the check.
- The movement is BIGGER than the quote → say so, and say the observed number. A concurrent run billing that
  workspace is the likely cause; our estimate simply running low is the other, and neither can be ruled
  out. Tell the user to check that workspace — never quietly report the quote as if nothing had happened.
- The balance could not be read credibly → the run prints the ESTIMATE and labels it one; pass that
  on as an estimate, never as the charge.
A `--resume` reports on the same terms, and never re-decides a figure the spend pass already measured — a
balance read an hour later says nothing about a charge that landed then. Every attempt leaves its own audit
trail at `runs/<key>/.fabric-spend-<sessionId>.json`, so re-running a key never erases the earlier run's.
Never let a run that spent credits end silently about cost.

→ `runs/<key>/<key>.mp4`. Feed that path into the PREP step exactly like user-supplied footage. `<key>` names a
directory under `runs/`, so it must match letters, digits, `.`, `-`, `_` only, and may not be `.`, `..`,
or start with `-` (see `assertSafeKey` in `veed/generate.ts`).

**AFTER THE MONEY IS GONE.** The charge lands the moment the job is created, so nothing past that point is
ever retried automatically. Every attempt records itself at `runs/<key>/.fabric-charge-<sessionId>.json`
BEFORE it calls VEED, so an attempt that never came back is still visible. Three outcomes, and they are NOT
the same:
- **Generation FAILED** (VEED reports the job failed) — report plainly what VEED said. Do NOT re-run `--yes`
  to "retry": a retry is a SECOND charge for the same script. A fresh attempt needs a fresh confirm pass and
  a fresh explicit yes from the user; the dead job blocks nothing.
- **The run was interrupted** (transport blip, polling died, download stalled, closed laptop) — the video is
  already PAID FOR and nothing needs approving. Collect it with
  `node --import tsx veed/generate.ts --key <key> --resume`, which polls, downloads and spends NOTHING.
  Polling gives up after 15 minutes, or after a run of consecutive status-check failures — the job may still
  be finishing server-side, so always `--resume` before ever paying again.
- **The attempt vanished mid-charge** (`--yes` refuses saying a charge MAY have landed) — no job id was ever
  recorded, so nothing can collect it. Tell the user plainly that VEED may already have charged, and have
  them check that workspace's balance and videos around the time the refusal named. To free the key, run
  `node --import tsx veed/generate.ts --key <key> --abandon <sessionId>` with the id from the refusal; it
  clears that one record and nothing else, and any credits that attempt spent are gone.
`--yes` REFUSES while another run of the same key is charging, while a paid job is uncollected (it points at
`--resume`), and while an abandoned attempt is unresolved. Runs of DIFFERENT keys never block each other, and
running them at the same time is fine.

Defaults produce a 9:16 talking head. `--character` picks the presenter (this is ALSO how framing is
chosen — there is no aspect parameter) and `--voice` the accent; browse with the Fabric tools only if the
user asks. Generation takes several MINUTES for a short clip — tell them it is running, then go quiet.
The credit approval is the only gate here that SPENDS — never pass `--yes` without the user's explicit
approval — but the footage question and the workspace question are stop-and-ask too: three gates, and nothing
else in this step stops.

**On the "another model" path the bill and the craft are both yours.** Everything below applies to a
clip this repo did not commission — a generator on the user's own key, or footage the user brought.

**READ THE MODEL'S OWN DOCUMENTATION BEFORE THE FIRST CALL. Do not infer it from this file.** The
endpoint ids in `FAL_MODELS` are DEFAULTS, not a catalogue: `--model` reaches any endpoint on the
queue, and there are more of them than the defaults name — text-to-video as well as image-to-video,
reference-driven variants, background removal, upscales. What the model accepts, what it returns,
what its ceilings are on duration and resolution, and what it costs are stated on its own page and
nowhere in this repository. Guessing those costs a generation you pay for and throw away, and it is
how a run ends up building a whole step it did not need.

**Captions need words with times on them, and where those come from depends on the generator.** Some
video models return synced speech in the clip; some return picture only. CHECK THE MODEL rather than
assuming either — its own endpoint documentation says which, and a clip already on disk answers it in
one `ffprobe`. If the clip carries speech, transcribe it like any other footage. If it does not, the
words come from somewhere else: generate the voice track and map its times through
`prep/whisper.ts <json> <media>`, or author the caption windows directly from the script. Only the
second case is worth warning the user about, and only once you have established it is the case.

**A TAKE'S OWN AUDIO MUST NOT OWN THE CUT.** Laying a generated take's dialogue down as the soundtrack
pins the picture to that take's timecode: every pause it contains is now in the film, and no shot can
be shortened, reordered or dropped without breaking sync. One run made that choice in a single line and
then could not cut — 21 of its 24 "shots" were contiguous slices of one take, and its pace came out a
third slower than the reference it was copying. If the cut matters, carry the speech separately: keep
the take for its picture, generate or re-voice the line, and let the edit be free of it. Measure what
you kept — speech seconds against running time — before deciding the pauses are the performance.

**AGREE THE SUBJECT BEFORE YOU PAY FOR IT.** The first generation is a charge, and everything after it
is built on whatever concept that charge embodied. When the ask leaves the subject open, say what you
intend to make in one line and let the user answer before the first call, not after seventeen. That is
ONE question about spend — not a loop. A run that asked seven times in half an hour was not being
careful; it was handing back the work. Write the best thing you can, say what it costs, and go.

**A SOUNDTRACK IS NOT A STATISTIC.** Measuring a reference tells you what it does, not what to make. A
run measured its reference honestly — a bed 19 dB under the speech, a riser before a cut and an impact
after it on 51 of 62 cuts — then generated ONE riser and ONE impact and fired the same two samples at
every cut, sixteen events out of two files. The statistic was reproduced exactly and the result was
unlistenable, because a sample the ear hears eight times in thirty seconds stops being an accent and
becomes a tic. The delivered film that did work went the other way: six music cues, each with its own
mood written for its own passage, and eleven distinct effects; the short piece before it carried four
events in thirty seconds from three samples. So: **a sample used more than twice is a defect**, an
effect on every cut is a defect, and every generated cue gets a prompt written for ITS moment rather
than one generic description reused. And listen to what came back before you build on it — no gate in
this repo has ears, which makes the audition yours and not optional.

**ONE SCRIPT, RESEARCHED, AND THE INTERRUPTIONS ARE NOT PRINTED.** When the ask needs words, go and
find out what is actually being argued about in that field right now — the repository tells you what
the product is, not what makes a subject live. A script written only from a README comes out
plausible and inert. Then commit to one and write it well; offering versions is not collaboration
here, it is asking the user to do the writing.

And mind the punctuation, because the script is display text: a run marked its interruptions with an
em dash, the dash went into the generation prompt and then into the caption, and the delivered film
reads `for a living—` on screen. Where a line breaks off, break it off — the cut and the next speaker
carry the interruption. Nothing that exists to instruct the reader of the script belongs in the words
the viewer sees.

**Every generated asset lands in the manifest with its provenance**
(`pipeline/providers/assets.ts`): what made it, from what prompt, derived from what, and what it cost.
Report the spend unprompted when the run delivers, with `spendLine` — it says plainly when a figure is
a lower bound and when the RESPONSE carried no price. That is a statement about the inference response
and about this client, which does not ask for a price; it is not a statement that the endpoint has no
published price. If the user wants a real figure, its pricing is on the model's page — go and read it
rather than telling them the number cannot be had.

### PREP — transcript, then frames + meta  · SCRIPT
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
**There is no default: picking for the user is the failure mode this question exists to prevent.**

Not choosing for them is not the same as having no opinion, and collapsing the two is its own defect.
**The order below is a statement about quality — VEED transcribes best, and it is first and named as
best for that reason.** Keep the order and the wording when you put the question, whichever way you put
it; two runs read the no-default rule as a ban on saying so, flattened the four into equals, and then
led with the free local one because free and local is what reads as sensible in the absence of a view.
Say which is best, then let them choose.

> Before I can add captions I need a transcript. Four ways to get one:
>
> 1. **VEED** — best quality. One-time browser sign-in. A free account covers about 10 minutes of
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

- **veed** → `node --import tsx veed/go.ts <video> [...]`, login flow below. When the browser opens, say
  exactly: "I've opened a VEED login tab in your browser — click Allow if it asks. I'll wait here;
  there's nothing to paste."
- **whisperx** → `node --import tsx prep/transcribe.ts <video> [...]` — the recorded tier applies; pass
  `--model medium|small.en` only to override it. If the binary is missing, ASK before installing: "WhisperX isn't installed. It's a local
  Python tool — the install pulls in PyTorch and the first run downloads a model, so expect a slow first
  pass and around 2 GB of disk. It goes in its own isolated environment, not your system Python and not
  this project, and `uv tool uninstall whisperx` removes it again. Install it now?" On yes run
  `bash pipeline/scripts/install-whisperx.sh` and stream its output.
- **custom** → the user's service is yours to drive: get a Whisper-family JSON out of it (their MCP,
  their CLI, their API — their credentials, never handled here), then
  `node --import tsx prep/whisper.ts <json> <video>` — one json per video, repeated in pairs for a
  batch. `prep/whisper.ts` IS the shipped mapper; what we ship no helper for is DRIVING the user's
  service, which is yours to do with their tool.

OFFERING THE ALTERNATIVE — once, and in these words, so the user hears the actual trade rather than a
second nag:

- VEED sign-in declined → "No problem, I'll leave VEED alone. I can run WhisperX locally instead: free,
  offline, nothing leaves your machine. It needs a one-off install that pulls in PyTorch, so the first
  pass is slow. Want that?"
- WhisperX install declined → "Then I'll skip the local route. VEED transcription needs a one-time
  browser sign-in and runs on your VEED account's limits. Shall I open that instead?"
- Both hosted routes declined → "Then I won't transcribe — every caption is built from a transcript and
  I won't invent one. Two routes are still open: point me at your own transcription service and I'll
  wire it up, or give me the caption copy and I'll place it by hand rather than synced to speech.
  Otherwise, say the word if you change your mind about VEED or WhisperX." Stop only if they decline
  those two as well.
- No audio track → "That clip has no audio track, so there's no speech to caption. I can still put text
  on it — titles, lower thirds, motion graphics — from copy you give me. Want that?" Transcription is
  the step with no subject here, not the run: with no transcript there is no recipe to route to, so
  author DESIGN + RENDER INLINE per `director-brief.md` exactly as the NO VIDEO case does, with the
  footage as the base layer and timings chosen by you rather than synced to speech. Only an ask for
  speech captions specifically has nothing left to do.

WHEN A RUN FAILS — classify it, because the right move differs and none of them is a silent retry:

- **Out of credits** (`veed/go.ts` says "out of transcription credits") → the account is the blocker, not
  the choice, so go back to the Q1 question with VEED still on the table: "VEED is out of transcription
  credits for this workspace — a free account covers about 10 minutes a month. You can add a plan at
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
`node --import tsx prep/prep.ts <video> [...]`
Auto-detects aspect from the source and writes, under `runs/<key>/`:
- `meta.json` — the single source of truth downstream: canvas `width/height/fps`, `durationSec`, and all paths
  (`videoPath`, `transcriptPath`, `wordTimingsPath`, `framesDir`). Canvas = the source's own dims
  (rotation-corrected) and fps, probed by prep; `aspect` = portrait (9:16) or landscape (16:9) label.
- `word-timings.json` — per beat: `cueDelayMs`/`cueDurMs` + every word's absolute-ms `delayMs`, synthesized
  from the VEED chunks' real per-word times (even split only if a transcript has none). The DESIGN + RENDER step pastes
  these VERBATIM — compiled recipes by construction, the inline creative passes per the director brief;
  timing is never re-derived.
- `frames/beat-N.png` — one clean still per beat at the chunk MID time, emitted at HALF canvas (×2 → canvas).

### ANALYSE — frames → analysis.json  · AGENT (vision) — OPT-IN

**A clip with no speech has no beats, and still has a composition.** `prep` samples one still per
transcript chunk, which is the right unit for a captioned run and no unit at all for a silent clip, a
card with no audio, or a piece of stock footage. Those runs get time-sampled stills instead:
`node --import tsx pipeline/scripts/scene-frames.ts <video.mp4> <runs/key/frames> [--count 8]`
It writes the stills plus `scene-plan.json` — canvas, fps, and for each sample its second and its frame
index — so facts are written against sample indices rather than against beats that do not exist. No
transcript is read on this path.

The analysis pass on this path is the SAME opt-in vision subagent described below, with two words
changed: it reads `scene-N.png` and keys its facts to the `i` of each sample in `scene-plan.json`,
where a captioned run reads `beat-N.png` and keys to beats. Everything else — nameless, background,
CANVAS px, writes `analysis.json`, the only agent that opens a frame — is identical. Sampling follows
the PICTURE stream, so a file whose audio outlasts its video still gets a still for every sample.

Without it, the composition ends up in the brief as prose — "her head sits roughly y430-900; the
ceiling band y0-420 is empty" — retyped per agent and per round, and checkable by nobody. That is how
52 briefs in one session carried the same three paragraphs.

### ANALYSE (captioned runs) — frames + transcript → analysis.json  · AGENT (vision) — OPT-IN, refine only
**SKIP this step by default.** Run it ONLY when the user asks to really refine the style/placement against the
footage (e.g. "refine the style", "tuck the captions into the negative space"). On such a request: run this
step, then re-run DESIGN + RENDER as the FROM-SCRATCH inline pass (variant B — compiled recipes are deterministic and
ignore `analysis.json`; the pass finds the file and composes from it), then MUX AUDIO. On a refine-only re-run (no
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

### SAMPLE ONE STYLE — deterministic, zero tokens  · SCRIPT
`node --import tsx pipeline/scripts/sample-style.ts --run runs/<key>`
Facet-scored seeded draw of ONE aspect-matched ref from `refs/tags.json` (v3: the RUNTIME INDEX —
recipes only; `fit` is the aspect SOT). Vibe comes from the transcript automatically (energy from word
rate/caps/exclamations — no LLM, no frames) and weights the draw; same run key → same ref. Writes
`runs/<key>/style.json` `{refId, refPath, facets, hasRecipe, seed, energy, coverage, alternates}`.
The script's `recipe=yes|no` OUTPUT is the routing decision for the DESIGN + RENDER step — never parse or hand-edit
`style.json` yourself (the index is fully compiled, so an implicit draw always prints `recipe=yes`).
The drawn ref id and everything in `style.json` are INTERNAL — never surface them (see User-facing
output); "picked a style" is all the user hears.
Overrides: `--seed N` (browse alternatives), `--style <id>` (the user asked for a look — must be an
index id; anything outside the index is not a runtime pick and the script rejects it), `--exclude <id>`
(repeatable).
**A SET MUST NOT LAND TWICE ON ONE STYLE.** When several pieces are being made together — variants,
languages, a campaign — pass every id already taken as `--exclude`. Say the taken ids once; never
reseed until a collision stops happening, and never carry the list in your head, where the next
compaction loses it.
- **THE INDEX IS THE RUNTIME UNIVERSE**: every entry ships a validated sheet (`refs/html/<id>/recipe.md`)
  + its compiled module (`recipe.ts`) — the script fail-louds on any entry missing either, or missing
  its prefab.
- **COVERAGE MODE** (`coverage.filtered:false` — possible only if curation ever shrinks an aspect below
  the threshold): STOP and tell the user honestly the aspect isn't covered by recipes; options are
  `--style` by their explicit pick, an authored-from-scratch run if they ask for one, or cancel. NEVER
  reach for the from-scratch pass SILENTLY — the ban is on substituting it without the user choosing it,
  not on the path existing.
- **RECIPES ARE THE PRODUCT**: the draw, `--style`, and `alternates` are all RECIPE-BACKED only —
  the runtime index contains nothing else.
- **CLASSIC POOL — explicit-simplicity route (intent, not vibe)**: `refs/html/classic/tags.json` holds a
  small set of plain caption presets (single font, simple or no word animation; every preset is dual-aspect).
  Route here ONLY when the user's INITIAL prompt itself asks for a simplified/standard look — "simple",
  "clean", "minimal", "just subtitles", "black bars behind the text", "highlight the spoken word", or
  similar prose (each entry lists its `cues`; match on meaning, not exact strings). On this route SKIP
  sample-style and pick in TWO stages: (1) the ask's cues NARROW the pool — often barely ("simple" alone
  eliminates nothing; a concrete ask like "black bars" narrows hard); (2) the CONTENT decides among what
  remains, the same signal the seeded draw scores from the transcript — word rate, caps, exclamations,
  overall tone: calm/measured speech → the soft picks (`energy: calm|clean`), fast punchy
  delivery → the highlight picks (`energy: punchy`); busy footage favors a `bg` (bars/plate)
  for legibility. DEFAULT TO MOTION: prefer a word-by-word preset (`motion` != none — float-in, colour
  flash, per-word fade) even for calm content; pick a static preset (`motion: none`) only when the user
  says no animation ("static", "no motion", "nothing moving") or their concrete ask lands on one
  ("black bars" → the bars preset is static, and the concrete ask wins). Preset ids are ARBITRARY
  LABELS, never selectors — "give me a simple style" does NOT mean the preset named `simple`; a
  hype-paced clip answering that ask is better served by `rizz` or `mint` than by a static preset. Then run DESIGN + RENDER variant A with
  `--module refs/html/classic/<id>/recipe.ts` appended (same command, same gates; no `style.json`
  exists and none is needed). The pick is INTERNAL like any other (User-facing output): never surface
  "classic", "preset", preset ids, or the pool's existence — the user hears at most "going with a clean
  look for this clip". No simplicity hint → never classic; the seeded draw stays the
  default. Classic presets are END styles on the bank side: never donors or craft substrate for any
  OTHER run's remix/face-1, and never in the seeded draw. Iteration on a delivered classic run routes
  three ways:
  **PARAMETER AMENDS stay classic** — "make the text blue", "add an outline", "bigger", "move it up",
  "highlight in green", "all caps": anything expressible as a field of the classic spec (color, outline,
  shadow, size/position fractions, casing, highlight colour, font weight). COPY the preset's `recipe.ts`
  to the scratchpad, fix its relative `classic-lib.ts` import to the absolute path, edit ONLY the spec
  fields in the copy, rerun with `--module <copy>` (same gates; the library recipe is never edited).
  **"Another simple one / different simple style"** re-picks a different classic preset through this
  same route. **A new creative DIRECTION** (a mood, a reference, new layout/motion language, "make it
  more interesting") GRADUATES to REMIX — but the user is iterating on THEIR current look, so the
  delivered classic design is the CONTINUITY SKELETON (donor A): translate its spec (font, casing,
  palette, placement, bars/plate, motion) into the skeleton role and keep whatever the ask doesn't
  touch; runtime-index donors supply only the divergence (B by `type`, optional C by `device`) per
  REMIX MODE. The never-a-donor bar is about the BANK: classic refs never serve as donors or craft
  substrate for any OTHER run and never enter the seeded draw — a classic run's own iteration keeping
  its own skeleton is not a violation.
- **CREATIVE PASS, two faces**: the user does NOT know recipes exist and never needs to — route on the
  SHAPE of the ask, never on whether they said "mix".
  **face-1** — the prompt ARRIVES WITH the user's OWN reference/brand/concept (an image, a brand kit, a
  described idea): skip the draw-and-ship — run the from-scratch INLINE pass (DESIGN + RENDER variant B). The USER'S
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
    probe → mux (commands in DESIGN + RENDER). Never a raw prefab, never an id outside the index.
  - **RE-ROLL only when the user asks for VARIANTS, not for creative input**: "show me more options",
    "another style", "make 5 different versions" (that's N draws — run them as N `--seed`s through
    DESIGN + RENDER variant A, parallel when N>1). Re-roll serves the user who never had an idea in the first place;
    the moment the ask carries ANY creative direction it is a REMIX, never a re-roll.
  - Defect repairs (typo, overlap, out-of-sync word) are neither — fix at the source, then re-run the
    gates. Creative-run output (face-1/REMIX — agent-authored) → patch the run's template directly.
    Recipe-run output → NEVER hand-edit the generated .wv document (generate-recipe.ts owns it): a text/timing
    defect = fix transcript/word-timings and re-run the script; placement-vs-footage = the refine path
    (ANALYSE); a deliberate one-run tweak = the CUSTOMISING `--module` copy (DESIGN + RENDER variant A).
  - **A BRAND OR A SET GETS A FILE, NOT A PARAGRAPH.** When the user supplies a brand, or several
    pieces are being made together, write `brand.json` beside the run (palette BY ROLE, colour law,
    type pair, the mark's file path and placement, and for a set the bone every piece keeps). Validate
    it with `node --import tsx pipeline/scripts/brand.ts --file <brand.json> --check` — it fails when a
    named mark is not on disk, which is what makes a design pass draw its own — and paste
    `--brief` into the design pass. Retyping the law per piece is how four cards drifted apart.
  - **RECORD WHAT WAS REJECTED, AND WHY.** Before starting another round on the same footage:
    `node --import tsx pipeline/scripts/creative-log.ts --for <video> --reject "<what it was>" --why "<their reason>"`
    and when something lands, `--accept "<the aesthetic>" --why "<why it landed>"`. Then start the next
    round by reading it back with `--brief` and putting that text in the design pass. It is keyed by
    the FOOTAGE, so rounds two, three and four inherit it, and it survives a compaction — which the
    same list carried in your head does not. Parallel attempts that converge on one idea are the
    complaint this exists to prevent.
  - **A SCOPED EDIT MUST PROVE ITS SCOPE.** When the user asks for one thing and says to leave the rest
    alone, copy the accepted document first, then check the result against it:
    `node --import tsx pipeline/scripts/scoped-edit.ts <accepted.wv> <new.wv> --allow <selector-or-id>…`
    It names every difference outside what you were allowed to touch, with both values. Run it before
    you say the change is done — "you moved something I told you not to move" is the correction this
    pipeline earns most often, and neither `--verify` nor probe-qa can see it: both documents render
    perfectly, one of them is just not what was asked for.

Then, for FACE-1 runs only, set:
- **ENGAGEMENT mode** — pass the seed copy VERBATIM to DESIGN + RENDER (see below; wording changes output).
- **ANIMATION LEVEL** — `word` (default; almost always) / `cue` line (titles, or plain/corporate) / `none`
  (minimal/corporate). Respect any stated user preference; ask if genuinely unsure.
(Recipe runs need NONE of these — the compiled recipe fixes engagement, animation, and design. A REMIX
needs neither: its look comes from the donor sheets per the brief's REMIX MODE.)

### DESIGN + RENDER — SCRIPT (recipe) / INLINE (creative face-1 · remix)

**ON THE AUTHORED VARIANTS BELOW (B · REMIX · NO VIDEO), RELOAD THIS SKILL BEFORE YOU AUTHOR ANYTHING,
AND AGAIN BEFORE EVERY AUTHORING TOUCH AFTER IT.** Invoke `open-edit` again — the whole skill, not a
section of it — and read the design rules fresh. It binds by what you are DOING, not by which variant
you routed to: a compiled recipe run that reaches CUSTOMISING or a classic PARAMETER AMEND is
hand-editing design values, and that is an authoring touch like any other. Only a recipe run that
touches nothing reloads nothing.

Authoring is the LAST thing that happens, and it has to be: nothing about it can be decided before the
material exists, because where the subject sits, what the frame leaves empty and how bright it is are
all facts about footage that does not exist until the end. So it is always the work with the most
behind it and the least attention left, and a rule read an hour ago is a rule competing with several
hundred tool results. Reloading puts it back on top at the moment it binds. It costs tokens and buys
the only thing on screen the viewer actually looks at.

**Reloading is not permission to redesign.** The system is committed ONCE and is not re-litigated; what
reloads is the contract you author WITHIN. A later touch places, sizes and times things the system
already decided — it does not reopen the aesthetic. **A mechanical fix to the element a gate flagged
is not an authoring touch**: step the rung down, close the window, and move on without reloading
anything. What makes a touch an authoring touch is that YOU chose to change how something reads.

This is not a suggestion to re-read if you feel unsure. Reload at each of these, every time:

- before writing `design/system.json`;
- before authoring any `.wv` document, and before each chapter of a longer piece;
- before adding or RESTYLING any caption, graphic, plate, chart, mark, title, end card or motion — a
  touch on one of those is an authoring touch however small it looks.

**A reload replays no step this run has already finished.** Reading the flow again is not doing it
again: a recorded transcription provider is used and nothing is asked, the style draw is deterministic
on the run key, preflight is idempotent, and — the one that would cost money — **if `runs/<key>` already
holds the footage, the FOOTAGE step is done and none of its gates are re-entered.**

Route by the SHAPE of the run (the SAMPLE ONE STYLE script's output + the creative-pass routing own this decision):
- variant A (`recipe=yes` — every default run): **SCRIPT — no agent, no model, zero tokens.** The recipe
  is compiled code. (Rerun the SAMPLE ONE STYLE script if you no longer have its output — same run key → same result.)
  The classic route (SAMPLE ONE STYLE's CLASSIC POOL) is this same variant with
  `--module refs/html/classic/<id>/recipe.ts` appended.
- variant B (creative face-1; also refine re-runs after ANALYSE): INLINE — you execute the from-scratch
  contract (B below) YOURSELF, no subagent. A default run can NEVER route here: the runtime index is
  recipes-only, so an implicit draw always has a recipe.
- REMIX (face-2 creative iteration): INLINE — you author the donor blend yourself per
  `director-brief.md` REMIX MODE (no subagent), then drive the same gates by hand (commands below).
- NO VIDEO (see INPUTS): INLINE — neither PREP nor SAMPLE ONE STYLE ran, so there is no recipe to route to and nothing
  to route on. Write `runs/<key>/design/system.json` first (this path authors from scratch, so it needs
  a system as much as face-1 — `groundedIn` names whatever the run's own facts are: the brief, a script,
  a shot list), author per `director-brief.md` with the canvas and duration from the ask, then run
  `bash pipeline/scripts/gates.sh runs/<key> --no-probe --no-mux` — no source footage to diff frames
  against, and no source track to restore. If the run HAS a built soundtrack, pass
  `--audio runs/<key>/audio/mix.m4a` instead of `--no-mux`. A footage-free run is as supported as any
  other; what it lacks is a source file to derive from, not a path through this step. Place pictures
  with `<img src="asset.png">` — a file BESIDE the document renders, `object-fit` included (probe:
  img-file-src). A `data:` URI does NOT (probe: img-data-uri-blank), so write the bytes to the run and
  reference them by name rather than inlining them.

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
**0** → MUX AUDIO · **1** = a gate failed — report the failure honestly in plain terms (raw FAIL lines only
on request); on a probe FAIL offer a
`--seed`/`--style` re-run; never redesign or hand-edit the .wv document · **3** = the sampled ref has no compiled
recipe (stale `style.json`; rerun SAMPLE ONE STYLE).

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
uncured references. (Refine re-runs after ANALYSE use this same variant — see ANALYSE for how to fill the
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
TASK: WRITE THE SYSTEM DOWN FIRST, then author against it.
  node --import tsx {repo}/pipeline/scripts/design-gate.ts {repo}/runs/{key}
  fails until {repo}/runs/{key}/design/system.json exists and every document obeys it. Author that file
  before any .wv: 2-3 Google @import fonts, a type LADDER (each rung a role + size + its own optical
  tracking — `opticalTracking(px)` in {repo}/pipeline/recipes/type.ts gives the measured curve), a named
  palette, spacing, NAMED easings and durations, the reveal unit, the devices in play, and `donors` =
  the recipe ids you took mechanics from (they are checked against the runtime index). `groundedIn` must
  name the run's own content files, and the gate refuses a system whose files do not exist — a design
  authored before the content is a design authored from nothing, which is exactly how a delivered film
  ended up with 23 font sizes and one easing curve used 934 times.
LEARN THE REPERTOIRE BEFORE YOU DESIGN ANYTHING. Open two or three ref folders under {repo}/refs/html/
  — the sheet AND the document beside it — and read what the engine is SHOWN doing: how a word is set
  at a different size from the words around it (a beat is a column of separate text blocks, not one
  styled line), how an underline is drawn, what arrows, brackets, corner marks, rules and badges look
  like when they are made well, which faces are already proven to render. Write down what you found and
  what you intend to use. This is a bank of what is POSSIBLE, not a template: look at how something is
  done, then do it better for the piece in hand. An agent that skips this designs from its own defaults,
  and its own defaults are a centred line of one size — which is the single most common reason a
  delivered piece reads as machine-made.
COMPOSE, don't type: {repo}/pipeline/recipes/devices.ts (dividers, ground shadow and the rest of the
  delivered vocabulary — a rule is a hairline + shadow + stub that DRAWS, never a lone grey line),
  {repo}/pipeline/design/captions.ts (per-word reveal off the real timings, travelling cursor, lines as
  blocks), {repo}/pipeline/recipes/geometry.ts (arcs, lattices, springs, clip polygons),
  {repo}/pipeline/recipes/type.ts (the ladder and the tracking curve).
  Contrast over footage comes from the two-layer ground shadow, NOT a scrim box.
PLACEMENT IS A DECISION, MADE PER BEAT AND WRITTEN DOWN. For every beat say where the block sits, WHY
  there — what is behind it, which way the subject faces, where the frame is empty — and what changed
  since the last one. A block that holds one position for a whole piece is the defect, not the default:
  two delivered runs shipped it, one with 217 cues in one box and one with six of eight cues on the
  same left edge, and in both the author's own reference notes said the block moves every beat.
  Emphasis is carried by the WORD that takes the beat, not by a phrase set in bolder type.
  With footage, the system's `placement.measuredIn` must name a file holding one entry per cue,
  measured off this run's own picture — the gate refuses the system otherwise, because grounding in
  the transcript and the cue times is grounding in the WORDS, and a run that did exactly that put six
  of eight blocks on one edge while believing it had measured everything.
NOT ACROSS THE FACE. Type passing BEHIND a person is the technique; type across their eyes is a
  mistake no amount of measurement excuses. One run scored its own coverage at 0.65 and 0.71, reasoned
  that nothing fit behind the speaker, and put the block in front — over his face in the opening shot
  and over his eyes in the last. When the clean ground runs out the answer is a smaller rung, a
  re-broken line, a different anchor or a later window, never the face. Read the face box off the
  subject's own silhouette (the head is the top of its bounding box) and keep it clear.
GRAPHICS GO WHERE THE CONTENT ASKS FOR THEM — not everywhere, and never as decoration. A number
  spoken in the script is the clearest invitation there is: a figure that arrives as type alone spends
  a beat saying what a count, a bar, a scale or a comparison would land. So is anything the speech
  describes that a picture states faster than a sentence. Whether to reach for them at all is settled
  by the material: if the reference carries graphics between the talking, that is both the permission
  and the measure of how much; if the user's ask implies them, the same. Where neither does, don't.
A DEVICE THAT APPEARS TWICE NEEDS A LOGIC. One run put two chapter marks in a thirty-second piece,
  both in its second half and none in its first. Each was fine alone; together they read as an
  accident, because nothing said when the thing appears. Either it follows a rule the piece keeps —
  every subject turn, every figure, every change of speaker — or it does not appear at all. And a
  device that recurs varies: same logic, different corner, different scale, so the second one is a
  system rather than a repeat.
LINES ARE SEPARATE BLOCKS, SO GIVE THEM DIFFERENT EDGES. A three-line beat whose lines all start at
  the same x is a paragraph, not a composition — one run printed `safeX` as the left edge of eight
  blocks in a row. The lines are already separate elements, which is what makes an indent, a hang or a
  step free; use it, and let the size change inside the block so one word carries the beat.
Hold the system across all beats; vary scale/composition per beat; escalate hook → close. Author ONE
{repo}/runs/{key}/final/template.wv (z0 base video FIRST; EVERY text layer position:absolute + explicit
z-index>=1 + a UNIQUE `id` e.g. id="cap3" — see the opacity trap; the id makes --verify name the element in
its failure lines; each caption visible only in its cue window) +
{repo}/runs/{key}/final/manifest.json {"render":{"width":W,"height":H,"fps":FPS,"duration":durationSec}}.
RENDER + VERIFY (OUTSIDE any sandbox — needs the window-server; binary = {repo}/.veed-engine/veed-engine-cli, NOT on PATH):
  DESIGN GATE (mechanical, no engine): node --import tsx {repo}/pipeline/scripts/design-gate.ts {repo}/runs/{key}
     — reads every .wv in the run back against design/system.json: a font, size, tracking, colour or
     easing the system does not declare is an error, as is a donor id that is not a real ref. Exit 1 →
     fix the document, or amend the system deliberately. Run it FIRST: every finding is a string in a
     file, and learning it after a record costs minutes of encode to discover what a regex knew instantly.
  LINT (mechanical, no engine): node --import tsx {repo}/pipeline/scripts/lint-template.ts {repo}/runs/{key}/final/template.wv
     — engine-limit anti-patterns (animated blur, the stacking trap, missing cue ids, per-corner radius).
     Exit 1 → fix the flagged rule, re-lint before verifying.
  VERIFY (analytic, fast, no video, reads manifest render block):
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
  EXPECT WINDOWS (optional) — word-reveal TIMING: to assert a caption is shown/hidden in a time window, add a "verify" block to
     manifest.json alongside "render": {"verify":{"expect":[{"element":"cap3","visible":true,"from":2.1,"to":3.4}]}}.
     --verify then FAILs[expect-visible]/[expect-hidden] if a word isn't on-screen when it should be. Use when a
     beat's reveal timing is subtle; ids only (a word with no id can't be targeted).
  WCAG PASS (DEFAULT on creative runs; level AA) — after --verify is clean, before recording. It
     DETECTS and REPORTS; it NEVER silently changes colours — the human chooses.
       node --import tsx {repo}/pipeline/scripts/wcag-pass.ts --run {repo}/runs/{key}
     It samples the REAL rendered background behind every caption, checks WCAG AA contrast, writes
     final/contrast-statistics.json (the policy-free statistics the verdicts and the recommendation
     studio are computed from), and STOPS. It prints `status: pass|attention` plus EXHAUSTIVE `review:`
     disposition lines (will fix / no colour satisfies / halo recommended / indeterminate — report these
     honestly). Exit 1 = tooling missing or crashed (fix the environment; see config.ts WCAG_* vars) —
     not a design failure.
     - `status: pass` → all caption text clears AA. Note it and move on.
     - `status: attention` → some caption text has low contrast. Tell the user in PLAIN PRODUCT TERMS:
       how many of how many text elements fail, and the worst offenders (from the `review:` lines). Then
       ASK which of these to do — do NOT pick for them, do NOT silently apply:
         (a) OPEN THE RECOMMENDATION STUDIO — curated, clickable colour/design options to choose from. It
             is served by the preview server (the PREVIEW step) at the /wcag/ route — if that server is
             running, open `http://127.0.0.1:<port>/wcag/` for the user (the port from the `preview:`
             line); only if no preview server is up, generate the static page instead:
               node --import tsx {repo}/pipeline/scripts/wcag/recommend.ts --run {repo}/runs/{key}
             (writes runs/{key}/final/wcag-recommendations.html — open that file).
             When the user CLICKS a choice, the studio writes runs/{key}/final/wcag-choice.json
             ({"schema":1,"chosen":[{level,group,kind:"colour"|"shadow"|"outline"|"background",hex,backingHex?,selector?}]}).
             READ that file to tell the user what they picked, then run the apply step (b) — a clicked
             choice always takes effect (wcag-pass sees the file and drives the applier with it).
             CHAT IS AN EQUAL PATH: if the user says what they want in words ("apply the AA corpus colour",
             "add a shadow halo behind the caption" → kind:"shadow"), WRITE the same wcag-choice.json shape
             yourself, then apply.
         (b) APPLY — promoted only on MEASURED improvement:
               node --import tsx {repo}/pipeline/scripts/wcag-pass.ts --run {repo}/runs/{key} --apply
             With a runs/{key}/final/wcag-choice.json present, --apply drives the applier from that explicit
             choice (colour / shadow / outline / background backing) and ALWAYS runs it; with NO choice file it falls
             back to the automatic hue-preserving colour set (value/saturation shift only, design identity
             kept), applied only where a colours-only fix is applicable. FINAL IS FINAL — no sibling dirs,
             no video artifacts; on promotion the remediated template becomes runs/{key}/final/template.wv
             and the file artifacts land inside final/: template.draft.wv (pre-remediation original),
             template.draft.wcag-remediated.wv (the remediation output), template.final.wv (clone of
             the shipping template on promotion), wcag-remediation.css (per-rule evidence),
             wcag-remediation-plan.json, contrast-statistics{,.remediated}.json. After promoting it re-runs
             --verify on final/ itself, and prints `status: pass|remediated|not-improved|residual` + the
             same EXHAUSTIVE `review:` lines.
         (c) LEAVE AS-IS — record the original unchanged.
  RECORD the deliverable — ONLY after --verify is clean, always FROM runs/{key}/final (whatever the
     user chose in the WCAG PASS already lives in final/template.wv — the untouched original, or an
     --apply promotion). --verify and --record are mutually exclusive, so this is a
     SECOND invocation:
       {repo}/.veed-engine/veed-engine-cli {repo}/runs/{key}/final --progress-output --record {repo}/runs/{key}/final/out.silent.mp4
     --progress-output prints `progress: N/M frames (X%)` lines during the record; recording is long-running —
     watch these to confirm it's alive, but don't narrate them to the user.
  Change NOTHING else — no aesthetic/colour/font/device/animation/timing edits. Author correctly up front (recipe +
  limits in the brief) so --verify passes first try; it is a safety net, not a design loop. (probe-qa — the
  mechanical frame QA — comes right AFTER the record step; it is not part of the verify loop.)
OUTPUT: {repo}/runs/{key}/final/{template.wv, manifest.json, out.silent.mp4}.
THEN (same turn, no pause): note the locked system so you can describe the delivered look in plain
terms (aesthetic, fonts, palette, device — not gate status), note the wcag status (pass / attention with
what the user chose — recommendation studio, --apply's remediated palette shift, or leave-as-is), and
continue straight to probe-qa + mux.
```

After recording: run the last gate —
`node --import tsx pipeline/scripts/probe-qa.ts runs/<key>` (mechanical frame QA: per-beat mid + tail
probes vs the source — caption present, WCAG-ish contrast). FAIL → do NOT redesign and do NOT
auto-re-render: report honestly in plain terms and pick the fix WITH the user. Warns → proceed to mux;
surface one only if it's likely visible in the deliverable.

**REMIX EXECUTION (face-2, inline — no subagent).** Set up a fresh run dir `runs/<key>-remix`: copy
`meta.json`, `transcript.json`, `word-timings.json` from `runs/<key>` (same footage, same timings; update
the `key` field inside `meta.json` to `<key>-remix` so downstream paths stay coherent). Pick donors per
SAMPLE ONE STYLE (A = current pick's sheet as skeleton, same aspect; B = different `type` facet; optional C =
different `device` facet — B and C may be off-aspect, geometry re-derived at this canvas; sheets at
`refs/html/<id>/recipe.md`; donors come from the RUNTIME INDEX only — classic-pool refs are never
donors and ship no sheet), author
write `runs/<key>-remix/design/system.json` FIRST (a remix authors a document from scratch, so it needs
its own system exactly as face-1 does — copy the original's and change what the brief asks to change,
naming the donors in `donors`), then author
`runs/<key>-remix/final/{template.wv, manifest.json}` per `director-brief.md` REMIX MODE, then run the
whole chain with one command (OUTSIDE any sandbox — verify and record need the window-server):
  `bash pipeline/scripts/gates.sh runs/<key>-remix`
It runs design → lint → `--verify` → WCAG → `--record` → probe-qa → mux, stops at the first failure and names
the gate. A `--verify` failure: fix ONLY the flagged element and re-run, at most twice, then stop and
report honestly. A probe-qa failure: report it in plain terms and pick the fix WITH the user — never
redesign. The deliverable lands next to the original, and the user compares.
The WCAG AA pass runs INSIDE that chain, before the record — do not run it again afterwards. It DETECTS
and REPORTS only; the chain does not pause and does not apply anything. On `status: attention` the
route is exactly the main flow's WCAG PASS, and a remix gets the whole of it: tell the user in plain
product terms how many text elements fail and the worst offenders, then ASK — the recommendation studio
(the preview server's `/wcag/` route, or `wcag/recommend.ts` when no server is up), a choice written to
`final/wcag-choice.json` either by a click or by you from what they said in words, `wcag-pass.ts --apply`
to act on it, or leave it as-is. Never pick for them. After an apply, re-run the chain so the record is
made from the promoted template.

### MUX AUDIO — restore the soundtrack  · SCRIPT
the engine renders video only. When the run's audio IS the source clip's, `bash pipeline/scripts/mux-audio.sh runs/<key>` muxes it onto
`final/out.silent.mp4` → **`runs/<key>/final/out.mp4`** (the deliverable). `-map 1:a:0?` tolerates a source with
no audio track, and the deliverable takes the PICTURE's length, so a built mix shorter than the render cannot truncate it. Deliver `out.mp4` to the user — this is the FIRST
moment the run is presented as done (never announce the silent render or muxing separately).
When the audio is BUILT rather than restored — narration, music, effects, anything with more than one
piece — write `runs/<key>/audio/mix.json`, build the track, and mux THAT:
```json
{ "durationSec": 726.8, "tracks": [
  { "path": "assets/vo-01.mp3",  "atSec": 0,    "role": "voice" },
  { "path": "assets/music-1.mp3","atSec": 12.4, "gainDb": -14, "fadeOutSec": 3, "role": "music", "duck": true },
  { "path": "assets/sfx-3.mp3",  "atSec": 88.2, "gainDb": -6,  "role": "sfx" } ] }
```
```
node --import tsx pipeline/scripts/mix-audio.ts runs/<key>          # → runs/<key>/audio/mix.m4a
bash pipeline/scripts/mux-audio.sh runs/<key> --audio runs/<key>/audio/mix.m4a
```
`durationSec` is required and is the FILM's length — anything past it is trimmed, so one long cue
cannot lengthen the deliverable. A bed marked `duck` is opened by the voice itself rather than by a
gain you guessed at; a fade-out is measured from the end of the film, because a cue's own length is not
in the spec. `--print-graph` shows the filtergraph without running ffmpeg.
With NO source video there is no soundtrack to restore and no source for the script to read: copy
`final/out.silent.mp4` to `final/out.mp4` and deliver that, so the deliverable path is the same for
every run. A silent deliverable is a complete one here, not a failed mux.

### PREVIEW — open the localhost preview  · SCRIPT (parallel, non-blocking, runs alongside the rest)
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
- veed-engine-cli is checked by PREFLIGHT — keep it current via `bash pipeline/scripts/install-veed-engine.sh`; macOS-arm64 binary. Older builds lose features (e.g. pre-0.3 = no shadows = major degrade).
- Sandbox: PREP (veed/go.ts) needs network egress to `*.veed.io` — a sandboxed
  `fetch failed` there means the sandbox blocked the call; re-run it outside the sandbox. The DESIGN + RENDER step's
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
- Word timing is NEVER invented — DESIGN + RENDER pastes `word-timings.json` delays verbatim (compiled recipes do
  this by construction).
- The preview server (PREVIEW) is loopback-only and additive — if its default port 8978 is busy (an
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
