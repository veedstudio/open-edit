// Proposes ONE Fabric character + voice, so nobody has to read 24 thumbnails and 588 voice rows to start.
// Deterministic like its sibling pipeline/scripts/sample-style.ts, and it shares that file's seeding idiom.
// It lives in veed/ rather than pipeline/scripts/ because it needs the VEED login and the VEED API.
//
//   npx @veedstudio/openedit-cli sample-presenter [--key <run>] [--seed N] [--gender male|female]
//                                              [--locale en] [--portrait | --landscape]
//
// It PROPOSES, it does not decide: it writes nothing generate.ts reads, spends nothing (the two list tools
// are free), and ends with the exact generate.ts command carrying the pair — the user overrules it by
// re-rolling with --seed, or by editing the ids in that command.
//
// Which workspace pays is still generate.ts's question to ask, so no workspace flag is invented here.
//
// The face is drawn first and the voice from what suits it, so a mismatched pair is not reachable.
import { seedFromKey, mulberry32 } from '../seeded-random.ts';
import { assertSafeKey, parseUsage, usageLine, type Usage } from '../args.ts';
import type { FabricCharacter, FabricVoice } from '../veed/fabric.ts';
import { framingOf, listAllVoices, listCharacters, voiceSuitsFace } from '../veed/fabric.ts';
import type { VeedHttp } from '../veed/api.ts';
import { realHttp } from '../veed/http.ts';
import { resolveVeedToken } from '../veed/resolve-token.ts';

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

// Alternates travel as PAIRS: two lists would let a user take the face from one and the voice from the other.
export interface PresenterPair {
  character: FabricCharacter;
  voice: FabricVoice;
}

