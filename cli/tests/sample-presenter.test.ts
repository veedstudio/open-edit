// Tests for veed/sample-presenter.ts: the selection, seeding and filtering, driven with injected listings
// so nothing touches the network and nothing is ever proposed by accident.
//   Run:  node --import tsx tests/sample-presenter.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FabricCharacter, FabricVoice } from '../src/veed/fabric.ts';
import { isPortraitThumbnail } from '../src/veed/fabric.ts';
import type { VeedHttp } from '../src/veed/api.ts';
import {
  collectPresenterPool, formatProposal, generateCommand, parsePresenterArgs, samplePresenter,
} from '../src/commands/sample-presenter.ts';

// Shaped exactly like the live list_characters rows: portrait characters carry `_P_` in the thumbnail path.
const CHARACTERS: FabricCharacter[] = [
  { id: 'character-1', name: 'Character 1', thumbnail: 'https://cdn/1_P_bd7b69e369/1_P_bd7b69e369.jpg', gender: 'female' },
  { id: 'character-2', name: 'Character 2', thumbnail: 'https://cdn/2_bdeae28943/2_bdeae28943.jpg', gender: 'female' },
  { id: 'character-3', name: 'Character 3', thumbnail: 'https://cdn/3_094c5d0d71/3_094c5d0d71.jpg', gender: 'male' },
  { id: 'character-6', name: 'Character 6', thumbnail: 'https://cdn/6_P_c69c4ddae8/6_P_c69c4ddae8.jpg', gender: 'male' },
  { id: 'character-9', name: 'Character 9', thumbnail: 'https://cdn/9_e1269440e8/9_e1269440e8.jpg', gender: 'male' },
  { id: 'character-11', name: 'Character 11', thumbnail: 'https://cdn/11_P_f99954fcfe/11_P_f99954fcfe.jpg', gender: 'male' },
  { id: 'character-14', name: 'Character 14', thumbnail: 'https://cdn/14_P_3fa580b86a/14_P_3fa580b86a.jpg', gender: 'female' },
  { id: 'character-15', name: 'Character 15', thumbnail: 'https://cdn/15_P_7d44dcb0df/15_P_7d44dcb0df.jpg', gender: 'female' },
  { id: 'character-16', name: 'Character 16', thumbnail: 'https://cdn/16_674d899465/16_674d899465.jpg', gender: 'male' },
  { id: 'character-17', name: 'Character 17', thumbnail: 'https://cdn/17_P_96b8bf3cb0/17_P_96b8bf3cb0.jpg', gender: 'female' },
  { id: 'character-20', name: 'Character 20', thumbnail: 'https://cdn/20_66526d0e4f/20_66526d0e4f.jpg', gender: 'female' },
  { id: 'character-22', name: 'Character 22', thumbnail: 'https://cdn/22_031ba9ca51/22_031ba9ca51.png', gender: 'male' },
];

const voice = (id: string, name: string, locale: string, gender: string): FabricVoice => ({
  id, name, locale, localeLabel: locale, gender,
  previewAudioUrl: `https://www.veed.io/api/v1/subtitles/synthesize/preview?voice=${id}&rate=1&locale=${locale}`,
});

