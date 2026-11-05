// What the user asked of one piece, recorded once in the piece's folder, where every tool that works on its files
// finds it: how long it runs, where it is posted and their own words. review, render, safe-zone and reframe read it
// when they are not told otherwise.
//
//   openedit brief runs/<key> --length 60 --platform tiktok --words "Doors open at 7"
//   openedit brief runs/<key>                       (prints the brief that applies there)
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { numberFlag, parseUsage, usageLine, type Usage } from '../args.ts';
import { readBrief, writeBrief, type Brief, type FoundBrief } from '../brief.ts';
import { quoted } from '../verify/report.ts';
import { FORMATS, formatNamed, type Format, type Shape } from './safe-zone.ts';

export const usage = {
  summary: 'Record what the user asked of a piece (its length, where it is posted, their own words) in its brief.json, which review, render, safe-zone and reframe read',
  positionals: '<dir>',
  flags: {
    length: { type: 'string', value: '<sec>', help: 'How long the piece should run, in seconds: review\'s length check and render\'s length line compare with it' },
    platform: {
      type: 'string', value: '<zone>',
      help: 'Where it is posted, as safe-zone names it: an app (tiktok, reels, shorts, youtube, x), a shape (9:16, 1:1, 4:5, 16:9, 4:3) or an app with its shape (linkedin 1:1); safe-zone takes its zone from it and reframe its shape',
    },
    words: { type: 'string', value: '<text>', help: 'The user\'s own words for the piece, as they wrote them' },
  },
  notes: [
    '<dir> is the piece\'s folder, runs/<key>. Each call sets the fields it is given and keeps the others; with none,',
    'it prints the brief that applies there. A tool finds the brief from the file it works on, in that file\'s folder',
    'or the nearest one above it inside the workspace. A value given to a tool itself (review --length, a zone named to',
    'safe-zone, reframe --aspect) wins over the brief, and the tool says which it used.',
    'Which platform: the app the user names; with none named, or several, the shape. 9:16, 1:1 and 4:5 are clear of',
    'every app safe-zone --help lists for them, while 16:9 is YouTube\'s player, so a 16:9 piece for a feed names',
    'that feed\'s app. Instagram, Facebook and LinkedIn are posted in several shapes: name the app with its shape',
    '(instagram 4:5, linkedin 16:9), or reels for a 9:16 Reel.',
  ].join('\n'),
} satisfies Usage;

/** Refuses a platform unless it names exactly one zone, so every tool that reads the brief takes the same one. */
function assertOneZone(platform: string): void {
  try {
    formatNamed(platform);
  } catch (error) {
    const named = (shape: Shape) => {
      try {
        formatNamed(`${platform} ${shape}`);
        return true;
      } catch {
        return false;
      }
    };
    const shapes = [...new Set(FORMATS.map((f) => f.shape))].filter(named);
    if (shapes.length) {
      const names = shapes.map((s) => `"${platform} ${s}"`);
      throw new Error(`--platform ${platform} is posted in ${shapes.length} shapes, each with its own zone and size: name it with `
        + `its shape, as ${names.slice(0, -1).join(', ')} or ${names.at(-1)}`);
    }
    throw new Error(`--platform: ${(error as Error).message}`, { cause: error });
  }
}

function print(found: FoundBrief): void {
  const { length, platform, words } = found.brief;
  console.log(`brief: ${found.path}`);
  if (length !== undefined) console.log(`  length: ${length} s`);
  if (platform !== undefined) {
    // A brief written by hand can name what the command would refuse; the tools that read it say so then.
    let zone: Format | undefined;
    try {
      zone = formatNamed(platform);
    } catch {
      zone = undefined;
    }
    console.log(`  platform: ${platform}${zone ? ` (${zone.platforms}, ${zone.shape})` : ''}`);
  }
  if (words !== undefined) console.log(`  words: ${quoted(words.replace(/\s+/g, ' ').trim())}`);
  if (length === undefined && platform === undefined && words === undefined) console.log('  empty');
}

export function brief(argv: string[]): number {
  const { values, positionals } = parseUsage('brief', usage, argv);
  if (positionals.length !== 1) {
    console.error(usageLine('brief', usage));
    return 2;
  }
  const given = resolve(positionals[0]);
  // A file of the piece names its folder as well as the folder does.
  const dir = existsSync(given) && statSync(given).isFile() ? dirname(given) : given;
  const fields: Brief = {};
  if (values.length !== undefined) fields.length = numberFlag('length', values.length, 30, (n) => n > 0, 'seconds above 0');
  if (values.platform !== undefined) {
    const platform = values.platform.trim().toLowerCase().replace(/\s+/g, ' ');
    assertOneZone(platform);
    fields.platform = platform;
  }
  if (values.words !== undefined) fields.words = values.words;
  if (Object.keys(fields).length === 0) {
    const found = readBrief(dir);
    if (found) print(found);
    else console.log(`brief: none for ${dir}; give --length, --platform or --words to write one there`);
    return 0;
  }
  const written = writeBrief(dir, fields);
  print(written);
  if (written.replaced) console.log(`  replaced the file that was there: ${written.replaced}`);
  console.log(`  review, render, safe-zone and reframe read it for the files in ${dir}`);
  return 0;
}
