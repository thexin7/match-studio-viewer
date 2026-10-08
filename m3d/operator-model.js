import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { createOperatorRifle, createOperatorRod, RIFLE_RIGHT_GRIP } from './operator-weapon.js?v=1.0.2';
import { locomotionWeights, operatorState, hasHeldWeapon, hasFishingRod, animationStep } from './operator-motion.js?v=1.1.0';

const assets=new Map();
const modelLoadQueue=[];
let activeModelLoads=0;
function enqueueOperatorLoad(task) {
  return new Promise((resolve,reject)=>{
    const run=()=>{
      activeModelLoads++;
      Promise.resolve().then(task).then(resolve,reject).finally(()=>{
        activeModelLoads--;modelLoadQueue.shift()?.();
      });
    };
    if(activeModelLoads<2)run();else modelLoadQueue.push(run);
  });
}
export const operatorAssetState = definition => assets.get(definition?.src)?.state || 'idle';
export function loadOperatorAsset(definition) {
  if(!definition)return Promise.resolve(null);
  if(assets.has(definition.src))return assets.get(definition.src).loading;
  const entry={state:'loading',asset:null,loading:null};assets.set(definition.src,entry);
  // The existing HTTP server serves the precompressed .gz sibling. Let the
  // browser decode Content-Encoding, including on older mobile browsers.
  entry.loading=enqueueOperatorLoad(()=>new GLTFLoader().loadAsync(definition.src)).then(gltf=>{
    const referencePose=gltf.animations.find(clip=>clip.name==='TPose');
    if(!referencePose)throw new Error('干员模型缺少参考姿态');
    const referenceMixer=new THREE.AnimationMixer(gltf.scene);referenceMixer.clipAction(referencePose).play();referenceMixer.update(0);
    gltf.scene.updateMatrixWorld(true);
    const high=[],low=[];
    gltf.scene.traverse(o=>{
      if(!o.isMesh)return;
      let parent=o,isLow=false;while(parent){isLow ||= parent.name.includes('_LOD1');parent=parent.parent;}
      o.userData.operatorLod=isLow?1:0;(isLow?low:high).push(o);
      o.castShadow=false;o.receiveShadow=false;o.renderOrder=1002;o.userData.radarLitSurface=true;o.userData.radarEntitySurface=true;
      // Draw opaque character surfaces after their x-ray shells in the same
      // queue. Otherwise armor layers falsely x-ray through the character itself.
      if(definition.native){
        const old=o.material;
        const params={color:0xffffff,vertexColors:true,side:THREE.DoubleSide,transparent:true,depthWrite:true};
        o.material=definition.isDesktop?new THREE.MeshStandardMaterial({...params,roughness:.82,metalness:.04}):new THREE.MeshLambertMaterial(params);
        o.material.forceSinglePass=true;
        for(const m of Array.isArray(old)?old:[old])m.dispose();
      }else for(const m of Array.isArray(o.material)?o.material:[o.material]){m.color.setHex(0xffffff);m.roughness=.78;m.metalness=0;m.transparent=true;m.forceSinglePass=true;m.depthWrite=true;}
      if(o.isSkinnedMesh)o.skeleton.update();
    });
    const bounds=new THREE.Box3();for(const o of high)bounds.union(new THREE.Box3().setFromObject(o,true));
    const height=bounds.max.y-bounds.min.y;
    if(!(height>0)||!high.length)throw new Error('干员模型缺少有效几何');
    const bones={};gltf.scene.traverse(o=>{if(o.isBone)bones[o.name.replace('mixamorig','')]=o;});
    for(const name of ['Hips','LeftHand','RightHand','Head'])if(!bones[name])throw new Error('干员骨骼缺少 '+name);
    // The network owns horizontal translation; remove locomotion root motion
    // in model space, while retaining the vertical motion of steps and falls.
    const anchors=new Map();
    for(const name of ['Root','Hips'])if(bones[name]){
      const bone=bones[name];bone.parent.updateWorldMatrix(true,false);
      const matrix=bone.parent.matrixWorld.clone();
      anchors.set(name+'.position',{matrix,inverse:matrix.clone().invert(),position:bone.position.clone().applyMatrix4(matrix)});
    }
    const clips=gltf.animations.map(clip=>{
      const copy=clip.clone();
      for(const track of copy.tracks){
        const anchor=[...anchors].find(([name])=>track.name.endsWith(name))?.[1];
        if(!anchor)continue;
        const p=new THREE.Vector3();
        for(let i=0;i<track.values.length;i+=3){p.fromArray(track.values,i).applyMatrix4(anchor.matrix);p.x=anchor.position.x;p.z=anchor.position.z;p.applyMatrix4(anchor.inverse).toArray(track.values,i);}
      }
      return copy;
    });
    for(const name of ['Idle','Walk','Run','Death'])if(!clips.some(c=>c.name===name))throw new Error('干员动画缺少 '+name);
    entry.asset={scene:gltf.scene,clips,bounds,scale:definition.native?1:1.8/height,highTriangles:high.reduce((n,o)=>n+o.geometry.index.count/3,0),lowTriangles:low.reduce((n,o)=>n+o.geometry.index.count/3,0)};
    entry.state='ready';return entry.asset;
  }).catch(error=>{entry.state='error';console.warn('[干员模型] 加载失败，使用简化模型',error);return null;});
  return entry.loading;
}

