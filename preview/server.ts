// The preview server: serves the read-only page, streams the two media files with
// Range support, and pushes run-dir state over SSE. Loopback-only, same trust model as
// veed/login.ts's OAuth catcher. Run:
//   node --import tsx preview/server.ts runs/<key>
// Env: VEED_PREVIEW_PORT (default 8978; falls back to an ephemeral port if busy),
//      VEED_PREVIEW_NO_OPEN=1 (print the URL, don't open the browser).
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRunState } from './state.ts';
import { planRange } from './media.ts';
import { makeHub, makeRunDirWatcher, type Hub } from './events.ts';

const PAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'page');
const PAGE_ASSETS: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/helpers.mjs': { file: 'helpers.mjs', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

function boundPort(server: Server): number {
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('server has no bound tcp port');
  return addr.port;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

async function streamMedia(res: ServerResponse, path: string, rangeHeader: string | undefined): Promise<void> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    json(res, 404, { error: 'not available yet' });
    return;
  }
  const plan = planRange(rangeHeader, size);
  const headers = { ...plan.headers, 'content-type': 'video/mp4', 'cache-control': 'no-store' };
  if (plan.status === 416) {
    res.writeHead(416, headers);
    res.end();
    return;
  }
  res.writeHead(plan.status, headers);
  // pipeline, not pipe: a stream error after the headers (file removed/unreadable mid-request) must
  // kill this response, never the process — and an aborted request (scrubbing cancels Range requests
  // constantly) destroys the read stream too, releasing its file descriptor instead of leaking it.
  pipeline(createReadStream(path, { start: plan.start, end: plan.end }), res, () => {});
}

export async function createPreviewServer(
  runDir: string,
  opts: { port?: number; openBrowser?: boolean } = {},
): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const dirStat = await stat(runDir); // throws for a missing run dir
  if (!dirStat.isDirectory()) throw new Error(`not a directory: ${runDir}`);

  const hub: Hub = makeHub({
    readState: () => readRunState(runDir),
    watch: (onEvent) => makeRunDirWatcher(runDir, onEvent),
  });
  await hub.start();

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    try {
      // The loopback bind keeps remote clients out; this keeps DNS-rebinding pages out
      // (a rebound document arrives carrying the attacker's own Host).
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (host !== '127.0.0.1' && host !== 'localhost') {
        json(res, 403, { error: 'forbidden host' });
        return;
      }
      const asset = req.method === 'GET' ? PAGE_ASSETS[path] : undefined;
      if (asset) {
        const body = await readFile(join(PAGE_DIR, asset.file));
        res.writeHead(200, { 'content-type': asset.type, 'content-length': body.length, 'cache-control': 'no-store' });
        res.end(body);
        return;
      }
      if (req.method === 'GET' && path === '/api/state') {
        const current = hub.current();
        if (current) json(res, 200, current);
        else json(res, 503, { error: 'run state unreadable' });
        return;
      }
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        const off = hub.addClient((frame) => res.write(frame));
        req.on('close', off);
        return;
      }
      if (req.method === 'GET' && path === '/video') {
        const videoPath = hub.current()?.video?.videoPath;
        if (!videoPath) json(res, 404, { error: 'no video yet (waiting for prep)' });
        else await streamMedia(res, videoPath, req.headers.range);
        return;
      }
      if (req.method === 'GET' && path === '/render') {
        await streamMedia(res, join(runDir, 'final', 'out.mp4'), req.headers.range);
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : 'internal error' });
    }
  });

  const envPort = Number.parseInt(process.env.VEED_PREVIEW_PORT ?? '', 10);
  const wanted = opts.port ?? (Number.isInteger(envPort) && envPort >= 0 && envPort <= 65535 ? envPort : 8978);
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE') {
        reject(err);
        return;
      }
      // Default port busy (another preview, or an orphan) — take an ephemeral one.
      // (this `once` handler has already been removed by firing; the next one is the real guard)
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(boundPort(server)));
    });
    server.listen(wanted, '127.0.0.1', () => resolve(boundPort(server)));
  });

  const url = `http://127.0.0.1:${port}`;
  if (opts.openBrowser) execFile('open', [url], () => {});
  return {
    url,
    port,
    close: () => new Promise<void>((resolve) => {
      hub.stop();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

async function main(): Promise<void> {
  const runDir = process.argv[2];
  if (!runDir) throw new Error('usage: node --import tsx preview/server.ts runs/<key>');
  const srv = await createPreviewServer(runDir, {
    openBrowser: process.env.VEED_PREVIEW_NO_OPEN !== '1',
  });
  console.log(`preview: ${srv.url}/  (run: ${basename(runDir)})`);
  const shutdown = (): void => {
    void srv.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
