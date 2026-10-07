---
name: open-edit
description: Video work with VEED's hosted services and a CLI toolkit — word-timed transcription, cutting, background removal, AI presenters, lipsync, any fal model, sound mixing, and a Chrome renderer for HTML compositions that re-renders only what changed. Captions, edits, motion graphics, or pieces with no footage at all; hands a finished piece to VEED's editor as an editable project, and takes projects back from it. Use when the user wants video made, edited, or captioned by an agent.
---

# open-edit

You author the piece yourself, as an HTML page, and render it with `render`. OpenEdit supplies what a
bare shell does not: VEED's hosted services on one login, measured tools for cutting and sound, and a
renderer that re-renders only the stretch you changed. `openedit` below is short for
`npx @veedstudio/openedit-cli`; every command explains its flags with `--help`.

## Setup

Once per workspace, before the first command. WORKSPACE is the current project root, or the current
directory outside a project.
```
npx --yes @veedstudio/openedit-cli init --dry --workspace "$WORKSPACE"
npx --yes @veedstudio/openedit-cli init --workspace "$WORKSPACE"
```
Read the final `preflight:` line, not the exit code: `ready — OPEN_EDIT_ROOT=…` means go, and `runs/`
and the recorded preferences live under that root. If init prints `APPROVAL REQUIRED`, tell the user
every exact action and wait for an explicit yes, then run it again with `--auto-approve`. When the final
line says the user runs the install commands, `--auto-approve` cannot run them: give the user those
commands and run init again once they are done. Never install anything machine-global without that
yes, and never infer it from the render request. When a command prints `update available`, tell the user
once; run the `init --update` command it names only after they say yes, and if they decline, carry on
without asking again.

## One folder per piece

Keep everything a piece is made of under `runs/<key>/`: the page, its assets, renders, audio. The code
is the edit: that folder is how the user comes back later to change one scene or reuse the piece for
another video, so nothing it needs lives anywhere else.

## Tools

| Need | Command |
| --- | --- |
| A transcript with real per-word times | `transcribe <video> [...]` runs the provider recorded in `$OPEN_EDIT_ROOT/.open-edit-prefs.json`. None recorded (the command refuses and says so), "No VEED login found", or a failed run: read `TRANSCRIPTION.md` first |
| Remove, reorder or join takes | read `CUT.md` (`speech-probe`, `apply-edl`, `retime-transcript`) |
| Join whole clips whose shapes disagree | `concat-videos` (re-encodes to one canvas at 30 fps) |
| Look at a video, a page or a pile of images | `frames <video> --at <sec,...> --sheet` (one sheet of those moments; `--images` for a folder of references), `render --stills` |
| Cut the subject out of its background | `background-removal` (the free VEED route; when it cannot run, the command stops with fal's price, and only `--fal` buys) |
| A presenter speaking a script | Fabric: read `FABRIC.md` first |
| New audio on a face | `lipsync` |
| Any fal model: images, video, music, voice, effects | `fal schema <model>`, then `fal run <model> --input <json or @file> --run runs/<key>` (`--batch <jobs.json>` for many); local files in the input are uploaded for you |
| Web fonts as local files | `fonts <Family> [...] --out <dir>` |
| Real, licensed pictures | `stills search`, `stills show`, `stills save` |
| One soundtrack from several pieces | `mix-audio runs/<key>` (voice tracks duck the bed; `mix-audio --help` has the spec) |
| Sound on a render, at delivery loudness | `mux-audio --video <render> --audio <source clip or built track> --out <file>` |
| The piece in VEED's editor for the user to change, or a project they bring from it | read `VEED.md` (`veed-project`, `veed-pull`) |

Fabric, background removal, lipsync and `veed-project` reuse the VEED transcription login: same veed.io
account, same stored token, no second sign-in. The editor hand-off's bookmarks run in the user's own VEED
session in the browser. `background-removal --fal` needs no VEED login at all.

## Render

```
openedit render runs/<key>/index.html --out runs/<key>/out.mp4 --fps <fps> --duration <seconds>
```
The canvas is the page's `#stage` (or `[data-stage]`) element, captured at its own size, else
1920x1080. `--width`/`--height` instead capture that much of the page from its top-left corner and
ignore the stage. With footage, the canvas and frame rate are the source's own, and `frames` prints
both. Pass its `frameRate` (such as `30000/1001`) to `--fps`, never the decimal beside it.
- The renderer owns time. It drives a virtual clock (`performance.now`, `Date.now`,
  `requestAnimationFrame`, timers, a seeded `Math.random`), sets every CSS and Web Animations
  animation to the frame's time and seeks GSAP's global timeline. Anything else that moves with time
  goes in `window.__seek(t)` (it may be async).
- It waits for fonts, images and videos before the first frame, and shows each `<video>` at the exact
  frame. Keep fonts and assets as files beside the page.
- `--from <s> --to <s>` re-renders only that stretch and reuses the rest. After a change, re-render what
  changed, not the piece.
- `--stills 0.5,2,4 --sheet <file>` shows moments without a full render. `--transparent` gives alpha.
- It fails loudly on a page error, a blank render or a Chrome that did not start; read the reason it
  prints. A load it lists as failed (a video, an image, a font) is a wrong render: fix it and re-render
  before delivering.
- The output is silent: `mux-audio` lays the sound on (build a many-piece track first with `mix-audio`).

## No footage

If the user attached no video, read the ask before assuming one is needed:
- A clip is coming: wait for it.
- A talking head from a script: Fabric, per `FABRIC.md`.
- A clip from another model (anything on fal, their key and their bill): say in the same breath that
  captions are transcribed from the clip's speech, and most generators return silent clips.
- No video at all: build from stills, graphics, generated imagery and audio. That is a whole run.

If it is unclear which, ask.

## Money

- VEED transcription consumes the VEED transcription credits of one workspace. On an account with
  several, the CLI will not pick: name the one the user chose with `--workspace`.
- Fabric consumes the AI Playground credits of the workspace chosen for it; `FABRIC.md` has its three stops.
- Every fal call (`fal run`, `lipsync`, `background-removal --fal` or `--fast`) bills the user's own fal
  account.
  Before the first paid call, say in one line what you will make and what it costs, and let them
  answer. Background removal's default route is free.
- Report what was spent, and on which account, when you deliver.

## Talking to the user

One line when you start, then the deliverable's path and a sentence or two on the result. No
step-by-step progress and no internals: run keys, command names, raw tool output. Pass on in plain
terms a warning about the result, such as words transcribed without timings. If you must stop, say in
plain terms what is wrong on screen and what the options are.
