// Tests the Fabric operations against a fake VeedHttp (no network). Proves each one issues the REST
// routes the live edge serves, that the spend path is the sequence it claims to be, and that the values
// gating money are checked rather than trusted.
// Run:  node --import tsx tests/fabric.test.ts
import assert from 'node:assert/strict';
import {
  awaitVideo, confirmVideo, createVideo, estimateTotalCredits, FabricJobFailedError,
  getAllowances, getStatus, isPortraitThumbnail, listCharacters,
  listFabricWorkspaces, listVoices, voiceSuitsFace,
} from '../src/veed/fabric.ts';
import { formatWorkspaceTable, listWorkspacesWithCredits } from '../src/veed/workspace.ts';
import { FABRIC_CHARACTERS } from '../src/veed/fabric-characters.ts';
import { fakeFabricHttp, scriptCosting } from './fabric-fake.ts';
import { test } from 'node:test';

const req = { script: 'Here is how it works.', voiceId: 'voice-1', characterId: 'character-15', workspaceId: 'ws1' };

await test('characters come from the compiled-in list, with no request at all', async () => {
  const { client, calls } = fakeFabricHttp();
  const all = await listCharacters(client);
  assert.equal(all.length, FABRIC_CHARACTERS.length);
  assert.deepEqual(calls, [], 'listing characters must not touch the network');
  const women = await listCharacters(client, 'female');
  assert.ok(women.length > 0 && women.every((c) => c.gender === 'female'));
});

await test('portrait framing is read off the thumbnail path, not a parameter', () => {
  assert.equal(isPortraitThumbnail('https://cdn/1_P_abc.jpg'), true);
  assert.equal(isPortraitThumbnail('https://cdn/2_abc.jpg?x=_P_'), false, 'query strings do not count');
});

await test('voices are fetched once and paged locally', async () => {
  const { client, names } = fakeFabricHttp();
  const page = await listVoices(client, { locale: 'en' });
  assert.deepEqual(names(), ['list_voices'], 'one request, however many pages are read from it');
  assert.equal(page.totalCount, 2);
  assert.equal(page.voices[0].name, 'Maeve');
  assert.equal(page.voices[0].gender, 'Female', 'the numeric gender code is decoded');
  assert.match(page.voices[0].previewAudioUrl, /synthesize\/preview\?voice=voice-1/);
  assert.equal(page.nextCursor, undefined, 'a single page advertises no cursor');
});

await test('an unrecognised gender code is not silently filed as gender-neutral', async () => {
  // 'Neutral' suits any face, so folding unknown codes into it lets any voice pair with any face.
  const { client } = fakeFabricHttp({
    voices: [{ id: 'v-new', name: 'Newcomer', locale: 'en-GB', gender: '7' }],
  });
  const page = await listVoices(client, { locale: 'en' });
  assert.equal(page.voices[0].gender, 'unknown');
  const male = { id: 'c', name: 'C', thumbnail: 'https://cdn/c.jpg', gender: 'male' } as const;
  const female = { ...male, gender: 'female' } as const;
  assert.equal(voiceSuitsFace(page.voices[0], male.gender), false);
  assert.equal(voiceSuitsFace(page.voices[0], female.gender), false);
});

await test('the AI Playground balance is summed across the buckets a generation draws on', async () => {
  // The one allowance a generation spends now: speech used to bill a separate seconds allowance and is
  // folded into these credits. The report splits the figure across buckets, so the client has to sum them.
  const { client } = fakeFabricHttp();
  const allowances = await getAllowances(client, 'ws1');
  assert.equal(allowances.aiPlaygroundCredits, 8_032_608);
});

await test('workspaces come back in the shape the billing table wants', async () => {
  const { client } = fakeFabricHttp();
  assert.deepEqual(await listFabricWorkspaces(client), [{ id: 'ws1', name: 'Solo' }]);
  assert.deepEqual(await listWorkspacesWithCredits(client), [
    { id: 'ws1', name: 'Solo', credits: 8_032_608 },
  ]);
});

await test('an unreadable balance is reported as unknown, never as zero, and never blocks', async () => {
  // It is not evidence of an empty workspace, and a run with one workspace has no choice a balance
  // would inform — so the listing degrades rather than refusing.
  const { client } = fakeFabricHttp({ balances: [] });
  assert.deepEqual(await listWorkspacesWithCredits(client), [
    { id: 'ws1', name: 'Solo', credits: null },
  ]);
});

await test('confirming spends nothing and prices the script locally', async () => {
  const { client, names } = fakeFabricHttp();
  const confirmation = await confirmVideo(client, req);
  // No project, no asset, no generation: the whole point of the confirm pass.
  assert.deepEqual(names(), ['list_workspaces', 'list_voices']);
  assert.equal(confirmation.estimatedCredits, estimateTotalCredits(req.script));
  assert.deepEqual(
    [confirmation.voiceName, confirmation.characterName, confirmation.workspaceName],
    ['Maeve', 'Character 15', 'Solo'],
  );
});

