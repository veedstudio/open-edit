// One approval covering SEVERAL shots.
//
//   node --import tsx veed/generate-set.ts --shots shots.json --key poem --workspace <id>
//   node --import tsx veed/generate-set.ts --key poem --yes
//
// A set is a layer over the single-shot engine, not a replacement for it. Every guarantee generate.ts
// already provides is per-KEY — the charge record that survives a create which timed out, --resume,
// --abandon, the refusal to buy the same script twice — so each shot runs under its own derived key
// (`poem-1`, `poem-2`, …) and keeps all of them, unchanged and independent. A shot that fails leaves the
// shots already paid for alone.
//
// What the set adds is the ONE thing a user should not have to do N times: approve. The set approval is
// the authorisation; the per-shot approvals it writes are its expansion, not a second question. That is
// why the set is hashed as a whole — reorder the shots, edit one line, swap one image, and the approval
// no longer covers what is about to be bought.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { estimateRange, estimateTotalCredits } from './fabric.ts';
import {
  assertNonEmptyScript, type GenerateDeps, type PendingConfirmation, pendingPathFor, run, runDirFor,
  scriptHash,
} from './generate.ts';
import {
  DEFAULT_VOICE_RATES_PATH, parseVoiceRates, rateRange, resolveRate, SEEDED_RATES, type VoiceRates,
} from './voice-rates.ts';

export interface Shot {
  // Names the run directory for this shot, so a failure points at something a person can act on.
  id: string;
  script: string;
  character?: string;
  image?: string;
  voice?: string;
}

export interface SetApproval {
  shots: Shot[];
  // Over the WHOLE set: order included, because two shots swapped is a different video.
  setSha256: string;
  workspaceId: string;
  workspaceNamed: boolean;
  estimatedCredits: number;
  approvedAt: number;
}

export function setPathFor(key: string): string {
  return join(runDirFor(key), '.fabric-pending-set.json');
}

// The key a shot runs under. Derived, never taken from input, so a shot id cannot escape the run dir.
export function shotKey(setKey: string, id: string): string {
  return `${setKey}-${id}`;
}

