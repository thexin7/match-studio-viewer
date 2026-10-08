// Pure snapshot/pose contract shared by the adapter, renderer and regression tests.
export const characterKind = e => ['player','mate','unknown'].includes(e.kind);
export const validWorld = w => Array.isArray(w) && w.length >= 3 && w.slice(0,3).every(Number.isFinite);
export const scenePosition = w => [w[0]/100,-w[1]/100,w[2]/100];
// BP_DFMCharacter: capsule half-height 86 cm; mesh RelativeLocation.Z = -86 cm.
export const CHARACTER_ROOT_ABOVE_MESH_M = .86;
export function aimOf(s) {
  const fresh = Number.isFinite(s.self_aim_yaw) && (!Number.isFinite(s.self_aim_age_ms) || s.self_aim_age_ms <= 250);
  return {yaw:fresh?s.self_aim_yaw:s.self_yaw, pitch:fresh&&Number.isFinite(s.self_pitch)?s.self_pitch:0};
}
export function viewOf(s) {
  if (s.replay || !Number.isFinite(s.self_aim_yaw) || !Number.isFinite(s.self_aim_age_ms) || s.self_aim_age_ms < 0 || s.self_aim_age_ms > 250) return null;
  const source = validWorld(s.self_up_loc) ? s.self_up_loc : s.self;
  if (!validWorld(source)) return null;
  const world = source.slice();
  if (s.self_position_origin === 'mesh' && validWorld(s.self)) world[2] = s.self[2] + CHARACTER_ROOT_ABOVE_MESH_M * 100;
  return { world, origin:s.self_position_origin==='mesh'?'mesh-normalized':'actor', ...aimOf(s) };
}
export function aimDirection(yaw, pitch=0) {
  const y=-yaw*Math.PI/180, p=Math.max(-89.9,Math.min(89.9,pitch))*Math.PI/180;
  return [Math.cos(y)*Math.cos(p),Math.sin(y)*Math.cos(p),Math.sin(p)];
}
export function blendPose(a,b,t) {
  if (a && b && ['eid','actor_guid','spawn_seq','kind','name','position_origin'].some(k=>a[k]!==b[k])) return b;
  if (!validWorld(a?.world) || !validWorld(b?.world) || Math.hypot(...a.world.map((v,i)=>v-b.world[i]))>500) return b;
  const world=b.world.map((v,i)=>a.world[i]+(v-a.world[i])*t);
  const yaw=Number.isFinite(a.yaw)&&Number.isFinite(b.yaw)?a.yaw+(((b.yaw-a.yaw+540)%360)-180)*t:b.yaw;
  const pitch=Number.isFinite(a.pitch)&&Number.isFinite(b.pitch)?a.pitch+(b.pitch-a.pitch)*t:b.pitch;
  return {...b,world,xyz:world,yaw,pitch};
}

// 第一视角视线（上行位置 + 瞄准朝向）的插值；来源（actor / mesh 归一化）不同或瞬移时直接用新值
export function blendView(a,b,t) {
  if (!a || !b || a.origin!==b.origin || !validWorld(a.world) || !validWorld(b.world) || Math.hypot(...a.world.map((v,i)=>v-b.world[i]))>500) return b;
  return {...b, world:b.world.map((v,i)=>a.world[i]+(v-a.world[i])*t),
    yaw:a.yaw+(((b.yaw-a.yaw+540)%360)-180)*t, pitch:a.pitch+(b.pitch-a.pitch)*t};
}

/* 呈现时间线（插值缓冲）。
   - 内容有变化的快照按时刻 ts 入缓冲：优先用后端的 timestampMs（数据生成时刻），缺失或不递增时用到达时刻。
   - 到达延迟 lat = 到达时刻 − ts；base 取近期最小延迟（变小立即跟、变大慢慢跟，吸收时钟漂移），
     jit 是超出 base 的迟到量（变大快跟、变小慢退）。到达时刻模式下迟到量按「比预期间隔晚了多少」计。
   - 呈现时刻 pt = now − base − (快照间隔 iv + jit)：一个间隔保证手里总有下一帧，jit 吸收到达抖动。
     pt 落在哪两帧之间就按时间比例插值，到达忽早忽晚不再变成走走停停。迟到超过余量时停在最新一帧，不外推。
   - 位置与朝向取插值，其余字段（血量、武器、姿态等）一律用最新快照。会话切换、回放暂停/拖动/倒退直接重置。
   - 本人身体、第一视角视线与真人玩家共用这条时间线；AI 不插值，保持数据原样。 */
