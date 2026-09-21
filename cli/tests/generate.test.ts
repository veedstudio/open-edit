// Tests for veed/generate.ts: argument parsing AND the credit-spend gate in run(), driven with a fake
// MCP client so nothing touches the network or spends anything.
//   Run:  node --import tsx tests/generate.test.ts
import assert from 'node:assert/strict';
import { FABRIC_CHARACTERS } from '../src/veed/fabric-characters.ts';
import { join } from 'node:path';
import { test } from 'node:test';
import { runsDir, workspacePath } from '../src/config.ts';
import {
  chargePathFor, parseArgs, pendingPathFor, realDeps, run, scriptHash,
  type Args, type PendingConfirmation, type SpendRecord,
} from '../src/commands/generate.ts';
import type { ChargeRecord } from '../src/veed/charge-records.ts';
import { estimateTotalCredits, PORTRAIT_CHARACTER_IDS } from '../src/veed/fabric.ts';
import { runKeyOf } from '../src/resolve-video.ts';
import type { VeedHttp } from '../src/veed/api.ts';
import { fakeFabricHttp, scriptCosting } from './fabric-fake.ts';
import {
  DEFAULT_CHARACTER, DEFAULT_VOICE, makeFakeDeps as fakeDeps, makeSeedPending, readCharge, spendArgs,
} from './generate-fake.ts';
import { DEFAULT_VOICE_RATES_PATH, parseVoiceRates, resolveRate } from '../src/veed/voice-rates.ts';

// Spelled out rather than imported, so these tests also pin WHERE the two new files live: the workspace
// choice sits beside the login it belongs to (and beside its .gitignore entry), the spend record inside the
// run it paid for.
const WORKSPACE_CHOICE_PATH = workspacePath();
// Spelled out rather than imported, so these tests pin the on-disk LAYOUT too: one spend record per
// ATTEMPT, named for the session that wrote it, exactly like the charge record beside it.
const spendPath = (key: string, sessionId: string): string =>
  join(runsDir(), key, `.fabric-spend-${sessionId}.json`);

function spendRecords(state: Map<string, string>, key: string): SpendRecord[] {
  const prefix = join(runsDir(), key, '.fabric-spend-');
  return [...state.entries()]
    .filter(([p]) => p.startsWith(prefix))
    .map(([, raw]) => JSON.parse(raw) as SpendRecord);
}

// The audit trail of a key that was attempted exactly once.
function onlySpend(state: Map<string, string>, key = 'test-run'): SpendRecord {
  const records = spendRecords(state, key);
  assert.equal(
    records.length, 1,
    `expected exactly one spend record under runs/${key}/; state was ${JSON.stringify([...state.keys()])}`,
  );
  return records[0];
}

function spendAt(state: Map<string, string>, key: string, sessionId: string): SpendRecord {
  const raw = state.get(spendPath(key, sessionId));
  assert.ok(raw, `no spend record for session ${sessionId} under runs/${key}/`);
  return JSON.parse(raw) as SpendRecord;
}

await test('a character with no --voice speaks with the voice curated for that face', () => {
  // A flat default voice put a male face in a female voice on the one path that spends credits.
  for (const c of FABRIC_CHARACTERS) {
    const args = parseArgs(['--script', 'Hello world', '--character', c.id, '--workspace', 'ws-1']);
    assert.equal(args.voice, c.voiceId, `${c.id} (${c.gender})`);
  }
});

await test('an explicit --voice still wins over the face it is paired with', () => {
  const args = parseArgs(['--script', 'Hi', '--character', 'character-3', '--voice', 'voice-1', '--workspace', 'ws-1']);
  assert.equal(args.voice, 'voice-1');
});

await test('a normal invocation parses all arguments and yields yes === false', () => {
  const args = parseArgs(['--script', 'Hello world', '--key', 'test-run', '--character', 'char-1', '--voice', 'voice-1', '--workspace', 'ws-1']);
  assert.deepEqual(args, {
    script: 'Hello world',
    key: 'test-run',
    character: 'char-1',
    voice: 'voice-1',
    workspace: 'ws-1',
    yes: false,
    resume: false,
    ignoreBalance: false,
  });
});

await test('a standalone --yes (pass 2, no --script) yields yes === true', () => {
  const args = parseArgs(['--key', 'promo', '--yes']);
  assert.deepEqual(args, {
    key: 'promo',
    character: DEFAULT_CHARACTER,
    voice: DEFAULT_VOICE,
    yes: true,
    resume: false,
    ignoreBalance: false,
  });
});

await test('--script together with --yes is refused: pass 2 must not re-type the approved script', () => {
  // The whole point of the pending-confirmation file is that the script is typed ONCE. Accepting it again
  // alongside --yes is what let a drifted script (or a re-priced one) be billed unseen.
  assert.throws(
    () => parseArgs(['--script', 'Hello world', '--key', 'promo', '--yes']),
    /--script cannot be combined with --yes/,
  );
});

await test('--yes alone with no --script parses (it spends the approval on disk)', () => {
  const args = parseArgs(['--key', 'promo', '--yes']);
  assert.equal(args.script, undefined);
  assert.equal(args.yes, true);
});

await test('--script "--yes" never becomes a spend — now by refusing it outright', () => {
  // `--script "$MSG"` with $MSG unset produces `--script --yes`. The old parser read it as a script whose
  // text was "--yes"; node:util refuses the ambiguity instead, which is stronger — neither reading can
  // happen by accident, and the `=` form is there for anyone who meant it literally.
  assert.throws(() => parseArgs(['--script', '--yes']), /argument is ambiguous/);
  const args = parseArgs(['--script=--yes']);
  assert.equal(args.script, '--yes');
  assert.equal(args.yes, false);
});

await test('defaults apply when optional flags are omitted', () => {
  const args = parseArgs(['--script', 'test']);
  assert.equal(args.script, 'test');
  assert.equal(args.key, 'generated');
  assert.equal(args.character, DEFAULT_CHARACTER);
  assert.equal(args.voice, DEFAULT_VOICE);
  assert.equal(args.workspace, undefined);
  assert.equal(args.yes, false);
  assert.equal(args.resume, false);
});

await test('a flag whose value is missing (flag is the final token) throws a clear error', () => {
  assert.throws(
    () => parseArgs(['--script', 'test', '--key']),
    /Option '--key <value>' argument missing/,
  );
});

await test('a flag immediately followed by another known flag throws a clear error', () => {
  assert.throws(
    () => parseArgs(['--script', 'test', '--character', '--voice', 'voice-1']),
    /Option '--character' argument is ambiguous/,
  );
});

await test('missing required --script throws the usage message', () => {
  assert.throws(
    () => parseArgs(['--key', 'test']),
    /usage: openedit generate/,
  );
});

// --- F7: an empty (or unset-variable) --script must not pass validation and reach the server ---

await test('--script "" is refused as empty, not silently accepted', () => {
  // The common cause is a shell variable that failed to expand: --script "$SCRIPT" with $SCRIPT unset.
  assert.throws(
    () => parseArgs(['--script', '', '--key', 'test']),
    /--script must not be empty/,
  );
});

await test('--script "   " (whitespace-only) is refused the same way', () => {
  assert.throws(
    () => parseArgs(['--script', '   ', '--key', 'test']),
    /--script must not be empty/,
  );
});

await test('a normal, non-empty --script still parses', () => {
  const args = parseArgs(['--script', 'Hello world', '--key', 'test']);
  assert.equal(args.script, 'Hello world');
});

await test('an unknown flag throws a clear error', () => {
  assert.throws(
    () => parseArgs(['--script', 'test', '--unknown']),
    /Unknown option '--unknown'/,
  );
});

await test('a stray token not consumed as a flag value is rejected, not silently dropped', () => {
  // Under-quoted script: only "Hello" is consumed as --script's value; "everyone", "welcome", "back" are
  // stray tokens that must not be silently dropped (which would otherwise still honour a trailing --yes).
  assert.throws(
    () => parseArgs(['--script', 'Hello', 'everyone', 'welcome', 'back', '--yes']),
    /Unexpected argument 'everyone'/,
  );
});

await test('the default character is one of the portrait character ids', () => {
  assert.ok(
    (PORTRAIT_CHARACTER_IDS as readonly string[]).includes(DEFAULT_CHARACTER),
    `${DEFAULT_CHARACTER} is not in PORTRAIT_CHARACTER_IDS`,
  );
  assert.equal(parseArgs(['--script', 'test']).character, DEFAULT_CHARACTER);
});

// --- --key is a directory name under runs/, so it must not be able to escape ---

for (const bad of ['../../etc', '..', 'a/b', '/abs', 'x/../y', 'a\\b', '.']) {
  await test(`--key ${JSON.stringify(bad)} is rejected as a path escape`, () => {
    assert.throws(() => parseArgs(['--script', 'test', '--key', bad]), /invalid --key/);
  });
}

await test('ordinary keys still parse', () => {
  for (const good of ['generated', 'my-run', 'run_2', 'a.b']) {
    assert.equal(parseArgs(['--script', 'test', '--key', good]).key, good);
  }
});

// --- the spend gate: run() against a fake Fabric server ---

// Answers the Fabric REST routes the way the live edge does, and records every call in order so a test
// can assert both WHICH operations ran and in WHAT order.
// `balances` drives the credit balance per call, in order, with the last value sticky: an EMPTY array
// makes every balance call fail, which is how "the charge cannot be read back" is exercised.
//
// There is no `quote` any more: the figure comes from the script's length, so a test that needs a
// particular cost asks for a script of the right length (scriptCosting) rather than configuring a server.
function fakeFabric(statuses: string[] = ['pending', 'done'], balances: number[] | null = null) {
  return fakeFabricHttp({ statuses, balances });
}

