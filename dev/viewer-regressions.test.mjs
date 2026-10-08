import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as THREE from '../vendor/three/build/three.module.js';
import { aimOf, aimDirection, viewOf, blendPose, PosePresenter, CHARACTER_ROOT_ABOVE_MESH_M } from '../m3d/gateway-pose.js';
import { hasHeldWeapon, operatorState } from '../m3d/operator-motion.js';
import { buildRayGrid, raycastRayGrid, clipSegmentToBox } from '../m3d/map-raycast.js';

const renderer = fs.readFileSync(new URL('../m3d/korr-renderer.js', import.meta.url), 'utf8');
const adapter = fs.readFileSync(new URL('../m3d/korr-adapter.js', import.meta.url), 'utf8');
const model = fs.readFileSync(new URL('../ui/radar/model.js', import.meta.url), 'utf8');
const loadModel = (sandbox = {}) => { const ctx = vm.createContext({ ...sandbox }); vm.runInContext(model, ctx); return ctx; };

test('position samples with different origins are never interpolated together', () => {
  const actor={world:[100,200,386],position_origin:'actor'},mesh={world:[100,200,300],position_origin:'mesh'};
  assert.equal(blendPose(actor,mesh,.5),mesh);
  const view=viewOf({self:[100,200,300],self_position_origin:'mesh',self_up_loc:[100,200,386],self_aim_yaw:0,self_pitch:0,self_aim_age_ms:10});
  assert.deepEqual(view.world,[100,200,386]);assert.equal(view.origin,'mesh-normalized');
});

test('own first person does not allocate or animate an invisible third person avatar', () => {
  const start=renderer.indexOf('function updateSelf(');
  const ctx=vm.createContext({THREE,selfEntity:{root:new THREE.Group()},
    cameraMode:'firstPerson',CAMERA_MODES:{FIRST_PERSON:'firstPerson'},followTarget:{kind:'self'},
    ueToThreeX:x=>x/100,ueToThreeY:y=>-y/100,ueToThreeZ:z=>z/100});
  vm.runInContext(renderer.slice(start,renderer.indexOf('\nfunction _hideFirstPersonFollowedEntity',start)),ctx);
  vm.runInContext('updateSelf({x:100,y:200,z:300})',ctx);
  assert.equal(ctx.selfEntity.root.visible,false);
  assert.deepEqual(ctx.selfEntity.root.position.toArray(),[1,-2,3]);
});

test('AI units use a soldier model and keep spawn-position uncertainty visible', () => {
  const start=renderer.indexOf('function updateAIs('),models=[],labels=[];
  const ctx=vm.createContext({THREE,POOL:{ais:[]},POOL_SIZE:{ais:0},scene:{add(){}},window:{AppState:{display:{}}},
    buildPlayerEntity:()=>({root:new THREE.Group(),sprite:{},hpBar:null}),
    ueToThreeX:x=>x/100,ueToThreeY:y=>-y/100,ueToThreeZ:z=>z/100,ueYawToThreeRotZ:y=>-y*Math.PI/180,
    frameViewer:null,PALETTE:{ai:0xff0000,mate:0x00ff00},_isEnemyOfViewer:()=>true,
    syncCharacterModel:(e,style,options)=>models.push(options),animateCharacterModel(){},
    camera:new THREE.PerspectiveCamera(),performance,renderer:{domElement:{clientHeight:800}},
    _viewerRange:()=>20,_pickDetail:()=>2,_poseHeightDelta:()=>0,updateInfoCard:(sprite,info)=>labels.push(info),followTarget:null});
  vm.runInContext(renderer.slice(start,renderer.indexOf('\n/* 物资标签',start)),ctx);
  vm.runInContext('updateAIs([{key:"ai-1",name:"ai-1",displayName:"AI·士兵",kind:"ai",x:100,y:200,z:300,spawn_mark:true,hp:95,maxHp:null}])',ctx);
  assert.equal(models[0].hero,'AI通用步兵');assert.ok(labels[0].name.includes('出生点'));
  assert.equal(labels[0].hpText,'95 / ?');
});

