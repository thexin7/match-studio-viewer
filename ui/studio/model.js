export function defaultStudio() {
  return { revision: 0, layout: 'corner', hidden: false, observer: '__self', view: '2d', camera: 'chase', map: '',
    minimap: true, threats: true, ticker: true, muted: true,
    prefs: { alert: 80, warnd: 150, radarr: 150, alerttoast: 1 } };
}

export const position = value => Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(Number.isFinite);
export function health(hp) {
  const total = hp?.total;
  return Array.isArray(total) && total.length === 2 && total.every(Number.isFinite) && total[1] > 0
    ? { current: Math.max(0, total[0]), max: total[1], percent: Math.max(0, Math.min(100, total[0] / total[1] * 100)) } : null;
}
export function characters(snapshot) {
  if (!snapshot) return [];
  const list = (Array.isArray(snapshot.entities) ? snapshot.entities : []).filter(e =>
    ['player', 'mate', 'self'].includes(e.kind) && !e.dead && !e.out_of_range && position(e.world));
  if (position(snapshot.self) && !snapshot.self_life?.dead) list.unshift({ key: '__self', kind: 'self', world: snapshot.self,
    name: snapshot.self_name || '自身', hero: snapshot.self_hero || '', hp: snapshot.self_hp,
    team: snapshot.self_team ?? snapshot.team, yaw: snapshot.self_yaw,
    curr_weapon: snapshot.self_weapon || '' });
  return list;
}
export function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}
export function playbackPosition(snapshot) {
  if (Number.isFinite(snapshot?.replay?.position)) return snapshot.replay.position;
  const c = snapshot?.cursor;
  if (c && Number.isFinite(c.seq) && Number.isFinite(c.lo) && c.hi > c.lo && Number.isFinite(c.t_lo) && Number.isFinite(c.t_hi)) {
    return Math.max(0, (c.seq - c.lo) / (c.hi - c.lo) * (c.t_hi - c.t_lo));
  }
  return null;
}
export function replayInfo(status) {
  const replay = status?.replay;
  if (!replay) return null;
  return { ...replay, position: Number.isFinite(replay.position) ? replay.position : Number.isFinite(replay.positionMs) ? replay.positionMs / 1000 : null,
    duration: Number.isFinite(replay.duration) ? replay.duration : Number.isFinite(replay.durationMs) ? replay.durationMs / 1000 : null };
}
export function deriveHUD(snapshot, settings) {
  const people = characters(snapshot);
  const observer = people.find(e => e.key === settings.observer);
  if (!observer) return { observer: null, people, opponents: [], threats: [], nearby: [], identified: people.length };
  const opponents = people.filter(e => {
    if (e.key === observer.key) return false;
    if (observer.team > 0 && e.team > 0) return String(observer.team) !== String(e.team);
    if (observer.kind === 'self') return e.kind === 'player';
    // Without a team identity we cannot classify the selected player's allies.
    return false;
  }).map(e => {
    const dx = e.world[0] - observer.world[0], dy = e.world[1] - observer.world[1];
    const distance = Math.hypot(dx, dy) / 100;
    const bearing = Number.isFinite(observer.yaw) ? ((Math.atan2(dy, dx) * 180 / Math.PI - observer.yaw + 540) % 360) - 180 : null;
    const directions = ['前', '右前', '右', '右后', '后', '左后', '左', '左前'];
    return { ...e, distance, bearing, direction: bearing === null ? '方位未知' : directions[(Math.round(bearing / 45) + 8) % 8] };
  }).sort((a, b) => a.distance - b.distance);
  return { observer: { ...observer, health: health(observer.hp) }, people, opponents,
    threats: opponents.filter(e => e.distance <= Number(settings.prefs.warnd ?? 150)),
    nearby: opponents.filter(e => e.distance <= Number(settings.prefs.alert ?? 80)), identified: people.length };
}

export class ProximityEvents {
  previous = null;
  context = '';
  time = null;
  at = null;
  events = [];
  update(snapshot, settings, now = Date.now()) {
    const context = JSON.stringify([snapshot?.flow, snapshot?.session, snapshot?.meta?.run, settings.observer, settings.prefs.alert, settings.prefs.warnd]);
    const time = playbackPosition(snapshot);
    const hud = deriveHUD(snapshot, settings);
    const discontinuity = time !== null && this.time !== null && (time < this.time - 1 || time - this.time > (now - this.at) / 1000 * (snapshot?.replay?.speed || 1) + 2);
    if (context !== this.context || discontinuity || snapshot?.replay?.seeking || !hud.observer) {
      this.previous = null; this.events = [];
    }
    const next = new Set(hud.nearby.map(e => e.key));
    if (this.previous) for (const e of hud.nearby) if (!this.previous.has(e.key)) {
      this.events.unshift({ key: `${now}:${e.key}`, at: now, time, text: `${e.hero || e.name || '未知干员'} 进入 ${settings.prefs.alert}m · ${e.direction}` });
    }
    this.previous = snapshot?.replay?.seeking ? null : next; this.context = context; this.time = time; this.at = now;
    this.events = this.events.filter(e => now - e.at < 60000).slice(0, 8);
    return this.events;
  }
}
// Device rendering preferences belong to each standalone viewer. Embedded OBS
// views still follow the console's shared rendering preferences.
export const LOCAL_RENDER_PREFS = ['q3d', 'shadow3d', 'fpscap'];
export function viewerPreferences(remote, local, embedded = false) {
  const prefs = { ...remote };
  if (!embedded) for (const key of LOCAL_RENDER_PREFS) if (local[key] !== undefined) prefs[key] = local[key];
  return prefs;
}
