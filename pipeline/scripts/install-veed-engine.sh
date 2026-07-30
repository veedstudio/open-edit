#!/bin/bash
# Install veed-engine-cli by downloading the release directly from GitHub (no Homebrew).
# Fetches the macOS-arm64 tarball + its .sha256 + the feature-support.md asset, verifies the checksum,
# and extracts everything into the repo-local .veed-engine/ dir (gitignored). preflight.sh checks
# staleness; this script does the actual install/upgrade — the orchestrator asks the user before running.
# The upstream release assets keep their original names (weave-viewer-cli-*.tar.gz, weave-v* tags);
# the extracted binary is renamed locally to veed-engine-cli.
#
# Usage:
#   bash pipeline/scripts/install-veed-engine.sh            # install/upgrade to the latest release
#   bash pipeline/scripts/install-veed-engine.sh weave-v0.4.1   # pin a specific tag (upstream tag format)
#
# After it runs, the binary is .veed-engine/veed-engine-cli (config.ts's default VEED_ENGINE_BIN).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO="veedstudio/weave-renderer-public-releases"   # upstream repo name — not renamed
DEST="$REPO_ROOT/.veed-engine"
TARBALL="weave-viewer-cli-macos-arm64.tar.gz"   # upstream asset name; only macOS-arm64 is published today
UPSTREAM_BIN="weave-viewer-cli"                 # binary name inside the tarball
LOCAL_BIN="veed-engine-cli"                     # what we rename it to

# 0. Platform guard — the only published asset is macOS arm64; fail loudly elsewhere rather than
# installing a binary that can't exec (replaces brew's `depends_on arch: :arm64`).
OS="$(uname -s)"; ARCH="$(uname -m)"
if [ "$OS" != "Darwin" ] || [ "$ARCH" != "arm64" ]; then
  echo "install-veed-engine: unsupported platform ${OS}/${ARCH} — only macOS arm64 is published at ${REPO}." >&2
  exit 1
fi

# 1. Resolve the tag to install (arg overrides; else the latest release, jq-free parse)
TAG="${1:-}"
if [ -z "$TAG" ]; then
  TAG="$(curl -fsSL --max-time 30 "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
          | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
fi
if [ -z "$TAG" ]; then
  echo "install-veed-engine: could not resolve a release tag (offline, or GitHub API unreachable)." >&2
  exit 1
fi
BASE="https://github.com/${REPO}/releases/download/${TAG}"
echo "install-veed-engine: installing ${TAG} (${TARBALL}) → ${DEST}"

# 2. Download tarball + checksum + feature-support.md into a scratch dir
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -fSL  --max-time 120 --progress-bar -o "$WORK/$TARBALL"        "$BASE/$TARBALL"
curl -fsSL --max-time 30                 -o "$WORK/$TARBALL.sha256"  "$BASE/$TARBALL.sha256"
# feature-support.md is auxiliary (the support matrix) — don't abort the install if a release omits it.
curl -fsSL --max-time 30 -o "$WORK/feature-support.md" "$BASE/feature-support.md" \
  || echo "install-veed-engine: note — no feature-support.md asset on ${TAG}; skipping it."
# The binary is licensed separately from this repo (PolyForm Shield, not Apache-2.0) and the tarball
# does not carry its terms, so fetch them from the release tag and install them next to the binary —
# whoever ends up with the engine should also end up with its license. Repo file, not a release asset.
curl -fsSL --max-time 30 -o "$WORK/LICENSE-binary.md" \
  "https://raw.githubusercontent.com/${REPO}/${TAG}/LICENSE-binary.md" \
  || echo "install-veed-engine: note — could not fetch the engine license for ${TAG}; it is at https://github.com/${REPO}/blob/main/LICENSE-binary.md"

# 3. Verify the checksum (the sidecar names the tarball; check from inside the work dir)
echo "install-veed-engine: verifying sha256…"
( cd "$WORK" && shasum -a 256 -c "$TARBALL.sha256" )

# 4. Extract into a clean .veed-engine/ (replace any prior install atomically-ish), then rename the
# binary from its upstream name to the local one.
rm -rf "$DEST"
mkdir -p "$DEST"
tar -xzf "$WORK/$TARBALL" -C "$DEST"
mv "$DEST/$UPSTREAM_BIN" "$DEST/$LOCAL_BIN"
[ -f "$WORK/feature-support.md" ] && mv "$WORK/feature-support.md" "$DEST/feature-support.md"
[ -f "$WORK/LICENSE-binary.md" ] && mv "$WORK/LICENSE-binary.md" "$DEST/LICENSE-binary.md"

# 5. Clear any quarantine flag so the ad-hoc-signed bundle runs without a Gatekeeper prompt
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

# 6. Verify the binary actually runs (catches a wrong-arch download or an unexpected tarball layout)
if ! VER="$("$DEST/$LOCAL_BIN" --version 2>/dev/null)"; then
  echo "install-veed-engine: ERROR — installed $DEST/$LOCAL_BIN but it did not run (--version failed)." >&2
  exit 1
fi
echo "install-veed-engine: installed ${VER}"
echo "install-veed-engine: VEED_ENGINE_BIN → $DEST/$LOCAL_BIN"
