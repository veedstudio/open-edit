// Proposes ONE Fabric character + voice, so nobody has to read 24 thumbnails and 588 voice rows to start.
// Deterministic like its sibling pipeline/scripts/sample-style.ts, and it shares that file's seeding idiom.
// It lives in veed/ rather than pipeline/scripts/ because it needs the VEED login and the VEED API.
//
//   node --import tsx veed/sample-presenter.ts [--key <run>] [--seed N] [--gender male|female]
//                                              [--locale en] [--portrait | --landscape]
//
// It PROPOSES, it does not decide: it writes nothing generate.ts reads, spends nothing (the two list tools
// are free), and ends with the exact generate.ts command carrying the pair — the user overrules it by
// re-rolling with --seed, or by editing the ids in that command. Which workspace pays is still generate.ts's
// question to ask, so no workspace flag is invented here.
import { pathToFileURL } from 'node:url';
import { seedFromKey, mulberry32 } from '../pipeline/scripts/sample-style.ts';
import { VEED_ORIGIN } from './api.ts';
import { assertSafeKey, parseFlags } from './args.ts';
import type { FabricCharacter, FabricVoice } from './fabric.ts';
import { framingOf, listCharacters, listVoices } from './fabric.ts';
import type { VeedHttp } from './api.ts';
import { realHttp } from './http.ts';
import { DEFAULT_TOKEN_PATH, resolveToken } from './token-store.ts';

// generate.ts's own default, so the proposal and the command it prints agree when no --key is given.
const DEFAULT_KEY = 'generated';
// English unless asked otherwise: list_voices REQUIRES a locale, and 588 English voices already outnumber
// what anyone will audition.
export const DEFAULT_LOCALE = 'en';
const ALTERNATES = 3;

export type Framing = 'portrait' | 'landscape' | 'any';

export interface PresenterPool {
  characters: FabricCharacter[];
  voices: FabricVoice[];
}

export interface PresenterOptions {
  key?: string;
  seed?: number;
  gender?: 'male' | 'female';
  locale?: string;
  framing?: Framing;
}

export interface PresenterProposal {
  character: FabricCharacter;
  voice: FabricVoice;
  seed: number;
  framing: Framing;
  locale: string;
  // What the pick was drawn FROM, so the output can say how much was ruled out by the filters.
  pool: { characters: number; voices: number };
  // Runners-up the user can overrule the proposal with, by eye (thumbnails) and by ear (previews).
  alternates: { characters: FabricCharacter[]; voices: FabricVoice[] };
}

// Voice gender is capitalised server-side ('Female' | 'Male' | 'Neutral'); character gender is not.
function voiceGenderFor(gender: 'male' | 'female'): 'Male' | 'Female' {
  return gender === 'male' ? 'Male' : 'Female';
}

// 'en' matches every English voice, 'en-IE' only the Irish ones — the same prefix rule list_voices uses.
function matchesLocale(voice: FabricVoice, locale: string): boolean {
  const want = locale.toLowerCase();
  const have = voice.locale.toLowerCase();
  return have === want || have.startsWith(`${want}-`);
}

