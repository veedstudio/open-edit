// Shared scaffolding for the generate*.test.ts suites. The three suites split by THEME — the spend gate,
// concurrency, and untrusted input — but they all drive run() the same way: a fake GenerateDeps standing
// in for the JSON files under runs/<key>/ and the network, plus seed helpers that write a well-formed
// approval or read a charge back. That plumbing lives here so it is written once, not three times.
import { sep } from 'node:path';
import {
  chargePathFor, pendingPathFor, scriptHash,
  type Args, type GenerateDeps, type PendingConfirmation,
} from '../src/commands/generate.ts';
import { estimateTotalCredits } from '../src/veed/fabric.ts';
import { DEFAULT_VOICE_RATES_PATH, parseVoiceRates, resolveRate } from '../src/veed/voice-rates.ts';
import type { ChargeRecord } from '../src/veed/charge-records.ts';
import type { VeedHttp } from '../src/veed/api.ts';
import { curatedVoiceFor } from '../src/veed/fabric.ts';

export const DEFAULT_CHARACTER = 'character-15';
// Derived, not restated, so it cannot drift from what a default run actually uses.
export const DEFAULT_VOICE = curatedVoiceFor(DEFAULT_CHARACTER)!;

// Pass 2 spends exactly what pass 1 recorded, so it carries no script.
export const spendArgs: Args = {
  key: 'test-run', character: DEFAULT_CHARACTER, voice: DEFAULT_VOICE, yes: true, resume: false,
};

// One call is one PROCESS: its sessionId, pid and liveness answer are its own, while `state` (the files
// under runs/<key>/) is shared with every other process in a test by passing the SAME map. Every side
// channel is captured (writes, downloads, token getters) so any suite can inspect what it needs; the
// identity fields default here and are overridden per suite, or per test, through `over`.
let sessionSeq = 0;
export function makeFakeDeps(
  client: VeedHttp,
  over: Partial<GenerateDeps> = {},
  state = new Map<string, string>(),
) {
  const writes: Array<{ path: string; bytes: number }> = [];
  const downloads: string[] = [];
  const slept: number[] = [];
  const getters: Array<() => Promise<string>> = [];
  let clock = 0;
  const n = (sessionSeq += 1);
  const deps: GenerateDeps = {
    resolveAccessToken: async () => 'tok-1',
    connect: async (getToken) => { getters.push(getToken); return client; },
    download: async (url) => { downloads.push(url); return new Uint8Array([1, 2, 3, 4]); },
    writeOutput: async (path, bytes) => { writes.push({ path, bytes: bytes.length }); },
    readState: async (path) => state.get(path) ?? null,
    writeState: async (path, text) => { state.set(path, text); },
    removeState: async (path) => { state.delete(path); },
    listState: async (dir) => [...state.keys()]
      .filter((p) => p.startsWith(`${dir}${sep}`) && !p.slice(dir.length + 1).includes(sep))
      .map((p) => p.slice(dir.length + 1)),
    sessionId: `sess-${n}`,
    pid: 1000 + n,
    host: 'test-host',
    isAlive: () => false,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    log: () => {},
    ...over,
  };
  return { deps, writes, downloads, slept, getters, state };
}

// A well-formed approval, as pass 1 would have written it; `over` bends one field at a time. Each suite
// sizes its costs against a different default script (one is length-calibrated, one is a fixed line), so
// the default is bound per suite rather than baked in here.
export function makeSeedPending(defaultScript: string) {
  return function seedPending(
    state: Map<string, string>, key: string, over: Partial<PendingConfirmation> = {},
  ): void {
    const script = over.script ?? defaultScript;
    const record: PendingConfirmation = {
      script,
      scriptSha256: scriptHash(script),
      characterId: DEFAULT_CHARACTER,
      voiceId: DEFAULT_VOICE,
      workspaceId: 'ws1',
      // As pass 1 writes it when --workspace was given: the workspace was named, so the spend has nothing
      // left to confirm about it.
      workspaceNamed: true,
      // The total the spend pass will re-derive from this exact script and voice, priced at the SAME rate
      // it will read back from state — so an unmodified seed never trips the "quote exceeds approval" cap,
      // even after an earlier run folded a fresh observation into that voice's rate.
      estimatedCredits: estimateTotalCredits(
        script,
        resolveRate(DEFAULT_VOICE, parseVoiceRates(state.get(DEFAULT_VOICE_RATES_PATH) ?? null)).charsPerSecond,
      ),
      approvedAt: 0,
      ...over,
    };
    state.set(pendingPathFor(key), JSON.stringify(record, null, 2));
  };
}

export function readCharge(state: Map<string, string>, key: string, sessionId: string): ChargeRecord | null {
  const raw = state.get(chargePathFor(key, sessionId));
  return raw ? (JSON.parse(raw) as ChargeRecord) : null;
}
