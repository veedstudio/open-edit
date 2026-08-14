#!/bin/bash
# Open Edit's single setup entrypoint.
#
#   preflight                 Apply workspace-local setup; report global installs and updates.
#   preflight --dry           Report only; never write.
#   preflight --auto-approve  Apply everything, including global installs and clean updates. The
#                             orchestrating agent may use this only after explicit user approval.
set -uo pipefail

# GUI-launched agents inherit a minimal PATH that commonly omits Homebrew. Add both standard
# prefixes before probing brew, Node, pnpm, FFmpeg, or Git; preserve the caller's remaining PATH.
HOMEBREW_PATH_PREFIX="${OPEN_EDIT_HOMEBREW_PATH_PREFIX-/opt/homebrew/bin:/usr/local/bin}"
export PATH="${HOMEBREW_PATH_PREFIX:+$HOMEBREW_PATH_PREFIX:}$PATH"

DEFAULT_REPOSITORY="https://github.com/veedstudio/open-edit.git"
DEFAULT_REF="main"
MIN_PNPM="10.16.1" # floor, not a pin: any newer pnpm is accepted
ENGINE_RELEASES="veedstudio/weave-renderer-public-releases" # upstream repo name, not renamed
MODE="apply"
SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ARG=""
REPOSITORY_ARG=""
REF_ARG=""
NEEDS_APPROVAL=0
FAILED=0

usage() {
  cat >&2 <<'EOF'
usage: preflight.sh [--dry|--auto-approve]
                    [--workspace <path>] [--repository <url-or-path>] [--ref <branch>]

Bare preflight applies only workspace-local first-time setup. --dry never writes.
--auto-approve installs missing machine dependencies and applies all clean updates; use it only
after the user has explicitly approved every action reported by --dry.
EOF
}

die() { echo "preflight: ERROR — $*" >&2; exit 1; }
say() { echo "preflight: $*" >&2; }
need_approval() { NEEDS_APPROVAL=1; say "APPROVAL REQUIRED — $*"; }
have() { command -v "$1" >/dev/null 2>&1; }
version_at_least() { # version_at_least <candidate> <floor>
  [ -n "$1" ] || return 1
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]
}
pnpm_ok() { version_at_least "$(pnpm --version 2>/dev/null || true)" "$MIN_PNPM"; }
resolve_dir() { (cd "$1" 2>/dev/null && pwd -P) || return 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry) MODE="dry"; shift ;;
    --auto-approve) MODE="auto"; shift ;;
    --workspace) [ "$#" -ge 2 ] || die "--workspace requires a path"; WORKSPACE_ARG="$2"; shift 2 ;;
    --repository) [ "$#" -ge 2 ] || die "--repository requires a URL or local path"; REPOSITORY_ARG="$2"; shift 2 ;;
    --ref) [ "$#" -ge 2 ] || die "--ref requires a branch"; REF_ARG="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
done

for VALUE in "$WORKSPACE_ARG" "$REPOSITORY_ARG" "$REF_ARG"; do
  case "$VALUE" in *$'\n'*|*$'\r'*) die "arguments may not contain newlines" ;; esac
done

if [ -n "$WORKSPACE_ARG" ]; then
  WORKSPACE="$(resolve_dir "$WORKSPACE_ARG")" || die "workspace does not exist: $WORKSPACE_ARG"
else
  WORKSPACE="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"
fi
if [ -n "$REPOSITORY_ARG" ] && [ -d "$REPOSITORY_ARG" ]; then
  REPOSITORY_ARG="$(resolve_dir "$REPOSITORY_ARG")" || die "repository path does not exist"
fi

OS="$(uname -s 2>/dev/null || true)"
ARCH="$(uname -m 2>/dev/null || true)"
[ "$OS" = "Darwin" ] && [ "$ARCH" = "arm64" ] || die "unsupported platform ${OS:-unknown}/${ARCH:-unknown}; rendering requires macOS arm64"

CONTAINER="$WORKSPACE/.open-edit"
MANAGED_ROOT="$CONTAINER/runtime"
ROOT="$MANAGED_ROOT"
ROOT_KIND="missing"
STATE=""
RECORDED_REPOSITORY=""
RECORDED_REF=""
RECORDED_COMMIT=""

is_open_edit_checkout() {
  local candidate="$1"
  [ -f "$candidate/package.json" ] && [ -f "$candidate/pnpm-lock.yaml" ] &&
    [ -f "$candidate/pipeline/scripts/preflight.sh" ] &&
    grep -Eq '"name"[[:space:]]*:[[:space:]]*"open-edit"' "$candidate/package.json"
}