// Pass 1: carries the script, spends nothing, records the approval. The workspace is explicit because the
// CLI never picks one on the user's behalf — a run given neither a flag nor a stored choice stops.
// Sized so the local estimate lands on exactly 64 credits — the figure this suite has always asserted.
// It used to come from the server's quote; it now comes from the script's LENGTH and the voice's speaking
// RATE, so the script is sized against the rate this voice will really be priced at. Hardcoding 18 here
// would make every figure below drift the moment that voice is measured.
const RATE = resolveRate(DEFAULT_VOICE).charsPerSecond;
const SCRIPT = scriptCosting(64, RATE);
// scriptCosting sizes the LIPSYNC charge to 64; the quote a user approves is the TOTAL, so it also carries
// the folded-in speech credits. Derived rather than hardcoded, so it tracks the rate and the speech rule.
const QUOTE = estimateTotalCredits(SCRIPT, RATE);
const baseArgs: Args = {
  script: SCRIPT, key: 'test-run', character: DEFAULT_CHARACTER, voice: DEFAULT_VOICE,
  workspace: 'ws1', yes: false, resume: false,
};

// Runs the confirm-only pass against its own fake server, sharing `state` with the spend pass that follows.
// `quote` is produced by approving a script of the matching LENGTH, since that is what the cost is derived
// from now. The spend pass re-estimates from the script recorded here, so the two agree by construction.
//
// The length is measured against whatever rate is in `state` RIGHT NOW, not the seeded one: a paid run
// records what that voice actually did, so the second confirm of a key prices at the newly learned rate.
// Sizing against a fixed rate would ask for 64 credits and be quoted something else.
async function approve(state: Map<string, string>, over: Partial<Args> = {}, quote = 64) {
  const rate = resolveRate(DEFAULT_VOICE, parseVoiceRates(state.get(DEFAULT_VOICE_RATES_PATH) ?? null)).charsPerSecond;
  const fabric = fakeFabric();
  const { deps } = fakeDeps(fabric.client, {}, state);
  const result = await run({ ...baseArgs, script: scriptCosting(quote, rate), ...over, yes: false, resume: false }, deps);
  return { fabric, result };
}

function readPending(state: Map<string, string>, key: string): PendingConfirmation {
  const raw = state.get(pendingPathFor(key));
  assert.ok(raw, `no pending confirmation recorded for key "${key}"`);
  return JSON.parse(raw) as PendingConfirmation;
}

// Sized against this suite's length-calibrated 64-credit script; `over` bends one field at a time.
const seedPending = makeSeedPending(baseArgs.script as string);

// A charge record as the spend pass writes it. One per attempt, named for the session that wrote it, so no
// two runs ever write the same file.
function seedCharge(state: Map<string, string>, key: string, over: Partial<ChargeRecord> & { sessionId: string }): void {
  const record: ChargeRecord = { pid: 4242, host: 'test-host', startedAt: 0, phase: 'charging', ...over };
  state.set(chargePathFor(key, record.sessionId), JSON.stringify(record, null, 2));
}

// --- the workspace is the user's choice, never the CLI's ---

await test('a run with no --workspace and no stored choice stops and lists the workspaces, spending nothing', async () => {
  // Picking the richest workspace for the user spends their money somewhere they never chose, and in the pot
  // where an accidental spend is least visible. Stopping costs nothing; guessing can cost everything.
  const fabric = fakeFabric();
  const logs: string[] = [];
  const { deps, writes } = fakeDeps(fabric.client, { log: (m) => logs.push(m) });

  const result = await run({ ...baseArgs, workspace: undefined }, deps);

  assert.equal(result.status, 'workspace-required');
  const names = fabric.names();
  assert.ok(!fabric.confirmed(), 'nothing may be confirmed before the user has picked');
  assert.ok(!names.includes('create_fabric_video'), 'and nothing at all may be created');
  assert.ok(names.includes('list_workspaces'), 'the user must be shown what there is to pick from');
  const printed = logs.join('\n');
  for (const expected of [/ws1/, /Solo/, /8032608/, /--workspace/]) {
    assert.match(printed, expected, `the workspace table must show ${expected}; got:\n${printed}`);
  }
  assert.deepEqual(writes, []);
});

await test('an explicit --workspace is used and remembered, so the choice survives the session', async () => {
  const fabric = fakeFabric();
  const { deps, state } = fakeDeps(fabric.client);

  await run({ ...baseArgs, workspace: 'ws-chosen' }, deps);

  assert.deepEqual(fabric.workspacesTouched(), ['ws-chosen'], 'the flag must decide which workspace is billed');
  const stored = state.get(WORKSPACE_CHOICE_PATH);
  assert.ok(stored, `the choice must be persisted at ${WORKSPACE_CHOICE_PATH}`);
  assert.equal((JSON.parse(stored) as { workspaceId: string }).workspaceId, 'ws-chosen');
});

// A session that has a remembered workspace and has not been told to use it again.
function storedChoice(): Map<string, string> {
  const state = new Map<string, string>();
  state.set(WORKSPACE_CHOICE_PATH, JSON.stringify({ workspaceId: 'ws-stored', chosenAt: 0 }));
  return state;
}

await test('the confirm pass reuses a stored workspace but says it is only remembered, not confirmed', async () => {
  // The confirm pass spends nothing, so a remembered choice may carry it — but gate 2 confirms a cached
  // choice rather than assuming it, and the CLI cannot ask, so it says so and defers the answer to the spend.
  const state = storedChoice();
  const fabric = fakeFabric();
  const logs: string[] = [];
  const { deps } = fakeDeps(fabric.client, { log: (m) => logs.push(m) }, state);

  const result = await run({ ...baseArgs, workspace: undefined }, deps);

  assert.equal(result.status, 'confirmed', 'a pass that spends nothing must not be stopped');
  assert.deepEqual(fabric.workspacesTouched(), ['ws-stored'], 'the remembered choice must be the one priced');
  const printed = logs.join('\n');
  assert.match(printed, /remembered/i, `the cached choice must be flagged as cached; got:\n${printed}`);
  assert.match(
    printed, /--workspace ws-stored/,
    `and the command it prints must carry the workspace so the spend confirms it; got:\n${printed}`,
  );
});

await test('the spend pass refuses a workspace that was only remembered, and confirms nothing', async () => {
  // Nobody ever named this workspace: the confirm pass inherited it from an earlier session. Billing it now
  // spends from a pot the user has not looked at since.
  const state = storedChoice();
  await approve(state, { workspace: undefined });
  const fabric = fakeFabric(['done']);
  const { deps, writes } = fakeDeps(fabric.client, {}, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), (e: Error) => {
    assert.match(e.message, /ws-stored/, `the error must name the workspace it would bill; got: ${e.message}`);
    assert.match(e.message, /\b8032608\b/, `and state its balance; got: ${e.message}`);
    return true;
  });
  assert.ok(!fabric.names().includes('create_fabric_video'), 'an unconfirmed workspace may not be billed');
  assert.ok(!fabric.confirmed(), 'and the refusal must land before the quote');
  assert.deepEqual(writes, []);
});

await test('naming the remembered workspace on the spend pass is the acknowledgement, and proceeds', async () => {
  const state = storedChoice();
  await approve(state, { workspace: undefined });
  const fabric = fakeFabric(['done']);
  const { deps, writes } = fakeDeps(fabric.client, {}, state);

  const result = await run({ ...spendArgs, workspace: 'ws-stored' }, deps);

  assert.ok(fabric.names().includes('create_fabric_video'), 'a workspace the user just named may be billed');
  assert.equal(result.status, 'generated');
  assert.equal(writes.length, 1);
});

await test('a --workspace that disagrees with the approved one refuses, naming both', async () => {
  // Approving binds the workspace along with the script and the figure. A flag that names a different one
  // is drift, and charging the approved workspace anyway bills a decision the user has just contradicted.
  const state = new Map<string, string>();
  await approve(state, { workspace: 'ws1' });
  const fabric = fakeFabric(['done']);
  const { deps, writes } = fakeDeps(fabric.client, {}, state);

  await assert.rejects(() => run({ ...spendArgs, workspace: 'ws-other' }, deps), (e: Error) => {
    assert.match(e.message, /ws1/, `the error must name the approved workspace; got: ${e.message}`);
    assert.match(e.message, /ws-other/, `and the one the flag asked for; got: ${e.message}`);
    return true;
  });
  assert.ok(!fabric.names().includes('create_fabric_video'), 'a contradicted workspace may not be billed');
  assert.deepEqual(writes, []);
});

await test('a --workspace that agrees with the approved one is harmless and proceeds', async () => {
  const state = new Map<string, string>();
  await approve(state, { workspace: 'ws1' });
  const fabric = fakeFabric(['done']);
  const { deps, writes } = fakeDeps(fabric.client, {}, state);

  const result = await run({ ...spendArgs, workspace: 'ws1' }, deps);

  assert.ok(fabric.names().includes('create_fabric_video'), 'agreeing with the approval is not a conflict');
  assert.equal(result.status, 'generated');
  assert.equal(writes.length, 1);
});

