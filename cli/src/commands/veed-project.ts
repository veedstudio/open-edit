// VEED PROJECT — hand a finished edit to a person as an editable project in VEED's editor.
//
//   openedit veed-project <plan.json> [--workspace <id>] [--work <dir>] [--no-open] [--local]
//   openedit veed-project --install-bookmark
//
// Footage cuts, text, images and audio become the editor's own items, and each page layer is rendered on its own,
// cut to its box and uploaded as a transparent clip. The CLI's login can create a project and upload into it but not
// write its timeline, so the last step runs in the user's own session: a bookmarklet reads the hand-off this puts on
// the clipboard.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseUsage, usageLine, type Usage } from '../args.ts';
import { FFMPEG, stateDir } from '../config.ts';
import { loadEdl, snapRanges, sourceOrder, sourcePath } from '../edl.ts';
import { readJsonFile } from '../json-file.ts';
import { openUrl } from '../open-url.ts';
import { audioDurationOf, probeDisplaySize, probeFps, videoDurationOf } from '../probe.ts';
import { errorText } from '../proxy.ts';
import { contentTypeOf } from '../providers/fal-storage.ts';
import { resolveChrome } from '../render/browser.ts';
import { inspectPng } from '../render/png.ts';
import { startPageServer } from '../render/server.ts';
import { RenderSession } from '../render/session.ts';
import { splitContiguous, workersFor } from '../render/timing.ts';
import { readSpec } from './mix-audio.ts';
import { BUDGET_MS, EPOCH, SEED, pageRoots } from './render.ts';
import { VEED_ORIGIN } from '../veed/api.ts';
import { uploadLocalAsset } from '../veed/asset-upload.ts';
import {
  BOOKMARKLET, PULL_BOOKMARKLET, PlanError, audioItem, printable, bookmarkletUrl, captionItems, checkPlan, edlParts, encodeBundle, imageItem, mixParts, movedBox,
  previewSafeSize, textItem, videoItem, visibleSpans,
  type Box, type Bundle, type HandoffRecord, type LayerPart, type Origin, type Part, type Plan, type SourceAsset, type VeedItem,
  BUNDLE_VERSION,
} from '../veed/editor-project.ts';
import { createProject, getDefaultSpace } from '../veed/fabric-routes.ts';
import { refreshingHttp } from '../veed/http.ts';
import { NO_LOGIN_HELP, resolveVeedToken } from '../veed/resolve-token.ts';
import { pickProjectWorkspace } from '../veed/workspace.ts';
import { DEFAULT_WORKSPACE_PATH, rememberedWorkspace } from '../veed/workspace-store.ts';
import type { Transcript } from '../transcript/transcript-types.ts';

export const usage = {
  summary: 'Hand a finished edit to VEED as an editable project: native cuts, text, captions, images and audio, and each page layer as its own clip',
  positionals: '[plan.json]',
  flags: {
    workspace: { type: 'string', value: '<id>', help: 'The VEED workspace to make the project in (default: the remembered one, else the first; the one used is printed)' },
    work: { type: 'string', value: '<dir>', help: 'Where rendered layers are kept (default: veed/ beside the plan)' },
    'no-open': { type: 'boolean', help: 'Do not open VEED at the end (its address is printed either way)' },
    local: { type: 'boolean', help: 'Render and cut the layers only, uploading nothing: to check the layers against the page first' },
    'install-bookmark': { type: 'boolean', help: 'Write the page holding both bookmarks, "OpenEdit to VEED" and "Send to Claude", and open it' },
  },
  notes: [
    'Plan: {name, width, height, fps?, duration?, page?, parts: [...]}. Positions are canvas pixels: a box is {x, y, w, h}',
    'from its top-left, a text\'s x and y are its centre. at/to are seconds on the project timeline, in/out seconds of the',
    'file, and paths are relative to the plan\'s folder. video, image, audio, text and layer parts also take name? and',
    'z? (higher draws on top); edl and captions take z?. Parts:',
    '  video {file, at, in?, out?, volume?, box?}   image {file, at, to, box}',
    '  audio {file, at, in?, out?, volume?, fadeIn?, fadeOut?}',
    '  text {text, at, to, x, y, size, font?, color?, align?, bold?, italic?, animation?} (animation: one of the editor\'s)',
    '  edl {file, at?, volume?}: an apply-edl EDL, each range its own clip, cut where apply-edl cuts',
    '  mix {file}: a mix-audio spec, each track its own audio item at its own gain (ducking is not carried)',
    '  captions {transcript, x?, y?, size?, font?, color?, bold?, animation?, words?}: one editable text per cue, from a',
    '    transcript already on the project timeline (after a cut, what retime-transcript wrote)',
    '  layer {select, page?, at?, to?, shift?, moved?}: the page elements a CSS selector matches, drawn alone, one clip per',
    '    stretch they show in. Its at/to are PAGE time (default: the whole plan, which then needs duration); shift adds',
    '    seconds to place it on the timeline; moved {from: box, to: box} maps it as a person moved or resized it.',
    'A plan from veed-pull names its VEED project in "source": its files are copied inside VEED rather than uploaded,',
    'unless changed on disk since the pull.',
    'At the end, open VEED and click the "OpenEdit to VEED" bookmark there (the hand-off is on the clipboard on macOS;',
    'elsewhere copy the handoff.txt it names): it lays the timeline in the project in your',
    'own session and opens the editor.',
  ].join('\n'),
} satisfies Usage;

