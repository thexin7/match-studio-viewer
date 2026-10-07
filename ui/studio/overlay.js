import { defaultStudio, deriveHUD, clock, playbackPosition, ProximityEvents } from './model.js?v=1.0.2';
import { StudioClient, request, poll } from './client.js?v=1.0.2';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const part = location.pathname.split('/')[2] || '';
const root = $('overlay'), client = new StudioClient();
let settings = defaultStudio(), snapshot = null, connected = false, maps = [], events = new ProximityEvents();
if (params.get('transparent') === '0') document.body.classList.add('preview');
if (part && $(part)) { document.body.classList.add('single'); $(part).classList.add('selected'); }
if (part && part !== 'minimap') $('minimap').remove();

function layout() {
  const value = ['corner', 'bar', 'vertical', 'map'].includes(params.get('layout')) ? params.get('layout') : settings.layout;
  root.className = `layout-${value}`;
  const vertical = value === 'vertical';
  if (!part) root.style.transform = `scale(${Math.min(innerWidth / (vertical ? 1080 : 1920), innerHeight / (vertical ? 1920 : 1080))})`;
  root.hidden = settings.hidden;
  if ($('minimap')) $('minimap').hidden = !settings.minimap;
  $('threats').hidden = !settings.threats;
  $('ticker').hidden = !settings.ticker;
  $('radar').hidden = settings.prefs.radar3d === 0;
}
window.addEventListener('resize', layout);
function text(id, value) { const el = $(id); if (el.textContent !== String(value)) el.textContent = value; }
function radar(hud) {
  const cv = $('radar').querySelector('canvas'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, 240, 240);
  ctx.strokeStyle = '#ffffff15'; ctx.lineWidth = 1;
  for (const r of [30, 60, 90, 118]) { ctx.beginPath(); ctx.arc(120, 120, r, 0, Math.PI * 2); ctx.stroke(); }
  for (let a = 0; a < 8; a++) { ctx.beginPath(); ctx.moveTo(120, 120); ctx.lineTo(120 + Math.cos(a * Math.PI / 4) * 118, 120 + Math.sin(a * Math.PI / 4) * 118); ctx.stroke(); }
  const range = Number(settings.prefs.radarr || 150);
  text('radar-range', `量程 ${range}m`);
  if (!hud.observer) return;
  ctx.fillStyle = '#2ddd90';ctx.beginPath();ctx.moveTo(120, 112);ctx.lineTo(114, 128);ctx.lineTo(120, 124);ctx.lineTo(126, 128);ctx.closePath();ctx.fill();
  for (const e of hud.opponents) {
    if (e.bearing === null || e.distance > range) continue;
    const angle = e.bearing * Math.PI / 180;
    const r = Math.min(110, e.distance / range * 110), x = 120 + Math.sin(angle) * r, y = 120 - Math.cos(angle) * r;
    const close = e.distance <= settings.prefs.alert;
    ctx.fillStyle = close ? '#ff5264' : '#ffb547';ctx.strokeStyle = '#05080c';ctx.lineWidth = 2;
    ctx.beginPath();ctx.arc(x, y, 5, 0, Math.PI * 2);ctx.fill();ctx.stroke();
    if (close) { ctx.strokeStyle = '#ff2d3f';ctx.beginPath();ctx.arc(x, y, 10, 0, Math.PI * 2);ctx.stroke(); }
  }
}
let threatSignature = '';
function render() {
  layout();
  const hud = deriveHUD(connected ? snapshot : null, settings);
  const observer = hud.observer;
  $('status').classList.toggle('connected', connected);
  text('mode', !connected ? '连接中断' : snapshot?.live_active ? '实时数据' : snapshot?.replay || snapshot?.status === 'replay' || snapshot?.status === 'paused' ? '回放' : '等待数据');
  text('map-name', maps.find(m => m.key === settings.map)?.name || maps.find(m => m.key === 'daba')?.name || '地图待选');
  text('match-time', clock(playbackPosition(snapshot)));
  text('identified', hud.identified);
  text('observer-name', observer ? `${observer.name || observer.hero || '未知干员'} · 观察中` : '等待观察对象');
  text('observer-initial', observer?.hero?.slice(0, 1) || observer?.name?.slice(0, 1) || '—');
  text('observer-meta', observer ? [observer.hero, observer.helmet ? `头 ${observer.helmet}` : '', observer.vest ? `甲 ${observer.vest}` : '', observer.curr_weapon].filter(Boolean).join(' · ') || '装备信息待解析' : '暂无可用坐标');
  const hp = $('observer-hp');
  if (hp.firstChild.nodeValue !== (observer?.health ? String(Math.round(observer.health.current)) : '--')) hp.firstChild.nodeValue = observer?.health ? String(Math.round(observer.health.current)) : '--';
  $('health-bar').style.width = `${observer?.health?.percent || 0}%`;
  const near = hud.nearby[0];
  $('alert').hidden = !near || settings.prefs.alerttoast === 0;
  if (near) { text('alert-title', `${near.team > 0 ? `T${near.team} ` : ''}${near.hero || near.name || '对手'} · 接近`);text('alert-direction', near.direction);text('alert-distance', `${Math.round(near.distance)}m`);$('alert-progress').style.transform = `scaleX(${1 - near.distance / Math.max(1, settings.prefs.alert)})`; }
  text('threat-count', `${settings.prefs.warnd}m 内 ${hud.threats.length}`);text('near-count', `${hud.nearby.length} 接近`);
  const sig = JSON.stringify(hud.threats.slice(0, 4).map(e => [e.key, e.hero, e.name, Math.round(e.distance), e.direction, e.distance <= settings.prefs.alert]));
  if (sig !== threatSignature) {
    threatSignature = sig;
    const rows = hud.threats.slice(0, 4).map(e => {
      const row = document.createElement('div');row.className = `threat-row${e.distance <= settings.prefs.alert ? ' close' : ''}`;
      const bar = document.createElement('i');bar.style.setProperty('--team', e.distance <= settings.prefs.alert ? '#ff5264' : '#ffb547');
      const name = document.createElement('b');name.textContent = `${e.team > 0 ? `T${e.team} ` : ''}${e.hero || e.name || '未知'}`;
      const dir = document.createElement('em');dir.textContent = e.direction;
      const dist = document.createElement('strong');dist.textContent = `${Math.round(e.distance)}m`;row.append(bar, name, dir, dist);return row;
    });
    if (!rows.length) { const empty = document.createElement('p');empty.className = 'empty-threat';empty.textContent = '范围内暂无已识别对手';rows.push(empty); }
    $('threat-list').replaceChildren(...rows);
  }
  radar(hud);
  const history = connected ? events.update(snapshot, settings) : [];
  const signature = history.map(e => e.key).join(',');
  if ($('event-list').dataset.signature !== signature) {
    $('event-list').dataset.signature = signature;
    $('event-list').replaceChildren(...history.map(e => { const item = document.createElement('span'), time = document.createElement('time');time.textContent = clock(e.time);item.append(time, e.text);return item; }));
    if (!history.length) $('event-list').textContent = connected ? '等待距离变化…' : '数据连接中断';
  }
}
request('/api/map').then(data => { maps = data.maps || []; }).catch(() => {});
poll(async () => { try { settings = await client.read(); render(); } catch { /* State polling below owns the connection indicator. */ } }, 500);
poll(async () => {
  try { const value = await request('/api/state');if (!value || !Array.isArray(value.entities)) throw new Error('快照无效');snapshot = value;connected = true; }
  catch { connected = false;events = new ProximityEvents(); }
  render();
}, 100);
