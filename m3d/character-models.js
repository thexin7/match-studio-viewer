import * as THREE from 'three';
import { loadOperatorAsset, operatorAssetState, createRealisticOperator } from './operator-model.js?v=1.1.0';
import { operatorDefinition, characterDetail } from './character-detail.js?v=1.1.0';
export const MODEL_IDS=['tactical','mannequin','beacon','capsule'];
const CAPSULE_FOOT_Z=-.9;
const GEAR_COLORS=[0x9ca3af,0xe5e7eb,0x67d783,0x5aa3ff,0xb778f2,0xf1b44c,0xf15b64];
const ANIM_LOD_M=60;

/* tactical 的程序化骨架：关节都是 Group，网格挂在关节下；以脚底为原点（z=0），X 朝前、Y 朝左。
   body → pelvis → spine → neck / 左右肩 → 肘，pelvis → 左右髋 → 膝。
   可见与 x 光两遍各建一套同构骨架，动画每帧把同一组关节值写进两套，保证剪影与可见几何一致。 */
function buildRig(part,m){
 const g=(parent,x,y,z)=>{const j=new THREE.Group();j.position.set(x,y,z);if(parent)parent.add(j);return j;};
 const box=(parent,size,pos,mat)=>part(parent,new THREE.BoxGeometry(...size),mat,pos);
 const limb=(parent,r,len,z,mat)=>part(parent,new THREE.CapsuleGeometry(r,len,3,8),mat,[0,0,z],[Math.PI/2,0,0]);
 const rig={};
 rig.body=g(null,0,0,0);
 rig.pelvis=g(rig.body,0,0,.94);
 box(rig.pelvis,[.22,.32,.16],[0,0,.02],m.dark);
 rig.spine=g(rig.pelvis,0,0,.06);
 box(rig.spine,[.24,.38,.46],[0,0,.25],m.body);
 rig.vest=[box(rig.spine,[.07,.34,.32],[.14,0,.27],m.vest),box(rig.spine,[.05,.32,.30],[-.135,0,.27],m.vest)];
 rig.pack=box(rig.spine,[.20,.34,.40],[-.26,0,.26],m.pack);
 rig.neck=g(rig.spine,0,0,.50);
 part(rig.neck,new THREE.SphereGeometry(.115,12,8),m.body,[.01,0,.14]);
 box(rig.neck,[.045,.17,.07],[.115,0,.14],m.visor);
 rig.helmet=part(rig.neck,new THREE.SphereGeometry(.135,14,8,0,Math.PI*2,0,Math.PI*.55),m.helmet,[0,0,.155]);
 rig.shoulder=[];rig.elbow=[];rig.hip=[];rig.knee=[];
 for(const [k,sign] of [[0,1],[1,-1]]){
   const sh=g(rig.spine,0,sign*.23,.43);limb(sh,.055,.20,-.15,m.dark);
   const el=g(sh,0,0,-.29);limb(el,.05,.17,-.12,m.dark);part(el,new THREE.SphereGeometry(.05,8,6),m.dark,[0,0,-.26]);
   const hp=g(rig.pelvis,0,sign*.10,0);limb(hp,.075,.26,-.21,m.body);
   const kn=g(hp,0,0,-.44);limb(kn,.06,.28,-.21,m.dark);box(kn,[.26,.11,.09],[.05,0,-.455],m.dark);
   rig.shoulder[k]=sh;rig.elbow[k]=el;rig.hip[k]=hp;rig.knee[k]=kn;
 }
 rig.rifle=g(rig.spine,.22,-.11,.22);
 box(rig.rifle,[.62,.055,.10],[.05,0,0],m.rifle);box(rig.rifle,[.30,.03,.03],[.50,0,.02],m.rifle);
 box(rig.rifle,[.06,.04,.14],[.04,0,-.10],m.rifle);box(rig.rifle,[.18,.05,.11],[-.30,0,-.02],m.rifle);
 return rig;
}

