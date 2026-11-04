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
another video, so nothing it needs lives anywhere else. When the user states a length, where the piece is
posted or wording for it, run `openedit brief runs/<key>` with `--length <sec>`, `--platform <zone>` (the
app they name, or the shape when they name none or several) or `--words "<their words>"`.

## The footage's look

HDR footage (HLG or PQ, as phones record it) is converted to SDR on the way in, keeping its look and
rolling its highlights off: `apply-edl`, `render`, `frames` and `concat-videos` convert it where they read
it, `background-removal`, `lipsync` and `veed-project` send a converted copy, and each prints a line when it
does. Keep the source's look: no tone-map, grade or colour correction of your own unless the user asks for
one, and then grade in `apply-edl` (`CUT.md`). When HDR was converted, tell the user in one plain sentence.

## Tools

| Need | Command |
| --- | --- |
| A transcript with real per-word times | `transcribe <video> [...]` runs the provider recorded in `$OPEN_EDIT_ROOT/.open-edit-prefs.json`. None recorded (the command refuses and says so), "No VEED login found", or a failed run: read `TRANSCRIPTION.md` first |
| A transcript as timed lines | `words <transcript>`: a line per word with its start and end (`--cues` a line per cue, `--from`/`--to` in seconds), from a `transcript.json` or a speech-to-text JSON as it came |
| Remove, reorder or join takes; slow motion, a speed change or a grade on footage | read `CUT.md` (`speech-probe`, `apply-edl`) |
| Join whole clips | `concat-videos --canvas WxH <out> <in...>` re-encodes them to one canvas at 30 fps (without `--canvas`, the largest clip as shown, the first of equals) and cuts each clip of another shape to it as `reframe` does: around its faces when `faces` has run on that clip, else from the middle, and a line per clip says which. `--fit letterbox` keeps each clip whole and pads it instead |
| Look at a video, a page or a pile of images | `frames <video> --at <sec,...> --sheet` (one sheet of those moments; `--images` for a folder of references), `render --stills` |
| Make it like a reference video | `shots <reference>`: every shot's start and length, what is said in it, its shot size, and storyboard sheets of a few labelled frames of every shot (its first, middle and last, or the middle of a shot under a second; a reference with too many shots for three frames each on four sheets shows every shot's middle alone). Look at the sheets with the list before planning from it. Its speech is the reference's transcript, so transcribe the reference first if it talks; on VEED that spends transcription credits on a video that is not the deliverable, so ask before. It finds hard cuts and fades through black: a dissolve reads as one longer shot, and so does about one jump cut in three. Effects that flicker can read as extra cuts; `--threshold 0.2` drops those, and most jump cuts with them. Each shot's size (close-up, medium, wide or no face) comes from the boxes `faces` wrote for the reference, so run that first; a face the frame cuts through, in shadow or very small often reads as no face, one in profile now and then a size off, and a title or an effect now and then as a face; a letterboxed reference is measured inside its black bars, where a wide shot can read medium, unless a full-frame title or text in the bars keeps them in, and then every size reads wider. So check the sizes the plan leans on against the sheets. On-screen text is not read; the sheets (paths printed, and in the JSON) show it at those frames |
| Where the faces and burned-in graphics are, shot by shot | `faces <video>` writes `faces.json` and `faces.js` to `runs/<key>/faces-<hash>/`, a folder of that clip's own, and prints the path; load the `faces.js` it printed. It runs MediaPipe, which `install-mediapipe` puts in once (several hundred MB: ask the user first) |
| Captions of the speech | `captions runs/<key>/transcript.json` writes `captions.js` beside the transcript (run it again when the transcript changes). Load it with a `<script>` tag and give the page an empty `<div data-captions>` where the captions go (inside `<div data-safe>` when the page has a safe zone): it shows every spoken word on the page's clock, in cues broken where the speech breaks and fitted to that element's width in the page's font, and places each cue off the faces when `faces.js` is loaded. The look is the page's: style and animate the cues from the state and timing `captions --help` lists; one word at a time, one line, and footage that starts later on the page are attributes of that element |
| How much of a graphic laid behind the speaker stays visible | `behind <page>` (see Faces) |
| A clip's delivery shape or size, e.g. 16:9 to 9:16 | `reframe <video> --out runs/<key>/<file>` (the shape of the brief's platform; `--aspect W:H` for another), and only `reframe`: never raw ffmpeg or a hand-made crop (`concat-videos` and `apply-edl` cut a clip of another shape with reframe's own code; `render --footage` refuses one and names the `reframe` command). With `faces` run on the clip first, each shot, which can be split again where a face seen alone for four samples jumps further than its own width and is seen alone there for four more (a dissolve or a cut the cut detection missed), is followed when it shows one face and held still where the most face is when it shows more; without, it is cut from the middle. It outputs the platform canvas, 1080 px on the short side (1080x1920 for 9:16, 1080x1080 for 1:1, 1080x1350 for 4:5, 1920x1080 for 16:9): the crop, or a clip already in the shape, is scaled to it; `--size 2160x3840` when the user asks for 4K |
| Cut the subject out of its background | `background-removal` (the free VEED route; when it cannot run, the command stops with fal's price, and only `--fal` buys) |
| A presenter speaking a script | Fabric: read `FABRIC.md` first |
| New audio on a face | `lipsync` |
| Any fal model: images, video, music, voice, effects | `fal schema <model>`, then `fal run <model> --input <json or @file> --run runs/<key>` (`--batch <jobs.json>` for many); local files in the input are uploaded for you |
| Web fonts as local files | `fonts <Family> [...] --out <dir>` |
| Real, licensed pictures | `stills search`, `stills show`, `stills save` |
| One soundtrack from several pieces | `mix-audio runs/<key>` (`--video <render>` gives it the render's length; voice tracks duck music and effects, an effect given no `gainDb` is set under the voice, and the music bed runs to the last frame; give an effect a `gainDb` for a deliberate loud hit; `mix-audio --help` has the spec) |
| Sound on a render, at delivery loudness | `mux-audio --video <render> --audio <source clip or built track> --out <file>`, or `--music <file>` in place of `--audio` for a music file alone, run to the last frame |
| The piece in VEED's editor for the user to change, or a project they bring from it | read `VEED.md` (`veed-project`, `veed-pull`) |

Fabric, background removal, lipsync and `veed-project` reuse the VEED transcription login: same veed.io
account, same stored token, no second sign-in. The editor hand-off's bookmarks run in the user's own VEED
session in the browser. `background-removal --fal` needs no VEED login at all.

## Faces

Never draw over a face unless the user asks for it (a face blur, a sticker): captions and small text go
outside the face boxes. On footage with people in it, or text burned into it, load the `faces.js` of the clip the
page shows with a `<script>` tag (the one `apply-edl` or `reframe` printed when it cut that clip, else run `faces`
on the clip), and call `openeditFaces.place(el, from, to)` for each small text element drawn over the footage
(`captions.js` places its own cues), once it is laid out (in `__seek` when its text changes). `from` and `to` are
seconds of the clip, not of the page: page time, less the time the clip starts at on the page, plus the point in
the clip it starts playing from when it is trimmed. It moves the element the least distance, inside its
`[data-safe]` container, else the stage's safe zone, that clears every face on screen over that span, and every
graphic burned into the footage that is up in it (a lower third, a score bar, old subtitles, a logo), which
`faces` finds in the same run. `clear: false` comes with a console warning that says why: no place inside those
bounds (or `within`) clears the faces and graphics for that whole span, so make the element smaller or shorten
its span; or an animation or `!important` rule owns the element's translate, so move it in the page or place a
wrapper; or a transform on the element or an ancestor (a rotation, say) turned the move, so place it without that
transform. If `install-mediapipe` fails, read what it printed: when it names a way out (install uv, another
`OPEN_EDIT_MEDIAPIPE_PYTHON`, an arm64 Node), offer that to the user. Only on an Intel Mac, where MediaPipe
1.1.1 has no build, can faces not be found on this machine at all; say so. When the user declines MediaPipe
or it cannot be installed, check the placement by eye on `frames --sheet` at the moments the text is on
screen.

A large graphic that would cover a face (a title, a plate, a big shape) is moved the same way, or put behind the
speaker, who then covers part of it while nothing covers the face. Cut the speaker out with `background-removal`
(its default route is free, on the VEED login transcription uses) from the clip as the page plays it, trimmed
first when the page starts it partway; it writes `speaker.js` beside the cut-out. Name the cut-out on the stage
(`<div id="stage" data-cutout="cutout.webm">`) and fill three layers, each a child of the stage:
`<div data-layer="footage">` with the footage filling it cover-fit, `<div data-layer="behind">` with the graphics behind the speaker,
each marked `data-behind="<name>"`, and `<div data-layer="front">` with the captions and small text (small text placed
with `place()`). Load `speaker.js` with a `<script>` tag. The CLI fills the stage with each layer and stacks them in
that order whatever their contents' z-index, and draws the cut-out in a layer of its own between behind and
front, on the page's clock from time 0, in every render and in a browser preview; under `render --footage` it
shows from `--footage-at` and only while the footage does. Style freely inside the
layers; the layers themselves are the CLI's, except that a transform on the footage layer (a punch-in) moves the
speaker with it. The cut-out is laid cover-fit over the whole stage, so footage letterboxed, placed in part of the
stage or transformed on its own `<video>` leaves the speaker out of register with it: transform the footage layer
instead. Then run `behind <page>` with the render's `--fps`, `--duration` and `--footage-at`: for each graphic it
reports how much of it stays visible over the frames it is on (the worst frame and the mean) and its least
visible word, measured on what Chrome draws. Keep a graphic behind the speaker only when it passes, with at
least 75% of it and of each of its words visible on every frame; otherwise move, shift or shrink it and check
again.

## Render

```
openedit render runs/<key>/index.html --out runs/<key>/out.mp4 --fps <fps> --duration <seconds>
```
The canvas is the page's `#stage` (or `[data-stage]`) element, captured at its own size, else
1920x1080. `--width`/`--height` instead capture that much of the page from its top-left corner and
ignore the stage. With footage, the canvas and frame rate are the source's own, and `frames` prints
both. Under `--footage`, `--fps` defaults to the clip's own and `--duration` runs to its last frame; a page
that plays its footage in a `<video>` takes the `frameRate` `frames` prints (such as `30000/1001`) as `--fps`.
- All text goes inside `<div data-safe>`, the text layer on the platform's safe zone, placed by layout (its
  place in the flow, top, left, margins), with transform and
  opacity left to animate entrances and exits freely, never to park text where it rests; footage and
  full-bleed pictures go on `#stage`. A page that links no zone of its own is given one of its stage's shape:
  the brief's platform's, else the shape's own (`9:16`, `1:1` and `4:5` are each clear of every app
  `safe-zone --help` lists for them, `16:9` is YouTube's player). Text under the size floor is drawn at the
  floor. A 9:16 ad links the ad zone instead: `safe-zone --ad --out runs/<key>` (`--canvas` for footage's own
  size) writes it, `safe-zone.css`.
- The renderer owns time. It drives a virtual clock (`performance.now`, `Date.now`,
  `requestAnimationFrame`, timers, a seeded `Math.random`), sets every CSS and Web Animations
  animation to the frame's time and seeks GSAP's global timeline. Anything else that moves with time
  goes in `window.__seek(t)` (it may be async).
- It waits for fonts, images and videos before the first frame, and shows each `<video>` at the exact
  frame. Keep fonts and assets as files beside the page.
- If the page draws frame t from t alone (CSS/Web Animations running from load, GSAP, a `__seek(t)` that
  places everything from t), mark the stage `data-stateless`: workers and stills then jump straight to their
  frames instead of stepping through every earlier one (with a `<video>` on the page, that stepping is where
  most of a multi-worker render's time goes). render checks the mark on one frame first: where that frame
  comes out otherwise when stepped to (a counter, a transition `__seek` starts), the page renders as an
  unmarked one, with a line saying so.
- Footage that fills the stage, with captions or graphics over it: pass the clip as `--footage <file>` as
  well. ffmpeg lays the page over it, and the page's `<video>` of that file is stood down (keep it, so the
  page previews in a browser), so Chrome never decodes or seeks the footage and the render is many times
  faster. The page must not paint an opaque background over the footage: no opaque `background` on
  `html`, `body` or the stage. `--footage-at <s>` starts the clip later in the piece, and it may end before
  the piece does: a title card before it and an end card after it are the page's, drawn in the same render,
  and `mux-audio --audio <that clip>` lays its sound from the same moment. Footage the page moves, crops or
  transforms stays a `<video>` and renders without `--footage`: framing a clip inside a layout (split
  screen, picture in picture) is design on the page, while changing the clip's own shape for delivery is
  `reframe`'s.
  `--footage` must have the stage's shape as shown: footage of another shape is refused with the `reframe`
  command that cuts it. Make that cut the page's footage, so the preview, `faces.js` and the render show the
  same picture.
- `--from <s> --to <s>` re-renders only that stretch and reuses the rest. After a change, re-render what
  changed, not the piece.
- `--stills 0.5,2,4 --sheet <file>` shows moments without a full render. `--transparent` gives alpha.
- To check motion and timing while the piece is still changing, render a draft: `--draft --out
  runs/<key>/out.draft.mp4`. It draws the frames at half size with a cheap capture and encode, a quarter
  of the pixels to draw, and keeps its own cache, so the full render beside it is untouched.
  Patch it with `--from/--to` like any render. A draft is never the deliverable: render once without
  `--draft` when the piece is settled. Each of its settings can be given alone (`--scale`, `--capture`,
  `--quality`, `--preset`, `--crf`), with or without `--draft`.
- When a render is slow and the output is opaque, `--capture jpeg` cuts the capture cost, about half
  the capture time on a frame full of gradients, shadows and large text. The loss is small (the colour
  is kept at half resolution before encoding) but it is a loss: say so to the user when a deliverable
  was rendered with it. Not with `--transparent`, `--footage` or `--stills`.
- It fails loudly on a page error, a blank render or a Chrome that did not start or stopped answering;
  read the reason it prints. A load it lists as failed (a video, an image, a font) is a wrong render: fix it
  and re-render before delivering. After a video it also prints, without failing, a first frame that makes
  a poor cover and a still held longer than its words allow.
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

## Before delivering

Run `openedit review <video>` on a video you are about to deliver; an image or a sound file skips this
step. It runs every delivery check and prints one report; it changes nothing. A finding is yours to judge,
not an order to re-render: tell the user about one you leave in place. Checks that compare against speech
read the `transcript.json` in the video's folder, or the one `--transcript` names, in any format `whisper`
maps; name one when the folder's is not on the video's timeline (for a cut, the retimed one). Without a
transcript, the report says what it skipped. The checks of on-screen text (its size, its contrast, captions
missing under speech, numbers no one said, text over graphics burned into the footage, and whether a picture
running on past the last word is an end card) read the record `render` writes beside the video,
`<video>.text.json`, which `mux-audio` carries to the file it writes; without a record that matches the video,
the report says they were skipped.

## Talking to the user

One line when you start, then the deliverable's path and a sentence or two on the result. No
step-by-step progress and no internals: run keys, command names, raw tool output. Pass on in plain
terms a warning about the result, such as words transcribed without timings. If you must stop, say in
plain terms what is wrong on screen and what the options are.
