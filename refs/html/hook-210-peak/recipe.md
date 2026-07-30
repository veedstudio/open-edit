> **AUTHORITY NOTE (2026-07-21):** `recipe.ts` next door is the single source of truth — the
> curation pass (design rounds v2–v6) edited the MODULE only and this sheet has NOT been synced.
> Do not recompile the module from this sheet until it is re-derived.

# RECIPE — hook-210-peak (9:16 · 736×1312 @ 25fps)

RESOLUTION: px are authored at the 9:16 reference canvas 736×1312. FIRST STEP: SCALE = W/736 from
`meta.json` (require |H − 1312·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE and round (positions, sizes, fonts, px spacing/shadows/margins/tops);
`em` values and ms timings never scale; the manifest carries the run's real W/H. The accent font-size is
COMPUTED (§3 FIT LAW) from `BLOCK_W`; since `BLOCK_W` is a scaled px width the result already rides SCALE —
do not scale the accent size a second time.

## 1. IDENTITY

An optically-centred, upper-third caption stream: a small sentence-case handwritten Kalam line above a
monumental yellow Anton accent that FILLS the block width (one or two words sized to the box). Every word
rises up from just below and holds; each page then fades out as a whole the instant the next page rises —
a clean hand-off, never two accents printed at once. The caption is a continuous flow-through of a few
words at a time, never a static block.

## 2. SKELETON

Prefab is 720×1280; all px below are ALREADY rescaled ×1.022 for the 736×1312 canvas — copy them
verbatim, do not rescale again. Placeholders: `{W} {H} {FPS} {DUR}` from `meta.json` (expect
736 / 1312 / 25), `{videoPath}` = the run's video path.

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Kalam:wght@300&family=Permanent+Marker&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: {W}px; height: {H}px; overflow: hidden; }
  body { position: relative; font-size: 0; background: #000; }
  .vid { position: absolute; inset: 0; width: {W}px; height: {H}px; object-fit: cover; z-index: 0; }

  /* beat gate — the one safe reveal recipe; delay+duration set inline per beat */
  @keyframes cueWin { 0%, 99.99% { opacity: 1; } 100% { opacity: 0; } }
  .cue { position: absolute; left: 81px; top: 175px; width: 574px; height: 420px;
         opacity: 0; animation-name: cueWin; animation-timing-function: linear;
         animation-fill-mode: forwards; }

  /* a page = one small-line + big-line pair; every page TOP-aligns INSIDE the cue box (fixed anchor
     at the box top, horizontally centred) so the block's top edge stays put at every beat regardless
     of accent size — content only ever grows DOWN from the fixed top, never drifting up into the
     16–20% band or shifting the block's read position beat to beat. */
  .pg { position: absolute; left: 0; top: 0; width: 574px; height: 420px;
        display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
        text-align: center; }
  /* mid-beat pages carry .fade (§4); the beat's LAST page never does — it rides the cue gate. */
  .pg.fade { animation-name: pageFade; animation-timing-function: linear; animation-fill-mode: forwards; }

  .line1 { font-family: 'Kalam', 'Permanent Marker', cursive; font-weight: 300;
           font-size: 57px; line-height: 1.3; letter-spacing: 3px; color: #ffffff;
           margin-top: -7px;
           text-shadow: 0 2px 6px rgba(0,0,0,0.8), 0 0 18px rgba(0,0,0,0.6); }
  /* line1 carries the SAME headroom-closing trick as line2's -18px: Kalam's line-height:1.3 leading +
     the font's own ascent gap put the visible ink ~22px below the .cue top (175) — measured ink top
     ~197px against a ~190px art-directed target. -7px closes that residual without touching line-height
     (which would also compress the line1→line2 gap) — it shifts the WHOLE line1 box (and, by flex flow,
     line2 with it) up by exactly 7px, so the kicker/accent gap is unchanged. */
  .line2 { font-family: 'Anton', 'Impact', sans-serif; font-weight: 400;
           line-height: 1.24; letter-spacing: 2px; color: #f0d10a;
           margin-top: -18px; text-shadow: 0 3px 10px rgba(0,0,0,0.7), 0 0 30px rgba(0,0,0,0.65); }
  /* the shadow is ONE soft-halo idiom (both layers blurred, no offset block): it grounds the white/yellow
     over the bright-office beats — the composition sits in the upper third where the footage is lightest,
     so a soft ambient halo is baked in (light-on-light, hook-224). Do not add a hard/offset layer. */
  /* line2 has NO size class — its font-size is COMPUTED per accent by the FIT LAW (§3) and set inline. */
  /* line1 fallback rows (single over-long word only) */
  .k45  { font-size: 45px; }
  .k34  { font-size: 34px; }

  /* words: rise up from below, then HOLD (no per-word exit — the page fades as a unit, see .fade).
     delay + duration are set INLINE per word (delay = word-timings delayMs VERBATIM). */
  .w  { display: inline-block; opacity: 0;
        animation-name: riseIn; animation-timing-function: ease-out; animation-fill-mode: both; }
  .sp { display: inline-block; width: 0.3em; }
  @keyframes riseIn {
    0%   { opacity: 0; transform: translateY(64px); }
    65%  { opacity: 1; transform: translateY(0); }
    100% { opacity: 1; transform: translateY(0); }
  }
  /* page-level exit: the WHOLE page fades together (opacity only — a transform here would sit above the
     animated words and break them). ONE group fade instead of staggered per-word exits is what keeps two
     accents from ever cross-printing at the shared anchor (hook-210 v1/v3). */
  @keyframes pageFade { 0% { opacity: 1; } 100% { opacity: 0; } }
</style>
<video class="vid" src="{videoPath}" muted></video>
<!-- one .cue per beat, appended here in beat order -->
```

Placement is FIXED for every beat: the `.cue` box is `left:81px; top:175px; width:574px; height:420px`
and each `.pg` TOP-aligns inside it (`justify-content: flex-start`), staying horizontally centred
(`align-items: center`). `left:81 … right:655` is the symmetric 11% band, so the block is optically
centred on the canvas (centre x 368 = W/2), not merely inside the safe band. The box top at 175 puts the
block's visible top edge just under the 144px (11%) top safe line — the tight end of the art-directed
~175–200px band, chosen to buy every last px of face clearance. Because pages top-align rather than
centre, the block's top edge is IDENTICAL at every beat regardless of accent height; only the bottom
grows/shrinks with content. KNOWN RESIDUAL: the FIT-LAW-capped accents (190px — `THING.`/`SAVED.`/
`DURING`; and the near-cap 173–183px — `INVITE,`/`BEEN AN`) still run tall enough (line2 optical height
≈ 190–215px on top of line1's ≈56px net) that their ink reaches into this speaker's eye line even pinned
at the safe-top floor — geometrically the accent height (fixed by §3's FIT LAW, out of scope for a
position-only edit) exceeds the headroom between the 144px floor and this speaker's eyes. There is no
upward exit slide, so the +64px entrance dips DOWN from the resting position and never threatens the top
line; the block's bottom stays far above the 17% line at 1089px on every beat. Do not vary placement per
beat.

## 3. PER-BEAT ASSEMBLY

One `.cue` per beat `{N}` of `word-timings.json`:

```html
<div class="cue" id="cue{N}" style="z-index:{10+N}; animation-delay:{cueDelayMs}ms; animation-duration:{winMs}ms;">
  <div class="pg fade" style="animation-delay:{fadeStartMs}ms; animation-duration:200ms;">
    <div class="line1" id="b{N}p1l1" data-node-role="text"><!-- line1 word spans --></div>
    <div class="line2" id="b{N}p1l2" style="font-size:{fsPx}px" data-node-role="text"><!-- line2 word spans --></div>
  </div>
  <!-- more .pg blocks for the same beat; the LAST page of the beat drops the `fade` class + its inline anim -->
</div>
```

**Window** (extends the gate to the next beat so the last page can hold — pure subtraction):
- `{winMs}` = next beat's `cueDelayMs` − this beat's `cueDelayMs`.
- Last beat: `{winMs}` = round(`durationSec`×1000 from `meta.json`) − its `cueDelayMs`.

**Paging rule** — map the beat's `words[]` (ORDER PRESERVED, every token used exactly once) onto pages.
Char count = letters+punctuation of each word, +1 per space between words. Walk left to right:

1. **line1**: add words while ALL hold — (a) line1 stays ≤ 15 chars, (b) line1 has ≤ 4 words,
   (c) at least 1 word remains for line2. Stop before the first violation.
2. **line2** (the accent): take the next word. Add a 2nd word only if the pair (incl. the space) is ≤ 9 chars.
3. If words remain, start the next `.pg` at step 1.
4. If a page begins with exactly ONE word left in the beat, omit line1 and put that word in line2.

**CASE** (edit): line1 words render VERBATIM from `word-timings.json` — the transcript is already
sentence-case (`So I built an`, `it auto`, `10,000 hours`) — keep it. line2 (the accent) words are
UPPERCASED. Punctuation and leading hyphens are kept on both. (Char counts are case-independent; paging
is unchanged.)

**ACCENT FIT LAW** (edit — the accent FILLS the block width; size via font-size, never glyph stretch):
compute the accent font-size so its rendered width equals the block. Closed form, one reading only —

```
L  = accent glyph count  (letters + punctuation of ALL its words; spaces NOT counted)
S  = spaces INSIDE the accent (0 for one word, 1 for a two-word accent)
fsPx = clamp( (574 − 2·(L − 1)) / (0.463·L + 0.30·S) , 64 , 190 )   → round
```

`0.463` = Anton's calibrated per-glyph advance in em at letter-spacing 2px (worst-case average from the
sheet's own width calibration — using the wide end guarantees the fill never overflows the box); `0.30` =
the `.sp` spacer em; `2` = the accent letter-spacing px; `574` = `BLOCK_W`. The `190` cap is a HEIGHT guard
(a 5–6 glyph accent would otherwise tower and crash the talking head) — it fills ≥ ~90% and reads as full;
the `64` floor never binds on real speech. Set the result INLINE: `style="font-size:{fsPx}px"` on the
`line2` div. Worked sizes (this content): `THING.`/`SAVED.`/`DURING` → 190 (capped) · `BEEN AN` → 176 ·
`INVITE,` → 173 · `APP THAT` → 158 · `REPLIES.` → 151 · `POINTLESS`/`MEETINGS.` → 134 ·
`PROFESSIONALLY.` → 79.

**line1 sizing** (the accent is now self-sizing; line1 keeps a fallback for a lone monster word only):

| line1 chars | class (size) |
|---|---|
| ≤ 15 | base (57px) |
| 16–18 | `k45` |
| 19–22 | `k34` |

(The paging rule caps normal line1 at 15 chars; the `k` rows only ever apply to a single over-long word.)

**Worked example** (beat 6, words `And I built it during meetings.`, cueDelayMs 9840, next beat = none →
last beat, winMs = round(12.051×1000) − 9840 = 2211):
- p1 (`.pg fade`): line1 `And I built it` (14 ✓, verbatim case) · line2 `DURING` (accent, L 6 S 0 → 190px).
  fadeStartMs = 11600 − 200 = 11400 (see §4).
- p2 (LAST page → NO `fade`): line2 `MEETINGS.` (L 9 S 0 → 134px); rides the cue gate.

## 4. WORDS + TIMING

- One `<span class="w">` per token from `word-timings.json` `words[]` (line1 verbatim case, line2
  UPPERCASED — §3). Between two words in the same line: `<span class="sp"></span>` (inter-span whitespace
  is dropped by the engine — the spacer IS the space).
- Each word span gets, inline: `animation-delay:{delayMs}ms` — that word's `delayMs` VERBATIM, never
  recomputed — and `animation-duration:{enterMs}ms` where
  `{enterMs}` = clamp(`nextStart` − `delayMs`, 200, 600):
  - `nextStart` = the FIRST word `delayMs` of the NEXT page of the SAME beat;
  - for the beat's LAST page, `nextStart` = `winEnd` = this beat's `cueDelayMs + winMs`.
  Each word rises in and then HOLDS (the `riseIn` curve holds full from 65% on); it does not exit on its
  own — the page fade does.
- **Page hand-off (the anti-collision mechanic).** Every page EXCEPT the beat's last carries `class="pg fade"`
  with `style="animation-delay:{fadeStartMs}ms; animation-duration:200ms"`, where
  `{fadeStartMs}` = `nextStart` − 200 (`nextStart` = the next page's first word `delayMs`). The whole page
  fades 1→0 over 200ms, reaching 0 EXACTLY as the next page's words begin rising from 0 — so a page and its
  successor are never both inked at the shared anchor (this is the fix for the yellow-accent cross-print).
  The beat's LAST page gets NO `fade` (plain `class="pg"`, no inline anim): it holds full and the cue gate
  (`cueWin`) cuts it at beat end — fading the last page would leave dead air before the next beat.
  Where a word is spoken < ~250ms before the next page (dense speech), its `enterMs` floors at 200 and it
  overlaps the fade — it shows only briefly BY DESIGN; the hand-off stays clean because the fade is one
  group opacity, not a per-word stagger.
- The beat's `.cue` gets inline `animation-delay:{cueDelayMs}ms; animation-duration:{winMs}ms` exactly as §3.
- Word span example (line2 accent):
  `<span class="w" style="animation-delay:11400ms; animation-duration:200ms;">DURING</span>`
  (rendered inside `<div class="line2" style="font-size:190px">…`).

## 5. EMPHASIS

The emphasis device is STRUCTURAL and already produced by the paging + FIT LAW: every page's final word(s)
land in line2 — the width-filling yellow Anton accent — so the beat's closing words are automatically the
heroes. Do NOT add any other emphasis: no color swaps, no per-word scale, no styling beyond the classes and
the computed `font-size` in this sheet.

## BOUNDED VARIETY

DETERMINISTIC — no variety axes: the FIT LAW sizes every accent from its content box and §5 deliberately forbids variety devices; paging is fully rule-derived. Validators: a variety sample of this sheet is by design byte-identical to the default sample.

## 6. VERIFY LOOP

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Otherwise apply the MECHANICAL fix for the named element and re-run (≤ 2 fix cycles):
- `FAIL[bounds] … left/right outside` on a `b{N}p{P}l2` id → the computed accent overflowed (a very wide
  glyph run): multiply that `line2`'s inline `font-size` by 0.94 and round; re-run. (Do NOT touch the FIT
  LAW constants — the per-run nudge stays local.)
- `FAIL[bounds] … left/right outside` on a `l1` id → move that line1 one row DOWN the line1 table
  (base → `k45` → `k34`).
- `FAIL[bounds] … top outside` (ink above the viewport) → increase the `.cue` `top` by the reported
  overshoot rounded up to the next 10px (single shared value; lowers the whole block).
- `FAIL[never-visible]` → that span's `animation-delay` is outside its beat's cue window: re-check the word
  was pasted into the RIGHT beat's `.cue` with its own `delayMs`; also confirm the `.cue` carries its
  inline `z-index`.
- `FAIL[occluded]` → two cue windows overlap: re-check each `{winMs}` equals the next beat's `cueDelayMs`
  minus this beat's, and that every `.cue` has its `z-index:{10+N}`.

Then record (separate invocation, only after exit 0):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --record {repo}/runs/<key>/final/out.silent.mp4
```

`manifest.json`, verbatim shape:

```json
{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}
```

## 7. DO NOT

- No fonts, colors, shadows, or keyframes beyond this sheet — the `riseIn`/`pageFade`/`cueWin` curves, the
  two fonts, `#f0d10a`/`#ffffff` are the whole system.
- No per-word exit animation and no transform on any word-ancestor (`.cue`/`.pg`) — the page exit is one
  group `pageFade` (opacity only); a stagger or an ancestor transform re-breaks the accents.
- No invented sizes or timing: the accent `font-size` comes ONLY from the §3 FIT LAW; every
  `animation-delay` is VERBATIM from `word-timings.json`; durations only via the §4 clamps.
- No reading frames, no ffmpeg, no visual checks — `--verify` is the only self-check.
- No `var()` in transforms or keyframes, no animated `filter:blur`, no `text-transform` reliance —
  set line1 verbatim case and line2 uppercase in the strings yourself.
- No redesign after render; fix only elements `--verify` names, only by the §6 rules.
