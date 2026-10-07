/* 地形打包格式 MSTP v1 的解码（浏览器与 tools/terrain-pack 共用同一份代码，管线据此做往返校验）。
   文件 = gzip(载荷)；载荷全部小端：
     'MSTP' | u32 版本 | u32 标志(bit0=含 bake) | u32 块数 | u32 顶点总数 | u32 索引总数 | u32 元数据长度 | 元数据 JSON（补齐到 4 字节）
     块表：每块 u32 顶点数、u32 索引数、f64×12 仿射矩阵（行主序 3×4，作用于 int16 量化坐标，得到 glTF 米制坐标）
     位置：6 个字节平面（X 低/高、Y 低/高、Z 低/高），值为块内相邻顶点 int16 差分的 zigzag
     索引：u32 字节数 + LEB128 变长码，码值 = 高水位 − 索引（顶点已按首次使用排序，新顶点恒为 0）
     bake（可选）：AO、天空可见度两个字节平面，块内相邻顶点差分（模 256）
   不依赖 three，输出直接可用的类型化数组；坐标换算与 GLB 路径逐位一致：three 的 x=gx, y=−gz, z=gy。 */
export const PACK_MAGIC = 0x5054534d; // 'MSTP'
export const PACK_VERSION = 1;
export const CHUNK_HEADER_BYTES = 8 + 12 * 8;

/** 若是 gzip 流就用原生 DecompressionStream 解压；服务端已按 Content-Encoding 解过压的直接返回。 */
export async function gunzipIfNeeded(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 2 || u8[0] !== 0x1f || u8[1] !== 0x8b) return u8;
  if (typeof DecompressionStream !== 'function') throw new Error('浏览器不支持 DecompressionStream');
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function decodeTerrainPack(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < 28 || dv.getUint32(0, true) !== PACK_MAGIC) throw new Error('不是 MSTP 地形包');
  const version = dv.getUint32(4, true);
  if (version !== PACK_VERSION) throw new Error('不支持的地形包版本 ' + version);
  const flags = dv.getUint32(8, true), chunkCount = dv.getUint32(12, true);
  const vertCount = dv.getUint32(16, true), indexCount = dv.getUint32(20, true), metaLen = dv.getUint32(24, true);
  let at = 28;
  const meta = metaLen ? JSON.parse(new TextDecoder().decode(u8.subarray(at, at + metaLen))) : {};
  at += (metaLen + 3) & ~3;
  const chunks = new Array(chunkCount);
  for (let c = 0; c < chunkCount; c++, at += CHUNK_HEADER_BYTES) {
    const m = new Float64Array(12);
    for (let k = 0; k < 12; k++) m[k] = dv.getFloat64(at + 8 + k * 8, true);
    chunks[c] = { verts: dv.getUint32(at, true), indices: dv.getUint32(at + 4, true), matrix: m };
  }
  const need = at + vertCount * 6 + 4;
  if (need > u8.length) throw new Error('地形包截断（位置段）');
  const planes = [];
  for (let k = 0; k < 6; k++) planes.push(u8.subarray(at + k * vertCount, at + (k + 1) * vertCount));
  at += vertCount * 6;
  const indexBytes = dv.getUint32(at, true); at += 4;
  if (at + indexBytes > u8.length) throw new Error('地形包截断（索引段）');
  const ib = u8.subarray(at, at + indexBytes); at += indexBytes;
  const hasBake = (flags & 1) !== 0;
  if (hasBake && at + vertCount * 2 > u8.length) throw new Error('地形包截断（bake 段）');

  const position = new Float32Array(vertCount * 3), index = new Uint32Array(indexCount);
  const bake = hasBake ? new Uint8Array(vertCount * 2) : null;
  const [xl, xh, yl, yh, zl, zh] = planes;
  const ar = hasBake ? u8.subarray(at, at + vertCount) : null, ag = hasBake ? u8.subarray(at + vertCount, at + vertCount * 2) : null;
  let v = 0, ii = 0, ip = 0;
  for (const ch of chunks) {
    const m = ch.matrix, base = v;
    let qx = 0, qy = 0, qz = 0, r = 0, g = 0;
    for (let n = 0; n < ch.verts; n++, v++) {
      let z = xl[v] | (xh[v] << 8); qx = (((qx + ((z >>> 1) ^ -(z & 1))) + 32768) & 0xffff) - 32768;
      z = yl[v] | (yh[v] << 8); qy = (((qy + ((z >>> 1) ^ -(z & 1))) + 32768) & 0xffff) - 32768;
      z = zl[v] | (zh[v] << 8); qz = (((qz + ((z >>> 1) ^ -(z & 1))) + 32768) & 0xffff) - 32768;
      // 与 Matrix4.applyMatrix4 相同的运算顺序，保证与原 GLB 路径逐位一致
      const tx = m[0] * qx + m[1] * qy + m[2] * qz + m[3];
      const ty = m[4] * qx + m[5] * qy + m[6] * qz + m[7];
      const tz = m[8] * qx + m[9] * qy + m[10] * qz + m[11];
      position[v * 3] = tx; position[v * 3 + 1] = -tz; position[v * 3 + 2] = ty;
      if (bake) { r = (r + ar[v]) & 255; g = (g + ag[v]) & 255; bake[v * 2] = r; bake[v * 2 + 1] = g; }
    }
    let hwm = 0;
    for (let n = 0; n < ch.indices; n++) {
      let code = 0, shift = 0, b;
      do { if (ip >= ib.length || shift > 21) throw new Error('地形包索引段损坏'); b = ib[ip++]; code |= (b & 127) << shift; shift += 7; } while (b & 128);
      const local = hwm - code;
      if (code === 0) hwm++;
      if (local < 0 || local >= ch.verts) throw new Error('地形包索引越界');
      index[ii++] = base + local;
    }
  }
  if (v !== vertCount || ii !== indexCount) throw new Error('地形包块表与总数不一致');
  return { meta, chunks, position, index, bake, verts: vertCount, tris: indexCount / 3 };
}

