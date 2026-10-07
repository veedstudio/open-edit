// Says when a newer CLI is published and never installs it: an update is new code, so it runs only after
// the user says yes, and `init --update <version>` installs exactly the version they agreed to.
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { PACKAGE_NAME } from './config.ts';
import { isRelease, stateDirFor, versionAtLeast } from './platform.ts';
import { writeAtomic } from './providers/exclusive-files.ts';

const REGISTRY_DEFAULT = 'https://registry.npmjs.org';
const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 3_000;

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<any> }>;

async function latestVersion(env: Env, fetchImpl: Fetch, timeoutMs: number): Promise<string | null> {
  const registry = (env.OPENEDIT_REGISTRY || REGISTRY_DEFAULT).replace(/\/+$/, '');
  try {
    // The `latest` manifest, not the packument, which grows with every release.
    const res = await fetchImpl(`${registry}/${PACKAGE_NAME}/latest`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const version = (await res.json())?.version;
    return typeof version === 'string' && isRelease(version) ? version : null;
  } catch {
    return null;
  }
}

export const noticeText = (current: string, latest: string): string =>
  `openedit: update available — ${PACKAGE_NAME} ${current} → ${latest}. Nothing updates on its own; to install this version: npx ${PACKAGE_NAME} init --update ${latest}`;

interface Cache { checkedAt: number; latest: string | null }

// The cache is shared by every CLI version on the machine and printed to an agent, so anything off-shape
// counts as no cache at all.
const readCache = (file: string): Cache | null => {
  try {
    const cache = JSON.parse(readFileSync(file, 'utf8'));
    const latestOk = cache?.latest === null || (typeof cache?.latest === 'string' && isRelease(cache.latest));
    return Number.isFinite(cache?.checkedAt) && latestOk ? cache : null;
  } catch {
    return null;
  }
};

export interface NoticeDeps {
  version: string;
  env: Env;
  platform: string;
  now: () => number;
  fetch: Fetch;
  err: (line: string) => void;
  lookupTimeoutMs?: number;
}

const noLookup = async (): Promise<void> => {};

/**
 * Prints the notice the last lookup left, before the command's own output, and returns the lookup to run
 * once the command is done: started earlier, a command that blocks the event loop would time it out.
 * Neither part throws or rejects, since nothing here may fail a command.
 */
export function updateNotice(deps: NoticeDeps): () => Promise<void> {
  try {
    const { version, env } = deps;
    // NO_UPDATE_NOTIFIER is the opt-out other npm CLIs already honour.
    if (!isRelease(version) || env.CI || env.NO_UPDATE_NOTIFIER) return noLookup;
    const dir = stateDirFor(deps.platform, env);
    // With no home directory the path is relative, and the cache would land wherever the command ran.
    if (!isAbsolute(dir)) return noLookup;
    const file = join(dir, 'update-check.json');
    const cache = readCache(file);
    if (cache?.latest && !versionAtLeast(version, cache.latest)) deps.err(noticeText(version, cache.latest));
    const age = deps.now() - (cache?.checkedAt ?? Number.NEGATIVE_INFINITY);
    // A timestamp from the future (clock skew, a restored machine) is stale, or lookups stop until the
    // clock catches up.
    if (age >= 0 && age < DAY_MS) return noLookup;
    return async () => {
      try {
        // A failed lookup waits a day too, so an offline machine does not pay the timeout on every command.
        const latest = await latestVersion(env, deps.fetch, deps.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS);
        writeAtomic(file, { checkedAt: deps.now(), latest: latest ?? cache?.latest ?? null });
      } catch { /* an unwritable app-data dir only means the next run looks again */ }
    };
  } catch {
    return noLookup;
  }
}
