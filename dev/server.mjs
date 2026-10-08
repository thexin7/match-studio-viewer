#!/usr/bin/env node
/**
 * Nova 实时雷达 · 本地开发服务器（测试数据）。
 * 提供静态资源与样例版 /api/state、/api/status、/api/map。所有样例响应带 dev_fixture:true，
 * 页面会显示「测试数据」横幅：这些画面只能验证界面表达，不能当作实时对局验收证据。
 *
 * 情景（--scenario 或 GET /__dev/scenario?set=<名称>）：
 *   live     实时：live_active=true，人物按确定性轨迹移动（默认）
 *   waiting  服务在线但没有对局（与真实后端空闲态同形：status=waiting、self=null、entities=[]）
 *   stalled  实时数据冻结在切换那一刻，之后内容不再变化
 *   error    /api/state 与 /api/status 返回 503
 *   noself   实时，但本人坐标缺失
 *   nonlive  服务端处于回放：live_active=false、status=replay
 * 另可加 terrain=0（或 --no-terrain）让 /m3d 下的地形文件返回 404，用于验证 3D 失败与重试；
 * session=N 模拟新会话（session/flow 改变）；map=<key> 把样例整体平移到该地图包围盒中心，用于验证新会话自动切图。
 *
 * --upstream <地址>：不使用样例，把 /api/state、/api/status、/api/map 与 /resources/ 原样转发到真实后端（只读 GET，不加测试标记），
 * 用于以本仓库的新界面查看真实数据。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCENARIOS = ['live', 'waiting', 'stalled', 'error', 'noself', 'nonlive'];
const HELP = `用法: node dev/server.mjs [--scenario ${SCENARIOS.join('|')}] [--no-terrain] [--upstream http://127.0.0.1:17912] [--port 5173] [--host 127.0.0.1]
运行中切换: GET /__dev/scenario?set=<情景>&terrain=0|1（返回当前情景 JSON）`;

function parseArgs(argv) {
  const o = { scenario: 'live', terrain: true, upstream: '', port: Number(process.env.PORT || 5173), host: process.env.HOST || '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (i + 1 >= argv.length) throw new Error(a + ' 缺少参数值'); return argv[++i]; };
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a === '--scenario') o.scenario = next();
    else if (a === '--no-terrain') o.terrain = false;
    else if (a === '--upstream') o.upstream = next().replace(/\/+$/, '');
    else if (a === '--port') o.port = Number(next());
    else if (a === '--host') o.host = next();
    else throw new Error('未知参数: ' + a);
  }
  if (!SCENARIOS.includes(o.scenario)) throw new Error('未知情景: ' + o.scenario);
  return o;
}
let opt;
try { opt = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); console.error(HELP); process.exit(2); }

const stateFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/state.json'), 'utf8'));
const mapCatalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'map_catalog.json'), 'utf8'));
const manifestMaps = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'm3d/manifest.json'), 'utf8')).maps || {}; } catch { return {}; } })();
const startedAt = Date.now();
let frozen = null, session = 1, mapShift = null;
// 把样例平移到指定地图的 3D 包围盒中心（bbox 单位为米，顺序 [x, 高度, y]）
function shiftFor(key) {
  const box = manifestMaps[key]?.bbox;
  if (!box) return null;
  const cx = (box[0][0] + box[1][0]) / 2 * 100, cy = (box[0][2] + box[1][2]) / 2 * 100;
  return [cx - stateFixture.self[0], cy - stateFixture.self[1]];
}
function applyShift(s) {
  if (!mapShift) return s;
  const [dx, dy] = mapShift, mv = w => Array.isArray(w) && w.length >= 2 ? [w[0] + dx, w[1] + dy, ...w.slice(2)] : w;
  if (s.self) s.self = mv(s.self);
  for (const e of s.entities || []) { e.world = mv(e.world); if (e.xyz) e.xyz = e.world; if (Array.isArray(e.trail)) e.trail = e.trail.map(mv); }
  return s;
}

/* 样例运动：fixture 只有一帧静态坐标。每个人物绕自己的 fixture 坐标做确定性的圆周运动，
   一部分会周期性进出 80m 贴脸范围。只影响开发服务器，不改变 API 字段形状。 */
