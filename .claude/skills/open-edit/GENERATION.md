# open-edit: footage generation (the FOOTAGE step)

Read this whole file when the user brought no video. Every path returns to PREP in `SKILL.md`.

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
browser flow yourself per the PREP step's LOGIN block (the user never runs a command or pastes a token).
Skipped when a token is already stored; one login covers generation and transcription for about a month.

Draft the script yourself from their prompt and show it for edit. Generation is **two commands, and the
script is typed only in the first one.**

**WHOSE credits.** Generation spends the AI Playground credits of ONE
workspace. With exactly one on the account there is nothing to decide, so it is used and NAMED with what it
holds; with several and no prior answer the CLI stops and asks, and never picks. Run the confirm
command with no workspace flag first:
`npx @veedstudio/openedit-cli generate --script "<the script>" --key <key>`
With no workspace chosen it stops having spent nothing (exit 1) and lists every workspace with its name and
credit balance. Put that choice to the user in plain terms (names and balances, not ids), then re-run naming
the one they picked: that re-run is the CONFIRM pass below. The choice is remembered at
`veed/.veed-workspace.json`, but a remembered choice is never a settled one: a spend pass whose
workspace was only remembered REFUSES until the command names it again. Put the remembered workspace and its
balance to the user, get a yes, and carry `--workspace <id>` on the spend command; the same flag switches it.

**WHAT IT COSTS.** Generating draws AI Playground credits TWICE: the speech is synthesized first, then
handed to **Fabric One Lipsync** (`veed/fabric-one-lipsync`), and both debits land on the same credit
allowance.
- **Fabric One Lipsync** — ~4 credits per SECOND of finished video, measured.
- **Speech synthesis** — 2 credits per minute of generated audio, rounded up to the whole minute, so any
  read up to a minute costs 2.

The quoted figure is the SUM of both. Script length is the lever, but read length depends on the voice
(measured voices run about 11 to 18 characters a second, so a 900-character script is roughly 200 to 320
credits). The tool quotes at the rate measured for that voice and quotes a range for an unmeasured one:
repeat the range, never flatten it to its low end or anchor the user on a small number. Too expensive:
redraft a shorter script or take another answer to the footage question, never a different workspace. The
figure is our estimate; VEED quotes no per-job price.

**THE PRESENTER CAN BE THEIRS.** The 24 presets are a menu, not the boundary. `--image <url|path>` uses the
user's own still instead (a URL is fetched by VEED, a local file uploaded from here); use it whenever they
brought a face, logo, character sheet or frame they like. A user image has no default voice, so `--voice`
is required with `--image`.

**A SET of images is ONE approval.** Several stills is one video of several shots: one question, not N.
Write a shots file, `[{ id, script, image | character, voice }, …]`, and confirm the set at once:
`npx @veedstudio/openedit-cli generate-set --shots shots.json --key <key> --workspace <id>`
It prints each shot's cost and one total, then spends the lot on a single `--yes`. The approval is hashed
over the whole set; any edit, reorder or swap makes it refuse. Each shot runs under its own key, so a
failure halfway leaves the paid shots alone and `--resume` collects them. Then join:
`npx @veedstudio/openedit-cli concat-videos <out.mp4> <clip1.mp4> <clip2.mp4> [...]`
It pads each clip into one canvas rather than cropping. The result is ordinary source footage: transcribe,
caption and render it like any other.

**That joiner is for source clips that disagree, and only those.** It re-encodes and normalises frame rate,
right for generated clips of different shapes and wrong for anything else. The finished chapters of a long
piece use `npx @veedstudio/openedit-cli concat-chapters`, which stream-copies and refuses parts whose format
differs (see the DESIGN + RENDER step). The wrong joiner re-encodes and silently resamples a 24 or 25 fps
film to 30.

**WHO presents it.** If the user has no opinion about the presenter, do not paste 24 thumbnails at them:
`npx @veedstudio/openedit-cli sample-presenter --key <key> [--gender male|female] [--locale <locale>] [--portrait|--landscape]`
It proposes one character + voice, prints two or three alternate presenters (each a face with a suited
voice, swappable as a row) plus more voices for the chosen face, with thumbnail and audio-preview links,
and ends with the ready-to-run confirm command for that pair. `--gender` narrows the face and the voice
follows it (never a mismatched pair; gender-neutral voices suit either). `--portrait`/`--landscape` chooses
the framing (the character is the framing; there is no aspect parameter), so pass the one the user's
format needs.
It proposes, it never decides — it costs 0 credits, writes nothing, and the user overrules it with `--seed N`
or by editing the two ids. Show them the pick and the alternates and get a yes before the confirm command.

