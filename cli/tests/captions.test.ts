// The captions command and captions.js. The cue shaping runs everywhere, in Node from the page's own source; the
// pages are rendered by the real renderer in the pinned headless Chrome, skipped when it is not installed unless
// OPENEDIT_REQUIRE_BROWSER is set, and read back from the record of on-screen text render writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import { captionsApi, CLOSE_GAP, KEY_WORDS, LAG_OUT, LINE_CHARS, LINES, trackOf, type CaptionTrack, type Cue } from '../src/captions/page-script.ts';
import { formatNamed, minText, stylesheet, zoneFor } from '../src/commands/safe-zone.ts';
import { wordsLines } from '../src/commands/words.ts';
import { facesApi, facesScript, type FacesClip } from '../src/faces/page-script.ts';
import { CHROME_FLAGS, chromePlatform, installedChrome } from '../src/render/browser.ts';
import { startPageServer } from '../src/render/server.ts';
import { readRecord, recordPath, timeOf, type TextEntry, type TextRecord } from '../src/render/text-record.ts';
import type { Transcript } from '../src/transcript/transcript-types.ts';
import { HOLD, judgeCaptions, MIN_UNCAPTIONED } from '../src/verify/captions.ts';
import { tokensOf } from '../src/verify/text-blocks.ts';
import { scratchDir } from './helpers/synth.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const platform = chromePlatform();
const missing = platform && existsSync(installedChrome(platform)) ? null : 'Chrome Headless Shell is not installed (openedit install-browser)';
if (missing && process.env.OPENEDIT_REQUIRE_BROWSER) throw new Error(`${missing}, and OPENEDIT_REQUIRE_BROWSER is set`);
const skip = missing ?? false;

type Said = [text: string, start: number, end: number];

/** Sentences spoken one after another: each word for `each` seconds, `gap` apart, and `pause` after the sentence. */
function speech(parts: { text: string; each?: number; gap?: number; pause: number }[], from = 0.2): Said[] {
  const out: Said[] = [];
  let t = from;
  for (const p of parts) {
    for (const [i, w] of p.text.split(' ').entries()) {
      const long = /^(a|I)$/.test(w) ? 0.12 : p.each ?? 0.3;
      if (i) t += p.gap ?? 0.05;
      out.push([w, Math.round(t * 1000) / 1000, Math.round((t + long) * 1000) / 1000]);
      t += long;
    }
    t += p.pause;
  }
  return out;
}

const transcriptOf = (words: Said[]): Transcript => ({
  text: words.map((w) => w[0]).join(' '),
  chunks: [{ text: words.map((w) => w[0]).join(' '), timestamp: [words[0][1], words.at(-1)![2]], words: words.map(([text, a, b]) => ({ text: ` ${text}`, timestamp: [a, b] as [number, number] })) }],
});

const trackFor = (words: Said[]): CaptionTrack => trackOf('/work/transcript.json', 'transcript.json', transcriptOf(words).chunks[0].words);

// About ten seconds: a pause the screen holds through, a short word, a clause, and a silence long enough to clear it.
const SPEECH = speech([
  { text: 'Today we look at the new studio.', pause: 0.8 },
  { text: 'It has three rooms, a kitchen and a garden.', pause: 1.6 },
  { text: 'Come and see it for yourself!', pause: 0 },
]);

// Thirty seconds of one run-on sentence with no pause, six words over and over: only the lines, the characters and the
// hold can break it, and a bare word could be any of sixteen.
const RUN_ON = speech([{ text: Array.from({ length: 100 }, (_, i) => ['the', 'studio', 'kitchen', 'garden', 'is', 'bright'][i % 6]).join(' '), each: 0.25, gap: 0.05, pause: 0 }]);

/** A word named as a key word, as an agent reading `words` names it: its text, @, and its start to the hundredth. */
const keyOf = (words: Said[], i: number) => `${words[i][0]}@${words[i][1].toFixed(2)}`;

/** Each cue's words, joined. */
const textOf = (track: CaptionTrack, cue: Cue): string => cue.words.map((w) => track.words[w][0]).join(' ');

function assertCovers(track: CaptionTrack, cues: Cue[]): void {
  assert.deepEqual(cues.flatMap((c) => c.words), track.words.map((_, i) => i), 'every word in exactly one cue, in the order spoken');
  cues.forEach((c, k) => {
    const first = track.words[c.words[0]], last = track.words[c.words.at(-1)!];
    assert.equal(c.start, first[1], `cue ${k} comes up with its first word`);
    const next = cues[k + 1] && track.words[cues[k + 1].words[0]];
    const lagged = last[2] + LAG_OUT;
    const want = next && next[1] - lagged < CLOSE_GAP ? next[1] : lagged;
    assert.ok(Math.abs(c.end - want) < 1e-9, `cue ${k} "${textOf(track, c)}" ends at ${c.end}, not ${want}`);
    if (next) assert.ok(c.end <= next[1] + 1e-9, `cue ${k} is gone when the next comes up`);
    assert.deepEqual(c.lines.flat(), c.words, `cue ${k}'s lines hold its words`);
  });
  // The screen clears only in a silence of the captions check's second.
  for (let k = 1; k < cues.length; k++) {
    const silence = track.words[cues[k].words[0]][1] - track.words[cues[k - 1].words.at(-1)!][2];
    assert.equal(cues[k].start > cues[k - 1].end + 1e-9, silence >= MIN_UNCAPTIONED - 1e-9, `between cues ${k - 1} and ${k}, a silence of ${silence.toFixed(2)} s`);
  }
}

test('captions.js: every word is in one cue, up from when it is said until half a second past the cue\'s last word or the next cue', () => {
  const track = trackFor(SPEECH);
  const cues = captionsApi(track).cues();
  assertCovers(track, cues);
  assert.deepEqual(cues.map((c) => textOf(track, c)), ['Today we look at the new studio.', 'It has three rooms, a kitchen and a garden.', 'Come and see it for yourself!'],
    'a sentence each, as each fits two lines of 42 characters');
  // The 0.8 s pause is held through, the 1.6 s silence clears half a second after the last word.
  assert.equal(cues[0].end, cues[1].start);
  assert.ok(Math.abs(cues[1].end - (SPEECH[15][2] + LAG_OUT)) < 1e-9);
});

