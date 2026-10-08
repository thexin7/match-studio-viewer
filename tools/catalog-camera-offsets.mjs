// Derive stance-dependent head offsets from the same rig used for rendering.
// Standing eye height remains the viewer setting; no ground snapping is used.
import fs from 'node:fs';
import * as THREE from '../vendor/three/build/three.module.js';

const catalogURL=new URL('../m3d/operator-catalog.js',import.meta.url);
const text=fs.readFileSync(catalogURL,'utf8');
const catalog=JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));
for(const definition of Object.values(catalog)){
  const file=new URL('..'+new URL(definition.src,'http://local').pathname,import.meta.url);
  const bytes=fs.readFileSync(file),size=bytes.readUInt32LE(12);
  const doc=JSON.parse(bytes.subarray(20,20+size)),data=bytes.subarray(28+size);
  const read=index=>{
    const a=doc.accessors[index],v=doc.bufferViews[a.bufferView],width={SCALAR:1,VEC3:3,VEC4:4}[a.type];
    return Array.from({length:a.count},(_,i)=>Array.from({length:width},(_,k)=>data.readFloatLE((v.byteOffset||0)+(a.byteOffset||0)+i*(v.byteStride||width*4)+k*4)));
  };
  function head(clipName){
    const nodes=doc.nodes.map(n=>{
      const object=new THREE.Object3D();object.position.fromArray(n.translation||[0,0,0]);object.quaternion.fromArray(n.rotation||[0,0,0,1]);object.scale.fromArray(n.scale||[1,1,1]);
      if(n.matrix)new THREE.Matrix4().fromArray(n.matrix).decompose(object.position,object.quaternion,object.scale);
      return object;
    });
    for(let i=0;i<doc.nodes.length;i++)for(const child of doc.nodes[i].children||[])nodes[i].add(nodes[child]);
    const reference=doc.animations.find(a=>a.name==='TPose');
    for(const channel of reference?.channels||[]){
      const value=read(reference.samplers[channel.sampler].output)[0],node=nodes[channel.target.node];
      ({translation:node.position,rotation:node.quaternion,scale:node.scale})[channel.target.path].fromArray(value);
    }
    for(const root of doc.scenes[doc.scene||0].nodes)nodes[root].updateMatrixWorld(true);
    const anchors=new Map();
    for(let i=0;i<doc.nodes.length;i++)if(['Root','Hips'].includes(doc.nodes[i].name)&&nodes[i].parent){
      const matrix=nodes[i].parent.matrixWorld.clone();
      anchors.set(i,{matrix,inverse:matrix.clone().invert(),point:nodes[i].position.clone().applyMatrix4(matrix)});
    }
    const clip=doc.animations.find(a=>a.name===clipName);if(!clip)return null;
    for(const channel of clip.channels){
      const values=read(clip.samplers[channel.sampler].output),value=values[Math.floor(values.length/2)],node=nodes[channel.target.node];
      const anchor=channel.target.path==='translation'&&anchors.get(channel.target.node);
      if(anchor){const point=new THREE.Vector3(...value).applyMatrix4(anchor.matrix);point.x=anchor.point.x;point.z=anchor.point.z;node.position.copy(point.applyMatrix4(anchor.inverse));}
      else ({translation:node.position,rotation:node.quaternion,scale:node.scale})[channel.target.path].fromArray(value);
    }
    for(const root of doc.scenes[doc.scene||0].nodes)nodes[root].updateMatrixWorld(true);
    return nodes[doc.nodes.findIndex(n=>n.name==='Head')].getWorldPosition(new THREE.Vector3());
  }
  const standing=head('Idle');definition.headOffsets={};
  for(const state of ['Crouch','Prone','Swim','SwimIdle','Downed']){
    const point=head(state);if(!point)continue;point.sub(standing);
    // The renderer's model basis maps glTF XYZ to local YZX.
    definition.headOffsets[state]=[point.z,point.x,point.y].map(v=>Math.round(v*1000)/1000);
  }
}
fs.writeFileSync(catalogURL,'// Generated from local game assets; do not hand-edit.\nexport const OPERATOR_MODELS = Object.freeze('+JSON.stringify(catalog,null,2)+');\n');
