# open-edit: Fabric presenters

Read this whole file before the first Fabric command. Fabric turns a script into a talking-head clip,
billed to one of the user's VEED workspaces; the clip then enters like footage the user brought.

On the Fabric path exactly three things stop and ask: the footage question (the No footage section of
`SKILL.md`), WHOSE credits, and the credit approval. Everything else — logging in, generating, reporting the charge — is a step: do it, say what
happened, keep moving.

**LOG IN BEFORE THE FIRST FABRIC COMMAND.** Every command below needs the VEED token — the SAME token VEED
transcription uses, not a second one — so establish the login here rather than discovering it is missing
mid-flow. If a command reports "No VEED login found", run the login flow in `TRANSCRIPTION.md` yourself
(the user never runs a command or pastes a token). One login covers generation and transcription for
about a month.

Draft the script yourself from their prompt and show it for edit. Generation is **two commands, and the
script is typed only in the first one.**

**WHOSE credits.** Generation spends the AI Playground credits of ONE
workspace. With exactly one on the account there is nothing to decide, so it is used and NAMED with what it
holds; with several and no prior answer the CLI stops and asks, and never picks. Run the confirm
command with no workspace flag first:
`npx @veedstudio/openedit-cli generate --script "<the script>" --key <key>`
It stops having spent nothing and lists every workspace with its name and credit balance. Put that choice to
the user in plain terms (names and balances, not ids), then re-run naming the one they picked. The choice is
remembered, but a remembered choice is never a settled one: a spend pass whose workspace was only
remembered refuses until the command names it again, so put the remembered workspace and its balance to the
user, get a yes, and carry `--workspace <id>` on the spend command.

**WHAT IT COSTS.** Generating draws AI Playground credits TWICE: the speech is synthesized first, then
handed to **Fabric One Lipsync** (`veed/fabric-one-lipsync`), and both debits land on the same credit
allowance. The quoted figure is the SUM of both, and read length depends on the voice, so the tool quotes a
range for an unmeasured voice: repeat the range, never flatten it to its low end. Too expensive: redraft a
shorter script or take another answer to the footage question, never a different workspace.

**WHO presents it.** If the user has no opinion about the presenter, do not paste 24 thumbnails at them:
`npx @veedstudio/openedit-cli sample-presenter --key <key> [--gender male|female] [--locale <locale>] [--portrait|--landscape]`
It proposes one character and voice plus a few alternates, and ends with the ready-to-run confirm command.
It proposes, it never decides — it costs 0 credits, writes nothing, and the user overrules it with `--seed N`
or by editing the two ids. Show them the pick and the alternates; the yes to the CONFIRM proposal covers
the presenter too.
The presenter can be theirs: `--image <url|path>` uses their own still, and then `--voice` is required.

**A SET of stills is ONE approval.** Several shots is one video: write a shots file
`[{ id, script, image | character, voice }, …]` and run
`npx @veedstudio/openedit-cli generate-set --shots shots.json --key <key> --workspace <id>`; it prints each
shot's cost and one total and spends the lot on a single `--yes`. Join the clips with `concat-videos`.

1. CONFIRM (spends nothing):
   `npx @veedstudio/openedit-cli generate --script "<the script>" --key <key> --workspace <id>`
   It prints the script, the character, voice, framing ("portrait 9:16"), the workspace being billed with its
   balance, and our estimate of the credit cost, records that approval, and prints the exact next command.
   Show the user the cost in plain terms and get an explicit yes.
2. SPEND (only after that yes): the command it printed, **with no `--script`**:
   `npx @veedstudio/openedit-cli generate --key <key> --yes`
   That yes binds the SCRIPT, the FIGURE (character, voice, framing, quoted cost) and the WORKSPACE together
   for one hour; if any of the three drifts the run refuses rather than charging something the user never saw.
   A refusal charges nothing: re-run CONFIRM for a fresh yes.

**Say what it cost, and how much to trust the figure.** The number the run stands behind is OUR ESTIMATE
from the script's length — VEED quotes no per-job price and reports no per-job charge, so there is nothing
to confirm it against. Give it with the workspace it came out of ("about 380 credits from <workspace>"),
never as a figure VEED confirmed, and pass on the balance movement the run prints the way it prints it.
Never let a run that spent credits end silently about cost.

**AFTER THE MONEY IS GONE.** A charged job is never re-charged automatically, and never re-run `--yes` to
retry: another attempt needs a fresh CONFIRM and a fresh yes. A failed run can still have cost something:
report the figures it prints. An interrupted run is paid for: collect it with
`npx @veedstudio/openedit-cli generate --key <key> --resume`, which spends nothing. When `--yes` refuses
saying a charge may have landed, tell the user to check that workspace, then free the key with the
`--abandon <sessionId>` command the refusal names.

→ `runs/<key>/<key>.mp4`, footage like any other.
