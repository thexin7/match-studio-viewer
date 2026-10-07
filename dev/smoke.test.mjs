import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('./smoke.mjs', import.meta.url), 'utf8');
const terrainWait = source.slice(source.indexOf('async function waitForTerrain('), source.indexOf('// 采样一个阶段'));

test('smoke waits for installed geometry, not only a terrain triangle count', async () => {
  let reads = 0;
  const ctx = vm.createContext({ Date, sleep: async () => {}, cdp: {
    eval: async () => ++reads === 1 ? { tris: 100, mapChunks: null } : { mapChunks: { triangles: 100 } },
  } });
  vm.runInContext(terrainWait, ctx);
  await vm.runInContext('waitForTerrain(cdp)', ctx);
  assert.equal(reads, 2);
});

test('smoke does not report a failed terrain load as success', async () => {
  const ctx = vm.createContext({ Date, sleep: async () => {}, cdp: {
    eval: async () => ({ err: '地图 HTTP 404' }),
  } });
  vm.runInContext(terrainWait, ctx);
  await assert.rejects(vm.runInContext('waitForTerrain(cdp)', ctx), /地图 HTTP 404/);
});

test('repeated smoke samples share one animation counter', () => {
  const expression = source.match(/await cdp\.eval\('(window\.__smokeFrames[^\n]+)'\);/)[1];
  const frames = [];
  const ctx = vm.createContext({ window: {}, requestAnimationFrame: fn => frames.push(fn) });
  for (let i = 0; i < 3; i++) vm.runInContext(expression, ctx);
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(ctx.window.__smokeFrames, 1);
  assert.equal(frames.length, 1);
});