const VOICES: FabricVoice[] = [
  voice('en-CA-ClaraNeural', 'Clara', 'en-CA', 'Female'),
  voice('en-CA-LiamNeural', 'Liam', 'en-CA', 'Male'),
  voice('en-KE-AsiliaNeural', 'Asilia', 'en-KE', 'Female'),
  voice('en-KE-ChilembaNeural', 'Chilemba', 'en-KE', 'Male'),
  voice('wkqe33083YLBV35we7yB', 'River', 'en-US', 'Female'),
  voice('kOvUpYLYS0rKGldsKcD1', 'Maeve', 'en-IE', 'Female'),
  voice('C92s6vssSLlabgIln1iY', 'Michelle', 'en-IE', 'Female'),
  voice('ryziVMdpAaocEG81oDcg', 'Andre', 'en-ZA', 'Male'),
  voice('G9SfCJxnowNWgbS9QcKS', 'Ahmed', 'en-ZA', 'Male'),
  voice('d0NpsluCMIhcxftWaNBW', 'Danielle', 'en-ZA', 'Female'),
  voice('jR3bzi2Q3ZUoDWJpZUlS', 'Exafrika', 'en-ZA', 'Neutral'),
  voice('de-DE-KatjaNeural', 'Katja', 'de-DE', 'Female'),
  voice('de-DE-ConradNeural', 'Conrad', 'de-DE', 'Male'),
  voice('fr-FR-DeniseNeural', 'Denise', 'fr-FR', 'Female'),
  // Appended, not inserted: earlier tests index into this array by position.
  // Live en-IE carries both genders; a single-gender locale would otherwise be the only case tested.
  voice('en-IE-ConnorNeural', 'Connor', 'en-IE', 'Male'),
  voice('en-IE-SeanNeural', 'Sean', 'en-IE', 'Male'),
];

const POOL = { characters: CHARACTERS, voices: VOICES };

const pairOf = (p: { character: FabricCharacter; voice: FabricVoice }): string => `${p.character.id}/${p.voice.id}`;

await test('the same seed proposes the same pair', () => {
  assert.equal(pairOf(samplePresenter(POOL, { seed: 7 })), pairOf(samplePresenter(POOL, { seed: 7 })));
});

await test('the same --key proposes the same pair, and a different key a different one', () => {
  // One run keeps one presenter: re-running for the same key must not swap the face mid-project.
  assert.equal(pairOf(samplePresenter(POOL, { key: 'promo' })), pairOf(samplePresenter(POOL, { key: 'promo' })));
  const keys = ['promo', 'launch', 'hook-042', 'monday-test', 'demo-2', 'tuesday'];
  const pairs = new Set(keys.map((key) => pairOf(samplePresenter(POOL, { key }))));
  assert.ok(pairs.size >= 2, `${keys.length} keys proposed ${pairs.size} distinct pairs`);
});

await test('a different seed proposes a different pair, so alternatives can be browsed', () => {
  const pairs = new Set([1, 2, 3, 4, 5, 6, 7].map((seed) => pairOf(samplePresenter(POOL, { seed }))));
  assert.ok(pairs.size >= 2, `7 seeds proposed ${pairs.size} distinct pairs`);
  assert.notEqual(pairOf(samplePresenter(POOL, { seed: 1 })), pairOf(samplePresenter(POOL, { seed: 2 })));
});

await test('--portrait only ever proposes a portrait-thumbnail character, alternates included', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const p = samplePresenter(POOL, { seed, framing: 'portrait' });
    assert.ok(isPortraitThumbnail(p.character.thumbnail), `seed ${seed} proposed ${p.character.id}`);
    for (const { character: alt } of p.alternates.pairs) assert.ok(isPortraitThumbnail(alt.thumbnail), `alternate ${alt.id}`);
  }
});

await test('--landscape never proposes a portrait-thumbnail character', () => {
  // A deliberately portrait-heavy pool (5 of 6): an unfiltered draw would land portrait most of the time.
  const heavy = { characters: CHARACTERS.filter((c) => isPortraitThumbnail(c.thumbnail) || c.id === 'character-2'), voices: VOICES };
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const p = samplePresenter(heavy, { seed, framing: 'landscape' });
    assert.equal(isPortraitThumbnail(p.character.thumbnail), false, `seed ${seed} proposed ${p.character.id}`);
  }
});

