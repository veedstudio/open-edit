// The fal command an environment gives in place of a fal key, run once on one model and its input. Its answer is the
// files it leaves in a folder made for that one run; what it prints is only shown, and nothing is read from it.
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { printable } from '../printable.ts';
import { errorText } from '../proxy.ts';

/** The command left no answer: it refused, failed, could not be started, or was stopped for not answering in time. */
export class FalCommandFailed extends Error {}

/** How a command ended: its exit, or the error that kept it from starting, and whether it was stopped for running too long. */
export interface Ran { status: number | null; signal: string | null; error?: Error; timedOut: boolean }
/** Runs a command, giving each line of its stderr to `onLine` as it comes, and stops it and what it started after `timeoutMs`. */
export type Runner = (cmd: string, args: string[], o: { timeoutMs: number; onLine: (line: string) => void; graceMs?: number }) => Promise<Ran>;

// What a command's output may cost here, since it is the command's to fill: a line's length, how many lines are
// shown as they come, and how many of the last are kept for the line that says why it failed.
const LINE_CHARS = 400;
const LINES_SHOWN = 200;
const LINES_KEPT = 3;
// How long a command told to stop is given before it is killed, and how long its last output is waited for once it
// has exited.
const GRACE_MS = 2000;
const DRAIN_MS = 250;
// How many entries of the answer's folder are looked at, and what a file there may be called.
const ENTRIES_MOST = 64;
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const SECRET = '«redacted»';

/** A line of a command's output as it may be shown: no control characters, no credential, and no longer than LINE_CHARS. */
export const shownLine = (line: string): string => printable(line)
  .replace(/(authorization["']?\s*[:=]\s*["']?)((?:bearer|key|basic)\s+)?[^\s"',}]+/gi, `$1$2${SECRET}`)
  .replace(/\b(bearer\s+)[^\s"',}]+/gi, `$1${SECRET}`)
  .trim()
  .slice(0, LINE_CHARS);

export const runCommand: Runner = (cmd, args, o) => new Promise((done) => {
  const grouped = process.platform !== 'win32';
  // A group of its own, so that stopping it stops what it started too: a wrapper's child would outlive the wrapper.
  // Its stdout is not read: a pipe nobody empties would stall a command that prints its answer there.
  const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: grouped });
  let [pending, timedOut, over] = ['', false, false];
  let exited: { status: number | null; signal: string | null } | undefined;
  let interrupted: NodeJS.Signals | undefined;
  const timers: NodeJS.Timeout[] = [];
  const stop = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      // Windows has no process group: taskkill ends the command and all it started at once, with no warning first.
      if (grouped) process.kill(-child.pid, signal);
      else spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // Already gone.
    }
  };
  const FORWARDED: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const unhook = () => { for (const signal of FORWARDED) process.removeListener(signal, forward); };
  const end = (ran: Omit<Ran, 'timedOut'>) => {
    if (over) return;
    over = true;
    for (const timer of timers) clearTimeout(timer);
    unhook();
    if (pending.trim()) o.onLine(pending);
    // A child of the command may still hold the pipe: it is let go of, or it would keep this process from ending.
    child.stderr.destroy();
    child.unref();
    done({ ...ran, timedOut });
  };
  // Killed with all it started, then this process ends as the signal would have ended it.
  const die = () => {
    stop('SIGKILL');
    unhook();
    for (const timer of timers) clearTimeout(timer);
    if (interrupted && !process.listenerCount(interrupted)) process.kill(process.pid, interrupted);
    else end({ status: null, signal: interrupted ?? 'SIGKILL' });
  };
  // Stopping this process stops the command: in a group of its own it gets no signal from the terminal or a parent.
  function forward(signal: NodeJS.Signals): void {
    if (interrupted) return;
    interrupted = signal;
    stop(signal);
    timers.push(setTimeout(die, o.graceMs ?? GRACE_MS));
  }
  for (const signal of FORWARDED) process.on(signal, forward);
  timers.push(setTimeout(() => {
    if (exited) return;
    timedOut = true;
    stop('SIGTERM');
    // Killed after the grace whatever has exited or closed by then: a child that ignores the signal outlives both.
    timers.push(setTimeout(() => {
      stop('SIGKILL');
      end(exited ?? { status: null, signal: 'SIGKILL' });
    }, o.graceMs ?? GRACE_MS));
  }, o.timeoutMs));
  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    const parts = (pending + text).split('\n');
    pending = (parts.pop() ?? '').slice(0, 8 * LINE_CHARS);
    for (const part of parts) if (part.trim()) o.onLine(part);
  });
  child.on('error', (error) => end({ status: null, signal: null, error }));
  // Settled on the exit, not on the pipe closing: a child the command left behind can hold the pipe for as long as it likes.
  child.on('exit', (status, signal) => {
    exited = { status, signal };
    if (interrupted) return die();
    if (!timedOut) timers.push(setTimeout(() => end(exited!), DRAIN_MS));
  });
  child.on('close', () => { if (exited && !timedOut && !interrupted) end(exited); });
});