state_path() {
  local git_dir
  git_dir="$(git -C "$1" rev-parse --absolute-git-dir 2>/dev/null)" || return 1
  printf '%s/open-edit-preflight-state\n' "$git_dir"
}

state_get() { git config --file "$1" --get "preflight.$2" 2>/dev/null || true; }

write_state() {
  local root="$1" source="$2" branch="$3" commit="$4" state
  state="$(state_path "$root")" || die "cannot locate Git metadata for $root"
  git config --file "$state" preflight.schema 1
  git config --file "$state" preflight.repository "$source"
  git config --file "$state" preflight.ref "$branch"
  git config --file "$state" preflight.installedCommit "$commit"
}

discover_runtime() {
  local origin head
  if is_open_edit_checkout "$WORKSPACE" && git -C "$WORKSPACE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    ROOT="$WORKSPACE"; ROOT_KIND="reused"; return
  fi
  [ -e "$MANAGED_ROOT" ] || return
  [ -d "$MANAGED_ROOT" ] || die "managed runtime path is not a directory: $MANAGED_ROOT"
  is_open_edit_checkout "$MANAGED_ROOT" || die "refusing unexpected contents at $MANAGED_ROOT"
  STATE="$(state_path "$MANAGED_ROOT")" || die "managed runtime is not a Git checkout"
  [ -f "$STATE" ] || die "managed runtime has no completed-clone receipt"
  [ "$(state_get "$STATE" schema)" = "1" ] || die "managed runtime has an unsupported receipt"
  RECORDED_REPOSITORY="$(state_get "$STATE" repository)"
  RECORDED_REF="$(state_get "$STATE" ref)"
  RECORDED_COMMIT="$(state_get "$STATE" installedCommit)"
  [ -n "$RECORDED_REPOSITORY" ] && [ -n "$RECORDED_REF" ] && [ -n "$RECORDED_COMMIT" ] || die "managed runtime receipt is incomplete"
  origin="$(git -C "$MANAGED_ROOT" remote get-url origin 2>/dev/null || true)"
  head="$(git -C "$MANAGED_ROOT" rev-parse HEAD 2>/dev/null || true)"
  [ "$origin" = "$RECORDED_REPOSITORY" ] || die "runtime origin differs from its receipt"
  [ "$head" = "$RECORDED_COMMIT" ] || die "runtime HEAD differs from its managed revision; inspect it before continuing"
  [ -z "$REPOSITORY_ARG" ] || [ "$REPOSITORY_ARG" = "$RECORDED_REPOSITORY" ] || die "--repository conflicts with the managed runtime"
  [ -z "$REF_ARG" ] || [ "$REF_ARG" = "$RECORDED_REF" ] || die "--ref conflicts with the managed runtime"
  ROOT="$MANAGED_ROOT"; ROOT_KIND="managed"
}

discover_runtime

# Say which code is about to run, and warn when a local checkout is being bypassed. WORKSPACE is only
# reused when it IS an Open Edit checkout; otherwise everything below runs from a clone of
# $DEFAULT_REF, so pointing --workspace at the wrong directory silently runs different code.
BUNDLED_CHECKOUT="$(resolve_dir "$SCRIPT_ROOT/../../.." 2>/dev/null || true)"
if [ "$ROOT_KIND" = "reused" ]; then
  say "reusing the local checkout at $ROOT"
else
  say "workspace $WORKSPACE will use a managed clone at $MANAGED_ROOT"
  if [ -n "$BUNDLED_CHECKOUT" ] && is_open_edit_checkout "$BUNDLED_CHECKOUT" \
     && [ "$BUNDLED_CHECKOUT" != "$WORKSPACE" ]; then
    say "NOTE: this skill lives in the checkout $BUNDLED_CHECKOUT, which will NOT be used."
    say "      To run that code instead, pass --workspace $BUNDLED_CHECKOUT"
  fi
fi

if [ "$ROOT_KIND" = "managed" ]; then
  REPOSITORY="$RECORDED_REPOSITORY"; REF="$RECORDED_REF"
else
  REPOSITORY="${REPOSITORY_ARG:-$DEFAULT_REPOSITORY}"; REF="${REF_ARG:-$DEFAULT_REF}"
fi

install_brew_formula() {
  local formula="$1"
  have brew || { say "Homebrew is required to install $formula; install Homebrew first"; FAILED=1; return; }
  brew install "$formula" || FAILED=1
}