const BUFFER_MAX = 6;
export class PosePresenter {
  constructor(){this.buf=[];this.identity='';this.signature='';this.base=NaN;this.iv=0;this.jit=0;this.useTs=null;this.latest=null;}
  get delay(){return this.iv+this.jit;}
  push(s,now){
    const identity=[s.session,s.epoch,s.flow,s.local,s.remote].join('|');
    const reset=identity!==this.identity || s.replay?.seeking || s.replay?.paused ||
      s.replay?.position < (this.latest?.replay?.position ?? 0);
    const sig=JSON.stringify([s.self,s.self_up_loc,aimOf(s),s.entities?.map(e=>[e.key,e.kind,e.is_bot,e.world,e.yaw,e.pose_seq])]);
    this.identity=identity;this.latest=s;
    if(reset)this.buf=[];
    const last=this.buf[this.buf.length-1];
    if(last && sig===this.signature){last.s=s;last.m=null;return;}
    this.signature=sig;
    const serverTs=Number(s.timestampMs);
    const useTs=Number.isFinite(serverTs) && (!last || !this.useTs || serverTs>last.ts);
    if(last && useTs!==this.useTs)this.buf=[];
    this.useTs=useTs;
    const prev=this.buf[this.buf.length-1];
    const ts=useTs?serverTs:now;
    if(prev){
      const step=ts-prev.ts;
      if(step>0 && step<1000)this.iv=this.iv>0?this.iv+(Math.min(250,step)-this.iv)*.2:Math.min(250,step);
    }
    const lat=now-ts;
    if(!Number.isFinite(this.base) || !prev || lat<this.base || lat-this.base>1000)this.base=lat;
    else this.base+=(lat-this.base)*.005;
    // 迟到量：时间戳模式看延迟超出 base 多少；到达时刻模式看比预期间隔晚了多少
    const late=useTs?lat-this.base:prev?Math.max(0,(now-prev.at)-this.iv):0;
    if(prev)this.jit=Math.min(150,late>this.jit?this.jit+(late-this.jit)*.5:this.jit+(late-this.jit)*.02);
    this.buf.push({ts,at:now,s});
    if(this.buf.length>BUFFER_MAX)this.buf.shift();
  }
  sample(now){
    const s=this.latest,buf=this.buf;
    if(!s || buf.length<2 || s.replay?.paused || s.replay?.seeking)return s;
    const pt=now-this.base-this.delay;
    let i=buf.length-1;
    if(pt>=buf[i].ts)return s;
    while(i>0 && buf[i-1].ts>pt)i--;
    if(i===0)i=1;
    const A=buf[i-1],B=buf[i],t=Math.max(0,Math.min(1,(pt-A.ts)/(B.ts-A.ts)));
    // 每个缓冲帧的实体索引只建一次，逐帧采样不再重建
    A.m??=new Map((A.s.entities||[]).map(e=>[e.key,e]));B.m??=new Map((B.s.entities||[]).map(e=>[e.key,e]));
    return this.blend(A.s,B.s,A.m,B.m,t,s);
  }
  blend(a,b,ea,eb,t,s){
    const entities=(s.entities||[]).map(e=>{
      if(!characterKind(e) || e.is_bot)return e;
      const pa=ea.get(e.key),pb=eb.get(e.key);
      if(!pa || !pb)return e;
      const p=blendPose(pa,pb,t);
      return p===pb?e:{...e,world:p.world,xyz:p.world,yaw:p.yaw};
    });
    const own=blendPose({world:a.self,position_origin:a.self_position_origin,...aimOf(a)},
      {world:b.self,position_origin:b.self_position_origin,...aimOf(b)},t);
    const va=viewOf(a),vb=viewOf(b);
    return {...s,entities,self:own.world,self_yaw:own.yaw,self_aim_yaw:own.yaw,self_pitch:own.pitch,self_view:va&&vb?blendView(va,vb,t):viewOf(s)};
  }
}

// Partition index buffers only: retain every triangle and the shared world vertices.
export function splitSurfaceIndices(xyz, indices) {
  indices ??= Uint32Array.from({length:xyz.length/3},(_,i)=>i);
  const groups=new Uint8Array(indices.length/3);let horizontal=0;
  for(let i=0;i<indices.length;i+=3){
    const a=indices[i]*3,b=indices[i+1]*3,c=indices[i+2]*3;
    const ux=xyz[b]-xyz[a],uy=xyz[b+1]-xyz[a+1],uz=xyz[b+2]-xyz[a+2];
    const vx=xyz[c]-xyz[a],vy=xyz[c+1]-xyz[a+1],vz=xyz[c+2]-xyz[a+2];
    const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
    const isFloor=Math.abs(nz)>=.70*Math.hypot(nx,ny,nz);
    groups[i/3]=isFloor?0:1;if(isFloor)horizontal+=3;
  }
  const result=new Uint32Array(indices.length);let floor=0,wall=horizontal;
  for(let i=0;i<indices.length;i+=3){const at=groups[i/3]?wall:floor;result.set(indices.subarray(i,i+3),at);if(groups[i/3])wall+=3;else floor+=3;}
  return {indices:result,horizontal,vertical:indices.length-horizontal};
}
