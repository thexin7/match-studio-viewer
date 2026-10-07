import { defaultStudio, deriveHUD, characters, clock, replayInfo, ProximityEvents } from './model.js?v=1.0.2';
import { StudioClient, request, poll } from './client.js?v=1.0.2';
import { groups } from './settings.js?v=1.0.3';

const $ = id => document.getElementById(id), client = new StudioClient();
let settings = defaultStudio(), snapshot = null, status = null, connected = false, busy = false, seeking = false;
let noticeTimer, audioContext, lastBeep = '', has3d = false;
const events = new ProximityEvents();
const deck = [
  ['fpv', '第一视角', 'eye', 'F1'], ['chase', '第三视角', 'target', 'F2'], ['orbit', '自由视角', 'cube', 'F3'], ['top', '俯视', 'map', 'F4'], ['view', '2D / 3D', 'layers', 'V'],
  ['prev', '上一个观察', 'prev', '['], ['next', '下一个观察', 'next', ']'], ['nearest', '最近对手', 'target', 'N'], ['alert', '接近警报', 'alert', 'A'], ['mute', '提示音', 'vol', 'S'],
  ['minimap', '小地图', 'pip', 'M'], ['threats', '对手列表', 'list', 'T'], ['layout', '叠加布局', 'layers', 'L'], ['hidden', '显示叠加层', 'max', ''], ['viewer', '打开查看器', 'map', ''],
];
for (const [action, label, icon, key] of deck) {
  const button = document.createElement('button');button.type = 'button';button.dataset.action = action;
  const img = document.createElement('img');img.src = `/ui/studio/assets/${icon}.svg`;img.alt = '';
  const title = document.createElement('span');title.textContent = label;
  const hotkey = document.createElement('kbd');hotkey.textContent = key;
  button.append(img, title, hotkey);button.addEventListener('click', () => perform(action));$('deck').append(button);
}
function notify(message, error = false) {
  $('notice').textContent = message;$('notice').classList.toggle('error', error);$('notice').hidden = false;
  clearTimeout(noticeTimer);noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 6000 : 3000);
}
async function change(patch) {
  busy = true;sync();
  try { settings = await client.update(patch);sync(); }
  catch (error) { notify(error.message, true); }
  finally { busy = false;sync(); }
}
async function perform(action) {
  if (busy) return;
  const people = characters(snapshot), hud = deriveHUD(snapshot, settings);
  if (['fpv', 'chase', 'orbit', 'top', 'view'].includes(action) && !has3d) { notify('当前服务没有可用 3D 地形');return; }
  if (['fpv', 'chase', 'orbit', 'top'].includes(action)) return change({ view: '3d', camera: action });
  if (action === 'view') return change({ view: settings.view === '3d' ? '2d' : '3d' });
  if (action === 'prev' || action === 'next') {
    if (!people.length) return;
    const i = people.findIndex(e => e.key === settings.observer);
    return change({ observer: people[(Math.max(0, i) + (action === 'next' ? 1 : people.length - 1)) % people.length].key });
  }
  if (action === 'nearest') { if (!hud.opponents.length) return notify('没有已识别对手');return change({ observer: hud.opponents[0].key }); }
  if (action === 'alert') return change({ prefs: { alerttoast: settings.prefs.alerttoast ? 0 : 1 } });
  if (action === 'mute') {
    if (settings.muted) {
      try { audioContext ||= new AudioContext();await audioContext.resume(); } catch { notify('浏览器无法启用提示音', true);return; }
    }
    return change({ muted: !settings.muted });
  }
  if (['minimap', 'threats', 'hidden'].includes(action)) return change({ [action]: !settings[action] });
  if (action === 'layout') { const layouts = ['corner', 'bar', 'vertical', 'map'];return change({ layout: layouts[(layouts.indexOf(settings.layout) + 1) % layouts.length] }); }
  if (action === 'viewer') window.open('/', '_blank', 'noopener');
}
function beep() {
  if (settings.muted || !audioContext || audioContext.state !== 'running') return;
  const osc = audioContext.createOscillator(), gain = audioContext.createGain();osc.connect(gain);gain.connect(audioContext.destination);
  osc.frequency.value = 660;gain.gain.setValueAtTime(.08, audioContext.currentTime);gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + .16);osc.start();osc.stop(audioContext.currentTime + .17);
}
const controlDefs = new Map();
for (const [index, group] of groups.entries()) {
  const details = document.createElement('details');details.open = index === 0;
  const summary = document.createElement('summary');summary.textContent = group.name;
  const count = document.createElement('span');count.textContent = `${group.items.length} 项`;summary.append(count);
  const hint = document.createElement('p');hint.textContent = group.hint;details.append(summary, hint);
  for (const item of group.items) {
    const [key, title, type, initial, min, max, step, unit] = item;controlDefs.set(key, item);
    const row = document.createElement('div');row.className = 'setting';
    const label = document.createElement('label');label.htmlFor = `pref-${key}`;label.textContent = title;row.append(label);
    let input;
    if (type === 'toggle') {
      const wrapper = document.createElement('label');wrapper.className = 'switch';
      input = document.createElement('input');input.type = 'checkbox';input.checked = Boolean(initial);input.setAttribute('aria-label', title);
      wrapper.append(input, document.createElement('span'));row.append(wrapper);
    } else if (type === 'select') {
      input = document.createElement('select');
      for (const [value, caption] of min) { const option = document.createElement('option');option.value = value;option.textContent = caption;input.append(option); }
      input.value = initial;row.append(input);
    } else {
      input = document.createElement('input');Object.assign(input, { type: 'range', min, max, step, value: initial });
      const out = document.createElement('output');out.htmlFor = `pref-${key}`;out.textContent = `${initial}${unit}`;out.id = `value-${key}`;
      input.addEventListener('input', () => { out.textContent = `${input.value}${unit}`; });row.append(input, out);
    }
    input.id = `pref-${key}`;
    input.addEventListener('change', () => {
      const value=type === 'toggle' ? Number(input.checked) : typeof initial === 'number' ? Number(input.value) : input.value;
      const prefs={ [key]:value };
      if(key==='q3d'&&(value==='perf'||value==='high'))Object.assign(prefs,{fpscap:value==='perf'?30:60,shadow3d:value==='perf'?'off':'auto'});
      change({prefs});
    });
    details.append(row);
  }
  $('settings').append(details);
}
let peopleSignature = '';
function renderPeople(hud) {
  const sig = JSON.stringify([settings.observer, hud.people.map(e => [e.key, e.name, e.hero, e.team])]);
  if (sig === peopleSignature) return;peopleSignature = sig;
  $('people-count').textContent = `${hud.people.length} 个已识别单位`;
  const rows = hud.people.map(e => {
    const button = document.createElement('button');button.className = `person${settings.observer === e.key ? ' on' : ''}`;button.dataset.key = e.key;button.setAttribute('aria-pressed', String(settings.observer === e.key));
    const hostile=hud.opponents.some(op=>op.key===e.key);
    const friendly=e.key===hud.observer?.key||(hud.observer?.team>0&&e.team===hud.observer.team)||(hud.observer?.kind==='self'&&e.kind==='mate');
    button.style.setProperty('--faction',hostile?'#ff4058':friendly?'#37e08a':'#8c96a8');
    const initial = document.createElement('span');initial.className = 'initial';initial.textContent = (e.hero || e.name || '？').slice(0, 1);
    const identity = document.createElement('span');identity.className = 'identity';
    const name = document.createElement('b');name.textContent = e.name || e.hero || '未知干员';
    const meta = document.createElement('small');meta.textContent = [e.kind === 'self' ? '自身' : e.team > 0 ? `第 ${e.team} 队` : '队伍未知', e.hero].filter(Boolean).join(' · ');identity.append(name, meta);button.append(initial, identity);
    if (settings.observer === e.key) { const tag = document.createElement('span');tag.className = 'tag';tag.textContent = '观察中';button.append(tag); }
    button.addEventListener('click', () => change({ observer: e.key }));return button;
  });
  if (!rows.length) { const empty = document.createElement('p');empty.className = 'empty';empty.textContent = '暂无可用坐标，等待比赛数据…';rows.push(empty); }
  $('people').replaceChildren(...rows);
}
function sync() {
  $('connection').textContent = connected ? '数据已连接' : '数据未连接';$('connection-dot').classList.toggle('on', connected);
  $('source-mode').textContent = snapshot?.live_active ? '实时数据' : status?.replay ? '回放模式' : '等待比赛';
  const hud = deriveHUD(connected ? snapshot : null, settings);renderPeople(hud);
  for (const button of $('deck').children) {
    const action = button.dataset.action;
    const on = ['fpv', 'chase', 'orbit', 'top'].includes(action) ? settings.view === '3d' && settings.camera === action : action === 'alert' ? !!settings.prefs.alerttoast : action === 'mute' ? !settings.muted : action === 'hidden' ? !settings.hidden : action === 'view' ? settings.view === '3d' : ['minimap', 'threats'].includes(action) ? settings[action] : false;
    button.classList.toggle('on', on);button.setAttribute('aria-pressed', String(on));
    const needs3d = ['fpv', 'chase', 'orbit', 'top', 'view'].includes(action);
    button.disabled = busy || (needs3d && !has3d) || (['prev', 'next', 'nearest'].includes(action) && !hud.people.length);
    button.title = needs3d && !has3d ? '当前服务没有可用 3D 地形' : '';
  }
  for (const button of $('layouts').children) button.setAttribute('aria-pressed', String(button.dataset.layout === settings.layout));
  if (document.activeElement !== $('map-select') && settings.map) $('map-select').value = settings.map;
  for (const [key, item] of controlDefs) {
    const el = $(`pref-${key}`), value = settings.prefs[key] ?? item[3];
    if (document.activeElement === el) continue;
    if (item[2] === 'toggle') el.checked = !!value;else el.value = value;
    if ($(`value-${key}`)) $(`value-${key}`).textContent = `${value}${item[7]}`;
  }
  const vertical = settings.layout === 'vertical';
  $('source-size').textContent = `OBS → 来源 → 浏览器，宽 ${vertical ? 1080 : 1920} 高 ${vertical ? 1920 : 1080}`;
  // Omitting layout keeps OBS sources synchronized with the console layout selection.
  $('source-url').value = `${location.origin}/overlay?transparent=1`;
  $('open-overlay').href = '/overlay?transparent=0';
  resizePreview();
  const replay = replayInfo(status);
  $('replay-panel').hidden = !replay;
  if (replay) {
    $('replay-play').textContent = replay.paused ? '播放' : '暂停';$('replay-time').textContent = `${clock(replay.position)} / ${clock(replay.duration)}`;
    if (!seeking && document.activeElement !== $('replay-seek')) $('replay-seek').value = replay.duration > 0 ? Math.round(replay.position / replay.duration * 1000) : 0;
    if (document.activeElement !== $('replay-speed')) $('replay-speed').value = replay.speed;
  }
}
function resizePreview() {
  const stage = document.querySelector('.preview-stage'), box = document.querySelector('.preview-wrap');
  const vertical = settings.layout === 'vertical', width = vertical ? 1080 : 1920, height = vertical ? 1920 : 1080;
  // A portrait source is fitted inside the preview; its broadcast canvas stays 1080×1920.
  const scale = Math.min(box.clientWidth / width, (box.clientHeight - 30) / height);
  stage.style.width = `${width}px`;stage.style.height = `${height}px`;stage.style.left = `${(box.clientWidth - width * scale) / 2}px`;stage.style.transform = `scale(${scale})`;
}
new ResizeObserver(resizePreview).observe(document.querySelector('.preview-wrap'));
document.querySelectorAll('[data-layout]').forEach(button => button.addEventListener('click', () => change({ layout: button.dataset.layout })));
$('map-select').addEventListener('change', () => change({ map: $('map-select').value }));
$('preview-toggle').addEventListener('click', () => { const on = document.querySelector('.preview-wrap').classList.toggle('checker');$('preview-toggle').setAttribute('aria-pressed', String(on)); });
async function copy(value) {
  try { await navigator.clipboard.writeText(value);notify('地址已复制'); }
  catch { $('source-url').value = value;$('source-url').focus();$('source-url').select();notify('请按 Ctrl+C 复制选中的地址'); }
}
$('copy-source').addEventListener('click', () => copy(`${location.origin}/overlay?transparent=1`));
$('copy-part').addEventListener('click', () => copy(`${location.origin}/overlay/${$('part-select').value}?transparent=1`));
async function replay(query) {
  for (const el of $('replay-panel').querySelectorAll('button,input,select')) el.disabled = true;
  try { await request(`/api/ctrl?${query}`);status = await request('/api/status');sync(); }
  catch (error) { notify(error.message, true); }
  finally { for (const el of $('replay-panel').querySelectorAll('button,input,select')) el.disabled = false; }
}
$('replay-play').addEventListener('click', () => replay(`pause=${status?.replay?.paused ? 0 : 1}`));
$('replay-speed').addEventListener('change', () => replay(`speed=${$('replay-speed').value}`));
$('replay-seek').addEventListener('pointerdown', () => { seeking = true; });
$('replay-seek').addEventListener('pointercancel', () => { seeking = false; });
$('replay-seek').addEventListener('change', () => { seeking = false;replay(`seek=${$('replay-seek').value}`); });
document.addEventListener('keydown', event => {
  if (event.repeat || event.isComposing || event.target.closest('input,select,textarea,[contenteditable=true]')) return;
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyO') { event.preventDefault();perform('hidden');return; }
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  const actions = { F1: 'fpv', F2: 'chase', F3: 'orbit', F4: 'top', KeyV: 'view', BracketLeft: 'prev', BracketRight: 'next', KeyN: 'nearest', KeyA: 'alert', KeyS: 'mute', KeyM: 'minimap', KeyT: 'threats', KeyL: 'layout' };
  if (actions[event.code]) { event.preventDefault();perform(actions[event.code]); }
});
request('/api/map').then(data => {
  $('map-select').replaceChildren(...(data.maps || []).map(m => { const option = document.createElement('option');option.value = m.key;option.textContent = m.name;return option; }));
}).catch(() => notify('地图目录加载失败', true));
poll(async () => {
  try { settings = await client.read();has3d = settings.has3d !== false; }
  catch { has3d = false; }
  sync();
}, 500);
poll(async () => {
  try { snapshot = await request('/api/state');if (!Array.isArray(snapshot?.entities)) throw new Error('快照无效');connected = true; }
  catch { connected = false;snapshot = null; }
  sync();
  const history = events.update(snapshot, settings), signature = history.map(e => e.key).join(',');
  if ($('events').dataset.signature !== signature) {
    $('events').dataset.signature = signature;
    $('events').replaceChildren(...history.slice(0, 4).map(e => { const row = document.createElement('p'), time = document.createElement('time');time.textContent = clock(e.time);row.append(time, e.text);return row; }));
    if (!history.length) { const p = document.createElement('p');p.className = 'empty';p.textContent = '等待距离变化…';$('events').append(p); }
    if (history[0] && history[0].key !== lastBeep) { lastBeep = history[0].key;beep(); }
  }
}, 250);
poll(async () => { try { status = await request('/api/status');sync(); } catch { status = null;sync(); } }, 1000);