const SIM_TRAIL_N = 16, SIM_TRAIL_STEP_S = 0.6;
function orbit(base, i, tSec) {
  const radius = 1500 + (i % 4) * 900;
  const omega = (0.12 + (i % 3) * 0.05) * (i % 2 ? -1 : 1);
  const phase = i * 1.37, a = omega * tSec + phase;
  const x = base[0] + radius * (Math.cos(a) - Math.cos(phase));
  const y = base[1] + radius * (Math.sin(a) - Math.sin(phase));
  const yaw = (Math.atan2(omega * Math.cos(a), -omega * Math.sin(a)) * 180 / Math.PI + 360) % 360;
  return { world: [x, y, base[2]], yaw };
}

// 在 fixture 上补齐真实后端出现过的字段组合（测试数据），覆盖各种表达分支
function enrich(s) {
  const own = s.self;
  const players = s.entities.filter(e => e.kind === 'player');
  const at = (dx, dy, dz = 0) => [own[0] + dx, own[1] + dy, own[2] + dz];
  const set = (e, patch) => Object.assign(e, patch);
  if (players[0]) set(players[0], { kind: 'mate', team: 4, curr_weapon: '怜悯', curr_weapon_status: 'resolved', weapon: '磁吸炸弹', hp: { total: [47.37, 100], max_source: 'operator_default' } });
  if (players[1]) set(players[1], { kind: 'mate', team: 4, curr_weapon: '空手', curr_weapon_status: 'resolved', weapon: null });
  if (players[2]) set(players[2], { status_key: 'down', status: '倒地', life_state: 'downed' });
  if (players[3]) set(players[3], { pose: { movement: 'swim' } });
  if (players[4]) set(players[4], { pose: { crouched: true } });
  if (players[5]) set(players[5], { pose: { prone: true }, curr_weapon: '匕首', curr_weapon_status: 'resolved' });
  if (players[6]) set(players[6], { curr_weapon: null, curr_weapon_status: 'pending', weapon: 'M4A1' });
  if (players[7]) set(players[7], { out_of_range: true });
  if (players[8]) set(players[8], { curr_weapon: '武器 18100000029', curr_weapon_id: 18100000029, curr_weapon_status: 'resolved' });
  if (players[9]) set(players[9], { hp: { total: [0, 100] } });
  s.entities.push({ key: 'anon-13', kind: 'unknown', name: '未知玩家', hp: null, world: at(4200, -3100, 600), yaw: 285, team: null });
  for (let i = 0; i < 3; i++) s.entities.push({ key: 'spawn-' + i, kind: 'ai', name: 'AI·士兵', spawn_mark: true, age_sec: 20 + i * 4,
    hp: { total: [95, null] }, weapon: '空手', curr_weapon: ['UZI', '野牛', 'M870'][i], curr_weapon_status: 'resolved', helmet: 1, vest: 1,
    world: at(-3300 + i * 2100, 2500 - i * 1500), yaw: null });
  s.entities.push({ key: 'ai-live', kind: 'ai', name: 'AI·火焰兵', hp: { total: [350, null] }, curr_weapon: '空手', curr_weapon_status: 'resolved', world: at(2600, 1800, -400), yaw: 90 });
  for (const e of s.entities) if (e.kind === 'player' && e.hp == null) e.hp = { total: [100, 100], max_source: 'operator_default' };
  return s;
}

/* 本人边跑边周期性起跳：约 4.3 m/s 绕圈，每 3.2 s 腾空 0.62 s、最高 55 cm，腾空期间 movement=fall。
   用来复现第一视角跑跳时的镜头与视模表现；self_up_loc 与真实后端一样给出上行坐标。 */