test('captions.js: cues break at sentence ends and pauses, keep to their lines and characters, and never hold past 7 s', () => {
  const track = trackFor(RUN_ON);
  for (const options of [{}, { lines: 1 }, { lines: 1, chars: 16 }, { lines: 3, chars: 80 }, { words: 3 }]) {
    const cues = captionsApi(track).cues(undefined, options);
    assertCovers(track, cues);
    for (const c of cues) {
      const lines = c.lines.map((l) => l.map((w) => track.words[w][0]).join(' '));
      assert.ok(lines.length <= (options.lines ?? LINES), `${JSON.stringify(options)}: ${lines.join(' / ')}`);
      for (const line of lines) assert.ok(line.length <= (options.chars ?? LINE_CHARS), `${JSON.stringify(options)}: "${line}" is too long`);
      assert.ok(!options.words || c.words.length <= options.words);
      assert.ok(track.words[c.words.at(-1)!][2] - c.start <= HOLD.max, `${JSON.stringify(options)}: a cue speaks for over ${HOLD.max} s`);
    }
    // Lines of one cue are as even as the words allow: no line under half the longest when it could be.
    if (!options.words) {
      for (const c of cues.filter((q) => q.lines.length === 2)) {
        const [a, b] = c.lines.map((l) => l.map((w) => track.words[w][0]).join(' ').length);
        assert.ok(Math.min(a, b) >= Math.max(a, b) / 2 - 7, `${JSON.stringify(options)}: lines of ${a} and ${b} characters`);
      }
    }
  }
  // A sentence's end breaks a cue that would have room for both, unless the cue before it would flash by.
  const two = speech([{ text: 'We open at nine.', pause: 0.1 }, { text: 'Coffee comes first.', pause: 0 }]);
  const t2 = trackFor(two);
  assert.deepEqual(captionsApi(t2).cues().map((c) => textOf(t2, c)), ['We open at nine.', 'Coffee comes first.']);
  const flash = speech([{ text: 'So.', pause: 0.06 }, { text: 'We open at nine.', pause: 0 }]);
  const t3 = trackFor(flash);
  assert.deepEqual(captionsApi(t3).cues().map((c) => textOf(t3, c)), ['So. We open at nine.'], `"So." alone would be up ${0.3 + 0.06} s`);
  // A pause breaks a phrase where nothing else does.
  const paused = speech([{ text: 'the light comes in', pause: 0.45 }, { text: 'early every morning here', pause: 0 }]);
  const t4 = trackFor(paused);
  assert.deepEqual(captionsApi(t4).cues().map((c) => textOf(t4, c)), ['the light comes in', 'early every morning here']);
});

test('captions.js: one word at a time, and only the stretch of the clip the page plays', () => {
  const track = trackFor(SPEECH);
  const one = captionsApi(track).cues(undefined, { words: 1 });
  assertCovers(track, one);
  assert.equal(one.length, SPEECH.length);
  const part = captionsApi(track).cues(undefined, { from: 3, to: 6 });
  const inside = SPEECH.map((w, i) => [w, i] as const).filter(([w]) => w[1] >= 3 && w[1] < 6).map(([, i]) => i);
  assert.deepEqual(part.flatMap((c) => c.words), inside);
  assert.ok(part.every((c) => c.end <= 6), 'nothing is up past the stretch');
});

test('captions.js: key words named by text and start mark exactly those words, a repeated word told apart by its start', () => {
  const api = captionsApi(trackFor(SPEECH));
  const marked = (keyWords: string, options = {}) => api.cues(undefined, { ...options, keyWords }).flatMap((c) => c.emphasis);
  assert.deepEqual(marked(''), [], 'none named, none marked');
  // The second "a" alone; "three" in capitals; "rooms," named without its comma.
  assert.deepEqual(marked(`${keyOf(SPEECH, 14)} THREE@${SPEECH[9][1].toFixed(2)} rooms@${SPEECH[10][1].toFixed(2)}`), [9, 10, 14]);
  // A start to the tenth, or the second, finds that word said nearest it; one to the thousandth, as transcript.json has it, too.
  assert.deepEqual(marked(`a@${SPEECH[14][1].toFixed(1)} the@${Math.round(SPEECH[4][1])} studio.@${SPEECH[6][1].toFixed(3)}`), [4, 6, 14]);
  // Outside the stretch the page plays, a key word is named but never laid.
  assert.deepEqual(marked(keyOf(SPEECH, 21), { from: 0, to: 5 }), []);

  // Each line `words` prints names its own word, and only it.
  const dir = scratchDir('captions-key-words');
  writeFileSync(join(dir, 'transcript.json'), JSON.stringify(transcriptOf(SPEECH)));
  const printed = wordsLines(join(dir, 'transcript.json')).slice(1);
  assert.equal(printed.length, SPEECH.length);
  printed.forEach((l, i) => {
    const [, start, text] = /^\s*([\d.]+)\s+[\d.]+\s+(.*)$/.exec(l)!;
    assert.deepEqual(marked(`${text.trim()}@${start}`), [i], `"${l}"`);
  });

  assert.throws(() => marked('studio'), /data-key-words: "studio" is not word@seconds/);
  assert.deepEqual(marked(`kitchen@${SPEECH[9][1].toFixed(2)} ${keyOf(SPEECH, 14)}`), [14], 'a name no word matches is skipped, and the rest still marked');
});

test(`captions.js: at most ${KEY_WORDS} key words a line are marked, the first named kept, whatever the page names`, () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let lines = 0, capped = 0;
  for (const words of [SPEECH, RUN_ON]) {
    const track = trackFor(words);
    for (const options of [{}, { lines: 1 }, { lines: 1, chars: 16 }, { lines: 3, chars: 80 }, { words: 3 }]) {
      for (let n = 0; n < 20; n++) {
        // Any number of words, in any order, a few named twice.
        const order = words.map((_, i) => i);
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        const picked = order.slice(0, 1 + Math.floor(rand() * words.length));
        const named = [...picked, ...picked.slice(0, 3)].map((i) => keyOf(words, i)).join(' ');
        for (const c of captionsApi(track).cues(undefined, { ...options, keyWords: named })) {
          assert.ok(c.emphasis.every((w) => c.words.includes(w)), 'a cue marks only its own words');
          for (const line of c.lines) {
            const mine = line.filter((w) => picked.includes(w));
            const want = mine.sort((a, b) => picked.indexOf(a) - picked.indexOf(b)).slice(0, KEY_WORDS).sort((a, b) => a - b);
            assert.deepEqual(c.emphasis.filter((w) => line.includes(w)), want, `${JSON.stringify(options)}: ${named}`);
            lines++;
            if (mine.length > KEY_WORDS) capped++;
          }
        }
      }
    }
  }
  assert.ok(capped > 100 && lines > 1000, `${capped} of ${lines} lines held more key words than ${KEY_WORDS}`);
});

// ---- rendered ---------------------------------------------------------------------------------------------------

const W = 360, H = 640;
const ZONE = zoneFor(formatNamed('tiktok'), { width: W, height: H });

function render(args: string[]): void {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'render', ...args], { encoding: 'utf8', timeout: 240_000 });
  assert.equal(r.status, 0, r.stderr);
}

function captionsCommand(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, ['--import', 'tsx', CLI, 'captions', ...args], { encoding: 'utf8', timeout: 60_000 });
}

