import * as THREE from 'three';
import { CHARACTER_ROOT_ABOVE_MESH_M } from './gateway-pose.js?v=1.4.0';

/* 3D 战术 HUD —— 解决「第一视角看不到其他人相对位置」。
   =============================================================================
   3D 场景里远处的人物模型只有几个像素，标签又随距离缩到读不出来；屏幕外的人
   完全没有提示。HUD 在每帧 3D 渲染之后，把每个人物投影到屏幕上，用一张 2D canvas
   画固定像素尺寸的标识，不受距离、墙体遮挡影响：

     画面内：敌人头顶 ▼ 标识（队伍色；贴脸 = 红色 + 呼吸环；倒地 = 橙色）、
             3D 信息卡隐藏后（远距离）显示「名字 距离」、可选方框与顶部连线。
     画面外：以屏幕中心为圆心的预警圆，圆周上的箭头指向画面外的敌人，标距离；
             进入贴脸距离的箭头外侧加红点并闪烁。
     点位：  撤离点「区域 · 类型」+ 到观察者的距离；观察者附近的高价值容器。
     雷达：  独立小画布（#r3-radar，由 CSS 摆放以避让小地图与底部控件），视线方向
             永远朝上，画视野扇形、敌我、贴脸红环与撤离点方块。

   输入由 korr-renderer 每帧整理（three 世界坐标 + 语义标记），本模块只做投影与
   绘制，不读全局状态。所有尺寸是 CSS 像素，canvas 按 devicePixelRatio 放大。 */

const _cam = new THREE.Vector3();
const _ndc = new THREE.Vector3();
const _cssCache = new Map();
const FONT_STACK = 'system-ui,"PingFang SC","Microsoft YaHei",sans-serif';
const HEAD_ABOVE_CENTER_M = 1.05;   // 人物根节点是胶囊中心，头顶约在其上 0.9m，再留一点空
const FOOT_BELOW_CENTER_M = CHARACTER_ROOT_ABOVE_MESH_M;

function css(hex) {
    let v = _cssCache.get(hex);
    if (!v) { v = '#' + (hex >>> 0).toString(16).padStart(6, '0'); _cssCache.set(hex, v); }
    return v;
}
// 撤离类型色是深色底色，直接用作文字在暗场景里偏暗：文字用提亮 45% 的同色
const _lightCache = new Map();
function lighten(hexCss) {
    let v = _lightCache.get(hexCss);
    if (!v) {
        const n = parseInt(String(hexCss).slice(1), 16) || 0;
        const ch = sh => Math.round(((n >> sh) & 255) + (255 - ((n >> sh) & 255)) * 0.45);
        v = 'rgb(' + ch(16) + ',' + ch(8) + ',' + ch(0) + ')';
        _lightCache.set(hexCss, v);
    }
    return v;
}

function placeFarLabel(x, y, width, height, placed, viewportW, viewportH) {
    const w = Math.min(width, viewportW - 8), h = height;
    const left = Math.max(4, Math.min(viewportW - w - 4, x - w / 2));
    const initial = Math.max(4, Math.min(viewportH - h - 4, y - h));
    let top = initial;
    for (let step = 0; step <= placed.length * 2 + 2; step++) {
        const offset = Math.ceil(step / 2) * (h + 4) * (step % 2 ? -1 : 1);
        top = initial + offset;
        if (top < 4 || top + h > viewportH - 4) continue;
        if (!placed.some(r => left < r.x + r.w + 3 && left + w + 3 > r.x && top < r.y + r.h + 3 && top + h + 3 > r.y)) break;
    }
    const result = { x:left, y:Math.max(4,Math.min(viewportH-h-4,top)), w, h };
    placed.push(result);return result;
}

// 手机竖屏远距名牌文字的数量上限；排序：贴脸 > 敌人 > 实时位置 > 距离近
const FAR_TEXT_BUDGET_NARROW = 6;
const _farRank = [];
function rankFarText(items, count, budget) {
    _farRank.length = 0;
    for (let i = 0; i < count; i++) { const it = items[i]; it.textOk = false; if (it.far && it.text) _farRank.push(it); }
    _farRank.sort((a, b) => (b.alert - a.alert) || (b.enemy - a.enemy) || (a.stale - b.stale) || ((a.dist ?? 1e9) - (b.dist ?? 1e9)));
    for (let i = 0; i < _farRank.length && i < budget; i++) _farRank[i].textOk = true;
    _farRank.length = 0;
}