// What VEED's upload takes, by extension; each file's media type comes from the shared table.
const TAKES = new Set(['mp4', 'mov', 'webm', 'png', 'jpg', 'jpeg', 'webp', 'mp3', 'wav', 'm4a', 'aac', 'ogg']);
const KIND = { video: { kind: 'VIDEO', group: 'srcVideo' }, image: { kind: 'IMAGE', group: 'image' }, audio: { kind: 'AUDIO', group: 'audio' } } as const;
type Kind = (typeof KIND)[keyof typeof KIND];

export async function veedProject(argv: string[]): Promise<number> {
  const { values, positionals } = parseUsage('veed-project', usage, argv);
  if (values['install-bookmark']) return installBookmark();
  const planPath = positionals[0];
  if (!planPath) {
    console.error(`veed-project: give the plan\n${usageLine('veed-project', usage)}`);
    return 2;
  }
  const made: { url?: string } = {};
  try {
    await run(resolve(planPath), values, made);
    return 0;
  } catch (e) {
    console.error(`veed-project: ${errorText(e)}`);
    // A project made before the failure stays in the workspace; say which, so it is not found later as a mystery.
    if (made.url) console.error(`veed-project: the project it had made, left without a timeline, is ${made.url}`);
    return e instanceof PlanError ? 2 : 1;
  }
}

type Values = { workspace?: string; work?: string; 'no-open'?: boolean; local?: boolean };

