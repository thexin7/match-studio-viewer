#!/usr/bin/env node
/**
 * Local dev gateway for Match Studio viewer.
 * Serves static assets and a minimal REST API backed by fixtures.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
        .replaceAll('__NOVA_NO3D__', fs.existsSync(path.join(ROOT, 'm3d/manifest.json')) ? '0' : '1')
    );
    headers['Cache-Control'] = 'no-store';
  } else if (['.js', '.css', '.json'].includes(ext)) {
    headers['Cache-Control'] = 'no-cache';
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
  s.live_active = false;
  s.status = replayPaused ? 'paused' : 'replay';
  s.cursor = s.cursor || {};
  s.cursor.speed = replaySpeed;
  if (statusFixture.replay) {
    statusFixture.replay.paused = replayPaused;
    statusFixture.replay.speed = replaySpeed;
    statusFixture.replay.positionMs = replayPosition;
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
      if (q.has('pause')) replayPaused = q.get('pause') === '1';
      if (q.has('speed')) replaySpeed = Number(q.get('speed')) || 1;
      if (q.has('seek')) replayPosition = Number(q.get('seek')) || 0;
      return json(res, 200, { ok: true, paused: replayPaused, speed: replaySpeed, positionMs: replayPosition });
    }
    default:
      return false;
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (handleApi(req, res, url) !== false) return;

  let rel = url.pathname;
  if (rel === '/' || rel === '/index.html') rel = '/index.html';
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
  console.log(`Match Studio dev server → http://${HOST}:${PORT}/`);
  console.log('Fixtures: dev/fixtures/state.json (replay mode)');
});
