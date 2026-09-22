# @veedstudio/openedit-cli

The Open Edit command-line tool: agent-driven video creation and editing,
powered by VEED.

The package carries the content it runs on — the recipe pool, the director's
brief, the design substrate and the gates — so a fresh install can draw a style,
build a document and gate it without cloning anything. The source is public at
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

Transcribe videos, writing `runs/<key>/transcript.json`. There is no default
provider — the choice is the user's, recorded once with `--record`. Locally with
WhisperX (free, offline, nothing billed anywhere):

```sh
npx @veedstudio/openedit-cli transcribe video.mp4 [...] [--model medium] [--language de] [--force]
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

### prep

Probe the source canvas, synthesize `word-timings.json` from the transcript's
real per-word times, and cut one base frame per beat (the transcript must
already exist):

```sh
npx @veedstudio/openedit-cli prep video.mp4 [...]
```

### synth-timings

Even-split word reveal delays for a single beat window:

```sh
npx @veedstudio/openedit-cli synth-timings --start 1.2 --end 3.4 --words "A B C" [--out file.json]
```

### generate / generate-set / sample-presenter

Fabric generation — source footage from a script, when there is no video to
caption. Generating spends TWO of the named workspace's allowances — AI
Playground credits for the video and text-to-speech seconds for the voice — so
it is two commands: the first quotes both and records the approval, the second
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

Remove a video's background (VEED's free route by default; `--fast` uses a fal
model billed to your own fal key), or re-lipsync a video to a new audio track
(always fal-billed). Both use the VEED login only to host the local file:

```sh
npx @veedstudio/openedit-cli background-removal video.mp4 [--fast] [--mask-only] [--out <path>]
npx @veedstudio/openedit-cli lipsync video.mp4 narration.mp3 [--out <path>]
```

The fal key comes from `FAL_KEY`, or `OPEN_EDIT_FAL_KEY_FILE` pointing at a
file that holds it.

### install-engine

Download the veed render engine (checksum-verified, from its public GitHub
releases) into the app-data dir, or upgrade an existing install:

```sh
npx @veedstudio/openedit-cli install-engine [weave-v<semver>]
```

`VEED_ENGINE_BIN` overrides where the engine is looked for. The binary is
licensed separately (PolyForm Shield); its license installs beside it.

### install-ffmpeg / install-whisperx

The other two installers. `install-ffmpeg` checks for a working FFmpeg first
(`VEED_ENGINE_FFMPEG`, then PATH, then a previous install) and only downloads
when nothing works — a checksum-verified static build into the app-data dir
(the download route is Windows-only; macOS points at `brew install ffmpeg`).
`install-whisperx` installs the local transcription provider into an isolated
uv/pipx tool environment; it never touches the system Python.

```sh
npx @veedstudio/openedit-cli install-ffmpeg [--check|--force]
npx @veedstudio/openedit-cli install-whisperx [<version>]
```

### mux-audio / mix-audio

Put sound on a render. `mux-audio` lays a run's source audio (or `--audio
<file>`) onto its silent render, levelled to -14 LUFS / -1 dBTP (`--no-loudnorm`
keeps the source level; the line it prints says which correction ran);
`mix-audio` first builds one track from many pieces — narration, music,
effects — per the run's mix spec, with music ducked under the voice:

```sh
npx @veedstudio/openedit-cli mix-audio runs/<key>            # → runs/<key>/audio/mix.m4a
npx @veedstudio/openedit-cli mux-audio runs/<key> --audio runs/<key>/audio/mix.m4a
```

### wcag-pass

Contrast-audit a rendered run through the engine's bundled analyzer, and (with
`--apply`) promote the remediated template after re-verifying it:

```sh
npx @veedstudio/openedit-cli wcag-pass --run runs/<key> [--apply]
```

Needs the installed engine (`install-engine`). `WCAG_REMEDIATE` can point at a
replacement remediation applier; by default the bundled one runs as its own
plain-node process.

### gates / expect-windows

The whole gate chain — lint → verify → contrast → record → mux —
as one command over a run directory (run it outside any sandbox; rendering
needs a real desktop session):

```sh
npx @veedstudio/openedit-cli gates runs/<key> [--doc <subdir>] [--audio <file>] [--no-mux] [--no-loudnorm] [--no-expect] [--no-wcag] [--no-safezones]
```

`expect-windows` derives the `verify.expect` timing assertions from a
document's own gates (`--write` stamps them into the manifest); the chain runs
it automatically. The lint gate comes from the content this package
carries, so it runs in-process with no checkout (`lint` also
exists as a standalone command); `OPEN_EDIT_ROOT` pointed at a checkout runs that
checkout's gates instead. `content-root` prints where the content lives.

### Editing and QA tools

The remaining pipeline tools, each a direct port of its script:

```sh
npx @veedstudio/openedit-cli concat-chapters <run-dir> --doc chapters/act-1 --doc chapters/act-2
npx @veedstudio/openedit-cli concat-videos [--canvas WxH] [--fit letterbox|crop|open] <out> <in1> <in2> [...]
npx @veedstudio/openedit-cli cut-frames <video> [--json]      # frames at every shot boundary
npx @veedstudio/openedit-cli scene-frames <video> <outDir>    # stills for a clip with no beats
npx @veedstudio/openedit-cli frames <video> --at 12.5,1:02 --frame 300-306 --every 0.5 --from 8 --to 11 [--sheet]  # stills at the moments you name
npx @veedstudio/openedit-cli frames --images <image|dir> [...] [--width N] [--cols N]                                   # pictures that already exist, on one sheet
npx @veedstudio/openedit-cli check-delivery <run-dir> [--doc <subdir>] [--samples N] [--json]                       # the finished file: container, picture against the source, loudness
npx @veedstudio/openedit-cli scoped-edit <baseline.wv> <candidate.wv> [--allow <selector>]...
npx @veedstudio/openedit-cli brand --file <brand.json> [--brief] [--check]
npx @veedstudio/openedit-cli creative-log --for <video> [--reject "…" --why "…"] [--brief]
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

