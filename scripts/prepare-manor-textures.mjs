#!/usr/bin/env node
// The manor source textures are 60 PNGs at 2048x2048 -- around 1.3 GB of GPU
// memory once mipmapped, which no browser will thank us for. This downscales
// them into assets/manor/derived/, which is what the level actually loads.
//
// Base colour and normal keep the most detail; roughness and metalness are
// low-frequency and survive a harder squeeze. Ambient occlusion is skipped
// entirely -- the scene lights the rooms directly.
//
// Source assets are gitignored, so this is re-runnable from a fresh checkout
// once the raw manor pack is in place: npm run prepare-assets

import { execFile } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SRC = 'assets/manor/assets';
const OUT = 'assets/manor/derived';

// Suffix -> output width. Anything not listed is skipped.
const SIZES = [
  [/_(Base_color|Albedo)\.png$/i, 1024],
  [/_Normal\.png$/i, 1024],
  [/_Roughness\.png$/i, 512],
  [/_Metallic\.png$/i, 512],
];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const targetFor = (file) => SIZES.find(([re]) => re.test(file))?.[1] ?? null;

let converted = 0;
let skipped = 0;
let bytesIn = 0;
let bytesOut = 0;

if (!existsSync(SRC)) {
  console.error(`No manor assets at ${SRC} -- drop the pack in and re-run.`);
  process.exit(1);
}

for await (const file of walk(SRC)) {
  const size = targetFor(file);
  if (!size) continue;

  // Flatten to derived/<AssetName>_<Map>.png so the loader needs no knowledge
  // of the (inconsistent) source folder layout. The pack also names the colour
  // map _Albedo on some assets and _Base_color on others; normalise to one so
  // the loader has a single name to ask for.
  const out = path.join(OUT, path.basename(file).replace(/_Albedo\.png$/i, '_Base_color.png'));
  await mkdir(OUT, { recursive: true });

  if (existsSync(out)) {
    skipped++;
    continue;
  }

  await run('sips', ['-Z', String(size), file, '--out', out]);
  bytesIn += (await stat(file)).size;
  bytesOut += (await stat(out)).size;
  converted++;
  process.stdout.write(`\r  ${converted} textures resized...`);
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
console.log(
  `\ndone: ${converted} resized, ${skipped} already present` +
    (converted ? ` -- ${mb(bytesIn)} -> ${mb(bytesOut)}` : '')
);