await test('the workspace in use is logged with its name, id and balance BEFORE anything is confirmed', async () => {
  const fabric = fakeFabric();
  const logs: string[] = [];
  const { deps } = fakeDeps(fabric.client, { log: (m) => logs.push(m) });

  await run({ ...baseArgs, workspace: 'ws1' }, deps);

  const line = logs.find((m) => /workspace/i.test(m) && m.includes('ws1') && m.includes('Solo') && m.includes('8032608'));
  assert.ok(line, `no line named the workspace, its id AND its balance; got:\n${logs.join('\n')}`);
  const confirmAt = logs.findIndex((m) => m.includes('[fabric] confirmation'));
  assert.ok(confirmAt >= 0, 'the confirmation must still be printed');
  assert.ok(logs.indexOf(line) < confirmAt, 'the workspace must be named before the cost is put up for approval');
});

await test('a run WITHOUT --yes confirms, never calls create_fabric_video, and writes no file', async () => {
  const fabric = fakeFabric();
  const { deps, writes, downloads } = fakeDeps(fabric.client);
  const result = await run({ ...baseArgs, yes: false }, deps);

  assert.ok(fabric.confirmed(), 'confirmation must run');
  assert.ok(!fabric.names().includes('create_fabric_video'), 'NOTHING may be created without --yes');
  assert.ok(!fabric.names().includes('get_generation_status'), 'no polling without a job');
  assert.deepEqual(writes, []);
  assert.deepEqual(downloads, []);
  assert.deepEqual(result, { status: 'confirmed', credits: QUOTE });
});

await test('a run WITH --yes confirms BEFORE creating, then polls and writes the file', async () => {
  const state = new Map<string, string>();
  await approve(state, { key: 'spend-run' });

  const fabric = fakeFabric(['pending', 'processing', 'done']);
  const { deps, writes, downloads } = fakeDeps(fabric.client, {}, state);
  const result = await run({ ...spendArgs, key: 'spend-run' }, deps);

  const names = fabric.names();
  const confirmAt = names.indexOf('list_voices');
  const createAt = names.indexOf('create_fabric_video');
  assert.ok(confirmAt >= 0, 'confirmation must run');
  assert.ok(createAt >= 0, 'creation must run with --yes');
  assert.ok(confirmAt < createAt, 'confirmation must precede creation');
  assert.equal(names.filter((n) => n === 'create_fabric_video').length, 1, 'exactly one creation');
  assert.equal(names.filter((n) => n === 'get_generation_status').length, 3);

  assert.deepEqual(downloads, ['https://v3b.fal.media/out.mp4']);
  assert.equal(writes.length, 1);
  assert.match(writes[0].path, /runs[\\/]spend-run[\\/]spend-run\.mp4$/);
  assert.equal(writes[0].bytes, 4);
  assert.equal(result.status, 'generated');
});

await test('the file generate.ts writes for a key derives back to that same key (no run-key collision)', async () => {
  // veed/go.ts and prep/prep.ts both compute the run key as runKeyOf(videoPath); a generated run must
  // write to a path that reproduces the SAME key it was generated for, or downstream runs collide.
  const state = new Map<string, string>();
  await approve(state, { key: 'promo' });
  const fabric = fakeFabric(['done']);
  const { deps, writes } = fakeDeps(fabric.client, {}, state);
  await run({ ...spendArgs, key: 'promo' }, deps);

  assert.equal(writes.length, 1);
  assert.equal(runKeyOf(writes[0].path), 'promo', `runKeyOf(${writes[0].path}) must round-trip to "promo"`);
});

await test('the confirmation is never skipped, whatever the flags', async () => {
  // Both passes, with and without an explicit workspace. Pass 2 always re-confirms against the server
  // before it is allowed to create — the approval on disk binds the price, it does not replace the check.
  for (const over of [
    { yes: false },
    { yes: false, workspace: 'ws-explicit' },
    { yes: true },
    { yes: true, workspace: 'ws-explicit' }, // a flag that agrees with the approval, not a second choice
  ] as Array<Partial<Args>>) {
    const state = new Map<string, string>();
    const args: Args = over.yes
      ? { ...spendArgs, ...over } as Args
      : { ...baseArgs, ...over } as Args;
    if (over.yes) await approve(state, over.workspace ? { workspace: over.workspace } : {});

    const fabric = fakeFabric();
    const { deps } = fakeDeps(fabric.client, {}, state);
    await run(args, deps);
    const names = fabric.names();
    assert.ok(fabric.confirmed(), `no confirmation for ${JSON.stringify(args)}`);
    const createAt = names.indexOf('create_fabric_video');
    if (createAt >= 0) {
      assert.ok(names.indexOf('confirm_fabric_video') < createAt, 'confirmation must precede creation');
    } else {
      assert.equal(args.yes, false, 'creation may only be skipped when --yes was absent');
    }
  }
});

// --- gate 3 is ONE approval, so it must show everything it is approving: script and framing included ---

// The confirmation block as the user reads it: the single message the approval is given against.
async function confirmationBlock(over: Partial<Args> = {}): Promise<string> {
  const fabric = fakeFabric();
  const logs: string[] = [];
  const { deps } = fakeDeps(fabric.client, { log: (m) => logs.push(m) });
  await run({ ...baseArgs, ...over, yes: false, resume: false }, deps);
  const block = logs.find((m) => m.includes('[fabric] confirmation'));
  assert.ok(block, `no confirmation block was printed; got:\n${logs.join('\n')}`);
  return block;
}

await test('the confirmation shows the script it is asking approval to buy', async () => {
  // Script and format lost their own gates when the flow folded down to three; approving a script the
  // confirmation never printed is approving something unseen.
  const script = 'Ship it on Friday, and tell nobody until Monday.';
  const block = await confirmationBlock({ script });
  assert.ok(block.includes(script), `the confirmation must contain the script; got:\n${block}`);
});

await test('the confirmation states the framing, so a wrong aspect ratio is rejected before it is paid for', async () => {
  const block = await confirmationBlock({ character: 'character-15' });
  assert.match(block, /framing/i, `the confirmation must name the framing; got:\n${block}`);
  assert.match(block, /portrait 9:16/, `character-15 is a portrait character; got:\n${block}`);
});

await test('a landscape character is stated as landscape, not assumed to be portrait', async () => {
  const block = await confirmationBlock({ character: 'character-2' });
  assert.match(block, /landscape 16:9/, `character-2 has no _P_ thumbnail; got:\n${block}`);
  assert.ok(!/portrait/.test(block), `and it must not be called portrait; got:\n${block}`);
});

await test('a character nobody can price or frame is refused outright, not confirmed with a guess', async () => {
  // The character list is compiled in rather than fetched, so an id outside it is knowably wrong before
  // anything is quoted — better than the old behaviour, which could only say the framing was unknown.
  const state = new Map<string, string>();
  const fabric = fakeFabric();
  const { deps } = fakeDeps(fabric.client, {}, state);
  await assert.rejects(
    () => run({ ...baseArgs, character: 'character-not-listed' }, deps),
    /not a known character/,
  );
  assert.ok(!fabric.confirmed(), 'and nothing may be quoted for it');
  assert.equal(state.get(pendingPathFor('test-run')), undefined, 'nor recorded as approved');
});

await test('the create call bills exactly what the confirmation quoted', async () => {
  const state = new Map<string, string>();
  await approve(state);
  const fabric = fakeFabric();
  const { deps } = fakeDeps(fabric.client, {}, state);
  await run({ ...spendArgs }, deps);
  // The confirmation priced this script against this workspace; the generation must buy exactly that.
  const gen = fabric.bodyOf('/ai-playground') as Record<string, unknown>;
  assert.equal(gen.prompt, SCRIPT, 'the script bought must be the script quoted');
  assert.deepEqual(fabric.workspacesTouched(), ['ws1'], 'and billed to the workspace that was priced');
});

await test('no login means no tool calls at all, not even the confirmation', async () => {
  const state = new Map<string, string>();
  seedPending(state, 'test-run'); // a perfectly good approval: the missing login is the only problem
  const fabric = fakeFabric();
  const { deps, writes } = fakeDeps(fabric.client, { resolveAccessToken: async () => null }, state);
  const result = await run({ ...spendArgs }, deps);
  assert.deepEqual(result, { status: 'no-token' });
  assert.deepEqual(fabric.names(), []);
  assert.deepEqual(writes, []);
});

await test('run refuses an escaping key before touching the server', async () => {
  const fabric = fakeFabric();
  const { deps, writes } = fakeDeps(fabric.client);
  await assert.rejects(() => run({ ...spendArgs, key: '../../escape' }, deps), /invalid --key/);
  assert.deepEqual(fabric.names(), [], 'nothing may be spent on an invalid key');
  assert.deepEqual(writes, []);
});

await test('run refuses an empty --script before any tool call, even for a caller that bypasses parseArgs', async () => {
  const fabric = fakeFabric();
  const { deps, writes } = fakeDeps(fabric.client);
  await assert.rejects(() => run({ ...baseArgs, script: '' }, deps), /--script must not be empty/);
  assert.deepEqual(fabric.names(), [], 'nothing may be quoted, let alone spent, for an empty script');
  assert.deepEqual(writes, []);
});

await test('the transport gets a token GETTER, so a long poll survives expiry', async () => {
  const state = new Map<string, string>();
  await approve(state);
  const fabric = fakeFabric();
  const issued = ['tok-1', 'tok-2', 'tok-3'];
  let i = 0;
  const { deps, getters } = fakeDeps(fabric.client, {
    resolveAccessToken: async () => issued[Math.min(i++, issued.length - 1)],
  }, state);
  await run({ ...spendArgs }, deps);

  assert.equal(getters.length, 1, 'connect must be handed a getter');
  // Each later request re-resolves rather than reusing the token captured at connect time.
  assert.equal(await getters[0](), 'tok-2');
  assert.equal(await getters[0](), 'tok-3');
});

