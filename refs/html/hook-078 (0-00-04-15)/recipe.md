> **AUTHORITY NOTE (2026-07-21):** `recipe.ts` next door is the single source of truth — the
> curation pass (design rounds v2–v6) edited the MODULE only and this sheet has NOT been synced.
> Do not recompile the module from this sheet until it is re-derived.

# RECIPE — hook-078 (0-00-04-15) · neon movie-poster credits (9:16 · 736×1312 @ 25fps)

RESOLUTION: px are authored at the 9:16 reference canvas 736×1312. FIRST STEP: SCALE = W/736 from
`meta.json` (require |H − 1312·SCALE| ≤ 0.02·H, else STOP — wrong aspect). SCALE = 1 → numbers verbatim;
otherwise multiply EVERY px by SCALE and round (positions, sizes, fonts, px spacing/shadows/margins/tops);
`em` values and ms timings never scale; the manifest carries the run's real W/H.

Prefab is 720×1280; every px below is ALREADY rescaled ×1.022 — copy numbers as written, never rescale again.

## 1. IDENTITY

A neon-yellow movie-poster over full-bleed footage: fixed Oswald credits chrome (corner kickers, twin
laurel badges around "A CREATOR! JOINT", a small subtitle, three credit rows, bottom logos with a smile
underline) frames a monumental all-caps Staatliches title — the spoken beat — whose characters strike on
one by one like an under-powered neon tube, glowing yellow `#fff402` on their real word timings.

## 2. SKELETON

