#!/usr/bin/env node
/**
 * 实时雷达检查与性能采样：打开任意部署地址（真实后端或 dev/server.mjs），记录状态胶囊时间线、
 * 页面错误与失败请求，并按阶段采样脚本/布局耗时、长任务、帧间隔、网络量、3D 绘制次数与资源数量；
 * --soak 反复切图与切换 2D/3D，强制 GC 后记录内存、DOM 与 3D 资源的增长。
 * 每个阶段同时记录各 Chrome 进程（页面、GPU、浏览器）的 CPU 占用，单位为单核百分比。
 * 无头 Chrome 的 rAF 不跟显示器同步（本机实测约 300 Hz）；需要跟真实显示器节拍时用 --headful。
 * 默认强制 SwiftShader：帧率与耗时偏保守，不等于真实 GPU；需要硬件路径时加 --hardware。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Cdp, findChrome, waitJson, sleep } from './smoke.mjs';

const HELP = `用法: node dev/live-check.mjs [选项]
  --url <地址>        被测页面，默认 http://127.0.0.1:5180/
  --seconds <秒>      每个阶段的采样时长，默认 15
  --phone             使用 390x844 手机视口（DPR 2，触控）
  --size <宽x高>      桌面视口，默认 1440x900
  --3d                追加 3D 第三跟随（含小地图）、第三跟随（关小地图）、第一跟随三个阶段
  --soak <分钟>       长时间运行：循环切换地图与 2D/3D，记录资源增长
  --out <目录>        截图目录，默认 <临时目录>/ms-live
  --hardware          使用默认 GPU 路径
  --profile           每个阶段采集 CPU 剖析，输出自身耗时最高的函数与文件
  --headful           用有界面 Chrome（窗口放到屏幕外），帧节拍跟随真实显示器垂直同步；测 CPU 占用时推荐
  --frames            采样 rAF 帧间隔（自带一个 rAF 循环，会推高主线程与合成器占用，测 CPU 时不要开）
  --trace             每个阶段录制 Chrome trace，按线程汇总忙碌时间、按事件名汇总主线程自身耗时与帧数
  --cpu <倍数>        CPU 降速倍数（如 4，用于近似手机），默认 1
  --pref <键=值>      启动前写入页面偏好（localStorage 的 nr2_<键>），可重复，用于对照实验
  --init-js <代码>    页面脚本之前注入的一段 JS（对照实验用）
  --port <端口>       远程调试端口，默认 9361
输出: stdout 打印 JSON；有页面异常或 console.error 时退出码 1；参数或环境错误退出码 2。`;

function parseArgs(argv) {
  const o = { url: 'http://127.0.0.1:5180/', seconds: 15, phone: false, width: 1440, height: 900, three: false, soak: 0, out: path.join(os.tmpdir(), 'ms-live'), hardware: false, port: 9361, profile: false, cpu: 1, headful: false, trace: false, frames: false, prefs: {}, initJs: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(a + ' 缺少参数值'); return argv[++i]; };
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a === '--url') o.url = v();
    else if (a === '--seconds') o.seconds = Number(v());
    else if (a === '--phone') o.phone = true;
    else if (a === '--size') { const m = /^(\d+)x(\d+)$/.exec(v()); if (!m) throw new Error('--size 格式应为 宽x高'); o.width = +m[1]; o.height = +m[2]; }
    else if (a === '--3d') o.three = true;
    else if (a === '--soak') o.soak = Number(v());
    else if (a === '--out') o.out = v();
    else if (a === '--hardware') o.hardware = true;
    else if (a === '--port') o.port = Number(v());
    else if (a === '--profile') o.profile = true;
    else if (a === '--cpu') o.cpu = Number(v());
    else if (a === '--headful') o.headful = true;
    else if (a === '--trace') o.trace = true;
    else if (a === '--frames') o.frames = true;
    else if (a === '--init-js') o.initJs = v();
    else if (a === '--pref') { const m = /^([a-z0-9_]+)=(.*)$/i.exec(v()); if (!m) throw new Error('--pref 格式应为 键=值'); o.prefs[m[1]] = m[2]; }
    else throw new Error('未知参数: ' + a);
  }
  if (!(o.seconds > 0)) throw new Error('--seconds 必须为正数');
  return o;
}

// 页面内的测量钩子：长任务与按需启动的帧间隔采样（只在采样窗口内运行，避免常驻 rAF 影响结果）
const PROBE = `(() => {
  window.__lt = { n: 0, ms: 0, max: 0 };
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) { __lt.n++; __lt.ms += e.duration; __lt.max = Math.max(__lt.max, e.duration); } }).observe({ type: 'longtask', buffered: true }); } catch {}
  window.__ftStart = () => { window.__ft = []; window.__ftOn = true; let last = 0; const f = t => { if (!window.__ftOn) return; if (last) __ft.push(t - last); last = t; requestAnimationFrame(f); }; requestAnimationFrame(f); };
  window.__ftStop = () => { window.__ftOn = false; const a = (window.__ft || []).slice().sort((x, y) => x - y); const q = p => a.length ? Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))] * 10) / 10 : null; return { frames: a.length, p50: q(.5), p95: q(.95), p99: q(.99), max: a.length ? Math.round(a[a.length - 1]) : null }; };
})();`;
const READ = `(() => { const p = document.getElementById('status-pill'), b = document.getElementById('banner');
  const st = window.gateway3d ? window.gateway3d.stat() : null;
  return { state: p ? p.dataset.state : null, label: p ? p.innerText.replace(/\\s+/g, ' ').trim() : '', banner: b && !b.hidden ? b.innerText.replace(/\\s+/g, ' ') : '',
    map: typeof MAP_INFO !== 'undefined' && MAP_INFO ? MAP_INFO.key : null, mapSrc: document.getElementById('map-src')?.dataset.src || '',
    ops: document.getElementById('n-ops')?.textContent, loot: document.getElementById('n-loot')?.textContent,
    markers: typeof markers !== 'undefined' ? markers.size : null, infos: typeof infos !== 'undefined' ? infos.size : null,
    r3: st ? { fps: Math.round(st.fps || 0), calls: st.renderCalls, tris: st.triangles, geometries: st.resources?.geometries, textures: st.resources?.textures, players: st.players, err: st.err } : null };
})()`;

// 本次启动的 Chrome 各进程（按用户数据目录匹配）工作集之和，MB；仅 Windows，失败返回 null
function chromeWorkingSetMB(profile) {
  if (process.platform !== 'win32') return null;
  try {
    const like = profile.replace(/'/g, "''");
    const outp = execFileSync('powershell', ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*" + like + "*' } | Measure-Object -Property WorkingSetSize -Sum).Sum"], { encoding: 'utf8', timeout: 15000 });
    const v = Number(outp.trim()); return Number.isFinite(v) ? Math.round(v / 1048576) : null;
  } catch { return null; }
}

// CPU 剖析汇总：按「函数 文件:行」与按文件统计自身耗时，换算成每秒毫秒
function summarizeProfile(profile, seconds) {
  const self = new Map(), byId = new Map(profile.nodes.map(n => [n.id, n]));
  for (let i = 0; i < profile.samples.length; i++) { const id = profile.samples[i], dt = (profile.timeDeltas[i] || 0) / 1000; self.set(id, (self.get(id) || 0) + dt); }
  const fn = new Map(), file = new Map(), special = {};
  for (const [id, ms] of self) {
    const cf = byId.get(id).callFrame, name = cf.functionName || '(anonymous)';
    if (!cf.url && name.startsWith('(')) { special[name] = (special[name] || 0) + ms; continue; }
    const base = cf.url ? cf.url.split('?')[0].split('/').pop() : '(native)';
    const k = name + ' ' + base + ':' + (cf.lineNumber + 1);
    fn.set(k, (fn.get(k) || 0) + ms); file.set(base, (file.get(base) || 0) + ms);
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, Math.round(v / seconds * 10) / 10]);
  return { msPerSec: Object.fromEntries(Object.entries(special).map(([k, v]) => [k, Math.round(v / seconds * 10) / 10])), topFiles: top(file, 10), topFunctions: top(fn, 25) };
}

// trace 汇总：各线程顶层事件的忙碌时间（ms/s）、页面主线程按事件名的自身耗时、主线程帧数与 GPU 绘制次数
function summarizeTrace(events, seconds) {
  const names = new Map();
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') names.set(e.pid + ':' + e.tid, e.args.name);
  const byThread = new Map();
  for (const e of events) if (e.ph === 'X' && e.dur > 0) { const k = e.pid + ':' + e.tid; (byThread.get(k) || byThread.set(k, []).get(k)).push(e); }
  const busy = {}, selfByName = new Map(), counts = {};
  let mainKey = null, mainBusy = -1;
  for (const [k, list] of byThread) {
    list.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    let top = 0, end = -1;
    for (const e of list) if (e.ts >= end) { top += e.dur; end = e.ts + e.dur; }
    const n = names.get(k) || k;
    busy[n] = Math.round(((busy[n] || 0) + top / 1000 / seconds) * 10) / 10;
    if (n === 'CrRendererMain' && top > mainBusy) { mainBusy = top; mainKey = k; }
  }
  if (mainKey) {
    const stack = [];
    for (const e of byThread.get(mainKey)) {
      while (stack.length && stack[stack.length - 1].end <= e.ts) stack.pop();
      if (stack.length) stack[stack.length - 1].child += e.dur;
      const rec = { name: e.name, end: e.ts + e.dur, dur: e.dur, child: 0 };
      stack.push(rec);
      e._rec = rec;
    }
    for (const e of byThread.get(mainKey)) { const r = e._rec; selfByName.set(r.name, (selfByName.get(r.name) || 0) + Math.max(0, r.dur - r.child)); }
  }
  // 帧相关事件计数：主线程帧（ProxyMain::BeginMainFrame）、动画帧回调、显示合成器绘制
  const FRAME_EVENTS = new Set(['ProxyMain::BeginMainFrame', 'FireAnimationFrame', 'Display::DrawAndSwap', 'TimerFire', 'ResourceSendRequest']);
  for (const e of events) if (FRAME_EVENTS.has(e.name) && (e.ph === 'X' || e.ph === 'B' || e.ph === 'I' || e.ph === 'i')) counts[e.name] = (counts[e.name] || 0) + 1;
  const per = v => Math.round(v / seconds * 10) / 10;
  return { threadBusyMsPerSec: Object.fromEntries(Object.entries(busy).sort((a, b) => b[1] - a[1]).slice(0, 12)),
    mainSelfMsPerSec: [...selfByName].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => [k, per(v / 1000)]),
    perSec: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, per(v)])) };
}

async function main() {
  let opt;
  try { opt = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); console.error(HELP); return 2; }
  let chromePath; try { chromePath = findChrome(); } catch (e) { console.error(e.message); return 2; }
  fs.mkdirSync(opt.out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-live-profile-'));
  const mode = opt.headful
    ? ['--window-position=-4000,-4000', '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']
    : ['--headless=new'];
  const chrome = spawn(chromePath, [...mode, `--remote-debugging-port=${opt.port}`, `--user-data-dir=${profile}`, `--window-size=${opt.width},${opt.height}`,
    '--no-first-run', '--no-default-browser-check', ...(opt.hardware ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']), '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  const errors = [], warnings = [], failed = [], timeline = [];
  const net = new Map(), reqUrl = new Map();
  let code = 0, out = {}, traceSink = null;
  try {
    const page = (await waitJson(`http://127.0.0.1:${opt.port}/json/list`)).find(t => t.type === 'page');
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    // SystemInfo 只在浏览器级目标上可用
    const browserCdp = await Cdp.connect((await waitJson(`http://127.0.0.1:${opt.port}/json/version`)).webSocketDebuggerUrl);
    const procCpu = async () => { const r = await browserCdp.send('SystemInfo.getProcessInfo'); const m = {}; for (const p of r.processInfo) { const k = p.type === 'GPU' ? 'gpu' : p.type; m[k] = (m[k] || 0) + p.cpuTime; } return m; };
    const bucket = u => { const p = new URL(u).pathname; return p === '/api/state' ? 'api/state' : p.startsWith('/api/') ? 'api/other' : /\.(glb|tpk)$/i.test(p) ? 'terrain' : /maps2d|map_db|\.jpg$/i.test(u) ? 'tiles' : 'other'; };
    cdp.on(msg => {
      if (traceSink && msg.method && msg.method.startsWith('Tracing.')) return traceSink(msg);
      const m = msg.method, p = msg.params;
      if (m === 'Runtime.exceptionThrown') errors.push('异常: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text).split('\n')[0]);
      else if (m === 'Runtime.consoleAPICalled' && p.type === 'error') errors.push('console.error: ' + p.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
      else if (m === 'Runtime.consoleAPICalled' && p.type === 'warning' && warnings.length < 40) warnings.push(p.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200));
      else if (m === 'Network.requestWillBeSent') reqUrl.set(p.requestId, p.request.url);
      else if (m === 'Network.responseReceived' && p.response.status >= 400) failed.push(p.response.status + ' ' + new URL(p.response.url).pathname);
      else if (m === 'Network.loadingFinished') { const u = reqUrl.get(p.requestId); if (u) { const k = bucket(u), r = net.get(k) || { n: 0, bytes: 0 }; r.n++; r.bytes += p.encodedDataLength || 0; net.set(k, r); reqUrl.delete(p.requestId); } }
      else if (m === 'Network.loadingFailed') { const u = reqUrl.get(p.requestId); if (u && !p.canceled) failed.push('失败 ' + new URL(u).pathname + ' ' + p.errorText); reqUrl.delete(p.requestId); }
    });
    for (const d of ['Page', 'Runtime', 'Network', 'Performance', 'HeapProfiler', 'Profiler']) await cdp.send(d + '.enable');
    if (opt.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: opt.cpu });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    if (opt.initJs) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: opt.initJs });
    await cdp.send('Emulation.setDeviceMetricsOverride', opt.phone ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } : { width: opt.width, height: opt.height, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: opt.url });
    await sleep(800);
    await cdp.eval(`localStorage.clear(); localStorage.setItem('nr2_q3d','auto'); ${Object.entries(opt.prefs).map(([k, v]) => `localStorage.setItem(${JSON.stringify('nr2_' + k)}, ${JSON.stringify(v)}); `).join('')}0`);
    await cdp.send('Page.reload', { ignoreCache: true });
    const t0 = Date.now();
    const read = () => cdp.eval(READ);
    const waitFor = async (expr, ms) => { const end = Date.now() + ms; for (;;) { if (await cdp.eval(expr)) return true; if (Date.now() > end) return false; await sleep(250); } };
    await waitFor('document.getElementById("status-pill")?.dataset.state && document.getElementById("status-pill").dataset.state !== "connecting"', 20000);
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
    const shot = async name => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(opt.out, (opt.phone ? 'phone-' : 'desktop-') + name + '.png'); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); return f; };
    const phase = async name => {
      net.clear();
      let traceEvents = null, traceDone = null;
      if (opt.trace) {
        traceEvents = [];
        traceDone = new Promise(resolve => { traceSink = m => { if (m.method === 'Tracing.dataCollected') traceEvents.push(...m.params.value); else if (m.method === 'Tracing.tracingComplete') resolve(); }; });
        await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc', 'gpu', 'viz', 'toplevel', 'v8', '__metadata'] } });
      }
      if (opt.profile) { await cdp.send('Profiler.setSamplingInterval', { interval: 250 }); await cdp.send('Profiler.start'); }
      await cdp.eval(`window.__lt.n = 0; window.__lt.ms = 0; window.__lt.max = 0; ${opt.frames ? 'window.__ftStart(); ' : ''}0`);
      const a = await metrics(), ca = await procCpu(), wa = performance.now(); const samples = [];
      const end = Date.now() + opt.seconds * 1000;
      while (Date.now() < end) { const r = await read(); samples.push(r); timeline.push({ t: Math.round((Date.now() - t0) / 100) / 10, state: r.state, label: r.label }); await sleep(500); }
      const b = await metrics(), cb = await procCpu(), wall = (performance.now() - wa) / 1000; const ft = opt.frames ? await cdp.eval('window.__ftStop()') : undefined; const lt = await cdp.eval('({ ...window.__lt })');
      let trace;
      if (opt.trace) { await cdp.send('Tracing.end'); await traceDone; traceSink = null; trace = summarizeTrace(traceEvents, opt.seconds); }
      const prof = opt.profile ? summarizeProfile((await cdp.send('Profiler.stop')).profile, opt.seconds) : undefined;
      const dt = (b.Timestamp - a.Timestamp) || opt.seconds, per = k => Math.round(((b[k] || 0) - (a[k] || 0)) / dt * 1000 * 10) / 10;
      const last = samples[samples.length - 1] || {};
      const states = samples.reduce((m, s) => (m[s.state] = (m[s.state] || 0) + 1, m), {});
      const netOut = Object.fromEntries([...net].map(([k, v]) => [k, { reqPerSec: Math.round(v.n / dt * 10) / 10, kbPerSec: Math.round(v.bytes / dt / 1024 * 10) / 10 }]));
      const cpu = {}; let cpuTotal = 0;
      for (const k of new Set([...Object.keys(ca), ...Object.keys(cb)])) { const v = Math.max(0, (cb[k] || 0) - (ca[k] || 0)) / wall * 100; cpu[k] = Math.round(v * 10) / 10; cpuTotal += v; }
      cpu.total = Math.round(cpuTotal * 10) / 10;
      return { phase: name, seconds: Math.round(dt * 10) / 10, states, cpuPercent: cpu, last: { label: last.label, banner: last.banner, map: last.map, mapSrc: last.mapSrc, ops: last.ops, loot: last.loot, markers: last.markers, infos: last.infos, r3: last.r3 },
        scriptMsPerSec: per('ScriptDuration'), layoutMsPerSec: per('LayoutDuration'), styleMsPerSec: per('RecalcStyleDuration'), taskMsPerSec: per('TaskDuration'),
        layoutsPerSec: Math.round(((b.LayoutCount || 0) - (a.LayoutCount || 0)) / dt), longTasks: { count: lt.n, totalMs: Math.round(lt.ms), maxMs: Math.round(lt.max) },
        frameIntervalMs: ft, network: netOut, profile: prof, trace, heapMB: Math.round(b.JSHeapUsedSize / 1048576 * 10) / 10, domNodes: b.Nodes, listeners: b.JSEventListeners,
        screenshot: await shot(name) };
    };
    const phases = [];
    phases.push(await phase('2d'));
    if (opt.three) {
      await cdp.eval(`localStorage.setItem('nr2_pip','1'); document.getElementById('s-3d').click(); 0`);
      const ok = await waitFor('window.gateway3d?.stat()?.mapChunks?.triangles > 0 || !!window.gateway3d?.stat()?.err', 120000);
      if (!ok) errors.push('3D 地形未在 120 秒内装载');
      await cdp.eval(`(() => { const b = document.querySelector('#camseg button[data-cam="chase"]'); b && b.click(); return 0; })()`); await sleep(1500);
      phases.push(await phase('3d-chase-minimap'));
      await cdp.eval(`(() => { const b = document.getElementById('s-pip'); if (b && b.classList.contains('on')) b.click(); return 0; })()`); await sleep(1000);
      phases.push(await phase('3d-chase-no-minimap'));
      await cdp.eval(`(() => { document.querySelector('#camseg button[data-cam="fpv"]').click(); return 0; })()`); await sleep(1500);
      phases.push(await phase('3d-fpv'));
      await cdp.eval(`(() => { const b = document.getElementById('s-pip'); if (b && !b.classList.contains('on')) b.click(); document.getElementById('s-2d').click(); return 0; })()`); await sleep(1500);
    }
    let soak = null;
    if (opt.soak > 0) {
      const series = [], keys = await cdp.eval('Object.keys(MAPS)');
      const end = Date.now() + opt.soak * 60000;
      let i = 0;
      const snap = async label => { await cdp.send('HeapProfiler.collectGarbage'); await sleep(300); const m = await metrics(); const r = await read(); series.push({ i, label, minute: Math.round((Date.now() - t0) / 6000) / 10, processMB: chromeWorkingSetMB(profile), heapMB: Math.round(m.JSHeapUsedSize / 1048576 * 10) / 10, dom: m.Nodes, listeners: m.JSEventListeners, markers: r.markers, infos: r.infos, r3: r.r3 }); };
      await snap('start');
      while (Date.now() < end) {
        const key = keys[i % keys.length];
        await cdp.eval(`(() => { document.getElementById('map-chip').click(); const c = [...document.querySelectorAll('#maps .mcard')].find(x => x.dataset.k === ${JSON.stringify(key)}); c && c.click(); return 0; })()`);
        await sleep(2500);
        if (i % 2 === 1) {
          await cdp.eval(`document.getElementById('s-3d').click(); 0`);
          await waitFor('window.gateway3d?.stat()?.mapChunks?.triangles > 0 || !!window.gateway3d?.stat()?.err', 120000);
          await sleep(3000);
          await cdp.eval(`document.getElementById('s-2d').click(); 0`); await sleep(1500);
        }
        i++;
        await snap(key + (i % 2 === 0 ? ' +3D' : ''));
      }
      const first = series[1] || series[0], last = series[series.length - 1];
      soak = { cycles: i, series, growthFromFirstCycle: { heapMB: Math.round((last.heapMB - first.heapMB) * 10) / 10, dom: last.dom - first.dom, listeners: last.listeners - first.listeners,
        geometries: (last.r3?.geometries ?? 0) - (first.r3?.geometries ?? 0), textures: (last.r3?.textures ?? 0) - (first.r3?.textures ?? 0),
        processMB: last.processMB != null && first.processMB != null ? last.processMB - first.processMB : null } };
    }
    const states = timeline.reduce((m, s) => (m[s.state] = (m[s.state] || 0) + 1, m), {});
    out = { url: opt.url, browser: opt.headful ? 'headful' : 'headless', viewport: opt.phone ? '390x844@2' : opt.width + 'x' + opt.height, gpu: opt.hardware ? 'default' : 'swiftshader', stateSamples: states, phases, soak };
    cdp.ws.close(); browserCdp.ws.close();
  } catch (e) { console.error('检查中断:', e.message); code = 2; }
  finally { chrome.kill(); await sleep(400); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }
  if (code === 0 && errors.length) code = 1;
  console.log(JSON.stringify({ ok: code === 0, ...out, errors, warnings: [...new Set(warnings)].slice(0, 10), failedRequests: [...new Set(failed)].slice(0, 30) }, null, 2));
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
