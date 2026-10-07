// 逐顶点烘焙：R = 半球环境光遮蔽（1 = 无遮挡），G = 正上方天空可见度（1 = 头顶是天空）。
// 主线程负责求法线、建 BVH；射线在 worker_threads 里并行，几何数据走 SharedArrayBuffer 零拷贝共享。
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import os from 'node:os';

const LEAF_MAX = 4, BINS = 12;

/* 采样点：地图没有存法线且几何是双面的；源网格的大三角形（几十米的屋顶、地坪）角点常压在女儿墙压顶、
   上层结构底下，若在顶点处取样，整片屋顶会按角点插值成「被遮挡、没有天空」。
   因此每个顶点改在「相邻面里面积最大的那张」上取样：沿该面朝质心内收 35% 距离（5cm~3m），
   法线也取这张面（近水平面翻成朝上；朝向在 worker 里两侧都试）。顶点值代表它所属大面在其附近的开阔程度。 */
function vertexSamples(position, index, count) {
  const best = new Float64Array(count), nrm = new Float32Array(count * 3), origin = new Float32Array(count * 3);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    const e1x = position[b] - position[a], e1y = position[b + 1] - position[a + 1], e1z = position[b + 2] - position[a + 2];
    const e2x = position[c] - position[a], e2y = position[c + 1] - position[a + 1], e2z = position[c + 2] - position[a + 2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-12)) continue;
    if (Math.abs(nz) >= 0.2 * len && nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const gx = (position[a] + position[b] + position[c]) / 3, gy = (position[a + 1] + position[b + 1] + position[c + 1]) / 3, gz = (position[a + 2] + position[b + 2] + position[c + 2]) / 3;
    for (let k = 0; k < 3; k++) {
      const v = index[t + k];
      if (len <= best[v]) continue;
      best[v] = len;
      const o = v * 3, ix = gx - position[o], iy = gy - position[o + 1], iz = gz - position[o + 2], il = Math.hypot(ix, iy, iz);
      const step = il > 1e-9 ? Math.min(3, Math.max(0.05, il * 0.35), il) / il : 0;
      origin[o] = position[o] + ix * step; origin[o + 1] = position[o + 1] + iy * step; origin[o + 2] = position[o + 2] + iz * step;
      nrm[o] = nx / len; nrm[o + 1] = ny / len; nrm[o + 2] = nz / len;
    }
  }
  let degenerate = 0;
  for (let v = 0; v < count; v++) if (!(best[v] > 0)) {
    const o = v * 3; degenerate++;
    origin[o] = position[o]; origin[o + 1] = position[o + 1]; origin[o + 2] = position[o + 2]; nrm[o + 2] = 1;
  }
  return { nrm, origin, degenerate };
}

/* 分箱 SAH 的 BVH。节点：bounds[6] + info[2]；叶子 info = [首三角, 数量]，内部节点 info = [左孩子, 0]，右孩子 = 左 + 1。
   三角形按叶子顺序重排成 v0/e1/e2（9 个 float），相对地图中心存放，降低 float32 的远点误差。 */