/** A 9:16 piece for TikTok: the zone's stylesheet, the speech's transcript and its captions.js, and the page. */
function piece(name: string, body: string, style: string, words: Said[] = SPEECH, scripts = '', stateless = true): { dir: string; page: string } {
  const dir = scratchDir(`captions-${name}`);
  writeFileSync(join(dir, 'safe-zone.css'), stylesheet(ZONE));
  writeFileSync(join(dir, 'transcript.json'), JSON.stringify(transcriptOf(words)));
  const made = captionsCommand([join(dir, 'transcript.json')]);
  assert.equal(made.status, 0, made.stderr);
  const page = join(dir, 'index.html');
  writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="safe-zone.css">
<style>html,body{margin:0;background:#000}#stage{background:#234;font-family:Helvetica,Arial,sans-serif;color:#fff}${style}</style>
${scripts}<script src="captions.js"></script></head><body><div id="stage" data-safe-zone="9:16"${stateless ? ' data-stateless' : ''}>${body}</div></body></html>`);
  return { dir, page };
}

const captionTexts = (s: { texts: TextEntry[] }) => s.texts.filter((e) => e.caption);
const tokens = (entries: TextEntry[]) => new Set(entries.flatMap((e) => tokensOf(e.text)));

/** For every word: each sample while it is said shows it, or, for a word shorter than a sample, the first after it starts. */
function assertEveryWordShown(record: TextRecord, words: Said[], at = 0): void {
  for (const [text, start, end] of words) {
    const want = tokensOf(text)[0];
    const during = record.samples.filter((s) => timeOf(record, s.frame) >= start + at - 1e-9 && timeOf(record, s.frame) < end + at - 1e-4);
    const checked = during.length ? during : record.samples.filter((s) => timeOf(record, s.frame) >= start + at - 1e-9).slice(0, 1);
    assert.ok(checked.length, `"${text}" is said after the video ends`);
    for (const s of checked) assert.ok(tokens(captionTexts(s)).has(want), `"${text}" (${start}-${end} s) is not on screen at ${timeOf(record, s.frame)} s: ${captionTexts(s).map((e) => e.text).join(' ')}`);
  }
}

test('captions: rendered, every spoken word is on screen while it is said, in two-line cues inside the safe zone, and the captions check passes beside a card', { skip }, () => {
  // A card stacked right above the captions: the layout that merged captions and card into one block for the check.
  const { dir, page } = piece('default', '<div data-safe><div class="card">THE NEW STUDIO</div><div data-captions></div></div>',
    '.card{font-size:22px;font-weight:800;text-align:center}[data-captions]{text-align:center;font-size:24px;font-weight:800}');
  const out = join(dir, 'out.mp4');
  render([page, '--out', out, '--fps', '30', '--duration', '10.5']);
  const record = readRecord(recordPath(out));
  assertEveryWordShown(record, SPEECH);
  for (const s of record.samples) {
    const caps = captionTexts(s);
    for (const e of caps) {
      assert.ok(e.box[0] >= ZONE.left - 0.5 && e.box[0] + e.box[2] <= ZONE.right + 0.5 && e.box[1] >= ZONE.top - 0.5 && e.box[1] + e.box[3] <= ZONE.bottom + 0.5,
        `"${e.text}" at ${JSON.stringify(e.box)} leaves the zone ${JSON.stringify([ZONE.left, ZONE.top, ZONE.right, ZONE.bottom])}`);
    }
    assert.ok(new Set(caps.map((e) => e.box[1])).size <= LINES, `more than ${LINES} lines at ${s.time} s`);
    assert.ok(s.texts.some((e) => e.text === 'THE NEW STUDIO' && !e.caption), 'the card is not taken for a caption');
  }
  // Through the 0.8 s pause a caption stays up; in the 1.6 s silence it clears half a second after the last word.
  const at = (t: number) => captionTexts(record.samples.find((s) => Math.abs(timeOf(record, s.frame) - t) < 0.02)!);
  const lastOfFirst = SPEECH[6][2], lastOfSecond = SPEECH[15][2];
  assert.ok(at(Math.round((lastOfFirst + 0.6) * 10) / 10).length > 0, 'held through the pause');
  assert.equal(at(Math.round((lastOfSecond + 0.9) * 10) / 10).length, 0, 'cleared in the silence');
  const report = judgeCaptions({ path: recordPath(out), record }, { path: join(dir, 'transcript.json'), transcript: transcriptOf(SPEECH) });
  assert.equal(report.verdict, 'pass', report.lines.join('\n') + report.skipped.join('\n'));
  assert.match(report.lines[0], /^every stretch of speech has a caption on screen: \d+ caption text\(s\), \d+ in the page's caption track, /);
});

test('captions: styled under the size floor, the cues are laid out at the floor render draws them at, so every line stays in the zone', { skip }, () => {
  const { dir, page } = piece('floor', '<div data-safe><div data-captions></div></div>', '[data-captions]{text-align:center;font-size:10px;font-weight:800}');
  const out = join(dir, 'out.mp4');
  render([page, '--out', out, '--fps', '30', '--duration', '10.5']);
  const record = readRecord(recordPath(out));
  assertEveryWordShown(record, SPEECH);
  const floor = minText({ width: W, height: H });
  for (const s of record.samples) {
    const caps = captionTexts(s);
    for (const e of caps) {
      assert.equal(e.fontSize, floor, `"${e.text}" drawn at ${e.fontSize} px`);
      assert.ok(e.box[0] >= ZONE.left - 0.5 && e.box[0] + e.box[2] <= ZONE.right + 0.5, `"${e.text}" at ${JSON.stringify(e.box)} runs past the zone's sides ${ZONE.left}-${ZONE.right}`);
    }
    assert.ok(new Set(caps.map((e) => e.box[1])).size <= LINES, `more than ${LINES} lines at ${s.time} s`);
  }
});

test('captions: a track the page leaves unsized is drawn at the zone\'s caption size, under a card set at the card size', { skip }, () => {
  const { dir, page } = piece('unsized', '<div data-safe><div class="card">THE NEW STUDIO</div><div data-captions></div></div>',
    '.card{font-size:var(--card-text);font-weight:800}');
  const out = join(dir, 'out.mp4');
  render([page, '--out', out, '--fps', '10', '--duration', '3']);
  const record = readRecord(recordPath(out));
  assertEveryWordShown(record, SPEECH.filter((w) => w[2] < 3));
  for (const s of record.samples) {
    for (const e of captionTexts(s)) assert.equal(e.fontSize, ZONE.captionText, `"${e.text}" drawn at ${e.fontSize} px`);
    const card = s.texts.find((e) => e.text === 'THE NEW STUDIO');
    assert.equal(card?.fontSize, ZONE.cardText);
  }
  assert.ok(ZONE.cardText > ZONE.captionText);
});

test('captions: the page styles and animates the cues from their state, hides punctuation, and can show one word at a time', { skip }, () => {
  const style = `[data-captions]{text-align:center;font-size:24px;font-weight:800}
[data-word][data-state=now]{color:rgb(255,212,0);scale:calc(1 + 0.5 * max(0, 1 - var(--since) / 0.4))}
[data-word][data-state=next]{visibility:hidden}[data-punct]{display:none}`;
  const { dir, page } = piece('styled', '<div data-safe><div data-captions></div></div>', style);
  const out = join(dir, 'out.mp4');
  render([page, '--out', out, '--fps', '30', '--duration', '10.5']);
  const record = readRecord(recordPath(out));
  assertEveryWordShown(record, SPEECH);
  const sampleAt = (t: number) => record.samples.find((s) => timeOf(record, s.frame) >= t - 1e-9)!;
  let lit = 0, pops = 0;
  for (const [text, start, end] of SPEECH.filter((w) => w[2] - w[1] >= 0.25)) {
    const token = tokensOf(text)[0];
    const s = sampleAt(start);
    if (timeOf(record, s.frame) >= end) continue;
    const mine = captionTexts(s).filter((e) => tokensOf(e.text)[0] === token);
    assert.ok(mine.some((e) => e.color[0] === 255 && e.color[1] === 212 && e.color[2] === 0), `"${text}" is lit while said`);
    lit++;
    const others = captionTexts(s).filter((e) => tokensOf(e.text)[0] !== token);
    assert.ok(others.every((e) => e.color[1] === 255), `only "${text}" is lit`);
    // Just after it starts it is drawn larger than once it settles: the pop the page wrote from --since.
    const settled = sampleAt(start + 0.45);
    const popped = Math.max(...mine.map((e) => e.fontSize));
    const after = captionTexts(settled).filter((e) => tokensOf(e.text)[0] === token).map((e) => e.fontSize);
    if (after.length) {
      assert.ok(popped > Math.max(...after), `"${text}" pops: ${popped} px then ${after}`);
      pops++;
    }
    // The words not yet said are hidden.
    const later = SPEECH.filter((w) => w[1] > timeOf(record, s.frame) + 0.05 && w[1] < timeOf(record, s.frame) + 1).map((w) => tokensOf(w[0])[0]);
    const seen = tokens(captionTexts(s));
    assert.ok(later.every((w) => !seen.has(w) || SPEECH.some((x) => tokensOf(x[0])[0] === w && x[1] <= timeOf(record, s.frame))), `words ahead of "${text}" are hidden`);
  }
  assert.ok(lit >= 15 && pops >= 10, `${lit} words checked lit, ${pops} popping`);
  assert.ok(record.samples.every((s) => captionTexts(s).every((e) => !/[.,!?]/.test(e.text))), 'the page hid the punctuation');

  const single = piece('one-word', '<div data-safe><div data-captions data-words="1"></div></div>', '[data-captions]{text-align:center;font-size:40px}');
  const one = join(single.dir, 'out.mp4');
  render([single.page, '--out', one, '--fps', '30', '--duration', '10.5']);
  const shown = readRecord(recordPath(one));
  assertEveryWordShown(shown, SPEECH);
  assert.ok(shown.samples.every((s) => captionTexts(s).filter((e) => tokensOf(e.text).length).length <= 1), 'one word on screen at a time');
});

