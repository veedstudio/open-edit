// One of several runs started together by the face-folder tests: at a set moment, writes a clip's boxes where faces
// writes them, as faces does, and prints the folder.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { facesFolder } from '../../src/faces/folder.ts';
import { facesScript, type FacesClip } from '../../src/faces/page-script.ts';
import { writeAtomic, writeTextAtomic } from '../../src/providers/exclusive-files.ts';

const [video, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {
  // Every run writes at the same instant.
}
const clip = { video: realpathSync(video), name: 'clip', width: 640, height: 360, durationSec: 1, shots: [] } as unknown as FacesClip;
const out = facesFolder(video);
writeAtomic(join(out, 'faces.json'), clip);
writeTextAtomic(join(out, 'faces.js'), facesScript(clip));
console.log(out);
