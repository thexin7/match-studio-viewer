import * as THREE from 'three';
import {characterKind,aimOf,PosePresenter} from './gateway-pose.js?v=1.1.0';
import { parseGLB } from './r3d.js?v=1.1.0';
import { loadTerrainPack } from './terrain-packed.js?v=1.4.0';
import { gateway } from './korr-renderer.js?v=1.4.0';

// ER snapshots and local GLBs -> Korr renderer, retaining the ER page and controls.
// Coordinates enter in UE centimetres. GLB uses metres [UE.x, UE.z, UE.y].
export function interpolateHumans(previous, current, fraction) {
  if (!previous || !current || current.replay?.seeking || current.replay?.paused) return current;
  const t = Math.max(0, Math.min(1, fraction));
  const old = new Map((previous.entities || []).map(e => [e.key, e]));
  const blend = (a, b) => {
    if (!a?.world || !b?.world || Math.hypot(...a.world.map((x,i) => x-b.world[i])) > 3000) return b;
    const world = b.world.map((v,i) => a.world[i] + (v-a.world[i])*t);
    let yaw = b.yaw;
    if (Number.isFinite(a.yaw) && Number.isFinite(b.yaw)) {
      const delta = ((b.yaw-a.yaw+540)%360)-180;
      yaw = a.yaw + delta*t;
    }
    return {...b, world, xyz:world, yaw};
  };
  const entities = (current.entities || []).map(e => ['player','mate'].includes(e.kind) && !e.is_bot ? blend(old.get(e.key),e) : e);
  const own = blend({world:previous.self,yaw:previous.self_aim_yaw ?? previous.self_yaw},
                    {world:current.self,yaw:current.self_aim_yaw ?? current.self_yaw});
  return {...current,entities,self:own.world,self_yaw:own.yaw,self_aim_yaw:own.yaw};
}

const hpOf = h => {
  if (h && Array.isArray(h.total)) return {hp:h.total[0],maxHp:h.total[1]};
  return Number.isFinite(h) ? {hp:h,maxHp:100} : {hp:null,maxHp:null};
};
// 回放时 toKorr 每个动画帧都会跑；物资/AI/盒子在两次轮询之间是同一个对象，
// 按源对象缓存转换结果，避免每帧为几百个物资重新展开对象（GC 抖动）。
const converted = new WeakMap();
// 背包名 → 等级（index.html 的 BAG_LV，经 create({bagLv}) 传入），人物模型按等级缩放背包
let bagLevels = null;
const entity = e => {
  let c = converted.get(e);
  if (!c) {
    c = {...e, x:e.world[0], y:e.world[1], z:e.world[2],
      // Follow targets use stable actor keys, labels retain the real name.
      name:e.key, displayName:e.name === '物资' ? '未知物资 · ID待识别' : e.name || '未命名', ...hpOf(e.hp),
      alive:!e.dead, quality:e.grade ?? 0, weapon:e.curr_weapon || e.weapon,
      helmetLv:e.helmet, armorLv:e.vest,helmetDur:e.helmet_dur,armorDur:e.vest_dur,hero:e.hero,
      bagLv:(e.bp && bagLevels?.[e.bp]) || 0};
    converted.set(e, c);
  }
  return c;
};

export function toKorr(snapshot, pref={}) {
  const hp = hpOf;
  const valid = (snapshot.entities || []).filter(e => Array.isArray(e.world) && e.world.length>=3 && e.world.every(Number.isFinite));
  return {players:valid.filter(e=>characterKind(e) && (pref.mate!==0 || e.kind!=='mate')).map(entity),
    ais:valid.filter(e=>e.kind==='ai').map(entity),bosses:[],
    items:valid.filter(e=>(pref.loot!==0 && e.kind==='loot') || (pref.box!==0 && e.kind==='box' && (pref.aibox!==0 || (!e.is_ai && !e.is_bot))) || (pref.container!==0 && e.kind==='container')).map(entity),
    local:snapshot.self ? {key:'__self',name:'__self__',displayName:snapshot.self_name || '自己',
      x:snapshot.self[0],y:snapshot.self[1],z:snapshot.self[2],...aimOf(snapshot),...hp(snapshot.self_hp),
      // 自己的队号快照里没有直接给出，取任一队友的队号；复盘他人视角时用于判敌我
      team:(snapshot.entities || []).find(e => e.kind === 'mate' && e.team > 0)?.team || 0,
      dead:!!snapshot.self_life?.dead} : null,
    replay:!!snapshot.replay,slowRevision:Math.floor((snapshot.replay?.position || 0)*5)};
}