test('captions: rendered, the key words named are drawn emphasised and nothing else is, each changing state on the frame its word does', { skip }, () => {
  const keys = [5, 9, 14, 21]; // "new", "three", the second "a", "yourself!"
  const style = `[data-captions]{text-align:center;font-size:24px;font-weight:800}[data-word][data-state=now]{color:rgb(255,212,0)}
[data-word][data-emphasis]{font-size:30px;color:rgb(0,200,255)}[data-word][data-emphasis][data-state=next]{color:rgb(0,90,120)}
[data-word][data-emphasis][data-state=now]{color:rgb(255,0,160)}`;
  const { dir, page } = piece('key-words', `<div data-safe><div data-captions data-key-words="${keys.map((i) => keyOf(SPEECH, i)).join(' ')}"></div></div>`, style);
  const out = join(dir, 'out.mp4');
  // At 10 fps the text is read on every frame.
  render([page, '--out', out, '--fps', '10', '--duration', '10.5']);
  const record = readRecord(recordPath(out));
  assert.equal(record.framesPerSample, 1);
  assertEveryWordShown(record, SPEECH);
  const COLOUR = { plain: { next: [255, 255, 255], now: [255, 212, 0], said: [255, 255, 255] }, key: { next: [0, 90, 120], now: [255, 0, 160], said: [0, 200, 255] } };
  const spoken = SPEECH.map((w) => tokensOf(w[0])[0]);
  // A word's line and its place in it, from its selector.
  const place = (e: TextEntry) => /div:nth-child\((\d+)\)>span:nth-child\((\d+)\)$/.exec(e.selector)!.slice(1).map(Number);
  const seen = new Set<number>();
  for (const s of record.samples) {
    // The cue's words in the order laid, matched to the run of the speech they are.
    const drawn = captionTexts(s).filter((e) => tokensOf(e.text).length).sort((a, b) => place(a)[0] - place(b)[0] || place(a)[1] - place(b)[1]);
    if (!drawn.length) continue;
    const at = spoken.map((_, o) => o).filter((o) => drawn.every((e, i) => tokensOf(e.text)[0] === spoken[o + i]));
    assert.equal(at.length, 1, `the words on screen at ${s.time} s are one run of the speech`);
    const c = timeOf(record, s.frame) + 1e-6;
    drawn.forEach((e, i) => {
      const w = at[0] + i, [text, start, end] = SPEECH[w];
      const said = i + 1 < drawn.length ? c >= SPEECH[w + 1][1] : c >= end;
      const state = c < start ? 'next' : said ? 'said' : 'now';
      const key = keys.includes(w);
      if (key) seen.add(w);
      assert.deepEqual(e.color.slice(0, 3), COLOUR[key ? 'key' : 'plain'][state], `"${text}" (${start}-${end} s) at ${s.time} s: ${key ? 'a key word' : 'plain'}, ${state}`);
      assert.ok(e.box[0] >= ZONE.left - 0.5 && e.box[0] + e.box[2] <= ZONE.right + 0.5, `"${e.text}" at ${JSON.stringify(e.box)} runs past the zone's sides`);
    });
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), keys, 'every key word was drawn');
});

test(`captions.js: in Chrome, a line naming more than ${KEY_WORDS} key words marks the first named, the console names the rest and a name no word matches, and a word the page retexts keeps its name`, { skip }, async () => {
  // Every word named, the last said first: each line keeps its last two words. "kitchen" at three's start is a typo.
  const named = [...SPEECH.map((_, i) => keyOf(SPEECH, i)).reverse(), `kitchen@${SPEECH[9][1].toFixed(2)}`];
  const { dir, page } = piece('key-words-cap', `<div data-safe><div data-captions data-key-words="${named.join(' ')}"></div></div>
<script>openeditCaptions.words()[9].text = '3';</script>`, '[data-captions]{text-align:center;font-size:24px}');
  const { chromium } = await import('playwright-core');
  const server = await startPageServer({ roots: [dir] });
  const browser = await chromium.launch({ executablePath: installedChrome(platform!), args: CHROME_FLAGS });
  try {
    const p = await browser.newPage();
    const warnings: string[] = [], errors: string[] = [];
    p.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(server.urlFor(page));
    await p.waitForFunction('document.querySelector("[data-captions] [data-cue]")');
    const { laid, cue, marked, three } = await p.evaluate(`(() => {
      const el = document.querySelector('[data-captions]'), cue = el.querySelector('[data-cue]');
      return { laid: openeditCaptions.laid(el), cue: Number(cue.getAttribute('data-cue')), three: openeditCaptions.words()[9].text,
        marked: [...cue.querySelectorAll('[data-emphasis]')].map((w) => Number(w.getAttribute('data-word'))) };
    })()`) as { laid: Cue[]; cue: number; marked: number[]; three: string };
    assert.deepEqual(errors, [], '"three", shown as 3, is still named by its own text, and the typo stops nothing');
    assert.equal(three, '3');
    assert.ok(laid.length >= 3, 'the cues are laid');
    const dropped: number[] = [];
    for (const c of laid) {
      for (const line of c.lines) {
        assert.deepEqual(c.emphasis.filter((w) => line.includes(w)), line.slice(-KEY_WORDS), `line ${line.join(',')}`);
        dropped.push(...line.slice(0, -KEY_WORDS));
      }
    }
    assert.ok(dropped.length > 0);
    assert.deepEqual(marked, laid[cue].emphasis, 'the spans on screen are marked as laid');
    const names = dropped.sort((a, b) => b - a).map((i) => keyOf(SPEECH, i));
    assert.match(warnings[0] ?? '', /^openeditCaptions: data-key-words: no "kitchen" starts at \d+\.\d\d s in transcript\.json, so it is not emphasised; the words that start nearest it are three@/);
    assert.equal(warnings.filter((w) => w.includes('"kitchen"')).length, 1, 'the name no word matches is noted once');
    assert.deepEqual([...new Set(warnings.slice(1))], [`openeditCaptions: a line emphasises at most ${KEY_WORDS} key words, the first named, so ${names.join(', ')} are not emphasised`]);
  } finally {
    await browser.close();
    await server.close();
  }
});

