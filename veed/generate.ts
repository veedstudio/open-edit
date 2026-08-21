// Generate source footage with VEED Fabric when the user has no video to caption.
//
//   1. Log in once:   npx @veedstudio/openedit-cli login       (same token as transcription — no MCP connector)
//   2. Confirm cost:  node --import tsx veed/generate.ts --script "..." --key my-run --workspace ws-id
//   3. Spend + make:  node --import tsx veed/generate.ts --key my-run --yes        (NO --script here)
//   4. If 3 broke:    node --import tsx veed/generate.ts --key my-run --resume     (collects, spends nothing)
//   5. If 3 vanished: node --import tsx veed/generate.ts --key my-run --abandon <sessionId>  (clears one record)
//
// Which workspace pays is the user's decision: with no --workspace and no remembered choice the confirm
// pass stops and prints every workspace with its balance. A remembered choice (veed/.veed-workspace.json) is
// not a confirmed one, so the spend pass refuses until the command names the workspace, and refuses a
// different one from the approval. A run that spends reports what it was approved for, plus what the balance
// did, into runs/<key>/.fabric-spend-<sessionId>.json.
//
// Confirm and spend are two separate processes. The confirm pass writes the approved script + its SHA-256,
// ids, workspace and quoted credits to runs/<key>/.fabric-pending.json; the spend pass spends THAT and takes
// no --script (re-typing it is how billed words drift from priced ones). It refuses if the fresh estimate
// exceeds the approved figure, the recorded script no longer matches its hash, or the approval is over an
// hour old; a spent approval is deleted so one "yes" buys one video.
//
// Nothing takes an exclusive lock, because concurrent runs are normal: every attempt writes its OWN
// runs/<key>/.fabric-charge-<sessionId>.json. It is written BEFORE the create call (phase 'charging') and
// updated with the job id after (phase 'charged'), because a create that times out or 502s has still moved
// the money and only a record written first can say so. Before charging, a run stands down if another is
// charging now, is already paid for (--resume collects it), or was orphaned (--abandon clears that one
// record). See veed/charge-records.ts.
//
// Writes runs/<key>/<key>.mp4, whose filename must derive back to <key> via runKeyOf (resolve-video.ts, the
// rule go.ts and prep.ts share). The default run only ever CONFIRMS, since generation spends real credits.
// The flow lives in run() with HTTP client, token, download and file write injected (like orchestrate.ts's
// transcribeWithVeed) so the spend gate is testable offline; main() supplies the real ones.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../config.ts';
import { runKeyOf } from '../pipeline/scripts/resolve-video.ts';
import { assertSafeKey, assertSafeSessionId, describeValue, parseFlags } from './args.ts';
import {
  chargeFileName, classifyChargeRecords, parseChargeRecord, sessionIdOfChargeFile,
  type ChargeRecord, type ChargeVerdict,
} from './charge-records.ts';
import {
  awaitVideo, CHARS_PER_SECOND, confirmVideo, createVideo, estimateRange, estimateTotalCredits,
  framingOf, FabricJobFailedError, getAllowances, listCharacters,
  type Allowances, type ImageSource,
} from './fabric.ts';
import type { VeedHttp } from './api.ts';
import { refreshingHttp } from './http.ts';
import { resolveVeedToken } from './cli-token.ts';
import {
  conservativeRate, DEFAULT_VOICE_RATES_PATH, parseVoiceRates, rateFor, rateRange, serializeVoiceRates,
  withObservation,
} from './voice-rates.ts';
import { DEFAULT_WORKSPACE_PATH, parseWorkspaceChoice, serializeWorkspaceChoice } from './workspace-store.ts';
import {
  allUnpriced, describeChoice, formatWorkspaceTable, listWorkspacesWithCredits, resolveWorkspace,
  type WorkspaceCredits,
} from './workspace.ts';

// Defaults so a caller who supplies only --script gets a sensible 9:16 talking head. Character choice is how
// portrait framing is selected (no aspectRatio parameter); character-15 verifiably renders 480x864.
const DEFAULT_CHARACTER = 'character-15';
const DEFAULT_VOICE = 'kOvUpYLYS0rKGldsKcD1'; // Maeve, English (Ireland)

// A URL is fetched by VEED; anything else is a path on this machine. Deciding here keeps the rule in one
// place rather than in both passes.
export function imageSourceFrom(ref: string | undefined): ImageSource | undefined {
  if (!ref) return undefined;
  return /^https?:\/\//i.test(ref) ? { kind: 'url', url: ref } : { kind: 'file', path: ref };
}

export interface Args {
  // Absent on the spend pass: --yes takes the script from the approval on disk, so priced words are billed words.
  script?: string;
  key: string;
  character: string;
  // The user's own still — a URL or a local path — used INSTEAD of a preset character.
  image?: string;
  voice: string;
  workspace?: string;
  yes: boolean;
  resume: boolean;
  // The session whose charge record is to be resolved. Names ONE record, never a whole run's state.
  abandon?: string;
  // Spend despite an allowance reading that says it cannot cover this (dev/internal accounts misreport).
  // Never bypasses the approval itself.
  ignoreBalance?: boolean;
}

// What pass 1 records under runs/<key>/ and pass 2 is allowed to spend. The hash pins the exact words the
// quote was for; approvedAt bounds how long a quote is honoured.
export interface PendingConfirmation {
  script: string;
  scriptSha256: string;
  characterId: string;
  // Present only when the user brought their own still; part of the approval, since swapping it between the
  // passes would generate something nobody said yes to.
  image?: string;
  voiceId: string;
  workspaceId: string;
  // True only when the user named the workspace on the approving invocation; a cached choice is confirmed
  // before it bills, not assumed.
  workspaceNamed: boolean;
  estimatedCredits: number;
  approvedAt: number;
}

// The audit trail for a run that spent something. Unlike the two files above it is never deleted: it is the
// only durable answer to "what did this cost, and out of whose credits?".
export interface SpendRecord {
  jobId: string;
  workspaceId: string;
  workspaceName: string;
  // Our own estimate, and the figure the user approved. VEED quotes no per-job price.
  estimatedCredits: number;
  // What the credits bought, kept so a paid run doubles as a calibration sample (only the finished video
  // says how many seconds a script really took). Optional for records written before this field existed.
  scriptChars?: number;
  durationSeconds?: number;
  // What the quote was built from, so the report can name the gap rather than the reader inferring it.
  assumedCharsPerSecond?: number;
  // The workspace balance delta, kept ONLY when it corroborates the quote closely enough to be quoted back;
  // null when the balance could not be read, did not move, or moved by an amount no single run explains.
  chargedCredits: number | null;
  // The same delta, unfiltered: a WORKSPACE-level observation (a teammate or the web app moves it too),
  // never a claim about this run — it is what a user takes to VEED support when the figures disagree.
  observedWorkspaceDelta?: number | null;
  // The balance read immediately before the charge, kept so a --resume in a LATER process can still measure
  // what the job took: without it an interrupted run can never say more than its estimate.
  balanceBefore: number | null;
  at: number;
}

