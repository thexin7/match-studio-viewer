import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { simplifyTerrain } from '../tools/terrain-pack/simplify.mjs';
import { upsertPacked } from '../tools/terrain-pack/manifest.mjs';

test('terrain simplification retains locked boundary positions and vertex bake', async () => {
  const q = [], index = [], bake = [];
  for (let y = 0; y <= 8; y++) for (let x = 0; x <= 8; x++) { q.push(x, 0, y); bake.push(x + y * 9, 255); }
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const a = y * 9 + x; index.push(a, a + 1, a + 9, a + 1, a + 10, a + 9); }
  const chunk = { q: Int16Array.from(q), index: Uint32Array.from(index), affine: Float64Array.of(1,0,0,0,0,1,0,0,0,0,1,0) };
  const result = await simplifyTerrain([chunk], Uint8Array.from(bake));
  const ch = result.chunks[0], retained = new Set();
  assert.ok(ch.index.length < index.length);
  for (let v = 0; v < ch.q.length / 3; v++) {
    const x = ch.q[v * 3], y = ch.q[v * 3 + 2];
    retained.add(`${x},${y}`);
    assert.equal(result.bake[v * 2], x + y * 9);
    assert.equal(result.bake[v * 2 + 1], 255);
    assert.equal(ch.q[v * 3 + 1], 0);
  }
  for (let i = 0; i <= 8; i++) for (const pair of [[0,i],[8,i],[i,0],[i,8]]) assert.ok(retained.has(pair.join(',')), pair.join(','));
});

test('adding a light pack preserves the existing full-pack manifest', () => {
  const original = '{"maps":{"daba":{"rev":"v1","packed":{"file":"full.tpk"}}}}';
  const updated = JSON.parse(upsertPacked(original, 'daba', { file: 'light.tpk' }, 'packed_light'));
  assert.equal(updated.maps.daba.packed.file, 'full.tpk');
  assert.equal(updated.maps.daba.packed_light.file, 'light.tpk');
});

test('auto selects current light terrain, high and stale packs retain full terrain', () => {
  const html = fs.readFileSync(new URL('../ui/radar/app.js', import.meta.url), 'utf8');
  const start = html.indexOf('function r3TerrainRecord(');
  assert.ok(start >= 0, 'quality-aware terrain selection exists');
  const ctx = vm.createContext({});
  vm.runInContext(html.slice(start, html.indexOf('\nasync function r3Model', start)), ctx);
  ctx.rec = { rev: 'v1', packed: { file: 'full.tpk' }, packed_light: { file: 'light.tpk', src_rev: 'v1' } };
  assert.equal(vm.runInContext('r3TerrainRecord(rec, "auto").packed.file', ctx), 'light.tpk');
  assert.equal(vm.runInContext('r3TerrainRecord(rec, "auto").packed_fallback.file', ctx), 'full.tpk');
  assert.equal(vm.runInContext('r3TerrainRecord(rec, "high").packed.file', ctx), 'full.tpk');
  ctx.rec.packed_light.src_rev = 'old';
  assert.equal(vm.runInContext('r3TerrainRecord(rec, "perf").packed.file', ctx), 'full.tpk');
});

test('failed light download falls back to full pack and cancellation stops fallback', async () => {
  const source = fs.readFileSync(new URL('../m3d/korr-adapter.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function loadPackedGeometry(');
  const code = source.slice(start, source.indexOf('\nlet initialized', start));
  const urls = [];
  class Geometry { constructor() { this.userData = {}; } setAttribute() {} setIndex() {} }
  const ctx = vm.createContext({
    URL, location: { href: 'http://localhost/' }, DecompressionStream, performance,
    THREE: { BufferGeometry: Geometry, BufferAttribute: class {} }, console: { log() {}, warn() {} },
    loadTerrainPack: async url => { urls.push(url); if (url.includes('light')) throw new Error('404'); return { position: [], index: [], verts: 3, tris: 1 }; },
    job: { url: '/m3d/map.glb', model: { rev: 'r1', packed: { file: 'light.tpk', src_rev: 'r1' }, packed_fallback: { file: 'full.tpk', src_rev: 'r1' } }, controller: new AbortController() },
  });
  vm.runInContext(code, ctx);
  const result = await vm.runInContext('loadPackedGeometry(job)', ctx);
  assert.equal(urls.length, 2);
  assert.ok(result.userData.terrainSource.url.includes('full.tpk'));
  urls.length = 0;
  ctx.job.controller.abort();
  await assert.rejects(vm.runInContext('loadPackedGeometry(job)', ctx));
  assert.equal(urls.length, 1);
});

test('switching terrain quality reloads even when the GLB fallback URL is unchanged', async () => {
  const source = fs.readFileSync(new URL('../m3d/korr-adapter.js', import.meta.url), 'utf8');
  const start = source.indexOf('async setMap(info,url,progress,model)');
  const method = source.slice(start, source.indexOf('\n  };', start));
  const loaded = [];
  const ctx = vm.createContext({ pendingMap: null, loading: null, loadingJob: null, mapUrl: '', statError: '', terrainSource: null, latest: null, AbortController,
    gateway: { installGeometry: async () => {}, fit() {} }, options: {},
    loadPackedGeometry: async job => { loaded.push(job.model.packed.file); return { userData: {} }; },
  });
  vm.runInContext('const adapter = {camMode:"orbit",' + method + '};', ctx);
  await vm.runInContext('adapter.setMap({key:"daba"},"daba.glb",null,{packed:{file:"light.tpk"}})', ctx);
  await vm.runInContext('adapter.setMap({key:"daba"},"daba.glb",null,{packed:{file:"full.tpk"}})', ctx);
  assert.deepEqual(loaded, ['light.tpk', 'full.tpk']);
});
