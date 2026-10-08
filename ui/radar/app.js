"use strict";
/* ============================================================================
   Nova 实时雷达 · 页面主程序（普通脚本，依赖 model.js 的全局函数与 Leaflet）
   ----------------------------------------------------------------------------
   数据流与节奏（彼此独立，不互相拖慢）：
     接收   —— poll() 串行请求 /api/state，按服务端快照间隔自适应；内容签名（去掉随墙钟增长的年龄字段）
               不变就整帧跳过，静止时退避，后台标签页 1 s。
     判定   —— monitor 记录成功 / 失败 / 内容变化；状态胶囊、横幅、观察条每 250 ms 刷新一次。
     插值   —— 2D 标记由 smStep 的单个 rAF 平滑；3D 由 korr-adapter 的 PosePresenter 在渲染帧内插值。
     列表   —— 目标页最多 8 Hz、物资页最多 2.5 Hz，只渲染当前可见分页；距离、方位、血量按行增量更新。
   2D 与 3D：3D 打开且不显示小地图时不维护 2D 标记；进入 3D 时清掉 2D 信息堆。
   ========================================================================== */
const $ = (id) => document.getElementById(id);
const MQ_MOBILE = window.matchMedia("(max-width:760px)");
const MOBILE = () => MQ_MOBILE.matches;
const NO3D = !!window.MS_NO3D;

/* ------------------------------------------------------------- 偏好存储 */
// 键名沿用 nr2_ 前缀（历史命名），改名需要迁移方案。
const PREF_DEF = {
  follow:1, trail:1, hp:1, loot:1, box:1, container:1, aibox:0, ai:1, mate:1, cone:1, gunlen:92, dotsize:100, fontsize:100, tagweight:600,
  name:1, wpn:1, gear:1, dist:1, foe:1, ray:0, tagop:80, lootmin:4, lootsort:"grade", alert:80, sort:"team",
  mapstyle3d:"real", maptex3d:1, shadow3d:"auto", walltrans:78, floortrans:0, followwalltrans:0, model3d:"tactical",
  visiblecolor3d:"#49d5ff", occludedcolor3d:"#ff4058", directionstyle3d:"arrow", directionanchor3d:"head",
  v3d:0, pip:1, cam3d:"chase", fpvtau:0, fpvheight:1.6, fov:58, charsize:100, q3d:"auto", fpscap:0, box3d:0,
  warn3d:1, warnd:150, warnr:200, warnsz:100, alerttoast:1, radar3d:1, radarr:150,
  poiexit:1, poispawn:1, poibox:1, poiboxoff:"", poiboxd:60, poilevel:0, color3d:"team",
  mapkey:"daba", panel:1, ptab:"targets", settab:"alert",
};
const PREF = {};
for (const k in PREF_DEF) {
  let v = null;
  try { v = localStorage.getItem("nr2_" + k); } catch (e) {}
  PREF[k] = (v === null) ? PREF_DEF[k] : (isNaN(v) || v === "" ? v : Number(v));
}
function setPref(k, v) { PREF[k] = v; try { localStorage.setItem("nr2_" + k, v); } catch (e) {} }
if (PREF.cam3d === "follow") setPref("cam3d", "chase");
if (PREF.q3d === "balanced") setPref("q3d", "mid");
if (PREF.color3d !== "team") setPref("color3d", "team");

/* ------------------------------------------------------------- 色彩语义 */
// 唯一色板：2D 直接使用，3D 通过 create({palette}) 拿到同一份。阵营色：自己与友军绿，敌方红。
const C_FOE = "#ff4058";
const TEAM_COLORS = Array(8).fill(C_FOE);
const C_SELF = "#37e08a", C_MATE = "#37e08a", C_BOX = "#a97bff", C_AI = C_FOE, C_UNK = "#8c96a8";
const C_ALERT = "#ff2d3f";
const GRADE_COL = {1:"#c9d1de",2:"#6bcf7f",3:"#4c8dff",4:"#c792ea",5:"#ffb547",6:"#ff5f6d"};
const HP_COL = { high:"#37e08a", mid:"#ffcf4d", low:"#ff5f6d", zero:"#8d2233", unknown:"#88939e" };
// 背包名 -> 等级 / 容量：装备行与 3D 背包尺寸使用
const BAG_LV = {"斜挎包": 1, "运动背包": 1, "旅行背包": 1, "DG运动背包": 1, "帆布背囊": 1, "轻型户外背包": 2, "战术快拆背包": 2, "突袭战术背包": 2, "露营背包": 2, "大型登山包": 3, "3H战术背包": 3, "DASH战术背包": 3, "GA野战背包": 3, "雨林猎手背包": 3, "MAP侦察背包": 4, "野战徒步背包": 4, "D2战术登山包": 4, "GT1户外登山包": 4, "生存战术背包": 4, "蛟龙战术背包": 4, "ALS背负系统": 5, "HLS-2重型背包": 5, "D3战术登山包": 5, "GT5野战背包": 5, "不投放": 6, "重型登山包": 6, "D7战术背包": 6, "GTO重型战术包": 6};
const RIG_LV = {"便携胸包":1,"快速侦察胸挂":1,"轻型战术胸挂":1,"简易挂载包":1,"尼龙挎包":2,"HK3便携胸挂":2,"D01轻型胸挂":2,"通用战术胸挂":2,"胸挂包":2,"简易携行弹挂":3,"HD3战术胸挂":3,"DSA战术胸挂":3,"G01战术弹挂":3,"突袭胸挂":3,"强袭战术背心":4,"突击者战术背心":4,"DRC先进侦察胸挂":4,"GIR野战胸挂":4,"蛟龙战术胸挂":4,"飓风战术胸挂":5,"指挥官战术背心":5,"黑鹰野战胸挂":5,"DAR突击手胸挂":5,"通用胸挂":5,"指挥官背心":6,"非法道具 看到报bug":6,"G.T.I 5级胸挂":6};
const BAG_CAP = {"斜挎包": 6, "运动背包": 8, "旅行背包": 10, "DG运动背包": 12, "帆布背囊": 10, "轻型户外背包": 12, "战术快拆背包": 15, "突袭战术背包": 15, "露营背包": 15, "大型登山包": 16, "3H战术背包": 18, "DASH战术背包": 20, "GA野战背包": 20, "雨林猎手背包": 21, "MAP侦察背包": 24, "野战徒步背包": 24, "D2战术登山包": 24, "GT1户外登山包": 25, "生存战术背包": 28, "ALS背负系统": 28, "HLS-2重型背包": 28, "D3战术登山包": 28, "GT5野战背包": 30, "重型登山包": 40, "D7战术背包": 35, "GTO重型战术包": 45};
const GRADE_NM  = {1:"1 级",2:"2 级",3:"3 级",4:"4 级",5:"5 级",6:"6 级"};
const STATE_COL = {down:"#ffcf4d", dying:"#ffcf4d", dead:"#a97bff", revive:"#37e08a", box_carried:"#ffcf4d", box_searching:"#ffcf4d", box_empty:"#88939e", box_looted:"#a97bff"};
const STATE_TXT = {down:"倒地", dying:"倒地", dead:"阵亡", revive:"救援", box_carried:"搬运中", box_searching:"搜刮中", box_empty:"已搜空", box_looted:"已搜刮"};
const KIND_NM   = {player:"玩家", ai:"AI", self:"自己", box:"死亡盒", container:"容器", loot:"物资", mate:"队友", unknown:"未知玩家"};
const LOOT_IMG  = (id) => "/resources/items/" + encodeURIComponent(id) + ".png";
const AVATAR_V = "3";
const avatarUrl = (hero) => "/avatars/" + encodeURIComponent(hero) + ".png?v=" + AVATAR_V;
const CHAR_KINDS = new Set(["player", "mate", "ai", "unknown"]);

const boxColor = (e) => (e.is_ai === true || e.is_bot === true) ? C_BOX : "#ffb547";
function entColor(e) {
  if (e.kind === "self") return C_SELF;
  if (e.kind === "mate") return C_MATE;
  if (e.kind === "container") return "#38bdf8";
  if (e.kind === "box") return boxColor(e);
  if (e.kind === "loot") return GRADE_COL[e.grade] || "#ffb547";
  if (e.kind === "ai") return C_AI;
  if (e.kind === "player") return C_FOE;
  return C_UNK;
}
function displaySelfName(s) {
  const n = typeof s.self_name === "string" ? s.self_name.replace(/\(self\)\s*$/i, "").trim() : "";
  return n || "自己";
}
function nameOf(e) {
  if (e.kind === "loot") return lootName(e);
  const n = e.name || KIND_NM[e.kind] || "未知";
  return (e.is_bot && e.name) ? n + "（人机）" : n;
}

let _toastT = 0;
function toast(msg, kind) {
  const t = $("toast");
  t.textContent = msg; t.classList.add("on");
  t.classList.toggle("alert", kind === "alert");
  clearTimeout(_toastT); _toastT = setTimeout(() => t.classList.remove("on"), kind === "alert" ? 2600 : 1800);
}

/* ------------------------------------------------------------ 地图与投影 */
let MAP_INFO = null, MAPS = {}, DEF_MAP = "daba", map = null, tileLayer = null;
// 世界坐标 -> 平面 (lng,lat)，与官方 main.js getMapPos 一致（含 rotate）
function worldToPlane(wx, wy) {
  const i = MAP_INFO, bj = i.bj || 128, xB = i.width / bj, yB = i.height / bj;
  const cx = i.centerX, cy = i.centerY, r = Number(i.rotate || 0);
  if (r === 90)  return { lng: bj - (cy + wy) / yB, lat: -bj + (cx - wx) / xB };
  if (r === -90) return { lng: bj + (cy + wy) / yB, lat: -bj - (cx - wx) / xB };
  return { lng: bj - (cx - wx) / xB, lat: -bj - (cy + wy) / yB };
}
function pointLatLng(w) { const p = worldToPlane(w[0], w[1]); return L.latLng(p.lat, p.lng); }
// 世界 yaw -> 屏幕旋转角（0=向上，顺时针为正）。投影 p 与 p+dir 两点求平面增量，吃掉各地图的 rotate。
function yawToScreen(w, yaw) {
  if (yaw == null) return null;
  const r = yaw * Math.PI / 180, L0 = 1500;
  const a = worldToPlane(w[0], w[1]);
  const b = worldToPlane(w[0] + Math.cos(r) * L0, w[1] + Math.sin(r) * L0);
  const dx = b.lng - a.lng, dy = b.lat - a.lat;
  if (!dx && !dy) return null;
  return Math.atan2(dx, dy) * 180 / Math.PI;
}

/* ---------------------------------------------------------- 渲染缓存/状态 */
let markers = new Map(), trails = new Map(), infos = new Map();
let selfMarker = null, alertCircle = null;
let follow = !!PREF.follow, followKey = "__self";
let sel = null;           // 列表选中项 key
let lastSnap = null, lastEnts = [];
const alertHold = new Map();
const opRows = new Map(), lootRows = new Map();
const foldGrp = new Set();
// 「值没变就不碰 DOM」缓存：draw 是高频路径
const _rc = { pos:new Map(), icon:new Map(), iconBase:new Map(), trail:new Map(), self:"", strip:"", peek:"" };
const monitor = createLiveMonitor();
let liveState = monitor.state(performance.now());

/* ------------------------------------------- 位置平滑（指数趋近 + 单个 rAF） */
const smPos = new Map(), smTgt = new Map();
const SM_TAU = 0.12, SM_SNAP_CM = 3000;
/* 本人位置跳变过滤：单次跳变超过 20m 先按住旧位置，连续 6 次报上来才接受（真实复活/换点最多晚约 0.3 s）。 */
const SELF_JUMP_CM = 2000, SELF_HOLD_N = 6;
let selfHold = null;
function normalizeSelf(raw) {
  if (!raw || raw.length < 3) { selfHold = null; return raw; }
  const x = Number(raw[0]), y = Number(raw[1]);
  if (!isFinite(x) || !isFinite(y)) return raw;
  if (!selfHold) { selfHold = { p: raw.slice(), n: 1 }; return raw; }
  const d = Math.hypot(x - selfHold.p[0], y - selfHold.p[1]);
  if (d <= SELF_JUMP_CM) { selfHold = { p: raw.slice(), n: 1 }; return raw; }
  selfHold.n += 1;
  if (selfHold.n >= SELF_HOLD_N) { selfHold = { p: raw.slice(), n: 1 }; return raw; }
  return selfHold.p.slice();
}
let smRaf = 0, smTimer = 0, smLast = 0, smDue = 0, smRefresh = 1000 / 60, smDirect = true, smPrevRaf = 0;
function smDistanceCm(p, t) {
  const info = MAP_INFO;
  if (!info || !(info.width > 0) || !(info.height > 0)) return Infinity;
  const x = info.width / (info.bj || 128), y = info.height / (info.bj || 128);
  const rotate = Number(info.rotate || 0), lat = t.lat - p.lat, lng = t.lng - p.lng;
  return rotate === 90 || rotate === -90 ? Math.hypot(lat * x, lng * y) : Math.hypot(lng * x, lat * y);
}
/* 高刷屏（144–300 Hz）上 rAF 远快于数据（约 20 Hz），每个刷新周期都挪点会让主线程、合成器和 GPU 一起空忙。
   平滑最多 60 Hz（3D 下的小地图 30 Hz）：离到期还早就用定时器睡到前约 1.5 个刷新周期，再用 rAF 逐个周期逼近，
   落在到期时刻最近的那次刷新上（与 3D 渲染循环同一做法）。刷新周期只用相邻两次 rAF 的间隔估计。 */
function smSchedule() {
  if (smRaf || smTimer) return;
  const wait = smDue - performance.now() - (smRefresh * 1.5 + 2);
  smDirect = !(wait > 1);
  if (wait > 1) smTimer = setTimeout(() => { smTimer = 0; smRaf = requestAnimationFrame(smStep); }, wait);
  else smRaf = requestAnimationFrame(smStep);
}
function smStep(ts) {
  smRaf = 0;
  if (!map) return;
  const now = ts || performance.now();
  if (smDirect && smPrevRaf && now - smPrevRaf > 1 && now - smPrevRaf < 100) smRefresh += (now - smPrevRaf - smRefresh) * 0.1;
  smPrevRaf = now;
  const interval = is3d() ? 1000 / 30 : 1000 / 60;
  if (now < smDue - Math.min(smRefresh, interval) * 0.5) { smSchedule(); return; }
  smDue += interval;
  if (smDue <= now) smDue = now + interval;
  const dt = Math.min(Math.max(now - smLast, 0) / 1000, 0.25) || 0.016; smLast = now;
  const a = 1 - Math.exp(-dt / SM_TAU);
  // CRS.Simple 下 1 个坐标单位 = 2^zoom 像素：差距不到 0.2 像素直接落到目标，静止的点不再每帧改样式
  const eps = 0.2 / Math.pow(2, map.getZoom());
  // 视野外（各边外扩 20%）的点直接落到目标，只按数据频率更新
  const vb = map.getBounds(), py = (vb.getNorth() - vb.getSouth()) * 0.2, px = (vb.getEast() - vb.getWest()) * 0.2;
  const s0 = vb.getSouth() - py, n0 = vb.getNorth() + py, w0 = vb.getWest() - px, e0 = vb.getEast() + px;
  const inView = q => q.lat >= s0 && q.lat <= n0 && q.lng >= w0 && q.lng <= e0;
  let active = false;
  for (const [k, t] of smTgt) {
    const m = markers.get(k) || (k === "__self" ? selfMarker : null);
    if (!m) { smPos.delete(k); smTgt.delete(k); continue; }
    let p = smPos.get(k);
    if (!p) { p = { lat: t.lat, lng: t.lng }; smPos.set(k, p); }
    let chg = false;
    const dl = Math.abs(t.lat - p.lat), dg = Math.abs(t.lng - p.lng);
    if (dl || dg) {
      if ((dl < eps && dg < eps) || smDistanceCm(p, t) > SM_SNAP_CM || (!inView(p) && !inView(t))) { p.lat = t.lat; p.lng = t.lng; }
      else { p.lat += (t.lat - p.lat) * a; p.lng += (t.lng - p.lng) * a; active = true; }
      chg = true;
    }
    if (chg) {
      m.setLatLng([p.lat, p.lng]);
      const it = infos.get(k); if (it) it.m.setLatLng([p.lat, p.lng]);
      if (k === "__self" && alertCircle) alertCircle.setLatLng([p.lat, p.lng]);
    }
    if (follow && k === followKey) followPan(p);
  }
  if (active) smSchedule();
}
function smKick() { if (!smRaf && !smTimer) { smLast = smDue = performance.now(); smDirect = false; smRaf = requestAnimationFrame(smStep); } }
/* 跟随平移只挪地图面板（合成器移动图层），不走 panTo：panTo 每次都触发 moveend，Canvas 图层会重设画布尺寸
   并整张重画、瓦片层重算范围。moveend 合并为最多每 250 ms 一次，Canvas 自带的外延足以覆盖其间的位移。 */
let _panEndTimer = 0;
function followPan(p) {
  if (map._animatingZoom) return;
  const c = map.latLngToContainerPoint([p.lat, p.lng]), size = map.getSize();
  const dx = Math.round(c.x - size.x / 2), dy = Math.round(c.y - size.y / 2);
  if (!dx && !dy) return;
  if (Math.abs(dx) > size.x / 2 || Math.abs(dy) > size.y / 2) { map.panTo([p.lat, p.lng], { animate: false }); return; }
  map._rawPanBy(L.point(dx, dy));
  map.fire("move");
  if (!_panEndTimer) _panEndTimer = setTimeout(() => { _panEndTimer = 0; map.fire("moveend"); }, 250);
}
function smSet(key, ll) {
  smTgt.set(key, { lat: ll.lat, lng: ll.lng });
  if (!smPos.has(key)) smPos.set(key, { lat: ll.lat, lng: ll.lng });
  smKick();
}

