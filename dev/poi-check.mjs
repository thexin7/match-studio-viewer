#!/usr/bin/env node
/**
 * 点位坐标自检：验证 m3d/poi-data.js 的 planeToWorld 是 index.html 中 worldToPlane 的逆。
 *   1. 从 index.html 原文提取 worldToPlane（以页面实现为准，不信任副本），对每张地图
 *      （rotate 0 / 90 / −90 都有）随机取世界点做 世界→平面→世界 往返，统计最大误差；
 *   2. 对每张图的目录 POI 做 平面→世界→平面 往返；
 *   3. map_markers.json 同时给了 UE x/y 与 lng/lat，用它核对反算结果与真实世界坐标的偏差。
 * 输出 JSON；任一误差超过阈值退出码 1，参数或文件错误退出码 2。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planeToWorld, worldToPlane as worldToPlaneCopy } from '../m3d/poi-data.js';

const HELP = `用法: node dev/poi-check.mjs [--samples N]
  --samples N   每张图随机往返的世界点数量，默认 2000
退出码: 0 = 全部通过；1 = 误差超阈值；2 = 参数或文件错误`;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUNDTRIP_CM = 0.01;     // 纯浮点往返：远小于 1cm
const MARKER_CM = 5;           // markers 的 lng/lat 只保留 6 位小数：约 0.06cm/单位，留足余量

function parseArgs(argv) {
    const opt = { samples: 2000 };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '-h' || argv[i] === '--help') { console.log(HELP); process.exit(0); }
        else if (argv[i] === '--samples') opt.samples = Number(argv[++i]);
        else throw new Error('未知参数: ' + argv[i]);
    }
    if (!(opt.samples > 0)) throw new Error('--samples 必须为正数');
    return opt;
}

function loadPageWorldToPlane() {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const m = /function worldToPlane\(wx, wy\) \{[\s\S]*?\n\}/.exec(html);
    if (!m) throw new Error('index.html 中找不到 worldToPlane');
    // 页面实现读全局 MAP_INFO；包一层把它变成参数
    return new Function('MAP_INFO', 'wx', 'wy', m[0] + '\nreturn worldToPlane(wx, wy);');
}

function main() {
    let opt;
    try { opt = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); console.error(HELP); return 2; }
    let pageW2P, catalog, markers;
    try {
        pageW2P = loadPageWorldToPlane();
        catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'map_catalog.json'), 'utf8'));
        markers = JSON.parse(fs.readFileSync(path.join(ROOT, 'map_markers.json'), 'utf8'));
    } catch (e) { console.error('读取失败:', e.message); return 2; }

    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const report = { ok: true, maps: [] };
    for (const info of catalog.maps || []) {
        const r = { key: info.key, rotate: Number(info.rotate || 0), worldRoundTripCm: 0, planeRoundTripCm: 0, copyMismatch: 0, pois: 0 };
        for (let i = 0; i < opt.samples; i++) {
            const wx = info.centerX + (rnd() - 0.5) * info.width * 2;
            const wy = -info.centerY + (rnd() - 0.5) * info.height * 2;
            const p = pageW2P(info, wx, wy);
            const q = worldToPlaneCopy(info, wx, wy);
            r.copyMismatch = Math.max(r.copyMismatch, Math.abs(p.lng - q.lng), Math.abs(p.lat - q.lat));
            const w = planeToWorld(info, p.lng, p.lat);
            r.worldRoundTripCm = Math.max(r.worldRoundTripCm, Math.hypot(w.x - wx, w.y - wy));
        }
        const bj = info.bj || 128, unitCm = Math.max(info.width, info.height) / bj;
        for (const poi of info.poi || []) {
            const w = planeToWorld(info, poi.lng, poi.lat);
            const p = pageW2P(info, w.x, w.y);
            // 平面误差换算成厘米，便于和世界往返放在同一量纲比较
            r.planeRoundTripCm = Math.max(r.planeRoundTripCm, Math.hypot(p.lng - poi.lng, p.lat - poi.lat) * unitCm);
            r.pois++;
        }
        if (r.worldRoundTripCm > ROUNDTRIP_CM || r.planeRoundTripCm > ROUNDTRIP_CM || r.copyMismatch > 1e-9) report.ok = false;
        report.maps.push(r);
    }
    const mInfo = (catalog.maps || []).find(m => m.key === markers.map);
    if (mInfo) {
        let maxCm = 0, n = 0;
        for (const level of markers.levels || []) for (const p of level.points || []) {
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
            const w = planeToWorld(mInfo, p.lng, p.lat);
            maxCm = Math.max(maxCm, Math.hypot(w.x - p.x, w.y - p.y));
            n++;
        }
        report.markers = { map: markers.map, points: n, maxErrorCm: Math.round(maxCm * 1000) / 1000, limitCm: MARKER_CM };
        if (maxCm > MARKER_CM) report.ok = false;
    }
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
}

process.exit(main());
