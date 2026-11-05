// Tests src/verify/numbers.ts, the review's check of numbers on screen that neither the speech nor the user's words
// say, and review's --brief. The parsing is judged on the forms one number is written and said in, the check on
// records shaped as renders write them, and once end to end through a real render in the pinned headless Chrome
// (skipped when it is not installed unless OPENEDIT_REQUIRE_BROWSER is set), whose record runs a <br>'s two lines
// together.
//   Run:  node --import tsx --test cli/tests/numbers.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { briefFor, review } from '../src/commands/review.ts';
import { chromePlatform, installedChrome } from '../src/render/browser.ts';
import type { TextEntry, TextRecord } from '../src/render/text-record.ts';
import type { Transcript } from '../src/transcript/transcript-types.ts';
import { CHECKS, type BriefInput, type Found, type TextRecordInput, type TranscriptInput } from '../src/verify/checks.ts';
import { borneOut, judgeNumbers, mentionsIn, valuesSaid } from '../src/verify/numbers.ts';
import { captureConsoleAsync, scratchDir } from './helpers/synth.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const platform = chromePlatform();
const noChrome = platform && existsSync(installedChrome(platform)) ? null : 'Chrome Headless Shell is not installed (openedit install-browser)';
if (noChrome && process.env.OPENEDIT_REQUIRE_BROWSER) throw new Error(`${noChrome}, and OPENEDIT_REQUIRE_BROWSER is set`);

/** Whether each number `screen` shows as a claim is borne out by `source`. */
const verdicts = (screen: string, source: string): boolean[] =>
  mentionsIn(screen).filter((m) => m.claim && !m.name).map((m) => borneOut(m.claim!, valuesSaid(source)));

test('numbers: one number agrees with itself in digits, in words, in another unit or format, and rounded', () => {
  const agree: [string, string][] = [
    ['15 MIN', 'cook it for fifteen minutes'],
    ['0:15', 'it takes 15 minutes'],
    ['15 min', 'a quarter of an hour'],
    ['90 MIN', 'an hour and a half'],
    ['$5', 'it costs five dollars'],
    ['$1,400', 'fourteen hundred dollars'],
    ['$4.99', 'only four ninety-nine'],
    ['50% OFF', 'fifty percent off'],
    ['50% OFF', 'half of them'],
    ['33%', 'a third of them'],
    ['25', 'twenty-five people'],
    ['2.5 HOURS', 'two and a half hours'],
    ['2½ hours', 'two and a half hours'],
    ['2.5', 'two point five'],
    ['SINCE 2018', 'since twenty eighteen'],
    ['SINCE 2018', 'two thousand and eighteen'],
    ['1999', 'back in nineteen ninety-nine'],
    ['THE 1990s', 'back in the nineties'],
    ['1.4M VIEWS', '1,423,000 views'],
    ['1.4M', 'one point four million'],
    ['7K', 'seven thousand'],
    ['6X FASTER', 'six times faster'],
    ['1ST DOWN', 'first down'],
    ['3 TIPS', 'three tips for you'],
    ['12 EGGS', 'a dozen eggs'],
    ['8:30 AM', 'doors at eight thirty'],
    ['100', 'a hundred times'],
  ];
  for (const [screen, source] of agree) assert.deepEqual(verdicts(screen, source), [true], `${screen} against "${source}"`);
  // A range and a score are two numbers, each borne out on its own.
  assert.deepEqual(verdicts('10–15 MIN', 'ten to fifteen minutes'), [true, true]);
  assert.deepEqual(verdicts('17–0', 'down 17 to nothing'), [true, true]);
});

test('numbers: a scale said after a decimal or a half scales the whole, so it agrees in value with the figure in full', () => {
  // No screen here has a glued letter that also reads as the bare number, so only the scaled value bears it out.
  const agree: [string, string][] = [
    ['1,400,000', 'one point four million'],
    ['$2.5 billion', 'two point five billion'],
    ['1.4 million views', 'one point four million views'],
    ['1,500,000', 'one and a half million'],
    ['1,500,000', 'a million and a half'],
    ['2,500,000', 'two million and a half'],
    ['1,500,000', '1 and a half million'],
  ];
  for (const [screen, source] of agree) assert.deepEqual(verdicts(screen, source), [true], `${screen} against "${source}"`);
  assert.deepEqual(verdicts('1,500,000', 'one point four million'), [false]);
  assert.deepEqual(verdicts('$2.5 billion', 'two point five million'), [false]);
});

