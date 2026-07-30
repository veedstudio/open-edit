> **AUTHORITY NOTE (2026-07-21):** `recipe.ts` next door is the single source of truth — the
> curation pass (design rounds v2–v6) edited the MODULE only and this sheet has NOT been synced.
> Do not recompile the module from this sheet until it is re-derived.

# hook-015 — recipe (scattered handwritten collage)

Inputs (module derivation offline; creative-pass craft substrate at run time): this sheet + this ref's `template.wv` (design authority, already encoded below) +
`runs/<key>/word-timings.json` + `runs/<key>/meta.json` + `runs/<key>/transcript.json`.
Output: `runs/<key>/final/template.wv` + `runs/<key>/final/manifest.json`.
All px in this sheet are ALREADY rescaled for the 736×1312 @25fps canvas (prefab 720×1280 × 1.022).
If `meta.json` is not 736×1312, STOP and report — do not rescale yourself.

## 1. IDENTITY

Scattered kinetic collage: handwritten Caveat phrases on cream paper pills (plus one bare white
"aside" line), each pinned at its own slightly-rotated spot down the canvas, popping in word-cluster
by word-cluster with a slide-from-bottom + motion-blur + fade; hand-drawn cream doodle arrows as
fixed decoration.

## 2. SKELETON

Paste this whole document, then fill: `{videoPath}` (from `meta.json`), the per-beat `.cue` blocks
(section 3), and `{DUR}` in the manifest (= `durationSec` from `meta.json`, full clip).

