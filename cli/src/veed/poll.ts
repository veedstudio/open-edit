// One poll loop for every VEED route that hands back a job to wait on: asset upload, transcription,
// speech synthesis, video generation. Sleep is injected so the wait is instant under test.
export async function poll<T>(opts: {
  fetch: () => Promise<T>;
  decide: (value: T) => 'done' | 'failed' | 'wait';
  label: string;
  failMessage: (value: T) => string;
  sleep: (ms: number) => Promise<void>;
  intervalMs: number;
  maxAttempts: number;
}): Promise<T> {
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    const value = await opts.fetch();
    const state = opts.decide(value);
    if (state === 'failed') throw new Error(opts.failMessage(value));
    if (state === 'done') return value;
    await opts.sleep(opts.intervalMs);
  }
  throw new Error(
    `VEED: ${opts.label} did not finish after ${opts.maxAttempts} polls (${opts.intervalMs}ms each)`,
  );
}