const PENDING_FILE = '.fabric-pending.json';
const SPEND_PREFIX = '.fabric-spend-';
const SPEND_SUFFIX = '.json';
// An approval goes stale after an hour: past that the user has moved on, and server pricing may have moved
// with them. Re-confirming is free; being billed for a quote nobody is still looking at is not.
const PENDING_TTL_MS = 60 * 60_000;
// Runs AFTER the credits are spent, so a stalled CDN connection must not hang forever on paid-for work:
// generous enough for the whole transfer, finite so the process always ends. Same budget as veed/http.ts.
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

// A server-side `failed` verdict costs nothing (VEED does not charge a failed job), so a run re-submits a
// fresh job rather than surrendering to a transient backend hiccup. The waits below sit BETWEEN attempts, so
// three attempts wait twice; the last value is sticky if the array is ever shorter than the attempts.
const MAX_GENERATION_ATTEMPTS = 3;
const GENERATION_RETRY_BACKOFF_MS = [10_000, 20_000];

// Matched on the code, never the message beside it: "Insufficient funds" is display copy and can be reworded.
const INSUFFICIENT_CREDITS_CODE = 'insufficient_credits';

function isTerminalGenerationFailure(e: FabricJobFailedError): boolean {
  return e.code === INSUFFICIENT_CREDITS_CODE;
}

export function scriptHash(script: string): string {
  return createHash('sha256').update(script, 'utf8').digest('hex');
}

export function runDirFor(key: string): string {
  return join(REPO_ROOT, 'runs', assertSafeKey(key));
}

export function pendingPathFor(key: string): string {
  return join(runDirFor(key), PENDING_FILE);
}

export function chargePathFor(key: string, sessionId: string): string {
  return join(runDirFor(key), chargeFileName(assertSafeSessionId(sessionId)));
}

// Per ATTEMPT, like the charge record: a singleton file let a second run of the same key destroy the first's
// only account of what it cost. --resume knows which session's record it has to complete.
export function spendPathFor(key: string, sessionId: string): string {
  return join(runDirFor(key), `${SPEND_PREFIX}${assertSafeSessionId(sessionId)}${SPEND_SUFFIX}`);
}

// The run-directory guards live in args.ts, shared with every entry point that names one; re-exported
// here because this module's callers and the docs address them through it.
export { assertSafeKey, assertSafeSessionId };

const OPTIONS = {
  script: { type: 'string' },
  key: { type: 'string' },
  character: { type: 'string' },
  image: { type: 'string' },
  voice: { type: 'string' },
  workspace: { type: 'string' },
  abandon: { type: 'string' },
  yes: { type: 'boolean' },
  resume: { type: 'boolean' },
  // Balance is evidence, not truth (dev/internal accounts misreport), so this downgrades that reading from a
  // refusal to a warning. Overrides nothing else — the approval still has to exist, match, and be fresh.
  'ignore-balance': { type: 'boolean' },
} as const;

const USAGE = [
  'usage: node --import tsx veed/generate.ts --script "spoken words" --workspace <id> [--key <run>] [--character <id>] [--voice <id>]',
  '       node --import tsx veed/generate.ts --key <run> --yes     (spends the cost the confirm pass above quoted)',
  '       node --import tsx veed/generate.ts --key <run> --resume  (collects a job already created and paid for)',
  '       node --import tsx veed/generate.ts --key <run> --abandon <sessionId>  (clears one abandoned charge record)',
].join('\n');

const SCRIPT_WITH_YES = [
  '--script cannot be combined with --yes.',
  '--yes spends the confirmation you already approved, which is recorded under runs/<key>/.fabric-pending.json;',
  're-typing the script is exactly how the billed words drift away from the priced ones. Confirm first:',
  '  node --import tsx veed/generate.ts --script "spoken words" --key <run>',
  'then spend what it quoted:',
  '  node --import tsx veed/generate.ts --key <run> --yes',
].join('\n');

// The four modes are mutually exclusive by construction; checked in parseArgs AND in run(), which is a
// public entry point of its own.
function assertFlagCombination(args: { script?: string; yes: boolean; resume: boolean; abandon?: string }): void {
  if (args.yes && args.script !== undefined) throw new Error(SCRIPT_WITH_YES);
  if (args.resume && (args.yes || args.script !== undefined)) {
    throw new Error(
      '--resume takes neither --script nor --yes: it downloads a job that was already created and paid for, ' +
      'and spends nothing.',
    );
  }
  if (args.abandon !== undefined && (args.yes || args.resume || args.script !== undefined)) {
    throw new Error(
      '--abandon takes no --script, --yes or --resume: it only resolves one abandoned charge record, and ' +
      'spends nothing.',
    );
  }
  if (!args.yes && !args.resume && args.abandon === undefined && args.script === undefined) throw new Error(USAGE);
}

// An unexpanded shell variable (`--script "$SCRIPT"` with `$SCRIPT` unset) parses as `--script ""`, which
// would be quoted for a video with nothing to say and then billed by --yes. Validated in parseArgs like
// --key, not in assertFlagCombination, which only compares flags against each other.
export function assertNonEmptyScript(script: string): string {
  if (script.trim() === '') {
    throw new Error(
      `--script must not be empty or whitespace-only (got ${JSON.stringify(script)}). This is usually a ` +
      'shell variable that failed to expand, e.g. --script "$SCRIPT" with $SCRIPT unset.',
    );
  }
  return script;
}

export function parseArgs(argv: string[]): Args {
  const result: Partial<Args> = {
    key: 'generated',
    character: DEFAULT_CHARACTER,
    voice: DEFAULT_VOICE,
    yes: false,
    resume: false,
  };

  const { values } = parseFlags({ args: argv, options: OPTIONS });

  if (values.script !== undefined) result.script = assertNonEmptyScript(values.script);
  if (values.key !== undefined) result.key = values.key;
  if (values.character !== undefined) result.character = values.character;
  if (values.image !== undefined) result.image = values.image;
  if (values.voice !== undefined) result.voice = values.voice;
  if (values.workspace !== undefined) result.workspace = values.workspace;
  if (values.abandon !== undefined) result.abandon = assertSafeSessionId(values.abandon);
  result.yes = values.yes ?? false;
  result.resume = values.resume ?? false;
  result.ignoreBalance = values['ignore-balance'] ?? false;

  assertFlagCombination(result as Args);
  assertSafeKey(result.key as string);

  return result as Args;
}

