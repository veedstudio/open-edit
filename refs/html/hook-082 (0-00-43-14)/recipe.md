> **AUTHORITY NOTE (2026-07-21):** `recipe.ts` next door is the single source of truth — the
> curation pass (design rounds v2–v6) edited the MODULE only and this sheet has NOT been synced.
> Do not recompile the module from this sheet until it is re-derived.

# RECIPE — hook-082 (9:16 · 736×1312 @ 25fps)

RESOLUTION: every px in this sheet is authored at the 9:16 reference canvas 736×1312. FIRST STEP:
SCALE = W/736 from `meta.json` (require |H − 1312·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1
(the standard prep canvas) → numbers verbatim. Otherwise multiply EVERY px by SCALE and round: positions,
widths/heights, font sizes, px letter-spacings, px text-shadow offsets/blurs, px translate distances in
keyframes, px margins/tops. `em` values and ms timings never scale; the manifest carries the run's real W/H.

## 1. IDENTITY

A brutalist end-card caption: upright condensed Oswald caps, flag-anchored low in the frame (the anchor
flag flips left/right beat-to-beat), where ONE hero word per beat is blown up huge in signal-yellow with a
hard maroon offset block behind it while the setup words sit small in cream above/below it, set on a tight
poster leading — a movie-poster "small setup / BIG WORD / small payoff" stack. Each beat's lines punch in
together, sliding as a unit from the side its flag is anchored to; a soft warm scrim grounds the band and
each beat cross-fades to the next.

> Prefab-adaptation notes (why this differs from `template.wv`, kept out of the assembly rules' way):
> the prefab's italic + `scaleX(.87)` are DROPPED — the engine has no Oswald italic face (it substitutes
> upright and warns, which trips the font-STOP rule) and an ancestor `scaleX` over animated words is the
> engine composite bug. Both looks are recovered with Oswald's native condensation + upright weight
> contrast. The heart accent-glyph is demo-copy-specific (no reliable glyph to swap into live captions),
> so the "accent-letter" device is reinterpreted as the accent HERO WORD.

## 2. SKELETON

Paste this whole document as `runs/<key>/final/template.wv`, then insert one `.cue` block per beat
(section 3) after the `.scrim` div. Replace only `{videoPath}` (from `meta.json`) and, in the manifest,
`{DUR}` (`durationSec`). Canvas: see RESOLUTION at the top of this sheet.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@600;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 736px; height: 1312px; overflow: hidden; }
  body { position: relative; background: #000; font-family: 'Oswald', 'Arial Narrow', sans-serif; }
  .vid { position: absolute; inset: 0; width: 736px; height: 1312px; object-fit: cover; z-index: 0; }

  /* warm grounding scrim — lower band only (the prefab's #scrim); static, never gated */
  .scrim { position: absolute; left: 0; top: 686px; width: 736px; height: 626px; z-index: 1;
           pointer-events: none;
           background: linear-gradient(180deg, rgba(10,8,6,0) 0%, rgba(10,8,6,.30) 46%, rgba(10,8,6,.52) 100%); }

  /* beat gate — cue-fade: hold, then fade over the last 6% of the window. z-index is inline per cue
     (positioned + opacity-animated => the stacking trap needs an explicit z). */
  @keyframes cueGate { 0%, 94% { opacity: 1; } 100% { opacity: 0; } }
  @keyframes cueHold { 0%, 100% { opacity: 1; } }        /* FINAL beat only — rides the video end, no fade */
  .cue { position: absolute; top: 740px; width: 580px; height: 336px;
         display: flex; flex-direction: column; justify-content: center; align-items: flex-start;
         opacity: 0; animation-timing-function: linear; animation-fill-mode: both; }
  /* cue anchor — the ONLY thing that varies horizontally per beat (section 6 CUE ANCHOR); top/height
     never move. text-align is set HERE and inherited down into .line (which sets none of its own). */
  .aL { left: 64px; right: auto; text-align: left; }
  .aR { left: auto; right: 100px; text-align: right; }

  /* a line = one full-width row (NEVER shrink-to-fit — a shrink-to-fit line resizes with its content, so one word moves everything beside it);
     words flow from the anchor's side. line-height cut well under 1 for a tight poster stack — this
     drops the ≥1.2 shear guard, so .ink's padding below now carries shear-safety alone. */
  .line { width: 100%; line-height: .82; white-space: nowrap; text-transform: uppercase;
          position: relative; z-index: 2; }
  .sup  { font-weight: 600; font-size: 42px; letter-spacing: .01em; color: #f2ead2;
          text-shadow: 0 2px 8px rgba(0,0,0,.72); }                     /* setup: cream, ONE soft dark halo */
  .hero { font-weight: 700; letter-spacing: -.01em; color: #ffde04;
          text-shadow: 6px 9px 0 #5a1808, 0 3px 10px rgba(0,0,0,.5); }  /* hero: yellow, hard maroon block + soft ground */

  /* HERO size ladder — pick by the hero word's char count C (section 3): fs = min(132, floor(990 / C)) */
  .h132{font-size:132px} .h123{font-size:123px} .h110{font-size:110px} .h99{font-size:99px}
  .h90{font-size:90px}   .h82{font-size:82px}   .h76{font-size:76px}   .h70{font-size:70px}
  .h66{font-size:66px}   .h61{font-size:61px}   .h58{font-size:58px}   .h55{font-size:55px}
  .h52{font-size:52px}   .h49{font-size:49px}   .h47{font-size:47px}   .h45{font-size:45px} .h43{font-size:43px}

  /* LINE UNIT = nested two spans (engine-bug-safe over <video>): the WHOLE line slides in from one side
     (outer .slide) while it rises + fades (inner .ink). ONE unit per line — the words are plain text
     inside and move TOGETHER (no relative motion = no overlap during the slide). NEVER collapse to one
     span; NEVER put a transform (scaleX/skew/perspective/rotate) on the .cue, a .line, or any ancestor. */
  .slide { display: inline-block; vertical-align: top;
           animation-timing-function: cubic-bezier(.2,.7,.3,1); animation-fill-mode: both; }
  .fromL { animation-name: slL; }              /* the line enters from the LEFT  */
  .fromR { animation-name: slR; }              /* the line enters from the RIGHT */
  .ink   { display: inline-block; padding: .1em 0 .18em; opacity: 0;    /* padding = descender headroom (sole guard now that line-height < 1) */
           animation-name: rise; animation-timing-function: cubic-bezier(.2,.7,.3,1); animation-fill-mode: both; }
  @keyframes slL  { 0% { transform: translateX(-48px); } 100% { transform: translateX(0); } }
  @keyframes slR  { 0% { transform: translateX(48px); }  100% { transform: translateX(0); } }
  @keyframes rise { 0% { opacity: 0; transform: translateY(.14em); } 100% { opacity: 1; transform: translateY(0); } }
</style>
</head>
<body>
  <video class="vid" src="{videoPath}" muted></video>
  <div class="scrim"></div>
  <!-- one .cue block per beat goes here, in beat order -->
</body>
</html>
```

`manifest.json` (verbatim shape; `{DUR}` = `durationSec` from `meta.json`):

```json
{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json
```

`top:740px; width:580px; height:336px` are FIXED on `.cue` — a column in the LOWER band (the talking head
lives dead-center; this clears it). The HORIZONTAL side is the one thing that moves, between two
pre-validated anchors (`aL`/`aR`, section 6 CUE ANCHOR gives the per-beat rotation):
- `aL` (`left:64px`): left 64 ≥ 44, right edge 64+580 = 644 ≤ 655. Text flush-left; lines slide `fromL`
  (travel start 64−48 = 16 ≥ 0, in-viewport).
- `aR` (`right:100px`): right edge 736−100 = 636 ≤ 655, left edge 636−580 = 56 ≥ 44. Text flush-right;
  lines slide `fromR` (travel start 636+48 = 684 ≤ 736, in-viewport).
Both: top 740 ≥ 144, lowest ink (centered ≤336-tall stack) ≤ ~1058 ≤ 1089. Never a third position, never
blend `aL`/`aR` on one cue.

## 3. PER-BEAT ASSEMBLY

One `.cue` per beat `{N}` of `word-timings.json`, anchored `{ANCHOR}` (section 6 CUE ANCHOR: `N` odd →
`aL`, `N` even → `aR`). Inside it, in this vertical order: the BEFORE-cluster support line(s), then the
ONE hero line, then the AFTER-cluster support line(s):

```html
<div class="cue {ANCHOR}" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N}; animation-name:{GATE}; animation-delay:{cueDelayMs}ms; animation-duration:{winMs}ms;">
  <div class="line sup" id="b{N}s1" data-node-id="b{N}s1" data-node-role="text"><span class="slide {DIR}" style="animation-delay:{ld}ms;animation-duration:{le}ms"><span class="ink" style="animation-delay:{ld}ms;animation-duration:{le}ms">WORD WORD WORD</span></span></div>
  <div class="line hero {hSIZE}" id="b{N}h" data-node-id="b{N}h" data-node-role="text"><span class="slide {DIR}" style="animation-delay:{ldH}ms;animation-duration:{leH}ms"><span class="ink" style="animation-delay:{ldH}ms;animation-duration:{leH}ms">HEROWORD</span></span></div>
  <!-- AFTER-cluster support line(s), same shape as the .sup line, ids b{N}a1, b{N}a2 … -->
</div>
```

`{ANCHOR}` is the ONE class (`aL` or `aR`) applying to that beat's `.cue`; `{DIR}` (below) always matches it.

- `{GATE}` = `cueGate` for every beat EXCEPT the last; the LAST beat uses `cueHold` (a mid-beat page
  fades so the next can rise; the last must HOLD or the tail goes caption-blank — the gate/video-end cuts it).
- `{10+N}` gives cues ascending z in beat order (turn-taking). A line's words go inside its ONE `.ink`
  span as plain text joined by single spaces — STRIPPED (terminal `.,!?` dropped, internal punctuation
  kept); the CSS uppercases them. A line is ONE slide unit; both its spans carry the SAME timing.

**Word prep (before anything):** from each token strip ONE trailing `.` `,` `!` `?` (keep INTERNAL
punctuation — `10,000` stays 6 chars, apostrophes stay). `len(word)` = the stripped length.
GLUE: a token starting with `-` (e.g. `-do` after `to`) MERGES with the previous token into one unit for
counting + line mapping (`TO-DO` = 5); it renders as the two spans back-to-back with `margin-right:0` on
the first and the `-` span leading the second, each keeping its OWN `delayMs`.

**Pick the hero word (the beat's accent — no judgment):**
1. If any word contains a digit `0–9`, the FIRST such word is the hero.
2. Else the LONGEST word by `len`; tie → the LATER (rightmost) one.

The hero is ISOLATED on its own `.line.hero`. Words BEFORE it (original order) = the before-cluster;
words AFTER it = the after-cluster. Either cluster may be empty (hero first or last → that side has no
support line; a 1-word beat is hero-only).

**Support pagination — per cluster, independently (order ALWAYS preserved):**
- `nw` = words in the cluster; `cc` = Σ len + (nw − 1) spaces.
- `Ls = max(1, ceil(cc / 26))` support lines.
- `base = floor(nw / Ls)`, `r = nw mod Ls`: the FIRST `r` lines take `base+1` consecutive words, the rest
  take `base`. (nw=8,Ls=2 → 4,4 · nw=6,Ls=2 → 3,3 · nw=5,Ls=1 → 5 · nw=2,Ls=1 → 2.)
- Every support line is one `.line.sup`; all support text is a single fixed size (`.sup` = 42px). The
  26-char line budget keeps it inside 580px (Oswald 600 caps advance ≈ 0.53·fs, spaces ~0.25·fs — baked in).

**Hero sizing — `{hSIZE}` by the hero word's char count `C = len(hero)`** (Oswald 700 caps advance
budget 0.576·fs incl. tracking; usable ink width 570px — already baked in). `fs = min(132, floor(990/C))`;
use the class from this table:

| C  | ≤7  | 8   | 9   | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | ≥23 |
|----|-----|-----|-----|----|----|----|----|----|----|----|----|----|----|----|----|----|-----|
| cls| h132| h123| h110| h99| h90| h82| h76| h70| h66| h61| h58| h55| h52| h49| h47| h45| h43 |

**Slide direction `{DIR}`** — ONE direction for the WHOLE beat, matching its cue's anchor (section 6 CUE
ANCHOR): every line in an `aL` beat is `fromL`; every line in an `aR` beat is `fromR`. No per-line
alternation — all lines in one beat carry the SAME `{DIR}`.

**Worked example — video1 beat 1** `So I built an app that does one thing.` cueDelayMs 320, next 2080 →
winMs 1760, `cueGate`, z-index 11; beat 1 is odd → `aL` → every line `fromL`. Hero pick: no digit; longest
tie built(5)/thing(5) → later = `thing`. before-cluster = `So I built an app that does one` (8 words,
cc = 24 + 7 = 31 → Ls = 2 → 4,4); after = empty.
Lines (each a LINE unit; `{ld}` = its first word's delay; `{le}` = clamp(2080 − ld, 250, 500)):
L0 `SO I BUILT AN` (`sup`, `fromL`, ld=320, le=500), L1 `APP THAT DOES ONE` (`sup`, `fromL`, ld=840, le=500),
L2 hero `THING` C5 → `h132` (`fromL`, ld=1680, le=400).

## 4. WORDS + TIMING

This ref is LINE-LEVEL (whole lines slide in as a unit) — timing attaches to LINES, not words:
- One LINE UNIT (`<span class="slide …"><span class="ink" …>WORDS</span></span>`) per line. BOTH spans
  carry the SAME inline `animation-delay` AND `animation-duration` (the outer slides the line, the inner
  rises + fades it; one entrance, must stay in sync — the two-span nesting is the engine-bug workaround,
  do not merge it and never re-split the line into per-word spans).
- `{ld}` = the line's FIRST word's `delayMs` from `runs/<key>/word-timings.json` VERBATIM (absolute on the
  single timeline — paste as-is, never re-zero, never invent). Lines thus slide in top-to-bottom in spoken
  order (before-cluster → hero → after-cluster).
- `{le}` = the entrance duration, ONE closed form: `le = clamp(cueEnd − ld, 250, 500)` where
  `cueEnd = cueDelayMs(N+1)` for a non-last beat, `= round(durationSec×1000)` for the last beat (a line
  starting <500ms before the gate compresses so it still lands; floor 250).
- Each `.cue` gets inline `animation-delay:{cueDelayMs}ms; animation-duration:{winMs}ms`, where
  `winMs = cueDelayMs(N+1) − cueDelayMs(N)` (non-last), `= round(durationSec×1000) − cueDelayMs(N)` (last).
- Word gaps are ordinary single spaces inside the one `.ink` text node (the dropped-whitespace engine
  limit bites only BETWEEN sibling spans — a line keeps its words in ONE span, so the spaces render).
  `.slide` and `.ink` stay `display:inline-block`; never `display:block`.

## 5. EMPHASIS

The hero device IS the emphasis: exactly ONE word per beat, picked by the section-3 rule (digit wins,
else longest, else later), rendered on its own `.line.hero` — big yellow Oswald 700 with the hard maroon
offset block. Everything else is `.sup`. No second emphasis: no per-word colour swaps, no block on any
support word, no extra classes beyond `{hSIZE}` and the slide `{DIR}`.

## 6. BOUNDED VARIETY (pick per CONTENT, not randomly; default = the first value; state choices in the REPORT)

All axes reuse the skeleton's own mechanics (no new fonts/keyframes/timing) — every value is
pre-validated (inside margins, sized by the ladder, verify-clean).

1. **CUE ANCHOR** — which side each beat's `.cue` sits on, plus the shared slide-in direction that goes
   with it (an ANCHORS-type axis per `docs/recipe-format.md` — the one axis type allowed to touch
   placement):
   - `alternating` (DEFAULT, and the only validated value): beat `N` (1-indexed, in `word-timings.json`
     order) odd → `aL` (`left:64px`, text flush-left, every line `fromL`); `N` even → `aR` (`right:100px`,
     text flush-right, every line `fromR`). left, right, left, right … across the run — the direction
     always matches the anchor (sections 3–4). `top:740px; height:336px` never move (section 2).
2. **SCALE ARC** — the hero size trajectory hook→close:
   - `steady` (DEFAULT): every hero from the ladder as-is.
   - `punch-close`: the LAST beat's hero takes the NEXT-larger ladder class (one step up, never above
     `h132`); then re-check `0.576·fs·C ≤ 570` and, only if it fails, keep the steady class. Use when the
     last beat lands a payoff/number. (video1: beat 6 `MEETINGS` C8 h123 → h132; 0.576·132·8 = 608 > 570?
     use the measured 0.48·132·8 = 507 ≤ 570 ✓ → h132.)

An axis choice may NOT touch fonts, palette, keyframe mechanics, timing, or the DO NOTs beyond what its own
row states; CUE ANCHOR is the one axis permitted to move `.cue` horizontally (its entire purpose) — it may
never touch `top`/`height`.

## 7. VERIFY LOOP

First LINT (mechanical), then VERIFY (both outside any sandbox; the binary is not on PATH):

```
node --import tsx pipeline/scripts/lint-template.ts runs/<key>/final/template.wv
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Lint exit 1 → fix the named rule, re-lint. Verify exit 0 → record. Else apply the MECHANICAL fix for the
named element and re-run; at most 2 fix cycles:
- `FAIL[bounds] #b{N}h …` (hero too wide) → move that hero one class RIGHT in the section-3 table (next
  smaller). If it fails again, one more step.
- `FAIL[bounds] #b{N}s{K}` or `#b{N}a{K}` (a support line too wide) → RE-PAGINATE that cluster with
  `Ls+1` lines (section 3), keeping word order. (A support word never overflows alone at 42px.)
- `FAIL[bounds] … top/bottom outside` → the `.cue` `top` drifted: restore `top:740px`.
- `FAIL[bounds] #cue{N}` left/right outside → the anchor class drifted: restore it exactly (`aL` →
  `left:64px`, `aR` → `right:100px`); never blend the two or invent a third inset.
- `FAIL[never-visible] #cue{N}` → check the cue's inline `z-index:{10+N}`, `animation-name`
  (`cueGate`, or `cueHold` on the LAST beat only), `animation-delay`/`-duration`, and that the `<video>`
  is the first body element with `.vid` at z0.
- `FAIL[occluded] #… ` → two cue windows overlap: re-check every `winMs = cueDelayMs(N+1) − cueDelayMs(N)`
  and that cue z-indexes are exactly `10+N` in beat order (scrim sits at z1, below all cues).

Any FONT WARNING in verify/record output (`no italic face`, `no data/font-cache seed`, a fallback) = STOP,
do not record — a silent substitution falsifies the sizing math. (This sheet is upright-only precisely so
Oswald never triggers the italic substitution.)

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --progress-output --record {repo}/runs/<key>/final/out.silent.mp4
```

Then probe-qa (mechanical frame QA — the defects verify can't see):

```
npx @veedstudio/openedit-cli probe-qa runs/<key>
```

FAIL → report honestly and offer a `--seed`/`--style` re-run; do NOT redesign or auto-re-render. Warns
(mid-luminance ink over a bright t-shirt patch sits in the 2.0–3.5 band; a tail probe catching the 6% cue
fade) → mention and proceed to mux.

## 8. DO NOT

- No fonts, colours, shadows, sizes, or keyframes beyond this sheet: Oswald 600/700 UPRIGHT only (never
  `font-style:italic` — the engine has no Oswald italic and silently falls to upright), the four values
  `#ffde04` / `#f2ead2` / `#5a1808` / the `rgba(10,8,6,*)` scrim, and `cueGate`/`cueHold`/`slL`/`slR`/`rise`.
- The hard maroon offset block (`6px 9px 0`) is HERO-ONLY — never on a `.sup` line; support takes the one
  soft halo and nothing more. Do not stack a second shadow idiom on either.
- Never merge a line's two spans into one, and never place ANY transform (scaleX/skew/perspective/rotate)
  on the `.cue`, a `.line`, or any ancestor of the animated lines — it re-opens the over-video composite bug.
- No invented timing: every `{ld}` is a first-word `delayMs` from `word-timings.json` verbatim; `{le}`/`winMs`
  only via the section-4 closed forms; the scrim never animates.
- No `.slide`/`.ink` set to `display:block`; no shrink-to-fit flex around the animated lines (full-width
  `.line` blocks in the flex column, ONE `.slide` inside each); no descendant selectors — flat classes
  exactly as in the skeleton.
- Never read the video frames; never move the `.cue` beyond the two section-6 anchors (`aL`/`aR` by beat
  parity — no other placement improvisation, `top`/`height` never move); no `<br>`. No redesign after a verify/probe failure — only the section-7 mechanical fixes.