/* -------------------------------------------------------------- 血量与装备片段 */
function hpBarHtml(hp, cls) {
  const h = hpInfo(hp), key = hpColorKey(h);
  if (h.frac == null && h.state !== "zero")
    return '<span class="' + cls + ' unk" role="meter" aria-label="血量" aria-valuetext="' + esc(h.text) + '" title="' + esc(h.text) + '"></span>';
  return '<span class="' + cls + '" role="meter" aria-label="血量" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(h.frac * 100)
    + '" aria-valuetext="' + esc(h.text) + '" title="' + esc(h.text) + '"><i style="width:' + (h.frac * 100).toFixed(1) + '%;background:' + HP_COL[key] + '"></i></span>';
}
function hpLineHtml(hp) {
  const h = hpInfo(hp);
  return hpBarHtml(hp, "hpbar") + '<span class="hpv tnum" style="color:' + HP_COL[hpColorKey(h)] + '">' + esc(h.state === "nomax" ? h.short + " 上限未知" : h.text) + "</span>";
}
function gearValue(durability, level) {
  return (Array.isArray(durability) && durability[0] != null) ? String(Math.round(durability[0])) : String(level || "?");
}
function gearIconHtml(kind, level, value) {
  const color = GRADE_COL[Number(level)] || "#c9d1de";
  const labels = {helmet:"头盔", armor:"护甲", bag:"背包", rig:"胸挂"};
  return '<span class="gear-chip" title="' + (labels[kind] || "装备") + ' ' + level
    + ' 级"><i class="gear-icon ' + kind + '" style="--gear:' + color + '"></i><b>' + value + '</b></span>';
}
function gearBarHtml(e) {
  const parts = [];
  if (e.helmet) parts.push(gearIconHtml("helmet", e.helmet, gearValue(e.helmet_dur, e.helmet)));
  if (e.vest) parts.push(gearIconHtml("armor", e.vest, gearValue(e.vest_dur, e.vest)));
  const blv = e.bp ? BAG_LV[e.bp] : null, rlv = e.cr ? RIG_LV[e.cr] : null;
  if (blv) parts.push(gearIconHtml("bag", blv, blv));
  if (rlv) parts.push(gearIconHtml("rig", rlv, rlv));
  if (!parts.length) return "";
  return '<div class="grb' + (e._out_of_range ? " out-range" : "") + '">' + parts.join("") + "</div>";
}
// 地图上只显示有证据的当前装备；未解析时不写，详情里再说明
function weaponShort(w) {
  if (w.kind === "unresolved") return "";
  if (w.kind === "unlisted") return "未收录武器";
  return w.text;
}
function durTxt(v) {
  if (!Array.isArray(v) || v[0] == null) return "";
  return " " + Math.round(v[0]) + "/" + (v[1] != null ? Math.round(v[1]) : "?");
}

/* -------------------------------------------------------------- 2D 信息堆 */
function isOutOfUpdateRange(e) {
  // 最后位置仍然画出，但必须与实时点区分；死亡与出生点已有各自的历史位置语义
  return (e.kind === "player" || e.kind === "ai" || e.kind === "mate" || e.kind === "unknown") && !e.dead && !e.spawn_mark && e.out_of_range === true;
}
function foeHtml(e) {
  if (!PREF.foe || e.kind !== "player" || !(e.team > 0) || e.dead) return "";
  const down = e.status_key === "down" || e.status_key === "dying";
  return '<div class="foe' + (down ? " down" : "") + '">' + (down ? "倒地" : "敌人") + "</div>";
}
function tagHtml(e, d) {
  const parts = [];
  const col = entColor(e);
  const st = e.status_key ? STATE_TXT[e.status_key] : null;
  if (st) parts.push("<b>" + st + "</b>");
  if (e._out_of_range) parts.push('<span class="far">超距·最后位置</span>');
  if (e.spawn_mark) parts.push('<span class="sp">出生点' + (e.age_sec != null ? " " + agoTxt(e.age_sec) : "") + "</span>");
  if (e.team > 0 && e.kind !== "mate") parts.push('<span class="tm">T' + e.team + "</span>");
  if (PREF.wpn) { const w = weaponShort(weaponInfo(e)); if (w) parts.push("<i>" + esc(w) + "</i>"); }
  if (PREF.name) { const n = e.hero || e.name; if (n) parts.push(esc(e.is_bot && !e.hero ? n + "（人机）" : n)); }
  if (PREF.dist && d != null) parts.push('<span class="tnum">' + d.toFixed(0) + "m</span>");
  if (!parts.length) return "";
  return '<div class="tb-wrap"><div class="tag' + (e._out_of_range ? " out-range" : "") + '" style="--tc:' + col + '">' + parts.join("") + "</div></div>";
}
// 地图上的血量：条 + 数值，上限未知时只写数值，未知时写「?」
function mapHpHtml(e) {
  if (!PREF.hp || e.dead) return "";
  const h = hpInfo(e.hp);
  if (h.state === "unknown" && e.hp == null && e.kind !== "player" && e.kind !== "unknown" && e.kind !== "ai") return "";
  return '<div class="hpm' + (e._out_of_range || e.spawn_mark ? " out-range" : "") + '">' + hpBarHtml(e.hp, "hpb")
    + '<span class="hpn" style="color:' + HP_COL[hpColorKey(h)] + '">' + esc(h.state === "unknown" ? "?" : h.short) + "</span></div>";
}
const INFO_SLOTS = ["foe", "tag", "gear", "hp"];
const INFO_HTML = '<div class="ist"><div class="ist-up"><div data-s="foe"></div><div data-s="tag"></div></div>'
  + '<div class="ist-dn"><div data-s="gear"></div><div data-s="hp"></div></div></div>';
function updInfo(key, ll, parts, alert) {
  let it = infos.get(key);
  if (!INFO_SLOTS.some(k => parts[k])) { if (it) { it.m.remove(); infos.delete(key); } return; }
  if (!it) {
    const at = smPos.get(key) || ll;
    const m = L.marker([at.lat, at.lng], { icon: divIcon(INFO_HTML, [0, 0], [0, 0]), keyboard: false, interactive: false, zIndexOffset: 1000 }).addTo(map);
    const root = m.getElement().firstElementChild;
    it = { m, root, slots: {}, html: {}, alert: false };
    for (const el of root.querySelectorAll("[data-s]")) it.slots[el.dataset.s] = el;
    infos.set(key, it);
  }
  for (const k of INFO_SLOTS) {
    const h = parts[k] || "";
    if (it.html[k] !== h) { it.slots[k].innerHTML = h; it.html[k] = h; }
  }
  if (it.alert !== !!alert) { it.alert = !!alert; it.root.classList.toggle("ist-alert", it.alert); }
}
function clearInfos() { for (const it of infos.values()) it.m.remove(); infos.clear(); }
function planeUnits(cm) {
  const i = MAP_INFO, bj = i.bj || 128;
  return cm / ((i.width / bj + i.height / bj) / 2);
}
/* 自身警戒圈：半径 = 贴脸距离；圈内有实时敌人时变红。
   用 DOM 标记而不是 Canvas 圆：它每个平滑步都跟着本人移动，Canvas 圆每次都要在下一帧整块重画，DOM 只改 transform。 */
function sizeAlertRing(zoom) {
  const el = alertCircle && alertCircle.getElement();
  if (!el) return;
  // CRS.Simple 下 1 个坐标单位 = 2^zoom 像素
  const d = Math.max(4, Math.round(planeUnits((Number(PREF.alert) || 0) * 100) * Math.pow(2, zoom) * 2));
  if (el._d === d) return;
  el._d = d;
  el.style.width = el.style.height = d + "px";
  el.style.marginLeft = el.style.marginTop = -d / 2 + "px";
}
function updAlertCircle(ll, threat) {
  const r = Number(PREF.alert) || 0;
  if (!ll || r <= 0) { if (alertCircle) { alertCircle.remove(); alertCircle = null; } return; }
  if (!alertCircle) {
    const at = smPos.get("__self") || ll;
    alertCircle = L.marker([at.lat, at.lng], { icon: L.divIcon({ className: "alert-ring", html: "", iconSize: null }), interactive: false, keyboard: false, zIndexOffset: -1000 }).addTo(map);
    alertCircle._threat = null;
  }
  sizeAlertRing(map.getZoom());
  if (alertCircle._threat !== threat) { alertCircle._threat = threat; alertCircle.getElement().classList.toggle("threat", threat); }
}
/* Tooltip 只在打开时生成，打开中的内容变了才刷新 */
function bindLazyTip(m, opts) {
  m.bindTooltip(l => l._tipHtml !== undefined ? l._tipHtml : (l._tipFn ? l._tipFn() : ""), opts);
  m.on("tooltipclose", () => { m._tipHtml = undefined; });
}
function lazyTip(m, fn) {
  m._tipFn = fn;
  if (!m.isTooltipOpen()) return;
  const t = fn();
  if (m._tipHtml !== t) { m._tipHtml = t; m.getTooltip().update(); }
}
function mkIcon(e, col, rot) {
  const st = e.status_key && STATE_COL[e.status_key] ? STATE_COL[e.status_key] : null;
  const cls = ["mk"];
  if (e.kind === "self") cls.push("self");
  if (e.kind === "unknown") cls.push("unk");
  if (st) cls.push("st");
  if (e.dead) cls.push("dead");
  if (e._out_of_range) cls.push("out-range");
  if (e.spawn_mark) cls.push("spawn");
  if (sel === e.key) cls.push("sel");
  if (e._alert) cls.push("alert");
  let style = "--c:" + col;
  if (st) style += ";--s:" + st;
  if (rot != null) style += ";--rot:" + rot.toFixed(1) + "deg";
  const aim = PREF.cone && rot != null && !e.dead && !e.spawn_mark;
  const gun = aim ? '<i class="mk-gun"></i>' : "";
  const cone = aim ? '<i class="mk-cone"></i>' : "";
  // 只有已知干员用头像；未知身份保留通用圆点，不冒充具体干员
  const face = e.hero
    ? '<img class="mk-face" alt="" src="' + avatarUrl(e.hero) + '" onerror="this.remove()">'
    : '<i class="mk-core"></i>';
  return '<div class="' + cls.join(" ") + '" style="' + style + '">' + gun + cone + face + '</div>';
}
function syncMarkerIcon(m, key, html, htmlBase, rot) {
  if (_rc.iconBase.get(key) === htmlBase) {
    if (rot != null && _rc.icon.get(key) !== html) {
      const el = m.getElement() && m.getElement().firstElementChild;
      if (el) el.style.setProperty("--rot", rot.toFixed(1) + "deg");
      _rc.icon.set(key, html);
    }
  } else if (_rc.icon.get(key) !== html) {
    m.setIcon(divIcon(html, [26,26], [13,13]));
    _rc.icon.set(key, html); _rc.iconBase.set(key, htmlBase);
  }
}
function divIcon(html, size, anchor) {
  return L.divIcon({ className: "", html: html, iconSize: size, iconAnchor: anchor });
}
// 详情：点击或悬停才看的完整档案，包含字段来源的说明
function tipHtml(e, d) {
  const col = entColor(e);
  const h = ['<div class="tip-h"><span style="width:8px;height:8px;border-radius:50%;background:' + col + ';display:inline-block"></span>'
    + esc(nameOf(e)) + (e.team > 0 ? '<span class="tip-dim">T' + e.team + "</span>" : "") + "</div>"];
  if (e.kind === "container") {
    h.push('<div class="tip-r">搜索容器 · 内容未知</div>');
    if (e.class_path) h.push('<div class="tip-r">' + esc(e.class_path.split('.').pop()) + '</div>');
  } else if (e.kind === "box") {
    h.push('<div class="tip-r">物资 <b>' + (e.empty === true ? '已搜空' : e.empty === false ? '未空' : '未知') + '</b></div>');
    if (e.searching_count || e.looting_count) h.push('<div class="tip-r">正在交互 <b>' + Math.max(e.searching_count || 0, e.looting_count || 0) + ' 人</b></div>');
    h.push(boxContentsHtml(e));
  } else if (e.kind === "loot") {
    const value = lootValue(e), count = lootCount(e);
    h.push('<div class="tip-r">品质 <b style="color:' + (GRADE_COL[e.grade] || "#fff") + '">' + (GRADE_NM[e.grade] || "未知") + "</b> · 数量 <b>" + (count == null ? "未知" : count) + "</b></div>");
    if (value.total != null) h.push('<div class="tip-r">参考总价 <b>' + lootMoney(value.total) + '</b></div>');
    if (value.unit != null) h.push('<div class="tip-r">单件参考价 <b>' + lootMoney(value.unit) + '</b></div>');
    if (!lootItemId(e)) h.push('<div class="tip-r">尚未识别物品 ID</div>');
    else if (lootName(e) === "未知物资") h.push('<div class="tip-r">名称表未收录 · ID ' + esc(lootItemId(e)) + '</div>');
    if (value.unit == null) h.push('<div class="tip-r">参考价未知</div>');
    if (e.source_type === 2) h.push('<div class="tip-r">来源 <b>丢弃物</b></div>');
    if (e.pickup_status === "candidate") h.push('<div class="tip-r tip-warn">疑似拾取 · 有人曾在此停留，尚未确认</div>');
    if (e.channel_state === "irrelevant") h.push('<div class="tip-r">最后已知位置</div>');
  } else {
    const fr = freshnessOf(e);
    if (e._out_of_range) h.push('<div class="tip-r tip-warn">超出更新范围 · 最后已知位置</div>');
    if (fr.kind === "spawn") h.push('<div class="tip-r tip-warn">出生点情报 <b>' + (e.age_sec != null ? agoTxt(e.age_sec) : "—") + "</b>（不是实时位置）</div>");
    const id = identityOf(e);
    h.push('<div class="tip-r">身份 <b>' + esc(id.kind === "known" ? id.label : id.kind === "ai" ? "AI" : id.label) + "</b>" + (id.bot ? " · 人机" : "") + "</div>");
    const pose = poseLabel(e);
    if (pose) h.push('<div class="tip-r">状态 <b style="color:' + (STATE_COL[e.status_key] || "#fff") + '">' + esc(pose) + "</b></div>");
    else if (e.status) h.push('<div class="tip-r">状态 <b>' + esc(e.status) + "</b></div>");
    const w = weaponInfo(e);
    h.push('<div class="tip-r">当前武器 <b>' + esc(w.kind === "unlisted" ? "名称未收录 #" + w.id : w.text) + "</b>"
      + (w.kind === "unresolved" && w.raw ? ' <span class="tip-dim">(' + esc(w.raw) + ")</span>" : "") + "</div>");
    if (w.initial && w.initial !== w.text) h.push('<div class="tip-r tip-dim">初始武器 ' + esc(w.initial) + "（出生携带，不代表当前持有）</div>");
    const g = [];
    if (e.helmet) g.push("头" + e.helmet + durTxt(e.helmet_dur));
    if (e.vest) g.push("甲" + e.vest + durTxt(e.vest_dur));
    if (g.length) h.push('<div class="tip-r">护具 <b>' + g.join(" · ") + "</b></div>");
    if (!e.dead) {
      const hi = hpInfo(e.hp), worst = hpWorstPart(e.hp);
      h.push('<div class="tip-r">血量 <b style="color:' + HP_COL[hpColorKey(hi)] + '">' + esc(hi.text) + "</b>"
        + (worst ? ' <span class="tip-dim">最低 ' + worst.name + " " + Math.round(worst.cur) + "/" + Math.round(worst.max) + "</span>" : "") + "</div>");
      if (hi.maxSource === "operator_default") h.push('<div class="tip-r tip-dim">上限来自服务端的干员默认值</div>');
    }
  }
  if (d != null) h.push('<div class="tip-r tnum">距离 <b>' + d.toFixed(0) + "m</b>" + (dz(e) != null ? " · 高差 <b>" + heightTxt(dz(e)) + "</b>" : "") + "</div>");
  h.push('<div class="tip-r tnum tip-dim">x' + Math.round(e.world[0]) + " y" + Math.round(e.world[1]) + " z" + Math.round(e.world[2])
    + (e.yaw != null ? " · " + Math.round(e.yaw) + "°" : "") + "</div>");
  return h.join("");
}
function boxContentsHtml(e) {
  const items = Array.isArray(e.contents) ? e.contents : [];
  if (!e.contents_known && !items.length) return '<div class="tip-r">物品清单 <b>未同步</b></div>'
    + (e.looted ? '<div class="tip-r">已搜刮，但尚未收到该盒子的物品明细</div>' : '');
  const heading = e.contents_known ? '最近同步清单' : '上次清单（待更新）';
  const unknown = items.filter(item => !item.revealed).length;
  const lines = ['<div class="tip-r">' + heading + ' <b>' + items.length + ' 条' + (unknown ? ' · ' + unknown + ' 条未搜索' : '') + '</b></div>'];
  lines.push('<div class="box-items">');
  for (const item of items) {
    const count = Number.isSafeInteger(item.count) && item.count >= 0 ? item.count : '?';
    lines.push('<div class="tip-r"><span>' + esc(item.name || '未识别物品') + '</span><b class="tnum">×' + count + '</b></div>');
  }
  lines.push('</div>');
  return lines.join('');
}

