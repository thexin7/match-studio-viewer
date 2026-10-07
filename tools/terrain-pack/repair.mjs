import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readGlb, canonicalize, chunkPositions } from './pack.mjs';
import { repairHeightfields, terrainSeamReport } from './repair-heightfields.mjs';
import { writeGlb } from './write-glb.mjs';
import { upsertPacked } from './manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../m3d');
const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const key = process.argv[2];
if (!manifest.maps[key]) throw new Error('用法: node tools/terrain-pack/repair.mjs <地图 key>');
const rec = manifest.maps[key], source = rec.terrain_source || { file: rec.file, rev: rec.rev };
const repaired = repairHeightfields(readGlb(fs.readFileSync(path.join(root, source.file))).chunks);
if (!repaired.repairedTiles) { console.log(JSON.stringify({ key, changed: false, ...repaired.before })); }
else {
  const chunks = canonicalize(repaired.chunks), glb = writeGlb(chunks);
  const check = readGlb(glb).chunks, before = chunkPositions(chunks), after = chunkPositions(check);
  if (before.length !== after.length || before.some((v,i) => v !== after[i])) throw new Error('GLB 回读坐标不一致');
  const report = { version: 'heightfield-xy-transpose-v1', tiles: repaired.repairedTiles, before: repaired.before, after: terrainSeamReport(check), welded: repaired.welded };
  const rev = crypto.createHash('sha256').update(glb).digest('hex').slice(0,16), file = `${key}.repaired.${rev}.glb`;
  fs.writeFileSync(path.join(root, file), glb);
  let text = fs.readFileSync(manifestPath, 'utf8');
  for (const [field,value] of Object.entries({ file, rev, bytes: glb.length, verts: chunks.reduce((n,ch) => n+ch.q.length/3,0), tiles: chunks.length, terrain_source: source, terrain_repair: report })) text = upsertPacked(text, key, value, field);
  fs.writeFileSync(manifestPath, text);
  console.log(JSON.stringify({ key, file, ...report }));
}
