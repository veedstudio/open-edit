// How fast a voice actually speaks, in characters per second.
//
// This exists because the cost of a generation is per SECOND of finished video, while the only thing we
// hold before spending is a script. Converting one to the other needs a speaking rate, and a speaking
// rate is a property of the VOICE: measured voices run from 11.2 to 18.1 characters a second, a 62%
// spread, so no single constant is right for more than one of them.
//
// The API cannot tell us: listVoices carries a `wordsPerMinute` field, but it is unset (-1) for the
// great majority of voices, so nothing can be built on it. The rate is MEASURED instead — every paid run
// records the script length and the finished duration, and that is an observation about that voice.
//
// Two consequences shape the design. A rate we have not measured is genuinely unknown, so the estimate
// is a RANGE across the rates we do know rather than a point that pretends otherwise. And the single
// figure we put next to it leans SLOW — the lower tertile of known rates — because a slow voice makes a
// longer video and a bigger bill, so under-quoting is the direction that surprises someone after they
// have already approved.
import { join } from 'node:path';
import { REPO_ROOT } from '../config.ts';

export const DEFAULT_VOICE_RATES_PATH = join(REPO_ROOT, 'veed', '.veed-voice-rates.json');

export interface VoiceRate {
  charsPerSecond: number;
  // How many runs are behind the figure, so a single sample is never mistaken for a settled one.
  samples: number;
}

export type VoiceRates = Record<string, VoiceRate>;

// Measured, one paid run each unless noted. Kept in the source as the floor of what is known, so a fresh
// checkout with no learned file still estimates from evidence rather than from a guess.
export const SEEDED_RATES: VoiceRates = {
  '2mltbVQP21Fq8XgIfRQJ': { charsPerSecond: 18.1, samples: 4 },  // Axell
  OvO0rJbpandgx1bK263a: { charsPerSecond: 11.2, samples: 1 },    // Teddy — the slowest seen
  m2eiQmRlw2jKNs6qW86Z: { charsPerSecond: 15.8, samples: 1 },    // Drew C
  dAlhI9qAHVIjXuVppzhW: { charsPerSecond: 16.7, samples: 1 },    // Tamsin
};

// The lower tertile of everything known: a third of voices are slower than this, two thirds faster. Used
// when the voice at hand has never been measured. Deliberately not the mean — the mean splits the error
// evenly, and the two directions are not equally bad.
export function conservativeRate(rates: VoiceRates = SEEDED_RATES): number {
  const known = Object.values(rates).map((r) => r.charsPerSecond).sort((a, b) => a - b);
  if (known.length === 0) return 14;
  const at = (known.length - 1) / 3;
  const lo = known[Math.floor(at)];
  const hi = known[Math.ceil(at)];
  return Number((lo + (hi - lo) * (at - Math.floor(at))).toFixed(1));
}

// The envelope the estimate is honest about when the voice is unknown: slowest and fastest seen.
export function rateRange(rates: VoiceRates = SEEDED_RATES): { slow: number; fast: number } {
  const known = Object.values(rates).map((r) => r.charsPerSecond);
  if (known.length === 0) return { slow: 11, fast: 18 };
  return { slow: Math.min(...known), fast: Math.max(...known) };
}

export function rateFor(voiceId: string, rates: VoiceRates = SEEDED_RATES): VoiceRate | undefined {
  return rates[voiceId];
}

// The rate a quote should actually use: what was measured for this voice, or the conservative default
// when it has never been heard. `samples: null` marks the second case, so a caller can say "estimated"
// rather than presenting a stand-in as a measurement.
export function resolveRate(voiceId: string, rates: VoiceRates = SEEDED_RATES): { charsPerSecond: number; samples: number | null } {
  const known = rates[voiceId];
  return known ? { charsPerSecond: known.charsPerSecond, samples: known.samples } : { charsPerSecond: conservativeRate(rates), samples: null };
}

// A new observation folded into what a voice was already known to do. A running mean, weighted by how
// many runs are behind each figure, so one unusual script cannot swing a well-measured voice.
export function withObservation(rates: VoiceRates, voiceId: string, charsPerSecond: number): VoiceRates {
  if (!Number.isFinite(charsPerSecond) || charsPerSecond <= 0) return rates;
  const prior = rates[voiceId];
  if (!prior) return { ...rates, [voiceId]: { charsPerSecond: Number(charsPerSecond.toFixed(1)), samples: 1 } };
  const samples = prior.samples + 1;
  const mean = (prior.charsPerSecond * prior.samples + charsPerSecond) / samples;
  return { ...rates, [voiceId]: { charsPerSecond: Number(mean.toFixed(1)), samples } };
}

// A corrupt or truncated file reads as "nothing learned yet": re-measuring costs nothing, while acting
// on a half-parsed rate would quote a figure from noise.
export function parseVoiceRates(raw: string | null): VoiceRates {
  if (raw === null) return { ...SEEDED_RATES };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...SEEDED_RATES };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ...SEEDED_RATES };
  const learned: VoiceRates = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const r = value as Partial<VoiceRate>;
    if (typeof r?.charsPerSecond === 'number' && Number.isFinite(r.charsPerSecond) && r.charsPerSecond > 0) {
      learned[id] = { charsPerSecond: r.charsPerSecond, samples: typeof r.samples === 'number' && r.samples > 0 ? r.samples : 1 };
    }
  }
  // Seeds are the floor, learned values win: a voice measured here is better known than one measured once
  // on someone else's machine.
  return { ...SEEDED_RATES, ...learned };
}

export function serializeVoiceRates(rates: VoiceRates): string {
  return `${JSON.stringify(rates, null, 2)}\n`;
}
