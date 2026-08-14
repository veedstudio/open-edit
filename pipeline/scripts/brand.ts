// The brand law, and the bone a SET of pieces shares.
//
// Every RACE-card brief in the launch session retyped the same block: the palette, the rule that white
// and green carry everything and orange is a micro-accent only, the rule that type on a green plate is
// the brand dark, where the mark sits, and the shared skeleton that made four cards read as one
// campaign. Retyped four times, drifting each time, and the run that dropped the mark produced the
// session's sharpest correction — the logo was not the one from the brandbook.
//
//   brand.ts --file <brand.json> --brief     # the law as prompt-ready prose
//   brand.ts --file <brand.json> --check     # validate it before a run spends a render on it
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFlags } from '../../veed/args.ts';

export interface Brand {
  name: string;
  /** role → hex. Roles are the point: "ink"/"accent"/"ground" survive a palette swap, "#96FF1A" does not. */
  palette: Record<string, string>;
  /** Sentences that constrain how the palette may be spent. These are what a design pass gets wrong. */
  colourLaw?: string[];
  type?: { display?: string; body?: string; notes?: string };
  /** A mark is a FILE, never a redrawing. `asset` is resolved relative to the brand file. */
  logo?: { asset?: string; placement?: string; never?: string };
  /** Present when several pieces are made together and must read as one campaign. */
  set?: { shared: string[]; varies?: string[] };
}

export interface Problem { field: string; message: string }

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function validate(brand: Brand, baseDir: string): Problem[] {
  const out: Problem[] = [];
  if (!brand.name?.trim()) out.push({ field: 'name', message: 'a brand with no name cannot be reported back to the user' });
  const roles = Object.entries(brand.palette ?? {});
  if (!roles.length) out.push({ field: 'palette', message: 'no palette — the design pass would invent one' });
  for (const [role, hex] of roles) {
    if (!HEX.test(hex)) out.push({ field: `palette.${role}`, message: `"${hex}" is not a hex colour` });
    if (/^#?[0-9a-f]{3,6}$/i.test(role)) {
      out.push({ field: `palette.${role}`, message: 'the KEY must be a role ("ink", "accent", "ground"), not the colour again — a role survives a palette swap' });
    }
  }
  // The corpus's asset-fidelity class is 17 records: a mark drawn by hand instead of taken from the
  // file the user supplied. A brand that names an asset which is not there invites exactly that.
  if (brand.logo?.asset) {
    const p = isAbsolute(brand.logo.asset) ? brand.logo.asset : join(baseDir, brand.logo.asset);
    if (!existsSync(p)) out.push({ field: 'logo.asset', message: `${brand.logo.asset} does not exist — a design pass told to use a missing mark draws its own` });
  }
  if (brand.set && !brand.set.shared?.length) {
    out.push({ field: 'set.shared', message: 'a set with nothing shared is not a set — name the bone every piece keeps' });
  }
  return out;
}

export function briefFor(brand: Brand, baseDir: string): string {
  const lines: string[] = [`THE BRAND — ${brand.name}. It is the design authority; on any collision with a direction, it wins.`];
  lines.push(`  Palette (role → value, spend them by ROLE):`);
  for (const [role, hex] of Object.entries(brand.palette ?? {})) lines.push(`    ${role}: ${hex}`);
  if (brand.colourLaw?.length) {
    lines.push(`  Colour law — these are constraints, not suggestions:`);
    for (const l of brand.colourLaw) lines.push(`    · ${l}`);
  }
  if (brand.type) {
    const t = [brand.type.display && `display ${brand.type.display}`, brand.type.body && `body ${brand.type.body}`]
      .filter(Boolean).join(' · ');
    if (t) lines.push(`  Type: ${t}`);
    if (brand.type.notes) lines.push(`    ${brand.type.notes}`);
  }
  if (brand.logo) {
    const p = brand.logo.asset
      ? (isAbsolute(brand.logo.asset) ? brand.logo.asset : resolve(baseDir, brand.logo.asset))
      : undefined;
    lines.push(`  Mark: ${p ? `USE THE FILE at ${p} — never redraw it, never crop it out of a raster` : 'no asset supplied'}`);
    if (brand.logo.placement) lines.push(`    Placement: ${brand.logo.placement}`);
    if (brand.logo.never) lines.push(`    Never: ${brand.logo.never}`);
  }
  if (brand.set) {
    lines.push(`  THE SHARED BONE — every piece in this set keeps these, so the set reads as one campaign:`);
    for (const s of brand.set.shared) lines.push(`    · ${s}`);
    if (brand.set.varies?.length) {
      lines.push(`  What differs between pieces: ${brand.set.varies.join(', ')}. Compositions differ; the bone does not.`);
    }
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseFlags({
    args: process.argv.slice(2),
    options: { file: { type: 'string' }, brief: { type: 'boolean' }, check: { type: 'boolean' } },
  });
  if (!values.file) { console.error('usage: brand.ts --file <brand.json> [--brief] [--check]'); process.exit(2); }
  const path = resolve(values.file);
  const brand = JSON.parse(readFileSync(path, 'utf8')) as Brand;
  const problems = validate(brand, dirname(path));
  if (values.brief && !problems.length) { console.log(briefFor(brand, dirname(path))); process.exit(0); }
  for (const p of problems) console.error(`BRAND[${p.field}] ${p.message}`);
  if (problems.length) { console.error(`brand: ${problems.length} problem(s)`); process.exit(1); }
  console.log('brand: valid');
}
