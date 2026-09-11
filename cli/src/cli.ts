#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { login } from "./commands/login.ts";
import { token } from "./commands/token.ts";
import { transcribe } from "./commands/transcribe.ts";
import { whisper } from "./commands/whisper.ts";
import { prep } from "./commands/prep.ts";
import { synthTimings } from "./commands/synth-timings.ts";
import { generate } from "./commands/generate.ts";
import { generateSet } from "./commands/generate-set.ts";
import { samplePresenterCommand } from "./commands/sample-presenter.ts";
import { backgroundRemoval } from "./commands/background-removal.ts";
import { lipsync } from "./commands/lipsync.ts";
import { installEngine } from "./commands/install-engine.ts";
import { installFfmpeg } from "./commands/install-ffmpeg.ts";
import { installWhisperx } from "./commands/install-whisperx.ts";
import { muxAudio } from "./commands/mux-audio.ts";
import { mixAudio } from "./commands/mix-audio.ts";
import { wcagPass } from "./commands/wcag-pass.ts";
import { gates } from "./commands/gates.ts";
import { expectWindows } from "./commands/expect-windows.ts";
import { generateRecipe } from "./commands/generate-recipe.ts";
import { sampleStyleCommand } from "./commands/sample-style.ts";
import { probeQaCommand } from "./commands/probe-qa.ts";
import { scopedEdit } from "./commands/scoped-edit.ts";
import { brandCommand } from "./commands/brand.ts";
import { creativeLog } from "./commands/creative-log.ts";
import { concatChapters } from "./commands/concat-chapters.ts";
import { concatVideosCommand } from "./commands/concat-videos.ts";
import { sceneFrames } from "./commands/scene-frames.ts";
import { cutFrames } from "./commands/cut-frames.ts";
import { speechProbe } from "./commands/speech-probe.ts";
import { applyEdl } from "./commands/apply-edl.ts";
import { retimeTranscript } from "./commands/retime-transcript.ts";
import { stillsCommand } from "./commands/stills.ts";
import { preview } from "./commands/preview.ts";
import { main as initMain } from "./commands/init.ts";
import { sessionStart } from "./commands/session-start.ts";
import { readiness } from "./commands/readiness.ts";
import { lint } from "./commands/lint.ts";
import { designGate } from "./commands/design-gate.ts";
import { contentRootCommand } from "./commands/content-root.ts";

// package.json sits two levels above both src/ (dev via tsx) and dist/ (published build): the
// package root is the repository root.
const pkg = createRequire(import.meta.url)("../../package.json") as {
  name: string;
  version?: string;
};

const HELP = `Usage: openedit <command> [options]

Commands:
  login          Log in with VEED (opens a browser; --manual to paste the redirect instead)
  token          Print a valid VEED access token for a pipe, refreshing if stale; masked when printed
                 to a terminal (--path prints the store location)
  transcribe     Transcribe videos: WhisperX locally by default, or --provider veed for VEED's hosted
                 transcription (--record <provider> records the choice; --force redoes an existing transcript)
  whisper        Map a Whisper-family JSON your own service produced into runs/<key>/transcript.json (--force replaces one)
  prep           Probe canvas, synthesize word timings, and cut base frames for source videos
  synth-timings  Even-split word reveal delays for one beat window (the creative-pass fallback)
  generate       Fabric generation, two passes: --script quotes and records the approval; --yes spends it
  generate-set   One approval covering several shots (--shots shots.json)
  sample-presenter  Seeded, deterministic Fabric presenter proposal for a run key
  background-removal  Remove a video's background (free VEED route; --fast bills your own fal key)
  lipsync        Re-lipsync a video to new audio (bills your own fal key; VEED login only hosts the files)
  install-engine  Download and verify the render engine into the app-data dir (optional release tag)
  install-ffmpeg  Install FFmpeg if nothing works already: env override → PATH → app-data download (Windows)
  install-whisperx  Install WhisperX into an isolated uv/pipx environment (optional version pin)
  mux-audio      Mux a run's audio onto its silent render at delivery loudness (--audio <file>; --no-loudnorm)
  mix-audio      Build one soundtrack from a run's mix spec (narration/music/sfx, with ducking)
  wcag-pass      Contrast-audit a rendered run via the engine's analyzer (--apply promotes the remediation)
  gates          THE gate chain: design → lint → verify → wcag → record → probe → mux, one command
  lint           Run the engine-limit gate on one document (--json)
  design-gate    Read a run's documents back against its own design system (--doc <subdir>, --json)
  content-root   Print the content tree this CLI resolves to (recipes, briefs, gates)
  expect-windows  Derive verify.expect timing assertions from a document's own gates (--write stamps them)
  generate-recipe  Run a workspace's compiled recipe for a sampled style, then drive the gate chain
  sample-style   Facet-scored, seeded style draw from the workspace's runtime index → style.json
  probe-qa       Frame QA of a recorded run vs its source footage
  scoped-edit    Prove an edit stayed inside its stated scope (baseline vs candidate .wv)
  brand          Validate a brand.json (--brief prints the design brief it implies)
  creative-log   Record accepted/rejected looks per footage, so a later pass knows what to avoid
  concat-chapters  Stream-copy a film's gated chapters into one deliverable
  concat-videos  Re-encode clips that disagree onto one canvas (--fit letterbox|crop|open)
  scene-frames   Stills for a clip with no beats
  cut-frames     Frames at every shot boundary (--json for the cut list)
  speech-probe   Measured speech onset, decay and safe cut gaps for a clip or a range (--json)
  apply-edl      Assemble the kept ranges of an EDL into one file, crossfading every join
  retime-transcript  Move existing per-word timings onto an EDL's timeline instead of transcribing again
  stills         Licensed stills from Wikimedia Commons: search / show / save (terms recorded with the file)
  preview        Localhost read-only preview of a run: scrub footage, follow the transcript, live-swap renders
  init           Workspace setup: check/install dependencies, clone the runtime, verify the engine
                 (--dry reports only; --auto-approve applies global installs after explicit user approval)
  readiness      Report what is present vs missing for a run (read-only, no network; exits 1 on a blocking miss)
  session-start  Agent SessionStart adapter: run init and print the context note (claude|codex|gemini)

Options:
  -v, --version  Print the version and exit
  -h, --help     Show this help and exit
`;