export function createRealisticOperator(definition) {
  const asset=assets.get(definition?.src)?.asset;
  if(!asset)return null;
  const root=new THREE.Group(),basis=new THREE.Group(),model=clone(asset.scene);
  basis.rotation.set(Math.PI/2,0,Math.PI/2,'ZYX');root.add(basis);basis.add(model);
  model.scale.multiplyScalar(asset.scale);model.position.y-=asset.bounds.min.y*asset.scale;
  const bones={};model.traverse(o=>{if(o.isBone)bones[o.name.replace('mixamorig','')]=o;});
  const occluded=new THREE.MeshBasicMaterial({color:0xff4058,depthFunc:THREE.GreaterDepth,depthTest:true,depthWrite:false,transparent:true,opacity:.5,fog:false});
  const meshes=[];model.traverse(o=>{if(o.isMesh)meshes.push(o);});
  const bodyMaterial=meshes[0].material.clone(),identityColor=new THREE.Color(0xff4058);
  if(definition.isDesktop){
    bodyMaterial.onBeforeCompile=shader=>{
      shader.uniforms.operatorIdentity={value:identityColor};
      shader.fragmentShader='uniform vec3 operatorIdentity;\n'+shader.fragmentShader;
      shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`#include <opaque_fragment>
        float operatorRim = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 2.0);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, operatorIdentity, 0.12 + 0.65 * operatorRim);`);
    };
    bodyMaterial.customProgramCacheKey=()=> 'operator-affiliation-rim-v1';
  }else{
    bodyMaterial.vertexColors=false;
    bodyMaterial.color.copy(identityColor);bodyMaterial.emissive.copy(identityColor);bodyMaterial.emissiveIntensity=.12;
  }
  for(const mesh of meshes){
    mesh.material=bodyMaterial;
    let shell;
    if(mesh.isSkinnedMesh){shell=new THREE.SkinnedMesh(mesh.geometry,occluded);shell.bindMode=mesh.bindMode;shell.bind(mesh.skeleton,mesh.bindMatrix);}
    else shell=new THREE.Mesh(mesh.geometry,occluded);
    shell.position.copy(mesh.position);shell.quaternion.copy(mesh.quaternion);shell.scale.copy(mesh.scale);shell.renderOrder=1001;
    shell.userData.operatorLod=mesh.userData.operatorLod;shell.userData.radarExcludeFromSsao=true;mesh.parent.add(shell);mesh.userData.operatorShell=shell;
  }
  const rifle=createOperatorRifle(occluded);root.add(rifle);
  const rod=createOperatorRod();root.add(rod);rod.visible=false;
  const mixer=new THREE.AnimationMixer(model),actions={};
  for(const clip of asset.clips){if(clip.name==='TPose')continue;const action=mixer.clipAction(clip);action.setEffectiveWeight(0).play();if(clip.name==='Death'){action.setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;}actions[clip.name]=action;}
  actions.Idle.setEffectiveWeight(1);mixer.update(0);root.updateMatrixWorld(true);
  const previous=new THREE.Vector3(),p=new THREE.Vector3(),localVelocity=new THREE.Vector3(),q=new THREE.Quaternion(),right=new THREE.Vector3(),left=new THREE.Vector3(),direction=new THREE.Vector3(),grip=new THREE.Vector3(...RIFLE_RIGHT_GRIP),gripOffset=new THREE.Vector3(),axis=new THREE.Vector3(0,1,0);
  let key=null,at=0,speed=0,pending=0,lastState='moving',lod=-1;
  const weights={Idle:1};
  const setLod=value=>{if(lod===value)return;lod=value;for(const mesh of meshes){const visible=mesh.userData.operatorLod===value;mesh.visible=visible;mesh.userData.operatorShell.visible=visible;}};
  setLod(0);
  return { root,footZ:0,realistic:true,rig:null,mixer,bones,rifle,
    setColor(color){identityColor.setHex(color);if(!definition.isDesktop){bodyMaterial.color.copy(identityColor);bodyMaterial.emissive.copy(identityColor);}},
    setOcclusion(color,opacity){occluded.color.setHex(color);occluded.opacity=opacity;},
    // These are the operator's base clothes. Gear levels do not identify a mesh.
    setGear(){},
    update(source,camera,now,detail=0,quality='performance'){
      root.getWorldPosition(p);let dt=Math.max(0,Math.min(.1,(now-at)/1000));at=now;
      const identity=source.key||source.name;
      if(key!==identity){key=identity;previous.copy(p);speed=0;pending=0;dt=0;lastState='moving';for(const a of Object.values(actions)){a.reset().setEffectiveWeight(0).play();}actions.Idle.setEffectiveWeight(1);for(const k of Object.keys(weights))delete weights[k];weights.Idle=1;}
      localVelocity.copy(p).sub(previous);previous.copy(p);
      const measured=dt>0?Math.hypot(localVelocity.x,localVelocity.y)/dt:0;
      if(measured<15)speed+=(measured-speed)*(1-Math.exp(-dt*7));else speed=0;
      root.getWorldQuaternion(q).invert();localVelocity.applyQuaternion(q);
      const distance=camera.position.distanceTo(p),current=operatorState(source),armed=hasHeldWeapon(source),fishing=hasFishingRod(source);
      setLod(detail===1&&asset.lowTriangles>0?1:0);pending+=dt;
      if(pending<Math.max(animationStep(distance,quality),detail===1?(quality==='high'?1/24:1/12):0)&&current===lastState)return;
      dt=pending;pending=0;
      if(current==='Death'&&lastState!=='Death')actions.Death.reset().play();
      const forward=localVelocity.x===0&&localVelocity.y===0?1:localVelocity.x;
      let target=current==='moving'?locomotionWeights(speed,forward,localVelocity.y):{[current]:1};
      if(current==='Swim'){
        const moving=Math.min(1,speed/1.2);target={Swim:moving,SwimIdle:1-moving};
      }
      if(!armed&&!fishing&&current==='moving'&&target.Idle&&actions.Relaxed){target={...target,Relaxed:target.Idle,Idle:0};}
      if(!actions.Sprint&&target.Sprint){target.Run=(target.Run||0)+target.Sprint;target.Sprint=0;}
      for(const name of ['Backward','Left','Right'])if(!actions[name]&&target[name]){target.Walk=(target.Walk||0)+target[name];target[name]=0;}
      if(current!=='moving'&&!actions[current])target={Idle:1};
      const blend=1-Math.exp(-dt*10);
      for(const [name,action]of Object.entries(actions)){
        weights[name]=(weights[name]||0)+((target[name]||0)-(weights[name]||0))*blend;
        if(!target[name]&&weights[name]<.0001)weights[name]=0;
        action.enabled=weights[name]>0;action.setEffectiveWeight(weights[name]);
      }
      const walkRate=THREE.MathUtils.clamp(speed/1.8,.7,1.5);for(const name of ['Walk','Backward','Left','Right'])actions[name]?.setEffectiveTimeScale(walkRate);
      mixer.update(dt);lastState=current;root.updateMatrixWorld(true);
      const canHold=!['Death','Downed','Swim','Fall'].includes(current);
      rifle.visible=armed&&canHold;
      rod.visible=fishing&&canHold;
      if(rod.visible){bones.RightHand.getWorldPosition(right);root.worldToLocal(right);rod.position.copy(right);rod.rotation.set(0,-.28,0);}
      if(rifle.visible){
        bones.RightHand.getWorldPosition(right);bones.LeftHand.getWorldPosition(left);root.worldToLocal(right);root.worldToLocal(left);direction.copy(left).sub(right);
        const yaw=Math.atan2(direction.y,direction.x),pitch=Math.atan2(direction.z,Math.hypot(direction.x,direction.y))-Math.atan2(.04,.32);
        rifle.rotation.set(0,-pitch,yaw,'ZYX');rifle.position.copy(right).sub(gripOffset.copy(grip).applyQuaternion(rifle.quaternion));
      }
    },
    inspect(){return {lod,speed,state:lastState,identityColor:identityColor.getHex(),weights:{...weights},highTriangles:asset.highTriangles,lowTriangles:asset.lowTriangles};},
    dispose(){mixer.stopAllAction();mixer.uncacheRoot(model);const skeletons=new Set();model.traverse(o=>{if(o.isSkinnedMesh)skeletons.add(o.skeleton);});for(const s of skeletons)s.dispose();occluded.dispose();bodyMaterial.dispose();}
  };
}
