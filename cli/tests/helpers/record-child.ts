// One writer in the cross-process manifest races in assets.test.ts: waits for a shared start instant, then
// records `count` assets of its own into the run every other writer records into. Given a request id, it
// instead fills that request's one row `count` times, adding its own tag to the row's `fills` each time.
import { record, recordRequest } from '../../src/providers/assets.ts';

const [runDir, startAt, tag, count, requestId] = process.argv.slice(2);

await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
const started = Date.now();
for (let i = 0; i < Number(count); i++) {
  const asset = {
    id: `${tag}-${i}`, kind: 'image' as const, path: `assets/${tag}-${i}.png`, provider: 'fal', model: 'm',
    createdAt: new Date().toISOString(), cost: 0.01,
  };
  if (!requestId) record(runDir, asset);
  else recordRequest(runDir, requestId, (prior) => ({ ...(prior ?? asset), meta: { ...prior?.meta, fills: [...((prior?.meta?.fills as string[] | undefined) ?? []), `${tag}-${i}`] } }));
}
// The time spent writing, apart from starting up, so a caller can tell a writer that was made to wait.
process.stdout.write(String(Date.now() - started));