await test('--gender narrows the characters, and the voice follows the face it was drawn for', () => {
  // --gender filters the FACE only; the voice is drawn from what suits the character that won.
  for (const seed of [1, 2, 3, 4, 5]) {
    const p = samplePresenter(POOL, { seed, gender: 'male' });
    assert.equal(p.character.gender, 'male');
    assert.ok(['Male', 'Neutral'].includes(p.voice.gender), `drew ${p.voice.name} [${p.voice.gender}]`);
    for (const { character: alt } of p.alternates.pairs) assert.equal(alt.gender, 'male');
    for (const alt of p.alternates.voices) assert.ok(['Male', 'Neutral'].includes(alt.gender), alt.name);
  }
});

// --- the voice must suit the face: the pair is drawn together, not as two independent picks ---

await test('the proposed voice suits the proposed face, with no --gender given', () => {
  // Drawn from two independent pools, a male face with a female voice was an ordinary draw.
  for (let seed = 1; seed <= 40; seed += 1) {
    const p = samplePresenter(POOL, { seed });
    const allowed = p.character.gender === 'male' ? ['Male', 'Neutral'] : ['Female', 'Neutral'];
    assert.ok(
      allowed.includes(p.voice.gender),
      `seed ${seed}: ${p.character.id} (${p.character.gender}) drew ${p.voice.name} [${p.voice.gender}]`,
    );
  }
});

await test('a Neutral voice suits either face, so a Neutral-only pool still proposes', () => {
  // Narrowing to the face's own gender alone would make every Neutral voice unreachable.
  const neutralOnly = VOICES.filter((v) => v.gender === 'Neutral');
  for (const gender of ['male', 'female'] as const) {
    const p = samplePresenter({ characters: CHARACTERS, voices: neutralOnly }, { seed: 1, gender });
    assert.equal(p.character.gender, gender);
    assert.equal(p.voice.gender, 'Neutral');
  }
});

await test('every alternate presenter pairs a face with a voice that suits it', () => {
  // Two independent lists put the mismatch one keystroke away: face from one, voice from the other.
  for (const seed of [1, 2, 3, 4, 5, 6, 7]) {
    const p = samplePresenter(POOL, { seed });
    assert.ok(p.alternates.pairs.length >= 1, `seed ${seed} offered no alternate presenter`);
    for (const alt of p.alternates.pairs) {
      const allowed = alt.character.gender === 'male' ? ['Male', 'Neutral'] : ['Female', 'Neutral'];
      assert.ok(
        allowed.includes(alt.voice.gender),
        `${alt.character.id} (${alt.character.gender}) + ${alt.voice.name} [${alt.voice.gender}]`,
      );
    }
  }
});

await test('the alternate voices all suit the chosen face, so any one is safe to swap in', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7]) {
    const p = samplePresenter(POOL, { seed });
    const allowed = p.character.gender === 'male' ? ['Male', 'Neutral'] : ['Female', 'Neutral'];
    for (const v of p.alternates.voices) {
      assert.ok(allowed.includes(v.gender), `${p.character.id} (${p.character.gender}) offered ${v.name} [${v.gender}]`);
    }
  }
});

await test('--locale narrows the voices and defaults to en', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const p = samplePresenter(POOL, { seed, locale: 'en-IE' });
    assert.equal(p.voice.locale, 'en-IE');
    // Default: English everywhere, so a de-DE or fr-FR voice never turns up unasked.
    assert.match(samplePresenter(POOL, { seed }).voice.locale, /^en(-|$)/);
  }
  assert.equal(samplePresenter(POOL, { seed: 1, locale: 'de' }).voice.locale, 'de-DE');
});

await test('a locale that can pair with no eligible face at all is refused, naming the locale', () => {
  // fr-FR carries only Denise [Female], so with --gender male nothing in the pool can pair.
  assert.throws(
    () => samplePresenter(POOL, { seed: 1, gender: 'male', locale: 'fr' }),
    /no voice in locale=fr suits any matching character/,
  );
});

