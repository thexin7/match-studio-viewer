#!/usr/bin/env node
/**
 * 查看器冒烟与性能采样：用无头 Chrome 打开页面，依次进入 2D / 3D 第三跟随 / 3D 第一视角，
 * 每个阶段截图并采样 Performance.getMetrics 的脚本、布局、样式耗时，最后输出 JSON。
 * 页面异常、console.error 记为失败（退出码 1）；资源 404 单独统计，不算失败
 * （本地 dev 环境本来就没有瓦片、物品图标和地形 GLB）。
 *
 * 依赖：Node 18+（内置 fetch / WebSocket 需 Node 22+）、本机 Chrome 或 Edge。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HELP = `用法: node dev/smoke.mjs [选项]

选项:
  --url <地址>        被测页面，默认 http://127.0.0.1:5173/
  --out <目录>        截图输出目录，默认 <系统临时目录>/ms-smoke
  --chrome <路径>     Chrome / Edge 可执行文件，默认自动查找
  --seconds <秒>      每个阶段的采样时长，默认 6
  --size <宽x高>      视口尺寸，默认 1600x900
  --port <端口>       远程调试端口，默认 9333
  --map <key>        检查指定地图（通过页面地图卡片切换）
  --quality <档位>   auto / perf / mid / high，默认 auto
  -h, --help          显示帮助

输出: stdout 打印 JSON（各阶段每秒脚本/布局/样式耗时、帧率、错误列表）。
退出码: 0 = 无页面错误；1 = 有页面异常或 console.error；2 = 参数或环境错误。`;

function parseArgs(argv) {
    const opt = { url: 'http://127.0.0.1:5173/', out: path.join(os.tmpdir(), 'ms-smoke'), chrome: '',
        seconds: 6, width: 1600, height: 900, port: 9333, map: '', quality: 'auto' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i], v = () => {
            if (i + 1 >= argv.length) throw new Error(`${a} 缺少参数值`);
            return argv[++i];
        };
        if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
        else if (a === '--url') opt.url = v();
        else if (a === '--out') opt.out = v();
        else if (a === '--chrome') opt.chrome = v();
        else if (a === '--seconds') opt.seconds = Number(v());
        else if (a === '--port') opt.port = Number(v());
        else if (a === '--map') opt.map = v();
        else if (a === '--quality') opt.quality = v();
        else if (a === '--size') {
            const m = /^(\d+)x(\d+)$/.exec(v());
            if (!m) throw new Error('--size 格式应为 宽x高');
            opt.width = Number(m[1]); opt.height = Number(m[2]);
        } else throw new Error(`未知参数: ${a}`);
    }
    if (!(opt.seconds > 0)) throw new Error('--seconds 必须为正数');
    if (!['auto', 'perf', 'mid', 'high'].includes(opt.quality)) throw new Error('无效画质档位');
    return opt;
}

function findChrome(explicit) {
    const candidates = explicit ? [explicit] : [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
    const hit = candidates.find(p => fs.existsSync(p));
    if (!hit) throw new Error('找不到 Chrome / Edge，请用 --chrome 指定');
    return hit;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitJson(url, tries = 50) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(url); if (r.ok) return await r.json(); } catch { /* 浏览器还没起来 */ }
        await sleep(200);
    }
    throw new Error(`连接调试端口超时: ${url}`);
}

class Cdp {
    constructor(ws) {
        this.ws = ws; this.seq = 0; this.pending = new Map(); this.handlers = [];
        ws.addEventListener('message', ev => {
            const msg = JSON.parse(ev.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
            } else if (msg.method) for (const h of this.handlers) h(msg);
        });
    }
    static async connect(url) {
        const ws = new WebSocket(url);
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
        return new Cdp(ws);
    }
    send(method, params = {}) {
        const id = ++this.seq;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }
    on(fn) { this.handlers.push(fn); }
    async eval(expression) {
        const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error('页面求值失败: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
        return r.result.value;
    }
}

async function metrics(cdp) {
    const { metrics: list } = await cdp.send('Performance.getMetrics');
    return Object.fromEntries(list.map(m => [m.name, m.value]));
}

async function waitForTerrain(cdp) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        const state = await cdp.eval('window.gateway3d?.stat() || null');
        if (state?.err) throw new Error(state.err);
        if (state?.mapChunks?.triangles > 0) return;
        await sleep(250);
    }
    throw new Error('3D 地形未在 60 秒内完成装载');
}

