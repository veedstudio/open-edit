# RECIPE — hook-158-peak (16:9 · 1280×720 @ 24fps)

RESOLUTION: px are authored at the 16:9 reference canvas 1280×720. FIRST STEP: SCALE = W/1280 from
`meta.json` (require |H − 720·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px value by SCALE (positions, font sizes, the px glow/grounding shadow
offsets/blurs) — authored integers round, DERIVED lefts and tops stay fractional (never force-round a
computed left/top); the SOLVED `em` letter-spacings and the ms timings never scale (an em tracking
scales with its font size on its own, which is exactly what keeps the justified block justified); the
manifest carries the run's real W/H.

Prefab is a 960×720 flat poster on solid near-black `#0a0e16`; the composition below is RE-COMPOSED
for the wide 1280×720 frame over FULL-BLEED footage — the opaque background is dropped (it would
occlude the video; a dark grounding shadow under the prefab's white glow replaces it) and the type
scale is carried at the shared 720px height. Copy numbers as written, never rescale against the prefab.

## 1. IDENTITY

A full-frame stack of up to three giant Archivo Black caps rows JUSTIFIED to ONE common container:
every row of every page of every beat has its INK flush at x 80 and x 1200 — a 7-letter word and a
2-letter word measure the same 1120px block, the short one simply carries more tracking. White ink
wearing a soft layered white glow over the footage; words rise + fade in on their spoken timing, and
word-groups take turns as pages at the shared center stack. The prefab's PEACE / OF / MIND register
(tracking that widens as the word shortens) taken to its literal end: it is no longer a table, it is
solved per row so the margins are exact.

## 2. SKELETON

Paste this whole document as `runs/<key>/final/template.wv`, then add one `.cue` block per beat
(section 3) after the `<video>` element. Replace only `{videoPath}` (from `meta.json`) and `{DUR}`
(`durationSec` from `meta.json`, manifest only). Canvas: see RESOLUTION at the top of this sheet.
The footage is FULL-BLEED at z0 — no chrome covers it.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1280px; height: 720px; background: #0a0e16; overflow: hidden; }
  body { position: relative; }
  .vid { position: absolute; inset: 0; width: 1280px; height: 720px; object-fit: cover; z-index: 0; }

  /* beat gate — the one safe reveal recipe; delay + duration come inline per cue */
  @keyframes cueWin { 0%, 99.99% { opacity: 1; } 100% { opacity: 0; } }
  .cue { position: absolute; left: 0; top: 0; width: 1280px; height: 720px; opacity: 0;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* a page = up to three justified rows at the shared center stack; mid-beat pages fade out
     COMPLETING at the successor's first word; the beat's LAST page holds and the gate cuts it. */
  .pg { position: absolute; inset: 0; z-index: 1;
        animation-name: pgOut; animation-duration: 160ms; animation-timing-function: linear;
        animation-fill-mode: forwards; }
  @keyframes pgOut { 0% { opacity: 1; } 100% { opacity: 0; } }

  /* one JUSTIFIED row — flush-LEFT in the shared block, its solved letter-spacing and its
     bearing-corrected left both inline per row, so the ink runs x 80 … x 1200 whatever the word.
     Never centre a row, never shrink-to-fit flex around animated children. Shadow = the prefab's
     layered white glow + a dark grounding layer for footage (the prefab's flat dark demo bg is not
     carried over). */
  .row { position: absolute; width: 1120px; text-align: left; white-space: nowrap;
         color: #fff; font-weight: 400; line-height: 1.2;
         font-family: "Archivo Black", "Helvetica Neue", Arial, sans-serif;
         text-shadow: 0 0 8px rgba(255,255,255,0.45), 0 0 22px rgba(255,255,255,0.3),
                      0 0 44px rgba(255,255,255,0.18),
                      0 2px 12px rgba(0,0,0,0.55), 0 1px 3px rgba(0,0,0,0.7); }

  /* rise + fade (the prefab's wIn) — duration compresses inline near a page turn / gate close */
  .w { display: inline-block; opacity: 0;
       animation-name: wIn; animation-timing-function: cubic-bezier(.2,.7,.3,1);
       animation-fill-mode: both; }
  @keyframes wIn { 0% { opacity: 0; transform: translateY(0.28em); } 100% { opacity: 1; transform: none; } }

  .f172{font-size:172px} .f154{font-size:154px} .f138{font-size:138px} .f124{font-size:124px}
  .f112{font-size:112px} .f100{font-size:100px} .f90{font-size:90px} .f80{font-size:80px}
  .f72{font-size:72px} .f64{font-size:64px} .f56{font-size:56px}
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

One `.cue` per beat `{N}` of `word-timings.json`. Beat template — one `.pg` per page, one `.row` per
row (section "Rows"), one `.w` span per token:

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N}; animation-delay:{cueDelayMs}ms; animation-duration:{winMs}ms;">
  <div class="pg" style="animation-delay:{pgOutMs}ms">
    <div class="row {F}" id="b{N}p{K}r{J}" data-node-id="b{N}p{K}r{J}" data-node-role="text" style="left:{leftPx}px; top:{topPx}px; letter-spacing:{ls}em"><span class="w" style="animation-delay:{delayMs}ms; animation-duration:{inMs}ms">{WORD}</span></div>
    <!-- up to three .row divs (r1 r2 r3) -->
  </div>
  <!-- more .pg blocks (p2, p3, …) as the paging rule produces them;
       the beat's LAST .pg gets style="animation:none" instead (it holds; the gate cuts it) -->
</div>
```

**Window** (extends the gate to the next beat so the last page rides silence gaps):
- `{winMs}` = next beat's `cueDelayMs` − this beat's `cueDelayMs`.
- Last beat: `{winMs}` = round(`durationSec`×1000 from `meta.json`) − its `cueDelayMs`.

**Word prep (before counting anything):** UPPERCASE every token yourself (no text-transform
reliance); strip ONE trailing `.` or `,` (`bulb.` → `BULB`, `ikea,` → `IKEA`); keep `?` `!` `'` `£`
and internal punctuation (`£55` stays). GLUE: a token starting with `-` (e.g. `-DO` after `TO`)
merges with the previous word into ONE unit for paging and counting (`TO-DO` = 5 chars); it renders
as two ADJACENT spans on the same row — the row's tracking spaces them like any glyph gap — each
keeping its OWN verbatim `delayMs`. n below = UNIT count.

**Paging rule** — walk the beat's units left to right (ORDER PRESERVED, every unit used once):
a page takes units while BOTH hold: total page chars (unit chars + 1 per gap) ≤ 24 AND ≤ 3 units.
Stop before the first violation; remaining units start the next page. An oversized single unit
still gets a page of its own.

**Rows** — one WORD per row, with ONE exception: a unit of a single character (`A`, `I`) has no
letter gap of its own to open, so it cannot be justified alone. It shares a row with its neighbour —
the NEXT unit, or the PREVIOUS one when it closes the page — the two words split by SEP, a gap of
TWO `&#160;` (nbsp) that the row's tracking widens along with everything else, so the word gap always
reads wider than the letter gaps around it. Order is never changed and a word is never split. A page
of 1–3 units therefore yields L = 1–3 rows, filled top-down in word order (r1 r2 r3).

**Metrics** — Archivo Black 400, read from the shipped Google font (advance = `hmtx`/1000 upem,
LSB = `glyf` xMin/1000, RSB = (advance − xMax)/1000, kern = the GPOS `kern` pair xAdvance/1000).
Justification is arithmetic: it is only as exact as these numbers. The working set, em:

| | A | B | C | D | E | F | G | H | I | J | K | L | M | N | O | P | Q | R | S | T | U | V | W | X | Y | Z |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| adv | .778 | .778 | .778 | .778 | .722 | .667 | .833 | .833 | .389 | .667 | .833 | .667 | .944 | .833 | .833 | .722 | .833 | .778 | .722 | .722 | .833 | .778 | 1.000 | .778 | .778 | .722 |
| lsb | .010 | .074 | .045 | .074 | .074 | .074 | .045 | .074 | .084 | .023 | .074 | .074 | .060 | .074 | .045 | .074 | .045 | .074 | .043 | .023 | .074 | .017 | .005 | .004 | .007 | .024 |
| rsb | .009 | .040 | .045 | .045 | .046 | .037 | .063 | .074 | .084 | .074 | .014 | .019 | .060 | .074 | .045 | .042 | .045 | .031 | .036 | .027 | .074 | .018 | .005 | .000 | .008 | .031 |

Digits `0`–`9` and `$ £ €`: adv .667 · space and nbsp: adv .333, lsb/rsb 0 · `? ` .611 · `" ` .500 ·
`' ` .278 · `! , - . : ;` .333. Anything else: the compiled module carries the full extracted table;
a glyph outside it falls back to adv .750 (the caps average) with zero bearings.

KERN pairs among caps, 1/1000 em (subtract from the advance sum; the module also carries the
punctuation pairs): `FA -94 · YA -94 · AY -85 · PA -85 · LY -77 · AT -69 · OY -68 · TA -68 ·
YC/YG/YO -60 · VA -57 · AV -55 · OX -52 · LT/LV/QY -51 · DA/OV/QV/RY/YS -43 ·
AU/DV/DY/KC/KG/KO/OA/TC/TG/TO/TQ/UA/VC/VG/VO/VQ/XC/XG/XO -34 · BU/JA/LU/OT -26 · RQ -20 ·
AQ -19 · AC/AG/AO/QT/RC/RG -18 · BA/LC/LG/LO/LW/OW/RO/RU/RV/WC/WG/WO -17 · DW/QA +17 ·
NA -10 · RT -9 · AW +8`. Kerning applies INSIDE one span only — every word is its own inline box and
an inline boundary breaks the shaping run, so glued and SEP-separated words never kern across.
(Proven on the render: the `TO` row lands on the same right edge as its unkerned neighbours only
when the −34 is taken off.)

**Measuring a row** (all in em, at the row's own reading order):
- runs = one per `.w` span, plus SEP between two units that share a row.
- `slots` = the total CHARACTER count over all runs (SEP counts 2). Tracking gaps = `slots − 1`.
- `ADV` = Σ over runs of ( Σ adv(char) + Σ kern(char pair) ).
- `INK` = `ADV` − lsb(first char of the row) − rsb(last char of the row) — the row's ink width at
  zero tracking. Justification is OPTICAL: the INK meets the container, not the advance box.

**Sizing — one `{F}` class per page (all its rows share it):** the largest ladder size at which the
page's WIDEST row still fits the block with tracking ≥ 0, i.e. `F · max(INK) ≤ 1120`.
The ladder, ordered (for the verify fix): f172 f154 f138 f124 f112 f100 f90 f80 f72 f64 f56.
An English word never reaches the bottom (f56 fits INK ≤ 20em ≈ 26 caps).

HEIGHT is budgeted by construction: a page's row stack = 1.2·F·L ≤ 1.2·172·3 = 619.2px, inside the
y 43…677 safe band at every ladder row.

**Justification — inline `{ls}` per row, solved (em, 4dp, never negative):**

    {ls} = (1120 / F − INK) / (slots − 1)

A row of a single glyph (only reachable when a beat is one one-letter word) has no gap to open: it
takes `{ls}` = 0 and the extra inline `text-align:center` — the one row in the system that is
centred instead of justified.

**Placement:** every row sits at `width:1120` with

    {leftPx} = 80 − F · lsb(first char of the row)        {topPx} = 360 − 0.6·F·L + 1.2·F·(J−1)

— F = the page's font px, L = its row count, J = the row's 1-based index. The left pulls the box back
by the first glyph's side bearing so the INK starts at x 80; the tracking then carries the last
glyph's ink to x 1200. The row stack is centered on y 360. Both stay fractional. Demoting a page
recomputes every `{ls}`, `{leftPx}` and `{topPx}` with the new F.

**Page turn:** each mid-beat `.pg` gets inline `animation-delay:{pgOutMs}ms` with
`{pgOutMs}` = max(nextStart − 160, lastDelay) — nextStart = the NEXT page's first word `delayMs`
(same beat), lastDelay = this page's last word `delayMs` — so the 160ms fade completes at the
successor's first rise. The beat's LAST `.pg` gets `animation:none` instead: it HOLDS and the cue
gate cuts it.

**Worked example** (beat 1 of the landscape-main fixture — 7 words
`This is a Philips Hue smart bulb.`, cueDelayMs 160, next beat 1720 → winMs 1560, cueEnd 1720):
- pages: `THIS IS A` (9 chars) · `PHILIPS HUE SMART` (17) · `BULB` (4)
- p1 rows: `A` is one char and closes the page → it joins the previous row → [THIS] · [IS SEP A],
  L = 2. INK: THIS 2.6070 (no kern), IS+SEP+A 2.4620 → max 2.6070 → 172·2.6070 = 448 ≤ 1120 → f172.
  tops 153.6 / 360. `{ls}` = (1120/172 − 2.6070)/3 = 1.3015em and (6.511628 − 2.4620)/4 = 1.0124em;
  `{leftPx}` = 80 − 172·.023 = 76.04 (T) and 80 − 172·.084 = 65.55 (I); pgOutMs = max(440−160, 320) = 320
- p2 [PHILIPS/HUE/SMART] L = 3 → f172, tops 50.4 / 256.8 / 463.2; INK 4.3340 / 2.2680 / 3.8650 →
  `{ls}` 0.3629 / 2.1218 / 0.6617em; `{leftPx}` 67.27 / 67.27 / 72.60; pgOutMs = max(1400−160, 1120) = 1240
- p3 [BULB] L = 1 → f172, top 256.8; INK 2.9160 → `{ls}` 1.1985em; `{leftPx}` 67.27; LAST page →
  `animation:none`, the gate cuts it at 160+1560 = 1720
- word `{inMs}` (section 4, limit = own page's pgOutMs, last page → cueEnd): THIS/IS/A → 200/200/200;
  PHILIPS 420, HUE 320, SMART 200; BULB 240
- row example: `<div class="row f172" id="b1p2r1" data-node-id="b1p2r1" data-node-role="text"
  style="left:67.27px; top:50.4px; letter-spacing:0.3629em"><span class="w"
  style="animation-delay:440ms; animation-duration:420ms">PHILIPS</span></div>`
- shared row example (beat 2, `And I had to pay £55 to buy one`, page `AND I HAD`):
  `<div class="row f172" id="b2p1r2" … style="left:65.55px; top:360px; letter-spacing:0.6393em"><span
  class="w" …>I</span>&#160;&#160;<span class="w" …>HAD</span></div>`
- beat 2 (cueDelayMs 1720): pages `AND I HAD` · `TO PAY £55` · `TO BUY ONE`; `TO` is 2 slots →
  `{ls}` = 6.511628 − 1.4530 = 5.0586em, the T at x 80 and the O ending at x 1200; its last page
  holds from `ONE` (4360) until the gate at 4600.

## 4. WORDS + TIMING

- One `<span class="w">` per token, inline `animation-delay:{delayMs}ms` — that word's `delayMs`
  from `runs/<key>/word-timings.json`, VERBATIM (delays are absolute on the single timeline —
  never re-zero, never invent) — plus `animation-duration:{inMs}ms`. Nothing else inline on a span.
- `{inMs}` = min(420, max(200, limit − delayMs − 80)) — limit = the span's own page's `{pgOutMs}`
  (mid-beat page) or the beat's cueEnd = cueDelayMs + winMs (last page) — the prefab's 420ms rise
  compresses so a word spoken just before its page turns (or the gate closes) still lands.
- The beat's `.cue` gets inline `z-index:{10+N}; animation-delay:{cueDelayMs}ms;
  animation-duration:{winMs}ms` exactly as in section 3.
- The only gap markup is SEP (`&#160;&#160;`) between two units sharing a row; it is plain text
  between the spans, never a span of its own, and it is counted in `slots` and `ADV` like any glyph.
- Words accumulate within a page — all rows hold until the page's fade (or the gate).

## 5. EMPHASIS

Structural — every word is the same white 400-weight Archivo Black glow ink; the register (giant type
justified edge to edge, tracking opening as the word shortens) IS the emphasis device. No per-word
hero, no accent class, nothing to pick. Do not re-add the house digit-first/longest rule here.

## 6. VERIFY LOOP

Run (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Otherwise apply the MECHANICAL fix for the named element and re-run; at most 2
fix cycles:
- `FAIL[bounds] #b{N}p{K}r{J} … left/right outside` → that PAGE one row DOWN the ordered ladder
  (all its rows swap `{F}` together; recompute every `{ls}`, `{leftPx}` and `{topPx}` with the new
  F). Same page again → one more row. (Justification pins the ink to x 80…1200, so this can only
  fire on a metrics gap — a glyph the table does not cover.)
- `FAIL[bounds] … top/bottom outside` → same one-row step down (smaller type shrinks the stack and
  the top formula recenters it); never invent a new top.
- `FAIL[never-visible]` on a span or cue → check that cue's inline `animation-delay`/`-duration`
  against `word-timings.json`, that the `<video>` is the first body element with `class="vid"`
  (z0), that every `.cue` carries inline `z-index:{10+N}`, and that `cueWin`/`pgOut`/`wIn` are
  spelled exactly (a typo'd animation-name never fires).
- `FAIL[occluded]` → two cue windows overlap: re-check each `{winMs}` equals the next beat's
  `cueDelayMs` minus this beat's, and z-index is 10+N in beat order.

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --progress-output --record {repo}/runs/<key>/final/out.silent.mp4
```

Manifest line (already given in section 2): `{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}` — W/H/FPS/DUR from `meta.json`.

## 7. DO NOT

- No fonts, colors, shadows, sizes, or keyframes beyond this sheet — Archivo Black 400 caps (the
  Google Fonts `<link>` in the skeleton is what loads it; there is no local fallback that measures
  the same), white `#fff`, the one five-layer shadow (three white glows + two dark grounding
  layers), `cueWin`/`pgOut`/`wIn` and the f-ladder are the whole system.
- Never centre a row, never right-align one, never `text-indent` — every row is flush-left at its
  bearing-corrected `{leftPx}` and reaches x 1200 through its solved `{ls}`. The ONLY exception is
  the lone single-glyph row, which has no gap to open.
- Never hand-pick a tracking value, never re-introduce a tracking-by-char-count table, and never
  size the block to the page (a per-page width would break the alignment BETWEEN beats — the
  container is one block for the whole video).
- Never reinstate the prefab's opaque `#0a0e16` poster background, a scrim, or any plate behind the
  type — the footage stays full-bleed; legibility is the baked grounding shadow only.
- Never drop the dark grounding layers to "match the prefab" — the pure-white glow vanishes over
  light footage; the prefab's flat dark demo bg is what hid this.
- Mid-beat pages fade out on the closed form only; never fade or cut the beat's LAST page (it rides
  the cue gate).
- Never split a word across rows or reorder units; two words share a row ONLY under the one-letter
  rule, and then always with SEP between them.
- No invented timing: every `delayMs`/`cueDelayMs` comes VERBATIM from `word-timings.json`;
  derived numbers ONLY via the closed forms in sections 3-4.
- Never animate `color` or `filter:blur`; no `-webkit-text-stroke`; no text-transform reliance — uppercase the strings
  yourself.
- No flex anywhere — the prefab's space-between column is replaced by absolutely positioned rows
  (a shrink-to-fit line reflows as its children reveal around animated children).
- Never read the video frames, never run ffmpeg checks — `--verify` is the only self-check.
- No redesign after a render or a verify failure — only the mechanical fixes in section 6.
