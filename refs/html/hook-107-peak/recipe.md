> **AUTHORITY NOTE (2026-07-21):** `recipe.ts` next door is the single source of truth — the
> curation pass (design rounds v2–v6) edited the MODULE only and this sheet has NOT been synced.
> Do not recompile the module from this sheet until it is re-derived.

# RECIPE — hook-107-peak (9:16 · 736×1312 @ 25fps)

RESOLUTION: px are authored at the 9:16 reference canvas 736×1312. FIRST STEP: SCALE = W/736 from
`meta.json` (require |H − 1312·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE and round (positions, sizes, fonts, px shadows/margins/tops);
`em` values and ms timings never scale; the manifest carries the run's real W/H.

Prefab is 720×1280; every px below is ALREADY rescaled ×1.0222 — copy numbers as written, never rescale again.

## 1. IDENTITY

A scattered two-font editorial stack over FULL-BLEED footage: sentence-case words step down the canvas
in fixed slots — huge Archivo 800 sans alternating with Playfair Display italic — each fading up on its
spoken timing, while ONE hero word per beat pops scale(0)→scale(1) on a torn-paper red gradient sticker
tilted −3° at mid-frame. (The prefab's flat green demo bg is replaced by the footage; white ink gets a
dark grounding text-shadow.)

## 2. SKELETON

Paste this whole document as `runs/<key>/final/template.wv`, then insert one `.cue` block per beat
(section 3). Replace only `{videoPath}` (from `meta.json`) and `{DUR}` (`durationSec`, manifest only).
Canvas: see RESOLUTION at the top of this sheet. The footage is FULL-BLEED at z0 — no chrome covers it.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:ital,wght@0,800;0,900&family=Playfair+Display:ital,wght@0,500;0,600;1,500;1,600&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:736px; height:1312px; overflow:hidden; background:#000; }
  body { position:relative; }
  .vid { position:absolute; inset:0; width:736px; height:1312px; object-fit:cover; z-index:0; }

  /* beat gate — the one safe reveal recipe; z-index + delay + duration come inline per cue */
  .cue { position:absolute; inset:0; opacity:0;
         animation-name:cueWin; animation-timing-function:linear; animation-fill-mode:forwards; }
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }

  /* scattered slot text — white ink over footage needs the dark grounding shadow */
  .t { position:absolute; z-index:2; color:#fff; white-space:nowrap; line-height:1.3;
       text-shadow:0 2px 10px rgba(0,0,0,0.65), 0 1px 3px rgba(0,0,0,0.55); }
  .sans  { font-family:"Archivo","Helvetica Neue",Arial,sans-serif; font-weight:800; letter-spacing:-0.02em; }
  .serif { font-family:"Playfair Display",Georgia,serif; font-style:italic; font-weight:500; }

  /* the six scattered slots (anchors fixed; font-size comes inline from the sizing tables) */
  .p1 { left:61px;   top:272px; }
  .p2 { left:169px;  top:429px; }
  .p3 { right:81px;  top:498px; }
  .p4 { right:81px;  top:824px; }
  .p5 { left:119px;  top:949px; }
  .p6 { right:81px;  top:1000px; }

  /* word reveal — the prefab's fade+rise; gap = margin + the &#160; each non-final span carries
     (inter-span whitespace is not what sets the gap here; italic Playfair caps overhang, hence the wider .wi margin) */
  .w  { display:inline-block; opacity:0; margin-right:0.32em;
        animation-name:wIn; animation-timing-function:cubic-bezier(.2,.7,.3,1); animation-fill-mode:both; }
  .wi { display:inline-block; opacity:0; margin-right:0.45em;
        animation-name:wIn; animation-timing-function:cubic-bezier(.2,.7,.3,1); animation-fill-mode:both; }
  @keyframes wIn { 0%{opacity:0;transform:translateY(0.28em)} 100%{opacity:1;transform:translateY(0)} }

  /* torn-paper red sticker — static rotate on the box; ONLY the inner paper/word animate scale.
     The gradient fill is calibrated through this engine on this exact construct — keep it verbatim;
     if a future engine stops painting it, fall back to flat background:#e2140c (the mid stop). */
  .stkr { position:absolute; left:192px; top:591px; width:368px; height:143px;
          transform:rotate(-3deg); transform-origin:center center; z-index:3; }
  .paper { position:absolute; inset:0; z-index:1;
           background:linear-gradient(135deg, #ff2a1c 0%, #e2140c 55%, #c20f08 100%);
           clip-path:polygon(
             2% 22%, 9% 8%, 18% 16%, 27% 4%, 38% 14%, 49% 2%, 60% 12%,
             72% 3%, 83% 14%, 93% 6%, 99% 24%, 96% 42%, 100% 60%, 95% 78%,
             99% 92%, 88% 86%, 77% 97%, 65% 88%, 53% 98%, 42% 87%,
             30% 96%, 19% 85%, 8% 94%, 1% 74%, 4% 56%, 0% 40%
           );
           transform:scale(0); transform-origin:50% 50%;
           animation-name:pop; animation-timing-function:cubic-bezier(.2,.8,.25,1); animation-fill-mode:both; }
  /* word row = full-width block + text-align:center (a translate(-50%,-50%) wrapper mis-centers in
     this engine); its inline top comes from the closed form in section 3 */
  .stw { position:absolute; left:0; width:100%; text-align:center; z-index:2; white-space:nowrap; }
  .stword { display:inline-block; font-family:"Playfair Display",Georgia,serif; font-style:normal;
            font-weight:500; color:#0a0a0a; letter-spacing:0.009em; line-height:1.3;
            transform:scale(0); transform-origin:50% 50%;
            animation-name:pop; animation-timing-function:cubic-bezier(.2,.8,.25,1); animation-fill-mode:both; }
  @keyframes pop { 0%{transform:scale(0)} 100%{transform:scale(1)} }
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

One `.cue` per beat `{N}` of `word-timings.json`. Beat template — slot divs in position order, the
sticker LAST:

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N};animation-delay:{cueDelayMs}ms;animation-duration:{cueDurMs}ms">
  <div class="t {font} p{P}" id="b{N}s{P}" data-node-id="b{N}s{P}" data-node-role="text" style="font-size:{F}px"><!-- word spans --></div>
  <!-- one slot div per phrase -->
  <div class="stkr" data-node-id="b{N}kbox">
    <span class="paper" style="animation-delay:{accDelayMs}ms;animation-duration:{popMs}ms"></span>
    <div class="stw" style="top:{STOP}px"><span class="stword" id="b{N}stk" data-node-id="b{N}stk" data-node-role="text"
          style="font-size:{SF}px;animation-delay:{accDelayMs}ms;animation-duration:{popMs}ms">{accWord}</span></div>
  </div>
