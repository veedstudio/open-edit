// A minimal zip reader for the browser archive. The system tar reads zip on macOS and Windows but not
// on Linux, and `unzip` is not installed everywhere, so the one archive format the renderer needs is
// read here: stored and deflated entries, zip64 sizes, unix modes and symlinks.
import { closeSync, createReadStream, createWriteStream, fstatSync, mkdirSync, openSync, readSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw, inflateRawSync } from 'node:zlib';

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  mode: number;
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, position + got);
    if (n === 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

function centralDirectory(fd: number, size: number): { count: number; offset: number } {
  const tailLen = Math.min(size, 65_557);
  const tail = readAt(fd, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');
  let count = tail.readUInt16LE(eocd + 10);
  let offset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) throw new Error('zip64 archive without its locator');
    const z64 = readAt(fd, Number(tail.readBigUInt64LE(locator + 8)), 56);
    if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error('corrupt zip64 end-of-central-directory record');
    count = Number(z64.readBigUInt64LE(32));
    offset = Number(z64.readBigUInt64LE(48));
  }
  return { count, offset };
}

function entries(fd: number, size: number): Entry[] {
  const { count, offset } = centralDirectory(fd, size);
  const out: Entry[] = [];
  let pos = offset;
  for (let i = 0; i < count; i++) {
    const head = readAt(fd, pos, 46);
    if (head.readUInt32LE(0) !== 0x02014b50) throw new Error(`corrupt zip central directory at entry ${i}`);
    const nameLen = head.readUInt16LE(28);
    const extraLen = head.readUInt16LE(30);
    const commentLen = head.readUInt16LE(32);
    const rest = readAt(fd, pos + 46, nameLen + extraLen);
    let compressedSize = head.readUInt32LE(20);
    let entrySize = head.readUInt32LE(24);
    let localOffset = head.readUInt32LE(42);
    // A zip64 extra field carries, in this order, only the values whose 32-bit slots are saturated.
    const extra = rest.subarray(nameLen);
    for (let e = 0; e + 4 <= extra.length;) {
      const id = extra.readUInt16LE(e);
      const len = extra.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let p = e + 4;
        if (entrySize === 0xffffffff) { entrySize = Number(extra.readBigUInt64LE(p)); p += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = Number(extra.readBigUInt64LE(p)); p += 8; }
        if (localOffset === 0xffffffff) { localOffset = Number(extra.readBigUInt64LE(p)); }
      }
      e += 4 + len;
    }
    const madeByUnix = head[5] === 3;
    out.push({
      name: rest.toString('utf8', 0, nameLen),
      method: head.readUInt16LE(10),
      compressedSize,
      size: entrySize,
      localOffset,
      mode: madeByUnix ? head.readUInt32LE(38) >>> 16 : 0,
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * The real path of `p`, or of its nearest ancestor that exists. Native, as the kernel resolves it: the
 * JS resolver collapses a link's `..` against the link's own spelling, so `a/b/..` through a link
 * `a/b -> ..` reads as inside when the kernel lands outside.
 */
function realAncestor(p: string): string {
  for (let q = p; ; q = dirname(q)) {
    try {
      return realpathSync.native(q);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(q) === q) throw e;
    }
  }
}

const inside = (root: string, p: string): boolean => {
  const rel = relative(root, p);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
};

/**
 * Extracts every entry of `zip` under `dest` and never writes outside it: an entry is refused when its
 * name climbs out, when a link an earlier entry made would carry it out, or when something already
 * stands at its path, which a link could redirect. A link whose target is spelled outside is refused
 * too; one that leads out only through other links is kept, and nothing is written through it.
 */
export async function extractZip(zip: string, dest: string): Promise<number> {
  const fd = openSync(zip, 'r');
  let list: Entry[];
  const located: { entry: Entry; dataStart: number }[] = [];
  try {
    list = entries(fd, fstatSync(fd).size);
    for (const entry of list) {
      const local = readAt(fd, entry.localOffset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`corrupt zip: no local header for ${entry.name}`);
      located.push({ entry, dataStart: entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28) });
    }
  } finally {
    closeSync(fd);
  }

  mkdirSync(dest, { recursive: true });
  const realDest = realpathSync.native(dest);
  let files = 0;
  for (const { entry, dataStart } of located) {
    const rel = normalize(entry.name);
    if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error(`zip entry escapes the destination: ${entry.name}`);
    const target = join(dest, rel);
    const dir = entry.name.endsWith('/') ? target : dirname(target);
    // What does not exist yet has no link in it, so the nearest existing ancestor decides where it lands.
    if (!inside(realDest, realAncestor(dir))) throw new Error(`zip entry escapes the destination through a link: ${entry.name}`);
    mkdirSync(dir, { recursive: true });
    if (dir === target) continue;
    const parent = realpathSync.native(dir);
    const source = () => createReadStream(zip, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
    const kind = entry.mode & 0o170000;
    const mode = (entry.mode & 0o777) || 0o644;
    if (kind === 0o120000) {
      const chunks: Buffer[] = [];
      for await (const c of source()) chunks.push(c as Buffer);
      const link = (entry.method === 8 ? inflateRawSync(Buffer.concat(chunks)) : Buffer.concat(chunks)).toString('utf8');
      if (isAbsolute(link) || !inside(realDest, resolve(parent, link))) throw new Error(`zip entry ${entry.name} links outside the destination: ${link}`);
      symlinkSync(link, target);
    } else {
      if (entry.method !== 0 && entry.method !== 8) throw new Error(`zip entry ${entry.name} uses compression method ${entry.method}, which this reader does not handle`);
      // Exclusive creation does not follow a link at the final name, where a lexical check cannot tell
      // an earlier entry's link chain leads.
      try {
        if (entry.compressedSize === 0) writeFileSync(target, '', { mode, flag: 'wx' });
        else if (entry.method === 0) await pipeline(source(), createWriteStream(target, { mode, flags: 'wx' }));
        else await pipeline(source(), createInflateRaw(), createWriteStream(target, { mode, flags: 'wx' }));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`zip entry ${entry.name} would write over what already stands at its path`);
        throw e;
      }
    }
    files++;
  }
  return files;
}
