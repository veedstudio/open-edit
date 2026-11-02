import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bandHeight, clearRuns, labelBand, labelScale, MAX_SHEETS, pack, pickFrames, planStoryboard, seeRuns, SHEET_PATCHES, SHEET_SIDE,
  sheetPixels, startStoryboard, sweepStoryboards, tileSize, type ShotSpan, type StoryboardPlan,
} from '../src/storyboard.ts';

const FPS = 25;

/** `count` shots of `sec` each, back to back from 0, and every frame's time at FPS. */
const evenShots = (count: number, sec: number): { shots: ShotSpan[]; pts: number[] } => ({
  shots: Array.from({ length: count }, (_, i) => ({ shot: i + 1, start: i * sec, end: (i + 1) * sec, duration: sec })),
  pts: Array.from({ length: Math.round(count * sec * FPS) }, (_, k) => k / FPS),
});
const plan = (count: number, sec: number, width: number, height: number): StoryboardPlan => {
  const { shots, pts } = evenShots(count, sec);
  const p = planStoryboard(shots, pts, { fps: FPS, source: { width, height } });
  if ('why' in p) assert.fail(p.why);
  return p;
};

/** Every sheet inside the limits, and every shot's frames in order, each shot's on one row of one sheet. */
function assertSheets(p: StoryboardPlan, shots: number): void {
  assert.ok(p.cells.length >= 1 && p.cells.length <= MAX_SHEETS, `${p.cells.length} sheets`);
  for (const cells of p.cells) {
    const { width, height } = sheetPixels(p, cells.length);
    assert.ok(width <= SHEET_SIDE && height <= SHEET_SIDE, `${width}x${height}`);
    assert.ok(Math.ceil(width / 28) * Math.ceil(height / 28) <= SHEET_PATCHES, `${width}x${height}`);
  }
  const placed = p.cells.flatMap((cells, n) => cells.flatMap((index, i) => (index === null ? [] : [{ index, sheet: n, row: Math.floor(i / p.cols) }])));
  assert.deepEqual(placed.map((c) => c.index), p.tiles.map((_, i) => i));
  assert.deepEqual([...new Set(p.tiles.map((t) => t.shot))], Array.from({ length: shots }, (_, i) => i + 1));
  for (let i = 1; i < p.tiles.length; i++) {
    if (p.tiles[i].shot !== p.tiles[i - 1].shot) continue;
    assert.deepEqual([placed[i].sheet, placed[i].row], [placed[i - 1].sheet, placed[i - 1].row], `shot ${p.tiles[i].shot} split`);
  }
}

test('storyboard: a shot of a second or more shows its first, middle and last decoded frame, a shorter one its middle', () => {
  const shots: ShotSpan[] = [
    { shot: 1, start: 0, end: 2, duration: 2 },
    { shot: 2, start: 2, end: 2.8, duration: 0.8 },
    { shot: 3, start: 2.8, end: 4, duration: 1.2 },
  ];
  const pts = Array.from({ length: 100 }, (_, k) => k / FPS);
  assert.deepEqual(pickFrames(shots, pts, FPS, true).map((t) => [t.shot, t.at, t.frame, t.sec, t.label]), [
    [1, 'start', 0, 0, '#1 0.000s'], [1, 'middle', 25, 1, '#1 1.000s'], [1, 'end', 49, 1.96, '#1 1.960s'],
    [2, 'middle', 60, 2.4, '#2 2.400s'],
    [3, 'start', 70, 2.8, '#3 2.800s'], [3, 'middle', 85, 3.4, '#3 3.400s'], [3, 'end', 99, 3.96, '#3 3.960s'],
  ]);
  // The last shot ends at the last frame decoded, whatever length the file declares.
  assert.equal(pickFrames(shots, pts.slice(0, 91), FPS, true).at(-1)!.frame, 90);
  assert.deepEqual(pickFrames(shots, pts, FPS, false).map((t) => [t.shot, t.at, t.frame]), [[1, 'middle', 25], [2, 'middle', 60], [3, 'middle', 85]]);
});

test('storyboard: on a variable-rate video a shot\'s last tile is its own last frame, not the grid frame before the next shot', () => {
  // One second at 30 fps, then 10 fps: the second shot's last frame is at 1.9 s, two grid frames before the cut at 2 s.
  const pts = [...Array.from({ length: 30 }, (_, k) => k / 30), ...Array.from({ length: 20 }, (_, k) => 1 + k / 10)];
  const shots: ShotSpan[] = [{ shot: 1, start: 0, end: 1, duration: 1 }, { shot: 2, start: 1, end: 2, duration: 1 }, { shot: 3, start: 2, end: 3, duration: 1 }];
  assert.deepEqual(pickFrames(shots, pts, 30, true).filter((t) => t.shot === 2).map((t) => [t.at, t.sec, t.frame]),
    [['start', 1, 30], ['middle', 1.5, 45], ['end', 1.9, 57]]);
  // A cut at frame 41 of 30 fps is listed at 1.367 s, after the frame's own 1.366667: it still opens the second shot.
  const grid = Array.from({ length: 90 }, (_, k) => k / 30);
  const rounded: ShotSpan[] = [{ shot: 1, start: 0, end: 1.367, duration: 1.367 }, { shot: 2, start: 1.367, end: 3, duration: 1.633 }];
  assert.deepEqual(pickFrames(rounded, grid, 30, true).map((t) => [t.shot, t.at, t.frame]),
    [[1, 'start', 0], [1, 'middle', 20], [1, 'end', 40], [2, 'start', 41], [2, 'middle', 65], [2, 'end', 89]]);
  // A frame stamped between two grid points is the one the next index's seek lands on.
  const between = [0.95, 0.983333, 1.016667];
  assert.deepEqual(pickFrames([{ shot: 1, start: 0.95, end: 1.05, duration: 0.1 }], between, 30, true).map((t) => t.frame), [30]);
});

