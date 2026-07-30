> **AUTHORITY NOTE (2026-07-21):** `recipe.ts` next door is the single source of truth — the
> curation pass (design rounds v2–v6) edited the MODULE only and this sheet has NOT been synced.
> Do not recompile the module from this sheet until it is re-derived.

# RECIPE — hook-045 (0-00-06-22) · giant-word overlay (9:16 · 736×1312 @ 25fps)

RESOLUTION: px are authored at the 9:16 reference canvas 736×1312. FIRST STEP: SCALE = W/736 from
`meta.json` (require |H − 1312·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE and round (positions, sizes, fonts, px spacing/shadows/margins/tops);
`em` values and ms timings never scale; the manifest carries the run's real W/H.

Prefab is a ~720×720 peak crop (not full-frame); its numbers were re-composed onto the full reference
canvas here — copy the numbers as written, never rescale or re-derive from the prefab again. The crop's
caption sat below the safe band and its giant word bled off the crop; both are re-anchored inside the
9:16 safe margins (top≥144, bottom≤1089, ink centered inside x 44…655) with all growth budgeted in
section 3.

## 1. IDENTITY

One MONUMENTAL all-caps League Gothic word per beat — ultra-condensed, near full-bleed, off-white over
the subject, revealed glyph by glyph left to right — with the full spoken line as a small Inter caption
near the bottom, words rising in on their real timing. Plain overlay: the prefab's text-behind-subject
occlusion machinery is gone (no masks, no clips) and must not be reinvented. The prefab's scaleX(0.5)
squeeze is also dropped — the condensation is the font's own (see DO NOT).

## 2. SKELETON

Paste this whole document as `runs/<key>/final/template.wv`, then insert one `.cue` block per beat
(section 3) after the `<video>` element. Replace only `{videoPath}` (from `meta.json`) and `{DUR}`
(`durationSec`, manifest only). Canvas: see RESOLUTION at the top of this sheet. The footage is
FULL-BLEED at z0 — no chrome covers it.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=League+Gothic&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 736px; height: 1312px; background: #000; overflow: hidden; }
  body { position: relative; }
  .vid { position: absolute; inset: 0; width: 736px; height: 1312px; object-fit: cover; z-index: 0; }

  /* beat gate — the one safe reveal recipe; z-index + delay + duration come inline per cue */
  @keyframes cueWin { 0%, 99.99% { opacity: 1; } 100% { opacity: 0; } }
  .cue { position: absolute; left: 0; top: 0; width: 736px; height: 1312px;
         opacity: 0; animation-name: cueWin; animation-timing-function: linear;
         animation-fill-mode: forwards; }

  /* the giant word — one per beat, holds for the whole beat (the gate cuts it). A full-width
     block centered by text-align (never shrink-to-fit flex), NO transform. The dark shadow is
     grounding: pure off-white glyphs vanish over light footage. */
  .big { position: absolute; left: 0; top: 144px; width: 736px; text-align: center;
         font-family: 'League Gothic', sans-serif; font-weight: 400;
         line-height: 0.72; letter-spacing: 0.004em; color: #f6f3f7; white-space: nowrap;
         text-shadow: 0 4px 28px rgba(0,0,0,0.40); }

  /* glyph reveal — opacity only, then HOLD. The vertical padding is mid-reveal shear headroom
     for the 0.72 line-height box — never remove it. */
  .c { display: inline-block; opacity: 0; padding: 0.14em 0 0.14em;
       animation-name: cIn; animation-duration: 140ms;
       animation-timing-function: cubic-bezier(.2,.7,.3,1); animation-fill-mode: both; }
  @keyframes cIn { 0% { opacity: 0; } 100% { opacity: 1; } }

  /* giant-word size ladder (fs = floor(1983/n) capped at 780 — section 3) */
  .B780 { font-size: 780px; }
  .B661 { font-size: 661px; }
  .B495 { font-size: 495px; }
  .B396 { font-size: 396px; }
  .B330 { font-size: 330px; }
  .B283 { font-size: 283px; }
  .B247 { font-size: 247px; }
  .B220 { font-size: 220px; }
  .B198 { font-size: 198px; }
  .B180 { font-size: 180px; }
  .B165 { font-size: 165px; }
  .B152 { font-size: 152px; }
  .B141 { font-size: 141px; }
  .B132 { font-size: 132px; }
  .B123 { font-size: 123px; }
  .B116 { font-size: 116px; }
  .B110 { font-size: 110px; }
  .B104 { font-size: 104px; }
  .B99  { font-size: 99px; }
  .B82  { font-size: 82px; }
  .B70  { font-size: 70px; }

  /* a caption page = one single-line subtitle; pages of a beat sit at one anchor and take turns.
     PLAIN BLOCKS on purpose (no flex); each mid-beat page carries ONE inline fade-out (pgOut). */
  .pg { position: absolute; left: 0; top: 1030px; width: 736px;
        animation-name: pgOut; animation-duration: 250ms; animation-timing-function: ease;
        animation-fill-mode: forwards; }
  @keyframes pgOut { from { opacity: 1; } to { opacity: 0; } }

  /* caption line — full-width block, ink centered by text-align, nowrap so the sizing table's
     width math holds */
  .cl { display: block; width: 736px; text-align: center;
        font-family: Inter, sans-serif; font-weight: 500; letter-spacing: 0.004em;
        color: #fbfbfb; white-space: nowrap;
        text-shadow: 0 1px 5px rgba(0,0,0,0.55); }

  /* caption size ladder */
  .s34 { font-size: 34px; }
  .s31 { font-size: 31px; }
  .s28 { font-size: 28px; }
  .s25 { font-size: 25px; }
  .s22 { font-size: 22px; }

  /* caption word reveal — rise + eased fade IN, then HOLD; the page-level pgOut is the only
     fade-out. Word gap = the margin (never spacer spans); the vertical padding is shear headroom. */
  .w { display: inline-block; opacity: 0; margin-right: 0.26em; padding: 0.08em 0 0.15em;
       animation-name: wIn; animation-duration: 380ms;
       animation-timing-function: cubic-bezier(.2,.7,.3,1); animation-fill-mode: both; }
  @keyframes wIn { 0% { opacity: 0; transform: translateY(0.28em); } 100% { opacity: 1; transform: none; } }
</style>
</head>
<body>
  <video class="vid" src="{videoPath}" muted></video>
  <!-- one .cue block per beat goes here, in beat order -->
</body>
</html>
```

`manifest.json` (verbatim, `{DUR}` = `durationSec` from `meta.json`):

```json
{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json
```

## 3. PER-BEAT ASSEMBLY

One `.cue` per beat `{N}` of `word-timings.json`. Placement is FIXED. Giant word: box top 144 (the top
safe line); measured League Gothic metrics (calibration render at 736 wide, the exact `.big`/`.c`
construct): advance 0.355×fs per char (caps-alphabet average incl. the 0.004em tracking), ink top =
box top + 0.123×fs, ink height 0.751×fs → worst-case ink bottom = 144 + 0.874×780 = 826, far above the
caption. Ink budget 704px centered (16px edge guard each side): fs = floor(1983/E), capped at 780.
Caption: anchor top 1030; Inter-500 caps budget 0.60×fs per char (measured, gaps included at the char
count below); ink ≤ 26×0.60×34 = 530 ≤ 574 centered (inside x 81…655, safe both sides); ink bottom
≈ 1030 + 1.23×34 = 1072 ≤ 1089 (the bottom safe line). Beat template — one `.big` per beat, one `.c`
span per glyph of the DISPLAY word, one `.pg` per caption page, one `.cl` line per page, one `.w` span
per word:

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N}; animation-delay:{cueDelayMs}ms; animation-duration:{winMs}ms;">
  <div class="big B{FS}" id="b{N}big" data-node-id="b{N}big" data-node-role="text"><!-- glyph spans --></div>
  <div class="pg" style="animation-delay:{pgOutMs}ms">
    <div class="cl s{fs}" id="b{N}p1l1" data-node-id="b{N}p1l1" data-node-role="text"><!-- word spans --></div>
  </div>
  <!-- more .pg blocks (p2, p3, …) as the paging rule produces them, each with its own {pgOutMs};
       EXCEPTION: the beat's LAST .pg gets style="animation:none" instead (it holds; the gate cuts it) -->
</div>
```

**Window** (extends the gate to the next beat so fade-outs finish — pure subtraction):
- `{winMs}` = next beat's `cueDelayMs` − this beat's `cueDelayMs`.
- Last beat: `{winMs}` = round(`durationSec`×1000 from `meta.json`) − its `cueDelayMs`.
- `{gateEnd}` = this beat's `cueDelayMs` + `{winMs}`.

**Word prep:** UPPERCASE every token yourself (no text-transform in the CSS); keep ALL punctuation
exactly as in `word-timings.json`. GLUE: a token starting with `-` (e.g. `-DO` after `TO`) merges with
the previous word into ONE unit for paging and char counting (`TO-DO` = 5 chars); it renders as two
adjacent caption spans — the previous span gets inline `margin-right:0` — each keeping its OWN verbatim
`delayMs`. Char count of a page = letters + punctuation + 1 per space between its units.

**Giant word (the beat's DISPLAY word):** the beat's hero unit (section 5). Its display copy = the
unit's span texts joined, then leading/trailing characters outside A–Z/0–9 stripped (`THING.` → `THING`,
`10,000` stays `10,000`); if stripping empties the string, use the joined text unchanged.
E = the display copy's length + 0.45 per `W` + 0.35 per `M` (the two glyphs measured far above the
0.355em average — a never-visible clip has no mechanical fix, so width must fit by construction).
Size class = the first row fitting E:

| E ≤ 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 24 | above |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B780 | B661 | B495 | B396 | B330 | B283 | B247 | B220 | B198 | B180 | B165 | B152 | B141 | B132 | B123 | B116 | B110 | B104 | B99 | B82 | B70 |

One `<span class="c">` per glyph of the display copy, in order.

**Caption paging rule** — walk the beat's units left to right (ORDER PRESERVED, every unit used once):
a page takes units while BOTH hold: total page chars (incl. gaps) ≤ 26 AND ≤ 6 units. Stop before the
first violation; remaining units start the next page. An oversized single unit still gets its own page.
Every page is ONE line (`.cl`, nowrap). Size class = the first row fitting the page's char count C:

| C ≤ 26 | 27–30 | 31–34 | 35–38 | above |
|---|---|---|---|---|
| s34 | s31 | s28 | s25 | s22 |

**Worked example** (portrait-main fixture beat 1 — `So I built an app that does one thing.`,
cueDelayMs 320, next beat 2080 → winMs 1760, gateEnd 2080):
- units (9): SO 320 · I 400 · BUILT 520 · AN 720 · APP 840 · THAT 1000 · DOES 1160 · ONE 1400 · THING. 1680
- hero = THING. (no digits; longest incl. punctuation, 6 chars) → display copy `THING`, E = 5 (no W/M)
  → `B396` (width 5×0.355×396 ≈ 703 ≤ 704)
- glyph stagger (section 4): min(70, floor((2080−140−320)/4)) = 70 → T 320 · H 390 · I 460 · N 530 ·
  G 600, all at the default 140ms (600+140 ≤ 2080 — no compression)
- caption p1 `SO I BUILT AN APP THAT` (22 chars, 6 units — DOES would be unit 7) → `s34`;
  p2 `DOES ONE THING.` (15 chars) → `s34`
- p1 `{pgOutMs}` = max(1160−250, 1000) = **1000**; p2 holds (`animation:none`)
- no caption entrance compression: 1680+380 = 2060 ≤ 2080

(Fixture beat 2: POINTLESS and MEETINGS. tie at 9 chars → the LATER wins → display `MEETINGS`,
E = 8 + 0.35 = 8.35 → `B220`; pages `IT KILLS POINTLESS` (18c, s34) + `MEETINGS.` (9c, s34); p1
pgOutMs = max(3200−250, 2800) = 2950. Fixture beat 5: `10,000` bears digits → hero; display `10,000`,
E = 6 → `B330`; one page `10,000 HOURS SAVED.` (19c, s34).)

## 4. WORDS + TIMING

- One `<span class="w">` per caption token, inline `animation-delay:{delayMs}ms` — that word's `delayMs`
  from `runs/<key>/word-timings.json`, VERBATIM (delays are absolute on the single timeline — never
  re-zero, never invent). Word gaps are the `.w { margin-right: 0.26em }` — never insert empty spacer
  spans. Spans stay `display:inline-block`; a glued `-` unit is two adjacent spans with the first span's
  `margin-right` zeroed inline.
- **Caption entrance compression at the gate:** if `delayMs + 380 > gateEnd`, that span ALSO gets inline
  `animation-duration:{max(gateEnd − delayMs, 250)}ms`; otherwise no inline duration.
- **Giant-word glyph timing:** the k-th glyph (k = 0…n−1) gets inline
  `animation-delay:{cueDelayMs + k·STAG}ms` with
  `STAG` = n>1 ? min(70, max(0, floor((gateEnd − 140 − cueDelayMs) / (n−1)))) : 0 — the reveal leads the
  beat from `cueDelayMs` and always completes inside the gate. If a glyph's `delay + 140 > gateEnd`
  (window shorter than one entrance), it ALSO gets inline `animation-duration:{max(gateEnd − delay, 100)}ms`.
  The giant word never fades: it HOLDS and the `.cue` gate cuts it.
- Each mid-beat `.pg` gets inline `animation-delay:{pgOutMs}ms` with
  `{pgOutMs}` = max(nextPageFirstWordDelayMs − 250, thisPageLastWordDelayMs) — the 250ms fade COMPLETES
  as the successor's first word rises. The beat's LAST `.pg` gets NO pgOut: inline `animation:none` —
  it HOLDS and the beat's `.cue` gate cuts it at `{gateEnd}` (fading it leaves dead-air at every beat
  end).