await test('the token getter fails loudly if the login disappears mid-run', async () => {
  const fabric = fakeFabric();
  let first = true;
  const { deps, getters } = fakeDeps(fabric.client, {
    resolveAccessToken: async () => { if (first) { first = false; return 'tok-1'; } return null; },
  });
  await run({ ...baseArgs, yes: false }, deps);
  await assert.rejects(() => getters[0](), /login is no longer valid/i);
});

// --- the approved cost is BINDING: pass 2 spends the figure the user actually saw, or nothing ---

await test('the confirm pass records the approved cost, script and hash in a pending file', async () => {
  const state = new Map<string, string>();
  const { fabric, result } = await approve(state, { key: 'promo' });

  assert.deepEqual(result, { status: 'confirmed', credits: QUOTE });
  assert.ok(!fabric.names().includes('create_fabric_video'), 'the confirm pass may not spend');

  const pending = readPending(state, 'promo');
  assert.equal(pending.estimatedCredits, QUOTE, 'the quoted price must be recorded');
  assert.equal(pending.script, SCRIPT);
  assert.equal(pending.scriptSha256, scriptHash(SCRIPT));
  assert.equal(pending.characterId, DEFAULT_CHARACTER);
  assert.equal(pending.voiceId, DEFAULT_VOICE);
  assert.equal(pending.workspaceId, 'ws1');
  assert.equal(typeof pending.approvedAt, 'number');
});

await test('a fresh quote ABOVE the approved cost aborts without calling create_fabric_video', async () => {
  // The server re-prices between the two invocations (or the pricing table moves). The user approved 32;
  // billing them the new 64 is the overspend this whole design exists to prevent.
  const state = new Map<string, string>();
  seedPending(state, 'test-run', { estimatedCredits: 32 });
  const fabric = fakeFabric(); // confirm_fabric_video quotes 64
  const { deps, writes } = fakeDeps(fabric.client, {}, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), /refusing to spend/i);
  assert.ok(!fabric.names().includes('create_fabric_video'), 'NOTHING may be created above the approved cost');
  assert.deepEqual(writes, []);
});

await test('a fresh quote BELOW the approved cost still runs (the user is charged less than they approved)', async () => {
  const state = new Map<string, string>();
  seedPending(state, 'test-run', { estimatedCredits: 500 });
  const fabric = fakeFabric(['done']);
  const { deps, writes } = fakeDeps(fabric.client, {}, state);

  const result = await run({ ...spendArgs }, deps);
  assert.equal(result.status, 'generated');
  assert.equal(writes.length, 1);
});

await test('a pending record whose script does not match its hash aborts without spending', async () => {
  // The file was edited (or truncated) after approval: the words no longer match the price that was quoted.
  const state = new Map<string, string>();
  seedPending(state, 'test-run', { scriptSha256: scriptHash('some other script entirely') });
  const fabric = fakeFabric();
  const { deps, writes } = fakeDeps(fabric.client, {}, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), /refusing to spend/i);
  assert.ok(!fabric.names().includes('create_fabric_video'), 'a tampered approval may not spend');
  assert.deepEqual(writes, []);
});

await test('a pending record older than an hour aborts without spending', async () => {
  const state = new Map<string, string>();
  seedPending(state, 'test-run', { approvedAt: 0 });
  const fabric = fakeFabric();
  // Two hours later: the user has long since moved on, and the price may have moved with them.
  const { deps, writes } = fakeDeps(fabric.client, { now: () => 2 * 60 * 60_000 }, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), /refusing to spend/i);
  assert.ok(!fabric.names().includes('create_fabric_video'), 'a stale approval may not spend');
  assert.deepEqual(writes, []);
});

await test('--yes with no pending confirmation at all refuses, and spends nothing', async () => {
  const fabric = fakeFabric();
  const { deps, writes } = fakeDeps(fabric.client);
  await assert.rejects(() => run({ ...spendArgs }, deps), /confirm/i);
  assert.ok(!fabric.names().includes('create_fabric_video'));
  assert.deepEqual(writes, []);
});

await test('run refuses --script together with --yes, before any tool call', async () => {
  const state = new Map<string, string>();
  seedPending(state, 'test-run');
  const fabric = fakeFabric();
  const { deps } = fakeDeps(fabric.client, {}, state);
  await assert.rejects(
    () => run({ ...spendArgs, script: 'Hello world.' }, deps),
    /--script cannot be combined with --yes/,
  );
  assert.deepEqual(fabric.names(), []);
});

await test('a spent approval is removed, so --yes cannot be replayed into a second charge', async () => {
  const state = new Map<string, string>();
  await approve(state);
  const first = fakeFabric(['done']);
  await run({ ...spendArgs }, fakeDeps(first.client, {}, state).deps);
  assert.ok(first.names().includes('create_fabric_video'), 'the approved run must go through once');
  assert.equal(state.get(pendingPathFor('test-run')), undefined, 'the spent approval must be gone');

  const second = fakeFabric(['done']);
  const { deps, writes } = fakeDeps(second.client, {}, state);
  await assert.rejects(() => run({ ...spendArgs }, deps), /confirm/i);
  assert.ok(!second.names().includes('create_fabric_video'), 'a spent approval must not buy a second video');
  assert.deepEqual(writes, []);
});

// --- paid work must be recoverable: the job id outlives the process that created it ---

await test('the job id is persisted BEFORE the first poll, so a lost connection cannot lose a paid job', async () => {
  const state = new Map<string, string>();
  await approve(state);
  const fabric = fakeFabric(['pending', 'done']);
  const seen: Array<ChargeRecord | null> = [];
  // The first status poll is the moment to look: by then the charge has landed and must be on disk.
  const client: VeedHttp = {
    ...fabric.client,
    async getJson<T>(path: string, headers?: Record<string, string>): Promise<T> {
      if (path.startsWith('/ai-playground/') && seen.length === 0) {
        seen.push(readCharge(state, 'test-run', 'sess-poll'));
      }
      return fabric.client.getJson<T>(path, headers);
    },
  };
  const { deps } = fakeDeps(client, { sessionId: 'sess-poll' }, state);
  await run({ ...spendArgs }, deps);

  const atFirstPoll = seen[0];
  assert.ok(atFirstPoll, `the charge record must exist before the first poll; state was ${JSON.stringify([...state.keys()])}`);
  assert.equal(atFirstPoll.phase, 'charged', 'and it must already say the charge landed');
  assert.equal(atFirstPoll.jobId, 'job-1', 'naming the only route back to the video');
});

await test('the charge record names the job while polling, and is resolved once the video is downloaded', async () => {
  const state = new Map<string, string>();
  await approve(state);
  const fabric = fakeFabric(['done']);
  // Recorded rather than asserted in-line: awaitVideo now treats a throwing poll as a transient blip, so an
  // assertion raised inside the fake client would be retried away instead of failing the test.
  const seen: Array<string | undefined> = [];
  const client: VeedHttp = {
    ...fabric.client,
    async getJson<T>(path: string, headers?: Record<string, string>): Promise<T> {
      if (path.startsWith('/ai-playground/')) seen.push(readCharge(state, 'test-run', 'sess-poll')?.jobId);
      return fabric.client.getJson<T>(path, headers);
    },
  };
  await run({ ...spendArgs }, fakeDeps(client, { sessionId: 'sess-poll' }, state).deps);
  assert.deepEqual(seen, ['job-1'], 'the id on disk while polling must be the id that was created');
  assert.equal(
    typeof readCharge(state, 'test-run', 'sess-poll')?.resolvedAt, 'number',
    'a downloaded job is no longer in flight, so its record must stop blocking the next run',
  );
});

await test('--resume downloads an already-created job WITHOUT calling create_fabric_video', async () => {
  // The transport died mid-poll on a job the workspace has already been charged for. Resuming must collect
  // the video; regenerating would charge a second time for the same script.
  const state = new Map<string, string>();
  seedCharge(state, 'test-run', { sessionId: 'sess-paid', phase: 'charged', jobId: 'job-1' });
  const fabric = fakeFabric(['processing', 'done']);
  const { deps, writes, downloads } = fakeDeps(fabric.client, {}, state);

  const result = await run({ key: 'test-run', character: DEFAULT_CHARACTER, voice: DEFAULT_VOICE, yes: false, resume: true }, deps);

  const names = fabric.names();
  assert.ok(!names.includes('create_fabric_video'), '--resume must NEVER spend');
  assert.ok(!fabric.confirmed(), '--resume has nothing to confirm');
  assert.ok(names.includes('get_generation_status'), '--resume must poll the existing job');
  assert.deepEqual(downloads, ['https://v3b.fal.media/out.mp4']);
  assert.equal(writes.length, 1);
  assert.match(writes[0].path, /runs[\\/]test-run[\\/]test-run\.mp4$/);
  assert.equal(result.status, 'generated');
  assert.equal(
    typeof readCharge(state, 'test-run', 'sess-paid')?.resolvedAt, 'number',
    'the record stops blocking once the download lands, whichever run collected it',
  );
});