await test('a script aimed at a chosen figure prices to exactly that figure', () => {
  // The helper the generate tests use to aim at a specific quote must actually hit it — and the quote is
  // the TOTAL, speech folded in, which is what a user approves.
  assert.equal(estimateTotalCredits(scriptCosting(64)), 64);
});

await test('confirming refuses an unknown voice BEFORE anything is created', async () => {
  const { client, names } = fakeFabricHttp();
  await assert.rejects(confirmVideo(client, { ...req, voiceId: 'nope' }), /not a known voice/);
  assert.ok(!names().includes('create_fabric_video'));
});

await test('confirming refuses an unknown character and an empty script', async () => {
  const { client } = fakeFabricHttp();
  await assert.rejects(confirmVideo(client, { ...req, characterId: 'nope' }), /not a known character/);
  await assert.rejects(confirmVideo(client, { ...req, script: '   ' }), /the script is empty/);
});

await test('a multi-workspace account is never billed by guess', async () => {
  const { client } = fakeFabricHttp();
  const many: typeof client = {
    ...client,
    async getJson<T>(path: string): Promise<T> {
      if (path === '/workspace') return [{ id: 'ws1', name: 'A' }, { id: 'ws2', name: 'B' }] as T;
      return client.getJson<T>(path);
    },
  };
  await assert.rejects(confirmVideo(many, { ...req, workspaceId: undefined }), /name the one to bill/);
});

await test('creating a video runs the whole spend chain, in order', async () => {
  const { client, calls, names, bodyOf } = fakeFabricHttp();
  const job = await createVideo(client, req);

  assert.deepEqual(
    calls.filter((c) => c.method === 'POST').map((c) => c.path),
    ['/project', '/asset/transload', '/asset', '/subtitles/synthesize/generate', '/ai-playground'],
  );
  assert.equal(job.jobId, 'job-1');
  assert.equal(job.durationSeconds, 12.7, 'the duration comes from the speech job');
  assert.ok(names().includes('create_fabric_video'));

  // The audio asset is minted EMPTY and its signed URL handed over; VEED renders the mp3 into it, so no
  // audio bytes are uploaded from here.
  const synth = bodyOf('/subtitles/synthesize/generate') as Record<string, unknown>;
  assert.equal(synth.uploadUrl, 'https://gcs/tts-session');
  assert.ok(!calls.some((c) => c.method === 'PUT'), 'a preset character uploads nothing');

  const gen = bodyOf('/ai-playground') as Record<string, unknown>;
  assert.equal(gen.model, 'veed/fabric-one-lipsync');
  assert.equal(gen.assetId, 'img1');
  assert.equal(gen.audioAssetId, 'tts1');
  assert.equal(gen.projectId, 'proj1');

  // The project is private: this client downloads the file and never needs a shareable link.
  assert.equal((bodyOf('/project') as Record<string, unknown>).privacy, 'private');
});

await test('a URL image is transloaded, so the bytes never pass through this process', async () => {
  const { client, calls, bodyOf } = fakeFabricHttp();
  const job = await createVideo(client, { ...req, image: { kind: 'url', url: 'https://cdn/still.png' } });
  assert.equal(job.jobId, 'job-1');
  const transload = bodyOf('/asset/transload') as Record<string, unknown>;
  assert.equal(transload.sourceUrl, 'https://cdn/still.png', 'the USER image, not a preset thumbnail');
  assert.equal(transload.extension, 'png', 'the extension comes from the URL');
  assert.ok(!calls.some((c) => c.method === 'PUT'), 'a URL uploads nothing');
});

await test('a URL extension is read off the path, ignoring any query string', async () => {
  const { client, bodyOf } = fakeFabricHttp();
  await createVideo(client, { ...req, image: { kind: 'url', url: 'https://cdn/a.JPEG?v=2#x' } });
  assert.equal((bodyOf('/asset/transload') as Record<string, unknown>).extension, 'jpeg');
});

await test('a LOCAL image is uploaded, and the id is only used once the upload finalizes', async () => {
  const { client, calls, bodyOf } = fakeFabricHttp();
  const read: string[] = [];
  const job = await createVideo(
    client,
    { ...req, image: { kind: 'file', path: '/tmp/still.jpg' } },
    { readFileBytes: async (p) => { read.push(p); return new Uint8Array([1, 2, 3]); }, sleep: async () => {} },
  );
  assert.deepEqual(read, ['/tmp/still.jpg'], 'the file is read through the injected reader');
  assert.equal((bodyOf('/asset') as Record<string, unknown>).group, 'image', 'an IMAGE asset, not the TTS one');
  assert.ok(calls.some((c) => c.method === 'PUT'), 'local bytes are PUT to the signed URL');
  // The generation must not name an asset that is still UPLOADING — that fails after the money moved.
  const uploadAt = calls.findIndex((c) => c.method === 'PUT');
  const waitAt = calls.findIndex((c) => c.path.startsWith('/asset/') && c.method === 'GET');
  assert.ok(waitAt > uploadAt, 'the upload is waited on before the id is used');
  assert.equal(job.jobId, 'job-1');
});