async function run(planPath: string, values: Values, made: { url?: string }): Promise<void> {
  const plan = readJsonFile(planPath) as Plan;
  checkPlan(plan);
  const from = dirname(planPath);
  const at = (p: string) => resolve(from, p);
  // A mix spec's and an EDL's parts come from their own files; mix tracks resolve against the plan's folder, as
  // mix-audio's do against its run.
  const parts: Exclude<Part, { type: 'mix' | 'edl' }>[] = plan.parts.flatMap((p) => {
    if (p.type === 'mix') {
      const mixed = mixParts(readSpec(at(p.file)), (track) => audioDurationOf(at(track)));
      for (const note of mixed.notes) console.error(`veed-project: ${note}`);
      return mixed.parts;
    }
    if (p.type === 'edl') {
      const loaded = loadEdl(at(p.file));
      const ids = sourceOrder(loaded.edl.ranges);
      const ranges = snapRanges(loaded.edl.ranges, new Map(ids.map((id) => [id, probeFps(sourcePath(loaded, id))])));
      return edlParts(p, ranges, (id) => sourcePath(loaded, id));
    }
    return [p];
  });
  const { width: W, height: H } = plan;

  // Everything that can fail on the plan's own files fails here, before anything renders or is made in VEED.
  const files = new Map<string, Kind>();
  for (const p of parts) if (p.type === 'video' || p.type === 'image' || p.type === 'audio') files.set(at(p.file), KIND[p.type]);
  // Files already assets of the project the plan was read from are copied inside VEED, unless changed since the pull.
  const copied = new Map<string, SourceAsset>();
  for (const [file, a] of Object.entries(plan.source?.assets ?? {})) {
    const st = existsSync(at(file)) ? statSync(at(file)) : null;
    if (st && st.size === a.bytes && st.mtimeMs === a.mtimeMs && files.delete(at(file))) copied.set(at(file), a);
  }
  for (const [file] of files) {
    if (!existsSync(file)) throw new PlanError(`no file at ${file}`);
    if (!TAKES.has(extname(file).slice(1).toLowerCase())) throw new PlanError(`${basename(file)}: VEED takes ${[...TAKES].join(', ')}`);
  }
  const lengths = new Map<string, number>();
  for (const p of parts) {
    if (p.type === 'video' && p.out === undefined) lengths.set(at(p.file), videoDurationOf(at(p.file)));
    if (p.type === 'audio' && p.out === undefined) lengths.set(at(p.file), audioDurationOf(at(p.file)));
  }
  const transcripts = new Map<string, Transcript>();
  for (const p of parts) {
    if (p.type !== 'captions') continue;
    const t = readJsonFile(at(p.transcript)) as Transcript;
    if (!Array.isArray(t?.chunks)) throw new PlanError(`${p.transcript} is not a transcript: it has no "chunks"`);
    transcripts.set(at(p.transcript), t);
  }

  const work = resolve(values.work ?? join(from, 'veed'));
  mkdirSync(join(work, 'layers'), { recursive: true });
  // Layer frames next: a page that will not render fails the hand-off before anything is made in VEED.
  const byPage = new Map<string, LayerPart[]>();
  for (const p of parts) {
    if (p.type !== 'layer') continue;
    const page = at(p.page ?? plan.page!);
    byPage.set(page, [...(byPage.get(page) ?? []), p]);
  }
  const rendered: { parts: LayerPart[]; frames: Frames }[] = [];
  for (const [page, layerParts] of byPage) {
    // Named by the page's path as well, so two index.html pages in different folders keep apart.
    const dir = join(work, 'layers', `${basename(page, extname(page))}-${createHash('sha1').update(page).digest('hex').slice(0, 8)}`);
    rendered.push({ parts: layerParts, frames: await renderFrames(page, layerParts, dir, plan) });
  }
  const layers = new Map<LayerPart, Clip[]>();
  const stop: { reason?: unknown } = {};
  const cutAll = async (onClip: (c: Clip) => void) => {
    for (const { parts: layerParts, frames } of rendered) {
      const clips = await cutLayers(layerParts, frames, plan, onClip, stop);
      layerParts.forEach((p, k) => layers.set(p, clips[k]));
    }
  };

  if (values.local) {
    await cutAll(() => {});
    for (const [p, clips] of layers) console.log(`veed-project: ${printable(p.name ?? p.select)}: ${clips.map((c) => `${c.at.toFixed(2)}-${c.to.toFixed(2)} s`).join(', ') || 'nothing drawn'}`);
    console.log(`veed-project: layers are in ${join(work, 'layers')}; nothing was uploaded`);
    printTiming();
    return;
  }

  const token = await resolveVeedToken();
  if (!token) throw new Error(NO_LOGIN_HELP);
  const http = refreshingHttp(async () => {
    const fresh = await resolveVeedToken();
    if (!fresh) throw new Error('the VEED login expired during the run: run openedit login, then this again');
    return fresh;
  });
  const ws = await pickProjectWorkspace(http, values.workspace, rememberedWorkspace(DEFAULT_WORKSPACE_PATH, (m) => console.error(`veed-project: ${m}`)), 'OpenEdit project');
  console.error(`veed-project: workspace ${printable(ws.name)} (${ws.id}): ${ws.why}. A hand-off spends no VEED credits; the workspace only holds the project.`);
  const spaceId = await getDefaultSpace(http, ws.id);

  // The project itself holds the uploads: the editor plays only a project's own media, and a separate holding
  // project is one a person tidies away, taking every file with it.
  const project = await createProject(http, { name: plan.name, workspaceId: ws.id, spaceId, aspect: [W, H], fps: plan.fps ?? 30 });
  made.url = `${VEED_ORIGIN}/edit/${project}`;
  const assets = new Map<string, string>([...copied].map(([file, a]) => [file, a.asset]));

  // Uploads start as soon as a file exists, so the plain media and each cut clip go up while the rest is cut. A
  // failure is caught where it happens and stops the work still queued, rather than surfacing only at the end.
  const slot = limiter(4);
  const sending: Promise<void>[] = [];
  const send = (file: string, kind: Kind, upload = file) => {
    sending.push(slot(async () => {
      if (stop.reason) return;
      const ext = extname(upload).slice(1).toLowerCase();
      const bytes = await readFile(upload);
      // An upload that drops mid-way left only an empty asset behind and costs nothing, so it is sent again.
      for (let attempt = 1; ; attempt++) {
        try {
          const up = await uploadLocalAsset({ http }, { bytes, mimeType: contentTypeOf(upload), extension: ext, assetType: kind.kind, group: kind.group, workspaceId: ws.id, projectId: project });
          assets.set(file, up.assetId);
          return;
        } catch (e) {
          if (attempt === 3 || stop.reason) throw new Error(`${basename(upload)} did not upload: ${errorText(e)}`);
          process.stderr.write(`veed-project: ${basename(upload)} upload failed (${errorText(e)}); sending it again\n`);
        }
      }
    }).catch((e) => { stop.reason ??= e; }));
  };
  const plain = (async () => {
    for (const [file, kind] of files) {
      if (stop.reason) return;
      send(file, kind, kind.kind === 'VIDEO' ? await uploadCopy(file, work) : file);
    }
  })().catch((e) => { stop.reason ??= e; });
  try {
    await cutAll((c) => send(c.file, KIND.video));
  } catch (e) {
    stop.reason ??= e;
  }
  await plain;
  process.stderr.write(`veed-project: finishing ${sending.length} uploads\n`);
  await timed('uploads left after cutting', () => Promise.all(sending));
  if (stop.reason) throw stop.reason;

  const items: VeedItem[] = [];
  for (const p of parts) {
    if (p.type === 'video') {
      const f = at(p.file);
      items.push(videoItem({ assetId: assets.get(f)!, at: p.at, in: p.in ?? 0, out: p.out ?? lengths.get(f)!, volume: p.volume ?? 1, box: p.box, z: p.z, name: p.name ?? basename(f) }, W, H));
    } else if (p.type === 'layer') {
      for (const c of layers.get(p)!) {
        items.push(videoItem({ assetId: assets.get(c.file)!, at: c.at + (p.shift ?? 0), in: 0, out: c.to - c.at, volume: 0, box: movedBox(c.box, p.moved), z: p.z, name: p.name ?? p.select }, W, H));
      }
    } else if (p.type === 'image') {
      items.push(imageItem(p, assets.get(at(p.file))!, W, H));
    } else if (p.type === 'audio') {
      const f = at(p.file);
      items.push(audioItem(p, assets.get(f)!, p.out ?? lengths.get(f)!));
    } else if (p.type === 'text') {
      items.push(textItem(p, W, H));
    } else if (p.type === 'captions') {
      items.push(...captionItems(p, transcripts.get(at(p.transcript))!, W, H));
    } else {
      const never: never = p;
      throw new PlanError(`a part of type ${(never as Part).type} has no item`);
    }
  }

  writeHandoffRecord(project, planPath, plan, parts, assets, copied, layers, at);
  const bundle: Bundle = { v: BUNDLE_VERSION, project, items, ...(copied.size ? { copy: { from: plan.source!.project, assets: [...new Set([...copied.values()].map((a) => a.asset))] } } : {}) };
  writeFileSync(join(work, 'bundle.json'), JSON.stringify(bundle, null, 2));
  const handoff = `openedit=${encodeBundle(bundle)}`;
  writeFileSync(join(work, 'handoff.txt'), handoff);
  const onClipboard = process.platform === 'darwin' && spawnSync('pbcopy', { input: handoff }).status === 0;
  const home = `${VEED_ORIGIN}/workspaces/${ws.id}/home`;
  console.log(`veed-project: project "${printable(plan.name)}" is ${made.url}; its timeline goes in with the bookmark`);
  const counts = new Map<string, number>();
  for (const i of items) counts.set(String(i.category), (counts.get(String(i.category)) ?? 0) + 1);
  console.log(`veed-project: ${items.length} items (${[...counts].map(([k, v]) => `${v} ${k}`).join(', ')}), ${sending.length} files uploaded${copied.size ? `, ${copied.size} copied from the project it came from` : ''}`);
  console.log(`${onClipboard ? 'The hand-off is on the clipboard' : `Copy the contents of ${join(work, 'handoff.txt')} to the clipboard`}; open ${home}`);
  console.log('and click the "OpenEdit to VEED" bookmark there (once: openedit veed-project --install-bookmark).');
  printTiming();
  if (!values['no-open']) openUrl(home);
}