await test('--resume with no recorded job says so instead of spending', async () => {
  const fabric = fakeFabric();
  const { deps, writes } = fakeDeps(fabric.client);
  await assert.rejects(
    () => run({ key: 'test-run', character: DEFAULT_CHARACTER, voice: DEFAULT_VOICE, yes: false, resume: true }, deps),
    /no in-flight Fabric job/i,
  );
  assert.deepEqual(fabric.names(), []);
  assert.deepEqual(writes, []);
});

// --- what the run cost: the QUOTE is the figure it stands behind, the balance delta only corroborates it ---

// The reframed report, as three findable lines. The quote leads every run; a credible delta is offered as a
// WORKSPACE movement rather than as "charged N", because no run can claim a workspace-global number.
// The leading figure is our own estimate now — there is no VEED quote to report — so this matches the
// wording that says so.
const quoteLine = (logs: string[]): string | undefined =>
  logs.find((m) => /approved for an estimated \d+ credits/.test(m));
const movementLine = (logs: string[]): string | undefined => logs.find((m) => /balance moved \d+ credits/.test(m));
const estimateLine = (logs: string[]): string | undefined =>
  logs.find((m) => /estimate/i.test(m) && /not the amount charged/i.test(m));

await test('the workspace movement is computed from the balance either side of the create call, and reported beside the quote', async () => {
  const state = new Map<string, string>();
  await approve(state);
  // Read before the charge, read again once the job is done: 1000 -> 936 is a 64-credit charge.
  const fabric = fakeFabric(['done'], [1000, 1000, 936]);
  const logs: string[] = [];
  const { deps } = fakeDeps(fabric.client, { log: (m) => logs.push(m) }, state);

  await run({ ...spendArgs }, deps);

  const names = fabric.names();
  const createAt = names.indexOf('create_fabric_video');
  assert.equal(names[createAt - 1], 'get_credit_balance', 'the balance must be read immediately before the charge');
  assert.ok(names.slice(createAt).includes('get_credit_balance'), 'and read again once the charge has landed');
  const quoted = quoteLine(logs);
  assert.ok(quoted, `the confirmed quote must always be stated; got:\n${logs.join('\n')}`);
  assert.match(quoted, new RegExp(`\\b${QUOTE}\\b`), `and it is the figure the run was approved for; got: ${quoted}`);
  const moved = movementLine(logs);
  assert.ok(moved, `the observed delta must be reported too; got:\n${logs.join('\n')}`);
  assert.match(moved, /\b64\b/, `and it is the delta that was observed; got: ${moved}`);
  assert.match(moved, /workspace/i, `stated as a workspace movement, not as this run's charge; got: ${moved}`);
});

await test('when the balance cannot be read, the confirmed estimate is reported AND labelled an estimate', async () => {
  // Silence about cost is the one outcome that is never acceptable: an unreadable balance downgrades the
  // report to the server's own quote, said out loud as a quote.
  const state = new Map<string, string>();
  await approve(state);
  const fabric = fakeFabric(['done'], []); // every get_credit_balance throws
  const logs: string[] = [];
  const { deps } = fakeDeps(fabric.client, { log: (m) => logs.push(m) }, state);

  const result = await run({ ...spendArgs }, deps);

  assert.equal(result.status, 'generated', 'an unreadable balance must not fail a paid, finished job');
  const line = logs.find((m) => /estimate/i.test(m) && /not the amount charged/i.test(m));
  assert.ok(line, `the estimate must be reported and labelled as one; got:\n${logs.join('\n')}`);
  assert.match(line, /\b64\b/, `and it must be the CONFIRMED estimate; got: ${line}`);
});

await test('the spend is recorded in the run directory, so a user can audit what a run cost', async () => {
  const state = new Map<string, string>();
  await approve(state);
  const fabric = fakeFabric(['done'], [1000, 1000, 936]);
  const { deps } = fakeDeps(fabric.client, {}, state);

  await run({ ...spendArgs }, deps);

  const record = onlySpend(state) as unknown as Record<string, unknown>;
  assert.equal(record.jobId, 'job-1');
  assert.equal(record.workspaceId, 'ws1');
  assert.equal(record.workspaceName, 'Solo');
  assert.equal(record.estimatedCredits, QUOTE);
  assert.equal(record.chargedCredits, 64);
  assert.equal(typeof record.at, 'number', 'the record must be timestamped');
});

await test('a partial debit at create no longer hides the full charge that settles at completion', async () => {
  // Regression from live credit-billed runs: the speech debits a couple of credits at CREATE, so the tight
  // post-create reading shows a positive-but-partial delta (2 here). The old guard re-read only when NOTHING
  // had moved, so that partial reading stood as "nothing credible" while the clip's charge settled unseen.
  const state = new Map<string, string>();
  await approve(state); // quote 64
  // resolution 1000, before-create 1000, at-create 998 (just the speech), at-completion 936 (the full 64).
  const fabric = fakeFabric(['done'], [1000, 1000, 998, 936]);
  const { deps } = fakeDeps(fabric.client, {}, state);

  await run({ ...spendArgs }, deps);

  const record = onlySpend(state);
  assert.equal(record.chargedCredits, 64, 'the completion re-read corroborates the full charge, not the partial 2');
  assert.equal(record.observedWorkspaceDelta, 64, 'and the reported movement is the settled figure, not the partial one');
});

await test('the spend record survives a failed download, because the credits are gone either way', async () => {
  const state = new Map<string, string>();
  await approve(state);
  const fabric = fakeFabric(['done'], [1000, 1000, 936]);
  const { deps } = fakeDeps(fabric.client, {
    download: async () => { throw new Error('CDN went away'); },
  }, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), /CDN went away/);
  assert.equal(
    spendRecords(state, 'test-run').length, 1,
    'the charge happened, so it must be on record even when the download did not',
  );
});

await test('--resume reports what the job cost and completes the spend record left open', async () => {
  // The charge already happened in the process that died; the run that finally collects the video is the
  // last chance to say what it cost, and the only one that can close the audit trail.
  const state = new Map<string, string>();
  seedCharge(state, 'test-run', { sessionId: 'sess-paid', phase: 'charged', jobId: 'job-1' });
  state.set(spendPath('test-run', 'sess-paid'), JSON.stringify({
    jobId: 'job-1', workspaceId: 'ws1', workspaceName: 'Solo',
    estimatedCredits: 64, chargedCredits: null, balanceBefore: 1000, at: 0,
  }));
  const fabric = fakeFabric(['done'], [936]);
  const logs: string[] = [];
  const { deps } = fakeDeps(fabric.client, { log: (m) => logs.push(m) }, state);

  const result = await run({ key: 'test-run', character: DEFAULT_CHARACTER, voice: DEFAULT_VOICE, yes: false, resume: true }, deps);

  assert.equal(result.status, 'generated');
  assert.ok(!fabric.names().includes('create_fabric_video'), '--resume must still never spend');
  assert.ok(fabric.names().includes('get_credit_balance'), 'the balance must be read so the charge can be reported');
  const quoted = quoteLine(logs);
  assert.ok(quoted, `a resumed run must still report what the job cost; got:\n${logs.join('\n')}`);
  assert.match(quoted, /Solo/, 'naming the workspace it was billed to');
  const moved = movementLine(logs);
  assert.ok(moved, `and the delta it could still observe; got:\n${logs.join('\n')}`);
  assert.match(moved, /\b64\b/, `which is the figure it measured; got: ${moved}`);
  assert.equal(
    spendAt(state, 'test-run', 'sess-paid').chargedCredits, 64,
    'the spend record must not stay open forever',
  );
});

await test('the spend record keeps the pre-charge balance, so a later --resume can still measure the charge', async () => {
  const state = new Map<string, string>();
  await approve(state);
  const fabric = fakeFabric(['done'], [1000, 1000, 936]);
  const { deps } = fakeDeps(fabric.client, {}, state);

  await run({ ...spendArgs }, deps);

  const record = onlySpend(state);
  assert.equal(record.balanceBefore, 1000, 'the balance read immediately before the charge must be recorded');
});

// --- a delta only corroborates the quote when it looks like one; otherwise the quote stands alone ---

// Runs the spend pass against a fake whose balances produce `after - before`, and returns what was logged
// plus the spend record it left behind. `quote` defaults to 64 to match fakeFabric/approve's own default.
async function spendWithBalances(balances: number[], quote = 64): Promise<{ logs: string[]; record: SpendRecord }> {
  const state = new Map<string, string>();
  await approve(state, {}, quote);
  const fabric = fakeFabric(['done'], balances);
  const logs: string[] = [];
  const { deps } = fakeDeps(fabric.client, { log: (m) => logs.push(m) }, state);
  await run({ ...spendArgs }, deps);
  return { logs, record: onlySpend(state) };
}

await test('a ZERO balance delta is reported as the labelled estimate, never as a measured charge', async () => {
  // A balance that did not move cannot be this job's charge — the credits provably went somewhere. Printing
  // "charged 0 credits" states as fact the one thing that is certainly false.
  const { logs, record } = await spendWithBalances([1000, 1000, 1000]);

  assert.equal(movementLine(logs), undefined, `a zero delta corroborates nothing; got:\n${logs.join('\n')}`);
  const line = estimateLine(logs);
  assert.ok(line, `it must fall back to the labelled estimate; got:\n${logs.join('\n')}`);
  assert.match(line, new RegExp(`\\b${QUOTE}\\b`));
  assert.equal(record.chargedCredits, null, 'and nothing unmeasured may be recorded as measured');
});