await test('a local image with no reader refuses, rather than generating something blank', async () => {
  const { client } = fakeFabricHttp();
  await assert.rejects(
    createVideo(client, { ...req, image: { kind: 'file', path: '/tmp/x.jpg' } }),
    /needs a file reader/,
  );
});

await test('the approval names the user image rather than pretending it is a preset', async () => {
  const { client } = fakeFabricHttp();
  const url = await confirmVideo(client, { ...req, image: { kind: 'url', url: 'https://cdn/me.png' } });
  assert.match(url.characterName, /your image/);
  assert.match(url.characterName, /me\.png/);
  const preset = await confirmVideo(client, req);
  assert.equal(preset.characterName, 'Character 15', 'a preset still reads as its name');
});

await test('an unknown preset still refuses, but only when a preset is what was asked for', async () => {
  const { client } = fakeFabricHttp();
  await assert.rejects(confirmVideo(client, { ...req, characterId: 'nope' }), /not a known character/);
  // characterId is ignored entirely once the user brings their own still.
  const brought = await confirmVideo(client, { ...req, characterId: 'nope', image: { kind: 'url', url: 'https://cdn/x.png' } });
  assert.match(brought.characterName, /your image/);
});

await test('running out of credits mid-chain says so, rather than failing anonymously', async () => {
  const { client } = fakeFabricHttp({ failSpeechWith: 'outOfCredits' });
  await assert.rejects(createVideo(client, req), /out of AI Playground credits/);
});

await test('status resolves the download URL only once the job is done', async () => {
  const pending = fakeFabricHttp({ statuses: ['processing'] });
  assert.deepEqual(await getStatus(pending.client, 'job-1'), { jobId: 'job-1', status: 'processing', url: null });

  const done = fakeFabricHttp({ statuses: ['done'] });
  assert.deepEqual(await getStatus(done.client, 'job-1'), {
    jobId: 'job-1', status: 'done', url: 'https://v3b.fal.media/out.mp4',
  });
});

await test('awaitVideo returns the url, and a failed job is told apart from a timeout', async () => {
  const ok = fakeFabricHttp({ statuses: ['pending', 'done'] });
  assert.equal(await awaitVideo(ok.client, 'job-1', { sleep: async () => {} }), 'https://v3b.fal.media/out.mp4');

  const bad = fakeFabricHttp({ statuses: ['failed'] });
  await assert.rejects(awaitVideo(bad.client, 'job-1', { sleep: async () => {} }), FabricJobFailedError);
});

await test('a failed job carries the server reason through getStatus, the poll log and the error', async () => {
  const failed = fakeFabricHttp({ statuses: ['error'], generationError: { message: 'gpu OOM', code: 'provider_error' } });
  // getStatus surfaces the reason VEED reports (error/timedOut normalise to failed WITH the fields).
  assert.deepEqual(await getStatus(failed.client, 'job-9'), {
    jobId: 'job-9', status: 'failed', url: null, errorReason: 'gpu OOM', errorCode: 'provider_error',
  });

  const progress: string[] = [];
  await assert.rejects(
    awaitVideo(failed.client, 'job-9', { sleep: async () => {}, onProgress: (_a, s) => progress.push(s) }),
    (e: unknown) =>
      e instanceof FabricJobFailedError && e.reason === 'gpu OOM' && e.code === 'provider_error'
      && /Fabric job job-9 failed: gpu OOM/.test(e.message),
  );
  assert.ok(progress.includes('failed: gpu OOM'), 'the poll log names the cause, not a bare "failed"');

  // Even if VEED spells the failure status literally 'failed' rather than 'error'/'timedOut', its reason is
  // still carried through rather than dropped.
  const literal = fakeFabricHttp({ statuses: ['failed'], generationError: { message: 'content rejected', code: 'content_policy' } });
  assert.deepEqual(await getStatus(literal.client, 'job-7'), {
    jobId: 'job-7', status: 'failed', url: null, errorReason: 'content rejected', errorCode: 'content_policy',
  });
});

await test('the workspace table stays readable when a balance is unknown', () => {
  const table = formatWorkspaceTable([
    { id: 'ws1', name: 'Solo', credits: 12 },
    { id: 'ws2', name: 'Team', credits: null },
  ]);
  assert.match(table, /ID +NAME +CREDITS/);
  assert.match(table, /ws2 +Team +unknown/);
});