/**
 * Keeps, by project, what each of its files was made from, for veed-pull to say when the project comes back. A file
 * copied from another project is known by its storage path, which the copy keeps under a new id.
 */
function writeHandoffRecord(project: string, planPath: string, plan: Plan, parts: Part[], assets: Map<string, string>, copied: Map<string, SourceAsset>,
  layers: Map<LayerPart, Clip[]>, at: (p: string) => string): void {
  const byId: Record<string, Origin> = {};
  const byPath: Record<string, Origin> = {};
  for (const [file, id] of assets) if (!copied.has(file)) byId[id] = { file };
  for (const [p, clips] of layers) {
    for (const c of clips) byId[assets.get(c.file)!] = { layer: p.select, page: at(p.page ?? plan.page!), plan: planPath, at: c.at, to: c.to, box: c.box };
  }
  for (const [file, a] of copied) {
    if (!a.path) continue;
    const said = parts.find((p): p is Extract<Part, { type: 'video' | 'audio' | 'image' }> => (p.type === 'video' || p.type === 'audio' || p.type === 'image') && at(p.file) === file && !!p.origin)?.origin;
    byPath[a.path] = said && 'layer' in said ? { layer: said.layer, page: said.page, plan: said.plan, at: said.at, to: said.to, box: said.box } : said ?? { file };
  }
  const record: HandoffRecord = { plan: planPath, assets: byId, paths: byPath };
  mkdirSync(join(stateDir(), 'veed-handoffs'), { recursive: true });
  writeFileSync(join(stateDir(), 'veed-handoffs', `${project}.json`), JSON.stringify(record, null, 2));
}

/**
 * The file to upload for a video: footage above 1080p as a 1080p copy, since the editor proxies it anyway and a 4K
 * source can be gigabytes on a home connection. Its timeline is the source's, so every trim still holds. The copy is
 * named by the source's path, size and time, so another file of the same name never takes its place.
 */