Paste this whole document as `runs/<key>/final/template.wv`, then insert one `.cue` block per beat
(section 3) after the chrome. Replace only `{videoPath}` (from `meta.json`). The chrome (#tagl … #logos)
is FINAL — fixed dressing text with fixed delays; never edit it, never put spoken words in it. The
prefab's `ignite` animated a `drop-shadow` surge together with sub-1 opacity — animated drop-shadow under
partial opacity clips glyphs in this engine, so this sheet's `ignite` is opacity-ONLY and the glow lives
entirely in the static text-shadows (2 yellow neon layers + 1 dark grounding layer so yellow survives
light footage). Do not re-add any `filter`.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Staatliches&family=Oswald:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 736px; height: 1312px; background: #000; overflow: hidden; }
  body { position: relative; font-family: 'Oswald', sans-serif; }
  .vid { position: absolute; inset: 0; width: 736px; height: 1312px; object-fit: cover; z-index: 0; }

  /* poster chrome — fixed dressing, one reveal wave at clip start, persistent for the whole video */
  .y { color: #fff402; }
  .glow { text-shadow: 0 0 14px rgba(255,225,0,.55), 0 0 4px rgba(255,225,0,.7), 0 2px 12px rgba(0,0,0,.7); }
  .fader { opacity: 0; animation: fadeon .45s cubic-bezier(.2,.7,.3,1) both; }
  @keyframes fadeon { from { opacity: 0; } to { opacity: 1; } }

  #tagl { position: absolute; z-index: 2; left: 87px; top: 61px; font-weight: 700; font-size: 18px; letter-spacing: 2px; }
  #tagr { position: absolute; z-index: 2; right: 61px; top: 61px; font-weight: 700; font-size: 18px; letter-spacing: 2px; }

  #joint-row { position: absolute; z-index: 2; left: 0; top: 393px; width: 736px; height: 65px; }
  #joint { position: absolute; top: 4px; left: 0; width: 736px; font-weight: 700; font-size: 27px; letter-spacing: 4px;
           display: flex; align-items: flex-start; gap: 12px; justify-content: center; }
  .jd { font-family: 'Staatliches', sans-serif; letter-spacing: 0; font-size: 31px; transform: skewX(-6deg); }
  .laurel { position: absolute; top: 0; width: 78px; height: 65px; }
  #laurel-l { left: 63px; }
  #laurel-r { left: 595px; }
  .lp { position: absolute; left: 0; top: 0; width: 78px; height: 65px; background: #fff402; z-index: 1; }
  .lbl { position: absolute; left: 0; top: 0; width: 78px; height: 65px; z-index: 2;
         display: flex; flex-direction: column; align-items: center; justify-content: center;
         font-size: 9px; font-weight: 700; line-height: 1.05; letter-spacing: .5px; }

  #subtitle-row { position: absolute; z-index: 2; left: 0; top: 783px; width: 736px; text-align: center; }
  #subtitle { display: inline-block; font-weight: 700; font-size: 21px; letter-spacing: 2px; }

  #credits { position: absolute; z-index: 2; left: 0; top: 864px; width: 736px;
             display: flex; flex-direction: column; align-items: center; gap: 9px; }
  .crow { display: flex; gap: 17px; justify-content: center; font-size: 19px; font-weight: 400; letter-spacing: .5px; }
  .seg { position: relative; z-index: 2; white-space: nowrap; }
  .cb { font-weight: 700; }

  #logos { position: absolute; z-index: 2; left: 0; top: 1214px; width: 736px;
           display: flex; align-items: center; gap: 16px; justify-content: center; }
  #logo-jbo { position: relative; z-index: 2; font-weight: 700; font-size: 37px; letter-spacing: 1px; }
  #logo-prima { position: relative; font-weight: 500; font-size: 26px; letter-spacing: .5px; padding-bottom: 8px; }
  .pt { position: relative; z-index: 2; }
  .smile { position: absolute; left: 6px; right: 2px; bottom: -8px; height: 12px; }
  .sp { position: absolute; left: 0; top: 0; width: 100%; height: 100%; background: #fff402; z-index: 1; }

  /* beat gate — the one safe reveal recipe; z-index + delay + duration come inline per cue */
  @keyframes cueWin { 0%,99.99%{opacity:1} 100%{opacity:0} }
  .cue { position: absolute; left: 81px; top: 472px; width: 574px; opacity: 0;
         animation-name: cueWin; animation-timing-function: linear; animation-fill-mode: forwards; }

  /* title line — full-width block, ink centered by text-align (never shrink-to-fit flex);
     skew baked static per line; glow = 2 yellow neon layers + 1 dark grounding layer */
  .tl { display: block; width: 574px; text-align: center; white-space: nowrap;
        font-family: 'Staatliches', sans-serif; font-weight: 400; line-height: 1; letter-spacing: 0;
        color: #fff402; transform: skewX(-3deg);
        text-shadow: 0 0 14px rgba(255,225,0,.55), 0 0 4px rgba(255,225,0,.7), 0 2px 12px rgba(0,0,0,.7); }
  .tn { margin-top: -0.18em; } /* lines 2..L — the prefab's tight poster leading */

  /* size ladder (pick by section 3 table only — width and height budgets baked in) */
  .s94{font-size:94px} .s84{font-size:84px} .s76{font-size:76px} .s68{font-size:68px}
  .s62{font-size:62px} .s56{font-size:56px} .s50{font-size:50px} .s45{font-size:45px}
  .s40{font-size:40px} .s36{font-size:36px} .s32{font-size:32px} .s28{font-size:28px}

  /* per-char neon ignition — opacity gutters then holds lit. OPACITY ONLY (no filter).
     The vertical padding is shear headroom for the animating span's raster box. */
  @keyframes ignite { 0%{opacity:0} 10%{opacity:.9} 20%{opacity:.08} 34%{opacity:.7}
                      46%{opacity:.2} 62%{opacity:1} 100%{opacity:1} }
  .ch { display: inline-block; opacity: 0; padding-top: 0.08em; padding-bottom: 0.16em;
        animation: ignite .55s linear both; }
  .gp { margin-right: 0.32em; } /* inter-word gap, paired with the trailing &#160; (section 4) */
</style>
</head>
<body>
  <video class="vid" src="{videoPath}" muted></video>

  <div id="tagl" class="y glow fader" style="animation-delay:0ms" data-node-id="tagl" data-node-role="text">THE INTERNET</div>
  <div id="tagr" class="y glow fader" style="animation-delay:0ms" data-node-id="tagr" data-node-role="text">PRESENTS</div>

  <div id="joint-row">
    <div id="laurel-l" class="laurel" data-node-id="laurel-l" data-node-role="icon">
      <div class="lp fader" id="lp1" style="animation-delay:150ms; clip-path: polygon(51.1% 94.1%, 48.3% 91.5%, 45.8% 88.9%, 43.3% 86.1%, 41.0% 83.1%, 38.8% 80.1%, 36.8% 76.9%, 34.9% 73.6%, 33.2% 70.2%, 31.7% 66.7%, 13.0% 57.8%, 15.5% 55.6%, 30.2% 63.0%, 29.0% 59.3%, 27.9% 55.4%, 27.0% 51.4%, 11.0% 40.0%, 13.5% 37.8%, 26.2% 47.3%, 25.6% 43.1%, 25.2% 38.8%, 24.9% 34.4%, 14.0% 23.3%, 16.5% 21.1%, 24.8% 29.9%, 24.9% 25.3%, 25.2% 20.6%, 25.7% 15.8%, 24.0% 13.9%, 22.3% 15.4%, 21.8% 20.3%, 21.5% 25.1%, 21.4% 29.9%, 21.5% 34.6%, 34.0% 15.6%, 32.5% 18.3%, 21.8% 39.1%, 22.2% 43.6%, 22.8% 48.0%, 31.0% 32.2%, 29.5% 35.0%, 23.6% 52.3%, 24.6% 56.4%, 25.8% 60.5%, 27.1% 64.4%, 28.6% 68.2%, 32.0% 48.9%, 30.5% 51.7%, 30.2% 71.9%, 32.0% 75.5%, 34.0% 79.0%, 36.1% 82.3%, 38.4% 85.5%, 40.8% 88.6%, 43.4% 91.6%, 46.1% 94.4%, 48.9% 97.0%)"></div>
      <div class="lp fader" id="lp2" style="animation-delay:150ms; clip-path: polygon(48.9% 94.1%, 51.7% 91.5%, 54.2% 88.9%, 56.7% 86.1%, 59.0% 83.1%, 61.2% 80.1%, 63.2% 76.9%, 65.1% 73.6%, 66.8% 70.2%, 68.3% 66.7%, 87.0% 57.8%, 84.5% 55.6%, 69.8% 63.0%, 71.0% 59.3%, 72.1% 55.4%, 73.0% 51.4%, 89.0% 40.0%, 86.5% 37.8%, 73.8% 47.3%, 74.4% 43.1%, 74.8% 38.8%, 75.1% 34.4%, 86.0% 23.3%, 83.5% 21.1%, 75.2% 29.9%, 75.1% 25.3%, 74.8% 20.6%, 74.3% 15.8%, 76.0% 13.9%, 77.7% 15.4%, 78.2% 20.3%, 78.5% 25.1%, 78.6% 29.9%, 78.5% 34.6%, 66.0% 15.6%, 67.5% 18.3%, 78.2% 39.1%, 77.8% 43.6%, 77.2% 48.0%, 69.0% 32.2%, 70.5% 35.0%, 76.4% 52.3%, 75.4% 56.4%, 74.2% 60.5%, 72.9% 64.4%, 71.4% 68.2%, 68.0% 48.9%, 69.5% 51.7%, 69.8% 71.9%, 68.0% 75.5%, 66.0% 79.0%, 63.9% 82.3%, 61.6% 85.5%, 59.2% 88.6%, 56.6% 91.6%, 53.9% 94.4%, 51.1% 97.0%)"></div>
      <div class="lbl y fader" id="lbl1" style="animation-delay:150ms"><div>BEST</div><div>PICTURE</div></div>
    </div>
    <div id="joint" class="y glow fader" style="animation-delay:150ms" data-node-id="joint" data-node-role="text">
      <span id="jw1">A</span><span class="jd" id="jd">CREATOR!</span><span id="jw2">JOINT</span>
    </div>
    <div id="laurel-r" class="laurel" data-node-id="laurel-r" data-node-role="icon">
      <div class="lp fader" id="lp3" style="animation-delay:150ms; clip-path: polygon(51.1% 94.1%, 48.3% 91.5%, 45.8% 88.9%, 43.3% 86.1%, 41.0% 83.1%, 38.8% 80.1%, 36.8% 76.9%, 34.9% 73.6%, 33.2% 70.2%, 31.7% 66.7%, 13.0% 57.8%, 15.5% 55.6%, 30.2% 63.0%, 29.0% 59.3%, 27.9% 55.4%, 27.0% 51.4%, 11.0% 40.0%, 13.5% 37.8%, 26.2% 47.3%, 25.6% 43.1%, 25.2% 38.8%, 24.9% 34.4%, 14.0% 23.3%, 16.5% 21.1%, 24.8% 29.9%, 24.9% 25.3%, 25.2% 20.6%, 25.7% 15.8%, 24.0% 13.9%, 22.3% 15.4%, 21.8% 20.3%, 21.5% 25.1%, 21.4% 29.9%, 21.5% 34.6%, 34.0% 15.6%, 32.5% 18.3%, 21.8% 39.1%, 22.2% 43.6%, 22.8% 48.0%, 31.0% 32.2%, 29.5% 35.0%, 23.6% 52.3%, 24.6% 56.4%, 25.8% 60.5%, 27.1% 64.4%, 28.6% 68.2%, 32.0% 48.9%, 30.5% 51.7%, 30.2% 71.9%, 32.0% 75.5%, 34.0% 79.0%, 36.1% 82.3%, 38.4% 85.5%, 40.8% 88.6%, 43.4% 91.6%, 46.1% 94.4%, 48.9% 97.0%)"></div>
      <div class="lp fader" id="lp4" style="animation-delay:150ms; clip-path: polygon(48.9% 94.1%, 51.7% 91.5%, 54.2% 88.9%, 56.7% 86.1%, 59.0% 83.1%, 61.2% 80.1%, 63.2% 76.9%, 65.1% 73.6%, 66.8% 70.2%, 68.3% 66.7%, 87.0% 57.8%, 84.5% 55.6%, 69.8% 63.0%, 71.0% 59.3%, 72.1% 55.4%, 73.0% 51.4%, 89.0% 40.0%, 86.5% 37.8%, 73.8% 47.3%, 74.4% 43.1%, 74.8% 38.8%, 75.1% 34.4%, 86.0% 23.3%, 83.5% 21.1%, 75.2% 29.9%, 75.1% 25.3%, 74.8% 20.6%, 74.3% 15.8%, 76.0% 13.9%, 77.7% 15.4%, 78.2% 20.3%, 78.5% 25.1%, 78.6% 29.9%, 78.5% 34.6%, 66.0% 15.6%, 67.5% 18.3%, 78.2% 39.1%, 77.8% 43.6%, 77.2% 48.0%, 69.0% 32.2%, 70.5% 35.0%, 76.4% 52.3%, 75.4% 56.4%, 74.2% 60.5%, 72.9% 64.4%, 71.4% 68.2%, 68.0% 48.9%, 69.5% 51.7%, 69.8% 71.9%, 68.0% 75.5%, 66.0% 79.0%, 63.9% 82.3%, 61.6% 85.5%, 59.2% 88.6%, 56.6% 91.6%, 53.9% 94.4%, 51.1% 97.0%)"></div>
      <div class="lbl y fader" id="lbl2" style="animation-delay:150ms"><div>BEST</div><div>ACT</div></div>
    </div>
  </div>

  <div id="subtitle-row" class="fader" style="animation-delay:300ms">
    <div id="subtitle" class="y glow" data-node-id="subtitle" data-node-role="text">INSPIRED BY ACTUAL EVENTS</div>
  </div>

  <div id="credits" class="glow" data-node-id="credits">
    <div class="crow y" data-node-id="credit-row1" data-node-role="text"><span class="seg fader" id="seg1" style="animation-delay:450ms">Directed By <b class="cb">THE ALGORITHM</b></span><span class="seg fader" id="seg2" style="animation-delay:450ms">Camera By <b class="cb">A TRIPOD</b></span><span class="seg fader" id="seg3" style="animation-delay:450ms">Audio By <b class="cb">THE MIC</b></span></div>
    <div class="crow y" data-node-id="credit-row2" data-node-role="text"><span class="seg fader" id="seg4" style="animation-delay:450ms">Script By <b class="cb">NO ONE</b></span><span class="seg fader" id="seg5" style="animation-delay:450ms">Editor By <b class="cb">CAFFEINE</b></span><span class="seg fader" id="seg6" style="animation-delay:450ms">Art Director By <b class="cb">VIBES</b></span></div>
    <div class="crow y" data-node-id="credit-row3" data-node-role="text"><span class="seg fader" id="seg7" style="animation-delay:450ms">Stylish By <b class="cb">DEFAULT</b></span><span class="seg fader" id="seg8" style="animation-delay:450ms">VFX By <b class="cb">NONE, SORRY</b></span></div>
  </div>

  <div id="logos" class="glow" data-node-id="logos">
    <div id="logo-jbo" class="y fader" style="animation-delay:600ms" data-node-id="logo-jbo" data-node-role="text">JBO</div>
    <div id="logo-prima" class="y" data-node-id="logo-prima" data-node-role="text"><span class="pt fader" id="pt" style="animation-delay:600ms">prima video</span>
      <span class="smile">
        <span class="sp fader" id="sp1" style="animation-delay:600ms; clip-path: polygon(3.1% 29.7%, 11.6% 49.9%, 20.1% 66.2%, 28.6% 78.6%, 37.2% 87.1%, 45.7% 91.7%, 54.3% 92.3%, 62.8% 89.1%, 71.3% 81.9%, 79.9% 70.8%, 88.4% 55.8%, 96.9% 36.9%, 96.4% 20.3%, 88.0% 39.1%, 79.5% 53.9%, 71.1% 64.9%, 62.7% 72.0%, 54.2% 75.2%, 45.8% 74.6%, 37.4% 70.0%, 28.9% 61.6%, 20.5% 49.4%, 12.1% 33.2%, 3.6% 13.2%)"></span>
        <span class="sp fader" id="sp2" style="animation-delay:600ms; clip-path: polygon(89.2% 14.3%, 97.5% 28.6%, 94.6% 82.1%)"></span>
      </span>
    </div>
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

**The role system (reversed from the prefab — 12 roles, assignment is fixed and total):** the prefab is a
poster of 12 element roles; 11 are chrome with fixed content and fixed reveal delays, and exactly ONE role
(`title-char`) is transcript-driven — EVERY spoken character of every beat is a `title-char`, no exceptions.
The prefab's chrome carried content-specific names (FOTHA, CLAYVER!, crew names, a Portuguese subtitle) —
garnish that cannot be transcript-derived, so it is collapsed to the fixed English dressing in the skeleton.
The prefab revealed its chrome once, 150ms per group after its one title; here the poster persists across
beats, so the same wave (same order, same 150ms cadence) runs ONCE at clip start:

| #  | role          | slot            | content              | reveal                              |
|----|---------------|-----------------|----------------------|-------------------------------------|
| 1  | kicker-left   | `#tagl`         | fixed `THE INTERNET` | fade @ 0ms                          |
| 2  | kicker-right  | `#tagr`         | fixed `PRESENTS`     | fade @ 0ms                          |
| 3  | laurel-panel  | `#lp1–4`        | fixed wreath panels  | fade @ 150ms                        |
| 4  | laurel-label  | `#lbl1–2`       | fixed BEST PICTURE/ACT | fade @ 150ms                      |
| 5  | joint-plain   | `#jw1`,`#jw2`   | fixed `A` / `JOINT`  | fade @ 150ms                        |
| 6  | joint-display | `#jd`           | fixed `CREATOR!`     | fade @ 150ms                        |
| 7  | title-char    | `.ch` in `b{N}l{k}` | EVERY spoken char | ignite @ `wordDelayMs + i×K` (§4)   |
| 8  | subtitle      | `#subtitle`     | fixed dressing       | fade @ 300ms                        |
| 9  | credit-seg    | `#seg1–8`       | fixed credits        | fade @ 450ms                        |
| 10 | logo-word     | `#logo-jbo`     | fixed `JBO`          | fade @ 600ms                        |
| 11 | logo-script   | `#pt`           | fixed `prima video`  | fade @ 600ms                        |
| 12 | smile-panel   | `#sp1–2`        | fixed smile panels   | fade @ 600ms                        |

One `.cue` per beat `{N}` of `word-timings.json` — it holds ONLY the title lines. Placement is FIXED
(`left:81; top:472; width:574` — centered on x 368; the title zone bottoms out above the subtitle chrome
at 783 by the height caps below). Beat template — one `.tl` div per line, one `.ch` span per character:

```html
<div class="cue" id="cue{N}" data-node-id="cue{N}"
     style="z-index:{10+N}; animation-delay:{cueDelayMs}ms; animation-duration:{winMs}ms">
  <div class="tl {SIZE}" id="b{N}l1" data-node-id="b{N}l1" data-node-role="text"><!-- char spans --></div>
  <div class="tl {SIZE} tn" id="b{N}l2" data-node-id="b{N}l2" data-node-role="text"><!-- char spans --></div>
  <!-- l3 / l4 only as the line rule produces them; every line after l1 carries `tn` -->
</div>
```

**Window** (the poster holds through speech gaps; the next poster replaces it exactly):
- `{winMs}` = next beat's `cueDelayMs` − this beat's `cueDelayMs`.
- Last beat: `{winMs}` = round(`durationSec`×1000 from `meta.json`) − its `cueDelayMs`.
- `gateEnd` = this beat's `cueDelayMs + winMs` (used by the timing guards in §4).

**Word prep:** UPPERCASE every token yourself (never text-transform); keep ALL punctuation. GLUE: a token
starting with `-` (e.g. `-DO` after `TO`) merges with the previous word into ONE unit for counting and
splitting; it renders as its own char run continuing the unit (each span keeps its OWN verbatim `delayMs`,
no gap inside the unit). Char count of a line = unit chars + 1 per space between its units.

**Line rule** (n = unit count after gluing; order preserved, every unit used once):
- L = 1 if n ≤ 2 · 2 if n ≤ 6 · 3 if n ≤ 11 · 4 if n ≥ 12.
- Cut points, closed form: for k = 1..L−1 the cut goes at the unit boundary whose cumulative char count
  (units 1..c rendered, gaps included) is CLOSEST to k·total/L; tie → the earlier boundary. Each cut must
  leave ≥1 unit per remaining line (search only boundaries after the previous cut and before n−(L−k)).

**Sizing — one class per beat (ALL its lines share it):** C = char count of the beat's LONGEST line.
Staatliches advance budget = 0.46×font-size per counted char (measured; alphabet average 0.437×fs, the
0.32em+`&#160;` word gap 0.53×fs — the flat 0.46 covers both), ink budget 548px inside the 574px box.
Pick the first row fitting C, then apply the HEIGHT CAP: L=3 → never larger than `s76`; L=4 → never
larger than `s56` (keeps the stack above the subtitle chrome at 783).

| C ≤ 12 | 13–14 | 15 | 16–17 | 18–19 | 20–21 | 22–23 | 24–26 | 27–29 | 30–33 | 34–37 | ≥38 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| s94 | s84 | s76 | s68 | s62 | s56 | s50 | s45 | s40 | s36 | s32 | s28 |

**Worked example** (portrait-main fixture, beat 1 — `So I built an app that does one thing.`,
cueDelayMs 320, next beat 2080 → winMs 1760, gateEnd 2080): 9 units → L = 3; total chars 38, targets
12.67/25.33; cumulative 2,4,10,13,17,22,27,31 → cuts after unit 4 (13) and unit 7 (27) →
`SO I BUILT AN` (13) · `APP THAT DOES` (13) · `ONE THING.` (10). C = 13 → `s84`, height cap L=3 → `s76`.
Beat 5 (`10,000 hours saved.`, cueDelayMs 8240, winMs 1600, gateEnd 9840): 3 units → L = 2; cut after
`HOURS` → `10,000 HOURS` (12) · `SAVED.` (6) → C = 12 → `s94`.

## 4. WORDS + TIMING

- The beat's `.cue` gets inline `z-index:{10+N}; animation-delay:{cueDelayMs}ms;
  animation-duration:{winMs}ms` (§3 window — delays are absolute on the single timeline; the cue window
  bounds every span's lifetime, so consecutive posters never coexist at the shared anchor). The beat's
  title HOLDS to the end of its window — no fade-outs anywhere; the gate cuts it.
- **Per-char ignition (role 7):** split each span's text into single characters IN ORDER (punctuation is a
  char). One `<span class="ch">` per char. Char delays derive from that span's `delayMs` (VERBATIM base —
  never adjusted) plus a fixed stagger: `chDelayMs = spanDelayMs + i×K`, i = 0-based char index WITHIN the
  span, **K = 65** (the prefab's own cadence). ONE guard, per span: if
  `spanDelayMs + (m−1)×65 + 550 > gateEnd` (m = span char count), use **K = 30** for that span (if 30
  still overruns, keep 30 — the mid-flicker cut is accepted).
- **END-OF-BEAT COMPRESSION** (per char, mechanical): if `chDelayMs + 550 > gateEnd`, give that char inline
  `animation-duration:{max(gateEnd − chDelayMs, 250)}ms` so it is fully lit before the gate closes. All
  other chars use the skeleton's `ignite .55s linear both` with only `animation-delay` inline.
- **WORD GAPS** (both parts required): the LAST char span of every unit EXCEPT the line-final one gets
  class `ch gp` AND a trailing `&#160;` appended to its text (`<span class="ch gp" …>O&#160;</span>`) —
  bare margins alone can be eaten by ink overhang and the engine trims plain trailing spaces. No gaps
  between chars inside a unit; a glued `-` unit renders as one continuous char run across its spans.
- Char span example (beat 1, `SO` delayMs 320, K 65): `<span class="ch" style="animation-delay:320ms">S</span><span class="ch gp" style="animation-delay:385ms">O&#160;</span>`.
  Beat 1's `THING.` (delayMs 1680, m=6, gateEnd 2080): 1680+5×65+550 = 2555 > 2080 → K=30 → delays
  1680…1830, and every char compresses (1680+550 > 2080) → inline durations 400/370/340/310/280/250ms.
  Beat 5's `SAVED.` (delayMs 9160, m=6, gateEnd 9840): K=30 → only the `.` at 9310 compresses, to
  `animation-duration:530ms` (9310+550 > 9840).
- Chrome timing is already final in the skeleton (the one 0–600ms wave, then persistent) — never touch
  it, never re-reveal it per beat.

## 5. EMPHASIS

STRUCTURAL, already produced by the mapping: the whole spoken beat IS the monumental Staatliches
ignite title — the prefab has no per-word hero device in its title, and none is added. Do NOT add color
swaps, scale bumps, or per-word styling; the fixed chrome (roles 1–6, 8–12) is the counterweight.

## 6. VERIFY LOOP

Run (outside any sandbox):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --verify
```

Exit 0 → record. Otherwise apply the MECHANICAL fix for the named element and re-run; at most 2 fix cycles:
- `FAIL[bounds] #b{N}l{K} … left/right/top/bottom outside` → move that BEAT one row DOWN the ladder
  (all its lines share the class; the height cap still applies as a floor on row size). Same beat again →
  one more row.
- `FAIL[never-visible]` on a span or line → that char was pasted into the WRONG beat's `.cue`, or its
  delay is not `spanDelayMs + i×K` with this beat's gateEnd, or the `.cue` is missing one of its three
  inline values.
- `FAIL[occluded]` → two cue windows overlap: re-check each `{winMs}` equals the next beat's `cueDelayMs`
  minus this beat's, cues appear in DOM in beat order, every cue carries `z-index:{10+N}`, and no chrome
  z-index was raised above 2.

Then record (a SECOND invocation — `--verify` and `--record` are mutually exclusive):

```
{repo}/.veed-engine/veed-engine-cli {repo}/runs/<key>/final --record {repo}/runs/<key>/final/out.silent.mp4
```

Manifest line (already given in section 2): `{"render":{"width":{W},"height":{H},"fps":{FPS},"duration":{DUR}}}   ← W/H/FPS/DUR from meta.json`

## 7. DO NOT

- No fonts, colors, shadows, sizes, or keyframes beyond this sheet — Staatliches + Oswald, `#fff402` on
  the footage, the 3-layer glow (2 yellow neon + 1 dark grounding, never edited or dropped), the 12-row
  ladder and the 3 keyframe blocks are the whole system.
- No `filter` anywhere — the prefab's animated `drop-shadow` surge is REMOVED on purpose (animated
  drop-shadow under sub-1 opacity clips glyphs in this engine); do not restore it, do not animate
  `text-shadow` either.
- Never change, translate, or transcript-derive the chrome text; never put a spoken word into a chrome
  slot — every spoken char is a `title-char` in a `.tl` line. Never move, re-time, or re-reveal chrome.
- No invented timing: every char delay is `spanDelayMs + i×K` off a VERBATIM `word-timings.json` delay;
  cue delay/window only via the §3 subtraction.
- No fade-outs on title lines (the gate cuts the held poster); no `var()` in transforms/keyframes; no
  descendant selectors — flat classes/ids exactly as in the skeleton; spans stay `display:inline-block`
  with their padding headroom.
- No reading frames, no ffmpeg, no visual checks — `--verify` is the only self-check; no redesign after
  a failure, only the mechanical fixes in section 6.