test('captions: on the page\'s clock, a clip that starts later on the page is captioned later, and one worker draws what four do', { skip }, () => {
  const { dir, page } = piece('clock', '<div data-safe><div class="title">TITLE</div><div data-captions data-at="1.5"></div></div>',
    '.title{font-size:30px}[data-captions]{font-size:24px}[data-word][data-state=now]{color:rgb(255,212,0)}');
  const outs = [1, 4].map((workers) => {
    const out = join(dir, `out-${workers}.mp4`);
    render([page, '--out', out, '--fps', '30', '--duration', '12', '--workers', String(workers)]);
    return readRecord(recordPath(out));
  });
  assert.deepEqual(outs[1].samples, outs[0].samples, 'the record is the same whichever worker drew each frame');
  const record = outs[0];
  assert.ok(record.samples.filter((s) => timeOf(record, s.frame) < SPEECH[0][1] + 1.5 - 1e-9).every((s) => captionTexts(s).length === 0), 'nothing before the clip starts');
  assertEveryWordShown(record, SPEECH, 1.5);
  const shifted = SPEECH.map(([text, a, b]): Said => [text, a + 1.5, b + 1.5]);
  assert.equal(judgeCaptions({ path: 'out.text.json', record }, { path: 'transcript.json', transcript: transcriptOf(shifted) }).verdict, 'pass');
});

test('captions: with faces.js loaded, each cue is placed off the faces and kept in the safe zone', { skip }, () => {
  // A face low in the frame, over where the captions sit; the cue has to go above it.
  const face = { x: 60, y: 420, w: 240, h: 120 };
  const clip: FacesClip = {
    video: '/media/clip.mp4', name: 'clip.mp4', width: W, height: H, fps: 30, frameRate: '30', durationSec: 12, model: 'blaze_face_full_range',
    every: 1, threshold: 10, confidence: 0.5, textMargin: 0,
    shots: [{ start: 0, end: 12, samples: Array.from({ length: 12 }, (_, i) => ({ sec: i + 0.5, faces: [face] })) }],
  };
  const { dir, page } = piece('faces', '<div data-safe><div data-captions></div></div>',
    '[data-safe]{display:flex;flex-direction:column;justify-content:flex-end}[data-captions]{text-align:center;font-size:24px;margin-bottom:60px}', SPEECH,
    '<script src="faces.js"></script>');
  const overFace = (e: TextEntry) => {
    const [x, y, w, h] = e.box;
    return !(x + w <= face.x || face.x + face.w <= x || y + h <= face.y || face.y + face.h <= y);
  };
  // Without the faces the captions sit over the face, so the placement below is the script's doing.
  writeFileSync(join(dir, 'faces.js'), '');
  const bare = join(dir, 'bare.mp4');
  render([page, '--out', bare, '--fps', '30', '--duration', '10.5']);
  assert.ok(readRecord(recordPath(bare)).samples.some((s) => captionTexts(s).some(overFace)), 'the layout puts captions on the face');
  writeFileSync(join(dir, 'faces.js'), facesScript(clip));
  const out = join(dir, 'out.mp4');
  render([page, '--out', out, '--fps', '30', '--duration', '10.5']);
  const record = readRecord(recordPath(out));
  assertEveryWordShown(record, SPEECH);
  for (const s of record.samples) {
    for (const e of captionTexts(s)) {
      assert.ok(!overFace(e), `"${e.text}" at ${JSON.stringify(e.box)} is over the face at ${s.time} s`);
      assert.ok(e.box[1] >= ZONE.top - 0.5 && e.box[1] + e.box[3] <= ZONE.bottom + 0.5, `"${e.text}" left the zone`);
    }
  }
});

/** A clip of the stage's own size with these shots, each sampled where it says. */
function stageClip(shots: { start: number; end: number; samples: [sec: number, faces: { x: number; y: number; w: number; h: number }[]][] }[], video = '/media/clip.mp4'): FacesClip {
  return {
    video, name: video.split('/').pop()!, width: W, height: H, fps: 30, frameRate: '30', durationSec: shots.at(-1)!.end, model: 'blaze_face_full_range',
    every: 0.5, threshold: 10, confidence: 0.5, textMargin: 0,
    shots: shots.map((s) => ({ start: s.start, end: s.end, samples: s.samples.map(([sec, faces]) => ({ sec, faces })) })),
  };
}
const every = (from: number, to: number, faces: (sec: number) => { x: number; y: number; w: number; h: number }[]): [number, { x: number; y: number; w: number; h: number }[]][] =>
  Array.from({ length: Math.round((to - from) / 0.5) }, (_, i) => [from + i / 2, faces(from + i / 2)]);
const bottomOf = (s: { texts: TextEntry[] }) => Math.max(...captionTexts(s).map((e) => e.box[1] + e.box[3]));
const textOfSample = (s: { texts: TextEntry[] }) => captionTexts(s).map((e) => e.text).join(' ');
const spread = (list: number[]) => Math.max(...list) - Math.min(...list);
function assertOffFaces(record: TextRecord, clip: FacesClip): void {
  const faces = facesApi(clip);
  for (const s of record.samples) {
    const t = timeOf(record, s.frame);
    for (const e of captionTexts(s)) {
      const [x, y, w, h] = e.box;
      for (const f of faces.boxes(t + 1e-6)) assert.ok(x + w <= f.x || f.x + f.w <= x || y + h <= f.y || f.y + f.h <= y, `"${e.text}" at ${JSON.stringify(e.box)} is over a face at ${t} s`);
    }
  }
}

test('captions: with faces.js loaded, the cues hold one place through each shot and move only at the cut, a cue up across it included, whichever worker draws them', { skip }, () => {
  // A word at a time at the bottom of the zone. A face high in the frame for the first three seconds is clear of
  // them; then one comes down over where they sit, until the cut at 5.1 s, which falls while "kitchen" is up. Placed
  // cue by cue, the words before it would stay at the bottom and the rest go up over it.
  const high = { x: 60, y: 150, w: 240, h: 110 }, low = { x: 60, y: 350, w: 240, h: 120 };
  const clip = stageClip([{ start: 0, end: 5.1, samples: every(0, 5.5, (sec) => [sec <= 3 ? high : low]) }, { start: 5.1, end: 10.5, samples: every(5.5, 10.5, () => []) }]);
  const { dir, page } = piece('shots', '<div data-safe><div data-captions data-words="1"></div></div>',
    '[data-safe]{display:flex;flex-direction:column;justify-content:flex-end}[data-captions]{text-align:center;font-size:24px}', SPEECH,
    '<script src="faces.js"></script>');
  writeFileSync(join(dir, 'faces.js'), facesScript(clip));
  const records = [1, 4].map((workers) => {
    const out = join(dir, `w${workers}.mp4`);
    render([page, '--out', out, '--fps', '30', '--duration', '10.5', '--workers', String(workers)]);
    return readRecord(recordPath(out));
  });
  assert.deepEqual(records[1].samples, records[0].samples, 'four workers draw what one does');
  const record = records[0];
  assertEveryWordShown(record, SPEECH);
  assertOffFaces(record, clip);
  const shown = record.samples.filter((s) => captionTexts(s).length);
  const before = shown.filter((s) => timeOf(record, s.frame) + 1e-6 < 5.1), after = shown.filter((s) => timeOf(record, s.frame) + 1e-6 >= 5.1);
  assert.ok(before.length > 20 && after.length > 20);
  assert.ok(spread(before.map(bottomOf)) <= 1, `the first shot's cues sit at bottoms ${[...new Set(before.map(bottomOf))].join(', ')}, not one`);
  assert.ok(spread(after.map(bottomOf)) <= 1, `the second shot's cues sit at bottoms ${[...new Set(after.map(bottomOf))].join(', ')}, not one`);
  assert.ok(bottomOf(before[0]) <= low.y && bottomOf(after[0]) > low.y, `up over the face through the first shot (${bottomOf(before[0])}), back down after the cut (${bottomOf(after[0])})`);
  const kitchen = shown.filter((s) => textOfSample(s) === 'kitchen');
  assert.ok(kitchen.some((s) => before.includes(s)) && kitchen.some((s) => after.includes(s)), 'a cue is up across the cut, and drawn on both sides of it');
});

