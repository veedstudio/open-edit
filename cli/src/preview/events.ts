// Watch → debounce → re-derive → broadcast. Injectable watch so tests run offline
// (mirrors the DI style of veed/orchestrate.ts). Refreshes are SERIALIZED through a
// promise queue: overlapping reads could otherwise resolve out of order and broadcast
// stale state last. Self-write echoes need no special handling — the lastJson dedupe
// makes them client-invisible. RunStateError (mid-write JSON) keeps last good state.
import { watch as fsWatch } from 'node:fs';
import { join } from 'node:path';
import { RunStateError, type PreviewState } from './state.ts';

// Run-dir watching with a polling fallback: macOS recursive fs.watch rides FSEvents, which a
// sandbox's filesystem interception can block (failing at construction or via a later 'error').
// Polling every couple of seconds keeps the preview honest instead of dying with a cryptic
// watcher error; the hub's dedupe makes the extra refreshes free.
export function makeRunDirWatcher(
  dir: string,
  onEvent: (path: string) => void,
  opts: { watchImpl?: typeof fsWatch; pollMs?: number } = {},
): () => void {
  const watchImpl = opts.watchImpl ?? fsWatch;
  const pollMs = opts.pollMs ?? 2000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let watcher: ReturnType<typeof fsWatch> | null = null;
  const poll = (): void => {
    if (!timer) timer = setInterval(() => onEvent(dir), pollMs);
  };
  try {
    watcher = watchImpl(dir, { recursive: true }, (_event, filename) => {
      onEvent(join(dir, typeof filename === 'string' ? filename : ''));
    });
    watcher.on('error', () => {
      watcher?.close();
      watcher = null;
      poll();
    });
  } catch {
    poll();
  }
  return () => {
    watcher?.close();
    if (timer) clearInterval(timer);
  };
}

export interface HubDeps {
  readState: () => Promise<PreviewState>;
  watch: (onEvent: (path: string) => void) => () => void;
  debounceMs?: number;
}

export interface Hub {
  start(): Promise<void>;
  addClient(write: (sseData: string) => void): () => void;
  refresh(): Promise<void>;
  current(): PreviewState | null;
  stop(): void;
}

export function makeHub(deps: HubDeps): Hub {
  const debounceMs = deps.debounceMs ?? 150;
  const clients = new Set<(d: string) => void>();
  let last: PreviewState | null = null;
  let lastJson = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unwatch: (() => void) | null = null;
  let queue: Promise<void> = Promise.resolve();

  async function doRefresh(): Promise<void> {
    let next: PreviewState;
    try {
      next = await deps.readState();
    } catch (e) {
      if (e instanceof RunStateError) return; // mid-write — keep last good state
      throw e;
    }
    const json = JSON.stringify(next);
    if (json === lastJson) return;
    last = next;
    lastJson = json;
    const frame = `data: ${json}\n\n`;
    for (const write of clients) write(frame);
  }

  function refresh(): Promise<void> {
    queue = queue.then(doRefresh, doRefresh);
    return queue;
  }

  function onFsEvent(_path: string): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, debounceMs);
  }

  return {
    async start() {
      unwatch = deps.watch(onFsEvent);
      await refresh();
    },
    addClient(write) {
      clients.add(write);
      if (last) write(`data: ${lastJson}\n\n`);
      return () => clients.delete(write);
    },
    refresh,
    current: () => last,
    stop() {
      if (timer) clearTimeout(timer);
      unwatch?.();
      clients.clear();
    },
  };
}
