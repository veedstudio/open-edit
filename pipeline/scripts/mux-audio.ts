// MUX AUDIO — restore the soundtrack. veed-engine-cli renders video only; this muxes the original audio
// onto the clean silent render. Deterministic; run OUTSIDE any sandbox is NOT required (ffmpeg only).
//
//   node --import tsx pipeline/scripts/mux-audio.ts <run-dir> [--doc final] [--audio <file>]
// Audio comes from --audio when given, else from <run-dir>/meta.json's source video. Muxes
// <run-dir>/<doc>/out.silent.mp4 -> out.mp4, where <doc> defaults to final.
//   VEED_ENGINE_FFMPEG  ffmpeg (default: ffmpeg on PATH)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { FFMPEG, FFPROBE } from '../../config.ts';

const fail = (msg: string, code: number): never => {
  console.error(msg);
  process.exit(code);
};

const [dir, ...rest] = process.argv.slice(2);
if (!dir) fail('usage: mux-audio.ts <run-dir> [--doc final] [--audio <file>]', 2);
// A film gates and delivers one chapter at a time, and its audio is a built mix rather than the
// source clip's track — hardcoding both was why the chain's own --doc flag stopped at the engine.
let doc = 'final';
let audio = '';
while (rest.length > 0) {
  const flag = rest.shift();
  switch (flag) {
    case '--doc': doc = rest.shift() ?? fail('--doc needs a subdirectory', 2); break;
    case '--audio': audio = rest.shift() ?? fail('--audio needs a file', 2); break;
    default: fail(`mux-audio: unknown flag ${flag}`, 2);
  }
}

const silent = join(dir, doc, 'out.silent.mp4');
const outPath = join(dir, doc, 'out.mp4');
if (!existsSync(silent)) fail(`mux: missing ${silent} (render first)`, 1);

// The audio is either a track that was BUILT for this run (a mix of narration, music and effects) or
// the source clip's own. Only the second needs meta.json — a run with no footage has none, and
// requiring it was why the footage-free path failed at its last gate.
let src: string;
if (audio) {
  src = audio;
  if (!existsSync(src)) fail(`mux: no audio at ${src}`, 1);
} else {
  const metaPath = join(dir, 'meta.json');
  if (!existsSync(metaPath)) fail(`mux: no ${metaPath} and no --audio — say which track to lay on`, 2);
  const videoPath = (JSON.parse(readFileSync(metaPath, 'utf8')) as { videoPath?: string }).videoPath ?? '';
  if (!videoPath || !existsSync(videoPath)) fail(`mux: could not resolve source video from ${metaPath}`, 1);
  src = videoPath;
}

const probe = (args: string[]) => {
  try {
    return execFileSync(FFPROBE, args, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

// -map 1:a:0? tolerates a source with no audio track (out.mp4 then == silent render).
// Write to a tmp name and rename: out.mp4 is watched live by the preview server, so its
// existence must mean completeness (a moov-less in-progress file plays as broken "done").
// +faststart keeps moov up front (the engine records it that way; default muxing would move it
// to the tail, making the deliverable start slower anywhere without Range support).
const tmp = join(dir, doc, 'out.tmp.mp4');
// The PICTURE decides the length. `-shortest` let a built mix truncate the film — a 2s track over a
// 6s render wrote a 2s deliverable and exited 0, which destroys work without saying so.
const vdur = probe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', silent])
  || probe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', silent]);
if (!vdur) fail(`mux: could not read the duration of ${silent}`, 1);
try {
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', silent, '-i', src,
    '-map', '0:v:0', '-map', '1:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-t', vdur, '-movflags', '+faststart', tmp,
  ], { stdio: ['ignore', 'inherit', 'inherit'] });
} catch {
  process.exit(1);
}
renameSync(tmp, outPath);
console.log(`mux: wrote ${outPath}`);