test('numbers: another number is not borne out, a lone digit is not taken for a rounding, and only an exact figure matches a whole one', () => {
  assert.deepEqual(verdicts('READY IN 15 MIN', 'This will take about 10 minutes. Leave to simmer for about two minutes more.'), [false]);
  assert.deepEqual(verdicts('10–15 MIN', 'ten minutes'), [true, false]);
  assert.deepEqual(verdicts('20 MIN', 'twelve minutes'), [false]);
  assert.deepEqual(verdicts('$7,000', 'seven hundred dollars'), [false]);
  assert.deepEqual(verdicts('$1,400', '1,423 dollars'), [false]);
  assert.deepEqual(verdicts('2', 'one and a half'), [false]);
  assert.deepEqual(verdicts('TOP 10', 'my top nine'), [false]);
});

test('numbers: a format, a name, an address and "one" or "first" in words are no claim', () => {
  for (const text of ['1080p', '3D', '5G']) assert.deepEqual(mentionsIn(text).map((m) => [m.claim, m.name]), [[null, text]], text);
  // Letters run into digits name something, so the check sets them aside where one element's own text runs them together.
  assert.deepEqual(mentionsIn('MP4 EXPORT').map((m) => m.name), ['MP4']);
  assert.deepEqual(mentionsIn('COVID-19').map((m) => m.name), ['COVID-19']);
  for (const text of ['@user123', 'www.site2.com', 'open 24/7']) assert.deepEqual(mentionsIn(text), [], text);
  for (const text of ['one simple principle', 'first', 'half price']) assert.deepEqual(mentionsIn(text).map((m) => m.claim), [null], text);
  // "constructor" and its kind are Object's own properties, not number words.
  assert.deepEqual(mentionsIn('the constructor of toString'), []);
});

// ---- the check on records --------------------------------------------------------------------------------------

interface Shown {
  text: string;
  from: number;
  to: number;
  box: TextEntry['box'];
  fontSize: number;
  selector: string;
}

/** A record at 30 fps sampled every third frame, each sample showing what is up at its time. */
function recordOf(seconds: number, shows: Shown[], width = 1080, height = 1920): Found<TextRecordInput> {
  const frames = Math.round(seconds * 30);
  const samples: TextRecord['samples'] = [];
  for (let frame = 0; frame < frames; frame += 3) {
    const t = frame / 30;
    samples.push({
      frame, time: Math.round(t * 1000) / 1000,
      texts: shows.filter((s) => t >= s.from - 1e-9 && t < s.to - 1e-9)
        .map((s) => ({ text: s.text, box: s.box, fontSize: s.fontSize, color: [255, 255, 255, 1], opacity: 1, selector: s.selector })),
    });
  }
  return { path: 'final.mp4.text.json', record: { version: 1, page: 'index.html', width, height, fps: '30', frames, transparent: false, framesPerSample: 3, samples } };
}

const said = (text: string): Found<TranscriptInput> => {
  const words = text.split(' ').map((w, i) => ({ text: w, timestamp: [i * 0.3, i * 0.3 + 0.25] as [number, number] }));
  const transcript: Transcript = { text, chunks: [{ text, timestamp: [0, words.length * 0.3], words }] };
  return { path: 'cut/transcript.json', transcript };
};

const asText = (text: string): BriefInput => ({ sources: [{ label: 'given as text', text }] });
const NO_BRIEF: BriefInput = { missing: 'none given with --brief' };