export function hashSet(shots: Shot[]): string {
  const canonical = JSON.stringify(
    shots.map((s) => ({ id: s.id, script: s.script, character: s.character ?? null, image: s.image ?? null, voice: s.voice ?? null })),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

export function parseShots(raw: string): Shot[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`the shots file is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('the shots file must be a non-empty array');

  const seen = new Set<string>();
  return parsed.map((entry, i) => {
    const s = entry as Partial<Shot>;
    const id = s.id ?? String(i + 1);
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`shot ${i + 1}: id "${id}" must be letters, digits, dot, dash or underscore`);
    if (seen.has(id)) throw new Error(`shot ${i + 1}: duplicate id "${id}" — ids name run directories, so they must differ`);
    seen.add(id);
    if (s.character && s.image) throw new Error(`shot ${id}: give a character or an image, not both`);
    return {
      id,
      script: assertNonEmptyScript(String(s.script ?? '')),
      ...(s.character ? { character: s.character } : {}),
      ...(s.image ? { image: s.image } : {}),
      ...(s.voice ? { voice: s.voice } : {}),
    };
  });
}

// Priced shot by shot at each shot's own voice rate, then summed — a set can mix a measured voice with an
// unmeasured one, and averaging them would quote a figure that is right for neither. `low`/`high` are the
// spread across known speaking rates, carried so the approval can say how firm the total is.
export function estimateSet(
  shots: Shot[],
  defaults: { voice: string } = { voice: '' },
  rates: VoiceRates = SEEDED_RATES,
): { credits: number; low: number; high: number; allMeasured: boolean } {
  const spread = rateRange(rates);
  let credits = 0;
  let low = 0;
  let high = 0;
  let allMeasured = true;
  for (const shot of shots) {
    const { charsPerSecond, samples } = resolveRate(shot.voice ?? defaults.voice, rates);
    if (samples === null) allMeasured = false;
    // Each shot is a separate generation, so its speech rounds up to its own whole minute — priced per
    // shot and summed, never as one pooled duration.
    credits += estimateTotalCredits(shot.script, charsPerSecond);
    const range = estimateRange(shot.script, spread);
    low += range.low;
    high += range.high;
  }
  return { credits, low, high, allMeasured };
}

// Every way a stored set approval can fail to cover what is about to be spent. Each is a refusal, never
// a warning: the whole point of the record is that nobody is billed for something they did not see.
export function assertCovers(approval: SetApproval, shots: Shot[], nowMs: number, maxAgeMs: number): void {
  if (hashSet(shots) !== approval.setSha256) {
    throw new Error(
      'refusing to spend: the shots no longer match the set that was approved — a script, an image, an ' +
      'order or a voice has changed. Nothing spent. Re-run the confirm pass and approve the new figure.',
    );
  }
  // Guard the timestamp before doing arithmetic on it — a missing/non-finite approvedAt makes `age` NaN,
  // and the age-based message would otherwise read "NaN minutes old", which names no actionable reason.
  if (!Number.isFinite(approval.approvedAt)) {
    throw new Error(
      'refusing to spend: the approval has no valid timestamp — the pending set record is corrupt. ' +
      'Nothing spent. Re-run the confirm pass and approve a fresh figure.',
    );
  }
  const age = nowMs - approval.approvedAt;
  if (age < 0 || age > maxAgeMs) {
    throw new Error(
      `refusing to spend: the approval is ${Math.round(age / 60_000)} minutes old. Nothing spent. ` +
      'Re-run the confirm pass and approve a fresh figure.',
    );
  }
}

// Expands the ONE approval into the per-shot approval each run consumes. These files are not a second
// question — they are what the answer already given means, written where the single-shot engine reads it.
export function pendingForShot(
  approval: SetApproval,
  shot: Shot,
  defaults: { character: string; voice: string },
  rates: VoiceRates = SEEDED_RATES,
): PendingConfirmation {
  const voiceId = shot.voice ?? defaults.voice;
  // The SAME rate the single-shot engine will re-derive when it re-confirms this pending. Priced any
  // other way, its "you approved N but the quote is now M" guard fires on every shot of every set.
  const { charsPerSecond } = resolveRate(voiceId, rates);
  return {
    script: shot.script,
    scriptSha256: scriptHash(shot.script),
    characterId: shot.character ?? defaults.character,
    ...(shot.image ? { image: shot.image } : {}),
    voiceId,
    workspaceId: approval.workspaceId,
    workspaceNamed: approval.workspaceNamed,
    estimatedCredits: estimateTotalCredits(shot.script, charsPerSecond),
    approvedAt: approval.approvedAt,
  };
}

export interface SetResult {
  status: 'confirmed' | 'generated' | 'no-token' | 'workspace-required';
  credits?: number;
  clips?: string[];
}

export async function runSet(
  args: { key: string; shots?: Shot[]; workspace?: string; yes: boolean; character: string; voice: string },
  deps: GenerateDeps,
  maxAgeMs = 60 * 60_000,
): Promise<SetResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  // Both default the same way generate.ts does, so a set and a single shot agree about time.
  const now = deps.now ?? Date.now;
  const setPath = setPathFor(args.key);
  // The same learned rates the single-shot engine reads, so a set and a shot quote the same script alike.
  const rates = parseVoiceRates(await deps.readState(DEFAULT_VOICE_RATES_PATH));

  if (!args.yes) {
    if (!args.shots) throw new Error('the confirm pass needs --shots <file.json>');
    const shots = args.shots;
    const { credits, low, high, allMeasured } = estimateSet(shots, { voice: args.voice }, rates);

    // One block, one figure, one yes. The per-shot lines are there so nobody approves a total without
    // seeing what makes it up.
    log(
      [
        `[fabric] ${shots.length} shots in one approval`,
        ...shots.map((s) => {
          const who = s.image ? `your image (${s.image})` : (s.character ?? args.character);
          const { charsPerSecond, samples } = resolveRate(s.voice ?? args.voice, rates);
          const basis = samples === null ? 'estimated rate' : `${samples} run${samples === 1 ? '' : 's'} of this voice`;
          return `  ${s.id.padEnd(10)} ~${estimateTotalCredits(s.script, charsPerSecond)} credits · ${s.script.length} chars · ${who} · ${basis}`;
        }),
        `  ${'TOTAL'.padEnd(10)} ~${credits} AI Playground credits`,
        // Cost follows the finished DURATION, and speaking rate decides that. Where a voice has never been
        // measured the total is a lean-slow guess, so the spread it could land in is stated rather than
        // implied by a tilde.
        ...(allMeasured
          ? []
          : [`  ${''.padEnd(10)} some voices here have never been measured — expect ${low}-${high} credits`]),
      ].join('\n'),
    );

    // Written only after the block is printed: an approval that exists before the user has seen what it
    // covers is an approval for nothing.
    const approval: SetApproval = {
      shots,
      setSha256: hashSet(shots),
      workspaceId: args.workspace ?? '',
      workspaceNamed: Boolean(args.workspace),
      estimatedCredits: credits,
      approvedAt: now(),
    };
    await deps.writeState(setPath, `${JSON.stringify(approval, null, 2)}\n`);
    log(`\nNothing spent. To approve ${credits} credits and generate all ${shots.length}, run exactly:\n\n  node --import tsx veed/generate-set.ts --key ${args.key} --yes\n`);
    return { status: 'confirmed', credits };
  }

  const raw = await deps.readState(setPath);
  if (raw === null) {
    throw new Error(
      `no approved set for --key ${args.key}. Run the confirm pass first (it spends nothing):\n` +
      `  node --import tsx veed/generate-set.ts --shots <file.json> --key ${args.key}`,
    );
  }
  const approval = JSON.parse(raw) as SetApproval;
  assertCovers(approval, approval.shots, now(), maxAgeMs);

  const clips: string[] = [];
  for (const shot of approval.shots) {
    const key = shotKey(args.key, shot.id);
    // The set approval, expanded where the single-shot engine looks for it. Everything below this line
    // is the existing per-shot path, with every guarantee it already had.
    await deps.writeState(
      pendingPathFor(key),
      `${JSON.stringify(pendingForShot(approval, shot, { character: args.character, voice: args.voice }, rates), null, 2)}\n`,
    );
    log(`[fabric] shot ${shot.id} →`);
    const result = await run(
      { key, character: args.character, voice: args.voice, workspace: approval.workspaceId, yes: true, resume: false },
      deps,
    );
    if (result.status !== 'generated') return { status: result.status as SetResult['status'], clips };
    clips.push(join(runDirFor(key), `${key}.mp4`));
  }

  // Spent: the approval is gone, so one yes buys one set — the same rule a single shot follows.
  await deps.removeState(setPath);
  log(`\n[fabric] ${clips.length} clips generated. Join them with:\n  node --import tsx pipeline/scripts/concat-videos.ts ${join(runDirFor(args.key), `${args.key}.mp4`)} ${clips.join(' ')}`);
  return { status: 'generated', clips };
}

async function main(): Promise<void> {
  const { parseArgs, realDeps } = await import('./generate.ts');
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--shots');
  if (at !== -1 && (at + 1 >= argv.length || argv[at + 1].startsWith('--'))) {
    throw new Error('flag --shots requires a value: the path to a shots JSON file');
  }
  const shotsFile = at === -1 ? undefined : argv[at + 1];
  // --shots is handled here and removed; everything left is handed to the single-shot parser, which is
  // strict and will name any other unknown flag.
  const rest = at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)];
  // parseArgs wants a script on a confirm pass and REFUSES one alongside --yes; a set keeps its
  // scripts in the shots file, so the placeholder is supplied only where the parser insists on it.
  const spending = rest.includes('--yes');
  const args = parseArgs(spending || rest.includes('--script') ? rest : [...rest, '--script', 'set']);
  const shots = shotsFile ? parseShots(await readFile(shotsFile, 'utf8')) : undefined;
  const result = await runSet({ ...args, shots }, realDeps());
  if (result.status === 'workspace-required' || result.status === 'no-token') process.exit(1);
}

if (process.argv[1]?.endsWith('generate-set.ts')) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
