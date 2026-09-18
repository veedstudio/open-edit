// The npm dep-add emulation the init fixtures share: writes what the real install writes and logs
// the action — one copy, so the suites cannot drift on what "npm ran" means.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface NpmAddHost { actionLog: string; npmAddFails: boolean }

export function emulateNpmAdd(host: NpmAddHost, args: string[], cwd: string): { status: number; stdout: string; stderr: string } | null {
  if (args[0] !== 'install' || !args.includes('--save-dev')) return null;
  const spec = args[args.length - 1];
  appendFileSync(host.actionLog, `npm-add:${spec}\n`);
  if (host.npmAddFails) return { status: 1, stdout: '', stderr: 'npm ERR! network' };
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  const version = at > 0 ? spec.slice(at + 1) : '0.0.0-stub';
  const pkgPath = join(cwd, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; devDependencies?: Record<string, string> };
  pkg.devDependencies = { ...pkg.devDependencies, [name]: version.replace(/^file:/, '') };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({ name: pkg.name, lockfileVersion: 3, pinned: pkg.devDependencies }));
  return { status: 0, stdout: '', stderr: '' };
}
