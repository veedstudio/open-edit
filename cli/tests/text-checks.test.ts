// The two checks that read a render's record of on-screen text: the text check (size against the frame, contrast
// measured on the video's pixels) and the captions check (speech with no caption on screen). Contrast and size are
// judged on real renders in the pinned headless Chrome, skipped when it is not installed unless
// OPENEDIT_REQUIRE_BROWSER is set, and on clips ffmpeg draws; the captions check is judged on records built here,
// and once end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { review } from '../src/commands/review.ts';
import { FFMPEG } from '../src/config.ts';
import { chromePlatform, installedChrome } from '../src/render/browser.ts';
import { readRecord, recordPath, type TextEntry, type TextRecord } from '../src/render/text-record.ts';
import type { Transcript } from '../src/transcript/transcript-types.ts';
import { judgeCaptions, MIN_UNCAPTIONED } from '../src/verify/captions.ts';
import { CHECKS } from '../src/verify/checks.ts';
import { blocksOf } from '../src/verify/text-blocks.ts';
import { contrastOf, judgeText, type RgbFrame } from '../src/verify/text.ts';
import { TESTSRC, captureConsoleAsync, scratchDir, synthClip } from './helpers/synth.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const platform = chromePlatform();
const missing = platform && existsSync(installedChrome(platform)) ? null : 'Chrome Headless Shell is not installed (openedit install-browser)';
if (missing && process.env.OPENEDIT_REQUIRE_BROWSER) throw new Error(`${missing}, and OPENEDIT_REQUIRE_BROWSER is set`);
const skip = missing ?? false;

function render(args: string[]): void {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'render', ...args], { encoding: 'utf8', timeout: 240_000 });
  assert.equal(r.status, 0, r.stderr);
}

const found = (video: string) => ({ path: recordPath(video), record: readRecord(recordPath(video)) });

/** A record of `frames` frames, sampled every third, each sample showing what `texts` gives for its frame. */
function recordFor(o: { width: number; height: number; fps?: string; frames: number; transparent?: boolean; texts: (frame: number) => TextEntry[] }): TextRecord {
  const [num, den = 1] = (o.fps ?? '30').split('/').map(Number);
  const samples = [];
  for (let frame = 0; frame < o.frames; frame += 3) samples.push({ frame, time: Math.round((frame * den * 1000) / num) / 1000, texts: o.texts(frame) });
  return { version: 1, page: 'p.html', width: o.width, height: o.height, fps: o.fps ?? '30', frames: o.frames, transparent: o.transparent ?? false, framesPerSample: 3, samples };
}

const entry = (text: string, box: [number, number, number, number], fontSize: number, selector = '#t'): TextEntry =>
  ({ text, box, fontSize, color: [255, 255, 255, 1], opacity: 1, selector });

