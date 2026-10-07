import * as THREE from 'three';

/* 官方 2D 底图 → 3D 地形投影纹理。
   只下载覆盖 3D 几何 XY 范围的瓦片，拼成一张 canvas 纹理（未下载到的瓦片保持透明，
   着色器按 alpha 回退到原色），并给出 three 世界 (x,y) → UV 的仿射矩阵（含 rotate）。

   坐标链（与 index.html worldToPlane 一致）：
     three (x,y) → UE (ux,uy) = (100x, −100y)
     UE → 平面 (lng,lat)，按 rotate 0 / 90 / −90 三支
     平面 → 缩放 z 下像素 (lng·2^z, −lat·2^z)（Leaflet CRS.Simple）
     像素 → canvas → UV（canvas 纹理 flipY，v = 1 − 行/高） */

let catalogPromise = null;
async function mapInfo(key) {
    if (!catalogPromise) {
        catalogPromise = fetch('/api/map', { cache: 'no-cache' })
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .catch(error => { catalogPromise = null; throw error; });
    }
    const catalog = await catalogPromise;
    const maps = Array.isArray(catalog?.maps) ? catalog.maps : Object.values(catalog?.maps || {});
    return maps.find(m => m && m.key === key) || null;
}

/* 平面坐标 (lng, lat) 关于 three (x, y) 的仿射系数：lng = a0 + ax·x + ay·y，lat = b0 + bx·x + by·y。 */
function planeAffine(info) {
    const bj = info.bj || 128, xB = info.width / bj, yB = info.height / bj;
    const cx = info.centerX, cy = info.centerY, r = Number(info.rotate || 0);
    if (r === 90) return { a0: bj - cy / yB, ax: 0, ay: 100 / yB, b0: -bj + cx / xB, bx: -100 / xB, by: 0 };
    if (r === -90) return { a0: bj + cy / yB, ax: 0, ay: -100 / yB, b0: -bj - cx / xB, bx: 100 / xB, by: 0 };
    return { a0: bj - cx / xB, ax: 100 / xB, ay: 0, b0: -bj - cy / yB, bx: 0, by: 100 / yB };
}

function loadTile(url, signal) {
    return fetch(url, { mode: 'cors', credentials: 'omit', signal })
        .then(r => (r.ok ? r.blob() : null))
        .then(blob => (blob ? createImageBitmap(blob) : null))
        .catch(error => { if (error?.name === 'AbortError') throw error; return null; });
}

/**
 * @param {string} key 地图 key（map_catalog 的 key）
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} bounds 3D 几何 XY 范围（three 坐标，米）
 * @param {{zoom:number,maxSize?:number,anisotropy?:number,concurrency?:number,signal?:AbortSignal}} opt
 * @returns {Promise<{texture:THREE.CanvasTexture,matrix:THREE.Matrix3,zoom:number,size:number[],tiles:number,loaded:number,ms:number}|null>}
 */
export async function buildMapTexture(key, bounds, opt) {
    const t0 = performance.now();
    const info = await mapInfo(key);
    if (!info?.tileUrl || !Number.isFinite(info.width) || !Number.isFinite(info.centerX)) return null;
    const T = info.tileSize || 256;
    const maxSize = Math.max(256, opt.maxSize || 4096);
    const f = planeAffine(info);
    let zoom = Math.min(opt.zoom, Number(info.maxNativeZoom) || opt.zoom);
    let s, px0, px1, py0, py1;
    for (;; zoom--) {
        s = 2 ** zoom;
        px0 = Infinity; px1 = -Infinity; py0 = Infinity; py1 = -Infinity;
        for (const x of [bounds.minX, bounds.maxX]) for (const y of [bounds.minY, bounds.maxY]) {
            const px = s * (f.a0 + f.ax * x + f.ay * y), py = -s * (f.b0 + f.bx * x + f.by * y);
            px0 = Math.min(px0, px); px1 = Math.max(px1, px); py0 = Math.min(py0, py); py1 = Math.max(py1, py);
        }
        // 官方瓦片只存在于 bounds 内（[[lat,lng],[lat,lng]]），超出部分无需请求
        const b = info.bounds;
        if (Array.isArray(b) && b.length === 2) {
            const lngMin = Math.min(b[0][1], b[1][1]), lngMax = Math.max(b[0][1], b[1][1]);
            const latMin = Math.min(b[0][0], b[1][0]), latMax = Math.max(b[0][0], b[1][0]);
            px0 = Math.max(px0, lngMin * s); px1 = Math.min(px1, lngMax * s);
            py0 = Math.max(py0, -latMax * s); py1 = Math.min(py1, -latMin * s);
        }
        px0 = Math.max(0, px0); py0 = Math.max(0, py0);
        if (!(px1 > px0 && py1 > py0)) return null;
        const w = (Math.floor((px1 - 1e-6) / T) - Math.floor(px0 / T) + 1) * T;
        const h = (Math.floor((py1 - 1e-6) / T) - Math.floor(py0 / T) + 1) * T;
        if ((w <= maxSize && h <= maxSize) || zoom <= 0) break;
    }
    const tx0 = Math.floor(px0 / T), tx1 = Math.floor((px1 - 1e-6) / T);
    const ty0 = Math.floor(py0 / T), ty1 = Math.floor((py1 - 1e-6) / T);
    const W = (tx1 - tx0 + 1) * T, H = (ty1 - ty0 + 1) * T;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const jobs = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
    let next = 0, loaded = 0;
    const worker = async () => {
        while (next < jobs.length) {
            if (opt.signal?.aborted) return;
            const [tx, ty] = jobs[next++];
            const url = String(info.tileUrl).replace('{z}', zoom).replace('{x}', tx).replace('{y}', ty);
            const bitmap = await loadTile(url, opt.signal);
            if (!bitmap) continue;      // 404 / 网络错误：该块保持透明，着色器回退原色
            ctx.drawImage(bitmap, (tx - tx0) * T, (ty - ty0) * T, T, T);
            bitmap.close?.();
            loaded++;
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, opt.concurrency || 6) }, worker));
    if (opt.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (!loaded) return { texture: null, matrix: null, zoom, size: [W, H], tiles: jobs.length, loaded, ms: Math.round(performance.now() - t0) };

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.max(1, opt.anisotropy || 1);
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    // u = (s·lng − tx0·T)/W；v = 1 − (−s·lat − ty0·T)/H
    const matrix = new THREE.Matrix3().set(
        s * f.ax / W, s * f.ay / W, (s * f.a0 - tx0 * T) / W,
        s * f.bx / H, s * f.by / H, 1 + (s * f.b0 + ty0 * T) / H,
        0, 0, 1,
    );
    return { texture, matrix, zoom, size: [W, H], tiles: jobs.length, loaded, ms: Math.round(performance.now() - t0) };
}