export interface GenerateDeps {
  // A currently-valid access token, or null when there is no usable login. Called again per request, so a
  // long poll survives the token expiring mid-run.
  resolveAccessToken: () => Promise<string | null>;
  connect: (getToken: () => Promise<string>) => Promise<VeedHttp>;
  download: (url: string) => Promise<Uint8Array>;
  // Only for a user's LOCAL image; injected so the spend path stays testable without touching a disk.
  readFileBytes?: (path: string) => Promise<Uint8Array>;
  writeOutput: (path: string, bytes: Uint8Array) => Promise<void>;
  // The small JSON state files under runs/<key>/ (approval, charge records, spend trail); injected so the
  // spend gate stays testable without touching the filesystem.
  readState: (path: string) => Promise<string | null>;
  writeState: (path: string, text: string) => Promise<void>;
  removeState: (path: string) => Promise<void>;
  // File names in a run directory (empty when absent): charge records are per-attempt, so finding the OTHER
  // attempts means listing the directory rather than reading one known path.
  listState: (dir: string) => Promise<string[]>;
  // Who this process is, stamped into the record it writes so another run can ask whether it is still there.
  // One process charges at most once, so its session id is also its attempt id.
  sessionId: string;
  pid: number;
  host: string;
  // Only meaningful for a pid on THIS host; injected so both branches of the liveness rule are drivable.
  isAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

export type RunResult =
  | { status: 'no-token' }
  // Nobody has said which workspace to bill, so the run stops having spent nothing and shows the choices.
  | { status: 'workspace-required'; workspaces: WorkspaceCredits[] }
  | { status: 'confirmed'; credits: number }
  | { status: 'generated'; path: string; bytes: number }
  | { status: 'abandoned'; sessionId: string };

function refusePending(path: string, detail: string): never {
  throw new Error(
    `refusing to spend: ${path} ${detail}. Nothing spent.\n` +
    'That file is left where it is so it can be inspected; re-run the confirm pass and approve the cost it ' +
    'prints.',
  );
}

// The approval crossed a process boundary as JSON, so every field is an untrusted claim. Unchecked, a
// missing timestamp reads back as `nowMs - undefined` = NaN and passes BOTH the `> TTL` and `< 0` checks
// silently; refusal names the offending field, because "malformed" is not something a user can act on.
function assertPendingShape(value: unknown, path: string): PendingConfirmation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    refusePending(path, `holds ${describeValue(value)}, which is not a JSON object`);
  }
  const record = value as Record<string, unknown>;
  for (const field of ['script', 'scriptSha256', 'characterId', 'voiceId', 'workspaceId'] as const) {
    const held = record[field];
    if (typeof held !== 'string' || held === '') {
      refusePending(path, `has ${field} = ${describeValue(held)}, not a non-empty string`);
    }
  }
  if (typeof record.workspaceNamed !== 'boolean') {
    refusePending(path, `has workspaceNamed = ${describeValue(record.workspaceNamed)}, not a boolean`);
  }
  // Finite, because 1e999 is legal JSON that reads back as Infinity: an infinite approved figure caps
  // nothing, and an infinite timestamp is never stale.
  for (const field of ['estimatedCredits', 'approvedAt'] as const) {
    const held = record[field];
    if (typeof held !== 'number' || !Number.isFinite(held)) {
      refusePending(path, `has ${field} = ${describeValue(held)}, not a finite number`);
    }
  }
  if ((record.estimatedCredits as number) < 0) {
    refusePending(path, `has estimatedCredits = ${record.estimatedCredits}, which is not a cost anyone approved`);
  }
  return value as PendingConfirmation;
}

