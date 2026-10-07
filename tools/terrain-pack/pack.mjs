// 读取现有地形 GLB、规范化为按块的量化网格、编码 MSTP 载荷，以及按 GLB 客户端路径计算参考坐标。
import { PACK_MAGIC, PACK_VERSION, CHUNK_HEADER_BYTES } from '../../m3d/terrain-packed.js';

/** 解析项目自用的最小 GLB：每个带 mesh 的节点取 primitives[0] 的 int16 POSITION 与 uint16/uint32 索引。 */
export function readGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('不是 GLB 文件');
  let off = 12, json = null, binOff = -1, binLen = 0;
  while (off + 8 <= buf.length) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    if (type === 0x4e4f534a) json = JSON.parse(buf.toString('utf8', off + 8, off + 8 + len));
    else if (type === 0x004e4942) { binOff = off + 8; binLen = len; }
    off += 8 + len;
  }
  if (!json || binOff < 0) throw new Error('GLB 缺少 JSON/BIN 块');
  const view = (ai, Ctor, comps) => {
    const a = json.accessors[ai], bv = json.bufferViews[a.bufferView];
    const start = binOff + (bv.byteOffset || 0) + (a.byteOffset || 0), bytes = a.count * comps * Ctor.BYTES_PER_ELEMENT;
    if (bv.byteStride && bv.byteStride !== comps * Ctor.BYTES_PER_ELEMENT) throw new Error('不支持交错的 bufferView');
    if (start + bytes > binOff + binLen) throw new Error('accessor 越界');
    // 拷贝一份：Buffer 的字节偏移不保证 2/4 字节对齐
    return new Ctor(buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + start + bytes));
  };
  const chunks = [];
  for (const nd of json.nodes || []) {
    if (nd.mesh == null) continue;
    const prim = json.meshes[nd.mesh].primitives[0];
    if ((prim.mode ?? 4) !== 4) throw new Error(`节点 ${nd.name} 不是三角形列表`);
    const pa = json.accessors[prim.attributes.POSITION], ia = json.accessors[prim.indices];
    if (pa.componentType !== 5122 || pa.type !== 'VEC3' || pa.normalized) throw new Error(`节点 ${nd.name} 的 POSITION 不是非归一化 int16（当前格式不支持）`);
    const IndexCtor = ia.componentType === 5123 ? Uint16Array : ia.componentType === 5125 ? Uint32Array : null;
    if (!IndexCtor) throw new Error(`节点 ${nd.name} 的索引类型 ${ia.componentType} 不支持`);
    const m = nd.matrix || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    if (m[3] || m[7] || m[11] || m[15] !== 1) throw new Error(`节点 ${nd.name} 的矩阵含投影分量`);
    // 行主序 3×4：与 Matrix4.applyMatrix4 的 e[0]*x+e[4]*y+e[8]*z+e[12] 一一对应
    const affine = Float64Array.of(m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14]);
    chunks.push({ name: nd.name || '', q: view(prim.attributes.POSITION, Int16Array, 3), index: view(prim.indices, IndexCtor, 1), affine });
  }
  return { json, chunks };
}

/** 按首次使用重排顶点、丢弃未引用顶点；三角形顺序与角点顺序保持不变。 */
export function canonicalize(chunks) {
  return chunks.map(ch => {
    const n = ch.q.length / 3, remap = new Int32Array(n).fill(-1), order = [];
    const index = new Uint32Array(ch.index.length);
    for (let k = 0; k < ch.index.length; k++) {
      const i = ch.index[k];
      if (i >= n) throw new Error(`块 ${ch.name} 索引越界 ${i}/${n}`);
      if (remap[i] < 0) { remap[i] = order.length; order.push(i); }
      index[k] = remap[i];
    }
    const q = new Int16Array(order.length * 3);
    for (let v = 0; v < order.length; v++) { const s = order[v] * 3; q[v * 3] = ch.q[s]; q[v * 3 + 1] = ch.q[s + 1]; q[v * 3 + 2] = ch.q[s + 2]; }
    return { name: ch.name, q, index, affine: ch.affine, dropped: n - order.length };
  });
}