/* -------------------------------------------------------- 物资显示规则 */
function lootCount(e) { return Number.isSafeInteger(e.stack_count) && e.stack_count >= 0 ? e.stack_count : null; }
function lootName(e) { return typeof e.name === "string" && e.name.trim() && e.name !== "物资" ? e.name : "未知物资"; }
function lootItemId(e) { const id = String(e.item_id == null ? "" : e.item_id); return /^[1-9][0-9]{0,19}$/.test(id) ? id : null; }
function lootValue(e) {
  const unit = Number.isFinite(e.price) && e.price >= 0 ? e.price : null, count = lootCount(e);
  const product = unit != null && count != null ? unit * count : null;
  return { unit, total: product != null && Number.isFinite(product) && product <= Number.MAX_SAFE_INTEGER ? product : null };
}
const LOOT_MONEY_FORMAT = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
function lootMoney(value) { return LOOT_MONEY_FORMAT.format(value); }
function lootMinGrade() { const g = Number(PREF.lootmin); return Number.isInteger(g) && g >= 0 && g <= 6 ? g : 4; }
function lootFilterName() { const g = lootMinGrade(); return ({0:"全部品质",3:"蓝及以上",4:"紫及以上",5:"金及以上",6:"仅红"})[g] || g + " 级以上"; }
function lootAvailable(e) {
  return e.kind === "loot" && Array.isArray(e.world) && e.world.length >= 3
    && e.world.slice(0, 3).every(v => Number.isFinite(v) && Math.abs(v) <= 2097152)
    && e.world.slice(0, 3).some(v => v !== 0)
    && !["removed", "confirmed"].includes(e.pickup_status) && e.hidden !== true
    && e.item_state !== 5 && lootCount(e) !== 0;
}
function lootGradeOk(e) { return lootMinGrade() === 0 || (Number.isInteger(e.grade) && e.grade >= lootMinGrade() && e.grade <= 6); }
function lootVisible(e) { return !!PREF.loot && lootAvailable(e) && lootGradeOk(e); }
function lootIdentity(e) {
  const gid = typeof e.inventory_gid === "string" ? e.inventory_gid : Number.isSafeInteger(e.inventory_gid) ? String(e.inventory_gid) : "";
  return /^[1-9][0-9]*$/.test(gid) && lootItemId(e) ? gid + ":" + lootItemId(e) : null;
}
function prepareLootEntities(entities) {
  const latest = new Map(), other = [];
  for (const e of entities) {
    if (e.kind !== "loot") { other.push(e); continue; }
    const id = lootIdentity(e) || "actor:" + e.key, old = latest.get(id);
    const seq = x => Number.isFinite(x.updated_seq) ? x.updated_seq : -1;
    if (!old || seq(e) > seq(old) || (seq(e) === seq(old) && String(e.key) > String(old.key))) latest.set(id, e);
  }
  return other.concat([...latest.values()].filter(lootAvailable));
}
function lootSort(a, b) {
  const near = e => { const d = dist2(e); return Number.isFinite(d) ? d : 1e18; };
  const va = lootValue(a), vb = lootValue(b);
  const value = (va.total == null) - (vb.total == null) || (vb.total || 0) - (va.total || 0)
    || (va.unit == null) - (vb.unit == null) || (vb.unit || 0) - (va.unit || 0);
  const quality = (b.grade || 0) - (a.grade || 0), distance = near(a) - near(b);
  const order = PREF.lootsort === "dist" ? distance || quality || value :
    PREF.lootsort === "grade" ? quality || value || distance : value || quality || distance;
  return order || lootName(a).localeCompare(lootName(b), "zh") || String(a.key).localeCompare(String(b.key));
}
function lootThumb(e) {
  const id = lootItemId(e), label = lootName(e);
  return '<span class="loot-thumb' + (label === "未知物资" ? " unk" : "") + '" style="--c:' + (GRADE_COL[e.grade] || "#8c96a8") + '">'
    + '<span aria-hidden="true">' + esc(label === "未知物资" ? "?" : initials(label)) + '</span>'
    + (id ? '<img loading="lazy" alt="" src="' + LOOT_IMG(id) + '" onerror="this.remove()">' : '') + '</span>';
}
function lootIconHtml(e) {
  const count = lootCount(e);
  return lootThumb(e) + (count != null && count > 1 ? '<span class="loot-qty">×' + count + '</span>' : '')
    + (e.pickup_status === "candidate" ? '<span class="loot-question">?</span>' : '');
}
function loot3dSnapshot(s) {
  return { ...s, entities: prepareLootEntities(s.entities || []).filter(visible)
    .map(e => e.kind !== "loot" ? e : { ...e, name: lootName(e)
      + (lootCount(e) != null && lootCount(e) > 1 ? " ×" + lootCount(e) : "")
      + (e.pickup_status === "candidate" ? " · 疑似拾取" : "") }) };
}

/* -------------------------------------------------------------- 主渲染 */
function visible(e) {
  if (e.kind === "container" && !PREF.container) return false;
  if (e.kind === "box" && !PREF.box) return false;
  if (e.kind === "box" && !PREF.aibox && (e.is_ai === true || e.is_bot === true)) return false;
  if (e.kind === "ai" && !PREF.ai) return false;
  if (e.kind === "loot") return lootVisible(e);
  if (e.kind === "mate" && !PREF.mate) return false;
  return true;
}
function followSessionIdentity(s) {
  return JSON.stringify([s.session, s.epoch, s.flow, s.local, s.remote]);
}
function followTargetInvalid(previous, current, key) {
  if (!previous) return false;
  if (followSessionIdentity(previous) !== followSessionIdentity(current)) return true;
  if (!key || key === "__self") return false;
  const old = (previous.entities || []).find(e => e.key === key);
  const next = (current.entities || []).find(e => e.key === key);
  if (!next) return true;
  return !!old && ["kind", "eid", "actor_guid", "spawn_seq"].some(k => old[k] !== next[k]);
}
function resetFollowTarget() {
  followKey = "__self"; sel = null; _rc.icon.clear();
  if (R3 && R3.setFollowKey) R3.setFollowKey("__self");
  forceLists();
}
// 3D 打开且不显示小地图（或手机）时不维护 2D 标记
function render2d() { return !is3d() || (PREF.pip !== 0 && !MOBILE()); }
let _r2dPrev = true, _centeredFor = "";
function draw(s) {
  if (followTargetInvalid(lastSnap, s, followKey)) resetFollowTarget();
  if (lastSnap && sel && lastSnap.flow !== s.flow) sel = null;
  lastSnap = s;
  const alertR = Number(PREF.alert) || 0;
  const r2d = render2d(), showInfo = r2d && !is3d();
  if (r2d !== _r2dPrev) { _r2dPrev = r2d; if (!r2d) purge(true); }
  if (!showInfo && infos.size) clearInfos();

  /* --- 自己 --- */
  const self = validWorld(s.self) ? s.self : null;
  let selfLL = null;
  if (self && r2d) {
    const ll = selfLL = pointLatLng(self);
    const rot = yawToScreen(self, s.self_yaw);
    const ownLife = s.self_life;
    const ownState = ownLife && ownLife.dead ? "dead" : ownLife && ownLife.downed ? "down" : null;
    const pe = { key:"__self", kind:"self", world:self, yaw:s.self_yaw, name:displaySelfName(s), hero:s.self_hero || null, status_key:ownState, status:STATE_TXT[ownState] || null };
    const html = mkIcon(pe, C_SELF, rot);
    const htmlBase = rot != null ? mkIcon(pe, C_SELF, null) : html;
    if (!selfMarker) {
      selfMarker = L.marker(ll, { icon: divIcon(html, [26, 26], [13, 13]), keyboard:false, zIndexOffset:1200 });
      bindLazyTip(selfMarker, { direction:"top", offset:[0,-12] });
      selfMarker.addTo(map);
      selfMarker.on("click", () => focusEntity("__self"));
      _rc.icon.set("__self", html); _rc.iconBase.set("__self", htmlBase);
      smPos.set("__self", { lat: ll.lat, lng: ll.lng });
    } else syncMarkerIcon(selfMarker, "__self", html, htmlBase, rot);
    const spos = self[0] + "," + self[1];
    if (_rc.pos.get("__self") !== spos) { _rc.pos.set("__self", spos); smSet("__self", ll); }
    // 每个会话 / 每张图第一次拿到本人坐标时以自己为中心放大；之后只平移，不抢用户的缩放
    const sess = followSessionIdentity(s) + "|" + MAP_INFO.key;
    if (_centeredFor !== sess && follow && followKey === "__self") {
      _centeredFor = sess;
      map.setView(ll, Math.max(map.getZoom(), MOBILE() ? 4.5 : 4.75), { animate: false });
    }
    lazyTip(selfMarker, () => selfTipHtml(s));
    if (showInfo) updInfo("__self", ll, { hp: PREF.hp ? mapHpHtml({ kind:"self", hp:s.self_hp }) : "" }, false);
  } else if (selfMarker) {
    selfMarker.remove(); selfMarker = null;
    _rc.pos.delete("__self"); _rc.icon.delete("__self");
    smTgt.delete("__self"); smPos.delete("__self");
    updInfo("__self", null, {}, false);
  }

  /* --- 实体 --- */
  const seen = new Set();
  const entered = [];
  let threat = false;
  const ents = prepareLootEntities(s.entities || []);
  for (const e of ents) {
    if (!e.world || !visible(e)) continue;
    seen.add(e.key);
    const d = dist2(e);
    e._out_of_range = isOutOfUpdateRange(e);
    // 贴脸只认实时坐标（出生点 / 超距不触发），进入 alertR、退出 1.25×alertR 防抖
    const alertPrev = alertHold.get(e.key) === true;
    const alertLimit = alertPrev ? alertR * 1.25 : alertR;
    const alertOn = alertR > 0 && d != null && d <= alertLimit && !e.spawn_mark && !e._out_of_range
      && (e.kind === "player" || e.kind === "ai") && !e.dead;
    if (alertOn !== alertPrev) { alertHold.set(e.key, alertOn); if (alertOn) entered.push({ e, d }); }
    e._alert = alertOn;
    if (alertOn) threat = true;
    if (!r2d) continue;
    const ll = pointLatLng(e.world), col = entColor(e);
    const ppos = e.world[0] + "," + e.world[1] + "," + e.world[2];
    let m = markers.get(e.key);
    if (e.kind === "loot") {
      const cls = "loot-point" + (sel === e.key ? " sel" : "") + (e.pickup_status === "candidate" ? " candidate" : "");
      const html = lootIconHtml(e), signature = cls + html;
      const icon = () => L.divIcon({html, className: cls, iconSize:[30,30], iconAnchor:[15,15]});
      if (!m) {
        m = L.marker(ll, { icon:icon(), keyboard:false, flat:true, zIndexOffset:sel === e.key ? 1400 : 0 });
        bindLazyTip(m, {direction:"top",offset:[0,-16]});
        m.addTo(map); markers.set(e.key,m);
        m.on("click", () => focusEntity(e.key));
        smSet(e.key, ll);
        _rc.pos.set(e.key,ppos); _rc.icon.set(e.key,signature);
      } else {
        if (_rc.pos.get(e.key) !== ppos) { m.setLatLng(ll); _rc.pos.set(e.key,ppos); smSet(e.key, ll); }
        if (_rc.icon.get(e.key) !== signature) { m.setIcon(icon()); _rc.icon.set(e.key,signature); }
        const z = sel === e.key ? 1400 : 0;
        if (m.options.zIndexOffset !== z) m.setZIndexOffset(z);
      }
      lazyTip(m, () => tipHtml(e, d));
    } else if (e.kind === "box" || e.kind === "container") {
      if (!m) {
        m = L.marker(ll, { icon: divIcon('<div class="dbox' + (e.kind === "container" ? " cont" : "") + '" style="--box:' + entColor(e) + '"></div>', [16,16], [8,8]), keyboard:false, flat:true });
        bindLazyTip(m, { direction:"top", offset:[0,-10], interactive:true });
        m.on("tooltipopen", event => { const el = event.tooltip.getElement(); if (el) L.DomEvent.disableScrollPropagation(el); });
        m.addTo(map); markers.set(e.key, m); _rc.pos.set(e.key, ppos);
        m.on("click", () => focusEntity(e.key));
        smSet(e.key, ll);
      } else if (_rc.pos.get(e.key) !== ppos) { m.setLatLng(ll); _rc.pos.set(e.key, ppos); smSet(e.key, ll); }
      lazyTip(m, () => tipHtml(e, d));
    } else {
      const rot = e.spawn_mark ? null : yawToScreen(e.world, e.yaw);
      const html = mkIcon(e, col, rot);
      const htmlBase = rot != null ? mkIcon(e, col, null) : html;
      if (!m) {
        m = L.marker(ll, { icon: divIcon(html, [26,26], [13,13]), keyboard:false, zIndexOffset: e.kind === "mate" ? 400 : 600 });
        bindLazyTip(m, { direction:"top", offset:[0,-12] });
        m.addTo(map); markers.set(e.key, m);
        m.on("click", () => focusEntity(e.key));
        _rc.icon.set(e.key, html); _rc.iconBase.set(e.key, htmlBase); _rc.pos.set(e.key, ppos);
        smPos.set(e.key, { lat: ll.lat, lng: ll.lng });
      } else {
        syncMarkerIcon(m, e.key, html, htmlBase, rot);
        if (_rc.pos.get(e.key) !== ppos) { _rc.pos.set(e.key, ppos); smSet(e.key, ll); }
      }
      lazyTip(m, () => tipHtml(e, d));
      if (showInfo) updInfo(e.key, ll, {
        foe: foeHtml(e),
        tag: e.kind !== "mate" ? tagHtml(e, d) : "",
        gear: PREF.gear && !e.dead ? gearBarHtml(e) : "",
        hp: mapHpHtml(e),
      }, alertOn);
    }
    /* 轨迹：滚动窗口，用首尾 + 长度做指纹 */
    let tl = trails.get(e.key);
    if (PREF.trail && e.trail && e.trail.length > 1 && CHAR_KINDS.has(e.kind)) {
      const t0 = e.trail[0], t1 = e.trail[e.trail.length - 1];
      const th = t0[0] + "," + t0[1] + "|" + t1[0] + "," + t1[1] + "|" + e.trail.length + "|" + (e._out_of_range ? "far" : "near");
      if (_rc.trail.get(e.key) !== th) {
        const lls = e.trail.map(pointLatLng);
        if (!tl) { tl = L.polyline(lls, { color: col, weight: 1.6, opacity: e._out_of_range ? .10 : .38, interactive: false }); tl.addTo(map); trails.set(e.key, tl); }
        else { tl.setLatLngs(lls); tl.setStyle({ color: col, opacity: e._out_of_range ? .10 : .38 }); }
        _rc.trail.set(e.key, th);
      }
    } else if (tl) { tl.remove(); trails.delete(e.key); _rc.trail.delete(e.key); }
  }
  if (r2d) {
    for (const [k, m] of markers) if (!seen.has(k)) {
      m.remove(); markers.delete(k);
      _rc.pos.delete(k); _rc.icon.delete(k); _rc.iconBase.delete(k); _rc.trail.delete(k);
      smPos.delete(k); smTgt.delete(k);
      const t = trails.get(k); if (t) { t.remove(); trails.delete(k); }
    }
    for (const [k, it] of infos) if (!seen.has(k) && k !== "__self") { it.m.remove(); infos.delete(k); }
    updAlertCircle(selfLL, threat);
  }
  for (const k of [...alertHold.keys()]) if (!seen.has(k)) alertHold.delete(k);
  if (sel && !seen.has(sel) && sel !== "__self") sel = null;
  lastEnts = ents;
  if (entered.length) notifyAlert(entered, s);
  updateSelfUI(s, ents);
  scheduleLists();
}
function selfTipHtml(s) {
  const hi = hpInfo(s.self_hp), w = selfWeaponInfo(s), pose = selfPoseLabel(s), aim = aimState(s);
  return '<div class="tip-h"><span style="width:8px;height:8px;border-radius:50%;background:' + C_SELF + ';display:inline-block"></span>' + esc(displaySelfName(s)) + '<span class="tip-dim">自己</span></div>'
    + '<div class="tip-r">干员 <b>' + esc(s.self_hero || "未解析") + '</b></div>'
    + '<div class="tip-r">血量 <b style="color:' + HP_COL[hpColorKey(hi)] + '">' + esc(hi.text) + '</b></div>'
    + '<div class="tip-r">当前武器 <b>' + esc(w.kind === "unlisted" ? "名称未收录 #" + w.id : w.text) + '</b></div>'
    + (pose ? '<div class="tip-r">状态 <b>' + esc(pose) + '</b></div>' : '')
    + '<div class="tip-r">' + esc(aim.text) + '</div>'
    + '<div class="tip-r tip-dim">位置基准 ' + esc(s.self_position_origin || "未提供") + '</div>';
}

/* 进入提醒：敌人刚以实时坐标跨进贴脸距离时弹出「谁 · 方位 · 距离」；2.5 s 内不重复 */
let _alertToastAt = 0;
function notifyAlert(entered, s) {
  const pill = $("status-pill");
  if (pill.animate) pill.animate([{ boxShadow: "0 0 0 0 rgba(255,45,63,0)" }, { boxShadow: "0 0 0 6px rgba(255,45,63,.5)" }, { boxShadow: "0 0 0 0 rgba(255,45,63,0)" }], { duration: 700, iterations: 2 });
  if (!PREF.alerttoast) return;
  const now = performance.now();
  if (now - _alertToastAt < 2500) return;
  _alertToastAt = now;
  entered.sort((a, b) => a.d - b.d);
  const { e, d } = entered[0];
  const who = (e.kind === "ai" ? "AI " : "敌方 ") + (e.team > 0 && e.kind === "player" ? "T" + e.team + " " : "") + (e.hero || e.name || KIND_NM[e.kind] || "");
  const dir = bearingOf(e, s.self_yaw);
  toast("⚠ " + who + " 进入 " + (Number(PREF.alert) || 0) + "m · " + (dir ? dir + " " : "") + d.toFixed(0) + "m"
    + (entered.length > 1 ? "（另 " + (entered.length - 1) + " 个）" : ""), "alert");
}

