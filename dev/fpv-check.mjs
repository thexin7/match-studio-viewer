#!/usr/bin/env node
/**
 * 第一视角 / 第三跟随镜头平滑度检查：打开页面进入 3D，逐渲染帧记录相机位置与视线方向
 * （korr-renderer 的 window.__msFrameLog 诊断钩子），统计每帧水平速度、竖直速度与转向角速度的波动。
 * 镜头按快照频率「走一下停一下」时，停顿帧比例和速度变异系数会明显升高。
 * 配合 dev/server.mjs（本人约 4.3 m/s 绕圈并周期性起跳）使用；真实后端也可用，但结论取决于当时的运动。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Cdp, findChrome, waitJson, sleep } from './smoke.mjs';

const HELP = `用法: node dev/fpv-check.mjs [选项]
  --url <地址>        被测页面，默认 http://127.0.0.1:5180/
  --seconds <秒>      每种镜头的记录时长，默认 8
  --cams <列表>       逗号分隔的镜头：fpv,chase，默认 fpv,chase
  --hardware          使用默认 GPU 路径（默认 SwiftShader）
  --phone             390x844 手机视口
  --out <目录>        截图目录，默认 <临时目录>/ms-fpv
  --port <端口>       远程调试端口，默认 9365
输出: stdout 打印 JSON；页面异常或 console.error 退出码 1；参数或环境错误退出码 2。`;

function parseArgs(argv) {
  const o = { url: 'http://127.0.0.1:5180/', seconds: 8, cams: ['fpv', 'chase'], hardware: false, phone: false, out: path.join(os.tmpdir(), 'ms-fpv'), port: 9365 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(a + ' 缺少参数值'); return argv[++i]; };
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a === '--url') o.url = v();
    else if (a === '--seconds') o.seconds = Number(v());
    else if (a === '--cams') o.cams = v().split(',').map(x => x.trim()).filter(Boolean);
    else if (a === '--hardware') o.hardware = true;
    else if (a === '--phone') o.phone = true;
    else if (a === '--out') o.out = v();
    else if (a === '--port') o.port = Number(v());
    else throw new Error('未知参数: ' + a);
  }
  if (!(o.seconds > 0)) throw new Error('--seconds 必须为正数');
  if (!o.cams.every(c => c === 'fpv' || c === 'chase')) throw new Error('--cams 只支持 fpv、chase');
  return o;
}

const q = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null;
const r2 = v => v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;

// 帧日志每帧 7 个数：渲染时刻 ms、相机 x/y/z（米）、视线方向 x/y/z
export function analyzeFrames(log) {
  const n = Math.floor(log.length / 7), hs = [], vs = [], ws = [], dts = [];
  for (let i = 1; i < n; i++) {
    const a = (i - 1) * 7, b = i * 7, dt = (log[b] - log[a]) / 1000;
    if (!(dt > 0) || dt > 0.1) continue;
    const dx = log[b + 1] - log[a + 1], dy = log[b + 2] - log[a + 2], dz = log[b + 3] - log[a + 3];
    const h = Math.hypot(dx, dy) / dt;
    if (h > 30) continue; // 换目标或重置镜头的瞬移不计入
    const yawA = Math.atan2(log[a + 5], log[a + 4]), yawB = Math.atan2(log[b + 5], log[b + 4]);
    const dyaw = Math.atan2(Math.sin(yawB - yawA), Math.cos(yawB - yawA));
    hs.push(h); vs.push(Math.abs(dz) / dt); ws.push(Math.abs(dyaw) * 180 / Math.PI / dt); dts.push(dt * 1000);
  }
  const stats = (arr, stallBelow) => {
    const s = arr.slice().sort((x, y) => x - y), med = q(s, 0.5) || 0;
    const mean = arr.reduce((x, y) => x + y, 0) / (arr.length || 1);
    const sd = Math.sqrt(arr.reduce((x, y) => x + (y - mean) ** 2, 0) / (arr.length || 1));
    // 相邻帧速度变化（抖动）：平滑运动应接近 0，走停交替时接近中位速度
    let jerk = 0; for (let i = 1; i < arr.length; i++) jerk += Math.abs(arr[i] - arr[i - 1]);
    return { median: r2(med), p95: r2(q(s, 0.95)), cv: r2(mean > 0 ? sd / mean : 0),
      stallFrames: r2(med > stallBelow ? arr.filter(v => v < med * 0.25).length / (arr.length || 1) : 0),
      meanFrameDelta: r2(arr.length > 1 ? jerk / (arr.length - 1) : 0) };
  };
  const ft = dts.slice().sort((x, y) => x - y);
  return { frames: hs.length, fps: r2(1000 / (dts.reduce((x, y) => x + y, 0) / (dts.length || 1))), frameMs: { p50: r2(q(ft, 0.5)), p95: r2(q(ft, 0.95)) },
    horizontalMps: stats(hs, 0.5), verticalMps: stats(vs, 0.2), turnDegPerSec: stats(ws, 5) };
}

async function main() {
  let opt;
  try { opt = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); console.error(HELP); return 2; }
  let chromePath; try { chromePath = findChrome(); } catch (e) { console.error(e.message); return 2; }
  fs.mkdirSync(opt.out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-fpv-profile-'));
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${opt.port}`, `--user-data-dir=${profile}`, '--window-size=1440,900',
    '--no-first-run', '--no-default-browser-check', ...(opt.hardware ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']), '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  const errors = [];
  let code = 0, out = {};
  try {
    const page = (await waitJson(`http://127.0.0.1:${opt.port}/json/list`)).find(t => t.type === 'page');
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    cdp.on(msg => {
      if (msg.method === 'Runtime.exceptionThrown') errors.push('异常: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text).split('\n')[0]);
      else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push('console.error: ' + msg.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    });
    for (const d of ['Page', 'Runtime']) await cdp.send(d + '.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', opt.phone ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } : { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: opt.url });
    await sleep(800);
    await cdp.eval(`localStorage.clear(); localStorage.setItem('nr2_q3d','auto'); 0`);
    await cdp.send('Page.reload', { ignoreCache: true });
    const waitFor = async (expr, ms) => { const end = Date.now() + ms; for (;;) { if (await cdp.eval(expr)) return true; if (Date.now() > end) return false; await sleep(250); } };
    if (!await waitFor('document.getElementById("status-pill")?.dataset.state === "live"', 20000)) throw new Error('页面未进入实时状态');
    await cdp.eval(`document.getElementById('s-3d').click(); 0`);
    if (!await waitFor('window.gateway3d?.stat()?.mapChunks?.triangles > 0 || !!window.gateway3d?.stat()?.err', 120000)) throw new Error('3D 地形未在 120 秒内装载');
    const shot = async name => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(opt.out, (opt.phone ? 'phone-' : 'desktop-') + name + '.png'); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); return f; };
    const cams = {};
    for (const cam of opt.cams) {
      await cdp.eval(`document.querySelector('#camseg button[data-cam="${cam}"]').click(); 0`);
      await sleep(2500);
      await cdp.eval('window.__msFrameLog = []; 0');
      const shots = [];
      const end = Date.now() + opt.seconds * 1000;
      // 跑动与腾空各截一张：dev 服务器每 3.2 s 起跳一次，腾空 0.62 s
      let grounded = null, airborne = null;
      while (Date.now() < end) {
        const air = await cdp.eval(`(() => { const p = window.AppState?.gameData?.local?.pose; return !!p && p.movement === 'fall'; })()`);
        if (air && !airborne) { airborne = await shot(cam + '-airborne'); shots.push(airborne); }
        else if (!air && !grounded) { grounded = await shot(cam + '-running'); shots.push(grounded); }
        await sleep(60);
      }
      const log = await cdp.eval('(() => { const l = window.__msFrameLog; window.__msFrameLog = null; return l; })()');
      cams[cam] = { ...analyzeFrames(log), screenshots: shots };
    }
    out = { url: opt.url, gpu: opt.hardware ? 'default' : 'swiftshader', viewport: opt.phone ? '390x844@2' : '1440x900', cams };
    cdp.ws.close();
  } catch (e) { console.error('检查中断:', e.message); code = 2; }
  finally { chrome.kill(); await sleep(400); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }
  if (code === 0 && errors.length) code = 1;
  console.log(JSON.stringify({ ok: code === 0, ...out, errors }, null, 2));
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