test('automatic rendering has a bounded frame budget while explicit rates remain available', () => {
  const start=renderer.indexOf('function _renderFrameLimit(');assert.ok(start>=0);
  const ctx=vm.createContext({});vm.runInContext(renderer.slice(start,renderer.indexOf('\nlet gatewayLastSlow',start)),ctx);
  assert.equal(vm.runInContext('_renderFrameLimit(0,false,true)',ctx),60);
  assert.equal(vm.runInContext('_renderFrameLimit(0,true,true)',ctx),30);
  assert.equal(vm.runInContext('_renderFrameLimit(0,false,false)',ctx),30);
  assert.equal(vm.runInContext('_renderFrameLimit(144,false,true)',ctx),144);
});

test('first person view follows the body timeline from the upstream position instead of stepping per snapshot', () => {
  const presenter=new PosePresenter();
  const first={session:1,timestampMs:1000,self:[100,200,300],self_up_loc:[100,200,300],self_aim_yaw:0,self_pitch:0,self_aim_age_ms:10,entities:[]};
  presenter.push(first,0);
  presenter.push({...first,timestampMs:1050,self:[200,200,300],self_up_loc:[230,200,300],self_aim_yaw:90,self_pitch:40},50);
  const mid=presenter.sample(75);
  assert.deepEqual(mid.self_view.world,[165,200,300]);
  assert.equal(mid.self_view.yaw,45);assert.equal(mid.self_view.pitch,20);
  assert.equal(mid.self[0],150,'body keeps its own source');
  // 下一帧迟到时停在最新一帧，不外推
  const held=presenter.sample(200);
  assert.deepEqual((held.self_view || viewOf(held)).world,[230,200,300]);
});

test('arrival jitter does not turn steady movement into stop-and-go', () => {
  const presenter=new PosePresenter();
  // 20 Hz 快照、0–35 ms 的确定性到达抖动，本人匀速 4 m/s
  const jitter=[5,31,12,26,2,35,18,9,29,14,22,7,33,0,20,11];
  const arrivals=Array.from({length:60},(_,k)=>({ts:1000+k*50,at:k*50+jitter[k%jitter.length],x:k*20})).sort((a,b)=>a.at-b.at);
  let next=0,last=null;const speeds=[];
  for(let now=0;now<3000;now+=1000/60){
    while(next<arrivals.length&&arrivals[next].at<=now){const a=arrivals[next++];presenter.push({session:1,timestampMs:a.ts,self:[a.x,0,0],self_yaw:0,entities:[]},a.at);}
    const x=presenter.sample(now)?.self?.[0];
    if(last!=null&&x!=null&&now>600)speeds.push((x-last)*60);
    last=x;
  }
  speeds.sort((a,b)=>a-b);
  const p=q=>speeds[Math.floor(speeds.length*q)];
  assert.ok(p(.05)>340&&p(.95)<460,`速度 p5 ${p(.05)} p95 ${p(.95)} cm/s`);
});

test('first person weapon stays inside portrait and desktop viewports', () => {
  const source=fs.readFileSync(new URL('../m3d/first-person-weapon.js',import.meta.url),'utf8');
  const start=source.indexOf('function positionFirstPersonWeapon(');assert.ok(start>=0);
  const ctx=vm.createContext({THREE});vm.runInContext(source.slice(start,source.indexOf('\nexport function createFirstPersonWeapon',start)),ctx);
  for(const aspect of [390/844,16/9]){
    const camera=new THREE.PerspectiveCamera(58,aspect,.1,100);camera.updateMatrixWorld();
    const root=new THREE.Group();ctx.root=root;ctx.camera=camera;
    vm.runInContext('positionFirstPersonWeapon(root,camera,0,0)',ctx);
    const projected=root.position.clone().project(camera);
    assert.ok(Math.abs(projected.x)<.5);assert.ok(projected.y>-.7&&projected.y<0);
  }
});