// Reads back what pass 1 approved. Everything here is local: a bad approval is refused before a single
// byte reaches VEED, let alone a charge.
async function loadPending(
  deps: GenerateDeps, path: string, key: string, nowMs: number,
): Promise<PendingConfirmation> {
  const raw = await deps.readState(path);
  if (raw === null) {
    throw new Error(
      `no approved confirmation for --key ${key}. Run the confirm pass first (it spends nothing):\n` +
      `  node --import tsx veed/generate.ts --script "spoken words" --key ${key}\n` +
      'then re-run this command once you have approved the cost it prints.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`refusing to spend: ${path} is not readable JSON; re-run the confirm pass`);
  }
  const record = assertPendingShape(parsed, path);
  // The hash pins the exact words the quote was for: a record edited after approval buys something the
  // user was never shown a price for.
  if (scriptHash(record.script) !== record.scriptSha256) {
    throw new Error(
      `refusing to spend: the script in ${path} does not match the hash recorded when the cost was approved.\n` +
      'Re-run the confirm pass and approve the cost it prints.',
    );
  }
  const ageMs = nowMs - record.approvedAt;
  if (ageMs > PENDING_TTL_MS || ageMs < 0) {
    const age = ageMs < 0 ? 'timestamped in the future' : `${Math.round(ageMs / 60_000)} minutes old`;
    throw new Error(
      `refusing to spend: that approval is ${age} (limit ${PENDING_TTL_MS / 60_000} minutes).\n` +
      'Re-run the confirm pass to see the current cost and approve it again.',
    );
  }
  return record;
}

// --- charge records: what the OTHER attempts at this key say about whether it may be charged again ---

// One record as found on disk. A null `record` is a file that could not be parsed, which is refused rather
// than skipped: guessing its phase would guess whether money moved.
interface ScannedCharge {
  sessionId: string;
  record: ChargeRecord | null;
}

// Every attempt but our own. Our own record is excluded because a run must never stand down for itself.
async function scanChargeRecords(deps: GenerateDeps, key: string): Promise<ScannedCharge[]> {
  const dir = runDirFor(key);
  const found: ScannedCharge[] = [];
  for (const name of await deps.listState(dir)) {
    const sessionId = sessionIdOfChargeFile(name);
    if (sessionId === null || sessionId === deps.sessionId) continue;
    const raw = await deps.readState(join(dir, name));
    // Gone between the listing and the read: the owner resolved it, which is the one race that is safe.
    if (raw === null) continue;
    found.push({ sessionId, record: parseChargeRecord(raw) });
  }
  return found;
}

function verdictsOf(scanned: ScannedCharge[], deps: GenerateDeps, nowMs: number): ChargeVerdict[] {
  return classifyChargeRecords(
    scanned.flatMap((s) => (s.record ? [s.record] : [])),
    { host: deps.host, now: nowMs, isAlive: deps.isAlive },
  );
}

// Paid first, then a live charge, then an orphan: all three refuse, and this only decides which one the user
// is told about — the most actionable one.
const BLOCKER_ORDER = ['paid', 'charging', 'orphaned'] as const;

function blockingVerdict(verdicts: ChargeVerdict[]): ChargeVerdict | undefined {
  for (const state of BLOCKER_ORDER) {
    const hit = verdicts.find((v) => v.state === state);
    if (hit) return hit;
  }
  return undefined;
}

function unreadableRecordMessage(sessionId: string, key: string): string {
  return (
    `refusing to spend: the charge record for session ${sessionId} under --key ${key} cannot be read, so it ` +
    'cannot be ruled out that this run was already charged. Nothing spent.\n' +
    'Check the workspace for a recent charge, then clear that one record:\n' +
    `  node --import tsx veed/generate.ts --key ${key} --abandon ${sessionId}`
  );
}

function blockerMessage(v: ChargeVerdict, key: string): string {
  const started = new Date(v.startedAt).toISOString();
  if (v.state === 'paid') {
    return (
      `refusing to spend: session ${v.sessionId} has already paid for Fabric job ${v.jobId} under --key ${key}. ` +
      'Nothing spent.\n' +
      'Collect that job instead — it charges nothing:\n' +
      `  node --import tsx veed/generate.ts --key ${key} --resume`
    );
  }
  if (v.state === 'charging') {
    return (
      `refusing to spend: session ${v.sessionId} (pid ${v.pid} on ${v.host}) is charging --key ${key} right ` +
      `now, since ${started}. Nothing spent.\n` +
      'Let it finish; if it is interrupted, its video is collected without paying again:\n' +
      `  node --import tsx veed/generate.ts --key ${key} --resume`
    );
  }
  return (
    `refusing to spend: session ${v.sessionId} (pid ${v.pid} on ${v.host}) started charging --key ${key} at ` +
    `${started} and never came back, so VEED MAY already have charged for it — and no job id was ever ` +
    'recorded, so nothing here can collect it. Nothing spent.\n' +
    'Check that workspace for a video and a charge from around then before paying again. Once you have, ' +
    'clear that one record (it releases nothing else):\n' +
    `  node --import tsx veed/generate.ts --key ${key} --abandon ${v.sessionId}`
  );
}

// The pre-flight scan: a charge already in flight, already paid or possibly-landed all stop the run before
// anything reaches the server.
function assertNoBlockingCharge(scanned: ScannedCharge[], deps: GenerateDeps, key: string, nowMs: number): void {
  const unreadable = scanned.find((s) => s.record === null);
  if (unreadable) throw new Error(unreadableRecordMessage(unreadable.sessionId, key));
  const blocker = blockingVerdict(verdictsOf(scanned, deps, nowMs));
  if (blocker) throw new Error(blockerMessage(blocker, key));
}

// Ties are broken on the session id so that two records stamped in the same millisecond still yield to the
// SAME one in both processes; without that, a symmetric race can stand both runs down or neither.
function startedBefore(other: ChargeVerdict, ours: ChargeRecord): boolean {
  if (other.startedAt !== ours.startedAt) return other.startedAt < ours.startedAt;
  return other.sessionId < ours.sessionId;
}

// Write our record, then look again: no mutex, so the record is on disk before the charge, a rival that got
// there first is visible, and the earlier startedAt decides. A record written only after a successful
// create would make this impossible.
async function acquireChargeSlot(deps: GenerateDeps, key: string, nowMs: number): Promise<ChargeRecord> {
  const record: ChargeRecord = {
    sessionId: deps.sessionId, pid: deps.pid, host: deps.host, startedAt: nowMs, phase: 'charging',
  };
  const path = chargePathFor(key, deps.sessionId);
  await deps.writeState(path, `${JSON.stringify(record, null, 2)}\n`);

  const rescanned = await scanChargeRecords(deps, key);
  const unreadable = rescanned.find((s) => s.record === null);
  if (unreadable) {
    await deps.removeState(path);
    throw new Error(unreadableRecordMessage(unreadable.sessionId, key));
  }
  const verdicts = verdictsOf(rescanned, deps, nowMs);
  // A rival that started LATER is not a blocker: it can see us, and it is the one that stands down.
  const blocker = blockingVerdict(verdicts.filter((v) => v.state !== 'charging' || startedBefore(v, record)));
  if (blocker) {
    await deps.removeState(path);
    if (blocker.state !== 'charging') throw new Error(blockerMessage(blocker, key));
    throw new Error(
      `refusing to spend: session ${blocker.sessionId} started charging --key ${key} first ` +
      `(${new Date(blocker.startedAt).toISOString()}), so this run stood down rather than buy the same ` +
      'script twice. Nothing spent.\n' +
      'Collect that run\'s video when it finishes — it charges nothing:\n' +
      `  node --import tsx veed/generate.ts --key ${key} --resume`,
    );
  }
  return record;
}

// The attempt is over: the record stays as an account of what happened, and constrains nothing further.
async function resolveChargeRecord(
  deps: GenerateDeps, key: string, sessionId: string, at: number,
): Promise<void> {
  const path = chargePathFor(key, sessionId);
  const raw = await deps.readState(path);
  const record = raw === null ? null : parseChargeRecord(raw);
  // Nothing legible to resolve, so leave nothing legible behind either.
  if (!record) {
    await deps.removeState(path);
    return;
  }
  await deps.writeState(path, `${JSON.stringify({ ...record, resolvedAt: at }, null, 2)}\n`);
}

// The counterpart for --resume: the job a charge record says this key has ALREADY been charged for.
async function loadResumableJob(
  deps: GenerateDeps, key: string, nowMs: number,
): Promise<{ jobId: string; sessionId: string }> {
  const scanned = await scanChargeRecords(deps, key);
  const verdicts = verdictsOf(scanned, deps, nowMs);
  // The newest, because a key charged more than once (each time on its own fresh approval) is resumed to its
  // most recent job.
  const paid = verdicts.filter((v) => v.state === 'paid').sort((a, b) => b.startedAt - a.startedAt)[0];
  if (paid?.jobId) return { jobId: paid.jobId, sessionId: paid.sessionId };

  const stranded = verdicts.find((v) => v.state === 'orphaned' || v.state === 'charging');
  if (stranded) {
    throw new Error(
      `no in-flight Fabric job recorded for --key ${key}: session ${stranded.sessionId} started a charge at ` +
      `${new Date(stranded.startedAt).toISOString()} but never recorded a job id, so there is nothing to poll.\n` +
      'Check the workspace before paying again, then clear that record:\n' +
      `  node --import tsx veed/generate.ts --key ${key} --abandon ${stranded.sessionId}`,
    );
  }
  throw new Error(
    `no in-flight Fabric job recorded for --key ${key} (looked for a charge record in ${runDirFor(key)}).\n` +
    'There is nothing to resume: either the job already downloaded, or it was never created.',
  );
}

// Purely local, and deliberately narrow: it resolves the ONE record it is given and leaves every other
// attempt, and every other run, exactly as it was.
async function abandonChargeRecord(
  deps: GenerateDeps, key: string, sessionId: string, nowMs: number, log: (m: string) => void,
): Promise<RunResult> {
  const path = chargePathFor(key, sessionId);
  if (await deps.readState(path) === null) {
    throw new Error(
      `no charge record for session ${sessionId} under --key ${key} (looked in ${path}). Nothing to abandon.`,
    );
  }
  await resolveChargeRecord(deps, key, sessionId, nowMs);
  log(
    `[fabric] charge record ${sessionId} abandoned; --key ${key} is free to take a fresh approval. If that ` +
    'attempt did charge, those credits are gone — this only unblocks the key.',
  );
  return { status: 'abandoned', sessionId };
}

// Where the workspace to bill came from. `flag` is the only source that updates the stored choice: it is the
// only one where the user just named a workspace.
type WorkspaceSource = 'approval' | 'flag' | 'stored';

// Purely local, and deliberately without a fallback: an unanswered question stops the run (see run()) rather
// than being answered on the user's behalf.
async function resolveWorkspaceChoice(
  args: Args, deps: GenerateDeps, pending: PendingConfirmation | undefined,
): Promise<{ id: string; source: WorkspaceSource } | null> {
  if (pending) {
    // The approval binds script, figure AND workspace together; a flag naming a different one contradicts
    // it, and honouring either side silently bills a choice the user did not make twice.
    if (args.workspace && args.workspace !== pending.workspaceId) {
      throw new Error(
        `refusing to spend: the approval on disk bills ${pending.workspaceId}, but --workspace names ` +
        `${args.workspace}. Nothing spent.\n` +
        `Drop the flag to spend from ${pending.workspaceId}, or re-run the confirm pass against ` +
        `${args.workspace} and approve what it quotes.`,
      );
    }
    return { id: pending.workspaceId, source: 'approval' };
  }
  if (args.workspace) return { id: args.workspace, source: 'flag' };
  const stored = parseWorkspaceChoice(await deps.readState(DEFAULT_WORKSPACE_PATH));
  if (stored) return { id: stored.workspaceId, source: 'stored' };
  return null;
}

// ASYMMETRIC because the directions are not equally believable: VEED charges at or under quote, so a delta
// below it is ordinary rounding (generous floor), while a delta above it is likely a concurrent run, not a
// bigger charge (tight ceiling). The 20/5 split comes from a real run — quoted 24, charged 22 (8.3% under) —
// which the old symmetric 5% band discarded. Do not re-tighten the lower bound without re-reading that data.
const LOWER_BAND_RATIO = 0.80;
const UPPER_BAND_RATIO = 1.05;
// 20% of a small quote can be a fraction of a credit (e.g. 2.4 on a quote of 3), which integer billing can
// never land on exactly; the absolute floor keeps small quotes measurable at all.
const BAND_SLACK_CREDITS = 1;

// What a workspace delta is worth as corroboration: measured (close enough to quote back), unmeasured
// (unreadable, non-positive, or below the floor), or ambiguous (above the ceiling — overcharge or a
// concurrent run, indistinguishable). `delta` rides on all three because it is an observation in its own
// right; discarding it on the ambiguous branch withheld the one measured number the user needs to go check.
type ChargeAssessment =
  | { kind: 'measured'; delta: number }
  | { kind: 'unmeasured'; delta: number | null }
  | { kind: 'ambiguous'; delta: number };

function assessCharge(before: number | null, after: number | null, quoted: number): ChargeAssessment {
  if (before === null || after === null) return { kind: 'unmeasured', delta: null };
  const delta = before - after;
  // A balance that did not move (or moved the wrong way) corroborates nothing, regardless of the band.
  if (delta <= 0) return { kind: 'unmeasured', delta };
  const lower = Math.min(quoted - BAND_SLACK_CREDITS, quoted * LOWER_BAND_RATIO);
  const upper = Math.max(quoted + BAND_SLACK_CREDITS, quoted * UPPER_BAND_RATIO);
  if (delta < lower) return { kind: 'unmeasured', delta };
  if (delta > upper) return { kind: 'ambiguous', delta };
  return { kind: 'measured', delta };
}

// For reporting, never gating: an unreadable allowance degrades the report to an estimate rather than
// failing a paid-for run, and is never treated as an empty one (which would refuse an affordable run).
async function readAllowances(client: VeedHttp, workspaceId: string): Promise<Allowances | null> {
  try {
    return await getAllowances(client, workspaceId);
  } catch {
    return null;
  }
}

async function readBalance(client: VeedHttp, workspaceId: string): Promise<number | null> {
  return (await readAllowances(client, workspaceId))?.aiPlaygroundCredits ?? null;
}

// Name + balance for the workspace about to be billed, so the user reads it before approving anything. The
// name is cosmetic, so a listing failure must not stop a run the user has already directed.
async function describeFraming(client: VeedHttp, characterId: string): Promise<string> {
  let listed;
  try {
    listed = (await listCharacters(client)).find((c) => c.id === characterId);
  } catch {
    listed = undefined;
  }
  if (!listed) return `unknown — ${characterId} is not in the live character listing, so its shape cannot be stated`;
  return framingOf(listed) === 'portrait' ? 'portrait 9:16' : 'landscape 16:9';
}

export async function run(args: Args, deps: GenerateDeps): Promise<RunResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  // Re-checked here as well as in parseArgs: run() is a public entry point and the key ends up in a path.
  const key = assertSafeKey(args.key);
  assertFlagCombination(args);
  // Same reasoning as the key: a caller of run() that never went through parseArgs (every test here included)
  // must not be able to reach confirm_fabric_video with nothing to say.
  if (args.script !== undefined) assertNonEmptyScript(args.script);
  const now = deps.now ?? Date.now;
  const pendingPath = pendingPathFor(key);

  // Spends nothing and asks the server nothing, so it answers before the login is even resolved.
  if (args.abandon !== undefined) {
    return await abandonChargeRecord(deps, key, assertSafeSessionId(args.abandon), now(), log);
  }

  // Pass 2 and --resume read their whole request off disk BEFORE anything touches the network.
  if (args.yes) assertNoBlockingCharge(await scanChargeRecords(deps, key), deps, key, now());
  const pending = args.yes ? await loadPending(deps, pendingPath, key, now()) : undefined;
  const resuming = args.resume ? await loadResumableJob(deps, key, now()) : undefined;

  const token = await deps.resolveAccessToken();
  if (!token) return { status: 'no-token' };

  const client = await deps.connect(async () => {
    const fresh = await deps.resolveAccessToken();
    if (!fresh) throw new Error('VEED login is no longer valid; run: npx @veedstudio/openedit-cli login');
    return fresh;
  });

  // --resume never confirms and never creates: the video is already bought, this only collects it.
  if (resuming) {
    log(`[fabric] resuming job ${resuming.jobId} — it is already paid for, nothing further will be charged`);
    try {
      return await collect(client, resuming.jobId, key, resuming.sessionId, deps, log);
    } finally {
      // The charge report is unconditional, and the run that was interrupted never got to make it. The
      // record to close is that SESSION's, not the key's: another attempt's trail is not this run's to touch.
      await completeSpendRecord(client, key, resuming.sessionId, deps, log);
    }
  }

  // Which workspace pays is the user's decision. With no flag and no remembered choice the run stops here,
  // before the first billable thought, and shows them what there is to choose from.
  const choice = await resolveWorkspaceChoice(args, deps, pending);
  if (!choice) {
    const workspaces = await listWorkspacesWithCredits(client);
    log(
      [
        '[fabric] Fabric bills a workspace and none has been chosen, so nothing has been done and nothing spent.',
        '',
        formatWorkspaceTable(workspaces),
        '',
        'Re-run naming the workspace to spend from, for example:',
        `  node --import tsx veed/generate.ts --script "spoken words" --key ${key} --workspace ${workspaces[0].id}`,
        'That choice is remembered, so this is asked once and not every session.',
      ].join('\n'),
    );
    return { status: 'workspace-required', workspaces };
  }

  const workspaceId = choice.id;
  // An account with no workspaces has nothing to bill; checked here where the workspace is chosen, so it
  // fails once with a useful message rather than later, one call at a time.
  const resolution = await resolveWorkspace({ http: client, explicit: workspaceId });
  if (resolution.kind === 'must-choose') throw new Error('internal error: a workspace was already chosen');
  const workspace = resolution.workspace;
  log(`[fabric] ${describeChoice(workspace, resolution.source)}`);
  // The spend pass is the last moment at which a workspace nobody ever named can still be questioned, and
  // the CLI cannot hold a conversation — so naming it on this invocation IS the acknowledgement.
  if (pending && !pending.workspaceNamed && args.workspace !== workspaceId) {
    throw new Error(
      `refusing to spend: ${workspace.name} (${workspaceId}) is remembered from an earlier session, and ` +
      'nobody has confirmed it for this charge. Nothing spent.\n' +
      `It has ${workspace.credits === null ? 'an unreadable balance' : `${workspace.credits} credits`}. ` +
      'Confirm it by naming it:\n' +
      `  node --import tsx veed/generate.ts --key ${key} --yes --workspace ${workspaceId}\n` +
      'To bill a different workspace, re-run the confirm pass with that --workspace.',
    );
  }

  // Only an explicit flag records a decision; a run that inherited its workspace has not made one.
  const workspaceNamed = choice.source === 'flag';
  if (choice.source === 'stored') {
    log(
      `[fabric] ${workspaceId} is remembered from an earlier session, not chosen for this run — the spend ` +
      'pass below names it again, which is where that choice gets confirmed.',
    );
  }
  if (workspaceNamed) {
    await deps.writeState(
      DEFAULT_WORKSPACE_PATH,
      serializeWorkspaceChoice({ workspaceId, workspaceName: workspace.name, chosenAt: now() }),
    );
  }

  // Pass 1 builds the request from the flags; pass 2 rebuilds it from the approval, so the script is typed
  // exactly once and cannot drift between the price the user saw and the one they are charged.
  const script = pending?.script ?? (args.script as string);
  const voiceId = pending?.voiceId ?? args.voice;

  // Resolved BEFORE the confirmation, because it is what prices it: confirmVideo quotes at this rate, so
  // the figure in the approval block and the figure the estimate line explains are the same number.
  const rates = parseVoiceRates(await deps.readState(DEFAULT_VOICE_RATES_PATH));
  const known = rateFor(voiceId, rates);
  const rate = known?.charsPerSecond ?? conservativeRate(rates);
  const range = estimateRange(script, rateRange(rates));

  const req = {
    script,
    voiceId,
    characterId: pending?.characterId ?? args.character,
    image: imageSourceFrom(pending?.image ?? args.image),
    workspaceId,
    // Already resolved above; passing it spares confirmVideo a duplicate workspace listing.
    workspaceName: workspace.name,
    charsPerSecond: rate,
  };
  log(
    known
      ? `[fabric] local estimate ~${estimateTotalCredits(script, rate)} credits (${script.length} chars at ${rate} chars/second, measured over ${known.samples} run${known.samples === 1 ? '' : 's'} of this voice)`
      : `[fabric] local estimate ~${estimateTotalCredits(script, rate)} credits (${script.length} chars). This voice has never been measured, and speaking rate decides the length: expect ${range.low}-${range.high} credits.`,
  );
  // The confirmation ALWAYS runs, and always before create_fabric_video below — it is what the user is
  // shown to approve. Nothing between here and the `if (!args.yes)` gate may spend.
  const confirmation = await confirmVideo(client, req);
  // One approval covers the script, the presenter, the voice, the framing AND the cost, so all five are in
  // the block it is given against: the script and the framing lost their own gates, not their visibility.
  log(
    [
      '[fabric] confirmation',
      `  character  ${confirmation.characterName} (${confirmation.characterId})`,
      `  voice      ${confirmation.voiceName}`,
      `  framing    ${await describeFraming(client, req.characterId)}`,
      `  workspace  ${confirmation.workspaceName}`,
      `  cost       ~${confirmation.estimatedCredits} AI Playground credits`,
      // The speech synthesis and Fabric One Lipsync are two debits on the one credit allowance; the figure
      // above is their sum, so the user sees the whole spend rather than half of it.
      "             (covers both the speech synthesis and Fabric One Lipsync — one allowance, one figure)",
      // An unmeasured voice gets the spread it could land in, not a single figure dressed as a
      // measurement. The point number above already leans slow; this says how wide the uncertainty is.
      ...(known ? [] : [`             (estimated: this voice has never been measured, expect ${range.low}-${range.high})`]),
      `  script     ${script.length} chars, exactly as they will be spoken:`,
      ...script.split('\n').map((line) => `    ${line}`),
    ].join('\n'),
  );

  // A workspace that cannot cover the quote is a stop, not a prompt to look elsewhere: a richer workspace
  // bills money nobody offered. Checked on BOTH passes, each with its own freshly-read balance (it can move
  // between them); refusing on the CONFIRM pass means no unaffordable approval is ever written. An UNREADABLE
  // balance is not evidence of insufficiency, so it proceeds and lets the server refuse.
  if (workspace.credits !== null && workspace.credits < confirmation.estimatedCredits && args.ignoreBalance) {
    log(
      `[fabric] WARNING: ${workspace.name} reports ${workspace.credits} credits against a ~${confirmation.estimatedCredits} ` +
      'credit quote, and --ignore-balance says to spend anyway. If the report is right this fails at VEED, ' +
      'having charged nothing; if it is wrong, this charges normally.',
    );
  } else if (workspace.credits !== null && workspace.credits < confirmation.estimatedCredits) {
    throw new Error(
      `refusing to spend: ${workspace.name} (${workspaceId}) has ${workspace.credits} credits, but this ` +
      `costs ${confirmation.estimatedCredits}. Nothing spent.\n` +
      'Top that workspace up, shorten the script, or re-confirm naming a different --workspace — this will ' +
      'not switch workspaces on your behalf.',
    );
  }

  if (!pending) {
    const record: PendingConfirmation = {
      script,
      scriptSha256: scriptHash(script),
      characterId: req.characterId,
      ...(args.image ? { image: args.image } : {}),
      voiceId: req.voiceId,
      workspaceId,
      workspaceNamed,
      estimatedCredits: confirmation.estimatedCredits,
      approvedAt: now(),
    };
    await deps.writeState(pendingPath, `${JSON.stringify(record, null, 2)}\n`);
    // An unnamed workspace carries its own flag into the command, so approving the cost and confirming the
    // workspace are the same keystroke rather than two questions.
    const spendCommand = `  node --import tsx veed/generate.ts --key ${key} --yes` +
      (workspaceNamed ? '' : ` --workspace ${workspaceId}`);
    log(
      `\nNothing spent. To approve ${confirmation.estimatedCredits} credits and generate, run exactly:\n\n` +
      `${spendCommand}\n\n` +
      'That re-uses the confirmation above — do not re-type --script.',
    );
    return { status: 'confirmed', credits: confirmation.estimatedCredits };
  }

  // The cap: the server may not charge more than the figure the user actually saw and approved. A cheaper
  // quote is fine — being billed LESS than approved needs no second look.
  if (confirmation.estimatedCredits > pending.estimatedCredits) {
    throw new Error(
      `refusing to spend: you approved ${pending.estimatedCredits} credits, but the server now quotes ` +
      `${confirmation.estimatedCredits}. Nothing spent.\n` +
      'Re-run the confirm pass to see the new cost and approve it explicitly.',
    );
  }

  // --- everything past this line spends real credits ---
  let lastFailure: FabricJobFailedError | undefined;
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const waitMs = GENERATION_RETRY_BACKOFF_MS[Math.min(attempt - 1, GENERATION_RETRY_BACKOFF_MS.length - 1)];
      log(`[fabric] retry ${attempt + 1}/${MAX_GENERATION_ATTEMPTS} in ${Math.round(waitMs / 1000)}s (reason=${lastFailure?.reason ?? 'unknown'})`);
      await deps.sleep(waitMs);
    }

    // VEED exposes no per-job charge, so the balance either side of the create call is all there is — and it
    // is only ever a WORKSPACE observation; the quote above is the figure this run reports. Read per attempt
    // so each attempt's record stands on its own.
    const balanceBefore = await readBalance(client, workspaceId);
    // Written BEFORE the charging call, deliberately: a create that times out, 502s or returns a truncated
    // body has still moved the money, and a record written afterwards would not exist to say so (buying twice).
    // A retry runs under a per-attempt session id so its charge/spend files sit BESIDE the failed attempt's,
    // never on top of them — and so scanChargeRecords (which excludes the acquiring session's own record)
    // still excludes THIS attempt. Only acquireChargeSlot reads deps.sessionId; the rest take it explicitly.
    const attemptDeps: GenerateDeps = attempt === 0
      ? deps
      : { ...deps, sessionId: `${deps.sessionId}-r${attempt}` };
    const charge = await acquireChargeSlot(attemptDeps, key, now());
    const chargePath = chargePathFor(key, charge.sessionId);
    const job = await createVideo(client, req, { readFileBytes: deps.readFileBytes });
    // Now the charge is known to have landed AND has an id: the record can name the job --resume needs.
    await deps.writeState(chargePath, `${JSON.stringify({ ...charge, phase: 'charged', jobId: job.jobId }, null, 2)}\n`);
    // Closing balance taken HERE, not after the download: the balance is workspace-global, so the minutes of
    // polling and downloading would let other spends land inside the measurement. Whether VEED debits at create
    // or completion is unknown, so this reading is preferred only when it moved, with the post-download one as fallback.
    const balanceAtCreate = await readBalance(client, workspaceId);
    // The approval is consumed at the FIRST create and never re-read: the retries re-submit the same in-memory
    // request, so a "yes" left on disk could only ever buy a SECOND, unrelated video. After the attempts are
    // exhausted the run throws and a fresh confirm pass is required.
    if (attempt === 0) await deps.removeState(pendingPath);
    log(`[fabric] job ${job.jobId} started${job.durationSeconds ? ` (${job.durationSeconds.toFixed(1)}s of video)` : ''}`);
    log(`[fabric] recorded at ${chargePath} — if this run is interrupted, collect it without paying again:\n  node --import tsx veed/generate.ts --key ${key} --resume`);

    const spend: SpendRecord = {
      jobId: job.jobId,
      workspaceId,
      workspaceName: workspace.name,
      estimatedCredits: confirmation.estimatedCredits,
      scriptChars: confirmation.script.length,
      durationSeconds: job.durationSeconds,
      assumedCharsPerSecond: rate,
      chargedCredits: null,
      observedWorkspaceDelta: null,
      balanceBefore,
      at: now(),
    };
    const spendPath = spendPathFor(key, charge.sessionId);
    // Written at the charge and again below with the observed figure: a run that dies mid-download still spent
    // the credits, and an audit trail that only appears on success hides the cases worth auditing.
    await deps.writeState(spendPath, `${JSON.stringify(spend, null, 2)}\n`);

    // Closes this attempt's charge audit against the balance. Only reached for a job that was actually
    // charged — a success, or a timeout/transport failure whose credits are gone and which --resume collects.
    const finalizeCharge = async (): Promise<void> => {
      let balanceAfter = balanceAtCreate;
      let assessment = assessCharge(balanceBefore, balanceAtCreate, confirmation.estimatedCredits);
      // The tight reading is credible only when it already CORROBORATES the quote; anything less — nothing
      // moved, or only PART of the charge had landed — needs the completion read, the last chance to see a
      // debit that settles late. The speech synthesis debits a couple of credits at create while the clip's
      // credits settle at completion, so the early delta is routinely positive but far below the quote;
      // stopping there would report that partial figure as "nothing credible" while the full charge settled
      // unseen. 'ambiguous' is left alone: the early delta is already above the quote, and waiting only lets
      // more concurrent movement pile onto a reading that is already untrustworthy.
      if (assessment.kind === 'unmeasured') {
        balanceAfter = await readBalance(client, workspaceId);
        assessment = assessCharge(balanceBefore, balanceAfter, confirmation.estimatedCredits);
      }
      spend.chargedCredits = assessment.kind === 'measured' ? assessment.delta : null;
      spend.observedWorkspaceDelta = assessment.delta;
      reportCharge(log, spend, assessment, balanceAfter);
      if (spend.durationSeconds && spend.scriptChars) {
        // The next quote for this voice is built from what this one actually did.
        await deps.writeState(
          DEFAULT_VOICE_RATES_PATH,
          serializeVoiceRates(withObservation(rates, req.voiceId, spend.scriptChars / spend.durationSeconds)),
        );
      }
      await deps.writeState(spendPath, `${JSON.stringify(spend, null, 2)}\n`);
      log(`[fabric] spend recorded at ${spendPath}`);
    };

    try {
      const result = await collect(client, job.jobId, key, charge.sessionId, deps, log);
      await finalizeCharge();
      return result;
    } catch (e) {
      // Closed against the balances actually read: a zero asserted here would deny the synthesis debit.
      await finalizeCharge();
      if (e instanceof FabricJobFailedError) {
        lastFailure = e;
        // A timeout may already have consumed what it billed for; a refusal did not.
        if (e.timedOut || isTerminalGenerationFailure(e)) throw e;
        continue;
      }
      // Transport and client-side timeouts may still be finishing on a paid job, so --resume collects them.
      throw e;
    }
  }
  // All attempts returned the server's `failed` verdict without one that a re-submit could fix.
  throw lastFailure ?? new Error(`Fabric generation failed after ${MAX_GENERATION_ATTEMPTS} attempts`);
}