export interface PresenterProposal {
  character: FabricCharacter;
  voice: FabricVoice;
  seed: number;
  framing: Framing;
  locale: string;
  // Not two independent axes: `voices` are those suiting the character that won.
  pool: { characters: number; voices: number };
  // Runners-up the user can overrule the proposal with, by eye (thumbnails) and by ear (previews).
  // `voices` are alternatives for the CHOSEN face; `pairs` swap the whole presenter.
  alternates: { pairs: PresenterPair[]; voices: FabricVoice[] };
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

export function eligibleVoices(
  voices: FabricVoice[],
  opts: { locale?: string; faceGender?: 'male' | 'female' } = {},
): FabricVoice[] {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  return voices
    .filter((v) => matchesLocale(v, locale))
    .filter((v) => (opts.faceGender ? voiceSuitsFace(v, opts.faceGender) : true))
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
  const matching = eligibleCharacters(pool.characters, opts);
  // Naming the filter that emptied the pool: proposing something outside it would quietly hand the user a
  // presenter they explicitly ruled out.
  if (matching.length === 0) {
    throw new Error(`no character matches those filters (gender=${opts.gender ?? 'any'}, framing=${framing}) — drop one and re-run`);
  }

  // Filtered and sorted ONCE; every per-face pool below is a cheap filter over this.
  const localeVoices = eligibleVoices(pool.voices, { locale });
  const voicesFor = (face: FabricCharacter): FabricVoice[] =>
    localeVoices.filter((v) => voiceSuitsFace(v, face.gender));

  // Drawing a face first and refusing afterwards failed the whole run on the luck of the seed.
  const characters = matching.filter((c) => localeVoices.some((v) => voiceSuitsFace(v, c.gender)));
  if (characters.length === 0) {
    throw new Error(`no voice in locale=${locale} suits any matching character — try a broader --locale`);
  }

  const seed = opts.seed ?? seedFromKey(opts.key ?? DEFAULT_KEY);
  // One stream for both halves: a seed reproduces the PAIR, not either side of it.
  const rnd = mulberry32(seed);
  const [character, ...altCharacters] = drawDistinct(characters, rnd, 1 + ALTERNATES);
  const voices = voicesFor(character);
  const [voice, ...altVoices] = drawDistinct(voices, rnd, 1 + ALTERNATES);

  // Preferring one not already on screen: a repeated voice reads as though nothing changed.
  const shown = new Set([voice.id, ...altVoices.map((v) => v.id)]);
  const pairs: PresenterPair[] = altCharacters.map((alt) => {
    const all = voicesFor(alt);
    const spare = all.filter((v) => !shown.has(v.id));
    const picked = drawDistinct(spare.length ? spare : all, rnd, 1)[0];
    shown.add(picked.id);
    return { character: alt, voice: picked };
  });

  return {
    character,
    voice,
    seed,
    framing,
    locale,
    pool: { characters: characters.length, voices: voices.length },
    alternates: { pairs, voices: altVoices },
  };
}

// The ONLY two tools this script may reach for. Both are free reads: nothing here can spend a credit,
// create a job, or leave state behind.
export async function collectPresenterPool(
  client: VeedHttp, opts: { locale?: string; gender?: 'male' | 'female' } = {},
): Promise<PresenterPool> {
  const characters = await listCharacters(client, opts.gender);
  // Not pushed down: the listing filters on the voice's own gender and would drop Neutral before the draw.
  const voices = await listAllVoices(client, { locale: opts.locale ?? DEFAULT_LOCALE });
  return { characters, voices };
}

export function generateCommand(proposal: PresenterProposal, key: string): string {
  // The script is the one thing this cannot propose, so it stays a placeholder the user replaces — and the
  // command it belongs to is the CONFIRM pass, which quotes a cost and spends nothing.
  return 'npx @veedstudio/openedit-cli generate --script "<your script>" ' +
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
    `[sample-presenter] proposing 1 of ${pool.characters} characters; ${pool.voices} voices suit ` +
    `${character.id} (seed=${proposal.seed}, locale=${proposal.locale}, framing=${proposal.framing})`,
    `  character  ${character.id}  ${character.name}  ${character.gender}  ${framingOf(character)}`,
    `             ${character.thumbnail}`,
    `  voice      ${voice.id}  ${voice.name}  ${voice.localeLabel}  ${voice.gender}`,
    `             ${voice.previewAudioUrl}`,
  ];
  if (alternates.pairs.length) {
    const pad = columnPadder(alternates.pairs.map((p) => [p.character.id, p.character.name, p.character.gender]));
    lines.push('  other presenters — swap the whole row, the voice already suits the face:');
    for (const { character: c, voice: v } of alternates.pairs) {
      lines.push(`    ${pad([c.id, c.name, c.gender])}  ${framingOf(c)}  ${c.thumbnail}`);
      lines.push(`      with  ${v.id}  ${v.name}  ${v.localeLabel}  ${v.gender}  ${v.previewAudioUrl}`);
    }
  }
  if (alternates.voices.length) {
    const pad = columnPadder(alternates.voices.map((v) => [v.id, v.name, v.localeLabel, v.gender]));
    lines.push(`  other voices for ${character.id} (listen):`);
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

export const usage = {
  summary: 'Seeded, deterministic Fabric presenter proposal for a run key',
  flags: {
    key: { type: 'string', value: '<run>', help: `Run key the proposal is for (default ${DEFAULT_KEY})` },
    seed: { type: 'string', value: 'N', help: 'Seed for the draw; the same seed proposes the same presenter' },
    gender: { type: 'string', value: 'male|female', help: 'Narrow the draw to one gender' },
    locale: { type: 'string', value: '<locale>', help: `Narrow the draw to voices of a locale (default ${DEFAULT_LOCALE})` },
    portrait: { type: 'boolean', help: 'Portrait framing only; opposite of --landscape' },
    landscape: { type: 'boolean', help: 'Landscape framing only; opposite of --portrait' },
  },
} satisfies Usage;

const USAGE = usageLine('sample-presenter', usage);

// Shares the strict parser every entry point uses rather than a second hand-rolled reader
// that can drift from it: an unknown or misspelled flag, or a --seed with no value, is an error, not a silent
// miss. --key gets the same safe-key guard generate.ts uses, since it ends up in the confirm command run next.
export function parsePresenterArgs(argv: string[]): PresenterOptions {
  const { values } = parseUsage('sample-presenter', usage, argv);

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

export async function samplePresenterCommand(argv: string[]): Promise<number> {
  let opts: PresenterOptions;
  try {
    opts = parsePresenterArgs(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    return 2;
  }

  const token = await resolveVeedToken();
  if (!token) {
    console.error(
      [
        'No VEED login found. Log in once (the same login Fabric generation uses):',
        '',
        '  npx @veedstudio/openedit-cli login',
        '',
        'It stores a refreshable token, owner-only, in the',
        "CLI's app-data directory (npx @veedstudio/openedit-cli token --path prints where).",
      ].join('\n'),
    );
    return 1;
  }

  const client = realHttp(token);
  const pool = await collectPresenterPool(client, { locale: opts.locale, gender: opts.gender });
  console.log(formatProposal(samplePresenter(pool, opts), opts.key ?? DEFAULT_KEY));
  return 0;
}