handle_global_dependencies() {
  local missing_git=0 missing_node=0 missing_pnpm=0 missing_ffmpeg=0
  have git || missing_git=1
  have node || missing_node=1
  pnpm_ok || missing_pnpm=1
  { have "${VEED_ENGINE_FFMPEG:-ffmpeg}" && have "${VEED_ENGINE_FFPROBE:-ffprobe}"; } || missing_ffmpeg=1

  if [ "$missing_git" -eq 1 ]; then need_approval "install Git globally: brew install git"; fi
  if [ "$missing_node" -eq 1 ]; then need_approval "install Node globally: brew install node"; fi
  if [ "$missing_pnpm" -eq 1 ]; then need_approval "install pnpm ${MIN_PNPM} or newer globally: npm install --global pnpm@${MIN_PNPM}"; fi
  if [ "$missing_ffmpeg" -eq 1 ]; then need_approval "install FFmpeg globally: brew install ffmpeg"; fi

  [ "$MODE" = "auto" ] || return
  NEEDS_APPROVAL=0
  [ "$missing_git" -eq 0 ] || install_brew_formula git
  [ "$missing_node" -eq 0 ] || install_brew_formula node
  [ "$missing_ffmpeg" -eq 0 ] || install_brew_formula ffmpeg
  if [ "$missing_pnpm" -eq 1 ]; then
    have npm || { say "npm is unavailable after installing Node"; FAILED=1; return; }
    npm install --global "pnpm@${MIN_PNPM}" || FAILED=1
  fi
  have git || FAILED=1
  have node || FAILED=1
  pnpm_ok || FAILED=1
  { have "${VEED_ENGINE_FFMPEG:-ffmpeg}" && have "${VEED_ENGINE_FFPROBE:-ffprobe}"; } || FAILED=1
}

handle_global_dependencies
[ "$FAILED" -eq 0 ] || die "one or more approved global dependency installs failed"

if [ "$MODE" != "dry" ] && have node; then
  node "$SCRIPT_ROOT/hooks/install-project-hooks.mjs" "$WORKSPACE" "$SCRIPT_ROOT" ||
    say "could not install project hooks automatically; the agent must preserve existing settings and add them manually"
fi

clone_runtime() {
  local staging commit origin exclude
  if [ "$ROOT_KIND" != "missing" ]; then return; fi
  if ! have git; then say "runtime clone is waiting for Git"; return; fi
  if [ "$MODE" = "dry" ]; then
    say "WOULD APPLY LOCALLY — full clone $REPOSITORY ($REF) to $MANAGED_ROOT"
    return
  fi
  mkdir -p "$CONTAINER"
  staging="$(mktemp -d "$CONTAINER/.preflight.XXXXXX")" || die "cannot create clone staging directory"
  trap 'rm -rf "$staging"' EXIT
  say "cloning $REPOSITORY ($REF) to $MANAGED_ROOT"
  git clone --single-branch --branch "$REF" -- "$REPOSITORY" "$staging/runtime" >&2 || die "clone failed"
  is_open_edit_checkout "$staging/runtime" || die "cloned repository is not a valid Open Edit checkout"
  commit="$(git -C "$staging/runtime" rev-parse HEAD)" || die "cannot resolve cloned revision"
  origin="$(git -C "$staging/runtime" remote get-url origin)" || die "cannot resolve cloned origin"
  write_state "$staging/runtime" "$origin" "$REF" "$commit"
  [ ! -e "$MANAGED_ROOT" ] || die "runtime appeared while cloning; refusing to overwrite it"
  mv "$staging/runtime" "$MANAGED_ROOT"
  trap - EXIT
  rm -rf "$staging"
  if git -C "$WORKSPACE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    exclude="$(git -C "$WORKSPACE" rev-parse --git-path info/exclude)"
    case "$exclude" in /*) ;; *) exclude="$WORKSPACE/$exclude" ;; esac
    grep -Fqx '.open-edit/' "$exclude" 2>/dev/null || printf '\n.open-edit/\n' >>"$exclude"
  fi
  ROOT="$MANAGED_ROOT"; ROOT_KIND="managed"
  STATE="$(state_path "$ROOT")"
  RECORDED_REPOSITORY="$origin"; RECORDED_REF="$REF"; RECORDED_COMMIT="$commit"
  say "runtime cloned at $commit"
}

clone_runtime

repo_deps_ready() {
  local recorded
  [ -x "$ROOT/node_modules/.bin/tsx" ] && [ -f "$ROOT/node_modules/.modules.yaml" ] || return 1
  recorded="$(sed -n 's/^packageManager:[[:space:]]*pnpm@\([^[:space:]"'"'"']*\).*/\1/p' \
    "$ROOT/node_modules/.modules.yaml" | head -n1)"
  version_at_least "$recorded" "$MIN_PNPM" &&
    (cd "$ROOT" && pnpm list --depth 0 >/dev/null 2>&1)
}

