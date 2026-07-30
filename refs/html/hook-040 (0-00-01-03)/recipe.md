# RECIPE — hook-040 (0-00-01-03) (16:9 · 1280×720 @ 24fps)

RESOLUTION: px are authored at the 16:9 reference canvas 1280×720. FIRST STEP: SCALE = W/1280 from
`meta.json` (require |H − 720·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px value by SCALE and round (slot lefts/tops, font sizes, the wordIn travel,
the px text-shadow offsets/blurs, body/cue/page dims); `em` letter-spacing and ms timings never scale;
the manifest carries the run's real W/H.

Prefab is 960×720 (same 720 height): horizontal px are converted ×4/3 and vertical px carried, then the
scatter path is RE-COMPOSED into a 12-slot serpentine for the wide frame (the landscape precedent — the
prefab's 7 demo slots sat partly outside the safe band, e.g. its bottom word at y 692). Copy numbers as
written, never rescale against the prefab.

## 1. IDENTITY

Scattered kinetic word-cloud over full-bleed footage in ONE FACE — **Archivo Black 400 throughout**,
body words and accents alike. Each spoken word is its own white element with a tight white glow halo,
rising in (fade + 33px lift) at ITS OWN scattered position — a jittered staircase stepping down the
left band, then hopping right and climbing back up — words keep their spoken case, accumulate one by
one on their spoken timing, and the beat gate cuts the cloud; odd beats scatter from the left, even
beats mirror to the right. TWO words per beat are ACCENTS on TWO RUNGS — same white ink, same face,
same slots, at **1.5×** (the SUB, the beat's setup word) and **2.8×** (the LEAD, its payoff word) the
page size. Every beat therefore plays THREE type sizes: the body cloud, the word you read second, and
the word you read first. With a single face the hierarchy is PURE SIZE — there is no face swap left to
lean on, which is why the three rungs are spread WIDE (1× / 1.5× / 2.8×) and the tracking curve (§5)
has to be visible. A lead of 1.8× against a sub of 1.5× reads as ONE size and the beat collapses.

## 2. SKELETON

Paste this whole document as `runs/<key>/final/template.wv`, then add one `.cue` block per beat
(section 3) after the `<video>` element. Replace only `{videoPath}` (from `meta.json`) and `{DUR}`
(`durationSec` from `meta.json`, manifest only). Canvas: see RESOLUTION at the top of this sheet.

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
  html, body { width: 1280px; height: 720px; }
  /* ONE FACE for the whole cloud — Archivo Black ships a single weight (400); never ask for 700. */
  body { background: #0e0d10; overflow: hidden; position: relative; font-family: "Archivo Black", system-ui, sans-serif; }
  .vid { position: absolute; inset: 0; width: 1280px; height: 720px; object-fit: cover; }

  /* window gate — the one safe reveal recipe; delay+duration+z come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position: absolute; left: 0; top: 0; width: 1280px; height: 720px; opacity: 0; z-index: 11;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* page wrapper — a mid-beat page dies together via ONE pgOut (delay comes inline);
     the beat's LAST page holds (inline animation:none) and the cue gate cuts it */
  .pg { position: absolute; left: 0; top: 0; width: 1280px; height: 720px;
        animation-name: pgOut; animation-duration: 280ms; animation-timing-function: ease;
        animation-fill-mode: forwards; }
  @keyframes pgOut { from { opacity: 1; } to { opacity: 0; } }

  /* scattered word — the ANIMATED unit is one absolutely positioned word div. Rise + fade ONLY:
     the prefab's 12px entrance blur is deliberately dropped (the engine holds an animated filter's
     INITIAL value — the word would stay blurred forever). translateY ends at identity. Shadow =
     the prefab's tight white halo + one dark grounding layer for light footage. */
  @keyframes wordIn { 0% { opacity: 0; transform: translateY(33px); } 100% { opacity: 1; transform: none; } }
  .w { position: absolute; white-space: nowrap; color: #ffffff; opacity: 0;
       font-weight: 400; line-height: 1.4; letter-spacing: 0.02em;
       text-shadow: 0 0 1px rgba(255,255,255,0.95), 0 0 5px rgba(255,255,255,0.5),
                    0 0 14px rgba(235,242,255,0.3), 0 2px 10px rgba(0,0,0,0.55);
       animation-name: wordIn; animation-timing-function: cubic-bezier(.2,.7,.3,1);
       animation-fill-mode: both; }

  /* ACCENTS — TWO words per beat on two rungs. One face throughout, so the hierarchy is PURE SIZE
     and the only thing these classes carry is the TRACKING CURVE: it falls as the type grows, body
     +0.02em (Archivo Black is heavy — the small rungs need their counters opened) → .acc −0.04em
     (the SUB rung, 1.5×) → .lead −0.07em (the LEAD rung, 2.8×, its own tightest value: at ~110px the
     sub's −0.04 reads loose and airy). Declared after .w, .lead after .acc, so every override lands. */
  .acc { letter-spacing: -0.04em; }
  .lead { letter-spacing: -0.07em; }

  .f36{font-size:36px} .f32{font-size:32px} .f29{font-size:29px} .f26{font-size:26px} .f23{font-size:23px} .f21{font-size:21px}
  .a54{font-size:54px} .a48{font-size:48px} .a44{font-size:44px} .a39{font-size:39px} .a35{font-size:35px} .a32{font-size:32px}
  .l101{font-size:101px} .l90{font-size:90px} .l81{font-size:81px} .l73{font-size:73px} .l64{font-size:64px} .l59{font-size:59px}
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

One `.cue` per beat `{N}` of `word-timings.json`; inside it one `.pg` page div per page, and inside
each page one `.w` div per word at its slot. Beat template (odd beats write each word position as
`left:{x}px`, even beats as `right:{x}px` — same numbers, mirrored composition):

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N};animation-delay:{cueDelayMs}ms;animation-duration:{cueDurMs}ms">
  <div class="pg" id="b{N}p{j}" data-node-id="b{N}p{j}" style="{pgStyle}">
    <div class="w {F}" id="b{N}w{k}" data-node-id="b{N}w{k}" data-node-role="text" style="left:{x}px;top:{y}px;animation-delay:{delayMs}ms;animation-duration:{inMs}ms">{Word}</div>
    <div class="w acc {A}" id="b{N}w{k}" data-node-id="b{N}w{k}" data-node-role="text" style="left:{x}px;top:{y}px;animation-delay:{delayMs}ms;animation-duration:{inMs}ms">{SubWord}</div>
    <div class="w acc lead {L}" id="b{N}w{k}" data-node-id="b{N}w{k}" data-node-role="text" style="left:{x}px;top:{y}px;animation-delay:{delayMs}ms;animation-duration:{inMs}ms">{LeadWord}</div>
    <!-- one .w per word of the page, in word order; the §5 LEAD and (when the beat earns one) the
         §5 SUB are the only two that differ — same div shape, different size class -->
  </div>
  <!-- more .pg divs for beats longer than 12 words -->
</div>
```

**Word prep (before counting anything):** keep the word's SPOKEN CASE verbatim (this ref is sentence
case, never uppercase); strip a trailing `.` or `,`; keep `?` `!` `'` and any INTERNAL punctuation
(`£55`, `10,000` stay as is). GLUE: a token starting with `-` (e.g. `-do` after `to`) merges with the
previous word into ONE div — text concatenated with no gap (`to-do`), counted as one word whose
`delayMs` is the FIRST token's. charLen = the prepped text length (hyphen/apostrophe count as one).

**Paging — 12 slots per page.** n = the beat's word count (after glue). P = ceil(n/12) pages; page
sizes as equal as possible: base = floor(n/P), the first (n mod P) pages take base+1 words, word order
preserved. k = the word's 0-based index in the BEAT; its slot index s = the word's 0-based index in
its PAGE.

**The slot path (reference px; slot s → left x, top y):**

| s | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
|---|----|----|----|----|----|----|----|----|----|----|----|----|
| x | 133 | 104 | 236 | 107 | 210 | 160 | 640 | 700 | 760 | 820 | 880 | 940 |
| y | 96 | 188 | 282 | 370 | 466 | 556 | 556 | 466 | 370 | 282 | 188 | 96 |

Slots 0–5 step down the NEAR column (jittered lefts, the prefab's descending drift); slots 6–11 climb
back up the FAR column stepping 60px outward per row (the prefab's `that`→`have` rise, extended). ODD
beats anchor NEAR = left: `left:{x}px`. EVEN beats mirror: `right:{x}px` with the SAME x/y (the far
column then rises up the left side).

**HEIGHT — the VERTICAL band, not width, is what caps the LEAD rung.** Body and sub boxes sit inside
the y-safe band by construction: body box = 1.4·36 = 51px, worst top 556 → 607 ≤ 676; sub box =
1.4·54 = 76px, 556 → 632 ≤ 676; worst top 96 ≥ 43. The LEAD is the one rung that runs past that band,
and the frame bottom is its real limit. A slot is TOP-anchored, so the 2.8× lead grows DOWNWARD out of
the bottom slot row (y 556); its deepest ink sits ≈1.22·F below the element top (0.08em half-leading
at line-height 1.4 + 0.98em ascent + a ≈0.16em descender), and the `wordIn` lift holds it 33px LOWER
on its entrance frame:

```
556 + 1.22·101 + 33 = 712 ≤ 720   ✓   (the lead paired with the top body rung, f36)
```

That budget is exactly why the BODY ladder tops out at 36 and not the prefab's 47: at a 40px body the
lead would be 2.8·40 = 112 and measured 5.5px out of frame on `phone`. **CONTRAST OUTRANKS BODY
SIZE** — where the lead cannot fit, the BODY steps down and the lead stays huge, never the other way
round. Demotion only shrinks; the slot path never moves.

**Centre gutter (accents only).** Slot 6 anchors at x 640 — the frame centre, where the subject sits.
A word that lands there AND is a §5 accent (EITHER rung) uses `x = 700` with `avail = 503` (the next
far-column anchor, y unchanged) so the blown-up word opens into the side band instead of straddling
the middle. Body words at slot 6 never move; no other slot is ever nudged.

**Sizing — one `{F}` class per PAGE.** ONE FACE, so one advance model for everything: Archivo Black
measures **≈0.615 em/char** mixed-case at zero tracking on this skeleton's calibration render, and the
tracking value adds straight onto it — **0.635** at the body's +0.02em, **0.575** at the sub's
−0.04em, **0.545** at the lead's −0.07em. The budget advance is **ADV = 0.70 em/char** = the body
rung's 0.635 × a 1.10 safety margin. Each slot has a fixed width budget `avail_s` (near column:
624 − x_s, the far column's mirrored edge minus a 16px gutter; far column: 1203 − x_s, the x-safe edge):

| s | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
|---|----|----|----|----|----|----|----|----|----|----|----|----|
| avail_s | 491 | 520 | 388 | 517 | 414 | 464 | 563 | 503 | 443 | 383 | 323 | 263 |

Page pressure `C = ceil(1000 · max_s(charLen_s / avail_s))` over the page's words at their slots
(avail in REFERENCE px — C never scales). The page's two ACCENT slots (§5) instead contribute
`W · charLen / avail` against their gutter-corrected budgets, W = the rung's SIZE STEP × its advance
ratio against the body rung (the only thing left to correct for once the face is shared is TRACKING):

| rung | size step | tracking | Archivo advance | W |
|---|---|---|---|---|
| SUB | 1.5× | −0.04em | 0.575 em/char | **1.36** (= 1.5 × 0.575/0.635) |
| LEAD | 2.8× | −0.07em | 0.545 em/char | **2.4** (= 2.8 × 0.545/0.635) |

so each accent carries the SAME 1.10 safety margin as ADV (it rides in via the ladder's `maxC`) and
either fits its side band or takes the WHOLE page one rung down — never the accent alone, the
1.5×/2.8× ratios are the design and neither accent can grow across the frame centre. `{F}` = the
first ladder row with C ≤ maxC, where `maxC = floor(1000 / (ADV · size))` — re-derived for Archivo
Black, which eats ~13% more width per char than the Poppins this ladder was first cut for, so every
row now fits fewer chars per slot:

| C ≤39 | ≤44 | ≤49 | ≤54 | ≤62 | >62 |
|------|-----|-----|-----|-----|-----|
| f36 | f32 | f29 | f26 | f23 | f21 |

The ladder, ordered for the fix-loop stepping: f36 f32 f29 f26 f23 f21. `{A}` (sub) and `{L}` (lead)
are the accent classes PAIRED with the page's row (`round(1.5 · size)` / `round(2.8 · size)`), so a
demotion shrinks body and both accents together and the three sizes stay in step:

| {F} | f36 | f32 | f29 | f26 | f23 | f21 |
|---|---|---|---|---|---|---|
| {A} | a54 | a48 | a44 | a39 | a35 | a32 |
| {L} | l101 | l90 | l81 | l73 | l64 | l59 |

**Page style `{pgStyle}`:** the beat's LAST page → `animation:none` (it holds; the gate cuts it).
Every earlier page → `animation-delay:{pgOutMs}ms` with
`pgOutMs = max(nextPageFirstDelayMs − 280, lastWordDelayMs)` (the page's own last word's delay) —
the 280ms fade completes at the successor's first word.

**Worked example — beat 1 (landscape-main fixture)** (`This is a Philips Hue smart bulb.`,
cueDelayMs 160, cueDurMs 1560 → cueEnd 1720; 7 words → P=1; ODD → `left:`):
- Slots: This→s0 (133,96) · is→s1 (104,188) · a→s2 (236,282) · Philips→s3 (107,370) ·
  Hue→s4 (210,466) · smart→s5 (160,556) · bulb→s6 (640,556).
- Accents (7 units ≥ 4): no digit → LEAD = longest = `Philips` (7) at s3 → `w acc lead l101`; SUB =
  longest of the rest at ≥4 chars = `smart` (5) at s5 → `w acc a54`. Neither is at slot 6 → x unchanged.
- Pressure: lead 2.4·7/517 = 32.50 beats the sub (1.36·5/464 = 14.66) and every body ratio
  (This 4/491 = 8.15) → C = 33 → `f36`, so the pair is `l101` + `a54`.
- inMs = min(500, max(220, cueEnd − delayMs − 80)): This 500 … smart 500, bulb (delay 1400) → 240.
- One page → `animation:none` on `b1p1`.

**Worked example — beat 2 (landscape-main fixture)** (`And I had to pay £55 to buy one`,
cueDelayMs 1720, cueDurMs 2880 → cueEnd 4600; 9 words → P=1; EVEN → `right:`):
- Slots s0..s8 with `right:` x: And right:133 top:96 … £55→s5 right:160 top:556, to→s6 right:640
  top:556, buy→s7 right:700 top:466, one→s8 right:760 top:370.
- Accents: LEAD = `£55` — it carries a digit, so it wins outright (index 5, before any length test) →
  `w acc lead l101`. SUB: no other unit carries a digit and the longest of the rest is 3 chars
  (`And`/`had`/`pay`/`buy`/`one`), under the 4-char floor → **no sub**, the beat runs on the LEAD alone.
- Pressure: lead 2.4·3/464 = 15.52 vs the best body ratio had 3/388 = 7.73 → C = 16 → `f36`.
- inMs: And 500 … one (delay 4360, avail 160) → 220.

## 4. WORDS + TIMING

- Delays are absolute on the single timeline — paste as-is from `runs/<key>/word-timings.json`, never
  re-zero, never invent.
- Each beat's `.cue` gets inline `animation-delay:{cueDelayMs}ms;animation-duration:{cueDurMs}ms`
  verbatim, plus `z-index:{10+N}`.
- The WORD is the animated unit: each `.w` gets inline `animation-delay:{delayMs}ms` VERBATIM and
  `animation-duration:{inMs}ms` with `inMs = min(500, max(220, cueEnd − delayMs − 80))` where
  cueEnd = cueDelayMs + cueDurMs (the entrance compresses so a late word still lands before the gate).
- A word's text is ONE plain text node (a glued unit concatenated, no gap). No inner spans, no spacer
  elements — each word is its own absolutely positioned div, so word gaps are the slot geometry.
- Words accumulate — every landed word HOLDS at full opacity; a mid-beat page dies via its single
  pgOut; the beat's last page rides the cue gate. No per-word fade-outs anywhere.

## 5. EMPHASIS

TWO accent words per beat on TWO RUNGS, so the beat plays THREE type sizes — small / medium / HUGE.
It is a SIZE contrast and nothing else: one face, one ink, no colour step. The LEAD is the beat's
payoff word, the SUB its setup word.

**Which two words (mechanical, no judgement).** Over the beat's prepped words, in order:

- **LEAD (2.8×)** — the FIRST word containing a digit wins; if none does, the LONGEST word (charLen
  after prep) wins, tie → the **LATER** one.
- **SUB (1.5×)** — the same contest re-run over the beat MINUS the lead: the first remaining word
  containing a digit wins; if none does, the longest remaining word **of at least 4 chars** wins,
  tie → the **EARLIER** one.

The tie-breaks are deliberately opposite: the payoff word drifts late and the setup word drifts early,
so the two accents spread across the beat's reading order instead of clustering. The 4-char floor keeps
three-letter function words (`And`, `the`, `one`) out of the accent rungs; a digit-bearing word is
strong at any length and skips the floor.

**Degradation.** The SUB is dropped — the beat runs on the LEAD alone — when the beat has **fewer than
4 words**, or when no remaining word clears the 4-char floor. A two-word beat therefore gives one
accent and one body word, never two accents; a one-word beat is its own lead.

Indices are counted across the whole BEAT, so a paged beat still emphasises two words in total (a page
that owns neither runs all-body).

**Why the rungs sit that far apart.** With ONE face the hierarchy is PURE SIZE — there is no face swap
left to lean on, so 1.5 vs 1.8 read as ONE size and the beat collapses. The lead has to JUMP clear of
the sub, hence 1× / 1.5× / **2.8×**. 2.8 is the largest step the bottom slot row's descender budget
allows (§3), and it is paid for out of the BODY — the f-ladder tops out at 36 so the lead can stay
huge — never out of the lead.

**How they render:** the same div, the same slot, the same face, the same white ink, glow, `wordIn`
entrance and verbatim timing as every other word — only two things change:
1. the size class — `{L}` (lead) or `{A}` (sub), paired with the page's `{F}` in the §3 table, i.e.
   **2.8×** and **1.5×** the body size. The three must read as clearly different sizes, not as a wobble.
2. tracking TIGHTENS with every step up: body **+0.02em** (Archivo Black is heavy — the small rungs
   need their counters opened, and a Poppins-era −0.01em would choke them) → `.acc` (sub)
   **−0.04em** → `.lead` **−0.07em**. A value that reads right at one rung reads loose and airy blown
   up to the next, which kills the dominance — each rung needs its own number, and `.lead` must follow
   `.acc` in the stylesheet so its retighten lands. There is NO face or weight change: Archivo Black
   ships one weight (400) and it is the body face too.

**Staying out of the middle:** each accent obeys §3's slot width budget at its own char weight (sub
1.36, lead 2.4), so a near-column accent still ends by x 624 and a far-column accent still opens at
640 or beyond — neither can grow across the frame centre onto the subject. The one slot that anchors
ON the centre (slot 6) gets the §3 centre gutter, for either rung.

No accent colour, no plate, no sticker, no second entrance animation, no bold/italic on the body words
— the three-size step is the entire emphasis system.

## 6. VERIFY LOOP

Run (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Otherwise apply the mechanical fix for the flagged element and re-run; at most 2 fix
cycles:
- `FAIL[bounds] #b{N}w{k} … left/right outside` → that word's PAGE steps one row DOWN the ordered
  ladder (f36 → f32 → …); all words of the page shrink together, both accents with them via their
  paired `{A}`/`{L}` (never demote an accent alone — the 1.5×/2.8× ratios are the design). Fails
  again → one step more.
- `FAIL[bounds] … top/bottom outside` → an arithmetic slip, not a design problem: re-check the beat's
  slot tops against the section-3 table (body/sub stacks bottom out at 607/632 ≤ 676 and the lead's
  deepest ink at 712 ≤ 720 by construction); never move the slots and never shrink the lead alone.
- `FAIL[never-visible]` → check that cue's inline `animation-delay`/`animation-duration` match
  `word-timings.json`, the `<video>` is the first body element with `style="z-index:0"`, every word's
  class list is exactly `w f{…}` (a typo'd `wordIn`/`cueWin` never animates in), and a mid-beat page's
  pgOut delay is not earlier than its own words' delays.
- `FAIL[occluded] #b{N}…` → cue windows overlap: cue N's `animation-duration` must not exceed
  `cueDelayMs(N+1) − cueDelayMs(N)`; if it does, set it to that difference. Confirm inline z-index is
  10+N in beat order.

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --progress-output --record {repo}/runs/<key>/final/out.silent.mp4
```

Manifest line (already given in section 2): `{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}` — W/H/FPS/DUR from `meta.json`.

## 7. DO NOT

- No fonts, colors, shadows, sizes, or keyframes beyond this sheet — **Archivo Black 400 for
  EVERYTHING** (body words and both accent rungs; never ask the family for 700, it ships one weight),
  white `#ffffff`, the one four-layer text-shadow, `cueWin`/`pgOut`/`wordIn` and the f/a/l ladders are
  the whole system. Never re-introduce a second body face.
- Never more than TWO accents per beat, never a third rung, never an accent picked by meaning — §5's
  lead/sub selectors are the only ones; never give an accent its own colour, plate or animation, and
  never let a size drift off the paired `{A}`/`{L}` (1.5× / 2.8× the page rung) or the tracking off
  the +0.02 / −0.04 / −0.07em curve. Below §5's floors the beat drops the SUB, never the LEAD.
- Never buy body size back by shrinking the LEAD — the f-ladder tops out at 36 *because* 2.8× has to
  clear the bottom slot row (§3); contrast outranks body size.
- Never re-add the prefab's entrance blur (see the skeleton's why-clause) and never animate `color` or
  `filter`; never put `var()` in transforms or keyframes; no `vw` font sizes; no
  `-webkit-text-stroke`; single-value `border-radius` only (none is used here).
- Never uppercase — the spoken case is the design.
- No flex anywhere; every word is its own absolutely positioned div; no `text-align`; the even-beat
  mirror is the `right:` property with the section-3 numbers, never a re-derived layout.
- Never move the slot path or the avail budgets (the §3 centre gutter is the single exception, and it
  applies to an accent word of either rung at slot 6 only) — the ladder is the ONLY bounds lever.
- No invented timing: every `delayMs`/`cueDelayMs`/`cueDurMs` comes verbatim from
  `word-timings.json`; derived numbers ONLY via the closed forms in sections 3–4.
- Words accumulate and the gate cuts the beat — never add per-word fade-outs; only a mid-beat PAGE
  fades, and its fade completes at the successor's first word.
- Never read the video frames; never re-derive layout; no redesign after a render or verify failure —
  only the mechanical fixes in section 6.
