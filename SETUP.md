# SETUP

## Install as an agent skill
From the project where you want to use Open Edit:
```
npx skills add veedstudio/open-edit --skill open-edit
```
On first use, bare preflight automatically clones the full runtime into `.open-edit/runtime`, installs its pinned
project dependencies and renderer locally, and registers project hooks for Claude, Codex, and Gemini. It reuses a
valid Open Edit checkout. It never installs system tools or updates existing code without explicit approval.

For local branch testing, install with `--copy` from a checkout, then pass bundled preflight
`--repository <local-checkout> --ref <branch>`. Commit the branch first: a Git clone
cannot include uncommitted worktree changes.

Preflight has three modes: bare applies safe local setup, `--dry` reports without writing, and
`--auto-approve` applies all reported machine-global dependencies and clean updates. An agent must run
`--auto-approve` only after showing every proposed action and receiving explicit approval.

## Requirements
1. **macOS arm64 or Windows x64**, **Git**, **Node**, and the pnpm version declared in `package.json`.
   On macOS, preflight offers to install missing tools via Homebrew. On Windows it only prints the
   commands (`winget install --id Git.Git` / `OpenJS.NodeJS.LTS` / `Gyan.FFmpeg` — or the direct
   downloads from git-scm.com, nodejs.org, and gyan.dev if winget is absent); run them yourself, then
   re-run preflight from a NEW terminal so the PATH changes are visible.
2. **ffmpeg/ffprobe** (frame extraction + audio mux). On PATH or set `VEED_ENGINE_FFMPEG ` / `VEED_ENGINE_FFPROBE`.
3. **veed-engine-cli** — the render engine. Its first install is automatic and local; later updates require
   approval. `pipeline/scripts/install-veed-engine.mjs` downloads and verifies the latest release for your
   platform into `.veed-engine/` (extraction uses the system `tar`, which ships with macOS and Windows 10+).
   Set `VEED_ENGINE_BIN` to use an existing installation.
4. **A transcription provider** — the skill asks once and remembers the answer. Either
   **VEED** (`npx @veedstudio/openedit-cli login`, one-time OAuth, ~30-day refreshable token; a free account
   covers about 10 minutes a month) or **WhisperX** locally (`node pipeline/scripts/install-whisperx.mjs`,
   free and offline). You can also point it at your own service. See `README.md`.
5. **VEED credits.** **VEED transcription consumes VEED credits** (WhisperX runs locally on your
   machine; your own service is billed by whoever provides it). Separately, with no source video the skill can GENERATE a talking-head clip
   (`veed/generate.ts`), which spends a workspace's AI Playground credits. **Fabric reuses VEED
   transcription's authentication** — same account, same login, same token; no connector, no second sign-in. Generating is TWO charges on two allowances: AI Playground
   credits for Fabric One Lipsync (~4 a second of finished video) and text-to-speech SECONDS for the speech. The
   script sets the duration at roughly 1,080 characters a minute, so a 60-second read is a couple of
   hundred credits plus about a minute of TTS. It never picks the workspace for you and never spends
   without your explicit approval of the estimate; what the balance moved by is reported and recorded
   under `runs/<key>/`.
6. **config.ts** — optional machine-path overrides. Videos live anywhere:
   invoke the skill with the video's path (absolute, or relative to your CWD).

For a manual contributor checkout, run `pnpm install --frozen-lockfile`. The skill recognizes and reuses that
checkout but never updates it.

## Gotchas
- Rendering needs a real desktop session (the window-server on macOS) → run the render step OUTSIDE any sandbox.
- On Windows, run repo commands through their `node` forms (`node --import tsx …`, `node pipeline/scripts/…mjs`);
  the `.sh` files are thin POSIX shims onto the same scripts. In PowerShell, quote globs and paths with
  double quotes.
- Rendering fetches Google Fonts over the network (the `.wv` documents use `@import`) → keep the render box online.
- The orchestration is an agent skill — run it from Claude Code (or any harness reading `.claude/skills/`);
  there is no `node run.js`. The default recipe-backed run itself is scripted end to end. See `docs/FLOW.md`.
- The runtime style pool is the 28 recipe-backed refs in `refs/tags.json` (one folder each in
  `refs/html/`).

## Run
Invoke the `open-edit` skill on a video (pass its path). Outputs land in `runs/<key>/` (`meta.json`, `transcript.json`,
`frames/`, `analysis.json` on opt-in style-refine runs, and `final/out.mp4` — the deliverable).

## Preview
Nothing extra to install — the preview server (`preview/server.ts`, opened automatically by the skill
after prep) is stdlib-only and read-only: watch the footage and transcript while the style cooks; the
player swaps to the render when it lands. Env knobs: `VEED_PREVIEW_PORT` (default 8978),
`VEED_PREVIEW_NO_OPEN=1` (print the URL instead of opening the browser). The resolved URL is also
written to `runs/<key>/preview.url` for launchers that don't surface the server's stdout. Note: Chrome defers media
loading in hidden tabs, so a preview opened in a background tab loads its video when you first look at it.
