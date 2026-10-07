# @veedstudio/openedit-cli

The Open Edit command-line tool: agent-driven video creation and editing,
powered by VEED.

The package carries the agent skill that `init` installs into a workspace;
everything else is a command below. The source is public at
[veedstudio/open-edit](https://github.com/veedstudio/open-edit), whose README
covers what Open Edit is and what it makes; this page is the command surface.

## Usage

```sh
npx @veedstudio/openedit-cli --help
```

## Commands

### login

Log in with VEED (OAuth 2.1 + PKCE via the browser; the token is stored locally
and refreshed automatically):

```sh
npx @veedstudio/openedit-cli login
```

Pass `--manual` (or set `VEED_LOGIN_MANUAL=1`) when no reachable browser exists:
the URL is printed, and the redirect is pasted back instead of caught on a
localhost loopback.

### token

Print a valid VEED access token for other tools to consume, refreshing it
first when stale (`VEED_ACCESS_TOKEN`, when set, is passed through as-is). The
value is printed only when the output is captured; run it straight in a terminal
and it reports that a token exists without putting one in your scrollback:

```sh
npx @veedstudio/openedit-cli token
```

Exits non-zero when no login is stored. `--path` prints the token store
location instead of a token.

### transcribe

Transcribe videos, writing `runs/<key>/transcript.json`. The provider is the
user's choice, recorded once with `--record`: a bare `transcribe video.mp4` runs
the recorded one (and refuses, saying why, when nothing usable is recorded), and
`--provider` names another for one run. Locally with WhisperX (free, offline,
nothing billed anywhere):

```sh
npx @veedstudio/openedit-cli transcribe --provider whisperx video.mp4 [...] [--model medium] [--language de] [--force]
```

A transcript already on disk is left alone (it may have been retimed onto an
edit); `--force` transcribes it again.

Or hosted by VEED (premium quality; requires the one-time `login`, and spends
the workspace's VEED transcription credits — `--workspace <id>` names which,
required only when the account has several):

```sh
npx @veedstudio/openedit-cli transcribe --provider veed video.mp4 [...]
```

`--record <veed|whisperx|custom> [--model <id>]` records the transcription
provider choice in `.open-edit-prefs.json` instead of running anything.

### whisper

Map a Whisper-family JSON produced by your own service (WhisperX,
openai-whisper, whisper-timestamped, mlx-whisper, whisper.cpp `-oj -ml 1`, or
the OpenAI API's `verbose_json` with word granularity) into the same
`runs/<key>/transcript.json`:

```sh
npx @veedstudio/openedit-cli whisper transcription.json media.mp4 [...] [--force]
```

Word timestamps are required; the media argument may be a video or an audio
file.

### generate / generate-set / sample-presenter

Fabric generation — source footage from a script, when there is no video to
caption. Generating draws the named workspace's AI Playground credits twice —
the speech is synthesized, then lip-synced — so it is two commands: the first
quotes the sum and records the approval, the second
spends exactly what was approved (no `--script` on the spend pass — the
recorded, hashed script is what bills):

```sh
npx @veedstudio/openedit-cli generate --script "spoken words" --key my-run --workspace <id>
npx @veedstudio/openedit-cli generate --key my-run --yes
```

`--resume` collects a job already created and paid for; `--abandon <sessionId>`
clears one abandoned charge record. `generate-set --shots shots.json` covers
several shots under one approval, and `sample-presenter` proposes a
deterministic character/voice pair for a run key (listing costs nothing).

### background-removal / lipsync

Remove a video's background, or re-lipsync a video to a new audio track.
Background removal tries VEED's free route first; when that route cannot run,
it stops having spent nothing and prints what fal's model would cost and the
command to run with `--fal`. Only `--fal` (the full model, uploaded to fal's own
storage) or `--fast` (fal's fast model) buys anything, and lipsync always goes
through fal. Every fal call bills your own fal key, never a VEED workspace; a
re-run of the same inputs resumes the paid job instead of buying it again:

```sh
npx @veedstudio/openedit-cli background-removal video.mp4 [--fal|--fast] [--mask-only] [--no-refine] [--out <path>]
npx @veedstudio/openedit-cli lipsync video.mp4 narration.mp3 [--out <path>]
```

The fal key comes from `FAL_KEY`, or `OPEN_EDIT_FAL_KEY_FILE` pointing at a
file that holds it.

### veed-project / veed-pull

Hand a finished edit to VEED's editor as a project a person can take apart:
footage cuts, text, captions, images and each audio track become the editor's
own items, and each page element the plan names becomes a transparent clip cut
to its box. It uses your VEED login and spends no VEED credits and nothing on your
fal key. The last step runs in
your browser: click the "OpenEdit to VEED" bookmark on VEED. The way back is the
"Send to Claude" bookmark on a project open in the editor, and `veed-pull`:

```sh
npx @veedstudio/openedit-cli veed-project --install-bookmark
npx @veedstudio/openedit-cli veed-project plan.json [--workspace <id>] [--local]
npx @veedstudio/openedit-cli veed-pull ~/Downloads/openedit-<project id>.json --out <dir>
```

`veed-project --help` lists the plan's fields; `veed-pull` writes the project
back as such a plan.

### fal

Run any fal model on your own key. Local file paths inside the input are
uploaded for you (multipart above 90 MB), outputs are downloaded, and each job
ends with a cost line: the billed figure when your key can read fal's billing,
otherwise `cost: unknown` beside fal's listed price. An identical request is
bought once, even across processes and crashes:

```sh
npx @veedstudio/openedit-cli fal schema <model>
npx @veedstudio/openedit-cli fal run <model> --input '{"prompt":"…"}' [--out <dir>]
npx @veedstudio/openedit-cli fal run --batch jobs.json [--concurrency N]   # [{model, input, name?}]
```

### install-ffmpeg / install-whisperx

`install-ffmpeg` looks for an existing FFmpeg first (`OPENEDIT_FFMPEG` and
`OPENEDIT_FFPROBE`, then a previous install, then PATH) and only downloads when
there is none — a checksum-verified static build into the app-data dir (the
download route is Windows-only; macOS points at `brew install ffmpeg`, Linux at
`apt`). A set `OPENEDIT_FFMPEG` or `OPENEDIT_FFPROBE` is run first, and fails
the command, naming the variable, when its binary does not start, since nothing
else is used while it is set; `--check` runs whichever pair every command would.
`--force` reinstalls the app-data copy, and is refused while either override is
set, since no command would run the copy it installs.
`install-whisperx` installs the local transcription provider into an isolated
uv/pipx tool environment; it never touches the system Python.

```sh
npx @veedstudio/openedit-cli install-ffmpeg [--check|--force]
npx @veedstudio/openedit-cli install-whisperx [<version>]
```

### render / fonts / install-browser

Render an HTML page to video in headless Chrome, frame-exact. The page runs on a
virtual clock (timers, `requestAnimationFrame`, `Date.now` and a seeded
`Math.random` advance one frame per frame); CSS and Web Animations, GSAP's
global timeline and an optional `window.__seek(t)` are set to each frame's time,
and `<video>` elements show the picture at that time. The output is silent H.264
(or ProRes 4444 with `--transparent`), identical whatever the worker count:

```sh
npx @veedstudio/openedit-cli render page.html --out out.mp4 --fps 30000/1001 --duration 12 [--workers N]
npx @veedstudio/openedit-cli render page.html --out out.mp4 --from 4 --to 6     # re-render only that stretch
npx @veedstudio/openedit-cli render page.html --out stills --stills 0.5,2,4 --sheet sheet.jpg
```

Segments and a manifest are cached in `<out>.render/`, so `--from`/`--to`
re-renders only the segments it overlaps and rejoins the rest by stream copy.
It fails naming the cause when Chrome does not start, the page throws, or every
frame is one flat colour. `fonts` downloads Google Fonts as local woff2 files
with a `fonts.css`; `install-browser` fetches the pinned Chrome Headless Shell,
which `render` also does on first use:

```sh
npx @veedstudio/openedit-cli fonts "Inter:wght@400;700" Anton --out fonts
npx @veedstudio/openedit-cli install-browser [--check|--force]
```

### mux-audio / mix-audio

Put sound on a render. `mux-audio` lays a track (the source clip, or a built
soundtrack) onto a silent render, levelled to -14 LUFS / -1 dBTP
(`--no-loudnorm` keeps the source level; the line it prints says which
correction ran);
`mix-audio` first builds one track from many pieces — narration, music,
effects — per the run's mix spec, with music ducked under the voice:

```sh
npx @veedstudio/openedit-cli mix-audio runs/<key>            # → runs/<key>/audio/mix.m4a
npx @veedstudio/openedit-cli mux-audio --video runs/<key>/out.mp4 --audio runs/<key>/audio/mix.m4a --out runs/<key>/final.mp4
```

### Frames and joins

Tools for looking at and joining footage:

```sh
npx @veedstudio/openedit-cli concat-videos [--canvas WxH] [--fit letterbox|crop|open] <out> <in1> <in2> [...]
npx @veedstudio/openedit-cli frames <video> --at 12.5,1:02 --frame 300-306 --every 0.5 --from 8 --to 11 [--sheet]  # stills at the moments you name
npx @veedstudio/openedit-cli frames --images <image|dir> [...] [--width N] [--cols N]                                   # pictures that already exist, on one sheet
```

The cut tools, for an edit made before captioning: measure where speech starts,
stops and pauses; assemble the kept ranges of an EDL (edit decision list) in one
encode with crossfaded joins, each range snapped to the frame grid; and move the
per-word timings you already have onto that timeline instead of transcribing the
cut again. `--gap` and `--crossfade` are milliseconds; the EDL is seconds.

```sh
npx @veedstudio/openedit-cli speech-probe <video> [--range a:b] [--gap 250] [--window 10] [--json]
npx @veedstudio/openedit-cli apply-edl --edl edl.json --out cut.mp4 [--crossfade 40] [--crf 20]
npx @veedstudio/openedit-cli retime-transcript --edl edl.json --out <OPEN_EDIT_ROOT>/runs/cut/transcript.json
```

The retimed transcript goes where a transcription of the cut would land,
`runs/<key>/transcript.json` under the workspace, so the transcription routes
refuse to overwrite it and the cut is never transcribed.

### stills

`stills` fetches licensed pictures from Wikimedia Commons, recording each
file's terms beside it (`search` / `show` / `save`):

```sh
npx @veedstudio/openedit-cli stills search "berlin skyline" --limit 10
```

### init

`init` is the workspace setup: it checks the machine dependencies (Node,
ffmpeg) and npm-ifies the workspace (a minimal private `package.json` when none
exists, this CLI exact-pinned as a devDependency and installed, `git init` when
git is available, `runs/` gitignored, the skill refreshed from packaged content
into `.claude/skills/` for Claude Code and `.agents/skills/` for Codex and Gemini
CLI). In a clone whose `node_modules` lacks the pinned CLI, init asks for
approval to run the project's install (with lifecycle scripts off), since until
then `npx` would run the registry's latest rather than the pinned version.
It adds nothing to agent settings, and removes the SessionStart hooks earlier
versions added. Bare `init` applies only safe,
workspace-local setup; `--dry` reports without writing; `--auto-approve` also
applies the machine-global installs init can run on the system (Node and FFmpeg
only through Homebrew on macOS; on Windows bare init already fetches FFmpeg into
the app-data dir, no admin rights needed; the rest it prints for the user to
run), and is only for after a person has approved every reported
action. Exit 10 means something is awaiting
that approval; on success the workspace root is printed on stdout.

The CLI never updates itself. About once a day per machine a command asks the
registry whether a newer release is out; from the next command on, until the
update, each prints `update available` with both versions and the exact
`init --update <version>` that installs that version and refreshes the skill.
`NO_UPDATE_NOTIFIER=1` turns the lookup off.

```sh
npx @veedstudio/openedit-cli init --dry --workspace <dir>
npx @veedstudio/openedit-cli init --workspace <dir>
npx @veedstudio/openedit-cli init --update <version> --workspace <dir>
```

## Configuration

| Environment variable | Effect |
| --- | --- |
| `VEED_ORIGIN` | Overrides the default `https://www.veed.io` origin. |
| `OPENEDIT_STATE_DIR` | Overrides where login state, the update-check cache and init's lease are stored. |
| `OPEN_EDIT_ROOT` | Where `runs/<key>/` outputs and `.open-edit-prefs.json` are written (default: the nearest project above the working directory, else the app-data directory below). |
| `OPENEDIT_PACKAGE_SOURCE` | Overrides what init pins into a scaffolded workspace (a packed tarball path in tests and CI). |
| `OPENEDIT_REGISTRY` | Overrides the registry the update notice reads the latest version from (default: `https://registry.npmjs.org`); installs use npm's own registry config. |
| `NO_UPDATE_NOTIFIER` | Any non-empty value stops the once-a-day lookup and the `update available` notice. CI runs skip both already. |
| `OPENEDIT_FFMPEG` / `OPENEDIT_FFPROBE` | ffmpeg/ffprobe binaries (default: the copy `install-ffmpeg` put in the app-data directory, else `PATH`; ffprobe defaults beside a configured ffmpeg; an empty value counts as unset). |
| `WHISPERX_BIN` / `WHISPERX_MODEL` | WhisperX binary and fallback model tier (defaults: `whisperx` on `PATH`, `small.en`). |
| `OPEN_EDIT_WHISPERX_DEVICE` / `OPEN_EDIT_WHISPERX_COMPUTE` | WhisperX device/compute (defaults: `cpu`/`int8`). |

Login state lives in the platform's per-user app-data directory:
`~/Library/Application Support/veed-openedit` on macOS, `%APPDATA%\veed-openedit`
on Windows, and `$XDG_CONFIG_HOME/veed-openedit` (default `~/.config/veed-openedit`)
on Linux.

## License

Apache-2.0. See the bundled `LICENSE` and `NOTICE` files.
