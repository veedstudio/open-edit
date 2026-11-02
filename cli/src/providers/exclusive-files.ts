// The file primitives shared state is built from when several processes write it at once, such as the job
// ledger (queue-ledger.ts), the asset manifest's records (assets.ts) and faces' boxes. Each state file is either
// owned by one writer, created exclusively, or replaced whole, so no reader ever sees half of one.
import { closeSync, linkSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

export const tmpName = (path: string) => `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;

export const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A reader sees the old bytes or the new ones, never a torn write. */
export function writeAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, JSON.stringify(value, null, 2) + '\n');
}

/** writeAtomic for text that is not JSON. */
export function writeTextAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tmpName(path);
  try {
    writeFileSync(tmp, text);
    renameInto(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never written, or already renamed */ }
    throw e;
  }
}

function renameInto(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      // Windows refuses to replace a file another process has open or is replacing at that instant; a moment later it is free.
      const busy = process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '');
      if (!busy || attempt === 40) throw e;
      sleepSync(25);
    }
  }
}

/**
 * Creates `path` only if nothing is there, complete from the first instant: written aside and linked
 * into place, because link refuses an existing name. A filesystem without hard links falls back to an
 * exclusive open, whose brief empty window readers treat as a live claim.
 */
export function createExclusive(path: string, value: unknown): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify(value, null, 2) + '\n';
  const tmp = tmpName(path);
  writeFileSync(tmp, text);
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    let fd: number;
    try {
      fd = openSync(path, 'wx');
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e2;
    }
    try { writeSync(fd, text); } finally { closeSync(fd); }
    return true;
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
