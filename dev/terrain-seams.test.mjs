import assert from 'node:assert/strict';
import test from 'node:test';
import { repairHeightfields, terrainSeamReport } from '../tools/terrain-pack/repair-heightfields.mjs';
import { chunkPositions, readGlb } from '../tools/terrain-pack/pack.mjs';
import { writeGlb } from '../tools/terrain-pack/write-glb.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import * as THREE from '../vendor/three/build/three.module.js';

function tile(gx, gy, transposed = true) {
  const q = [], index = [];
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const u = gx + (transposed ? y : x), v = gy + (transposed ? x : y);
    q.push((gx + x) * 2, u * 10 + v * 3, -(gy + y) * 2);
  }
  for (let y = 0; y < 63; y++) for (let x = 0; x < 63; x++) {
    const a = y * 64 + x;index.push(a, a + 1, a + 64, a + 1, a + 65, a + 64);
  }
  return { name: `tile-${gx}-${gy}`, q: Int16Array.from(q), index: Uint32Array.from(index), affine: Float64Array.of(1,0,0,0,0,.1,0,0,0,0,1,0) };
}
test('heightfield row-column correction joins adjacent tiles without moving buildings or altering heights', () => {
  const building = { name: 'building', q: Int16Array.of(1,10,1,5,20,1,1,30,6), index: Uint32Array.of(0,1,2), affine: Float64Array.of(1,0,0,0,0,1,0,0,0,0,1,0) };
  const chunks = [tile(0,0), tile(63,0), tile(0,63), tile(63,63), building];
  const original = structuredClone(chunks);
  const repaired = repairHeightfields(chunks);
  assert.ok(repaired.before.max > 20);
  assert.ok(repaired.after.max < .001);
  assert.equal(repaired.repairedTiles, 4);
  assert.deepEqual(chunks, original, 'source is read-only');
  assert.deepEqual(repaired.chunks.find(c => c.name === 'building'), building);
  for (const ch of repaired.chunks.filter(c => c.name !== 'building')) {
    const p = chunkPositions([ch]);
    for (let i = 0; i < p.length; i += 3) assert.ok(Math.abs(p[i + 2] - (p[i] / 2 * 10 + p[i + 1] / 2 * 3) * .1) < .001);
    const [a,b,c] = [...ch.index.slice(0,3)].map(i => i*3);
    assert.ok((p[b]-p[a])*(p[c+1]-p[a+1])-(p[b+1]-p[a+1])*(p[c]-p[a]) > 0, 'winding is preserved');
  }
});
test('already continuous terrain is not transposed again', () => {
  const chunks = [tile(0,0,false),tile(63,0,false)];
  assert.equal(terrainSeamReport(chunks).max, 0);
  assert.equal(repairHeightfields(chunks).repairedTiles, 0);
});
test('repaired GLB has aligned vertex data and preserves quantized coordinates and transforms', () => {
  const repaired = repairHeightfields([tile(0,0), tile(63,0)]).chunks;
  const { json, chunks } = readGlb(writeGlb(repaired));
  assert.ok(json.bufferViews.filter(v => v.target === 34962).every(v => v.byteStride === 8 && v.byteOffset % 4 === 0));
  assert.deepEqual(chunkPositions(chunks), chunkPositions(repaired));
  chunks.forEach((ch,i) => assert.deepEqual([...ch.index], [...repaired[i].index]));
});
test('small residual differences are welded only on shared landscape borders', () => {
  const a=tile(0,0),b=tile(63,0);b.affine[7]=.2;
  const result=repairHeightfields([a,b]);
  assert.ok(result.welded.points > 0);
  assert.ok(result.welded.maxAdjustment < .101);
  assert.ok(result.after.max < .005);
});
test('browser GLB fallback reads the padded repaired positions correctly', () => {
  const chunks=repairHeightfields([tile(0,0),tile(63,0)]).chunks;
  const glb=writeGlb(chunks), bytes=glb.buffer.slice(glb.byteOffset,glb.byteOffset+glb.byteLength);
  const source=fs.readFileSync(new URL('../m3d/r3d.js',import.meta.url),'utf8');
  const code=source.match(/function parseGLB\(buf\) \{[\s\S]*?return out;\s*\}/)[0];
  const ctx=vm.createContext({THREE,TextDecoder,DataView,Uint8Array,Int8Array,Int16Array,Uint16Array,Uint32Array,Float32Array,bytes});
  vm.runInContext(code,ctx);const parts=vm.runInContext('parseGLB(bytes)',ctx);
  const result=[];const point=new THREE.Vector3();
  for(const part of parts){const pos=part.geometry.attributes.position;for(let i=0;i<pos.count;i++){point.fromBufferAttribute(pos,i).applyMatrix4(part.matrix);result.push(Math.fround(point.x),Math.fround(-point.z),Math.fround(point.y));}part.geometry.dispose();}
  assert.deepEqual(result,[...chunkPositions(chunks)]);
});
