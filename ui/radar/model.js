/* ============================================================================
   Nova 实时雷达 · 数据表达模型（纯函数，无 DOM）
   ----------------------------------------------------------------------------
   这里集中规定「界面上每个数字从哪个字段来、缺失时怎么说」。规则：
     · 未知血量 ≠ 0 血；上限未知时只显示数值，不补 100、不画比例。
     · 当前持有武器只认 curr_weapon 的解析结果；weapon 是出生携带，只能作为「初始」出现在详情里。
     · 已知目标数只代表当前快照里收到的目标，不是全场人数。
     · 实时 / 停滞 / 异常 / 等待 / 非实时由请求结果、live_active、status 原值与内容变化共同判定，
       不发明后端枚举；所有时间都是客户端计时，不是游戏网络延迟。
   以普通脚本加载（全局函数），node:test 通过 vm 直接执行本文件。
   ========================================================================== */
"use strict";

const DMAX_M = 5000;            // 超过任何地图尺度的距离视为无效（本人坐标未解出时的护栏）
const LIVE_STALL_MS = 3000;     // 实时流超过该时长没有内容变化即判为停滞
const RATE_WINDOW_MS = 2000;    // 快照变化频率的统计窗口
const AIM_FRESH_MS = 250;       // 与 gateway-pose.js 的 aimOf 一致

function validWorld(w) {
  return Array.isArray(w) && w.length >= 3 && Number.isFinite(w[0]) && Number.isFinite(w[1]) && Number.isFinite(w[2]);
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 头像缩写：优先汉字，其次前两个字符
function initials(s) {
  s = String(s || "").trim();
  if (!s) return "?";
  const cn = s.match(/[一-龥]/g);
  if (cn && cn.length) return cn[0];
  return s.slice(0, 2).toUpperCase();
}

// 客户端计时的「多久之前」，用于状态与时效标签
function fmtAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 10000) return (ms / 1000).toFixed(1) + " s";
  if (ms < 120000) return Math.round(ms / 1000) + " s";
  return Math.round(ms / 60000) + " min";
}
function agoTxt(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  return sec < 60 ? sec + "s前" : Math.floor(sec / 60) + "m前";
}

/* ---------------------------------------------------------------- UE 文本清洗 */
// FText 偶尔原样序列化成 INVTEXT("文本","上下文")，入口处只保留文本本身
const FTEXT_RE = /^\s*(?:NS)?INVTEXT\(\s*"((?:[^"\\]|\\.)*)"/;
function uiText(v) {
  if (typeof v !== "string" || v.indexOf("INVTEXT(") < 0) return v;
  const m = FTEXT_RE.exec(v);
  return m ? m[1] : v;
}
function normalizeNames(s) {
  s.self_name = uiText(s.self_name);
  // Verified against the game's FishingRodAttribute data table; possession does
  // not identify casting, waiting for a bite, or reeling.
  const rods = { '18300000001':'路亚钓竿', '18300000002':'路亚钓竿', '18300000003':'路亚钓竿', '18300000004':'台钓竿', '18300000005':'台钓竿' };
  if (s.self_weapon_status === 'resolved' && rods[s.self_weapon_id]) s.self_weapon = rods[s.self_weapon_id];
  for (const e of s.entities || []) {
    if (typeof e.name === "string") e.name = uiText(e.name);
    if (e.curr_weapon_status === 'resolved' && rods[e.curr_weapon_id]) e.curr_weapon = rods[e.curr_weapon_id];
  }
}

/* ---------------------------------------------------------------- 距离与方位 */
function dist2(e) {
  if (!e || !e.rel) return null;
  const x = e.rel[0], y = e.rel[1];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const d = Math.hypot(x, y) / 100;
  return d <= DMAX_M ? d : null;
}
function dz(e) {
  if (!e || !e.rel) return null;
  const z = e.rel[2];
  if (!Number.isFinite(z)) return null;
  const v = z / 100;
  return Math.abs(v) <= DMAX_M ? v : null;
}
// 相对观察者朝向的角度（度，-180..180，正值为右）。UE 左手系：yaw 从 +X 向 +Y 增大。
function relAngle(e, yaw) {
  if (!e || !e.rel || !Number.isFinite(yaw)) return null;
  const x = e.rel[0], y = e.rel[1];
  if (!Number.isFinite(x) || !Number.isFinite(y) || (!x && !y)) return null;
  return ((Math.atan2(y, x) * 180 / Math.PI - yaw) % 360 + 540) % 360 - 180;
}
const BEARING_TXT = ["前", "右前", "右", "右后", "后", "左后", "左", "左前"];
function bearingOf(e, yaw) {
  const rel = relAngle(e, yaw);
  return rel == null ? "" : BEARING_TXT[((Math.round(rel / 45) % 8) + 8) % 8];
}
function heightTxt(z) {
  if (z == null) return "";
  if (Math.abs(z) < 1) return "同层";
  return (z > 0 ? "↑" : "↓") + Math.abs(z).toFixed(0) + "m";
}

