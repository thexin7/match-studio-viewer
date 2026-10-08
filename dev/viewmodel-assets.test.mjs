import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const root=new URL('../ui/models/equipment/',import.meta.url);
const manifest=JSON.parse(fs.readFileSync(new URL('manifest.json',root),'utf8'));
const source=fs.readFileSync(new URL('../m3d/first-person-weapon.js',import.meta.url),'utf8');
for(const [name,record]of Object.entries(manifest)){
  const file=new URL(record.file,root);
  test(`${name}: self-contained viewmodel stays at weapon scale and has a matching cache revision`,{skip:!fs.existsSync(file)&&'Optional native assets are not installed'},()=>{
    const bytes=fs.readFileSync(file),packed=fs.readFileSync(new URL(record.file+'.gz',root));
    assert.deepEqual(gunzipSync(packed),bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex').slice(0,12),record.rev);
    assert.ok(source.includes(record.file+'?v='+record.rev));
    assert.ok(packed.length<200_000);
    const model=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)));
    assert.ok(model.buffers.every(buffer=>!buffer.uri));
    for(const mesh of model.meshes)for(const primitive of mesh.primitives){
      const position=model.accessors[primitive.attributes.POSITION];
      assert.ok(position.max.every((value,i)=>value-position.min[i]<1),'Bone visualization helpers must not become part of the weapon');
    }
  });
}