// Commands own their flags, so only the command word is dispatched here; everything
// after it goes to the command's own strict parser.
export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command.startsWith("-")) {
    let values: { version?: boolean; help?: boolean };
    try {
      ({ values } = parseArgs({
        args: argv,
        options: {
          version: { type: "boolean", short: "v" },
          help: { type: "boolean", short: "h" },
        },
      }));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      console.error(HELP);
      return 1;
    }
    if (values.version) {
      // version is stamped at publish; absent on a dev checkout
      console.log(pkg.version ?? "0.0.0-dev");
      return 0;
    }
    console.log(HELP);
    return 0;
  }

  try {
    switch (command) {
      case "login": {
        const { values } = parseArgs({
          args: rest,
          options: { manual: { type: "boolean" } },
        });
        await login({ manual: values.manual });
        return 0;
      }
      case "token": {
        const { values } = parseArgs({
          args: rest,
          options: { path: { type: "boolean" } },
        });
        return await token({ path: values.path });
      }
      case "transcribe":
        return await transcribe(rest);
      case "whisper":
        return await whisper(rest);
      case "prep":
        return await prep(rest);
      case "synth-timings":
        return synthTimings(rest);
      case "generate":
        return await generate(rest);
      case "generate-set":
        return await generateSet(rest);
      case "sample-presenter":
        return await samplePresenterCommand(rest);
      case "background-removal":
        return await backgroundRemoval(rest);
      case "lipsync":
        return await lipsync(rest);
      case "install-engine":
        return await installEngine(rest);
      case "install-ffmpeg":
        return await installFfmpeg(rest);
      case "install-whisperx":
        return await installWhisperx(rest);
      case "mux-audio":
        return muxAudio(rest);
      case "mix-audio":
        return mixAudio(rest);
      case "wcag-pass":
        return wcagPass(rest);
      case "gates":
        return gates(rest);
      case "expect-windows":
        return expectWindows(rest);
      case "generate-recipe":
        return await generateRecipe(rest);
      case "sample-style":
        return sampleStyleCommand(rest);
      case "probe-qa":
        return probeQaCommand(rest);
      case "scoped-edit":
        return scopedEdit(rest);
      case "brand":
        return brandCommand(rest);
      case "creative-log":
        return creativeLog(rest);
      case "concat-chapters":
        return concatChapters(rest);
      case "concat-videos":
        return await concatVideosCommand(rest);
      case "scene-frames":
        return sceneFrames(rest);
      case "cut-frames":
        return cutFrames(rest);
      case "speech-probe":
        return speechProbe(rest);
      case "apply-edl":
        return applyEdl(rest);
      case "retime-transcript":
        return retimeTranscript(rest);
      case "stills":
        return await stillsCommand(rest);
      case "preview":
        return await preview(rest);
      case "init":
        return await initMain(rest);
      case "session-start":
        return await sessionStart(rest);
      case "readiness":
        return readiness(rest);
      case "lint":
        return await lint(rest);
      case "design-gate":
        return await designGate(rest);
      case "content-root":
        return contentRootCommand(rest);
      default:
        console.error(`Unknown command: ${command}`);
        console.error(HELP);
        return 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exitCode = await run(process.argv.slice(2));
