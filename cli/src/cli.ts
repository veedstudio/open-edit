#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { parseUsage, renderUsage, usageLine, type Usage } from "./args.ts";
import * as login from "./commands/login.ts";
import * as token from "./commands/token.ts";
import * as transcribe from "./commands/transcribe.ts";
import * as whisper from "./commands/whisper.ts";
import * as prep from "./commands/prep.ts";
import * as synthTimings from "./commands/synth-timings.ts";
import * as generate from "./commands/generate.ts";
import * as generateSet from "./commands/generate-set.ts";
import * as samplePresenter from "./commands/sample-presenter.ts";
import * as backgroundRemoval from "./commands/background-removal.ts";
import * as lipsync from "./commands/lipsync.ts";
import * as installEngine from "./commands/install-engine.ts";
import * as installFfmpeg from "./commands/install-ffmpeg.ts";
import * as installWhisperx from "./commands/install-whisperx.ts";
import * as muxAudio from "./commands/mux-audio.ts";
import * as mixAudio from "./commands/mix-audio.ts";
import * as wcagPass from "./commands/wcag-pass.ts";
import * as gates from "./commands/gates.ts";
import * as lint from "./commands/lint.ts";
import * as contentRoot from "./commands/content-root.ts";
import * as enginePath from "./commands/engine-path.ts";
import * as expectWindows from "./commands/expect-windows.ts";
import * as generateRecipe from "./commands/generate-recipe.ts";
import * as sampleStyle from "./commands/sample-style.ts";
import * as safezoneCheck from "./commands/safezone-check.ts";
import * as checkDelivery from "./commands/check-delivery.ts";
import * as measurePlacement from "./commands/measure-placement.ts";
import * as scopedEdit from "./commands/scoped-edit.ts";
import * as brand from "./commands/brand.ts";
import * as creativeLog from "./commands/creative-log.ts";
import * as concatChapters from "./commands/concat-chapters.ts";
import * as concatVideos from "./commands/concat-videos.ts";
import * as sceneFrames from "./commands/scene-frames.ts";
import * as cutFrames from "./commands/cut-frames.ts";
import * as frames from "./commands/frames.ts";
import * as speechProbe from "./commands/speech-probe.ts";
import * as applyEdl from "./commands/apply-edl.ts";
import * as retimeTranscript from "./commands/retime-transcript.ts";
import * as stills from "./commands/stills.ts";
import * as preview from "./commands/preview.ts";
import * as init from "./commands/init.ts";
import * as readiness from "./commands/readiness.ts";
import * as sessionStart from "./commands/session-start.ts";

// package.json sits two levels above both src/ (dev via tsx) and dist/ (published build): the
// package root is the repository root.
const pkg = createRequire(import.meta.url)("../../package.json") as {
  name: string;
  version?: string;
};

type Command = { usage: Usage; run: (argv: string[]) => number | Promise<number> };

