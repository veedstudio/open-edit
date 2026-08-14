> **AUTHORITY NOTE (2026-07-21):** `recipe.ts` next door is the single source of truth — the
> curation pass (design rounds v2–v6) edited the MODULE only and this sheet has NOT been synced.
> Do not recompile the module from this sheet until it is re-derived.

# hook-097-peak — recipe (9:16 · 736×1312 @ 25fps)

RESOLUTION: px are authored at the 9:16 reference canvas 736×1312. FIRST STEP: SCALE = W/736 from
`meta.json` (require |H − 1312·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE and round (positions, sizes, fonts, px spacing/shadows/margins/tops);
`em` values, unitless rotate/scale factors and ms timings never scale; the manifest carries the run's
real W/H.

Prefab is 720-wide; every px below is ALREADY rescaled ×1.022 — copy numbers as written, never rescale
again. Geometry math is done in UNROUNDED reference px; round only the emitted values.

## 1. IDENTITY

Two tilted film-strip rows over a flat warm-gray board (the footage stays hidden): each strip is a dark
near-black band — plain 2D `rotate(-3deg)` on the top row, `rotate(5.5deg)` on the bottom, origin
50% 50% — carrying a centered monospace stock label, up to three white film frames holding giant
Archivo 900 all-caps words (one counter-accent red word per strip), and a row of monospace frame marks;
later strips slide in from off-screen along their own tilt while words pop in on their spoken timing.

## 2. SKELETON

Paste this whole document as `runs/<key>/final/template.wv`, then insert one `.cue` block per beat
(section 3) after the `.bg` div. Replace only `{videoPath}` (from `meta.json`) and `{DUR}`
(`durationSec`, manifest only). Canvas: see RESOLUTION at the top of this sheet. The footage is present
at z0 but fully covered by the opaque `.bg` at z1 — the no-footage-flat-bg identity of this ref; never
remove or fade `.bg`.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@900&family=Roboto+Mono:wght@600&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 736px; height: 1312px; background: #e4e5e2; overflow: hidden; }
  body { position: relative; }
  .vid { position: absolute; inset: 0; width: 736px; height: 1312px; object-fit: cover; z-index: 0; }
  .bg  { position: absolute; inset: 0; background: #e4e5e2; z-index: 1; }

  /* beat gate — the one safe reveal recipe; z-index + delay + duration come inline per cue */
  @keyframes cueWin { 0%, 99.99% { opacity: 1; } 100% { opacity: 0; } }
  .cue { position: absolute; left: 0; top: 0; width: 736px; height: 1312px;
         opacity: 0; animation-name: cueWin; animation-timing-function: linear;
         animation-fill-mode: forwards; }

  /* a page = one whole film strip; pages alternate anchors (odd → top .sT, even → bottom .sB) and
     take turns AT an anchor. Each mid page carries ONE inline fade-out (pgOut). */
  .spg { position: absolute; left: 0; top: 0; width: 736px; height: 1312px;
         animation-name: pgOut; animation-duration: 250ms; animation-timing-function: ease;
         animation-fill-mode: forwards; }
  .sT { z-index: 2; }
  .sB { z-index: 3; }
  @keyframes pgOut { from { opacity: 1; } to { opacity: 0; } }

  /* the strip band — the PROVEN transform stack: static plain 2D rotate on the band (origin
     50% 50%); the slide-in animates translateX with the SAME rotate baked literally into both
     keyframes. No perspective/rotate3d anywhere. The band is flat #1b1a16: the prefab's dot-texture
     background-image radial-gradient is dropped by this engine — never re-add it. */
  .rot { position: absolute; left: -41px; width: 818px; background-color: #1b1a16;
         box-shadow: 0 6px 18px rgba(0,0,0,0.28); transform-origin: 50% 50%; }
  .rT { top: 231px; height: 249px; transform: rotate(-3deg); }
  .rB { top: 626px; height: 254px; transform: rotate(5.5deg); }
  @keyframes slT { 0%   { transform: translateX(-880px) rotate(-3deg); }
                   100% { transform: translateX(0px) rotate(-3deg); } }
  @keyframes slB { 0%   { transform: translateX(880px) rotate(5.5deg); }
                   100% { transform: translateX(0px) rotate(5.5deg); } }

  /* strip chrome text — plain numbers only (the prefab's ::before arrow content does not render in
     this engine); fades in at the page's first word so no glyph is ever drawn mid-slide. */
  .lab { position: absolute; left: 0; top: 12px; width: 818px; text-align: center;
         font-family: "Roboto Mono", monospace; font-weight: 600; font-size: 16px;
         letter-spacing: 3px; line-height: 1.3; color: #b9b8b4; white-space: nowrap;
         opacity: 0; animation-name: labIn; animation-duration: 160ms; animation-fill-mode: both; }
  .mks { position: absolute; left: 72px; bottom: 8px;
         font-family: "Roboto Mono", monospace; font-weight: 600; font-size: 16px;
         letter-spacing: 2px; line-height: 1.3; color: #cfcecb; white-space: nowrap;
         opacity: 0; animation-name: labIn; animation-duration: 160ms; animation-fill-mode: both; }
  @keyframes labIn { 0% { opacity: 0; } 100% { opacity: 1; } }

  /* film frames — FIXED computed geometry (left/width inline per frame, section 3); never flex. */
  .fr { position: absolute; top: 40px; height: 176px; background: #ffffff; border-radius: 1px; }
  .word { position: absolute; left: 10px; right: 10px; top: 0;
          font-family: "Archivo", sans-serif; font-weight: 900; color: #1b1a16;
          letter-spacing: -0.026em; }
  .alL { text-align: left; } .alC { text-align: center; } .alR { text-align: right; }

  /* size ladder (font-size for ALL frames of a page) */
  .s60 { font-size: 60px; }
  .s54 { font-size: 54px; }
  .s48 { font-size: 48px; }
  .s43 { font-size: 43px; }
  .s38 { font-size: 38px; }
  .s34 { font-size: 34px; }
  .s30 { font-size: 30px; }
  .s27 { font-size: 27px; }
  .s24 { font-size: 24px; }

  /* one unit per line; stacked pitch 0.9em (1.24em span box − 0.34em pull) */
  .ln  { display: block; line-height: 1; }
  .ln2 { margin-top: -0.34em; }

  /* word reveal — the prefab's scale pop + fade IN, then HOLD; the page-level pgOut is the only
     fade-out. The vertical padding is descender clearance headroom — never remove it. */
  .wp  { display: inline-block; opacity: 0; padding: 0.06em 0 0.18em;
         animation-name: wordPop; animation-duration: 160ms;
         animation-timing-function: cubic-bezier(.2,.7,.3,1); animation-fill-mode: both; }
  .red { color: #e02b27; }
  @keyframes wordPop { 0% { opacity: 0; transform: scale(1.10); } 100% { opacity: 1; transform: scale(1); } }
</style>
</head>
<body>
  <video class="vid" src="{videoPath}" muted></video>
  <div class="bg" id="bg" data-node-id="bg"></div>
  <!-- one .cue block per beat goes here, in beat order -->
</body>
</html>
```

`manifest.json` (verbatim, `{DUR}` = `durationSec` from `meta.json`):

```json
{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json
```

## 3. PER-BEAT ASSEMBLY

One `.cue` per beat `{N}` of `word-timings.json`. Strip anchors are FIXED (`.rT`/`.rB` in the skeleton);
frame geometry is computed per page below. Beat template — one `.spg` per page, one `.rot` strip per
page, one `.fr`+`.word` per frame, one `.ln` line per unit, one `.wp` span per token:

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N}; animation-delay:{cueDelayMs}ms; animation-duration:{winMs}ms;">
  <div class="spg sT" style="{pgOutMs or animation:none}">
    <div class="rot rT" id="b{N}p1rot" data-node-id="b{N}p1rot">
      <div class="lab" id="b{N}p1lab" data-node-id="b{N}p1lab" data-node-role="text" style="animation-delay:{pgStart}ms">1214&#160;&#160;LUX&#160;&#160;PLUS</div>
      <div class="fr" id="b{N}p1f1box" data-node-id="b{N}p1f1box" style="left:{X}px; width:{W}px"><div class="word alL s{FS}" id="b{N}p1f1" data-node-id="b{N}p1f1" data-node-role="text" style="padding-top:{PT}px"><div class="ln"><!-- unit 1 spans --></div><div class="ln ln2"><!-- unit 2 spans, if stacked --></div></div></div>
      <!-- f2, f3 as the distribution rule produces them -->
      <div class="mks" id="b{N}p1mk" data-node-id="b{N}p1mk" data-node-role="text" style="animation-delay:{pgStart}ms">1&#160;&#160;&#160;&#160;1A&#160;&#160;&#160;&#160;2&#160;&#160;&#160;&#160;2A&#160;&#160;&#160;&#160;3</div>
    </div>
  </div>
  <!-- more .spg blocks (p2, p3, …): even pages use class "spg sB" + "rot rB" and the BOTTOM chrome
       strings (label 212&#160;&#160;MED&#160;&#160;BALANCE&#160;&#160;FILM · marks 3A&#160;&#160;&#160;&#160;4&#160;&#160;&#160;&#160;4A&#160;&#160;&#160;&#160;5&#160;&#160;&#160;&#160;5A);
       pages j ≥ 2 add the slide on their .rot:
       style="animation:slT|slB 420ms cubic-bezier(.2,.7,.3,1) {pgStart−420}ms both" -->
</div>
```

**Window** (extends the gate to the next beat so fade-outs finish — pure subtraction):
- `{winMs}` = next beat's `cueDelayMs` − this beat's `cueDelayMs`.
- Last beat: `{winMs}` = round(`durationSec`×1000 from `meta.json`) − its `cueDelayMs`.
- `{gateEnd}` = this beat's `cueDelayMs` + `{winMs}` (used by the entrance-compression rule, section 4).

**Word prep:** UPPERCASE every token yourself (no text-transform in the CSS); keep ALL punctuation
exactly as in `word-timings.json`. GLUE: a token starting with `-` (e.g. `-DO` after `TO`) merges with
the previous word into ONE unit for paging and counting (`TO-DO` = 5 chars); it renders as two adjacent
`.wp` spans inside the unit's `.ln` (inter-span whitespace is not what sets the gap here, so the pair reads flush), each
keeping its OWN verbatim `delayMs`.

**Paging rule** — walk the beat's units left to right (ORDER PRESERVED, every unit used once): a page
takes units while BOTH hold: total page chars (incl. 1 per inter-unit gap) ≤ 24 AND ≤ 6 units. Stop
before the first violation; remaining units start the next page. An oversized single unit still gets
its own page. Page `{pgStart}` = its first unit's first `delayMs`. Page j anchor: j odd → top (`.sT` +
`.rT`), j even → bottom (`.sB` + `.rB`).

**Frame distribution** — a page of n units renders F = min(3, n) frames; frame f (1-based, left to
right) takes `floor(n/F) + (f ≤ n mod F ? 1 : 0)` consecutive units, order preserved — so [2,1,1] for
n=4, [2,2,1] for n=5, [2,2,2] for n=6. A 2-unit frame stacks its units as two `.ln` lines (`.ln2` on
the second). Alignment: F=1 → `alC`; F=2 → `alL`,`alR`; F=3 → `alL`,`alC`,`alR`.

**Sizing — one size class per page (ALL its frames share it).** Archivo 900 caps advance budget
A = 0.75 × font-size per char incl. the −0.026em tracking (measured by calibration render at 736 wide;
covers the wide-caps worst case, the ladder demotion absorbs outliers). S = Σ over frames of the
frame's LONGEST line's chars. Ink budget 640px total (mid-pop scale growth and the rotated bbox
budgeted in); per-frame chrome 20px + 18px gaps → usable ink B_F = 620 (F=1) / 582 (F=2) / 544 (F=3).
Normalize C = S × 544 / B_F, then look C up (row = largest fs with fs ≤ 544/(0.75·C), precomputed):

| C ≤ 12.09 | 13.43 | 15.11 | 16.87 | 19.09 | 21.33 | 24.18 | 26.86 | above |
|---|---|---|---|---|---|---|---|---|
| s60 | s54 | s48 | s43 | s38 | s34 | s30 | s27 | s24 |

**Frame geometry (per page, computed at reference px then scaled; keep fractions until emit):**
- frame width `w_f` = (frame's longest line chars) × 0.75 × fs + 20.
- total `T` = Σ w_f + 18×(F−1); first frame `left` = (818 − T)/2; each next left = prev left + prev
  w + 18 (lefts accumulate UNROUNDED).
- `padding-top` = (176 − H)/2 with H = 1.24×fs (1 line) or 2.14×fs (2 lines).

**Worked example** (portrait-main fixture beat 1 — `So I built an app that does one thing.`,
cueDelayMs 320, next beat 2080 → winMs 1760, gateEnd 2080):
- units (9): SO 320 · I 400 · BUILT 520 · AN 720 · APP 840 · THAT 1000 · DOES 1160 · ONE 1400 · THING. 1680
- p1 `SO I BUILT AN APP THAT` (22 chars, 6 units, TOP): frames [2,2,2] → f1 [SO,I] max 2 · f2
  [BUILT,AN] max 5 · f3 [APP,THAT] max 4 → S = 11, C = 11 → `s60`; widths 110 / 245 / 200,
  T = 591, lefts 113.5→**114** · 241.5→**242** · 504.5→**505**; padding-top (2 lines) 23.8→**24**;
  accent = BUILT (longest, ties→later) → f2's BUILT is red.
- p2 `DOES ONE THING.` (3 units, BOTTOM): frames [1,1,1], S = 4+3+6 = 13, C = 13 → `s54`; widths
  182 / 141.5 / 263, T = 622.5, lefts **98** / **298** / **457**; padding-top (1 line) 54.52→**55**;
  accent THING. red; slide `slB` delay 1160−420 = **740**; lab/mks delay **1160**.
- P = 2 → BOTH pages hold (`animation:none` on both `.spg`); the gate cuts them at 2080.

(Fixture beat 4 sizes: p1 `THIS COULD HAVE BEEN AN` → [2,2,1], S=11 → `s60`; p2
`EMAIL, PROFESSIONALLY.` → F=2, S=21, C = 21×544/582 = 19.63 → `s34`.)

## 4. WORDS + TIMING

- One `<span class="wp">` per token, inline `animation-delay:{delayMs}ms` — that word's `delayMs` from
  `runs/<key>/word-timings.json`, VERBATIM (delays are absolute on the single timeline — never re-zero,
  never invent). Spans stay `display:inline-block`.
- **Entrance compression at the gate:** if `delayMs + 160 > gateEnd`, that span ALSO gets inline
  `animation-duration:{max(gateEnd − delayMs, 100)}ms`; otherwise no inline duration.
- **Slide:** page 1's strip is at rest from gate open (no slide — its slide would land inside the
  closed gate). Every page j ≥ 2 gets inline
  `animation:slT|slB 420ms cubic-bezier(.2,.7,.3,1) {pgStart−420}ms both` on its `.rot` — the slide
  COMPLETES exactly at `{pgStart}`, and every glyph of the page (label, marks, words) first draws at
  `{pgStart}` or later, so no text is ever drawn mid-slide off the viewport.
- **Chrome fade:** each page's `.lab` and `.mks` get inline `animation-delay:{pgStart}ms`.
- Each `.spg` with a SAME-ANCHOR successor (page j with j+2 ≤ P) gets inline
  `animation-delay:{pgOutMs}ms` with `{pgOutMs}` = max((pgStart_{j+2} − 420) − 250,
  thisPageLastWordDelayMs) — the 250ms fade completes as the successor's slide begins. Pages P−1 and P
  have no same-anchor successor: inline `animation:none` — they HOLD and the beat's `.cue` gate cuts
  them at `{gateEnd}` (fading them leaves dead-air at every beat end).
- The beat's `.cue` gets inline `z-index:{10+N}; animation-delay:{cueDelayMs}ms;
  animation-duration:{winMs}ms` exactly as in section 3.
- Word span examples:
  `<span class="wp" style="animation-delay:1000ms">THAT</span>`
  `<span class="wp red" style="animation-delay:1680ms">THING.</span>`

## 5. EMPHASIS

Exactly ONE counter-accent unit per PAGE (each strip carries its own red word, like the prefab): add
class `red` to every span of that unit. Pick rule, no judgment, over the page's units:
1. Any unit containing a digit wins (first such unit if several).
2. Otherwise the LONGEST unit (chars, punctuation included).
3. Tie → the LATER unit.
Nothing else changes for the accent unit.

## 6. VERIFY LOOP

Run (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

(`ancestor-rotation-overflow-clip-omitted` warnings are benign — the strips depend on nothing being
clipped.) Exit 0 → record. Otherwise apply the MECHANICAL fix for the named element and re-run; at
most 2 fix cycles:
- `FAIL[bounds] #b{N}p{P}f{F}` (or `…lab` / `…mk`) → move that PAGE one row DOWN the ladder
  (`s60`→`s54`→…, ALL the page's frames together; recompute widths/lefts/padding-top). Same page
  again → one more row. Never change a rotate angle and never move a strip anchor.
- `FAIL[never-visible]` on a span or cue → that word was pasted into the WRONG beat's `.cue` or the
  cue is missing its inline `z-index:{10+N}` / delay / duration; also confirm the `<video>` is the
  first body element with `class="vid"` (z0) and `.bg` kept `z-index:1`.
- `FAIL[occluded]` → two cue windows overlap or chrome outranks text: re-check each `{winMs}` equals
  the next beat's `cueDelayMs` minus this beat's, every `.cue` has `z-index:{10+N}`, and no `.spg`
  z-index was raised above 3.

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --record {repo}/runs/<key>/final/out.silent.mp4
```

Manifest line (already given in section 2): `{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json`

## 7. DO NOT

- No fonts, colors, shadows, sizes, or keyframes beyond this sheet — Archivo 900 + Roboto Mono 600,
  `#e4e5e2`/`#1b1a16`/`#ffffff`/`#e02b27` + the two chrome grays, the two rotate angles, the nine size
  rows and the six keyframe blocks are the whole system.
- No invented timing: every word `animation-delay` comes VERBATIM from `word-timings.json`; inline
  durations only via the entrance-compression formula; slides/chrome only at `{pgStart}` per the
  closed forms; page fades only via the pgOut formula.
- Do not remove, fade, or thin the `.bg` cover — the footage never shows on this ref.
- Do not re-add the prefab's dot-texture `background-image`, its `::before` arrow marks, its flex
  `.frames` row, or `text-transform`; do not change the rotate angles, the transform-origin, or the
  slide distance; no perspective/rotate3d.
- Never animate `color` or `filter:blur`; single-value `border-radius` only.
- Never read the video frames, never run ffmpeg checks — `--verify` is the only self-check.
- No redesign after render or a verify failure — only the mechanical fixes in section 6.