// A recipe teaser as one was delivered: a numbered step tag over each step, and a two-line "Ready in<br>15 min" tag
// whose element text the record runs together, at the size and place the page drew them on a 1214x2160 frame.
const step = (n: number, label: string, from: number, to: number): Shown[] => [
  { text: String(n), from, to, box: [592, 324, 30, 62], fontSize: 51, selector: `#stage>div:nth-child(${n + 1})>div:nth-child(1)` },
  { text: label, from, to, box: [380, 430, 453, 93], fontSize: 76, selector: `#stage>div:nth-child(${n + 1})>div:nth-child(2)` },
];
const TEASER: Shown[] = [
  { text: 'HEALTHY & TASTY', from: 0, to: 2.9, box: [323, 336, 567, 64], fontSize: 53, selector: '#title' },
  ...step(1, 'ONIONS', 2.9, 4.8), ...step(2, 'EGGPLANT', 4.8, 7.3), ...step(3, 'SPICES', 7.3, 11.4), ...step(4, 'COCONUT MILK', 11.4, 13.5),
  { text: 'READY IN15 MIN', from: 13.5, to: 14.9, box: [404, 331, 407, 178.5], fontSize: 77, selector: '#stage>div:nth-child(6)>div:nth-child(1)' },
  { text: 'Cook Maldives', from: 14.9, to: 20.3, box: [406, 862, 401, 281], fontSize: 134, selector: '#book' },
];
const NARRATION = 'Pour about a cup of water, then cover and cook till the eggplant becomes tender. This will take about 10 minutes. '
  + 'Now we are ready to add the coconut milk. Turn to low heat and leave to simmer for about two minutes more.';

test('numbers: a time on a card that the narration never says is reported with where and when it shows, and the step tags are not', () => {
  const report = judgeNumbers(recordOf(20.3, TEASER, 1214, 2160), said(NARRATION), asText('Make a 20-second vertical recipe teaser from this 4K video with text overlays.'));
  assert.equal(report.verdict, 'found');
  assert.deepEqual(report.lines, [
    "1 number(s) on screen that neither the transcript nor the user's words say, to confirm against the source or take off:",
    '"15 MIN" in "READY IN 15 MIN", top centre, from 13.50s to 14.90s',
    'set aside as no claim: a list\'s own numbering or count, "1", "2", "3", "4"',
    "compared with the words of cut/transcript.json and the user's words (given as text)",
  ]);
  assert.deepEqual(report.skipped, []);
});

test('numbers: a time the speech or the user says passes, and without --brief the report says it compared the transcript only', () => {
  const record = recordOf(20.3, TEASER, 1214, 2160);
  const spoken = judgeNumbers(record, said(NARRATION.replace('10 minutes', 'fifteen minutes')), asText('a recipe teaser'));
  assert.equal(spoken.verdict, 'pass');
  assert.equal(spoken.lines[0], "every number on screen is said in the transcript or the user's words: 1 number(s)");
  const asked = judgeNumbers(record, said(NARRATION), asText('Put "ready in 15 minutes" on the last card'));
  assert.equal(asked.verdict, 'pass');
  const alone = judgeNumbers(record, said(NARRATION), NO_BRIEF);
  assert.equal(alone.verdict, 'found');
  assert.equal(alone.lines[0], '1 number(s) on screen that the transcript never says, to confirm against the source or take off:');
  assert.deepEqual(alone.skipped, ['the user\'s words: none given with --brief, so the numbers were compared with the transcript only']);
});

test('numbers: letters running into digits are a name in one line of one element, and a line break or two elements apart are not', () => {
  const line = (text: string, height: number, selector = '#t'): Shown => ({ text, from: 0, to: 2, box: [100, 100, 600, height], fontSize: 60, selector });
  const name = judgeNumbers(recordOf(2, [line('EXPORT AS MP4', 72)]), said('export it'), NO_BRIEF);
  assert.equal(name.verdict, 'pass');
  assert.match(name.lines.join('\n'), /part of a name, "MP4"/);
  const broken = judgeNumbers(recordOf(2, [line('READY IN15 MIN', 140)]), said('it is ready'), NO_BRIEF);
  assert.equal(broken.lines[1], '"15 MIN" in "READY IN 15 MIN", top centre, from 0.00s to 2.00s');
  // A label and a score in two elements set close together read as one block, never as one name.
  const score: Shown[] = [
    { text: 'MICHIGAN', from: 0, to: 2, box: [100, 100, 300, 60], fontSize: 50, selector: '#team' },
    { text: '13', from: 0, to: 2, box: [403, 100, 50, 60], fontSize: 50, selector: '#score' },
  ];
  const scored = judgeNumbers(recordOf(2, score), said('michigan scores'), NO_BRIEF);
  assert.equal(scored.verdict, 'found');
  assert.match(scored.lines[1], /^"13" in "MICHIGAN13", top left, from 0\.00s to 2\.00s$/);
});

