#!/usr/bin/env node
// Experimental Windows-renderer bridge. No downloads, global installs, or platform spoofing.
import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const pathOptions = new Set([
  '--template', '--overrides', '--exit-screenshot', '--record',
  '--verify-report', '--contrast-audit', '--statistics',
]);

export function windowsPath(value, cwd = process.cwd()) {
  if (/^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\')) return value;
  return `Z:${path.resolve(cwd, value)}`;
}

export function engineArgs(args, cwd = process.cwd()) {
  if (args.includes('--render-server')) {
    throw new Error('--render-server is not supported: stdin job paths require a separate bridge.');
  }
  let expectsPath = false;
  return args.map((arg, index) => {
    if (expectsPath) {
      expectsPath = false;
      if (arg.startsWith('--')) throw new Error('Missing path before ' + arg);
      return windowsPath(arg, cwd);
    }
    if (pathOptions.has(arg)) {
      if (index === args.length - 1) throw new Error('Missing path after ' + arg);
      expectsPath = true;
    }
    if (arg.startsWith('--verify=') && arg.includes('safezones:')) {
      throw new Error('Use manifest verify.safezones for custom zones with this experimental launcher.');
    }
    // The engine accepts a project directory as its first positional argument.
    return index === 0 && !arg.startsWith('-') ? windowsPath(arg, cwd) : arg;
  });
}

function requireFile(file, executable = false) {
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error('Missing file: ' + file);
  accessSync(file, executable ? constants.X_OK : constants.R_OK);
  return file;
}

export async function launch(args, env = process.env) {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('This experimental launcher supports Linux x64 only.');
  }
  for (const key of ['OPENEDIT_PROTON_DIR', 'OPENEDIT_WINDOWS_ENGINE_DIR']) {
    if (!env[key] || !path.isAbsolute(env[key])) throw new Error(key + ' must be an absolute directory path.');
  }
  const engine = env.OPENEDIT_WINDOWS_ENGINE_DIR;
  const wine = requireFile(path.join(env.OPENEDIT_PROTON_DIR, 'files/bin/wine64'), true);
  const binary = requireFile(path.join(engine, 'weave-viewer-cli.exe'));
  for (const dll of ['dxgi.dll', 'd3d11.dll', 'd3d12.dll', 'd3d12core.dll']) requireFile(path.join(engine, dll));
  if (args.includes('--record')) requireFile(path.join(engine, 'ffmpeg.exe'));
  const translated = engineArgs(args);
  // A dedicated prefix, never the user's default Wine prefix or a Steam game's prefix.
  const state = env.OPENEDIT_LINUX_STATE_DIR ?? path.join(env.XDG_STATE_HOME ?? path.join(homedir(), '.local/state'), 'openedit-proton');
  if (!path.isAbsolute(state)) throw new Error('OPENEDIT_LINUX_STATE_DIR must be absolute.');
  const prefix = path.join(state, 'wineprefix');
  mkdirSync(prefix, { recursive: true });
  const child = spawn(wine, [binary, ...translated], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: {
      ...env,
      WINEPREFIX: prefix,
      WINEDEBUG: env.WINEDEBUG ?? '-all',
      DXVK_LOG_LEVEL: env.DXVK_LOG_LEVEL ?? 'error',
      VKD3D_DEBUG: env.VKD3D_DEBUG ?? 'none',
      VKD3D_SHADER_CACHE_PATH: env.VKD3D_SHADER_CACHE_PATH ?? state,
      WINEDLLOVERRIDES: [env.WINEDLLOVERRIDES, 'dxgi,d3d11,d3d12,d3d12core=n'].filter(Boolean).join(';'),
      WINEPATH: [windowsPath(engine), env.WINEPATH].filter(Boolean).join(';'),
    },
  });
  // This engine can exit 0 after failing to decode a source video. Preserve its logs
  // while rejecting that false success; keep only a small tail across stream chunks.
  let failed = false;
  for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    let tail = '';
    stream.on('data', (chunk) => {
      output.write(chunk);
      const text = tail + chunk.toString();
      if (/\[error\]|video decode failed|VideoSourcePump: provider failed to open/.test(text)) failed = true;
      tail = text.slice(-512);
    });
  }
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (signal) return reject(new Error('Renderer terminated by ' + signal));
        if (failed && code === 0) {
          console.error('linux-proton-engine: renderer logged an error; output is not a successful render.');
          resolve(1);
        } else resolve(code ?? 1);
      });
    });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await launch(process.argv.slice(2)); }
  catch (error) { console.error('linux-proton-engine: ' + error.message); process.exitCode = 1; }
}
