/* 点位数据层（2D 图层与 3D 光柱 / HUD / 雷达共用）
   =============================================================================
   数据来源：
     - /api/map 的地图目录：每张图的 poi（name/icon/region + 平面坐标 lng/lat，无高度）。
     - /map_markers.json：只有零号大坝，4 档难度（常规/机密/终夜/永夜），点位带 UE 世界
       x/y/z；撤离点、出生点的 z 为 0，表示没有高度。
   本模块只做归类、配色、坐标换算与缓存，不依赖 three，也不读页面全局状态，
   因而 node 下的自检脚本（dev/poi-check.mjs）可以直接导入。
   2D 与 3D 必须拿同一份分类与颜色，否则同一个撤离点在两个视图里颜色不同。 */

export const POI_LEVELS = ['常规', '机密', '终夜', '永夜'];

/* 撤离点按「怎么撤」分 5 类配色：深色饱和底 + 白色单字类型标，和队伍色（浅色圆点 /
   头像）在形状与明度上都分得开；也避开贴脸红 #ff2d3f。 */
export const EXIT_CATEGORY_COLORS = {
    open: '#12b886',     // 常规：随时可撤
    paid: '#d9900b',     // 付费
    chance: '#0e8fb3',   // 概率开放
    cond: '#6d4aff',     // 条件 / 丢包
    mech: '#c026d3',     // 机关类：电梯、拉闸、列车、延迟、行动
};
const EXIT_TYPES = {
    常规撤离点: { short: '常规撤离', glyph: '常', cat: 'open' },
    付费撤离点: { short: '付费撤离', glyph: '付', cat: 'paid' },
    概率撤离点: { short: '概率撤离', glyph: '概', cat: 'chance' },
    条件撤离点: { short: '条件撤离', glyph: '条', cat: 'cond' },
    丢包撤离点: { short: '丢包撤离', glyph: '包', cat: 'cond' },
    电梯撤离点: { short: '电梯撤离', glyph: '梯', cat: 'mech' },
    拉闸撤离点: { short: '拉闸撤离', glyph: '闸', cat: 'mech' },
    列车撤离点: { short: '列车撤离', glyph: '车', cat: 'mech' },
    延迟撤离点: { short: '延迟撤离', glyph: '延', cat: 'mech' },
    行动撤离点: { short: '行动撤离', glyph: '行', cat: 'mech' },
};

/* 高价值容器：筛选项的顺序即设置面板里的顺序。 */
export const BOX_TYPES = [
    { name: '保险箱', glyph: '保' },
    { name: '小保险箱', glyph: '小' },
    { name: '服务器', glyph: '服' },
    { name: '电脑', glyph: '脑' },
    { name: '高级储物箱', glyph: '储' },
    { name: '航空储物箱', glyph: '航' },
    { name: '大武器箱', glyph: '武' },
    { name: '房卡房间', glyph: '卡' },
    { name: '密码房', glyph: '密' },
];
const BOX_GLYPH = new Map(BOX_TYPES.map(t => [t.name, t.glyph]));
export const BOX_COLOR = '#e6c07a';
export const SPAWN_COLOR = '#b8c4d0';

export function exitStyle(name) {
    const t = EXIT_TYPES[name] || (/撤离/.test(name) ? { short: String(name).replace('撤离点', '撤离'), glyph: '撤', cat: 'cond' } : null);
    if (!t) return null;
    return { ...t, color: EXIT_CATEGORY_COLORS[t.cat] };
}

/* 关闭的容器类型以逗号分隔存进偏好（存「关」而不是「开」：以后新增类型默认可见）。 */
export function parseBoxOff(value) {
    return new Set(String(value || '').split(',').map(s => s.trim()).filter(Boolean));
}

/* 区域名形如「大坝_合同」「核电站_RBMK区」，前缀就是地图名，显示时去掉。 */
export function regionText(region) {
    const s = String(region || '').trim();
    const i = s.indexOf('_');
    return i >= 0 && i < s.length - 1 ? s.slice(i + 1) : s;
}

/* 世界 → 平面，与 index.html 的 worldToPlane 逐字一致（含 rotate 0 / 90 / −90）。
   这里保留一份只为自检与 3D 侧使用，2D 仍以 index.html 的实现为准。 */
export function worldToPlane(info, wx, wy) {
    const bj = info.bj || 128, xB = info.width / bj, yB = info.height / bj;
    const cx = info.centerX, cy = info.centerY, r = Number(info.rotate || 0);
    if (r === 90) return { lng: bj - (cy + wy) / yB, lat: -bj + (cx - wx) / xB };
    if (r === -90) return { lng: bj + (cy + wy) / yB, lat: -bj - (cx - wx) / xB };
    return { lng: bj - (cx - wx) / xB, lat: -bj - (cy + wy) / yB };
}

