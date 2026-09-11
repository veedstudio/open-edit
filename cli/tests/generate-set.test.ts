// Tests the set layer: ONE approval covering several shots, expanded into the per-shot approvals the
// single-shot engine already knows how to spend. The point of these is that combining the approval must
// not weaken any of the per-shot protections — so they check what the set REFUSES at least as hard as
// what it allows.
//   Run:  node --import tsx tests/generate-set.test.ts
import assert from 'node:assert/strict';
import {
  assertCovers, estimateSet, hashSet, parseShots, pendingForShot, setPathFor, shotKey, type SetApproval,
} from '../src/commands/generate-set.ts';
import { estimateTotalCredits } from '../src/veed/fabric.ts';
import { resolveRate } from '../src/veed/voice-rates.ts';
import { scriptHash } from '../src/commands/generate.ts';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Moved from the repository's cli-entry suite with the entry point itself: the argv seams
// stay strict through the CLI dispatch, not just when the parser is called directly.
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
function runCli(args: string[]): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', cliPath, 'generate-set', ...args], { encoding: 'utf8' },
      (error, _out, stderr) => resolve({ code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0, err: stderr }));
  });
}

test('--shots with no path is refused, not read as a missing file later', async () => {
  const { code, err } = await runCli(['--key', 'test', '--shots']);
  assert.equal(code, 1);
  assert.match(err, /--shots requires a value/);
});

test('the OTHER flags reach the strict single-shot parser', async () => {
  const { code, err } = await runCli(['--key', 'test', '--shots', 'x.json', '--voise', 'v1']);
  assert.equal(code, 1);
  assert.match(err, /Unknown option '--voise'/);
});

const SHOTS = [
  { id: 'one', script: 'For oft, when on my couch I lie In vacant or in pensive mood,', image: '/tmp/1.jpg', voice: 'v1' },
  { id: 'two', script: 'They flash upon that inward eye Which is the bliss of solitude;', image: '/tmp/2.jpg', voice: 'v1' },
];

// Every shot here uses voice 'v1', which has never been measured, so all of them price at the
// conservative default. Derived rather than hardcoded: the figure moves the day that voice is measured.
const RATE = resolveRate('v1').charsPerSecond;

const approvalFor = (shots = SHOTS, at = 1_000_000): SetApproval => ({
  shots,
  setSha256: hashSet(shots),
  workspaceId: 'ws1',
  workspaceNamed: true,
  estimatedCredits: estimateSet(shots).credits,
  approvedAt: at,
});

await test('the set total is the sum of its shots, priced the same way one shot is', () => {
  const { credits } = estimateSet(SHOTS);
  assert.equal(credits, estimateTotalCredits(SHOTS[0].script, RATE) + estimateTotalCredits(SHOTS[1].script, RATE));
  assert.ok(credits > 0);
});

await test('an unmeasured voice makes the total a RANGE, and the point figure sits inside it', () => {
  const { credits, low, high, allMeasured } = estimateSet(SHOTS);
  assert.equal(allMeasured, false, "'v1' has never been heard, and the approval has to say so");
  assert.ok(low <= credits && credits <= high, `${credits} should sit inside ${low}-${high}`);
  assert.ok(low < high);
});

await test('a MEASURED voice quotes one figure, with no range to hedge it', () => {
  // Axell, four runs behind it. Nothing here should read as "expect somewhere between".
  const measured = SHOTS.map((s) => ({ ...s, voice: '2mltbVQP21Fq8XgIfRQJ' }));
  assert.equal(estimateSet(measured).allMeasured, true);
});

await test('shots are priced at their OWN voices, not one rate averaged across the set', () => {
  // Teddy is the slowest voice measured and Axell the fastest, so the same words cost more in the first.
  const priceIn = (voice: string) => estimateSet([{ id: 'a', script: SHOTS[0].script, voice }]);
  const slow = priceIn('OvO0rJbpandgx1bK263a');
  const fast = priceIn('2mltbVQP21Fq8XgIfRQJ');
  assert.ok(slow.credits > fast.credits, `${slow.credits} (slow voice) should exceed ${fast.credits} (fast)`);
});

await test('a shot runs under a DERIVED key, so its id cannot escape the run directory', () => {
  assert.equal(shotKey('poem', 'one'), 'poem-one');
  assert.match(setPathFor('poem'), /runs[\\/]poem[\\/]\.fabric-pending-set\.json$/);
  assert.throws(() => parseShots(JSON.stringify([{ id: '../escape', script: 'hi' }])), /letters, digits/);
});

await test('duplicate ids are refused — two shots cannot share a run directory', () => {
  assert.throws(() => parseShots(JSON.stringify([{ id: 'a', script: 'x' }, { id: 'a', script: 'y' }])), /duplicate id/);
});