// Saying nothing about cost is never acceptable, nor is a number the run cannot stand behind. VEED gives no
// per-job figure, so the leading number is OUR estimate (labelled as one), and the workspace-global balance
// delta is offered as corroboration, named a workspace movement, never "charged N". The user always gets a
// number AND how much to trust it.
function reportCharge(
  log: (m: string) => void, spend: SpendRecord, assessment: ChargeAssessment, balanceAfter: number | null,
): void {
  const workspace = `${spend.workspaceName} (${spend.workspaceId})`;
  // Printed on EVERY run that can measure, not only where the delta agrees: an estimate that was wrong
  // is exactly the case this line explains, so hiding it there would hide it when it matters most.
  if (spend.durationSeconds && spend.scriptChars) {
    const observed = spend.scriptChars / spend.durationSeconds;
    log(
      `[fabric] this run measured ${observed.toFixed(1)} characters/second` +
      (assessment.delta ? ` and ${(assessment.delta / spend.durationSeconds).toFixed(2)} credits/second` : '') +
      `. The estimate assumed ${spend.assumedCharsPerSecond ?? CHARS_PER_SECOND}; speaking rate is a ` +
      'property of the voice, and it is what decides how long — and so how expensive — a script is.',
    );
  }
  log(
    `[fabric] this run was approved for an estimated ${spend.estimatedCredits} credits against ${workspace} — ` +
    'that figure is our own estimate from the script length, not a price VEED quoted. VEED exposes no ' +
    'per-job cost, so the balance movement below is the only measurement of what was actually charged.',
  );
  const left = balanceAfter === null ? '' : `, ${balanceAfter} left`;
  if (assessment.kind === 'measured') {
    log(
      `[fabric] that workspace's balance moved ${assessment.delta} credits over the run${left}, which ` +
      'corroborates the estimate. It is a workspace-wide movement rather than this run\'s charge: anything ' +
      'else billing the same workspace moves it too.',
    );
    return;
  }
  if (assessment.kind === 'ambiguous') {
    log(
      `[fabric] that workspace's balance moved ${assessment.delta} credits over the run${left} — more than ` +
      `the ${spend.estimatedCredits}-credit estimate, so it is recorded as an observed workspace movement ` +
      'and not as this run\'s charge. The likeliest cause is our estimate running low — a voice slower ' +
      'than assumed makes a longer video — and a concurrent run billing the same workspace is the other. ' +
      'The measured rate above says which.',
    );
    return;
  }
  // Deliberately covers all three ways a delta says nothing — unread, unmoved, moved too little — because
  // claiming the balance "could not be read" when it read perfectly and sat still is its own small lie.
  log(
    `[fabric] the balance either side gives nothing credible to corroborate that with (it could not be read, ` +
    `did not move, or moved too little to stand for the estimate), so this is our estimate and not ` +
    `the amount charged: ~${spend.estimatedCredits} credits from ${workspace}`,
  );
}

