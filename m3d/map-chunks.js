/* 地图几何分块：把整张地形（数百万三角形）按 XY 空间切成约 100–300 块，
   每块局部重排顶点、能用 Uint16 索引就用，并给出包围盒/包围球，让 three.js 的视锥剔除
   （主渲染和阴影 pass 都会做）只提交镜头里的部分。

   纯 JS、不依赖 three：同一个文件既能在主线程 import，也能作为 module Worker 运行
   （Worker 里没有 import map，不能 import 'three'）。

   切分方式：先把三角形质心落到 256×256 的均匀格子里计数，再在格子上做按三角形数量
   均衡的 k-d 切分，叶子是格子矩形；这样稠密城区块小、空旷地形块大，每块三角形数接近，
   而全程只有几次 O(n) 遍历。每块内地面（|nz| ≥ 0.70·|n|，与 splitSurfaceIndices 一致）
   在前、墙在后，对应材质组 0 / 1。 */

const GRID = 256;
const FLOOR_COS = 0.70;

function chunkCountFor(triangles, opt) {
    const target = Math.max(1000, opt.targetTriangles || 20000);
    const max = Math.max(1, opt.maxChunks || 300);
    const min = Math.max(1, Math.min(max, opt.minChunks || 1));
    return Math.min(max, Math.max(min, Math.round(triangles / target)));
}

/* k-d 切分格子区域；leaves 为该区域应得的叶子数。返回叶子矩形 [x0,x1,y0,y1)。 */
function splitCells(counts, gx, gy, cell, leavesWanted) {
    const out = [];
    const sumRegion = (x0, x1, y0, y1) => {
        let s = 0;
        for (let y = y0; y < y1; y++) for (let x = x0, o = y * gx + x0; x < x1; x++, o++) s += counts[o];
        return s;
    };
    const visit = (x0, x1, y0, y1, leaves, total) => {
        if (total === 0) return;
        if (leaves <= 1 || (x1 - x0 <= 1 && y1 - y0 <= 1)) { out.push([x0, x1, y0, y1]); return; }
        const alongX = (x1 - x0) >= (y1 - y0) ? (x1 - x0 > 1) : !(y1 - y0 > 1);
        const leftLeaves = Math.floor(leaves / 2);
        const target = total * leftLeaves / leaves;
        const n = alongX ? x1 - x0 : y1 - y0;
        const line = new Float64Array(n);
        for (let y = y0; y < y1; y++) for (let x = x0, o = y * gx + x0; x < x1; x++, o++) {
            line[alongX ? x - x0 : y - y0] += counts[o];
        }
        let acc = 0, at = 1, best = Infinity;
        for (let i = 0; i < n - 1; i++) {
            acc += line[i];
            const d = Math.abs(acc - target);
            if (d < best) { best = d; at = i + 1; }
        }
        let left = 0;
        for (let i = 0; i < at; i++) left += line[i];
        if (alongX) {
            visit(x0, x0 + at, y0, y1, leftLeaves, left);
            visit(x0 + at, x1, y0, y1, leaves - leftLeaves, total - left);
        } else {
            visit(x0, x1, y0, y0 + at, leftLeaves, left);
            visit(x0, x1, y0 + at, y1, leaves - leftLeaves, total - left);
        }
    };
    visit(0, gx, 0, gy, leavesWanted, sumRegion(0, gx, 0, gy));
    return out;
}

/**
 * @param {Float32Array} position  xyz（three 世界坐标，米）
 * @param {Uint32Array|Uint16Array|null} index  三角形索引；null 表示非索引几何
 * @param {{name:string,array:ArrayLike<number>,itemSize:number,normalized:boolean}[]} attributes 其余逐顶点属性
 * @param {{targetTriangles?:number,maxChunks?:number,minChunks?:number}} [opt]
 */