/* ---------------------------------------------------------------- 血量 */
// hp.total = [当前, 已知上限或 null]。部位数值独立保留，不能相加充当总血量。
function fmtHp(x) { return String(Number(x.toFixed(1))); }
function hpInfo(hp) {
  const t = hp && Array.isArray(hp.total) ? hp.total : null;
  const cur = t && Number.isFinite(t[0]) && t[0] >= 0 ? t[0] : null;
  const max = t && Number.isFinite(t[1]) && t[1] > 0 && (cur == null || t[1] >= cur) ? t[1] : null;
  const maxSource = hp && typeof hp.max_source === "string" ? hp.max_source : null;
  if (cur == null) return { state: "unknown", cur: null, max: null, frac: null, text: "血量未知", short: "未知", maxSource };
  if (cur === 0) return { state: "zero", cur: 0, max, frac: 0, text: max != null ? "0/" + fmtHp(max) : "0", short: "0", maxSource };
  if (max == null) return { state: "nomax", cur, max: null, frac: null, text: fmtHp(cur) + " · 上限未知", short: fmtHp(cur) + "/?", maxSource };
  return { state: "known", cur, max, frac: Math.max(0, Math.min(1, cur / max)), text: fmtHp(cur) + "/" + fmtHp(max), short: fmtHp(cur) + "/" + fmtHp(max), maxSource };
}
// 只报告数据里同时给了当前值和上限的部位，不用默认上限补齐
const HP_PARTS = { head: "头", thorax: "胸", abdomen: "腹", larm: "左臂", rarm: "右臂", lleg: "左腿", rleg: "右腿" };
function hpWorstPart(hp) {
  let worst = null;
  if (!hp) return null;
  for (const k in HP_PARTS) {
    const rec = hp[k];
    if (!Array.isArray(rec) || !Number.isFinite(rec[0]) || !Number.isFinite(rec[1]) || rec[1] <= 0 || rec[0] < 0 || rec[0] > rec[1]) continue;
    const f = rec[0] / rec[1];
    if (f < 1 && (!worst || f < worst.f)) worst = { k, name: HP_PARTS[k], cur: rec[0], max: rec[1], f };
  }
  return worst;
}
function hpColorKey(info) {
  if (!info || info.frac == null) return info && info.state === "zero" ? "zero" : "unknown";
  if (info.frac <= 0) return "zero";
  return info.frac > 0.66 ? "high" : info.frac > 0.33 ? "mid" : "low";
}

/* ---------------------------------------------------------------- 当前装备 */
function heldKind(name) {
  if (/钓竿|鱼竿/.test(name)) return "rod";
  if (/匕首|刀|斧|镐/.test(name)) return "melee";
  if (/手雷|烟雾|闪光|燃烧|C4|炸弹|雷$/.test(name)) return "throwable";
  if (/医疗|药|针|注射|绷带|止痛|止血/.test(name)) return "item";
  return "gun";
}
function weaponFrom(name, status, known, id, initial) {
  name = typeof name === "string" ? name.trim() : "";
  const resolved = status != null ? status === "resolved" : (known !== false && !!name);
  const init = typeof initial === "string" && initial.trim() ? initial.trim() : null;
  if (!resolved || !name) return { kind: "unresolved", text: "武器未解析", raw: status == null ? null : String(status), initial: init, model: null };
  if (/^武器\s*\d+$/.test(name)) return { kind: "unlisted", text: "武器名称未收录", id: id != null ? String(id) : name.replace(/\D+/g, ""), initial: init, model: name };
  if (name === "空手") return { kind: "empty", text: "空手", initial: init, model: name };
  return { kind: heldKind(name), text: name, initial: init, model: name };
}
// model 字段交给 3D：只有当前持有的解析结果；没有证据时为 null，3D 不会强行放枪
function weaponInfo(e) {
  return weaponFrom(e && e.curr_weapon, e && e.curr_weapon_status, e && e.curr_weapon_known, e && e.curr_weapon_id, e && e.weapon);
}
function selfWeaponInfo(s) {
  return weaponFrom(s && s.self_weapon, s && s.self_weapon_status, undefined, s && s.self_weapon_id, null);
}

