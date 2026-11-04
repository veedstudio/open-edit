// The captions command and captions.js. The cue shaping runs everywhere, in Node from the page's own source; the
// pages are rendered by the real renderer in the pinned headless Chrome, skipped when it is not installed unless
// OPENEDIT_REQUIRE_BROWSER is set, and read back from the record of on-screen text render writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captionsApi, CLOSE_GAP, LAG_OUT, LINE_CHARS, LINES, trackOf, type CaptionTrack, type Cue } from '../src/captions/page-script.ts';
import { formatNamed, minText, stylesheet, zoneFor } from '../src/commands/safe-zone.ts';
import { facesScript, type FacesClip } from '../src/faces/page-script.ts';
import { chromePlatform, installedChrome } from '../src/render/browser.ts';
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
  // Thirty seconds of one run-on sentence with no pause: only the lines, the characters and the hold can break it.
  const runOn = speech([{ text: Array.from({ length: 100 }, (_, i) => ['the', 'studio', 'kitchen', 'garden', 'is', 'bright'][i % 6]).join(' '), each: 0.25, gap: 0.05, pause: 0 }]);
  const track = trackFor(runOn);
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
function piece(name: string, body: string, style: string, words: Said[] = SPEECH, scripts = ''): { dir: string; page: string } {
  const dir = scratchDir(`captions-${name}`);
  writeFileSync(join(dir, 'safe-zone.css'), stylesheet(ZONE));
  writeFileSync(join(dir, 'transcript.json'), JSON.stringify(transcriptOf(words)));
  const made = captionsCommand([join(dir, 'transcript.json')]);
  assert.equal(made.status, 0, made.stderr);
  const page = join(dir, 'index.html');
  writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="safe-zone.css">
<style>html,body{margin:0;background:#000}#stage{background:#234;font-family:Helvetica,Arial,sans-serif;color:#fff}${style}</style>
${scripts}<script src="captions.js"></script></head><body><div id="stage" data-safe-zone="9:16" data-stateless>${body}</div></body></html>`);
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
