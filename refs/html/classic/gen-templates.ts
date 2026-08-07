/**
 * Regenerates template.wv for every classic ref (portrait demo copy at the
 * 9:16 reference canvas) and lints both aspects.
 * Run: node --import tsx refs/html/classic/gen-templates.ts
 */
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { RecipeGenerator, RunMeta } from '../../../pipeline/recipes/lib.ts';
import { lintTemplate } from '../../../pipeline/scripts/lint-template.ts';
import type { WordTimings } from '../../../pipeline/scripts/synth-word-timings.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

export const CLASSIC_IDS = ['simple', 'rizz', 'karl', 'lowkey', 'mint', 'glass'] as const;

function demoTimings(): WordTimings {
  const beats = [
    { words: 'Make your captions look this good', startSec: 0.2, endSec: 2.1 },
    { words: 'every word lands right on time', startSec: 2.1, endSec: 4.3 },
    { words: 'rendered straight over your footage', startSec: 4.3, endSec: 5.9 },
  ];
  return {
    beats: beats.map((b, i) => {
      const ws = b.words.split(' ');
      const step = (b.endSec - b.startSec) / ws.length;
      return {
        i: i + 1,
        startSec: b.startSec,
        endSec: b.endSec,
        cueDelayMs: Math.round(b.startSec * 1000),
        cueDurMs: Math.round((b.endSec - b.startSec) * 1000),
        words: ws.map((w, k) => ({ w, delayMs: Math.round((b.startSec + k * step) * 1000) })),
      };
    }),
  };
}

const PT: RunMeta = { key: 'template', videoPath: 'demo.mp4', width: 736, height: 1312, fps: 30, durationSec: 6 };
const LS: RunMeta = { key: 'template', videoPath: 'demo.mp4', width: 1280, height: 720, fps: 30, durationSec: 6 };

let failed = 0;
for (const id of CLASSIC_IDS) {
  const recipe = (await import(`./${id}/recipe.ts`)).default as RecipeGenerator;
  const timings = demoTimings();
  for (const [label, m] of [['9:16', PT], ['16:9', LS]] as const) {
    const out = recipe.generate(m, timings, {});
    const errors = lintTemplate(out.wv).filter((f) => f.severity === 'error');
    if (errors.length) {
      failed++;
      console.error(`${id} ${label}: ${errors.map((e) => `${e.rule}: ${e.message}`).join(' | ')}`);
    }
    if (label === '9:16') writeFileSync(join(HERE, id, 'template.wv'), out.wv);
  }
  console.log(`${id}: template.wv written, both aspects linted`);
}
if (failed) {
  console.error(`${failed} lint failures`);
  process.exit(1);
}