// Every command, in the order the top-level help lists them. Each owns its flags through the
// `usage` it exports; the parser and both help views are derived from that one declaration.
const COMMANDS: Record<string, Command> = {
  login: {
    usage: login.usage,
    run: async (argv) => {
      const { values } = parseUsage("login", login.usage, argv);
      await login.login({ manual: values.manual });
      return 0;
    },
  },
  token: {
    usage: token.usage,
    run: (argv) => token.token({ path: parseUsage("token", token.usage, argv).values.path }),
  },
  transcribe: { usage: transcribe.usage, run: transcribe.transcribe },
  whisper: { usage: whisper.usage, run: whisper.whisper },
  prep: { usage: prep.usage, run: prep.prep },
  "synth-timings": { usage: synthTimings.usage, run: synthTimings.synthTimings },
  generate: { usage: generate.usage, run: generate.generate },
  "generate-set": { usage: generateSet.usage, run: generateSet.generateSet },
  "sample-presenter": { usage: samplePresenter.usage, run: samplePresenter.samplePresenterCommand },
  "background-removal": { usage: backgroundRemoval.usage, run: backgroundRemoval.backgroundRemoval },
  lipsync: { usage: lipsync.usage, run: lipsync.lipsync },
  "install-engine": { usage: installEngine.usage, run: installEngine.installEngine },
  "install-ffmpeg": { usage: installFfmpeg.usage, run: installFfmpeg.installFfmpeg },
  "install-whisperx": { usage: installWhisperx.usage, run: installWhisperx.installWhisperx },
  "mux-audio": { usage: muxAudio.usage, run: muxAudio.muxAudio },
  "mix-audio": { usage: mixAudio.usage, run: mixAudio.mixAudio },
  "wcag-pass": { usage: wcagPass.usage, run: wcagPass.wcagPass },
  gates: { usage: gates.usage, run: gates.gates },
  lint: { usage: lint.usage, run: lint.lint },
  "content-root": { usage: contentRoot.usage, run: contentRoot.contentRootCommand },
  "engine-path": { usage: enginePath.usage, run: enginePath.enginePathCommand },
  "expect-windows": { usage: expectWindows.usage, run: expectWindows.expectWindows },
  "generate-recipe": { usage: generateRecipe.usage, run: generateRecipe.generateRecipe },
  "sample-style": { usage: sampleStyle.usage, run: sampleStyle.sampleStyleCommand },
  "safezone-check": { usage: safezoneCheck.usage, run: safezoneCheck.safezoneCheckCommand },
  "check-delivery": { usage: checkDelivery.usage, run: checkDelivery.checkDeliveryCommand },
  "measure-placement": { usage: measurePlacement.usage, run: measurePlacement.measurePlacementCommand },
  "scoped-edit": { usage: scopedEdit.usage, run: scopedEdit.scopedEdit },
  brand: { usage: brand.usage, run: brand.brandCommand },
  "creative-log": { usage: creativeLog.usage, run: creativeLog.creativeLog },
  "concat-chapters": { usage: concatChapters.usage, run: concatChapters.concatChapters },
  "concat-videos": { usage: concatVideos.usage, run: concatVideos.concatVideosCommand },
  "scene-frames": { usage: sceneFrames.usage, run: sceneFrames.sceneFrames },
  "cut-frames": { usage: cutFrames.usage, run: cutFrames.cutFrames },
  frames: { usage: frames.usage, run: frames.frames },
  "speech-probe": { usage: speechProbe.usage, run: speechProbe.speechProbe },
  "apply-edl": { usage: applyEdl.usage, run: applyEdl.applyEdl },
  "retime-transcript": { usage: retimeTranscript.usage, run: retimeTranscript.retimeTranscript },
  stills: { usage: stills.usage, run: stills.stillsCommand },
  preview: { usage: preview.usage, run: preview.preview },
  init: { usage: init.usage, run: (argv) => init.main(argv) },
  readiness: { usage: readiness.usage, run: readiness.readiness },
  "session-start": { usage: sessionStart.usage, run: sessionStart.sessionStart },
};

// The top-level list carries each command's summary AND its grammar, so an agent reading this once
// knows every flag by name; `<command> --help` adds what each flag does.
function topLevelHelp(): string {
  const names = Object.keys(COMMANDS);
  const width = Math.max(...names.map((n) => n.length));
  const lines = [
    "Usage: openedit <command> [options]",
    "       openedit <command> --help   the command's flags and positionals, with what each does",
    "",
    "Commands:",
  ];
  for (const [name, { usage }] of Object.entries(COMMANDS)) {
    lines.push(`  ${name.padEnd(width)}  ${usage.summary}`);
    lines.push(`  ${"".padEnd(width)}  ${usageLine(name, usage).replace(/^usage: /, "")}`);
  }
  lines.push("", "Options:", "  -v, --version  Print the version and exit", "  -h, --help     Show this help and exit");
  return `${lines.join("\n")}\n`;
}

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
      console.error(topLevelHelp());
      return 1;
    }
    if (values.version) {
      // version is stamped at publish; absent on a dev checkout
      console.log(pkg.version ?? "0.0.0-dev");
      return 0;
    }
    console.log(topLevelHelp());
    return 0;
  }

  const entry = COMMANDS[command];
  if (!entry) {
    console.error(`Unknown command: ${command}`);
    console.error(topLevelHelp());
    return 1;
  }

  // Answered here because no command's parser accepts --help, and several would read it as a path
  // or a version. Anything after `--` is the command's own positional, so it is not looked at.
  const own = rest.indexOf("--") === -1 ? rest : rest.slice(0, rest.indexOf("--"));
  if (own.includes("--help") || own.includes("-h")) {
    console.log(renderUsage(command, entry.usage));
    return 0;
  }

  try {
    return await entry.run(rest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exitCode = await run(process.argv.slice(2));