function geometryFromParts(parts) {
  let vertices=0, indices=0;
  for(const p of parts){vertices+=p.geometry.attributes.position.count;indices+=p.geometry.index.count;}
  const xyz=new Float32Array(vertices*3), ix=new Uint32Array(indices);
  const v=new THREE.Vector3();let base=0, at=0;
  for(const p of parts){
    const pos=p.geometry.attributes.position, src=pos.array, m=p.matrix.elements;
    // 地形有数百万顶点：普通 Float32 顶点直接读底层数组并内联仿射变换，
    // 比逐个 getX()/applyMatrix4() 快数倍；量化/交错等特殊格式走通用路径。
    if(src instanceof Float32Array && !pos.normalized && !pos.isInterleavedBufferAttribute && pos.itemSize===3){
      for(let n=0,o=base*3;n<pos.count;n++,o+=3){
        const x=src[n*3],y=src[n*3+1],z=src[n*3+2];
        const tx=m[0]*x+m[4]*y+m[8]*z+m[12], ty=m[1]*x+m[5]*y+m[9]*z+m[13], tz=m[2]*x+m[6]*y+m[10]*z+m[14];
        xyz[o]=tx;xyz[o+1]=-tz;xyz[o+2]=ty;
      }
    }else{
      for(let n=0;n<pos.count;n++){
        v.set(pos.getX(n),pos.getY(n),pos.getZ(n)).applyMatrix4(p.matrix);
        xyz[(base+n)*3]=v.x;xyz[(base+n)*3+1]=-v.z;xyz[(base+n)*3+2]=v.y;
      }
    }
    const idx=p.geometry.index.array;
    for(let n=0;n<idx.length;n++)ix[at++]=base+idx[n];
    base+=pos.count;p.geometry.dispose();
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(xyz,3));g.setIndex(new THREE.BufferAttribute(ix,1));return g;
}

/* 带进度的整包下载：地形 40~100MB，以前要等整包下完进度条才动一次。
   压缩传输时 Content-Length 是线上字节，解压后会超出，进度夹到满格。 */
async function readWithProgress(response,progress){
  const total=Number(response.headers.get('Content-Length')||0);
  if(!response.body||!progress||!total){const data=await response.arrayBuffer();progress?.(data.byteLength,data.byteLength);return data;}
  const reader=response.body.getReader(),chunks=[];let got=0,lastAt=0;
  for(;;){
    const {done,value}=await reader.read();if(done)break;
    chunks.push(value);got+=value.length;
    const now=performance.now();if(now-lastAt>80){lastAt=now;progress(Math.min(got,total),total);}
  }
  const out=new Uint8Array(got);let at=0;
  for(let i=0;i<chunks.length;i++){out.set(chunks[i],at);at+=chunks[i].length;chunks[i]=null;}
  progress(got,got);
  return out.buffer;
}

/* 优先加载离线打包的地形（tools/terrain-pack 产出的 .tpk：体积约为 GLB 的 1/3，附带逐顶点 bake）。
   manifest 没有 packed、包与当前 GLB 版本不符、浏览器不支持解压或下载/解码失败时返回 null，由调用方回退原 GLB。
   bake：Uint8 normalized、itemSize 2，R = AO（1 = 无遮挡），G = 天空可见度（1 = 头顶是天空）。 */
async function loadPackedGeometry(job){
  const rec=job.model,pk=rec?.packed;
  if(!pk?.file || (pk.src_rev && rec.rev && pk.src_rev!==rec.rev) || typeof DecompressionStream!=='function')return null;
  try{
    const url=new URL(pk.file+'?v='+encodeURIComponent(pk.rev || pk.bytes || 1),new URL(job.url,location.href)).href;
    const t0=performance.now();
    const pack=await loadTerrainPack(url,job.progress);
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.BufferAttribute(pack.position,3));
    g.setIndex(new THREE.BufferAttribute(pack.index,1));
    if(pack.bake)g.setAttribute('bake',new THREE.BufferAttribute(pack.bake,2,true));
    g.userData.terrainSource={kind:'packed',url,bytes:pk.bytes,verts:pack.verts,tris:pack.tris,bake:!!pack.bake};
    console.log(`[Radar3D] 地形包 ${pk.file} 已解码：${pack.verts} 顶点 / ${pack.tris} 面，bake=${!!pack.bake}，${Math.round(performance.now()-t0)}ms`);
    return g;
  }catch(e){
    console.warn('[Radar3D] 地形包加载失败，回退 GLB：',e);
    return null;
  }
}