test('verified rod IDs identify held equipment without inventing a fishing phase', () => {
  const ctx=loadModel({s:{entities:[{name:'teammate',curr_weapon_status:'resolved',curr_weapon_id:'18300000004',status_key:null}]}});
  vm.runInContext('normalizeNames(s)',ctx);
  assert.equal(ctx.s.entities[0].curr_weapon,'台钓竿');
  assert.equal(ctx.s.entities[0].status_key,null);
});

test('first person firearm is shown only for a living armed target', () => {
  const source=fs.readFileSync(new URL('../m3d/first-person-weapon.js',import.meta.url),'utf8');
  const start=source.indexOf('export function firstPersonWeaponVisible');
  const ctx=vm.createContext({hasHeldWeapon});vm.runInContext(source.slice(start,source.indexOf('// A generic',start)).replace('export ',''),ctx);
  for(const source of [{weapon:null},{weapon:'空手'},{weapon:'M4A1',dead:true},{weapon:'M4A1',status_key:'down'},{weapon:'M4A1',pose:{movement:'swim'}}]){
    ctx.source=source;assert.equal(vm.runInContext('firstPersonWeaponVisible(source)',ctx),false);
  }
  ctx.source={weapon:'M4A1'};assert.equal(vm.runInContext('firstPersonWeaponVisible(source)',ctx),true);
  ctx.source={weapon:'战术匕首'};assert.equal(vm.runInContext('firstPersonWeaponVisible(source)',ctx),true);
});

test('live movement and wrapped yaw are interpolated between network snapshots', () => {
  const presenter=new PosePresenter();
  const first={session:1,self:[100,200,300],self_yaw:350,entities:[{key:'one',kind:'player',world:[100,0,0],yaw:350}]};
  presenter.push(first,0);
  presenter.push({...first,self:[200,200,300],self_yaw:10,entities:[{...first.entities[0],world:[200,0,0],yaw:10}]},50);
  const halfway=presenter.sample(75);
  assert.equal(halfway.self[0],150);assert.equal(halfway.entities[0].world[0],150);
  assert.equal(halfway.entities[0].yaw,360);
  presenter.push({...first,session:2,self:[9000,0,0]},80);
  assert.equal(presenter.sample(81).self[0],9000);
});

test('live map defaults follow world coordinates rather than a saved map from another session', () => {
  const ctx=loadModel();
  ctx.maps=JSON.parse(fs.readFileSync(new URL('../m3d/manifest.json',import.meta.url))).maps;
  ctx.s={self:[343228.1,-797516.2,-16410]};
  assert.equal(vm.runInContext('inferSnapshotMap(s,maps)',ctx),'daba');
  ctx.s.self=[0,0,0];assert.equal(vm.runInContext('inferSnapshotMap(s,maps)',ctx),null);
});

test('desktop operator assets remain detailed when terrain auto quality is reduced', () => {
  const start=renderer.indexOf('function _operatorRenderQuality(');
  assert.ok(start>=0);
  const ctx=vm.createContext({requestedRenderQuality:'auto',_isMobileGpuProfile:()=>false});
  vm.runInContext(renderer.slice(start,renderer.indexOf('\n}',start)+2),ctx);
  assert.equal(vm.runInContext('_operatorRenderQuality()',ctx),'high');
  ctx.requestedRenderQuality='performance';assert.equal(vm.runInContext('_operatorRenderQuality()',ctx),'performance');
});

test('expired upstream aim cannot mix stale pitch with current body yaw', () => {
  assert.deepEqual(aimOf({self_yaw:90,self_aim_yaw:0,self_pitch:60,self_aim_age_ms:500}),{yaw:90,pitch:0});
});