test('captions: a cue up across a cut moves there without starting its animations over', { skip }, () => {
  // The cue fades in over 3 s and the word being said over 0.3 s, neither ever down again; the cut at 5.2 s falls in
  // the second cue, a quarter second into saying "kitchen", and sends the cue from over the face back down.
  const low = { x: 60, y: 400, w: 240, h: 70 };
  const clip = stageClip([{ start: 0, end: 5.2, samples: every(0, 5.5, () => [low]) }, { start: 5.2, end: 10.5, samples: every(5.5, 10.5, () => []) }]);
  // The fade is keyed to the cue being the container's only child, as a page may write it. The state changes start
  // animations, so the page is not marked data-stateless, and one worker draws it in order.
  const { dir, page } = piece('animated', '<div data-safe><div data-captions></div></div>',
    `[data-safe]{display:flex;flex-direction:column;justify-content:flex-end}[data-captions]{text-align:center;font-size:24px}
[data-cue]:only-child{animation:fade 3s linear both}@keyframes fade{from{opacity:.4}to{opacity:1}}
[data-word][data-state=next]{opacity:.2}[data-word][data-state=now]{animation:pulse .3s linear both}@keyframes pulse{from{opacity:.2}to{opacity:1}}`, SPEECH,
    '<script src="faces.js"></script>', false);
  writeFileSync(join(dir, 'faces.js'), facesScript(clip));
  const out = join(dir, 'out.mp4');
  render([page, '--out', out, '--fps', '30', '--duration', '10.5', '--workers', '1']);
  const record = readRecord(recordPath(out));
  assertOffFaces(record, clip);
  const second = record.samples.filter((s) => captionTexts(s).some((e) => e.text === 'kitchen'));
  assert.ok(second.some((s) => timeOf(record, s.frame) < 5.2) && second.some((s) => timeOf(record, s.frame) > 5.2), 'the second cue is up across the cut');
  assert.ok(bottomOf(second[0]) <= low.y && bottomOf(second.at(-1)!) > low.y, 'and moves at it');
  const last = new Map<string, [number, number]>();
  for (const s of second) {
    for (const e of captionTexts(s)) {
      const had = last.get(e.selector), t = timeOf(record, s.frame);
      assert.ok(!had || e.opacity >= had[0] - 0.011, `"${e.text}" faded from ${had?.[0]} at ${had?.[1]} s to ${e.opacity} at ${t} s: an animation started over`);
      last.set(e.selector, [e.opacity, t]);
    }
  }
});

test('captions: a cue earlier in a shot holds the later ones to its place, and a worker or a patch that starts mid-shot draws what one from the start does', { skip }, () => {
  // Centred cues. The first cue is up under a face just above them, the second over one across them: on its own the
  // second would go up, into the first's face, so the shot goes down. Nearest samples are blank either side of the
  // change, so neither cue sees the other's face. The container pads itself while it holds the second cue, so a cue
  // measured beside another is measured wrong; a lower third burned in while the last cue is up sends that one up.
  const above = { x: 61, y: 140, w: 238, h: 110 }, across = { x: 61, y: 250, w: 238, h: 80 }, third = { x: 61, y: 260, w: 238, h: 80 };
  const clip = stageClip([
    { start: 0, end: 7, samples: [...every(0.5, 3, () => [above]), [3, []], [3.5, []], ...every(4, 7, () => [across])] },
    { start: 7, end: 10.5, samples: every(7, 10.5, () => []) },
  ]);
  clip.graphics = [{ ...third, from: 8, to: 9 }];
  const { dir, page } = piece('order', '<div data-safe><div data-captions></div></div>',
    '[data-safe]{display:flex;flex-direction:column;justify-content:center}[data-captions]{text-align:center;font-size:24px}[data-captions]:has([data-cue="1"]){padding-bottom:60px}', SPEECH,
    '<script src="faces.js"></script>');
  writeFileSync(join(dir, 'faces.js'), facesScript(clip));
  const outs = [1, 3].map((workers) => {
    const out = join(dir, `w${workers}.mp4`);
    render([page, '--out', out, '--fps', '30', '--duration', '10.5', '--workers', String(workers)]);
    return out;
  });
  const whole = readRecord(recordPath(outs[0]));
  assert.deepEqual(readRecord(recordPath(outs[1])).samples, whole.samples, 'the second of three workers starts in the second cue');
  render([page, '--out', outs[0], '--fps', '30', '--duration', '10.5', '--from', '3', '--to', '5', '--workers', '2']);
  assert.deepEqual(readRecord(recordPath(outs[0])).samples, whole.samples, 'the patch starts at 2 s, in the first cue, and at 4 s, in the second');
  assertOffFaces(whole, clip);
  const shown = whole.samples.filter((s) => captionTexts(s).length);
  const first = shown.filter((s) => timeOf(whole, s.frame) < 7), last = shown.filter((s) => timeOf(whole, s.frame) >= 7);
  const tops = (list: typeof shown) => list.map((s) => Math.min(...captionTexts(s).map((e) => e.box[1])));
  assert.ok(bottomOf(first[0]) > across.y + across.h, `the first shot's cues sit below the face across them, not at ${[...new Set(first.map(bottomOf))].join(', ')}`);
  assert.ok(spread(tops(first.filter((s) => captionTexts(s).some((e) => e.text === 'Today')))) <= 1 && spread(tops(first.filter((s) => captionTexts(s).some((e) => e.text === 'kitchen')))) <= 1);
  assert.ok(Math.max(...tops(last)) + 1 < third.y, `the last cue is up off the lower third, at ${[...new Set(tops(last))].join(', ')}`);
});

test('captions: a page whose faces.js was written before captions held one place through a shot stops, naming it', { skip }, () => {
  const { dir, page } = piece('older', '<div data-safe><div data-captions></div></div>', '[data-captions]{font-size:24px}', SPEECH,
    '<script src="old-faces.js"></script><script src="faces.js"></script>');
  // The older faces.js is loaded first, so its openeditFaces is the page's, and the newer one only adds its clip to it.
  writeFileSync(join(dir, 'old-faces.js'), 'window.openeditFaces = { clips: {}, add: function (clip) { this.clips[clip.video] = clip; }, place: function () {} };');
  writeFileSync(join(dir, 'faces.js'), facesScript(stageClip([{ start: 0, end: 10.5, samples: every(0, 10.5, () => []) }])));
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'render', page, '--out', join(dir, 'out.mp4'), '--fps', '30', '--duration', '2'], { encoding: 'utf8', timeout: 240_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /openeditCaptions: of old-faces\.js, faces\.js, the first loaded was written by an older openedit and has no openeditFaces\.placer, which captions\.js needs: load the faces\.js that "openedit faces <clip>" prints instead/);
});