export function eligibleCharacters(characters: FabricCharacter[], opts: PresenterOptions = {}): FabricCharacter[] {
  const framing = opts.framing ?? 'any';
  return characters
    .filter((c) => (opts.gender ? c.gender === opts.gender : true))
    // Framing is a property of the character (Fabric has no aspectRatio parameter), read live off the
    // thumbnail rather than from a list that goes stale the next time VEED ships a character.
    .filter((c) => (framing === 'any' ? true : framingOf(c) === framing))
    // Sorted so the draw depends on the listing's CONTENT, not on the order the server happened to return.
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function eligibleVoices(voices: FabricVoice[], opts: PresenterOptions = {}): FabricVoice[] {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const gender = opts.gender ? voiceGenderFor(opts.gender) : undefined;
  return voices
    .filter((v) => matchesLocale(v, locale))
    .filter((v) => (gender ? v.gender.toLowerCase() === gender.toLowerCase() : true))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Draws `n` DISTINCT items from one PRNG stream: an alternate that repeats the pick is not an alternative.
function drawDistinct<T>(pool: T[], rnd: () => number, n: number): T[] {
  const remaining = [...pool];
  const out: T[] = [];
  while (out.length < n && remaining.length > 0) {
    out.push(...remaining.splice(Math.floor(rnd() * remaining.length), 1));
  }
  return out;
}

export function samplePresenter(pool: PresenterPool, opts: PresenterOptions = {}): PresenterProposal {
  const framing = opts.framing ?? 'any';
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const characters = eligibleCharacters(pool.characters, opts);
  const voices = eligibleVoices(pool.voices, opts);
  // Naming the filter that emptied the pool: proposing something outside it would quietly hand the user a
  // presenter they explicitly ruled out.
  if (characters.length === 0) {
    throw new Error(`no character matches those filters (gender=${opts.gender ?? 'any'}, framing=${framing}) — drop one and re-run`);
  }
  if (voices.length === 0) {
    throw new Error(`no voice matches those filters (locale=${locale}, gender=${opts.gender ?? 'any'}) — try a broader --locale`);
  }

  const seed = opts.seed ?? seedFromKey(opts.key ?? DEFAULT_KEY);
  // One stream for both halves: a seed reproduces the PAIR, not either side of it.
  const rnd = mulberry32(seed);
  const [character, ...altCharacters] = drawDistinct(characters, rnd, 1 + ALTERNATES);
  const [voice, ...altVoices] = drawDistinct(voices, rnd, 1 + ALTERNATES);

  return {
    character,
    voice,
    seed,
    framing,
    locale,
    pool: { characters: characters.length, voices: voices.length },
    alternates: { characters: altCharacters, voices: altVoices },
  };
}

// A server that always hands back a cursor would otherwise page forever; 'en' alone is 24 pages of 25.
const MAX_VOICE_PAGES = 60;

// The ONLY two tools this script may reach for. Both are free reads: nothing here can spend a credit,
// create a job, or leave state behind.
export async function collectPresenterPool(
  client: VeedHttp, opts: { locale?: string; gender?: 'male' | 'female' } = {},
): Promise<PresenterPool> {
  const characters = await listCharacters(client, opts.gender);
  const voices: FabricVoice[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_VOICE_PAGES; page += 1) {
    const got = await listVoices(client, {
      locale: opts.locale ?? DEFAULT_LOCALE,
      ...(opts.gender ? { gender: voiceGenderFor(opts.gender) } : {}),
      ...(cursor ? { cursor } : {}),
    });
    voices.push(...got.voices);
    if (!got.nextCursor) break;
    cursor = got.nextCursor;
  }
  return { characters, voices };
}

export function generateCommand(proposal: PresenterProposal, key: string): string {
  // The script is the one thing this cannot propose, so it stays a placeholder the user replaces — and the
  // command it belongs to is the CONFIRM pass, which quotes a cost and spends nothing.
  return 'node --import tsx veed/generate.ts --script "<your script>" ' +
    `--key ${key} --character ${proposal.character.id} --voice ${proposal.voice.id}`;
}

// Alternates are meant to be SCANNED — ragged ids and names make three rows read like thirty.
function columnPadder(rows: string[][]): (row: string[]) => string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return (row) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ');
}

export function formatProposal(proposal: PresenterProposal, key: string): string {
  const { character, voice, alternates, pool } = proposal;
  const lines = [
    `[sample-presenter] proposing 1 of ${pool.characters} characters x ${pool.voices} voices ` +
    `(seed=${proposal.seed}, locale=${proposal.locale}, framing=${proposal.framing})`,
    `  character  ${character.id}  ${character.name}  ${character.gender}  ${framingOf(character)}`,
    `             ${character.thumbnail}`,
    `  voice      ${voice.id}  ${voice.name}  ${voice.localeLabel}  ${voice.gender}`,
    `             ${voice.previewAudioUrl}`,
  ];
  if (alternates.characters.length) {
    const pad = columnPadder(alternates.characters.map((c) => [c.id, c.name, c.gender]));
    lines.push('  other characters (look):');
    for (const c of alternates.characters) {
      lines.push(`    ${pad([c.id, c.name, c.gender])}  ${framingOf(c)}  ${c.thumbnail}`);
    }
  }
  if (alternates.voices.length) {
    const pad = columnPadder(alternates.voices.map((v) => [v.id, v.name, v.localeLabel, v.gender]));
    lines.push('  other voices (listen):');
    for (const v of alternates.voices) {
      lines.push(`    ${pad([v.id, v.name, v.localeLabel, v.gender])}  ${v.previewAudioUrl}`);
    }
  }
  lines.push(
    '',
    '  This is a proposal, not a decision: nothing was written and nothing was chosen for you. Listing',
    '  characters and voices costs 0 credits, so re-running this is always free. Re-roll with --seed N,',
    '  narrow with --gender/--locale/--portrait/--landscape, or just edit the two ids below.',
    '',
    generateCommand(proposal, key),
  );
  return lines.join('\n');
}

const USAGE = 'usage: node --import tsx veed/sample-presenter.ts [--key <run>] [--seed N] [--gender male|female] [--locale <locale>] [--portrait|--landscape]';

const OPTIONS = {
  key: { type: 'string' },
  seed: { type: 'string' },
  gender: { type: 'string' },
  locale: { type: 'string' },
  portrait: { type: 'boolean' },
  landscape: { type: 'boolean' },
} as const;

// Shares the strict parseFlags every entry point uses (veed/args.ts) rather than a second hand-rolled reader
// that can drift from it: an unknown or misspelled flag, or a --seed with no value, is an error, not a silent
// miss. --key gets the same safe-key guard generate.ts uses, since it ends up in the confirm command run next.
export function parsePresenterArgs(argv: string[]): PresenterOptions {
  const { values } = parseFlags({ args: argv, options: OPTIONS });

  const key = assertSafeKey(values.key ?? DEFAULT_KEY);

  let seed: number | undefined;
  if (values.seed !== undefined) {
    seed = Number(values.seed);
    if (!Number.isFinite(seed)) throw new Error(`--seed must be a number, got "${values.seed}"`);
  }

  const gender = values.gender;
  if (gender !== undefined && gender !== 'male' && gender !== 'female') {
    throw new Error(`--gender must be male or female, got "${gender}"\n${USAGE}`);
  }

  if (values.portrait && values.landscape) {
    throw new Error(`--portrait and --landscape are opposites; pass at most one\n${USAGE}`);
  }
  const framing: Framing = values.portrait ? 'portrait' : values.landscape ? 'landscape' : 'any';

  return { key, seed, gender, locale: values.locale ?? DEFAULT_LOCALE, framing };
}

async function main(): Promise<void> {
  let opts: PresenterOptions;
  try {
    opts = parsePresenterArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  }

  const token = await resolveToken({
    envToken: process.env.VEED_ACCESS_TOKEN, tokenPath: DEFAULT_TOKEN_PATH, expectedOrigin: VEED_ORIGIN,
  });
  if (!token) {
    console.error(
      [
        'No VEED login found. Log in once (the same login Fabric generation uses):',
        '',
        '  node --import tsx veed/login.ts',
        '',
        'It stores a refreshable token, owner-only, at',
        `  ${DEFAULT_TOKEN_PATH}`,
      ].join('\n'),
    );
    process.exit(1);
  }

  const client = realHttp(token);
  const pool = await collectPresenterPool(client, { locale: opts.locale, gender: opts.gender });
  console.log(formatProposal(samplePresenter(pool, opts), opts.key ?? DEFAULT_KEY));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
