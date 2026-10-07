import test from 'node:test';
import assert from 'node:assert/strict';
import { isEnemyOfViewer } from '../m3d/character-detail.js';

test('local allies stay friendly and hostile players stay hostile without team IDs', () => {
  const viewer={self:true,key:'__self',team:1,selfTeam:1};
  assert.equal(isEnemyOfViewer(viewer,{kind:'mate',team:0},false),false);
  assert.equal(isEnemyOfViewer(viewer,{kind:'player',team:0},false),true);
  assert.equal(isEnemyOfViewer(viewer,{kind:'ai'},false),true);
  assert.equal(isEnemyOfViewer(null,{kind:'player'},false),true);
});
test('following another player changes affiliation consistently with the HUD', () => {
  const viewer={self:false,key:'target',team:8,selfTeam:1};
  assert.equal(isEnemyOfViewer(viewer,{key:'target',kind:'player',team:0},false),false);
  assert.equal(isEnemyOfViewer(viewer,{key:'squadmate',kind:'player',team:8},false),false);
  assert.equal(isEnemyOfViewer(viewer,{kind:'mate',team:1},false),true);
  assert.equal(isEnemyOfViewer(viewer,{},true),true);
});