1. CONFIRM (spends nothing):
   `npx @veedstudio/openedit-cli generate --script "<the script>" --key <key> --workspace <id>`
   It prints the script, the character, voice, framing ("portrait 9:16"), the workspace being billed with its
   balance, and the exact credit cost, records that approval at `runs/<key>/.fabric-pending.json`, and prints
   the exact next command. Show the user the cost in plain terms and get an explicit yes.
   NOT ENOUGH CREDITS is checked here too, before anything is written: a balance below the quote refuses,
   names both figures and records no approval, so it never hands you a SPEND command that is guaranteed to fail.
2. SPEND (only after that yes): copy the command it printed, **with no `--script`**:
   `npx @veedstudio/openedit-cli generate --key <key> --yes`
   It re-confirms against the server and refuses to spend if the fresh quote is above the approved cost, the
   recorded script no longer matches its hash, the approval is over an hour old, or a `--workspace` here
   disagrees with the approved one. Nothing is charged in those cases: re-run CONFIRM for a fresh yes.
   That yes binds the SCRIPT, the FIGURE (character, voice, framing, quoted cost) and the WORKSPACE together
   for one hour; if any of the three drifts the run refuses rather than charging something the user never saw.
   A quote that came in LOWER proceeds; only a rise refuses.
   NOT ENOUGH CREDITS is checked again here against the current balance (it can have moved since CONFIRM):
   it refuses, names both figures and charges nothing. That reopens the workspace question: top the
   workspace up, shorten the script, or re-confirm against a workspace the user explicitly names. Never move
   the run to a richer workspace yourself; a balance that cannot be read is not a refusal and proceeds, on
   either pass.

Passing `--script` together with `--yes` is an error; SPEND reads the script off disk so the billed words
cannot drift from the priced ones. A spent approval is deleted: one yes buys one video.

**Say what it cost, and how much to trust the figure.** The number the run stands behind is OUR ESTIMATE
from the script's length — VEED quotes no per-job price and reports no per-job charge, so there is nothing
to confirm it against. That figure, and which workspace it came out of, go to the user in plain terms once
the video lands ("about 380 credits from <workspace>"), and never as a figure VEED confirmed. The run also
reads the workspace balance either side of the create call and offers the movement as corroboration; the
balance is workspace-wide, so it can never be stated as "this run cost N". Pass it on as the run prints it:
- Movement agrees with the quote: give both, the quote as the figure and the movement as the check.
- Movement is bigger than the quote: say so and give the observed number (a concurrent run on that
  workspace, or our estimate running low); tell the user to check that workspace.
- Balance could not be read: the run prints the estimate and labels it one; pass it on as an estimate.
A `--resume` reports on the same terms and never re-decides a figure the spend pass measured. Every attempt
leaves its own audit trail at `runs/<key>/.fabric-spend-<sessionId>.json`. Never let a run that spent
credits end silently about cost.

→ `runs/<key>/<key>.mp4`. Feed it into the PREP step like user-supplied footage. `<key>` names a directory
under `runs/`: letters, digits, `.`, `-`, `_` only; not `.` or `..`; no leading `-` (`assertSafeKey` in the
`@veedstudio/openedit-cli` generate command).

**AFTER THE MONEY IS GONE.** A charge lands when a job is created; a charged job is never re-charged
automatically. A generation VEED refuses is not billed for its generation half, so `generate.ts` re-submits
a few times with backoff; never re-submit by hand. Speech synthesis is billed on every attempt, so a failed
run still cost something: report the figures the run prints, never call it free. Server time-outs and credit
refusals are not re-submitted. Each attempt is recorded at `runs/<key>/.fabric-charge-<sessionId>.json`
before the VEED call. Three distinct outcomes:
- **Generation failed** (VEED refused; re-submits exhausted or unable to clear the cause): report what VEED
  said, the reason it prints, and each attempt's recorded spend. Do not re-run `--yes` to retry; a further
  attempt needs a fresh confirm pass and a fresh explicit yes. The dead job blocks nothing.