async function uploadCopy(file: string, work: string): Promise<string> {
  if (extname(file).toLowerCase() === '.webm') return file;
  const { width, height } = probeDisplaySize(file);
  if (Math.max(width, height) <= 1920) return file;
  const st = statSync(file);
  const stamp = createHash('sha1').update(`${file}\0${st.size}\0${st.mtimeMs}`).digest('hex').slice(0, 10);
  const light = join(work, 'media', `${basename(file, extname(file))}-${stamp}.1080p.mp4`);
  if (!existsSync(light)) {
    mkdirSync(dirname(light), { recursive: true });
    process.stderr.write(`veed-project: making a 1080p copy of ${basename(file)} to upload\n`);
    await ffmpeg(['-v', 'error', '-y', '-i', file, '-vf', width >= height ? 'scale=1920:-2' : 'scale=-2:1920', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', `${light}.tmp.mp4`]);
    renameSync(`${light}.tmp.mp4`, light);
  }
  return light;
}

function printTiming(): void {
  const parts = Object.entries(timing).map(([k, v]) => `${k} ${v.toFixed(1)} s`);
  if (shots.taken + shots.skipped) parts.push(`${shots.taken} layer shots taken, ${shots.skipped} skipped as empty`);
  console.log(`veed-project: time: ${parts.join('; ')}`);
}

interface Clip { file: string; box: Box; at: number; to: number }

const pad5 = (n: number) => String(n).padStart(5, '0');

/** Seconds spent per stage, printed at the end so a slow hand-off says where its time went. */
const timing: Record<string, number> = {};
const timed = async <T,>(stage: string, work: () => Promise<T>): Promise<T> => {
  const t0 = performance.now();
  try {
    return await work();
  } finally {
    timing[stage] = (timing[stage] ?? 0) + (performance.now() - t0) / 1000;
  }
};
const shots = { taken: 0, skipped: 0 };

// Constant quality with a ceiling: a layer of full-frame grain or noise would otherwise run to hundreds of
// megabytes, since noise does not compress, while ordinary graphics stay well under it. The realtime speed
// encodes 2-5 times faster than 'good' for the same picture (SSIM within 0.002) and files up to half again larger.
const LAYER_CODEC = ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', '30', '-b:v', '8M', '-row-mt', '1', '-deadline', 'realtime', '-cpu-used', '8',
  '-auto-alt-ref', '0', '-metadata:s:v:0', 'alpha_mode=1', '-an'];

/**
 * Chrome workers for the layer pass. Each worker steps the page through every frame before its first, and a page
 * that seeks videos keeps several cores busy doing it, so more workers mostly fight over the CPU: on 14 cores a
 * 26-layer page took 173 s with 3 workers, 187 s with 4 and 256 s with 7.
 */
const layerWorkers = (): number => Math.max(1, Math.min(3, Math.floor(availableParallelism() / 4)));

/** A page's rendered layer frames: `dir/<k>/%05d.png` for layer k, and the key they were rendered under. */
interface Frames { dir: string; total: number; key: string }

/**
 * One pass over the page for all of its layers: each frame is stepped to once, then shot once per layer that
 * could show in it, with only that layer drawn; the frames a layer is judged absent from are one blank picture.
 */
async function renderFrames(page: string, parts: LayerPart[], dir: string, plan: Plan): Promise<Frames> {
  const fps = plan.fps ?? 30;
  const end = Math.max(...parts.map((p) => p.to ?? plan.duration!));
  // Rounded up, so a frame that starts inside the last layer's span is rendered.
  const total = Math.ceil(end * fps - 1e-6);
  // The frames are kept with what made them: the layers, the canvas and frame rate, and every file the page asked
  // for (the page itself included), by size and time or by being missing. A change to any of them renders again.
  const key = JSON.stringify({ capture: 5, layers: parts.map((p) => p.select), fps, width: plan.width, height: plan.height, total });
  const index = join(dir, 'layers.json');
  const kept = readCache<{ key?: string; read?: Record<string, number[] | null>; warnings?: string[] }>(index);
  const unchanged = (read: Record<string, number[] | null>) => Object.entries(read).every(([f, was]) => JSON.stringify(stamp(f)) === JSON.stringify(was));
  if (kept?.key === key && kept.read && unchanged(kept.read) && parts.every((_, k) => existsSync(join(dir, String(k), 'drawn.json')))) {
    process.stderr.write(`veed-project: the layer frames of ${basename(page)} are already rendered; cutting only\n`);
    for (const line of kept.warnings ?? []) process.stderr.write(`veed-project: ${line}\n`);
    return { dir, total, key: `${key}${JSON.stringify(kept.read)}` };
  }
  // Gone before the first frame is overwritten, so a run stopped halfway is never taken for a finished one.
  rmSync(index, { force: true });
  parts.forEach((_, k) => mkdirSync(join(dir, String(k)), { recursive: true }));
  process.stderr.write(`veed-project: rendering ${parts.length} layers of ${basename(page)}, ${total} frames\n`);

  const chrome = await resolveChrome(undefined, (line) => console.error(line));
  const server = await startPageServer({ roots: pageRoots(page, []).roots });
  const base = {
    chrome, server, page, viewport: { width: plan.width, height: plan.height }, clip: null, transparent: true, layers: parts.map((p) => p.select),
    fps: { num: fps, den: 1 }, seed: SEED, epoch: EPOCH, budgetMs: BUDGET_MS, failedLoads: new Set<string>(), refused: new Set<string>(),
  };
  const runs = splitContiguous(Array.from({ length: total }, (_, i) => i), workersFor(total, layerWorkers(), 24));
  // A frame a layer is judged absent from is this one picture, linked rather than captured.
  const blank = join(dir, 'blank.png');
  await ffmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black@0:s=${plan.width}x${plan.height},format=rgba`, '-frames:v', '1', blank]);
  // The frames each layer was drawn in: the rest are the blank picture, which the cut need not read.
  const drawn = parts.map(() => new Set<number>());
  const emptyVideo = parts.map(() => 0);
  // A page may build its elements in a timer or __seek, so "matches nothing" is decided over every frame, not the first.
  const matched = parts.map(() => false);
  const warnings: string[] = [];
  let done = 0;
  let failed = false;
  try {
    await timed('layer frames', () => Promise.all(runs.map(async (run, w) => {
      const s = await RenderSession.open(base);
      try {
        const blended = await s.excludeBlended();
        const video = await s.layersWithVideo();
        if (w === 0 && blended.length) warnings.push(`left out, since the editor has no blend modes: ${blended.join(', ')}`);
        // Layers holding a video go first: a video hidden by the previous layer's switch can be shot before its
        // picture is drawn again, which comes out as an empty frame and flickers in the editor.
        const order = parts.map((_, k) => k).sort((a, b) => Number(video[b]) - Number(video[a]));
        for (const i of run) {
          if (failed) return;
          // The frame is stepped to with the whole page showing, so the render waits for every video's picture.
          await s.showLayer(-1);
          await s.seek(i);
          const { visible, matches } = await s.visibleLayers();
          matches.forEach((n, k) => { if (n) matched[k] = true; });
          for (const k of order) {
            const file = join(dir, String(k), `${pad5(i)}.png`);
            rmSync(file, { force: true });
            if (!visible[k]) {
              linkSync(blank, file);
              shots.skipped++;
              continue;
            }
            shots.taken++;
            drawn[k].add(i);
            await s.showLayer(k);
            let png = await s.shoot(`frame ${i} of layer ${parts[k].select}`);
            // A video layer that comes out empty although it is on screen is shot again, a few times, while its picture lands.
            let retry = 0;
            for (; video[k] && retry < 5 && inspectPng(png).alphaMax === 0; retry++) {
              await new Promise((r) => setTimeout(r, 40));
              png = await s.shoot(`frame ${i} of layer ${parts[k].select}`);
            }
            if (retry === 5 && inspectPng(png).alphaMax === 0) emptyVideo[k]++;
            writeFileSync(file, png);
          }
          if (++done % 48 === 0) process.stderr.write(`veed-project: ${Math.round((100 * done) / total)}% of layer frames\n`);
        }
      } catch (e) {
        failed = true;
        throw e;
      } finally {
        await s.close();
      }
    })));
  } finally {
    await server.close();
  }
  for (const line of base.failedLoads) warnings.push(`warning: ${line}`);
  parts.forEach((p, k) => {
    if (emptyVideo[k]) warnings.push(`warning: ${emptyVideo[k]} frames of the layer ${p.select} came out empty while its video was on screen; its clip may flicker there`);
  });
  // Said before a selector that matched nothing fails the run: a page that did not load is the likely reason.
  for (const line of warnings) process.stderr.write(`veed-project: ${line}\n`);
  const none = parts.filter((_, k) => !matched[k]).map((p) => p.select);
  if (none.length) throw new PlanError(`no element of ${basename(page)} matches the layer selector ${none.join(', ')} in any frame`);
  parts.forEach((_, k) => writeAtomic(join(dir, String(k), 'drawn.json'), JSON.stringify([...drawn[k]].sort((a, b) => a - b))));
  const read = Object.fromEntries(server.requested().map((f) => [f, stamp(f)]));
  // Written once the frames are complete.
  writeAtomic(index, JSON.stringify({ key, read, warnings }));
  return { dir, total, key: `${key}${JSON.stringify(read)}` };
}

/** Each stretch a layer is visible in, as a clip cut to its box; `onClip` hears of a layer's clips once they are all cut. */
async function cutLayers(parts: LayerPart[], f: Frames, plan: Plan, onClip: (c: Clip) => void, stop: { reason?: unknown }): Promise<Clip[][]> {
  // Clips are kept with what made them: the frames, the codec and cutting method, and each layer's span.
  const cache = join(f.dir, 'clips.json');
  const key = JSON.stringify({ frames: f.key, codec: `${LAYER_CODEC.join(' ')} cut:11`, spans: parts.map((p) => [p.at ?? 0, p.to ?? plan.duration]) });
  const kept = readCache<{ key?: string; clips: Clip[][] }>(cache);
  if (kept?.key === key && kept.clips.flat().every((c) => existsSync(c.file))) {
    kept.clips.flat().forEach(onClip);
    return kept.clips;
  }
  // Gone before the first clip is overwritten, so clips cut halfway are never taken for another run's.
  rmSync(cache, { force: true });
  const slot = limiter(4);
  const clips = await timed('cutting', () => Promise.all(parts.map((p, k) => slot(async () => {
    if (stop.reason) return [];
    try {
      const cut = await cutLayer(p, join(f.dir, String(k)), plan.fps ?? 30, f.total, plan);
      cut.forEach(onClip);
      return cut;
    } catch (e) {
      stop.reason ??= e;
      throw e;
    }
  }))));
  if (stop.reason) throw stop.reason;
  writeAtomic(cache, JSON.stringify({ key, clips }));
  return clips;
}

/** A file's size and modification time, or null when it is not there. */
const stamp = (f: string): number[] | null => {
  const st = existsSync(f) ? statSync(f) : null;
  return st ? [st.size, st.mtimeMs] : null;
};

/** A cache file's contents, or null when it is missing or unreadable (a run stopped mid-write): either way, work again. */
function readCache<T>(file: string): T | null {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as T : null;
  } catch {
    return null;
  }
}

function writeAtomic(file: string, text: string): void {
  writeFileSync(`${file}.${process.pid}.tmp`, text);
  renameSync(`${file}.${process.pid}.tmp`, file);
}

/** Runs the tasks given to it at most `n` at a time, in the order given. */
function limiter(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    // A finished task hands its slot straight to the next waiting one, so a newcomer cannot slip in between.
    if (running < n) running++;
    else await new Promise<void>((go) => waiting.push(go));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

function ffmpeg(args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    // Uncoloured, since its log is parsed line by line.
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, AV_LOG_FORCE_NOCOLOR: '1' } });
    let err = '';
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done(err) : fail(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`))));
  });
}

