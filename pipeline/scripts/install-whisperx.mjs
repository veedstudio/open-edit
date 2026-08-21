#!/usr/bin/env node
// Install WhisperX, the local and free transcription provider (prep/transcribe.ts). NOT run as a side
// effect of anything: the orchestrator asks the user first, because this pulls in PyTorch and the first
// transcription then downloads model weights — around 2 GB of disk for the fastest tier, more for medium.
//
// Usage:
//   node pipeline/scripts/install-whisperx.mjs            # install (or report an existing install)
//   node pipeline/scripts/install-whisperx.mjs 3.4.3      # pin a version
//
// Removing it: `uv tool uninstall whisperx` (or `pipx uninstall whisperx`) takes out the tool and its
// dependencies. Downloaded weights live on in ~/.cache/huggingface and ~/.cache/torch, which other tools
// share — prune those per model directory, never wholesale.
//
// Installs into an isolated tool environment — uv first, pipx second. It deliberately never runs
// `pip install` against the system Python: on a packaged or system interpreter that is either blocked
// outright (PEP 668) or, worse, succeeds and contaminates the environment.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { findOnPath, installHint, isCmdShim, whisperxSupported } from '../../.claude/skills/open-edit/scripts/platform.mjs';

const say = (msg) => console.log(`install-whisperx: ${msg}`);
const warn = (msg) => console.error(`install-whisperx: ${msg}`);
const die = (msg) => {
  warn(msg);
  process.exit(1);
};

const version = process.argv[2] ?? '';
const spec = `whisperx${version ? `==${version}` : ''}`;

// The interpreter is pinned because on Python 3.14 the resolver produces an install whose
// `whisperx --help` works but whose first real transcription dies importing pyannote.audio, since
// torchaudio 2.9 removed list_audio_backends(). 3.12 resolves a working set.
const python = 'OPEN_EDIT_WHISPERX_PYTHON' in process.env ? process.env.OPEN_EDIT_WHISPERX_PYTHON : '3.12';

// Platform guard — matching the rest of the runtime. On both supported platforms CTranslate2 defaults
// to CPU here; a CUDA-capable box can override the device via prep/transcribe.ts's env knobs.
if (!whisperxSupported()) {
  die(`unsupported platform ${process.platform}/${process.arch} — this runtime supports macOS arm64 and Windows x64.`);
}

const which = (cmd) => findOnPath(cmd);
// pipx installs as a .cmd shim on some Windows setups; Node refuses to exec those directly.
const run = (cmd, args, opts = {}) => {
  const resolved = which(cmd) ?? cmd;
  if (isCmdShim(resolved)) {
    const line = [resolved, ...args].map((a) => `"${a}"`).join(' ');
    return spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { stdio: 'inherit', ...opts, windowsVerbatimArguments: true });
  }
  return spawnSync(resolved, args, { stdio: 'inherit', ...opts });
};

const existing = which('whisperx');
if (existing) {
  say(`whisperx is already installed at ${existing}`);
  process.exit(0);
}

if (which('uv')) {
  say(`installing ${spec} with uv on Python ${python} (isolated tool environment)`);
  if (run('uv', ['tool', 'install', '--python', python, spec]).status !== 0) process.exit(1);
} else if (which('pipx')) {
  say(`installing ${spec} with pipx on Python ${python} (isolated tool environment)`);
  if (run('pipx', ['install', '--python', `python${python}`, spec]).status !== 0
    && run('pipx', ['install', spec]).status !== 0) process.exit(1);
} else {
  console.error(`install-whisperx: neither uv nor pipx is available, and this script will not install into the system
Python. Install one of them first, then re-run:

  ${installHint('uv')}     # recommended
  ${installHint('pipx')}

Or choose VEED transcription instead, which needs no local install.`);
  process.exit(1);
}

// An installer that exits 0 without a working binary is the failure mode worth catching here: a half
// state would otherwise be discovered mid-render.
const installed = which('whisperx');
if (!installed) {
  warn('the install reported success but whisperx is not on PATH.');
  warn('If uv or pipx installed it elsewhere, add its bin dir to PATH or set WHISPERX_BIN.');
  process.exit(1);
}
if (spawnSync(installed, ['--help'], { stdio: 'ignore' }).status !== 0) {
  warn('whisperx is on PATH but does not run (--help failed).');
  process.exit(1);
}

// --help alone is not proof: it parses arguments before importing the alignment stack, so a broken
// dependency set passes it and fails on the first real transcription instead. Import the package with
// the interpreter from the installed script's own shebang, which works for uv and pipx alike. On
// Windows the entry point is an .exe launcher with no shebang, so the check is skipped there.
let wxPython = '';
if (process.platform !== 'win32') {
  try {
    const shebang = fs.readFileSync(installed, 'utf8').split('\n', 1)[0] ?? '';
    if (shebang.startsWith('#!')) wxPython = shebang.slice(2).trim().split(/\s+/)[0] ?? '';
  } catch {
    wxPython = '';
  }
}
let interpreterUsable = false;
if (wxPython) {
  try {
    fs.accessSync(wxPython, fs.constants.X_OK);
    interpreterUsable = true;
  } catch {
    interpreterUsable = false;
  }
}
if (interpreterUsable) {
  if (spawnSync(wxPython, ['-c', 'import whisperx'], { stdio: 'ignore' }).status !== 0) {
    warn('whisperx installed but cannot be imported — its dependency set is broken.');
    warn(`Retry pinned to another interpreter, e.g. OPEN_EDIT_WHISPERX_PYTHON=3.11 node ${process.argv[1]}`);
    process.exit(1);
  }
} else {
  warn('note — could not locate the interpreter to verify the import; skipping that check.');
}

say(`ready — ${installed}`);
console.log('The first transcription downloads model weights, and alignment runs on CPU; expect it to be slow.');
