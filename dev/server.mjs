#!/usr/bin/env node
/**
 * Match Studio 本地开发服务器。
 * 提供静态资源与样例版 /api/* 响应。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudioAPI } from './studio-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';

const stateFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/state.json'), 'utf8')
);
const statusFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/status.json'), 'utf8')
);
const mapCatalog = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'map_catalog.json'), 'utf8')
);

let replayPaused = statusFixture.replay?.paused ?? false;
let replaySpeed = statusFixture.replay?.speed ?? 1;
let replayPosition = statusFixture.replay?.positionMs ?? 0;
const replayDurationMs = statusFixture.replay?.durationMs ?? 420000;
// 回放时钟：暂停 / 倍速 / 跳转都从「当前位置」重新起算，避免倍速切换时位置跳变。
let replayClockAt = Date.now();

// 样例回放到结尾后从头循环，长时间开着 dev 服务也一直有运动数据可看
function replayNowMs() {
  if (replayPaused) return replayPosition;
  const pos = replayPosition + (Date.now() - replayClockAt) * replaySpeed;
  return pos % replayDurationMs;
}

function rebaseReplayClock() {
  replayPosition = replayNowMs();
  replayClockAt = Date.now();
}

/* 样例运动：fixture 只有一帧静态坐标，本地无法验证平滑、贴脸预警和 3D HUD。
   这里让每个人物绕自己的 fixture 坐标做确定性的圆周运动（半径与角速度按序号错开），
   一部分敌人会周期性进出 80m 贴脸范围。只影响 dev 服务，不改变 API 字段形状。 */
const SIM_TRAIL_N = 16;
const SIM_TRAIL_STEP_S = 0.6;

function orbit(base, i, tSec) {
  const radius = 1500 + (i % 4) * 900;            // cm
  const omega = (0.12 + (i % 3) * 0.05) * (i % 2 ? -1 : 1);
  const phase = i * 1.37;
  const a = omega * tSec + phase;
  const x = base[0] + radius * (Math.cos(a) - Math.cos(phase));
  const y = base[1] + radius * (Math.sin(a) - Math.sin(phase));
  // 切线方向即移动朝向；UE yaw：+X 为 0°，向 +Y 增大
  const yaw = (Math.atan2(omega * Math.cos(a), -omega * Math.sin(a)) * 180 / Math.PI + 360) % 360;
  return { world: [x, y, base[2]], yaw };
}

function simulate(s, tSec) {
  const own = orbit(stateFixture.self, 7, tSec * 0.6);
  s.self = own.world;
  s.self_yaw = own.yaw;
  let i = 0;
  for (const e of s.entities) {
    if (!['player', 'mate', 'ai'].includes(e.kind) || !Array.isArray(e.world) || e.dead) continue;
    const base = e.world.slice();
    const pose = orbit(base, i, tSec);
    e.world = pose.world;
    e.xyz = pose.world;
    e.yaw = pose.yaw;
    e.trail = [];
    for (let k = SIM_TRAIL_N - 1; k >= 0; k--) {
      const p = orbit(base, i, tSec - k * SIM_TRAIL_STEP_S).world;
      e.trail.push([Math.round(p[0]), Math.round(p[1])]);
    }
    i++;
  }
  for (const e of s.entities) {
    if (Array.isArray(e.world) && Array.isArray(s.self)) {
      e.rel = [e.world[0] - s.self[0], e.world[1] - s.self[1], e.world[2] - s.self[2]];
    }
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gz': 'application/gzip',
};

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = decoded.replace(/^\/+/, '');
  const abs = path.resolve(ROOT, rel);
  if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) return null;
  return abs;
}

function serveFile(res, absPath) {
  if (!fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  let data = fs.readFileSync(absPath);
  const ext = path.extname(absPath).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
  };
  if (ext === '.html') {
    data = Buffer.from(
      data
        .toString('utf8')
        .replaceAll('__MS_NO3D__', fs.existsSync(path.join(ROOT, 'm3d/manifest.json')) ? '0' : '1')
    );
    headers['Cache-Control'] = 'no-store';
  } else if (['.js', '.css', '.json'].includes(ext)) {
    headers['Cache-Control'] = 'no-cache';
  } else if (ext === '.glb') {
    headers['Cache-Control'] = 'public, max-age=86400';
  }
  headers['Content-Length'] = data.length;
  res.writeHead(200, headers);
  res.end(data);
}

function mapInfo() {
  const doc = structuredClone(mapCatalog);
  if (Array.isArray(doc.maps)) {
    for (const m of doc.maps) {
      if (m?.key && !m.tileUrl?.startsWith('http')) {
        m.tileUrl = `/resources/maps2d/${m.key}/{z}_{x}_{y}.jpg`;
      }
    }
  }
  return doc;
}

function currentState() {
  const s = structuredClone(stateFixture);
  const posMs = replayNowMs();
  simulate(s, posMs / 1000);
  s.live_active = false;
  s.status = replayPaused ? 'paused' : 'replay';
  s.replay = { paused: replayPaused, speed: replaySpeed, position: posMs / 1000, seeking: false };
  s.cursor = {
    ...(s.cursor || {}),
    lo: 0, hi: 1000, seq: Math.round(1000 * posMs / replayDurationMs),
    t_lo: 0, t_hi: replayDurationMs / 1000, speed: replaySpeed,
  };
  if (statusFixture.replay) {
    statusFixture.replay.paused = replayPaused;
    statusFixture.replay.speed = replaySpeed;
    statusFixture.replay.positionMs = posMs;
  }
  return s;
}

function handleApi(req, res, url) {
  switch (url.pathname) {
    case '/api/state':
      return json(res, 200, currentState());
    case '/api/status':
      return json(res, 200, statusFixture);
    case '/api/map':
      return json(res, 200, mapInfo());
    case '/api/flows':
      return json(res, 200, { flows: [{ id: 'demo-session / 1', label: 'Demo session' }] });
    case '/api/select':
      return json(res, 200, { ok: true });
    case '/api/ctrl': {
      const q = url.searchParams;
      rebaseReplayClock();
      if (q.has('pause')) replayPaused = q.get('pause') === '1';
      if (q.has('speed')) replaySpeed = Number(q.get('speed')) || 1;
      // 前端 seek 滑块是 0–1000 的千分比
      if (q.has('seek')) replayPosition = Math.max(0, Math.min(1000, Number(q.get('seek')) || 0)) / 1000 * replayDurationMs;
      return json(res, 200, { ok: true, paused: replayPaused, speed: replaySpeed, positionMs: replayPosition });
    }
    default:
      return false;
  }
}

const studioAPI = createStudioAPI();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/studio') {
    studioAPI(req, res, fs.existsSync(path.join(ROOT, 'm3d/manifest.json')));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }

  if (handleApi(req, res, url) !== false) return;

  let rel = url.pathname;
  if (rel === '/' || rel === '/index.html') rel = '/index.html';
  else if (rel === '/studio' || rel === '/studio/') rel = '/ui/studio/index.html';
  else if (/^\/overlay(?:\/(?:status|alert|radar|threats|observer|ticker|minimap)?)?$/.test(rel)) rel = '/ui/studio/overlay.html';
  else rel = rel.replace(/^\//, '');

  const abs = safePath('/' + rel);
  if (!abs) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  serveFile(res, abs);
});

server.listen(PORT, HOST, () => {
  console.log(`Match Studio 开发服务器 → http://${HOST}:${PORT}/`);
  console.log('样例数据：dev/fixtures/state.json（回放模式，人物按确定性轨迹移动）');
});