```html
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:736px; height:1312px; position:relative; overflow:hidden; margin:0;
         font-family:'Caveat', cursive; background:#3a3640; }
  .vid { position:absolute; inset:0; width:736px; height:1312px; object-fit:cover; z-index:0; }

  /* beat gate — the one safe reveal recipe. Delay+duration are set INLINE per beat. */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position:absolute; inset:0; z-index:10; opacity:0;
         animation:cueWin linear forwards; }

  /* ---- SLOTS (self-contained single classes; rotation is baked into each slot's own
          keyframes — NEVER var() in a transform). Set A = odd beats, Set B = even beats. ---- */
  .sA1 { position:absolute; z-index:2; left:70px;  top:250px; display:inline-block; white-space:nowrap;
         color:#1c1a22; background:#ece6d6; font-weight:600; line-height:1; padding:4px 12px 8px;
         box-shadow:0 2px 6px rgba(0,0,0,.35); transform-origin:center; opacity:0;
         transform:rotate(-1.5deg); animation:kA1 .5s cubic-bezier(.2,.7,.3,1) both; }
  .sA2 { position:absolute; z-index:2; right:106px; top:405px; display:inline-block; white-space:nowrap;
         color:#1c1a22; background:#ece6d6; font-weight:600; line-height:1; padding:4px 12px 8px;
         box-shadow:0 2px 6px rgba(0,0,0,.35); transform-origin:center; opacity:0;
         transform:rotate(-1deg); animation:kA2 .5s cubic-bezier(.2,.7,.3,1) both; }
  .sA3 { position:absolute; z-index:2; left:78px;  top:560px; display:inline-block; white-space:nowrap;
         color:#1c1a22; background:#ece6d6; font-weight:600; line-height:1; padding:4px 12px 8px;
         box-shadow:0 2px 6px rgba(0,0,0,.35); transform-origin:center; opacity:0;
         transform:rotate(1.5deg); animation:kA3 .5s cubic-bezier(.2,.7,.3,1) both; }
  .sA4 { position:absolute; z-index:2; right:106px; top:715px; display:inline-block; white-space:nowrap;
         color:#1c1a22; background:#ece6d6; font-weight:600; line-height:1; padding:4px 12px 8px;
         box-shadow:0 2px 6px rgba(0,0,0,.35); transform-origin:center; opacity:0;
         transform:rotate(1deg); animation:kA4 .5s cubic-bezier(.2,.7,.3,1) both; }
  /* slot 5 = the bare "aside" accent (no pill) */
  .sA5 { position:absolute; z-index:2; left:300px; top:900px; display:inline-block; white-space:nowrap;
         color:#fff; font-weight:600; line-height:1; text-shadow:0 1px 4px rgba(0,0,0,.6);
         transform-origin:center; opacity:0; animation:kA5 .5s cubic-bezier(.2,.7,.3,1) both; }

  .sB1 { position:absolute; z-index:2; right:106px; top:265px; display:inline-block; white-space:nowrap;
         color:#1c1a22; background:#ece6d6; font-weight:600; line-height:1; padding:4px 12px 8px;
         box-shadow:0 2px 6px rgba(0,0,0,.35); transform-origin:center; opacity:0;
         transform:rotate(1.5deg); animation:kB1 .5s cubic-bezier(.2,.7,.3,1) both; }
  .sB2 { position:absolute; z-index:2; left:70px;  top:420px; display:inline-block; white-space:nowrap;
         color:#1c1a22; background:#ece6d6; font-weight:600; line-height:1; padding:4px 12px 8px;
         box-shadow:0 2px 6px rgba(0,0,0,.35); transform-origin:center; opacity:0;
         transform:rotate(1deg); animation:kB2 .5s cubic-bezier(.2,.7,.3,1) both; }
  .sB3 { position:absolute; z-index:2; right:106px; top:575px; display:inline-block; white-space:nowrap;
         color:#1c1a22; background:#ece6d6; font-weight:600; line-height:1; padding:4px 12px 8px;
         box-shadow:0 2px 6px rgba(0,0,0,.35); transform-origin:center; opacity:0;
         transform:rotate(-1.5deg); animation:kB3 .5s cubic-bezier(.2,.7,.3,1) both; }
  .sB4 { position:absolute; z-index:2; left:78px;  top:730px; display:inline-block; white-space:nowrap;
         color:#1c1a22; background:#ece6d6; font-weight:600; line-height:1; padding:4px 12px 8px;
         box-shadow:0 2px 6px rgba(0,0,0,.35); transform-origin:center; opacity:0;
         transform:rotate(-1deg); animation:kB4 .5s cubic-bezier(.2,.7,.3,1) both; }
  .sB5 { position:absolute; z-index:2; left:130px; top:915px; display:inline-block; white-space:nowrap;
         color:#fff; font-weight:600; line-height:1; text-shadow:0 1px 4px rgba(0,0,0,.6);
         transform-origin:center; opacity:0; animation:kA5 .5s cubic-bezier(.2,.7,.3,1) both; }

  /* slide-from-bottom + blur + fade, rotation held constant per keyframes (prefab-proven) */
  @keyframes kA1 {0%{opacity:0;filter:blur(12px);transform:rotate(-1.5deg) translateY(0.7em)}60%{filter:blur(2px)}100%{opacity:1;filter:blur(0);transform:rotate(-1.5deg) translateY(0)}}
  @keyframes kA2 {0%{opacity:0;filter:blur(12px);transform:rotate(-1deg) translateY(0.7em)}60%{filter:blur(2px)}100%{opacity:1;filter:blur(0);transform:rotate(-1deg) translateY(0)}}
  @keyframes kA3 {0%{opacity:0;filter:blur(12px);transform:rotate(1.5deg) translateY(0.7em)}60%{filter:blur(2px)}100%{opacity:1;filter:blur(0);transform:rotate(1.5deg) translateY(0)}}
  @keyframes kA4 {0%{opacity:0;filter:blur(12px);transform:rotate(1deg) translateY(0.7em)}60%{filter:blur(2px)}100%{opacity:1;filter:blur(0);transform:rotate(1deg) translateY(0)}}
  @keyframes kA5 {0%{opacity:0;filter:blur(12px);transform:translateY(0.7em)}60%{filter:blur(2px)}100%{opacity:1;filter:blur(0);transform:translateY(0)}}
  @keyframes kB1 {0%{opacity:0;filter:blur(12px);transform:rotate(1.5deg) translateY(0.7em)}60%{filter:blur(2px)}100%{opacity:1;filter:blur(0);transform:rotate(1.5deg) translateY(0)}}
  @keyframes kB2 {0%{opacity:0;filter:blur(12px);transform:rotate(1deg) translateY(0.7em)}60%{filter:blur(2px)}100%{opacity:1;filter:blur(0);transform:rotate(1deg) translateY(0)}}
  @keyframes kB3 {0%{opacity:0;filter:blur(12px);transform:rotate(-1.5deg) translateY(0.7em)}60%{filter:blur(2px)}100%{opacity:1;filter:blur(0);transform:rotate(-1.5deg) translateY(0)}}
  @keyframes kB4 {0%{opacity:0;filter:blur(12px);transform:rotate(-1deg) translateY(0.7em)}60%{filter:blur(2px)}100%{opacity:1;filter:blur(0);transform:rotate(-1deg) translateY(0)}}

  /* doodle arrows — decoration, fixed positions, z BELOW the slots (no base filter here) */
  .arrow { position:absolute; z-index:1; opacity:0; }
  .arrow path { fill:#f2efe6; }
  @keyframes ar0 {0%{opacity:0;filter:blur(10px);transform:translateY(0.6em)}100%{opacity:1;filter:blur(0);transform:translateY(0)}}
  @keyframes ar1 {0%{opacity:0;filter:blur(10px);transform:scaleX(-1) rotate(8deg) translateY(0.6em)}100%{opacity:1;filter:blur(0);transform:scaleX(-1) rotate(8deg) translateY(0)}}
  @keyframes ar2 {0%{opacity:0;filter:blur(10px);transform:rotate(6deg) translateY(0.6em)}100%{opacity:1;filter:blur(0);transform:rotate(6deg) translateY(0)}}
</style>

<video class="vid" src="{videoPath}" muted></video>

<!-- one .cue block per beat, from section 3 -->
```

