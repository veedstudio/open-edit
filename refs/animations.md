# Ref animations

All 28 pool refs ship a `template.wv` (an engine animation document, rendered with `veed-engine-cli` —
engine releases: `github.com/veedstudio/weave-renderer-public-releases`), authored to the engine's CSS
subset (support matrix = `.veed-engine/feature-support.md`, downloaded with the release). Each ref folder:
`refs/html/<id>/recipe.md` (the prose sheet) · `recipe.ts` (the compiled module) · `template.wv`.
The effect tables below are a PARTIAL catalogue from the first animation batch — 11 of the 28 pool refs.

## Timing conventions
- **word-by-word**: ~150 ms stagger; each unit `opacity 0→1` + a small rise (`translateY ~0.28em→0`), ~0.42 s ease-out.
- **character-by-character**: ~45 ms stagger; same rise+fade per glyph.
- The frozen final frame is the composition at rest (except the deliberately transient ones — `hook-210`, wiggles).

---

## word-by-word
Words reveal one at a time in reading order (rise + fade), unless noted.

| ref | effect |
|---|---|
| `hook-040 (0-00-01-03)` | words slide up from below + fade in |
| `hook-015 (0-00-14-06)` | torn-paper labels slide up from below + fade in (each keeps its static rotate); arrows fade/slide in after |
| `hook-054-peak` | gold **curved-arc** title revealed word by word (rise + fade) |
| `hook-126 Comp 1-peak` | rise + fade |
| `hook-158-peak` | rise + fade |
| `hook-242-peak` | rise + fade |
| `hook-210-peak` | **in-and-out**: each word slides up from below + fades in, holds, then slides further up + fades out (transient — ends empty) |

## character-by-character
| ref | effect |
|---|---|
| `hook-114-peak` | glyphs rise + fade; **`f*@k` pops in as one word** with a brief size overshoot |
| `hook-244-peak` | headline **lights up like a neon sign in random order** — chars fade in + rise from the bottom with a glow |
| `hook-230-peak` | **title** (curved arc) char-by-char, then the **subtitle** word-by-word |

## scale-in
| ref | effect |
|---|---|
| `hook-107-peak` | lead-in words rise + fade; the hero word **“intentional” scales 0→1** (no opacity fade), then the closing words |

---

## engine behaviour these animations were built around
These are the findings that shaped the first-batch animations, and only the ones this catalogue's
refs hit. The current support matrix ships with the release as `.veed-engine/feature-support.md`.
Each line below is settled by a control render — a document, a control drawing what the claim
predicts, and a pixel diff between them — and names the probe that settled it; the batch's own
workarounds are kept where they are the ref's idiom, not where the engine forces them.

- **`repeating-linear-gradient` paints** (probe: repeating-linear-gradient), so a striped fill is available. Stacked `background-image` gradient layers were never probed — the batch saw them break the background, so treat them as unverified, not proven broken.
- **No CSS grid** (probe: css-grid) — use flex. `vw` font sizes, `mix-blend-mode` and CSS `outline` all render (probes: vw-font-size, mix-blend-mode, css-outline), and so do inline `<svg>` and SVG `<text>` (probes: svg-inline, svg-text).
- **`<br>` breaks a line of ordinary inline text** (probe: br-ignored) but is inert between `display:inline-block` spans (probe: br-between-inline-blocks) — a per-word caption line still needs its own block element.
- **No animated `filter: blur`** — the engine holds the keyframe's initial value, so the ramp never plays (probe: animated-blur-holds); slides are fade-only. Static blur renders.
- **`-webkit-text-stroke` never paints**, on any construct (probe: webkit-text-stroke-never-paints). Ground with an 8-way `text-shadow` instead.
- **`border-radius` renders a true curve** (probes: border-radius-chamfer, border-radius-chamfer-clipped); only the slash form and per-corner values are ignored (probes: radius-slash-square, per-corner-radius). The %-only clip-path polygons in these refs state their corner geometry explicitly — that is the ref's idiom, not a repair.
