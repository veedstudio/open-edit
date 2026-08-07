// The "hit go" entry: transcribe a local video through VEED's upload +
// transcription API and write runs/<key>/transcript.json in the exact shape the
// editor pipeline already consumes (prep.ts then cuts the base frames from it).
//
//   1. Log in once:  node --import tsx veed/login.ts
//   2. Run:          node --import tsx veed/go.ts <video.mp4> [...]
//
// Env: VEED_ORIGIN (default https://www.veed.io), VEED_ACCESS_TOKEN (optional,
// overrides the stored login).
// Transcription spends the logged-in user's VEED credits.
import { parseFlags } from './args.ts';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { REPO_ROOT } from '../config.ts';
import { resolveVideoArg, runKeyOf } from '../pipeline/scripts/resolve-video.ts';
import { VEED_ORIGIN } from './api.ts';
import { realHttp } from './http.ts';
import { transcribeWithVeed } from './orchestrate.ts';
import { DEFAULT_TOKEN_PATH, resolveToken } from './token-store.ts';

async function readVideoBytes(videoPath: string): Promise<{ bytes: Uint8Array; mimeType: string; extension: string }> {
  // Buffer IS a Uint8Array; no copy.
  const bytes = await readFile(videoPath);
  const ext = (extname(videoPath).slice(1) || 'mp4').toLowerCase();
  const mimeType = ext === 'mov' ? 'video/quicktime' : ext === 'webm' ? 'video/webm' : 'video/mp4';
  return { bytes, mimeType, extension: ext };
}

function noTokenHelp(): void {
  console.error(
    [
      'No VEED login found. Log in with VEED:',
      '',
      '  node --import tsx veed/login.ts',
      '',
      'It opens your browser once and stores a refreshable token, owner-only, at',
      `  ${DEFAULT_TOKEN_PATH}`,
      '',
      'then re-run:  node --import tsx veed/go.ts <video.mp4> [...]',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  // Arguments FIRST, and before the login gate: parsing is free and local, so a typo should be named as a
  // typo. Checked the other way round, a mistyped flag surfaces as "no VEED login found" on any machine
  // that happens not to be logged in, which sends someone off fixing the wrong thing.
  //
  // Strict: this command takes a list of files, so a bare token is expected, but anything that looks
  // like a flag is one and must be recognised. A mistyped flag used to be resolved as a path and then
  // reported as a missing video, which names the wrong problem.
  const { positionals: videoArgs } = parseFlags({
    args: process.argv.slice(2),
    options: {},
    allowPositionals: true,
  });
  if (videoArgs.length === 0) {
    console.error('usage: node --import tsx veed/go.ts <video.mp4> [...]');
    process.exit(1);
  }

  const token = await resolveToken({
    envToken: process.env.VEED_ACCESS_TOKEN,
    tokenPath: DEFAULT_TOKEN_PATH,
    expectedOrigin: VEED_ORIGIN,
  });
  if (!token) {
    noTokenHelp();
    process.exit(1);
  }
  // Resolve and check every path before uploading any of them: a typo in the last argument should not
  // be discovered after the earlier videos have already spent transcription credits.
  const videos = videoArgs.map(resolveVideoArg);
  const missing = videos.filter((v) => !existsSync(v));
  if (missing.length > 0) {
    console.error(missing.map((v) => `video not found: ${v}`).join('\n'));
    process.exit(1);
  }

  const http = realHttp(token);
  for (const video of videos) {
    // The one run-key rule, shared with prep/ — never repeated inline.
    const key = runKeyOf(video);
    const outDir = join(REPO_ROOT, 'runs', key);
    await mkdir(outDir, { recursive: true });

    console.log(`[veed-transcribe] ${video}`);
    const transcript = await transcribeWithVeed(
      { http, readVideoBytes, log: (m) => console.log(`  ${m}`) },
      { videoPath: video },
    );
    const out = join(outDir, 'transcript.json');
    await writeFile(out, JSON.stringify(transcript, null, 2));
    console.log(`wrote ${out} (${transcript.chunks.length} beats)`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