let initialized=false;
export function create(options) {
  window.AppState={gameData:null,frameCount:0,display:{}};
  window.viewMode='3d';
  window.isRadarTeammate = p => p.kind==='mate';
  window.showRadarToast=options.onToast;
  bagLevels=options.bagLv && typeof options.bagLv==='object' ? options.bagLv : null;
  if(!initialized){gateway.init();initialized=true;}
  gateway.setPalette(options.palette);
  gateway.setHud(options.hud || null);
  let latest=null,pref=options.pref || {},active=true;
  const presenter=new PosePresenter();
  let statError='',mapUrl='',pendingMap=null,loading=null,followKey='__self',applyingCamera=false;
  const adapter={camMode:'chase',onCam:null,
    update(s){
      latest=s;presenter.push(s,performance.now());
      window.AppState.gameData=toKorr(presenter.sample(performance.now()),pref);window.AppState.frameCount++;
    },
    setPrefs(p){pref=p || {};window.AppState.display={showPlayers:true,showAIs:pref.ai!==0,
      showItems:pref.loot!==0 || pref.box!==0 || pref.container!==0,showHealth:pref.hp!==0,showName:pref.name!==0,
      showHero:pref.name!==0,showWeapon:pref.wpn!==0,showArmor:pref.gear!==0,showDistance:pref.dist!==0,showCone:pref.cone!==0,
      eyeHeight:pref.fpvheight,fpvtau:pref.fpvtau,followYaw:['fpv','chase'].includes(pref.cam3d),fpscap:pref.fpscap,fontScale:(pref.fontsize||100)/100,charScale:(pref.charsize||100)/100,model3d:pref.model3d,color3d:pref.color3d,
      tagOpacity:Number.isFinite(Number(pref.tagop))?Number(pref.tagop)/100:0.8,
      hud:{foe:pref.foe,ray:pref.ray,box3d:pref.box3d,warn3d:pref.warn3d,warnd:pref.warnd,warnr:pref.warnr,warnsz:pref.warnsz,alert:pref.alert,
        radar3d:pref.radar3d,radarr:pref.radarr,poiexit:pref.poiexit,poibox:pref.poibox,poiboxd:pref.poiboxd,poiboxoff:pref.poiboxoff,poilevel:pref.poilevel},visibleColor3d:pref.visiblecolor3d,occludedColor3d:pref.occludedcolor3d,directionStyle3d:pref.directionstyle3d,directionAnchor3d:pref.directionanchor3d,minQuality:0,minPrice:0};
      gateway.preferences(pref);
      if(latest){window.AppState.gameData=toKorr(presenter.sample(performance.now()),pref);window.AppState.frameCount++;}},
    setActive(on){active=on;window.viewMode=on?'3d':'2d';window.dispatchEvent(new CustomEvent('viewModeChanged',{detail:window.viewMode}));},
    resize(){gateway.resize();},
    stat(){return {...gateway.stat(),err:statError,engine:'Korr/Three.js',interpolation:'human-only',source:latest?.cursor,expectedCharacters:window.AppState.gameData?.players.length||0};},
    setQuality(q){window.radar3dSetQuality(({perf:'performance',low:'performance',mid:'balanced',high:'high'})[q] || q || 'auto');},
    setCam(mode){applyingCamera=true;
      try{
        this.camMode=mode;window.AppState.display.followYaw=['fpv','chase'].includes(mode);
        if(mode==='top')gateway.top();
        else{
          window.radar3dSetCameraMode(mode==='orbit'?'free':mode==='fpv'?'firstPerson':'thirdPerson');
          if(mode!=='orbit')this.setFollowKey(followKey);
        }
      }finally{applyingCamera=false;this.camMode=mode;this.onCam?.(mode,followKey);}
    },
    setFollowKey(key){followKey=key;if(['orbit','top'].includes(this.camMode))return;const e=latest?.entities?.find(e=>e.key===key);gateway.follow(key==='__self'?'self':e?.kind==='ai'?'ai':'player',key==='__self'?'__self__':key);},
    focus(key,s){const e=key==='__self'?{world:s.self}:s.entities.find(x=>x.key===key);
      if(e?.world){window.radar3dSetCameraMode('free');window.radar3dFocus(key==='__self'?'self':'player',...e.world,key);this.camMode='orbit';}},
    async setMap(info,url,progress,model){
      pendingMap={info,url,progress,model};if(loading)return loading;
      loading=(async()=>{while(pendingMap){const job=pendingMap;pendingMap=null;if(job.url===mapUrl)continue;
        statError='';try{
          let geometry=await loadPackedGeometry(job);
          if(!geometry){
            const response=await fetch(job.url,{cache:'force-cache'});if(!response.ok)throw Error('地图 HTTP '+response.status);
            const data=await readWithProgress(response,job.progress);
            geometry=geometryFromParts(parseGLB(data));
          }
          // 装图是异步的（Worker 切块）：等它完成，失败才能进 statError，载入提示也不会提前消失
          await gateway.installGeometry(job.info?.key || 'local',geometry);
          mapUrl=job.url;
          if(['orbit','top'].includes(adapter.camMode) || !latest?.self)gateway.fit();
        }catch(e){statError=String(e.message || e);options.onToast?.('3D 地图加载失败：'+statError);}
      }})();try{await loading;}finally{loading=null;}
    }
  };
  window.addEventListener('radar3dViewStateChanged',event=>{
    if(applyingCamera)return;
    const state=event.detail;
    if(!state)return;
    adapter.camMode=state.mode==='free'?'orbit':state.mode==='firstPerson'?'fpv':'chase';
    if(state.target)followKey=state.target.kind==='self'?'__self':state.target.name;
    window.AppState.display.followYaw=['fpv','chase'].includes(adapter.camMode);
    adapter.onCam?.(adapter.camMode,followKey);
  });
  adapter.setPrefs(pref);
  function animate(){
    if(active && latest?.replay && !latest.replay.seeking){
      const sample=presenter.sample(performance.now());
      window.AppState.gameData=toKorr(sample,pref);
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
  window.gateway3d=adapter;
  return adapter;
}

export {geometryFromParts};
