import test from 'node:test';
import assert from 'node:assert/strict';
import { viewerPreferences } from '../ui/studio/model.js';

test('shared console updates cannot replace a phone viewer render mode after reload', () => {
  const remote={q3d:'high',fpscap:60,shadow3d:'auto',warnd:200};
  const local={q3d:'perf',fpscap:30,shadow3d:'off',warnd:150};
  assert.deepEqual(viewerPreferences(remote,local),{q3d:'perf',fpscap:30,shadow3d:'off',warnd:200});
  assert.equal(remote.q3d,'high');
});
test('embedded console and OBS previews follow shared render controls', () => {
  const remote={q3d:'high',fpscap:60};
  assert.deepEqual(viewerPreferences(remote,{q3d:'perf',fpscap:30},true),remote);
});