/** 与 korr-adapter 的 GLB 路径相同的换算：仿射到 glTF 米制，再转 three（x, −z, y），落到 Float32。 */
export function chunkPositions(chunks) {
  let total = 0;
  for (const ch of chunks) total += ch.q.length / 3;
  const out = new Float32Array(total * 3);
  let v = 0;
  for (const ch of chunks) {
    const m = ch.affine, q = ch.q;
    for (let n = 0; n < q.length; n += 3, v++) {
      const x = q[n], y = q[n + 1], z = q[n + 2];
      out[v * 3] = m[0] * x + m[1] * y + m[2] * z + m[3];
      out[v * 3 + 1] = -(m[8] * x + m[9] * y + m[10] * z + m[11]);
      out[v * 3 + 2] = m[4] * x + m[5] * y + m[6] * z + m[7];
    }
  }
  return out;
}

export function chunkIndices(chunks) {
  let total = 0;
  for (const ch of chunks) total += ch.index.length;
  const out = new Uint32Array(total);
  let at = 0, base = 0;
  for (const ch of chunks) { for (let k = 0; k < ch.index.length; k++) out[at++] = base + ch.index[k]; base += ch.q.length / 3; }
  return out;
}

/** bake 为逐顶点交错 [R,G]（规范化后的顶点顺序），可为 null。 */
export function encodePack(chunks, bake, meta) {
  let verts = 0, indices = 0;
  for (const ch of chunks) { verts += ch.q.length / 3; indices += ch.index.length; }
  const metaBytes = Buffer.from(JSON.stringify(meta || {}), 'utf8');
  const head = 28 + ((metaBytes.length + 3) & ~3) + chunks.length * CHUNK_HEADER_BYTES;
  // 索引变长码：先按最坏 3 字节/个预留，写完再截断
  const idx = new Uint8Array(indices * 3);
  let ip = 0;
  for (const ch of chunks) {
    let hwm = 0;
    for (let k = 0; k < ch.index.length; k++) {
      const i = ch.index[k];
      let code;
      if (i === hwm) { code = 0; hwm++; } else { code = hwm - i; if (code <= 0) throw new Error('顶点未按首次使用排序'); }
      while (code >= 128) { idx[ip++] = (code & 127) | 128; code >>>= 7; }
      idx[ip++] = code;
    }
  }
  const total = head + verts * 6 + 4 + ip + (bake ? verts * 2 : 0);
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, PACK_MAGIC, true); dv.setUint32(4, PACK_VERSION, true); dv.setUint32(8, bake ? 1 : 0, true);
  dv.setUint32(12, chunks.length, true); dv.setUint32(16, verts, true); dv.setUint32(20, indices, true); dv.setUint32(24, metaBytes.length, true);
  out.set(metaBytes, 28);
  let at = 28 + ((metaBytes.length + 3) & ~3);
  for (const ch of chunks) {
    dv.setUint32(at, ch.q.length / 3, true); dv.setUint32(at + 4, ch.index.length, true);
    for (let k = 0; k < 12; k++) dv.setFloat64(at + 8 + k * 8, ch.affine[k], true);
    at += CHUNK_HEADER_BYTES;
  }
  // 位置：块内差分 → zigzag → 低/高字节分平面，gzip 对同类字节聚在一起的数据压得更好
  let v = 0;
  for (const ch of chunks) {
    const q = ch.q;
    let px = 0, py = 0, pz = 0;
    for (let n = 0; n < q.length; n += 3, v++) {
      const put = (prev, cur, plane) => {
        const d = (((cur - prev) + 32768) & 0xffff) - 32768;
        const z = ((d << 1) ^ (d >> 15)) & 0xffff;
        out[at + plane * 2 * verts + v] = z & 255; out[at + (plane * 2 + 1) * verts + v] = z >>> 8;
      };
      put(px, q[n], 0); put(py, q[n + 1], 1); put(pz, q[n + 2], 2);
      px = q[n]; py = q[n + 1]; pz = q[n + 2];
    }
  }
  at += verts * 6;
  dv.setUint32(at, ip, true); at += 4;
  out.set(idx.subarray(0, ip), at); at += ip;
  if (bake) {
    let vv = 0;
    for (const ch of chunks) {
      let r = 0, g = 0;
      for (let n = 0; n < ch.q.length / 3; n++, vv++) {
        const R = bake[vv * 2], G = bake[vv * 2 + 1];
        out[at + vv] = (R - r) & 255; out[at + verts + vv] = (G - g) & 255; r = R; g = G;
      }
    }
    at += verts * 2;
  }
  if (at !== total) throw new Error(`编码长度不符 ${at}/${total}`);
  return { payload: out, verts, indices, indexBytes: ip };
}
