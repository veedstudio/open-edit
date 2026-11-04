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

Map a speech-to-text JSON produced by your own service or a fal model into the
same `runs/<key>/transcript.json`: Whisper's segments with word times
(WhisperX, openai-whisper, whisper-timestamped, mlx-whisper), the OpenAI API's
`verbose_json` with word granularity, whisper.cpp `-oj -ml 1`, a timed word
list, fal's whisper and wizper chunks, a voice model's character timestamps, or
the `fal-result.json` that `fal run` keeps a model's answer in:

```sh
npx @veedstudio/openedit-cli whisper transcription.json media.mp4 [...] [--force]
```

Word timestamps are required; the media argument may be a video or an audio
file. Every command that reads a transcript (`review`, `retime-transcript`,
`shots`, `veed-project`, `words`) takes the same formats, mapped in memory, and
prints one line naming the format it read.

### words

Print a transcript as timed lines, one per word with its start and end in
seconds, or one per cue with `--cues`; `--from`/`--to` keep the lines that
overlap that stretch. It reads a `transcript.json` or any format `whisper` maps,
and writes nothing:

```sh
npx @veedstudio/openedit-cli words runs/<key>/transcript.json [--from <sec>] [--to <sec>] [--cues]
```

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

### brief

Record what the user asked of a piece once, in its folder: how long it runs,
where it is posted and their own words. `review` compares the video's length
with it and the numbers on screen with the words, `render` and `apply-edl` print
a line when what they made misses that length, `safe-zone` takes its zone from
the platform, `render` gives that zone to a page that links none, and `reframe`
takes its shape; a value given to the tool itself wins, and the tool says which
it used. A tool finds
`brief.json` from the file it works on, in that file's folder or the nearest
one above it inside the workspace. Each call sets the fields it is given and
keeps the others:

```sh
npx @veedstudio/openedit-cli brief runs/<key> --length 60 --platform tiktok --words "Doors open at 7"
npx @veedstudio/openedit-cli brief runs/<key> --platform "linkedin 1:1"
npx @veedstudio/openedit-cli brief runs/<key>      # prints the brief that applies there
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
npx @veedstudio/openedit-cli render page.html --out out.mp4 --footage clip.mp4  # the clip's rate and length
npx @veedstudio/openedit-cli render page.html --out out.mp4 --from 4 --to 6     # re-render only that stretch
npx @veedstudio/openedit-cli render page.html --out stills --stills 0.5,2,4 --sheet sheet.jpg
```

