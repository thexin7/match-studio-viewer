/* 地图碰撞射线加速
   =============================================================================
   第三人称镜头每帧从注视点向镜头打一条射线找最近的地图三角形，防止镜头穿墙。
   three.js 的 Mesh.raycast 会逐个测试整块（约 2～3 万面）的三角形，每帧要 5～12ms。

   这里给每个地图块懒建一个 XY 均匀网格（CSR 存储）：三角形按 XY 包围盒登记到覆盖的格子，
   射线沿 XY 投影逐格前进（2D DDA），只测经过格子里的三角形；当前格出口之前已有命中就结束。
   跨格过多的大三角形（大片地面、斜向长墙）放进 big 列表每次都测，避免网格引用数膨胀。
   同一三角形登记在多个格子里，用逐次递增的戳记去重。

   坐标与地图块一致（three 世界坐标，米）；地图块没有变换矩阵，不做坐标变换。
   纯 JS、不依赖 three，便于在 Node 测试里与暴力求交对照。 */

const TARGET_TRIS_PER_CELL = 6;
const MAX_CELLS = 1 << 16;
const MIN_CELL_M = 0.5;
const BIG_TRIANGLE_CELLS = 64;
const DET_EPSILON = 1e-12;

/**
 * 为一块几何建网格。index 为三角形索引（Uint16/Uint32）；position 为 xyz 浮点数组。
 * @returns {{box:Float64Array,minX:number,minY:number,cell:number,gx:number,gy:number,
 *   start:Uint32Array,refs:Uint16Array|Uint32Array,big:Uint16Array|Uint32Array,seen:Uint32Array,query:number,
 *   triangles:number}}
 */
export function buildRayGrid(position, index) {
    const triCount = Math.floor(index.length / 3);
    const box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (let p = 0; p < position.length; p += 3) {
        const x = position[p], y = position[p + 1], z = position[p + 2];
        if (x < box[0]) box[0] = x; if (x > box[3]) box[3] = x;
        if (y < box[1]) box[1] = y; if (y > box[4]) box[4] = y;
        if (z < box[2]) box[2] = z; if (z > box[5]) box[5] = z;
    }
    const sx = Math.max(box[3] - box[0], 1e-6), sy = Math.max(box[4] - box[1], 1e-6);
    const area = sx * sy;
    const cell = Math.max(MIN_CELL_M, Math.sqrt(area * TARGET_TRIS_PER_CELL / Math.max(1, triCount)),
        Math.sqrt(area / MAX_CELLS)) * 1.000001;
    const gx = Math.max(1, Math.ceil(sx / cell)), gy = Math.max(1, Math.ceil(sy / cell));
    const minX = box[0], minY = box[1];
    const cellX = x => Math.min(gx - 1, Math.max(0, Math.floor((x - minX) / cell)));
    const cellY = y => Math.min(gy - 1, Math.max(0, Math.floor((y - minY) / cell)));
    const Ref = triCount <= 0xffff ? Uint16Array : Uint32Array;

    // 两遍：先计数（含大三角形），再按前缀和填 CSR
    const start = new Uint32Array(gx * gy + 1);
    const range = new Int32Array(triCount * 4);
    let bigCount = 0;
    for (let t = 0; t < triCount; t++) {
        const a = index[t * 3] * 3, b = index[t * 3 + 1] * 3, c = index[t * 3 + 2] * 3;
        const x0 = cellX(Math.min(position[a], position[b], position[c]));
        const x1 = cellX(Math.max(position[a], position[b], position[c]));
        const y0 = cellY(Math.min(position[a + 1], position[b + 1], position[c + 1]));
        const y1 = cellY(Math.max(position[a + 1], position[b + 1], position[c + 1]));
        const r = t * 4;
        range[r] = x0; range[r + 1] = x1; range[r + 2] = y0; range[r + 3] = y1;
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > BIG_TRIANGLE_CELLS) { range[r] = -1; bigCount++; continue; }
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) start[y * gx + x + 1]++;
    }
    for (let k = 0; k < gx * gy; k++) start[k + 1] += start[k];
    const refs = new Ref(start[gx * gy]);
    const big = new Ref(bigCount);
    const fill = start.slice(0, gx * gy);
    let bigAt = 0;
    for (let t = 0; t < triCount; t++) {
        const r = t * 4;
        if (range[r] < 0) { big[bigAt++] = t; continue; }
        for (let y = range[r + 2]; y <= range[r + 3]; y++) {
            for (let x = range[r]; x <= range[r + 1]; x++) refs[fill[y * gx + x]++] = t;
        }
    }
    return { box, minX, minY, cell, gx, gy, start, refs, big, seen: new Uint32Array(triCount), query: 0, triangles: triCount };
}