</div>
```

`{STOP}` (the word row's top inside the 143px paper) = `floor((143 − round(1.3·SF)) / 2)` with SF from
the sticker table — e.g. SF 57 → 34, SF 40 → 45.

**Word prep (before counting anything):** strip a trailing `.` or `,` from each token; keep `?` `!` `'`
and internal punctuation (`10,000` stays). Words keep transcript case — this design is sentence-case,
never uppercase anything. GLUE: a token starting with `-` (e.g. `-do` after `to`) merges with the
previous word into ONE unit for mapping and char counting (`to-do` = 5 chars); it renders as two
adjacent spans — the previous span gets inline `margin-right:0` and NO trailing `&#160;` — each keeping
its OWN verbatim `delayMs`.

**Accent removal:** the beat's counter-accent unit (section 5) leaves the flow and takes the sticker.
m = the remaining unit count. m = 0 → the beat renders the sticker alone.

**Phrase mapping — deterministic, order preserved:** k = min(6, m) phrases; base = floor(m/k); the
first (m mod k) phrases take base+1 consecutive units, the rest take base (m ≤ 6 → one unit each).

**Slot run:** the k phrases occupy a CONTIGUOUS run of the six slots, start `P = 1 + floor((6−k)/2)`:

| k | slots used (in phrase order) |
|---|---|
| 1 | 3 |
| 2 | 3,4 |
| 3 | 2,3,4 |
| 4 | 2,3,4,5 |
| 5 | 1,2,3,4,5 |
| 6 | 1,2,3,4,5,6 |