/* -------------------------------------------------------------- 自己卡 / 自己条 / 抽屉摘要 */
function setText(id, v) { const el = $(id); if (el && el.textContent !== v) el.textContent = v; }
function setHpBar(id, hp) {
  const el = $(id); if (!el) return;
  const h = hpInfo(hp), key = hpColorKey(h);
  const sig = h.state + "|" + (h.frac == null ? "" : h.frac.toFixed(3)) + "|" + key;
  if (el._sig === sig) return;
  el._sig = sig;
  el.classList.toggle("unk", h.frac == null && h.state !== "zero");
  const i = el.firstElementChild;
  i.style.width = h.frac == null ? "0%" : (h.frac * 100).toFixed(1) + "%";
  i.style.background = HP_COL[key];
}
function setAvatar(id, hero, label, color) {
  const el = $(id); if (!el) return;
  const sig = hero + "|" + label + "|" + color;
  if (el._sig === sig) return;
  el._sig = sig;
  el.style.setProperty("--c", color);
  el.classList.toggle("dashed", !hero);
  el.innerHTML = esc(initials(label)) + (hero ? '<img alt="" src="' + avatarUrl(hero) + '" onerror="this.remove()">' : "");
}
function updateSelfUI(s, ents) {
  const selfOk = validWorld(s.self);
  const name = displaySelfName(s);
  const hi = hpInfo(s.self_hp), w = selfWeaponInfo(s), pose = selfPoseLabel(s);
  const foe = selfOk ? nearestFoe(ents, s.self_yaw) : null;
  const alerts = ents.reduce((n, e) => n + (e._alert ? 1 : 0), 0);
  const foeTxt = !selfOk ? "距离与方位不可用" : foe ? foe.d.toFixed(0) + "m" + (foe.dir ? " " + foe.dir : "") + (foe.dz != null && Math.abs(foe.dz) >= 1 ? " " + heightTxt(foe.dz) : "") : "当前快照无实时敌方玩家";
  setAvatar("self-av", s.self_hero || "", name, C_SELF);
  setText("self-name", name);
  setText("self-id", "自己 · " + (s.self_hero || "干员未解析") + (selfOk ? "" : " · 位置未解析") + (pose ? " · " + pose : ""));
  setHpBar("self-hpbar", s.self_hp);
  const hpEl = $("self-hp"); setText("self-hp", hi.state === "nomax" ? hi.short : hi.text); hpEl.style.color = HP_COL[hpColorKey(hi)];
  setText("self-gear", w.kind === "unlisted" ? "武器名称未收录" : w.text);
  setText("self-foe", foeTxt);
  $("self-foe").classList.toggle("muted", !foe);
  const arrow = $("self-foe-arrow");
  if (foe && foe.angle != null) { arrow.hidden = false; arrow.style.setProperty("--a", foe.angle.toFixed(0) + "deg"); } else arrow.hidden = true;
  setText("self-alert", Number(PREF.alert) > 0 && selfOk ? PREF.alert + "m 内 " + alerts : "");
  // 手机自己条
  setAvatar("strip-av", s.self_hero || "", name, C_SELF);
  setText("strip-name", name);
  setHpBar("strip-hpbar", s.self_hp);
  setText("strip-hp", hi.state === "nomax" ? hi.short : hi.text); $("strip-hp").style.color = HP_COL[hpColorKey(hi)];
  setText("strip-foe", !selfOk ? "位置未解析" : foe ? "敌 " + foe.d.toFixed(0) + "m" + (foe.dir ? " " + foe.dir : "") : "无实时敌人");
  updatePeek(s, ents, foe);
}
// 手机抽屉收起时的摘要：跟随对象 + 血量 + 最近实时敌人
function updatePeek(s, ents, foe) {
  // 没有对局时只说明在等待 / 连接，不展示空的自己与血量
  if (liveState.key === "waiting" || liveState.key === "connecting") {
    const waiting = liveState.key === "waiting";
    setText("peek-mode", ""); setText("peek-name", waiting ? "等待对局" : "连接中"); setText("peek-hp", "");
    $("peek-dot").style.background = waiting ? "var(--st-waiting)" : "var(--st-connecting)";
    setText("peek-foe", waiting ? "服务在线 · 尚无对局数据（不代表附近没有敌人）" : "正在连接服务"); setText("peek-extra", "");
    return;
  }
  const fk = followKey;
  let name, hp, color = C_SELF, extra;
  if (fk === "__self") { const n = displaySelfName(s); name = n === "自己" ? n : n + "（自己）"; hp = hpInfo(s.self_hp); extra = selfWeaponInfo(s).text; }
  else { const e = ents.find(x => x.key === fk); name = e ? (e.name || KIND_NM[e.kind]) : "目标已离开"; hp = hpInfo(e && e.hp); color = e ? entColor(e) : C_UNK; extra = e ? weaponInfo(e).text : ""; }
  const mode = is3d() ? ({ fpv: "第一跟随", chase: "第三跟随", orbit: "自由", top: "俯视" })[R3 ? R3.camMode : PREF.cam3d] || "" : follow ? "跟随" : "";
  setText("peek-mode", mode);
  setText("peek-name", name);
  $("peek-dot").style.background = color;
  setText("peek-hp", hp.state === "nomax" ? hp.short : hp.text); $("peek-hp").style.color = HP_COL[hpColorKey(hp)];
  const c = countsOf(ents);
  setText("peek-foe", "敌方玩家（已知）" + c.players + " · " + (validWorld(s.self) ? (foe ? "最近 " + foe.d.toFixed(0) + "m " + (foe.dir || "") : "无实时敌人") : "本人位置未解析"));
  setText("peek-extra", extra || "");
}

/* ------------------------------------------------------------ 目标 / 物资列表 */
// 只渲染当前可见分页；目标页最多 5 Hz，物资页最多 2.5 Hz；收起时完全不渲染，展开时强制补一帧。
// 贴脸提醒、地图标记与本人卡片不受此节流，列表只承担排序与细节浏览。
const ROSTER_MS = 200, LOOT_MS = 400;
let _listAt = { targets: 0, loot: 0 }, _listTimer = 0, _listForce = true;
function forceLists() { _listForce = true; scheduleLists(); }
function panelVisible() { return MOBILE() ? sheetState !== "peek" : !!PREF.panel; }
function scheduleLists() {
  if (!lastSnap) return;
  const tab = PREF.ptab === "loot" ? "loot" : "targets";
  const gap = tab === "loot" ? LOOT_MS : ROSTER_MS;
  const wait = _listForce ? 0 : gap - (performance.now() - _listAt[tab]);
  if (wait > 0) { if (!_listTimer) _listTimer = setTimeout(() => { _listTimer = 0; drawLists(); }, wait); return; }
  drawLists();
}
function drawLists() {
  if (_listTimer) { clearTimeout(_listTimer); _listTimer = 0; }
  const s = lastSnap; if (!s) return;
  const ents = lastEnts;
  const tab = PREF.ptab === "loot" ? "loot" : "targets";
  const ops = opList(s, ents);
  const allLoot = ents.filter(lootAvailable);
  const lootCountShown = allLoot.filter(lootGradeOk).length;
  setText("n-ops", String(ops.length)); setText("rail-ops", String(ops.length));
  setText("n-loot", String(allLoot.length)); setText("rail-loot", String(allLoot.length));
  const visiblePanel = panelVisible();
  _listForce = false;
  if (!visiblePanel) return;
  _listAt[tab] = performance.now();
  if (tab === "targets") drawTargets(s, ops); else drawLoot(s, ents, allLoot, lootCountShown);
}
function selfAsOp(s) {
  if (!validWorld(s.self) && !s.self_name && !s.self_hp) return null;
  const life = s.self_life;
  const ownState = life && life.dead ? "dead" : life && life.downed ? "down" : null;
  return { key:"__self", kind:"self", world:validWorld(s.self) ? s.self : null, rel:[0,0,0], yaw:s.self_yaw,
           name:displaySelfName(s), hero:s.self_hero || null, status_key:ownState, status:STATE_TXT[ownState] || null,
           hp:s.self_hp, dead:!!(life && life.dead), pose:s.self_pose };
}
function opList(s, ents) {
  const ops = ents.filter(e => e.world && CHAR_KINDS.has(e.kind) && visible(e));
  const so = selfAsOp(s);
  if (so) ops.unshift(so);
  return ops;
}
function grpOf(e) {
  if (e.kind === "self" || e.kind === "mate") return { id:"ally", nm:"我方", c:C_SELF, o:0 };
  if (e.kind === "ai") return { id:"ai", nm:"AI（位置来自出生点或实时）", c:C_AI, o:7 };
  if (e.kind === "unknown") return { id:"unk", nm:"未知身份", c:C_UNK, o:6 };
  if (e.team > 0) return { id:"t" + e.team, nm:"敌方 · 第 " + e.team + " 队", c:C_FOE, o:2 };
  return { id:"foe", nm:"敌方玩家（未分队）", c:C_FOE, o:3 };
}
function threatSort(a, b) {
  const da = dist2(a), db = dist2(b);
  if (da == null && db == null) return 0;
  if (da == null) return 1;
  if (db == null) return -1;
  return da - db;
}
function opRow(e) {
  const isSelf = e.kind === "self";
  const col = entColor(e), id = identityOf(e), fr = freshnessOf(e);
  const st = e.status_key;
  const badges = [];
  const pose = poseLabel(e);
  if (st && STATE_TXT[st]) badges.push('<span class="badge" style="--b:' + STATE_COL[st] + '">' + STATE_TXT[st] + "</span>");
  else if (pose && pose !== "阵亡") badges.push('<span class="badge ghost">' + pose + "</span>");
  else if (e.dead) badges.push('<span class="badge ghost">阵亡</span>');
  badges.push('<span class="badge alert" data-alert hidden>贴脸</span>');
  if (fr.kind === "far") badges.push('<span class="badge ghost warn">超距·最后位置</span>');
  if (fr.kind === "spawn") badges.push('<span class="badge ghost warn">出生点 <i data-age></i></span>');
  if (e.is_bot && e.kind !== "ai") badges.push('<span class="badge info">人机</span>');
  const w = isSelf ? null : weaponInfo(e);
  const meta = [];
  if (w) meta.push('<span class="wp' + (w.kind === "unresolved" ? " dim" : w.kind === "unlisted" ? " warn" : "") + '" title="' + esc(w.initial && w.initial !== w.text ? "初始武器 " + w.initial + "（出生携带）" : "当前持有") + '">' + esc(w.kind === "unlisted" ? "武器名称未收录 #" + w.id : w.text) + "</span>");
  if (e.team > 0 && e.kind !== "mate" && e.kind !== "self") meta.push('<span>T' + e.team + "</span>");
  if (e.helmet || e.vest) meta.push('<span class="gear-inline">' + (e.helmet ? gearIconHtml("helmet", e.helmet, gearValue(e.helmet_dur, e.helmet)) : "") + (e.vest ? gearIconHtml("armor", e.vest, gearValue(e.vest_dur, e.vest)) : "") + "</span>");
  const title = isSelf ? e.name : (e.kind === "ai" ? (e.name || "AI") : e.kind === "unknown" ? (e.name || "未知玩家") : (e.name || "未命名"));
  const sub = isSelf ? "自己 · " + (e.hero || "干员未解析") : id.kind === "known" ? id.label : id.kind === "ai" ? "" : id.label;
  const avatar = id.kind === "known" || (isSelf && e.hero)
    ? esc(initials(e.hero)) + '<img alt="" src="' + avatarUrl(e.hero) + '" onerror="this.remove()">'
    : esc(e.kind === "ai" ? "AI" : e.kind === "unknown" ? "?" : initials(title));
  return '<div class="op' + (sel === e.key || (isSelf && followKey === "__self" && sel === null) ? " sel" : "") + (e.dead ? " dead" : "")
    + (fr.kind === "spawn" || fr.kind === "far" ? " stale" : "") + '" data-k="' + esc(e.key) + '">'
    + '<span class="side" style="--c:' + col + '"></span>'
    + '<span class="av' + (id.kind === "known" || (isSelf && e.hero) ? "" : " dashed") + '" style="--c:' + col + '">' + avatar + "</span>"
    + '<div class="op-main">'
    +   '<div class="op-l1"><b class="op-name">' + esc(title) + '</b>' + (sub ? '<span class="op-hero">' + esc(sub) + "</span>" : "") + "</div>"
    +   '<div class="op-l2">' + badges.join("") + meta.join('<i class="sep">·</i>') + "</div>"
    +   (e.dead ? "" : '<div class="op-l3" data-hp></div>')
    + "</div>"
    + '<div class="op-r"><b class="op-d tnum" data-d>—</b><span class="op-z tnum"><svg class="brg" data-brg hidden><use href="#i-arrow"/></svg><span data-z></span></span></div>'
    + "</div>";
}
function drawTargets(s, ops) {
  const layout = [];
  const yaw = s.self_yaw;
  const c = countsOf(lastEnts);
  setText("ops-note", "计数为当前已收到的目标，不代表全场人数 · 敌方玩家（已知）" + c.players + (c.down ? " · 倒地 " + c.down : "") + (c.dead ? " · 阵亡 " + c.dead : ""));
  setText("ops-hint", liveState.key === "waiting" || liveState.key === "connecting" ? "" : validWorld(s.self) ? "距离与方位相对自己" : "本人位置未解析");
  if (PREF.sort === "team") {
    const groups = new Map();
    for (const e of ops) { const g = grpOf(e); if (!groups.has(g.id)) groups.set(g.id, { g, items: [] }); groups.get(g.id).items.push(e); }
    const arr = [...groups.values()];
    for (const x of arr) { x.items.sort((a, b) => (a.kind === "self" ? -1 : b.kind === "self" ? 1 : threatSort(a, b))); x.near = x.items.reduce((m, e) => { if (e.kind === "self" || e.spawn_mark) return m; const d = dist2(e); return d != null && (m == null || d < m) ? d : m; }, null); }
    arr.sort((a, b) => a.g.o - b.g.o || (a.near ?? 1e9) - (b.near ?? 1e9));
    for (const x of arr) {
      const fold = foldGrp.has(x.g.id);
      layout.push({ id: x.g.id, folded: fold,
        headHtml: '<div class="grp' + (fold ? " fold" : "") + '" data-g="' + x.g.id + '"><i class="grp-bar" style="--c:' + x.g.c + '"></i><span class="grp-name">' + x.g.nm + '</span><span class="grp-cnt tnum">' + x.items.length + '</span><span class="grow"></span>'
          + (x.near != null ? '<span class="grp-near tnum">最近 ' + x.near.toFixed(0) + "m</span>" : "") + '<svg class="ic xs grp-car"><use href="#i-chev"/></svg></div>',
        rows: x.items.map(e => ({ key: e.key, html: opRow(e) })) });
    }
  } else {
    const list = ops.slice().sort((a, b) => {
      if (a.kind === "self") return -1; if (b.kind === "self") return 1;
      const pa = a._alert ? 0 : 1, pb = b._alert ? 0 : 1; if (pa !== pb) return pa - pb;
      const sa = a.spawn_mark || a._out_of_range ? 1 : 0, sb = b.spawn_mark || b._out_of_range ? 1 : 0; if (sa !== sb) return sa - sb;
      return threatSort(a, b);
    });
    layout.push({ id: "flat", headHtml: null, rows: list.map(e => ({ key: e.key, html: opRow(e) })) });
  }
  const st = liveState.key;
  const empty = st === "connecting" ? emptyHtml("正在连接服务", "还没有收到任何快照")
    : st === "waiting" ? emptyHtml("服务在线 · 等待对局数据", "这不代表附近没有敌人")
    : st === "error" && !lastSnap ? emptyHtml("连接异常", "正在重试")
    : emptyHtml("当前快照没有可显示的目标", "不代表附近没有敌人；可能未收到或被图层隐藏");
  renderKeyed($("ops-body"), opRows, layout, empty);
  syncOpLive(ops, yaw);
}
function syncOpLive(ops, yaw) {
  for (const e of ops) {
    const row = opRows.get(e.key);
    if (!row) continue;
    const r = row.refs || (row.refs = { d: row.node.querySelector("[data-d]"), z: row.node.querySelector("[data-z]"), brg: row.node.querySelector("[data-brg]"),
      alert: row.node.querySelector("[data-alert]"), age: row.node.querySelector("[data-age]"), hp: row.node.querySelector("[data-hp]") });
    const isSelf = e.kind === "self";
    const d = isSelf ? null : dist2(e), z = isSelf ? null : dz(e);
    const dtxt = isSelf ? "—" : d != null ? d.toFixed(0) + "m" : "—";
    if (r.d && r.d._v !== dtxt) { r.d.textContent = dtxt; r.d._v = dtxt; }
    if (r.d && r.d._al !== !!e._alert) { r.d._al = !!e._alert; r.d.classList.toggle("al", !!e._alert); }
    const ang = isSelf ? null : relAngle(e, yaw);
    const ztxt = isSelf ? (Number.isFinite(e.yaw) ? "朝向 " + Math.round(((e.yaw % 360) + 360) % 360) + "°" : "") : [heightTxt(z), ang != null ? bearingOf(e, yaw) : ""].filter(Boolean).join(" · ");
    if (r.z && r.z._v !== ztxt) { r.z.textContent = ztxt; r.z._v = ztxt; }
    if (r.brg) {
      const show = ang != null;
      if (r.brg.hidden === show) r.brg.hidden = !show;
      if (show && (r.brg._a == null || Math.abs(r.brg._a - ang) > 2)) { r.brg.style.setProperty("--a", ang.toFixed(0) + "deg"); r.brg._a = ang; }
    }
    if (r.alert && r.alert.hidden !== !e._alert) r.alert.hidden = !e._alert;
    if (row.node._al !== !!e._alert) { row.node._al = !!e._alert; row.node.classList.toggle("alert", !!e._alert); }
    if (r.age && e.age_sec != null) { const a = agoTxt(e.age_sec); if (r.age._v !== a) { r.age.textContent = a; r.age._v = a; } }
    if (r.hp) { const hh = hpLineHtml(e.hp); if (r.hp._v !== hh) { r.hp.innerHTML = hh; r.hp._v = hh; } }
  }
}
function lootRowHtml(e) {
  const col = GRADE_COL[e.grade] || "#8c96a8";
  const count = lootCount(e), value = lootValue(e), name = lootName(e);
  const detail = [GRADE_NM[e.grade] || "品质未知"];
  detail.push(value.total != null ? "参考价 " + lootMoney(value.total) : value.unit != null ? "单件 " + lootMoney(value.unit) : "参考价未知");
  if (name === "未知物资") detail.unshift(lootItemId(e) ? "名称未收录" : "ID 待识别");
  if (count == null) detail.push("数量未知");
  if (e.source_type === 2) detail.push("丢弃物");
  const flags = (e.pickup_status === "candidate" ? '<span class="badge ghost warn">疑似拾取</span>' : "") + (e.channel_state === "irrelevant" ? '<span class="badge ghost">最后位置</span>' : "");
  return '<div class="lr' + (sel === e.key ? " sel" : "") + '" data-k="' + esc(e.key) + '">' + lootThumb(e)
    + '<div class="op-main"><div class="op-l1"><b class="op-name" style="color:' + (name === "未知物资" ? "var(--txt-2)" : col) + '">' + esc(name) + '</b>'
    + (count != null ? '<span class="op-hero tnum">×' + count + "</span>" : "") + "</div>"
    + '<div class="op-l2">' + flags + esc(detail.join(" · ")) + "</div></div>"
    + '<div class="op-r"><b class="op-d tnum" data-d>—</b><span class="op-z tnum" data-z></span></div></div>';
}
function boxRowHtml(e) {
  const col = entColor(e);
  const st = e.status_key && STATE_TXT[e.status_key] ? STATE_TXT[e.status_key] : e.empty === true ? "已搜空" : e.empty === false ? "未空" : "物资未知";
  const items = Array.isArray(e.contents) ? e.contents.length : 0;
  const info = e.kind === "container" ? "搜索容器 · 内容未知" : st + " · " + (e.contents_known ? "清单 " + items + " 条" : items ? "上次清单 " + items + " 条" : "清单未同步");
  return '<div class="lr box' + (sel === e.key ? " sel" : "") + '" data-k="' + esc(e.key) + '"><span class="dthumb" style="--c:' + col + '"></span>'
    + '<div class="op-main"><div class="op-l1"><b class="op-name">' + esc(e.kind === "container" ? (e.name || "容器") : (e.name || "死亡盒")) + "</b>"
    + (e.is_ai || e.is_bot ? '<span class="op-hero">AI / 人机</span>' : "") + '</div><div class="op-l2">' + esc(info) + "</div>"
    + (sel === e.key && e.kind === "box" ? '<div class="box-detail">' + boxContentsHtml(e) + "</div>" : "") + "</div>"
    + '<div class="op-r"><b class="op-d tnum" data-d>—</b><span class="op-z tnum" data-z></span></div></div>';
}
function drawLoot(s, ents, allLoot, shownCount) {
  const loot = PREF.loot ? allLoot.filter(lootGradeOk).sort(lootSort) : [];
  const boxes = PREF.box ? ents.filter(e => e.kind === "box" && visible(e) && e.world).sort(threatSort) : [];
  const conts = PREF.container ? ents.filter(e => e.kind === "container" && e.world).sort(threatSort) : [];
  const known = allLoot.filter(e => lootName(e) !== "未知物资").length;
  setText("loot-hint", "已识别 " + known + " · 待识别 " + (allLoot.length - known));
  const layout = [];
  if (loot.length) layout.push({ id: "loot", headHtml: '<div class="grp static"><i class="grp-bar" style="--c:#ffb547"></i><span class="grp-name">物资 · ' + lootFilterName() + '</span><span class="grp-cnt tnum">' + loot.length + "</span></div>", rows: loot.map(e => ({ key: e.key, html: lootRowHtml({ ...e }) })) });
  if (boxes.length) layout.push({ id: "box", headHtml: '<div class="grp static"><i class="grp-bar" style="--c:' + C_BOX + '"></i><span class="grp-name">死亡盒</span><span class="grp-cnt tnum">' + boxes.length + "</span></div>", rows: boxes.map(e => ({ key: e.key, html: boxRowHtml(e) })) });
  if (conts.length) layout.push({ id: "cont", headHtml: '<div class="grp static"><i class="grp-bar" style="--c:#38bdf8"></i><span class="grp-name">容器</span><span class="grp-cnt tnum">' + conts.length + "</span></div>", rows: conts.map(e => ({ key: e.key, html: boxRowHtml(e) })) });
  const empty = !PREF.loot && !PREF.box && !PREF.container ? emptyHtml("物资类型都已关闭", "在上方打开物资 / 死亡盒 / 容器")
    : allLoot.length && !shownCount ? emptyHtml("当前品质筛选无结果", "降低品质门槛或选择「全部」")
    : emptyHtml("当前快照没有可显示的物资", "已确认移除的物资会自动消失");
  renderKeyed($("loot-body"), lootRows, layout, empty);
  for (const e of [...loot, ...boxes, ...conts]) {
    const row = lootRows.get(e.key); if (!row) continue;
    const r = row.refs || (row.refs = { d: row.node.querySelector("[data-d]"), z: row.node.querySelector("[data-z]") });
    const d = dist2(e), z = dz(e);
    const dtxt = d != null ? d.toFixed(0) + "m" : "—", ztxt = z != null && Math.abs(z) >= 3 ? heightTxt(z) : "";
    if (r.d._v !== dtxt) { r.d.textContent = dtxt; r.d._v = dtxt; }
    if (r.z._v !== ztxt) { r.z.textContent = ztxt; r.z._v = ztxt; }
  }
}
function htmlToNode(html) { const box = document.createElement("div"); box.innerHTML = html; return box.firstElementChild; }
/* 列表增量渲染（keyed 复用）：内容或顺序变化时只动受影响的节点，不整块 innerHTML 重建，
   避免打断鼠标下的 hover 与过渡。layout = [{ id, headHtml, folded, rows:[{key, html}] }] */