await test('a locale that serves only one gender still proposes, instead of refusing on the seed', () => {
  // Drawing the face before its voice pool was known failed the run on the luck of the seed.
  const femaleOnly = VOICES.filter((v) => v.gender === 'Female' && v.locale.startsWith('en'));
  for (let seed = 1; seed <= 20; seed += 1) {
    const p = samplePresenter({ characters: CHARACTERS, voices: femaleOnly }, { seed });
    assert.equal(p.character.gender, 'female', `seed ${seed} drew a face with nothing to speak with`);
    assert.equal(p.voice.gender, 'Female');
  }
});

await test('no voice is shown twice while the pool still has spares', () => {
  // An alternate that repeats a voice already on screen reads as though nothing changed.
  for (const seed of [1, 2, 3, 4, 5, 6, 7]) {
    const p = samplePresenter(POOL, { seed });
    const shown = [p.voice.id, ...p.alternates.voices.map((v) => v.id), ...p.alternates.pairs.map((x) => x.voice.id)];
    assert.equal(new Set(shown).size, shown.length, `seed ${seed} repeated a voice: ${shown.join(', ')}`);
  }
});

await test('every character can be proposed, so no face is unreachable', () => {
  // Distinctness between two seeds says nothing about coverage of the pool.
  const seen = new Set<string>();
  for (let seed = 1; seed <= 400; seed += 1) seen.add(samplePresenter(POOL, { seed }).character.id);
  const missed = CHARACTERS.filter((c) => !seen.has(c.id)).map((c) => c.id);
  assert.deepEqual(missed, [], `never proposed in 400 draws: ${missed.join(', ')}`);
});

await test('a Neutral voice is reachable from a mixed pool, not merely permitted', () => {
  // The Neutral-only pool proves the rule admits one; this proves the draw can land on one. Live: 5 in 588.
  let found = false;
  for (let seed = 1; seed <= 400 && !found; seed += 1) {
    const p = samplePresenter(POOL, { seed });
    const onScreen = [p.voice, ...p.alternates.voices, ...p.alternates.pairs.map((x) => x.voice)];
    found = onScreen.some((v) => v.gender === 'Neutral');
  }
  assert.ok(found, 'no Neutral voice was proposed in 400 draws');
});

await test('when suitable voices run out an alternate repeats one, rather than disappearing', () => {
  // Dropping it would thin the list silently; a repeated voice still offers a different face.
  const faces = CHARACTERS.filter((c) => c.gender === 'female').slice(0, 4);
  const only = VOICES.filter((v) => v.id === 'kOvUpYLYS0rKGldsKcD1');
  const p = samplePresenter({ characters: faces, voices: only }, { seed: 1 });
  assert.equal(p.alternates.pairs.length, 3, 'every alternate face is still offered');
  for (const alt of p.alternates.pairs) assert.equal(alt.voice.id, 'kOvUpYLYS0rKGldsKcD1');
});

await test('an empty candidate pool is refused with the filter that emptied it, never a silent fallback', () => {
  assert.throws(() => samplePresenter(POOL, { locale: 'ja' }), /ja/);
  assert.throws(() => samplePresenter({ characters: [], voices: VOICES }), /character/i);
});

await test('alternates never duplicate the pick, and never each other', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7]) {
    const p = samplePresenter(POOL, { seed });
    const chars = [p.character.id, ...p.alternates.pairs.map((x) => x.character.id)];
    const voices = [p.voice.id, ...p.alternates.voices.map((v) => v.id)];
    assert.equal(new Set(chars).size, chars.length, `character alternates: ${chars.join(', ')}`);
    assert.equal(new Set(voices).size, voices.length, `voice alternates: ${voices.join(', ')}`);
    assert.ok(p.alternates.pairs.length >= 2 && p.alternates.pairs.length <= 3);
    assert.ok(p.alternates.voices.length >= 2 && p.alternates.voices.length <= 3);
  }
});