/* 线段 o + d·t（t∈[t0,t1]）与轴对齐包围盒 [minX,minY,minZ,maxX,maxY,maxZ] 的交段，
   相交时把交段写入 out[0..1] 并返回 true。 */
export function clipSegmentToBox(box, ox, oy, oz, dx, dy, dz, t0, t1, out) {
    const o = [ox, oy, oz], d = [dx, dy, dz];
    for (let k = 0; k < 3; k++) {
        const lo = box[k], hi = box[k + 3];
        if (Math.abs(d[k]) < 1e-12) {
            if (o[k] < lo || o[k] > hi) return false;
            continue;
        }
        let ta = (lo - o[k]) / d[k], tb = (hi - o[k]) / d[k];
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) return false;
    }
    if (out) { out[0] = t0; out[1] = t1; }
    return true;
}

/* 双面 Möller–Trumbore；返回 [near, best) 内的命中 t，否则返回 best。 */
function hitTriangle(position, index, t, ox, oy, oz, dx, dy, dz, near, best) {
    const a = index[t * 3] * 3, b = index[t * 3 + 1] * 3, c = index[t * 3 + 2] * 3;
    const ax = position[a], ay = position[a + 1], az = position[a + 2];
    const e1x = position[b] - ax, e1y = position[b + 1] - ay, e1z = position[b + 2] - az;
    const e2x = position[c] - ax, e2y = position[c + 1] - ay, e2z = position[c + 2] - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -DET_EPSILON && det < DET_EPSILON) return best;
    const inv = 1 / det;
    const sx = ox - ax, sy = oy - ay, sz = oz - az;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) return best;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) return best;
    const hit = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return hit >= near && hit < best ? hit : best;
}

const _clip = new Float64Array(2);

/**
 * 射线 o + d·t 与网格内三角形的最近交点（d 不要求单位长度，t 以 d 的长度为单位）。
 * @returns {number} 命中的 t；[near, far] 内无命中时返回 Infinity
 */
export function raycastRayGrid(grid, position, index, ox, oy, oz, dx, dy, dz, near, far) {
    if (!(far >= near) || !clipSegmentToBox(grid.box, ox, oy, oz, dx, dy, dz, near, far, _clip)) return Infinity;
    const t0 = _clip[0], t1 = _clip[1];
    if (++grid.query >= 0xffffffff) { grid.seen.fill(0); grid.query = 1; }
    const stamp = grid.query, seen = grid.seen, refs = grid.refs, start = grid.start;
    let best = far + 1e-9;
    for (let i = 0; i < grid.big.length; i++) best = hitTriangle(position, index, grid.big[i], ox, oy, oz, dx, dy, dz, near, best);

    const { minX, minY, cell, gx, gy } = grid;
    const px = ox + dx * t0, py = oy + dy * t0;
    let ix = Math.min(gx - 1, Math.max(0, Math.floor((px - minX) / cell)));
    let iy = Math.min(gy - 1, Math.max(0, Math.floor((py - minY) / cell)));
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0, stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    let tMaxX = stepX ? (minX + (ix + (stepX > 0 ? 1 : 0)) * cell - ox) / dx : Infinity;
    let tMaxY = stepY ? (minY + (iy + (stepY > 0 ? 1 : 0)) * cell - oy) / dy : Infinity;
    const tDeltaX = stepX ? cell / Math.abs(dx) : Infinity, tDeltaY = stepY ? cell / Math.abs(dy) : Infinity;
    for (;;) {
        const k = iy * gx + ix;
        for (let r = start[k], end = start[k + 1]; r < end; r++) {
            const t = refs[r];
            if (seen[t] === stamp) continue;
            seen[t] = stamp;
            best = hitTriangle(position, index, t, ox, oy, oz, dx, dy, dz, near, best);
        }
        const exit = Math.min(tMaxX, tMaxY, t1);
        if (best <= exit || exit >= t1) break;
        if (tMaxX < tMaxY) { ix += stepX; tMaxX += tDeltaX; if (ix < 0 || ix >= gx) break; }
        else { iy += stepY; tMaxY += tDeltaY; if (iy < 0 || iy >= gy) break; }
    }
    return best <= far ? best : Infinity;
}