test('captions: cues under the size floor are placed at the size the render draws them', { skip }, () => {
  // One word at a time at 12 px, which the render raises to the floor; a face sits just above each word as the page
  // sizes it, and over it as the render draws it.
  const face = { x: 61, y: 455, w: 238, h: 20 };
  const clip = stageClip([{ start: 0, end: 10.5, samples: every(0, 10.5, () => [face]) }]);
  const { dir, page } = piece('floor-placed', '<div data-safe><div data-captions data-words="1"></div></div>',
    '[data-safe]{display:flex;flex-direction:column;justify-content:flex-end}[data-captions]{text-align:center;font-size:12px}', SPEECH,
    '<script src="faces.js"></script>');
  writeFileSync(join(dir, 'faces.js'), facesScript(clip));
  const out = join(dir, 'out.mp4');
  render([page, '--out', out, '--fps', '30', '--duration', '10.5']);
  const record = readRecord(recordPath(out));
  const shown = record.samples.filter((s) => captionTexts(s).length);
  assert.ok(shown.length > 50 && shown.every((s) => captionTexts(s).every((e) => e.fontSize >= ZONE.minText - 0.5)), 'the words are drawn at the floor');
  assertOffFaces(record, clip);
});

/** The page in Chrome with requestAnimationFrame run by hand, as render runs it, at page seconds 'sec'. */
async function stepped(page: string, dir: string, body: (p: Page, step: (sec: number) => Promise<void>, warnings: string[], errors: string[]) => Promise<void>): Promise<void> {
  const { chromium } = await import('playwright-core');
  const server = await startPageServer({ roots: [dir] });
  const browser = await chromium.launch({ executablePath: installedChrome(platform!), args: CHROME_FLAGS });
  try {
    const p = await browser.newPage();
    const warnings: string[] = [], errors: string[] = [];
    p.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });
    p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript(() => {
      const queue: ((ms: number) => void)[] = [];
      const w = window as unknown as { requestAnimationFrame: (cb: (ms: number) => void) => number; step: (ms: number) => void };
      w.requestAnimationFrame = (cb) => queue.push(cb);
      w.step = (ms) => { for (const cb of queue.splice(0)) cb(ms); };
    });
    await p.goto(server.urlFor(page));
    await p.evaluate('document.fonts.ready');
    await body(p, async (sec) => { await p.evaluate(`step(${sec * 1000})`); }, warnings, errors);
  } finally {
    await browser.close();
    await server.close();
  }
}
const cueBox = async (p: Page) => await p.evaluate(`(() => { const r = document.querySelector('[data-captions] [data-cue]').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`) as { x: number; y: number; w: number; h: number };
const meets = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('captions.js: in Chrome, cues are placed at their settled look, through the clip and video the container names, laid again when its width changes, and a shot that needs two places says so', { skip }, async () => {
  // A word once said is drawn larger: the settled cue, every word said, reaches up into a face its words being said
  // stay clear of, and is what the place is found for.
  const face = { x: 61, y: 350, w: 238, h: 80 };
  const grown = piece('settled', '<div data-safe><div data-captions></div></div>',
    '[data-safe]{display:flex;flex-direction:column;justify-content:flex-end}[data-captions]{text-align:center;font-size:20px}[data-word][data-state=said]{font-size:30px}', SPEECH,
    '<script src="faces.js"></script>');
  writeFileSync(join(grown.dir, 'faces.js'), facesScript(stageClip([{ start: 0, end: 10.5, samples: every(0, 10.5, () => [face]) }])));
  await stepped(grown.page, grown.dir, async (p, step, warnings, errors) => {
    await step(3.3);
    assert.deepEqual(errors, []);
    assert.ok(!meets(await cueBox(p), face), `the first cue, every word said, at ${JSON.stringify(await cueBox(p))} is on the face`);
  });

  // Two clips loaded, and the container names b: one has to be named, and b's faces are the ones kept clear. b has
  // one where the captions sit while the first cue is up and one across the top while the second is, with a blank
  // sample either side between, so the first cue goes up and the second stays down: two places.
  const twoClips = piece('named', '<div data-safe><div data-captions data-clip="b.mp4"></div></div>',
    '[data-safe]{display:flex;flex-direction:column;justify-content:flex-end}[data-captions]{text-align:center;font-size:24px}', SPEECH,
    '<script src="faces-a.js"></script><script src="faces-b.js"></script>');
  const low = { x: 61, y: 420, w: 238, h: 72 }, high = { x: 61, y: 80, w: 238, h: 320 };
  writeFileSync(join(twoClips.dir, 'faces-a.js'), facesScript(stageClip([{ start: 0, end: 10.5, samples: every(0, 10.5, () => []) }], '/media/a.mp4')));
  writeFileSync(join(twoClips.dir, 'faces-b.js'), facesScript(stageClip([{ start: 0, end: 10.5, samples: [...every(0, 3, () => [low]), [3, []], [3.5, []], ...every(4, 10.5, () => [high])] }], '/media/b.mp4')));
  await stepped(twoClips.page, twoClips.dir, async (p, step, warnings, errors) => {
    await step(1);
    const first = await cueBox(p);
    await step(5);
    const second = await cueBox(p);
    assert.deepEqual(errors, []);
    assert.ok(!meets(first, low) && first.y + first.h <= low.y, `the first cue at ${JSON.stringify(first)} is up off b's face`);
    assert.ok(!meets(second, high) && second.y + second.h > low.y, `the second cue at ${JSON.stringify(second)} is down, off the one across the top`);
    assert.deepEqual(warnings.filter((w) => w.startsWith('openeditFaces')), [
      'openeditFaces: no one place inside its [data-safe] container keeps the captions off every face and graphic through the shot from 0.00 to 10.50 s of the clip, so the captions take 2 places in it, moving at 3.40 s',
    ]);
  });

  // The clip drawn in the top half of the stage by an <img> the container names: its face, at the bottom of the
  // picture, is drawn above the captions, which stay put; on the stage it would be on them.
  const drawn = piece('drawn', '<img id="v" src="clip.mp4"><div data-safe><div data-captions data-video="#v"></div></div>',
    '#v{position:absolute;left:0;top:0;width:360px;height:320px}[data-safe]{display:flex;flex-direction:column;justify-content:flex-end}[data-captions]{text-align:center;font-size:24px}', SPEECH,
    '<script src="faces.js"></script>');
  const chin = { x: 61, y: 440, w: 238, h: 50 };
  writeFileSync(join(drawn.dir, 'faces.js'), facesScript(stageClip([{ start: 0, end: 10.5, samples: every(0, 10.5, () => [chin]) }], join(drawn.dir, 'clip.mp4'))));
  await stepped(drawn.page, drawn.dir, async (p, step, warnings, errors) => {
    await step(1);
    const named = await cueBox(p);
    await p.evaluate(`document.querySelector('[data-captions]').removeAttribute('data-video'); document.getElementById('v').remove()`);
    await step(4);
    assert.deepEqual(errors, []);
    const stage = await cueBox(p);
    assert.ok(meets(named, chin) && !meets(stage, chin), `drawn in the <img>, the face is above the cue at ${JSON.stringify(named)}; on the stage the cue at ${JSON.stringify(stage)} keeps off it`);
  });

  // Up across a cut with the word being said drawn larger: placed for its settled look, the cue is clear of the next
  // shot's face, but drawn larger it meets it. That is said once, as it is drawn, and nothing claims a transform turned
  // a move never made.
  const said = piece('said-larger', '<div data-safe><div data-captions></div></div>',
    '[data-safe]{display:flex;flex-direction:column;justify-content:flex-end}[data-captions]{text-align:center;font-size:24px}[data-word][data-state=now]{font-size:60px}', SPEECH,
    '<script src="faces.js"></script>');
  writeFileSync(join(said.dir, 'faces.js'), facesScript(stageClip([{ start: 0, end: 5, samples: every(0, 5, () => []) }, { start: 5, end: 10.5, samples: every(5, 10.5, () => [{ x: 61, y: 380, w: 238, h: 50 }]) }])));
  await stepped(said.page, said.dir, async (p, step, warnings, errors) => {
    for (const sec of [4.9, 5.1, 5.2, 5.5]) await step(sec);
    assert.deepEqual(errors, []);
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0], /^openeditFaces\.place: this element is drawn larger than the \d+x\d+ px box it was placed for, from 5\.00 to 6\.64 s of the clip, and so meets a face or graphic/);
  });

  // The cues laid again twice at another width and back: a shot's line is said once.
  await stepped(twoClips.page, twoClips.dir, async (p, step, warnings) => {
    for (const [width, sec] of [['', 5], ['237px', 5.1], ['', 5.2]] as const) {
      await p.evaluate(`document.querySelector('[data-captions]').style.width = '${width}'`);
      await step(sec);
    }
    assert.equal(warnings.filter((w) => w.startsWith('openeditFaces')).length, 1, warnings.join('\n'));
  });

  // A faces.js from before placer(), alone or written into the page, is named as best the page can.
  for (const [scripts, named] of [['<script src="old-faces.js"></script>', 'old-faces.js'], ['<script>window.openeditFaces = { clips: {}, add() {}, place() {} };</script>', "the page's faces.js"]]) {
    const old = piece('older-alone', '<div data-safe><div data-captions></div></div>', '[data-captions]{font-size:24px}', SPEECH, scripts);
    writeFileSync(join(old.dir, 'old-faces.js'), 'window.openeditFaces = { clips: {}, add() {}, place() {} };');
    await stepped(old.page, old.dir, async (p, step) => {
      const thrown = await step(1).then(() => '', (e: Error) => e.message);
      assert.ok(thrown.includes(`openeditCaptions: ${named} was written by an older openedit and has no openeditFaces.placer, which captions.js needs: load the faces.js that "openedit faces <clip>" prints instead`), thrown);
    });
  }

  // The container narrowed mid-shot: the cues are laid again, more of them, and placed again from those.
  const narrowed = piece('narrowed', '<div data-safe><div data-captions></div></div>',
    '[data-safe]{display:flex;flex-direction:column;justify-content:flex-end}[data-captions]{text-align:center;font-size:24px;margin:0 auto}', SPEECH,
    '<script src="faces.js"></script>');
  writeFileSync(join(narrowed.dir, 'faces.js'), facesScript(stageClip([{ start: 0, end: 10.5, samples: every(0, 10.5, () => [low]) }])));
  await stepped(narrowed.page, narrowed.dir, async (p, step, warnings, errors) => {
    await step(1);
    const before = await p.evaluate(`openeditCaptions.laid(document.querySelector('[data-captions]')).length`) as number;
    await p.evaluate(`document.querySelector('[data-captions]').style.width = '120px'`);
    await step(9);
    const after = await p.evaluate(`openeditCaptions.laid(document.querySelector('[data-captions]')).length`) as number;
    assert.deepEqual(errors, []);
    assert.ok(after > before, `${after} cues at 120 px, ${before} at the zone's width`);
    assert.ok(!meets(await cueBox(p), low));
  });
});

