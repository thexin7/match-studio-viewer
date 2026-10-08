import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { OPERATOR_MODELS } from '../m3d/operator-catalog.js';

for (const [hero, asset] of Object.entries(OPERATOR_MODELS)) {
  const file = new URL('../ui/models/operator/' + asset.id + '.glb', import.meta.url);
  test(`${hero}: phone asset budget, self-contained data and lossless transport`, { skip: !fs.existsSync(file) && 'Optional local game assets are not installed' }, () => {
    const bytes = fs.readFileSync(file);
    const packed = fs.readFileSync(new URL(file.href + '.gz'));
    assert.ok(bytes.length < 900_000, 'Raw model including full locomotion must stay under 900 KB');
    assert.ok(packed.length < 400_000, 'Transfer must stay under 400 KB');
    assert.deepEqual(gunzipSync(packed), bytes);
    assert.ok(asset.src.endsWith(createHash('sha256').update(bytes).digest('hex').slice(0, 12)));
    const model = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
    assert.equal(model.images?.length || 0, 0);
    assert.equal(model.textures?.length || 0, 0);
    assert.equal(model.skins.length, 1);
    assert.equal(model.materials.length, 1);
    assert.ok(model.buffers.every(buffer => !buffer.uri));
    const triangles = model.meshes.map(mesh => mesh.primitives.reduce((n, p) => n + model.accessors[p.indices].count / 3, 0));
    assert.equal(triangles.length, 2);
    assert.ok(Math.max(...triangles) <= 3500);
    // Three long-hair silhouettes stop simplifying at about 1250 triangles;
    // keep their characteristic outline within the same mobile draw-call budget.
    assert.ok(Math.min(...triangles) <= 1300);
    for (const name of ['TPose', 'Idle', 'Walk', 'Run', 'Death', 'Crouch', 'Downed', 'Prone', 'Swim', 'SwimIdle', 'Fall']) {
      assert.ok(model.animations.some(clip => clip.name === name), name);
    }
    for (const name of ['Walk','Run','Sprint','Swim','SwimIdle','Death']) {
      const clip=model.animations.find(clip=>clip.name===name);
      assert.ok(clip?.samplers.some(s=>model.accessors[s.input].count>1),name+' must not be collapsed to one pose');
    }
  });
}

for (const [hero, asset] of Object.entries(OPERATOR_MODELS)) {
  const file = new URL('../ui/models/operator/' + asset.id + '.desktop.glb', import.meta.url);
  test(`${hero}: desktop detail stays separate from phone downloads`, { skip: !fs.existsSync(file) && 'Optional local desktop assets are not installed' }, () => {
    assert.ok(asset.desktop?.src.includes('.desktop.glb?'));
    assert.ok(!asset.src.includes('.desktop.glb'));
    const raw=fs.readFileSync(file),packed=fs.readFileSync(new URL(file.href+'.gz'));
    assert.ok(raw.length<4_000_000);
    assert.ok(packed.length<1_800_000);
    assert.deepEqual(gunzipSync(packed),raw);
    const model=JSON.parse(raw.subarray(20,20+raw.readUInt32LE(12)).toString());
    const triangles=model.meshes.map(mesh=>mesh.primitives.reduce((n,p)=>n+model.accessors[p.indices].count/3,0));
    assert.ok(Math.max(...triangles)<=24000);
    assert.ok(Math.max(...triangles)>9000);
    assert.equal(model.images?.length||0,0);
  });
}