function buildBvh(position, index, center, log) {
  const triCount = index.length / 3;
  const cmin = new Float32Array(triCount * 3), cmax = new Float32Array(triCount * 3), cen = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    for (let ax = 0; ax < 3; ax++) {
      const a = position[index[t * 3] * 3 + ax] - center[ax], b = position[index[t * 3 + 1] * 3 + ax] - center[ax], c = position[index[t * 3 + 2] * 3 + ax] - center[ax];
      const lo = Math.min(a, b, c), hi = Math.max(a, b, c);
      cmin[t * 3 + ax] = lo; cmax[t * 3 + ax] = hi; cen[t * 3 + ax] = (lo + hi) * 0.5;
    }
  }
  const perm = new Uint32Array(triCount);
  for (let t = 0; t < triCount; t++) perm[t] = t;
  const capNodes = Math.max(1, 2 * triCount);
  const bounds = new Float32Array(capNodes * 6), info = new Uint32Array(capNodes * 2);
  let nodeCount = 1;
  const stack = [[0, 0, triCount]];
  const binCnt = new Int32Array(BINS), binB = new Float64Array(BINS * 6), rightArea = new Float64Array(BINS);
  const area = (x0, y0, z0, x1, y1, z1) => { const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0; return dx * dy + dy * dz + dz * dx; };
  let built = 0, lastLog = Date.now();
  while (stack.length) {
    const [node, s, e] = stack.pop();
    let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
    let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let i = s; i < e; i++) {
      const t = perm[i] * 3;
      if (cmin[t] < bx0) bx0 = cmin[t]; if (cmin[t + 1] < by0) by0 = cmin[t + 1]; if (cmin[t + 2] < bz0) bz0 = cmin[t + 2];
      if (cmax[t] > bx1) bx1 = cmax[t]; if (cmax[t + 1] > by1) by1 = cmax[t + 1]; if (cmax[t + 2] > bz1) bz1 = cmax[t + 2];
      if (cen[t] < cx0) cx0 = cen[t]; if (cen[t + 1] < cy0) cy0 = cen[t + 1]; if (cen[t + 2] < cz0) cz0 = cen[t + 2];
      if (cen[t] > cx1) cx1 = cen[t]; if (cen[t + 1] > cy1) cy1 = cen[t + 1]; if (cen[t + 2] > cz1) cz1 = cen[t + 2];
    }
    const o = node * 6;
    bounds[o] = bx0; bounds[o + 1] = by0; bounds[o + 2] = bz0; bounds[o + 3] = bx1; bounds[o + 4] = by1; bounds[o + 5] = bz1;
    const count = e - s;
    const ex = cx1 - cx0, ey = cy1 - cy0, ez = cz1 - cz0;
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2, lo = axis === 0 ? cx0 : axis === 1 ? cy0 : cz0, ext = axis === 0 ? ex : axis === 1 ? ey : ez;
    if (count <= LEAF_MAX || !(ext > 1e-6)) {
      if (count > 64 && !(ext > 1e-6)) {
        // 质心完全重合的大簇：按序号对半分，避免叶子过大拖慢遍历
        const mid = (s + e) >> 1, l = nodeCount; nodeCount += 2;
        info[node * 2] = l; info[node * 2 + 1] = 0;
        stack.push([l + 1, mid, e], [l, s, mid]);
        continue;
      }
      info[node * 2] = s; info[node * 2 + 1] = count; built += count;
      continue;
    }
    binCnt.fill(0);
    for (let b = 0; b < BINS; b++) { binB[b * 6] = binB[b * 6 + 1] = binB[b * 6 + 2] = Infinity; binB[b * 6 + 3] = binB[b * 6 + 4] = binB[b * 6 + 5] = -Infinity; }
    const k = BINS * (1 - 1e-6) / ext;
    for (let i = s; i < e; i++) {
      const t = perm[i] * 3, b = Math.min(BINS - 1, ((cen[t + axis] - lo) * k) | 0), q = b * 6;
      binCnt[b]++;
      if (cmin[t] < binB[q]) binB[q] = cmin[t]; if (cmin[t + 1] < binB[q + 1]) binB[q + 1] = cmin[t + 1]; if (cmin[t + 2] < binB[q + 2]) binB[q + 2] = cmin[t + 2];
      if (cmax[t] > binB[q + 3]) binB[q + 3] = cmax[t]; if (cmax[t + 1] > binB[q + 4]) binB[q + 4] = cmax[t + 1]; if (cmax[t + 2] > binB[q + 5]) binB[q + 5] = cmax[t + 2];
    }
    let rx0 = Infinity, ry0 = Infinity, rz0 = Infinity, rx1 = -Infinity, ry1 = -Infinity, rz1 = -Infinity, rc = 0;
    for (let b = BINS - 1; b > 0; b--) {
      const q = b * 6;
      if (binCnt[b]) { rx0 = Math.min(rx0, binB[q]); ry0 = Math.min(ry0, binB[q + 1]); rz0 = Math.min(rz0, binB[q + 2]); rx1 = Math.max(rx1, binB[q + 3]); ry1 = Math.max(ry1, binB[q + 4]); rz1 = Math.max(rz1, binB[q + 5]); }
      rc += binCnt[b];
      rightArea[b] = rc ? area(rx0, ry0, rz0, rx1, ry1, rz1) * rc : 0;
    }
    let lx0 = Infinity, ly0 = Infinity, lz0 = Infinity, lx1 = -Infinity, ly1 = -Infinity, lz1 = -Infinity, lc = 0, best = Infinity, split = -1;
    for (let b = 0; b < BINS - 1; b++) {
      const q = b * 6;
      if (binCnt[b]) { lx0 = Math.min(lx0, binB[q]); ly0 = Math.min(ly0, binB[q + 1]); lz0 = Math.min(lz0, binB[q + 2]); lx1 = Math.max(lx1, binB[q + 3]); ly1 = Math.max(ly1, binB[q + 4]); lz1 = Math.max(lz1, binB[q + 5]); }
      lc += binCnt[b];
      if (!lc || lc === count) continue;
      const cost = area(lx0, ly0, lz0, lx1, ly1, lz1) * lc + rightArea[b + 1];
      if (cost < best) { best = cost; split = b; }
    }
    let mid;
    if (split < 0) mid = (s + e) >> 1;
    else {
      let i = s, j = e - 1;
      while (i <= j) {
        const b = Math.min(BINS - 1, ((cen[perm[i] * 3 + axis] - lo) * k) | 0);
        if (b <= split) i++; else { const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp; j--; }
      }
      mid = i;
      if (mid === s || mid === e) mid = (s + e) >> 1;
    }
    const l = nodeCount; nodeCount += 2;
    info[node * 2] = l; info[node * 2 + 1] = 0;
    stack.push([l + 1, mid, e], [l, s, mid]);
    if (Date.now() - lastLog > 3000) { lastLog = Date.now(); log(`  BVH 构建中：叶子已收 ${(built / triCount * 100).toFixed(0)}%`); }
  }
  const tris = new Float32Array(new SharedArrayBuffer(triCount * 9 * 4));
  for (let i = 0; i < triCount; i++) {
    const t = perm[i];
    const a = index[t * 3] * 3, b = index[t * 3 + 1] * 3, c = index[t * 3 + 2] * 3, o = i * 9;
    for (let ax = 0; ax < 3; ax++) {
      const p0 = position[a + ax] - center[ax];
      tris[o + ax] = p0; tris[o + 3 + ax] = position[b + ax] - center[ax] - p0; tris[o + 6 + ax] = position[c + ax] - center[ax] - p0;
    }
  }
  const nb = new Float32Array(new SharedArrayBuffer(nodeCount * 6 * 4)); nb.set(bounds.subarray(0, nodeCount * 6));
  const ni = new Uint32Array(new SharedArrayBuffer(nodeCount * 2 * 4)); ni.set(info.subarray(0, nodeCount * 2));
  return { bounds: nb, info: ni, tris, nodeCount };
}

