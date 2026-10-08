import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRayGrid, raycastRayGrid, clipSegmentToBox } from '../m3d/map-raycast.js';

// 确定性随机数，失败时可复现
function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// 小三角形 + 少量跨很多格的大三角形 + 竖直墙，混合成类似地图块的数据
function makeSoup(seed, count) {
    const rand = rng(seed), pos = [], idx = [];
    const tri = (a, b, c) => { const n = pos.length / 3; pos.push(...a, ...b, ...c); idx.push(n, n + 1, n + 2); };
    for (let i = 0; i < count; i++) {
        const x = rand() * 80 - 40, y = rand() * 60 - 30, z = rand() * 12;
        const s = rand() < 0.03 ? 30 : 0.5 + rand() * 2;
        if (rand() < 0.4) tri([x, y, z], [x + s, y + s * (rand() - 0.5), z], [x, y, z + s]);   // 竖直面
        else tri([x, y, z], [x + s, y, z + (rand() - 0.5)], [x, y + s, z + (rand() - 0.5)]);
    }
    return { position: new Float32Array(pos), index: Uint32Array.from(idx) };
}

function brute(position, index, o, d, near, far) {
    let best = Infinity;
    for (let t = 0; t < index.length / 3; t++) {
        const p = k => [position[index[t * 3 + k] * 3], position[index[t * 3 + k] * 3 + 1], position[index[t * 3 + k] * 3 + 2]];
        const [a, b, c] = [p(0), p(1), p(2)];
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const pv = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
        const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
        if (Math.abs(det) < 1e-12) continue;
        const s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
        const u = (s[0] * pv[0] + s[1] * pv[1] + s[2] * pv[2]) / det;
        if (u < 0 || u > 1) continue;
        const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
        const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
        if (v < 0 || u + v > 1) continue;
        const hit = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
        if (hit >= near && hit <= far && hit < best) best = hit;
    }
    return best;
}

test('grid raycast matches brute force on mixed geometry, including vertical and axis-aligned rays', () => {
    const { position, index } = makeSoup(7, 6000);
    const grid = buildRayGrid(position, index);
    assert.ok(grid.big.length > 0, '应有跨格大三角形走 big 列表');
    const rand = rng(99);
    let hits = 0;
    for (let i = 0; i < 3000; i++) {
        const o = [rand() * 100 - 50, rand() * 80 - 40, rand() * 16 - 2];
        let d = [rand() - 0.5, rand() - 0.5, rand() - 0.5];
        if (i % 10 === 0) d = [0, 0, rand() < 0.5 ? 1 : -1];        // 竖直：DDA 只在一格内
        if (i % 10 === 1) d = [1, 0, 0];                              // 沿格线方向
        const len = Math.hypot(...d); d = d.map(v => v / len);
        const near = 0.05, far = 2 + rand() * 40;
        const want = brute(position, index, o, d, near, far);
        const got = raycastRayGrid(grid, position, index, ...o, ...d, near, far);
        if (want === Infinity) assert.equal(got, Infinity, `射线 ${i}`);
        else { hits++; assert.ok(Math.abs(got - want) < 1e-6, `射线 ${i}: ${got} != ${want}`); }
    }
    assert.ok(hits > 300, '样本里应有足够多的命中');
});

test('grid raycast handles Uint16 indices and single-triangle chunks', () => {
    const position = new Float32Array([0, -1, -1, 0, 1, -1, 0, 0, 2]);
    const index = new Uint16Array([0, 1, 2]);
    const grid = buildRayGrid(position, index);
    assert.ok(Math.abs(raycastRayGrid(grid, position, index, -3, 0, 0, 1, 0, 0, 0.05, 10) - 3) < 1e-9);
    assert.ok(Math.abs(raycastRayGrid(grid, position, index, 3, 0, 0, -1, 0, 0, 0.05, 10) - 3) < 1e-9, '双面命中');
    assert.equal(raycastRayGrid(grid, position, index, -3, 0, 0, 1, 0, 0, 0.05, 2.9), Infinity, '超出 far 不算命中');
    assert.equal(raycastRayGrid(grid, position, index, -3, 0, 0, -1, 0, 0, 0.05, 10), Infinity, '背向射线');
});

test('segment box clipping rejects misses and returns the overlap', () => {
    const out = new Float64Array(2), box = [0, 0, 0, 1, 1, 1];
    assert.equal(clipSegmentToBox(box, -1, 0.5, 0.5, 1, 0, 0, 0, 10, out), true);
    assert.deepEqual([...out], [1, 2]);
    assert.equal(clipSegmentToBox(box, -1, 0.5, 0.5, 1, 0, 0, 0, 0.5, out), false);
    assert.equal(clipSegmentToBox(box, -1, 2, 0.5, 1, 0, 0, 0, 10, out), false);
});