/* ---------------------------------------------------------------- 身份、时效与姿态 */
function identityOf(e) {
  if (!e) return { kind: "unknown", label: "身份未解析" };
  if (e.kind === "ai") return { kind: "ai", label: e.name || "AI" };
  if (e.kind === "unknown") return { kind: "unknown", label: "身份未解析" };
  if (e.hero) return { kind: "known", label: e.hero, bot: e.is_bot === true };
  return { kind: "unresolved", label: "干员未解析", bot: e.is_bot === true };
}
// 位置时效：实时 / 出生点 / 超距最后位置 / 阵亡
function freshnessOf(e) {
  if (!e) return { kind: "live" };
  if (e.dead) return { kind: "dead", label: "阵亡" };
  if (e.spawn_mark) return { kind: "spawn", label: "出生点" + (Number.isFinite(e.age_sec) ? " " + agoTxt(e.age_sec) : ""), age: e.age_sec };
  if (e.out_of_range === true) return { kind: "far", label: "超距·最后位置" };
  return { kind: "live", label: "" };
}
// 只认解析出的姿态与生命状态；速度不能单独判定游泳，持竿不等于抛竿
function poseLabel(src) {
  if (!src) return null;
  if (src.dead || src.alive === false) return "阵亡";
  if (src.status_key === "down" || src.status_key === "dying" || src.life_state === "downed") return "倒地";
  const p = src.pose;
  if (!p || typeof p !== "object") return null;
  if (p.movement === "swim") return "游泳";
  if (p.prone === true) return "趴下";
  if (p.crouched === true) return "蹲伏";
  if (p.movement === "fall") return "下落";
  return null;
}
function selfPoseLabel(s) {
  if (!s) return null;
  const life = s.self_life || {};
  return poseLabel({ dead: !!life.dead, status_key: life.downed ? "down" : null, pose: s.self_pose });
}
// 本人朝向：只有新鲜的瞄准数据才能当作头部朝向
function aimState(s) {
  if (!s) return { kind: "none", text: "无朝向数据" };
  const age = s.self_aim_age_ms;
  if (Number.isFinite(s.self_aim_yaw) && Number.isFinite(age) && age >= 0 && age <= AIM_FRESH_MS) return { kind: "fresh", text: "朝向 实时 · " + Math.round(age) + " ms", age };
  if (Number.isFinite(s.self_aim_yaw)) return { kind: "stale", text: "瞄准过期 · 仅水平朝向", age };
  if (Number.isFinite(s.self_yaw)) return { kind: "body", text: "无瞄准数据 · 仅水平朝向" };
  return { kind: "none", text: "无朝向数据" };
}

/* ---------------------------------------------------------------- 计数与威胁 */
// 只统计当前快照里收到的目标，界面上必须写成「已知」
function countsOf(ents) {
  const c = { players: 0, alive: 0, down: 0, dead: 0, mates: 0, ai: 0, unknown: 0, boxes: 0, loot: 0, containers: 0 };
  for (const e of ents || []) {
    if (e.kind === "player") {
      c.players++;
      if (e.dead) c.dead++;
      else if (e.status_key === "down" || e.status_key === "dying") c.down++;
      else c.alive++;
    } else if (e.kind === "mate") c.mates++;
    else if (e.kind === "ai") c.ai++;
    else if (e.kind === "unknown") c.unknown++;
    else if (e.kind === "box") c.boxes++;
    else if (e.kind === "loot") c.loot++;
    else if (e.kind === "container") c.containers++;
  }
  return c;
}
// 最近的「实时」敌方玩家：出生点、超距、阵亡都不算
function nearestFoe(ents, yaw) {
  let best = null;
  for (const e of ents || []) {
    if (e.kind !== "player" || e.dead || e.spawn_mark || e.out_of_range === true) continue;
    const d = dist2(e);
    if (d == null) continue;
    if (!best || d < best.d) best = { e, d };
  }
  if (!best) return null;
  return { e: best.e, d: best.d, dz: dz(best.e), dir: bearingOf(best.e, yaw), angle: relAngle(best.e, yaw) };
}

/* ---------------------------------------------------------------- 地图推断 */
// 本人坐标落在唯一一张地图的 3D 包围盒内时确认地图
function inferSnapshotMap(snapshot, models) {
  const world = snapshot?.self;
  if (!Array.isArray(world) || world.length < 3 || !world.every(Number.isFinite)) return null;
  const matches = Object.entries(models || {}).filter(([, rec]) => {
    const box = rec.bbox;
    return box && world[0] / 100 >= box[0][0] && world[0] / 100 <= box[1][0]
      && world[1] / 100 >= box[0][2] && world[1] / 100 <= box[1][2];
  });
  return matches.length === 1 ? matches[0][0] : null;
}
// 本人坐标缺失时的后备：至少 3 个人物坐标，且 80% 以上落在同一张图内，才作为「推断」
function inferEntitiesMap(snapshot, models) {
  const pts = [];
  for (const e of snapshot?.entities || []) {
    if (!["player", "mate", "ai", "unknown"].includes(e.kind) || !validWorld(e.world)) continue;
    if (e.world[0] === 0 && e.world[1] === 0) continue;
    pts.push(e.world);
  }
  if (pts.length < 3) return null;
  let best = null, second = 0;
  for (const [key, rec] of Object.entries(models || {})) {
    const box = rec.bbox; if (!box) continue;
    let n = 0;
    for (const w of pts) if (w[0] / 100 >= box[0][0] && w[0] / 100 <= box[1][0] && w[1] / 100 >= box[0][2] && w[1] / 100 <= box[1][2]) n++;
    if (!best || n > best.n) { second = best ? best.n : 0; best = { key, n }; }
    else if (n > second) second = n;
  }
  return best && best.n >= Math.ceil(pts.length * 0.8) && second < best.n ? best.key : null;
}