/* 平面 → 世界：worldToPlane 三个分支分别解出 wx / wy。返回 UE 厘米。 */
export function planeToWorld(info, lng, lat) {
    const bj = info.bj || 128, xB = info.width / bj, yB = info.height / bj;
    const cx = info.centerX, cy = info.centerY, r = Number(info.rotate || 0);
    if (r === 90) return { x: cx - (lat + bj) * xB, y: (bj - lng) * yB - cy };
    if (r === -90) return { x: cx + (lat + bj) * xB, y: (lng - bj) * yB - cy };
    return { x: cx - (bj - lng) * xB, y: -(lat + bj) * yB - cy };
}

/* ------------------------------------------------------------------ 加载与缓存 */
let catalog = null;            // key -> 地图信息（含 poi）
let catalogPromise = null;
let markersPromise = null;
const warned = new Set();
function warnOnce(tag, error) {
    if (warned.has(tag)) return;
    warned.add(tag);
    console.warn('[点位] ' + tag + '，相关点位降级显示', error?.message || error || '');
}

/* 页面已经拿到地图目录时直接注入，省一次 /api/map 请求。 */
export function setCatalog(list) {
    if (!Array.isArray(list) || !list.length) return;
    catalog = new Map(list.filter(m => m && m.key).map(m => [m.key, m]));
    catalogPromise = Promise.resolve(catalog);
}

function loadCatalog() {
    if (!catalogPromise) {
        catalogPromise = fetch('/api/map', { cache: 'no-store' })
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(doc => { catalog = new Map((doc?.maps || []).filter(m => m && m.key).map(m => [m.key, m])); return catalog; })
            .catch(error => { warnOnce('地图目录 /api/map 读取失败', error); catalogPromise = null; return new Map(); });
    }
    return catalogPromise;
}

function loadMarkers() {
    if (!markersPromise) {
        markersPromise = fetch('/map_markers.json', { cache: 'force-cache' })
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(doc => (Array.isArray(doc?.levels) ? doc : null))
            .catch(error => { warnOnce('难度点位 map_markers.json 读取失败', error); return null; });
    }
    return markersPromise;
}

function sameSpot(a, b) {
    return Math.abs(a.lng - b.lng) < 0.05 && Math.abs(a.lat - b.lat) < 0.05;
}

/* 返回某张图某档难度的点位。每项：
     { kind:'exit'|'spawn'|'box', name, region, label, glyph, color, cat,
       lng, lat,            // 平面坐标（2D）
       x, y, z }            // UE 厘米；z 为 null 表示没有可靠高度
   结果按 (key, level) 缓存，同一张图来回切换不重复计算。 */
const resultCache = new Map();
export async function loadMapPois(key, level = 0) {
    const map = (await loadCatalog()).get(key);
    if (!map) return { key, level: 0, levels: 0, exits: [], spawns: [], boxes: [] };
    // 难度点位文件目前只有零号大坝；按文件里的 map 字段匹配，以后补别的图不用改代码
    const markers = await loadMarkers();
    const usable = !!markers && markers.map === key;
    const levelCount = usable ? markers.levels.length : 0;
    const lv = usable ? Math.max(0, Math.min(levelCount - 1, Number(level) || 0)) : 0;
    const cacheKey = key + '#' + lv + (usable ? '' : '!');
    const cached = resultCache.get(cacheKey);
    if (cached) return cached;

    const catalogPois = Array.isArray(map.poi) ? map.poi : [];
    const source = usable ? markers.levels[lv].points || [] : catalogPois;
    const catalogExits = catalogPois.filter(p => exitStyle(p.name));
    const out = { key, level: lv, levels: levelCount, exits: [], spawns: [], boxes: [] };
    for (const p of source) {
        const lng = Number(p.lng), lat = Number(p.lat);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        let x = Number(p.x), y = Number(p.y), z = Number(p.z);
        if (!Number.isFinite(x) || !Number.isFinite(y)) ({ x, y } = planeToWorld(map, lng, lat));
        // map_markers 用 0 表示「没有高度」；真实地面不会恰好是 0
        z = Number.isFinite(z) && z !== 0 ? z : null;
        const ex = exitStyle(p.name);
        if (ex) {
            // 难度点位里的撤离点不带区域名，按位置从地图目录补回
            let region = regionText(p.region);
            if (!region) region = regionText(catalogExits.find(c => c.name === p.name && sameSpot(c, p))?.region);
            out.exits.push({ kind: 'exit', name: p.name, region, label: region ? region + ' · ' + ex.short : ex.short,
                glyph: ex.glyph, color: ex.color, cat: ex.cat, short: ex.short, lng, lat, x, y, z });
        } else if (p.name === '出生点') {
            out.spawns.push({ kind: 'spawn', name: p.name, region: '', label: '出生点', glyph: '', color: SPAWN_COLOR,
                cat: 'spawn', lng, lat, x, y, z: null });
        } else if (BOX_GLYPH.has(p.name)) {
            const region = regionText(p.region);
            out.boxes.push({ kind: 'box', name: p.name, region, label: p.name, glyph: BOX_GLYPH.get(p.name),
                color: BOX_COLOR, cat: 'box', lng, lat, x, y, z });
        }
    }
    resultCache.set(cacheKey, out);
    return out;
}