/**
 * @param position Float32Array three 坐标（米，Z 朝上）
 * @param index    Uint32Array
 * @returns {{bake: Uint8Array, stats: object}} bake 为逐顶点交错 [R,G]
 */
export async function bakeTerrain(position, index, opts = {}, log = () => {}) {
  const rays = Math.max(4, opts.rays | 0 || 12), aoDist = Number(opts.aoDist) || 10, skyDist = Number(opts.skyDist) || 400;
  const threads = Math.max(1, opts.threads | 0 || Math.max(1, os.availableParallelism() - 1));
  const t0 = Date.now();
  const count = position.length / 3;
  const { nrm, origin, degenerate } = vertexSamples(position, index, count);
  log(`  采样点：${count} 顶点，无有效相邻面 ${degenerate}（${Date.now() - t0}ms）`);
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i += 3) for (let a = 0; a < 3; a++) { const p = position[i + a]; if (p < mn[a]) mn[a] = p; if (p > mx[a]) mx[a] = p; }
  const center = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2].map(Math.fround);
  const t1 = Date.now();
  const bvh = buildBvh(position, index, center, log);
  log(`  BVH：${index.length / 3} 三角形，${bvh.nodeCount} 节点（${((Date.now() - t1) / 1000).toFixed(1)}s）`);
  const wpos = new Float32Array(new SharedArrayBuffer(count * 12)), wnrm = new Float32Array(new SharedArrayBuffer(count * 12));
  for (let v = 0; v < count * 3; v += 3) for (let a = 0; a < 3; a++) wpos[v + a] = origin[v + a] - center[a];
  wnrm.set(nrm);
  const out = new Uint8Array(new SharedArrayBuffer(count * 2)), progress = new Int32Array(new SharedArrayBuffer(4 * threads));
  const t2 = Date.now();
  // Spatially adjacent samples can have very different ray costs. Claim small
  // batches so dense indoor regions do not leave most workers idle at the tail.
  const queue = new Int32Array(new SharedArrayBuffer(4));
  const workers = [];
  for (let k = 0; k < Math.min(threads, count); k++) {
    workers.push(new Promise((resolve, reject) => {
      const wk = new Worker(new URL(import.meta.url), { workerData: { kind: 'terrain-bake', slot: k, count, queue, rays, aoDist, skyDist,
        bounds: bvh.bounds, info: bvh.info, tris: bvh.tris, wpos, wnrm, out, progress } });
      wk.once('message', resolve); wk.once('error', reject);
      wk.once('exit', code => { if (code !== 0) reject(new Error(`烘焙 worker 退出码 ${code}`)); });
    }));
  }
  const timer = setInterval(() => {
    let done = 0; for (let k = 0; k < progress.length; k++) done += Atomics.load(progress, k);
    const s = (Date.now() - t2) / 1000;
    log(`  烘焙 ${(done / count * 100).toFixed(1)}%  ${s.toFixed(0)}s  约 ${(done * (rays * 2 + 5) / Math.max(s, 1e-3) / 1e6).toFixed(1)}M 射线/秒`);
  }, 5000);
  let rayCount = 0, sideDown = 0;
  try { for (const r of await Promise.all(workers)) { rayCount += r.rays; sideDown += r.sideDown; } }
  finally { clearInterval(timer); }
  const n = count, bake = new Uint8Array(out);
  const histR = new Array(10).fill(0), histG = new Array(10).fill(0);
  let sumR = 0, sumG = 0, openR = 0, skyG = 0, roofG = 0;
  for (let v = 0; v < n; v++) {
    const r = bake[v * 2], g = bake[v * 2 + 1];
    sumR += r; sumG += g; histR[Math.min(9, (r / 25.6) | 0)]++; histG[Math.min(9, (g / 25.6) | 0)]++;
    if (r >= 250) openR++; if (g >= 250) skyG++; if (g <= 5) roofG++;
  }
  const pct = x => +(x / n * 100).toFixed(2);
  return { bake, stats: {
    seconds: +((Date.now() - t0) / 1000).toFixed(1), raySeconds: +((Date.now() - t2) / 1000).toFixed(1), threads: workers.length,
    rays_per_side: rays, ao_dist_m: aoDist, sky_dist_m: skyDist, verts: count, degenerate_normals: degenerate,
    rays_cast: rayCount, flipped_to_back_side: sideDown,
    R: { mean: +(sumR / n / 255).toFixed(3), fully_open_pct: pct(openR), hist10_pct: histR.map(pct) },
    G: { mean: +(sumG / n / 255).toFixed(3), sky_pct: pct(skyG), covered_pct: pct(roofG), hist10_pct: histG.map(pct) },
  } };
}

