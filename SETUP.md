# SETUP

## Install as an agent skill
From the project where you want to use Open Edit:
```
npx skills add veedstudio/open-edit --skill open-edit
```
The CLI package is self-contained — the skill ships inside it. On first use, bare
`npx @veedstudio/openedit-cli init` turns the current folder into an ordinary npm project (a minimal
private `package.json` when none exists, the CLI exact-pinned as a devDependency, `git init` when git is
available, `runs/` gitignored), and installs the skill into `.claude/skills/` for Claude Code and
`.agents/skills/` for Codex and Gemini CLI. It writes no hooks into any agent's settings, and removes the
ones earlier versions added. An empty folder needs no questions; a folder that already
holds other files (or another project's `package.json`) is asked about first — approve it, or point
`--workspace` at the location you want (a fresh subfolder works well). Your project is reproducible from `package.json` plus its
lockfile, like any npm project. Init reuses a valid Open Edit checkout when run inside one, and it never
installs system tools or updates existing code without explicit approval. The CLI never updates itself:
commands print `update available` when a newer release is out (about one registry lookup a day;
`NO_UPDATE_NOTIFIER=1` turns it off), and once you say yes, `init --update <version>` installs exactly
that version.

Init has three modes: bare applies safe local setup, `--dry` reports without writing, and
`--auto-approve` also applies the reported machine-global installs init can run on this system (see
Requirements). An agent must run `--auto-approve` only after showing every proposed action and receiving
explicit approval. `--update <version>` is separate, and runs only when asked for.

## Requirements
1. **macOS, Linux or Windows** and **Node 20.18.1 or newer**. Git is optional (init versions your project with it
   when present, and skips that silently when not); pnpm is only needed for a contributor checkout.
   On macOS, init offers to install missing tools via Homebrew. On Windows, bare init itself fetches a
   missing FFmpeg into the CLI's app-data dir, with no admin rights needed, and only prints the Node
   command, even under `--auto-approve`: `winget install --id OpenJS.NodeJS.LTS` (or the direct
   download from nodejs.org if winget is absent). On Linux it only prints the Node and FFmpeg
   commands, even under `--auto-approve`: `sudo apt install ffmpeg` and Node 20.18.1+ from nodejs.org
   or your package manager, which need root. Run them yourself, then re-run init (on Windows from a
   NEW terminal, so the PATH changes are visible). A checkout's pnpm comes from corepack or npm, which
   init runs under `--auto-approve` everywhere but Windows.
2. **ffmpeg/ffprobe** (stills, cuts and audio). On PATH, or set `OPENEDIT_FFMPEG` /
   `OPENEDIT_FFPROBE`. On Windows, where the global installers want elevation,
   `npx @veedstudio/openedit-cli install-ffmpeg` puts a checksum-verified static build in the
   CLI's app-data dir — no admin rights, and nothing to export afterwards. macOS uses
   `brew install ffmpeg`, which already reaches a user-owned prefix; Linux uses its package manager
   (`sudo apt install ffmpeg`), which you run yourself.
3. **A transcription provider** — the skill asks once and remembers the answer. Either
   **VEED** (`npx @veedstudio/openedit-cli login`, one-time OAuth, ~30-day refreshable token; a free account
   covers about 10 minutes a month) or **WhisperX** locally (`npx @veedstudio/openedit-cli install-whisperx`,
   free and offline). You can also point it at your own service. See `.github/README.md`.
4. **VEED credits.** **VEED transcription consumes VEED transcription credits** (WhisperX runs locally on your
   machine; your own service is billed by whoever provides it). Separately, with no source video the skill can GENERATE a talking-head clip
   (`npx @veedstudio/openedit-cli generate`), which spends a workspace's AI Playground credits. **Fabric reuses VEED
   transcription's authentication** — same account, same login, same token; no connector, no second sign-in. Generating is TWO charges on ONE allowance, that workspace's
   AI Playground credits: the speech is synthesized, then Fabric One Lipsync (~4 credits a second of finished
   video) lip-syncs it, and the estimate you approve is the sum of both. The script sets the duration at
   roughly 1,080 characters a minute, so a 60-second read is a couple of hundred credits. It never picks
   the workspace for you and never spends without your explicit approval of the estimate; what the
   balance moved by is reported and recorded under `runs/<key>/`.
5. **Machine paths** — optional env overrides: ffmpeg as above, `WHISPERX_BIN` and `WHISPERX_MODEL` for
   WhisperX. Videos live anywhere: invoke the skill with the video's path (absolute, or relative to your
   CWD).

For a manual contributor checkout, run `pnpm install --frozen-lockfile`. The skill recognizes and reuses that
checkout but never updates it.

## Gotchas
- On Windows, run repo commands through their `node` forms (`node --import tsx …`). In PowerShell,
  quote globs and paths with double quotes.
- The orchestration is an agent skill — run it from Claude Code, Codex, Gemini CLI or any harness reading
  `.claude/skills/` or `.agents/skills/`; init puts the skill in both. There is no `node run.js`.

## Run
Invoke the `open-edit` skill on a video (pass its path), or describe a piece with no footage. Everything a
piece is made of lands in `runs/<key>/`: `transcript.json`, the page, its assets and its renders.
