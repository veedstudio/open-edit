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

## engine limits worked around
These are the constraints that shaped the first-batch animations, and only the ones this catalogue's
refs hit. The current support matrix ships with the release as `.veed-engine/feature-support.md`.

- **No `repeating-linear-gradient`** and **no stacked `background-image` gradient layers** (they collapse / break the background) — use one gradient or a solid fill.
- **No `vw` font sizes**, **no CSS grid / `mix-blend-mode` / `outline`**, **no SVG `<text>`**, **`<br>` ignored** (use block lines).
- **No animated `filter: blur`** — the engine holds the keyframe's initial value, so the ramp never plays (slides are fade-only). Static blur renders.
- **Don't rely on `-webkit-text-stroke`** — it is construct-dependent (renders on a static caption, drops on animated or tilted spans). Ground with an 8-way `text-shadow` instead.
- **`border-radius` draws a straight 45° chamfer, not a curve** — use %-only clip-path polygons for real corners.
