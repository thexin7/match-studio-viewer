import test from 'node:test';
import assert from 'node:assert/strict';
import { characterDetail, operatorDefinition } from '../m3d/character-detail.js';

test('operator appearance uses exact identity and never a different hero as fallback', () => {
  const vyron = { src: '/ui/models/operator/vyron.glb' };
  const catalog = { '威龙': vyron };
  assert.equal(operatorDefinition(' 威龙 ', catalog), vyron);
  for (const hero of ['', null, '蜂医', 'toString', '__proto__']) {
    assert.equal(operatorDefinition(hero, catalog), null);
  }
});

test('LOD preserves close detail and simplifies small silhouettes', () => {
  assert.equal(characterDetail(150), 0);
  assert.equal(characterDetail(30), 1);
  assert.equal(characterDetail(5), 2);
});

test('LOD hysteresis prevents flicker while zooming around a threshold', () => {
  assert.equal(characterDetail(43, 0), 0);
  assert.equal(characterDetail(43, 1), 1);
  assert.equal(characterDetail(13, 1), 1);
  assert.equal(characterDetail(13, 2), 2);
  assert.equal(characterDetail(70, 2), 0);
  assert.equal(characterDetail(4, 0), 2);
});

test('phone and desktop presets choose different detail for the same screen size', () => {
  assert.equal(characterDetail(45, -1, 'performance'), 1);
  assert.equal(characterDetail(45, -1, 'high'), 0);
  assert.equal(characterDetail(110, -1, 'performance'), 0);
  assert.equal(characterDetail(5, -1, 'high'), 2);
});