await test('ids default to position, and a shot may not be both a preset and an image', () => {
  assert.deepEqual(parseShots(JSON.stringify([{ script: 'x' }, { script: 'y' }])).map((s) => s.id), ['1', '2']);
  assert.throws(
    () => parseShots(JSON.stringify([{ script: 'x', character: 'character-1', image: '/tmp/a.jpg' }])),
    /not both/,
  );
});

await test('an empty script is refused before anything is priced', () => {
  assert.throws(() => parseShots(JSON.stringify([{ script: '   ' }])), /--script must not be empty/);
});

await test('a malformed shots file is named as such, not left to fail later', () => {
  assert.throws(() => parseShots('{'), /not valid JSON/);
  assert.throws(() => parseShots('[]'), /non-empty array/);
});

// --- the approval covers exactly what was seen, and nothing else ---

await test('the approval covers the set it was taken for', () => {
  assert.doesNotThrow(() => assertCovers(approvalFor(), SHOTS, 1_000_000, 3_600_000));
});

await test('editing ONE script invalidates the whole set approval', () => {
  const edited = [SHOTS[0], { ...SHOTS[1], script: `${SHOTS[1].script} and more` }];
  assert.throws(() => assertCovers(approvalFor(), edited, 1_000_000, 3_600_000), /no longer match the set/);
});

await test('REORDERING the shots invalidates it — two shots swapped is a different video', () => {
  assert.throws(() => assertCovers(approvalFor(), [SHOTS[1], SHOTS[0]], 1_000_000, 3_600_000), /no longer match/);
});

await test('swapping one image invalidates it, even with every script unchanged', () => {
  const swapped = [SHOTS[0], { ...SHOTS[1], image: '/tmp/other.jpg' }];
  assert.throws(() => assertCovers(approvalFor(), swapped, 1_000_000, 3_600_000), /no longer match/);
});

await test('changing a voice invalidates it — the same words in another voice is another video', () => {
  const revoiced = [SHOTS[0], { ...SHOTS[1], voice: 'v2' }];
  assert.throws(() => assertCovers(approvalFor(), revoiced, 1_000_000, 3_600_000), /no longer match/);
});

await test('a stale approval is refused, and says how stale', () => {
  assert.throws(
    () => assertCovers(approvalFor(SHOTS, 0), SHOTS, 2 * 3_600_000, 3_600_000),
    /approval is 120 minutes old/,
  );
});

await test('an approval timestamped in the future is refused rather than trusted', () => {
  assert.throws(() => assertCovers(approvalFor(SHOTS, 9_000_000), SHOTS, 1_000_000, 3_600_000), /refusing to spend/);
});

await test('an approvedAt of 1e999 reads back as Infinity and is refused, not treated as fresh', () => {
  const approval = { ...approvalFor(), approvedAt: JSON.parse('1e999') as number };
  assert.throws(() => assertCovers(approval, SHOTS, 1_000_000, 3_600_000), /refusing to spend/);
});

await test('a corrupt approval with no timestamp is refused clearly, never as "NaN minutes old"', () => {
  // A hand-edited or truncated .fabric-pending-set.json can drop approvedAt; age arithmetic then yields
  // NaN, and the refusal must name the corruption rather than print "the approval is NaN minutes old".
  const approval = { ...approvalFor(), approvedAt: Number.NaN };
  assert.throws(() => assertCovers(approval, SHOTS, 1_000_000, 3_600_000), (e: unknown) => {
    const message = (e as Error).message;
    assert.match(message, /no valid timestamp/);
    assert.doesNotMatch(message, /NaN/);
    return true;
  });
});

// --- the expansion is the answer already given, not a new question ---

await test('each per-shot approval carries THAT shot, hashed, at the set price', () => {
  const approval = approvalFor();
  const pending = pendingForShot(approval, SHOTS[1], { character: 'character-15', voice: 'fallback' });
  assert.equal(pending.script, SHOTS[1].script);
  assert.equal(pending.scriptSha256, scriptHash(SHOTS[1].script), 'the single-shot engine re-checks this');
  assert.equal(pending.image, '/tmp/2.jpg');
  assert.equal(pending.voiceId, 'v1', 'the shot voice wins over the default');
  assert.equal(pending.estimatedCredits, estimateTotalCredits(SHOTS[1].script, RATE), 'its own share, not the total');
  assert.equal(pending.workspaceId, 'ws1');
  assert.equal(pending.approvedAt, approval.approvedAt, 'the set clock, so one yes ages as one thing');
});

await test('a shot without its own presenter falls back to the run defaults', () => {
  const pending = pendingForShot(approvalFor(), { id: 'x', script: 'hello there' }, { character: 'character-15', voice: 'fallback' });
  assert.equal(pending.characterId, 'character-15');
  assert.equal(pending.voiceId, 'fallback');
  assert.equal(pending.image, undefined);
});