export function createHud(canvas) {
    const ctx = canvas.getContext('2d');
    let cssW = 0, cssH = 0, dpr = 1, dirty = false;
    const arrows = [];
    const farLabels = [];
    const placed = [];
    const proj = { on: false, front: false, sx: 0, sy: 0, cx: 0, cy: 0 };
    // 雷达画布与 HUD 同级：位置交给 CSS 媒体查询，避开小地图、回放条、相机条与快捷条
    let radarCv = canvas.parentElement?.querySelector('#r3-radar') || null;
    if (!radarCv && canvas.parentElement) {
        radarCv = document.createElement('canvas');
        radarCv.id = 'r3-radar';
        radarCv.setAttribute('aria-hidden', 'true');
        radarCv.style.display = 'none';
        canvas.parentElement.appendChild(radarCv);
    }
    const radar = radarCv ? { cv: radarCv, ctx: radarCv.getContext('2d'), w: 0, h: 0, dpr: 1, shown: false } : null;

    function fit() {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        const r = Math.min(2, window.devicePixelRatio || 1);
        if (w === cssW && h === cssH && r === dpr) return;
        cssW = w; cssH = h; dpr = r;
        canvas.width = Math.max(1, Math.round(w * r));
        canvas.height = Math.max(1, Math.round(h * r));
        dirty = true;
    }

    function clear() {
        if (!dirty) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        dirty = false;
    }

    // 相机空间坐标同时用于「是否在画面内」和「画面外的方向」：
    // NDC 在目标位于相机背后时会翻转，拿它算方向会把身后的人指反。
    function project(camera, x, y, z) {
        _cam.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
        proj.cx = _cam.x; proj.cy = _cam.y;
        proj.front = _cam.z < -camera.near;
        if (!proj.front) { proj.on = false; return proj; }
        _ndc.copy(_cam).applyMatrix4(camera.projectionMatrix);
        proj.sx = (_ndc.x * 0.5 + 0.5) * cssW;
        proj.sy = (-_ndc.y * 0.5 + 0.5) * cssH;
        proj.on = _ndc.x >= -1 && _ndc.x <= 1 && _ndc.y >= -1 && _ndc.y <= 1;
        return proj;
    }

    function label(str, x, y, color, size) {
        ctx.font = `700 ${size}px ${FONT_STACK}`;
        ctx.strokeText(str, x, y);
        ctx.fillStyle = color;
        ctx.fillText(str, x, y);
    }

    function chevron(x, y, s, fill) {
        // 尖端朝下指向头顶
        ctx.beginPath();
        ctx.moveTo(x - s, y - s * 1.15);
        ctx.lineTo(x + s, y - s * 1.15);
        ctx.lineTo(x, y);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.stroke();
    }

    function cornerBox(x, top, bottom, color) {
        const h = Math.max(8, bottom - top), w = Math.max(6, h * 0.42), l = Math.max(4, Math.min(w, h) * 0.28);
        const x0 = x - w / 2, x1 = x + w / 2, y0 = bottom - h, y1 = bottom;
        ctx.beginPath();
        ctx.moveTo(x0, y0 + l); ctx.lineTo(x0, y0); ctx.lineTo(x0 + l, y0);
        ctx.moveTo(x1 - l, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + l);
        ctx.moveTo(x0, y1 - l); ctx.lineTo(x0, y1); ctx.lineTo(x0 + l, y1);
        ctx.moveTo(x1 - l, y1); ctx.lineTo(x1, y1); ctx.lineTo(x1, y1 - l);
        ctx.strokeStyle = color;
        ctx.stroke();
    }

    /* items: [{ x,y,z, scale, color, enemy, alert, down, ai, far, text, dist, hp, spawn, stale }]
       opt:   { foe, ray, box, warn, warnD, warnR, warnSz, fontScale, alertColor, downColor }
       extra: { pois, poiCount, radar: { on, range, x, y, z } }，坐标均为 three 世界坐标（米） */
    function draw(camera, items, count, opt, now, extra) {
        fit();
        if (!cssW || !cssH) return;
        clear();
        const fs = Math.max(0.7, Math.min(2.2, Number(opt.fontScale) || 1));
        const pulse = 0.5 + 0.5 * Math.sin(now * 0.0126);          // 约 2Hz
        const poiCount = extra?.poiCount || 0;
        const rd = extra?.radar;
        drawRadar(camera, rd && rd.on ? rd : null, items, count, extra?.pois, poiCount, opt, pulse);
        if (!count && !poiCount) return;
        // 窄屏（手机竖屏）远距名牌文字容易互相压住：只给最重要的若干个写名字和距离，
        // 其余仍保留朝下标识和血条，血量不因密度控制而消失。
        const textBudget = cssW < 600 ? FAR_TEXT_BUDGET_NARROW : Infinity;
        if (textBudget !== Infinity) rankFarText(items, count, textBudget);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.lineJoin = 'round';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // 点位先画，人物标识压在上面
        if (poiCount) drawPois(camera, extra.pois, poiCount, fs);
        const alertCss = css(opt.alertColor), downCss = css(opt.downColor);
        arrows.length = 0;
        farLabels.length = 0;

        for (let i = 0; i < count; i++) {
            const it = items[i];
            const scale = it.scale || 1;
            const p = project(camera, it.x, it.y, it.z - FOOT_BELOW_CENTER_M + (FOOT_BELOW_CENTER_M+HEAD_ABOVE_CENTER_M+(it.headDelta||0)) * scale);
            const color = it.alert ? alertCss : css(it.color);
            if (!p.on) {
                if (it.enemy && opt.warn && !it.spawn && it.dist != null && it.dist <= opt.warnD) {
                    let ax = p.cx, ay = -p.cy;
                    if (Math.hypot(ax, ay) < 1e-4) { ax = 0; ay = 1; }   // 正后方：固定朝下
                    arrows.push({ a: Math.atan2(ay, ax), color: it.alert ? alertCss : css(it.color), alert: it.alert, dist: it.dist });
                }
                continue;
            }
            const hx = p.sx, hy = p.sy;
            dirty = true;

            if (opt.box && (it.enemy || it.alert)) {
                const foot = project(camera, it.x, it.y, it.z - FOOT_BELOW_CENTER_M);
                if (foot.front) {
                    ctx.lineWidth = it.alert ? 2 : 1.4;
                    ctx.globalAlpha = it.stale ? 0.4 : 0.95;
                    cornerBox(hx, hy, Math.max(hy + 8, foot.sy), color);
                    ctx.globalAlpha = 1;
                }
            }
            if (opt.ray && it.enemy) {
                ctx.beginPath();
                ctx.moveTo(cssW / 2, 0);
                ctx.lineTo(hx, hy);
                ctx.lineWidth = it.alert ? 2 : 1.3;
                ctx.strokeStyle = color;
                ctx.globalAlpha = it.stale ? 0.3 : 0.75;
                ctx.stroke();
                ctx.globalAlpha = 1;
            }

            let top = hy;
            if (it.enemy && opt.foe) {
                const s = (it.ai ? 4.5 : 6.5) * fs;
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = 'rgba(0,0,0,.85)';
                ctx.globalAlpha = it.stale ? 0.45 : 1;
                chevron(hx, hy - 3, s, color);
                ctx.globalAlpha = 1;
                top = hy - 3 - s * 1.15;
                if (it.alert) {
                    const r = (10 + 8 * (1 - pulse)) * fs;
                    ctx.beginPath();
                    ctx.arc(hx, hy - 3 - s * 0.6, r, 0, Math.PI * 2);
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = alertCss;
                    ctx.globalAlpha = 0.35 + 0.6 * pulse;
                    ctx.stroke();
                    ctx.globalAlpha = 1;
                    top -= 6 * fs;
                }
            } else if (it.far && !it.enemy) {
                ctx.beginPath();
                ctx.arc(hx, hy - 3, 3 * fs, 0, Math.PI * 2);
                ctx.fillStyle = color;
                ctx.fill();
                top = hy - 7 * fs;
            }

            let labelX = hx;
            const farText = it.far && it.text && (textBudget === Infinity || it.textOk) ? it.text : '';
            if (farText) {
                ctx.font = `600 ${Math.round(11 * fs)}px ${FONT_STACK}`;
                const rect = placeFarLabel(hx, top, ctx.measureText(farText).width + 12, 28 * fs, farLabels, cssW, cssH);
                labelX = rect.x + rect.w / 2;top = rect.y + rect.h;
                ctx.strokeStyle = color;ctx.lineWidth = .7;ctx.globalAlpha = .5;
                ctx.beginPath();ctx.moveTo(hx, hy);ctx.lineTo(labelX, top);ctx.stroke();ctx.globalAlpha = 1;
                ctx.fillStyle = 'rgba(6,9,14,.72)';ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
            }
            // 远距离名牌的细血条：与 2D 同一套阈值配色
            if (it.far && it.hp != null) {
                const w = 28 * fs, h = Math.max(2, 3 * fs), y = top - 3 * fs - h;
                ctx.globalAlpha = it.stale ? 0.5 : 1;
                ctx.fillStyle = 'rgba(6,8,14,.8)';
                ctx.fillRect(labelX - w / 2 - 1, y - 1, w + 2, h + 2);
                ctx.fillStyle = it.hp > 0.66 ? '#37e08a' : it.hp > 0.33 ? '#ffcf4d' : '#ff5f6d';
                ctx.fillRect(labelX - w / 2, y, w * it.hp, h);
                ctx.globalAlpha = 1;
                top = y - 1;
            }

            // 文字：远距离时 3D 信息卡隐藏，由这里给出「名字 距离」；近处贴脸只补距离
            let txt = '';
            // 密度控制省略名字时，没有比例血条的目标仍写出血量数值（上限未知 / 血量未知）
            if (it.far) txt = farText || (it.hp == null ? (it.hpText || '') : '');
            else if (it.alert && it.dist != null) txt = Math.round(it.dist) + 'm';
            if (it.down && it.enemy) txt = txt ? '倒地 · ' + txt : '倒地';
            if (txt) {
                ctx.lineWidth = 3;
                ctx.strokeStyle = 'rgba(0,0,0,.82)';
                ctx.globalAlpha = it.stale ? 0.5 : 1;
                label(txt, labelX, top - 8 * fs, it.alert ? alertCss : it.down ? downCss : css(it.color), Math.round(11 * fs));
                ctx.globalAlpha = 1;
            }
        }

        if (arrows.length) drawArrows(opt, pulse);
    }

    function drawArrows(opt, pulse) {
        dirty = true;
        const SC = Math.max(0.3, Math.min(3, (Number(opt.warnSz) || 100) / 100));
        // 半径上限连箭头和红点一起留出空间，避免被推出画面
        const tipOut = 13 * SC + 6 * SC + 3.4 * SC;
        const R = Math.max(40, Math.min(Number(opt.warnR) || 200, Math.min(cssW, cssH) * 0.5 - 14 - tipOut));
        const cx = cssW / 2, cy = cssH / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        // 暗底 + 亮线两遍描边：写实风格的亮天空与室内暗部上都看得见
        ctx.setLineDash([5, 7]);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,.18)';
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255,255,255,.45)';
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = `700 ${(11 * SC).toFixed(1)}px ${FONT_STACK}`;
        // 距离文字按「近的优先」逐个摆放：与已放好的文字框相交就向下挪一行，
        // 直接比较屏幕矩形，不依赖角度排序（角度在 ±180° 处不连续，排序会把左侧相邻的分开）。
        arrows.sort((p, q) => p.dist - q.dist);
        placed.length = 0;
        const lineH = 13 * SC;
        for (const a of arrows) {
            const c = Math.cos(a.a), s = Math.sin(a.a);
            const px = (r, t) => cx + r * c - t * s, py = (r, t) => cy + r * s + t * c;
            ctx.beginPath();
            ctx.moveTo(px(R, -7 * SC), py(R, -7 * SC));
            ctx.lineTo(px(R + 13 * SC, 0), py(R + 13 * SC, 0));
            ctx.lineTo(px(R, 7 * SC), py(R, 7 * SC));
            ctx.closePath();
            ctx.globalAlpha = a.alert ? 0.55 + 0.45 * pulse : 0.95;
            ctx.fillStyle = a.color;
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.strokeStyle = 'rgba(0,0,0,.55)';
            ctx.stroke();
            ctx.globalAlpha = 1;
            if (a.alert) {
                // 贴脸红点：画在箭头外侧，表达「这个方向的人已经很近」
                ctx.beginPath();
                ctx.arc(px(R + 19 * SC, 0), py(R + 19 * SC, 0), 3.4 * SC, 0, Math.PI * 2);
                ctx.fillStyle = css(opt.alertColor);
                ctx.fill();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = 'rgba(0,0,0,.55)';
                ctx.stroke();
            }
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(0,0,0,.75)';
            const t = Math.round(a.dist) + 'm', tx = px(R - 17 * SC, 0);
            const halfW = ctx.measureText(t).width / 2 + 2;
            let ty = py(R - 17 * SC, 0);
            for (let tries = 0; tries < 6 && placed.some(r => Math.abs(r.x - tx) < r.hw + halfW && Math.abs(r.y - ty) < lineH); tries++) ty += lineH;
            placed.push({ x: tx, y: ty, hw: halfW });
            ctx.strokeText(t, tx, ty);
            ctx.fillStyle = a.color;
            ctx.fillText(t, tx, ty);
        }
    }

    /* 撤离点：类型色方块 + 白色单字，上方「区域 · 类型」，下方距离；远处缩小变淡。
       容器：深底沙色小方块 + 单字，上方名称与距离；没有真实高度时虚线框并注明。 */
    const poiPlaced = [], poiSlots = [];
    function drawPois(camera, pois, n, fs) {
        poiPlaced.length = 0;
        for (let i = 0; i < n; i++) {
            const p = pois[i];
            const exit = p.kind === 'exit';
            const pr = project(camera, p.x, p.y, p.z + (exit ? 4 : 0.8));
            if (!pr.on) continue;
            dirty = true;
            const sx = pr.sx, sy = pr.sy;
            if (exit) {
                const far = p.dist > 350, k = (far ? 0.82 : 1) * fs, s = 8 * k;
                ctx.globalAlpha = far ? 0.8 : 1;
                ctx.beginPath();
                ctx.rect(sx - s, sy - s, s * 2, s * 2);
                ctx.fillStyle = p.css;
                ctx.fill();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = 'rgba(255,255,255,.9)';
                ctx.stroke();
                ctx.font = `700 ${Math.round(10 * k)}px ${FONT_STACK}`;
                ctx.fillStyle = '#fff';
                ctx.fillText(p.glyph, sx, sy + 0.5);
                ctx.lineWidth = 3;
                ctx.strokeStyle = 'rgba(0,0,0,.8)';
                label(p.label, sx, sy - s - 9 * k, lighten(p.css), Math.round(12 * k));
                // 撤离点标签优先：记下它占的位置，后面的容器文字遇到就让开
                const slot = poiPlaced.length < poiSlots.length ? poiSlots[poiPlaced.length] : (poiSlots[poiPlaced.length] = {});
                slot.x = sx; slot.y = sy - s - 9 * k; slot.hw = ctx.measureText(p.label).width / 2 + 2;
                poiPlaced.push(slot);
                ctx.font = `600 ${Math.round(11 * k)}px ${FONT_STACK}`;
                const t = (p.approx ? '≈' : '') + Math.round(p.dist) + 'm';
                ctx.strokeText(t, sx, sy + s + 9 * k);
                ctx.fillStyle = '#e8eef2';
                ctx.fillText(t, sx, sy + s + 9 * k);
                ctx.globalAlpha = 1;
            } else {
                const s = 5 * fs;
                ctx.beginPath();
                ctx.rect(sx - s, sy - s, s * 2, s * 2);
                ctx.fillStyle = 'rgba(11,17,24,.85)';
                ctx.fill();
                ctx.lineWidth = 1.2;
                ctx.strokeStyle = p.css;
                if (p.approx) ctx.setLineDash([2, 2]);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.font = `700 ${Math.round(7.5 * fs)}px ${FONT_STACK}`;
                ctx.fillStyle = p.css;
                ctx.fillText(p.glyph, sx, sy + 0.5);
                // 容器常成堆：文字与已画的相交就只留图标，近的先画（collect 按桶序，不严格）
                const t = p.label + ' ' + Math.round(p.dist) + 'm' + (p.approx ? ' · 高度未知' : '');
                const size = Math.round(10.5 * fs), ty = sy - s - 7 * fs;
                ctx.font = `700 ${size}px ${FONT_STACK}`;
                const hw = ctx.measureText(t).width / 2 + 2;
                if (poiPlaced.some(r => Math.abs(r.x - sx) < r.hw + hw && Math.abs(r.y - ty) < size + 2)) continue;
                const slot = poiPlaced.length < poiSlots.length ? poiSlots[poiPlaced.length] : (poiSlots[poiPlaced.length] = {});
                slot.x = sx; slot.y = ty; slot.hw = hw;
                poiPlaced.push(slot);
                ctx.lineWidth = 3;
                ctx.strokeStyle = 'rgba(0,0,0,.8)';
                label(t, sx, ty, '#ffd89a', size);
            }
        }
        poiPlaced.length = 0;
    }

    function fitRadar() {
        const w = radar.cv.clientWidth, h = radar.cv.clientHeight;
        const r = Math.min(2, window.devicePixelRatio || 1);
        if (w === radar.w && h === radar.h && r === radar.dpr) return;
        radar.w = w; radar.h = h; radar.dpr = r;
        radar.cv.width = Math.max(1, Math.round(w * r));
        radar.cv.height = Math.max(1, Math.round(h * r));
    }

    /* 朝向雷达：以观察者为圆心、视线方向朝上。前向取相机视线的水平投影；俯视时视线
       几乎竖直，改用相机「屏幕上方」的水平投影，雷达与画面朝向仍一致。 */
    function drawRadar(camera, rd, items, count, pois, poiCount, opt, pulse) {
        if (!radar) return;
        const show = !!rd;
        if (radar.shown !== show) { radar.cv.style.display = show ? '' : 'none'; radar.shown = show; }
        if (!show) return;
        fitRadar();
        const W = radar.w, H = radar.h;
        if (!W || !H) return;
        const c = radar.ctx;
        c.setTransform(radar.dpr, 0, 0, radar.dpr, 0, 0);
        c.clearRect(0, 0, W, H);
        const R = Math.min(W, H) / 2 - 3, cx = W / 2, cy = H / 2;
        const range = Math.max(20, Number(rd.range) || 150);
        _cam.set(0, 0, -1).applyQuaternion(camera.quaternion);
        let fx = _cam.x, fy = _cam.y, fl = Math.hypot(fx, fy);
        if (fl < 0.2) { _cam.set(0, 1, 0).applyQuaternion(camera.quaternion); fx = _cam.x; fy = _cam.y; fl = Math.hypot(fx, fy); }
        if (fl < 1e-6) { fx = 0; fy = 1; fl = 1; }
        fx /= fl; fy /= fl;
        const rx = fy, ry = -fx;                       // 视线的右手方向（Z 朝上）
        const k = R / range;

        c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2);
        c.fillStyle = 'rgba(8,12,18,.74)'; c.fill();
        c.lineWidth = 1; c.strokeStyle = 'rgba(255,255,255,.22)'; c.stroke();
        c.save();
        c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.clip();
        // 视野扇形：水平半视场角
        const half = Math.min(Math.PI * 0.49, Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect));
        c.beginPath(); c.moveTo(cx, cy);
        c.arc(cx, cy, R, -Math.PI / 2 - half, -Math.PI / 2 + half); c.closePath();
        c.fillStyle = 'rgba(76,141,255,.17)'; c.fill();
        c.strokeStyle = 'rgba(120,170,255,.35)'; c.stroke();
        c.lineWidth = 1; c.strokeStyle = 'rgba(255,255,255,.1)';
        c.beginPath(); c.arc(cx, cy, R / 3, 0, Math.PI * 2); c.stroke();
        c.beginPath(); c.arc(cx, cy, R * 2 / 3, 0, Math.PI * 2); c.stroke();
        c.beginPath(); c.moveTo(cx - R, cy); c.lineTo(cx + R, cy); c.moveTo(cx, cy - R); c.lineTo(cx, cy + R); c.stroke();

        // 撤离点：方块；量程外的贴在圆周上并画成空心，仍能看出方向
        for (let i = 0; i < poiCount; i++) {
            const p = pois[i];
            if (p.kind !== 'exit') continue;
            const dx = p.x - rd.x, dy = p.y - rd.y;
            let px = (dx * rx + dy * ry) * k, py = -(dx * fx + dy * fy) * k;
            const d = Math.hypot(px, py), out = d > R - 5;
            if (out) { px *= (R - 5) / d; py *= (R - 5) / d; }
            c.beginPath(); c.rect(cx + px - 3.5, cy + py - 3.5, 7, 7);
            if (out) { c.lineWidth = 1.5; c.strokeStyle = p.css; c.stroke(); }
            else { c.fillStyle = p.css; c.fill(); c.lineWidth = 1; c.strokeStyle = 'rgba(255,255,255,.85)'; c.stroke(); }
        }
        // 人物：我方空心环，敌人实心（队伍色），倒地橙色，贴脸红色并带闪环；高差 >3m 加上下小三角
        const alertCss = css(opt.alertColor), downCss = css(opt.downColor);
        for (let pass = 0; pass < 2; pass++) for (let i = 0; i < count; i++) {
            const it = items[i];
            if ((pass === 1) !== !!it.enemy) continue;   // 先画我方，敌人压在上面
            const dx = it.x - rd.x, dy = it.y - rd.y;
            const px = (dx * rx + dy * ry) * k, py = -(dx * fx + dy * fy) * k;
            if (px * px + py * py > R * R) continue;
            const x = cx + px, y = cy + py;
            const col = it.alert ? alertCss : css(it.color);
            c.globalAlpha = it.stale ? 0.45 : 1;
            c.beginPath(); c.arc(x, y, it.enemy ? (it.ai ? 2.6 : 3.4) : 3, 0, Math.PI * 2);
            if (it.enemy) {
                c.fillStyle = col; c.fill();
                c.lineWidth = 1; c.strokeStyle = 'rgba(0,0,0,.75)'; c.stroke();
            } else {
                c.lineWidth = 1.8; c.strokeStyle = col; c.stroke();
            }
            if (rd.z != null && Number.isFinite(it.z)) {
                const dz = it.z - rd.z;
                if (dz > 3 || dz < -3) {
                    const ty = dz > 0 ? y - 6.5 : y + 6.5, h = dz > 0 ? -1.8 : 1.8;
                    c.beginPath(); c.moveTo(x - 2.2, ty - h); c.lineTo(x + 2.2, ty - h); c.lineTo(x, ty + h); c.closePath();
                    c.fillStyle = col; c.fill();
                }
            }
            if (it.alert) {
                c.beginPath(); c.arc(x, y, 6 + 4 * (1 - pulse), 0, Math.PI * 2);
                c.lineWidth = 1.5; c.strokeStyle = alertCss; c.globalAlpha = 0.35 + 0.6 * pulse; c.stroke();
            }
            c.globalAlpha = 1;
        }
        c.restore();
        // 观察者：朝上的箭头
        c.beginPath(); c.moveTo(cx, cy - 7); c.lineTo(cx + 5, cy + 5); c.lineTo(cx, cy + 2); c.lineTo(cx - 5, cy + 5); c.closePath();
        c.fillStyle = '#f4f7fa'; c.fill(); c.lineWidth = 1; c.strokeStyle = 'rgba(0,0,0,.7)'; c.stroke();
        c.font = `600 9px ${FONT_STACK}`;
        c.textAlign = 'center'; c.textBaseline = 'alphabetic';
        c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,.7)';
        const t = Math.round(range) + 'm';
        c.strokeText(t, cx, cy + R - 5); c.fillStyle = 'rgba(232,238,242,.75)'; c.fillText(t, cx, cy + R - 5);
    }

    function clearAll() {
        clear();
        if (radar && radar.shown) { radar.cv.style.display = 'none'; radar.shown = false; }
    }

    return { draw, clear: clearAll };
}
