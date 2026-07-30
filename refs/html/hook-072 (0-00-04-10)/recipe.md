# RECIPE — hook-072 (0-00-04-10) (16:9 · 1280×720 @ 24fps)

RESOLUTION: px are authored at the 16:9 reference canvas 1280×720. FIRST STEP: SCALE = W/1280 from
`meta.json` (require |H − 720·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE and round (positions, widths, heights, font sizes, line-heights,
paddings, radii, tick/tail geometry — for the tick SVG scale only its `width`/`height` attributes and
the `.tk`/`.tkS` boxes; the `viewBox`, polyline points, and stroke-width stay verbatim and ride the
viewport scale); `em` values and ms timings never scale; the manifest carries the run's real W/H.

Prefab is 960×720; the composition below is RE-COMPOSED for the wide 1280×720 frame (a centered chat
column; type scaled ×1.333 from the prefab's 27px) — copy numbers as written, never rescale against the
prefab.

## 1. IDENTITY

A WhatsApp-style chat conversation over the footage: dark-green outgoing bubbles (right-aligned in the
column, timestamp + double ticks) alternate with dark-slate incoming bubbles (left-aligned, timestamp
only), white clean-sans text, a small tail at each bubble's anchored bottom corner; each message POPS in
with a scale-in overshoot at the moment its first word is spoken and messages stack upward chat-style;
one hero word per beat flips to the mint accent.

## 2. SKELETON

Paste this whole document as `runs/<key>/final/template.wv`, then add one `.cue` block per beat after
the `<video>` element (section 3). Replace only `{videoPath}` (from `meta.json`) and `{DUR}`
(`durationSec` from `meta.json`, manifest only). Canvas: see RESOLUTION at the top of this sheet. The
fonts are the prefab's system stack — no `@import` needed.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1280px; height: 720px; }
  body { background: #000; overflow: hidden; position: relative; }
  .vid { position: absolute; inset: 0; width: 1280px; height: 720px; object-fit: cover; }

  /* window gate — the one safe reveal recipe; delay+duration+z come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position: absolute; left: 0; top: 0; width: 1280px; height: 720px; opacity: 0; z-index: 11;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* message pop — rides the padded wrapper (the engine clips an opacity-animating element to its border
     box, so the protruding tail lives inside the wrapper's padding); visuals live on the skin */
  @keyframes pop { 0% { opacity: 0; transform: scale(0.6); }
                   65% { opacity: 1; transform: scale(1.05); }
                   100% { opacity: 1; transform: scale(1); } }
  .bub { position: absolute; opacity: 0; z-index: 1;
         animation-name: pop; animation-timing-function: cubic-bezier(.2,.7,.3,1);
         animation-fill-mode: both; }
  .out { transform-origin: 100% 100%; padding-right: 9px; }
  .in  { transform-origin: 0% 100%;  padding-left: 9px; }

  /* asymmetric 21/11 padding: the engine seats the 36/45 line ~5px high in the box — this centers
     the ink optically (measured); height stays 21+45+11 = 77 */
  .skOut { position: relative; background: #124c34; border-radius: 19px;
           border-bottom-right-radius: 0; padding: 21px 18px 11px 18px; }
  .skIn  { position: relative; background: #233138; border-radius: 19px;
           border-bottom-left-radius: 0; padding: 21px 18px 11px 18px; }

  .ln { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 36px; font-weight: 400;
        line-height: 45px; color: #ffffff; white-space: nowrap; text-align: left; }
  .wd { display: inline-block; margin-right: 0.28em; }
  .hero { color: #9fceb8; }

  /* meta ride the text line's optical axis: time +2px, tick box +3px (measured seats) */
  .tmO { display: inline-block; position: relative; top: 2px; margin-left: 8px; font-family: "Helvetica Neue", Arial, sans-serif;
         font-size: 20px; font-weight: 400; line-height: 20px; color: #9fceb8; }
  .tmI { display: inline-block; position: relative; top: 2px; margin-left: 8px; font-family: "Helvetica Neue", Arial, sans-serif;
         font-size: 20px; font-weight: 400; line-height: 20px; color: #8d9ba3; }
  .tk  { display: inline-block; position: relative; top: 3px; margin-left: 4px; width: 28px; height: 18px; }
  .tkS { display: block; width: 28px; height: 18px; }
  .tlO { position: absolute; bottom: 0; left: 100%; margin-left: -2px; width: 11px; height: 20px;
         background: #124c34; clip-path: polygon(0% 0%, 0% 100%, 100% 100%); }
  .tlI { position: absolute; bottom: 0; right: 100%; margin-right: -2px; width: 11px; height: 20px;
         background: #233138; clip-path: polygon(100% 0%, 100% 100%, 0% 100%); }
</style>
</head>
<body>
  <video class="vid" style="z-index:0" src="{videoPath}" muted></video>
  <!-- one .cue block per beat goes here, in beat order -->
</body>
</html>
```

`manifest.json` (verbatim, `{DUR}` = `durationSec` from `meta.json`):

```json
{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json
```

## 3. PER-BEAT ASSEMBLY

One `.cue` per beat in `word-timings.json`; inside it one BUBBLE per message. Beat template (`{N}` =
beat `i`):

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N};animation-delay:{cueDelayMs}ms;animation-duration:{cueDurMs}ms">
  <!-- one bubble per message, in message order (section: bubbles below) -->
</div>
```

**Word prep (before counting anything):** strip a trailing `.` or `,` from each word's DISPLAY text;
keep `?` `!` `'` and any INTERNAL punctuation (`10,000` stays as is). GLUE: a token starting with `-`
(e.g. `-do` after `to`) merges with the previous word into ONE unit — display them concatenated with no
space (`to-do`), count as one unit of 5 chars; the unit's delayMs is the FIRST token's. charLen below =
display length after stripping. Words stay sentence-case as spoken — never uppercase them.

**Message split — deterministic, word order always preserved:**
- A PUNCTUATION BOUNDARY sits after unit k when its RAW token (before stripping) ends with `.` `,` `!`
  or `?`, unless k is the beat's last unit.
- Walk the beat's units left→right building messages: start message 1 with unit 1. After appending a
  unit: if it carries a punctuation boundary → CLOSE the message (the next unit starts a new one).
  Otherwise, if appending the NEXT unit would push the message's char count over 18 — char count = sum
  of charLens + 1 per gap — CLOSE the message. Else append and continue.
- A single unit with charLen > 18 forms its own message (and drops its meta spans — see the width note).
- K = the beat's message count. Message text = its units joined by single spaces, rendered as `.wd`
  spans (one per unit).

**Sides — one GLOBAL counter g across the whole video** (beats in order, messages in order, starting at
g = 1): g odd → OUT bubble (green, right edge of the column, time + ticks); g even → IN bubble (slate,
left edge, time only). The counter never resets between beats.

**Placement (centered column — fixed, no left/right variant):** every bubble is one single-line bubble
of height 77 stacked bottom-up from stackBottom 640:

- `top` of message j (j = 1..K): `top_j = 563 − (K − j)·87`  (563 = 640 − 77; pitch 87 = 77 + 10 gap).
- OUT bubbles: inline `right:395px` (right edge at x 885). IN bubbles: inline `left:395px` (left edge at
  x 395) — the two anchors are equal and symmetric about the frame's x 640 center, so the bubble group
  reads as horizontally centered.
- The bubble's width is NOT set — it shrink-wraps its single line exactly. One `.ln` per bubble, always
  (the engine sums the max-content widths of MULTIPLE block children inside a shrink-to-fit box instead of
  taking the max — a second line balloons the bubble).
- Width budget (pre-validated, no math needed per bubble): 18-char line + meta ≤ 452px; with the 1.05
  overshoot IN's right edge reaches ≤ 870 and OUT's left edge reaches ≥ 410 — the pop stays inside its
  own resting envelope x 395..885, well inside x 77..1203 / y 43..676 for K ≤ 6.

**Bubble templates.** OUT (g odd):

```html
<div class="bub out" id="b{N}m{j}" data-node-id="b{N}m{j}"
     style="z-index:{j};right:395px;top:{top_j}px;animation-delay:{msgDelayMs}ms;animation-duration:{popMs}ms">
  <div class="skOut">
    <div class="ln" id="b{N}m{j}l" data-node-id="b{N}m{j}l" data-node-role="text"><span class="wd">{word}</span><span class="wd" style="margin-right:0">{lastWord}</span><span class="tmO" id="b{N}m{j}t" data-node-id="b{N}m{j}t" data-node-role="text">{TIME}</span><span class="tk"><svg class="tkS" width="28" height="18" viewBox="0 0 28 18"><polyline points="1.5,9.8 6.2,14.4 14.2,3.6" fill="none" stroke="#9fceb8" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></polyline><polyline points="9.8,9.8 14.5,14.4 22.5,3.6" fill="none" stroke="#9fceb8" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></polyline></svg></span></div>
    <i class="tlO"></i>
  </div>
</div>
```

IN (g even): classes `bub in` / `skIn` / `tmI` / `tlI`, inline `left:395px` instead of `right`, and NO
`.tk` span. In both: word spans adjacent with no whitespace between them; ONLY the message's LAST word
span gets inline `margin-right:0`; the time span follows the last word; the tail `<i>` is the skin's
last child. The tail is the ONLY absolutely-positioned child allowed inside the skin (any other abs
child inflates the bubble's intrinsic size — measured engine behavior).

**Time text:** every bubble of beat N shows `14:{20+N}` (beat 1 → `14:21`, beat 6 → `14:26`).

**Worked example 1** (9 words, punctuation: `Then one quick story, one phone call, Boom.`, cueDelayMs
6240, cueDurMs 3680, first-word delays 6240/7000/7680/8880): boundaries after `story,` and `call,`;
greedy 18 inside segment 1: `Then one quick` (14; +story → 20 > 18) closes → messages `Then one quick` /
`story` / `one phone call` / `Boom` → K = 4; tops 302 / 389 / 476 / 563; sides continue the global
counter; pops at 6240, 7000, 7680, 8880 (each message's FIRST word).

**Worked example 2** (9 words, no punctuation: `So I built an app that does one thing.`, cueDelayMs 320,
cueDurMs 1760): greedy → `So I built an app` (17) / `that does one` (13) / `thing` → K = 3, tops
389/476/563; pops at 320, 1000, 1680; cueEnd = 2080 so the last message's avail = 400 < 500 → popMs =
max(250, 400 − 100) = 300 (section 4).

## 4. WORDS + TIMING

- Delays are absolute on the single timeline — paste as-is from `runs/<key>/word-timings.json`, never
  re-zero, never invent.
- Each beat's `.cue` gets inline `animation-delay:{cueDelayMs}ms;animation-duration:{cueDurMs}ms`
  verbatim, plus `z-index:{10+N}`.
- Each bubble pops at its FIRST word: `{msgDelayMs}` = that word's `delayMs` VERBATIM.
- Pop duration: cueEnd = cueDelayMs + cueDurMs; avail = cueEnd − msgDelayMs;
  `popMs = 400` if avail ≥ 500, else `max(250, avail − 100)` (a message spoken just before the gate
  closes must still finish popping). Always write `animation-duration:{popMs}ms` inline.
- Bubbles accumulate — a popped message HOLDS until the cue gate cuts the beat. No fade-outs anywhere.
- Word spacing is the `.wd` `margin-right: 0.28em` — inter-span whitespace is dropped by the engine,
  the margins ARE the gaps. Spans stay `display:inline-block`; never `display:block`.
- Inside a bubble the words are STATIC (the bubble is the animated unit) — never give word spans their
  own reveal animation (animated children inside a shrink-to-fit box mis-lay-out).

## 5. EMPHASIS

Exactly ONE hero word per beat: its `.wd` span additionally gets class `hero` (`class="wd hero"`, plus
inline `margin-right:0` if it is a message's last word) — it renders in the mint accent `#9fceb8` (the
ref's tick/time color). Pick rule, no judgment:
1. Any word containing a digit wins (the FIRST such word if several).
2. Otherwise the LONGEST word of the beat (charLen after stripping).
3. Tie → the LATER word.
Nothing else changes for the hero — same size, same weight (the engine renders "Helvetica Neue" bold as
regular, so a weight-based hero would silently do nothing — the hero is COLOR).

## 6. BOUNDED VARIETY

Pick per axis by the RULES below, state choices in the REPORT.

1. **DEVICE INTENSITY** — `standard` (default: every bubble carries its meta — OUT time + ticks, IN
   time) · `minimal`: no `.tmO`/`.tmI`/`.tk` spans anywhere (text-only bubbles; nothing else changes).
   Rule: `minimal` only when the DIRECTION (execution contract) explicitly asks for calm/subtle/minimal energy; else
   `standard`.

## 7. VERIFY LOOP

Run (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Otherwise apply the mechanical fix for the flagged element and re-run; at most 2 fix
cycles:
- `FAIL[bounds] #b{N}m{j}... left/right outside` → that message over-ran the width budget: re-split
  THAT beat with the greedy limit 16 instead of 18, rebuild the beat's bubbles and tops (K may grow).
  If the offender is a single word longer than 16 chars, drop that bubble's meta spans instead.
- `FAIL[bounds] ... top/bottom outside` → re-check the beat's tops equal 563 − (K−j)·87 (·SCALE) and
  that every bubble has exactly one `.ln`.
- `FAIL[never-visible]` → check that cue's inline `animation-delay`/`animation-duration` match
  `word-timings.json`, the class lists (`cue`, `bub out`/`bub in`), the `<video>` is the first body
  element with `style="z-index:0"`, and the only animation names used are `cueWin` and `pop` (a typo'd
  name never animates in).
- `FAIL[occluded] #b{N}...` → cue windows overlap: cue N's `animation-duration` must not exceed
  `cueDelayMs(N+1) − cueDelayMs(N)`; if it does, set it to that difference. Confirm inline z-index is
  10+N in beat order.

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --progress-output --record {repo}/runs/<key>/final/out.silent.mp4
```

Manifest line (already given in section 2): `{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}` — W/H/FPS/DUR from `meta.json`.

## 8. DO NOT

- No fonts, colors, shadows, sizes, or keyframes beyond this sheet — the system-sans stack at weight
  400, the five inks (`#124c34`, `#233138`, `#ffffff`, `#9fceb8`, `#8d9ba3`), `cueWin`/`pop`, and the
  fixed type scale (36/45 msg, 20/20 time) are the whole system.
- Never add a second `.ln` to a bubble and never set an explicit width on `.bub`/`.skOut`/`.skIn` —
  single-line shrink-wrap IS the width system.
- Never re-introduce the prefab's flex skin, and never absolutely-position anything inside the skin
  except the tail.
- Never anchor an OUT bubble by `left` or an IN bubble by `right`, and never change the
  `transform-origin`s — the anchored bottom corner is the pop's fixed point; it keeps the 1.05
  overshoot growing INTO the column.
- No invented timing: every `delayMs`/`cueDelayMs`/`cueDurMs` comes verbatim from `word-timings.json`;
  derived numbers ONLY via the closed forms in sections 3-4.
- Bubbles accumulate and the gate cuts the beat — never add fade-outs, and never animate word spans.
- No `text-align: center/right`; letter-spacing stays 0; no descendant selectors — flat classes only.
- Never animate `color`; never put `var()` in transforms or keyframes; no `vw` font sizes; keep the
  tail `clip-path` polygons percentage-based (px/unitless coords get dropped by the engine).
- The double tick is the skeleton's inline SVG verbatim — literal-hex `stroke`, `fill="none"`, px-only
  coords, no percentage transforms; never rebuild it from `clip-path`/borders (mangles at final scale).
- Never read the video frames; never re-derive layout; no redesign after a render or verify failure —
  only the mechanical fixes in section 7.
