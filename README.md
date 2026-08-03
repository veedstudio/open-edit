# OpenEdit (Beta)

OpenEdit is an open-source, agent-driven editing pipeline that ships with VEED's HTML renderer — closed
source, but free to use.

There is no GUI and no timeline. The pipeline is driven entirely through your coding agent: it
transcribes the audio, designs a caption style for the footage, and renders the clip.

OpenEdit edits footage; it does not generate it. Supply your own source files.

## Requirements

| | |
| --- | --- |
| Platform | Apple Silicon Mac, macOS Tahoe 26.0 |
| Intel Macs, earlier macOS | Not supported |
| Windows, Linux | Planned; prioritisation depends on demand |
| Account | veed.io account for transcription — [sign up](https://www.veed.io/signup) or [login](https://www.veed.io/login) |

## Installation
Download this repo, or install via the command line with:
```sh
npx skills add veedstudio/open-edit
```

## Agents
OpenEdit uses an agent-agnostic skill and repository guide. It supports Claude Code, Codex, and Gemini;
the installed skill prepares the runtime and loads its `AGENTS.md` instructions explicitly.

## Usage
Open your coding agent. For example, with Claude Code:
```sh
claude
```

then ask it:
```
Add subtitles to my video [VIDEO]
```

The agent will automatically transcribe your video, analyse the transcript, create a suitable design for your video, and then render it.

After 1-3 minutes, the agent will return your video with subtitles burned in, as well as launch a video previewer. It will also tell you where to find the final MP4.

You can then ask the agent for subtitle amendments, for example:

```
I don't like the yellow colour, make it darker

Move the text up a bit

When he says "go buy it now", make sure the 'now' really stands out.
```

## Prompts
You can provide more specific or tailored prompts, for example:
```
Add subtitles to my video [VIDEO], avoid placing subtitles on the lower third

Add subtitles to my video [VIDEO], make them really engaging and dynamic

Add subtitles to my video [VIDEO], clean chill vibe

Add subtitles to my video [VIDEO], ensure that the hook really catches the eye and that my call to action hits the mark

Add subtitles that look like this [IMG-REF], to my video [VIDEO]
```

## Renderer

Caption styles are authored in HTML and CSS. Rendering does not use a headless browser: there is no
browser to install, launch, or keep alive for the duration of a render.

Internal benchmarks measured the renderer up to 2.2x faster than Chrome-driven renderers. These
measurements are preliminary and not yet reproducible outside VEED; a documented benchmark and its
methodology will follow.

The renderer is integrated but not required. Composition does not depend on it, so Chrome can be used
as the render backend instead.

## Transcription

The default workflow provides access to VEED's transcription and requires a VEED account. Usage limits
are those of your VEED account. The audio track is uploaded and stored in order to transcribe it; the
video is not uploaded.

By default OpenEdit does not create a VEED project. The agent guides the one-time browser login and
stores a refreshable token at `veed/.veed-token.json` inside the runtime.

For manual use:

```sh
node --import tsx veed/login.ts
node --import tsx veed/go.ts /path/to/video.mp4
```

## Scope and limitations

V1 targets captions. Motion graphics, charts, and brandbook-matched styling render today, but are less
exercised than captions and should be expected to have rough edges.

Report defects through GitHub issues.

## License

The editor is licensed under Apache-2.0. The renderer binaries are distributed under PolyForm Shield
1.0.0, which permits commercial use of the videos you produce with no payment to VEED. See `LICENSE`
and `NOTICE` for the full terms.
