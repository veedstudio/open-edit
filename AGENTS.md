# AGENTS.md

A map for changing this repo. Making a video is the `open-edit` skill's job:
`.claude/skills/open-edit/SKILL.md` is the whole runtime contract, and nothing here is needed to run it.

## Layout
- `.claude/skills/open-edit/`: the product skill. `SKILL.md` is the default load (setup, tools, the
  render contract, money, voice); `TRANSCRIPTION.md`, `CUT.md`, `FABRIC.md` and `VEED.md` load only when
  their situation arises.
- `cli/`: the `@veedstudio/openedit-cli` package, every command. `cli/src/cli.ts` registers them;
  `cli/src/config.ts` resolves the machine paths (ffmpeg, ffprobe, WhisperX) and the workspace the CLI
  writes (`runs/`, the recorded provider): `OPEN_EDIT_ROOT`, else the nearest project above the working
  directory. `init` installs the skill from the package's own tree.
- `cli/src/veed/`: the VEED client. Transcription, login, Fabric generation, background removal and the
  editor hand-off (`editor-project.ts`: a plan as editor items, and a project read back as a plan) share
  one login and one stored token. Background removal's default route is free. Its `--fast` mode and
  `lipsync` use the VEED login only to host the file, and `--fal` puts the file on fal's own storage; in
  all three the generation call bills the user's own fal key, never a VEED workspace.
- `cli/src/providers/`: the fal client on the user's own key (`fal.ts`), the asset manifest (`assets.ts`:
  records under `runs/<key>/assets/records/`, so parallel writers never share a file: one `row-*.json` per plain
  record, and each fal purchase as a series of `request-<id>.<n>.json` versions of which only the highest `n`
  stands, all read together by `readManifest`) and the queue ledger (`queue-ledger.ts`) that keeps an
  identical request from being bought twice.

## Rules
- Authored pages render in Chrome through `openedit render`.

## Transcription providers
`runs/<key>/transcript.json` is the only seam: anything that writes that shape is a provider. There is
no default: on a cold start the user chooses (`TRANSCRIPTION.md`), and the choice is recorded in
`$OPEN_EDIT_ROOT/.open-edit-prefs.json` by `openedit transcribe --record <provider> [--model <id>]`.
A bare `openedit transcribe <video>` runs the recorded provider; with none recorded and no `--provider`, it
refuses to start and says why.
VEED is listed first because it transcribes best, not because it wins ties.

| Provider | What it is | Entry point |
| --- | --- | --- |
| `veed` | Hosted, best quality. One browser sign-in; limits are the VEED account's. | `openedit transcribe --provider veed` |
| `whisperx` | Free, local. `medium` (slower, better) or `small.en` (fastest). CPU by default; `OPEN_EDIT_WHISPERX_DEVICE` / `OPEN_EDIT_WHISPERX_COMPUTE` override on a CUDA box. | `openedit transcribe --provider whisperx` |
| `custom` | The user's own service, and the route for generated narration: the media may be an audio file. We ship only the mapper; no credential passes through OpenEdit. | `openedit whisper <json> <media>` |

The mapper accepts the Python Whisper family (WhisperX, openai-whisper, whisper-timestamped,
mlx-whisper), the OpenAI API's `verbose_json` with word timestamps, and whisper.cpp's `-oj -ml 1`.
Per-word times are mandatory; untimed words are interpolated from their neighbours and counted.
A failed VEED run is classified per `TRANSCRIPTION.md` and never retried blindly; the recorded provider is
never rewritten on failure.

## Tests
`npm test`, `npm run test:cli`, `npm run typecheck`, `npm run typecheck:cli`, `npm run build`.