The retimed transcript goes where `prep` reads, `runs/<key>/` under the runtime
root, so `prep cut.mp4` finds it and the cut is never transcribed.

### stills / preview

`stills` fetches licensed pictures from Wikimedia Commons, recording each
file's terms beside it (`search` / `show` / `save`). `preview` serves a
read-only localhost page for a run — scrub the footage, follow the transcript,
and the player swaps to the new render when it lands:

```sh
npx @veedstudio/openedit-cli stills search "berlin skyline" --limit 10
npx @veedstudio/openedit-cli preview runs/<key>
```

### init / readiness

`init` is the workspace setup: it checks the machine dependencies (Node,
ffmpeg), npm-ifies the workspace (a minimal private `package.json` when none
exists, this CLI exact-pinned as a devDependency, `git init` when git is
available, `runs/` gitignored, the skill refreshed from packaged content),
verifies the render engine, and applies clean patch/minor updates of the CLI
itself — a major release, or one whose engine floor is not met, waits for
approval. An explicit `--repository`/`--ref` keeps the legacy managed-clone
path (which needs git and pnpm). Bare `init` applies only safe,
workspace-local setup; `--dry` reports without writing; `--auto-approve` also
applies machine-global installs and clean updates, and is only for after a
person has approved every reported action. Exit 10 means something is awaiting
that approval; on success the workspace root is printed on stdout.

```sh
npx @veedstudio/openedit-cli init --dry --workspace <dir>
npx @veedstudio/openedit-cli init --workspace <dir>
```

`readiness` reports what is present vs missing for a run — read-only, no
network — and exits 1 when a blocking item is missing.

## Configuration

| Environment variable | Effect |
| --- | --- |
| `VEED_ORIGIN` | Overrides the default `https://www.veed.io` origin. |
| `OPENEDIT_STATE_DIR` | Overrides where login state is stored. |
| `OPEN_EDIT_ROOT` | Where `runs/<key>/` outputs and `.open-edit-prefs.json` are written (default: the app-data directory below). Pointed at an Open Edit checkout it also replaces the bundled content, so the CLI runs that checkout's recipes and gates instead. |
| `OPENEDIT_PACKAGE_SOURCE` | Overrides what init pins into a scaffolded workspace (a packed tarball path in tests and CI). |
| `OPENEDIT_REGISTRY` | Overrides the npm registry the auto-update check consults (default: `https://registry.npmjs.org`). |
| `VEED_ENGINE_FFMPEG` / `VEED_ENGINE_FFPROBE` | ffmpeg/ffprobe binaries (default: `PATH`; ffprobe defaults beside a configured ffmpeg). |
| `WHISPERX_BIN` / `WHISPERX_MODEL` | WhisperX binary and fallback model tier (defaults: `whisperx` on `PATH`, `small.en`). |
| `OPEN_EDIT_WHISPERX_DEVICE` / `OPEN_EDIT_WHISPERX_COMPUTE` | WhisperX device/compute (defaults: `cpu`/`int8`). |

Login state lives in the platform's per-user app-data directory:
`~/Library/Application Support/veed-openedit` on macOS, `%APPDATA%\veed-openedit`
on Windows, and `$XDG_CONFIG_HOME/veed-openedit` (default `~/.config/veed-openedit`)
on Linux.

## License

Apache-2.0. See the bundled `LICENSE` and `NOTICE` files.
