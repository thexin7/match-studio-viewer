import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { loadMapPois, setCatalog, planeToWorld, worldToPlane } from '../m3d/poi-data.js';

const html = fs.readFileSync(new URL('../ui/radar/app.js', import.meta.url), 'utf8');
const catalog = JSON.parse(fs.readFileSync(new URL('../map_catalog.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(new URL('../m3d/manifest.json', import.meta.url), 'utf8'));

test('every published map has terrain metadata and usable POI coordinates', async () => {
  setCatalog(catalog.maps);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(new URL('../map_markers.json', import.meta.url), 'utf8')) });
  try {
    assert.equal(catalog.maps.length, 6);
    for (const map of catalog.maps) {
      assert.ok(manifest.maps[map.key]?.file, map.key);
      const pois = await loadMapPois(map.key);
      assert.ok(pois.exits.length > 0, map.key + ' exits');
      assert.ok(pois.boxes.length > 0, map.key + ' containers');
      for (const p of [...pois.exits, ...pois.boxes]) {
        const world = planeToWorld(map, p.lng, p.lat);
        const plane = worldToPlane(map, world.x, world.y);
        assert.ok(Math.abs(plane.lng - p.lng) < 1e-6 && Math.abs(plane.lat - p.lat) < 1e-6, map.key);
      }
    }
  } finally { globalThis.fetch = oldFetch; }
});

test('a temporary manifest failure can recover on the next map selection', async () => {
  let calls = 0;
  const ctx = vm.createContext({ M3D: '/m3d/', r3man: null, fetch: async () => {
    if (++calls === 1) throw new Error('offline');
    return { ok: true, json: async () => manifest };
  } });
  const start = html.indexOf('async function r3Manifest()');
  vm.runInContext(html.slice(start, html.indexOf('\nfunction r3Loading', start)), ctx);
  await vm.runInContext('r3Manifest()', ctx);
  const result = await vm.runInContext('r3Manifest()', ctx);
  assert.equal(Object.keys(result.maps).length, 6);
});

test('latest selected map wins while manifest requests complete out of order', async () => {
  const requests = [], loads = [];
  const ctx = vm.createContext({
    R3: { setMap: async (info, url) => loads.push([info.key, url]) }, is3d: () => true,
    MAP_INFO: { key: 'daba' }, r3SwitchVersion: 0, lastSnap: null,
    r3Model: key => new Promise(resolve => requests.push({ key, resolve })),
    r3Loading() {}, toast() {}, set3d() {},
  });
  const start = html.indexOf('async function r3SwitchMap()');
  vm.runInContext(html.slice(start, html.indexOf('\n// 2D / 3D', start)), ctx);
  const first = vm.runInContext('r3SwitchMap()', ctx);
  ctx.MAP_INFO = { key: 'az3' };
  const last = vm.runInContext('r3SwitchMap()', ctx);
  for (const request of [...requests].reverse()) {
    request.resolve({ key: request.key, url: request.key + '.glb', rec: { bytes: 1 } });
  }
  await Promise.all([first, last]);
  assert.deepEqual(loads, [['az3', 'az3.glb']]);
});

test('selecting another terrain cancels the old download without a failure toast', async () => {
  const source = fs.readFileSync(new URL('../m3d/korr-adapter.js', import.meta.url), 'utf8');
  const start = source.indexOf('async setMap(info,url,progress,model)');
  const method = source.slice(start, source.indexOf('\n  };', start));
  const jobs = [], installed = [], failures = [];
  const ctx = vm.createContext({
    pendingMap: null, loading: null, loadingJob: null, mapUrl: '', statError: '', latest: null,
    AbortController, gateway: { installGeometry: async key => installed.push(key), fit() {} },
    options: { onToast: msg => failures.push(msg) },
    loadPackedGeometry: job => new Promise((resolve, reject) => {
      jobs.push({ job, resolve });
      job.controller?.signal.addEventListener('abort', () => reject(job.controller.signal.reason));
    }),
  });
  vm.runInContext('const adapter = { camMode: "orbit", ' + method + ' };', ctx);
  const first = vm.runInContext('adapter.setMap({key:"daba"}, "daba.glb")', ctx);
  const second = vm.runInContext('adapter.setMap({key:"az3"}, "az3.glb")', ctx);
  assert.equal(jobs[0].job.controller?.signal.aborted, true);
  await new Promise(resolve => setImmediate(resolve));
  jobs[1].resolve({ dispose() {} });
  await Promise.all([first, second]);
  assert.deepEqual(installed, ['az3']);
  assert.deepEqual(failures, []);
});
