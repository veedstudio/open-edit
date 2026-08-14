> **AUTHORITY NOTE (2026-07-21):** `recipe.ts` next door is the single source of truth — the
> curation pass (design rounds v2–v6) edited the MODULE only and this sheet has NOT been synced.
> Do not recompile the module from this sheet until it is re-derived.

# hook-236-peak — recipe (9:16 · 736×1312 @ 25fps)

RESOLUTION: px are authored at the 9:16 reference canvas 736×1312. FIRST STEP: SCALE = W/736 from
`meta.json` (require |H − 1312·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE and round (positions, sizes, fonts, the dot geometry, the keyframe
translate px, the shadow px); `em` values (word gaps) and ms timings never scale; the manifest carries
the run's real W/H.

Prefab is 720×1280; every px below is ALREADY rescaled ×1.022 — copy numbers as written, never rescale again.

## 1. IDENTITY

A stop-motion word scatter over full-bleed footage: lowercase Work Sans words pinned one-by-one at
slightly-rotated spots meandering down the canvas, each popping in with a chunky 4-snap scale jump on its
own spoken timing, while a white-ringed orange dot hops word to word — landing above each word the instant
it is spoken — like a bouncing-ball sing-along.

## 2. SKELETON

Paste this whole document as `runs/<key>/final/template.wv`, then insert the generated `dm{N}` dot
keyframes (section 3) at the END of `<style>` and one `.cue` block per beat after the video. Replace only
`{videoPath}` (from `meta.json`) and `{DUR}` (`durationSec`, manifest only). The footage stays full-bleed
at z0 (blend-into-footage — no plate, no scrim); the near-black ink is grounded over arbitrary footage by
the baked white halo text-shadow (the prefab's flat sky hides this need — never remove the halo).

```html
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Work+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:736px; height:1312px; position:relative; overflow:hidden; margin:0;
         font-family:'Work Sans', Arial, Helvetica, sans-serif; background:#000; }
  .vid { position:absolute; inset:0; width:736px; height:1312px; object-fit:cover; z-index:0; }

  /* beat gate — the one safe reveal recipe; z-index + delay + duration come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position:absolute; inset:0; opacity:0;
         animation-name:cueWin; animation-timing-function:linear; animation-fill-mode:forwards; }

  /* scattered word slot — static rotation on the OUTER div, pop on the inner span (the engine paints an
     element animating its own transform/opacity beneath static siblings — never merge the two) */
  .word { position:absolute; display:inline-block; width:max-content; z-index:2;
          color:#0a0a0a; font-weight:400; line-height:1.3; white-space:nowrap;
          overflow:visible; transform-origin:center;
          text-shadow:0 0 3px rgba(255,255,255,0.85), 0 0 10px rgba(255,255,255,0.7); }

  /* the stop-motion pop — the prefab's steps(4, jump-end) BAKED as plateau keyframes (the engine
     drops steps() ramps to a smooth ease; discrete keyframe plateaus render exactly). 320ms = 4
     snaps of 2 frames @25fps. Delay (+ compressed duration when late) come inline per word. */
  .wi { display:inline-block; opacity:0; animation:wpop 320ms linear both; }
  .gp { margin-right:0.35em; } /* word gap — the margin IS the space (inter-span whitespace drops) */
  @keyframes wpop {
    0%,24.99%  { opacity:0;    transform:scale(0.25)   translateY(-6px); }
    25%,49.99% { opacity:0.25; transform:scale(0.4375) translateY(-4.5px); }
    50%,74.99% { opacity:0.5;  transform:scale(0.625)  translateY(-3px); }
    75%,99.99% { opacity:0.75; transform:scale(0.8125) translateY(-1.5px); }
    100%       { opacity:1;    transform:scale(1)      translateY(0); }
  }

  /* the counter-accent dot: animated inner <i> inside a static high-z wrapper (same engine rule as
     .word/.wi). Position hops via per-beat dm{N} keyframes; per-beat animation comes inline. */
  .dot { position:absolute; inset:0; z-index:50; }
  .dot i { position:absolute; left:0; top:0; width:45px; height:45px;
           background:#db5404; border-radius:50%;
           box-shadow:0 0 0 3px rgba(255,255,255,0.6); opacity:0; }
  /* generated dm{N} keyframes go here, one block per beat (section 3) */
</style>

<video class="vid" src="{videoPath}" muted></video>

<!-- one .cue block per beat, from section 3 -->
```

`manifest.json` (verbatim, `{DUR}` = `durationSec` from `meta.json`):

```json
{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json
```

## 3. PER-BEAT ASSEMBLY

One `.cue` per beat `{N}` of `word-timings.json`, plus one `dm{N}` keyframes block in `<style>`:

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N}; animation-delay:{cueDelayMs}ms; animation-duration:{winMs}ms;">
  <div class="word" id="b{N}w{K}" data-node-id="b{N}w{K}" data-node-role="text"
       style="left:{left}px; top:{top}px; font-size:{fs}px; transform:rotate({rot}deg);"><span
       class="wi" style="animation-delay:{delayMs}ms">{word}</span></div>
  <!-- one .word div per used slot, K = 1..k in reading order -->
  <div class="dot" id="b{N}dot" data-node-id="b{N}dot"><i style="animation:dm{N} {winMs}ms linear {cueDelayMs}ms both"></i></div>
</div>
```

**Window** (extends the gate to the next beat's start — pure subtraction):
- `{winMs}` = next beat's `cueDelayMs` − this beat's `cueDelayMs`.
- Last beat: `{winMs}` = round(`durationSec`×1000 from `meta.json`) − its `cueDelayMs`.

**Word prep:** strip ONE trailing `.` or `,` from each token; keep `?` `!` `'` and internal punctuation
(`10,000` stays whole); lowercase every token in code (the prefab is lowercase — never `text-transform`).
GLUE: a token starting with `-` (e.g. `-do` after `to`) merges with the previous word into ONE unit for
slot mapping and counting (`to-do` = 5 chars); it renders as two adjacent `.wi` spans with NO gap at the
join, each keeping its OWN verbatim `delayMs`. n below = UNIT count.

**Units → slots (deterministic):** k = min(n, 8) slots used; group the units IN ORDER into k slot
phrases, front-loaded: base = floor(n/k), the first (n mod k) slots take base+1 consecutive units, the
rest take base (n ≤ 8 → 1 each). The k phrases occupy a CONTIGUOUS slot run starting at
s = 1 + floor((8−k)/2).

**Slots** — the prefab's meander, center-anchored `(cx, top, rot)`. Set A = odd beats, Set B = even
beats (Set B mirrors cx about 368 and negates rot):

| slot | Set A | Set B |
|---|---|---|
| 1 | (243, 198, 5°) | (493, 198, −5°) |
| 2 | (370, 306, 8°) | (366, 306, −8°) |
| 3 | (522, 367, −24°) | (214, 367, 24°) |
| 4 | (394, 516, 0°) | (342, 516, 0°) |
| 5 | (340, 655, −4°) | (396, 655, 4°) |
| 6 | (236, 744, −6°) | (500, 744, 6°) |
| 7 | (342, 840, −4°) | (394, 840, 4°) |
| 8 | (467, 969, 0°) | (269, 969, 0°) |

**Sizing table** (by the slot phrase's char count C = unit chars + 1 per inter-unit gap; accent column =
section 5):

| C | font-size | accent |
|---|---|---|
| ≤12 | 45 | 47 |
| 13–16 | 41 | 43 |
| 17–20 | 37 | 39 |
| 21–24 | 33 | 35 |
| 25–28 | 29 | 31 |
| ≥29 | 25 | 27 |

**Placement (closed forms, all values then written inline):**
- `w` = round(C × 0.58 × fs) — Work Sans 400 lowercase advance calibration-measured at 0.51 em/char
  average (wide glyphs w/m reach 0.88 em; 0.58 is the budget with headroom).
- `{left}` = clamp(round(cx − w/2), 44, max(44, 655 − w)) — the 9:16 safe band; wide phrases slide
  inboard off their anchor rather than crossing a margin.
- `{top}` = the slot's top. Word box height ≤ 1.3×47 = 61px; slot 8 bottoms at 1030, inside the 1089
  floor. Rotations are static outer transforms — `--verify` measures ink pre-transform, and the inboard
  anchors keep the worst rotated corner (slot 3 at ±24° with a 20-char phrase) on-canvas.
- Dot geometry per slot: `dotLeft` = clamp(cx − 22, 47, 607), `dotTop` = top − 46 (45px dot, 3px ring,
  hovering just above the slot's word).

**Dot keyframes `dm{N}`** — the dot hops to slot K at the moment slot K's FIRST word is spoken:
- `t_K` = the first `delayMs` of slot K's phrase; `f_K` = round₂((t_K − cueDelayMs) / winMs × 100),
  clamped to ≤ 99.5, then forced monotonic: f_K = max(f_K, f_{K−1} + j + 0.01), capped at 99.99.
- `j` = round₂(4000 / winMs) — a 40ms jump window (≤ 1 frame @25fps; the pair of keyframes j apart IS
  the discrete hop).
- Emit, in order (positions are `translate({dotLeft}px,{dotTop}px)` of the slot):
  - f_1 ≤ j → `0% { opacity:1; transform:translate(P1); }`
  - else → `0% { opacity:0; transform:translate(P1); }` · `{f_1−j}% { opacity:0; transform:translate(P1); }`
    · `{f_1}% { opacity:1; transform:translate(P1); }`
  - for K = 2..k: `{f_K−j}% { opacity:1; transform:translate(P_{K−1}); }` ·
    `{f_K}% { opacity:1; transform:translate(P_K); }`
  - `100% { opacity:1; transform:translate(P_k); }` (skip if f_k ≥ 99.99).
- Percents print with at most 2 decimals, trailing zeros dropped (75, not 75.00).

**Worked example** (portrait-main fixture, beat 1 — `So I built an app that does one thing.`,
cueDelayMs 320, next beat 2080 → winMs 1760, Set A): units `so i built an app that does one thing`,
n=9 → k=8, counts 2,1,1,1,1,1,1,1, slots 1..8: `so i`(C=4) / `built`(5) / `an`(2) / `app`(3) / `that`(4)
/ `does`(4) / `one`(3) / `thing`(5). Accent (section 5): built(5) vs thing(5) tie → later → `thing`
(slot 8, fs 47). Slot 1: fs 45, w = round(4×0.58×45) = 104 → left = round(243−52) = 191, top 198,
rot 5°; spans `<span class="wi gp" style="animation-delay:320ms">so</span><span class="wi"
style="animation-delay:400ms">i</span>`. Slot 8: w = round(5×0.58×47) = 136 → left = round(467−68) =
399, top 969, rot 0°, delay 1680ms. Dot: j = round₂(4000/1760) = 2.27; slot firsts
320,520,720,840,1000,1160,1400,1680 → f = 0, 11.36, 22.73, 29.55, 38.64, 47.73, 61.36, 77.27; f_1 = 0 ≤ j
→ dm1 opens `0% { opacity:1; transform:translate(221px,152px); }`, hops e.g.
`9.09% {…(221px,152px)} 11.36% {…(348px,260px)}`, ends `77.27% {…(445px,923px)}` then
`100% {…(445px,923px)}`. Every pop keeps its default 320ms (cueEnd 2080; even `thing` at 1680 has
400ms ≥ 320).

And beat 2 (`It kills pointless meetings.`, cueDelayMs 2080, winMs 1760, Set B): n=4 → k=4, s=3 →
slots 3..6: `it` / `kills` / `pointless` / `meetings`; accent `pointless` (9 > 8) → slot 5, fs 47,
w = round(9×0.58×47) = 245 → left = round(396−122.5) = 274, top 655, rot 4°.

## 4. WORDS + TIMING

- One `.wi` span per token, inline `animation-delay:{delayMs}ms` — that word's `delayMs` from
  `runs/<key>/word-timings.json` VERBATIM (delays are absolute on the single timeline — never re-zero,
  never invent).
- Entrance compression (closed form): with `cueEnd` = this beat's `cueDelayMs + winMs`, a word's pop
  duration `d = min(320, max(160, cueEnd − delayMs))`; when `d < 320` add inline
  `animation-duration:{d}ms`, otherwise add nothing (the class's 320ms applies).
- Word gaps: inside a multi-unit slot every unit-final span except the slot's last gets class `wi gp`
  (`margin-right:0.35em`); glued `-` partners get NO margin between them. Spans stay
  `display:inline-block`; slot divs stay `white-space:nowrap`.
- Words accumulate — every word HOLDS at full opacity until the cue gate cuts the beat. No fade-outs
  anywhere; the beat's structure rides its gate, the dot holds its last position.
- The dot's inline animation is `dm{N} {winMs}ms linear {cueDelayMs}ms both`; its keyframes come only
  from the section-3 closed forms.

## 5. EMPHASIS

The counter-accent is the dot itself (it marks EVERY word); the type accent is ONE unit per beat, picked
with `lib.accentIndex` — digit-bearing unit first, else the longest unit (chars incl punctuation),
tie → the later unit. The SLOT PHRASE containing that unit takes the accent column of the sizing table
(fs + 2, the prefab's 44→46 bump). Nothing else changes — same pop, same ink.

## 6. VERIFY LOOP

Run (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Otherwise apply the MECHANICAL fix for the named element and re-run; at most 2 fix
cycles:
- `FAIL[bounds] #b{N}w{K} …` → move that slot phrase one row DOWN the sizing table (w and left
  recompute from the closed forms; the accent bump rides the new row). Same slot again → one more row.
- `FAIL[bounds] #b{N}dot` → re-check the dot clamps (left in 47..607, top = slot top − 46); a dot
  outside them means a slot table typo — restore the table, never invent a new dot offset.
- `FAIL[never-visible]` on a span or cue → the word was pasted into the WRONG beat's `.cue`, or the cue
  is missing its inline `z-index:{10+N}` / delay / duration; also confirm the `<video>` is the first
  body element at z0, `.word` kept `z-index:2` and `.dot` kept `z-index:50`.
- `FAIL[occluded]` → two cue windows overlap: re-check each `{winMs}` equals the next beat's
  `cueDelayMs` minus this beat's and every `.cue` carries `z-index:{10+N}`.

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --progress-output --record {repo}/runs/<key>/final/out.silent.mp4
```

Manifest line (already given in section 2): `{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json`

## 7. DO NOT

- No fonts, colors, shadows, sizes, or keyframes beyond this sheet — Work Sans 400, `#0a0a0a` ink with
  the white halo, the orange `#db5404` dot with its white ring, `cueWin`/`wpop`/`dm{N}` and the six
  ladder rows are the whole system.
- Never write `steps()` — the engine renders it as a smooth ease; the baked wpop plateaus ARE the
  stop-motion. Never smooth the dot hop into a tween; the paired keyframes ARE the hop.
- Never animate the OUTER `.word` div or bake its rotation into `wpop`; never give `.dot` (the wrapper)
  the animation — only the inner `<i>` animates.
- No plate, card, or scrim over the footage — full-bleed video at z0; never remove the halo text-shadow.
- No invented timing: every word `animation-delay` comes VERBATIM from `word-timings.json`; derived
  numbers only via the closed forms in sections 3–4. No fade-outs; the gate cuts each beat.
- Never move a slot anchor, add slots, uppercase the words, or re-balance the scatter aesthetically.
- Never animate `color` or `filter:blur`.
- Never read the video frames, never run ffmpeg checks — `--verify` is the only self-check.
- No redesign after a render or verify failure — only the mechanical fixes in section 6.
