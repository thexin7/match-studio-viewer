import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hasHeldWeapon } from './operator-motion.js?v=1.1.0';

export function firstPersonWeaponVisible(source) {
  return !!source && !source.dead && source.alive !== false && source.status_key !== 'down'
    && source.status_key !== 'dying' && source.life_state !== 'downed' && source.pose?.movement !== 'swim'
    && (hasHeldWeapon(source) || /匕首|刀/.test(source.weapon || ''));
}

// A generic firearm viewmodel: weapon names remain authoritative, but the feed
// does not provide attachment meshes, recoil or reload animation events.
function positionFirstPersonWeapon(root,camera,speed,phase,lift=0) {
  const depth=.65,halfHeight=depth*Math.tan(camera.fov*Math.PI/360);
  const scale=Math.max(.45,Math.min(1,camera.aspect));
  const sway=Math.min(1,speed/2);
  root.scale.setScalar(scale);
  root.position.set(halfHeight*camera.aspect*.2+Math.sin(phase)*.009*sway*scale,
    -halfHeight*.45+(Math.abs(Math.cos(phase))*.009*sway+lift)*scale,-depth);
  root.rotation.set(0,0,Math.sin(phase)*.012*sway);
}

export function createFirstPersonWeapon(camera) {
  const root=new THREE.Group();camera.add(root);root.visible=false;
  const gun=new THREE.Group(),nativeGun=new THREE.Group(),knife=new THREE.Group(),hands=new THREE.Group(),leftHand=new THREE.Group();
  root.add(gun,nativeGun,knife,hands,leftHand);let parts=gun,knifeRequested=false,mp5Requested=false,mp5Ready=false;
  const metal=new THREE.MeshStandardMaterial({color:0x58636e,roughness:.5,metalness:.25,transparent:true,depthTest:false,depthWrite:false});
  const grip=new THREE.MeshStandardMaterial({color:0x151b1f,roughness:.95,transparent:true,depthTest:false,depthWrite:false});
  const cloth=new THREE.MeshStandardMaterial({color:0x425449,roughness:1,transparent:true,depthTest:false,depthWrite:false});
  const box=(size,position,material)=>{
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(...size),material);
    mesh.position.set(...position);mesh.renderOrder=10000;mesh.userData.radarExcludeFromSsao=true;parts.add(mesh);return mesh;
  };
  const rounded=(radius,length,position,material)=>{
    const mesh=new THREE.Mesh(new THREE.CapsuleGeometry(radius,length,6,12),material);
    mesh.rotation.x=Math.PI/2;mesh.position.set(...position);mesh.renderOrder=10000;
    mesh.userData.radarExcludeFromSsao=true;parts.add(mesh);return mesh;
  };
  box([.08,.10,.36],[0,0,-.12],metal);
  box([.065,.065,.22],[0,.012,-.40],grip);
  rounded(.013,.16,[0,.015,-.59],metal);
  box([.055,.13,.06],[0,-.10,-.07],grip).rotation.x=-.18;
  box([.065,.17,.065],[0,-.12,-.22],metal).rotation.x=.12;
  box([.07,.09,.20],[0,-.025,.13],grip);
  box([.009,.035,.065],[-.026,.07,-.10],metal);
  box([.009,.035,.065],[.026,.07,-.10],metal);
  box([.06,.009,.065],[0,.092,-.10],metal);
  box([.008,.025,.018],[0,.068,-.43],metal);
  for(let i=0;i<6;i++)box([.082,.012,.013],[0,.055,-.22-i*.029],metal);
  parts=hands;
  rounded(.037,.045,[.03,-.075,.005],grip);
  const rightArm=rounded(.052,.20,[.065,-.19,.05],cloth);
  rightArm.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),new THREE.Vector3(.07,-.245,.095).normalize());
  parts=leftHand;
  rounded(.037,.045,[-.035,-.065,-.31],grip);
  const arm=rounded(.052,.48,[-.1175,-.2575,-.105],cloth);
  arm.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),new THREE.Vector3(.165,.385,-.41).normalize());
  // These rigid parts move together; merge them by material instead of issuing
  // one draw call for every rail, grip and sleeve segment.
  for(const group of [gun,hands,leftHand]){
    const batches=new Map();
    for(const mesh of group.children){mesh.updateMatrix();const list=batches.get(mesh.material)||[];list.push(mesh.geometry.clone().applyMatrix4(mesh.matrix));batches.set(mesh.material,list);mesh.geometry.dispose();}
    group.clear();
    for(const [material,geometries]of batches){const mesh=new THREE.Mesh(mergeGeometries(geometries,false),material);for(const geometry of geometries)geometry.dispose();mesh.renderOrder=10000;mesh.userData.radarExcludeFromSsao=true;group.add(mesh);}
  }
  /* 视模动作只来自位置变化（数据没有开火、换弹、冲刺事件）：
     - 步伐晃动按水平速度，腾空（movement=fall）时收回；步频随速度略升，约 3 Hz 上下、1.6 Hz 左右。
     - 竖直惯性：上升时枪略下沉、下落时略上飘、落地回弹；临界阻尼弹簧，幅度限制在 3 cm。 */
  const position=new THREE.Vector3(),previous=new THREE.Vector3();
  let hasPrevious=false,lastAt=0,speed=0,phase=0,lift=0,liftVelocity=0;
  return {
    update(source,active,now) {
      root.visible=active&&firstPersonWeaponVisible(source);
      if(!root.visible){hasPrevious=false;lastAt=now;speed=0;lift=0;liftVelocity=0;return;}
      const holdingKnife=/匕首|刀/.test(source.weapon || '');
      const holdingMP5=/MP5/i.test(source.weapon || '');
      gun.visible=!holdingKnife&&!(holdingMP5&&mp5Ready);nativeGun.visible=!holdingKnife&&holdingMP5&&mp5Ready;
      leftHand.visible=!holdingKnife;knife.visible=holdingKnife;
      hands.position.set(0,holdingMP5 && mp5Ready ? .06 : 0,holdingMP5 && mp5Ready ? .09 : 0);
      leftHand.position.set(holdingMP5 && mp5Ready ? .035 : 0,holdingMP5 && mp5Ready ? .10 : 0,holdingMP5 && mp5Ready ? .07 : 0);
      if(holdingMP5&&!mp5Requested){
        mp5Requested=true;
        new GLTFLoader().loadAsync('/ui/models/equipment/mp5-standard.glb?v=7744380873b4').then(gltf=>{
          const model=gltf.scene;model.rotation.set(-.10,Math.PI+.15,.06,'YXZ');
          model.traverse(mesh=>{if(!mesh.isMesh)return;mesh.material=metal;mesh.renderOrder=10000;mesh.frustumCulled=false;mesh.userData.radarExcludeFromSsao=true;});
          nativeGun.add(model);mp5Ready=true;
        }).catch(error=>console.warn('[第一视角 MP5] 加载失败，保留通用视模',error));
      }
      if(holdingKnife&&!knifeRequested){
        knifeRequested=true;
        new GLTFLoader().loadAsync('/ui/models/equipment/tactical-knife.glb?v=f11c01ee730a').then(gltf=>{
          const model=gltf.scene;model.rotation.set(0,Math.PI/2,Math.PI+.2,'ZYX');model.position.set(.03,.02,0);
          const blade=metal.clone();blade.color.setHex(0xa5afb8);blade.metalness=.35;
          blade.onBeforeCompile=shader=>{
            shader.vertexShader='varying float knifeY;\n'+shader.vertexShader;
            shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nknifeY=position.y;');
            shader.fragmentShader='varying float knifeY;\n'+shader.fragmentShader;
            shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\ndiffuseColor.rgb*=knifeY>-.015?0.14:1.0;');
          };
          blade.customProgramCacheKey=()=> 'knife-handle-v1';
          model.traverse(mesh=>{if(!mesh.isMesh)return;mesh.material=blade;mesh.renderOrder=10000;mesh.frustumCulled=false;mesh.userData.radarExcludeFromSsao=true;});
          knife.add(model);
        }).catch(error=>console.warn('[第一视角刀具] 加载失败',error));
      }
      position.set(source.x,source.y,source.z).multiplyScalar(.01);
      const dt=Math.min(.1,Math.max(0,(now-lastAt)/1000));lastAt=now;
      let horizontal=0,vertical=0;
      if(hasPrevious&&dt>0&&position.distanceTo(previous)<1){
        horizontal=Math.hypot(position.x-previous.x,position.y-previous.y)/dt;vertical=(position.z-previous.z)/dt;
      }
      previous.copy(position);hasPrevious=true;
      const airborne=source.pose?.movement==='fall';
      speed+=((airborne?0:Math.min(7,horizontal))-speed)*(1-Math.exp(-dt*10));
      phase+=dt*(speed>.2?6+speed:0);
      const step=Math.min(.05,dt),liftTarget=Math.max(-.03,Math.min(.03,-vertical*.008));
      liftVelocity+=((liftTarget-lift)*120-liftVelocity*22)*step;lift+=liftVelocity*step;
      positionFirstPersonWeapon(root,camera,speed,phase,lift);
    },
  };
}