Manifest — write `runs/<key>/final/manifest.json` EXACTLY (only `{DUR}` substituted):

```json
{"render":{"width":736,"height":1312,"fps":25,"duration":{DUR}}}
```

## 3. PER-BEAT ASSEMBLY

One `.cue` per beat in `word-timings.json`, in order. Beat template (placeholders from that beat):

```html
<div class="cue" id="cue{N}" style="animation-delay:{cueDelayMs}ms; animation-duration:{cueDurMs}ms;">
  <div class="{slotClass}" id="b{N}s{K}" data-node-role="text"
       style="font-size:{fs}px; letter-spacing:{ls}px; animation-delay:{phraseDelayMs}ms;">{phrase}</div>
  <!-- one div per used slot, K = 1..k in reading order -->
  <!-- ARROW line: only in arrow beats (rule D below), copied verbatim from rule D -->
</div>
```

`{N}` = beat index `i`. `{phraseDelayMs}` = the `delayMs` of the phrase's FIRST word, verbatim.
`{phrase}` = the phrase's words joined with single spaces, spelling/punctuation verbatim from
`word-timings.json` (every spoken word appears exactly once, reading order, none dropped).

### A. Words → slots (deterministic)

Let `n` = the beat's word count, `k = min(n, 5)` slots used.

Group the words IN ORDER into `k` phrases by this table (numbers = words per phrase, front-loaded):

| n | phrase sizes |
|---|---|
| 1–5 | 1 each (k = n) |
| 6 | 2,1,1,1,1 |
| 7 | 2,2,1,1,1 |
| 8 | 2,2,2,1,1 |
| 9 | 2,2,2,2,1 |
| 10 | 2,2,2,2,2 |
| 11 | 3,2,2,2,2 |
| 12 | 3,3,2,2,2 |
| 13 | 3,3,3,2,2 |
| 14 | 3,3,3,3,2 |
| 15+ | base=floor(n/5); first (n mod 5) phrases get base+1 |

