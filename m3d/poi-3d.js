import * as THREE from 'three';
import { loadMapPois, parseBoxOff } from './poi-data.js?v=1.4.0';

/* 3D 点位图层：撤离点光柱 + 地面光环，并为 HUD / 朝向雷达整理每帧的点位项。
   =============================================================================
   - 由 gateway.onMapInstalled 触发 install(name, mapMesh, scene)；换图时先清掉旧对象。
   - 撤离点在目录里没有高度：对地图做一次「向下取面」得到所有近水平面的高度。
     光环放在最上层（地表或屋顶），光柱从 30m 内最低的一层（楼内 / 隧道地面）一直
     升到最上层之上 70m，在室内、隧道里与远处都能看到。
   - 不用 Raycaster 逐点打 500 万面的整张网格（每条射线几十到上百毫秒）：
     改为对所有待测点建网格索引，按三角形遍历一遍，分片让出主线程。
     地图是单个 Mesh 还是分块 Group 都只走 traverse，两种形态一样处理。
   - 高价值容器不建 3D 对象，只在 HUD 上标注观察者附近 N 米内的；零号大坝用真实高度，
     其他图没有高度，按观察者高度近似并在标签上注明「高度未知」。
   - 每帧不分配：输出项复用对象池；容器先按网格桶预筛，不全量算距离。 */

const UE_TO_M = 0.01;
const BEAM_ABOVE_M = 70;
const LOWER_LAYER_M = 30;
const BOX_BUCKET_M = 40;
const SLICE_MS = 8;

function hexNum(css) { return parseInt(String(css).slice(1), 16) >>> 0; }

/* 对 points（three 坐标 {tx, ty}）求每点所有近水平面的高度（three z，升序去重前的原始列表）。
   isStale() 返回 true 时中止（换图或重建），返回 null。 */
async function sampleSurfaces(root, points, isStale) {
    const n = points.length;
    const hits = points.map(() => []);
    if (!n || !root) return hits;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
        minX = Math.min(minX, p.tx); maxX = Math.max(maxX, p.tx);
        minY = Math.min(minY, p.ty); maxY = Math.max(maxY, p.ty);
    }
    minX -= 1; minY -= 1; maxX += 1; maxY += 1;
    let cell = 4;
    while (((maxX - minX) / cell + 1) * ((maxY - minY) / cell + 1) > (1 << 20)) cell *= 2;
    const gw = Math.floor((maxX - minX) / cell) + 1, gh = Math.floor((maxY - minY) / cell) + 1;
    const head = new Int32Array(gw * gh).fill(-1), next = new Int32Array(n);
    for (let i = 0; i < n; i++) {
        const c = Math.floor((points[i].ty - minY) / cell) * gw + Math.floor((points[i].tx - minX) / cell);
        next[i] = head[c]; head[c] = i;
    }
    const meshes = [];
    root.updateWorldMatrix(true, true);
    root.traverse(o => { if (o.isMesh && o.geometry?.attributes?.position) meshes.push(o); });
    const v = new THREE.Vector3();
    let sliceAt = performance.now();
    for (const mesh of meshes) {
        const geo = mesh.geometry, pos = geo.attributes.position, index = geo.index?.array || null;
        const fast = pos.array instanceof Float32Array && pos.itemSize === 3 && !pos.normalized && !pos.isInterleavedBufferAttribute;
        const identity = mesh.matrixWorld.equals(new THREE.Matrix4());
        // 特殊格式（量化、交错、带变换）先展开成普通数组，主循环只保留一条快路径
        let arr = pos.array;
        if (!fast || !identity) {
            arr = new Float32Array(pos.count * 3);
            for (let i = 0; i < pos.count; i++) {
                v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld);
                arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z;
            }
        }
        const triCount = index ? Math.floor(index.length / 3) : Math.floor(pos.count / 3);
        for (let t = 0; t < triCount; t++) {
            if ((t & 0x3ffff) === 0 && performance.now() - sliceAt > SLICE_MS) {
                await new Promise(r => setTimeout(r, 0));
                if (isStale()) return null;
                sliceAt = performance.now();
            }
            const ia = (index ? index[t * 3] : t * 3) * 3, ib = (index ? index[t * 3 + 1] : t * 3 + 1) * 3, ic = (index ? index[t * 3 + 2] : t * 3 + 2) * 3;
            const ax = arr[ia], ay = arr[ia + 1], bx = arr[ib], by = arr[ib + 1], cx = arr[ic], cy = arr[ic + 1];
            const x0 = ax < bx ? (ax < cx ? ax : cx) : (bx < cx ? bx : cx);
            const x1 = ax > bx ? (ax > cx ? ax : cx) : (bx > cx ? bx : cx);
            if (x1 < minX || x0 > maxX) continue;
            const y0 = ay < by ? (ay < cy ? ay : cy) : (by < cy ? by : cy);
            const y1 = ay > by ? (ay > cy ? ay : cy) : (by > cy ? by : cy);
            if (y1 < minY || y0 > maxY) continue;
            const gx0 = Math.max(0, Math.floor((x0 - minX) / cell)), gx1 = Math.min(gw - 1, Math.floor((x1 - minX) / cell));
            const gy0 = Math.max(0, Math.floor((y0 - minY) / cell)), gy1 = Math.min(gh - 1, Math.floor((y1 - minY) / cell));
            for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
                for (let i = head[gy * gw + gx]; i >= 0; i = next[i]) {
                    const px = points[i].tx, py = points[i].ty;
                    if (px < x0 || px > x1 || py < y0 || py > y1) continue;
                    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
                    if (Math.abs(d) < 1e-9) continue;
                    const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
                    const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
                    const l3 = 1 - l1 - l2;
                    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
                    const az = arr[ia + 2], bz = arr[ib + 2], cz = arr[ic + 2];
                    // 只要近水平面：墙面在 XY 上投影退化，会给出任意高度
                    const ux = bx - ax, uy = by - ay, uz = bz - az, wx = cx - ax, wy = cy - ay, wz = cz - az;
                    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
                    if (Math.abs(nz) < 0.35 * Math.hypot(nx, ny, nz)) continue;
                    hits[i].push(l1 * az + l2 * bz + l3 * cz);
                }
            }
        }
    }
    return hits;
}

