// A fake VeedHttp that answers the REST routes Fabric generation drives, the way the live edge does.
// Shared by every test that needs a Fabric server without a network.
//
// It replaces the per-file `fakeFabric` that used to answer MCP tool NAMES. The difference matters: the
// code under test now issues real routes, so a fake that answered tool names would prove nothing about
// the wiring. `names()` still reports operation-level names so order assertions stay readable.
import type { VeedHttp } from '../src/veed/api.ts';
import {
  CHARS_PER_SECOND, CREDITS_PER_SECOND, curatedVoiceFor, estimateTotalCredits, TTS_CREDITS_PER_MINUTE,
} from '../src/veed/fabric.ts';

export type HttpCall = { method: 'GET' | 'POST' | 'PUT'; path: string; body?: unknown; headers?: Record<string, string> };

// Maps a route to the operation it implements, so a test can assert the sequence of OPERATIONS without
// caring that createVideo is six requests.
function operationOf(method: string, path: string): string | null {
  if (path === '/workspace') return 'list_workspaces';
  if (path.startsWith('/usage-events/report')) return 'get_credit_balance';
  if (path === '/subtitles/synthesize/listVoices') return 'list_voices';
  if (method === 'POST' && path === '/ai-playground') return 'create_fabric_video';
  if (method === 'GET' && path.startsWith('/ai-playground/')) return 'get_generation_status';
  return null; // the intermediate steps of createVideo: project, transload, tts, synthesize
}

export interface FakeOptions {
  // Status returned by successive generation polls; the last value is sticky.
  statuses?: string[];
  // Balance per call, in order, last value sticky. An EMPTY array makes every balance call fail, which is
  // how "the charge cannot be read back" is exercised. null means a fixed healthy balance.
  balances?: number[] | null;
  // Extra voice id to serve, on top of the defaults below. A voice has to exist in the listing or
  // confirmVideo refuses before spending, so a test using its own id declares it here.
  voiceId?: string;
  failSpeechWith?: string;
  // `code` must be one VEED really sends ('insufficient_credits', 'provider_error', 'content_policy',
  // 'invalid_input', 'invalid_output', 'timeout', 'transload_error', 'unknown'): a fixture that invents one
  // proves only that it agrees with the constant under test.
  generationError?: { message?: string; code?: string };
  // Runs INSIDE the call that completes the spend (POST /ai-playground), which is where the
  // concurrency tests need to interleave a second process.
  onCreate?: () => void;
  // Runs inside the confirm pass's only request, for the same reason.
  onConfirm?: () => void;
  // Replace what a listing or the create call answers with — the payloads a server that renamed,
  // dropped or re-typed a field would send.
  workspaces?: unknown;
  voices?: unknown;
  createResponse?: unknown;
}