// Closes the audit trail a charged-but-interrupted run left open: it names the workspace that was billed, so
// the balance can be read against it without asking the user anything a second time.
async function completeSpendRecord(
  client: VeedHttp, key: string, sessionId: string, deps: GenerateDeps, log: (m: string) => void,
): Promise<void> {
  const path = spendPathFor(key, sessionId);
  const raw = await deps.readState(path);
  let spend: SpendRecord | null = null;
  try {
    if (raw !== null) spend = JSON.parse(raw) as SpendRecord;
  } catch {
    spend = null;
  }
  if (!spend || typeof spend.workspaceId !== 'string') {
    log(`[fabric] no usable spend record at ${path}, so this run cannot say what the job cost`);
    return;
  }

  // A resume COMPLETES a record, never re-decides one: the balance it could read now reflects every other
  // spend against this workspace since, so re-running the assessment would replace the one real measurement
  // with an artefact of that drift.
  if (typeof spend.chargedCredits === 'number' && Number.isFinite(spend.chargedCredits)) {
    reportCharge(log, spend, { kind: 'measured', delta: spend.chargedCredits }, null);
    return;
  }

  const resolved = await resolveWorkspace({ http: client, explicit: spend.workspaceId });
  const workspace = resolved.kind === 'resolved'
    ? resolved.workspace
    : { id: spend.workspaceId, name: spend.workspaceName, credits: null };
  const assessment = assessCharge(spend.balanceBefore ?? null, workspace.credits, spend.estimatedCredits);
  spend.chargedCredits = assessment.kind === 'measured' ? assessment.delta : null;
  spend.observedWorkspaceDelta = assessment.delta;
  reportCharge(log, spend, assessment, workspace.credits);
  await deps.writeState(path, `${JSON.stringify(spend, null, 2)}\n`);
  log(`[fabric] spend recorded at ${path}`);
}