export function createPoiLayer() {
    let scene = null, mapMesh = null, mapKey = null, level = -1, gen = 0;
    let group = null;
    let exits = [], boxes = [];
    let boxBuckets = new Map();
    const heightCache = new Map();          // mapKey -> Map("x,y" -> {top, low})
    const mats = new Map();                 // 颜色 -> {beam, ring}
    let beamGeo = null, ringGeo = null;
    const out = [];

    function material(color) {
        let m = mats.get(color);
        if (m) return m;
        const beam = new THREE.ShaderMaterial({
            uniforms: { uColor: { value: new THREE.Color(color) } },
            vertexShader: 'varying float vH; void main(){ vH = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
            // 底部实、顶部渐隐；加色混合在暗场景和写实天空下都醒目
            fragmentShader: 'uniform vec3 uColor; varying float vH; void main(){ float a = pow(1.0 - vH, 1.5) * 0.6; gl_FragColor = vec4(uColor * a, a); }',
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
        });
        const ring = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false,
            side: THREE.DoubleSide, fog: false });
        m = { beam, ring };
        mats.set(color, m);
        return m;
    }

    function clearGroup() {
        if (!group) return;
        group.removeFromParent();
        group = null;   // 几何与材质共享复用，换图不释放
    }

    function buildBeacons(list) {
        clearGroup();
        if (!scene || !list.length) return;
        if (!beamGeo) {
            // 高度 1、底面在 z=0 的竖直圆柱：每个光柱按自己的上下界缩放
            beamGeo = new THREE.CylinderGeometry(1.5, 1.5, 1, 20, 1, true);
            beamGeo.rotateX(Math.PI / 2);
            beamGeo.translate(0, 0, 0.5);
            ringGeo = new THREE.RingGeometry(3.0, 4.2, 48);
        }
        group = new THREE.Group();
        group.name = 'poi-beacons';
        for (const e of list) {
            const m = material(e.color);
            const beam = new THREE.Mesh(beamGeo, m.beam);
            const bottom = e.low, top = e.tz + BEAM_ABOVE_M;
            beam.position.set(e.tx, e.ty, bottom);
            beam.scale.set(1, 1, Math.max(1, top - bottom));
            beam.renderOrder = 990;
            // 光环画在下层地面；与最上层相差一层楼以上（屋顶/隧道顶）时上层再放一个，内外都看得到
            const parts = [beam];
            for (const z of e.tz - e.low > 2.5 ? [e.low, e.tz] : [e.tz]) {
                const ring = new THREE.Mesh(ringGeo, m.ring);
                ring.position.set(e.tx, e.ty, z + 0.15);
                ring.renderOrder = 991;
                parts.push(ring);
            }
            for (const o of parts) {
                o.frustumCulled = true;
                o.userData.radarExcludeFromSsao = true;
                o.userData.poiBeacon = true;
                group.add(o);
            }
        }
        scene.add(group);
    }

    async function rebuild() {
        const token = ++gen;
        const stale = () => token !== gen;
        clearGroup();
        exits = []; boxes = []; boxBuckets = new Map();
        if (!mapKey || !mapMesh) return;
        let data;
        try { data = await loadMapPois(mapKey, Math.max(0, level)); }
        catch (error) { console.warn('[点位] 3D 点位载入失败', error); return; }
        if (stale()) return;
        let cache = heightCache.get(mapKey);
        if (!cache) { cache = new Map(); heightCache.set(mapKey, cache); }
        const list = data.exits.map(p => ({ ...p, tx: p.x * UE_TO_M, ty: -p.y * UE_TO_M,
            tz: p.z != null ? p.z * UE_TO_M : null, low: null, approx: false }));
        // 取面要几秒：先让 HUD 与雷达用上（高度暂按观察者近似），光柱等高度出来再建
        exits = list;
        boxes = data.boxes.map(p => ({ ...p, tx: p.x * UE_TO_M, ty: -p.y * UE_TO_M, tz: p.z != null ? p.z * UE_TO_M : null }));
        for (const b of boxes) {
            const k = Math.floor(b.tx / BOX_BUCKET_M) + ',' + Math.floor(b.ty / BOX_BUCKET_M);
            let arr = boxBuckets.get(k);
            if (!arr) boxBuckets.set(k, arr = []);
            arr.push(b);
        }
        const todo = list.filter(e => e.tz == null && !cache.has(e.tx.toFixed(1) + ',' + e.ty.toFixed(1)));
        if (todo.length) {
            const t0 = performance.now();
            const hits = await sampleSurfaces(mapMesh, todo, stale);
            if (!hits || stale()) return;
            todo.forEach((e, i) => {
                const zs = hits[i];
                if (!zs.length) return;
                const top = Math.max(...zs);
                let low = top;
                for (const z of zs) if (z < low && z >= top - LOWER_LAYER_M) low = z;
                cache.set(e.tx.toFixed(1) + ',' + e.ty.toFixed(1), { top, low });
            });
            console.log(`[点位] ${mapKey} 撤离点取地面高度 ${todo.length} 个，用时 ${Math.round(performance.now() - t0)}ms`);
        }
        const known = [];
        for (const e of list) {
            if (e.tz != null) { e.low = e.tz; known.push(e.tz); continue; }
            const h = cache.get(e.tx.toFixed(1) + ',' + e.ty.toFixed(1));
            if (h) { e.tz = h.top; e.low = h.low; known.push(h.top); }
        }
        // 网格外（取不到面）的撤离点：用其他撤离点高度的中位数，标记为近似
        const fallback = known.length ? known.sort((a, b) => a - b)[known.length >> 1] : 0;
        for (const e of list) if (e.tz == null) { e.tz = fallback; e.low = fallback; e.approx = true; }
        buildBeacons(exits);
    }

    function item(i) { return out[i] || (out[i] = {}); }

    return {
        install(name, mesh, sc) {
            scene = sc || scene; mapMesh = mesh || null; mapKey = name || null;
            rebuild();
        },
        /* 每帧调用：难度档变化时重建（换档只影响零号大坝的容器与点位集合）。 */
        setLevel(lv) {
            const next = Math.max(0, Number(lv) || 0);
            if (next === level) return;
            const first = level < 0;
            level = next;
            if (!first && mapMesh) rebuild();
        },
        setVisible(on) { if (group) group.visible = !!on; },
        get exits() { return exits; },
        get items() { return out; },
        /* 整理 HUD 点位项（three 坐标）：撤离点全部；容器只取观察者 boxD 米内且类型未关闭的。
           viewer: UE 厘米 {x, y, z?}；返回项数，项在 items 里，对象复用。 */
        collect(viewer, opt) {
            let n = 0;
            if (!viewer) return 0;
            const vx = viewer.x * UE_TO_M, vy = -viewer.y * UE_TO_M;
            const vz = Number.isFinite(viewer.z) ? viewer.z * UE_TO_M : null;
            if (opt.exit) for (const e of exits) {
                const it = item(n++);
                // 标签锚在下层地面（楼内电梯、隧道口的人站的那一层），而不是屋顶
                it.kind = 'exit'; it.x = e.tx; it.y = e.ty;
                it.z = e.low != null ? e.low : e.tz != null ? e.tz : (vz != null ? vz : 0);
                it.color = hexNum(e.color);
                it.css = e.color; it.glyph = e.glyph; it.label = e.label; it.approx = e.approx || e.tz == null;
                it.dist = Math.hypot(e.tx - vx, e.ty - vy);
            }
            const boxD = Number(opt.boxD) || 0;
            if (opt.box && boxD > 0 && boxes.length) {
                const off = opt.boxOff;
                const r = Math.ceil(boxD / BOX_BUCKET_M);
                const bx = Math.floor(vx / BOX_BUCKET_M), by = Math.floor(vy / BOX_BUCKET_M);
                for (let gy = by - r; gy <= by + r; gy++) for (let gx = bx - r; gx <= bx + r; gx++) {
                    const arr = boxBuckets.get(gx + ',' + gy);
                    if (!arr) continue;
                    for (const b of arr) {
                        if (off && off.has(b.name)) continue;
                        const d = Math.hypot(b.tx - vx, b.ty - vy);
                        if (d > boxD) continue;
                        const it = item(n++);
                        it.kind = 'box'; it.x = b.tx; it.y = b.ty;
                        it.approx = b.tz == null;
                        it.z = b.tz != null ? b.tz : (vz != null ? vz : 0);
                        it.color = 0xe6c07a; it.css = b.color; it.glyph = b.glyph; it.label = b.name; it.dist = d;
                    }
                }
            }
            return n;
        },
        parseBoxOff,
    };
}
