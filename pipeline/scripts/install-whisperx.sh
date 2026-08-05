#!/bin/bash
# Install WhisperX, the local and free transcription provider (prep/transcribe.ts). NOT run as a side
# effect of anything: the orchestrator asks the user first, because this pulls in PyTorch and the first
# transcription then downloads model weights — around 2 GB of disk for the fastest tier, more for medium.
#
# Usage:
#   bash pipeline/scripts/install-whisperx.sh            # install (or report an existing install)
#   bash pipeline/scripts/install-whisperx.sh 3.4.3       # pin a version
#
# Removing it: `uv tool uninstall whisperx` (or `pipx uninstall whisperx`) takes out the tool and its
# dependencies. Downloaded weights live on in ~/.cache/huggingface and ~/.cache/torch, which other tools
# share — prune those per model directory, never wholesale.
#
# Installs into an isolated tool environment — uv first, pipx second. It deliberately never runs
# `pip install` against the system Python: on a Homebrew or system interpreter that is either blocked
# outright (PEP 668) or, worse, succeeds and contaminates the environment.
set -euo pipefail

VERSION="${1-}"
SPEC="whisperx${VERSION:+==$VERSION}"

# The interpreter is pinned because on Python 3.14 the resolver produces an install whose
# `whisperx --help` works but whose first real transcription dies importing pyannote.audio, since
# torchaudio 2.9 removed list_audio_backends(). 3.12 resolves a working set.
PYTHON="${OPEN_EDIT_WHISPERX_PYTHON-3.12}"

# Platform guard — matching the rest of the runtime, and CTranslate2 has no GPU path here anyway, so
# transcription is CPU-bound by construction.
OS="$(uname -s)"; ARCH="$(uname -m)"
if [ "$OS" != "Darwin" ] || [ "$ARCH" != "arm64" ]; then
  echo "install-whisperx: unsupported platform ${OS}/${ARCH} — this runtime is macOS arm64 only." >&2
  exit 1
fi

have() { command -v "$1" >/dev/null 2>&1; }

if have whisperx; then
  echo "install-whisperx: whisperx is already installed at $(command -v whisperx)"
  exit 0
fi

if have uv; then
  echo "install-whisperx: installing ${SPEC} with uv on Python ${PYTHON} (isolated tool environment)"
  uv tool install --python "$PYTHON" "$SPEC"
elif have pipx; then
  echo "install-whisperx: installing ${SPEC} with pipx on Python ${PYTHON} (isolated tool environment)"
  pipx install --python "python${PYTHON}" "$SPEC" || pipx install "$SPEC"
else
  cat >&2 <<'MSG'
install-whisperx: neither uv nor pipx is available, and this script will not install into the system
Python. Install one of them first, then re-run:

  brew install uv     # recommended
  brew install pipx

Or choose VEED transcription instead, which needs no local install.
MSG
  exit 1
fi

# An installer that exits 0 without a working binary is the failure mode worth catching here: a half
# state would otherwise be discovered mid-render.
if ! have whisperx; then
  echo "install-whisperx: the install reported success but whisperx is not on PATH." >&2
  echo "If uv or pipx installed it elsewhere, add its bin dir to PATH or set WHISPERX_BIN." >&2
  exit 1
fi
if ! whisperx --help >/dev/null 2>&1; then
  echo "install-whisperx: whisperx is on PATH but does not run (--help failed)." >&2
  exit 1
fi

# --help alone is not proof: it parses arguments before importing the alignment stack, so a broken
# dependency set passes it and fails on the first real transcription instead. Import the package with
# the interpreter from the installed script's own shebang, which works for uv and pipx alike.
WX_PYTHON="$(head -n1 "$(command -v whisperx)" | sed 's|^#!||' | awk '{print $1}')"
if [ -x "$WX_PYTHON" ]; then
  if ! "$WX_PYTHON" -c 'import whisperx' >/dev/null 2>&1; then
    echo "install-whisperx: whisperx installed but cannot be imported — its dependency set is broken." >&2
    echo "Retry pinned to another interpreter, e.g. OPEN_EDIT_WHISPERX_PYTHON=3.11 bash $0" >&2
    exit 1
  fi
else
  echo "install-whisperx: note — could not locate the interpreter to verify the import; skipping that check." >&2
fi

echo "install-whisperx: ready — $(command -v whisperx)"
echo "The first transcription downloads model weights, and alignment runs on CPU; expect it to be slow."