test('self operator identity and stance survive the renderer adapter', () => {
  const source = adapter.slice(adapter.indexOf('export function interpolateHumans'),adapter.indexOf('function geometryFromParts')).replaceAll('export ', '');
  const ctx=vm.createContext({aimOf,viewOf,CHARACTER_ROOT_ABOVE_MESH_M,characterKind:()=>true});vm.runInContext(source,ctx);
  ctx.snapshot={self:[100,200,300],self_hero:'威龙',self_life:{downed:true},self_yaw:0,entities:[]};
  const local=vm.runInContext('toKorr(snapshot).local',ctx);
  assert.equal(local.hero,'威龙');assert.equal(local.status_key,'down');
  ctx.snapshot.entities=[{key:'one',kind:'player',world:[0,0,0],weapon:'M4A1',curr_weapon_known:true,curr_weapon_status:'empty'}];
  assert.equal(vm.runInContext('toKorr(snapshot).players[0].weapon',ctx),null);
  ctx.snapshot.self_position_origin='mesh';ctx.snapshot.entities[0].position_origin='mesh';
  assert.equal(vm.runInContext('toKorr(snapshot).local.z',ctx),386);
  const fresh={...ctx.snapshot.entities[0],key:'next'};ctx.snapshot.entities=[fresh];
  assert.equal(vm.runInContext('toKorr(snapshot).players[0].z',ctx),86);
  assert.deepEqual(fresh.world,[0,0,0],'source coordinates are not rewritten');
});

test('operator downloads can start together without exceeding two concurrent loads', async () => {
  const source=fs.readFileSync(new URL('../m3d/operator-model.js',import.meta.url),'utf8');
  const start=source.indexOf('const modelLoadQueue');assert.ok(start>=0);
  const ctx=vm.createContext({});vm.runInContext(source.slice(start,source.indexOf('export const operatorAssetState',start)),ctx);
  const releases=[];ctx.task=()=>new Promise(resolve=>releases.push(resolve));
  const jobs=[0,1,2].map(()=>vm.runInContext('enqueueOperatorLoad(task)',ctx));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(releases.length,2);
  releases[0]();await new Promise(resolve=>setImmediate(resolve));assert.equal(releases.length,3);
  releases[1]();releases[2]();await Promise.all(jobs);
});

test('first person reset ends at the eye pose without a subsequent orbit update', () => {
  const camera=new THREE.PerspectiveCamera();camera.up.set(0,0,1);
  const controls={target:new THREE.Vector3(),update(){camera.position.x+=10;}};
  const ctx=vm.createContext({THREE,camera,controls,aimDirection,followState:{},CHARACTER_ROOT_ABOVE_MESH_M,operatorState,_operatorDefinition:()=>null,
    window:{AppState:{display:{eyeHeight:1.6}}},FIRST_PERSON_CAMERA:{EYE_HEIGHT:.68,LOOK_DISTANCE:12},
    _worldPositionForTarget:h=>new THREE.Vector3(h.x/100,-h.y/100,h.z/100)});
  const start=renderer.indexOf('const CAPSULE_CENTER_ABOVE_FOOT_M');
  vm.runInContext(renderer.slice(start,renderer.indexOf('/* 重置按当前模式',start)),ctx);
  vm.runInContext('_resetFirstPersonCamera({x:100,y:200,z:300,yaw:90,pitch:30})',ctx);
  assert.deepEqual(camera.position.toArray(),[1,-2,3.74]);
  const direction=new THREE.Vector3();camera.getWorldDirection(direction);
  assert.ok(direction.distanceTo(new THREE.Vector3(...aimDirection(90,30)))<1e-6);
  vm.runInContext('_resetFirstPersonCamera({x:100,y:200,z:386,yaw:0,view:{world:[100,200,386],origin:"actor",yaw:90,pitch:30}})',ctx);
  assert.deepEqual(camera.position.toArray(),[1,-2,4.6],'actor root plus root-to-eye offset gives 1.6m above the mesh origin');
  ctx._operatorDefinition=()=>({headOffsets:{Prone:[0,0,-1.1]}});
  vm.runInContext('_resetFirstPersonCamera({x:100,y:200,z:386,yaw:0,position_origin:"mesh",pose:{prone:true}})',ctx);
  assert.ok(Math.abs(camera.position.z-3.5)<1e-6,'prone view follows the lower native head pose');
});

