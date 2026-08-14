> **AUTHORITY NOTE (2026-07-21):** `recipe.ts` next door is the single source of truth — the
> curation pass (design rounds v2–v6) edited the MODULE only and this sheet has NOT been synced.
> Do not recompile the module from this sheet until it is re-derived.

# hook-078 (0-00-42-23) — recipe (9:16 · 736×1312 @ 25fps)

RESOLUTION: px are authored at the 9:16 reference canvas 736×1312. FIRST STEP: SCALE = W/736 from
`meta.json` (require |H − 1312·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE and round (positions, sizes, fonts, px spacing/shadows/margins/tops);
`em` values and ms timings never scale; the manifest carries the run's real W/H.

Inputs (module derivation offline; creative-pass craft substrate at run time): `runs/<key>/word-timings.json`, `runs/<key>/meta.json`. Output:
`runs/<key>/final/template.wv` + `runs/<key>/final/manifest.json`.

GUARD: aspect and scaling per the RESOLUTION rule at the top of this sheet.

## 1. IDENTITY

A movie-poster credits card: constant red Albert Sans credits chrome (studio tags, "BASED ON A TRUE
STORY", "COMING SOON" + jokey small print) directly over the raw footage, around a big
DM-Serif-Display-italic headline — the spoken beat — whose words rise in one by one on their real
timings, with the prefab's `+WORD` accent on one hero word per beat. No panel/scrim — text sits
directly on the footage.

## 2. SKELETON

Prefab is 720×1280; every px below is ALREADY rescaled ×1.022 and repositioned inside the 9:16 safe
margins — copy numbers as written, never rescale again. Paste this whole document as
`runs/<key>/final/template.wv`; substitute only `{videoPath}` (from `meta.json`). The chrome divs
(#tagl…#sub2) are FINAL — fixed dressing text with fixed delays; never edit them, never put spoken
words in them.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@1&family=Albert+Sans:wght@700;800;900&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:736px; height:1312px; overflow:hidden; background:#000; }
  body { position:relative; font-family:'Albert Sans',sans-serif; }
  .vid { position:absolute; inset:0; width:736px; height:1312px; object-fit:cover; z-index:0; }

  /* persistent credits chrome — fixed text, revealed once at clip start, up for the whole video */
  .chrome { position:absolute; z-index:2; color:#e62129; white-space:nowrap; }
  #tagl    { left:110px; top:172px; font-weight:700; font-size:15px; letter-spacing:1px; line-height:22px; }
  #tagr    { right:146px; top:172px; text-align:right; font-weight:700; font-size:15px; letter-spacing:1px; line-height:22px; }
  /* bottom block — ONE anchor, four lines top-to-bottom: BASED ON A TRUE STORY / COMING SOON /
     LIKE, REALLY SOON / TRUST US :P. #basedon + #sub1 + #sub2 share font-size:14px (the plaque's old
     size); #embreve keeps its own larger size. No standalone mid-canvas plaque anymore. Block
     shifted +70px from the original tops so #sub2's ink bottom lands ~1084px (safe: <1089px). */
  #basedon { left:73px; width:554px; top:980px; text-align:center; font-weight:700; font-size:14px; letter-spacing:2px; line-height:1; }
  #embreve { left:73px; width:554px; top:999px; text-align:center; font-weight:800; font-size:41px; letter-spacing:3px; line-height:1; }
  #sub1    { left:73px; width:554px; top:1051px; text-align:center; font-weight:800; font-size:14px; letter-spacing:0.5px; line-height:1; }
  #sub2    { left:73px; width:554px; top:1070px; text-align:center; font-weight:800; font-size:14px; letter-spacing:0.5px; line-height:1; }

  /* beat gate — the one safe reveal recipe; z-index + delay + duration come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position:absolute; inset:0; opacity:0;
         animation-name:cueWin; animation-timing-function:linear; animation-fill-mode:forwards; }

  /* headline line — the prefab's line-height .92 title is built as ABSOLUTE lines (the engine has no
     half-leading); the per-class `top` values in section 3 ARE the leading. line-height stays 1.
     padding-bottom gives the wordIn rise headroom inside the line's own box — without it the
     engine shears a rising glyph's bottom at the box edge mid-reveal.
     ALIGNMENT LAW: left:110px here MUST equal #tagl's left:110px — the headline and "THE INTERNET"
     share exactly one flush-left edge, every beat. Never move either off 110px. */
  .tl { position:absolute; left:110px; z-index:1; white-space:nowrap; padding-bottom:0.3em;
        font-family:'DM Serif Display',serif; font-style:italic; font-weight:400; /* DM Serif ships italic 400 only */
        color:#e62129; letter-spacing:-0.026em; line-height:1; text-transform:uppercase; }

  /* size ladder (width budget 480px already baked in — pick by section 3 table only; every rung is
     the prior ladder ×1.12 — main-quote bump — rounded; same C→class rows as before, each just
     renders ~12% bigger now) */
  .t140{font-size:140px} .t120{font-size:120px} .t105{font-size:105px} .t93{font-size:93px}
  .t84{font-size:84px}   .t76{font-size:76px}   .t69{font-size:69px} .t64{font-size:64px}
  .t59{font-size:59px}   .t56{font-size:56px}   .t53{font-size:53px} .t49{font-size:49px}
  .t46{font-size:46px}   .t44{font-size:44px}   .t41{font-size:41px} .t39{font-size:39px}
  .t38{font-size:38px}   .t36{font-size:36px}   .t35{font-size:35px} .t34{font-size:34px}
  .t31{font-size:31px}   .t30{font-size:30px}   .t28{font-size:28px} .t25{font-size:25px}
  .t22{font-size:22px}

  /* word reveal — keep position:relative + z-index:1 (the prefab's .w stacking trick).
     Word gap = 0.3em margin PLUS a trailing &#160; in the span text (section 4) — italic caps can
     overhang their advance and eat a bare gap; the &#160; is the guaranteed glyph-level space.
     The vertical padding is descender headroom: an animating span is rasterized at its line-height:1
     box and glyph bottoms clip without it. Never shrink these numbers. */
  .w  { display:inline-block; position:relative; z-index:1; opacity:0;
        margin-right:0.3em; padding-bottom:0.2em; padding-top:0.1em;
        animation:wordIn 0.3s cubic-bezier(.2,.7,.3,1) both; }
  @keyframes wordIn { 0%{opacity:0; transform:translateY(0.16em)} 100%{opacity:1; transform:translateY(0)} }
</style>
</head>
<body>
  <video class="vid" src="{videoPath}" muted></video>
  <div id="tagl" class="chrome" data-node-role="text"><span class="w" style="animation-delay:0ms">THE&#160;</span><span class="w" style="animation-delay:90ms">INTERNET</span></div>
  <div id="tagr" class="chrome" data-node-role="text"><span class="w" style="animation-delay:180ms">PRESENTS</span></div>
  <div id="basedon" class="chrome" data-node-role="text"><span class="w" style="animation-delay:270ms">BASED&#160;</span><span class="w" style="animation-delay:330ms">ON&#160;</span><span class="w" style="animation-delay:390ms">A&#160;</span><span class="w" style="animation-delay:450ms">TRUE&#160;</span><span class="w" style="animation-delay:510ms">STORY</span></div>
  <div id="embreve" class="chrome" data-node-role="text"><span class="w" style="animation-delay:590ms">COMING&#160;</span><span class="w" style="animation-delay:670ms">SOON</span></div>
  <div id="sub1" class="chrome" data-node-role="text"><span class="w" style="animation-delay:730ms">LIKE,&#160;</span><span class="w" style="animation-delay:790ms">REALLY&#160;</span><span class="w" style="animation-delay:850ms">SOON</span></div>
  <div id="sub2" class="chrome" data-node-role="text"><span class="w" style="animation-delay:890ms">TRUST&#160;</span><span class="w" style="animation-delay:930ms">US&#160;</span><span class="w" style="animation-delay:970ms">:P</span></div>
  <!-- one .cue block per beat goes here, in beat order (section 3) -->
</body>
</html>
```

Manifest — write `runs/<key>/final/manifest.json` EXACTLY as (`{DUR}` = `durationSec` from `meta.json`):

```json
{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json
```

## 3. PER-BEAT ASSEMBLY

One `.cue` per beat `{N}` in `word-timings.json` — it holds ONLY the headline lines (chrome is already
in the skeleton and never repeats):

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N};animation-delay:{cueDelayMs}ms;animation-duration:{winMs}ms">
  <div class="tl {SIZE}" id="b{N}l1" data-node-id="b{N}l1" data-node-role="text" style="top:571px"><span class="w" style="animation-delay:{delayMs}ms">{WORD}&#160;</span><span class="w" style="animation-delay:{delayMs}ms">{WORD}</span></div>
  <div class="tl {SIZE}" id="b{N}l2" data-node-id="b{N}l2" data-node-role="text" style="top:{L2TOP}px">…</div>
  <!-- l3 / l4 only as the line rule produces them; tops from the same table row -->
</div>
```

**Window** (pure subtraction; the poster holds through speech gaps, next poster replaces it exactly):
- `{winMs}` = next beat's `cueDelayMs` − this beat's `cueDelayMs`.
- Last beat: `{winMs}` = round(`durationSec`×1000 from `meta.json`) − its `cueDelayMs`.

**Word prep (in this order, before any counting):**
1. Strip every trailing `.` and `,` from each word; keep `?` `!` `'` `-`.
2. GLUE: a token starting with `-` (e.g. `"-do"` after `"to"`) merges with the previous word into ONE
   unit for counting/splitting (rendered as two adjacent spans, no spacer — section 4).
3. UPPERCASE every unit's text YOURSELF — type caps into the spans (`text-transform` is not in the
   engine's support matrix; the CSS declaration is a fallback only, never rely on it).
4. Pick the hero (section 5) and prepend `+` to its text NOW — the `+` counts as a character below.

**Line rule** (n = unit count after gluing; order always preserved, every unit used once):
- L = min(4, ceil(n/2)); n = 1 → L = 1.
- base = floor(n/L); the first (n mod L) lines take base+1 units, the rest take base — CONSECUTIVE
  units in order. Examples: n=3 → 2,1 · n=6 → 2,2,2 · n=8 → 2,2,2,2 · n=10 → 3,3,2,2 · n=11 → 3,3,3,2.

**Sizing + line tops** — C = character count of the beat's LONGEST line (unit chars incl. `+`/`'`/`-`,
+1 per space between units on that line). ALL lines of the beat share the class; each line k gets the
inline `top` from the class's row (line1 is always `top:571px`). Height caps FIRST: if L=3 and the
table gives a class larger than `t93`, use `t93`; if L=4 and larger than `t76`, use `t76`. (These two
caps are held near their PRE-bump absolute reach rather than the full ×1.12 — they are a hard vertical
ceiling against the merged bottom block below, not the "+10-15%" content itself; scaling them the full
amount collided the deepest 3-/4-line beat with the block. Composition wins per the sheet's safe-zone
rule — this is the one deliberate deviation from a flat ×1.12 across the whole ladder.)

| C | class | line2 top | line3 top | line4 top |
|---|-------|-----------|-----------|-----------|
| ≤6 | t140 | 700 | 829 | 958 |
| 7  | t120 | 681 | 791 | 901 |
| 8  | t105 | 667 | 763 | 859 |
| 9  | t93  | 656 | 741 | 826 |
| 10 | t84  | 648 | 725 | 802 |
| 11 | t76  | 642 | 713 | 784 |
| 12 | t69  | 635 | 699 | 763 |
| 13 | t64  | 629 | 687 | 745 |
| 14 | t59  | 626 | 681 | 736 |
| 15 | t56  | 623 | 675 | 727 |
| 16 | t53  | 619 | 667 | 715 |
| 17 | t49  | 616 | 661 | 706 |
| 18 | t46  | 614 | 657 | 700 |
| 19 | t44  | 611 | 651 | 691 |
| 20 | t41  | 609 | 647 | 685 |
| 21 | t39  | 607 | 643 | 679 |
| 22 | t38  | 606 | 641 | 676 |
| 23 | t36  | 603 | 635 | 667 |
| 24 | t35  | 603 | 635 | 667 |
| 25 | t34  | 602 | 633 | 664 |
| 26 | t31  | 600 | 629 | 658 |
| 27–28 | t30 | 599 | 627 | 655 |
| 29–30 | t28 | 597 | 623 | 649 |
| 31–33 | t25 | 593 | 615 | 637 |
| ≥34 | t22 | 591 | 611 | 631 |

(The 480px width budget, the −0.026em tracking and the prefab's 0.92 leading are baked into this
table — never invent other sizes or tops, never set `line-height` on `.tl`. This table is the prior
table with every size AND every top-delta scaled ×1.12 — the main-quote bump — so the SAME character
count C now renders ~12% bigger than before; C-row boundaries are unchanged. Advance/char scales
linearly with font-size, so a bumped size can now run closer to (or past) the 480px budget at a row's
own upper C — that's what section 6's FAIL[bounds] step-down exists for; it is unchanged and still
the only fit-driven correction.)

**Placement is FIXED**: headline lines at `left:110px` with the tops above; chrome exactly
as in the skeleton. Everything already sits inside the 9:16 safe margins (x 45…655, y 145…1089).
ALIGNMENT LAW: `left:110px` on every `.tl` line MUST equal `#tagl`'s
`left:110px` — one shared flush-left edge, every beat, no exceptions. Do not move anything per beat.

**Worked example** (sample run, beat 5 — tokens `Coffee before words, zero eye contact with my to
-do list,`, cueDelayMs 6671, next beat 9631 → winMs 2960): strip → `Coffee before words zero eye
contact with my to -do list`; glue → 10 units (`to-do` is one unit, two spans); hero = CONTACT
(7 letters) → `+contact`. L = min(4, ceil(10/2)) = 4 → 3,3,2,2: `COFFEE BEFORE WORDS` (19) ·
`ZERO EYE +CONTACT` (17) · `WITH MY` (7) · `TO-DO LIST` (10). C = 19 → `t44`, tops
571/611/651/691. Beat 2 (`Mine's a lie.`, cueDelayMs 2991, next 3811 → winMs 820): 3 units, hero
MINE'S → L=2 → 2,1: `+MINE'S A` (9) · `LIE` (3) → C=9 → `t93`, tops 571/656.

## 4. WORDS + TIMING

- One `<span class="w">` per token from `word-timings.json` (after the strip + UPPERCASE rules — the
  span text is typed in caps). Each span's inline `animation-delay` = that token's `delayMs` VERBATIM
  (delays are absolute on the single timeline — never subtract the cue delay, never round, never invent).
- WORD GAPS (both parts required — validated offline): every span EXCEPT the last span of its line
  gets a trailing `&#160;` appended to its text (`<span …>COFFEE&#160;</span>`), and `.w` carries
  `margin-right:0.3em` from the skeleton. Italic caps can overhang their advance to the right and
  eat a bare gap — the in-span `&#160;` is the guaranteed space glyph. NEVER insert empty spacer
  spans and never shrink the margin or drop the `&#160;`.
- A glued `-` token keeps its OWN span and OWN `delayMs`, placed immediately after its partner
  span, with the partner span's `margin-right` zeroed inline (`style="…; margin-right:0"`) and NO
  trailing `&#160;` on the partner, so the pair renders joined: `TO-DO`.
- Never remove `display:inline-block`, the `position:relative; z-index:1`, or the vertical padding
  from `.w` (the padding stops the engine shearing glyph bottoms mid-reveal).
- Each beat's `.cue` gets inline `z-index:{10+N}; animation-delay:{cueDelayMs}ms;
  animation-duration:{winMs}ms` exactly as in section 3. The cue window IS the lifetime bound: every
  poster dies exactly when the next beat's poster starts, so consecutive posters never coexist at the
  shared anchor.
- Chrome timing is already final in the skeleton (fixed 0–970 ms reveal, then persistent) — do not
  touch it, do not re-reveal it per beat.
- Word span example: `<span class="w" style="animation-delay:8350ms">+CONTACT</span>`.

## 5. EMPHASIS

The device is the prefab's `+WORD` accent (its title reads `COMO SER +ORIGINAL`): exactly ONE hero
unit per beat gets a literal `+` prepended to its text — same font, same size, same color, same
animation, nothing else changes. Pick rule, no judgment:
1. Any unit containing a digit wins (the first such unit if several).
2. Otherwise the unit with the most LETTERS (ignore `+ ' - ? !` when counting). COUNT CAREFULLY —
   e.g. ACTUALLY = 8 letters beats MONDAYS = 7 (no tie there).
3. Tie (equal letter counts only) → the LATER unit.
For a glued unit the `+` goes on its FIRST span (`+TO-DO`). Every beat has exactly one hero, never two.

## BOUNDED VARIETY

DETERMINISTIC — no variety axes: every element (hero pick, line rule, sizing, chrome, windows) is rule-derived from word-timings.json; the poster identity is a single fixed composition. Validators: a variety sample of this sheet is by design byte-identical to the default sample.

## 6. VERIFY LOOP

Run from the repo root `{repo}` (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Exit 1 → apply the mechanical fix for the named element, re-run; at most 2 fix cycles:

- `FAIL[bounds] #b{N}l{K} … left/right/bottom outside` → replace that BEAT's size class with the next
  class DOWN the ladder (e.g. `t64` → `t59`) on ALL its lines AND update every line's inline `top`
  from the new class's table row. Same beat fails again → step down once more.
- `FAIL[never-visible] #cue{N}` or one of its lines → check, in order: (1) the cue has ALL THREE
  inline values (`z-index:{10+N}`, `animation-delay`, `animation-duration` in ms); (2) each word span
  has class `w` and its `delayMs` belongs to THIS beat in `word-timings.json`; (3) the `<video>` is
  the first body element with the skeleton's `z-index:0`; (4) no unclosed `</div>` in that beat.
- `FAIL[occluded] #b{N}…` → two windows overlap: confirm each `{winMs}` equals the NEXT beat's
  `cueDelayMs` minus this beat's, cues appear in DOM in beat order, and every cue's inline z-index is
  `10+N`. Fix the arithmetic/typo; never change the skeleton's z layers (chrome 2).
- Exit 2 → engine render failure: re-diff your file against the SKELETON block; the divergence is the bug.

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --record {repo}/runs/<key>/final/out.silent.mp4
```

Manifest line (already given in section 2): `{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json`

## 7. DO NOT

- No fonts, colors, shadows, sizes, or keyframes beyond this sheet — two fonts (DM Serif Display
  italic, Albert Sans), one red `#e62129`; no panel/scrim of any kind (text sits directly on the raw
  footage), no text-shadow, no rotations anywhere.
- Never change, translate, or transcript-derive the chrome text (`THE INTERNET / PRESENTS / BASED ON
  A TRUE STORY / COMING SOON / LIKE, REALLY SOON / TRUST US :P` is final dressing) and never put a
  spoken word into a chrome slot — every spoken word lives in a `.tl` headline line.
- No invented timing: word delays and `cueDelayMs`/`winMs` come from `word-timings.json` (+ the one
  subtraction); chrome delays stay exactly as in the skeleton.
- Never set `line-height` on `.tl` or re-create the prefab's 0.92 leading any other way — the table
  tops ARE the leading. Never use `<br>`; lines exist only as the absolute `.tl` divs you computed.
- No animated `filter:blur`, no descendant selectors — flat classes/ids exactly as in the skeleton.
- No reading video frames, no ffmpeg, no visual self-checks — `--verify` is the only check; no
  redesign after a failure, only the mechanical fixes in section 6.
