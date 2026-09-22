# open-edit: style routes off the default draw, the creative pass, and ANALYSE

Read this whole file when the initial prompt asks for a simple/standard look, the user brought their own
reference/brand/concept, they iterate on a delivered result, or they ask to refine the style. The default
draw itself is SAMPLE ONE STYLE in `SKILL.md`.

## Routes off the default draw

- **CLASSIC POOL — explicit-simplicity route (intent, not vibe)**: `refs/html/classic/tags.json` holds
  a few plain caption presets (single font, simple or no word animation, all dual-aspect). Route here
  only when the user's initial prompt itself asks for a simplified/standard look ("simple", "clean",
  "minimal", "just subtitles", "black bars behind the text", "highlight the spoken word" or similar;
  each entry lists its `cues`, match on meaning). On this route skip sample-style and pick in two
  stages: the ask's cues narrow the pool ("simple" alone eliminates nothing, "black bars" narrows
  hard), then the transcript signal the seeded draw scores (word rate, caps, exclamations, tone)
  decides: calm speech, the soft picks (`energy: calm|clean`); fast punchy delivery, the highlight
  picks (`energy: punchy`); busy footage, a `bg` (bars/plate). Default to a word-by-word preset
  (`motion` != none: float-in, colour flash, per-word fade) even for calm content; `motion: none` only
  when the user says no animation ("static", "no motion", "nothing moving") or a concrete ask lands on
  a static preset ("black bars"; the concrete ask wins). Preset ids are labels, never selectors ("give
  me a simple style" is not the preset named `simple`; a hype-paced clip making that ask suits `rizz`
  or `mint` over a static preset). Run DESIGN + RENDER variant A with
  `--module {content}/refs/html/classic/<id>/recipe.js` appended (the compiled module runs as plain
  node anywhere: {content} sits inside node_modules on the package path, where TypeScript sources are
  never type-stripped; in a checkout the sibling `recipe.ts` works too) (same command and gates; no
  `style.json`).
  The pick is internal (User-facing output); the user hears at most "going with a clean look for this
  clip". No simplicity hint, never classic; the seeded draw stays the default. Iteration on a
  delivered classic run: **PARAMETER AMENDS stay classic** (any classic spec field: color, outline,
  shadow, size/position fractions, casing, highlight colour, font weight; "make the text blue", "move
  it up", "all caps"): copy the preset's `recipe.ts` to the scratchpad, fix its relative
  `classic-lib.ts` import to the absolute path of `{content}/refs/html/classic/classic-lib.js` (the
  compiled module, for the same node_modules reason as CUSTOMISING in `SKILL.md`; `.ts` only when
  {content} is a checkout), edit only the spec fields, rerun with
  `--module <copy>` (same gates; never edit the library recipe).
  **"Another simple one / different simple style"** re-picks a different classic preset by the same
  route. **A new creative DIRECTION** (a mood, a reference, new layout/motion language, "make it more
  interesting") graduates to REMIX with the delivered classic design as donor A, the continuity
  skeleton: translate its spec (font, casing, palette, placement, bars/plate, motion) into the
  skeleton role, keep what the ask doesn't touch, and let runtime-index donors supply only the
  divergence (B by `type`, optional C by `device`) per REMIX MODE. Classic presets are never donors or
  craft substrate for another run's remix/face-1 and never enter the seeded draw; a classic run
  keeping its own skeleton is not a breach.
- **CREATIVE PASS, two faces**: the user does not know recipes exist; route on the shape of the ask,
  never on whether they said "mix".
  **face-1** (the prompt arrives with the user's own reference/brand/concept: an image, a brand kit,
  a described idea): skip the draw-and-ship; author the from-scratch pass inline, no subagent
  (DESIGN + RENDER variant B). The user's materials are the design authority; open and study their
  files/links. 1-2 nearest recipe sheets (by facets from `refs/tags.json`, closest type/energy;
  `alternates` in style.json is a ready shortlist) ride along as engine-proven craft substrate,
  mechanics only, never their look; they may be off-aspect, with anything geometric (bands, margins,
  ladder px, placement constants) re-derived at this run's canvas per the cross-aspect rule in
  `director-brief.md`. Set a **DIRECTION**: content angle, mood/energy, placement intent only, never
  fonts/palette/device (those come from the user's materials, which win any collision).
  **face-2** (the user iterates on a delivered result):
  - **REMIX is the DEFAULT creative answer.** Any iteration carrying creative input ("make it more
    interesting", "surprise me", a mood/direction, a concrete aesthetic change) goes straight to
    REMIX on the first ask, no re-roll between. Compose it yourself inline at session effort, no
    subagent, from 2-3 ingredient sheets in the runtime index: the current pick is donor A (the
    skeleton); donor B (type+palette) has a different `type` facet; optional donor C (device) has a
    different `device` facet (read `refs/tags.json` facets; pick contrast deliberately). A must
    match the run's aspect (its skeleton carries the canvas geometry); B and C may be off-aspect,
    every geometric number re-derived at this canvas. Execute per `director-brief.md` REMIX MODE in
    a fresh run dir `runs/<key>-remix`, then the same gates: lint → verify → contrast → record → mux
    (commands in DESIGN + RENDER). Never a raw prefab, never an id outside the index.
  - **RE-ROLL only when the user asks for VARIANTS, not for creative input** ("show me more options",
    "another style", "make 5 different versions": N draws, N `--seed`s through DESIGN + RENDER
    variant A, parallel when N>1).
  - Defect repairs (typo, overlap, out-of-sync word) are neither: fix at the source, re-run the gates.
    Creative-run output (face-1/REMIX): patch the run's template directly. Recipe-run output: never
    hand-edit the generated .wv document (generate-recipe owns it); text/timing defect = fix
    transcript/word-timings and re-run the script; placement-vs-footage = the refine path (ANALYSE);
    deliberate one-run tweak = the CUSTOMISING `--module` copy (DESIGN + RENDER variant A).
  - **A BRAND OR A SET GETS A FILE, NOT A PARAGRAPH.** When the user supplies a brand, or pieces are
    made together, write `brand.json` beside the run (palette by role, colour law, type pair, the
    mark's file path and placement, and for a set the bone every piece keeps). Validate with
    `npx @veedstudio/openedit-cli brand --file <brand.json> --check` (fails when a named mark is not
    on disk) and paste `--brief` into the design pass.
  - **RECORD WHAT WAS REJECTED, AND WHY.** Before another round on the same footage run
    `npx @veedstudio/openedit-cli creative-log --for <video> --reject "<what it was>" --why "<their reason>"`
    and, when something lands, `--accept "<the aesthetic>" --why "<why it landed>"`. Start the next
    round by reading it back with `--brief` and putting that text in the design pass. It is keyed by
    the footage, so later rounds inherit it and it survives a compaction.
  - **A SCOPED EDIT MUST PROVE ITS SCOPE.** When the user asks for one thing and says to leave the
    rest alone, copy the accepted document first, then before saying the change is done run
    `npx @veedstudio/openedit-cli scoped-edit <accepted.wv> <new.wv> --allow <selector-or-id>…`
    It names every difference outside what you were allowed to touch, with both values;
    `--verify` cannot see an out-of-scope change.

Then, for face-1 runs only, set:
- **ENGAGEMENT mode**: pass the seed copy verbatim to DESIGN + RENDER (Engagement modes in `DESIGN.md`; wording changes output).
- **ANIMATION LEVEL**: `word` (default; almost always) / `cue` line (titles, or plain/corporate) / `none`
  (minimal/corporate). Respect any stated user preference; ask if genuinely unsure.
Recipe runs (the compiled recipe fixes engagement, animation and design) and REMIX (donor sheets per
REMIX MODE) need neither.

### ANALYSE — frames → analysis.json  · AGENT (vision) — OPT-IN

A clip with no speech (silent clip, card with no audio, stock footage) has no beats, so `prep`'s
per-chunk stills do not apply. Sample by time instead:
`npx @veedstudio/openedit-cli scene-frames <video.mp4> <runs/key/frames> [--count 8]`
It writes the stills plus `scene-plan.json` (canvas, fps, each sample's second and frame index);
facts are keyed to sample indices, not beats. No transcript is read on this path. Sampling follows
the picture stream, so a file whose audio outlasts its video still gets a still for every sample.

The analysis pass on this path is the same opt-in vision subagent described below, except it reads
`scene-N.png` and keys its facts to each sample's `i` in `scene-plan.json`. Everything else is
identical. Composition facts go in `analysis.json`, never as prose in the brief.

### ANALYSE (captioned runs) — frames + transcript → analysis.json  · AGENT (vision) — OPT-IN, refine only
Skip this step by default. Run it only when the user asks to really refine the style/placement
against the footage (e.g. "refine the style", "tuck the captions into the negative space"). Then
re-run DESIGN + RENDER as the from-scratch inline pass (variant B: compiled recipes ignore
`analysis.json`; the inline pass finds the file and composes from it), then MUX AUDIO. On a
refine-only re-run (no user-brought materials) fill contract B's USER MATERIALS slot (`DESIGN.md`) with
`none — hold the delivered run's system; compose placement from analysis.json` and use the delivered
pick's sheet plus its nearest alternate as the craft substrate.

When run: spawn one nameless background vision subagent, never a named teammate (a teammate hangs
after finishing and is slower; a nameless background subagent self-exits). This is the only vision
pass; the design pass composes from `analysis.json`, not the frames. It reads `meta.json`,
`transcript.json` and every `frames/beat-N.png`, and writes `runs/<key>/analysis.json`. Frames are
half canvas: ×2 every pixel to canvas px.

Spawn prompt (fill {…}):
```
You are the SHOT-ANALYSIS agent for ONE short-form video. Read inputs, write ONE JSON file, return a summary. No design.
INPUTS: {repo}/runs/{key}/meta.json (canvas W/H/fps/durationSec) · {repo}/runs/{key}/transcript.json (chunks = beats, in order)
        · every {repo}/runs/{key}/frames/beat-N.png (the still at each beat's mid).
The frames are HALF canvas ({W/2}×{H/2}); report everything in CANVAS px → ×2 every pixel you read off a frame.
For EACH beat N (1-indexed, matching chunk N) record: shot (wide|med|close); subjectBbox [x,y,w,h]; faceBbox [x,y,w,h]
or null (close-ups only); negSpaceRect [x,y,w,h] = the LARGEST clean rect where type can live off the subject/face;
brightness of that zone (light|mid|dark|busy).
WRITE {repo}/runs/{key}/analysis.json EXACTLY:
  {"beats":[{"i":1,"text":"…","startSec":s,"endSec":s,"midSec":s,"midFrame":round(midSec*{FPS}),
             "shot":"…","subjectBbox":[x,y,w,h],"faceBbox":[x,y,w,h]|null,"negSpaceRect":[x,y,w,h],
             "brightness":"…"}, …]}
  (startSec/endSec/midSec from transcript chunk N's timestamp; midSec=(start+end)/2.)
RETURN tight: video format (9:16|16:9) · overall vibe/genre · subject + setting · energy (calm|hype). No preamble.
```