handle_repo_deps() {
  [ "$ROOT_KIND" != "missing" ] || return
  repo_deps_ready && { say "repository dependencies — ready"; return; }
  if ! have node || ! pnpm_ok; then
    say "repository dependencies are waiting for approved Node/pnpm installation"; return
  fi
  if [ "$MODE" = "dry" ]; then say "WOULD APPLY LOCALLY — pnpm install --frozen-lockfile in $ROOT"; return; fi
  say "installing repository dependencies in $ROOT"
  (cd "$ROOT" && pnpm install --frozen-lockfile) >&2 || die "repository dependency installation failed"
  repo_deps_ready || die "repository dependency validation failed after install"
}

handle_repo_deps

engine_path() { printf '%s\n' "${VEED_ENGINE_BIN:-$ROOT/.veed-engine/veed-engine-cli}"; }
latest_engine_version() {
  local tag
  tag="$(curl -fsSL --max-time 10 "https://api.github.com/repos/${ENGINE_RELEASES}/releases/latest" 2>/dev/null |
    grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' || true)"
  printf '%s\n' "${tag#weave-v}" # upstream tag format is weave-v<semver>
}

handle_renderer() {
  local engine installed latest lowest
  [ "$ROOT_KIND" != "missing" ] || return
  engine="$(engine_path)"
  if [ ! -x "$engine" ]; then
    if [ "$MODE" = "dry" ]; then say "WOULD APPLY LOCALLY — install the renderer in $ROOT/.veed-engine"; return; fi
    say "installing the renderer locally"
    bash "$ROOT/pipeline/scripts/install-veed-engine.sh" || die "renderer installation failed"
    return
  fi
  installed="$("$engine" --version 2>/dev/null | awk '{print $2}')"
  latest="$(latest_engine_version)"
  [ -n "$installed" ] && [ -n "$latest" ] || { say "renderer freshness — offline or indeterminate"; return; }
  [ "$installed" != "$latest" ] || { say "renderer $installed — current"; return; }
  lowest="$(printf '%s\n%s\n' "$installed" "$latest" | sort -V | head -n1)"
  [ "$lowest" = "$installed" ] || { say "renderer $installed is newer than published $latest"; return; }
  need_approval "update renderer from $installed to $latest"
  if [ "$MODE" = "auto" ]; then
    NEEDS_APPROVAL=0
    bash "$ROOT/pipeline/scripts/install-veed-engine.sh" || die "approved renderer update failed"
  fi
}

handle_renderer

handle_runtime_update() {
  local remote_commit local_commit changes
  [ "$ROOT_KIND" = "managed" ] || return
  remote_commit="$(git ls-remote --exit-code "$REPOSITORY" "refs/heads/$REF" 2>/dev/null | awk 'NR==1 {print $1}')"
  [ -n "$remote_commit" ] || { say "runtime freshness — offline or indeterminate"; return; }
  local_commit="$(git -C "$ROOT" rev-parse HEAD)"
  [ "$local_commit" != "$remote_commit" ] || { say "runtime $local_commit — current"; return; }
  changes="$(git -C "$ROOT" status --porcelain)"
  if [ -n "$changes" ]; then
    say "UPDATE AVAILABLE — runtime has local changes; leaving it untouched"
    return
  fi
  need_approval "fast-forward runtime from $local_commit to $remote_commit ($REPOSITORY $REF)"
  if [ "$MODE" = "auto" ]; then
    NEEDS_APPROVAL=0
    git -C "$ROOT" fetch origin "refs/heads/$REF:refs/remotes/origin/$REF" >&2 || die "approved runtime fetch failed"
    git -C "$ROOT" merge-base --is-ancestor "$local_commit" "$remote_commit" || die "remote update is not a fast-forward"
    git -C "$ROOT" merge --ff-only "$remote_commit" >&2 || die "approved runtime update failed"
    write_state "$ROOT" "$REPOSITORY" "$REF" "$remote_commit"
  fi
}

handle_runtime_update

if [ "$ROOT_KIND" = "missing" ]; then
  say "runtime is not ready"
elif repo_deps_ready && [ -x "$(engine_path)" ]; then
  say "ready — OPEN_EDIT_ROOT=$ROOT"
elif [ "$NEEDS_APPROVAL" -ne 0 ]; then
  say "local setup is incomplete because an approved prerequisite is missing"
else
  # Nothing is awaiting approval: the outstanding work is the WOULD APPLY LOCALLY list above, which
  # bare preflight performs itself. Saying "approval" here sent agents looking for a user to ask.
  say "not ready yet — run bare preflight (no --dry) to apply the local setup listed above"
fi

if [ "$NEEDS_APPROVAL" -ne 0 ]; then
  say "run with --auto-approve only after the user approves every action above"
  exit 10
fi
[ "$FAILED" -eq 0 ] || exit 1
printf '%s\n' "$ROOT"
