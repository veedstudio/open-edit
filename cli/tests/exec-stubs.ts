// The npm emulation the init fixtures share: writes what the real install writes and logs the action —
// one copy, so the suites cannot drift on what "npm ran" means.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** `shipsSkill: false` installs a package without the skill a real one carries. */
export interface NpmAddHost { actionLog: string; npmAddFails: boolean; shipsSkill?: boolean }

const CLI = '@veedstudio/openedit-cli';

// What the project then runs: init reads the installed version, and after any install it ran the skill, from here.
function plantCli(host: NpmAddHost, cwd: string, version: string): void {
  const dir = join(cwd, 'node_modules', '@veedstudio', 'openedit-cli');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: CLI, version }));
  if (host.shipsSkill === false) return;
  mkdirSync(join(dir, '.claude', 'skills', 'open-edit'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'skills', 'open-edit', 'SKILL.md'), `skill of ${version}\n`);
}
const installedVersionOf = (spec: string) => (/^\d+\.\d+\.\d+$/.test(spec) ? spec : '0.0.0-stub');

/** `npm install --save-dev <spec>` (the pin) and bare `npm install` (a clone's pin); null for anything else. */
export function emulateNpmAdd(host: NpmAddHost, args: string[], cwd: string): { status: number; stdout: string; stderr: string } | null {
  const pkgPath = join(cwd, 'package.json');
  if (args[0] === 'install' && !args.includes('--save-dev') && !args.includes('--global')) {
    appendFileSync(host.actionLog, 'npm-install\n');
    if (host.npmAddFails) return { status: 1, stdout: '', stderr: 'npm ERR! network' };
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { devDependencies?: Record<string, string> };
    plantCli(host, cwd, installedVersionOf(pkg.devDependencies?.[CLI] ?? ''));
    return { status: 0, stdout: '', stderr: '' };
  }
  if (args[0] !== 'install' || !args.includes('--save-dev')) return null;
  const spec = args[args.length - 1];
  appendFileSync(host.actionLog, `npm-add:${spec}\n`);
  if (host.npmAddFails) return { status: 1, stdout: '', stderr: 'npm ERR! network' };
  const at = spec.lastIndexOf('@');
  // A tarball path carries no name; npm keys it under the package's own.
  const name = at > 0 ? spec.slice(0, at) : CLI;
  const version = at > 0 ? spec.slice(at + 1) : spec;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; devDependencies?: Record<string, string> };
  pkg.devDependencies = { ...pkg.devDependencies, [name]: version.replace(/^file:/, '') };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({ name: pkg.name, lockfileVersion: 3, pinned: pkg.devDependencies }));
  if (name === CLI) plantCli(host, cwd, installedVersionOf(version));
  return { status: 0, stdout: '', stderr: '' };
}
