// Write aligned quantized geometry. Padding VEC3 int16 to 8 bytes per vertex
// satisfies glTF vertex alignment while retaining every authored coordinate.
export function writeGlb(chunks) {
  const json = { asset: { version: '2.0', generator: 'match-studio-terrain-repair' }, extensionsUsed: ['KHR_mesh_quantization'], extensionsRequired: ['KHR_mesh_quantization'],
    scene: 0, scenes: [{ nodes: chunks.map((_, i) => i) }], nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [] };
  const blocks = [];let offset = 0;
  const add = (data, target, stride) => {
    const view = json.bufferViews.length;json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length, target, ...(stride ? { byteStride: stride } : {}) });
    blocks.push(data);offset += data.length;const pad = (4 - data.length % 4) % 4;if (pad) { blocks.push(Buffer.alloc(pad));offset += pad; }return view;
  };
  for (const [i, ch] of chunks.entries()) {
    const count = ch.q.length / 3, pos = Buffer.alloc(count * 8), lo = [32767,32767,32767], hi = [-32768,-32768,-32768];
    for (let v = 0; v < count; v++) for (let k = 0; k < 3; k++) { const n = ch.q[v * 3 + k];pos.writeInt16LE(n, v * 8 + k * 2);lo[k] = Math.min(lo[k], n);hi[k] = Math.max(hi[k], n); }
    const position = json.accessors.length;
    json.accessors.push({ bufferView: add(pos, 34962, 8), componentType: 5122, count, type: 'VEC3', min: lo, max: hi });
    const small = count <= 65535, bytes = small ? 2 : 4, ix = Buffer.alloc(ch.index.length * bytes);
    for (let k = 0; k < ch.index.length; k++) { if (small) ix.writeUInt16LE(ch.index[k], k * bytes);else ix.writeUInt32LE(ch.index[k], k * bytes); }
    const index = json.accessors.length;
    json.accessors.push({ bufferView: add(ix, 34963), componentType: small ? 5123 : 5125, count: ch.index.length, type: 'SCALAR' });
    json.meshes.push({ name: ch.name, primitives: [{ attributes: { POSITION: position }, indices: index, mode: 4 }] });
    const m = ch.affine;
    json.nodes.push({ name: ch.name, mesh: i, matrix: [m[0],m[4],m[8],0,m[1],m[5],m[9],0,m[2],m[6],m[10],0,m[3],m[7],m[11],1] });
  }
  json.buffers.push({ byteLength: offset });
  let text = Buffer.from(JSON.stringify(json));text = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 32)]);
  const header = Buffer.alloc(20), binHeader = Buffer.alloc(8);header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);header.writeUInt32LE(28+text.length+offset,8);header.writeUInt32LE(text.length,12);header.writeUInt32LE(0x4e4f534a,16);
  binHeader.writeUInt32LE(offset);binHeader.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([header,text,binHeader,...blocks]);
}