export function fakeFabricHttp(opts: FakeOptions = {}) {
  const statuses = opts.statuses ?? ['pending', 'done'];
  const balances = opts.balances ?? null;
  // The ids the suites actually ask for. A real listing carries hundreds; two is enough to prove the
  // lookup happens, and means a test does not have to configure the fake just to name a voice.
  // The second is the voice a default generate run resolves to, so the spend path finds it in the listing.
  const voiceIds = ['voice-1', curatedVoiceFor('character-15')!, ...(opts.voiceId ? [opts.voiceId] : [])];
  const calls: HttpCall[] = [];
  let poll = 0;
  let balanceCall = 0;

  const balanceBody = (): unknown => {
    if (balances === null) return bucketed(8_032_608);
    if (balances.length === 0) throw new Error('GET /usage-events/report -> 403 forbidden');
    return bucketed(balances[Math.min(balanceCall++, balances.length - 1)]);
  };
  // The report splits the balance across four buckets and the client sums them; putting the whole figure
  // in one bucket exercises that sum rather than bypassing it.
  const bucketed = (total: number): unknown => ({
    ALLOWANCE: {
      AI_PLAYGROUND_CREDITS: { unit: 'COUNT', amount: total },
    },
    FEATURE_BALANCE: { AI_PLAYGROUND_CREDITS: { unit: 'COUNT', amount: 0 } },
    OPEN_BALANCE: { AI_PLAYGROUND_CREDITS: { unit: 'COUNT', amount: 0 } },
    REVENUECAT_BALANCE: { AI_PLAYGROUND_CREDITS: { unit: 'COUNT', amount: 0 } },
  });

  const client: VeedHttp = {
    async getJson<T>(path: string, headers?: Record<string, string>): Promise<T> {
      calls.push({ method: 'GET', path, headers });
      if (path === '/workspace') return (opts.workspaces ?? [{ id: 'ws1', name: 'Solo' }]) as T;
      if (/^\/workspace\/[^/]+\/space\/default$/.test(path)) return { id: 'space1' } as T;
      if (path === '/usage-events/report') return { data: balanceBody() } as T;
      if (path === '/subtitles/synthesize/listVoices') {
        opts.onConfirm?.();
        if (opts.voices !== undefined) return { data: opts.voices } as T;
        return { data: voiceIds.map((id) => ({ id, name: 'Maeve', locale: 'en-GB', gender: '0' })) } as T;
      }
      if (path.startsWith('/subtitles/synthesize/generate/')) {
        if (opts.failSpeechWith) return { id: 'sp1', status: 'error', errorReason: opts.failSpeechWith } as T;
        return { id: 'sp1', status: 'active', duration: 12.7 } as T;
      }
      if (path.startsWith('/ai-playground/')) {
        const status = statuses[Math.min(poll++, statuses.length - 1)];
        // A literal 'failed' carries a reason only when configured, so statuses:['failed'] alone still
        // exercises the reason-less case.
        if (status === 'error' || status === 'timedOut') {
          return { status, error: opts.generationError ?? { message: 'transient backend error', code: 'provider_error' } } as T;
        }
        if (status === 'failed' && opts.generationError) {
          return { status, error: opts.generationError } as T;
        }
        return { status, output: status === 'done' ? { assetId: 'out1' } : undefined } as T;
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async getJsonOrNull<T>(path: string): Promise<T | null> {
      calls.push({ method: 'GET', path });
      if (path.startsWith('/asset/')) {
        return { id: 'out1', uploadState: 'UPLOADED', sourceUrl: 'https://v3b.fal.media/out.mp4' } as T;
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async postJson<T>(path: string, body: unknown): Promise<T> {
      calls.push({ method: 'POST', path, body });
      if (path === '/project') return { id: 'proj1' } as T;
      if (path === '/asset/transload') return { asset: { id: 'img1' } } as T;
      if (path === '/asset') return { asset: { id: 'tts1' }, url: 'https://gcs/tts-session' } as T;
      if (path === '/subtitles/synthesize/generate') return { id: 'sp1' } as T;
      if (path === '/ai-playground') {
        opts.onCreate?.();
        return (opts.createResponse ?? { id: 'job-1' }) as T;
      }
      throw new Error(`unexpected POST ${path}`);
    },
    async putBytes(url: string): Promise<void> {
      calls.push({ method: 'PUT', path: url });
    },
  };

  return {
    client,
    calls,
    // Operation-level, de-duplicated for the repeated polls the old fake also collapsed.
    names: (): string[] =>
      calls.map((c) => operationOf(c.method, c.path)).filter((n): n is string => n !== null),
    bodyOf: (path: string): unknown => calls.find((c) => c.path === path)?.body,
    // Did the confirm pass run? Its fingerprint is the voice listing — the one request it makes that
    // nothing else does.
    confirmed: (): boolean => calls.some((c) => c.path === '/subtitles/synthesize/listVoices'),
    // Every workspace this run actually reached for: priced (the balance header) or billed (the bodies
    // that create the project and the generation).
    workspacesTouched: (): string[] => [
      ...new Set(
        calls.flatMap((c) => {
          if (c.path === '/usage-events/report') return c.headers?.workspaceId ? [c.headers.workspaceId] : [];
          const body = c.body as { workspaceId?: string } | undefined;
          return body?.workspaceId ? [body.workspaceId] : [];
        }),
      ),
    ],
  };
}

// The script whose TOTAL local estimate is `credits` AT A GIVEN SPEAKING RATE — the figure a user is
// quoted and approves, lipsync plus the folded-in speech credits. A test that needs a particular quote
// asks for it by length rather than hardcoding a script and hoping. The rate is a parameter because it
// belongs to the voice: a caller pricing against what the engine will really use passes resolveRate(voice).
//
// Speech adds a flat 2 credits for any read up to a minute (which every test quote is), so the LIPSYNC
// charge is sized to leave room for it. The result is verified against estimateTotalCredits, so a quote
// outside that sub-minute range throws HERE rather than skewing a downstream assertion.
export function scriptCosting(credits: number, charsPerSecond: number = CHARS_PER_SECOND): string {
  const lipsyncTarget = credits - TTS_CREDITS_PER_MINUTE;
  const script = 'x'.repeat(Math.ceil((lipsyncTarget / CREDITS_PER_SECOND) * charsPerSecond));
  const got = estimateTotalCredits(script, charsPerSecond);
  if (got !== credits) {
    throw new Error(`scriptCosting(${credits}) produced a script costing ${got}; only sub-minute quotes are supported`);
  }
  return script;
}
