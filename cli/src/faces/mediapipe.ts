// The face detector: MediaPipe's Face Detector task with the full-range BlazeFace model, on CPU, in a
// Python environment of its own that install-mediapipe makes under the app-data dir. The Tasks API is
// the only one current MediaPipe releases ship (the legacy `solutions` package is gone), and it takes the
// full-range model, which finds faces up to about 5 m from the camera where short-range stops near 2 m.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mediapipeDir } from '../config.ts';

// Pinned because the model file and this API surface were verified together on it.
export const MEDIAPIPE_VERSION = '1.1.1';

// Versioned URL, not `latest`: a model swapped under the same name would move every box without a code change.
export const MODEL = {
  file: 'blaze_face_full_range.tflite',
  url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite',
  sha256: '3698b18f063835bc609069ef052228fbe86d9c9a6dc8dcb7c7c2d69aed2b181b',
  bytes: 1_083_786,
} as const;

export const venvDir = (): string => join(mediapipeDir(), 'venv');
export const modelPath = (): string => join(mediapipeDir(), MODEL.file);
export const venvPython = (venv = venvDir(), platform = process.platform): string =>
  platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python');

// Kept as Python source inside this module: the build ships what tsc emits plus the few files build.mjs
// copies by name, so a separate .py would need a copy step of its own and a lookup beside the compiled
// code. With no folder it is the install check: it loads the model and runs it once on a blank image, since a
// MediaPipe that loads a model it cannot run fails only on detection. Each image gets one JSON line.
export const DETECT_SOURCE = String.raw`
import json, os, sys, time
start = time.perf_counter()
from mediapipe import Image
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import FaceDetector, FaceDetectorOptions
detector = FaceDetector.create_from_options(FaceDetectorOptions(
    base_options=BaseOptions(model_asset_path=sys.argv[1]), min_detection_confidence=float(sys.argv[2])))
print(json.dumps({"ready_ms": round(1000 * (time.perf_counter() - start), 1)}), flush=True)
folder = sys.argv[3] if len(sys.argv) > 3 else None
if not folder:
    import numpy
    from mediapipe import ImageFormat
    detector.detect(Image(image_format=ImageFormat.SRGB, data=numpy.zeros((64, 64, 3), numpy.uint8)))
for name in sorted(n for n in os.listdir(folder) if n.endswith(".png")) if folder else []:
    image = Image.create_from_file(os.path.join(folder, name))
    start = time.perf_counter()
    found = detector.detect(image).detections
    ms = 1000 * (time.perf_counter() - start)
    print(json.dumps({"file": name, "ms": round(ms, 2), "width": image.width, "height": image.height, "faces": [
        [d.bounding_box.origin_x, d.bounding_box.origin_y, d.bounding_box.width, d.bounding_box.height,
         round(d.categories[0].score, 3)] for d in found]}), flush=True)
`;

export interface Detection {
  file: string;
  ms: number;
  width: number;
  height: number;
  /** x, y, w, h in the image's pixels, then the score. */
  faces: [number, number, number, number, number][];
}

export interface DetectorRun {
  /** Loading MediaPipe and the model, before the first image. */
  readyMs: number;
  images: Detection[];
}

export type Spawn = typeof spawnSync;

/** Why the detector cannot run here, or null when it can. */
export function missingDetector(python = venvPython(), model = modelPath()): string | null {
  if (!existsSync(python)) return `MediaPipe is not installed (no ${python})`;
  if (!existsSync(model)) return `the face model is missing (no ${model})`;
  return null;
}

/** Every PNG in `folder`, in name order, through the detector; `folder` omitted only loads the model. */
export function runDetector(
  opts: { folder?: string; confidence: number; python?: string; model?: string },
  spawn: Spawn = spawnSync,
): DetectorRun {
  const python = opts.python ?? venvPython();
  const args = ['-I', '-c', DETECT_SOURCE, opts.model ?? modelPath(), String(opts.confidence), ...(opts.folder ? [opts.folder] : [])];
  const r = spawn(python, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.error || r.status !== 0) {
    // MediaPipe's own logging fills stderr on every run, so only the end of it is the reason.
    const tail = String(r.stderr ?? '').trim().split('\n').slice(-6).join('\n');
    const why = r.error?.message ?? (r.signal ? `killed by ${r.signal}` : `exit ${r.status}`);
    throw new Error(`the face detector failed (${why})${tail ? `\n${tail}` : ''}`);
  }
  const lines = String(r.stdout).split('\n').filter((l) => l.startsWith('{')).map((l) => {
    try {
      return JSON.parse(l) as Record<string, unknown>;
    } catch {
      throw new Error(`the face detector printed a line that is not JSON: ${l.slice(0, 200)}`);
    }
  });
  const ready = lines.find((l) => 'ready_ms' in l);
  if (!ready) throw new Error('the face detector exited without loading its model');
  return { readyMs: Number(ready.ready_ms), images: lines.filter((l) => 'file' in l) as unknown as Detection[] };
}