const JUMP_PERIOD_S = 3.2, JUMP_AIR_S = 0.62, JUMP_CM = 55;
function liveState(tSec) {
  const s = enrich(structuredClone(stateFixture));
  const own = orbit(stateFixture.self, 7, tSec * 0.6);
  const jt = tSec % JUMP_PERIOD_S, air = jt < JUMP_AIR_S, u = jt / JUMP_AIR_S;
  own.world[2] += air ? 4 * JUMP_CM * u * (1 - u) : 0;
  s.self = own.world; s.self_yaw = own.yaw;
  s.self_up_loc = own.world.slice(); s.self_up_ts = Math.round(tSec * 1000) / 1000;
  s.self_pose = air ? { movement: 'fall', crouched: false, prone: false } : { crouched: false, prone: false };
  s.self_weapon = 'MP5'; s.self_weapon_status = 'resolved';
  s.self_aim_yaw = own.yaw; s.self_aim_age_ms = 40; s.self_pitch = -6; s.self_aim_source = 'upstream';
  s.self_life = { state: 'alive', dead: false, downed: false, confirmed: true };
  s.self_hp = { total: [100, 100], max_source: 'operator_default' };
  s.self_name = '揽朝夕(self)';
  let i = 0;
  for (const e of s.entities) {
    if (!['player', 'mate', 'ai', 'unknown'].includes(e.kind) || !Array.isArray(e.world) || e.dead || e.spawn_mark) continue;
    const base = e.world.slice(), pose = orbit(base, i, tSec);
    e.world = pose.world; e.xyz = pose.world; e.yaw = pose.yaw;
    e.trail = [];
    for (let k = SIM_TRAIL_N - 1; k >= 0; k--) { const p = orbit(base, i, tSec - k * SIM_TRAIL_STEP_S).world; e.trail.push([Math.round(p[0]), Math.round(p[1])]); }
    i++;
  }
  for (const e of s.entities) {
    if (Array.isArray(e.world) && Array.isArray(s.self)) e.rel = [e.world[0] - s.self[0], e.world[1] - s.self[1], e.world[2] - s.self[2]];
    if (e.spawn_mark) e.age_sec = Math.round((e.age_sec || 0) + tSec);
  }
  s.live_active = true;
  delete s.status; delete s.replay; delete s.cursor;
  s.timestampMs = startedAt + Math.round(tSec * 1000);
  s.session = session; s.epoch = session; s.flow = 'demo-session / ' + session;
  s.dev_fixture = true;
  return applyShift(s);
}

// 与真实后端一致：快照按固定频率（20 Hz）产生；pose_age_ms 按挂钟增长，即使快照不变也每次请求都不同
const SNAPSHOT_HZ = 20;
function withAges(s) {
  if (!s || !Array.isArray(s.entities)) return s;
  const now = Date.now(), out = { ...s, entities: s.entities.map(e => ['player', 'mate', 'unknown'].includes(e.kind) ? { ...e, pose_age_ms: now - (s.timestampMs || now) } : e) };
  return out;
}
function currentState() { return withAges(snapshotState()); }
function snapshotState() {
  const tSec = Math.floor((Date.now() - startedAt) / 1000 * SNAPSHOT_HZ) / SNAPSHOT_HZ;
  switch (opt.scenario) {
    case 'waiting':
      return { cursor: { live: false, seq: 0 }, entities: [], live_active: false, schema: 'gateway-state/v5', self: null, status: 'waiting', dev_fixture: true };
    case 'stalled':
      return frozen ??= liveState(tSec);
    case 'noself': {
      const s = liveState(tSec);
      for (const k of Object.keys(s)) if (k.startsWith('self_') && k !== 'self_name') delete s[k];
      s.self = null;
      for (const e of s.entities) delete e.rel;
      return s;
    }
    case 'nonlive': {
      const s = liveState(tSec);
      s.live_active = false; s.status = 'replay';
      s.replay = { paused: true, position: 475.4, duration: 511.7, seeking: false };
      return s;
    }
    default:
      return liveState(tSec);
  }
}
function currentStatus() {
  const s = opt.scenario === 'waiting' ? { entities: [] } : currentState();
  const c = { characters: 0, charactersIncludingSelf: 0, ai: 0, loot: 0, box: 0, confirmedBots: 0, unknownMovementSlots: 0 };
  for (const e of s.entities || []) {
    if (['player', 'mate', 'unknown'].includes(e.kind)) c.characters++;
    if (e.kind === 'ai') c.ai++; if (e.kind === 'loot') c.loot++; if (e.kind === 'box') c.box++;
  }
  c.charactersIncludingSelf = c.characters + (s.self ? 1 : 0);
  const live = opt.scenario === 'live' || opt.scenario === 'noself';
  return { schema: 'gateway-parser-status/v5', dev_fixture: true, error: null, semanticComplete: false, counts: c,
    rates: live ? { characters: 12.4, self: 20 } : {}, transport: { udpUpPackets: 0, udpDownPackets: 0, udpBoundFlows: live ? 1 : 0 },
    stats: { inputErrors: 0, eventGaps: 0 }, replay: opt.scenario === 'nonlive' ? { paused: true } : null };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.glb': 'model/gltf-binary',
  '.tpk': 'application/octet-stream', '.gz': 'application/gzip',
};
function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}
function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const abs = path.resolve(ROOT, decoded.replace(/^\/+/, ''));
  if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) return null;
  return abs;
}
function serveFile(res, absPath) {
  if (!fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) { res.writeHead(404); res.end('Not found'); return; }
  let data = fs.readFileSync(absPath);
  const ext = path.extname(absPath).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  if (ext === '.html') {
    data = Buffer.from(data.toString('utf8').replaceAll('__MS_NO3D__', fs.existsSync(path.join(ROOT, 'm3d/manifest.json')) ? '0' : '1'));
    headers['Cache-Control'] = 'no-store';
  } else if (['.js', '.css', '.json', '.mjs'].includes(ext)) headers['Cache-Control'] = 'no-cache';
  else if (ext === '.glb' || ext === '.tpk') headers['Cache-Control'] = 'public, max-age=86400';
  headers['Content-Length'] = data.length;
  res.writeHead(200, headers);
  res.end(data);
}
function mapInfo() {
  const doc = structuredClone(mapCatalog);
  for (const m of doc.maps || []) if (m?.key && !m.tileUrl?.startsWith('http')) m.tileUrl = `/resources/maps2d/${m.key}/{z}_{x}_{y}.jpg`;
  return doc;
}

