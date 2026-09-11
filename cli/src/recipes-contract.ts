// The contract between this CLI and a workspace's compiled recipes. Recipes and their
// library live in the Open Edit repository (content, co-versioned with the style bank);
// the generate-recipe command dynamically imports a recipe module from the workspace and
// calls it through these shapes. They mirror pipeline/recipes/lib.ts there — the two
// declarations must never disagree, and tests/recipes-contract.test.ts pins this side.
import type { WordTimings } from './prep/synth-word-timings.ts';

export interface RunMeta {
  key: string;
  videoPath: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
}

export interface RecipeOptions {
  // page key ('b3p1') → rows DOWN the size ladder; the verify loop's mechanical bounds fix.
  demote?: Record<string, number>;
}

export interface RecipeOutput {
  wv: string;
  manifest: string;
}

export interface RecipeGenerator {
  refId: string;
  generate(meta: RunMeta, timings: WordTimings, opts?: RecipeOptions): RecipeOutput;
}

// Ref ids are folder names: letters/digits plus the spaces, parens, dots, hyphens and underscores the
// pool already uses ("hook-091 Pre-comp 1-peak"). No separators, so no id can climb out of refs/html/.
const REF_ID = /^[A-Za-z0-9][A-Za-z0-9 ()._-]*$/;

export function generatorRelPath(refId: string): string {
  if (!REF_ID.test(refId)) throw new Error(`unsafe refId: ${JSON.stringify(refId)}`);
  return `refs/html/${refId}/recipe.ts`;
}

// The compiled twin, which a published install carries and a checkout does not. Preferred wherever
// both exist: loading the source costs a type-stripping runtime that the engines floor does not
// guarantee, to reach the same module that is already sitting beside it.
export function compiledGeneratorRelPath(refId: string): string {
  if (!REF_ID.test(refId)) throw new Error(`unsafe refId: ${JSON.stringify(refId)}`);
  return `refs/html/${refId}/recipe.js`;
}