- **The run was interrupted** (transport, polling, download, closed laptop): the video is paid for and
  nothing needs approving. Collect it with `npx @veedstudio/openedit-cli generate --key <key> --resume`,
  which polls, downloads and spends nothing. Polling gives up after 15 minutes or a run of consecutive
  status-check failures; the job may still be finishing server-side, so always `--resume` before paying
  again.
- **The attempt vanished mid-charge** (`--yes` refuses saying a charge may have landed): no job id was
  recorded, so nothing can collect it. Tell the user VEED may have charged; have them check that workspace's
  balance and videos around the time the refusal named. Free the key with
  `npx @veedstudio/openedit-cli generate --key <key> --abandon <sessionId>` (id from the refusal); it clears
  that one record only, and credits that attempt spent are gone.
`--yes` refuses while the same key is charging, while a paid job is uncollected (it points at `--resume`),
and while an abandoned attempt is unresolved. Different keys never block each other; running them at the
same time is fine.

Defaults produce a 9:16 talking head. `--character` picks the presenter and with it the framing; `--voice`
picks the accent and, left off, follows the character. Browse with the Fabric tools only if the user asks.
Generation takes several minutes for a short clip: say it is running, then go quiet. Only the credit
approval spends, so never pass `--yes` without the user's explicit approval; with the footage and workspace
questions that is three gates, and nothing else in this step stops.

**On the "another model" path the bill and the craft are both yours.** The rest of this step covers a clip
this repo did not commission: a generator on the user's own key, or footage they brought.

**READ THE MODEL'S OWN DOCUMENTATION BEFORE THE FIRST CALL. Do not infer it from this file.** `FAL_MODELS`
ids are defaults, not a catalogue; `--model` reaches any endpoint on the queue (text-to-video,
image-to-video, reference-driven variants, background removal, upscales). Inputs, outputs, duration and
resolution ceilings and cost are on the model's own page only.

**Captions need words with times on them, and where those come from depends on the generator.** Some models
return synced speech, some picture only. Check the model rather than assuming: the endpoint documentation
says which, and a clip on disk answers in one `ffprobe`. If the clip carries speech, transcribe it like any
other footage. If not, generate the voice track and map its times through
`npx @veedstudio/openedit-cli whisper <json> <media>`, or author the caption windows from the script. Warn
the user only in that second case, once established.

**A TAKE'S OWN AUDIO MUST NOT OWN THE CUT.** A take's dialogue as the soundtrack pins the picture to its
timecode: every pause is in the film and no shot can be shortened, reordered or dropped without breaking
sync. If the cut matters, keep the take for its picture, generate or re-voice the line, and let the edit be
free of it. Measure speech seconds against running time before calling the pauses the performance.

**AGREE THE SUBJECT BEFORE YOU PAY FOR IT.** If the ask leaves the subject open, say in one line what you
intend to make and let the user answer before the first paid call. That is one question about spend, not a
loop: write the best thing you can, say what it costs, and go.

**A SOUNDTRACK IS NOT A STATISTIC.** A measured reference says what it does, not what to make. **A sample
used more than twice is a defect**, an effect on every cut is a defect, and every generated cue gets a
prompt for its own moment, not one generic description reused. Listen to what came back before building on
it.

**ONE SCRIPT, RESEARCHED, AND THE INTERRUPTIONS ARE NOT PRINTED.** If the ask needs words, find out what is
actually being argued about in that field right now. Commit to one script and write it well; offering
versions hands the writing back to the user.

The script is display text: an interruption marker or em dash in it goes into the generation prompt and
onto the screen. Where a line breaks off, break it off; the cut and the next speaker carry the interruption.
Nothing that exists to instruct the reader of the script belongs in the words the viewer sees.

**Every generated asset lands in the manifest with its provenance** (`runs/<key>/assets/manifest.json`):
what made it, from what prompt, derived from what, and what it cost. Report the spend unprompted when the
run delivers, with `spendLine`; it says when a figure is a lower bound and when the response carried no
price. The no-price wording describes the inference response and this client, which does not ask for one,
not the endpoint's published pricing. If the user wants a real figure, read the model's pricing page rather
than saying it cannot be had.

