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
1. **macOS arm64**, **Git**, **Node**, and the pnpm version declared in `package.json`.
2. **jpeg-turbo** — `brew install jpeg-turbo`. It supplies `libjpeg.8.dylib`, which the renderer loads at launch.
3. **ffmpeg/ffprobe** (frame extraction + audio mux). On PATH or set `VEED_ENGINE_FFMPEG ` / `VEED_ENGINE_FFPROBE`.
4. **veed-engine-cli** — the render engine. Its first install is automatic and local; later updates require
   approval. `pipeline/scripts/install-veed-engine.sh` downloads and verifies the latest macOS-arm64 release into `.veed-engine/`.
   Set `VEED_ENGINE_BIN` to use an existing installation.
5. **A transcription provider** — the skill asks once and remembers the answer. Either
   **VEED** (`node --import tsx veed/login.ts`, one-time OAuth, ~30-day refreshable token; a free account
   covers about 2 minutes a month) or **WhisperX** locally (`bash pipeline/scripts/install-whisperx.sh`,
   free and offline). You can also point it at your own service. See `README.md`.
6. **config.ts** — optional machine-path overrides. Videos live anywhere:
   invoke the skill with the video's path (absolute, or relative to your CWD).

For a manual contributor checkout, run `pnpm install --frozen-lockfile`. The skill recognizes and reuses that
checkout but never updates it.

## Gotchas
- Rendering needs the macOS window-server → run the render step OUTSIDE any sandbox.
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
`VEED_PREVIEW_NO_OPEN=1` (print the URL instead of opening the browser). Note: Chrome defers media
loading in hidden tabs, so a preview opened in a background tab loads its video when you first look at it.
