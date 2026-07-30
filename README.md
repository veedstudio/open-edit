# OpenEdit
Not the editor you rent, the one you own.

## Installation
Download this repo, or install via the command line with:
```sh
npx skills add veedstudio/open-edit
```

## Agents
OpenEdit uses an agent-agnostic skill and repository guide. It supports Claude Code, Codex, and Gemini;
the installed skill prepares the runtime and loads its `AGENTS.md` instructions explicitly.

## Requirements

Requires an Apple Silicon Mac, running macOS Tahoe 26.0. Windows and Linux versions are coming soon.

Requires a free veed.io account for transcription, [sign up](https://www.veed.io/signup) or [login](https://www.veed.io/login).

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

## Transcription

OpenEdit uploads the source video to VEED and uses your workspace for transcription billing. By default, it
does not create a VEED project. The agent guides the one-time browser login and stores a refreshable token
locally at `veed/.veed-token.json` inside the runtime.

For manual use:

```sh
node --import tsx veed/login.ts
node --import tsx veed/go.ts /path/to/video.mp4
```

Transcription always consumes workspace credits.
