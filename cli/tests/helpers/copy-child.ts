// One render's copy in the media cache races in media-cache.test.ts: waits for a shared start instant, then asks
// the cache for the seekable copy of its file, and prints what it was given.
import { seekableCopy } from '../../src/render/media.ts';

const [file, dir, startAt] = process.argv.slice(2);

await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
const { path, made } = await seekableCopy(file, dir);
process.stdout.write(JSON.stringify({ path, made }));