// 只读转发：真实后端的响应原样返回（状态码、正文），失败时返回 502 让页面显示连接异常
async function proxy(res, target) {
  try {
    const r = await fetch(target, { signal: AbortSignal.timeout(4000) });
    const body = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json; charset=utf-8', 'Cache-Control': r.headers.get('cache-control') || 'no-store', 'Content-Length': body.length });
    res.end(body);
  } catch (e) { json(res, 502, { error: '上游不可达：' + (e.message || e) }); }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end('Method not allowed'); return; }
  if (url.pathname === '/__dev/scenario') {
    const set = url.searchParams.get('set');
    if (set) { if (!SCENARIOS.includes(set)) return json(res, 400, { error: '未知情景', scenarios: SCENARIOS }); opt.scenario = set; frozen = null; }
    if (url.searchParams.has('terrain')) opt.terrain = url.searchParams.get('terrain') !== '0';
    if (url.searchParams.has('session')) { session = Number(url.searchParams.get('session')) || session + 1; frozen = null; }
    if (url.searchParams.has('map')) { const k = url.searchParams.get('map'); mapShift = k ? shiftFor(k) : null; if (k && !mapShift) return json(res, 400, { error: '未知地图', maps: Object.keys(manifestMaps) }); frozen = null; }
    return json(res, 200, { scenario: opt.scenario, terrain: opt.terrain, session, shifted: !!mapShift, scenarios: SCENARIOS });
  }
  // 真实后端的地图目录给出相对路径的瓦片（/resources/maps2d/...），资源也一并转发
  if (opt.upstream && (['/api/state', '/api/status', '/api/map'].includes(url.pathname) || url.pathname.startsWith('/resources/'))) return proxy(res, opt.upstream + url.pathname + url.search);
  if (url.pathname === '/api/state') return opt.scenario === 'error' ? json(res, 503, { error: '样例：服务不可用' }) : json(res, 200, currentState());
  if (url.pathname === '/api/status') return opt.scenario === 'error' ? json(res, 503, { error: '样例：服务不可用' }) : json(res, 200, currentStatus());
  if (url.pathname === '/api/map') return json(res, 200, mapInfo());
  if (url.pathname.startsWith('/api/')) return json(res, 404, { error: '开发服务器不提供该接口' });
  if (!opt.terrain && /^\/m3d\/.+\.(glb|tpk)$/i.test(url.pathname)) { res.writeHead(404); res.end('terrain disabled (dev scenario)'); return; }
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const abs = safePath(rel);
  if (!abs) { res.writeHead(403); res.end('Forbidden'); return; }
  serveFile(res, abs);
});
server.listen(opt.port, opt.host, () => {
  console.log(`Nova 实时雷达开发服务器 → http://${opt.host}:${opt.port}/`);
  console.log(opt.upstream ? `接口转发到真实后端：${opt.upstream}（只读）` : `情景：${opt.scenario}${opt.terrain ? '' : '（地形 404）'} · 样例数据均为测试数据，不能作为实时验收证据`);
});