export function buildCharacterModel(style,options={}){
 const occluded=!!options.occluded;
 const root=new THREE.Group(), colored=[],geometries=[],materials=[];
 const m={};
 if(occluded){
   m.body=new THREE.MeshBasicMaterial({color:0xff4058,depthTest:true,depthFunc:THREE.GreaterDepth,depthWrite:false,transparent:true,opacity:.72,fog:false});
   m.dark=m.visor=m.helmet=m.vest=m.pack=m.rifle=m.body;materials.push(m.body);
 }else{
   const std=(color,roughness=.8,metalness=0)=>{const x=new THREE.MeshStandardMaterial({color,roughness,metalness});materials.push(x);return x;};
   m.body=std(0x49d5ff,.68,.15);m.dark=std(0x182530);
   m.visor=new THREE.MeshStandardMaterial({color:0x9defff,emissive:0x184358,roughness:.2,metalness:.45});materials.push(m.visor);
   m.helmet=std(GEAR_COLORS[0],.55,.2);m.vest=std(GEAR_COLORS[0],.7,.1);m.pack=std(0x3b4436,.9);m.rifle=std(0x1d2126,.5,.4);
 }
 const part=(parent,g,mat,pos,rotation=null)=>{geometries.push(g);const mesh=new THREE.Mesh(g,mat);mesh.position.set(...pos);if(rotation)mesh.rotation.set(...rotation);mesh.userData.radarExcludeFromSsao=occluded;mesh.userData.radarLitSurface=!occluded;mesh.userData.radarEntitySurface=!occluded;if(occluded)mesh.renderOrder=1001;(parent||root).add(mesh);if(mat===m.body)colored.push(mesh);return mesh;};
 const box=(size,pos,mat=m.body)=>part(null,new THREE.BoxGeometry(...size),mat,pos);
 const sphere=(r,pos,mat=m.body)=>part(null,new THREE.SphereGeometry(r,12,8),mat,pos);
 const limb=(r,length,pos,mat=m.body)=>part(null,new THREE.CapsuleGeometry(r,length,3,8),mat,pos,[Math.PI/2,0,0]);
 let rig=null;
 if(style==='beacon'){
   part(null,new THREE.CylinderGeometry(.30,.38,.12,24),m.dark,[0,0,-.83],[Math.PI/2,0,0]);
   part(null,new THREE.OctahedronGeometry(.42,0),m.body,[0,0,.06]);
   part(null,new THREE.ConeGeometry(.20,.40,3),m.body,[.32,0,.67],[0,0,-Math.PI/2]);
 }else if(style==='tactical'){
   rig=buildRig(part,m);root.add(rig.body);
 }else{
   limb(.22,.20,[0,0,.13]);
   sphere(.19,[0,0,.68]);
   for(const sign of [-1,1]){
     limb(.075,.37,[0,sign*.34,.08]);
     sphere(.083,[.03,sign*.34,-.18]);
     limb(.095,.39,[0,sign*.14,-.44]);
     box([.32,.18,.14],[.06,sign*.14,-.81],m.dark);
   }
 }
 root.updateMatrixWorld(true);
 const footZ=new THREE.Box3().setFromObject(root).min.z;
 root.userData.style=style;
 root.userData.occluded=occluded;
 root.userData.footZ=footZ;
 return {root,footZ,rig,setColor(c){m.body.color.setHex(c);},setOpacity(o){if(occluded)m.body.opacity=o;},
  setGear(helmet,vest,bag,colors){
   if(!rig)return;
   const C=Array.isArray(colors)?colors:GEAR_COLORS;
   rig.helmet.visible=helmet>0;for(const p of rig.vest)p.visible=vest>0;rig.pack.visible=bag>0;
   if(!occluded){m.helmet.color.setHex(C[helmet]??C[0]);m.vest.color.setHex(C[vest]??C[0]);}
   // 背包按等级变大：贴着背甲向后、向上长，正面始终贴在背上
   const k=.7+.12*Math.max(1,Math.min(6,bag||1));
   rig.pack.scale.set(k,1,k);rig.pack.position.set(-(.16+.10*k),0,.24+.06*k);
  },
  dispose(){for(const g of geometries)g.dispose();for(const x of new Set(materials))x.dispose();}};
}

