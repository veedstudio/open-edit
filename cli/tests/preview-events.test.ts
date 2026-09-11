import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { watch as fsWatch } from 'node:fs';
import { makeHub, makeRunDirWatcher } from '../src/preview/events.ts';
import { RunStateError, type PreviewState } from '../src/preview/state.ts';

function state(stage: PreviewState['stage']): PreviewState {
  return {
    key: 'demo', stage, chunks: [], video: null,
    styleRef: null, stageStartedAtMs: null, renderMtimeMs: null,
  };
}

interface Harness {
  hub: ReturnType<typeof makeHub>;
  fire: (path: string) => void;
  frames: string[];
  setState: (s: PreviewState | Error) => void;
  gate: { hold: boolean; release: () => void };
  overlaps: { max: number };
}

function makeHarness(): Harness {
  let onEvent: (path: string) => void = () => {};
  let next: PreviewState | Error = state('waiting');
  const frames: string[] = [];
  const pending: Array<() => void> = [];
  const gate = { hold: false, release: () => { while (pending.length) pending.shift()?.(); } };
  const overlaps = { max: 0 };
  let inFlight = 0;
  const hub = makeHub({
    readState: async () => {
      inFlight += 1;
      overlaps.max = Math.max(overlaps.max, inFlight);
      if (gate.hold) await new Promise<void>((r) => { pending.push(r); });
      inFlight -= 1;
      if (next instanceof Error) throw next;
      return next;
    },
    watch: (cb) => {
      onEvent = cb;
      return () => {};
    },
    debounceMs: 0,
  });
  hub.addClient((d) => frames.push(d));
  return { hub, fire: (p) => onEvent(p), frames, setState: (s) => { next = s; }, gate, overlaps };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

test('start() broadcasts the initial state to clients', async () => {
  const h = makeHarness();
  await h.hub.start();
  assert.equal(h.frames.length, 1);
  assert.match(h.frames[0], /^data: \{/);
  assert.match(h.frames[0], /"stage":"waiting"/);
  assert.match(h.frames[0], /\n\n$/);
});

test('a watch event re-derives and broadcasts when state changed', async () => {
  const h = makeHarness();
  await h.hub.start();
  h.setState(state('cooking'));
  h.fire('/run/meta.json');
  await tick();
  assert.equal(h.frames.length, 2);
  assert.match(h.frames[1], /"stage":"cooking"/);
});

test('unchanged state is not re-broadcast', async () => {
  const h = makeHarness();
  await h.hub.start();
  h.fire('/run/whatever');
  await tick();
  assert.equal(h.frames.length, 1);
});

test('overlapping refreshes serialize: reads never overlap and the newest state wins', async () => {
  const h = makeHarness();
  await h.hub.start();
  // stale read starts first (gated open), fresh edit-refresh races it
  h.gate.hold = true;
  const r1 = h.hub.refresh(); // would read OLD state
  h.setState(state('cooking'));
  const r2 = h.hub.refresh(); // reads NEW state
  h.gate.hold = false;
  h.gate.release();
  await r1;
  await r2;
  await tick();
  assert.equal(h.overlaps.max, 1, 'readState calls must never run concurrently');
  assert.equal(h.hub.current()?.stage, 'cooking', 'the newest state must win');
  assert.match(h.frames[h.frames.length - 1], /"stage":"cooking"/);
});

test('RunStateError keeps last good state', async () => {
  const h = makeHarness();
  await h.hub.start();
  h.setState(new RunStateError('mid-write'));
  h.fire('/run/transcript.json');
  await tick();
  assert.equal(h.frames.length, 1);
  assert.equal(h.hub.current()?.stage, 'waiting');
});

test('late-joining client immediately gets the current state', async () => {
  const h = makeHarness();
  await h.hub.start();
  const late: string[] = [];
  h.hub.addClient((d) => late.push(d));
  assert.equal(late.length, 1);
});

test('removed clients stop receiving', async () => {
  const h = makeHarness();
  await h.hub.start();
  const late: string[] = [];
  const off = h.hub.addClient((d) => late.push(d));
  off();
  h.setState(state('cooking'));
  h.fire('/x');
  await tick();
  assert.equal(late.length, 1); // only the join frame
});

test('watcher falls back to polling when fs.watch is unavailable (sandboxed FSEvents)', async () => {
  const events: string[] = [];
  const failingWatch: typeof fsWatch = () => { throw new Error('EPERM: operation not permitted'); };
  const stop = makeRunDirWatcher('/tmp/nowhere', (p) => events.push(p), {
    watchImpl: failingWatch,
    pollMs: 20,
  });
  await new Promise((r) => setTimeout(r, 70));
  stop();
  assert.ok(events.length >= 2, `poller must keep delivering events (got ${events.length})`);
  assert.equal(events[0], '/tmp/nowhere');
});
