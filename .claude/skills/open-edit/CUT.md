# open-edit: the CUT step

Read this whole file when there is an edit to make.

### CUT — assemble the footage you actually want
Applies whenever the deliverable is not one source file played end to end: something to remove (dead
air, filler, a weak take), something to reorder, several clips to join, or footage to slow down, speed
up or grade. If the ask is a single clip captioned as-is, skip this.

**Where it sits.** `apply-edl` moves the sources' transcripts onto the cut, so: transcribe the sources
(one `transcribe` call, all files), then cut.

**Measure the cut points; do not take them from the transcript.**
```
npx @veedstudio/openedit-cli speech-probe <video> [--range a:b] [--gap 250] [--window 10] [--json]
```
Reports the noise floor, speech onset and decay, and every sub-threshold gap at least `--gap` long.
`--gap` and `--window` are milliseconds; `--range` and every number in the EDL are seconds. Transcript
word boundaries are not cut points. If the probe finds no gap at a boundary, do not cut there; keep the
filler word. Optional when the in- and out-points come from elsewhere (the user naming the takes).

**Write the edit down, then apply it.**
```json
{ "sources":     { "<id>": "<path to video>" },
  "transcripts": { "<id>": "<path to that source's transcript.json>" },
  "grade":       { "contrast": 1.1, "saturation": 1.15, "temperature": 5600, "lut": "look.cube", "grain": 3 },
  "ranges":      [ { "source": "<id>", "start": 1.6, "end": 7.05, "note": "free text, ignored" },
                   { "source": "<id>", "start": 9.2, "end": 10.4, "speed": 0.5, "interpolate": true, "mute": true,
                     "grade": { "exposure": 0.3 } } ] }
```
`transcripts` is optional; without it each source's transcript is read from where the transcribe command
wrote it (`$OPEN_EDIT_ROOT/runs/<key>/transcript.json`, `<key>` from the source video's filename).
`note` is optional. Ranges play in the order written; reorder them freely.

`speed`, `interpolate`, `mute` and `grade` are optional. `speed` 0.5 plays a range at half speed, 2 at
double. Slow motion repeats frames; `"interpolate": true` draws the frames between instead, which looks
smooth and encodes far slower (worst at 4K). A range's sound is time-stretched, pitch kept, from 0.5x to
2x, and silent at any other speed or with `"mute": true`; a source with no sound plays silent. The EDL's
`grade` covers every range, and a range's own `grade` overrides it key by key (`null` drops a key):
`exposure` in stops (-3 to 3), `contrast` and `saturation` (1 unchanged, 0 to 3), `temperature` in kelvin
of the light (6500 unchanged, lower is warmer), `lut` (a .cube, .3dl, .dat, .m3d or .csp file) and `grain`
(0 to 100).
```
npx @veedstudio/openedit-cli apply-edl --edl edl.json --out cut.mp4 [--crossfade 40] [--crf 20] [--fit letterbox]
```
One canvas (the first range's source's, as shown), joins crossfaded, and one colour, the first source's (BT.709
for an untagged one): every other source is converted to it as `concat-videos` converts, an HDR one to SDR first,
and a line names each one converted. A range from a source of another shape is cut to the canvas's shape as
`reframe` cuts it, around its faces when `faces` has run on that source, else from the middle, and a line says
which; `--fit letterbox` keeps it whole and pads it instead. A wide-gamut source among others, and sources at
different frame rates, are refused. `--crossfade` is milliseconds.
Each range is snapped to the frame grid, so the assembled timeline is exactly the sum of the snapped ranges
as they play. It prints the seconds kept and, when a range changes speed, where every range lands on the
cut and how long the cut runs, and a line when the cut misses the length in the piece's brief. Each range's
picture is kept in `<cut>.ranges/`, so a run
that changes one range encodes only that one; iterate on the EDL, never on an ffmpeg pass of your own.

This is the joiner for an edit: parts of clips, in an order you chose. `concat-videos` joins whole
clips, generated ones say, and hands back an ordinary source file you then transcribe; it cuts a clip of
another shape to the canvas's the same way. This one hands back a cut with its transcript: its sources'
word times moved onto the cut (a range that plays silent keeps none), in
`$OPEN_EDIT_ROOT/runs/<key>/transcript.json` for a cut named `<key>.mp4`; a line says where. Where `faces`
has run on its sources, it writes the cut's `faces.js` the same way, their boxes and burned-in graphics moved onto it.