test('failed terrain construction rejects so the adapter can report and retry it', async () => {
  const ctx=vm.createContext({mapInstallSeq:0,currentMapTriangleCount:0,mapBounds:null,mapTex:{key:'daba'},
    performance,console:{error(){}},window:{showRadarToast(){}},
    _sampleMapHeightRange:()=>({low:0,high:1}),buildMapChunksAsync:async()=>{throw new Error('chunk failed');}});
  const start=renderer.indexOf('function gatewayInstallGeometry(');
  vm.runInContext(renderer.slice(start,renderer.indexOf('\nfunction _installMapChunks',start)),ctx);
  ctx.geo=new THREE.BufferGeometry();ctx.geo.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0],3));
  await assert.rejects(vm.runInContext('gatewayInstallGeometry("daba",geo)',ctx),/chunk failed/);
});

function followCollisionContext(camera, children) {
  const start=renderer.indexOf('const FOLLOW_COLLISION_PAD');assert.ok(start>=0);
  const ctx=vm.createContext({THREE,camera,mapMesh:{children},controls:{target:new THREE.Vector3()},performance,
    cameraMode:'thirdPerson',CAMERA_MODES:{THIRD_PERSON:'thirdPerson'},buildRayGrid,raycastRayGrid,clipSegmentToBox});
  vm.runInContext(renderer.slice(start,renderer.indexOf('\n/* 每帧跟随核心',start)),ctx);
  return ctx;
}
// 地图块的顶点已是世界坐标、没有变换矩阵，测试墙体同样把位移烘进几何
function wallChunk(x) {
  const geometry=new THREE.BoxGeometry(.2,10,10).translate(x,0,0);geometry.computeBoundingBox();
  return new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
}

test('third person camera is kept on the player side of a wall', () => {
  const camera=new THREE.PerspectiveCamera();camera.position.set(-4,0,0);
  const ctx=followCollisionContext(camera,[wallChunk(-2)]);
  vm.runInContext('_avoidFollowCameraCollision(0)',ctx);
  assert.ok(camera.position.x>-1.9 && camera.position.x<-1);
  camera.position.set(-1,0,0);vm.runInContext('_avoidFollowCameraCollision(16)',ctx);
  assert.equal(camera.position.x,-1);
});

test('third person collision only shortens the rendered frame and eases back once clear', () => {
  const camera=new THREE.PerspectiveCamera();camera.position.set(-4,0,0);
  const ctx=followCollisionContext(camera,[wallChunk(-2)]);
  vm.runInContext('_avoidFollowCameraCollision(0)',ctx);
  const pushed=camera.position.x;assert.ok(pushed>-1.9 && pushed<-1);
  // 下一帧控制器更新前恢复用户设定的 4m；以前拉近的位置会被 OrbitControls 当成新半径，越拉越近
  vm.runInContext('_restoreFollowCamera()',ctx);assert.equal(camera.position.x,-4);
  ctx.mapMesh.children=[];
  vm.runInContext('_avoidFollowCameraCollision(50)',ctx);
  assert.ok(camera.position.x<pushed && camera.position.x>-4,'障碍消失后平滑退回，不瞬间跳回');
  for(let t=66;t<2000;t+=16)vm.runInContext(`_restoreFollowCamera();_avoidFollowCameraCollision(${t})`,ctx);
  assert.equal(camera.position.x,-4);assert.equal(vm.runInContext('followCollision.active',ctx),false);
});

test('frame cap keeps the requested average rate when refresh is not a multiple of it', () => {
  const start=renderer.indexOf('const frameClock');assert.ok(start>=0);
  const rate=(hz,cap,jitter=0)=>{
    const ctx=vm.createContext({});vm.runInContext(renderer.slice(start,renderer.indexOf('\nfunction tick(',start)),ctx);
    return vm.runInContext(`let n=0;for(let i=0;i<${hz}*6;i++){const t=i*1000/${hz}+((i%3)-1)*${jitter};if(_frameDue(t,${cap}))n++;}n/6`,ctx);
  };
  assert.ok(Math.abs(rate(144,60)-60)<1.5,'144Hz 屏 60 上限（以前只有 48）');
  assert.ok(Math.abs(rate(75,60)-60)<1.5,'75Hz 屏 60 上限（以前只有 37.5）');
  assert.ok(Math.abs(rate(165,60)-60)<1.5);
  assert.ok(Math.abs(rate(60,60,0.8)-60)<1,'时间戳抖动不能丢帧');
  assert.ok(Math.abs(rate(60,30)-30)<1);
  assert.ok(Math.abs(rate(144,144,0.5)-144)<2);
  assert.equal(rate(60,0),60);
});

