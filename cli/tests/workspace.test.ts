// Tests veed/workspace.ts — which workspace a run bills.
//
// This is a money question, so the cases that matter are the ones where nobody has answered it. Picking
// silently is how a user ends up billed against an account they never named, and refusing to pick when
// there is nothing to pick is just a run that cannot start. Both are wrong, and the difference between
// them is the whole module.
//   Run:  node --import tsx tests/workspace.test.ts
import assert from 'node:assert/strict';
import type { VeedHttp } from '../src/veed/api.ts';
import {
  allUnpriced, describeChoice, describeWorkspaceChoice, formatWorkspaceTable, listWorkspacesWithCredits,
  resolveWorkspace,
} from '../src/veed/workspace.ts';
import { test } from 'node:test';

// A server that lists `workspaces` and prices each one, recording every path it was asked for so a test
// can assert what was NOT fetched. `unpriced` makes the allowance call fail for those ids.
function fakeHttp(workspaces: Array<{ id: string; name?: string }>, unpriced: string[] = []): {
  http: VeedHttp; paths: string[]; priced: string[];
} {
  const paths: string[] = [];
  const priced: string[] = [];
  const http = {
    async getJson<T>(path: string, headers?: Record<string, string>): Promise<T> {
      paths.push(path);
      if (path === '/workspace') return { data: workspaces } as T;
      if (path === '/usage-events/report') {
        const id = headers?.workspaceId ?? '';
        priced.push(id);
        if (unpriced.includes(id)) throw new Error('403');
        return {
          data: {
            ALLOWANCE: { AI_PLAYGROUND_CREDITS: { amount: 100 } },
            OPEN_BALANCE: { AI_PLAYGROUND_CREDITS: { amount: 5 } },
          },
        } as T;
      }
      throw new Error(`unexpected GET ${path}`);
    },
    getJsonOrNull: async () => null,
    postJson: async () => ({}),
    putBytes: async () => {},
  } as unknown as VeedHttp;
  return { http, paths, priced };
}

await test('one workspace is taken without asking — there is nothing to decide', async () => {
  const { http } = fakeHttp([{ id: 'ws1', name: 'Solo' }]);
  const r = await resolveWorkspace({ http });
  assert.equal(r.kind, 'resolved');
  assert.equal(r.kind === 'resolved' && r.workspace.id, 'ws1');
  assert.equal(r.kind === 'resolved' && r.source, 'only-one');
});

await test('SEVERAL workspaces and no answer is a question, never a guess', async () => {
  // The case that used to silently bill workspaces[0].
  const { http } = fakeHttp([{ id: 'ws1', name: 'Solo' }, { id: 'ws2', name: 'Studio' }]);
  const r = await resolveWorkspace({ http });
  assert.equal(r.kind, 'must-choose');
  assert.deepEqual(r.kind === 'must-choose' && r.workspaces.map((w) => w.id), ['ws1', 'ws2']);
});

await test('an explicit choice wins, and is not second-guessed against the listing', async () => {
  // A listing can fail partially. Refusing a workspace the user named is a worse error than letting the
  // first scoped call report the server's own message.
  const { http } = fakeHttp([{ id: 'ws1', name: 'Solo' }, { id: 'ws2', name: 'Studio' }]);
  const r = await resolveWorkspace({ http, explicit: 'ws-not-listed' });
  assert.equal(r.kind === 'resolved' && r.workspace.id, 'ws-not-listed');
  assert.equal(r.kind === 'resolved' && r.source, 'flag');
});

await test('an account with NO workspace fails by name, rather than resolving to nothing', async () => {
  const { http } = fakeHttp([]);
  await assert.rejects(resolveWorkspace({ http }), /no VEED workspaces on this account/);
});

// --- balances are read only where they change the answer ---

await test('a named workspace prices ONE balance, not the whole account', async () => {
  const { http, priced } = fakeHttp([{ id: 'ws1' }, { id: 'ws2' }, { id: 'ws3' }]);
  await resolveWorkspace({ http, explicit: 'ws2' });
  assert.deepEqual(priced, ['ws2'], 'pricing workspaces nobody is choosing between is wasted latency');
});

await test('a choice between workspaces prices all of them — that IS the comparison', async () => {
  const { http, priced } = fakeHttp([{ id: 'ws1' }, { id: 'ws2' }]);
  await resolveWorkspace({ http });
  assert.deepEqual(priced.sort(), ['ws1', 'ws2']);
});

await test('the credit balance is summed across buckets', async () => {
  const [w] = await listWorkspacesWithCredits(fakeHttp([{ id: 'ws1', name: 'Solo' }]).http);
  assert.equal(w.credits, 105, '100 in ALLOWANCE + 5 in OPEN_BALANCE');
});

await test('an unreadable balance is UNKNOWN, never zero, and never hides the workspace', async () => {
  // Usually an expired login. Reading it as empty would tell a user they cannot afford a run they can.
  const { http } = fakeHttp([{ id: 'ws1', name: 'Solo' }, { id: 'ws2', name: 'Studio' }], ['ws2']);
  const r = await resolveWorkspace({ http });
  const listed = r.kind === 'must-choose' ? r.workspaces : [];
  assert.equal(listed.length, 2, 'a workspace nobody could price is still one the user may want');
  assert.equal(listed[1].credits, null);
  assert.equal(allUnpriced(listed), false);
  assert.equal(allUnpriced(listed.slice(1)), true, 'not one balance readable is worth saying out loud');
});

// --- what the user actually reads ---

await test('the table shows the credit balance, and says "unknown" rather than a number it does not have', async () => {
  const table = formatWorkspaceTable([
    { id: 'ws1', name: 'Solo', credits: 105 },
    { id: 'ws2', name: 'Studio', credits: null },
  ]);
  assert.match(table, /ID +NAME +CREDITS/);
  assert.match(table, /ws1 +Solo +105/);
  assert.match(table, /ws2 +Studio +unknown/);
});

await test('an auto-picked workspace SAYS it was auto-picked, and why', () => {
  // Informing is not the same as choosing for someone: the user has to be able to catch it.
  const line = describeChoice({ id: 'ws1', name: 'Solo', credits: 105 }, 'only-one');
  assert.match(line, /billing workspace Solo \(ws1\)/);
  assert.match(line, /105 AI Playground credits/);
  assert.match(line, /the only workspace on this account, so nothing was asked/);
});

await test('a named workspace is reported plainly, with no explanation to give', () => {
  const line = describeChoice({ id: 'ws1', name: 'Solo', credits: null }, 'flag');
  assert.match(line, /balance unavailable/);
  assert.ok(!line.includes('—  '), 'nothing was decided here, so there is nothing to justify');
});

await test('the transcription line names the workspace but NOT the AI Playground pool — a different currency', () => {
  // Transcription bills VEED transcription credits; showing the AI Playground balance next to it (as
  // describeChoice does, for generation) puts the wrong currency in front of the user.
  const w = { id: 'ws1', name: 'Solo', credits: 105 };
  const line = describeWorkspaceChoice(w, 'only-one');
  assert.match(line, /billing workspace Solo \(ws1\)/);
  assert.match(line, /the only workspace on this account, so nothing was asked/);
  assert.ok(!/AI Playground/.test(line), 'no generation-pool balance on a transcription run');
  // The generation line is deliberately distinct and still shows that pool.
  assert.match(describeChoice(w, 'only-one'), /105 AI Playground credits/);
});

