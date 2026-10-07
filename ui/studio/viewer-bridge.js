import { StudioClient, poll } from './client.js?v=1.0.2';
import { groups } from './settings.js?v=1.0.2';

const client = new StudioClient(), params = new URLSearchParams(location.search);
const mapOnly = params.has('overlay-map'), preview = mapOnly || params.has('studio-preview');
if (preview) document.body.classList.add('studio-preview');
if (mapOnly) document.body.classList.add('studio-map');
const prefKeys = groups.flatMap(g => g.items.map(item => item[0]));
let revision = -1, previous = null, lastApplied = '';
function read() {
  const raw = window.matchStudio?.read();
  if (!raw?.ready) return null;
  return { view: raw.view, camera: raw.camera, observer: raw.observer, map: raw.map,
    prefs: Object.fromEntries(prefKeys.map(key => [key, raw.prefs[key]])) };
}
poll(async () => {
  const local = read();if (!local) return;
  try {
    const remote = await client.read();
    if (remote.revision !== revision) {
      if (remote.revision === 0 && !preview) {
        const saved = await client.update(local);revision = saved.revision;previous = read();return;
      }
      // An untouched control session must not overwrite the viewer's saved preferences.
      if (remote.revision > 0 || preview) {
        const effective = { ...remote, map: remote.map || local.map };
        const signature = JSON.stringify([effective.view, effective.camera, effective.observer, effective.map, effective.prefs]);
        if (signature !== lastApplied) {
          if (!await window.matchStudio.apply(effective, mapOnly)) return;
          lastApplied = signature;
        }
      }
      revision = remote.revision;previous = read();return;
    }
    if (!preview && previous) {
      const patch = {};
      for (const key of ['view','camera','observer','map']) if (local[key] !== previous[key]) patch[key] = local[key];
      const prefs = {};
      for (const key of prefKeys) if (local.prefs[key] !== previous.prefs[key]) prefs[key] = local.prefs[key];
      if (Object.keys(prefs).length) patch.prefs = prefs;
      if (Object.keys(patch).length) { const saved = await client.update(patch);revision = saved.revision; }
    }
    previous = read();
  } catch { /* Existing /api/state diagnostics remain available on older hosts. */ }
}, 500);
