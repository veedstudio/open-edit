// The review: every delivery check, run on a render and printed as one report for the agent to read
// before it delivers. It reports only. It never edits the video or asks for a re-render, and it exits 0
// whatever it finds, so a finding is a judgement for the agent rather than a failure to retry. It exits
// non-zero only when it cannot run at all, such as a bad call, a file ffprobe cannot read or measure a
// picture in, a --transcript that is missing or malformed, or a --length that is not a positive number.
//
//   openedit review <video> [--transcript <transcript.json>] [--length <sec>]
//
// A check that compares against speech reads the transcript named, else the transcript.json in the
// render's own folder: the piece's folder, not a transcript keyed by file name, which another piece's
// render of the same name could have written. It never transcribes: that would bill the recorded
// provider, or take minutes of local compute, on every review. A check of on-screen text reads the record
// `openedit render` wrote beside the video, `<video>.text.json`, which mux-audio carries to its output.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { numberFlag, parseUsage, usageLine, type Usage } from '../args.ts';
import { FFPROBE } from '../config.ts';
import { pictureDurationOf, probeDisplaySize } from '../probe.ts';
import { readRecord, recordPath, recordSeconds, timeOf, type TextRecord } from '../render/text-record.ts';
import {
  CHECKS, type Check, type CheckReport, type LengthInput, type ReviewContext, type TextRecordInput, type TranscriptInput, type Verdict,
} from '../verify/checks.ts';
import { readTranscript } from './retime-transcript.ts';

export const usage = {
  summary: 'Run every delivery check on a render and print one report; changes nothing',
  positionals: '<video>',
  flags: {
    transcript: {
      type: 'string',
      value: '<transcript.json>',
      help: "The transcript on the video's timeline (default: transcript.json in the video's folder)",
    },
    length: {
      type: 'string',
      value: '<sec>',
      help: 'The length the video should run, in seconds (without it, the length check is skipped)',
    },
  },
  notes: 'Exits 0 whenever the review ran, findings or not: a finding is for you to judge, not an error.',
} satisfies Usage;

/** The transcript the checks compare against: the one named, else the one in the video's folder, else why there is none. */
export function transcriptFor(video: string, named: string | undefined): TranscriptInput {
  // A named file that cannot be read is a mistake in the call, so it stops the review rather than being skipped.
  if (named !== undefined) {
    if (!existsSync(named)) throw new Error(`transcript not found: ${named}`);
    return { path: named, transcript: readTranscript(named) };
  }
  const beside = join(dirname(video), 'transcript.json');
  if (!existsSync(beside)) return { missing: `no transcript at ${beside}, and none named with --transcript` };
  try {
    return { path: beside, transcript: readTranscript(beside) };
  } catch (error) {
    return { missing: (error as Error).message };
  }
}

/**
 * The record of the video's on-screen text, or why there is none. A record for another picture is set aside rather
 * than trusted, since its boxes would land on the wrong pixels: one of another size or length, or one older than the
 * video, which render and mux-audio always write after it.
 */
export function textRecordFor(video: string, duration: number): TextRecordInput {
  const path = recordPath(video);
  if (!existsSync(path)) {
    return {
      missing: `no record of on-screen text at ${path}: openedit render writes one beside each video and mux-audio carries it along, `
        + 'so this video was made another way, or before render wrote one, or render could not read its page\'s text',
    };
  }
  let record: TextRecord;
  try {
    record = readRecord(path);
  } catch (error) {
    return { missing: (error as Error).message };
  }
  if (statSync(path).mtimeMs < statSync(video).mtimeMs) {
    return { missing: `${path} is older than the video, so it describes a picture written there before` };
  }
  const seconds = recordSeconds(record);
  const { width, height } = probeDisplaySize(video);
  // A frame and a half either way: a container may round the picture's length by up to a frame.
  if (record.width !== width || record.height !== height || Math.abs(seconds - duration) > 1.5 * timeOf(record, 1)) {
    return {
      missing: `${path} is for a ${record.width}x${record.height} picture of ${seconds.toFixed(2)}s and this one is ${width}x${height} of `
        + `${duration.toFixed(2)}s, so it describes another render`,
    };
  }
  return { path, record };
}

