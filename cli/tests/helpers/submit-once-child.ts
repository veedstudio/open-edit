// One contender in the cross-process race in queue-ledger.test.ts: waits for a shared start instant,
// then asks for the same job every other contender asks for, against the test's local queue.
import { submitOnce, type Http } from '../../src/providers/fal.ts';

const [runDir, port, startAt] = process.argv.slice(2);

const http: Http = async (_url, init) => {
  const res = await fetch(`http://127.0.0.1:${port}/submit`, { method: init.method, headers: init.headers, body: init.body as BodyInit | undefined });
  return { status: res.status, json: () => res.json(), arrayBuffer: () => res.arrayBuffer() };
};

await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
const { job, reused } = await submitOnce(runDir, 'owner/model', { prompt: 'the same neon sign', seed: 7 }, {
  key: 'test-key', http, ledger: { pollMs: 20 },
});
process.stdout.write(JSON.stringify({ requestId: job.requestId, reused }) + '\n');