await test('a delta wildly at odds with the quote is stated as a workspace movement, never as the charge', async () => {
  // 900 credits against a 64-credit quote: a concurrent run in the same workspace moved the balance, so the
  // difference is not this job's charge — but it IS what the workspace did, and saying so is the only way
  // the user finds out that something else is billing it.
  const { logs, record } = await spendWithBalances([1000, 1000, 100]);

  const moved = movementLine(logs);
  assert.ok(moved, `the observed movement must be stated; got:\n${logs.join('\n')}`);
  assert.match(moved, /\b900\b/);
  assert.match(moved, /not as this run's charge/i, `and disclaimed as this run's charge; got: ${moved}`);
  assert.match(quoteLine(logs) as string, new RegExp(`\\b${QUOTE}\\b`), 'the quote must still be the figure the run stands behind');
  assert.equal(record.chargedCredits, null);
  assert.equal(record.observedWorkspaceDelta, 900, 'the observation belongs in the audit trail either way');
});

await test('a delta that matches the quote IS offered, as corroboration of it', async () => {
  const { logs, record } = await spendWithBalances([1000, 1000, 936]);

  const moved = movementLine(logs);
  assert.ok(moved, `a credible delta must be reported; got:\n${logs.join('\n')}`);
  assert.match(moved, /\b64\b/);
  assert.match(moved, /corroborat/i, `as corroboration of the quote, not as a per-run charge; got: ${moved}`);
  assert.equal(record.chargedCredits, 64);
});

// --- the band is asymmetric: undercharging is ordinary, overcharging is not ---

await test('a delta below the quote but inside the 20% floor is credible, and both figures are shown (regression: VEED quoted 24, the balance moved 22)', async () => {
  // Real data: a workspace balance went 471393 -> 471371, a 22-credit delta against a 24-credit quote — an
  // 8.3% shortfall. The old SYMMETRIC 5% band treated the quote as ground truth and threw this measurement
  // away as "not credible", reporting "~24 credits (estimate)" when the truth (22) was sitting right there.
  // VEED charges at or under its quote, so undercharging like this is ordinary, not suspicious.
  const { logs, record } = await spendWithBalances([471393, 471393, 471371], 24);

  const moved = movementLine(logs);
  assert.ok(moved, `the measured 22-credit delta must be reported; got:\n${logs.join('\n')}`);
  assert.match(moved, /\b22\b/);
  assert.match(quoteLine(logs) as string, /\b24\b/, 'and the 24-credit quote must be shown alongside it');
  assert.equal(record.chargedCredits, 22);
});

await test('a delta equal to the quote is reported plainly', async () => {
  const { logs, record } = await spendWithBalances([1000, 1000, 976], 24);

  const moved = movementLine(logs);
  assert.ok(moved, `an exact match must still be reported; got:\n${logs.join('\n')}`);
  assert.match(moved, /\b24\b/);
  assert.equal(record.chargedCredits, 24);
});

await test('a delta just under the 20% floor is not credible, and falls back to the labelled estimate', async () => {
  const { logs, record } = await spendWithBalances([1000, 1000, 981], 24); // delta 19, floor is min(23, 19.2) = 19.2

  assert.equal(movementLine(logs), undefined, `a delta below the floor corroborates nothing; got:\n${logs.join('\n')}`);
  const line = estimateLine(logs);
  assert.ok(line, `it must fall back to the labelled estimate; got:\n${logs.join('\n')}`);
  assert.match(line, /\b24\b/);
  assert.equal(record.chargedCredits, null);
});

await test('a delta above the 5% ceiling is genuinely ambiguous, and says so instead of claiming the quote', async () => {
  // Above the quote is not something VEED should do: the likelier explanation is a second run billing the
  // same workspace concurrently, not a bigger charge. That ambiguity must be surfaced, not silently folded
  // into the ordinary "unmeasurable" fallback.
  const { logs, record } = await spendWithBalances([1000, 1000, 974], 24); // delta 26, ceiling is max(25, 25.2) = 25.2

  const moved = movementLine(logs);
  assert.ok(moved, `an above-quote delta must still be stated; got:\n${logs.join('\n')}`);
  assert.match(moved, /\b26\b/);
  assert.match(moved, /concurrent/i, `naming concurrency as a likely cause; got: ${moved}`);
  assert.notEqual(moved, quoteLine(logs), 'the ambiguity message must be distinct from the quote line');
  assert.equal(record.chargedCredits, null, 'an ambiguous delta is not this run\'s charge');
  assert.equal(record.observedWorkspaceDelta, 26, 'but the measurement itself must survive');
});

await test('a delta of exactly zero is never credible, however small the quote', async () => {
  const { logs, record } = await spendWithBalances([1000, 1000, 1000], 24);

  assert.equal(movementLine(logs), undefined, `a zero delta corroborates nothing; got:\n${logs.join('\n')}`);
  const line = estimateLine(logs);
  assert.ok(line, `it must fall back to the labelled estimate; got:\n${logs.join('\n')}`);
  assert.match(line, /\b24\b/);
  assert.equal(record.chargedCredits, null);
});

await test('a small quote is not over-constrained by the percentage band, thanks to the 1-credit absolute slack', async () => {
  // 20% of a 3-credit quote is 2.4 credits — an amount integer billing can never produce exactly. The
  // 1-credit floor is what keeps a tiny quote measurable at all.
  const { logs, record } = await spendWithBalances([100, 100, 98], 3); // delta 2, lower bound is min(2, 2.4) = 2

  const line = logs.find((m) => /balance moved 2 credits/i.test(m));
  assert.ok(line, `a small quote must not be over-constrained by the percentage band; got:\n${logs.join('\n')}`);
  assert.equal(record.chargedCredits, 2);
});

// --- the real download is the last step AFTER the credits are spent; it must not hang forever ---

await test('the real download passes an abort signal, so a stalled CDN cannot wedge the CLI after the spend', async () => {
  // veed/http.ts sets a timeout on every request it makes ("so a hung request can't stall the poll loop
  // forever"); the download is the same shape of transfer as its GCS upload. Global fetch is stubbed, so
  // this stays offline — what is asserted is the init the real wrapper hands to fetch.
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), init });
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
  }) as typeof fetch;
  let bytes: Uint8Array;
  try {
    bytes = await realDeps().download('https://v3b.fal.media/out.mp4');
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(bytes.length, 4);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://v3b.fal.media/out.mp4');
  const signal = seen[0].init?.signal;
  assert.ok(signal instanceof AbortSignal, 'the download must pass an AbortSignal (it had none)');
  assert.equal(signal.aborted, false, 'and it must not be aborted before the request even starts');
});

// --- a workspace that cannot afford the quote is stopped, never swapped for a richer one ---

await test('a balance below the quoted cost refuses, and never calls create_fabric_video', async () => {
  const state = new Map<string, string>();
  await approve(state);
  const fabric = fakeFabric(['done'], [10]); // 10 credits against a 64-credit quote
  const { deps, writes } = fakeDeps(fabric.client, {}, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), (e: Error) => {
    assert.match(e.message, /refusing to spend/i);
    assert.match(e.message, /\b10\b/, `the error must name the balance; got: ${e.message}`);
    assert.match(e.message, /\b64\b/, `the error must name the quote; got: ${e.message}`);
    assert.match(e.message, /ws1/, `the error must name the workspace; got: ${e.message}`);
    return true;
  });
  assert.ok(!fabric.names().includes('create_fabric_video'), 'nothing may be created that cannot be paid for');
  assert.deepEqual(fabric.workspacesTouched(), ['ws1'], 'and no other workspace may be reached for');
  assert.deepEqual(writes, []);
});

await test('a balance above the quoted cost proceeds and spends', async () => {
  const state = new Map<string, string>();
  await approve(state);
  const fabric = fakeFabric(['done'], [1000, 1000, 936]);
  const { deps, writes } = fakeDeps(fabric.client, {}, state);

  const result = await run({ ...spendArgs }, deps);

  assert.ok(fabric.names().includes('create_fabric_video'), 'an affordable run must not be blocked');
  assert.equal(result.status, 'generated');
  assert.equal(writes.length, 1);
});

await test('a balance that cannot be read does NOT block the spend', async () => {
  // An unreadable balance is evidence about the connection, never about credits: refusing on it would
  // block affordable runs, and the server refuses an unaffordable one anyway.
  const state = new Map<string, string>();
  await approve(state);
  const fabric = fakeFabric(['done'], []); // every get_credit_balance throws
  const { deps, writes } = fakeDeps(fabric.client, {}, state);

  const result = await run({ ...spendArgs }, deps);

  assert.ok(fabric.names().includes('create_fabric_video'), 'an unknown balance is not evidence of insufficiency');
  assert.equal(result.status, 'generated');
  assert.equal(writes.length, 1);
});

// --- F9: an unaffordable script must be refused on the CONFIRM pass too, before an approval is written ---

await test('the confirm pass refuses when the balance cannot cover the quote, and writes NO pending approval', async () => {
  // Workspace holds 3 credits, the server quotes 64: writing an approval here just sets up a --yes command
  // that is guaranteed to fail once the user runs it.
  const fabric = fakeFabric(undefined, [3]);
  const { deps, state, writes } = fakeDeps(fabric.client);

  await assert.rejects(() => run({ ...baseArgs }, deps), (e: Error) => {
    assert.match(e.message, /refusing to spend/i);
    assert.match(e.message, /\b3\b/, `the error must name the balance; got: ${e.message}`);
    assert.match(e.message, /\b64\b/, `the error must name the quote; got: ${e.message}`);
    return true;
  });
  assert.ok(!fabric.names().includes('create_fabric_video'), 'the confirm pass may never create');
  assert.equal(
    state.get(pendingPathFor('test-run')), undefined,
    'no approval may be written for a script this workspace cannot afford',
  );
  assert.deepEqual(writes, []);
});

await test('the confirm pass with an ample balance still writes a pending approval', async () => {
  const fabric = fakeFabric(undefined, [1000]);
  const { deps, state } = fakeDeps(fabric.client);

  const result = await run({ ...baseArgs }, deps);

  assert.equal(result.status, 'confirmed');
  assert.ok(state.get(pendingPathFor('test-run')), 'an affordable script must still record its approval');
});

await test('the confirm pass proceeds when the balance is unreadable (null is not evidence of insufficiency)', async () => {
  const fabric = fakeFabric(undefined, []); // every get_credit_balance throws
  const { deps, state } = fakeDeps(fabric.client);

  const result = await run({ ...baseArgs }, deps);

  assert.equal(result.status, 'confirmed');
  assert.ok(state.get(pendingPathFor('test-run')), 'an unreadable balance must not block the confirm pass');
});

// --- a charge that happened is a charge that happened: the approval must not survive it ---

await test('a run whose generation FAILS exhausts its retries, then leaves no reusable approval behind', async () => {
  // A failed job is not charged, so the run re-submits — three attempts here, all failing. The approval is
  // still consumed at the FIRST create and never re-read, so no "yes" survives to buy an unrelated video next.
  const state = new Map<string, string>();
  await approve(state);
  const fabric = fakeFabric(['failed']);
  const { deps } = fakeDeps(fabric.client, { sessionId: 'sess-fail' }, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), /failed/i);

  assert.equal(
    fabric.names().filter((n) => n === 'create_fabric_video').length, 3,
    'a failed job is re-submitted up to the attempt cap',
  );
  assert.equal(
    state.get(pendingPathFor('test-run')), undefined,
    'the approval is consumed at the first create and must not be reusable after the attempts fail',
  );
});

await test('a transient failure is retried, and the re-submit’s success is returned', async () => {
  const state = new Map<string, string>();
  await approve(state);
  // The sticky poll counter spans both jobs, so ['error','done'] is attempt-1-fails then attempt-2-succeeds.
  const fabric = fakeFabricHttp({ statuses: ['error', 'done'], generationError: { message: 'transient', code: 'provider_error' } });
  const { deps, writes } = fakeDeps(fabric.client, { sessionId: 'sess-retry' }, state);

  const result = await run({ ...spendArgs }, deps);
  assert.equal(result.status, 'generated');
  assert.equal(fabric.names().filter((n) => n === 'create_fabric_video').length, 2, 'it re-submitted exactly once');
  // Its own audit, claiming no charge: the fake's balance never moves, so nothing corroborates one.
  assert.equal(spendAt(state, 'test-run', 'sess-retry').chargedCredits, null, 'the failed attempt claims no charge');
  assert.ok(state.get(spendPath('test-run', 'sess-retry-r1')), 'the successful re-submit has its own record');
  assert.equal(writes.length, 1, 'the video was written exactly once');
});

await test('three failures exhaust the retries and throw carrying the last reason', async () => {
  const state = new Map<string, string>();
  await approve(state);
  const fabric = fakeFabricHttp({ statuses: ['error'], generationError: { message: 'still broken', code: 'provider_error' } });
  const { deps } = fakeDeps(fabric.client, { sessionId: 'sess-3x' }, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), /failed: still broken/);
  assert.equal(fabric.names().filter((n) => n === 'create_fabric_video').length, 3, 'exactly the attempt cap');
});

// This status/code/message triple is what the live API returned for a generation billed to a workspace with
// no credits — not an invented payload.
await test('a workspace with no credits is asked once — insufficient_credits never retries', async () => {
  const state = new Map<string, string>();
  await approve(state);
  const fabric = fakeFabricHttp({
    statuses: ['error'],
    generationError: { code: 'insufficient_credits', message: 'Insufficient funds' },
  });
  const { deps } = fakeDeps(fabric.client, { sessionId: 'sess-broke' }, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), /failed: Insufficient funds/);
  assert.equal(
    fabric.names().filter((n) => n === 'create_fabric_video').length, 1,
    'a workspace that cannot pay must not be asked two more times',
  );
});

// The message is display copy, so a rewording must not change the decision.
await test('insufficient_credits is terminal on its CODE, whatever the message says', async () => {
  const state = new Map<string, string>();
  await approve(state);
  const fabric = fakeFabricHttp({
    statuses: ['error'],
    generationError: { code: 'insufficient_credits', message: 'Your balance is too low to run this.' },
  });
  const { deps } = fakeDeps(fabric.client, { sessionId: 'sess-reworded' }, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), /failed/i);
  assert.equal(
    fabric.names().filter((n) => n === 'create_fabric_video').length, 1,
    'a reworded message must not turn a terminal failure back into a retryable one',
  );
});

// The mirror: a message that merely reads like a funds problem is not one.
await test('a message that sounds like a funds problem still retries when the code is transient', async () => {
  const state = new Map<string, string>();
  await approve(state);
  const fabric = fakeFabricHttp({
    statuses: ['error'],
    generationError: { code: 'provider_error', message: 'insufficient GPU memory on the render node' },
  });
  const { deps } = fakeDeps(fabric.client, { sessionId: 'sess-gpu' }, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), /failed/i);
  assert.equal(
    fabric.names().filter((n) => n === 'create_fabric_video').length, 3,
    'a transient failure keeps its retries no matter what its message happens to contain',
  );
});

// 'timedOut' normalises to failed exactly like a refusal, which is why it needs its own test.
await test('a generation the server TIMED OUT is never re-submitted', async () => {
  const state = new Map<string, string>();
  await approve(state);
  const fabric = fakeFabricHttp({
    statuses: ['timedOut'],
    generationError: { code: 'timeout', message: 'Generation timed out' },
  });
  const { deps } = fakeDeps(fabric.client, { sessionId: 'sess-timeout' }, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), /timed out server-side/);
  assert.equal(
    fabric.names().filter((n) => n === 'create_fabric_video').length, 1,
    'work the server may already have billed for must not be re-submitted',
  );
});

await test('a failed attempt books no ESTIMATE as spend, but records what the balance actually did', async () => {
  // Synthesis bills before the generation, so a refused generation can still leave the workspace lighter:
  // zero would deny that debit, the estimate would invent one.
  const state = new Map<string, string>();
  await approve(state);
  const logs: string[] = [];
  const fabric = fakeFabricHttp({
    statuses: ['error'],
    generationError: { message: 'boom', code: 'provider_error' },
    // Declines by 2 across the run: the speech synthesis debit, far below the 64-credit quote.
    balances: [100, 100, 98],
  });
  const { deps } = fakeDeps(fabric.client, { sessionId: 'sess-nofund', log: (m) => logs.push(m) }, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), /failed/i);

  const record = spendAt(state, 'test-run', 'sess-nofund');
  assert.ok(
    (record.observedWorkspaceDelta ?? 0) > 0,
    `the measured movement must be recorded, not asserted as zero (got ${record.observedWorkspaceDelta})`,
  );
  assert.equal(record.chargedCredits, null, 'a partial movement is not claimed as the charge');
  assert.ok(logs.some((m) => /\[fabric\] spend recorded at/.test(m)), 'a failed run still closes its audit');
});

await test('the approval is already gone by the first poll, so an interrupted run cannot replay it', async () => {
  const state = new Map<string, string>();
  await approve(state);
  const fabric = fakeFabric(['pending', 'done']);
  let pendingAtFirstPoll: string | null | undefined;
  const client: VeedHttp = {
    ...fabric.client,
    async getJson<T>(path: string, headers?: Record<string, string>): Promise<T> {
      if (path.startsWith('/ai-playground/') && pendingAtFirstPoll === undefined) {
        pendingAtFirstPoll = state.get(pendingPathFor('test-run')) ?? null;
      }
      return fabric.client.getJson<T>(path, headers);
    },
  };
  const { deps, writes } = fakeDeps(client, {}, state);

  const result = await run({ ...spendArgs }, deps);

  assert.equal(pendingAtFirstPoll, null, 'the approval must be spent at the charge, not at the download');
  assert.equal(result.status, 'generated', 'and the happy path must still produce the video');
  assert.equal(writes.length, 1);
});

await test('--yes refuses while a paid charge record exists, and points at --resume instead of charging again', async () => {
  const state = new Map<string, string>();
  seedPending(state, 'test-run');
  seedCharge(state, 'test-run', { sessionId: 'sess-paid', phase: 'charged', jobId: 'job-1' });
  const fabric = fakeFabric(['done']);
  const { deps, writes } = fakeDeps(fabric.client, {}, state);

  await assert.rejects(() => run({ ...spendArgs }, deps), /--resume/);
  assert.ok(!fabric.names().includes('create_fabric_video'), 'work already paid for must never be re-created');
  assert.deepEqual(fabric.names(), [], 'and the refusal must land before anything reaches the server');
  assert.deepEqual(writes, []);
});

// --- N2: the measurement window is seconds, not the minutes a poll-and-download takes ---

await test('the closing balance is read right after create, so a long download cannot contaminate it', async () => {
  // balanceBefore is read seconds before the charge, but the closing read used to come after polling AND
  // downloading — minutes in which anything else billing this workspace lands inside the measurement.
  const state = new Map<string, string>();
  await approve(state);
  // The 3rd read (right after create) is 936; a 4th, later read would see 500 — another run, mid-download.
  const fabric = fakeFabric(['pending', 'done'], [1000, 1000, 936, 500]);
  const { deps } = fakeDeps(fabric.client, {}, state);

  await run({ ...spendArgs }, deps);

  const names = fabric.names();
  const createAt = names.indexOf('create_fabric_video');
  assert.equal(
    names[createAt + 1], 'get_credit_balance',
    `the closing balance must be read immediately after the create call; got ${JSON.stringify(names)}`,
  );
  assert.ok(
    !names.slice(names.indexOf('get_generation_status')).includes('get_credit_balance'),
    `and a reading that already moved needs no second one taken minutes later; got ${JSON.stringify(names)}`,
  );
  assert.equal(onlySpend(state).chargedCredits, 64, 'the tight reading is the one reported');
});

await test('a balance that only moves after the download still gets measured, from the later reading', async () => {
  // We do not know whether VEED debits at create or at completion, and one data point cannot tell. So the
  // tight reading is preferred only when it actually moved; otherwise the post-download one is all there is.
  const state = new Map<string, string>();
  await approve(state);
  const fabric = fakeFabric(['pending', 'done'], [1000, 1000, 1000, 936]);
  const { deps } = fakeDeps(fabric.client, {}, state);

  await run({ ...spendArgs }, deps);

  assert.equal(
    onlySpend(state).chargedCredits, 64,
    'a tight reading that showed nothing must fall back to the post-download one, not report unmeasurable',
  );
});

await test('a balance that never moves is reported unmeasurable, after BOTH readings were tried', async () => {
  const state = new Map<string, string>();
  await approve(state);
  const fabric = fakeFabric(['pending', 'done'], [1000, 1000, 1000, 1000]);
  const logs: string[] = [];
  const { deps } = fakeDeps(fabric.client, { log: (m) => logs.push(m) }, state);

  await run({ ...spendArgs }, deps);

  assert.equal(
    fabric.names().filter((n) => n === 'get_credit_balance').length, 4,
    'the fallback reading must be taken before anything is called unmeasurable',
  );
  assert.ok(estimateLine(logs), `and then it must say so plainly; got:\n${logs.join('\n')}`);
  assert.equal(onlySpend(state).chargedCredits, null);
});

// --- F8: an above-quote delta was MEASURED; it is stated and recorded, never thrown away ---

await test('a delta far above the quote states the observed movement and records it, naming concurrency', async () => {
  // 60 credits moved against a 24-credit quote. "The balance could not be read back credibly" is simply
  // false — it was read perfectly and moved by a precise, alarming amount, and that number is the one thing
  // a user needs to take to VEED support or to reconcile a workspace two runs are sharing.
  const { logs, record } = await spendWithBalances([1000, 1000, 940], 24);

  const line = logs.find((m) => /\b60\b/.test(m));
  assert.ok(line, `the observed movement must be stated, not discarded; got:\n${logs.join('\n')}`);
  assert.match(line, /concurrent/i, `and a concurrent run must be named as a likely cause; got: ${line}`);
  assert.equal(record.observedWorkspaceDelta, 60, 'the measurement must survive in the audit trail');
  assert.equal(
    record.chargedCredits, null,
    'but not in a field that claims it is this run\'s charge — no run can claim a workspace-wide movement',
  );
});

// --- F5: a resume COMPLETES a record; it never re-decides one that is already known ---

await test('--resume leaves an already-measured charge alone, however far the balance has drifted since', async () => {
  // The spend pass measured this correctly at the time: quoted 24, balance moved 22, recorded 22. Then the
  // download failed. An hour later the workspace has been topped up, so re-running the assessment against
  // the balance NOW yields a negative delta — and writing that over the 22 loses the true figure for good,
  // out of the one file whose whole job is to be the durable answer to what this cost.
  const state = new Map<string, string>();
  seedCharge(state, 'test-run', { sessionId: 'sess-paid', phase: 'charged', jobId: 'job-1' });
  state.set(spendPath('test-run', 'sess-paid'), JSON.stringify({
    jobId: 'job-1', workspaceId: 'ws1', workspaceName: 'Solo',
    estimatedCredits: 24, chargedCredits: 22, observedWorkspaceDelta: 22, balanceBefore: 471_393, at: 0,
  }));
  const fabric = fakeFabric(['done'], [999_999]); // topped up since: the delta is now negative
  const logs: string[] = [];
  const { deps } = fakeDeps(fabric.client, { log: (m) => logs.push(m) }, state);

  const result = await run({ key: 'test-run', character: DEFAULT_CHARACTER, voice: DEFAULT_VOICE, yes: false, resume: true }, deps);

  assert.equal(result.status, 'generated');
  const record = spendAt(state, 'test-run', 'sess-paid');
  assert.equal(record.chargedCredits, 22, 'a measurement that was already taken must survive the resume');
  assert.equal(record.observedWorkspaceDelta, 22, 'and so must the observation it was taken from');
  assert.ok(
    logs.some((m) => /\b22\b/.test(m)),
    `the resume must report the figure on record, not re-derive one; got:\n${logs.join('\n')}`,
  );
});

await test('--resume completes a record whose charge is still unknown', async () => {
  // The other half of the rule: null is not a decision, so this is exactly the record a resume is for.
  const state = new Map<string, string>();
  seedCharge(state, 'test-run', { sessionId: 'sess-paid', phase: 'charged', jobId: 'job-1' });
  state.set(spendPath('test-run', 'sess-paid'), JSON.stringify({
    jobId: 'job-1', workspaceId: 'ws1', workspaceName: 'Solo',
    estimatedCredits: 64, chargedCredits: null, observedWorkspaceDelta: null, balanceBefore: 1000, at: 0,
  }));
  const fabric = fakeFabric(['done'], [936]);
  const { deps } = fakeDeps(fabric.client, {}, state);

  await run({ key: 'test-run', character: DEFAULT_CHARACTER, voice: DEFAULT_VOICE, yes: false, resume: true }, deps);

  assert.equal(spendAt(state, 'test-run', 'sess-paid').chargedCredits, 64, 'an open record must be closed');
});

// --- N1: the audit trail is per ATTEMPT, because running the same key twice is ordinary ---

await test('two sequential runs of one key leave TWO spend records, not one overwritten by the other', async () => {
  // Re-running a key is legitimate and sequential — a redraft, a second take. A singleton .fabric-spend.json
  // meant the second run destroyed the first run's only account of what it cost, which is the same disease
  // the per-attempt charge records cured.
  const state = new Map<string, string>();
  await approve(state);
  const first = fakeFabric(['done'], [1000, 1000, 936]);
  await run({ ...spendArgs }, fakeDeps(first.client, { sessionId: 'sess-first' }, state).deps);

  await approve(state);
  const second = fakeFabric(['done'], [936, 936, 872]);
  await run({ ...spendArgs }, fakeDeps(second.client, { sessionId: 'sess-second' }, state).deps);

  const records = spendRecords(state, 'test-run');
  assert.equal(
    records.length, 2,
    `each attempt keeps its own audit trail; state was ${JSON.stringify([...state.keys()])}`,
  );
  assert.equal(spendAt(state, 'test-run', 'sess-first').chargedCredits, 64);
  assert.equal(spendAt(state, 'test-run', 'sess-second').chargedCredits, 64);
});

await test('--resume completes the record of the session whose job it is collecting, and no other', async () => {
  // Two attempts on one key: an older one that finished and was measured, and a newer one that charged and
  // died before it could close its trail. A resume knows which session's job it holds, so it must complete
  // exactly that session's record.
  const state = new Map<string, string>();
  seedCharge(state, 'test-run', { sessionId: 'sess-old', phase: 'charged', jobId: 'job-0', startedAt: 0, resolvedAt: 5 });
  state.set(spendPath('test-run', 'sess-old'), JSON.stringify({
    jobId: 'job-0', workspaceId: 'ws1', workspaceName: 'Solo',
    estimatedCredits: 11, chargedCredits: 11, balanceBefore: 1011, at: 0,
  }));
  seedCharge(state, 'test-run', { sessionId: 'sess-paid', phase: 'charged', jobId: 'job-1', startedAt: 10 });
  state.set(spendPath('test-run', 'sess-paid'), JSON.stringify({
    jobId: 'job-1', workspaceId: 'ws1', workspaceName: 'Solo',
    estimatedCredits: 64, chargedCredits: null, balanceBefore: 1000, at: 10,
  }));
  const fabric = fakeFabric(['done'], [936]);
  const { deps } = fakeDeps(fabric.client, {}, state);

  const result = await run({ key: 'test-run', character: DEFAULT_CHARACTER, voice: DEFAULT_VOICE, yes: false, resume: true }, deps);

  assert.equal(result.status, 'generated');
  assert.equal(spendAt(state, 'test-run', 'sess-paid').chargedCredits, 64, 'the collected job\'s record must be completed');
  assert.equal(
    spendAt(state, 'test-run', 'sess-old').chargedCredits, 11,
    'and an earlier attempt\'s trail is none of this resume\'s business',
  );
});

await test('--resume parses, and refuses to be combined with --script or --yes', () => {
  assert.deepEqual(parseArgs(['--key', 'promo', '--resume']), {
    key: 'promo', character: DEFAULT_CHARACTER, voice: DEFAULT_VOICE, yes: false, resume: true, ignoreBalance: false,
  });
  assert.throws(() => parseArgs(['--key', 'promo', '--resume', '--yes']), /--resume/);
  assert.throws(() => parseArgs(['--script', 'hi', '--key', 'promo', '--resume']), /--resume/);
});

