import test from 'node:test';
import assert from 'node:assert/strict';
import { bakeTerrain } from '../tools/terrain-pack/bake.mjs';

test('baking is deterministic across worker counts and visits every sample exactly once', async () => {
  const pos=[],ix=[];
  for(let y=0;y<40;y++)for(let x=0;x<40;x++)pos.push(x,y,Math.sin(x*.4)*.1);
  for(let y=0;y<39;y++)for(let x=0;x<39;x++){const a=y*40+x;ix.push(a,a+1,a+40,a+1,a+41,a+40);}
  const roof=pos.length/3;pos.push(2,2,2,12,2,2,12,12,2,2,12,2);ix.push(roof,roof+1,roof+2,roof,roof+2,roof+3);
  const position=Float32Array.from(pos),index=Uint32Array.from(ix);
  const one=await bakeTerrain(position,index,{threads:1,rays:4});
  const many=await bakeTerrain(position,index,{threads:4,rays:4});
  assert.deepEqual(many.bake,one.bake);
  assert.equal(many.stats.rays_cast,(pos.length/3)*13);
  assert.equal(many.stats.flipped_to_back_side,one.stats.flipped_to_back_side);
  assert.ok(one.bake.some(v=>v<255));
});
