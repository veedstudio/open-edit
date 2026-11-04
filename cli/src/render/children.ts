// The processes a render starts itself (encoders, compositing, Chrome's sandbox probe), so a signal can stop
// exactly these and nothing else on the machine. Chrome under the driver is the driver's to kill on exit.
import { spawn, type ChildProcess } from 'node:child_process';

const live = new Set<ChildProcess>();

/** Keeps `child` on the list until it exits. */
export function track<T extends ChildProcess>(child: T): T {
  live.add(child);
  child.on('close', () => live.delete(child));
  child.on('error', () => live.delete(child));
  return child;
}

export function killChildren(): void {
  for (const child of live) child.kill('SIGKILL');
}

/**
 * Runs `bin` with `input` on its stdin and returns its stdout. Asynchronous, unlike execFileSync, so a signal
 * is answered while it runs, and, given `timeoutMs`, killed after it, so a process that stops answering cannot hold
 * the render: the error says `what` did not finish.
 */
export function runBuffered(bin: string, args: string[], o: { input?: Buffer; timeoutMs?: number; what: string }): Promise<Buffer> {
  return new Promise<Buffer>((ok, fail) => {
    const child = track(spawn(bin, args, { stdio: [o.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] }));
    const out: Buffer[] = [];
    let err = '';
    let late = false;
    const limit = o.timeoutMs;
    const timer = limit === undefined ? undefined : setTimeout(() => {
      late = true;
      child.kill('SIGKILL');
    }, limit);
    child.stdout!.on('data', (d: Buffer) => out.push(d));
    child.stderr!.on('data', (d: Buffer) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      fail(new Error(`${o.what}: could not start ${bin}: ${e.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (late) fail(new Error(`${o.what} did not finish within ${Math.round(limit! / 1000)} s`));
      else if (code === 0) ok(Buffer.concat(out));
      else fail(new Error(`${o.what}: ${err.trim().split('\n').slice(-4).join(' | ') || (signal ?? `exit ${code}`)}`));
    });
    if (o.input) {
      // A process that exits before reading all of its input is reported by its exit, which carries the reason.
      child.stdin!.on('error', () => {});
      child.stdin!.end(o.input);
    }
  });
}
