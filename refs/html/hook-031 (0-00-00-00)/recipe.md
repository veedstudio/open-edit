> **AUTHORITY NOTE (2026-07-21):** `recipe.ts` next door is the single source of truth — the
> curation pass (design rounds v2–v6) edited the MODULE only and this sheet has NOT been synced.
> Do not recompile the module from this sheet until it is re-derived.

# RECIPE — hook-031 (0-00-00-00) · brutalist split-ledger stack (9:16 · 736×1312 @ 25fps)

RESOLUTION: px are authored at the 9:16 reference canvas 736×1312. FIRST STEP: SCALE = W/736 from
`meta.json` (require |H − 1312·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE and round (positions, sizes, fonts, px spacing/shadow offsets/blurs);
`em` values and ms timings never scale; the manifest carries the run's real W/H.

Prefab is 720×1280; every px below is ALREADY rescaled ×1.022 — copy numbers as written, never rescale again.

## 1. IDENTITY

A brutalist typographic ledger over FULL-BLEED footage: up to five fixed rows of huge yellow Fjalla One
caps stack down the frame, early rows split into a left phrase counterposed against a right-flushed one
(poster space-between), later rows flush left; words reveal by plain eased alpha fade on their real
spoken timing; each beat's stack accumulates, holds, and the cue gate cuts it.

## 2. SKELETON

Paste this whole document as `runs/<key>/final/template.wv`, then insert one `.cue` block per beat
(section 3) after the video. Replace only `{videoPath}` (from `meta.json`) and `{DUR}` (`durationSec`,
manifest only). The footage is FULL-BLEED at z0 — no chrome covers it; the dark `text-shadow` on `.w`
grounds the yellow ink over light footage (the prefab's flat dark demo bg hid this need).

```html
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fjalla+One&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:736px; height:1312px; position:relative; overflow:hidden; margin:0;
         background:#101010; font-family:'Fjalla One', Impact, "Arial Narrow Bold", sans-serif; }
  .vid { position:absolute; inset:0; width:736px; height:1312px; object-fit:cover; z-index:0; }

  /* beat gate — the one safe reveal recipe; z-index + delay + duration come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position:absolute; inset:0; opacity:0; animation-name:cueWin;
         animation-timing-function:linear; animation-fill-mode:forwards; }

  /* a row group — static layout anchor (only the .w children animate; no flex anywhere).
     gl = flush left, gr = flush right (the split counterweight). */
  .grp { position:absolute; z-index:2; display:inline-block; white-space:nowrap;
         line-height:1.62; letter-spacing:-1px; color:#fede0c; font-weight:400; }
  .gl { left:44px; }
  .gr { right:81px; }

  /* word reveal — the prefab's plain eased alpha fade IN, then HOLD; the cue gate is the only exit.
     Only animation-delay / animation-duration come inline per word. */
  .w { display:inline-block; opacity:0; text-shadow:0 2px 10px rgba(0,0,0,0.7);
       animation-name:wIn; animation-timing-function:cubic-bezier(.2,.7,.3,1); animation-fill-mode:both; }
  @keyframes wIn { 0%{opacity:0} 100%{opacity:1} }
</style>

<video class="vid" src="{videoPath}" muted></video>

<!-- one .cue block per beat, from section 3 -->
```

`manifest.json` (verbatim, `{DUR}` = `durationSec` from `meta.json`; W/H/FPS are the run's real values):

```json
{"render":{"width":736,"height":1312,"fps":25,"duration":{DUR}}}
```

## 3. PER-BEAT ASSEMBLY

One `.cue` per beat `{N}` of `word-timings.json`, in order:

```html
<div class="cue" id="cue{N}" style="z-index:{10+N}; animation-delay:{cueDelayMs}ms; animation-duration:{winMs}ms;">
  <!-- per row j = 1..k, at slot tops from rule B; single row: -->
  <div class="grp gl" id="b{N}r{j}l" data-node-role="text" style="top:{rowTop}px; font-size:{fs}px;">…word spans…</div>
  <!-- split row: the gl div holds the FIRST unit, plus this counterweight: -->
  <div class="grp gr" id="b{N}r{j}r" data-node-role="text" style="top:{rowTop}px; font-size:{fs}px;">…word spans…</div>
</div>
```

**Window**: `{winMs}` = next beat's `cueDelayMs` − this beat's `cueDelayMs`; last beat:
round(`durationSec`×1000) − its `cueDelayMs`. `gateEnd` = `cueDelayMs + winMs`.

**Word prep**: UPPERCASE every token yourself; keep punctuation verbatim. GLUE: a token starting with
`-` merges with the previous word into ONE unit for row packing and char counting; it renders as two
adjacent spans with NO separator between them, each keeping its own verbatim `delayMs`. Chars of a
row = unit chars + 1 per gap between units (exactly `lib.charsOf`).

### A. Units → rows (capacity + regroup, order preserved)

Pack units into rows with `lib.paginate(units, maxChars=12, maxUnits=3)` — a row takes units while
BOTH caps hold; an oversized single unit still gets its own row. If that yields MORE than 5 rows,
bump capacity and repack: `maxChars += 4, maxUnits += 1`, repeat until ≤ 5 rows. k = row count.

### B. Slots (fixed positions — captions take turns at them across beats)

Row tops, fixed for every beat: slot 1 → `265px` · 2 → `423px` · 3 → `582px` · 4 → `740px` · 5 → `899px`.
A beat's k rows occupy a CONTIGUOUS run starting at slot `s = 1 + floor((5−k)/2)` (so k=5 fills 1–5,
k=3 sits at 2–4, k=1 at 3). `{rowTop}` = the slot top of row j.

**Split vs single**: row j (1-based within the beat) is SPLIT iff it has ≥ 2 units AND
`j ≤ ceil(k/2)` — its FIRST unit goes flush left (`.gl`), ALL remaining units flush right (`.gr`).
Every other row is a single left group (`.gl` only, all units). This is the prefab's shape: early
rows counterpose, the closing rows land flush left.

### C. Sizing (ONE font size per beat — the whole stack shares it)

Per row compute the load `L_row = C_eff × (1.07 if split else 1)` where
`C_eff = rowChars + 0.6 × (count of W and M letters in the row)` (W/M ink runs ~60% over the
per-char budget; the 1.07 carries the split row's 40px middle gap). Beat load `L` = max over its
rows. Font size from this table (Fjalla One ink ≈ 0.452em per char at letter-spacing −1px; budget
611px between the x-anchors 44…655):

| L ≤ 9.8 | 11 | 12 | 13.5 | 15 | 17 | 19 | 21.5 | 24 | 28 | >28 |
|---|---|---|---|---|---|---|---|---|---|---|
| 137 | 122 | 112 | 100 | 90 | 79 | 71 | 62 | 56 | 48 | 42 |

`{fs}` goes inline on EVERY group of the beat. 137 is the cap: at the slot-5 top (899px) the ink
bottom (≈1.35em with descending punctuation) stays above the 1089px bottom safe margin.

**Worked example** — portrait-main fixture beat 1 (`So I built an app that does one thing.`,
cueDelayMs 320, next beat 2080 → winMs 1760, gateEnd 2080):
- units: SO·I·BUILT·AN·APP·THAT·DOES·ONE·THING. → rows: [SO I BUILT] [AN APP THAT] [DOES ONE] [THING.]
- k=4 → s=1, tops 265/423/582/740; ceil(4/2)=2 → rows 1,2 split, rows 3,4 single
- r1: gl `SO` | gr `I BUILT` (C=10, L=10.70) · r2: gl `AN` | gr `APP THAT` (C=11, L=11.77)
- r3: gl `DOES ONE` (L=8) · r4: gl `THING.` (L=6) → beat L=11.77 → **fs 112**
- every word duration = min(350, max(250, 2080−delay)) = 350 here; delays 320/400/520/720/840/1000/1160/1400/1680 verbatim

## 4. WORDS + TIMING

- One `<span class="w">` per token: `animation-delay:{delayMs}ms` VERBATIM from
  `runs/<key>/word-timings.json` (absolute timeline ms — never rebase, never invent), plus
  `animation-duration:{durMs}ms` where `{durMs} = min(350, max(250, gateEnd − delayMs))` — the
  entrance compresses when the gate would close before a full 350ms reveal.
- Word gap INSIDE a group: a single `&#160;` text node between unit spans (the prefab's own device;
  inter-span plain whitespace is dropped by the engine). Glued-unit spans are adjacent with no
  separator. Spans stay `display:inline-block`; groups stay `white-space:nowrap`.
- Each beat's `.cue` gets inline `z-index:{10+N}; animation-delay:{cueDelayMs}ms;
  animation-duration:{winMs}ms`. Rows never fade mid-beat — the stack accumulates and HOLDS; the
  cue gate cuts the whole beat at `gateEnd`.
- Word span example (worked example, last word):
  `<span class="w" style="animation-delay:1680ms; animation-duration:350ms">THING.</span>`

## 5. EMPHASIS

This ref's counter-accent is STRUCTURAL, not styled: every split row counterposes its first unit
(flush left) against the rest of the row (flush right), and the beat's last row lands as a short
flush-left punch. No hero word, no color/size bump — the prefab has a single ink (#fede0c) and one
size per stack, and this recipe keeps that. Deterministic by construction (rule B).

## 6. VERIFY LOOP

Write the files, then run (verbatim; `<key>` = the run key):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Exit 1 → apply the MECHANICAL fix per failure class and re-run; at most 2 fix cycles:

- `FAIL[bounds]` naming `#b{N}r{j}l` / `#b{N}r{j}r` → step beat N's ENTIRE stack one row DOWN the
  section-C table (uniform per-beat size; a flagged group never resizes alone). Same beat again →
  one more row. Never move the 44/81 x-anchors or the slot tops.
- `FAIL[never-visible]` → a skeleton typo: the group's class is `grp gl`/`grp gr`; `.cue` carries its
  inline z-index/delay/duration; `.w` spans carry both inline delay AND duration; the `<video>` is
  first with `class="vid"` (z0). Fix the typo — do not restyle.
- `FAIL[occluded]` → beats time-multiplex the same slots, and engine ≥0.6.0 gates occlusion by the
  `.cue` opacity window — a real occlusion means two cue windows overlap: re-check every `{winMs}`
  equals the next beat's `cueDelayMs` minus this beat's, and every `.cue` kept `z-index:{10+N}`.

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --progress-output --record {repo}/runs/<key>/final/out.silent.mp4
```

Manifest line (already given in section 2): `{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}`

## 7. DO NOT

- No fonts, colors, shadows, sizes or keyframes beyond this sheet — Fjalla One, `#fede0c` on footage,
  the one dark text-shadow, the section-C table and the two keyframe blocks are the whole system.
- No invented timing: word delays verbatim; durations only via the section-4 formula; cue windows
  only via the winMs subtraction. No per-row or per-page fade-outs — the gate is the only exit.
- Do not move the slot tops or the 44/81 x-anchors; do not center, re-balance, or swap which side a
  group lands on; the split rule in section B is the only layout authority.
- No flex anywhere; groups stay `position:absolute` + `inline-block`; words stay `inline-block`.
- Never animate `color` or `filter`; no `var()` in transforms/keyframes; no `vw`; no text-transform
  reliance — uppercase the strings yourself.
- Never read the video frames, never run ffmpeg checks — `--verify` is the only self-check.
- No redesign after render or a verify failure — only the mechanical fixes in section 6.
