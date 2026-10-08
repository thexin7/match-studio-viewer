import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const app = fs.readFileSync(new URL('../ui/radar/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const pollSource = app.slice(app.indexOf('let lastUiErrorAt=0;'), app.indexOf('document.addEventListener("visibilitychange", () => { if (!document.hidden)'));

function context(overrides = {}) {
  const events = [];
  const sandbox = {
    fetch: async () => ({ ok: true, text: async () => '{"entities":[]}' }),
    setTimeout: () => 1, clearTimeout() {}, AbortController, DOMException,
    performance: { now: () => 4000 }, document: { hidden: false },
    $: () => ({ textContent: '' }), normalizeNames() {}, normalizeSelf: x => x,
    lastSnap: null, R3: null, draw() {}, syncSessionMap: async () => {}, liveState: { key: 'live' },
    monitor: { ok: (s, changed) => events.push(changed ? 'ok:changed' : 'ok'), fail: () => events.push('fail') },
    console: { error() {}, warn() {} }, toast() {}, ...overrides,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(pollSource, ctx);
  ctx.events = events;
  return ctx;
}

test('failed rendering retries the same snapshot on the next poll', async () => {
  let attempts = 0;
  const ctx = context({ draw() { if (++attempts === 1) throw new Error('render failed'); } });
  await vm.runInContext('poll()', ctx);
  await vm.runInContext('poll()', ctx);
  assert.equal(attempts, 2);
  await vm.runInContext('poll()', ctx);
  assert.equal(attempts, 2, 'successfully rendered snapshot should be deduplicated');
  // 渲染失败不能被记成「连接异常」，也不能被记成一次新数据
  assert.deepEqual(ctx.events, ['ok', 'ok:changed', 'ok']);
});

test('stalled response body is aborted and releases polling', async () => {
  let timeout;
  let cleared = 0;
  let warnings = 0;
  let draws = 0;
  const ctx = context({
    console: { warn() { warnings++; }, error() { assert.fail('timeout must be recoverable'); } },
    draw() { draws++; },
    setTimeout(fn, ms) { if (ms === 5000) timeout = fn; return 1; },
    clearTimeout() { cleared++; },
    fetch: async (_url, { signal }) => ({ ok: true, text: () => new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) }),
  });
  const pending = vm.runInContext('poll()', ctx);
  await Promise.resolve();
  assert.equal(typeof timeout, 'function', 'request has a timeout');
  timeout();
  await pending;
  assert.equal(vm.runInContext('pollBusy', ctx), false);
  assert.equal(cleared, 1);
  assert.equal(warnings, 1);
  assert.deepEqual(ctx.events, ['fail'], 'a timed-out request is reported as a connection failure');
  ctx.fetch = async () => ({ ok: true, text: async () => '{"entities":[]}' });
  await vm.runInContext('poll()', ctx);
  assert.equal(draws, 1, 'next successful request resumes rendering');
});

test('a frozen snapshot whose wall-clock ages grow is not new data and lets polling back off', async () => {
  const frozen = age => JSON.stringify({ live_active: true, self: [1, 2, 3], entities: [{ key: 'a', kind: 'player', world: [4, 5, 6], pose_age_ms: age }], meta: { decode: age } });
  let age = 10, draws = 0;
  const delays = [];
  const ctx = context({ draw() { draws++; }, fetch: async () => ({ ok: true, text: async () => frozen(age += 300) }), setTimeout: (fn, ms) => { delays.push(ms); return 1; } });
  for (let i = 0; i < 4; i++) await vm.runInContext('poll()', ctx);
  assert.equal(draws, 1, 'only the first frozen snapshot is drawn');
  assert.deepEqual(ctx.events, ['ok:changed', 'ok', 'ok', 'ok']);
  assert.ok(delays[3] > delays[1], 'unchanged content backs off');
  // 位置真的变化时才算新数据
  ctx.fetch = async () => ({ ok: true, text: async () => frozen(age).replace('[4,5,6]', '[7,8,9]') });
  await vm.runInContext('poll()', ctx);
  assert.equal(draws, 2);
});

test('HTTP errors are connection failures, not new data', async () => {
  const ctx = context({ fetch: async () => ({ ok: false, status: 503, text: async () => '' }) });
  await vm.runInContext('poll()', ctx);
  assert.deepEqual(ctx.events, ['fail']);
});

test('the live radar page never calls replay, console or session-switch endpoints', () => {
  for (const source of [app, html]) {
    for (const endpoint of ['/api/ctrl', '/api/studio', '/api/select', '/api/flows']) assert.ok(!source.includes(endpoint), endpoint);
  }
  for (const word of ['playbar', 'seek', '倍速', '导播']) assert.ok(!html.includes(word), word);
});
