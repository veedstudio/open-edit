> **AUTHORITY NOTE (2026-07-21):** `recipe.ts` next door is the single source of truth — the
> curation pass (design rounds v2–v6) edited the MODULE only and this sheet has NOT been synced.
> Do not recompile the module from this sheet until it is re-derived.

# hook-114-peak — recipe (9:16 · 736×1312 @ 25fps)

RESOLUTION: px are authored at the 9:16 reference canvas 736×1312. FIRST STEP: SCALE = W/736 from
`meta.json` (require |H − 1312·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE and round (positions, sizes, fonts, px spacing/shadows/margins/tops);
`em` values and ms timings never scale; the manifest carries the run's real W/H.

This sheet is precomputed for the 736×1312 canvas (prefab is 720-wide; every px below is already ×1.022
and re-inset into the run safe margins — do NOT rescale anything yourself). Inputs you use:
`runs/<key>/word-timings.json` (all delays, verbatim), `runs/<key>/meta.json` ({DUR}=durationSec,
{videoPath}), `transcript.json` (not needed — word-timings carries the text). Transcribe and substitute;
every decision is already made below.

## 1. IDENTITY

Hand-scrawled yellow marker captions (Gochi Hand) revealed glyph-by-glyph with a rising fade, each beat a
centered column of small "whisper" lead-in lines over one BIG punch line whose accent word pops in as a
whole word with a scale-overshoot — plus a hand-drawn double-squiggle underline doodle on the hook and
final beats.

## 2. SKELETON

Paste this whole document; replace only `{W} {H} {DUR} {videoPath}` (9:16 run → {W}=736, {H}=1312).
Then insert one `.cue` block per beat (section 3) before `</body>`.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Gochi+Hand&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: {W}px; height: {H}px; }
  body { position: relative; overflow: hidden; background: #101010; }

  .vid { position: absolute; inset: 0; width: {W}px; height: {H}px; object-fit: cover; z-index: 0; }

  /* beat gate — opacity-trap-safe: absolute + explicit z-index, gated on the cue itself */
  .cue { position: absolute; left: 46px; width: 608px; z-index: 12; opacity: 0;
         display: flex; flex-direction: column; align-items: center; gap: 31px;
         font-family: "Gochi Hand", cursive; color: #f5cf00; text-align: center;
         text-shadow: 0 2px 5px rgba(0,0,0,0.45); }
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }

  .lns { font-size: 45px; line-height: 1.3; padding-bottom: 0.16em; white-space: nowrap; }
  .lnb { line-height: 1.16; padding-bottom: 0.16em; white-space: nowrap; }

  /* per-glyph reveal (the ref's signature) */
  .g { display: inline-block; opacity: 0; animation: gIn .4s cubic-bezier(.2,.7,.3,1) both; }
  @keyframes gIn { 0%{opacity:0;transform:translateY(0.5em)} 100%{opacity:1;transform:translateY(0)} }

  /* accent word pops in as ONE word, overshooting its final size */
  .big { display: inline-block; opacity: 0; animation: bigPop .5s cubic-bezier(.2,.8,.25,1) both;
         transform-origin: 50% 75%; }
  @keyframes bigPop { 0%{opacity:0;transform:scale(.4)} 55%{opacity:1;transform:scale(1.28)} 100%{opacity:1;transform:scale(1)} }

  .doodle { display: block; opacity: 0; animation: gIn .4s cubic-bezier(.2,.7,.3,1) both; }
</style>
</head>
<body>
  <video class="vid" src="{videoPath}" muted></video>
  <!-- one .cue block per beat goes here, in beat order -->
