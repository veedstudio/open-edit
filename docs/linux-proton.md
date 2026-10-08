# Experimental Linux graphics rendering through Proton

The Windows renderer can render text and CSS animation on Linux x64 through
Proton's DXVK and vkd3d-proton libraries. This is an opt-in compatibility
experiment, not native Linux support or a complete Open Edit installation.

`pipeline/scripts/linux-proton-engine.mjs` launches an already-downloaded Windows
engine using an already-installed Proton. It translates project/output paths,
uses a dedicated Wine prefix, forwards the engine's output and exit status, and
fails if the engine logs errors despite exiting zero. It installs nothing.

## Tested scope

Tested on Ubuntu 24.04 x64, NVIDIA RTX 4070 SUPER (driver 580.173.2), an active X
display, Steam Proton Experimental (Wine 10.0, DXVK 2.7.1 development build,
vkd3d-proton 3.0.0), renderer 0.10.2 and Windows FFmpeg 9.0.1:

| Check | Result |
| --- | --- |
| Renderer `--version` and `--help` | Pass |
| PNG capture of CSS shapes | Pass; pixels inspected |
| Text and animated CSS shape to H.264 MP4 | Pass; 320×240, 10 frames, 10 fps, 1 second |
| First/last decoded frames | Text visible; shape moves |
| `--verify` plus JSON report | Pass, all 10 frames |
| Embedded H.264 `<video>` | **Fails** in Media Foundation; unsupported in this experiment |
| Standard `openedit init --dry` | Still rejects Linux in CLI 0.0.19 |
| Full recipe/gates/caption pipeline | Not validated |
| Render-server stdin jobs | Rejected by launcher; job paths need translation |

Stock Ubuntu Wine 9.0 started the binary but could not create the WebGPU device:
`D3D12 create fence handle failed with E_NOTIMPL`. Proton with its native DXVK
and vkd3d-proton DLLs got past this failure. Setting Proton's GStreamer library
paths alone did not repair video decoding; it produced missing-library errors
and a crash. Do not treat a successful MP4 encode as proof that source footage
decoded. The launcher rejects logged engine errors for this reason.

Other GPUs, display servers, Proton releases, media types and font caches have
not been validated. The smoke fixture used the engine's embedded fallback font.
`--headless` was tested with an active display, not a display-less host.

## Prepare a private runtime directory

Prerequisites: Node.js, an existing Steam Proton installation containing
`files/bin/wine64`, working Vulkan drivers/display, `curl`, `unzip`, `sha256sum`,
and native FFmpeg/ffprobe for inspecting results. No global installation or
automatic upgrade is performed by these instructions.

From the repository root, choose an **unused** runtime directory. Set the Proton
path to the installation on your machine; some releases have different layouts.

```bash
export OPENEDIT_PROTON_DIR="$HOME/.local/share/Steam/steamapps/common/Proton - Experimental"
export OPENEDIT_LINUX_STATE_DIR="$PWD/.veed-engine/linux-proton"
export OPENEDIT_WINDOWS_ENGINE_DIR="$OPENEDIT_LINUX_STATE_DIR/engine"
mkdir -p "$OPENEDIT_LINUX_STATE_DIR/downloads"
```

Download the upstream engine and verify its published checksum before extraction:

```bash
(
  set -eu
  cd "$OPENEDIT_LINUX_STATE_DIR/downloads"
  release=https://github.com/veedstudio/weave-renderer-public-releases/releases/download/weave-v0.10.2
  curl -fLO "$release/weave-viewer-cli-windows-x64.zip"
  curl -fLO "$release/weave-viewer-cli-windows-x64.zip.sha256"
  sha256sum -c weave-viewer-cli-windows-x64.zip.sha256
  unzip -q weave-viewer-cli-windows-x64.zip -d "$OPENEDIT_WINDOWS_ENGINE_DIR"
  curl -fL https://raw.githubusercontent.com/veedstudio/weave-renderer-public-releases/weave-v0.10.2/LICENSE-binary.md \
    -o "$OPENEDIT_WINDOWS_ENGINE_DIR/LICENSE-binary.md"
)
```

Copy Proton's translation DLLs next to the engine (leave the Steam installation
unchanged). Keep the engine's bundled shaders, fonts and other DLLs intact:

```bash
cp "$OPENEDIT_PROTON_DIR/files/lib/wine/dxvk/x86_64-windows/dxgi.dll" \
   "$OPENEDIT_PROTON_DIR/files/lib/wine/dxvk/x86_64-windows/d3d11.dll" \
   "$OPENEDIT_PROTON_DIR/files/lib/wine/vkd3d-proton/x86_64-windows/d3d12.dll" \
   "$OPENEDIT_PROTON_DIR/files/lib/wine/vkd3d-proton/x86_64-windows/d3d12core.dll" \
   "$OPENEDIT_WINDOWS_ENGINE_DIR/"
```

MP4 recording also needs **Windows** `ffmpeg.exe` next to the engine. Native
Linux FFmpeg cannot replace the Windows child process. Obtain and checksum-check
the essentials ZIP from [Gyan's FFmpeg builds](https://www.gyan.dev/ffmpeg/builds/)
(the same provider used by Open Edit's Windows installer), extract it into the
private runtime directory, and copy its `bin/ffmpeg.exe` next to the engine.
Retain the extracted package and its license files. Do not commit or redistribute
engine, FFmpeg or Proton binaries as part of this source contribution; their
respective licenses remain separate from this repository's Apache-2.0 code.

## Run the included fixture

```bash
export VEED_ENGINE_BIN="$PWD/pipeline/scripts/linux-proton-engine.mjs"
mkdir -p "$OPENEDIT_LINUX_STATE_DIR/results"
"$VEED_ENGINE_BIN" --version
"$VEED_ENGINE_BIN" tests/fixtures/linux-proton --verify \
  --verify-report "$OPENEDIT_LINUX_STATE_DIR/results/verify.json"
"$VEED_ENGINE_BIN" tests/fixtures/linux-proton --headless \
  --record "$OPENEDIT_LINUX_STATE_DIR/results/smoke.mp4"
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,nb_frames \
  -show_entries format=duration -of json "$OPENEDIT_LINUX_STATE_DIR/results/smoke.mp4"
node --test tests/linux-proton-engine.test.mjs
```

The launcher preserves the caller's working directory for asset/font discovery.
Pass path options as separate arguments (`--record "output path.mp4"`). Use
relative asset paths inside templates/manifests; only command-line paths are
translated. Custom safe zones belong in the manifest, not `--verify=safezones:…`.
The Wine prefix and shader cache live under `OPENEDIT_LINUX_STATE_DIR`; setting
`WINEPREFIX` does not redirect the launcher to a game's existing prefix.

## Remaining upstream work

The renderer's [public distribution repository](https://github.com/veedstudio/weave-renderer-public-releases)
states that engine source lives in a private upstream monorepo. Its
[0.10.2 release](https://github.com/veedstudio/weave-renderer-public-releases/releases/tag/weave-v0.10.2)
contains macOS arm64 and Windows x64 archives, with no Linux build.

CLI 0.0.19 rejects Linux before testing `VEED_ENGINE_BIN`, and its implementation
is in the separately published `@veedstudio/openedit-cli` package. This launcher
does not patch npm caches, impersonate Windows, or bypass preflight. A complete
Linux integration needs explicit CLI capability handling, reliable media
decoding, end-to-end gate tests, and preferably a native engine release from the
engine maintainers. Until then, use this entry point directly for experiments
within the tested graphics scope.
