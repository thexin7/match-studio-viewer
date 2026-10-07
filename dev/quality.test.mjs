import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../m3d/korr-renderer.js', import.meta.url), 'utf8');
const monitor = source.slice(source.indexOf('function _monitorAutoRenderQuality('), source.indexOf('\nfunction resize()', source.indexOf('function _monitorAutoRenderQuality(')));

function setup() {
  const ctx = vm.createContext({
    document: { hidden: false }, requestedRenderQuality: 'auto', mapMesh: {},
    qualityMonitor: { frames: 0, sampleStartedAt: 0, lastFrameAt: 0, warmupUntil: 0 },
    activeQualityProfile: { id: 'high' }, autoQualityCeiling: null,
    _applyRenderQuality() {}, window: {},
  });
  vm.runInContext(monitor, ctx);
  return ctx;
}

test('sustained frames slower than one second still downgrade auto quality', () => {
  const ctx = setup();
  for (const at of [1, 2001, 4001, 6001]) vm.runInContext(`_monitorAutoRenderQuality(${at}, true)`, ctx);
  assert.equal(ctx.autoQualityCeiling, 'balanced');
});

test('hidden tab gaps and manual quality do not trigger downgrades', () => {
  const ctx = setup();
  vm.runInContext('_monitorAutoRenderQuality(1, true)', ctx);
  ctx.document.hidden = true;
  vm.runInContext('_monitorAutoRenderQuality(10001, true)', ctx);
  ctx.document.hidden = false;
  vm.runInContext('_monitorAutoRenderQuality(20001, true)', ctx);
  assert.equal(ctx.autoQualityCeiling, null);
  ctx.requestedRenderQuality = 'high';
  vm.runInContext('_monitorAutoRenderQuality(30001, true)', ctx);
  assert.equal(ctx.autoQualityCeiling, null);
});