/**
 * Chrome saves a frame it drew fully opaque without an alpha channel, so a layer's frames mix RGB and RGBA. ffmpeg
 * rebuilds its filters at each switch; the first frame is still written with alpha so the stream opens as RGBA.
 */
async function withAlphaFirst(png: string): Promise<void> {
  const colourType = readFileSync(png).subarray(0, 26)[25];
  if (colourType !== 2) return;
  await ffmpeg(['-v', 'error', '-y', '-i', png, '-pix_fmt', 'rgba', `${png}.rgba.png`]);
  renameSync(`${png}.rgba.png`, png);
}

/**
 * Frames `first`..`first + count - 1` of `dir/%05d.png`, read once for each one's strongest alpha and the box of every
 * pixel with any alpha at all (x2 < x1 when it has none), so a hairline, a dot or a faint glow keeps its true box.
 * The first frame is rewritten with an alpha channel if it has none, so the sequence opens as RGBA.
 */
export async function scanFrames(dir: string, fps: number, first: number, count: number): Promise<{ peak: number; x1: number; x2: number; y1: number; y2: number }[]> {
  await withAlphaFirst(join(dir, `${pad5(first)}.png`));
  // bbox counts a pixel above min_val, so 0 takes any alpha; it prints no box for a frame with none.
  const scan = await ffmpeg(['-hide_banner', '-framerate', String(fps), '-start_number', String(first), '-i', join(dir, '%05d.png'), '-frames:v', String(count),
    '-vf', 'format=rgba,alphaextract,format=gray,signalstats,bbox=min_val=0,metadata=print', '-f', 'null', '-']);
  const out: { peak: number; x1: number; x2: number; y1: number; y2: number }[] = [];
  for (const line of scan.split('\n')) {
    // Counted on the metadata filter's own line: bbox logs a pts_time of its own for every frame too.
    if (/frame:\d+\s+pts:/.test(line)) out.push({ peak: 0, x1: 0, x2: -1, y1: 0, y2: -1 });
    const key = /lavfi\.(?:signalstats\.(YMAX)|bbox\.([xy][12]))=(-?[\d.]+)/.exec(line);
    const f = out.at(-1);
    if (key && f) {
      if (key[1]) f.peak = Number(key[3]);
      else f[key[2] as 'x1' | 'x2' | 'y1' | 'y2'] = Number(key[3]);
    }
  }
  if (out.length !== count) throw new Error(`reading frames ${first}-${first + count - 1} of ${dir}: ffmpeg reported ${out.length}`);
  return out;
}

