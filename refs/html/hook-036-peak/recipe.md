# RECIPE — hook-036-peak (16:9 · 1280×720 @ 24fps)

RESOLUTION: px are authored at the 16:9 reference canvas 1280×720. FIRST STEP: SCALE = W/1280 from
`meta.json` (require |H − 720·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE and round (positions, widths, font sizes, the glow radii and the
grounding shadow's offset/blur); `em` values (the 0.26em word gaps) and ms timings never scale; the
manifest carries the run's real W/H.

Prefab is 1276×720; every px below is ALREADY at the reference canvas (factor ×1.003, precomputed —
copy numbers as written, never rescale against the prefab).

## 1. IDENTITY

A blend-into-footage caption system in glowing white Archivo Narrow, TYPED. Two tiers, ONE quiet
register: an all-caps 600-weight HEAD LINE hung from the TOP EDGE (its ink top pinned at y 50 on every
rung), and the rest of the sentence as a sentence-case 500-weight lower third centred on y 604 at TIGHT
leading (line-height 1.0). Both tiers run the SAME size ladder (30/27/24/21) with letter-spacing 0 —
the head line is not a hero, it is the sentence's opening words parked at the frame's top edge. The
reveal is a TYPEWRITER: glyphs pop on one at a time at their word's verbatim delay plus a 34ms
intra-word stagger, with a SINGLE cursor bar travelling the whole beat — head line first, then the
question stack. The ink is `#ffffff` / `#f8f6f4` under a four-layer white glow over a dark grounding layer plus one dark grounding
layer, so the type sits on the footage as light, not as a plate.

## 2. SKELETON

Paste this whole document as `runs/<key>/final/template.wv`, then add one `.cue` block per beat
(section 3) after the `<video>` element. Replace only `{videoPath}` (from `meta.json`) and `{DUR}`
(`durationSec`, manifest only). Canvas: see RESOLUTION at the top of this sheet.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700&family=Archivo+Narrow:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1280px; height: 720px; background: #000; overflow: hidden; }
  body { position: relative; }
  .vid { position: absolute; inset: 0; width: 1280px; height: 720px; object-fit: cover; z-index: 0; }

  /* beat gate — the one safe reveal recipe; delay + duration + z come inline per cue */
  @keyframes cueWin { 0%, 99.99% { opacity: 1; } 100% { opacity: 0; } }
  .cue { position: absolute; inset: 0; opacity: 0; animation-name: cueWin;
         animation-timing-function: linear; animation-fill-mode: forwards; }

  /* top-edge head line — a STATIC block (no block-level entrance, no transform): only the glyphs
     inside it animate. Full-width block + text-align (never shrink-to-fit flex). Letter-spacing is 0:
     Archivo Narrow is already condensed, and the glyph pops read as typing only on the natural fit.
     The four white layers ARE the glow; the last (dark, offset) layer is the grounding. */
  .hl { position: absolute; left: 0; width: 1280px; text-align: center; white-space: nowrap;
        font-family: 'Archivo Narrow', 'Archivo', sans-serif; font-weight: 600; line-height: 1.2;
        letter-spacing: 0; color: #ffffff;
        text-shadow: 0 0 4px #fff, 0 0 9px rgba(255,255,255,0.95), 0 0 18px rgba(255,255,255,0.7),
                     0 0 31px rgba(255,255,255,0.45), 0 1px 6px rgba(0,0,0,0.55); }
  .hw { display: inline-block; margin-right: 0.26em; }

  /* lower-third question — sentence case, same face one weight lighter; lines are full-width
     nowrap blocks in flow inside one positioned wrap. Leading is TIGHT (1.0, not 1.5): the stack
     must read as ONE block, never as airy separate rows. */
  .qw { position: absolute; left: 0; width: 1280px; }
  .ql { display: block; width: 1280px; text-align: center; white-space: nowrap;
        font-family: 'Archivo Narrow', 'Archivo', sans-serif; font-weight: 500; line-height: 1;
        letter-spacing: 0; color: #f8f6f4;
        text-shadow: 0 0 4px #fff, 0 0 9px rgba(255,255,255,0.95), 0 0 18px rgba(255,255,255,0.7),
                     0 0 31px rgba(255,255,255,0.45), 0 1px 6px rgba(0,0,0,0.55); }
  .w  { display: inline-block; margin-right: 0.26em; }

  /* TYPEWRITER: a glyph POPS on (no fade, no slide) at its delay… */
  .tg { display: inline-block; opacity: 0; animation: tOn 30ms linear both; }
  @keyframes tOn { 0% { opacity: 0; } 100% { opacity: 1; } }
  /* …and the cursor bar after it is visible ONLY until the next glyph types (window inline).
     width:0 + pre keeps it out of layout — it overhangs right after the glyph, same face and glow. */
  .cur { display: inline-block; width: 0; overflow: visible; white-space: pre; opacity: 0; }
  @keyframes curWin { 0% { opacity: 0; } 0.01%, 99.99% { opacity: 1; } 100% { opacity: 0; } }

  .h30 { font-size: 30px; } .h27 { font-size: 27px; } .h24 { font-size: 24px; } .h21 { font-size: 21px; }
  .q30 { font-size: 30px; } .q27 { font-size: 27px; } .q24 { font-size: 24px; } .q21 { font-size: 21px; }
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

One `.cue` per beat `{N}` of `word-timings.json`. Beat template — the `.hl` head line is always
present, the `.qw` wrap only when the beat has question words. Neither the `.hl` div nor the word
spans carry any animation: ONLY the glyph spans inside them do (section 4).

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N};animation-delay:{cueDelayMs}ms;animation-duration:{winMs}ms">
  <div class="hl {HS}" id="b{N}h" data-node-id="b{N}h" data-node-role="text"
       style="top:50px"><span class="hw">{TYPED GLYPHS}</span><!-- more head words, no whitespace between spans --></div>
  <div class="qw" style="top:{qTop}px">
    <div class="ql {QS}" id="b{N}q1" data-node-id="b{N}q1" data-node-role="text"><span class="w">{TYPED GLYPHS}</span><!-- more words, no whitespace between spans --></div>
    <!-- more .ql lines, ids b{N}q2, b{N}q3 -->
  </div>
</div>
```

**Window** (extends the gate to the next beat — no dead air between beats):
- `{winMs}` = next beat's `cueDelayMs` − this beat's `cueDelayMs`.
- Last beat: `{winMs}` = round(`durationSec`×1000 from `meta.json`) − its `cueDelayMs`.

**Word prep (before counting anything):** keep ALL punctuation exactly as in `word-timings.json`;
head-line words are UPPERCASED by you in the glyph text (no text-transform reliance); question words
keep their case as given. GLUE: a token starting with `-` (e.g. `-do` after `to`) merges with the previous
word into ONE unit for splitting and char counting (`TO-DO` = 5 chars); the merged unit renders inside a
SINGLE `.w`/`.hw` span (no `margin-right:0` patch is needed — there is only one gap), and each glued
token's glyphs type from its OWN verbatim `delayMs`.
Char count of a sequence = unit lengths + 1 per gap between units.

**Head/question split — deterministic, word order always preserved:**
- The HEAD LINE takes the longest PREFIX of the beat's units whose char count stays ≤ 12, and at
  least one unit (the first unit joins even if longer than 12 by itself). Greedily add units while
  the count is ≤ 12. The 12-char cap is what keeps the top line a short opening phrase — never raise
  it to fit more words; the words that don't fit are the lower third's job.
- All remaining units are QUESTION words. S = question unit count (S = 0 → no `.qw` wrap).

**Question line mapping:** L = min(3, ceil(S/3)) lines; base = floor(S/L); the first (S mod L) lines
take base+1 consecutive words, the rest take base.
- Examples: S=2 → one line · S=4 → 2,2 · S=5 → 3,2 · S=6 → 3,3 · S=7 → 3,2,2 · S=8 → 3,3,2.
- Never reorder or drop words.

**Sizing — `{HS}` for the head line, one `{QS}` shared by ALL the beat's question lines.** Ink budget
is 1126px (the 6% safe band x 77…1203). Advances are BUDGETED conservatively, not measured — the
narrow face is budgeted at the wider upright advance it replaced, so the ladders keep slack: caps 600
at 0.66em/char, mixed 500 at 0.60em/char, gaps counted as chars:

1. C_h = head-line char count; C_q = the LARGEST char count over the beat's question lines.
2. Head class by C_h (maxC(F) = floor(1126 / 0.66F)) — a ≤12-char head sits at `h30` always; the
   lower rungs only ever catch a pathologically long single first unit:

   | C_h ≤ 56 | 57–63 | 64–71 | ≥72 |
   |---|---|---|---|
   | `h30` | `h27` | `h24` | `h21` |

3. Question class by C_q (maxC(F) = floor(1126 / 0.60F)):

   | C_q ≤ 62 | 63–69 | 70–78 | ≥79 |
   |---|---|---|---|
   | `q30` | `q27` | `q24` | `q21` |

4. The ladders, ordered for the fix loop: head `h30 h27 h24 h21` · question `q30 q27 q24 q21`.
   The two tiers share the same sizes on purpose — ONE register, no accent rung.
5. HEIGHT is budgeted by construction: the head line is one nowrap line whose box starts at y 50 and
   spans at most 1.2 × 30 = 36px → y 50…86, clear of the top margin 43 and of everything below; the
   question stack is at most 3 lines × 1.0F ≤ 90px centred on y 604 → y 559…649, inside the bottom
   margin 677. No chrome exists to budget.

**Placement (closed forms, all px ×SCALE rounded):**
- Head line: `{headTop}` = 50 — CONSTANT on every rung. The line is anchored by its INK TOP at the top
  safe margin and grows DOWNWARD; a demotion shortens it from the bottom and never moves it. Never
  convert this back to a band centre.
- Question wrap: `{qTop}` = 604 − round(0.5 · F_q · L) — e.g. q30 L=1 → 589 · q30 L=2 → 574 ·
  q30 L=3 → 559 · q27 L=2 → 577.

**Worked example** (landscape-main beat 2 — 9 words `And I had to pay £55 to buy one`,
cueDelayMs 1720, cueDurMs 2880 → cueEnd 4600; next beat starts 4600 → winMs 2880):
- Head prefix: `AND`(3) → +I → 5 → +HAD → 9 → +TO → 12 ≤12 → +PAY → 16 >12, stop → head line
  `AND I HAD TO` (C_h = 12 → `h30`, top 50).
- Question S=5 → 3,2 → `pay £55 to` (C=10) / `buy one` (C=7) → C_q = 10 → `q30`, qTop 574.
- Typing (section 4): `AND` → A 1720 · N 1754 · D 1788 · `I` → 1880 · `HAD` → 2000/2034/2068 ·
  `TO` → 2120/2154; then the question: `pay` → 2240/2274/2308 · `£55` → 2720/2754/2788 ·
  `to` → 3960/3994 · `buy` → 4120/4154/4188 · `one` → 4360/4394/4428.
- Cursor windows follow that one sequence: 34,34,92 · 120 · 34,34,52 · 34,86 · 34,34,412 ·
  34,34,1172 · 34,126 · 34,34,172 · 34,34 and the final 350ms linger after `e`.

## 4. WORDS + TIMING

- Delays are absolute on the single timeline — paste as-is from `runs/<key>/word-timings.json`,
  never re-zero, never invent.
- Each beat's `.cue` gets inline `z-index:{10+N};animation-delay:{cueDelayMs}ms;
  animation-duration:{winMs}ms`.
- Per beat compute once: cueEnd = cueDelayMs + cueDurMs.
- **GLYPH (the only animated leaf).** Every word — head line and question alike — renders one span per
  glyph: `<span class="tg" style="animation-delay:{t}ms">{char}</span>`, HTML-escaped, no whitespace
  between spans. For glyph index `j` (0-based, restarting at each word — and at each token of a glued
  unit) of a word with verbatim `delayMs`:
  `t = max(delayMs, min(delayMs + 34·j, cueEnd − 100))`.
  The 34ms stagger IS the typing speed; the clamp keeps every glyph at least 100ms on screen before
  the gate closes (a word starting inside that tail types its whole run at once — deliberate, the
  alternative is glyphs that never render).
- **CURSOR.** Flatten the beat into ONE glyph sequence in reading order — the head line's words first,
  then the question stack line by line — and walk it: the cursor after glyph `i` runs from `t_i` until
  the next glyph types, i.e. `win = t_{i+1} − t_i`; after the LAST glyph of the beat `win = 350`
  (the linger). Emit
  `<span class="cur" style="animation:curWin {win}ms linear {t}ms both">|</span>` immediately after its
  glyph span, and DROP it entirely when `win < 12` — sub-half-frame windows are invisible anyway and,
  where VEED's word delays overlap (the next word starts before the previous word finished typing),
  a non-positive window would put two cursors on screen at once. Exactly ONE cursor is visible at any
  moment in the beat; that is the invariant the drop rule protects.
- Glyphs accumulate — every typed glyph HOLDS at full opacity until the cue gate cuts the beat. The
  beat's LAST structure holds and the gate cuts it: no fade-outs anywhere.
- Word spacing is the `.hw`/`.w` `margin-right` (0.26em on both tiers): the margin IS the gap, so it is
  exact at every size. Write spans adjacent with no whitespace between
  them. Spans stay `display:inline-block`.

## 5. EMPHASIS

STRUCTURAL — and it is POSITION plus the CURSOR, not scale. The beat's leading words are lifted out of
the sentence and parked at the top edge; the rest holds the lower third; the cursor crossing from one
to the other is what carries the eye. Both tiers run the same ladder deliberately: there is no accent
colour, no accent size, no underline, no separate accent/hero class. Never add one, and never re-open
the size gap between the tiers — if the head line ever shrinks, it is the ladder rescuing an overflow,
not a design choice.

## 6. VERIFY LOOP

Run (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Otherwise apply the MECHANICAL fix for the named element and re-run; at most 2 fix
cycles:
- `FAIL[bounds] #b{N}h … left/right outside` → that beat's head class one step DOWN the ordered
  head ladder (`h30`→`h27`→`h24`→`h21`); `{headTop}` stays 50. Fails again → one step more.
- `FAIL[bounds] #b{N}q{K} … left/right outside` → that beat's `{QS}` one step DOWN the ordered
  question ladder on ALL its question lines, recomputing `{qTop}`.
- `FAIL[bounds] … top/bottom outside` → same one-row step down for the flagged element (smaller
  type shrinks the stack); never move the y 50 / y 604 anchors, and NEVER widen the safe band — an
  overflowing line is a LAYOUT fix (the ladder), never a relaxed margin.
- `FAIL[never-visible]` → check that cue's inline `animation-delay`/`animation-duration` against
  `word-timings.json`, the class list is exactly `cue`, the `<video>` is the first body element at
  `z-index: 0`, and every animation-name resolves (`cueWin`/`tOn`/`curWin` spelled exactly).
- `FAIL[occluded]` → cue windows overlap or z-order is wrong: re-check each `{winMs}` equals the
  next beat's `cueDelayMs` minus this beat's, and every `.cue` has inline `z-index:{10+N}`.

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --progress-output --record {repo}/runs/<key>/final/out.silent.mp4
```

Manifest line (already given in section 2): `{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}` — W/H/FPS/DUR from `meta.json`.

## 7. DO NOT

- No fonts, colors, shadows, sizes, or keyframes beyond this sheet — Archivo Narrow 600/500, the two
  inks (`#ffffff`, `#f8f6f4`), the one five-layer glow + grounding shadow stack, `cueWin`/`tOn`/`curWin`
  and the h/q ladders are the whole system. No `filter: blur()` anywhere — the glow does the blending,
  a blur on typed glyphs only smears them.
- The glow stack is legibility hardware for white type over real footage — never slim it and never
  drop the dark grounding layer (light-on-light is invisible to `--verify`).
- Never track the type: `letter-spacing: 0` on both tiers. Archivo Narrow is condensed already;
  tightening it collapses the glyph pops into a smear.
- Never animate a word span, a line, or the `.hl` block — the glyph spans are the ONLY animated leaves
  (an animating span inside an animating-transform ancestor mis-composites in this engine). No
  block-level entrance, no rise, no per-word fades.
- Never emit two cursors at once: the beat is ONE glyph sequence, each cursor window ends where the
  next glyph types, and windows under 12ms are dropped. Never give `.cur` a blink keyframe — its
  window IS its life.
- No flex anywhere and no shrink-to-fit: head and question lines are full-width nowrap blocks
  centered by `text-align`.
- Never move the y 50 / y 604 anchors or the full-width x centering; never wrap text (nowrap +
  the ladders own overflow). The head line rides the TOP EDGE and the question stack the lower third —
  the empty middle band is the composition, not slack to be filled.
- Never loosen the question stack back toward line-height 1.5.
- No invented timing: every `delayMs`/`cueDelayMs` comes verbatim from `word-timings.json`; derived
  numbers ONLY via the closed forms in sections 3–4. No per-glyph or per-line fade-outs — the gate
  cuts each beat.
- No text-transform reliance — uppercase the head-line strings yourself; question words keep their case.
- Never animate `color` or `filter`; no `-webkit-text-stroke`.
- Never read the video frames; never re-derive layout; no redesign after a render or verify
  failure — only the mechanical fixes in section 6.
