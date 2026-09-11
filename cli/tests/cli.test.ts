import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(...args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    encoding: "utf8",
  });
}

test("--version prints the stamped version, or the dev marker on an unstamped checkout", () => {
  assert.equal(runCli("--version").trim(), pkg.version ?? "0.0.0-dev");
});

test("no arguments prints usage", () => {
  assert.match(runCli(), /Usage: openedit/);
});

// Moved from the repository's cli-entry suite with the prep/whisper commands themselves:
// a stray flag must be named, never read as a file path. `whisper` now takes --force (it writes the
// same transcript.json the other providers guard), so it names its valid flag instead of denying all.
test("prep and whisper name a stray flag, rather than reading one as a path", () => {
  for (const [command, expected] of [
    ["prep", /This command takes no flags/],
    ["whisper", /Valid flags: --force/],
  ] as const) {
    try {
      execFileSync(process.execPath, ["--import", "tsx", cliPath, command, "--json", "a.mp4"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.fail(`${command} accepted an unknown flag`);
    } catch (error) {
      const e = error as { status?: number; stderr?: string };
      assert.equal(e.status, 1, command);
      assert.match(e.stderr ?? "", /Unknown option '--json'/, command);
      assert.match(e.stderr ?? "", expected, command);
    }
  }
});
