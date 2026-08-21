// The "hit go" entry: transcribe a local video through VEED's upload +
// transcription API and write runs/<key>/transcript.json in the exact shape the
// editor pipeline already consumes (prep.ts then cuts the base frames from it).
//
//   1. Log in once:  npx @veedstudio/openedit-cli login
//   2. Run:          node --import tsx veed/go.ts <video.mp4> [...]
//
// Env: VEED_ORIGIN (default https://www.veed.io), VEED_ACCESS_TOKEN (optional,
// overrides the stored login).
// Transcription spends the logged-in user's VEED credits.
import { parseFlags } from './args.ts';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../config.ts';
import { resolveVideoArg, runKeyOf } from '../pipeline/scripts/resolve-video.ts';
import type { VeedHttp } from './api.ts';
import { refreshingHttp } from './http.ts';
import { transcribeWithVeed } from './orchestrate.ts';
import { resolveVeedToken } from './cli-token.ts';

async function readVideoBytes(videoPath: string): Promise<{ bytes: Uint8Array; mimeType: string; extension: string }> {
  // Buffer IS a Uint8Array; no copy.
  const bytes = await readFile(videoPath);
  const ext = (extname(videoPath).slice(1) || 'mp4').toLowerCase();
  const mimeType = ext === 'mov' ? 'video/quicktime' : ext === 'webm' ? 'video/webm' : 'video/mp4';
  return { bytes, mimeType, extension: ext };
}

// A VeedHttp that re-resolves the token per REQUEST. A batch can outlive a single access token, so closing
// over one (realHttp) would 401 on a later video after earlier ones already spent credits; resolving per
// request refreshes mid-run instead.
export function connectRefreshing(resolve: () => Promise<string | null> = resolveVeedToken): VeedHttp {
  return refreshingHttp(async () => {
    const token = await resolve();
    if (!token) throw new Error('VEED login expired mid-run — re-run: npx @veedstudio/openedit-cli login');
    return token;
  });
}

function noTokenHelp(): void {
  console.error(
    [
      'No VEED login found. Log in with VEED:',
      '',
      '  npx @veedstudio/openedit-cli login',
      '',
      'It opens your browser once and stores a refreshable token, owner-only, in the',
      "CLI's app-data directory (npx @veedstudio/openedit-cli token --path prints where).",
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
  // Transcription BILLS a workspace, so it has to be nameable — without this an account with several
  // could only ever use whichever one the listing put first. Strict, with the videos as positionals: a
  // mistyped flag used to be resolved as a path and then reported as a missing video, which names the
  // wrong problem.
  const { values, positionals: videoArgs } = parseFlags({
    args: process.argv.slice(2),
    options: { workspace: { type: 'string' } },
    allowPositionals: true,
  });
  const workspaceId = values.workspace;
  if (videoArgs.length === 0) {
    console.error('usage: node --import tsx veed/go.ts <video.mp4> [...]');
    process.exit(1);
  }

  const token = await resolveVeedToken();
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

  const http = connectRefreshing();
  for (const video of videos) {
    // The one run-key rule, shared with prep/ — never repeated inline.
    const key = runKeyOf(video);
    const outDir = join(REPO_ROOT, 'runs', key);
    await mkdir(outDir, { recursive: true });

    console.log(`[veed-transcribe] ${video}`);
    const transcript = await transcribeWithVeed(
      { http, readVideoBytes, log: (m) => console.log(`  ${m}`) },
      { videoPath: video, workspaceId },
    );
    const out = join(outDir, 'transcript.json');
    await writeFile(out, JSON.stringify(transcript, null, 2));
    console.log(`wrote ${out} (${transcript.chunks.length} beats)`);
  }
}

// Only when run as the entry point — importing go.ts (e.g. from a test of connectRefreshing) must not
// kick off a transcription batch from the importer's argv. Compare the module URL rather than matching the
// filename: an endsWith('go.ts') check also fires for any other script whose path happens to end that way.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
