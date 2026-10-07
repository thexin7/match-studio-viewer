export async function request(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(path, { cache: 'no-store', ...init, signal: controller.signal });
    if (!response.ok) { const error = new Error(response.status === 409 ? '设置已更新，请重试' : `请求失败 (${response.status})`); error.status = response.status; throw error; }
    const value = await response.json();
    if (value?.ok === false) throw new Error(value.error || '操作失败');
    return value;
  } finally { clearTimeout(timer); }
}

export class StudioClient {
  state = null;
  queue = Promise.resolve();
  async read() {
    const value = await request('/api/studio');
    if (!value || !Number.isFinite(value.revision) || !value.prefs) throw new Error('控制台数据格式无效');
    this.state = value;
    return value;
  }
  update(patch) {
    const run = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const state = await this.read();
        try {
          this.state = await request('/api/studio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...patch, revision: state.revision }) });
          return this.state;
        } catch (error) { if (error.status !== 409 || attempt) throw error; }
      }
    };
    const pending = this.queue.then(run);
    this.queue = pending.catch(() => {});
    return pending;
  }
}

export function poll(fn, interval) {
  let stopped = false, timer;
  async function tick() { try { await fn(); } finally { if (!stopped) timer = setTimeout(tick, interval); } }
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}
