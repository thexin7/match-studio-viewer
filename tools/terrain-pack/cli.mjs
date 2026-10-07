#!/usr/bin/env node
// 地形离线打包：GLB → MSTP（块内 int16 差分 + 首次使用索引变长码 + gzip）+ 逐顶点 AO / 天空可见度烘焙。
// 本仓库约定不引入原生代码，因此用 Node 内置 zlib / worker_threads 实现，零依赖。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readGlb, canonicalize, chunkPositions, chunkIndices, encodePack } from './pack.mjs';
import { bakeTerrain } from './bake.mjs';
import { upsertPacked } from './manifest.mjs';
import { decodeTerrainPack, gunzipIfNeeded } from '../../m3d/terrain-packed.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELP = `用法: node tools/terrain-pack/cli.mjs [选项] <地图key | GLB 路径>...

把 m3d/*.glb 打成更小的 .tpk（MSTP v1，gzip），可选烘焙逐顶点 AO 与天空可见度，
解码回读校验坐标与原 GLB 逐角点一致，并把 packed 字段追加到 manifest。

选项:
  --all                 处理 manifest 中的全部地图
  --manifest <路径>     默认 m3d/manifest.json
  --out-dir <目录>      输出目录，默认与 GLB 同目录
  --no-bake             不烘焙（客户端没有 bake 属性，渲染照旧）
  --rays <n>            每侧 AO 射线数，默认 12（双面几何两侧都打）
  --ao-dist <米>        AO 最大距离，默认 10
  --sky-dist <米>       天空可见度射线长度，默认 400
  --threads <n>         烘焙线程数，默认 CPU 逻辑核数 - 1
  --level <0-9>         gzip 级别，默认 9
  --no-manifest         不写回 manifest
  -h, --help            显示帮助

输出: stdout 打印 JSON 汇总（体积、耗时、最大坐标误差、bake 统计）；进度日志写 stderr。
退出码: 0 = 成功；1 = 处理或校验失败；2 = 参数错误。`;

const log = msg => process.stderr.write(`[terrain-pack] ${msg}\n`);

function parseArgs(argv) {
  const opt = { all: false, manifest: path.join(ROOT, 'm3d/manifest.json'), outDir: '', bake: true, rays: 12, aoDist: 10,
    skyDist: 400, threads: 0, level: 9, writeManifest: true, targets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(`${a} 缺少参数值`); return argv[++i]; };
    const num = (name, x, lo, hi) => { const n = Number(x); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} 取值应在 ${lo}~${hi}`); return n; };
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a === '--all') opt.all = true;
    else if (a === '--manifest') opt.manifest = path.resolve(v());
    else if (a === '--out-dir') opt.outDir = path.resolve(v());
    else if (a === '--no-bake') opt.bake = false;
    else if (a === '--rays') opt.rays = num('--rays', v(), 4, 256) | 0;
    else if (a === '--ao-dist') opt.aoDist = num('--ao-dist', v(), 0.5, 100);
    else if (a === '--sky-dist') opt.skyDist = num('--sky-dist', v(), 5, 5000);
    else if (a === '--threads') opt.threads = num('--threads', v(), 1, 1024) | 0;
    else if (a === '--level') opt.level = num('--level', v(), 0, 9) | 0;
    else if (a === '--no-manifest') opt.writeManifest = false;
    else if (a.startsWith('-')) throw new Error(`未知参数: ${a}`);
    else opt.targets.push(a);
  }
  if (!opt.all && !opt.targets.length) throw new Error('需要地图 key、GLB 路径或 --all');
  return opt;
}

function resolveJobs(opt, manifest) {
  const maps = manifest?.maps || {};
  const keys = opt.all ? Object.keys(maps) : opt.targets;
  return keys.map(t => {
    if (maps[t]) return { key: t, rec: maps[t], glb: path.join(path.dirname(opt.manifest), maps[t].file) };
    const glb = path.resolve(t);
    const key = Object.keys(maps).find(k => path.basename(glb) === maps[k].file);
    return { key: key || path.basename(glb).split('.')[0], rec: key ? maps[key] : null, glb };
  });
}

async function processMap(job, opt) {
  const t0 = Date.now();
  if (!fs.existsSync(job.glb)) throw new Error(`找不到 GLB: ${job.glb}`);
  const buf = fs.readFileSync(job.glb);
  log(`${job.key}: 读取 ${path.basename(job.glb)} ${(buf.length / 1048576).toFixed(1)}MB`);
  const src = readGlb(buf);
  const chunks = canonicalize(src.chunks);
  const position = chunkPositions(chunks), index = chunkIndices(chunks);
  const dropped = chunks.reduce((s, c) => s + c.dropped, 0);
  log(`${job.key}: ${chunks.length} 块，${position.length / 3} 顶点（丢弃未引用 ${dropped}），${index.length / 3} 三角形`);

  let bake = null, bakeStats = null;
  if (opt.bake) {
    log(`${job.key}: 烘焙 AO（每侧 ${opt.rays} 射线，${opt.aoDist}m）与天空可见度（${opt.skyDist}m）`);
    ({ bake, stats: bakeStats } = await bakeTerrain(position, index, opt, log));
    log(`${job.key}: 烘焙完成 ${bakeStats.seconds}s，R 均值 ${bakeStats.R.mean}，G 均值 ${bakeStats.G.mean}`);
  }
  const meta = { key: job.key, src: path.basename(job.glb), src_rev: job.rec?.rev || null, generator: 'tools/terrain-pack',
    bake: bakeStats ? { rays_per_side: opt.rays, ao_dist_m: opt.aoDist, sky_dist_m: opt.skyDist } : null };
  const enc = encodePack(chunks, bake, meta);
  const t1 = Date.now();
  const gz = zlib.gzipSync(enc.payload, { level: opt.level, memLevel: 9 });
  log(`${job.key}: 载荷 ${(enc.payload.length / 1048576).toFixed(1)}MB → gzip ${(gz.length / 1048576).toFixed(1)}MB（${((Date.now() - t1) / 1000).toFixed(1)}s）`);

  // 往返校验：用浏览器同一份解码代码回读，逐三角形角点对比原 GLB 路径的坐标
  const t2 = Date.now();
  const dec = decodeTerrainPack(await gunzipIfNeeded(gz));
  const refPos = chunkPositions(src.chunks), refIdx = chunkIndices(src.chunks);
  if (dec.index.length !== refIdx.length) throw new Error(`校验失败：索引数 ${dec.index.length} ≠ ${refIdx.length}`);
  let maxErr = 0, mismatched = 0;
  for (let k = 0; k < refIdx.length; k++) {
    const a = dec.index[k] * 3, b = refIdx[k] * 3;
    const e = Math.max(Math.abs(dec.position[a] - refPos[b]), Math.abs(dec.position[a + 1] - refPos[b + 1]), Math.abs(dec.position[a + 2] - refPos[b + 2]));
    if (e > maxErr) maxErr = e;
    if (e > 0) mismatched++;
  }
  if (bake) for (let i = 0; i < bake.length; i++) if (dec.bake[i] !== bake[i]) throw new Error(`校验失败：bake 第 ${i} 字节不一致`);
  if (!(maxErr <= 1e-3)) throw new Error(`校验失败：最大坐标误差 ${maxErr}m`);
  log(`${job.key}: 回读校验通过，最大误差 ${maxErr}m，不一致角点 ${mismatched}（${Date.now() - t2}ms）`);

  const outDir = opt.outDir || path.dirname(job.glb);
  const file = path.basename(job.glb).replace(/\.glb$/i, '') + '.tpk';
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, file), gz);
  const rev = crypto.createHash('sha1').update(gz).digest('hex').slice(0, 16);
  const packed = { file, rev, src_rev: job.rec?.rev || null, format: 'mstp1', bytes: gz.length, raw: enc.payload.length,
    tris: dec.tris, verts: dec.verts, chunks: chunks.length, bake: !!bake };
  if (bakeStats) packed.bake_params = { rays_per_side: opt.rays, ao_dist_m: opt.aoDist, sky_dist_m: opt.skyDist };
  return { key: job.key, packed, summary: {
    key: job.key, glb_bytes: buf.length, packed_bytes: gz.length, ratio: +(gz.length / buf.length).toFixed(3), payload_bytes: enc.payload.length,
    index_varint_bytes: enc.indexBytes, verts: dec.verts, tris: dec.tris, dropped_unused_verts: dropped, chunks: chunks.length,
    max_error_m: maxErr, mismatched_corners: mismatched, seconds: +((Date.now() - t0) / 1000).toFixed(1), bake: bakeStats, out: path.join(outDir, file) } };
}

async function main() {
  let opt;
  try { opt = parseArgs(process.argv.slice(2)); }
  catch (e) { log(e.message); console.error('\n' + HELP); return 2; }
  let manifest = null;
  if (fs.existsSync(opt.manifest)) manifest = JSON.parse(fs.readFileSync(opt.manifest, 'utf8'));
  else if (opt.all || opt.writeManifest) { log(`找不到 manifest: ${opt.manifest}`); return 2; }
  const jobs = resolveJobs(opt, manifest);
  const results = [], failures = [];
  for (const job of jobs) {
    try {
      const r = await processMap(job, opt);
      results.push(r.summary);
      if (opt.writeManifest && manifest?.maps?.[r.key]) {
        // 每张图完成就写回：中途失败也不丢已完成的结果；写前重读，避免覆盖其他流程刚同步的改动
        const latest = fs.readFileSync(opt.manifest, 'utf8');
        fs.writeFileSync(opt.manifest, upsertPacked(latest, r.key, r.packed));
        log(`${r.key}: manifest 已追加 packed`);
      }
    } catch (e) {
      log(`${job.key}: 失败 — ${e.stack || e.message}`);
      failures.push({ key: job.key, error: String(e.message || e) });
    }
  }
  console.log(JSON.stringify({ ok: failures.length === 0, maps: results, failures }, null, 2));
  return failures.length ? 1 : 0;
}

main().then(code => { process.exitCode = code; }, e => { log(e.stack || String(e)); process.exitCode = 1; });
