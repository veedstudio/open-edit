// Tests veed/voice-rates.ts — how fast a voice speaks, which is what turns a script into a duration and
// therefore into a price. These exist because a single global rate under-quoted a real run by 26%: it had
// been measured on one voice and the three used were 11.2, 15.8 and 16.7 against an assumed 18.
//   Run:  node --import tsx tests/voice-rates.test.ts
import assert from 'node:assert/strict';
import {
  conservativeRate, parseVoiceRates, rateFor, rateRange, SEEDED_RATES, serializeVoiceRates,
  withObservation, type VoiceRates,
} from '../src/veed/voice-rates.ts';
import { estimateCredits, estimateRange } from '../src/veed/fabric.ts';
import { test } from 'node:test';

await test('the default rate is the lower TERTILE, so quotes lean slow and therefore high', () => {
  // Slower speech makes a longer video and a bigger bill, so the two directions of error are not equally
  // bad: quoting low surprises someone AFTER they approved. A third of known voices sit below this.
  const rates: VoiceRates = {
    a: { charsPerSecond: 10, samples: 1 },
    b: { charsPerSecond: 13, samples: 1 },
    c: { charsPerSecond: 16, samples: 1 },
    d: { charsPerSecond: 19, samples: 1 },
  };
  const tertile = conservativeRate(rates);
  const mean = 14.5;
  assert.ok(tertile < mean, `the tertile (${tertile}) must sit below the mean (${mean})`);
  assert.ok(tertile >= 10 && tertile <= 16);
});

await test('a slower rate produces a HIGHER credit figure — the direction that matters', () => {
  const script = 'x'.repeat(180);
  assert.ok(estimateCredits(script, 11) > estimateCredits(script, 18));
});

await test('the seeded rates are the ones actually measured, not a guess', () => {
  const { slow, fast } = rateRange();
  assert.equal(slow, 11.2, 'Teddy, the slowest observed');
  assert.equal(fast, 18.1, 'Axell, measured over four runs');
  assert.ok(Object.keys(SEEDED_RATES).length >= 4);
});

await test('an unmeasured voice gets a RANGE, because one number there would be a guess', () => {
  const script = 'x'.repeat(193);
  const { low, high } = estimateRange(script, rateRange());
  assert.ok(low < high);
  // The real run cost 53 credits; the range has to contain what actually happened.
  assert.ok(low <= 53 && 53 <= high, `53 should fall inside ${low}-${high}`);
});

await test('a measured voice is preferred over the conservative default', () => {
  assert.equal(rateFor('OvO0rJbpandgx1bK263a')?.charsPerSecond, 11.2);
  assert.equal(rateFor('never-used'), undefined);
});

// --- learning ---

await test('a first observation of a voice is taken whole', () => {
  const next = withObservation({}, 'v1', 12.5);
  assert.deepEqual(next.v1, { charsPerSecond: 12.5, samples: 1 });
});

await test('later observations are a running mean, weighted by how many runs are behind each', () => {
  // One odd script must not swing a voice measured many times.
  const settled: VoiceRates = { v1: { charsPerSecond: 18, samples: 9 } };
  const next = withObservation(settled, 'v1', 8);
  assert.equal(next.v1.samples, 10);
  assert.ok(next.v1.charsPerSecond > 16.9 && next.v1.charsPerSecond < 17.1, `got ${next.v1.charsPerSecond}`);
});

await test('a nonsense observation is ignored rather than poisoning the rate', () => {
  const before: VoiceRates = { v1: { charsPerSecond: 15, samples: 2 } };
  for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(withObservation(before, 'v1', bad), before, `${bad} must be refused`);
  }
});

// --- the stored file ---

await test('a learned rate wins over its seed, because it was measured here', () => {
  const rates = parseVoiceRates(serializeVoiceRates({ OvO0rJbpandgx1bK263a: { charsPerSecond: 13.4, samples: 3 } }));
  assert.equal(rates.OvO0rJbpandgx1bK263a.charsPerSecond, 13.4);
  assert.equal(rates['2mltbVQP21Fq8XgIfRQJ'].charsPerSecond, 18.1, 'and the untouched seeds survive');
});

await test('a missing or corrupt file reads as "nothing learned", never as no rates at all', () => {
  for (const raw of [null, '{', '[]', 'null', '"text"']) {
    assert.deepEqual(parseVoiceRates(raw), SEEDED_RATES, `${raw} should fall back to the seeds`);
  }
});

await test('a malformed entry is dropped, and the rest of the file still counts', () => {
  const rates = parseVoiceRates(JSON.stringify({ good: { charsPerSecond: 14, samples: 2 }, bad: { charsPerSecond: 'fast' } }));
  assert.equal(rates.good.charsPerSecond, 14);
  assert.equal(rates.bad, undefined);
});

