import { readFileSync } from 'node:fs';

/** JSON.parse with the file named in the error: "Unexpected end of JSON input" alone says nothing about which file. */
export function readJsonFile(path: string): unknown {
  const text = readFileSync(path, 'utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(`${path}: ${(cause as Error).message}`, { cause });
  }
}