</body>
</html>
```

Write `runs/<key>/final/manifest.json` EXACTLY:
`{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json`

## 3. PER-BEAT ASSEMBLY

Beat template (`{N}` = beat index, `{cueDelayMs}` `{cueDurMs}` verbatim from `word-timings.json`):

```html
<div class="cue" id="cue{N}" style="top:{TOP}px; animation:cueWin {cueDurMs}ms linear {cueDelayMs}ms forwards">
  <!-- 0-3 small lead-in lines -->
  <div class="lns" id="b{N}s1" data-node-role="text">…glyph spans…</div>
  <div class="lns" id="b{N}s2" data-node-role="text">…glyph spans…</div>
  <!-- exactly ONE punch line, always last text line -->
  <div class="lnb" id="b{N}p" data-node-role="text" style="font-size:{S}px">…glyph spans + one .big span…</div>
  <!-- doodle: ONLY on beat 1 and the final beat (section: doodle rule below) -->
</div>
```

### {TOP} — anti-collision slot table (fixed; never place two beats at the same top)
`slot = (N−1) mod 6`. All cues share `left:46px; width:608px`; tops are ≥80px apart by construction.

| slot | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| top | 150px | 438px | 246px | 534px | 342px | 630px |

If a run has more than 6 beats, beats 7–12 reuse slots 0–5 but with `left:86px; width:528px` inline on the
cue (a different x-anchor, so repeated tops are allowed). Never move a cue to another beat's exact top.

### Word → line mapping (deterministic, order always preserved)
Character counts always include the single spaces between words; word text is taken VERBATIM from
`word-timings.json` `words[].w` (keep punctuation, keep case).

1. **PUNCH** = start from the beat's LAST word; keep prepending the previous word while total chars ≤ 14.
   (Minimum 1 word. If the whole beat fits in 14 chars, PUNCH = the whole beat and there are no lead lines.)
2. **E** = the accent word inside PUNCH — pick per section 5.
3. **SETUP** = all words before PUNCH. If empty, skip lead lines.
   Split SETUP into `L = ceil(setupChars / 23)` lines (cap L at 3). Target `T = ceil(setupChars / L)`.
   Fill words in order: lines 1..L−1 take words until adding the next word would exceed T (never leave a
   line empty); line L takes everything left.
4. Small-line size fallback (per line, by that line's char count): ≤23 → 45px (the `.lns` default, no
   inline style) · 24–26 → inline `font-size:40px` · 27–30 → `font-size:34px` · 31–34 → `font-size:30px`.

### Punch sizing table ({S} = punch line size, {B} = accent size, by PUNCH chars incl. spaces)
Width-budgeted at 0.58em/char with the accent at 1.2× — never resize by eye, never widen the column.

| PUNCH chars | ≤9 | 10–11 | 12–13 | 14 | 15–17 | 18–20 |
|---|---|---|---|---|---|---|
| {S} px | 82 | 78 | 66 | 62 | 51 | 43 |
| {B} px | 98 | 94 | 79 | 74 | 61 | 52 |

(15+ rows exist only for the rare single word longer than 14 chars.) If PUNCH is a single word, it is E:
the line is just the one `.big` span at {B}.

### Worked example — `runs/fresh-test/word-timings.json`

| N | lead lines (45px unless noted) | punch (S/B) | E | top |
|---|---|---|---|---|
| 1 | "Okay, everyone" / "posts their" / "perfect little morning" | "routine." (82/98) | routine. | 150 |
| 2 | — | "Mine's a lie." (66/79) | Mine's | 438 |
| 3 | "actually" | "hate Mondays." (66/79) | Mondays. | 246 |
| 4 | "So here's how" | "I survive one." (62/74) | survive | 534 |
| 5 | "Coffee before words," / "zero eye contact with my" (24ch → 40px) | "to -do list," (66/79) | list, | 342 |
| 6 | "and honestly, we just" / "pretend the week starts" | "on Tuesday." (78/94) | Tuesday. | 630 |

### Doodle rule (fixed decoration — no judgment)
Beat 1 and the FINAL beat each get this exact SVG as the LAST flex child of their `.cue` (in-flow, centered
by the column — it stays ≥130px inside the left/right safe lines and inside the slot's height budget):

```html
<svg class="doodle" id="b{N}d" width="320" height="30" viewBox="0 0 320 30" style="animation-delay:{DD}ms"><path d="M6 12 C 60 4, 120 20, 180 10 S 300 14, 314 8" stroke="#f5cf00" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M20 24 C 90 18, 170 28, 300 20" stroke="#f5cf00" stroke-width="4" fill="none" stroke-linecap="round"/></svg>
```

`{DD} = min(E.delayMs + 250, cueDelayMs + cueDurMs − 460)`. No other beat gets a doodle; no other doodle
shape exists. (fresh-test: beat 1 → 2251ms, beat 6 → 11431ms.)

## 4. WORDS + TIMING

- The `.cue` gate is exactly the inline `animation:cueWin {cueDurMs}ms linear {cueDelayMs}ms forwards`
  from the template — never gate visibility any other way.
- **One span per GLYPH** (this ref is glyph-level), except E which is ONE `.big` span for the whole word:
  - glyph: `<span class="g" style="animation-delay:{d}ms">x</span>`
  - word spacer (between two words INSIDE the same line, never at line edges):
    `<span class="g" style="width:0.3em;animation-delay:{d}ms">&nbsp;</span>` — its `{d}` = the NEXT
    word's `delayMs`. Inter-span whitespace is not what sets the gap here; the spacer IS the space.
  - accent: `<span class="big" style="font-size:{B}px;animation-delay:{E.delayMs}ms">{E.w}</span>`
- Per-word glyph delays: word with `delayMs = d` and `g` glyphs → glyph k (k = 0…g−1) gets
  `d + k×st`. Default stagger `st = 45`. The word's `delayMs` is used VERBATIM as glyph 0's delay.
- **End clamp (prevents FAIL[never-visible] on tail words).** Let `cueEnd = cueDelayMs + cueDurMs` and
  `Lsafe = cueEnd − 450`. For each word: if `d + (g−1)×45 > Lsafe`, use
  `st = max(0, floor((Lsafe − d)/(g−1)))` for that word only. If additionally `d > Lsafe` (word starts too
  late for a 400ms entrance), give its glyphs the FULL inline shorthand
  `animation:gIn {cueEnd−d−40}ms cubic-bezier(.2,.7,.3,1) {d}ms both` (st = 0).
  Worked (fresh-test beat 2, cueEnd 3691, Lsafe 3241): "Mine's" d=2991 keeps st 45; "lie." d=3290 > Lsafe →
  all 4 glyphs get `animation:gIn 361ms cubic-bezier(.2,.7,.3,1) 3290ms both`.
- **Accent clamp.** If `E.delayMs + 560 > cueEnd`, write the full inline shorthand
  `animation:bigPop {cueEnd−E.delayMs−60}ms cubic-bezier(.2,.8,.25,1) {E.delayMs}ms both`.
  Worked (fresh-test beat 6): "Tuesday." 11570 + 560 > 11891 → duration 261ms.
- Complete worked line (fresh-test beat 3, punch, S=66/B=79):

```html
<div class="lnb" id="b3p" data-node-role="text" style="font-size:66px"><span class="g" style="animation-delay:4170ms">h</span><span class="g" style="animation-delay:4215ms">a</span><span class="g" style="animation-delay:4260ms">t</span><span class="g" style="animation-delay:4305ms">e</span><span class="g" style="width:0.3em;animation-delay:4530ms">&nbsp;</span><span class="big" style="font-size:79px;animation-delay:4530ms">Mondays.</span></div>
```

## 5. EMPHASIS

E = the accent word, always exactly one per beat, always inside PUNCH:
1. If any PUNCH word contains a digit (e.g. "$400", "10x"), that word is E (later one wins on tie).
2. Otherwise E = the PUNCH word with the most characters after stripping punctuation; tie → the later word.
E keeps its verbatim text and case; it is the only `.big` span in the beat.

## 6. VERIFY LOOP

Run from outside any sandbox:

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Otherwise apply the MECHANICAL fix for the named element and re-run (≤2 fix cycles):
- `FAIL[bounds]` left/right on a `b{N}p` punch line → drop that beat's {S}/{B} one table row; on a lead
  line → apply the next smaller small-line fallback size.
- `FAIL[bounds]` bottom → reduce that cue's `top` by the reported overshoot + 8px, but never by more than
  16px (the slot spacing head-room); if more is needed, drop the punch one size row instead.
- `FAIL[never-visible]` → that glyph's entrance ends after its cue's window: re-apply the End/Accent clamps
  of section 4 to the flagged word; confirm the cue kept `z-index:12` and its inline `cueWin` animation.
- `FAIL[occluded]` → confirm no two cues share a `top` (slot table) and every cue has `z-index:12`.

Then record (a SECOND invocation — verify and record are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --record {repo}/runs/<key>/final/out.silent.mp4
```

Manifest (must already exist, verbatim from section 2):
`{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json`

## 7. DO NOT

- No fonts, colors, shadows, or keyframes beyond this sheet (Gochi Hand + #f5cf00 + the three keyframes only).
- No invented timing: every `delayMs`/`cueDelayMs`/`cueDurMs` comes verbatim from `word-timings.json`;
  the only arithmetic allowed is the +45ms glyph stagger and the two clamps in section 4.
- Do not read frames, run ffmpeg, or eyeball renders; `--verify` is the only self-check.
- Do not change slot tops, `left:46px`, `width:608px`, or place two beats at the same coordinates.
- Do not add scrim boxes, do not animate `color`.
- Do not regroup words across the PUNCH/SETUP boundary or reorder words — ever.