Char-balance fix (apply at most twice per beat, then stop): if a phrase exceeds 28 chars and an
ADJACENT phrase is ≥8 chars shorter, move one word from the long phrase's touching edge to that
neighbour (order preserved). Chars = letters+punctuation+inner single spaces, i.e. exactly what
you will type into the div.

### B. Slot classes (which positions)

Odd beat `i` → Set A, even → Set B. `k` phrases occupy a CONTIGUOUS run of slots; start slot
`s = 1 + floor((5−k)/2)`:

**KNOWN `--verify` FALSE POSITIVE (cross-beat slot reuse).** This layout time-multiplexes fixed slot
positions across beats (the `.cue` gate shows exactly one beat at a time), and the current engine's
`--verify` occlusion pass ignores the ancestor opacity gate (engine bug
`2026-07-09-verify-occlusion-ignores-cue-opacity-gate.md` in the weave-renderer repo’s `rendering-bugs/`) — it flags a later beat's pill as "covering" an
earlier beat's glyphs at the same slot even though they are never on screen together. Mechanical carve-out,
applied EXACTLY as stated: if `--verify` reports ONLY `FAIL[occluded]` lines (zero `[bounds]`, zero
`[never-visible]`, zero `[expect-*]`), treat the run as VERIFIED-WITH-KNOWN-EXCEPTION — proceed to
`--record` and state the exception in your report. Any `[bounds]` or `[never-visible]` line is real and
must be fixed per section 6 as usual. Do NOT move slot anchors to appease the occlusion rule; remove this
carve-out when the engine bug is fixed.

| k | slots used (in reading order) |
|---|---|
| 1 | 3 |
| 2 | 2,3 |
| 3 | 2,3,4 |
| 4 | 1,2,3,4 |
| 5 | 1,2,3,4,5 |

So a 3-word odd beat uses `.sA2 .sA3 .sA4`; a 5+-word even beat uses `.sB1`…`.sB5`. Slot 5 (the
bare white aside) only ever appears when k=5 — it is the punch line accent.

### C. Sizing table (by phrase char count — widths are pre-budgeted, do not measure)

| phrase chars | font-size | letter-spacing |
|---|---|---|
| 1–12 | 46px | 7px |
| 13–16 | 42px | 6px |
| 17–20 | 38px | 5px |
| 21–24 | 34px | 4px |
| 25–28 | 30px | 3px |
| 29–35 | 26px | 2px |

>35 chars must not happen — if it does, move the phrase's last word to the next slot (or previous,
if it is the last slot) and re-size both phrases from this table.

### D. Arrows (fixed decoration — never move them, never add more)

- Beat 1 gets ARROW-1. The LAST beat gets ARROW-3. If there are ≥5 beats, beat `ceil(beatCount/2)`
  gets ARROW-2 (skip if that beat is beat 1 or the last beat).
- Paste inside that beat's `.cue`, after the slot divs; `{D}` = that beat's `cueDelayMs + 300`:

```html
<!-- ARROW-1 -->
<svg class="arrow" id="b{N}arr" viewBox="0 0 110 95" width="112" height="97"
     style="left:72px; top:322px; animation:ar0 .5s cubic-bezier(.2,.7,.3,1) both; animation-delay:{D}ms;">
  <path d="M30 6 C70 6 78 20 70 48 L86 42 L62 82 L40 46 L58 50 C64 28 56 22 30 22 Z"/>
</svg>
<!-- ARROW-2 -->
<svg class="arrow" id="b{N}arr" viewBox="0 0 110 110" width="112" height="112"
     style="left:500px; top:470px; transform:scaleX(-1) rotate(8deg); animation:ar1 .5s cubic-bezier(.2,.7,.3,1) both; animation-delay:{D}ms;">
  <path d="M22 6 C66 4 80 22 72 56 L90 48 L64 94 L40 52 L60 58 C66 32 56 24 22 24 Z"/>
</svg>
<!-- ARROW-3 -->
<svg class="arrow" id="b{N}arr" viewBox="0 0 110 110" width="112" height="112"
     style="left:505px; top:930px; transform:rotate(6deg); animation:ar2 .5s cubic-bezier(.2,.7,.3,1) both; animation-delay:{D}ms;">
  <path d="M22 6 C66 4 80 22 72 56 L90 48 L64 94 L40 52 L60 58 C66 32 56 24 22 24 Z"/>
</svg>
```