/** The stretches layer frames in `dir` are visible in, each cut to the box it covers and encoded with its alpha. */
async function cutLayer(p: LayerPart, dir: string, fps: number, total: number, plan: Plan): Promise<Clip[]> {
  // In frame indices throughout; seconds only where a clip is placed.
  const frames = Array.from({ length: total }, (_, i) => ({ t: i, peak: 0, x1: 0, x2: -1, y1: 0, y2: -1 }));
  const bridge = Math.round(0.25 * fps);
  // Only the stretches the layer was drawn in are read, each frame once for both its strongest alpha and its box.
  const drawnAt = readJsonFile(join(dir, 'drawn.json')) as number[];
  for (const run of visibleSpans(drawnAt.map((i) => ({ t: i, peak: 1 })), 1, bridge)) {
    const first = run.at, count = run.to - run.at;
    const scanned = await timed('  scanning frames (sum)', () => scanFrames(dir, fps, first, count).catch((e) => {
      throw new Error(`layer ${p.select}: ${errorText(e)}`);
    }));
    scanned.forEach((f, n) => { frames[first + n] = { t: first + n, ...f }; });
  }
  // The frames that start inside the layer's span of page time.
  const from = Math.ceil((p.at ?? 0) * fps - 1e-6), to = Math.ceil((p.to ?? plan.duration!) * fps - 1e-6);
  const spans = visibleSpans(frames.filter((f) => f.t >= from && f.t < to), 1, bridge);
  if (!spans.length) {
    process.stderr.write(`veed-project: the layer ${p.select} draws nothing between ${(from / fps).toFixed(2)} and ${(to / fps).toFixed(2)} s; left out\n`);
    return [];
  }
  const clips: Clip[] = [];
  for (const [i, span] of spans.entries()) {
    const first = span.at, count = span.to - span.at;
    await withAlphaFirst(join(dir, `${pad5(first)}.png`));
    const cut = ['-framerate', String(fps), '-start_number', String(first), '-i', join(dir, '%05d.png'), '-frames:v', String(count)];
    const drawnHere = frames.slice(first, first + count).filter((f) => f.peak > 0 && f.x2 >= f.x1 && f.y2 >= f.y1);
    if (!drawnHere.length) throw new Error(`the frames of layer ${p.select} from ${first} have alpha but no box`);
    const x = Math.min(...drawnHere.map((f) => f.x1)), y = Math.min(...drawnHere.map((f) => f.y1));
    const w = Math.max(...drawnHere.map((f) => f.x2)) - x + 1, h = Math.max(...drawnHere.map((f) => f.y2)) - y + 1;
    const pad = 4;
    const bx = Math.max(0, x - pad) & ~1, by = Math.max(0, y - pad) & ~1;
    const bw = Math.max(2, Math.min(plan.width - bx, w + 2 * pad) & ~1), bh = Math.max(2, Math.min(plan.height - by, h + 2 * pad) & ~1);
    const webm = `${dir}-${i + 1}.webm`;
    const safe = previewSafeSize(bw, bh);
    await timed('  encoding (sum)', () => ffmpeg(['-v', 'error', '-y', ...cut, '-vf', `format=rgba,crop=${bw}:${bh}:${bx}:${by},pad=${safe.w}:${safe.h}:0:0:color=black@0`, ...LAYER_CODEC, webm]));
    clips.push({ file: webm, at: first / fps, to: (first + count) / fps, box: { x: bx, y: by, w: safe.w, h: safe.h } });
  }
  return clips;
}