export interface FalCommandRun {
  /** The environment's fal command. */
  fal: string;
  model: string;
  input: unknown;
  /** The folder this run's own folder is made in. */
  under: string;
  waitMs: number;
  /** Gets the command's own lines as it prints them, made safe to show. */
  log: (line: string) => void;
  /** The largest file taken as part of the answer, in bytes. */
  largest: number;
  run?: Runner;
}

export interface FalCommandAnswer {
  /** The folder made for this run, which holds the files. */
  dir: string;
  /** The plain files the command left there, by name. */
  files: string[];
  /** Entries there that are not taken: not a plain file, over `largest`, or under another kind of name. */
  passedOver: number;
  /** The request the command said it queued, where it said so. */
  requestId?: string;
}

/** The regular files in `dir` of a plain name and at most `largest` bytes, and how many other entries it holds. */
function plainFiles(dir: string, largest: number): { files: string[]; passedOver: number } {
  const names = readdirSync(dir).sort();
  const files = names.slice(0, ENTRIES_MOST).filter((name) => {
    if (!PLAIN_NAME.test(name)) return false;
    // lstat, so that a link, a pipe or a socket is seen for what it is and never opened.
    const entry = lstatSync(join(dir, name));
    return entry.isFile() && entry.size <= largest;
  });
  return { files: files.map((name) => join(dir, name)), passedOver: names.length - files.length };
}

/**
 * Runs `model` on `input` through the environment's fal command and gives the files it left in a folder made, empty,
 * for this run. A refusal, a failure and a command stopped after `waitMs` are a FalCommandFailed of one line, and
 * the folder is removed then.
 */
export async function runFalCommand(o: FalCommandRun): Promise<FalCommandAnswer> {
  mkdirSync(o.under, { recursive: true });
  const dir = mkdtempSync(join(o.under, 'run-'));
  const last: string[] = [];
  let [lines, requestId] = [0, undefined as string | undefined];
  const failed = (why: string): FalCommandFailed => {
    rmSync(dir, { recursive: true, force: true });
    return new FalCommandFailed(`${why}${last.length ? `: ${last.join(' ').slice(0, 2 * LINE_CHARS)}` : ''}`);
  };
  let r: Ran;
  try {
    r = await (o.run ?? runCommand)(o.fal, ['run', o.model, JSON.stringify(o.input), '--out', dir], {
      timeoutMs: o.waitMs,
      onLine: (raw) => {
        const line = shownLine(raw);
        if (!line) return;
        requestId ??= /^fal: queued \S+ as (\S+)$/.exec(line)?.[1];
        last.push(line);
        if (last.length > LINES_KEPT) last.shift();
        // A run held for approval says so in these lines and nowhere else, so they are shown as they come.
        if (lines++ < LINES_SHOWN) o.log(line);
        else if (lines === LINES_SHOWN + 1) o.log('more lines from the command are not shown as they come');
      },
    });
  } catch (e) {
    throw failed(`the environment's fal command could not be run (${errorText(e)})`);
  }
  if (r.timedOut) {
    throw failed(`the environment's fal command gave no answer in ${+(o.waitMs / 60_000).toFixed(1)} minutes and was stopped; ` +
      `${requestId ? `request ${requestId}` : 'any request it queued'} may still run and be billed, and nothing of this run is kept, so the next run asks again`);
  }
  if (r.error || r.status !== 0) {
    const how = r.error ? errorText(r.error) : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
    throw failed(`the environment's fal command did not run it (${how})`);
  }
  return { dir, ...plainFiles(dir, o.largest), requestId };
}
