// What a workspace has left to spend.
//
// This is account-level, not feature-level: the same report answers "can this workspace afford it?" for
// anything that bills, so it lives beside the workspace resolution rather than inside any one client.
//
// The workspace travels as a HEADER here rather than in the path, which is why VeedHttp.getJson takes
// headers at all — a route that scopes itself out-of-band is the exception the transport has to allow.
import { type VeedHttp, unwrap } from './api.ts';

// The four buckets that make up an allowance. Reachable with a plain user token; the workspace
// travels as a header rather than in the path.
const BUCKETS = ['ALLOWANCE', 'FEATURE_BALANCE', 'OPEN_BALANCE', 'REVENUECAT_BALANCE'] as const;

// A workspace holds TWO separate allowances, measured in different units, and a feature can draw on
// either: TEXT_TO_SPEECH is billed in SECONDS, AI_PLAYGROUND_CREDITS in credits. They are never summed —
// reporting one of them as "the balance" understates what a workspace can and cannot afford.
export interface Allowances {
  aiPlaygroundCredits: number;
  textToSpeechSeconds: number;
}

export async function getAllowances(http: VeedHttp, workspaceId: string): Promise<Allowances> {
  const report = await http.getJson<{ data?: Record<string, Record<string, { amount?: number }>> }>(
    '/usage-events/report',
    { workspaceId },
  );
  const data = unwrap<Record<string, Record<string, { amount?: number }>>>(report);
  const sum = (meter: string): number =>
    BUCKETS.reduce((total, bucket) => total + (data[bucket]?.[meter]?.amount ?? 0), 0);
  return { aiPlaygroundCredits: sum('AI_PLAYGROUND_CREDITS'), textToSpeechSeconds: sum('TEXT_TO_SPEECH') };
}
