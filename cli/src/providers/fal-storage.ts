// Local files into fal's own storage, so an endpoint that wants a url can be handed a path.
//
// fal storage refuses a single PUT past a size ceiling (413, "use multipart"), so above
// MULTIPART_ABOVE_BYTES the file goes up in parts, read from disk one part at a time, so a large source
// never has to fit in memory.
import { createHash } from 'node:crypto';
import { createReadStream, openSync, readSync, closeSync, statSync, readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { authHeaders, realHttp, scrub, snippet, type Http } from './fal.ts';
import { errorText } from '../proxy.ts';

const REST = 'https://rest.fal.ai';

/** fal's own client switches to multipart above this size; the single PUT is refused somewhere past it. */
export const MULTIPART_ABOVE_BYTES = 90 * 1024 * 1024;
export const PART_BYTES = 10 * 1024 * 1024;
const PART_ATTEMPTS = 3;

const TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac',
  json: 'application/json', txt: 'text/plain', pdf: 'application/pdf', zip: 'application/zip',
};

export function contentTypeOf(path: string): string {
  return TYPES[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

/** The file extension for a media type, or null for one this table does not know. */
export function extensionOf(contentType: string): string | null {
  return Object.keys(TYPES).find((ext) => TYPES[ext] === contentType.split(';')[0].trim().toLowerCase()) ?? null;
}

/** What a file is, independent of where it will be uploaded: the part of a request's identity it owns. */
export async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return `sha256:${hash.digest('hex')}`;
}

export interface UploadOptions {
  key: string;
  http?: Http;
  /** Test seams: where the single PUT stops and how big each part is. */
  multipartAboveBytes?: number;
  partBytes?: number;
}

async function initiate(kind: 'initiate' | 'initiate-multipart', path: string, opts: UploadOptions, http: Http): Promise<{ upload_url: string; file_url: string }> {
  const res = await http(`${REST}/storage/upload/${kind}?storage_type=fal-cdn-v3`, {
    method: 'POST',
    headers: authHeaders(opts.key),
    body: JSON.stringify({ content_type: contentTypeOf(path), file_name: basename(path) }),
  });
  if (res.status >= 300) throw new Error(scrub(`fal storage refused ${basename(path)} (${res.status}): ${await snippet(res)}`, opts.key));
  const body = (await res.json()) as { upload_url?: string; file_url?: string };
  if (!body.upload_url || !body.file_url) throw new Error(`fal storage returned no upload url for ${basename(path)}`);
  return { upload_url: body.upload_url, file_url: body.file_url };
}

function readPart(fd: number, offset: number, length: number): Uint8Array {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buf, read, length - read, offset + read);
    if (n === 0) break;
    read += n;
  }
  return buf.subarray(0, read);
}

/** Uploads one local file and returns the url an endpoint can fetch it from. */
export async function uploadFile(path: string, opts: UploadOptions): Promise<string> {
  const size = statSync(path).size;
  const above = opts.multipartAboveBytes ?? MULTIPART_ABOVE_BYTES;
  const http = opts.http ?? realHttp(15 * 60_000);

  if (size <= above) {
    const { upload_url, file_url } = await initiate('initiate', path, opts, http);
    const res = await http(upload_url, { method: 'PUT', headers: { 'Content-Type': contentTypeOf(path) }, body: readFileSync(path) });
    if (res.status >= 300) throw new Error(`fal storage upload of ${basename(path)} failed (${res.status})`);
    return file_url;
  }

  const { upload_url, file_url } = await initiate('initiate-multipart', path, opts, http);
  const u = new URL(upload_url);
  const partBytes = opts.partBytes ?? PART_BYTES;
  const parts: { partNumber: number; etag: string }[] = [];
  const fd = openSync(path, 'r');
  try {
    for (let offset = 0, partNumber = 1; offset < size; offset += partBytes, partNumber++) {
      const chunk = readPart(fd, offset, Math.min(partBytes, size - offset));
      let lastError = '';
      let etag: string | undefined;
      // A part is idempotent (same number, same bytes), so retrying one costs nothing but time.
      for (let attempt = 0; attempt < PART_ATTEMPTS && !etag; attempt++) {
        try {
          const res = await http(`${u.origin}${u.pathname}/${partNumber}${u.search}`, { method: 'PUT', headers: {}, body: chunk });
          if (res.status >= 300) { lastError = `status ${res.status}`; continue; }
          const body = (await res.json().catch(() => ({}))) as { etag?: string };
          etag = body.etag ?? res.header?.('etag') ?? undefined;
          if (!etag) lastError = 'no etag in the answer';
        } catch (e) {
          lastError = errorText(e);
        }
      }
      if (!etag) throw new Error(`fal storage: part ${partNumber} of ${basename(path)} failed ${PART_ATTEMPTS} times (${lastError})`);
      parts.push({ partNumber, etag });
    }
  } finally {
    closeSync(fd);
  }
  const done = await http(`${u.origin}${u.pathname}/complete${u.search}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts }),
  });
  if (done.status >= 300) throw new Error(`fal storage could not assemble ${basename(path)} (${done.status}): ${await snippet(done)}`);
  return file_url;
}
