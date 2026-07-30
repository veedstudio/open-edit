> **AUTHORITY NOTE (2026-07-21):** `recipe.ts` next door is the single source of truth — the
> curation pass (design rounds v2–v6) edited the MODULE only and this sheet has NOT been synced.
> Do not recompile the module from this sheet until it is re-derived.

# RECIPE — hook-084 (0-00-06-16) · glowing serif movie-poster credits (9:16 · 736×1312 @ 25fps)

RESOLUTION: px are authored at the 9:16 reference canvas 736×1312. FIRST STEP: SCALE = W/736 from
`meta.json` (require |H − 1312·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE and round once at the end (positions, sizes, fonts, px
spacings/shadows/margins/tops — derived positions stay FRACTIONAL until that single rounding);
`em` values and ms timings never scale; the manifest carries the run's real W/H.

Prefab is 882×1568; every px below is ALREADY rescaled ×0.8345 — copy numbers as written, never rescale again.

## 1. IDENTITY

A white-glow editorial credits poster over full-bleed footage: Bodoni Moda kickers top-left/right, a
letter-spaced EB Garamond tagline, EB Garamond credit rows and a JBO + Apple-pictogram "tv+" logo row
frame a monumental Bodoni Moda title — the spoken beat — whose lines land scattered (staggered left
offsets) with small EB Garamond caps asides bracketing the stack, everything striking on in 2–3-char
clusters with a soft white halo.

## 2. SKELETON

Paste this whole document as `runs/<key>/final/template.wv`, then insert one `.cue` block per beat
(section 3) after the chrome. Replace only `{videoPath}` (from `meta.json`). The chrome (#kickl … #logos)
is FINAL — fixed dressing text with fixed delays; never edit it, never put spoken words in it. The
prefab's flat `#6f7468` background is replaced by the footage; every glow therefore carries one dark
grounding text-shadow layer so white survives light footage. The prefab's `gIn` ramps
`filter:blur(6px→0)` alongside the fade — the engine DROPS animated blur ramps, so `gIn` here is
opacity-ONLY and the reveal reads identically; do not re-add any `filter`.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:wght@400;500;600;700&family=EB+Garamond:wght@400;500;600&family=Geist:wght@600;700;800&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 736px; height: 1312px; background: #000; overflow: hidden; }
  body { position: relative; font-family: 'EB Garamond', serif; color: #fff; }
  .vid { position: absolute; inset: 0; width: 736px; height: 1312px; object-fit: cover; z-index: 0; }

  /* white halo glow (prefab) + one dark grounding layer (footage replaces the prefab's flat bg) */
  .glow { text-shadow: 0 0 12px rgba(255,255,255,.75), 0 0 23px rgba(255,255,255,.5), 0 2px 10px rgba(0,0,0,.65); }
  .soft-glow { text-shadow: 0 0 7px rgba(255,255,255,.6), 0 1px 6px rgba(0,0,0,.65); }

  /* char-cluster reveal — opacity ONLY (the prefab's blur ramp is a no-op in-engine) */
  .g { display: inline-block; white-space: pre; opacity: 0;
       animation: gIn .24s cubic-bezier(.2,.7,.3,1) both; }
  .g.big { animation-duration: .3s; }
  @keyframes gIn { 0% { opacity: 0; } 100% { opacity: 1; } }
  .gp { margin-right: 0.32em; } /* inter-word gap, paired with the trailing &#160; (section 4) */

  /* ---- chrome: fixed dressing, one reveal wave at clip start, persistent ---- */
  #kickl { position: absolute; z-index: 2; left: 58px; top: 67px; font-family: 'Bodoni Moda', serif; font-weight: 700; font-size: 17px; letter-spacing: 1px; }
  #kickr { position: absolute; z-index: 2; right: 52px; top: 67px; font-family: 'Bodoni Moda', serif; font-weight: 600; font-size: 15px; letter-spacing: 1px; }
  #tagline { position: absolute; z-index: 2; left: 0; top: 407px; width: 736px; text-align: center; font-weight: 600; font-size: 23px; letter-spacing: 3px; }
  .crow { position: absolute; z-index: 2; left: 0; width: 736px; text-align: center; font-size: 14px; }
  #crow1 { top: 819px; } #crow2 { top: 846px; } #crow3 { top: 873px; }
  .credit { display: inline-block; white-space: nowrap; margin-right: 38px; }
  .credit.last { margin-right: 0; }
  .credit .role { font-weight: 400; opacity: 0.92; }
  .credit .name { font-weight: 700; letter-spacing: 0.5px; margin-left: 5px; }
  #logos { position: absolute; z-index: 2; left: 0; top: 1195px; width: 736px; text-align: center; font-family: 'Geist', sans-serif; }
  #logo-jbo { display: inline-block; font-weight: 800; font-size: 25px; letter-spacing: 1px; margin-right: 22px; }
  #logo-tv { display: inline-block; font-weight: 600; font-size: 23px; }
  /* apple pictogram drawn as clip-path shapes (U+F8FF has no glyph in the engine's fonts) — polygons verbatim from the prefab */
  .apple { position: relative; width: 17px; height: 22px; vertical-align: -2px; margin-right: 3px; }
  .apple .ab, .apple .al { position: absolute; display: block; background: #fff; }
  .apple .ab { left: 0; top: 4px; width: 17px; height: 18px;
    clip-path: polygon(50% 9%, 38% 1%, 25% 2%, 13% 11%, 6% 26%, 5% 42%, 8% 60%, 15% 77%, 25% 90%, 36% 98%, 44% 94%, 50% 93%, 56% 94%, 64% 98%, 75% 90%, 84% 78%, 89% 66%, 80% 62%, 75% 53%, 75% 43%, 80% 34%, 88% 29%, 86% 20%, 78% 8%, 66% 2%, 56% 4%); }
  .apple .al { left: 8px; top: 0; width: 8px; height: 6px;
    clip-path: polygon(10% 80%, 40% 20%, 80% 0%, 100% 30%, 70% 85%, 35% 100%); }

  /* ---- beat gate — the one safe reveal recipe; z-index + delay + duration come inline per cue ---- */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position: absolute; inset: 0; opacity: 0;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* title line — absolute, nowrap, scattered lefts per line parity (section 3) */
  .tt { position: absolute; z-index: 2; white-space: nowrap; font-family: 'Bodoni Moda', serif;
        font-weight: 500; line-height: 1.3333; letter-spacing: 1px; }
  /* size ladder (pick by section 3 only — width and height budgets baked in) */
  .s125{font-size:125px} .s112{font-size:112px} .s100{font-size:100px} .s88{font-size:88px}
  .s76{font-size:76px} .s66{font-size:66px} .s58{font-size:58px} .s51{font-size:51px}
  .s45{font-size:45px} .s40{font-size:40px} .s36{font-size:36px} .s32{font-size:32px}

  /* per-beat aside notes (fixed dressing text riding each beat's cue) */
  .nt { position: absolute; z-index: 2; font-weight: 500; font-size: 18px; letter-spacing: 2px; white-space: nowrap; }
</style>
</head>
<body>
  <video class="vid" src="{videoPath}" muted></video>

  <div id="kickl" class="glow" data-node-id="kickl" data-node-role="text"><span class="g" style="animation-delay:0ms">THE</span><span class="g" style="animation-delay:70ms"> IN</span><span class="g" style="animation-delay:140ms">TER</span><span class="g" style="animation-delay:210ms">NET</span></div>
  <div id="kickr" class="glow" data-node-id="kickr" data-node-role="text"><span class="g" style="animation-delay:150ms">PRE</span><span class="g" style="animation-delay:220ms">SEN</span><span class="g" style="animation-delay:290ms">TS</span></div>

  <div id="tagline" class="glow" data-node-id="tagline" data-node-role="text"><span class="g" style="animation-delay:300ms">A C</span><span class="g" style="animation-delay:365ms">REA</span><span class="g" style="animation-delay:430ms">TOR</span><span class="g" style="animation-delay:495ms">! J</span><span class="g" style="animation-delay:560ms">OIN</span><span class="g" style="animation-delay:625ms">T</span></div>

  <div id="crow1" class="crow soft-glow"><span class="credit" id="cr1" data-node-id="cr1" data-node-role="text"><span class="role"><span class="g" style="animation-delay:450ms">Dir</span><span class="g" style="animation-delay:482ms">ect</span><span class="g" style="animation-delay:514ms">ed </span><span class="g" style="animation-delay:546ms">By</span></span><span class="name"><span class="g" style="animation-delay:578ms">THE</span><span class="g" style="animation-delay:610ms"> AL</span><span class="g" style="animation-delay:642ms">GOR</span><span class="g" style="animation-delay:674ms">ITH</span><span class="g" style="animation-delay:706ms">M</span></span></span><span class="credit" id="cr2" data-node-id="cr2" data-node-role="text"><span class="role"><span class="g" style="animation-delay:570ms">Cam</span><span class="g" style="animation-delay:602ms">era</span><span class="g" style="animation-delay:634ms"> By</span></span><span class="name"><span class="g" style="animation-delay:666ms">A T</span><span class="g" style="animation-delay:698ms">RIP</span><span class="g" style="animation-delay:730ms">OD</span></span></span><span class="credit last" id="cr3" data-node-id="cr3" data-node-role="text"><span class="role"><span class="g" style="animation-delay:690ms">Aud</span><span class="g" style="animation-delay:722ms">io </span><span class="g" style="animation-delay:754ms">By</span></span><span class="name"><span class="g" style="animation-delay:786ms">THE</span><span class="g" style="animation-delay:818ms"> MI</span><span class="g" style="animation-delay:850ms">C</span></span></span></div>
  <div id="crow2" class="crow soft-glow"><span class="credit" id="cr4" data-node-id="cr4" data-node-role="text"><span class="role"><span class="g" style="animation-delay:810ms">Scr</span><span class="g" style="animation-delay:842ms">ipt</span><span class="g" style="animation-delay:874ms"> By</span></span><span class="name"><span class="g" style="animation-delay:906ms">NO </span><span class="g" style="animation-delay:938ms">ONE</span></span></span><span class="credit" id="cr5" data-node-id="cr5" data-node-role="text"><span class="role"><span class="g" style="animation-delay:930ms">Edi</span><span class="g" style="animation-delay:962ms">tor</span><span class="g" style="animation-delay:994ms"> By</span></span><span class="name"><span class="g" style="animation-delay:1026ms">CAF</span><span class="g" style="animation-delay:1058ms">FEI</span><span class="g" style="animation-delay:1090ms">NE</span></span></span><span class="credit last" id="cr6" data-node-id="cr6" data-node-role="text"><span class="role"><span class="g" style="animation-delay:1050ms">Art</span><span class="g" style="animation-delay:1082ms"> Di</span><span class="g" style="animation-delay:1114ms">rec</span><span class="g" style="animation-delay:1146ms">tor</span><span class="g" style="animation-delay:1178ms"> By</span></span><span class="name"><span class="g" style="animation-delay:1210ms">VIB</span><span class="g" style="animation-delay:1242ms">ES</span></span></span></div>
  <div id="crow3" class="crow soft-glow"><span class="credit" id="cr7" data-node-id="cr7" data-node-role="text"><span class="role"><span class="g" style="animation-delay:1170ms">Sty</span><span class="g" style="animation-delay:1202ms">lis</span><span class="g" style="animation-delay:1234ms">h B</span><span class="g" style="animation-delay:1266ms">y</span></span><span class="name"><span class="g" style="animation-delay:1298ms">DEF</span><span class="g" style="animation-delay:1330ms">AUL</span><span class="g" style="animation-delay:1362ms">T</span></span></span><span class="credit last" id="cr8" data-node-id="cr8" data-node-role="text"><span class="role"><span class="g" style="animation-delay:1290ms">VFX</span><span class="g" style="animation-delay:1322ms"> By</span></span><span class="name"><span class="g" style="animation-delay:1354ms">NON</span><span class="g" style="animation-delay:1386ms">E, </span><span class="g" style="animation-delay:1418ms">SOR</span><span class="g" style="animation-delay:1450ms">RY</span></span></span></div>

  <div id="logos" class="glow">
    <div id="logo-jbo" data-node-id="logo-jbo" data-node-role="text"><span class="g" style="animation-delay:1500ms">JB</span><span class="g" style="animation-delay:1590ms">O</span></div>
    <div id="logo-tv" data-node-id="logo-tv" data-node-role="text"><span class="apple g" style="animation-delay:1680ms"><span class="ab"></span><span class="al"></span></span><span class="g" style="animation-delay:1770ms">tv+</span></div>
  </div>

  <!-- one .cue block per beat goes here, in beat order -->
</body>
</html>
```

Manifest — write `runs/<key>/final/manifest.json` EXACTLY as (`{DUR}` = `durationSec` from `meta.json`):

```json
{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json
```

## 3. PER-BEAT ASSEMBLY

**The role system (reversed from the prefab — 10 roles, assignment is fixed and total):** the prefab is a
poster of 10 element roles; 9 are dressing with fixed content, and exactly ONE role (`title-cluster`) is
transcript-driven — EVERY spoken character of every beat lands in a `.tt` title line, no exceptions. The
prefab's dressing carried content-specific names (FOTHA, CLAYVER!, crew names, Portuguese asides TEM O
BACK / E TEM O) — garnish that cannot be transcript-derived, so it is collapsed to the fixed English
dressing above. The prefab revealed everything once in one long wave; here the poster chrome persists
across beats on ONE compressed wave at clip start (prefab order + prefab per-element cluster cadences),
while the title + the two asides ride each beat's cue:

| #  | role          | slot           | content               | reveal (cluster cadence K)             |
|----|---------------|----------------|-----------------------|----------------------------------------|
| 1  | kicker-left   | `#kickl`       | fixed `THE INTERNET`  | clusters @ 0ms, K=70                   |
| 2  | kicker-right  | `#kickr`       | fixed `PRESENTS`      | clusters @ 150ms, K=70                 |
| 3  | tagline       | `#tagline`     | fixed `A CREATOR! JOINT` | clusters @ 300ms, K=65              |
| 4  | credit        | `#cr1–8`       | fixed credits         | credit c (0-based): clusters @ 450+120c ms, K=32, role→name one run |
| 5  | logo-word     | `#logo-jbo`    | fixed `JBO`           | clusters @ 1500ms, K=90                |
| 6  | apple-glyph   | `.apple` in `#logo-tv` | fixed clip-path pictogram | one cluster @ 1680ms          |
| 7  | logo-tv       | `tv+` in `#logo-tv` | fixed `tv+`      | one cluster @ 1770ms                   |
| 8  | note-a        | `b{N}na`       | fixed `AN ORIGINAL`   | per beat: clusters @ cueDelayMs+240, K=60 |
| 9  | note-b        | `b{N}nb`       | fixed `IN REAL TIME`  | per beat: clusters @ cueDelayMs+480, K=60 |
| 10 | title-cluster | `.g.big` in `b{N}l{k}` | EVERY spoken char | pair-clusters @ `wordDelayMs + j×K` (§4) |

Chrome clusters are 3 characters each (spaces counted, `white-space:pre` keeps them); the wave is FINAL
in the skeleton — never re-derive it. One `.cue` per beat `{N}` of `word-timings.json`; it holds ONLY the
title lines + the two aside notes:

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N}; animation-delay:{cueDelayMs}ms; animation-duration:{winMs}ms">
  <div class="tt glow {SIZE}" id="b{N}l1" data-node-id="b{N}l1" data-node-role="text" style="left:{X1}px; top:{Y1}px"><!-- cluster spans --></div>
  <!-- l2..l4 only as the line rule produces them -->
  <div class="nt soft-glow" id="b{N}na" data-node-id="b{N}na" data-node-role="text" style="right:84px; top:428px"><!-- AN ORIGINAL clusters --></div>
  <div class="nt soft-glow" id="b{N}nb" data-node-id="b{N}nb" data-node-role="text" style="left:102px; top:{YB}px"><!-- IN REAL TIME clusters --></div>
</div>
```

**Window** (the poster holds through speech gaps; the next poster replaces it exactly):
- `{winMs}` = next beat's `cueDelayMs` − this beat's `cueDelayMs`.
- Last beat: `{winMs}` = round(`durationSec`×1000 from `meta.json`) − its `cueDelayMs`.
- `gateEnd` = this beat's `cueDelayMs + winMs` (used by the timing guards in §4).

**Word prep:** UPPERCASE every token yourself (never text-transform); keep ALL punctuation. GLUE: a token
starting with `-` (e.g. `-DO` after `TO`) merges with the previous word into ONE unit for counting and
splitting; it renders as its own cluster run continuing the unit (each span keeps its OWN verbatim
`delayMs`, no gap inside the unit). Char count of a line = unit chars + 1 per space between its units.

**Line rule** (n = unit count after gluing; order preserved, every unit used once):
- L = 1 if n ≤ 2 · 2 if n ≤ 6 · 3 if n ≤ 11 · 4 if n ≥ 12.
- Cut points, closed form: for k = 1..L−1 the cut goes at the unit boundary whose cumulative char count
  (units 1..c rendered, gaps included) is CLOSEST to k·total/L; tie → the earlier boundary. Each cut must
  leave ≥1 unit per remaining line (search only boundaries after the previous cut and before n−(L−k)).

**Scattered placement (the prefab's staggered stack):** line k sits at
`left = 53px` (k odd) / `157px` (k even), `top = 453 + (k−1)×1.1133×fs` px (fractional; round once via
SCALE). Aside `b{N}na` is fixed at `right:84; top:428` (between tagline and stack — measured clear of
both inks). Aside `b{N}nb` sits below the stack: `top = 453 + (L−1)×1.1133×fs + 1.17×fs + 8` px
(1.17×fs = measured Bodoni ink bottom incl old-style digit descenders).

**Sizing — one class per beat (ALL its lines share it):** Bodoni Moda 500 advance budget = 0.74×font-size
per counted char (measured: alphabet average 0.717×fs, worst real line "YOU FORWARD THE" 0.722×fs, the
0.32em+`&#160;` word gap ≈0.46×fs is covered); ink budgets 602px (odd lines, left 53) / 498px (even
lines, left 157) inside the 655px safe right edge. Closed form: `Ceff` = max over the beat's lines of
`C_k × 0.8272` (odd k) / `C_k` (even k), then pick the FIRST ladder row with `Ceff ≤ maxC`, starting at
the HEIGHT-CAP row: L ≤ 2 → `s125`; L = 3 → `s88`; L = 4 → `s66` (keeps stack + note-b above the credits
chrome at 819).

| row | s125 | s112 | s100 | s88 | s76 | s66 | s58 | s51 | s45 | s40 | s36 | s32 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| maxC | 5 | 6 | 6 | 7 | 8 | 10 | 11 | 13 | 14 | 16 | 18 | ∞ |

(maxC = floor(673/fs), 673 = 498/0.74.)

**Worked example** (portrait-main fixture): beat 1 — `So I built an app that does one thing.`,
cueDelayMs 320, next beat 2080 → winMs 1760, gateEnd 2080: 9 units → L = 3; total chars 38, targets
12.67/25.33; cumulative 2,4,10,13,17,22,27,31 → cuts after unit 4 (13) and unit 7 (27) →
`SO I BUILT AN` (13, odd) · `APP THAT DOES` (13, even) · `ONE THING.` (10, odd). Ceff =
max(13×0.8272, 13, 10×0.8272) = 13; L=3 starts at `s88` → first row with maxC ≥ 13 → `s51`.
Tops: 453 · 453+56.78 → 510 · 453+113.56 → 567; lefts 53 · 157 · 53. note-b top =
453 + 2×56.78 + 1.17×51 + 8 = 634.23 → 634.
Beat 5 (`10,000 hours saved.`, cueDelayMs 8240, winMs 1600, gateEnd 9840): 3 units → L = 2; cumulative
6,12 vs target 9.5 → cut after `HOURS` → `10,000 HOURS` (12, odd) · `SAVED.` (6, even) →
Ceff = max(12×0.8272, 6) = 9.93 → `s66`. Tops 453 · 526; note-b top = 453+73.48+77.22+8 = 611.7 → 612.

## 4. WORDS + TIMING

- The beat's `.cue` gets inline `z-index:{10+N}; animation-delay:{cueDelayMs}ms;
  animation-duration:{winMs}ms` (§3 window — delays are absolute on the single timeline; the cue window
  bounds every span's lifetime, so consecutive posters never coexist). The beat's title HOLDS to the end
  of its window — no fade-outs anywhere; the gate cuts it.
- **Title pair-clusters (role 10):** split each span's text into 2-char clusters IN ORDER (odd char count
  → last cluster is 1 char; punctuation is a char). One `<span class="g big">` per cluster. Cluster delays
  derive from that span's `delayMs` (VERBATIM base — never adjusted) plus a fixed stagger:
  `clDelayMs = spanDelayMs + j×K`, j = 0-based cluster index WITHIN the span, **K = 130** (the prefab's
  own title cadence). ONE guard, per span: if `spanDelayMs + (m−1)×130 + 300 > gateEnd` (m = span cluster
  count), use **K = 60** for that span (if 60 still overruns, keep 60 — the mid-reveal cut is accepted).
- **END-OF-BEAT COMPRESSION** (per cluster, mechanical): if `clDelayMs + 300 > gateEnd`, give that
  cluster inline `animation-duration:{max(gateEnd − clDelayMs, 200)}ms` so it lands before the gate
  closes. Same rule for aside clusters with their 240ms entrance: if `clDelayMs + 240 > gateEnd` →
  `animation-duration:{max(gateEnd − clDelayMs, 200)}ms`.
- **WORD GAPS** (both parts required): the LAST cluster of every unit EXCEPT the line-final one gets
  class `g big gp` AND a trailing `&#160;` appended to its text — bare margins alone can be eaten by ink
  overhang and the engine trims plain trailing spaces. No gaps between clusters inside a unit; a glued
  `-` unit renders as one continuous cluster run across its spans.
- **Asides:** fixed text in 3-char clusters (`AN ORIGINAL` → `AN `,`ORI`,`GIN`,`AL` · `IN REAL TIME` →
  `IN `,`REA`,`L T`,`IME`), `clDelayMs = base + j×60` with base = `cueDelayMs + 240` (note-a) /
  `cueDelayMs + 480` (note-b); the compression rule above applies.
- Cluster example (beat 1 line 3, gateEnd 2080): `ONE` (delayMs 1400, 2 clusters, K=130) →
  `<span class="g big" style="animation-delay:1400ms">ON</span><span class="g big gp" style="animation-delay:1530ms">E&#160;</span>`;
  `THING.` (delayMs 1680, 3 clusters: 1680+2×130+300 = 2240 > 2080 → K=60) → delays 1680/1740/1800, and
  `G.` compresses (1800+300 > 2080) → `animation-duration:280ms`.
- Chrome timing is already final in the skeleton (the one 0–1770ms wave, then persistent) — never touch
  it, never re-reveal it per beat.

## 5. EMPHASIS

STRUCTURAL, already produced by the mapping: the whole spoken beat IS the monumental glowing Bodoni
title — the prefab has no per-word hero device in its title, and none is added. Do NOT add color swaps,
scale bumps, or per-word styling; the fixed chrome (roles 1–7) and the asides (8–9) are the counterweight.

## 6. VERIFY LOOP

Run (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Otherwise apply the MECHANICAL fix for the named element and re-run; at most 2 fix cycles:
- `FAIL[bounds]` on `#b{N}l{K}` / `#b{N}na` / `#b{N}nb` → move that BEAT one row DOWN the ladder (all its
  lines share the class; the height-cap row still bounds the top; note-b's top rides the smaller fs).
  Same beat again → one more row.
- `FAIL[never-visible]` on a cluster → it was pasted into the WRONG beat's `.cue`, its delay is not
  `spanDelayMs + j×K` with this beat's gateEnd, or the `.cue` is missing one of its three inline values.
  (On chrome: the video is shorter than the 0–1770ms wave + 240ms — report, do not restyle.)
- `FAIL[occluded]` → two cue windows overlap: re-check each `{winMs}` equals the next beat's `cueDelayMs`
  minus this beat's, cues appear in DOM in beat order, every cue carries `z-index:{10+N}`, and no chrome
  z-index was raised above 2.

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --record {repo}/runs/<key>/final/out.silent.mp4
```

Manifest line (already given in section 2): `{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json`

## 7. DO NOT

- No fonts, colors, shadows, sizes, or keyframes beyond this sheet — Bodoni Moda + EB Garamond + Geist,
  white on the footage, the two glow recipes (each keeping its dark grounding layer), the 12-row ladder
  and the 2 keyframe blocks are the whole system.
- No `filter` anywhere — the prefab's `gIn` blur ramp is REMOVED on purpose (the engine drops animated
  blur ramps; opacity carries the reveal); do not restore it, do not animate `text-shadow` either.
- Never change, translate, or transcript-derive the dressing text (chrome AND the two asides); never put
  a spoken word into a dressing slot — every spoken char is a `title-cluster` in a `.tt` line. Never
  move or re-time chrome.
- No invented timing: every title cluster delay is `spanDelayMs + j×K` off a VERBATIM
  `word-timings.json` delay; aside bases are `cueDelayMs + 240/480`; cue delay/window only via the §3
  subtraction.
- No fade-outs on title lines or asides (the gate cuts the held poster); no `var()` in
  transforms/keyframes; clusters stay `display:inline-block; white-space:pre`; the apple pictogram's
  clip-path polygons are copied verbatim, never redrawn.
- No reading frames, no ffmpeg, no visual checks — `--verify` is the only self-check; no redesign after
  a failure, only the mechanical fixes in section 6.
