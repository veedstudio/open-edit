# open-edit: transcription (the PREP step's provider choice, login and failures)

Read this whole file when `$OPEN_EDIT_ROOT/.open-edit-prefs.json` records no provider, a command reports
"No VEED login found", or a transcription run fails. `SKILL.md` carries the commands for a recorded provider.

PROVIDER CHOICE: if nothing needs transcribing (no footage, silent source, a graphics-only ask), do not
ask it and record nothing. Otherwise read `$OPEN_EDIT_ROOT/.open-edit-prefs.json` first (the root
preflight printed: the workspace on the package path, the checkout in contributor mode; a legacy managed
clone's choice was promoted there by init, and looking anywhere else re-asks on every run). If it records a provider, use it and ask nothing. Only on a cold start (no
file, or nothing usable in it) ask once, offering exactly these four. No default: never pick for the
user. VEED transcribes best, so it is first and named as best; keep the order and the wording however
you put the question, then let them choose.

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

Record the answer with the command, never hand-authored JSON. Always include the WhisperX tier:

| They chose | Record it as |
| --- | --- |
| 1 · VEED | `npx @veedstudio/openedit-cli transcribe --record veed` |
| 2 · WhisperX, better | `npx @veedstudio/openedit-cli transcribe --record whisperx --model medium` |
| 3 · WhisperX, fastest | `npx @veedstudio/openedit-cli transcribe --record whisperx --model small.en` |
| 4 · their own service | `npx @veedstudio/openedit-cli transcribe --record custom` |

If they answer "WhisperX" with no tier, take fastest (`small.en`), record it, and say which you took;
they can switch later. Never record `whisperx` with no tier.

- **veed** → `npx @veedstudio/openedit-cli transcribe --provider veed <video> [...]`, login flow below. When the browser opens, say
  exactly: "I've opened a VEED login tab in your browser — click Allow if it asks. I'll wait here;
  there's nothing to paste."
- **whisperx** → `npx @veedstudio/openedit-cli transcribe <video> [...]` (recorded tier; `--model medium|small.en`
  only to override). If the binary is missing, ask before installing: "WhisperX isn't installed. It's a local
  Python tool — the install pulls in PyTorch and the first run downloads a model, so expect a slow first
  pass and around 2 GB of disk. It goes in its own isolated environment, not your system Python and not
  this project, and `uv tool uninstall whisperx` removes it again. Install it now?" On yes run
  `npx @veedstudio/openedit-cli install-whisperx` and stream its output.
- **custom** → drive the user's service yourself (their MCP, CLI or API; their credentials, never handled
  here) to get a Whisper-family JSON, then `npx @veedstudio/openedit-cli whisper <json> <video>` (one json
  per video, in pairs for a batch). The whisper command is the shipped mapper; driving their service is yours.

OFFERING THE ALTERNATIVE, once and in these words:

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
  the step with no subject, not the run: with no transcript there is no recipe, so author DESIGN + RENDER
  inline per `director-brief.md` as the NO VIDEO case does, footage as the base layer, timings chosen by
  you. Only an ask for speech captions specifically has nothing left to do.

WHEN A RUN FAILS, classify it; none of these is a silent retry:

- **Out of credits** (the veed transcribe run says "out of transcription credits") → re-ask the provider
  question with VEED still on the table: "VEED is out of transcription
  credits for this workspace — a free account covers about 10 minutes a month. You can add a plan at
  https://www.veed.io/pricing and I'll retry, or I can run WhisperX locally instead: free, offline, and
  it installs on first use. Which would you like?" Do not rewrite the recorded provider until something
  succeeds.
- **Login failed or expired** → run the login flow once more; if it fails again, treat it as declined and
  offer the alternative in the words above.
- **Anything else** (upload failure, poll timeout, network) → retry the command once, then offer the
  alternative.

Report the provider in ONE line once the transcript lands — "Transcribed with WhisperX (medium),
locally." or "Transcribed with VEED." — and relay any warning the run printed, e.g. "12 of 340 words came
back without timings, so those reveals are approximate; the text is complete." That single line is
allowed; step-by-step progress is not.

Re-ask only when the recorded provider is gone (token revoked, WhisperX uninstalled), the user asks to
switch, or a run failed and the alternative has not been offered yet; "switch transcription provider"
means rewrite that file.

LOGIN (if the veed transcribe run says "No VEED login found"): OAuth needs one browser sign-in by the
user, but you launch it; do not just tell them to run a command. Preferred flow (refreshable token,
~30-day):
- Run `npx @veedstudio/openedit-cli login` in the background. It starts a local catcher, prints an
  authorize URL, and opens that URL in the user's browser itself; you open nothing. Watch its output for
  `Logged in.`; meanwhile tell the user a VEED login tab has opened and to click "Allow" if a consent
  screen appears (usually it auto-approves). The browser redirects to `http://127.0.0.1:8977/callback`;
  the login command catches it and stores the token. Nothing to paste. Headless/SSH (no browser `open`
  can reach): add `--manual` and paste the redirected URL back to it.
- If the flow misbehaves, re-run it. Never read the user's browser cookies or local storage for a
  token, and never ask them to paste one out of DevTools.

## Warnings from the local provider

TRANSCRIPTION WARNINGS (local provider): a WhisperX run on macOS prints a wall of `Could not load
  libtorchcodec`, `dlopen` failures and `Library not loaded: @rpath/libavutil.<N>.dylib` for several FFmpeg
  majors, plus a Lightning checkpoint-upgrade notice (Windows prints an equivalent DLL-probing wall). They
  are pyannote probing FFmpeg builds it cannot find and are HARMLESS. Success is the line
  `[transcribe] whisperx: <N> words -> <path>` (it ran) or `[transcribe] cached: <path> already exists
  (--force to transcribe it again)` (left alone; a success, not a skip). If neither appears, read the last
  error, not the dlopen wall.