export function syncCharacterModel(entity,style,options={}){
 const id=MODEL_IDS.includes(style)?style:'tactical';
 const base=id==='tactical'?operatorDefinition(options.hero):null;
 const preferred=options.quality==='high'&&base?.desktop?base.desktop:base;
 if(preferred&&operatorAssetState(preferred)==='idle')loadOperatorAsset(preferred);
 if(base&&preferred!==base&&operatorAssetState(preferred)==='error'&&operatorAssetState(base)==='idle')loadOperatorAsset(base);
 let definition=preferred&&operatorAssetState(preferred)==='ready'?preferred:base;
 if(base&&operatorAssetState(definition)!=='ready'&&entity.operatorSource?.id===base.id)definition=entity.operatorSource;
 const realistic=!!definition&&operatorAssetState(definition)==='ready';
 const assetKey=realistic?definition.src:null;
 const helmetLv=options.helmetLv|0,armorLv=options.armorLv|0,bagLv=options.bagLv|0;
 // 每帧都会调用：输入不变就不再逐个改 mesh 的可见性、缩放与材质颜色
 const sig=[id,assetKey,options.scale,options.visibleColor,options.occludedColor,options.occludedOpacity,options.showHeading,options.directionStyle,options.directionAnchor,helmetLv,armorLv,bagLv].join('|');
 if(entity.modelSig===sig)return;
 entity.modelSig=sig;
 if(entity.modelStyle!==id||entity.operatorAssetKey!==assetKey){
   if(entity.customModel){entity.root.remove(entity.customModel.root);entity.customModel.dispose();entity.customModel=null;}
   if(entity.customOccludedModel){entity.root.remove(entity.customOccludedModel.root);entity.customOccludedModel.dispose();entity.customOccludedModel=null;}
   if(realistic){
     entity.customModel=createRealisticOperator(definition);entity.root.add(entity.customModel.root);
   }else if(id!=='capsule'){
     entity.customModel=buildCharacterModel(id);entity.root.add(entity.customModel.root);
     entity.customOccludedModel=buildCharacterModel(id,{occluded:true});entity.root.add(entity.customOccludedModel.root);
   }
   entity.modelStyle=id;
   entity.operatorRealistic=realistic;
   entity.operatorAssetKey=assetKey;
   entity.operatorSource=realistic?definition:null;
   entity.characterDetail=-1;
   if(entity.charAnim)entity.charAnim.applied=-1;
 }
 const scale=THREE.MathUtils.clamp(Number(options.scale)||1,.5,2);
 const visibleColor=Number.isFinite(options.visibleColor)?options.visibleColor:entity.capsule.material.color.getHex();
 const occludedColor=Number.isFinite(options.occludedColor)?options.occludedColor:(entity.occCapsule?.material.color.getHex()??0xff4058);
 entity.root.scale.setScalar(1);
 entity.capsule.visible=id==='capsule';
 entity.capsule.scale.setScalar(scale);entity.capsule.position.z=CAPSULE_FOOT_Z-CAPSULE_FOOT_Z*scale;
 if(entity.occCapsule){entity.occCapsule.visible=id==='capsule';entity.occCapsule.scale.setScalar(scale);entity.occCapsule.position.z=CAPSULE_FOOT_Z-CAPSULE_FOOT_Z*scale;entity.occCapsule.material.color.setHex(occludedColor);}
 const directionStyle=options.directionStyle==='line'?'line':'arrow';
 const directionAnchor=options.directionAnchor==='foot'?'foot':'head';
 const headingZ=directionAnchor==='foot'?CAPSULE_FOOT_Z+.08:CAPSULE_FOOT_Z+1.8*scale;
 for(const [headingId,pair] of Object.entries(entity.headings||{}))for(const [pass,mesh] of Object.entries(pair)){
  mesh.visible=options.showHeading!==false&&headingId===directionStyle;
  mesh.scale.setScalar(scale);
  mesh.position.set((headingId==='line'?.9:1.1)*scale,0,headingZ);
  mesh.material.color.setHex(pass==='occluded'?occludedColor:visibleColor);
 }
 if(entity.hpBar?.group){entity.hpBar.group.scale.setScalar(scale);entity.hpBar.group.position.x=-.55*scale;}
 for(const model of [entity.customModel,entity.customOccludedModel])if(model){model.root.scale.setScalar(scale);model.root.position.z=CAPSULE_FOOT_Z-model.footZ*scale;model.setGear(helmetLv,armorLv,bagLv,options.gearColors);}
 entity.capsule.material.color.setHex(visibleColor);
 entity.customModel?.setColor(visibleColor);
 entity.customOccludedModel?.setColor(occludedColor);
 // 掩体后（x 光）一遍的透明度：队伍色模式下用更淡的同色，区分「可见 / 被挡」
 const occludedOpacity=Number.isFinite(options.occludedOpacity)?options.occludedOpacity:null;
 if(occludedOpacity!=null){
   entity.customModel?.setOcclusion?.(occludedColor,occludedOpacity);
  entity.customOccludedModel?.setOpacity(occludedOpacity);
  if(entity.occCapsule)entity.occCapsule.material.opacity=Math.min(1,occludedOpacity*.85);
  for(const pair of Object.values(entity.headings||{}))pair.occluded.material.opacity=Math.min(1,occludedOpacity+.08);
 }
 entity.modelVisibleColor=visibleColor;entity.modelOccludedColor=occludedColor;
 entity.modelFootZ=CAPSULE_FOOT_Z;
 entity.headingStyle=directionStyle;entity.headingAnchor=directionAnchor;
 entity.modelRenderedFootZ=id==='capsule'
  ? entity.capsule.position.z+CAPSULE_FOOT_Z*scale
  : entity.customModel.root.position.z+entity.customModel.footZ*scale;
}