export function buildMapChunks(position, index, attributes = [], opt = {}) {
    const t0 = performance.now();
    const vertexCount = Math.floor(position.length / 3);
    const indexCount = index ? index.length : vertexCount;
    const triCount = Math.floor(indexCount / 3);
    const idx = index || null;
    const vi = i => (idx ? idx[i] : i);

    // 1) 质心 XY 范围与地面/墙分类
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const cx = new Float32Array(triCount), cy = new Float32Array(triCount);
    const wall = new Uint8Array(triCount);
    let floorTriangles = 0;
    for (let t = 0, i = 0; t < triCount; t++, i += 3) {
        const a = vi(i) * 3, b = vi(i + 1) * 3, c = vi(i + 2) * 3;
        const ax = position[a], ay = position[a + 1], az = position[a + 2];
        const ux = position[b] - ax, uy = position[b + 1] - ay, uz = position[b + 2] - az;
        const vx = position[c] - ax, vy = position[c + 1] - ay, vz = position[c + 2] - az;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const isFloor = Math.abs(nz) >= FLOOR_COS * Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (isFloor) floorTriangles++; else wall[t] = 1;
        const x = (ax + position[b] + position[c]) / 3, y = (ay + position[b + 1] + position[c + 1]) / 3;
        cx[t] = x; cy[t] = y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (!triCount) return { chunks: [], stats: { triangles: 0, floorTriangles: 0, wallTriangles: 0, chunks: 0, uint16Chunks: 0, ms: 0 } };

    // 2) 正方形格子计数（格子在长边方向 GRID 个）
    const span = Math.max(maxX - minX, maxY - minY, 1e-3);
    const cell = span / GRID * 1.000001;
    const gx = Math.max(1, Math.ceil((maxX - minX) / cell) || 1), gy = Math.max(1, Math.ceil((maxY - minY) / cell) || 1);
    const triCell = new Uint32Array(triCount);
    const counts = new Uint32Array(gx * gy);
    for (let t = 0; t < triCount; t++) {
        const x = Math.min(gx - 1, ((cx[t] - minX) / cell) | 0), y = Math.min(gy - 1, ((cy[t] - minY) / cell) | 0);
        const k = y * gx + x;
        triCell[t] = k; counts[k]++;
    }

    // 3) 按三角形数均衡切分格子，得到 格子 → 块
    const leaves = splitCells(counts, gx, gy, cell, chunkCountFor(triCount, opt));
    const cellLeaf = new Uint16Array(gx * gy);
    leaves.forEach(([x0, x1, y0, y1], id) => {
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cellLeaf[y * gx + x] = id;
    });

    // 4) 计数排序：键 = 块*2 + 墙
    const keys = leaves.length * 2;
    const start = new Uint32Array(keys + 1);
    for (let t = 0; t < triCount; t++) start[cellLeaf[triCell[t]] * 2 + wall[t] + 1]++;
    for (let k = 0; k < keys; k++) start[k + 1] += start[k];
    const fill = start.slice(0, keys);
    const order = new Uint32Array(triCount);
    for (let t = 0; t < triCount; t++) order[fill[cellLeaf[triCell[t]] * 2 + wall[t]]++] = t;

    // 5) 每块局部重排顶点
    let maxLeafTris = 0;
    for (let l = 0; l < leaves.length; l++) maxLeafTris = Math.max(maxLeafTris, start[l * 2 + 2] - start[l * 2]);
    const stamp = new Uint32Array(vertexCount);
    const remap = new Uint32Array(vertexCount);
    const scratchPos = new Float32Array(maxLeafTris * 9);
    const scratchIdx = new Uint32Array(maxLeafTris * 3);
    const scratchAttr = attributes.map(a => new a.array.constructor(maxLeafTris * 3 * a.itemSize));
    const chunks = [];
    let uint16Chunks = 0;
    for (let l = 0; l < leaves.length; l++) {
        const s = start[l * 2], mid = start[l * 2 + 1], e = start[l * 2 + 2];
        if (e === s) continue;
        const mark = l + 1;
        let local = 0, w = 0;
        let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
        for (let o = s; o < e; o++) {
            const t = order[o] * 3;
            for (let k = 0; k < 3; k++) {
                const v = vi(t + k);
                if (stamp[v] !== mark) {
                    stamp[v] = mark; remap[v] = local;
                    const p = v * 3, q = local * 3;
                    const x = position[p], y = position[p + 1], z = position[p + 2];
                    scratchPos[q] = x; scratchPos[q + 1] = y; scratchPos[q + 2] = z;
                    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
                    if (y < by0) by0 = y; if (y > by1) by1 = y;
                    if (z < bz0) bz0 = z; if (z > bz1) bz1 = z;
                    for (let a = 0; a < attributes.length; a++) {
                        const src = attributes[a].array, n = attributes[a].itemSize, dst = scratchAttr[a];
                        for (let c = 0; c < n; c++) dst[local * n + c] = src[v * n + c];
                    }
                    local++;
                }
                scratchIdx[w++] = remap[v];
            }
        }
        const pos = scratchPos.slice(0, local * 3);
        const scx = (bx0 + bx1) / 2, scy = (by0 + by1) / 2, scz = (bz0 + bz1) / 2;
        let r2 = 0;
        for (let q = 0; q < pos.length; q += 3) {
            const dx = pos[q] - scx, dy = pos[q + 1] - scy, dz = pos[q + 2] - scz;
            const d = dx * dx + dy * dy + dz * dz;
            if (d > r2) r2 = d;
        }
        const small = local <= 65535;
        if (small) uint16Chunks++;
        const outIdx = small ? Uint16Array.from(scratchIdx.subarray(0, w)) : scratchIdx.slice(0, w);
        const attrs = {};
        attributes.forEach((a, i) => { attrs[a.name] = scratchAttr[i].slice(0, local * a.itemSize); });
        chunks.push({ position: pos, index: outIdx, attributes: attrs,
            floorCount: (mid - s) * 3, wallCount: (e - mid) * 3,
            box: [bx0, by0, bz0, bx1, by1, bz1], sphere: [scx, scy, scz, Math.sqrt(r2)] });
    }
    return { chunks, stats: { triangles: triCount, floorTriangles, wallTriangles: triCount - floorTriangles,
        chunks: chunks.length, uint16Chunks, ms: Math.round(performance.now() - t0) } };
}

/* 结果里所有缓冲区，用于 postMessage 转移。 */
export function chunkTransferList(result) {
    const list = [];
    for (const c of result.chunks) {
        list.push(c.position.buffer, c.index.buffer);
        for (const a of Object.values(c.attributes)) list.push(a.buffer);
    }
    return list;
}

/* 主线程入口：优先在 Worker 中切块（不卡 UI），Worker 不可用时回退到主线程。
   先等 Worker 报「就绪」再转移缓冲区：postMessage 一调用缓冲区就被转走，若 Worker
   脚本加载失败就无法回退了。转移后调用方不得再读 position/index/属性数组。 */
export function buildMapChunksAsync(position, index, attributes = [], opt = {}) {
    const detachable = arr => arr && arr.byteOffset === 0 && arr.byteLength === arr.buffer.byteLength ? arr : arr?.slice();
    const runLocal = () => buildMapChunks(position, index, attributes, opt);
    let worker;
    try {
        worker = new Worker(new URL(import.meta.url), { type: 'module', name: 'map-chunks' });
    } catch (error) {
        console.warn('[MapChunks] Worker 不可用，改在主线程切块:', error);
        return Promise.resolve(runLocal());
    }
    return new Promise((resolve, reject) => {
        let sent = false;
        const fallback = reason => {
            worker.terminate();
            console.warn('[MapChunks] Worker 不可用，改在主线程切块:', reason);
            try { resolve(runLocal()); } catch (error) { reject(error); }
        };
        const timer = setTimeout(() => { if (!sent) fallback('就绪超时'); }, 4000);
        worker.onmessage = ev => {
            if (ev.data?.ready && !sent) {
                clearTimeout(timer);
                const pos = detachable(position), ix = detachable(index);
                const attrs = attributes.map(a => ({ ...a, array: detachable(a.array) }));
                const transfer = [pos.buffer];
                if (ix) transfer.push(ix.buffer);
                for (const a of attrs) transfer.push(a.array.buffer);
                try { worker.postMessage({ position: pos, index: ix, attributes: attrs, opt }, transfer); sent = true; }
                catch (error) { fallback(error); }
                return;
            }
            worker.terminate();
            if (ev.data?.error) reject(new Error(ev.data.error)); else resolve(ev.data);
        };
        worker.onerror = ev => {
            ev.preventDefault?.();
            clearTimeout(timer);
            if (!sent) { fallback(ev.message || 'load error'); return; }
            worker.terminate();
            reject(new Error('地图切块 Worker 失败: ' + (ev.message || 'unknown')));
        };
    });
}

// 作为 module Worker 运行时：先报就绪，收一次几何，回传切块结果后由主线程 terminate。
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
    self.postMessage({ ready: true });
    self.onmessage = ev => {
        try {
            const { position, index, attributes, opt } = ev.data;
            const result = buildMapChunks(position, index, attributes, opt);
            self.postMessage(result, chunkTransferList(result));
        } catch (error) {
            self.postMessage({ error: String(error?.stack || error) });
        }
    };
}