function installBookmark(): number {
  const page = join(stateDir(), 'openedit-veed-bookmark.html');
  const button = (href: string, label: string) =>
    `<a href="${href.replace(/"/g, '&quot;')}" style="display:inline-block;margin:4px 8px 4px 0;padding:10px 16px;background:#b8f36b;color:#000;border-radius:8px;text-decoration:none;font-weight:600">${label}</a>`;
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><title>OpenEdit bookmarks</title>
<body style="font:16px system-ui;max-width:680px;margin:48px auto;line-height:1.5">
<h1>OpenEdit and VEED</h1>
<p>Drag both buttons onto your bookmarks bar:</p>
<p>${button(bookmarkletUrl(BOOKMARKLET, VEED_ORIGIN), 'OpenEdit to VEED')}${button(bookmarkletUrl(PULL_BOOKMARKLET, VEED_ORIGIN), 'Send to Claude')}</p>
<p><b>OpenEdit to VEED</b>: after <code>openedit veed-project</code> opens VEED, click it there. It lays the timeline in the project veed-project made, in your own session, and opens it in the editor.</p>
<p><b>Send to Claude</b>: with a project open in the VEED editor (a screen recording, say), click it. It saves the project, with links to its files, into Downloads for <code>openedit veed-pull</code>.</p>
</body>`);
  console.log(`veed-project: the bookmark page is ${page}`);
  openUrl(page);
  return 0;
}