/* ---------------------------------------------------------------- 程序化动画
   姿态 = 关节值数组：[身体俯仰, 骨盆高, 脊柱前倾, 颈, 左髋俯仰, 左髋外展, 左膝, 右髋俯仰, 右髋外展, 右膝,
   左肩俯仰, 左肩外展, 左肘, 右肩俯仰, 右肩外展, 右肘, 持枪, 身体前移, 身体抬高]。
   阵亡时身体绕脚底向前扑倒（绕 Y 转 90°），再前移半个身长、抬高胸厚，让尸体居中贴地。绕 Y 负值 = 向前摆，绕 X 正值 = 向 +Y 摆。
   站立/走跑由逐帧位置差估出的水平速度驱动；倒地（跪姿）与阵亡（扑倒）是常量姿态，按权重平滑过渡。
   全部用模块级预分配数组，每帧零分配；60m 外与镜头背后的人物不做逐帧动画，只在状态变化时摆一次静态姿态。 */
const POSE_N=19;
const DOWN_POSE=Float32Array.of(0,.56,.55,-.35, -.15,.06,1.60, -.15,-.06,1.60, -.30,.10,-.20, -.65,-.20,-1.60, 0, 0,0);
const DEAD_POSE=Float32Array.of(Math.PI/2,.94,0,.15, 0,.16,.05, 0,-.16,.05, -2.4,.55,-.25, -2.4,-.55,-.25, 0, -.9,.24);
const _alive=new Float32Array(POSE_N),_pose=new Float32Array(POSE_N);
const smooth=(cur,target,dt,rate)=>cur+(target-cur)*(1-Math.exp(-dt*rate));

function applyPose(rig,p){
 rig.body.rotation.y=p[0];rig.pelvis.position.z=p[1];rig.spine.rotation.y=p[2];rig.neck.rotation.y=p[3];
 rig.hip[0].rotation.y=p[4];rig.hip[0].rotation.x=p[5];rig.knee[0].rotation.y=p[6];
 rig.hip[1].rotation.y=p[7];rig.hip[1].rotation.x=p[8];rig.knee[1].rotation.y=p[9];
 rig.shoulder[0].rotation.y=p[10];rig.shoulder[0].rotation.x=p[11];rig.elbow[0].rotation.y=p[12];
 rig.shoulder[1].rotation.y=p[13];rig.shoulder[1].rotation.x=p[14];rig.elbow[1].rotation.y=p[15];
 rig.rifle.visible=p[16]>.5;rig.body.position.x=p[17];rig.body.position.z=p[18];
}

function alivePose(a,dt,animate){
 const s=animate?a.speed:0,walk=Math.min(1,s/1.6),run=THREE.MathUtils.clamp((s-3)/3,0,1);
 let legAmp=walk*(.5+.25*run);
 if(animate){
   const stride=THREE.MathUtils.clamp(1.1+.3*s,1,3);
   a.phase+=dt*s/stride*Math.PI*2;
   // 原地转身：速度很小但朝向在变时迈小碎步
   const turn=s<.4?Math.min(1,Math.abs(a.yawRate)/2):0;
   if(turn>0){a.phase+=dt*turn*Math.PI*3;legAmp=Math.max(legAmp,.25*turn);}
   a.breath+=dt*Math.PI*2/3.6;
   if(a.phase>1e4)a.phase-=Math.PI*2*1000;if(a.breath>1e4)a.breath-=Math.PI*2*1000;
 }
 const sp=Math.sin(a.phase),cp=Math.cos(a.phase),br=animate?Math.sin(a.breath):0,knee=(.5+.7*run)*legAmp*1.6;
 const p=_alive;
 p[0]=0;p[1]=.94-.03*walk*(1-Math.cos(2*a.phase))*.5+.004*br;
 p[2]=.04+.06*walk+.16*run+.015*br;p[3]=-.03-.06*run-.01*br;
 p[4]=-sp*legAmp;p[5]=.05;p[6]=.08+knee*Math.max(0,cp);
 p[7]=sp*legAmp;p[8]=-.05;p[9]=.08+knee*Math.max(0,-cp);
 const bob=.06*walk*sp;
 p[10]=-.83+bob;p[11]=-1.04;p[12]=-.15;
 p[13]=-.25-bob;p[14]=-.30;p[15]=-1.5;
 p[16]=1;p[17]=0;p[18]=0;
 return p;
}