## 4. WORDS + TIMING

- This ref is PHRASE-level (like glyph-level refs, the reveal unit follows the ref): the reveal
  unit is the slot phrase, and its `animation-delay` = the `delayMs` of the phrase's FIRST word,
  copied VERBATIM from `word-timings.json`. All `delayMs`/`cueDelayMs` values are absolute
  timeline milliseconds — never rebase, never invent, never round.
- Each beat's `.cue` gets `animation-delay:{cueDelayMs}ms; animation-duration:{cueDurMs}ms`
  inline, verbatim from `word-timings.json`.
- Word spacing inside a phrase: plain single spaces inside ONE text node (one div per phrase, no
  inner spans — inter-span whitespace would be dropped). Slots are `display:inline-block` +
  `white-space:nowrap`; never change either.

## 5. EMPHASIS

Hero pick per beat, no judgment: the beat's longest CONTENT word (skip: a, an, the, and, or, but,
so, to, of, in, on, at, with, my, we, is, are, was, it, this, that, for, be, I, i, mine's, here's).
Any word containing a digit wins over all others. Tie → the earlier word. In the LAST beat the
hero is the beat's LAST content word instead.

Device: the slot phrase CONTAINING the hero uses this bumped sizing row instead of table C —
only if its char count allows:

| phrase chars | font-size | letter-spacing |
|---|---|---|
| 1–12 | 52px | 8px |
| 13–16 | 46px | 7px |
| ≥17 | no bump — keep table C |

If the hero lands in slot 5 (the white aside), no bump — the contrast style IS the accent.

## 6. VERIFY LOOP

Write the files, then run (verbatim; `<key>` = the run key):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Exit 1 → apply the MECHANICAL fix for each named element, re-run; at most 2 fix
cycles:

- `FAIL[bounds]` left/right on a slot → drop that phrase ONE sizing row (table C / table 5). If
  already at 26px, move the phrase's edge word (the side nearest its neighbour) to the adjacent
  used slot and re-size both. Never move a slot's left/right anchor.
- `FAIL[bounds]` top/bottom on a slot → move that slot's `top` inward (down for top-fails, up for
  bottom-fails) by the reported overflow rounded up + 8px, on that beat's inline style only.
- `FAIL[bounds]` on an arrow → delete that arrow (decoration is expendable; text is not).
- `FAIL[never-visible]` → check, in order: the element's class name is one of the skeleton
  classes; its `animation` name exists in `<style>`; its `.cue` parent has the inline
  delay/duration; `.cue` has `z-index:10`; the element kept `z-index:2` (slots) / `1` (arrows).
  Fix the typo — do not restyle.
- `FAIL[occluded]` → the covering rect is another pill of the same beat: move the occluded slot's
  `top` 30px away from it (inline, that beat only). If the coverer is an arrow, its z-index was
  changed — restore `z-index:1`.

Then record (a SECOND invocation — verify and record are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --record {repo}/runs/<key>/final/out.silent.mp4
```

## 7. DO NOT

- No fonts, colours, shadows, easings or `@keyframes` beyond this sheet. No new arrows or doodles.
- No invented or rebased timing — every delay/duration comes verbatim from `word-timings.json`.
- Never read frames, never eyeball renders, never run ffmpeg checks — `--verify` is the only check.
- Never drop, reorder or paraphrase a spoken word; every word appears in exactly one phrase.
- No `var()` anywhere in a transform or keyframe; rotations stay baked in the given keyframes.
- No scrim/box behind slot 5; no background on `.sA5`/`.sB5` (the bare aside is intentional).
- Do not move slot anchors or arrow positions except via the exact fixes in section 6.
- Do not redesign, re-balance layout aesthetically, or add legibility passes.