// 采样一个阶段：每秒耗时（毫秒）= 区间内累计耗时差 / 区间秒数
async function sample(cdp, name, seconds, opt) {
    await cdp.eval('window.__smokeFrames = 0; if (!window.__smokeFrameLoop) { window.__smokeFrameLoop = true; requestAnimationFrame(function f(){ window.__smokeFrames++; requestAnimationFrame(f); }); } 0');
    const a = await metrics(cdp);
    await sleep(seconds * 1000);
    const b = await metrics(cdp);
    const frames = await cdp.eval('window.__smokeFrames');
    const dt = (b.Timestamp - a.Timestamp) || seconds;
    const per = k => Math.round(((b[k] || 0) - (a[k] || 0)) / dt * 1000 * 10) / 10;
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(opt.out, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return { phase: name, scriptMsPerSec: per('ScriptDuration'), layoutMsPerSec: per('LayoutDuration'),
        styleMsPerSec: per('RecalcStyleDuration'), taskMsPerSec: per('TaskDuration'),
        layoutCountPerSec: Math.round(((b.LayoutCount || 0) - (a.LayoutCount || 0)) / dt),
        domNodes: b.Nodes, rafPerSec: Math.round(frames / dt), screenshot: file };
}

async function main() {
    let opt;
    try { opt = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); console.error(HELP); return 2; }
    let chromePath;
    try { chromePath = findChrome(opt.chrome); } catch (e) { console.error(e.message); return 2; }
    fs.mkdirSync(opt.out, { recursive: true });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-smoke-profile-'));
    const chrome = spawn(chromePath, [
        '--headless=new', `--remote-debugging-port=${opt.port}`, `--user-data-dir=${profile}`,
        `--window-size=${opt.width},${opt.height}`, '--no-first-run', '--no-default-browser-check',
        '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', 'about:blank',
    ], { stdio: 'ignore' });
    const errors = [], warnings = [], notFound = new Set();
    let code = 0;
    try {
        const targets = await waitJson(`http://127.0.0.1:${opt.port}/json/list`);
        const page = targets.find(t => t.type === 'page');
        if (!page) throw new Error('没有可用的页面 target');
        const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
        cdp.on(msg => {
            if (msg.method === 'Runtime.exceptionThrown') {
                const d = msg.params.exceptionDetails;
                errors.push('异常: ' + (d.exception?.description || d.text).split('\n')[0]);
            } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
                errors.push('console.error: ' + msg.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
            } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'warning' && warnings.length < 50) {
                warnings.push(msg.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
            } else if (msg.method === 'Network.responseReceived' && msg.params.response.status === 404) {
                notFound.add(new URL(msg.params.response.url).pathname.split('/').slice(0, 3).join('/'));
            }
        });
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Network.enable');
        await cdp.send('Performance.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: opt.width, height: opt.height, deviceScaleFactor: 1, mobile: false });
        await cdp.send('Page.navigate', { url: opt.url });
        await sleep(1500);
        await cdp.eval(`localStorage.clear(); localStorage.setItem('nr2_q3d', ${JSON.stringify(opt.quality)}); 0`);
        await cdp.send('Page.reload', { ignoreCache: true });
        await sleep(4000);
        if (opt.map) {
            const selected = await cdp.eval(`(() => {
                const card = [...document.querySelectorAll('#maps .mcard')].find(c => c.dataset.k === ${JSON.stringify(opt.map)});
                if (!card) return false;
                card.click(); return MAP_INFO.key === ${JSON.stringify(opt.map)};
            })()`);
            if (!selected) throw new Error('地图卡片不存在或切换失败：' + opt.map);
            await sleep(500);
        }
        const phases = [];
        phases.push(await sample(cdp, '2d', opt.seconds, opt));
        const has3d = await cdp.eval('typeof NO3D !== "undefined" && !NO3D');
        if (has3d) {
            await cdp.eval(`document.getElementById('s-3d').click(); 0`);
            await waitForTerrain(cdp);
            if (opt.map && await cdp.eval('window.gateway3d.stat().mapTexture.key') !== opt.map) throw new Error('3D 地形与所选地图不一致');
            phases.push(await sample(cdp, '3d-chase', opt.seconds, opt));
            await cdp.eval(`document.querySelector('#camseg button[data-cam="fpv"]')?.click(); 0`);
            await sleep(2500);
            phases.push(await sample(cdp, '3d-fpv', opt.seconds, opt));
        }
        const r3 = await cdp.eval('JSON.stringify(window.gateway3d ? window.gateway3d.stat() : null)');
        code = errors.length ? 1 : 0;
        console.log(JSON.stringify({ ok: code === 0, url: opt.url, map: opt.map, quality: opt.quality, phases, skipped3d: !has3d, render3d: JSON.parse(r3 || 'null'),
            errors, warnings, notFound: [...notFound].sort() }, null, 2));
        cdp.ws.close();
    } catch (e) {
        console.error('冒烟失败:', e.message);
        code = 2;
    } finally {
        chrome.kill();
        await sleep(500);
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome 可能还占着文件 */ }
    }
    return code;
}

process.exit(await main());
