// The hosted analysis that makes a clip's speakers file, where the environment names one: OPEN_EDIT_SPEAKERS_ANALYSIS
// holds the fal model to run, and with it unset nothing here is ever called. The model takes the clip as `video_url`
// and answers with a speakers file (speakers.ts), which faces maps as it maps one named with --speakers.
//
// It runs on whichever fal the environment has. On a fal key this process can read it goes through the code
// `openedit fal run` runs, so the clip is uploaded, the request bought once, resumed by a later run and recorded
// like any other. With no key, the fal command an environment gives in its place runs it, and prices and approves it;
// its own lines are passed on as it prints them. On both routes the answer is waited for WAIT_MS, and the command is
// stopped then.
import { statSync } from 'node:fs';
import { runFalJobs } from '../commands/fal.ts';
import { containerDurationOf, hasAudioStream, probeVideoSpan } from '../probe.ts';
import { errorText } from '../proxy.ts';
import type { Http } from '../providers/fal.ts';
import { FalCommandFailed, runFalCommand, type Runner } from '../providers/fal-command.ts';
import type { FalRoute } from '../providers/fal-route.ts';
import { SPEAKERS_BYTES } from './speakers.ts';

export const ANALYSIS_ENV = 'OPEN_EDIT_SPEAKERS_ANALYSIS';

const MODEL_ID = /^[A-Za-z0-9][\w.-]*(\/[\w.-]+)+$/;

/** The fal model the environment names for speakers files, or null when it names none. */
export function analysisNamed(env: NodeJS.ProcessEnv = process.env): string | null {
  const named = env[ANALYSIS_ENV]?.trim();
  if (!named) return null;
  if (!MODEL_ID.test(named)) {
    throw new Error(`${ANALYSIS_ENV} is ${JSON.stringify(named)}, which is not a fal model id (owner/name): unset it, or pass --local, and faces finds the shots and the faces itself`);
  }
  return named;
}

// What the analysis takes: a clip with sound, at most ten minutes long and 4 GB. It refuses any other only once the
// clip is uploaded and its request queued, so one outside these is not sent.
const LONGEST_SEC = 600;
const LARGEST_BYTES = 4e9;

/** A clip as the analysis's limits read it. */
interface Sendable { sound: boolean; seconds: number; bytes: number }

export const sendable = (video: string): Sendable =>
  ({ sound: hasAudioStream(video), seconds: containerDurationOf(video) ?? probeVideoSpan(video).end, bytes: statSync(video).size });

/** Why the analysis would refuse this clip, or null when it takes it. */
export function whyNotSent(clip: Sendable): string | null {
  if (!clip.sound) return 'the clip has no sound, and the analysis tells who is speaking by it';
  if (clip.seconds > LONGEST_SEC) return `the clip is ${(clip.seconds / 60).toFixed(1)} minutes long, and the analysis takes at most ${LONGEST_SEC / 60}`;
  if (clip.bytes > LARGEST_BYTES) return `the clip is ${(clip.bytes / 1e9).toFixed(1)} GB, and the analysis takes at most ${LARGEST_BYTES / 1e9}`;
  return null;
}

// A request may wait minutes for the analysis to start and then run for up to half an hour, so its answer is waited
// for that long: a wait given up sooner would send a clip that is being analysed to the local detector.
export const WAIT_MS = 40 * 60_000;

/** The analysis ran and gave no speakers file: it refused the clip, failed, or was not answered in time. */
export class AnalysisFailed extends Error {}

export interface AnalysisRun {
  /** The clip's run folder, whose job ledger keeps the request from being bought twice. */
  runDir: string;
  /** Where the answer's files land: on a key in this folder, through the command in a folder made in it for the run. */
  dir: string;
  route: Exclude<FalRoute, { how: 'none' }>;
  log: (line: string) => void;
  http?: Http;
  run?: Runner;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs the analysis `model` on `video` and gives the speakers file it answered with, and the request's id where it
 * is known. A refusal, a failure and an answer that never came are an AnalysisFailed whose message is one line.
 */
export async function runAnalysis(model: string, video: string, o: AnalysisRun): Promise<{ file: string; requestId?: string }> {
  if (o.route.how === 'key') {
    const [outcome] = await runFalJobs([{ name: 'speakers', model, input: { video_url: video }, bases: [], outDir: o.dir, largestBytes: SPEAKERS_BYTES }],
      { key: o.route.key, ledgerRoot: o.runDir, timeoutMs: WAIT_MS, http: o.http, log: o.log, sleep: o.sleep })
      .catch((e) => { throw new AnalysisFailed(errorText(e).split('\n')[0], { cause: e }); });
    if (outcome.error) throw new AnalysisFailed(outcome.error.split('\n')[0]);
    const file = outcome.files?.find((f) => /\.json$/i.test(f));
    if (!file) throw new AnalysisFailed('its answer held no speakers file');
    return { file, requestId: outcome.requestId };
  }
  const answer = await runFalCommand({ fal: o.route.fal, model, input: { video_url: video }, under: o.dir, waitMs: WAIT_MS, log: o.log, largest: SPEAKERS_BYTES, run: o.run })
    .catch((e) => { throw e instanceof FalCommandFailed ? new AnalysisFailed(e.message, { cause: e }) : e; });
  const file = answer.files.find((f) => /\.json$/i.test(f));
  if (!file) {
    throw new AnalysisFailed(`the environment's fal command left no speakers file in the folder it was given` +
      `${answer.passedOver ? ` (${answer.passedOver} thing(s) there are not a plain file of at most ${SPEAKERS_BYTES >> 20} MB)` : ''}`);
  }
  return { file, requestId: answer.requestId };
}