- The beat's `.cue` gets inline `z-index:{10+N}; animation-delay:{cueDelayMs}ms;
  animation-duration:{winMs}ms` exactly as in section 3.
- Span examples:
  `<span class="c" style="animation-delay:390ms">H</span>`
  `<span class="w" style="animation-delay:1680ms">THING.</span>`

## 5. EMPHASIS

The giant word IS the emphasis device — exactly ONE hero unit per beat, rendered monumental; the
caption itself is uniform (every word identical `#fbfbfb`, no accent class, no size change). Hero pick
rule, no judgment:
1. Any unit containing a digit wins (the first such unit if several).
2. Otherwise the LONGEST unit of the beat (chars, punctuation included).
3. Tie → the LATER unit.
The hero word also stays in the caption (the spoken line is never thinned).

## 6. VERIFY LOOP

Run (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Otherwise apply the MECHANICAL fix for the named element and re-run; at most 2 fix
cycles:
- `FAIL[bounds] #b{N}big …` → move that beat's giant word one row DOWN its ladder (`B780`→`B661`→…).
  Same beat again → one more row. Never widen the budget, never move the anchor.
- `FAIL[bounds] #b{N}p{P}l1 …` → move that caption PAGE one row DOWN its ladder (`s34`→`s31`→…).
- `FAIL[never-visible]` on a span or cue → that word was pasted into the WRONG beat's `.cue` or the cue
  is missing its inline `z-index:{10+N}` / delay / duration; also confirm the `<video>` is the first
  body element with `class="vid"` (z0).
- `FAIL[occluded]` → two cue windows overlap: re-check each `{winMs}` equals the next beat's
  `cueDelayMs` minus this beat's and every `.cue` has `z-index:{10+N}`.

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --record {repo}/runs/<key>/final/out.silent.mp4
```

Manifest line (already given in section 2): `{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json`

## 7. DO NOT

- No fonts, colors, shadows, sizes, or keyframes beyond this sheet — League Gothic + Inter,
  `#f6f3f7`/`#fbfbfb` on footage, the two text-shadows, the twenty-one B-rows, the five s-rows and the
  four keyframe blocks are the whole system.
- No invented timing: every caption `animation-delay` comes VERBATIM from `word-timings.json`; glyph
  delays only via the STAG formula; inline durations only via the two compression formulas; page fades
  only via the pgOut formula.
- No occlusion: do not reinvent masks, clip-paths, or a text-behind-subject layer — the giant word is a
  plain overlay above the footage (its stale `text-behind-occlusion` tag describes machinery this prefab
  no longer has).
- No caption accent class, no second colour, no per-word size change — the giant word is the only
  emphasis.
- Do not re-add the prefab's flex centering or `.sp` spacer spans; do not change line-height 0.72 or
  the letter-spacing. Do not re-add the prefab's scaleX(0.5) squeeze — `--verify` measures glyph ink
  PRE-transform, so parent-scaled monumental text false-fails (and shears at these sizes).
- Never animate `color` or `filter:blur`; never put `var()` inside a transform or keyframes; no `vw`
  font sizes; single-value `border-radius` only (none is used here).
- No text-transform reliance — uppercase the strings yourself.
- Never read the video frames, never run ffmpeg checks — `--verify` is the only self-check.
- No redesign after render or a verify failure — only the mechanical fixes in section 6.
