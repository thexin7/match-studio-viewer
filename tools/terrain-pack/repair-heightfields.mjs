import { chunkPositions, canonicalize } from './pack.mjs';

// These imported landscapes use 64×64 samples, a 2 m pitch and 126 m tiles.
// Buildings are not heightfields: only the regular grid triangles are selected.
const CELLS = 63, STEP = 2, EPS = .008;
function grids(chunk) {
  const p = chunkPositions([chunk]), groups = new Map();
  for (let i = 0; i < chunk.index.length; i += 3) {
    const a = chunk.index[i] * 3, b = chunk.index[i + 1] * 3, c = chunk.index[i + 2] * 3;
    const x = [p[a], p[b], p[c]], y = [p[a + 1], p[b + 1], p[c + 1]];
    if (x.some(v => Math.abs(v - Math.round(v / STEP) * STEP) > EPS) || y.some(v => Math.abs(v - Math.round(v / STEP) * STEP) > EPS)) continue;
    if (Math.abs(Math.max(...x) - Math.min(...x) - STEP) > EPS || Math.abs(Math.max(...y) - Math.min(...y) - STEP) > EPS) continue;
    if (Math.abs(Math.abs((x[1] - x[0]) * (y[2] - y[0]) - (y[1] - y[0]) * (x[2] - x[0])) - STEP * STEP) > .03) continue;
    const gx = Math.floor((x[0] + x[1] + x[2]) / (3 * STEP * CELLS)) * CELLS;
    const gy = Math.floor((y[0] + y[1] + y[2]) / (3 * STEP * CELLS)) * CELLS;
    const key = `${gx},${gy}`;
    if (!groups.has(key)) groups.set(key, { gx, gy, triangles: [], vertices: new Set() });
    const group = groups.get(key);group.triangles.push(i);
    group.vertices.add(a / 3);group.vertices.add(b / 3);group.vertices.add(c / 3);
  }
  return { position: p, groups: [...groups.values()].filter(g => g.triangles.length >= 128 && g.vertices.size <= 4096) };
}

export function terrainSeamReport(chunks) {
  const borders = new Map();let tiles = 0;
  for (const chunk of chunks) {
    const { position: p, groups } = grids(chunk);
    for (const g of groups) {
      tiles++;
      for (const v of g.vertices) {
        const x = Math.round(p[v * 3] / STEP), y = Math.round(p[v * 3 + 1] / STEP);
        if (x !== g.gx && x !== g.gx + CELLS && y !== g.gy && y !== g.gy + CELLS) continue;
        const key = `${x},${y}`, tile = `${g.gx},${g.gy}`;
        if (!borders.has(key)) borders.set(key, new Map());
        borders.get(key).set(tile, p[v * 3 + 2]);
      }
    }
  }
  const gaps = [];
  for (const values of borders.values()) if (values.size > 1) gaps.push(Math.max(...values.values()) - Math.min(...values.values()));
  gaps.sort((a,b) => a - b);
  return { tiles, samples: gaps.length, median: gaps[Math.floor(gaps.length / 2)] || 0,
    mean: gaps.length ? gaps.reduce((a,b) => a + b, 0) / gaps.length : 0, max: gaps.at(-1) || 0,
    above5cm: gaps.filter(v => v > .05).length };
}

function weldResidualBorders(chunks) {
  const borders = new Map(), changed = new Map();let points = 0, maxAdjustment = 0;
  for (const ch of chunks) {
    if (!ch.repairGrid) continue;
    const [gx,gy] = ch.repairGrid, p = chunkPositions([ch]);
    for (let v = 0; v < ch.q.length / 3; v++) {
      const x = Math.round(p[v*3]/STEP), y = Math.round(p[v*3+1]/STEP);
      if (x !== gx && x !== gx+CELLS && y !== gy && y !== gy+CELLS) continue;
      const key = `${x},${y}`;if (!borders.has(key)) borders.set(key, []);
      borders.get(key).push({ ch, v, z: p[v*3+2] });
    }
  }
  for (const entries of borders.values()) {
    if (entries.length < 2) continue;
    const zs = entries.map(e=>e.z), gap = Math.max(...zs)-Math.min(...zs);
    // Only stitch residual discontinuities of the same landscape sample after
    // orientation recovery. Large gaps may represent missing source geometry.
    if (gap <= .005 || gap > .75) continue;
    const mean = zs.reduce((a,b)=>a+b,0)/zs.length;points++;
    for (const e of entries) {
      if (!changed.has(e.ch)) changed.set(e.ch, new Map());changed.get(e.ch).set(e.v, mean);
      maxAdjustment = Math.max(maxAdjustment, Math.abs(e.z-mean));
    }
  }
  for (const [ch, changes] of changed) {
    if (ch.affine[4] || ch.affine[6]) throw new Error('高度网格高度轴存在旋转，不进行边界焊接');
    const heights = Float64Array.from({length:ch.q.length/3},(_,v)=>changes.get(v) ?? (ch.affine[5]*ch.q[v*3+1]+ch.affine[7]));
    let lo=Infinity,hi=-Infinity;for(const z of heights){lo=Math.min(lo,z);hi=Math.max(hi,z);}
    const center=(lo+hi)/2,scale=(hi-lo)/65534 || 1;
    ch.affine[5]=scale;ch.affine[7]=center;
    for(let v=0;v<heights.length;v++)ch.q[v*3+1]=Math.round((heights[v]-center)/scale);
  }
  return { points, maxAdjustment };
}

export function repairHeightfields(chunks) {
  const before = terrainSeamReport(chunks);
  if (before.mean < .01 || before.samples < 64) return { chunks, before, after: before, repairedTiles: 0 };
  const result = [];let repairedTiles = 0;
  for (const chunk of chunks) {
    const { groups } = grids(chunk);
    if (!groups.length) { result.push(chunk);continue; }
    const selected = new Uint8Array(chunk.index.length / 3);
    for (const g of groups) {
      const index = new Uint32Array(g.triangles.length * 3);let at = 0;
      for (const i of g.triangles) {
        selected[i / 3] = 1;
        // XY transpose is a reflection; reverse winding to preserve the face normal.
        index[at++] = chunk.index[i];index[at++] = chunk.index[i + 2];index[at++] = chunk.index[i + 1];
      }
      const m = chunk.affine, affine = m.slice(), delta = (g.gx - g.gy) * STEP;
      // GLB uses [world X, height, -world Y]. Keep the original quantized
      // samples and heights; correcting the node transform avoids re-quantization.
      for (let k = 0; k < 3; k++) { affine[k] = -m[8 + k];affine[8 + k] = -m[k]; }
      affine[3] = delta - m[11];affine[11] = delta - m[3];
      const compact = canonicalize([{ ...chunk, name: `${chunk.name}-heightfield`, index, affine }])[0];
      compact.repairGrid = [g.gx,g.gy];result.push(compact);repairedTiles++;
    }
    const remaining = [];
    for (let i = 0; i < chunk.index.length; i += 3) if (!selected[i / 3]) remaining.push(chunk.index[i], chunk.index[i + 1], chunk.index[i + 2]);
    if (remaining.length) result.push(...canonicalize([{ ...chunk, index: Uint32Array.from(remaining) }]));
  }
  const welded = weldResidualBorders(result), after = terrainSeamReport(result);
  if (after.samples < before.samples * .5 || after.mean > before.mean * .1) throw new Error('高度网格校正未通过接缝验证，不输出资源');
  return { chunks: result, before, after, repairedTiles, welded };
}