// Poll an EXISTING job (paid for already) and land the file. Shared by the spend pass and --resume, so both
// clean up the same state and neither can reach create_fabric_video from here.
async function collect(
  client: VeedHttp, jobId: string, key: string, sessionId: string, deps: GenerateDeps,
  log: (m: string) => void,
): Promise<RunResult> {
  const now = deps.now ?? Date.now;
  let url: string;
  try {
    url = await awaitVideo(client, jobId, {
      sleep: deps.sleep,
      now: deps.now,
      onProgress: (attempt, status) => log(`[fabric] poll ${attempt + 1}: ${status}`),
    });
  } catch (e) {
    // A job the server declared failed is terminal and (unlike a timeout) was not charged: resolving its
    // charge record frees the run to re-submit under a fresh slot, which a lingering record would block
    // forever. Every other failure may still finish server-side, so its record stays for --resume to collect.
    if (e instanceof FabricJobFailedError) await resolveChargeRecord(deps, key, sessionId, now());
    throw e;
  }

  const bytes = await deps.download(url);
  // The filename must derive back to `key` via runKeyOf (as go.ts and prep.ts do), or this run silently
  // collides with whatever run that filename would derive to.
  const out = join(REPO_ROOT, 'runs', key, `${key}.mp4`);
  if (runKeyOf(out) !== key) {
    throw new Error(`internal error: runKeyOf(${out}) !== "${key}" — refusing to write a colliding run`);
  }
  await deps.writeOutput(out, bytes);
  // A downloaded job is no longer in flight; the approval that bought it was already spent at the charge.
  await resolveChargeRecord(deps, key, sessionId, now());
  log(`[fabric] wrote ${out} (${(bytes.length / 1e6).toFixed(1)} MB)`);
  return { status: 'generated', path: out, bytes: bytes.length };
}