test('numbers: a clock running in one place is set aside, a count racing up leaves its final figure, and a flash is too brief to read', () => {
  const at = (text: string, from: number, to: number, selector: string): Shown => ({ text, from, to, box: [100, 1500, 200, 60], fontSize: 50, selector });
  const clock = Array.from({ length: 11 }, (_, s) => at(`0:${String(s).padStart(2, '0')}`, 2 + s, 3 + s, '#clock'));
  const count = Array.from({ length: 10 }, (_, k) => at(`${k * 9}%`, 14 + k * 0.1, 14.1 + k * 0.1, '#count'));
  const shows = [...clock, ...count, at('87%', 15, 17, '#count'), at('42', 17.5, 17.7, '#flash')];
  const report = judgeNumbers(recordOf(18, shows), said('what if the air vanished for 10 seconds'), NO_BRIEF);
  assert.equal(report.verdict, 'found');
  assert.equal(report.lines[0], '1 number(s) on screen that the transcript never says, to confirm against the source or take off:');
  assert.equal(report.lines[1], '"87%", bottom left, from 15.00s to 17.00s');
  assert.match(report.lines[2], /^set aside as no claim: a clock or a count running in one place, "0:00", "0:01", .*, and 5 more; on screen under 0\.25s, too briefly to read, "0%", "9%", .*, and 5 more$/);
  assert.equal(report.lines.length, 4);
});

test('numbers: with no transcript the user\'s words alone are compared, and with neither the check is skipped', () => {
  const card: Shown[] = [{ text: 'OPENS SATURDAY 8AM', from: 0, to: 3, box: [100, 800, 800, 90], fontSize: 80, selector: '#card' }];
  const check = CHECKS.find((c) => c.name === 'numbers')!;
  const base = { video: 'final.mp4', duration: 3, askedLength: { missing: 'none' }, textRecord: recordOf(3, card) };
  const briefOnly = check.run({ ...base, transcript: { missing: 'no transcript at final/transcript.json' }, brief: asText('a promo for Bean There, opening this Saturday') });
  assert.ok(!(briefOnly instanceof Promise));
  assert.equal(briefOnly.verdict, 'found');
  assert.equal(briefOnly.lines[1], '"8" in "OPENS SATURDAY 8AM", middle centre, from 0.00s to 3.00s');
  assert.deepEqual(briefOnly.skipped, [
    'the speech: no transcript at final/transcript.json, so the numbers were compared with the user\'s words only, and any the speech says are reported too',
  ]);
  assert.deepEqual(check.run({ ...base, transcript: { missing: 'no transcript here' }, brief: NO_BRIEF }),
    { verdict: 'skipped', lines: [], skipped: ['the speech: no transcript here', 'the user\'s words: none given with --brief'] });
  assert.deepEqual(check.run({ ...base, textRecord: { missing: 'no record here' }, transcript: said('hi'), brief: NO_BRIEF }),
    { verdict: 'skipped', lines: [], skipped: ['the text: no record here'] });
});

test('review --brief: a file is read, other text is the words themselves, and a path that names nothing stops the review', () => {
  const dir = scratchDir('numbers-brief');
  const video = join(dir, 'final.mp4');
  const file = join(dir, 'brief.txt');
  writeFileSync(file, 'Ready in 15 minutes');
  assert.deepEqual(briefFor([file, 'a 20-second teaser'], video), {
    sources: [{ label: file, text: 'Ready in 15 minutes' }, { label: 'given as text', text: 'a 20-second teaser' }],
  });
  assert.deepEqual(briefFor(undefined, video), { missing: 'none given with --brief or in a brief.json for this piece' });
  assert.throws(() => briefFor([join(dir, 'brief.md')], video), /^Error: brief file not found: .*brief\.md$/);
  assert.throws(() => briefFor(['  '], video), /--brief is empty/);
  mkdirSync(join(dir, 'folder'));
  assert.throws(() => briefFor([join(dir, 'folder')], video), /is a directory/);
});