await test('alternates are as few as the pool allows rather than invented', () => {
  const tiny = { characters: CHARACTERS.slice(0, 2), voices: VOICES.slice(5, 7) };
  const p = samplePresenter(tiny, { seed: 3 });
  assert.equal(p.alternates.pairs.length, 1);
  assert.equal(p.alternates.voices.length, 1);
});

// --- the pool comes from the two FREE list tools and nothing else ---

// Serves ONLY the voice listing, from the fixtures above, and refuses every other route — so a call that
// could spend credits or change state shows up as a failure rather than as a mock. Characters are no
// longer a request at all (they are compiled in), which is why nothing here answers for them.
function listOnlyClient() {
  const calls: Array<{ method: string; path: string }> = [];
  const client: VeedHttp = {
    async getJson<T>(path: string): Promise<T> {
      calls.push({ method: 'GET', path });
      if (path === '/subtitles/synthesize/listVoices') {
        // The route hands back every voice in one response; the locale and gender filters are applied
        // client-side, so the fake does not pre-filter.
        return {
          data: VOICES.map((v) => ({
            id: v.id, name: v.name, locale: v.locale, localeLabel: v.localeLabel,
            gender: v.gender === 'Female' ? '0' : v.gender === 'Male' ? '1' : '2',
          })),
        } as T;
      }
      throw new Error(`sample-presenter must never GET ${path}`);
    },
    async getJsonOrNull<T>(path: string): Promise<T | null> {
      throw new Error(`sample-presenter must never GET ${path}`);
    },
    async postJson<T>(path: string): Promise<T> {
      throw new Error(`sample-presenter must never POST ${path}`);
    },
    async putBytes(url: string): Promise<void> {
      throw new Error(`sample-presenter must never PUT ${url}`);
    },
  };
  return { client, calls };
}

await test('the pool is built from the voice listing ONLY — no route that spends or writes', async () => {
  const { client, calls } = listOnlyClient();
  const pool = await collectPresenterPool(client, { locale: 'en' });
  assert.ok(pool.characters.length > 0 && pool.voices.length > 0);
  // One free read, and nothing else: the character list is compiled in, so it costs not even a request.
  assert.deepEqual([...new Set(calls.map((c) => c.path))], ['/subtitles/synthesize/listVoices']);
});

await test('the whole locale reaches the pool, with nothing repeated', async () => {
  const { client } = listOnlyClient();
  const pool = await collectPresenterPool(client, { locale: 'en' });
  assert.equal(pool.voices.length, VOICES.filter((v) => v.locale.startsWith('en')).length);
  assert.equal(new Set(pool.voices.map((v) => v.id)).size, pool.voices.length, 'no voice repeated');
});

await test('the catalogue is downloaded once, not once per page', async () => {
  // listVoices pages by slicing a full response, so each page re-downloads the whole catalogue.
  const many = Array.from({ length: 120 }, (_, i) => voice(`v${i}`, `Voice ${i}`, 'en-US', i % 2 ? 'Male' : 'Female'));
  let gets = 0;
  const client: VeedHttp = {
    async getJson<T>(path: string): Promise<T> {
      gets += 1;
      if (path !== '/subtitles/synthesize/listVoices') throw new Error(`unexpected GET ${path}`);
      return {
        data: many.map((v) => ({
          id: v.id, name: v.name, locale: v.locale, localeLabel: v.localeLabel,
          gender: v.gender === 'Male' ? '1' : '0',
        })),
      } as T;
    },
    async getJsonOrNull<T>(path: string): Promise<T | null> { throw new Error(`unexpected GET ${path}`); },
    async postJson<T>(path: string): Promise<T> { throw new Error(`unexpected POST ${path}`); },
    async putBytes(url: string): Promise<void> { throw new Error(`unexpected PUT ${url}`); },
  };
  const pool = await collectPresenterPool(client, { locale: 'en' });
  assert.equal(pool.voices.length, 120, 'every voice still reaches the pool');
  assert.equal(gets, 1, `the catalogue was downloaded ${gets} times`);
});