function noTokenHelp(): void {
  console.error(
    [
      'No VEED login found. Log in with VEED:',
      '',
      '  npx @veedstudio/openedit-cli login',
      '',
      'It opens your browser once and stores a refreshable token, owner-only, in the',
      "CLI's app-data directory (npx @veedstudio/openedit-cli token --path prints where).",
      '',
      'The same login covers both transcription and Fabric generation.',
    ].join('\n'),
  );
}

export function realDeps(): GenerateDeps {
  return {
    resolveAccessToken: resolveVeedToken,
    // Resolved per request, so a token refresh mid-poll is picked up without reconnecting.
    connect: async (getToken) => refreshingHttp(getToken),
    readFileBytes: async (path) => new Uint8Array(await readFile(path)),
    download: async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`download ${url} -> ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    writeOutput: async (path, bytes) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },
    readState: async (path) => {
      try {
        return await readFile(path, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
    writeState: async (path, text) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, { mode: 0o600 });
    },
    removeState: (path) => rm(path, { force: true }),
    listState: async (dir) => {
      try {
        return await readdir(dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw e;
      }
    },
    // One id per process, and a process charges at most once, so this identifies the attempt as well.
    sessionId: randomUUID(),
    pid: process.pid,
    host: hostname(),
    // Signal 0 checks for the process without touching it; EPERM means it exists and simply is not ours.
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await run(args, realDeps());
  if (result.status === 'no-token') {
    noTokenHelp();
    process.exit(1);
  }
  // run() has already printed the workspaces and the exact command to re-run with; exiting non-zero keeps a
  // caller that chains commands from treating "nobody chose" as "done".
  if (result.status === 'workspace-required') process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
