// A minimal npm registry, its OWN process: the suites drive the CLI with spawnSync, which blocks
// the parent's event loop, so an in-process server could never answer. Prints "PORT <n>" when live.
//
//   node stub-registry.mjs --tarball <tgz> --latest <version> [--min-engine <v>] [--mode ok|hang]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({
  options: {
    tarball: { type: 'string' },
    latest: { type: 'string' },
    'min-engine': { type: 'string' },
    mode: { type: 'string', default: 'ok' },
  },
});

const bytes = readFileSync(opt.tarball);
const shasum = createHash('sha1').update(bytes).digest('hex');
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

// Absent --min-engine the floor is the tarball's OWN; a fixture value would keep a missing field green.
// Relative filename + cwd: bsdtar parses a drive-letter path as a remote host:file.
const manifest = JSON.parse(execFileSync('tar', ['-xOf', basename(opt.tarball), 'package/package.json'], { encoding: 'utf8', cwd: dirname(opt.tarball) }));
const minEngine = opt['min-engine'] ?? manifest.openedit?.minEngine;

const server = http.createServer((req, res) => {
  if (opt.mode === 'hang') return; // accepted, never answered — the client's timeout is the test
  // Name check FIRST: npm rewrites tarball hosts to the configured registry, so a proxied
  // dependency's own .tgz arrives here too and these bytes would fail its integrity check.
  const url = decodeURIComponent(req.url);
  if (!url.includes('@veedstudio/openedit-cli')) {
    https.get(`https://registry.npmjs.org${req.url}`, (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, { 'content-type': upstream.headers['content-type'] ?? 'application/json' });
      upstream.pipe(res);
    }).on('error', () => { res.writeHead(502); res.end(); });
    return;
  }
  if (req.url.endsWith('.tgz')) {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(bytes);
    return;
  }
  const base = `http://127.0.0.1:${server.address().port}`;
  const versionEntry = (version) => ({
    name: '@veedstudio/openedit-cli',
    version,
    ...(minEngine ? { openedit: { minEngine } } : {}),
    // The name rides in the tarball path so the proxy check above can tell it from a dependency's.
    dist: { tarball: `${base}/@veedstudio/openedit-cli/-/cli.tgz`, shasum, integrity },
  });
  res.writeHead(200, { 'content-type': 'application/json' });
  // init reads the `latest` manifest, npm the full packument; serving both keeps init honest.
  if (url.endsWith('/latest')) {
    res.end(JSON.stringify(versionEntry(opt.latest)));
    return;
  }
  res.end(JSON.stringify({
    name: '@veedstudio/openedit-cli',
    'dist-tags': { latest: opt.latest },
    versions: { [opt.latest]: versionEntry(opt.latest) },
  }));
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT ${server.address().port}\n`);
});