// A 9:16 stage, 360 px wide: the size floor is 4.5% of 360, 16.2 px.
const legibility = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#000}
#stage{position:relative;width:360px;height:640px;overflow:hidden;background:#e6e6e6;font:700 32px Helvetica,Arial,sans-serif;color:#fff}
#stage>div{position:absolute;left:16px}
.plate span{background:#222;padding:4px 10px;border-radius:8px}
.stroke{-webkit-text-stroke:3px #000;paint-order:stroke fill}
.shadow{text-shadow:0 0 8px rgba(0,0,0,.9),0 2px 4px #000}
.small{font-size:12px;color:#111}
.pop{color:#111;font-size:24px;animation:pop .5s .5s both}
@keyframes pop{from{transform:scale(.5)}to{transform:scale(1)}}
.half{color:rgba(255,255,255,.5)}
.faded{opacity:.5}
.grad{background:linear-gradient(90deg,#f00,#00f);-webkit-background-clip:text;background-clip:text;color:transparent}
</style></head><body><div id="stage">
<div style="top:20px">Pale wall</div>
<div class="plate" style="top:90px"><span>On a plate</span></div>
<div class="stroke" style="top:160px">With a stroke</div>
<div class="shadow" style="top:230px">With a shadow</div>
<div class="small" style="top:320px">Small print</div>
<div class="pop" style="top:380px">Pops in</div>
<div class="half" style="top:440px">Half white</div>
<div class="faded" style="top:500px">Half faded</div>
<div class="grad" style="top:560px">Gradient</div>
</div></body></html>`;

test('text: white text on a pale wall is under 3:1 where a plate, a stroke or a shadow lifts it, and small text is under the floor', { skip }, async () => {
  const dir = scratchDir('text-check');
  const page = join(dir, 'legibility.html');
  writeFileSync(page, legibility);
  const out = join(dir, 'out.mp4');
  // Drawn at the page's own sizes: render would raise the small print to the floor.
  render([page, '--out', out, '--fps', '30', '--duration', '1.5', '--no-text-floor']);
  const input = found(out);
  assert.deepEqual(input.record.samples[0].texts.map((e) => e.text).sort(), ['Gradient', 'Half faded', 'Half white', 'On a plate', 'Pale wall', 'Pops in', 'Small print', 'With a shadow', 'With a stroke']);
  const report = await judgeText(out, input);
  assert.equal(report.verdict, 'found', report.lines.join('\n'));
  const body = report.lines.join('\n');
  assert.match(body, /^1 text\(s\) under 16px, 4\.5% of the frame's 360px shorter side, smaller than a phone's body text:$/m);
  assert.match(body, /^"Small print" is 12px from 0\.00s to 1\.50s$/m);
  assert.match(body, /^1 time\(s\) a text is under 3:1 contrast with what is behind it, measured on the video's pixels:$/m);
  const pale = /^"Pale wall" is (\d\.\d):1 against what is behind it from 0\.00s to 1\.50s$/m.exec(body);
  assert.ok(pale, body);
  // White on #e6e6e6 is 1.25:1 by WCAG's formula; the encode moves it by a hair.
  assert.ok(Math.abs(Number(pale[1]) - 1.2) <= 0.1, `measured ${pale[1]}:1`);
  for (const lifted of ['On a plate', 'With a stroke', 'With a shadow', 'Pops in', 'Half white', 'Half faded', 'Gradient']) {
    assert.doesNotMatch(body, new RegExp(lifted), lifted);
  }
  assert.ok(report.skipped.includes('the contrast of 30 text sample(s) under 98% opaque, whose glyphs cannot be told by their colour'), report.skipped.join('\n'));
  assert.ok(report.skipped.includes('the contrast of 15 text sample(s) drawn without a solid fill of their own (a gradient or picture clipped to the text, or only a stroke or a shadow)'), report.skipped.join('\n'));
});

test('text: captions over footage are measured against the footage under them', { skip }, async () => {
  const dir = scratchDir('text-check-footage');
  const clip = join(dir, 'pale.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xe6e6e6:s=320x180:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
  const page = join(dir, 'captions.html');
  writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0}
#stage{position:relative;width:320px;height:180px;overflow:hidden;font:700 24px Helvetica,Arial,sans-serif;color:#fff}
#stage>div{position:absolute;left:12px}
.plate{background:#222;padding:4px 8px}
</style></head><body><div id="stage"><video src="pale.mp4" muted></video><div style="top:20px">Bare caption</div><div class="plate" style="top:100px">Plated caption</div></div></body></html>`);
  const out = join(dir, 'out.mp4');
  render([page, '--out', out, '--fps', '30', '--duration', '1', '--footage', clip]);
  const input = found(out);
  assert.deepEqual([input.record.width, input.record.height, input.record.transparent], [320, 180, false]);
  const report = await judgeText(out, input);
  assert.equal(report.verdict, 'found');
  assert.match(report.lines.join('\n'), /^"Bare caption" is 1\.\d:1 against what is behind it from 0\.00s to 1\.00s$/m);
  assert.doesNotMatch(report.lines.join('\n'), /Plated caption/);
});

test('text: a flash behind a text for less than a quarter second is not reported, a text shown only then is', async () => {
  const dir = scratchDir('text-check-flash');
  const video = join(dir, 'flash.mp4');
  // A white "glyph" on dark grey, the whole frame pale for frames 12 and 13 (the sample at 0.4 s).
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    "color=c=0x202020:s=160x90:r=30:d=1,drawbox=x=0:y=0:w=160:h=90:color=0xe6e6e6:t=fill:enable='between(t,0.39,0.45)',drawbox=x=40:y=30:w=40:h=20:color=white:t=fill",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  const box: [number, number, number, number] = [36, 26, 48, 28];
  const record = recordFor({ width: 160, height: 90, frames: 30, texts: (frame) => [entry('Steady', box, 30, '#steady'), ...(frame === 12 ? [entry('Flash', box, 30, '#flash')] : [])] });
  const report = await judgeText(video, { path: 'flash.mp4.text.json', record });
  assert.equal(report.verdict, 'found', report.lines.join('\n'));
  assert.equal(report.lines.length, 2);
  assert.match(report.lines[1], /^"Flash" is 1\.\d:1 against what is behind it from 0\.40s to 0\.50s$/);
});

test('text: contrast is judged on the ring around the glyphs that stands out most, and not at all with no ring in the frame', () => {
  const frame = (bg: number, glyph = 255): RgbFrame => {
    const rgb = new Uint8Array(40 * 30 * 3).fill(bg);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 30; x++) rgb.fill(glyph, (y * 40 + x) * 3, (y * 40 + x) * 3 + 3);
    return { width: 40, height: 30, rgb };
  };
  const text = entry('Hi', [8, 8, 24, 14], 20);
  assert.ok(Math.abs(contrastOf(frame(230), text)! - 1.25) < 0.02, 'white on #e6e6e6');
  assert.ok(contrastOf(frame(0), text)! > 20, 'white on black');
  // A dark outline two pixels wide, on the pale ground: the ring it fills is what counts.
  const outlined = frame(230);
  for (let y = 8; y < 22; y++) for (let x = 8; x < 32; x++) if (y < 10 || y >= 20 || x < 10 || x >= 30) outlined.rgb.fill(0, (y * 40 + x) * 3, (y * 40 + x) * 3 + 3);
  assert.ok(contrastOf(outlined, text)! > 20, 'an outline lifts it');
  assert.equal(contrastOf(frame(255), entry('Hi', [0, 0, 40, 30], 20)), null, 'all glyph, nothing around it');
  assert.equal(contrastOf(frame(0, 0), text), null, 'its colour is nowhere in its box');
});

test('text: a record with no text skips the check, and a transparent render skips only the contrast', async () => {
  const empty = recordFor({ width: 360, height: 640, frames: 3, texts: () => [] });
  assert.deepEqual(await judgeText('unused.mp4', { path: 'out.mp4.text.json', record: empty }),
    { verdict: 'skipped', lines: [], skipped: ['the text: out.mp4.text.json records no text on screen'] });
  const alpha = recordFor({ width: 360, height: 640, frames: 3, transparent: true, texts: () => [entry('Hi', [10, 10, 40, 30], 30)] });
  const report = await judgeText('unused.mov', { path: 'out.mov.text.json', record: alpha });
  assert.equal(report.verdict, 'pass');
  assert.deepEqual(report.lines, ['all 1 text(s) at least 16px, over 1 sampled frames']);
  assert.deepEqual(report.skipped, ['the contrast: the video is transparent, so what will be behind its text is not in it']);
});

test('text: the floor is a share of the shorter side, so a 40px text is small on a 1920x1080 frame, and letters set apart are one text', async () => {
  // One element per letter, revealed a letter a sample, a word space between the words.
  const letters = [...'So small'].flatMap((c, i) => (c === ' ' ? [] : [entry(c, [100 + 22 * i, 900, 20, 46], 40, `#title>span:nth-child(${i + 1})`)]));
  const record = recordFor({ width: 1920, height: 1080, frames: 30, transparent: true, texts: (frame) => letters.filter((_, i) => frame >= 3 * i) });
  const report = await judgeText('unused.mov', { path: 'r.json', record });
  assert.equal(report.verdict, 'found');
  assert.deepEqual(report.lines, [
    '1 text(s) under 49px, 4.5% of the frame\'s 1080px shorter side, smaller than a phone\'s body text:',
    '"So small" is 40px from 0.00s to 1.00s',
  ]);
});

test('text: an icon, an arrow, a lone symbol and SVG text are not held to the size floor; a word beside them is', async () => {
  const marks = [entry('→', [10, 10, 20, 20], 20, '#arrow'), entry('$', [40, 10, 20, 30], 30, '#dollar'), { ...entry('cc', [80, 10, 30, 30], 32, '#badge>text:nth-child(1)'), svg: true as const }];
  const record = recordFor({ width: 1080, height: 1920, frames: 3, transparent: true, texts: () => [...marks, entry('Fine print', [10, 100, 200, 30], 30, '#small')] });
  const report = await judgeText('unused.mov', { path: 'r.json', record });
  assert.deepEqual(report.lines, ['1 text(s) under 49px, 4.5% of the frame\'s 1080px shorter side, smaller than a phone\'s body text:', '"Fine print" is 30px from 0.00s to 0.10s']);
  const alone = await judgeText('unused.mov', { path: 'r.json', record: recordFor({ width: 1080, height: 1920, frames: 3, transparent: true, texts: () => marks }) });
  assert.equal(alone.verdict, 'pass');
  assert.deepEqual(alone.lines, ['no text held to the size floor, only icons, symbols and SVG text, over 1 sampled frames']);
});

// ---- captions, on records built here -------------------------------------------------------------------------

type Box = [number, number, number, number];
interface Showing { text: string; from: number; to: number; box?: Box; size?: number; selector?: string }

/** A 1080x1920 record sampled every third frame, showing each text over [from, to). */
function recordOf(seconds: number, showing: Showing[] | ((t: number) => Showing[]), fps = '30'): { path: string; record: TextRecord } {
  const [num, den = 1] = fps.split('/').map(Number);
  const record = recordFor({
    width: 1080, height: 1920, fps, frames: Math.round((seconds * num) / den), texts: (frame) => {
      const t = (frame * den) / num;
      const list = typeof showing === 'function' ? showing(t) : showing;
      return list.filter((s) => t >= s.from - 1e-9 && t < s.to - 1e-9).map((s, i) => entry(s.text, s.box ?? [100, 1500, 880, 80], s.size ?? 64, s.selector ?? `#c${i}`));
    },
  });
  return { path: 'out.mp4.text.json', record };
}

/** A transcript of phrases, each spoken over [from, to) with its words evenly spread. */
function spoken(phrases: [string, number, number][]): { path: string; transcript: Transcript } {
  const chunks = phrases.map(([text, from, to]) => {
    const words = text.split(' ');
    const each = (to - from) / words.length;
    return { text, timestamp: [from, to] as [number, number], words: words.map((w, i) => ({ text: ` ${w}`, timestamp: [from + i * each, from + (i + 1) * each] as [number, number] })) };
  });
  return { path: 'transcript.json', transcript: { text: phrases.map((p) => p[0]).join(' '), chunks } };
}

const PHRASES: [string, number, number][] = [
  ['today we look at the new studio', 0, 2],
  ['it has three rooms and a garden', 2.2, 4.2],
  ['the kitchen is the best part', 4.4, 6.4],
  ['come and see it for yourself', 6.6, 8.6],
];
const SPEECH = spoken(PHRASES);
const FRENCH = ['aujourd\'hui nous visitons le nouveau studio', 'il a trois pièces et un jardin', 'la cuisine est la meilleure partie', 'venez le voir vous-même'];
/** Each phrase's French caption, up from just before it is spoken until the next one comes up. */
const french = (texts = FRENCH): Showing[] => PHRASES.map(([, from, to], i) => ({ text: texts[i], from: from - 0.1, to: i < 3 ? PHRASES[i + 1][1] - 0.1 : to + 0.1 }));

test('captions: a phrase spoken with no caption on screen is reported with its words, the captioned ones are not', () => {
  const captions = PHRASES.filter((_, i) => i !== 2).map(([text, from, to]) => ({ text, from: from - 0.1, to: to + 0.1 }));
  const report = judgeCaptions(recordOf(9, captions), SPEECH);
  assert.equal(report.verdict, 'found');
  assert.deepEqual(report.lines, [
    '1 stretch(es) of speech with no caption on screen, 2.00s in all, in a video whose other speech is captioned (3 showing the words spoken, 0 changing in step with them):',
    'from 4.40s to 6.40s, while "the kitchen is the best part" is said',
    'the words: transcript.json',
  ]);
});

test('captions: captions in another language than the voice count when they change in step with its phrases, at any frame rate', () => {
  for (const fps of ['30', '30000/1001', '24', '25']) {
    const report = judgeCaptions(recordOf(9, french(), fps), SPEECH);
    assert.equal(report.verdict, 'pass', `${fps}: ${report.lines.join('\n')}${report.skipped.join('\n')}`);
    assert.equal(report.lines[0], 'every stretch of speech has a caption on screen: 4 caption text(s), 0 showing the words spoken, 4 changing in step with them', fps);
  }
  // Sliding into place a little at every sample, or crossfading one into the next, they are still one track.
  const sliding = recordOf(9, (t) => french().map((s) => ({ ...s, box: [100 + 40 * ((t * 10) % 4), 1500, 880, 80] as Box })));
  assert.equal(judgeCaptions(sliding, SPEECH).verdict, 'pass');
  const crossfading = french().map((s, i) => ({ ...s, to: i < 3 ? s.to + 0.3 : s.to }));
  assert.equal(judgeCaptions(recordOf(9, crossfading), SPEECH).verdict, 'pass');
});

test('captions: a phrase of another-language captions that happens to match the voice does not break their run', () => {
  const names: [string, number, number][] = [...PHRASES, ['netflix spotify youtube', 8.8, 10.2]];
  const texts = ['aujourd\'hui nous visitons le nouveau studio', 'il a trois pièces et un jardin', 'netflix spotify youtube', 'la cuisine est la meilleure partie', 'venez le voir vous-même'];
  const order: [string, number, number][] = [names[0], names[1], names[4], names[2], names[3]].map(([w], i) => [w, i * 2.2, i * 2.2 + 2]);
  const showing = order.map(([, from, to], i) => ({ text: texts[i], from: from - 0.1, to: i < 4 ? order[i + 1][1] - 0.1 : to + 0.1 }));
  const report = judgeCaptions(recordOf(11.2, showing), spoken(order));
  assert.equal(report.verdict, 'pass', report.lines.join('\n') + report.skipped.join('\n'));
  assert.match(report.lines[0], /5 caption text\(s\), 1 showing the words spoken, 4 changing in step with them/);
});

test('captions: a title or a card up through the speech is not a caption, nor is a hook card echoing one line', () => {
  const title = recordOf(9, [{ text: 'THE NEW STUDIO', from: 0, to: 9, box: [80, 200, 920, 140], size: 120 }]);
  const report = judgeCaptions(title, SPEECH);
  assert.equal(report.verdict, 'skipped');
  assert.deepEqual(report.skipped, ['the captions: no text the page draws shows the words spoken while it is up or changes in step with them, so there are none to check (out.mp4.text.json)']);
  // A card swapped once for another is not a run of captions either.
  const cards = recordOf(9, [{ text: 'Part one', from: 0, to: 4.3 }, { text: 'Part two', from: 4.3, to: 9 }]);
  assert.equal(judgeCaptions(cards, SPEECH).verdict, 'skipped');
  // The opening line on a card while it is said is a caption for that line, too little to call the video captioned.
  const hook = recordOf(9, [{ text: 'today we look at the new studio', from: 0, to: 2.1, box: [80, 200, 920, 140], size: 120 }]);
  assert.deepEqual(judgeCaptions(hook, SPEECH).skipped, ['the captions: captions are up for 27% of the spoken words, too few for the page to be captioning the speech, so there are none to check (out.mp4.text.json)']);
});

test('captions: with a title up, a phrase with no caption under it is still reported', () => {
  const showing: Showing[] = [
    { text: 'THE NEW STUDIO', from: 0, to: 9, box: [80, 200, 920, 140], size: 120, selector: '#title' },
    ...PHRASES.filter((_, i) => i !== 1).map(([text, from, to]) => ({ text, from, to: to + 0.2, selector: '#cap' })),
  ];
  const report = judgeCaptions(recordOf(9, showing), SPEECH);
  assert.equal(report.verdict, 'found');
  assert.equal(report.lines[1], 'from 2.20s to 4.20s, while "it has three rooms and a garden" is said');
});

test('captions: a caption laid out one element per word or per letter reads as its phrase, and one that builds up word by word counts', () => {
  // Each word its own element on one line, as a row of word spans with the spoken one lit.
  const perWord: Showing[] = PHRASES.flatMap(([text, from, to]) => {
    let x = 60;
    return text.split(' ').map((word, i) => {
      const box: Box = [x, 1500, word.length * 36, 80];
      x += word.length * 36 + 18;
      return { text: word, from, to: to + 0.2, box, selector: `#w${i}` };
    });
  });
  assert.deepEqual(blocksOf(recordOf(1, perWord).record.samples[0].texts).map((b) => b.text), ['today we look at the new studio']);
  assert.equal(judgeCaptions(recordOf(9, perWord), SPEECH).verdict, 'pass');
  // Each letter its own element, words a space apart.
  const perLetter: Showing[] = PHRASES.flatMap(([text, from, to]) => {
    let x = 60;
    return [...text].flatMap((c, i) => {
      const at = x;
      x += c === ' ' ? 18 : 36;
      return c === ' ' ? [] : [{ text: c, from, to: to + 0.2, box: [at, 1500, 36, 80] as Box, selector: `#l${i}` }];
    });
  });
  assert.deepEqual(blocksOf(recordOf(1, perLetter).record.samples[0].texts).map((b) => b.text), ['today we look at the new studio']);
  assert.equal(judgeCaptions(recordOf(9, perLetter), SPEECH).verdict, 'pass');

  const building: Showing[] = SPEECH.transcript.chunks.flatMap((chunk) => chunk.words.map((w, i) => ({
    text: chunk.words.slice(0, i + 1).map((v) => v.text.trim()).join(' '), from: w.timestamp[0], to: i + 1 < chunk.words.length ? chunk.words[i + 1].timestamp[0] : chunk.timestamp[1] + 0.2,
  })));
  const built = judgeCaptions(recordOf(9, building), SPEECH);
  assert.equal(built.verdict, 'pass', built.lines.join('\n'));
});

test('captions: a caption a beat late, words split by a silence, and words after the video ends are not reported', () => {
  const late = PHRASES.map(([text, from, to]) => ({ text, from: from + MIN_UNCAPTIONED * 0.8, to: to + 0.4 }));
  assert.equal(judgeCaptions(recordOf(9.5, late), SPEECH).verdict, 'pass');
  // Two uncaptioned words of 0.6 s, 1.2 s apart: each too short to report, and not one stretch.
  const gappy = spoken([...PHRASES, ['first', 9, 9.6], ['second', 10.8, 11.4], ['and the last line here', 11.6, 13]]);
  const captions = [...PHRASES, ['and the last line here', 11.6, 13] as [string, number, number]].map(([text, from, to]) => ({ text, from: from - 0.1, to: to + 0.1 }));
  assert.equal(judgeCaptions(recordOf(13.2, captions), gappy).verdict, 'pass');
  // Speech the transcript holds past the end of the video is not the video's.
  const longer = spoken([...PHRASES, ['this was cut from the video', 9.5, 11]]);
  assert.equal(judgeCaptions(recordOf(9, PHRASES.map(([text, from, to]) => ({ text, from, to: to + 0.2 }))), longer).verdict, 'pass');
});

test('captions: skipped without a transcript or without a record, saying which is missing', () => {
  const check = CHECKS.find((c) => c.name === 'captions')!;
  const input = recordOf(9, []);
  const base = { video: 'out.mp4', duration: 9, askedLength: { missing: 'none' }, brief: { missing: 'none' } };
  assert.deepEqual(check.run({ ...base, transcript: { missing: 'no transcript here' }, textRecord: input }),
    { verdict: 'skipped', lines: [], skipped: ['the speech: no transcript here'] });
  assert.deepEqual(check.run({ ...base, transcript: SPEECH, textRecord: { missing: 'no record here' } }),
    { verdict: 'skipped', lines: [], skipped: ['the text: no record here'] });
  const silent = judgeCaptions(input, { path: 'transcript.json', transcript: { text: '', chunks: [] } });
  assert.deepEqual(silent.skipped, ['the speech: transcript.json holds no words within the video']);
});

// ---- end to end ------------------------------------------------------------------------------------------------

test('review: on a render with French captions under English speech, only the phrase left uncaptioned is reported', { skip }, async () => {
  const dir = scratchDir('captions-review');
  // Eight phrases two seconds apart; the fifth has no caption.
  const english = ['we start in the morning', 'the light comes in early', 'coffee is the first thing', 'then we open the doors',
    'people arrive around nine', 'the work begins slowly', 'by noon it is busy', 'and that is our day'];
  const frenchCues = ['on commence le matin', 'la lumière entre tôt', 'le café d\'abord', 'puis on ouvre les portes',
    '', 'le travail commence doucement', 'à midi c\'est animé', 'et voilà notre journée'];
  const cues = frenchCues.map((text, i) => `[${2 * i},${2 * i + 2},${JSON.stringify(text)}]`).join(',');
  const page = join(dir, 'index.html');
  writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#000}
#stage{position:relative;width:320px;height:180px;overflow:hidden;background:#123;font:700 16px Helvetica,Arial,sans-serif;color:#fff}
#cap{position:absolute;left:0;right:0;bottom:16px;text-align:center}
</style></head><body><div id="stage" data-stateless><div id="cap"></div></div>
<script>const cues=[${cues}];window.__seek=(t)=>{const c=cues.find(([a,b])=>t>=a&&t<b);document.getElementById('cap').textContent=c?c[2]:''}</script></body></html>`);
  const out = join(dir, 'out.mp4');
  render([page, '--out', out, '--fps', '10', '--duration', '16']);
  writeFileSync(join(dir, 'transcript.json'), JSON.stringify(spoken(english.map((text, i) => [text, 2 * i + 0.2, 2 * i + 1.8])).transcript));
  const { result, out: printed } = await captureConsoleAsync(() => review([out]));
  assert.equal(result, 0);
  assert.match(printed, /^text +pass +all 7 text\(s\) at least 8px, and the 7 measured at least 3:1 against what is behind them, over 160 sampled frames$/m);
  assert.match(printed, /^captions +FOUND +1 stretch\(es\) of speech with no caption on screen, 1\.60s in all, in a video whose other speech is captioned \(0 showing the words spoken, 7 changing in step with them\):$/m);
  assert.match(printed, /^ +from 8\.20s to 9\.80s, while "people arrive around nine" is said$/m);
});

const why = 'openedit render writes one beside each video and mux-audio carries it along, so this video was made another way, or before render wrote one, or render could not read its page\'s text';

test('review: a video with no record of its text skips both checks with the reason', async () => {
  const dir = scratchDir('text-review-none');
  const video = synthClip(dir, 'clip.mp4', { video: TESTSRC, seconds: 1 });
  const { out } = await captureConsoleAsync(() => review([video]));
  assert.match(out, new RegExp(`^text +skipped +skipped: the text: no record of on-screen text at .*clip\\.mp4\\.text\\.json: ${why}$`, 'm'));
  assert.match(out, new RegExp(`^captions +skipped +skipped: the text: no record of on-screen text at .*clip\\.mp4\\.text\\.json: ${why}$`, 'm'));
});

test('review: a record of another picture, older than the video or unreadable is set aside, and the other checks still run', async () => {
  const dir = scratchDir('text-review-other');
  const video = synthClip(dir, 'clip.mp4', { video: TESTSRC, seconds: 1 });
  const cases: [TextRecord | string, RegExp][] = [
    [recordFor({ width: 1080, height: 1920, frames: 270, texts: () => [] }), /clip\.mp4\.text\.json is for a 1080x1920 picture of 9\.00s and this one is 320x240 of 1\.00s, so it describes another render$/m],
    [recordFor({ width: 320, height: 240, fps: '25', frames: 50, texts: () => [] }), /clip\.mp4\.text\.json is for a 320x240 picture of 2\.00s and this one is 320x240 of 1\.00s, so it describes another render$/m],
    [{ ...recordFor({ width: 320, height: 240, fps: '25', frames: 25, texts: () => [] }), fps: '29.97' }, /clip\.mp4\.text\.json is not a text record \(its fps "29\.97" is not a frame rate\); render the video again to write one$/m],
    ['{"version": 1, "samples": [', /clip\.mp4\.text\.json: .*JSON/m],
  ];
  for (const [record, reason] of cases) {
    writeFileSync(recordPath(video), typeof record === 'string' ? record : JSON.stringify(record));
    utimesSync(recordPath(video), new Date(), new Date(Date.now() + 1000));
    const { result, out } = await captureConsoleAsync(() => review([video]));
    assert.equal(result, 0);
    assert.match(out, new RegExp(`^text +skipped +skipped: the text: .*${reason.source}`, 'm'));
    assert.match(out, /^dead-tail /m, 'the other checks still run');
  }
  // A record of the right picture, older than the video, was left by a picture written there before.
  writeFileSync(recordPath(video), JSON.stringify(recordFor({ width: 320, height: 240, fps: '25', frames: 25, texts: () => [] })));
  utimesSync(recordPath(video), new Date(), new Date(Date.now() - 60_000));
  const { out } = await captureConsoleAsync(() => review([video]));
  assert.match(out, /^text +skipped +skipped: the text: .*clip\.mp4\.text\.json is older than the video, so it describes a picture written there before$/m);
});
