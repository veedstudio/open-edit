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

### render / fonts / safe-zone / install-browser

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
which `render` also does on first use. `safe-zone` writes the stylesheet for a
platform format (9:16 for TikTok, Reels and Shorts; 16:9 for YouTube; 4:3): the
stage at its size, and a `[data-safe]` container on the format's safe zone as the
page's text layer, drawn from the platforms' published ad safe zones, with
television title-safe sides on 4:3 (`safe-zone --help` says exactly what each keeps
clear). The container is a size container, so `cqw` and `cqh` measure the zone
for what is inside it. Its other defaults lose to any rule the page writes: text
inside starts at the format's minimum (and so do `small`, `sub`, `sup`, `h5`, `h6`
and form controls), a word too long for its line breaks, boxes inside keep within its
width unless they set `max-width: none` (a ticker's track also sets `width:
max-content`), and nothing is clipped:

```sh
npx @veedstudio/openedit-cli fonts "Inter:wght@400;700" Anton --out fonts
npx @veedstudio/openedit-cli safe-zone tiktok --out runs/<key>
npx @veedstudio/openedit-cli install-browser [--check|--force]
```

### mux-audio / mix-audio

Put sound on a render. `mux-audio` lays a track (the source clip, or a built
soundtrack) onto a silent render, levelled to -14 LUFS / -1 dBTP
(`--no-loudnorm` keeps the source level; the line it prints says which
correction ran);
`mix-audio` first builds one track from many pieces — narration, music,
effects — per the run's mix spec, with music and effects ducked under the voice:

```sh
npx @veedstudio/openedit-cli mix-audio runs/<key>            # → runs/<key>/audio/mix.m4a
npx @veedstudio/openedit-cli mux-audio --video runs/<key>/out.mp4 --audio runs/<key>/audio/mix.m4a --out runs/<key>/final.mp4
```

### review

Run every delivery check on the video about to be delivered and print one
report. It changes nothing, and exits 0 whatever it finds. The blank-frames
check reports a flash, a frame or two of one flat colour (a blank white page
with only a caption on it, say) between other pictures; any flat colour held
with nothing on it for more than a second; and a first frame that is blank,
near-black or partway into a fade-in, since platforms show it as the cover.
The dead-tail check reports a picture that runs on more than a second past its
last sound or its last spoken word. The words come from the `transcript.json`
in the video's folder, or the one `--transcript` names; the review never
transcribes, and without a transcript it says what it skipped. The length check
reports a picture that runs longer or shorter than the length `--length` names,
in seconds, by more than a second or 5% of that length, whichever is more;
without `--length` it is skipped.

Two checks read the record of on-screen text that `render` writes beside each
video, `<video>.text.json`: the text the page draws in its HTML and SVG (not
text inside an image, a canvas or the footage), read about every 100 ms of the
page's time, with its words, its box and font size in the video's pixels, its
colour and its opacity. `mux-audio` carries the record to the file it writes,
and a patch with `--from/--to` keeps it whole. The text check reports text
smaller than a phone's body text, measured against the frame's shorter side,
and text under WCAG's 3:1 contrast for large text against what is really behind
it, measured on the video's pixels around the glyphs, so a backing, a stroke or
a shadow counts; it skips the contrast of a transparent render, and of text
that is translucent or has no solid fill of its own. The captions check reports
a second or more of speech with no caption on screen. A caption is a text that
shows the words being spoken, or, in another language than the voice, one of a
run of texts in one place that change with the spoken phrases; a title is not
one. It is skipped when the page captions too little of the speech to be
captioning it, or there is no transcript. A video without a record, or with one
for a picture of another size or length or older than the video, skips both
checks:

```sh
npx @veedstudio/openedit-cli review runs/<key>/final.mp4 [--transcript <transcript.json>] [--length <sec>]
```

### Frames and joins

Tools for looking at and joining footage:

```sh
npx @veedstudio/openedit-cli concat-videos [--canvas WxH] [--fit crop|letterbox] <out> <in1> <in2> [...]
npx @veedstudio/openedit-cli frames <video> --at 12.5,1:02 --frame 300-306 --every 0.5 --from 8 --to 11 [--sheet]  # stills at the moments you name
npx @veedstudio/openedit-cli frames --images <image|dir> [...] [--width N] [--cols N]                                   # pictures that already exist, on one sheet
npx @veedstudio/openedit-cli shots <video> [--threshold 0.1] [--min-shot 0.333] [--faces <faces.json>] [--json]          # a video as a shot list: cuts, lengths, speech from an existing transcript, shot size from existing face boxes, storyboard sheets
```

The cut tools, for an edit made before captioning: measure where speech starts,
stops and pauses; assemble the kept ranges of an EDL (edit decision list) in one
encode with crossfaded joins, each range snapped to the frame grid; and move the
per-word timings you already have onto that timeline instead of transcribing the
cut again. `--gap` and `--crossfade` are milliseconds; the EDL is seconds.

```sh
npx @veedstudio/openedit-cli speech-probe <video> [--range a:b] [--gap 250] [--window 10] [--json]
npx @veedstudio/openedit-cli apply-edl --edl edl.json --out cut.mp4 [--crossfade 40] [--crf 20] [--fit crop|letterbox]
npx @veedstudio/openedit-cli retime-transcript --edl edl.json --out <OPEN_EDIT_ROOT>/runs/cut/transcript.json
```

Both joins put every clip on one canvas, sized as the clips are shown (a phone
clip stored sideways counts as upright). A clip of another shape is cut to the
canvas's shape with `reframe`'s own code, around its faces when `faces` has run
on it and from the middle otherwise, and a line says which; `--fit letterbox`
keeps it whole and pads it instead. `render --footage` refuses footage of
another shape than the stage and names the `reframe` command that cuts it.

The retimed transcript goes where a transcription of the cut would land,
`runs/<key>/transcript.json` under the workspace, so the transcription routes
refuse to overwrite it and the cut is never transcribed.

### faces / reframe / install-mediapipe

Find the faces in each shot of a clip and write their boxes, for laying text
out around them and for `reframe` (and the joins, which cut a clip of another
shape as it does). They go to `runs/<key>/faces-<hash>/`, a folder of the clip's
own named by its real path, so two clips of one name never share one; `faces`
prints the path, and every reader looks there (and in a `runs/<key>/faces.json`
an older `faces` wrote, when it names that same clip). One decode finds the cuts and samples four
frames a second (`--every 0.25`), each labelled by its presentation time, so
variable-frame-rate footage is sampled in time; a shot sampled fewer than four
times also gets its first frame and the first at or past the middle of each
quarter of it;
MediaPipe's full-range BlazeFace model finds the faces on CPU. `faces.json`
holds the boxes per sampled frame of each shot; `faces.js` holds them too, with
`openeditFaces.place(el, from, to)`, which moves a laid-out element the least
distance that clears every face on screen between those seconds of the clip.
`install-mediapipe` puts MediaPipe, every package it runs on at the versions
verified together (OpenCV's headless build) and the model into an environment
of their own under the app-data directory, never the system Python: with uv
when present, which fetches a Python it can use, else with `python3 -m venv`
when that python3 is 3.12 or newer. MediaPipe 1.1.1 has no Intel Mac build; on
an Apple Silicon Mac run an arm64 Node, and on Windows on ARM install uv and set
`OPEN_EDIT_MEDIAPIPE_PYTHON=cpython-3.12-windows-x86_64-none`:

```sh
npx @veedstudio/openedit-cli install-mediapipe [<version>]
npx @veedstudio/openedit-cli faces video.mp4 [--out <dir>] [--every 0.25] [--threshold 10] [--confidence 0.5] [--margin 0.25]
```

`reframe` cuts a clip to another shape (16:9 to 9:16, say). With those boxes,
and without guessing who is who, each shot, which can be split again where a
face seen alone for four samples jumps further than its own width and is seen
alone there for four more (a dissolve or a cut the cut detection missed), is
followed when it shows one face only (never two at once, each found
overlapping the one before), the crop holding still while the face stays inside
it and easing to a new place only when it must, and held at one place when it
shows more, where the faces wholly inside add up to the most height; at a cut
or a split it jumps. Without them it cuts the clip from the middle. It only
crops, at the source's resolution, and always re-encodes: upright, in square
pixels, H.264, a clip already in that shape included.

```sh
npx @veedstudio/openedit-cli reframe video.mp4 --aspect 9:16 --out tall.mp4 [--faces <faces.json>]
```

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
| `OPEN_EDIT_MEDIAPIPE_PYTHON` | The Python version `install-mediapipe` asks uv for (default: `3.12`; the pinned packages need 3.12 or newer). |

Login state lives in the platform's per-user app-data directory:
`~/Library/Application Support/veed-openedit` on macOS, `%APPDATA%\veed-openedit`
on Windows, and `$XDG_CONFIG_HOME/veed-openedit` (default `~/.config/veed-openedit`)
on Linux.

## License

Apache-2.0. See the bundled `LICENSE` and `NOTICE` files.