await test('a gender filter narrows the characters, and leaves the voice listing whole', async () => {
  const { client } = listOnlyClient();
  const pool = await collectPresenterPool(client, { locale: 'en', gender: 'male' });
  assert.ok(pool.characters.length > 0 && pool.characters.every((c) => c.gender === 'male'));
  // Pushing --gender down to the listing would strip every Neutral voice before the draw saw one.
  assert.ok(pool.voices.some((v) => v.gender === 'Neutral'), 'no Neutral voice survived the pool build');
  assert.ok(pool.voices.some((v) => v.gender === 'Male'));
});

// --- the output proposes; the user decides ---

await test('the last line is the ready-to-run generate command carrying the chosen pair', () => {
  const proposal = samplePresenter(POOL, { key: 'promo' });
  const out = formatProposal(proposal, 'promo');
  const lines = out.trimEnd().split('\n');
  assert.equal(lines[lines.length - 1], generateCommand(proposal, 'promo'));
  assert.match(lines[lines.length - 1], /openedit-cli generate/);
  assert.ok(lines[lines.length - 1].includes(`--character ${proposal.character.id}`));
  assert.ok(lines[lines.length - 1].includes(`--voice ${proposal.voice.id}`));
  assert.ok(lines[lines.length - 1].includes('--key promo'));
});

await test('the output says plainly that listing costs nothing, and that this is a proposal', () => {
  const out = formatProposal(samplePresenter(POOL, { seed: 4 }), 'generated');
  assert.match(out, /0 credits|costs? nothing|free/i);
  assert.match(out, /proposal|suggest/i);
});

await test('the alternates print with the thumbnail to look at and the preview to listen to', () => {
  const proposal = samplePresenter(POOL, { seed: 4 });
  const out = formatProposal(proposal, 'generated');
  const shownCharacters = [proposal.character, ...proposal.alternates.pairs.map((x) => x.character)];
  const shownVoices = [proposal.voice, ...proposal.alternates.voices, ...proposal.alternates.pairs.map((x) => x.voice)];
  for (const c of shownCharacters) assert.ok(out.includes(c.thumbnail), c.id);
  for (const v of shownVoices) assert.ok(out.includes(v.previewAudioUrl), v.id);
});

// --- F10: sample-presenter's argv reading must be as strict as generate.ts's, not a silent-drop `get()` ---

await test('a misspelled boolean flag (--protrait) is refused, not silently ignored', () => {
  // The old `argv.includes('--portrait')` reader left this false and fell back to 'any' framing with no
  // warning — the user pays for whichever aspect ratio got drawn, and framing cannot be fixed by a re-render.
  assert.throws(() => parsePresenterArgs(['--protrait']), /Unknown option '--protrait'/);
});

await test('--seed as the final token with no value is refused', () => {
  assert.throws(() => parsePresenterArgs(['--seed']), /Option '--seed <value>' argument missing/);
});

await test('a stray non-flag token is refused, not silently dropped', () => {
  assert.throws(() => parsePresenterArgs(['--key', 'promo', 'stray']), /does not take positional arguments/);
});

await test('an unsafe --key is refused, routed through the same guard generate.ts uses', () => {
  assert.throws(() => parsePresenterArgs(['--key', '../../escape']), /invalid --key/);
});

await test('a valid invocation still parses and proposes', () => {
  const opts = parsePresenterArgs(['--key', 'promo', '--seed', '7', '--gender', 'male', '--portrait']);
  assert.equal(opts.key, 'promo');
  assert.equal(opts.seed, 7);
  assert.equal(opts.gender, 'male');
  assert.equal(opts.framing, 'portrait');
  // And the parsed options still drive a real proposal end to end.
  const proposal = samplePresenter(POOL, opts);
  assert.ok(isPortraitThumbnail(proposal.character.thumbnail));
});