test('storyboard: a shot\'s frames stay on one row, and a full sheet starts the next', () => {
  // Four columns: a three-frame shot never takes the one cell left after another.
  assert.deepEqual(pack([3, 3, 1, 3], 4, 2), [[0, 1, 2, null, 3, 4, 5, 6], [7, 8, 9]]);
  assert.deepEqual(pack([1, 1, 1], 3, 1), [[0, 1, 2]]);
  assert.throws(() => pack([3], 2, 5), /a shot of 3 frames cannot sit on a row of 2/);
});

test('storyboard: tiles are about 480x270 of picture in the source\'s shape, never enlarged', () => {
  assert.deepEqual(tileSize({ width: 1920, height: 1080 }), { width: 480, height: 270 });
  assert.deepEqual(tileSize({ width: 1080, height: 1920 }), { width: 270, height: 480 });
  assert.deepEqual(tileSize({ width: 1080, height: 1080 }), { width: 360, height: 360 });
  assert.deepEqual(tileSize({ width: 320, height: 180 }), { width: 320, height: 180 });
});

test('storyboard: up to 6 shots of three frames a 16:9 or 9:16 sheet, then one frame a shot, then smaller tiles, never past four sheets', () => {
  for (const [width, height, most] of [[1920, 1080, 96], [1080, 1920, 84]]) {
    const three = plan(24, 1.5, width, height);
    assert.deepEqual([three.cells.length, three.tiles.length, three.note], [4, 72, null]);
    assertSheets(three, 24);

    const one = plan(25, 1.5, width, height);
    assert.ok(one.tiles.every((t) => t.at === 'middle'));
    assert.deepEqual(one.tile, tileSize({ width, height }));
    assert.equal(one.note, 'every shot shows its middle frame alone, since three frames a shot would need 5 sheets, more than 4');
    assertSheets(one, 25);

    // The figures the usage gives: one frame a shot at full size up to 96 shots at 16:9 and 84 at 9:16.
    assert.deepEqual(plan(most, 1.5, width, height).tile, tileSize({ width, height }));
    const shrunk = plan(most + 1, 1.5, width, height);
    assert.ok(shrunk.tile.width < tileSize({ width, height }).width);
    assert.match(shrunk.note!, new RegExp(`; tiles are ${shrunk.tile.width}x${shrunk.tile.height} rather than .* so that all ${most + 1} shots fit 4 sheets`));

    assertSheets(plan(500, 1.5, width, height), 500);
  }
  // Too wide for three tiles side by side, at any count.
  assert.equal(plan(2, 1.5, 2400, 600).note, 'every shot shows its middle frame alone, since three tiles of this shape side by side are wider than a sheet\'s 2000 px');
  // Ten half-second shots, then ten of a second: the short ones show one frame each, the rest three, and no note.
  const short = evenShots(10, 0.5).shots;
  const long = evenShots(15, 1);
  const mixed = planStoryboard([...short, ...long.shots.slice(5).map((s) => ({ ...s, shot: s.shot + 5 }))], long.pts, { fps: FPS, source: { width: 1920, height: 1080 } });
  if ('why' in mixed) assert.fail(mixed.why);
  assert.deepEqual([mixed.tiles.length, mixed.note], [10 + 30, null]);
});

test('storyboard: no storyboard for no shots, a picture too narrow for its labels, or too many shots, each saying which', () => {
  const why = (count: number, width: number, height: number) => {
    const { shots, pts } = evenShots(count, 1);
    const p = planStoryboard(shots, pts, { fps: FPS, source: { width, height } });
    return 'why' in p ? p.why : 'drawn';
  };
  assert.equal(why(0, 1920, 1080), 'there are no shots to show');
  assert.equal(why(1, 40, 800), 'a tile of this picture\'s shape is 40 px wide, narrower than the 57 px its labels need');
  assert.match(why(5000, 1920, 1080), /^5000 shots do not fit 4 sheets at any tile wide enough for its label$/);
});