function renderKeyed(body, pool, layout, emptyMarkup) {
  if (!layout.some(g => g.rows.length)) {
    if (body.dataset.kind !== emptyMarkup) { body.replaceChildren(); pool.clear(); body.innerHTML = emptyMarkup; body.dataset.kind = emptyMarkup; }
    return;
  }
  if (body.dataset.kind !== "list") { body.replaceChildren(); pool.clear(); body.dataset.kind = "list"; }
  const seen = new Set();
  let cursor = body.firstElementChild;
  const place = (key, html, isRow) => {
    seen.add(key);
    let r = pool.get(key);
    if (!r || r.html !== html) {
      const fresh = htmlToNode(html);
      if (!r) { r = { node: fresh }; pool.set(key, r); }
      else { r.node.className = fresh.className; r.node.replaceChildren(...fresh.childNodes); r.refs = null; }
      r.html = html;
    }
    if (r.node !== cursor) body.insertBefore(r.node, cursor);
    cursor = r.node.nextElementSibling;
  };
  for (const g of layout) {
    if (g.headHtml != null) place("h:" + g.id, g.headHtml, false);
    if (g.folded) continue;
    for (const it of g.rows) place(it.key, it.html, true);
  }
  for (const [k, r] of [...pool]) if (!seen.has(k)) { r.node.remove(); pool.delete(k); }
}
function emptyHtml(t, s) {
  return '<div class="empty"><svg class="ic"><use href="#i-clock"/></svg><b>' + esc(t) + '</b><span>' + esc(s) + "</span></div>";
}