/* ---------------------------------------------------------------- worker */
function runWorker(d) {
  const { count, queue, rays, aoDist, skyDist, bounds, info, tris, wpos, wnrm, out, progress, slot } = d;
  const stack = new Int32Array(128);
  // 余弦加权的半球方向（螺旋分层），每个顶点再绕法线随机转一个角度，把条纹变成噪声
  const lx = new Float64Array(rays), ly = new Float64Array(rays), lz = new Float64Array(rays);
  for (let i = 0; i < rays; i++) {
    const r = Math.sqrt((i + 0.5) / rays), phi = i * 2.399963229728653;
    lx[i] = r * Math.cos(phi); ly[i] = r * Math.sin(phi); lz[i] = Math.sqrt(Math.max(0, 1 - r * r));
  }
  const SKY = 5, tilt = Math.sin(10 * Math.PI / 180), up = Math.cos(10 * Math.PI / 180);
  let rayCount = 0, sideDown = 0;

  // 最近命中距离；anyHit 时找到任一命中即返回。未命中返回 -1。
  function trace(ox, oy, oz, dx, dy, dz, tmax, anyHit) {
    const ix = 1 / (dx || 1e-30), iy = 1 / (dy || 1e-30), iz = 1 / (dz || 1e-30);
    let best = tmax, hit = -1, sp = 0;
    stack[sp++] = 0;
    while (sp) {
      const node = stack[--sp], b = node * 6;
      let t0 = (bounds[b] - ox) * ix, t1 = (bounds[b + 3] - ox) * ix;
      let tn = t0 < t1 ? t0 : t1, tf = t0 < t1 ? t1 : t0;
      t0 = (bounds[b + 1] - oy) * iy; t1 = (bounds[b + 4] - oy) * iy;
      tn = Math.max(tn, t0 < t1 ? t0 : t1); tf = Math.min(tf, t0 < t1 ? t1 : t0);
      t0 = (bounds[b + 2] - oz) * iz; t1 = (bounds[b + 5] - oz) * iz;
      tn = Math.max(tn, t0 < t1 ? t0 : t1); tf = Math.min(tf, t0 < t1 ? t1 : t0);
      if (tf < tn || tf < 0 || tn > best) continue;
      const cnt = info[node * 2 + 1];
      if (cnt === 0) { const l = info[node * 2]; stack[sp++] = l + 1; stack[sp++] = l; continue; }
      for (let i = info[node * 2], e = i + cnt; i < e; i++) {
        const o = i * 9;
        const e1x = tris[o + 3], e1y = tris[o + 4], e1z = tris[o + 5], e2x = tris[o + 6], e2y = tris[o + 7], e2z = tris[o + 8];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-12 && det < 1e-12) continue;
        const inv = 1 / det, tx = ox - tris[o], ty = oy - tris[o + 1], tz = oz - tris[o + 2];
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > 1e-4 && t < best) { best = t; hit = t; if (anyHit) return t; }
      }
    }
    return hit;
  }

  const EPS = 0.02;
  for (let from = Atomics.add(queue, 0, 1024); from < count; from = Atomics.add(queue, 0, 1024)) {
    const to = Math.min(count, from + 1024);
    for (let w = from; w < to; w++) {
      const px = wpos[w * 3], py = wpos[w * 3 + 1], pz = wpos[w * 3 + 2];
      const nx = wnrm[w * 3], ny = wnrm[w * 3 + 1], nz = wnrm[w * 3 + 2];
      // Duff 等人的无分支正交基
      const sg = nz >= 0 ? 1 : -1, a = -1 / (sg + nz), bb = nx * ny * a;
      const tx = 1 + sg * nx * nx * a, ty = sg * bb, tz = -sg * nx;
      const bx = bb, by = sg + ny * ny * a, bz = -ny;
      const h = Math.imul(w ^ 0x5bd1e995, 0x27d4eb2d) >>> 0, rot = (h / 4294967296) * Math.PI * 2, cr = Math.cos(rot), sr = Math.sin(rot);
      // 两侧都打：双面几何的「可见侧」取更开阔的一侧；向下且没打中的射线在选侧时按遮挡计，
      // 否则地表下方的虚空会让地面永远选到背面而丢掉 AO。
      let occF = 0, occB = 0, downF = 0, downB = 0;
      for (let side = 0; side < 2; side++) {
        const s = side ? -1 : 1, ox = px + s * nx * EPS, oy = py + s * ny * EPS, oz = pz + s * nz * EPS;
        let occ = 0, down = 0;
        for (let i = 0; i < rays; i++) {
          const x = lx[i] * cr - ly[i] * sr, y = lx[i] * sr + ly[i] * cr, z = lz[i] * s;
          const dx = tx * x + bx * y + nx * z, dy = ty * x + by * y + ny * z, dz = tz * x + bz * y + nz * z;
          const t = trace(ox, oy, oz, dx, dy, dz, aoDist, false);
          if (t >= 0) occ += 1 - t / aoDist; else if (dz < -0.3) down++;
        }
        if (side) { occB = occ; downB = down; } else { occF = occ; downF = down; }
      }
      rayCount += rays * 2;
      const selF = occF + downF, selB = occB + downB;
      const back = selB < selF - 1e-6 || (Math.abs(selB - selF) <= 1e-6 && nz < 0);
      if (back) sideDown++;
      const s = back ? -1 : 1, occ = back ? occB : occF;
      const ao = 1 - occ / rays;
      // 天空可见度：竖直向上一根 + 10° 锥内四根，任一命中即算遮挡
      const ox = px + s * nx * EPS, oy = py + s * ny * EPS, oz = pz + s * nz * EPS + EPS;
      let open = 0;
      for (let i = 0; i < SKY; i++) {
        let dx = 0, dy = 0, dz = 1;
        if (i) { const ang = rot + (i - 1) * Math.PI / 2; dx = Math.cos(ang) * tilt; dy = Math.sin(ang) * tilt; dz = up; }
        if (trace(ox, oy, oz, dx, dy, dz, skyDist, true) < 0) open++;
      }
      rayCount += SKY;
      out[w * 2] = Math.round(Math.max(0, Math.min(1, ao)) * 255);
      out[w * 2 + 1] = Math.round(open / SKY * 255);
    }
    Atomics.add(progress, slot, to - from);
  }
  return { rays: rayCount, sideDown };
}

if (!isMainThread && workerData?.kind === 'terrain-bake') parentPort.postMessage(runWorker(workerData));