**Sizing — per phrase, by C = phrase chars incl 1 per inter-unit gap.** Advance budgets measured via a
calibration render on the run engine: Archivo 800 sentence-case ≈ 0.62em/char incl the 0.32em+`&#160;`
gap; Playfair italic ≈ 0.56em/char incl the 0.45em+`&#160;` gap; Playfair upright (sticker, digits
included) ≈ 0.54em/char. Each slot's table = its width budget walked down its size list
(`maxC = floor(budget / (em·F))`, last row absorbs):

| slot | anchor | font | budget | F by C |
|---|---|---|---|---|
| p1 | left 61 | sans | 594 | ≤5→162 · ≤7→120 · ≤10→92 · ≤13→72 · ≤16→58 · ≤20→46 · else 38 |
| p2 | left 169 | sans | 486 | ≤10→72 · ≤13→58 · ≤17→46 · ≤20→38 · else 32 |
| p3 | right 81 | serif | 480 | ≤9→90 · ≤11→72 · ≤14→58 · ≤18→46 · ≤22→38 · else 32 |
| p4 | right 81 | serif | 480 | ≤9→86 · ≤12→70 · ≤14→58 · ≤18→46 · ≤22→38 · else 32 |
| p5 | left 119 | serif | 536 | ≤10→92 · ≤12→74 · ≤15→60 · ≤19→48 · ≤23→40 · else 32 |
| p6 | right 81 | sans | 486 | ≤9→80 · ≤12→64 · ≤15→52 · ≤18→42 · ≤23→34 · else 28 |
| sticker | fixed box | serif upright | 330 | ≤10→57 · ≤12→48 · ≤15→40 · ≤17→34 · ≤21→29 · else 25 |