/* -------------------------------------------------------------- 选中 / 定位 / 跟随 */
function clampToMap(ll) {
  const mb = MAP_INFO.bounds;
  const lat = Math.min(Math.max(ll.lat, Math.min(mb[0][0], mb[1][0])), Math.max(mb[0][0], mb[1][0]));
  const lng = Math.min(Math.max(ll.lng, Math.min(mb[0][1], mb[1][1])), Math.max(mb[0][1], mb[1][1]));
  return [lat, lng];
}
function focusEntity(key) {
  const s = lastSnap; if (!s) return;
  if (key === "__self") {
    followKey = "__self"; sel = null;
    if (R3 && R3.setFollowKey) R3.setFollowKey("__self");
    setFollow(true);
    if (is3d() && R3) {
      if (["orbit", "top"].includes(R3.camMode)) { R3.setCam("chase"); setPref("cam3d", "chase"); }
      r3CamSync();
    } else if (validWorld(s.self)) {
      map.setView(clampToMap(pointLatLng(s.self)), Math.min(Math.max(map.getZoom(), 5), map.getMaxZoom()), { animate: true });
    } else toast("本人位置未解析，无法定位自己");
    _rc.icon.clear(); forceLists(); if (lastSnap) draw(lastSnap);
    if (MOBILE()) setSheet("peek");
    return;
  }
  const e = prepareLootEntities(s.entities || []).find(x => x.key === key && visible(x));
  const toggleOff = sel === key;
  sel = toggleOff || !e ? null : key;
  _rc.icon.clear();
  if (!sel || !e || !e.world) {
    followKey = "__self"; if (R3) R3.setFollowKey("__self");
    forceLists(); if (lastSnap) draw(lastSnap); return;
  }
  const isChar = CHAR_KINDS.has(e.kind);
  // 只有人物能成为跟随目标；物资与盒子只定位
  if (isChar) {
    followKey = key;
    if (R3 && R3.setFollowKey) R3.setFollowKey(key);
    setFollow(true, false);
  } else setFollow(false, false);
  map.setView(clampToMap(pointLatLng(e.world)), Math.min(Math.max(map.getZoom(), 5), map.getMaxZoom()), { animate: true });
  forceLists(); draw(lastSnap);
  if (is3d() && R3) {
    if (isChar && ["fpv", "chase"].includes(R3.camMode)) { R3.setFollowKey(key); r3CamSync(); }
    else r3Focus(key);
  }
  if (MOBILE()) setSheet("peek");
}
function setFollow(v, syncCamera = true) {
  follow = !!v; setPref("follow", follow ? 1 : 0);
  $("s-follow").classList.toggle("on", follow && followKey === "__self");
  if (follow) smKick();
  if (syncCamera && is3d() && R3) {
    if (follow) { R3.setFollowKey(followKey); if (["orbit", "top"].includes(R3.camMode)) R3.setCam("chase"); }
    else R3.setCam("orbit");
    setPref("cam3d", R3.camMode); r3CamSync();
  }
}
function toggleSelfFollow() {
  const on = !follow || followKey !== "__self";
  resetFollowTarget(); setFollow(on);
  if (on && lastSnap && !validWorld(lastSnap.self)) toast("本人位置未解析，暂时无法跟随自己");
  else toast(on ? "镜头跟随自己" : "镜头跟随关闭");
}
function handleFollowKey(ev) {
  if (ev.defaultPrevented || ev.repeat || ev.isComposing || ev.ctrlKey || ev.altKey || ev.metaKey) return;
  if (ev.code !== "KeyG" && String(ev.key).toLowerCase() !== "g") return;
  if (ev.target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return;
  ev.preventDefault(); toggleSelfFollow();
}

/* ------------------------------------------------------------ 地图选择与会话推断 */
// 来源：self = 本人坐标确认；entities = 目标坐标推断；manual = 手动选择；pref = 未确认（沿用上次选择）
let mapSource = "pref", autoMapSession = "", manualMapSession = null;
const MAP_SRC_TXT = { self: "本人坐标确认", entities: "目标坐标推断", manual: "手动选择", pref: "未确认 · 沿用上次选择", default: "未确认 · 默认地图" };
function setMapSource(src) {
  mapSource = src;
  const el = $("map-src"); el.textContent = MAP_SRC_TXT[src] || src;
  el.dataset.src = src;
  updateMapNote();
}
function updateMapNote() {
  if (!MAP_INFO) return;
  const s = lastSnap;
  const sess = s && (s.flow || s.session != null) ? "（会话 " + esc(s.flow || s.session) + "）" : "";
  $("map-note").innerHTML = "当前：" + esc(MAP_INFO.name) + " · " + esc(MAP_SRC_TXT[mapSource] || mapSource) + sess
    + "<br><span>手动选择只覆盖本会话；新会话会重新按坐标判断。</span>";
}
async function syncSessionMap(snapshot) {
  if (!map) return;
  const identity = followSessionIdentity(snapshot);
  if (identity !== autoMapSession && manualMapSession !== null && manualMapSession !== identity) manualMapSession = null;
  if (manualMapSession === identity) return;
  if (identity === autoMapSession && mapSource === "self") return;
  const manifest = await r3Manifest();
  let key = inferSnapshotMap(snapshot, manifest.maps), src = "self";
  if (!key) { key = inferEntitiesMap(snapshot, manifest.maps); src = "entities"; }
  if (!key || !MAPS[key]) return;
  if (src === "self") autoMapSession = identity;
  if (MAP_INFO.key !== key) setMap(key, true);
  if (mapSource !== src) setMapSource(src);
}
function setMap(key, quiet) {
  const m = MAPS[key] || Object.values(MAPS)[0];
  if (!m) return;
  MAP_INFO = m;
  setPref("mapkey", m.key);
  const mb = L.latLngBounds(m.bounds[0], m.bounds[1]);
  if (tileLayer) { map.removeLayer(tileLayer); tileLayer = null; }
  tileLayer = L.tileLayer(m.tileUrl, { tileSize: m.tileSize || 256, maxNativeZoom: m.maxNativeZoom || 4, bounds: mb, keepBuffer: 3 }).addTo(map);
  map.setMaxBounds(mb.pad(0.25));
  map.fitBounds(mb);
  // 切图：平面区间变了，缓存全部清空强制重算
  purge(true);
  if (selfMarker) { selfMarker.remove(); selfMarker = null; }
  if (alertCircle) { alertCircle.remove(); alertCircle = null; }
  smPos.delete("__self"); smTgt.delete("__self"); _rc.pos.delete("__self");
  setText("map-name", m.name);
  document.querySelectorAll("#maps .mcard").forEach(c => c.classList.toggle("on", c.dataset.k === m.key));
  updateMapNote();
  if (!quiet) toast("已切换到 " + m.name);
  if (lastSnap) draw(lastSnap);
  if (typeof r3SwitchMap === "function") r3SwitchMap();
  if (typeof poiRebuild === "function") poiRebuild();
}
function mapThumb(m) { return String(m.tileUrl).replace("{z}", "1").replace("{x}", "1").replace("{y}", "1"); }

/* ------------------------------------------------------------ 状态胶囊 / 横幅 / 详情 */
let _statusAt = 0, _statusDetail = null, _statusKeyShown = "";
function renderStatus() {
  const now = performance.now();
  const st = liveState = monitor.state(now);
  const pill = $("status-pill");
  if (pill.dataset.state !== st.key) pill.dataset.state = st.key;
  pill.querySelector(".pill-label").textContent = MOBILE() && st.key === "live" ? "实时 " + (st.short || "") : MOBILE() && st.key === "stalled" ? "停滞 " + fmtAgo(st.lastChangeAgo).replace(" ", "") : st.label;
  const det = pill.querySelector(".pill-detail"); if (det.textContent !== st.detail) det.textContent = st.detail;
  pill.title = st.label + " · " + st.detail + "（客户端计时，不是游戏网络延迟）";
  document.body.classList.toggle("data-stale", st.key === "stalled" || st.key === "error");
  document.body.classList.toggle("data-nonlive", st.key === "nonlive");
  // 没有对局时不展示自己卡：那时缺本人数据是正常的，不能写成「位置未解析」
  document.body.classList.toggle("no-match", st.key === "waiting" || st.key === "connecting");
  // 状态切换不一定伴随新快照（等待态快照一直不变），自己卡与抽屉摘要在这里同步
  if (st.key !== _statusKeyShown) { _statusKeyShown = st.key; if (lastSnap) { updateSelfUI(lastSnap, lastEnts); forceLists(); } }
  const fixture = !!(st.snap && st.snap.dev_fixture);
  $("fixture-badge").hidden = !fixture;
  // 横幅：异常 > 停滞 > 非实时 > 测试数据
  let b = null;
  if (st.key === "error" && st.lastOkAgo != null) b = ["error", "#i-offline", "连接中断 · 重试中", "最近成功 " + fmtAgo(st.lastOkAgo) + " 前；画面不是当前位置"];
  else if (st.key === "stalled") b = ["stalled", "#i-clock", "数据已 " + fmtAgo(st.lastChangeAgo) + " 未更新", "画面为最后位置，不是当前位置"];
  else if (st.key === "nonlive") b = ["nonlive", "#i-clock", "非实时数据", "服务端状态 " + (st.snap && st.snap.status != null ? st.snap.status : "未提供") + " · 画面不是当前对局，本页不提供回放控制"];
  else if (fixture) b = ["fixture", "#i-warn", "测试数据", "开发样例，不能作为实时验收证据"];
  const banner = $("banner");
  if (b) {
    banner.hidden = false; banner.dataset.kind = b[0];
    const use = banner.querySelector("use"); if (use.getAttribute("href") !== b[1]) use.setAttribute("href", b[1]);
    setText("banner-title", b[2]); setText("banner-detail", b[3]);
  } else banner.hidden = true;
  if (lastSnap) {
    // 本人位置是否解析影响自己卡与第一视角
    document.body.classList.toggle("self-missing", !validWorld(lastSnap.self) && (st.key === "live" || st.key === "stalled"));
  }
  updateObserver();
  if (openedPop === "pop-status") renderStatusDetail();
}
function kvRow(k, v, src, cls) { return "<dt>" + esc(k) + "</dt><dd" + (cls ? ' class="' + cls + '"' : "") + ">" + esc(v) + (src ? "<small>" + esc(src) + "</small>" : "") + "</dd>"; }
function renderStatusDetail() {
  const st = liveState, s = lastSnap, raw = monitor.raw();
  const rows = [];
  rows.push(kvRow("服务连接", st.key === "error" ? "异常 · " + (st.error || "请求失败") : st.key === "connecting" ? "连接中" : "正常 · 最近响应 " + fmtAgo(st.lastOkAgo) + " 前", "客户端计时，不是游戏网络延迟", st.key === "error" ? "bad" : ""));
  rows.push(kvRow("对局数据", st.label, s ? "live_active=" + String(s.live_active) + " · status=" + (s.status != null ? s.status : "未提供") : "尚未收到快照", "st-" + st.key));
  rows.push(kvRow("快照变化", (st.rate >= 10 ? Math.round(st.rate) : st.rate.toFixed(1)) + " 次/秒 · 最近 " + fmtAgo(st.lastChangeAgo) + " 前", "客户端统计 /api/state 内容变化"));
  if (_statusDetail) {
    const r = _statusDetail.rates || {};
    rows.push(kvRow("服务端采样", Number.isFinite(r.characters) ? "人物 " + Number(r.characters).toFixed(1) + " 样本/秒 · 自身 " + Number(r.self || 0).toFixed(1) + " Hz" : "未提供", "/api/status rates"));
    if (_statusDetail.semanticComplete === false) rows.push(kvRow("解析完整度", "服务端标记为未完整", "semanticComplete=false", "warn"));
    if (_statusDetail.error) rows.push(kvRow("服务端错误", String(_statusDetail.error), "/api/status error", "bad"));
  } else rows.push(kvRow("服务端采样", "读取中…", "/api/status"));
  if (s) {
    const aim = aimState(s);
    rows.push(kvRow("本人位置", validWorld(s.self) ? "已解析 · 基准 " + (s.self_position_origin || "未提供") : "未解析", "self + self_position_origin", validWorld(s.self) ? "" : "warn"));
    rows.push(kvRow("本人朝向", aim.text, "self_aim_age_ms ≤ 250 才用作头部朝向", aim.kind === "fresh" ? "" : "warn"));
    const c = countsOf(lastEnts);
    rows.push(kvRow("已知目标", "敌方玩家 " + c.players + " · 队友 " + c.mates + " · 未知 " + c.unknown + " · AI " + c.ai + " · 物资 " + c.loot + " · 死亡盒 " + c.boxes, "当前快照计数，不是全场人数"));
  }
  if (R3 && is3d()) {
    const r = R3.stat();
    rows.push(kvRow("3D", (r.err ? "失败 · " + r.err : "地形 " + (Number(r.tris || 0) / 1e6).toFixed(2) + "M 面") + " · " + Number(r.fps || 0).toFixed(0) + " FPS · 绘制 " + (r.renderCalls || 0) + " 次", "几何 " + (r.resources?.geometries || 0) + " · 纹理 " + (r.resources?.textures || 0) + (r.resources?.heapMB != null ? " · JS 堆约 " + r.resources.heapMB + " MB" : "")));
  } else rows.push(kvRow("2D", "标记 " + markers.size + " · 信息堆 " + infos.size + " · 页面 " + (_pageFps > 0 ? Math.round(_pageFps) + " FPS" : "帧率统计中"), "仅在本面板打开时统计"));
  const html = rows.join("");
  const kv = $("status-kv"); if (kv._v !== html) { kv.innerHTML = html; kv._v = html; }
  if (_statusDetail) {
    const c = _statusDetail.counts || {}, t = _statusDetail.transport || {}, p = _statusDetail.stats || {}, b = t.broker || {};
    const txt = [
      "schema " + (_statusDetail.schema || "未提供") + " · 已索引状态 " + (_statusDetail.states ?? "—"),
      "人物 " + (c.characters ?? 0) + "（含自身 " + (c.charactersIncludingSelf ?? "—") + "） · 确认人机 " + (c.confirmedBots ?? c.suspectedBots ?? 0) + " · AI " + (c.ai ?? 0) + " · 物资 " + (c.loot ?? 0),
      "未识别移动槽 " + (c.unknownMovementSlots ?? 0) + " · 物资 ID 待识别 " + (_statusDetail.unknownLoot ?? 0),
      "UDP 上行 " + (t.udpUpPackets ?? b.UpPackets ?? p.upPackets ?? 0) + " / 下行 " + (t.udpDownPackets ?? b.DownPackets ?? p.downPackets ?? 0),
      "已验证连接 " + (t.udpBoundFlows ?? b.ValidatedFlows ?? 0) + " · 输入异常 " + (p.inputErrors || 0) + " · 序号缺口 " + (p.eventGaps || 0),
      _statusDetail.error || t.archiveError || t.parser?.error || "服务端未报告错误",
    ].join("\n");
    setText("diag-text", txt);
  }
}
let _statusPollTimer = 0, _pageFps = 0, _fpsRaf = 0;
async function pollStatusOnce() {
  try { _statusDetail = JSON.parse(await apiText("/api/status")); } catch (e) { _statusDetail = { error: "读取 /api/status 失败：" + (e.message || e) }; }
  if (openedPop === "pop-status") renderStatusDetail();
}
function startStatusPolling() {
  stopStatusPolling();
  pollStatusOnce();
  _statusPollTimer = setInterval(pollStatusOnce, 1000);
  // 页面帧率只在面板打开时统计，平时不常驻额外的 rAF 循环
  let frames = 0, at = performance.now();
  const tick = () => { frames++; const now = performance.now(); if (now - at >= 1000) { _pageFps = frames * 1000 / (now - at); frames = 0; at = now; } _fpsRaf = requestAnimationFrame(tick); };
  _fpsRaf = requestAnimationFrame(tick);
}
function stopStatusPolling() { if (_statusPollTimer) clearInterval(_statusPollTimer); _statusPollTimer = 0; if (_fpsRaf) cancelAnimationFrame(_fpsRaf); _fpsRaf = 0; }

/* ------------------------------------------------------------ 弹层 / 抽屉 */
let openedPop = null;
const POP_BTN = { "pop-status": "status-pill", "pop-map": "map-chip", "pop-layers": "btn-layers", "settings": "btn-settings" };
function openPop(id) {
  if (openedPop === id) return closePop();
  closePop();
  openedPop = id;
  const el = $(id); el.hidden = false;
  const btn = $(POP_BTN[id]); if (btn) { btn.setAttribute("aria-expanded", "true"); btn.classList.add("on"); }
  if (id === "pop-layers") $("fab-layers").classList.add("on");
  if (!MOBILE() && btn && id !== "settings") {
    const r = btn.getBoundingClientRect();
    if (id === "pop-layers") { el.style.left = "auto"; el.style.right = Math.max(8, window.innerWidth - r.right) + "px"; }
    else { el.style.right = "auto"; el.style.left = Math.round(r.left) + "px"; }
  } else { el.style.left = ""; el.style.right = ""; }
  if (MOBILE() || id === "settings") $("veil").classList.add("on");
  if (id === "pop-status") { startStatusPolling(); renderStatusDetail(); }
  if (id === "settings") selectSetPage(PREF.settab);
  document.body.classList.add("popping");
}
function closePop() {
  if (!openedPop) return;
  const el = $(openedPop); el.hidden = true;
  const btn = $(POP_BTN[openedPop]); if (btn) { btn.setAttribute("aria-expanded", "false"); btn.classList.remove("on"); }
  $("fab-layers").classList.remove("on");
  if (openedPop === "pop-status") stopStatusPolling();
  openedPop = null;
  $("veil").classList.remove("on");
  document.body.classList.remove("popping");
}
function selectSetPage(page) {
  if (!document.querySelector('#settings section[data-page="' + page + '"]')) page = "alert";
  setPref("settab", page);
  document.querySelectorAll("#set-tabs button").forEach(b => { const on = b.dataset.page === page; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); });
  document.querySelectorAll("#settings section[data-page]").forEach(s => { s.hidden = s.dataset.page !== page; });
}

/* ------------------------------------------------------------ 面板（桌面）/ 抽屉（手机） */
let sheetState = "peek";
function selectTab(tab) {
  if (tab === "layers") { openPop("pop-layers"); return; }
  if (tab !== "loot") tab = "targets";
  setPref("ptab", tab);
  document.querySelectorAll("#panel-tabs button[data-tab]").forEach(b => { const on = b.dataset.tab === tab; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); });
  $("tab-targets").hidden = tab !== "targets";
  $("tab-loot").hidden = tab !== "loot";
  opRows.clear(); lootRows.clear(); $("ops-body").dataset.kind = ""; $("loot-body").dataset.kind = "";
  if (MOBILE() && sheetState === "peek") setSheet("half");
  forceLists();
}
function setPanelOpen(open) {
  setPref("panel", open ? 1 : 0);
  document.body.classList.toggle("panel-closed", !open);
  $("rail").hidden = open;
  if (open) forceLists();
  if (map) setTimeout(() => map.invalidateSize(), 60);
}
function sheetHeights() {
  const vh = window.innerHeight;
  return { peek: 112, half: Math.round(vh * 0.48), full: vh - 52 };
}
function setSheet(state, px) {
  sheetState = state;
  const h = px != null ? px : sheetHeights()[state];
  document.documentElement.style.setProperty("--sheet-h", h + "px");
  document.body.dataset.sheet = state;
  if (state !== "peek") forceLists();
}
(function bindSheetDrag() {
  let drag = null;
  const start = ev => {
    if (!MOBILE()) return;
    drag = { y: ev.clientY, h: sheetHeights()[sheetState], moved: false, id: ev.pointerId };
    try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (e) {}
    document.body.classList.add("sheet-dragging");
  };
  const move = ev => {
    if (!drag || ev.pointerId !== drag.id) return;
    const dy = drag.y - ev.clientY;
    if (Math.abs(dy) > 4) drag.moved = true;
    const H = sheetHeights();
    const h = Math.max(H.peek, Math.min(H.full, drag.h + dy));
    document.documentElement.style.setProperty("--sheet-h", h + "px");
    drag.last = h;
  };
  const end = ev => {
    if (!drag) return;
    document.body.classList.remove("sheet-dragging");
    const H = sheetHeights();
    if (!drag.moved) setSheet(sheetState === "peek" ? "half" : sheetState === "half" ? "full" : "peek");
    else {
      const h = drag.last ?? drag.h;
      const order = ["peek", "half", "full"];
      let best = order[0];
      for (const k of order) if (Math.abs(H[k] - h) < Math.abs(H[best] - h)) best = k;
      setSheet(best);
    }
    drag = null;
  };
  for (const id of ["sheet-grip", "sheet-peek"]) {
    const el = $(id);
    el.addEventListener("pointerdown", start);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }
})();

/* ------------------------------------------------------------ 地图初始化 */
/* Leaflet 默认把屏幕 y 加进 z-index，平滑移动时每个点每帧都要改一次样式并重排层叠顺序。
   雷达按类别分层（zIndexOffset：警戒圈 < 物资 < 队友 < 敌人 < 信息堆 < 本人 < 选中）已经够用，固定后移动只改 transform。 */
L.Marker.include({
  _setPos(pos) {
    // flat：物资、箱子、POI 这类几乎不动的点用 2D 平移，画进所在面板的图层，不再各占一个合成层
    if (this._icon && this.options.flat) { this._icon._leaflet_pos = pos; this._icon.style.transform = "translate(" + pos.x + "px," + pos.y + "px)"; }
    else if (this._icon) L.DomUtil.setPosition(this._icon, pos);
    if (this._shadow) L.DomUtil.setPosition(this._shadow, pos);
    this._zIndex = this.options.zIndexOffset;
    this._resetZIndex();
  },
  _updateZIndex(offset) {
    if (!this._icon) return;
    const z = this._zIndex + offset;
    if (this._icon._msZ !== z) { this._icon._msZ = z; this._icon.style.zIndex = z; }
  },
});
fetch("/api/map").then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }).then(info => {
  const list = (info && info.maps) || [];
  DEF_MAP = (info && info.default) || "daba";
  for (const m of list) MAPS[m.key] = m;
  map = L.map("map", { crs: L.CRS.Simple, minZoom: 2, maxZoom: 7, preferCanvas: true, attributionControl: false, zoomControl: false, zoomSnap: .25, wheelPxPerZoomLevel: 90 });
  $("maps").innerHTML = list.map(m =>
    '<button class="mcard" type="button" data-k="' + esc(m.key) + '"><img loading="lazy" alt="" src="' + esc(mapThumb(m)) + '" onerror="this.style.display=\'none\'">'
    + '<span class="now">当前</span><b>' + esc(m.name) + "</b></button>").join("");
  $("maps").addEventListener("click", ev => {
    const c = ev.target.closest(".mcard");
    if (!c) return;
    // 手动选择只覆盖当前会话
    manualMapSession = lastSnap ? followSessionIdentity(lastSnap) : "";
    setMap(c.dataset.k); setMapSource("manual"); closePop();
  });
  const want = (PREF.mapkey && MAPS[PREF.mapkey]) ? PREF.mapkey : DEF_MAP;
  setMap(want, true);
  setMapSource(PREF.mapkey && MAPS[PREF.mapkey] ? "pref" : "default");
  map.on("dragstart", () => { if (follow) setFollow(false); });
  map.on("zoomend", poiApplyZoom);
  map.on("zoomanim", e => sizeAlertRing(e.zoom));
  map.on("zoomend", () => sizeAlertRing(map.getZoom()));
  poll();
}).catch(e => {
  console.error("地图目录读取失败", e);
  toast("地图目录读取失败：" + (e.message || e));
  monitor.fail(e, performance.now());
});

/* ---------------------------------------------------------------- 轮询 */
// 请求串行，避免慢网络堆积。数据在变时 20 ms 再取；静止指数回退；后台标签页 1 s。
let lastUiErrorAt=0;
async function apiText(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('请求超时，正在重新连接', 'TimeoutError')), 5000);
  try {
    const response = await fetch(path, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}
/* 接收节奏：
   · 内容签名去掉只随墙钟增长的字段（位置年龄、出生点年龄、瞄准年龄、解码计数），冻结的数据不会被当成新数据——
     否则既判断不出停滞，也会一直以最高频率重复拉取同一份快照。
   · 估计服务端快照间隔（内容变化间隔的 EMA）：新数据到达后约 0.85 个间隔再取，预计快到时 15 ms 紧拉一次。
   · 长时间无变化指数退避：实时流上限 100 ms，等待 / 非实时上限 400 ms；后台标签页 1 s。 */
const POLL_FAST = 20, POLL_MAX = 100, POLL_IDLE_MAX = 400, POLL_TIGHT = 15;
/* 内容签名：真实后端冻结时正文仍随墙钟变化（pose_age_ms / age_sec / self_aim_age_ms 与 meta 计数），
   直接在正文字符串上剥掉这些字段再比较；只有签名变了才 JSON.parse。meta 含嵌套对象，按括号配对截掉。 */
const VOLATILE_RE = /"(?:pose_age_ms|age_sec|self_aim_age_ms)":\s*(?:-?[0-9.eE+-]+|null)/g;
const META_RE = /"meta":\s*\{/g;
function bodySignature(body) {
  let out = "", from = 0, m;
  META_RE.lastIndex = 0;
  while ((m = META_RE.exec(body))) {
    let j = m.index + m[0].length, depth = 1, str = false;
    for (; j < body.length && depth; j++) {
      const c = body.charCodeAt(j);
      if (str) { if (c === 92) j++; else if (c === 34) str = false; }
      else if (c === 34) str = true;
      else if (c === 123) depth++;
      else if (c === 125) depth--;
    }
    out += body.slice(from, m.index); from = j; META_RE.lastIndex = j;
  }
  return (from ? out + body.slice(from) : body).replace(VOLATILE_RE, "");
}
let pollIv = POLL_FAST, pollBusy = false, _lastBody = "", _lastSig = "", _chgEma = 0, _chgAt = 0;
function nextPollDelay(changed, now) {
  if (document.hidden) return 1000;
  if (changed) return _chgEma > 0 ? Math.min(150, Math.max(POLL_FAST, _chgEma * 0.85)) : POLL_FAST;
  if (_chgEma > 0 && now - _chgAt < _chgEma * 2) return POLL_TIGHT;
  const cap = liveState && (liveState.key === "live" || liveState.key === "stalled") ? POLL_MAX : POLL_IDLE_MAX;
  return Math.min(pollIv * 1.7 + 1, cap);
}
async function poll() {
  let changed = false;
  if (!pollBusy) {
    pollBusy = true;
    let body = null;
    try {
      body = await apiText('/api/state');
    } catch (e) {
      // 请求失败（超时、HTTP 非 2xx、断网）记为连接异常；画面保留最后一帧
      monitor.fail(e, performance.now());
      if (performance.now()-lastUiErrorAt>3000) {
        if (e.name === 'TimeoutError' || e.name === 'AbortError') console.warn('状态请求超时，将自动重试', e);
        else console.warn('状态请求失败，将自动重试', e);
        lastUiErrorAt=performance.now();
      }
    }
    if (body !== null) {
      try {
        if (body !== _lastBody) {
          const sig = bodySignature(body);
          if (sig !== _lastSig) {
            const s = JSON.parse(body);
            const identities = Array.isArray(s.identityRecords) ? s.identityRecords : [];
            const identityText = identities.map(x => (x.name || '身份待解析') + ' · 队伍 ' + (x.team ?? '未知')).join('\n');
            if ($('nova-identities').textContent !== identityText) $('nova-identities').textContent = identityText;
            normalizeNames(s);
            if (Number.isFinite(s.self_aim_yaw) && s.self_aim_age_ms <= 250) s.self_yaw = s.self_aim_yaw;
            if (lastSnap && followSessionIdentity(lastSnap) !== followSessionIdentity(s)) selfHold = null;
            s.self = normalizeSelf(s.self);
            await syncSessionMap(s);
            draw(s);
            if (R3 && is3d()) R3.update(loot3dSnapshot(s));
            // 渲染失败时不记录签名，下一轮重试同一帧；渲染成功才算一次新数据
            _lastSig = sig; changed = true;
            const now = performance.now();
            if (_chgAt && now - _chgAt < 1000) _chgEma = _chgEma ? _chgEma * 0.8 + (now - _chgAt) * 0.2 : now - _chgAt;
            _chgAt = now;
            monitor.ok(s, true, now);
          } else monitor.ok(null, false, performance.now());
          _lastBody = body;
        } else monitor.ok(null, false, performance.now());
      } catch (e) {
        monitor.ok(null, false, performance.now());
        changed = false;
        if (performance.now()-lastUiErrorAt>3000) {
          console.error('页面更新失败', e);
          toast('页面更新失败：'+e.message); lastUiErrorAt=performance.now();
        }
      }
    }
    pollBusy = false;
  }
  pollIv = nextPollDelay(changed, performance.now());
  setTimeout(poll, pollIv);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) pollIv = POLL_FAST; });