/* ---------------------------------------------------------------- 实时状态 */
/* 状态只来自客户端可证实的证据：
     connecting —— 还没有任何成功响应；
     error      —— 最近一次请求失败（超时、HTTP 非 2xx、解析失败）；
     live       —— live_active=true 且 LIVE_STALL_MS 内内容有变化；
     stalled    —— live_active=true 但超过 LIVE_STALL_MS 没有内容变化；
     waiting    —— 响应成功但没有本人坐标、也没有任何实体（如 status=waiting）；
     nonlive    —— 响应成功、有数据，但 live_active 不为 true（如服务端在回放）。 */
function createLiveMonitor(opts) {
  const stallMs = (opts && opts.stallMs) || LIVE_STALL_MS;
  const m = { firstOkAt: 0, lastOkAt: 0, lastChangeAt: 0, lastFailAt: 0, failCount: 0, lastError: "", snap: null, changes: [] };
  function rate(now) {
    while (m.changes.length && now - m.changes[0] > RATE_WINDOW_MS) m.changes.shift();
    return m.changes.length / (RATE_WINDOW_MS / 1000);
  }
  return {
    ok(snap, changed, now) {
      if (!m.firstOkAt) m.firstOkAt = now;
      m.lastOkAt = now; m.failCount = 0; m.lastError = "";
      if (changed || !m.snap) {
        m.lastChangeAt = now; m.snap = snap || m.snap;
        m.changes.push(now); if (m.changes.length > 400) m.changes.shift();
      }
    },
    fail(err, now) {
      m.lastFailAt = now; m.failCount++;
      m.lastError = String((err && (err.message || err.name)) || err || "未知错误");
    },
    raw() { return m; },
    state(now) {
      const r = rate(now);
      const base = { rate: r, lastOkAgo: m.lastOkAt ? now - m.lastOkAt : null, lastChangeAgo: m.lastChangeAt ? now - m.lastChangeAt : null, error: m.lastError, snap: m.snap };
      if (!m.lastOkAt) {
        return m.failCount
          ? { ...base, key: "error", label: "连接异常", detail: "无法连接服务 · 重试中", current: false }
          : { ...base, key: "connecting", label: "连接中", detail: "正在连接服务…", current: false };
      }
      if (m.failCount && m.lastFailAt >= m.lastOkAt) {
        return { ...base, key: "error", label: "连接异常", detail: "最近成功 " + fmtAgo(now - m.lastOkAt) + " 前 · 重试中", current: false };
      }
      const s = m.snap || {};
      const hasData = validWorld(s.self) || (Array.isArray(s.entities) && s.entities.length > 0);
      const selfOk = validWorld(s.self);
      if (s.live_active === true) {
        const ago = now - m.lastChangeAt;
        if (ago >= stallMs) return { ...base, key: "stalled", label: "数据停滞", detail: fmtAgo(ago) + " 无新快照 · 显示最后位置", current: false, selfOk };
        const rt = r >= 10 ? Math.round(r) : r.toFixed(1);
        return { ...base, key: "live", label: "实时", detail: fmtAgo(ago) + " 前 · " + rt + " 次/秒", short: fmtAgo(ago).replace(" ", ""), current: true, selfOk };
      }
      if (!hasData) return { ...base, key: "waiting", label: "等待对局", detail: "服务在线 · 尚无对局数据", current: false, selfOk };
      return { ...base, key: "nonlive", label: "非实时数据", detail: "服务端状态 " + (s.status != null ? String(s.status) : "未提供") + " · 不是当前对局", current: false, selfOk };
    },
  };
}

if (typeof globalThis !== "undefined") {
  globalThis.RadarModel = {
    validWorld, esc, initials, fmtAgo, agoTxt, uiText, normalizeNames, dist2, dz, relAngle, bearingOf, heightTxt,
    hpInfo, hpWorstPart, hpColorKey, weaponInfo, selfWeaponInfo, identityOf, freshnessOf, poseLabel, selfPoseLabel,
    aimState, countsOf, nearestFoe, inferSnapshotMap, inferEntitiesMap, createLiveMonitor, LIVE_STALL_MS,
  };
}
