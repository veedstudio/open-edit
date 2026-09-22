# open-edit: the CUT step

Read this whole file when there is an edit to make. Then continue with PREP in `SKILL.md`, giving it the assembled file.

### CUT — assemble the footage you actually want  · SCRIPT (only when there is an edit to make; splits PREP)
Applies whenever the deliverable is not one source file played end to end: something to remove (dead
air, filler, a weak take), something to reorder, or several clips to join. If the ask is a single clip
captioned as-is, skip this step and run PREP normally.

**Where it sits.** `retime-transcript` needs the sources already transcribed, so: transcribe the sources
(the PREP step's own batch, one command, all files), then CUT.

**Measure the cut points; do not take them from the transcript.**
```
npx @veedstudio/openedit-cli speech-probe <video> [--range a:b] [--gap 250] [--window 10] [--json]
```
Reports the noise floor, speech onset and decay, and every sub-threshold gap at least `--gap` long.
`--gap` and `--window` are milliseconds; `--range` and every number in the EDL are seconds. Transcript
word boundaries are not cut points. If the probe finds no gap at a boundary, do not cut there; keep the
filler word. Optional when the in- and out-points come from elsewhere (a storyboard, the user naming the
takes).

**Write the edit down, then apply it.**
```json
{ "sources":     { "<id>": "<path to video>" },
  "transcripts": { "<id>": "<path to that source's transcript.json>" },
  "ranges":      [ { "source": "<id>", "start": 1.6, "end": 7.05, "note": "free text, ignored" } ] }
```
`transcripts` is optional; without it each source's transcript is read from where the transcribe command
wrote it (`{repo}/runs/<key>/transcript.json`, `<key>` from the source video's filename).
`note` is optional. Every source path must exist for both tools (the frame grid comes from the file).
Ranges play in the order written; reorder them freely.
```
npx @veedstudio/openedit-cli apply-edl --edl edl.json --out cut.mp4 [--crossfade 40] [--crf 20]
```
One encode, one canvas (the first range's source's), joins crossfaded, colour tags kept; sources that
disagree on colour or frame rate are refused, not relabelled. `--crossfade` is milliseconds. Each range
is snapped to the frame grid, so the assembled timeline is exactly the sum of the snapped ranges and the
retimed transcript below lands on the same instants.

This is the joiner for an edit: parts of clips, in an order you chose. The FOOTAGE step's joiner is for
whole generated clips whose shapes disagree and hands back an ordinary source file you then transcribe;
this one hands back a cut whose transcript you retime.

**Move the timings; do not buy them again.**
```
npx @veedstudio/openedit-cli retime-transcript --edl edl.json --out "$OPEN_EDIT_ROOT/runs/cut/transcript.json"
```
The per-word timings you already have are the new file's. Write it where `prep` looks:
`$OPEN_EDIT_ROOT/runs/<key>/transcript.json`, where `$OPEN_EDIT_ROOT` is the root preflight printed
({repo}, which on the package path is your project directory) and `<key>` is the assembled file's name
without its extension, whitespace turned into underscores (`runs/cut/` for `cut.mp4`). Skipped when
there is no transcript at all: no speech, nothing to retime.

**Never transcribe the assembled cut.** Every transcription route (hosted, local, and the mapper for your
own service) refuses to overwrite an existing `transcript.json` without `--force`, and checks before it
uploads or runs anything.

Then continue with the PREP step, giving it `cut.mp4`.

