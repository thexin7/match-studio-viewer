import test from 'node:test';
import assert from 'node:assert/strict';
import { locomotionWeights, hasHeldWeapon, operatorState, animationStep } from '../m3d/operator-motion.js';

test('movement blending preserves a unit total and supports backward and lateral movement',()=>{
  for(const speed of [0,.4,1.8,3,5,7]){
    const weights=locomotionWeights(speed,1,0);
    assert.ok(Math.abs(Object.values(weights).reduce((a,b)=>a+b,0)-1)<1e-6);
  }
  assert.equal(locomotionWeights(1.8,-1,0).Backward,1);
  assert.equal(locomotionWeights(1.8,0,1).Left,1);
});
test('death and downed states take precedence over estimated locomotion',()=>{
  assert.equal(operatorState({dead:true,status_key:'down'}),'Death');
  assert.equal(operatorState({status_key:'dying'}),'Crouch');
  assert.equal(operatorState({weapon:'UZI'}),'moving');
});
test('unknown and empty hands do not fabricate a held rifle',()=>{
  for(const weapon of [null,undefined,'','空手','未知武器'])assert.equal(hasHeldWeapon({weapon}),false);
  assert.equal(hasHeldWeapon({weapon:'M4A1'}),true);
});
test('distant animation is throttled while nearby and changed states remain responsive',()=>{
  assert.equal(animationStep(20),1/30);assert.equal(animationStep(100),1/12);assert.equal(animationStep(250),1/8);
});
test('desktop mode gives nearby characters a faster animation cadence',()=>{
  assert.equal(animationStep(20,'high'),1/60);
  assert.equal(animationStep(20,'performance'),1/30);
  assert.equal(animationStep(100,'high'),1/24);
});