setInterval(renderStatus, 250);

/* ------------------------------------------------------------ 交互装配 */
// 开关统一注册：一个偏好键可以对应多个按钮（如物资页类型筛选与图层弹层）
function bindToggle(ids, key, after) {
  const els = ids.map($).filter(Boolean);
  const sync = () => els.forEach(el => { el.classList.toggle("on", !!PREF[key]); el.setAttribute("aria-pressed", String(!!PREF[key])); });
  els.forEach(el => el.addEventListener("click", (ev) => {
    ev.preventDefault();
    setPref(key, PREF[key] ? 0 : 1);
    sync();
    if (after) after();
    forceLists();
    if (lastSnap) draw(lastSnap);
    if (R3) { R3.setPrefs(PREF); if (lastSnap && is3d()) R3.update(loot3dSnapshot(lastSnap)); }
  }));
  sync();
}
// 过滤类开关：先把标记全部撤下，下一次 draw 自然重建
function purge(all) {
  for (const k in _rc) if (_rc[k] instanceof Map) _rc[k].clear();
  for (const m of markers.values()) m.remove(); markers.clear();
  for (const t of trails.values()) t.remove(); trails.clear();
  for (const [k, it] of infos) if (all || k !== "__self") { it.m.remove(); infos.delete(k); }
  for (const k of [...smPos.keys()]) if (all || k !== "__self") smPos.delete(k);
  for (const k of [...smTgt.keys()]) if (all || k !== "__self") smTgt.delete(k);
  if (all && selfMarker) { selfMarker.remove(); selfMarker = null; }
  if (all && alertCircle) { alertCircle.remove(); alertCircle = null; }
}
bindToggle(["s-trail"], "trail", () => { if (!PREF.trail) { for (const t of trails.values()) t.remove(); trails.clear(); _rc.trail.clear(); } });
bindToggle(["s-hp"], "hp");
bindToggle(["s-loot", "s-loot-map"], "loot", () => purge());
bindToggle(["s-box", "s-box-map"], "box", () => purge());
bindToggle(["s-container", "s-container-map"], "container", () => purge());
bindToggle(["s-aibox"], "aibox", () => purge());
bindToggle(["s-ai"], "ai", () => purge());
bindToggle(["s-mate"], "mate", () => purge());
bindToggle(["s-foe"], "foe", () => purge());
bindToggle(["s-ray"], "ray");
bindToggle(["s-box3d"], "box3d");
bindToggle(["s-warn3d"], "warn3d", () => { if (PREF.warn3d && !(Number(PREF.warnd) > 0)) toast("屏外预警已开，但「预警距离」是 0"); });
bindToggle(["s-name"], "name");
bindToggle(["s-wpn"], "wpn");
bindToggle(["s-gear"], "gear");
bindToggle(["s-dist"], "dist");
bindToggle(["s-alerttoast"], "alerttoast");
bindToggle(["s-cone"], "cone", () => _rc.icon.clear());
bindToggle(["s-maptex3d"], "maptex3d");
bindToggle(["s-radar3d"], "radar3d");
bindToggle(["s-pip"], "pip", () => { $("map").classList.toggle("mini", is3d() && PREF.pip !== 0 && !MOBILE()); setTimeout(() => map && map.invalidateSize(), 120); });
function bindSlider(id, key, fmt, after) {
  const el = $(id), out = $("v-" + id.replace("s-", ""));
  el.value = PREF[key];
  const apply = () => { setPref(key, Number(el.value)); if (out) out.textContent = fmt(el.value); if (after) after(); };
  el.addEventListener("input", () => { apply(); if (R3) R3.setPrefs(PREF); });
  apply();
}
bindSlider("s-tagop", "tagop", v => v + "%", () => document.documentElement.style.setProperty("--tagop", (Number(PREF.tagop) / 100).toFixed(2)));
bindSlider("s-gunlen", "gunlen", v => v + "px", () => document.documentElement.style.setProperty("--gunlen", Number(PREF.gunlen) + "px"));
bindSlider("s-fpvtau", "fpvtau", v => Number(v) === 0 ? "最跟手" : v + "ms");
bindSlider("s-fpvheight", "fpvheight", v => Number(v).toFixed(1) + "m");
bindSlider("s-fov", "fov", v => v + "°");
bindSlider("s-walltrans", "walltrans", v => v + "%");
bindSlider("s-floortrans", "floortrans", v => v + "%");
bindSlider("s-followwalltrans", "followwalltrans", v => v + "%");
bindSlider("s-charsize", "charsize", v => v + "%");
bindSlider("s-warnd", "warnd", v => Number(v) === 0 ? "关" : v + "m");
bindSlider("s-warnr", "warnr", v => v + "px");
bindSlider("s-warnsz", "warnsz", v => v + "%");
bindSlider("s-dotsize", "dotsize", v => v + "%", () => document.documentElement.style.setProperty("--mks", (Number(PREF.dotsize) || 100) / 100));
bindSlider("s-fontsize", "fontsize", v => v + "%", () => document.documentElement.style.setProperty("--fs", (Number(PREF.fontsize) || 100) / 100));
bindSlider("s-tagw", "tagweight", v => String(v), () => document.documentElement.style.setProperty("--tagw", Number(PREF.tagweight) || 600));
bindSlider("s-alert", "alert", v => Number(v) === 0 ? "关" : v + "m", () => { _rc.icon.clear(); forceLists(); if (lastSnap) draw(lastSnap); });
bindSlider("s-radarr", "radarr", v => v + "m");
bindSlider("s-poiboxd", "poiboxd", v => Number(v) === 0 ? "关" : v + "m");
// 分段控件：data 属性值写入偏好
function bindSeg(id, key, attr, after) {
  const seg = $(id); if (!seg) return;
  const sync = () => seg.querySelectorAll("button").forEach(b => b.classList.toggle("on", String(b.dataset[attr]) === String(PREF[key])));
  seg.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
    const v = b.dataset[attr]; setPref(key, isNaN(v) || v === "" ? v : Number(v)); sync();
    if (after) after(); if (R3) R3.setPrefs(PREF);
  }));
  sync();
  return sync;
}
bindSeg("model3dseg", "model3d", "model", () => toast("3D 人物模型已切换"));
bindSeg("direction3dseg", "directionstyle3d", "direction");
bindSeg("directionanchor3dseg", "directionanchor3d", "anchor");
bindSeg("mapstyle3dseg", "mapstyle3d", "style");
const syncShadow = bindSeg("shadow3dseg", "shadow3d", "shadow");
const syncFps = bindSeg("fpscapseg", "fpscap", "f");
bindSeg("q3dseg", "q3d", "q", () => {
  // 手机 / 电脑预设同时给出帧率与阴影；均衡与自动保留现有设置
  if (PREF.q3d === "perf" || PREF.q3d === "high") { setPref("fpscap", PREF.q3d === "perf" ? 30 : 60); setPref("shadow3d", PREF.q3d === "perf" ? "off" : "auto"); syncFps(); syncShadow(); }
  if (R3) { R3.setPrefs(PREF); R3.setQuality(PREF.q3d); r3SwitchMap(); }
});
bindSeg("pick-loot", "lootmin", "g", () => { purge(); forceLists(); if (lastSnap) draw(lastSnap); if (R3 && lastSnap && is3d()) R3.update(loot3dSnapshot(lastSnap)); });
// 列表排序
$("sortbar").addEventListener("click", ev => {
  const b = ev.target.closest("button[data-sort]"); if (!b) return;
  setPref("sort", b.dataset.sort); syncSortbars(); opRows.clear(); $("ops-body").dataset.kind = ""; forceLists();
});
$("loot-sortbar").addEventListener("click", ev => {
  const b = ev.target.closest("button[data-loot-sort]"); if (!b) return;
  setPref("lootsort", b.dataset.lootSort); syncSortbars(); forceLists();
});
function syncSortbars() {
  document.querySelectorAll("#sortbar button").forEach(x => x.classList.toggle("on", x.dataset.sort === PREF.sort));
  document.querySelectorAll("#loot-sortbar button").forEach(x => x.classList.toggle("on", x.dataset.lootSort === PREF.lootsort));
}
syncSortbars();
// 列表点击：分组折叠 / 选中定位
for (const id of ["ops-body", "loot-body"]) $(id).addEventListener("click", ev => {
  const g = ev.target.closest(".grp[data-g]");
  if (g) { const k = g.dataset.g; foldGrp.has(k) ? foldGrp.delete(k) : foldGrp.add(k); forceLists(); return; }
  const row = ev.target.closest("[data-k]");
  if (row) focusEntity(row.dataset.k);
});
$("panel-tabs").addEventListener("click", ev => { const b = ev.target.closest("button[data-tab]"); if (b) selectTab(b.dataset.tab); });
$("btn-panel-close").addEventListener("click", () => setPanelOpen(false));
$("rail").addEventListener("click", ev => { const b = ev.target.closest("button"); if (!b) return; if (b.dataset.rail) selectTab(b.dataset.rail); setPanelOpen(true); });
$("set-tabs").addEventListener("click", ev => { const b = ev.target.closest("button[data-page]"); if (b) selectSetPage(b.dataset.page); });
$("status-pill").addEventListener("click", () => openPop("pop-status"));
$("map-chip").addEventListener("click", () => openPop("pop-map"));
$("btn-layers").addEventListener("click", () => openPop("pop-layers"));
$("fab-layers").addEventListener("click", () => openPop("pop-layers"));
$("btn-settings").addEventListener("click", () => openPop("settings"));
document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => closePop()));
$("veil").addEventListener("click", () => closePop());
$("s-follow").addEventListener("click", toggleSelfFollow);
$("zoom-in").addEventListener("click", () => map && map.zoomIn());
$("zoom-out").addEventListener("click", () => map && map.zoomOut());
document.addEventListener("keydown", handleFollowKey);
document.addEventListener("keydown", ev => { if (ev.key === "Escape") closePop(); });
// 桌面：点击弹层以外的地方收起（设置抽屉有遮罩，单独处理）
document.addEventListener("pointerdown", ev => {
  if (!openedPop || MOBILE() || openedPop === "settings") return;
  if (ev.target.closest("#" + openedPop) || ev.target.closest("#" + POP_BTN[openedPop])) return;
  closePop();
}, true);
setFollow(follow, false);

/* ------------------------------------------------------------ 点位图层
   撤离点 / 出生点 / 高价值容器。归类与配色来自 m3d/poi-data.js（3D 光柱、HUD、雷达同一份）。
   按缩放分级：撤离点常显、区域名 zoom≥3；出生点 zoom≥3；容器 zoom≥4。3D 小地图里只留撤离点。 */
const POI_MOD_URL = "/m3d/poi-data.js?v=1.4.0";
let poiModP = null, poiGen = 0;
const poiGroups = { exit: null, spawn: null, box: null };
function poiModule() {
  if (!poiModP) poiModP = import(POI_MOD_URL).catch(e => { poiModP = null; throw e; });
  return poiModP;
}
function poiClear() { for (const k in poiGroups) if (poiGroups[k]) { poiGroups[k].remove(); poiGroups[k] = null; } }
function poiTip(p) {
  const head = p.kind === "exit" ? (p.region || p.short) : p.name;
  const sub = p.kind === "exit" ? p.name : p.kind === "box" ? (p.region ? "区域 · " + p.region : "高价值容器") : "出生点";
  return '<div class="tip-h"><span class="poi-dot" style="--c:' + p.color + '"></span>' + esc(head) + '</div><div class="tip-r">' + esc(sub) + "</div>";
}
function poiMarker(p) {
  let html = "", cls = "poi poi-spawn", size = 10;
  if (p.kind === "exit") { html = '<span class="poi-ic" style="--c:' + p.color + '">' + esc(p.glyph) + '</span><span class="poi-lbl">' + esc(p.region || p.short) + "</span>"; cls = "poi poi-exit"; size = 20; }
  else if (p.kind === "box") { html = '<span class="poi-ic">' + esc(p.glyph) + "</span>"; cls = "poi poi-box"; size = 14; }
  const mk = L.marker([p.lat, p.lng], { pane: "poiPane", keyboard: false, flat: true, icon: L.divIcon({ className: cls, html: html, iconSize: [size, size] }) });
  mk.bindTooltip(poiTip(p), { direction: "top", offset: [0, -size / 2 - 2], opacity: 1 });
  return mk;
}
function poiApplyZoom() {
  if (!map) return;
  const z = map.getZoom(), el = $("map");
  const mini = el.classList.contains("mini") && is3d();
  const want = { exit: !!PREF.poiexit, spawn: !!PREF.poispawn && z >= 3 && !mini, box: !!PREF.poibox && z >= 4 && !mini };
  for (const k in poiGroups) {
    const g = poiGroups[k]; if (!g) continue;
    const has = map.hasLayer(g);
    if (want[k] && !has) g.addTo(map); else if (!want[k] && has) g.remove();
  }
  el.classList.toggle("poi-nolbl", z < 3 || mini);
}
async function poiRebuild() {
  const gen = ++poiGen;
  poiClear();
  if (!map || !MAP_INFO) return;
  if (!map.getPane("poiPane")) map.createPane("poiPane").style.zIndex = 450;
  let mod, data;
  try {
    mod = await poiModule();
    mod.setCatalog(Object.values(MAPS));
    data = await mod.loadMapPois(MAP_INFO.key, Number(PREF.poilevel) || 0);
  } catch (e) { if (gen === poiGen) console.warn("[点位] 2D 点位载入失败", e); return; }
  if (gen !== poiGen || !map) return;
  const off = mod.parseBoxOff(PREF.poiboxoff);
  poiGroups.exit = L.layerGroup(data.exits.map(poiMarker));
  poiGroups.spawn = L.layerGroup(data.spawns.map(poiMarker));
  poiGroups.box = L.layerGroup(data.boxes.filter(p => !off.has(p.name)).map(poiMarker));
  poiApplyZoom();
  const lvRow = $("poilevel-row");
  if (lvRow) { lvRow.classList.toggle("inactive", !data.levels); lvRow.title = data.levels ? "" : "当前地图没有分难度点位"; }
}
function poiPrefsChanged(rebuild) { if (rebuild) poiRebuild(); else poiApplyZoom(); if (R3) R3.setPrefs(PREF); }
bindToggle(["s-poiexit"], "poiexit", poiApplyZoom);
bindToggle(["s-poispawn"], "poispawn", poiApplyZoom);
bindToggle(["s-poibox"], "poibox", poiApplyZoom);
bindSeg("poilevelseg", "poilevel", "lv", () => poiPrefsChanged(true));
poiModule().then(mod => {
  const box = $("pick-poibox"); if (!box) return;
  const off = mod.parseBoxOff(PREF.poiboxoff);
  box.innerHTML = mod.BOX_TYPES.map(t => '<button type="button" data-t="' + esc(t.name) + '" class="' + (off.has(t.name) ? "" : "on") + '" title="' + esc(t.name) + '"><i>' + esc(t.glyph) + "</i>" + esc(t.name) + "</button>").join("");
  box.addEventListener("click", ev => {
    const b = ev.target.closest("button[data-t]"); if (!b) return;
    const cur = mod.parseBoxOff(PREF.poiboxoff);
    if (cur.has(b.dataset.t)) cur.delete(b.dataset.t); else cur.add(b.dataset.t);
    setPref("poiboxoff", [...cur].join(","));
    b.classList.toggle("on", !cur.has(b.dataset.t));
    poiPrefsChanged(true);
  });
}).catch(e => console.warn("[点位] 数据模块载入失败，点位图层不可用", e));
new MutationObserver(poiApplyZoom).observe($("map"), { attributes: true, attributeFilter: ["class"] });

