import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTerrainPack } from '../m3d/terrain-packed.js';
import { encodePack } from '../tools/terrain-pack/pack.mjs';

test('terrain decoding runs in a worker and returns progress and typed buffers', async t => {
  const original = globalThis.Worker;let terminated = false;
  t.after(() => { globalThis.Worker = original; });
  const pack = { position: new Float32Array([1,2,3]), index: new Uint32Array([0]), bake: new Uint8Array([255,255]) };
  globalThis.Worker = class {
    constructor() { queueMicrotask(() => this.onmessage?.({ data: { ready: true } })); }
    postMessage(data) { assert.equal(data.url, 'http://example.test/map.tpk');queueMicrotask(() => { this.onmessage({ data: { progress: [10,20] } });this.onmessage({ data: { pack } }); }); }
    terminate() { terminated = true; }
  };
  const progress = [];
  assert.equal(await loadTerrainPack('http://example.test/map.tpk', (...p) => progress.push(p)), pack);
  assert.deepEqual(progress, [[10,20]]);assert.ok(terminated);
});

test('changing maps terminates a pending decoder and preserves abort semantics', async t => {
  const original = globalThis.Worker;let terminated = false;
  t.after(() => { globalThis.Worker = original; });
  globalThis.Worker = class { postMessage() {} terminate() { terminated = true; } };
  const controller = new AbortController();
  const result = loadTerrainPack('http://example.test/map.tpk', null, controller.signal);
  controller.abort();
  await assert.rejects(result, error => error.name === 'AbortError');assert.ok(terminated);
});
test('decoder errors reject the load instead of silently accepting partial geometry', async t => {
  const original=globalThis.Worker;let terminated=false;t.after(()=>{globalThis.Worker=original;});
  globalThis.Worker=class{
    constructor(){queueMicrotask(()=>this.onmessage({data:{ready:true}}));}
    postMessage(){queueMicrotask(()=>this.onmessage({data:{error:'地形包截断'}}));}
    terminate(){terminated=true;}
  };
  await assert.rejects(loadTerrainPack('http://example.test/bad.tpk'),/地形包截断/);
  assert.ok(terminated);
});
test('worker startup failure retains the direct decoder fallback', async t => {
  const originalWorker=globalThis.Worker,originalFetch=globalThis.fetch;
  t.after(()=>{globalThis.Worker=originalWorker;globalThis.fetch=originalFetch;});
  const chunk={q:Int16Array.of(0,0,0,1,0,0,0,0,1),index:Uint32Array.of(0,1,2),affine:Float64Array.of(1,0,0,0,0,1,0,0,0,0,1,0)};
  const payload=encodePack([chunk],null,{}).payload;
  globalThis.Worker=class{constructor(){throw new Error('worker blocked');}};
  globalThis.fetch=async()=>new Response(payload);
  const pack=await loadTerrainPack('http://example.test/map.tpk');assert.equal(pack.tris,1);assert.deepEqual([...pack.index],[0,1,2]);
});
