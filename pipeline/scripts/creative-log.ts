// What has already been tried on a piece of footage, and why the accepted version was accepted.
//
// The launch session carried both by hand. Every creative brief it wrote ended with an "ALREADY TRIED
// ON THIS CLIP AND REJECTED" list and, once something landed, a sentence naming why: "the colours
// worked with the background rather than fighting it, it was graphic, bright and punchy, and the
// typefaces were interestingly chosen." That worked — the later rounds genuinely diverged — but it
// lived in the orchestrator's context, which means it was retyped for every agent and erased by the
// first compaction. Three rounds of "you approached them all the same way" came from exactly that.
//
// The log is keyed by the SOURCE VIDEO, not the run: rounds two, three and four of a treatment are
// different run dirs on the same footage, and it is the footage that accumulates history.
//
//   creative-log.ts --for <video> --reject "<what it was>" --why "<why it was rejected>"
//   creative-log.ts --for <video> --accept "<aesthetic>"   --why "<why it landed>"
//   creative-log.ts --for <video> --brief          # the accumulated history, ready to paste
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFlags } from '../../veed/args.ts';
import { REPO_ROOT } from '../../config.ts';

export interface Attempt { what: string; why: string }
export interface CreativeLog {
  source: string;
  rejected: Attempt[];
  /** The last accepted look. A later acceptance replaces it; the rejections only ever accumulate. */
  accepted?: Attempt;
}

// Overridable so a test never writes into the real one. The suite once deleted the production log on
// every run — the artifact whose whole purpose is surviving a compaction did not survive `pnpm test`.
const LOG_PATH = process.env.OPEN_EDIT_CREATIVE_LOG ?? join(REPO_ROOT, 'runs', '.creative-log.json');

type Store = Record<string, CreativeLog>;

let corrupt = false;

function load(): Store {
  corrupt = false;
  if (!existsSync(LOG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(LOG_PATH, 'utf8')) as Store;
  } catch {
    // Reading through a corrupt log is fine — history is a helper, not a gate. Writing through it is
    // not: the empty fallback would erase the reject/accept history of every clip on the machine.
    corrupt = true;
    return {};
  }
}

function save(store: Store): void {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  if (corrupt && existsSync(LOG_PATH)) {
    let dest = LOG_PATH.replace(/\.json$/, '.corrupt.json');
    let n = 1;
    while (existsSync(dest)) dest = LOG_PATH.replace(/\.json$/, `.corrupt.${n++}.json`);
    renameSync(LOG_PATH, dest);
    process.stderr.write(`[creative-log] the log could not be parsed and was kept at ${dest}; starting a new one\n`);
    corrupt = false;
  }
  writeFileSync(LOG_PATH, JSON.stringify(store, null, 2) + '\n');
}

export function logFor(source: string, store: Store = load()): CreativeLog {
  const key = resolve(source);
  return store[key] ?? { source: key, rejected: [] };
}

export function reject(source: string, what: string, why: string): CreativeLog {
  const store = load();
  const log = logFor(source, store);
  // The same attempt reported twice is one attempt; a re-run should not inflate the history.
  if (!log.rejected.some((r) => r.what === what)) log.rejected.push({ what, why });
  store[log.source] = log;
  save(store);
  return log;
}

export function accept(source: string, what: string, why: string): CreativeLog {
  const store = load();
  const log = logFor(source, store);
  log.accepted = { what, why };
  store[log.source] = log;
  save(store);
  return log;
}

/**
 * The history as prompt-ready prose. Empty when nothing has been tried, so a first round carries no
 * ceremony — and a design pass never has to be told that the list is empty.
 */
export function briefFor(source: string): string {
  const log = logFor(source);
  const parts: string[] = [];
  if (log.accepted) {
    parts.push(
      `WHAT THE CLIENT ACCEPTED ON THIS FOOTAGE, AND WHY — this is the bar, not a thing to copy:\n` +
      `  ${log.accepted.what}\n  Why it landed: ${log.accepted.why}`,
    );
  }
  if (log.rejected.length) {
    parts.push(
      `ALREADY TRIED ON THIS FOOTAGE AND REJECTED — do not land on any of these again:\n` +
      log.rejected.map((r) => `  · ${r.what}${r.why ? ` — rejected because ${r.why}` : ''}`).join('\n'),
    );
  }
  return parts.join('\n\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseFlags({
    args: process.argv.slice(2),
    options: {
      for: { type: 'string' },
      reject: { type: 'string' },
      accept: { type: 'string' },
      why: { type: 'string' },
      brief: { type: 'boolean' },
    },
  });
  const source = values.for;
  if (!source) {
    console.error('usage: creative-log.ts --for <video> [--reject "<what>" --why "<why>"] [--accept "<aesthetic>" --why "<why>"] [--brief]');
    process.exit(2);
  }
  if (values.brief) {
    const text = briefFor(source);
    console.log(text || '(nothing tried on this footage yet)');
    process.exit(0);
  }
  if (values.reject === undefined && values.accept === undefined) {
    console.error('nothing to record: pass --reject, --accept, or --brief');
    process.exit(2);
  }
  // A rejection with no reason is the part that stops being useful three rounds later, when nobody
  // remembers whether the look was wrong or merely early.
  if (!values.why) {
    console.error('--why is required: a list of rejected looks with no reasons cannot tell a later pass what to avoid');
    process.exit(2);
  }
  const log = values.accept !== undefined
    ? accept(source, values.accept, values.why)
    : reject(source, values.reject!, values.why);
  console.log(`[creative-log] ${values.accept !== undefined ? 'accepted' : 'rejected'} recorded — ${log.rejected.length} rejection(s) on file for this footage`);
}
