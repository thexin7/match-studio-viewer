import { MeshoptSimplifier } from 'meshoptimizer';
import { chunkPositions } from './pack.mjs';

// 只离线运行。保留原顶点坐标、拓扑边界和与顶点绑定的 AO/天空可见度。
export async function simplifyTerrain(chunks, bake, { ratio = 0.5, errorMeters = 0.05 } = {}) {
  if (!(ratio > 0 && ratio <= 1) || !(errorMeters >= 0 && Number.isFinite(errorMeters))) throw new Error('无效简化参数');
  const sourceVertices = chunks.reduce((n, ch) => n + ch.q.length / 3, 0);
  if (bake && bake.length !== sourceVertices * 2) throw new Error('烘焙数据与顶点数量不匹配');
  await MeshoptSimplifier.ready;
  const result = [], outBake = bake ? new Uint8Array(bake.length) : null;
  let oldBase = 0, newBase = 0, maxError = 0;
  for (const ch of chunks) {
    const target = Math.floor(ch.index.length * ratio / 3) * 3;
    const position = chunkPositions([ch]);
    const attributes = bake ? Float32Array.from(bake.subarray(oldBase * 2, (oldBase + ch.q.length / 3) * 2), v => v / 255) : null;
    const [reduced, error] = attributes
      ? MeshoptSimplifier.simplifyWithAttributes(ch.index, position, 3, attributes, 2, [1, 1], null, target, errorMeters, ['LockBorder', 'ErrorAbsolute'])
      : MeshoptSimplifier.simplify(ch.index, position, 3, target, errorMeters, ['LockBorder', 'ErrorAbsolute']);
    maxError = Math.max(maxError, error);
    const remap = new Int32Array(ch.q.length / 3).fill(-1), order = [], index = new Uint32Array(reduced.length);
    for (let i = 0; i < reduced.length; i++) {
      const v = reduced[i];
      if (remap[v] < 0) { remap[v] = order.length; order.push(v); }
      index[i] = remap[v];
    }
    const q = new Int16Array(order.length * 3);
    for (let v = 0; v < order.length; v++) {
      const src = order[v];
      q.set(ch.q.subarray(src * 3, src * 3 + 3), v * 3);
      if (outBake) outBake.set(bake.subarray((oldBase + src) * 2, (oldBase + src) * 2 + 2), (newBase + v) * 2);
    }
    result.push({ ...ch, q, index });
    oldBase += ch.q.length / 3; newBase += order.length;
  }
  return { chunks: result, bake: outBake?.slice(0, newBase * 2) || null, maxError };
}