p6 caps at 80 (not the prefab's 92) so its ink bottom 1000+80 stays inside the 17% bottom margin
(y ≤ 1089). The sticker box (192,591,368×143, −3°) bleeds to bbox ≈ 188..564 × 581..744 — inside the
safe zone with margin; never move it.

**Worked example A** (portrait-main beat 5 — `10,000 hours saved.`, cueDelayMs 8240, cueDurMs 1600 →
cueEnd 9840): units `10,000`(6) `hours`(5) `saved`(5); accent = `10,000` (digit rule) → sticker,
C=6 → 57px, popMs = min(500, max(250, 9840−8240−80)) = 500. m=2 → k=2 → slots 3,4: `hours` p3 C=5 →
90px, `saved` p4 C=5 → 86px; both inMs = 420 (avail 1040 / 680).

**Worked example B** (portrait-main beat 1 — `So I built an app that does one thing.`, cueDelayMs 320,
cueDurMs 1760): 9 units; no digits; longest = `built`(5) vs `thing`(5) → tie → later → `thing` takes
the sticker (C=5 → 57px; avail = 2080−1680 = 400 → popMs 320). m=8 → k=6 → counts 2,2,1,1,1,1 →
`So I`→p1 (C=4→162) · `built an`→p2 (C=8→72) · `app`→p3 (C=3→90) · `that`→p4 (C=4→86) ·
`does`→p5 (C=4→92) · `one`→p6 (C=3→80).

## 4. WORDS + TIMING

- Delays are absolute on the single timeline — paste as-is from `runs/<key>/word-timings.json`, never
  re-zero, never invent.
- Each beat's `.cue` gets inline `z-index:{10+N};animation-delay:{cueDelayMs}ms;animation-duration:{cueDurMs}ms`
  verbatim.
- Per word compute once: cueEnd = cueDelayMs + cueDurMs; avail = cueEnd − delayMs;
  `inMs = min(420, max(200, avail − 80))` — the entrance compresses so a word spoken just before the
  gate closes still reaches full opacity. Word span (`.w` in sans slots, `.wi` in serif slots):
  `<span class="w" style="animation-delay:{delayMs}ms;animation-duration:{inMs}ms">{word}&#160;</span>`.
  The LAST span of each slot drops the gap (inline `margin-right:0`, no `&#160;`); glued-unit internal
  spans likewise. Write spans adjacent with no whitespace between them.
- Sticker: `popMs = min(500, max(250, avail − 80))` with avail = cueEnd − accDelayMs (the accent unit's
  FIRST word delay). The `.paper` and every `.stword` span carry the SAME inline
  `animation-delay:{accDelayMs}ms;animation-duration:{popMs}ms`. The pop is scale-only (NO opacity —
  prefab-faithful); a glued accent renders as adjacent `.stword` spans (ids `b{N}stk`, `b{N}stk2`, …)
  each keeping its own verbatim delay.
- Words accumulate — every structure HOLDS at full opacity until the cue gate cuts the beat. No
  fade-outs anywhere; each phrase owns its slot, nothing turn-takes.
- Spans stay `display:inline-block`; slot line-height stays 1.3 (descender headroom for the animating spans).

## 5. EMPHASIS

Exactly ONE counter-accent unit per beat — it becomes the sticker word (black Playfair upright on the
red torn paper). Pick rule, no judgment (lib `accentIndex`):
1. Any unit containing a digit wins (the FIRST such unit if several).
2. Otherwise the LONGEST unit (chars incl punctuation).
3. Tie → the LATER unit.
Nothing else changes — the sticker word keeps its transcript case and its verbatim delay.

## 6. VERIFY LOOP

Run (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Otherwise apply the MECHANICAL fix for the named element and re-run; at most 2 fix
cycles:
- `FAIL[bounds] #b{N}s{P}` → that phrase one row DOWN its slot's table (the runner's demotion does
  exactly this). Fails again → one more row.
- `FAIL[bounds] #b{N}stk` → the sticker word one row DOWN the sticker table.
- `FAIL[never-visible]` → check that cue's inline z-index/delay/duration match `word-timings.json`,
  the `<video>` is the first body element at z0, slots kept `z-index:2` and the sticker `z-index:3`,
  and every animation-name resolves (`wIn`, `pop`, `cueWin` spelled exactly).
- `FAIL[occluded]` → cue windows overlap or the paper outranks text: each cue's duration must equal its
  `cueDurMs`, each cue's z-index 10+N in beat order; inside the sticker the word wrapper keeps
  `z-index:2` over the paper's 1.

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --progress-output --record {repo}/runs/<key>/final/out.silent.mp4
```

Manifest line (already given in section 2): `{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}` — W/H/FPS/DUR from `meta.json`.

## 7. DO NOT

- No fonts, colors, shadows, sizes, or keyframes beyond this sheet — Archivo 800 + Playfair Display,
  white ink `#fff`, sticker ink `#0a0a0a`, the red gradient, one grounding text-shadow, `cueWin`/`wIn`/`pop`.
- No green demo background, no plate behind the slot text — the footage is full-bleed; the shadow grounds it.
- Never uppercase — the design is sentence-case; type tokens as spoken (minus a trailing `.`/`,`).
- No invented timing: every delay comes VERBATIM from `word-timings.json`; derived numbers only via the
  closed forms in sections 3-4. No fade-outs, no per-word exits — the gate cuts each beat.
- Never move a slot anchor or the sticker box; never resize the 368×143 paper; never change the −3°
  rotate; capacity lives in the sizing tables, not the geometry.
- The sticker pop is scale-only on the INNER paper/word — never animate the `.stkr` box, never add
  opacity to `pop`, never put a transform animation on an ancestor of the word spans.
- No flex anywhere; no animated color or blur; single-value `border-radius` only (none is used here).
- Never read the video frames, never run ffmpeg checks — `--verify` is the only self-check.
- No redesign after a render or verify failure — only the mechanical fixes in section 6.
