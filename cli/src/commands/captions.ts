// Captions of the speech, laid by the page from a transcript's word times.
//
//   openedit captions <transcript.json> [--out <file>]
//
// Writes captions.js: the transcript's words and the code that shows them as caption cues on the page's clock, so a
// page captions every spoken word without timing a single cue itself. The look stays the page's own.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { captionsScript, CLOSE_GAP, HEADER, LAG_OUT, LINE_CHARS, LINES, trackOf } from '../captions/page-script.ts';
import { writeTextAtomic } from '../providers/exclusive-files.ts';
import { mappedNote, readTranscriptFile } from '../transcript/read-transcript.ts';
import { HOLD } from '../verify/captions.ts';

export const usage = {
  summary: 'Write captions.js, which captions every spoken word of a transcript on the page that loads it',
  positionals: '<transcript.json>',
  flags: {
    out: { type: 'string', value: '<file>', help: 'Where captions.js is written (default: captions.js beside the transcript)' },
  },
  notes: [
    'Load captions.js with a <script> tag and give the page an empty element marked data-captions where the captions',
    'go (inside <div data-safe> when the page has a safe zone). Each frame it holds the cue on screen:',
    '  <div data-cue="7"><div data-line="0"><span data-word="41" data-state="now">Hello<span data-punct="trail">,</span></span> ...',
    "data-state is next, now (from its start until the cue's next word starts) or said. Custom properties for CSS",
    'calc(): --since (seconds since the word began, below 0 before) and --progress (0-1 through it) on each word;',
    "--cue-since, --cue-until and --cue-progress on the cue. Motion drawn from these is drawn from the frame's time",
    'alone, so the page can stay data-stateless; a CSS animation or transition a state change starts cannot.',
    `A cue runs from its first word to ${LAG_OUT} s past its last, or on until the next when that comes up under ${CLOSE_GAP} s`,
    'later, so the screen clears only in a silence of a second or more. Cues break where the speech does (a sentence',
    `end, a pause, a clause) and speak for at most ${HOLD.max} s. Lines fit the container's width in the page's own font,`,
    `at most ${LINES} a cue and ${LINE_CHARS} characters a line. Options, on the container: data-lines, data-words (1 shows one`,
    "word at a time), data-chars; data-at (the page second the transcript's clip starts at), data-from and data-to",
    '(the stretch of the clip the page plays, its own seconds); data-transcript (which, with several loaded). With',
    'faces.js loaded each cue is placed off the faces, within the [data-safe] around it (data-clip and data-video pass',
    "place() its clip and video). openeditCaptions.words() is the words: change a word's text there before the first",
    'frame to show it otherwise. A speech-to-text JSON that `whisper` maps is read too.',
  ].join('\n'),
} satisfies Usage;

export function captions(argv: string[]): number {
  const { values, positionals } = parseUsage('captions', usage, argv);
  const [given] = positionals;
  if (!given || positionals.length > 1) {
    console.error(usageLine('captions', usage));
    return 2;
  }
  const path = resolve(given);
  if (!existsSync(path)) throw new Error(`transcript not found: ${path}`);
  const out = resolve(values.out ?? join(dirname(path), 'captions.js'));
  if (existsSync(out) && !readFileSync(out, 'utf8').startsWith(HEADER)) {
    console.error(`captions: ${out} is not a captions.js this command wrote, so it is left as it is: pass another --out <file>`);
    return 1;
  }
  const read = readTranscriptFile(path);
  const { transcript } = read;
  const track = trackOf(path, basename(path), transcript.chunks.flatMap((c) => c.words));
  if (track.words.length === 0) throw new Error(`${path} holds no timed words to caption`);
  writeTextAtomic(out, captionsScript(track));

  const words = track.words;
  let silences = 0;
  for (let k = 1; k < words.length; k++) if (words[k][1] - words[k - 1][2] >= LAG_OUT + CLOSE_GAP) silences++;
  const note = mappedNote(path, read);
  if (note) console.log(`captions: ${note}`);
  console.log(`captions: ${words.length} words of ${path}, ${words[0][1].toFixed(2)}-${words.at(-1)![2].toFixed(2)} s; ` +
    `each on screen from when it is said, cleared only in ${silences} silence(s) of a second or more`);
  console.log(`  wrote ${out}: load it with a <script> tag and give the page an empty <div data-captions> where the captions go`);
  return 0;
}