/** The length asked for, or why there is none; a value that is not a length is a mistake in the call and stops the review. */
export function lengthFor(raw: string | undefined): LengthInput {
  if (raw === undefined) return { missing: 'none given with --length' };
  return { seconds: numberFlag('length', raw, 30, (n) => n > 0, 'seconds above 0') };
}

/** An error's first line, with the last line a failed tool wrote to stderr: its own reason, which a spawn's message buries. */
function reasonOf(error: unknown): string {
  const first = (error instanceof Error ? error.message : String(error)).split('\n')[0];
  const spawned = error instanceof Error ? ((error.cause ?? error) as { stderr?: unknown }) : undefined;
  const said = String(spawned?.stderr ?? '').trim().split('\n').pop()?.trim();
  return said && !first.includes(said) ? `${first} (${said})` : first;
}

/** Seconds of picture, or a refusal saying why the file cannot be reviewed. */
export function pictureSeconds(video: string): number {
  // Asked quietly first: the shared probe lets ffprobe's own error text through to the terminal.
  const probe = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', video], {
    encoding: 'utf8',
  });
  if (probe.error) throw new Error(`cannot review ${video}: ffprobe could not run (${probe.error.message})`);
  if (probe.status !== 0) {
    const said = (probe.stderr ?? '').trim().split('\n').pop();
    throw new Error(`cannot review ${video}: ffprobe cannot read it${said ? ` (${said})` : ''}`);
  }
  if (probe.stdout.trim() === '') throw new Error(`cannot review ${video}: it has no video stream`);
  return pictureDurationOf(video);
}

/** The report: a heading, one block per check, and a footer counting the verdicts. */
export async function reviewReport(context: ReviewContext, checks: readonly Check[] = CHECKS): Promise<string[]> {
  const lines = [`review: ${context.video}`];
  const width = Math.max(...checks.map((c) => c.name.length));
  const tally: Record<Verdict, number> = { found: 0, pass: 0, skipped: 0 };
  let partial = 0;
  let crashed = 0;
  for (const check of checks) {
    let report: CheckReport;
    try {
      report = await check.run(context);
      tally[report.verdict]++;
    } catch (error) {
      // One check that cannot run must not hide what the others found.
      report = { verdict: 'skipped', lines: [], skipped: [`the whole check: ${reasonOf(error)}`] };
      crashed++;
    }
    if (report.verdict === 'pass' && report.skipped.length > 0) partial++;
    const body = [...report.lines, ...report.skipped.map((reason) => `skipped: ${reason}`)];
    const lead = `${check.name.padEnd(width)}  ${(report.verdict === 'found' ? 'FOUND' : report.verdict).padEnd(7)}  `;
    lines.push(`${lead}${body[0] ?? ''}`.trimEnd());
    for (const line of body.slice(1)) lines.push(`${''.padEnd(lead.length)}${line}`);
  }
  // Counted apart, so a review in which something could not be measured never reads as a clean one, and a
  // check that broke never hides among those that were given nothing to compare.
  const passed = partial ? `${tally.pass} passed (${partial} with a comparison skipped)` : `${tally.pass} passed`;
  const counts = `${tally.found} found something, ${passed}, ${tally.skipped} skipped, ${crashed} could not run`;
  lines.push(
    tally.found === 0
      ? `Checks: ${counts}. The video was not changed.`
      : `Checks: ${counts}. The video was not changed: each finding is yours to judge, and one you leave in ` +
        'place is worth a word to the user.',
  );
  return lines;
}

export async function review(argv: string[]): Promise<number> {
  const { values, positionals } = parseUsage('review', usage, argv);
  const video = positionals[0];
  if (!video || positionals.length > 1) throw new Error(usageLine('review', usage));
  if (!existsSync(video)) throw new Error(`video not found: ${video}`);
  const askedLength = lengthFor(values.length);
  const duration = pictureSeconds(video);
  const transcript = transcriptFor(video, values.transcript);
  const textRecord = textRecordFor(video, duration);
  for (const line of await reviewReport({ video, duration, transcript, askedLength, textRecord })) console.log(line);
  return 0;
}