test('storyboard: a label is white 5x7 glyphs on black, at the scale that fits its tile', () => {
  assert.equal(labelScale(320, 9), 2);
  assert.equal(labelScale(80, 9), 1);
  assert.equal(labelScale(40, 9), 0);
  const width = 40;
  const band = labelBand('#1', width, 2);
  assert.equal(band.length, width * bandHeight(2) * 3);
  const lit = (x: number, y: number) => band[(y * width + x) * 3] === 255;
  // '#' starts two glyph pixels in and two down: its top row is 01010, so the second glyph column is lit.
  assert.deepEqual([lit(4, 4), lit(6, 4), lit(7, 5), lit(8, 4)], [false, true, true, false]);
  // '1' is the next glyph, six glyph pixels on: its top row is 00100.
  assert.deepEqual([lit(16, 4), lit(20, 4), lit(21, 5), lit(22, 4)], [false, true, true, false]);
  // The two glyph rows of margin above and below stay black.
  assert.ok([0, 1, 2, 3, 18, 19, 20, 21].every((y) => Array.from({ length: width }, (_, x) => x).every((x) => !lit(x, y))));
  assert.throws(() => labelBand('#1 x', width, 1), /"x", which has no glyph/);
});

/** A folder with one storyboard run's files in it, `age` ms old, named as runs name them. */
function runFiles(dir: string, name: string, o: { marker?: boolean; age?: number } = {}): string[] {
  const files = [join(dir, `storyboard-${name}-1.jpg`), ...(o.marker ? [join(dir, `storyboard-${name}.pid`)] : [])];
  for (const file of files) {
    writeFileSync(file, file.endsWith('.pid') ? `${process.pid}\n` : 'jpg');
    if (o.age) utimesSync(file, new Date(Date.now() - o.age), new Date(Date.now() - o.age));
  }
  return files;
}
const listNaming = (dir: string, sheet: string) => {
  writeFileSync(join(dir, 'shots.json'), JSON.stringify({ storyboard: { sheets: [sheet] } }));
  return join(dir, 'shots.json');
};
const left = (paths: string[]) => paths.filter((p) => existsSync(p));
const HOUR = 3_600_000;

test('storyboard: a sweep keeps the run the list names, runs still drawing, and recent ones, and only files named as runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'storyboard-sweep-'));
  const run = startStoryboard(dir);
  const mine = runFiles(dir, run.attempt);
  const named = runFiles(dir, '000000000aaaaaa', { age: HOUR });
  const drawing = runFiles(dir, '000000000bbbbbb', { marker: true });
  // A run beside this one, whose list this one replaced: its printed sheets stay until the grace runs out.
  const recent = runFiles(dir, '000000000cccccc');
  const old = runFiles(dir, '000000000dddddd', { age: HOUR });
  // A marker past its lease is a run that died, even when its pid now names a live process.
  const died = runFiles(dir, '000000000eeeeee', { marker: true, age: HOUR });
  const strangers = ['storyboard-final-1.jpg', 'storyboard-v2.pid', 'notes.jpg'].map((name) => {
    writeFileSync(join(dir, name), '');
    utimesSync(join(dir, name), new Date(0), new Date(0));
    return join(dir, name);
  });
  sweepStoryboards(run, listNaming(dir, named[0]));
  assert.deepEqual(left([...mine, ...named, ...drawing, ...recent, ...old, ...died, ...strangers]),
    [...mine, ...named, ...drawing, ...recent, ...strangers]);
  assert.equal(existsSync(join(dir, `storyboard-${run.attempt}.pid`)), false);
  // A folder gone by the time of the sweep fails nothing: the list is already written.
  rmSync(dir, { recursive: true });
  assert.doesNotThrow(() => sweepStoryboards(run, join(dir, 'shots.json')));
});

test('storyboard: a run that finishes between another\'s look at the folder and its read of the list is never swept', () => {
  // A has written its list and looks at the folder while B is still drawing. With no grace and a list naming A,
  // B stays only because its marker is live.
  const dir = mkdtempSync(join(tmpdir(), 'storyboard-race-'));
  const a = startStoryboard(dir);
  const sheetA = runFiles(dir, a.attempt)[0];
  const b = startStoryboard(dir);
  const sheetB = runFiles(dir, b.attempt)[0];
  const list = listNaming(dir, sheetA);
  const seen = seeRuns(dir);
  clearRuns(seen, a.attempt, list, 0);
  assert.deepEqual(left([sheetA, sheetB]), [sheetA, sheetB]);
  // B then writes its list, naming B, and clears its marker before A reads the list: B stays.
  listNaming(dir, sheetB);
  sweepStoryboards(b, list);
  clearRuns(seen, a.attempt, list, 0);
  assert.deepEqual(left([sheetA, sheetB]), [sheetA, sheetB]);
  // Once A has finished too and the list names B, A's sheets go when no grace is left.
  sweepStoryboards(a, list);
  clearRuns(seeRuns(dir), b.attempt, list, 0);
  assert.deepEqual(left([sheetA, sheetB]), [sheetB]);
});

test('storyboard: a fresh marker whose process has exited is a run that died, and is swept with no grace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'storyboard-dead-'));
  const run = startStoryboard(dir);
  const [sheet, marker] = runFiles(dir, '000000000ffffff', { marker: true });
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  writeFileSync(marker, `${pid}\n`);
  sweepStoryboards(run, listNaming(dir, runFiles(dir, run.attempt)[0]), 0);
  assert.deepEqual(left([sheet, marker]), []);
});
