import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createStudioAPI } from './studio-api.mjs';
import { StudioClient } from '../ui/studio/client.js';

test('fixture host shares controls atomically and rejects stale or malformed writes', async t => {
  const handler = createStudioAPI();
  const server = http.createServer((req, res) => handler(req, res, false));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections();server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/studio`;
  const post = (body, origin) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  assert.equal((await (await fetch(url)).json()).has3d, false);
  assert.equal((await post({ revision: 0, layout: 'vertical', prefs: { alert: 120 } })).status, 200);
  assert.equal((await post({ revision: 0, layout: 'bar' })).status, 409);
  assert.equal((await post({ revision: 1, layout: 'bar', prefs: { alert: -1 } })).status, 400);
  const state = await (await fetch(url)).json();
  assert.equal(state.layout, 'vertical');assert.equal(state.prefs.alert, 120);assert.equal(state.revision, 1);
  assert.equal((await post({ revision: 1, hidden: true }, 'null')).status, 403);
  assert.equal((await post({ revision: 1, hidden: true }, 'http://elsewhere')).status, 403);
  const head = await fetch(url, { method: 'HEAD' });assert.equal(await head.text(), '');
});

test('client retries a revision conflict using fresh state and serializes subsequent changes', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let state = { revision: 0, layout: 'corner', prefs: {} }, conflict = true;
  const writes = [];
  globalThis.fetch = async (_path, init) => {
    if (init.method !== 'POST') return new Response(JSON.stringify(state));
    const patch = JSON.parse(init.body);writes.push(patch);
    if (conflict) { conflict = false;state = { ...state, revision: 1 };return new Response('{}', { status: 409 }); }
    assert.equal(patch.revision, state.revision);
    state = { ...state, ...patch, revision: state.revision + 1 };return new Response(JSON.stringify(state));
  };
  const client = new StudioClient();
  await Promise.all([client.update({ layout: 'bar' }), client.update({ hidden: true })]);
  assert.equal(state.layout, 'bar');assert.equal(state.hidden, true);assert.deepEqual(writes.map(p => p.revision), [0, 1, 2]);
});