/* ------------------------------------------------------------ 3D 白模视图
   与 2D 共用同一份快照；地形首次进图下载后走长缓存。失败不自动重载，由用户重试或回到 2D。 */
let R3 = null, r3busy = false, r3man = null, r3SwitchVersion = 0;
const M3D = "/m3d/";
const is3d = () => !!R3 && document.body.classList.contains("mode3d");
const CAM_NAME = { orbit: "自由", top: "俯视", fpv: "第一跟随", chase: "第三跟随" };
function r3CamSync() {
  const c = R3 ? R3.camMode : (PREF.cam3d || "chase");
  document.querySelectorAll("#camseg button[data-cam]").forEach(b => b.classList.toggle("on", b.dataset.cam === c));
  updateFollowChip();
  // 相机或跟随对象变化不一定伴随新快照（服务端暂停时），摘要与自己卡在这里同步
  if (lastSnap) updateSelfUI(lastSnap, lastEnts);
}
function updateFollowChip() {
  let name = "自己";
  if (followKey !== "__self" && lastSnap) { const e = (lastSnap.entities || []).find(x => x.key === followKey); name = e ? (e.name || KIND_NM[e.kind] || "目标") : "目标已离开"; }
  setText("follow-name", name);
  $("follow-self").hidden = followKey === "__self";
}
async function r3Manifest() {
  if (r3man) return r3man;
  try {
    const response = await fetch(M3D + 'manifest.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    r3man = await response.json();
  } catch (e) { return { maps: {} }; }
  return r3man;
}
function r3Loading(on, pct, txt) {
  const card = $("r3-card");
  if (!on) { if (card.dataset.state === "loading") card.hidden = true; return; }
  card.hidden = false; card.dataset.state = "loading";
  $("r3-card-btns").hidden = true;
  $("r3-bar").hidden = false;
  if (txt) setText("r3-card-title", txt);
  setText("r3-card-detail", "2D 地图仍可使用");
  $("r3-bar").firstElementChild.style.width = Math.max(0, Math.min(100, pct || 0)) + "%";
}
function r3Fail(msg) {
  const card = $("r3-card");
  card.hidden = false; card.dataset.state = "fail";
  setText("r3-card-title", "3D 地形加载失败");
  setText("r3-card-detail", String(msg || "未知原因"));
  $("r3-bar").hidden = true;
  $("r3-card-btns").hidden = false;
  setPref("v3d", 0);
}
function r3TerrainRecord(rec, quality) {
  const light = rec?.packed_light;
  if (quality !== 'high' && light?.file && light.src_rev === rec.rev) return { ...rec, packed: light, packed_fallback: rec.packed };
  return rec;
}
async function r3Model(k = (MAP_INFO && MAP_INFO.key) || DEF_MAP) {
  const mf = await r3Manifest();
  const rec = r3TerrainRecord(mf.maps && mf.maps[k], PREF.q3d);
  if (!rec) return null;
  const rev = rec.rev || rec.bytes || 1;
  return { url: M3D + rec.file + "?v=" + encodeURIComponent(rev), rec: rec, key: k };
}
function r3Focus(key) {
  if (!is3d() || !R3) return;
  R3.focus(key, lastSnap);
  setPref("cam3d", R3.camMode);
  r3CamSync();
}
async function r3SwitchMap() {
  if (!R3 || !is3d()) return;
  const version = ++r3SwitchVersion, info = MAP_INFO;
  const m = await r3Model(info.key);
  if (version !== r3SwitchVersion || !is3d()) return;
  if (!m) { toast("该地图暂无 3D 白模，已切回 2D"); set3d(false, true); return; }
  const mb = (((m.rec.packed && m.rec.packed.bytes) || m.rec.bytes) / 1048576).toFixed(0);
  r3Loading(true, 0, "载入 " + (m.rec.name || m.key) + " 地形 " + mb + "MB");
  await R3.setMap(info, m.url, (got, tot) => {
    if (version === r3SwitchVersion) r3Loading(true, tot ? got / tot * 100 : 0, "载入 " + (m.rec.name || m.key) + " " + (got / 1048576).toFixed(1) + " / " + mb + " MB");
  }, m.rec);
  if (version !== r3SwitchVersion) return;
  r3Loading(false);
  const st = R3.stat ? R3.stat() : null;
  if (st && st.err) r3Fail(st.err);
  if (lastSnap) R3.update(loot3dSnapshot(lastSnap));
}

// 2D / 3D 切换
function sync3dUI(on) {
  $("s-3d").classList.toggle("on", on);
  $("s-2d").classList.toggle("on", !on);
  document.body.classList.toggle("mode2d", !on);
}
async function set3d(on, quiet) {
  if (NO3D) return;
  if (r3busy) return;
  if (on === is3d()) return;
  if (!on) {
    document.body.classList.remove("mode3d");
    if (R3 && R3.setActive) R3.setActive(false);
    $("r3").classList.remove("on");
    $("map").classList.remove("mini");
    ["left", "top", "right", "bottom", "width", "height"].forEach(k2 => { $("map").style[k2] = ""; });
    syncMiniHint();
    $("r3-card").hidden = true;
    sync3dUI(false);
    setPref("v3d", 0);
    purge(true); _r2dPrev = true;
    if (lastSnap) draw(lastSnap);
    setTimeout(() => map.invalidateSize(), 60);
    return;
  }
  r3busy = true;
  try {
    let m = await r3Model();
    if (!m) { toast("该地图暂无 3D 白模"); return; }
    if (!R3) {
      r3Loading(true, 2, "载入 3D 引擎…");
      const mod = await import(M3D + "korr-adapter.js?v=2.1.0");
      R3 = mod.create({
        canvas: $("r3-cv"), labels: $("r3-lbl"), hud: $("r3-hud"),
        mapInfo: MAP_INFO, model: m.rec, pref: PREF,
        palette: { teams: TEAM_COLORS, self: C_SELF, mate: C_MATE, ai: C_AI, unknown: C_UNK, alert: C_ALERT, down: STATE_COL.down },
        onPick: (e) => { if (e && e.key && e.key !== "__self") focusEntity(e.key); },
        // 地形失败由 3D 状态卡展示（含重试），不再重复弹提示
        onToast: (msg) => { if (!/地图加载失败/.test(String(msg))) toast(msg); },
        bagLv: BAG_LV, bagCap: BAG_CAP,
      });
      // 3D 内部因拖动平移而脱离跟随时，同步相机条高亮
      R3.onCam = (mode, key) => {
        if (!is3d()) return;
        if (key) followKey = key;
        setFollow(mode !== "orbit", false); r3CamSync();
      };
    }
    const info = MAP_INFO;
    if (m.key !== info.key) m = await r3Model(info.key);
    if (!m) { toast('该地图暂无 3D 白模'); return; }
    document.body.classList.add("mode3d");
    if (R3 && R3.setActive) R3.setActive(true);
    $("r3").classList.add("on");
    if (PREF.pip !== 0 && !MOBILE()) $("map").classList.add("mini");
    setTimeout(() => { miniRestore(); syncMiniHint(); }, 80);
    sync3dUI(true);
    setPref("v3d", 1);
    clearInfos();
    if (!render2d()) { purge(true); _r2dPrev = false; }
    R3.resize();
    const mb = (((m.rec.packed && m.rec.packed.bytes) || m.rec.bytes) / 1048576).toFixed(0);
    r3Loading(true, 3, "载入 " + (m.rec.name || m.key) + " 地形 " + mb + "MB");
    await R3.setMap(info, m.url, (got, tot) => {
      r3Loading(true, tot ? got / tot * 100 : 0, "载入 " + (m.rec.name || m.key) + " " + (got / 1048576).toFixed(1) + " / " + mb + " MB");
    }, m.rec);
    r3Loading(false);
    const st = R3.stat();
    if (st.err) r3Fail(st.err);
    else if (!quiet) toast("3D 视图 · " + (st.tris / 1e6).toFixed(1) + "M 面");
    R3.setPrefs(PREF);
    R3.setQuality(PREF.q3d || "auto");
    R3.setCam(PREF.cam3d || "chase");
    if (["chase", "fpv"].includes(PREF.cam3d || "chase")) {
      setFollow(true, false);
      if (lastSnap && validWorld(lastSnap.self)) setTimeout(() => map.panTo(pointLatLng(lastSnap.self), { animate: false }), 360);
    }
    r3CamSync();
    if (lastSnap) R3.update(loot3dSnapshot(lastSnap));
    setTimeout(() => map.invalidateSize(), 340);
  } catch (e) {
    // 载入失败：清 v3d，下次启动不再自动拉地形（防手机重载死循环），给出重试与回到 2D
    r3Fail("3D 初始化失败：" + (e && e.message || e));
  } finally { r3busy = false; }
}
async function r3Retry() {
  $("r3-card").hidden = true;
  if (!is3d()) { await set3d(true); return; }
  setPref("v3d", 1);
  await r3SwitchMap();
}
if (NO3D) { $("viewseg").hidden = true; }
$("s-2d").addEventListener("click", () => set3d(false));
$("s-3d").addEventListener("click", () => set3d(true));
$("r3-retry").addEventListener("click", r3Retry);
$("r3-back").addEventListener("click", () => { $("r3-card").hidden = true; set3d(false); });
$("camseg").addEventListener("click", ev => {
  const b = ev.target.closest("button[data-cam]"); if (!b || !R3) return;
  setPref("cam3d", b.dataset.cam);
  R3.setCam(b.dataset.cam);
  if (["fpv", "chase"].includes(b.dataset.cam)) R3.setFollowKey(followKey);
  r3CamSync(); updateObserver();
});
$("follow-chip").addEventListener("click", () => {
  if (MOBILE()) setSheet("half"); else setPanelOpen(true);
  selectTab("targets");
  toast("点选列表中的人物即可改为跟随对方");
});
$("follow-self").addEventListener("click", () => focusEntity("__self"));
$("cam-reset").addEventListener("click", () => { if (window.radar3dResetView) window.radar3dResetView(); });
window.addEventListener("resize", () => { if (R3) R3.resize(); });
// 上次停在 3D 就恢复（地形走浏览器缓存）
if (Number(PREF.v3d) === 1) setTimeout(() => set3d(true, true), 600);

/* 第一跟随观察条：跟随对象的血量、当前装备、姿态与朝向时效；本人坐标缺失时说明不可用 */
function updateObserver() {
  const ob = $("observer");
  const fpv = is3d() && R3 && R3.camMode === "fpv";
  if (!fpv || !lastSnap) { if (!ob.hidden) ob.hidden = true; return; }
  const s = lastSnap;
  let html;
  if (followKey === "__self") {
    if (!validWorld(s.self)) html = '<span class="ob-warn"><svg class="ic xs"><use href="#i-warn"/></svg>第一跟随（自己）不可用</span><span class="sub">本人位置未解析 · 可改为跟随列表中的目标</span>';
    else {
      const hi = hpInfo(s.self_hp), w = selfWeaponInfo(s), aim = aimState(s), pose = selfPoseLabel(s);
      html = '<span class="sub">第一跟随</span><b>' + esc(displaySelfName(s)) + "</b>" + hpBarHtml(s.self_hp, "hpbar")
        + '<span class="hpv tnum" style="color:' + HP_COL[hpColorKey(hi)] + '">' + esc(hi.state === "nomax" ? hi.short : hi.text) + "</span>"
        + '<span class="sub">' + esc(w.kind === "unlisted" ? "武器名称未收录" : w.text) + "</span>" + (pose ? '<span class="badge ghost">' + esc(pose) + "</span>" : "")
        + '<span class="tnum ' + (aim.kind === "fresh" ? "ok" : "warn") + '">' + esc(aim.text) + '</span><span class="sub dim">眼高为估算</span>';
    }
  } else {
    const e = (s.entities || []).find(x => x.key === followKey);
    if (!e) html = '<span class="ob-warn">跟随目标已离开当前快照</span><span class="sub">将回到自己</span>';
    else {
      const hi = hpInfo(e.hp), w = weaponInfo(e), pose = poseLabel(e), fr = freshnessOf(e);
      html = '<span class="sub">第一跟随</span><b>' + esc(e.name || KIND_NM[e.kind]) + "</b>" + (e.hero ? '<span class="sub">' + esc(e.hero) + "</span>" : "") + hpBarHtml(e.hp, "hpbar")
        + '<span class="hpv tnum" style="color:' + HP_COL[hpColorKey(hi)] + '">' + esc(hi.state === "nomax" ? hi.short : hi.text) + "</span>"
        + '<span class="sub">' + esc(w.kind === "unlisted" ? "武器名称未收录" : w.text) + "</span>" + (pose ? '<span class="badge ghost">' + esc(pose) + "</span>" : "")
        + (fr.kind === "spawn" || fr.kind === "far" ? '<span class="warn">' + esc(fr.label) + "</span>" : "")
        + '<span class="sub">仅水平朝向 · 眼高为估算</span>';
    }
  }
  if (ob._v !== html) { ob.innerHTML = html; ob._v = html; }
  if (ob.hidden) ob.hidden = false;
}

/* --- 3D 小地图：Shift+拖动移动 / Shift+滚轮缩放（仅桌面） --- */
{
  const el = $("map");
  let drag = null;
  const isMini = () => is3d() && el.classList.contains("mini");
  el.addEventListener("pointerdown", e => {
    if (!isMini() || !e.shiftKey || e.button !== 0) return;
    const r = el.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault(); e.stopPropagation();
  }, true);
  el.addEventListener("pointermove", e => {
    if (!drag) return;
    const x = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - drag.dx));
    const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.dy));
    el.style.left = x + "px"; el.style.top = y + "px"; el.style.right = "auto"; el.style.bottom = "auto";
    map.invalidateSize(); syncMiniHint();
    e.preventDefault(); e.stopPropagation();
  }, true);
  const endDrag = () => { drag = null; syncMiniHint(); miniSave(); };
  window.syncMiniHint = () => {
    const hint = $("mini-hint");
    const show = is3d() && el.classList.contains("mini") && !MOBILE();
    hint.classList.toggle("on", show);
    if (!show) return;
    const r2 = el.getBoundingClientRect();
    hint.style.left = Math.round(r2.left) + "px";
    hint.style.top = Math.max(4, Math.round(r2.top - 22)) + "px";
    hint.style.maxWidth = Math.round(r2.width) + "px";
  };
  const MINI_KEY = "nr2_mini";
  window.miniSave = () => {
    if (!el.classList.contains("mini")) return;
    const r2 = el.getBoundingClientRect();
    try { localStorage.setItem(MINI_KEY, JSON.stringify({ l: Math.round(r2.left), t: Math.round(r2.top), w: Math.round(r2.width), h: Math.round(r2.height) })); } catch (e) {}
  };
  window.miniRestore = () => {
    if (MOBILE()) return;
    let v = null;
    try { v = JSON.parse(localStorage.getItem(MINI_KEY) || "null"); } catch (e) {}
    if (!v || !v.w) return;
    const w = Math.max(150, Math.min(window.innerWidth * 0.8, v.w));
    const h = Math.max(110, Math.min(window.innerHeight * 0.8, v.h || w * 0.74));
    const l = Math.max(0, Math.min(window.innerWidth - 60, v.l || 0));
    const t = Math.max(0, Math.min(window.innerHeight - 40, v.t || 0));
    el.style.left = l + "px"; el.style.top = t + "px"; el.style.right = "auto"; el.style.bottom = "auto";
    el.style.width = Math.round(w) + "px"; el.style.height = Math.round(h) + "px";
    map.invalidateSize(); syncMiniHint();
  };
  el.addEventListener("pointerup", endDrag, true);
  el.addEventListener("pointercancel", endDrag, true);
  el.addEventListener("wheel", e => {
    if (!isMini() || !e.shiftKey) return;
    e.preventDefault(); e.stopPropagation();
    const r = el.getBoundingClientRect();
    const w = Math.max(150, Math.min(window.innerWidth * 0.7, r.width * (e.deltaY < 0 ? 1.12 : 0.89)));
    el.style.width = Math.round(w) + "px"; el.style.height = Math.round(w * 0.74) + "px";
    map.invalidateSize(); syncMiniHint(); miniSave();
  }, { passive: false, capture: true });
}

/* --- 布局：桌面 / 手机切换时重置面板与抽屉 --- */
function applyLayout() {
  const m = MOBILE();
  document.body.classList.toggle("mobile", m);
  closePop();
  if (m) { document.body.classList.remove("panel-closed"); $("rail").hidden = true; setSheet("peek"); $("map").classList.remove("mini"); }
  else { setPanelOpen(!!PREF.panel); document.documentElement.style.removeProperty("--sheet-h"); delete document.body.dataset.sheet; if (is3d() && PREF.pip !== 0) $("map").classList.add("mini"); }
  if (lastSnap) { purge(true); _r2dPrev = render2d(); draw(lastSnap); }
  if (map) setTimeout(() => map.invalidateSize(), 80);
}
MQ_MOBILE.addEventListener("change", applyLayout);
selectTab(PREF.ptab);
applyLayout();
renderStatus();