test('far labels retain exact health, including zero, and never invent unknown health', () => {
  const start=renderer.indexOf('function _hudPush(');
  const ctx=vm.createContext({hudItems:[],hudCount:0,UE_TO_M:.01,PALETTE:{unknown:0},_isEnemyOfViewer:()=>true});
  vm.runInContext(renderer.slice(start,renderer.indexOf('\nfunction _drawHud',start)),ctx);
  ctx.entity={root:{visible:true,position:{x:500,y:0,z:0}},sprite:{visible:false},src:{key:'enemy',kind:'player',hero:'威龙',x:50000,y:0,hp:37,maxHp:100}};
  for(const [hp,text] of [[37,'37/100'],[0,'0/100'],[null,'血量未知']]){
    ctx.entity.src.hp=hp;ctx.hudCount=0;
    vm.runInContext('_hudPush(entity,false,{key:"self",x:0,y:0},{showHealth:true},80)',ctx);
    assert.ok(ctx.hudItems[0].text.includes(text));
    assert.equal(ctx.hudItems[0].hp,hp===null?null:hp/100);
  }
  ctx.entity.src.hp=550;ctx.entity.src.maxHp=null;ctx.hudCount=0;
  vm.runInContext('_hudPush(entity,false,{key:"self",x:0,y:0},{showHealth:true},80)',ctx);
  assert.ok(ctx.hudItems[0].text.includes('550/?'));
  assert.equal(ctx.hudItems[0].hp,null,'unknown maximum cannot become a full bar');
});

test('distant teammates standing together get separate readable health labels', () => {
  const source=fs.readFileSync(new URL('../m3d/korr-hud.js',import.meta.url),'utf8');
  const start=source.indexOf('function placeFarLabel(');assert.ok(start>=0);
  const ctx=vm.createContext({placed:[]});
  vm.runInContext(source.slice(start,source.indexOf('\nexport function createHud',start)),ctx);
  for(let i=0;i<3;i++)vm.runInContext('placeFarLabel(200,200,160,28,placed,800,600)',ctx);
  assert.equal(new Set(ctx.placed.map(r=>r.y)).size,3);
  assert.ok(ctx.placed.every(r=>r.x>=0&&r.x+r.w<=800&&r.y>=0));
});

test('near health bars draw the fill after the backing and fill horizontally', () => {
  const start=renderer.indexOf('const HPBAR_W_M');
  const end=renderer.indexOf('function makeInfoCardSprite',start);
  const ctx=vm.createContext({THREE,CHARACTER_ROOT_ABOVE_MESH_M});vm.runInContext(renderer.slice(start,end),ctx);
  const bar=vm.runInContext('makeHpBar()',ctx);ctx.bar=bar;
  vm.runInContext('updateHpBar(bar,.5)',ctx);
  assert.equal(bar.bg.material.transparent,true);assert.equal(bar.fill.material.transparent,true);
  assert.ok(bar.fill.renderOrder>bar.bg.renderOrder);
  assert.equal(bar.fill.scale.x,.5);assert.equal(bar.fill.scale.y,1);
  const billboard=renderer.indexOf('const _hpWorldQ');
  vm.runInContext(renderer.slice(billboard,renderer.indexOf('\nlet gatewayLastSlow',billboard)),ctx);
  ctx.entity={root:new THREE.Group(),hpBar:bar,modelScale:1};
  vm.runInContext('_billboardHpBar(entity,new THREE.Vector3(3,-5,1))',ctx);
  assert.equal(bar.group.position.x,0);assert.ok(Math.abs(bar.group.position.z-1.16)<1e-8);
});