const _viewPosition=new THREE.Vector3(),_projectedPosition=new THREE.Vector3();
export function animateCharacterModel(entity,src,camera,now=performance.now(),viewportHeight=900,quality='balanced'){
 entity.root.getWorldPosition(_viewPosition);
 _viewPosition.applyMatrix4(camera.matrixWorldInverse);
 const depth=-_viewPosition.z,scale=entity.capsule.scale.z;
 const pixels=depth>0?1.8*scale*camera.projectionMatrix.elements[5]*viewportHeight/(2*(camera.isOrthographicCamera?1:depth)):0;
 _projectedPosition.copy(_viewPosition).applyMatrix4(camera.projectionMatrix);
 const extent=pixels/Math.max(1,viewportHeight);
 const inView=entity.root.visible&&depth>0&&Math.abs(_projectedPosition.x)<1.1+extent/Math.max(.1,camera.aspect||1)&&Math.abs(_projectedPosition.y)<1.1+extent;
 const detail=characterDetail(pixels,entity.characterDetail,quality);
 entity.characterDetail=detail;
 const simplified=detail===2&&entity.modelStyle==='tactical';
 if(entity.customModel)entity.customModel.root.visible=inView&&!simplified;
 if(entity.customOccludedModel)entity.customOccludedModel.root.visible=inView&&!simplified;
 entity.capsule.visible=inView&&(entity.modelStyle==='capsule'||simplified);
 if(entity.occCapsule)entity.occCapsule.visible=entity.capsule.visible;
 if(!inView||simplified){
   // Reset velocity history on re-entry: time spent culled is not a movement sample.
   if(entity.charAnim)entity.charAnim.t=0;
   return;
 }
 if(entity.customModel?.realistic){
   entity.customModel.update(src,camera,now,detail,quality);
   return;
 }
 const rig=entity.customModel?.rig,rigOcc=entity.customOccludedModel?.rig;
 if(!rig)return;
 const a=entity.charAnim||(entity.charAnim={key:null,t:0,x:0,y:0,yaw:0,speed:0,yawRate:0,phase:0,breath:Math.random()*6,downW:0,deadW:0,applied:-1});
 const pos=entity.root.position,key=entity.root.userData.entityKey;
 let dt=(now-a.t)/1000;a.t=now;
 const reset=a.key!==key||!(dt>0)||dt>.5;
 if(reset){a.key=key;a.x=pos.x;a.y=pos.y;a.yaw=entity.root.rotation.z;a.speed=0;a.yawRate=0;dt=0;a.applied=-1;}
 const dx=pos.x-a.x,dy=pos.y-a.y;a.x=pos.x;a.y=pos.y;
 let dyaw=entity.root.rotation.z-a.yaw;a.yaw=entity.root.rotation.z;
 dyaw-=Math.round(dyaw/(Math.PI*2))*Math.PI*2;
 if(dt>0){
   const v=Math.hypot(dx,dy)/dt;
   // 瞬移（换人、跳转、超距回填）不计入速度
   if(v<15){a.speed=smooth(a.speed,v,dt,4);a.yawRate=smooth(a.yawRate,dyaw/dt,dt,4);}
 }
 const dead=src?.alive===false||src?.dead===true;
 const down=!dead&&(src?.status_key==='down'||src?.status_key==='dying');
 const cam=camera.position,cx=pos.x-cam.x,cy=pos.y-cam.y,cz=pos.z-cam.z,dist=Math.hypot(cx,cy,cz);
 const e=camera.matrixWorld.elements;
 const behind=dist>4&&(-e[8]*cx-e[9]*cy-e[10]*cz)<-.2*dist;
 const animate=entity.root.visible&&(detail===0||dist<=ANIM_LOD_M)&&!behind;
 if(!animate){
   // 不动画时直接落到目标状态；只在状态变化时摆一次姿态
   a.deadW=dead?1:0;a.downW=down?1:0;
   const code=dead?2:down?1:0;
   if(a.applied===code)return;
   a.applied=code;
 }else{
   a.deadW=reset?(dead?1:0):smooth(a.deadW,dead?1:0,dt,3);
   a.downW=reset?(down?1:0):smooth(a.downW,down?1:0,dt,3);
   a.applied=-1;
 }
 const al=alivePose(a,dt,animate),p=_pose,w1=a.downW,w2=a.deadW;
 for(let i=0;i<POSE_N;i++){const v=al[i]+(DOWN_POSE[i]-al[i])*w1;p[i]=v+(DEAD_POSE[i]-v)*w2;}
 applyPose(rig,p);
 if(rigOcc)applyPose(rigOcc,p);
}