Segments and a manifest are cached in `<out>.render/`, so `--from`/`--to`
re-renders only the segments it overlaps and rejoins the rest by stream copy;
every frame of the joined file is checked against its time. A page marked
`data-stateless` is checked on one frame before the workers start, and rendered
as an unmarked page, with a line saying why, when the mark does not hold.
The all-intra copies that a page's long-GOP videos are served from are made once
per source, keyed by its content, in the workspace's `runs/.media`, which stills
into any directory, renders and patches share (`render --help` says how much it
keeps).
It fails naming the cause when Chrome does not start or stops answering, the
page throws, or every frame is one flat colour, and a signal stops it with the
Chromes and ffmpegs it started. A video render then looks at what it made, as the
review's blank-frames and dead-air checks do, and prints a line, failing
nothing, for a first frame that is blank, near-black or partway into a fade-in,
and for each still held longer than its words allow; a patch looks only near
the range it re-rendered. `fonts` downloads Google Fonts as local woff2 files
with a `fonts.css`; `install-browser` fetches the pinned Chrome Headless Shell,
which `render` also does on first use. `safe-zone` writes the stylesheet for where
a video will be posted: the stage at its shape's size, and a `[data-safe]`
container on that platform's safe zone as the page's text layer. With no zone
named, it takes the platform in the piece's brief. A zone is the app the user
names (`tiktok`, `reels`, `shorts`, `youtube`, `x`, `linkedin`, `facebook`).
With none named, or several, it is the shape: `9:16`, `1:1` and `4:5` are each clear
of every app's UI listed for them, while `16:9` is YouTube's player, so a 16:9 piece
for a feed names that feed's app (`4:3` has one zone). For Instagram, name where it
goes: `reels` for a 9:16 Reel, the feed shape (`1:1` or `4:5`) or the app with its
shape (`instagram 4:5`), or pass the canvas with `--canvas`; LinkedIn and Facebook
are named or take `--canvas` the same way. Add
`--ad` when a 9:16 video is an ad: ads reserve more of the frame than an ordinary
post's UI takes. Ordinary posts and feeds are kept clear of the UI each app draws
over them, ads of the platforms' published ad safe zones, and 4:3 has television
title-safe sides (`safe-zone --help` says exactly what each zone keeps clear). The
container is a size container, so `cqw` and `cqh` measure the zone for what is
inside it. Its other defaults lose to any rule the page writes: text inside starts
at the shape's minimum (and so do `small`, `sub`, `sup`, `h5`, `h6` and form
controls), a word too long for its line breaks, boxes inside keep within its width
unless they set `max-width: none` (a ticker's track also sets `width:
max-content`), and nothing is clipped:

```sh
npx @veedstudio/openedit-cli fonts "Inter:wght@400;700" Anton --out fonts
npx @veedstudio/openedit-cli safe-zone --out runs/<key>               # the platform in the piece's brief
npx @veedstudio/openedit-cli safe-zone tiktok --out runs/<key>
npx @veedstudio/openedit-cli safe-zone 9:16 --ad --out runs/<key>
npx @veedstudio/openedit-cli safe-zone instagram --canvas 1080x1350 --out runs/<key>
npx @veedstudio/openedit-cli install-browser [--check|--force]
```

### captions

Caption every spoken word of a transcript on the page. `captions` writes
`captions.js` beside the transcript (`--out` names another file): its words and
the code that shows them as cues on the page's clock. The page loads it with a
`<script>` tag and gives it an empty element marked `data-captions` where the
captions go, inside `[data-safe]` when the page has a safe zone. Each cue comes
up with its first word and stays half a second past its last, held until the
next when the gap is under half a second, so the screen clears only in a silence
of a second or more. Cues break where the speech does (a sentence end, a pause,
a clause), speak for at most 7 seconds, and take at most two lines of 42
characters, fitted to the element's width in the page's own font. With
`faces.js` loaded each cue is placed off the faces, inside the safe zone. The
script sets structure and state only, never a look: the cue on screen is a
`[data-cue]` of `[data-line]`s of `[data-word]` spans (punctuation in a
`[data-punct]` of its own), each word's `data-state` is `next`, `now` or `said`,
and `--since`, `--progress`, `--cue-since`, `--cue-until` and `--cue-progress`
give the page's CSS each frame's timing to animate from. `data-lines`,
`data-words` (1 for one word at a time), `data-chars`, `data-at` (where the
transcript's clip starts on the page), `data-from` and `data-to` on the element
change the cues; `captions --help` lists them all. A speech-to-text JSON is read
as `whisper` reads it:

```sh
npx @veedstudio/openedit-cli captions runs/<key>/transcript.json [--out <file>]
```

### mux-audio / mix-audio

Put sound on a render. `mux-audio` lays a track (the source clip, or a built
soundtrack) onto a silent render, levelled to -14 LUFS / -1 dBTP
(`--no-loudnorm` keeps the source level; the line it prints says which
correction ran), starts a clip that `render --footage-at` placed later in the
piece at that same moment, and prints a silent opening or ending longer than a
second in what it wrote. `--music <file>` in place of `--audio` lays a music
file alone, run to the picture's last frame;
`mix-audio` first builds one track from many pieces — narration, music,
effects — per the run's mix spec, with music and effects ducked under the voice,
effects given no gain set under it by measured loudness (give an effect a
gain for a deliberate loud hit), and the music bed run to the end of the film:
looped with a crossfade when its sound ends sooner, faded out at the end.
`--video` takes the mix's length from the render:

```sh
npx @veedstudio/openedit-cli mix-audio runs/<key> --video runs/<key>/out.mp4   # → runs/<key>/audio/mix.m4a
npx @veedstudio/openedit-cli mux-audio --video runs/<key>/out.mp4 --audio runs/<key>/audio/mix.m4a --out runs/<key>/final.mp4
npx @veedstudio/openedit-cli mux-audio --video runs/<key>/out.mp4 --music runs/<key>/assets/music.mp3 --out runs/<key>/final.mp4
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
in the video's folder, or the one `--transcript` names, in any format `whisper`
maps; the review never transcribes, and without a transcript it says what it
skipped. A picture that runs on past the last word with sound under it to the
end is an end card when
new text is on screen through it: text that came up from the pause before the
last spoken phrase on, in an element that showed no other words before then.
It passes unless it is held longer than its words take to read: 0.2 seconds a
word, plus 2 seconds to find the text (3 from ten words) and a one-second beat,
never less than 4 seconds and never more than 4.5. So a card brought up with
the spoken call to action counts, while a caption left on into the music, a
title up since earlier or a watermark does not. A run-on with more than a
second of no end card is reported as background left running; without the
record of on-screen text (below) it is reported, and the report says the end
card could not be judged. The dead-air check reports a stretch with nothing
happening anywhere in the video. In the picture, that is a still, frozen or
nearly so (a slow zoom or a drift over a held card), held longer than a still
may hold, end cards included: as long as an end card of as many words when it
has words on screen, 3 seconds when it has none. Footage that moves almost
everywhere, such as a slow pan, is not still. A talking head can measure as
still as a held card, so a nearly still picture passes while a voice talks over
it without pausing more than 2 seconds; without a transcript it is reported,
and the report says the voice could not be checked. A frozen picture is
reported whoever speaks over it. In the sound, it is a first sound more than a
second after the first frame, and more than 2 seconds of silence between two
sounds; a silence after the last sound is the dead-tail check's to report, so
no silence is reported twice. The length check reports a picture that runs longer
or shorter than the length asked for, in seconds (`--length`, else the length in
the piece's brief), by more than a second or 5% of that length, whichever is
more; without either it is skipped. The
canvas check reports a picture nearly one of the platform shapes (9:16, 1:1, 4:5,
16:9) but not exactly it, such as a 606x1080 crop of 1080p footage, and one under
1080 px on its short side; a picture of another shape is judged on its short
side alone.

The text, captions, numbers and graphics checks read the record of on-screen text that `render`
writes beside each video, `<video>.text.json`: the text the page draws in its
HTML and SVG (not text inside an image, a canvas or the footage), read about
every 100 ms of the page's time, with its words, its box and font size in the
video's pixels, its colour, its opacity and how opaque the backgrounds painted
under it are, and each `<video>` the page shows, with its clip, the second of
it on screen and where its picture lies. `mux-audio` carries the record to
the file it writes, and a patch with `--from/--to` keeps it whole. The text
check reports text smaller than a phone's body text, measured against the
frame's shorter side, and text under WCAG's 3:1 contrast for large text against
what is really behind it, measured on the video's pixels around the glyphs, so a
backing, a stroke or a shadow counts; it skips the contrast of a transparent
render, and of text that is translucent or has no solid fill of its own. The
captions check reports a second or more of speech with no caption on screen. A
caption is a text in the page's caption track (an element marked
`data-captions`, which `captions.js` fills), a text that shows the words being
spoken, or, in another language than the voice, one of a run of texts in one
place that change with the spoken phrases; a title is not one. It is skipped when the page captions too little of
the speech to be captioning it, or there is no transcript. The numbers check
reports a number on screen that neither the transcript nor the user's own words
say, with where and when it shows: a time, a price, a percentage or an amount
worked out or guessed while the video was made, such as "Ready in 15 min" over
narration of "about 10 minutes". Numbers are compared by value, in digits or in
English words, so "15 min", "fifteen minutes" and "0:15" agree, as do "$5" and
"five dollars", "50%" and "half", "2018" and "twenty eighteen", and a rounding
such as "1.4M" for 1,423,000; a range or a score is two numbers. A list's own
numbering ("01", "Tip 2") and the count of its items, a clock or a count running
in one place, a number up for under a quarter of a second, and digits in a name
("MP4"), an address or a handle are set aside. The user's words come from
`--brief`, their message itself or a file holding it, repeatable, else from the
words in the piece's brief (`brief --words`); without either the numbers are
compared with the transcript only, without a transcript with the user's words
only, and with neither the check is skipped. It cannot see the
footage, so a number read off the picture (a scoreboard, a page in shot) is
reported too. The graphics check reports text drawn over a graphic burned into
the footage while it is up: the record names the clip `--footage` laid under the
page, and each `<video>` the page plays with the second of its clip on screen
and where its picture lies. It reads the graphics `faces` found on a clip, or
looks for them itself when `faces` has not run on it, and counts a text only
where the video still shows the clip's picture around it, so text on a card or
band that covers the graphic passes. A video without a record, or with one for a
picture of another size or length or older than the video, skips all four:

```sh
npx @veedstudio/openedit-cli review runs/<key>/final.mp4 [--transcript <transcript.json>] [--length <sec>] [--brief <text|file>]
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
stops and pauses; assemble the kept ranges of an EDL (edit decision list) with
crossfaded joins, each range snapped to the frame grid and optionally at its own
speed (slow motion by repeated or interpolated frames, sound time-stretched or
silenced) and grade (exposure, contrast, saturation, temperature, a LUT, grain),
moving the per-word timings, the face boxes and the burned-in graphics the
sources already have onto the cut instead of finding them again. Each range's picture is kept in `<cut>.ranges/` under
a name made of its source's content and everything applied to it, so a second run
that changes one range encodes only that range. A path in the EDL is read beside
it, else from the working directory or the workspace when the file is there.
After the cut, `apply-edl` prints each range whose picture runs on past its last
sound, and each stretch held still with nothing heard, measured on the cut, and
a line when the cut misses the length in the piece's brief.
`--gap` and `--crossfade` are milliseconds; the EDL is seconds.

```sh
npx @veedstudio/openedit-cli speech-probe <video> [--range a:b] [--gap 250] [--window 10] [--json]
npx @veedstudio/openedit-cli apply-edl --edl edl.json --out cut.mp4 [--crossfade 40] [--crf 20] [--fit crop|letterbox]
npx @veedstudio/openedit-cli retime-transcript --edl edl.json --out <transcript.json>
```

Both joins put every clip on one canvas, sized as the clips are shown (a phone
clip stored sideways counts as upright). A clip of another shape is cut to the
canvas's shape with `reframe`'s own code, around its faces when `faces` has run
on it and from the middle otherwise, and a line says which; `--fit letterbox`
keeps it whole and pads it instead. `render --footage` refuses footage of
another shape than the stage and names the `reframe` command that cuts it.

The retimed transcript goes where a transcription of the cut would land,
`runs/<key>/transcript.json` under the workspace, so the transcription routes
refuse to overwrite it and the cut is never transcribed. `retime-transcript`
writes the same transcript from an EDL alone, to any path.

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
MediaPipe's full-range BlazeFace model finds the faces on CPU. The same
sampled frames, small and grey, show the graphics burned into the footage (a
lower third, a score bar, old subtitles, a logo), without OCR or a model: sharp
edges, mostly square to the frame, that hold their value while most of the frame
changes around them, at a cut or as the camera moves (a step in the camera's
exposure is no change), or that come up over, or give way to, other steady
content in a still shot, each with the seconds it is up. `faces.json`
holds the boxes per sampled frame of each shot and the graphics; `faces.js` holds them too, with
`openeditFaces.place(el, from, to)`, which moves a laid-out element the least
distance that clears every face on screen, and every graphic up, between those seconds of the clip.
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
or a split it jumps. Without them it cuts the clip from the middle. The crop is
scaled (lanczos) to 1080 px on its short side, the platforms' canvas for their
shapes: 1080x1920 for 9:16, 1080x1080 for 1:1, 1080x1350 for 4:5, 1920x1080 for
16:9. `--size` names another size of the shape, such as 2160x3840 for 4K, and
`--size native` keeps the crop in the source's own pixels. It always re-encodes:
upright, in square pixels, H.264, a clip already in that shape included and
scaled the same way. With the clip's boxes it also writes the output's own, in
the output's folder where `faces` would write them, each box and burned-in
graphic moved and scaled with the crop and cut where the crop cuts it, so
`faces` need not run on the clip it made.

```sh
npx @veedstudio/openedit-cli reframe video.mp4 --aspect 9:16 --out tall.mp4 [--faces <faces.json>] [--size WxH|native]
npx @veedstudio/openedit-cli reframe video.mp4 --out runs/<key>/tall.mp4   # the shape of the platform in the piece's brief
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
| `OPENEDIT_CHROME` | The Chrome or Chromium `render`, `behind` and `veed-project` drive when `render --chrome` is not given (default: the pinned Chrome Headless Shell; an empty value counts as unset). |
| `WHISPERX_BIN` / `WHISPERX_MODEL` | WhisperX binary and fallback model tier (defaults: `whisperx` on `PATH`, `small.en`). |
| `OPEN_EDIT_WHISPERX_DEVICE` / `OPEN_EDIT_WHISPERX_COMPUTE` | WhisperX device/compute (defaults: `cpu`/`int8`). |
| `OPEN_EDIT_MEDIAPIPE_PYTHON` | The Python version `install-mediapipe` asks uv for (default: `3.12`; the pinned packages need 3.12 or newer). |

Login state lives in the platform's per-user app-data directory:
`~/Library/Application Support/veed-openedit` on macOS, `%APPDATA%\veed-openedit`
on Windows, and `$XDG_CONFIG_HOME/veed-openedit` (default `~/.config/veed-openedit`)
on Linux.

## License

Apache-2.0. See the bundled `LICENSE` and `NOTICE` files.
