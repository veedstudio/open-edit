// Which engine release is the latest one.
//
// The obvious route, the REST API, allows 60 unauthenticated calls an hour PER SOURCE IP — a hosted
// CI runner shares its egress with everyone else on that pool and arrives with the budget already
// spent by strangers, so a single API call is not a dependable answer. github.com's own
// `/releases/latest` redirect carries the same tag off the metered API, so it is asked first and the
// API is the fallback. Both routes report why they failed: "offline" was the wrong diagnosis when the
// real answer was a 403 from someone else's traffic.
const RELEASES_REPO = 'veedstudio/weave-renderer-public-releases'; // upstream repo name — not renamed

export const ENGINE_RELEASES_REPO = RELEASES_REPO;

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<any>;

export interface LatestEngineTag {
  /** The upstream tag (`weave-v<semver>`), or '' when no route answered. */
  tag: string;
  /** One line per route that did NOT answer, in order — reported even when a later route did. */
  failures: string[];
}

// A route's own account of itself: the status, plus the rate-limit headers when they are what
// happened. Read from the headers, never guessed from the body.
const describe = (url: string, res: any): string => {
  const remaining = res?.headers?.get?.('x-ratelimit-remaining');
  const limit = res?.headers?.get?.('x-ratelimit-limit');
  const exhausted = remaining === '0' ? ` (rate limit exhausted for this IP: ${limit ?? '?'}/hour unauthenticated)` : '';
  return `${url} → HTTP ${res?.status ?? '?'}${exhausted}`;
};

const tagFromLocation = (location: string): string => {
  const match = /\/releases\/tag\/([^/?#]+)/.exec(location);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1]!;
  }
};

// `budgetMs` is spent across ALL routes, not granted to each: a network that blackholes packets would
// otherwise stall a caller for as many timeouts as there are routes.
export async function resolveLatestEngineTag(fetchImpl: FetchLike = fetch, budgetMs = 30_000): Promise<LatestEngineTag> {
  const failures: string[] = [];
  const deadline = Date.now() + budgetMs;
  const signal = () => AbortSignal.timeout(Math.max(1, deadline - Date.now()));

  const redirectUrl = `https://github.com/${RELEASES_REPO}/releases/latest`;
  try {
    // 'manual' keeps the 302 itself: Node hands back the Location header rather than fetching the
    // release page's HTML, which is the only part of the response worth anything here.
    const res = await fetchImpl(redirectUrl, { redirect: 'manual', signal: signal() });
    const tag = tagFromLocation(res?.headers?.get?.('location') ?? '');
    if (tag) return { tag, failures };
    failures.push(describe(redirectUrl, res));
  } catch (error) {
    failures.push(`${redirectUrl} → ${(error as Error).message}`);
  }

  const apiUrl = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
  try {
    const res = await fetchImpl(apiUrl, { signal: signal() });
    if (res?.ok) {
      const tag = ((await res.json()) as { tag_name?: string }).tag_name ?? '';
      // The failures ride along: a route that is permanently blocked is worth saying out loud even
      // when the fallback saved the run, because every one of those runs is spending metered budget.
      if (tag) return { tag, failures };
    }
    failures.push(describe(apiUrl, res));
  } catch (error) {
    failures.push(`${apiUrl} → ${(error as Error).message}`);
  }

  return { tag: '', failures };
}
