#!/usr/bin/env node
// Browser integration against any host implementing the public /api/* contract.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cdp, findChrome, waitJson, sleep } from './smoke.mjs';
import { deriveHUD, defaultStudio } from '../ui/studio/model.js';

const url = process.argv[2] || 'http://127.0.0.1:5174';
const out = process.argv[3] || path.join(os.tmpdir(), 'ms-studio-smoke');
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-studio-browser-'));
const port = 9341;
const errors = [], failedResources = [];
const chrome = spawn(findChrome(), ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
let cdp, original;
async function get(route) { const response = await fetch(url + route);assert.ok(response.ok, `${route}: ${response.status}`);return response.json(); }
async function patch(value) {
  const state = await get('/api/studio');
  const response = await fetch(url + '/api/studio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...value, revision: state.revision }) });
  assert.ok(response.ok, `control: ${response.status} ${await response.clone().text()}`);return response.json();
}
async function until(expression, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await cdp.eval(expression)) return;await sleep(100); }
  throw new Error(`Timed out: ${expression}`);
}
async function shot(name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(data, 'base64'));
}
async function navigate(route, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: url + route });
}
try {
  original = await get('/api/studio');
  await patch({ view: '2d', layout: 'corner', hidden: false, observer: '__self', minimap: true, threats: true });
  const targets = await waitJson(`http://127.0.0.1:${port}/json/list`);
  cdp = await Cdp.connect(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  cdp.on(msg => {
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map(a => a.value ?? a.description).join(' '));
    if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400 && !msg.params.response.url.endsWith('/favicon.ico')) failedResources.push(msg.params.response.url);
  });
  await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await navigate('/studio', 1440, 1130);
  await until("document.querySelector('#people .person') && document.querySelector('#connection')?.textContent === '数据已连接'");
  assert.equal(await cdp.eval("document.documentElement.scrollWidth <= innerWidth"), true, 'desktop overflow');
  assert.equal(await cdp.eval("document.querySelector('.switch').getBoundingClientRect().width"), 36, 'toggle geometry');
  assert.ok(await cdp.eval("[...document.querySelectorAll('#deck img')].every(img => img.complete && img.naturalWidth === 26 && Math.round(img.getBoundingClientRect().width) === 26)"), 'Figma assets');
  const target = await cdp.eval("document.querySelector('#people .person:not([data-key=\"__self\"])').dataset.key");
  await cdp.eval(`document.querySelector('#people .person[data-key="${target}"]').click(); 0`);
  await until(`document.querySelector('#people .person[data-key="${target}"]')?.getAttribute('aria-pressed') === 'true'`);
  assert.equal((await get('/api/studio')).observer, target);
  const nearest = deriveHUD(await get('/api/state'), { ...defaultStudio(), observer: target, prefs: { alert: 300, warnd: 1000 } }).threats[0];
  assert.ok(nearest && nearest.distance < 290, 'capture must include a nearby opponent');
  const threshold = Math.min(300, Math.ceil(nearest.distance / 10) * 10 + 10);
  await cdp.eval(`(() => { const input = document.getElementById('pref-alert'); input.value = '${threshold}'; input.dispatchEvent(new Event('input')); input.dispatchEvent(new Event('change')); })()`);
  await until(`document.querySelector('#preview-viewer').contentWindow.matchStudio?.read().prefs.alert === ${threshold}`);
  assert.equal((await get('/api/studio')).prefs.alert, threshold);
  await until(`document.querySelector('#preview-overlay').contentDocument.querySelector('#observer-name').textContent.includes('观察中')`);
  await until("document.querySelector('#preview-overlay').contentDocument.getElementById('alert').hidden === false");
  await cdp.eval("document.querySelector('[data-layout=bar]').click(); 0");
  await until("document.querySelector('#preview-overlay').contentDocument.querySelector('#overlay').classList.contains('layout-bar')");
  await cdp.eval("document.querySelector('[data-layout=corner]').click(); 0");
  await until("document.querySelector('#preview-overlay').contentDocument.querySelector('#overlay').classList.contains('layout-corner')");
  assert.ok(!await cdp.eval("document.getElementById('replay-time').textContent.includes('--')"), 'real replay units');
  await until("document.querySelector('#preview-viewer').contentDocument.body.classList.contains('studio-preview')");
  await shot('console-desktop');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  assert.equal(await cdp.eval('document.documentElement.scrollWidth <= innerWidth'), true, 'mobile overflow');
  await shot('console-mobile');
  await navigate('/overlay?transparent=0', 1920, 1080);
  await until("document.querySelector('#observer-name')?.textContent.includes('观察中')");
  await until("document.querySelector('#minimap iframe').contentDocument.body.classList.contains('studio-map')");
  await until("document.querySelector('#minimap iframe').contentWindow.matchStudio?.read().prefs.ai === 0");
  await until("document.querySelector('#alert:not([hidden]) img')?.naturalWidth === 44");
  await shot('overlay-corner');
  for (const layout of ['bar', 'map']) {
    await patch({ layout });
    await until(`document.querySelector('#overlay').classList.contains('layout-${layout}')`);
    if (layout === 'bar') assert.ok(await cdp.eval("document.getElementById('observer').getBoundingClientRect().bottom <= document.getElementById('ticker').getBoundingClientRect().top"), 'observer health must not overlap the ticker');
    await shot(`overlay-${layout}`);
  }
  await patch({ hidden: true });await until("document.getElementById('overlay').hidden");
  await patch({ hidden: false, layout: 'vertical' });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1080, height: 1920, deviceScaleFactor: 1, mobile: false });
  await until("document.querySelector('#overlay').classList.contains('layout-vertical')");await shot('overlay-vertical');
  await navigate('/overlay/observer?transparent=1', 560, 139);
  await until("document.querySelector('#observer-name')?.textContent.includes('观察中')");
  assert.equal(await cdp.eval("getComputedStyle(document.body).backgroundColor"), 'rgba(0, 0, 0, 0)', 'transparent background');
  const visible = await cdp.eval("[...document.querySelectorAll('#overlay>section')].filter(e=>getComputedStyle(e).display!=='none').map(e=>e.id)");
  assert.deepEqual(visible, ['observer']);
  await shot('overlay-component');
  assert.deepEqual(errors, [], 'browser errors');
  assert.deepEqual(failedResources.filter(resource => new URL(resource).pathname.startsWith('/ui/')), [], 'UI resource failures');
  const result = { ok: true, host: url, checks: ['desktop', '390px mobile', 'asset geometry', 'observer selection', 'setting and alert sync', 'four layouts', 'replay units', 'hide/show', 'portrait', 'transparent component'], errors, failedResources: [...new Set(failedResources)], screenshots: out };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.stack);console.error(JSON.stringify({ errors, failedResources: [...new Set(failedResources)] }));process.exitCode = 1;
} finally {
  if (original) { const { revision, has3d, ...restore } = original;await patch(restore).catch(() => {}); }
  cdp?.ws.close();chrome.kill();await sleep(500);
  // The directory was created by this process under the OS temporary root.
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