test('review: without --brief the user\'s words come from the piece\'s brief.json; --brief wins over them and says so', () => {
  // As the brief is found: by its real path, which a temporary folder reached through a symlink (macOS) or by its
  // short 8.3 name (Windows) is not, and which only the native realpath expands.
  const dir = realpathSync.native(scratchDir('numbers-brief-file'));
  const video = join(dir, 'final.mp4');
  const brief = join(dir, 'brief.json');
  writeFileSync(brief, JSON.stringify({ words: 'a recipe ready in 15 minutes' }));
  assert.deepEqual(briefFor(undefined, video), { sources: [{ label: brief, text: 'a recipe ready in 15 minutes' }] });
  assert.deepEqual(briefFor(['ready in 20 minutes'], video), {
    sources: [{ label: `given as text, over the words in ${brief}`, text: 'ready in 20 minutes' }],
  });
  writeFileSync(brief, JSON.stringify({ length: 30 }));
  assert.deepEqual(briefFor(undefined, video), { missing: `none given with --brief or in ${brief}` });
});

// ---- end to end ------------------------------------------------------------------------------------------------

test('review: a render whose card reads "Ready in<br>15 min" reports 15 min against the narration, and passes once the user asked for it', { skip: noChrome ?? false }, async () => {
  const dir = scratchDir('numbers-review');
  const page = join(dir, 'index.html');
  writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#000}
#stage{position:relative;width:180px;height:320px;overflow:hidden;background:#234;font:700 18px Helvetica,Arial,sans-serif;color:#fff}
.tag{position:absolute;left:20px;top:40px;line-height:1.1}
.num{position:absolute;left:80px;top:10px;font-size:14px}
</style></head><body><div id="stage" data-stateless></div>
<script>const steps=[[0,1,'1','ONIONS'],[1,2,'2','SPICES'],[2,3,'3','COCONUT MILK']];
window.__seek=(t)=>{const s=steps.find(([a,b])=>t>=a&&t<b);document.getElementById('stage').innerHTML=s
? '<div class="num">'+s[2]+'</div><div class="tag">'+s[3]+'</div>' : '<div class="tag">Ready in<br>15 min</div>'}</script></body></html>`);
  const out = join(dir, 'final.mp4');
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'render', page, '--out', out, '--fps', '10', '--duration', '4.5'], { encoding: 'utf8', timeout: 240_000 });
  assert.equal(r.status, 0, r.stderr);
  writeFileSync(join(dir, 'transcript.json'), JSON.stringify(said(NARRATION).transcript));
  const first = await captureConsoleAsync(() => review([out, '--brief', 'Make a recipe teaser with text overlays']));
  assert.equal(first.result, 0);
  assert.match(first.out, /^numbers +FOUND +1 number\(s\) on screen that neither the transcript nor the user's words say, to confirm against the source or take off:$/m);
  assert.match(first.out, /^ +"15 min" in "Ready in 15 min", top left, from 3\.00s to 4\.50s$/m);
  assert.match(first.out, /^ +set aside as no claim: a list's own numbering or count, "1", "2", "3"$/m);
  const file = join(dir, 'brief.txt');
  writeFileSync(file, 'Make a recipe teaser, and end on a card that says it is ready in 15 minutes.');
  const second = await captureConsoleAsync(() => review([out, '--brief', 'Make a recipe teaser', '--brief', file]));
  assert.match(second.out, new RegExp(`^numbers +pass +every number on screen is said in the transcript or the user's words: 1 number\\(s\\)$`, 'm'));
  assert.match(second.out, new RegExp(`^ +compared with the words of .*transcript\\.json and the user's words \\(given as text, ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)$`, 'm'));
});
