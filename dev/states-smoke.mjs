#!/usr/bin/env node
/**
 * 实时雷达状态验收（测试数据）：驱动 dev/server.mjs 的情景切换，在桌面与手机视口下检查
 * 状态胶囊、横幅、本人位置缺失、空状态、3D 第三/第一跟随、3D 加载失败与重试、新会话自动切图，
 * 每项截图并收集控制台错误与非预期的失败请求。只验证界面表达，不能替代实时对局验收。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Cdp, findChrome, waitJson, sleep } from './smoke.mjs';

const HELP = `用法: node dev/states-smoke.mjs [选项]
  --url <地址>     开发服务器地址（需为本仓库 dev/server.mjs），默认 http://127.0.0.1:5180/
  --out <目录>     截图目录，默认 <临时目录>/ms-states
  --only <名称>    只跑名称包含该文字的检查
  --skip3d         跳过 3D 相关检查
  --hardware       使用默认 GPU 路径（默认强制 SwiftShader）
  --port <端口>    远程调试端口，默认 9351
输出: stdout 打印 JSON；有失败检查、页面异常或非预期失败请求时退出码 1；参数或环境错误退出码 2。`;

function parseArgs(argv) {
  const o = { url: 'http://127.0.0.1:5180/', out: path.join(os.tmpdir(), 'ms-states'), only: '', skip3d: false, hardware: false, port: 9351 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(a + ' 缺少参数值'); return argv[++i]; };
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a === '--url') o.url = v();
    else if (a === '--out') o.out = v();
    else if (a === '--only') o.only = v();
    else if (a === '--skip3d') o.skip3d = true;
    else if (a === '--hardware') o.hardware = true;
    else if (a === '--port') o.port = Number(v());
    else throw new Error('未知参数: ' + a);
  }
  if (!o.url.endsWith('/')) o.url += '/';
  return o;
}

const VIEWPORTS = { desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, phone: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } };
const READ_UI = `(() => {
  const $ = id => document.getElementById(id), b = $('banner');
  return { pill: $('status-pill').dataset.state, label: $('status-pill').innerText.replace(/\\s+/g, ' ').trim(),
    banner: b.hidden ? null : b.dataset.kind, bannerText: b.hidden ? '' : b.innerText.replace(/\\s+/g, ' '),
    fixture: !$('fixture-badge').hidden, selfMissing: document.body.classList.contains('self-missing'),
    mode3d: document.body.classList.contains('mode3d'), map: typeof MAP_INFO !== 'undefined' && MAP_INFO ? MAP_INFO.key : null,
    mapSrc: $('map-src').dataset.src || '', selfFoe: $('self-foe').innerText, stripFoe: $('strip-foe').innerText,
    ops: $('ops-body').innerText.slice(0, 160).replace(/\\s+/g, ' '), observer: $('observer').hidden ? '' : $('observer').innerText.replace(/\\s+/g, ' '),
    card: $('r3-card').hidden ? null : $('r3-card').dataset.state, cardText: $('r3-card').hidden ? '' : $('r3-card').innerText.replace(/\\s+/g, ' '),
    terrain: window.gateway3d?.stat()?.mapChunks?.triangles || 0, err3d: window.gateway3d?.stat()?.err || '' };
})()`;

async function main() {
  let opt;
  try { opt = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); console.error(HELP); return 2; }
  const scen = async q => { const r = await fetch(opt.url + '__dev/scenario?' + q); if (!r.ok) throw new Error('情景切换失败 ' + q + '：HTTP ' + r.status + '（--url 是否指向本仓库 dev/server.mjs？）'); return r.json(); };
  try { await scen('set=live&terrain=1&session=1&map='); } catch (e) { console.error(e.message); return 2; }
  let chromePath; try { chromePath = findChrome(); } catch (e) { console.error(e.message); return 2; }
  fs.mkdirSync(opt.out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-states-profile-'));
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${opt.port}`, `--user-data-dir=${profile}`, '--window-size=1440,900',
    '--no-first-run', '--no-default-browser-check', ...(opt.hardware ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']), '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  const results = [], errors = [], failedRequests = [];
  // 开发服务器没有物品图标；503 只会出现在「连接异常」情景（切走后页面仍可能收到一两次）
  let expected = [/\/favicon\.ico$/, /\/resources\/items\//, /^\/api\/(state|status)$/];
  let code = 0;
  try {
    const page = (await waitJson(`http://127.0.0.1:${opt.port}/json/list`)).find(t => t.type === 'page');
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    cdp.on(msg => {
      if (msg.method === 'Runtime.exceptionThrown') errors.push('异常: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text).split('\n')[0]);
      else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push('console.error: ' + msg.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
      else if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
        const u = new URL(msg.params.response.url); const p = u.pathname;
        if (!expected.some(re => re.test(p))) failedRequests.push(msg.params.response.status + ' ' + p);
      }
    });
    for (const d of ['Page', 'Runtime', 'Network']) await cdp.send(d + '.enable');
    const evalv = expr => cdp.eval(expr);
    const waitFor = async (expr, ms = 15000, step = 200) => { const end = Date.now() + ms; for (;;) { if (await evalv(expr)) return true; if (Date.now() > end) return false; await sleep(step); } };
    const shot = async name => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(opt.out, name + '.png'); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); return f; };
    const open = async (vp, prefs = {}) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', VIEWPORTS[vp]);
      await cdp.send('Page.navigate', { url: opt.url });
      await sleep(600);
      await evalv(`localStorage.clear(); ${Object.entries({ q3d: 'mid', ...prefs }).map(([k, v]) => `localStorage.setItem('nr2_${k}', ${JSON.stringify(String(v))});`).join(' ')} 0`);
      await cdp.send('Page.reload', { ignoreCache: true });
      await waitFor('typeof map !== "undefined" && !!map && document.getElementById("status-pill").dataset.state !== "connecting"', 15000);
      await sleep(800);
    };
    const check = async (name, vp, fn) => {
      if (opt.only && !name.includes(opt.only)) return;
      let pass = false, got = null, note = '';
      try { ({ pass, note } = await fn()); got = await evalv(READ_UI); }
      catch (e) { note = '执行失败：' + e.message; try { got = await evalv(READ_UI); } catch {} }
      const file = await shot(vp + '-' + name).catch(() => '');
      results.push({ name, viewport: vp, pass, note, got, screenshot: file });
    };
    const ui = () => evalv(READ_UI);

    for (const vp of ['desktop', 'phone']) {
      await scen('set=live&terrain=1&session=1&map=');
      await open(vp);
      await check('实时更新', vp, async () => { await sleep(600); const u = await ui(); return { pass: u.pill === 'live' && u.banner === 'fixture' && u.fixture && /本人坐标确认|self/.test(u.mapSrc) , note: u.label }; });
      await check('数据停滞', vp, async () => { await scen('set=stalled'); await sleep(3600); const u = await ui(); return { pass: u.pill === 'stalled' && u.banner === 'stalled', note: u.bannerText }; });
      await check('连接异常', vp, async () => { expected.push(/^\/api\/(state|status)$/); await scen('set=error'); await sleep(2500); const u = await ui(); expected.pop(); return { pass: u.pill === 'error' && u.banner === 'error' && /最近成功/.test(u.bannerText), note: u.bannerText }; });
      await check('非实时数据', vp, async () => { await scen('set=nonlive'); await sleep(1500); const u = await ui(); return { pass: u.pill === 'nonlive' && u.banner === 'nonlive' && /replay/.test(u.bannerText), note: u.bannerText }; });
      await check('本人位置未解析', vp, async () => { await scen('set=noself'); await sleep(1500); const u = await ui(); const txt = vp === 'phone' ? u.stripFoe : u.selfFoe; return { pass: u.pill === 'live' && u.selfMissing && /不可用|未解析/.test(txt), note: txt }; });
      await check('等待对局', vp, async () => { await scen('set=waiting'); await open(vp); const u = await ui(); return { pass: u.pill === 'waiting' && !u.banner?.match(/stalled|error/) && /pref|default/.test(u.mapSrc), note: u.label + ' / ' + u.mapSrc }; });
      // 界面交互截图：分页、弹层、抽屉（实时情景）
      await scen('set=live&session=1&map=');
      await open(vp);
      const clickShot = (name, js, cond) => check(name, vp, async () => { await evalv(js + '; 0'); const ok = await waitFor(cond, 5000); await sleep(400); return { pass: ok, note: '' }; });
      if (vp === 'phone') await clickShot('抽屉半展开', 'document.querySelector(\'#panel-tabs button[data-tab="targets"]\').click()', 'document.body.dataset.sheet === "half" && document.querySelectorAll("#ops-body .op").length > 0');
      await clickShot('物资页', 'document.querySelector(\'#panel-tabs button[data-tab="loot"]\').click()', 'document.querySelectorAll("#loot-body .lr").length > 0');
      await evalv('document.querySelector(\'#panel-tabs button[data-tab="targets"]\').click(); 0');
      if (vp === 'phone') await evalv('setSheet("peek"); 0');
      await clickShot('状态详情', 'document.getElementById("status-pill").click()', '!document.getElementById("pop-status").hidden && /对局数据/.test(document.getElementById("status-kv").innerText)');
      await evalv('closePop(); 0');
      await clickShot('地图选择', 'document.getElementById("map-chip").click()', '!document.getElementById("pop-map").hidden && document.querySelectorAll("#maps .mcard").length === 6');
      await evalv('closePop(); 0');
      await clickShot('图层弹层', 'document.getElementById(innerWidth <= 760 ? "fab-layers" : "btn-layers").click()', '!document.getElementById("pop-layers").hidden');
      await evalv('closePop(); 0');
      await clickShot('设置抽屉', 'document.getElementById("btn-settings").click()', '!document.getElementById("settings").hidden');
      await evalv('closePop(); 0');
      await check('新会话自动切图', vp, async () => { await scen('set=live&session=2&map=az3'); const ok = await waitFor('MAP_INFO && MAP_INFO.key === "az3" && document.getElementById("map-src").dataset.src === "self"', 8000); const u = await ui(); await scen('session=3&map='); return { pass: ok, note: u.map + ' / ' + u.mapSrc }; });
      if (opt.skip3d) continue;
      await scen('set=live&terrain=1&session=1&map=');
      await open(vp, { cam3d: 'chase' });
      await check('3D 第三跟随', vp, async () => { await evalv('document.getElementById("s-3d").click(); 0'); const ok = await waitFor('window.gateway3d?.stat()?.mapChunks?.triangles > 0', 90000, 500); await sleep(2500); const u = await ui(); return { pass: ok && u.mode3d && !u.err3d, note: 'terrain ' + u.terrain }; });
      await check('3D 第一跟随', vp, async () => { await evalv('document.querySelector(\'#camseg button[data-cam="fpv"]\').click(); 0'); await sleep(2500); const u = await ui(); return { pass: /第一跟随/.test(u.observer) && /朝向 实时/.test(u.observer), note: u.observer }; });
      await check('第一跟随·本人位置缺失', vp, async () => { await scen('set=noself'); await waitFor('/不可用/.test(document.getElementById("observer").innerText)', 10000); const u = await ui(); return { pass: /不可用/.test(u.observer), note: u.observer }; });
      await scen('set=live&terrain=0');
      // 前面的 3D 检查已缓存地形；失败用例必须绕过浏览器缓存，服务器的 404 才能生效
      await cdp.send('Network.clearBrowserCache'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      expected.push(/^\/m3d\/.+\.(glb|tpk)$/);
      await open(vp, { cam3d: 'chase' });
      await check('3D 加载失败', vp, async () => { await evalv('document.getElementById("s-3d").click(); 0'); const ok = await waitFor('document.getElementById("r3-card").dataset.state === "fail" && !document.getElementById("r3-card").hidden', 60000, 300); const u = await ui(); return { pass: ok && /重试/.test(u.cardText) && /回到 2D/.test(u.cardText), note: u.cardText }; });
      await check('3D 重试成功', vp, async () => { await scen('terrain=1'); await evalv('document.getElementById("r3-retry").click(); 0'); const ok = await waitFor('window.gateway3d?.stat()?.mapChunks?.triangles > 0 && document.getElementById("r3-card").hidden', 90000, 500); const u = await ui(); return { pass: ok && !u.err3d, note: 'terrain ' + u.terrain }; });
      expected.pop();
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
    }
    cdp.ws.close();
  } catch (e) {
    console.error('验收中断:', e.message); code = 2;
  } finally {
    chrome.kill(); await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    await fetch(opt.url + '__dev/scenario?set=live&terrain=1&session=1&map=').catch(() => {});
  }
  const failed = results.filter(r => !r.pass);
  if (code === 0 && (failed.length || errors.length || failedRequests.length)) code = 1;
  console.log(JSON.stringify({ ok: code === 0, passed: results.length - failed.length, failed: failed.map(r => r.viewport + ':' + r.name), errors, failedRequests,
    results: results.map(r => ({ name: r.name, viewport: r.viewport, pass: r.pass, note: r.note, screenshot: r.screenshot })) }, null, 2));
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