/** 下载（带进度，按线上字节计）→ 解压 → 解码。progress(got, total) 与 GLB 路径同语义。 */
async function loadTerrainPackLocal(url, progress, signal) {
  const response = await fetch(url, { cache: 'force-cache', signal });
  if (!response.ok) throw new Error('地形包 HTTP ' + response.status);
  const total = Number(response.headers.get('Content-Length') || 0);
  let raw;
  if (!response.body || !progress || !total) raw = new Uint8Array(await response.arrayBuffer());
  else {
    const reader = response.body.getReader(), parts = [];
    let got = 0, lastAt = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      const now = performance.now();
      if (now - lastAt > 80) { lastAt = now; progress(Math.min(got, total), total); }
    }
    raw = new Uint8Array(got);
    let at = 0;
    for (let i = 0; i < parts.length; i++) { raw.set(parts[i], at); at += parts[i].length; parts[i] = null; }
  }
  progress?.(raw.length, raw.length);
  return decodeTerrainPack(await gunzipIfNeeded(raw));
}

// Download, inflate and decode away from the UI thread. A map switch terminates
// the worker, so an obsolete map cannot finish decoding in the background.
export function loadTerrainPack(url, progress, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (typeof Worker !== 'function') return loadTerrainPackLocal(url, progress, signal);
  let worker;
  try { worker = new Worker(new URL(import.meta.url), { type: 'module', name: 'terrain-decoder' }); }
  catch { return loadTerrainPackLocal(url, progress, signal); }
  return new Promise((resolve, reject) => {
    let sent = false, settled = false;
    const cleanup = () => { clearTimeout(timer);signal?.removeEventListener('abort', abort);worker.onmessage = null;worker.onerror = null;worker.terminate(); };
    const finish = (error, pack) => { if (settled) return;settled = true;cleanup();error ? reject(error) : resolve(pack); };
    const abort = () => finish(signal.reason);
    const fallback = () => { if (settled) return;settled = true;cleanup();loadTerrainPackLocal(url, progress, signal).then(resolve, reject); };
    const timer = setTimeout(fallback, 4000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (settled) return;
      if (data.ready && !sent) { sent = true;clearTimeout(timer);worker.postMessage({ url }); }
      else if (data.progress) progress?.(...data.progress);
      else if (data.error) finish(new Error(data.error));
      else if (data.pack) finish(null, data.pack);
    };
    worker.onerror = event => { event.preventDefault?.();if (sent) finish(new Error('地形后台解码失败'));else fallback(); };
  });
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = async ({ data }) => {
    try {
      const pack = await loadTerrainPackLocal(data.url, (...progress) => self.postMessage({ progress }));
      const transfer = [pack.position.buffer, pack.index.buffer];if (pack.bake) transfer.push(pack.bake.buffer);
      self.postMessage({ pack }, transfer);
    } catch (error) { self.postMessage({ error: error.message || '地形解码失败' }); }
  };
  self.postMessage({ ready: true });
}