// ---- the check, and the command ---------------------------------------------------------------------------------

test('captions check: text in the page\'s caption track is a caption, even set right under a card it would merge with', () => {
  // A card's line and the caption under it, closer than a line apart: read as one block, they matched no speech.
  const words = SPEECH;
  const frames = 10.5 * 30;
  const record = (flag: boolean): TextRecord => {
    const samples = [];
    for (let frame = 0; frame < frames; frame += 3) {
      const t = frame / 30;
      const texts: TextEntry[] = [{ text: 'NO ONE CARES HOW IT IS MADE', box: [60, 200, 240, 30], fontSize: 26, color: [255, 255, 255, 1], opacity: 1, selector: '#card' }];
      const cue = words.filter((w) => w[1] <= t + 1e-9 && t < w[2] + 0.4);
      cue.forEach((w, i) => texts.push({ text: w[0], box: [60 + i * 40, 236, 36, 30], fontSize: 26, color: [255, 255, 255, 1], opacity: 1, selector: `#cap>div>span:nth-child(${i + 1})`, ...(flag ? { caption: true as const } : {}) }));
      samples.push({ frame, time: Math.round(t * 1000) / 1000, texts });
    }
    return { version: 1, page: 'p.html', width: 360, height: 640, fps: '30', frames, transparent: false, framesPerSample: 3, samples };
  };
  const transcript = { path: 'transcript.json', transcript: transcriptOf(words) };
  assert.equal(judgeCaptions({ path: 'r', record: record(false) }, transcript).verdict, 'skipped', 'unmarked, the merged block shows none of the words');
  const marked = judgeCaptions({ path: 'r', record: record(true) }, transcript);
  assert.equal(marked.verdict, 'pass', marked.lines.join('\n') + marked.skipped.join('\n'));
});

test('captions: the command writes captions.js beside the transcript, reads a Whisper JSON, and leaves a captions.js it did not write alone', () => {
  const dir = scratchDir('captions-command');
  writeFileSync(join(dir, 'transcript.json'), JSON.stringify(transcriptOf(SPEECH)));
  const made = captionsCommand([join(dir, 'transcript.json')]);
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.stdout, /^captions: 22 words of .*transcript\.json, 0\.20-9\.79 s; each on screen from when it is said, cleared only in 1 silence\(s\) of a second or more$/m);
  const script = readFileSync(join(dir, 'captions.js'), 'utf8');
  const window: { openeditCaptions?: { words(): { text: string }[] } } = {};
  new Function('window', script)(window);
  assert.deepEqual(window.openeditCaptions!.words().map((w) => w.text), SPEECH.map((w) => w[0]));
  assert.equal(captionsCommand([join(dir, 'transcript.json')]).status, 0, 'its own captions.js is written again');

  const whisper = { segments: [{ start: 0.2, end: 1.4, text: ' Hello there friend', words: [{ word: ' Hello', start: 0.2, end: 0.5 }, { word: ' there', start: 0.55, end: 0.9 }, { word: ' friend', start: 0.95, end: 1.4 }] }] };
  writeFileSync(join(dir, 'whisper.json'), JSON.stringify(whisper));
  const mapped = captionsCommand([join(dir, 'whisper.json'), '--out', join(dir, 'w.js')]);
  assert.equal(mapped.status, 0, mapped.stderr);
  assert.match(mapped.stdout, /^captions: .*whisper\.json: read as Whisper segments with word times, mapped in memory \(3 words\)$/m);
  assert.match(mapped.stdout, /^captions: 3 words of .*whisper\.json, /m);

  const own = join(dir, 'mine');
  spawnSync('mkdir', [own]);
  writeFileSync(join(own, 'transcript.json'), JSON.stringify(transcriptOf(SPEECH)));
  writeFileSync(join(own, 'captions.js'), 'window.CUES = [];\n');
  const refused = captionsCommand([join(own, 'transcript.json')]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /is not a captions\.js this command wrote, so it is left as it is: pass another --out <file>/);
  assert.equal(readFileSync(join(own, 'captions.js'), 'utf8'), 'window.CUES = [];\n');
});
