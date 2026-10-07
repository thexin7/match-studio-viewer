import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const pollSource = html.slice(html.indexOf('let lastUiErrorAt=0;'), html.indexOf('document.addEventListener("visibilitychange", () => { if (!document.hidden)'));

function context(overrides = {}) {
  const sandbox = {
    fetch: async () => ({ ok: true, text: async () => '{"entities":[]}' }),
    setTimeout: () => 1, clearTimeout() {}, AbortController, DOMException,
    performance: { now: () => 4000 }, document: { hidden: false },
    $: () => ({ textContent: '' }), normalizeNames() {}, normalizeSelf: x => x,
    lastSnap: null, R3: null, draw() {}, gwUiSamples: 0,
    console: { error() {}, warn() {} }, toast() {}, ...overrides,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(pollSource, ctx);
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
  ctx.fetch = async () => ({ ok: true, text: async () => '{"entities":[]}' });
  await vm.runInContext('poll()', ctx);
  assert.equal(draws, 1, 'next successful request resumes rendering');
});

test('one pointer seek sends only one replay command', () => {
  const handlers = {};
  const commands = [];
  const ctx = vm.createContext({
    $: () => ({ value: '500', addEventListener(type, fn) { handlers[type] = fn; } }),
    replayControl: q => commands.push(q), seeking: false,
  });
  const start = html.indexOf('$("seek").addEventListener("pointerdown"');
  const end = html.indexOf('/* --- 战况岛', start);
  vm.runInContext(html.slice(start, end), ctx);
  for (const type of ['pointerdown', 'change', 'pointerup']) handlers[type]?.();
  assert.deepEqual(commands, ['seek=500']);
  assert.equal(ctx.seeking, false);
});
