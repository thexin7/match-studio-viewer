import { defaultStudio } from '../ui/studio/model.js';
import { groups } from '../ui/studio/settings.js';

const prefs = new Map(groups.flatMap(g => g.items.map(item => [item[0], item])));
export function createStudioAPI() {
  let state = defaultStudio();
  return async function handle(req, res, has3d) {
    const reply = (status, body) => { const text = JSON.stringify(body);res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });res.end(req.method === 'HEAD' ? undefined : text); };
    if (req.method === 'GET' || req.method === 'HEAD') return reply(200, { ...state, has3d });
    if (req.method !== 'POST') return reply(405, { error: 'method not allowed' });
    if (req.headers.origin) {
      try { const origin = new URL(req.headers.origin);if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) return reply(403, { error: 'origin rejected' }); }
      catch { return reply(403, { error: 'origin rejected' }); }
    }
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') return reply(415, { error: 'JSON required' });
    let body = '', bytes = 0;
    try {
      for await (const chunk of req) { bytes += chunk.length;if (bytes > 16384) return reply(413, { error: 'body too large' });body += chunk; }
      const patch = JSON.parse(body);
      if (!patch || !Number.isFinite(patch.revision)) return reply(400, { error: 'revision required' });
      if (patch.revision !== state.revision) return reply(409, { error: 'revision conflict' });
      for (const [key, value] of Object.entries(patch)) {
        let valid = false;
        if (key === 'revision') valid = true;
        else if (key === 'layout') valid = ['corner', 'bar', 'vertical', 'map'].includes(value);
        else if (key === 'view') valid = ['2d', '3d'].includes(value);
        else if (key === 'camera') valid = ['fpv', 'chase', 'orbit', 'top'].includes(value);
        else if (['observer', 'map'].includes(key)) valid = typeof value === 'string' && value.length <= 128;
        else if (['hidden', 'minimap', 'threats', 'ticker', 'muted'].includes(key)) valid = typeof value === 'boolean';
        else if (key === 'prefs' && value && typeof value === 'object' && !Array.isArray(value)) {
          valid = Object.entries(value).every(([name, val]) => {
            const item = prefs.get(name);if (!item) return false;
            if (item[2] === 'toggle') return val === 0 || val === 1;
            if (item[2] === 'select') return item[4].some(([choice]) => val === choice);
            return Number.isFinite(val) && val >= item[4] && val <= item[5];
          });
        }
        if (!valid) return reply(400, { error: `invalid field: ${key}` });
      }
      state = { ...state, ...patch, prefs: { ...state.prefs, ...patch.prefs }, revision: state.revision + 1 };
      return reply(200, { ...state, has3d });
    } catch { return reply(400, { error: 'invalid JSON' }); }
  };
}
