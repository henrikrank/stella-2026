#!/usr/bin/env node
// Copies runtime assets into dist/.
//
// The assets live outside Vite's publicDir (they are big, and we don't want
// them hashed or inlined), so nothing copies them at build time by default.
//
// Three groups are deliberately left behind, because the game never requests
// them and together they are more than half the payload:
//   - main-character.glb  (89 MB) the un-rigged high-res scan, superseded by
//                         the skinned exports
//   - ghost.glb           (33 MB) same story for the ghost
//   - manor Textures*/    (65 MB) the 2048px sources; the level loads the
//                         downscaled copies in manor/derived instead

import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const SRC = 'assets';
const OUT = 'dist/assets';

const SKIP = [
  /characters\/main-character\/main-character\.glb$/,
  /characters\/ghost\/ghost\.glb$/,
  /manor\/assets\/.*\/Textures[^/]*\//,
  /\.DS_Store$/,
];

const skipped = (p) => SKIP.some((re) => re.test(p.split(path.sep).join('/')));

let files = 0;
let bytes = 0;

async function walk(dir, out) {
  await mkdir(out, { recursive: true });
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const from = path.join(dir, entry.name);
    if (skipped(from)) continue;

    const to = path.join(out, entry.name);
    if (entry.isDirectory()) {
      await walk(from, to);
    } else {
      await cp(from, to);
      bytes += (await stat(from)).size;
      files++;
    }
  }
}

if (!existsSync(SRC)) {
  console.error(`No ${SRC}/ directory to copy.`);
  process.exit(1);
}

await walk(SRC, OUT);
console.log(`copied ${files} asset files (${(bytes / 1e6).toFixed(1)} MB) into ${OUT}`);

