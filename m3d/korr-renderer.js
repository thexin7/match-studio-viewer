/*
   Korr — 3D scene view (Three.js)
   =============================================================================
   数据流: 复用 app.js 里的 AppState.gameData (WebSocket 收到的 game_data JSON)
   坐标系: UE 世界坐标 cm, Z 是 up 轴
   激活方式: 用户在 radar.html 里点 "3D" 按钮 → window.viewMode = '3d'

   实体:
     玩家   — 胶囊 (队伍色) + 头顶朝向锥体 (yaw) + 头顶名字/血条 sprite
     Boss   — 六边棱柱 (橙色)
     人机   — 小方块 (灰色)
     物资   — 小菱形 (品质色)

   相机: OrbitControls, 上帝俯视, 右键平移, 滚轮缩放, 按 F fit-to-players
   地板: 网格 + 可选的地图纹理平面 (跟 2D 底图同源)

   性能: 每帧从 AppState.gameData 读一次, 若跟上一帧同一份就 skip update.
        实体池化 (提前建 N 个 mesh, 帧内 show/hide + 移位), 避免 create/dispose.
*/

import * as THREE from 'three';
import { isEnemyOfViewer as _isEnemyOfViewer } from './character-detail.js?v=1.1.0';
import {syncCharacterModel,animateCharacterModel} from './character-models.js?v=1.6.0';
import {aimDirection,splitSurfaceIndices} from './gateway-pose.js?v=1.1.0';
import { buildMapChunksAsync } from './map-chunks.js?v=1.4.0';
import { buildMapTexture } from './map-texture.js?v=1.4.0';
import { createHud } from './korr-hud.js?v=1.5.0';
import { createPoiLayer } from './poi-3d.js?v=1.4.0';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// ============================================================================
//  常量
// ============================================================================
/* 色板由页面通过 gateway.setPalette() 下发，与 2D 态势图同一份：同一个人在 2D/3D
   里颜色一致。以前 3D 自带一套色板，2 队在 2D 是橙色、3D 是蓝色，3 队在 3D 是绿色，
   与队友绿撞色。下面的默认值只在页面未下发时兜底。 */
const PALETTE = {
    teams: Array(8).fill(0xff4058),
    self: 0x37e08a, mate: 0x37e08a, ai: 0xff4058, unknown: 0x8c96a8,
    alert: 0xff2d3f, down: 0xffcf4d, dead: 0x475569,
};
function setPalette(p) {
    if (!p) return;
    if (Array.isArray(p.teams) && p.teams.length) {
        const teams = p.teams.map(c => _prefColorHex(c, null)).filter(c => c != null);
        if (teams.length) PALETTE.teams = teams;
    }
    for (const key of ['self', 'mate', 'ai', 'unknown', 'alert', 'down']) PALETTE[key] = _prefColorHex(p[key], PALETTE[key]);
}
function teamColor(team) {
    if (!team || team < 1) return PALETTE.unknown;
    return PALETTE.teams[(team - 1) % PALETTE.teams.length];
}
const QUALITY_COLORS = [0x9ca3af, 0xffffff, 0x22c55e, 0x3b82f6, 0xa855f7, 0xf59e0b, 0xef4444];
function qualityColor(q) {
    if (q < 0 || q >= QUALITY_COLORS.length) return 0x9ca3af;
    return QUALITY_COLORS[q];
}

// UE 单位是 cm, 我们直接用米作为 three.js 场景单位, 系数 0.01
const UE_TO_M = 0.01;
const RADAR_WORLD_UP = new THREE.Vector3(0, 0, 1);
const RADAR_WORLD_LIGHT_DIRECTION = new THREE.Vector3(0.45, -0.55, 0.70).normalize();
const radarViewRotation = new THREE.Matrix3();

/* v700x: UE 世界是左手系 (x=前, y=右, z=上), three.js 是右手系.
   直接把 (x,y,z) 送 three 会导致所有物体的"左右"镜像反 —
   玩家胶囊面向的方向对, 但侧向反, 场景里的左右门也是反的.
   统一解法: 把 UE.y 取负, 让整个世界从左手系翻成右手系.
   yaw 也要跟着翻符号 (绕 z 的旋转方向反了).
   注意: 所有从服务端拿到 UE 坐标的地方 (玩家/AI/BOSS/物资位置 + 地图三角形顶点
   + 2D 小地图 + fitToAll bbox) 都必须过 ueToThree*, 否则会出现地图跟人错位. */
function ueToThreeX(ux) { return ux * UE_TO_M; }
function ueToThreeY(uy) { return -uy * UE_TO_M; }
function ueToThreeZ(uz) { return (uz || 0) * UE_TO_M; }
/* UE yaw (degrees) → three.js rotation.z (radians, 已翻符号) */
function ueYawToThreeRotZ(uyawDeg) { return -(uyawDeg || 0) * Math.PI / 180; }

// 已加载的地图：THREE.Group，子节点是分块 Mesh（userData.radarMapChunk），共享地面/墙两个材质
let mapMesh = null;
let mapBounds = null;        // 当前（或正在切块的）地图包围盒，装图时同步给出，fit 不必等切块完成
let mapInstallSeq = 0;
/* 官方底图投影：纹理按「地图 key + 缩放级」缓存，开关只改强度 uniform 不重复下载；换图时释放。 */
const mapTex = { enabled: true, key: null, entries: new Map(), pending: new Map(), abort: null };
/* 静态缓存阴影（见 _updateLightingRig）。shadowPref：auto / on / off。 */
let shadowPref = 'auto';
const shadowRig = { center: new THREE.Vector3(), span: 0, valid: false, lastAt: 0, casterSig: NaN,
    right: new THREE.Vector3(), up: new THREE.Vector3(), basisReady: false,
    updates: 0, rateAt: 0, rate: 0, sigAt: 0 };
let mapMeshWire = null;
let currentMapName = null;
let mapLoading = false;
let currentMapTriangleCount = 0;

// 小地图 (2D 顶视图, 3D 模式下方位指示)
const minimapCanvas = document.getElementById('minimap3d');
const minimapCtx = minimapCanvas ? minimapCanvas.getContext('2d') : null;

// ============================================================================
//  Three.js 场景
// ============================================================================
const canvas = document.getElementById('r3-cv');
let renderer, scene, camera, controls;
let freeOrbitMinDistance = 0;
let freeOrbitEnablePan = true;
let ambient, dirLight, fillLight, hemi;
let groundMesh, gridHelper;
let composer = null;
let renderPass = null;
let ssaoPass = null;
let bloomPass = null;
let structureEdgePass = null;
let outputPass = null;
let fxaaPass = null;
let ssaoPlainNormalMaterial = null;
let ssaoCutawayNormalMaterial = null;
let environmentTexture = null;
let environmentRenderTarget = null;
let activeQualityProfile = null;
let requestedRenderQuality = 'auto';
let autoQualityCeiling = null;
/* 墙体透明度按镜头模式取值：总览（自由/俯视）用 walltrans，方便看穿建筑找人；
   跟随视角（第一/第三跟随）用 followwalltrans（默认实心），观感接近游戏本身。
   不透明度 ≥ 50% 的墙会写深度：墙后人物改由「掩体后」x 光剪影显示，既保留
   建筑纵深又不丢人。更透明的墙不写深度，人物照常绘制、透过墙可见。 */
let gatewaySurfacePrefs = {walltrans:78, floortrans:0, followwalltrans:0};
function applyGatewaySurfaceOpacity() {
    if (!mapMesh?.userData.gatewayTransparentWalls) return;
    const materials = _getRadarMapMaterials();
    const wall = cameraMode === CAMERA_MODES.FREE ? gatewaySurfacePrefs.walltrans : gatewaySurfacePrefs.followwalltrans;
    [gatewaySurfacePrefs.floortrans, wall].forEach((value, index) => {
        const material = materials[index]; if (!material) return;
        const opacity = 1 - value / 100, transparent = opacity < 1;
        if (material.transparent !== transparent) { material.transparent = transparent; material.needsUpdate = true; }
        material.opacity = opacity; material.visible = opacity > 0;
        material.depthWrite = opacity >= 0.5;
    });
    _requestShadowUpdate();     // 墙完全透明时不投影，缓存的阴影图要重画
}
let indoorClarityEnabled = false; // Gateway uses transparent walls; no camera cutout.
let indoorClarityActive = false;
let indoorClarityLastValidAt = 0;
const INDOOR_CLARITY_STORAGE_KEY = 'relinkRadar3dIndoorClarity.v1';
const INDOOR_CLARITY_LOST_GRACE_MS = 750;
const INDOOR_CLARITY_HEIGHT_ABOVE_ROOT = 1.35;
const INDOOR_CLARITY_TARGET_HEIGHT = 0.70;
const radarCutawayUniforms = {
    radarCutawayCenter: { value: new THREE.Vector2() },
    radarCutawayPlaneZ: { value: 0 },
    radarCutawayRadius: { value: 12 },
    radarCutawayTarget: { value: new THREE.Vector3() },
    radarCutawayCamera: { value: new THREE.Vector3() },
    radarSightlineDirection: { value: new THREE.Vector3(0, 0, -1) },
    radarSightlineLength: { value: 1 },
    radarSightlineNearRadius: { value: 2 },
    radarSightlineRadius: { value: 3 },
    radarSightlineFloorZ: { value: 0 },
};
const qualityMonitor = {
    frames: 0,
    sampleStartedAt: 0,
    warmupUntil: 0,
    lastFrameAt: 0,
};

// 实体池 (提前建 N 个 mesh, 帧内复用)
const POOL = {
    players: [],   // { root, capsule, cone, sprite }
    bosses:  [],
    ais:     [],
    items:   [],
};
const POOL_SIZE = { players: 64, bosses: 8, ais: 128, items: 512 };
const CARD_ICONS = {};
if (typeof Image !== 'undefined') {
    for (const [key, url] of Object.entries({helmet:'/ui/icons/helmet.png?v=1.1.0', armor:'/ui/icons/armor.png?v=1.1.0'})) {
        const image = new Image();
        image.onload = () => {
            CARD_ICONS[key] = image;
            for (const pool of [POOL.players, POOL.bosses]) for (const entity of pool) if (entity.sprite) entity.sprite.userData.key = '';
            if (selfEntity?.sprite) selfEntity.sprite.userData.key = '';
            if (window.AppState) window.AppState.frameCount = (window.AppState.frameCount || 0) + 1;
        };
        image.src = url;
    }
}
const EQUIP_COLORS = [0x9ca3af,0xe5e7eb,0x67d783,0x5aa3ff,0xb778f2,0xf1b44c,0xf15b64];
function _prefColorHex(value, fallback) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(value || ''));
    return match ? parseInt(match[1], 16) : fallback;
}

/* v700x: self entity - 单独一个绿色胶囊表示本人 (房主). data.local 里的坐标
   源自游戏的 LocalPlayer, 不在 players 列表 (WebRadar.cpp 过滤了 IsLocal).
   相机默认会跟随它, 用户双击其他人可切换目标. */
let selfEntity = null;

// 上次渲染的帧数, 用来判断 gameData 是否变了
let lastFrameCount = -1;

// ============================================================================
//  自适应 3D 画质
//  auto: 根据触屏、内存、CPU 与 WebGL2 自动选档；运行中持续低帧率只会向下降档。
// ============================================================================
const RENDER_QUALITY_IDS = new Set(['auto', 'performance', 'balanced', 'high']);
const RENDER_QUALITY_RANK = { performance: 0, balanced: 1, high: 2 };
const RENDER_QUALITY_PROFILES = Object.freeze({
    performance: Object.freeze({
        id: 'performance', pixelRatioCap: 1.0, postPixelRatioCap: 1.0, ssaoScale: 0.5,
        exposure: 1.02, ambient: 0.32, hemisphere: 0.34, keyLight: 1.10, fillLight: 0.15,
        environment: false, environmentIntensity: 0.0,
        shadows: false, shadowMapSize: 0, ssao: false, bloom: false, fxaa: false,
        colorStrength: 1.0, edgeStrength: 0.0, contourStrength: 0.0,
        wallHighlightStrength: 0.18, screenSpaceEdges: false, screenEdgeStrength: 0.0,
        cutTopStrength: 0.16,
        indoorCutRadiusMin: 8.0, indoorCutRadiusMax: 12.0,
        sightlineRadiusMin: 4.5, sightlineRadiusMax: 10.0, sightlinePixels: 90,
        sightlineNearRadius: 2.0,
        contourSpacing: 16.0, roughness: 0.88, metalness: 0.01, entityEmissive: 0.08,
    }),
    balanced: Object.freeze({
        id: 'balanced', pixelRatioCap: 1.35, postPixelRatioCap: 1.0, ssaoScale: 0.5,
        exposure: 0.92, ambient: 0.18, hemisphere: 0.24, keyLight: 1.22, fillLight: 0.14,
        environment: true, environmentIntensity: 0.18,
        shadows: false, shadowMapSize: 0, ssao: false, bloom: false, fxaa: false,
        colorStrength: 1.0, edgeStrength: 0.085, contourStrength: 0.034,
        wallHighlightStrength: 0.18, screenSpaceEdges: false, screenEdgeStrength: 0.0,
        cutTopStrength: 0.18,
        indoorCutRadiusMin: 10.0, indoorCutRadiusMax: 15.0,
        sightlineRadiusMin: 5.5, sightlineRadiusMax: 13.0, sightlinePixels: 105,
        sightlineNearRadius: 2.6,
        contourSpacing: 12.0, roughness: 0.82, metalness: 0.02, entityEmissive: 0.10,
    }),
    high: Object.freeze({
        id: 'high', pixelRatioCap: 1.60, postPixelRatioCap: 1.10, ssaoScale: 0.75,
        exposure: 0.95, ambient: 0.12, hemisphere: 0.20, keyLight: 1.38, fillLight: 0.18,
        environment: true, environmentIntensity: 0.24,
        // bloom 强度 0.08、阈值 0.95，肉眼几乎不可见，却要走 EffectComposer：多一串全屏
        // 模糊 pass，且离屏渲染目标没有 MSAA，边缘反而比「平衡」档更锯齿。关掉后直接渲染。
        shadows: true, shadowMapSize: 1024, ssao: true, bloom: false, fxaa: true,
        colorStrength: 1.0, edgeStrength: 0.11, contourStrength: 0.045,
        wallHighlightStrength: 0.20, screenSpaceEdges: true, screenEdgeStrength: 0.20,
        cutTopStrength: 0.20,
        indoorCutRadiusMin: 12.0, indoorCutRadiusMax: 18.0,
        sightlineRadiusMin: 6.5, sightlineRadiusMax: 16.0, sightlinePixels: 120,
        sightlineNearRadius: 3.2,
        contourSpacing: 10.0, roughness: 0.78, metalness: 0.02, entityEmissive: 0.12,
    }),
});

function _readStoredRenderQuality() {
    try {
        const stored = localStorage.getItem('relinkRadar3dQuality.v1');
        return RENDER_QUALITY_IDS.has(stored) ? stored : 'auto';
    } catch (_) {
        return 'auto';
    }
}
requestedRenderQuality = _readStoredRenderQuality();

function _readStoredIndoorClarity() {
    try {
        const stored = localStorage.getItem(INDOOR_CLARITY_STORAGE_KEY);
        if (stored == null) return true;
        return stored !== '0' && stored !== 'false';
    } catch (_) {
        return true;
    }
}
indoorClarityEnabled = _readStoredIndoorClarity();

function _isMobileGpuProfile() {
    const coarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches === true;
    const narrowScreen = window.matchMedia?.('(max-width: 768px)')?.matches === true;
    return navigator.userAgentData?.mobile === true || (coarsePointer && narrowScreen);
}

function _resolveAutoRenderQuality() {
    const mobile = _isMobileGpuProfile();
    const memory = Number(navigator.deviceMemory || (mobile ? 4 : 8));
    const cores = Number(navigator.hardwareConcurrency || (mobile ? 4 : 8));
    const webgl2 = !renderer || renderer.capabilities.isWebGL2 !== false;
    let resolved;
    if (mobile) {
        resolved = memory <= 3 || cores <= 4 ? 'performance' : 'balanced';
    } else {
        resolved = webgl2 && memory >= 6 && cores >= 6 ? 'high' : 'balanced';
    }
    if (autoQualityCeiling && RENDER_QUALITY_RANK[resolved] > RENDER_QUALITY_RANK[autoQualityCeiling]) {
        resolved = autoQualityCeiling;
    }
    return resolved;
}

function _resolvedRenderQualityId() {
    return requestedRenderQuality === 'auto' ? _resolveAutoRenderQuality() : requestedRenderQuality;
}

function _getRenderQualityState() {
    const profile = activeQualityProfile || RENDER_QUALITY_PROFILES[_resolvedRenderQualityId()];
    return {
        requested: requestedRenderQuality,
        effective: profile.id,
        shadows: !!profile.shadows && !!renderer?.shadowMap?.enabled,
        ssao: !!profile.ssao && !!ssaoPass?.enabled && renderer?.capabilities?.isWebGL2 !== false,
        bloom: !!profile.bloom && !!bloomPass?.enabled,
        fxaa: !!profile.fxaa && !!fxaaPass?.enabled,
        environment: !!profile.environment && !!environmentTexture && scene?.environment === environmentTexture,
        edgeEnhancement: profile.wallHighlightStrength > 0 || !!structureEdgePass?.enabled,
        screenSpaceEdges: !!structureEdgePass?.enabled,
    };
}

function _dispatchRenderQualityChanged() {
    window.dispatchEvent(new CustomEvent('radar3dQualityChanged', { detail: _getRenderQualityState() }));
}

function _injectRadarCutawayShader(shader) {
    Object.assign(shader.uniforms, radarCutawayUniforms);
    shader.vertexShader = shader.vertexShader
        .replace(
            '#include <common>',
            '#include <common>\nvarying vec3 vRadarCutWorldPosition;',
        )
        .replace(
            '#include <displacementmap_vertex>',
            `#include <displacementmap_vertex>
vRadarCutWorldPosition = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`,
        );
    shader.fragmentShader = shader.fragmentShader
        .replace(
            '#include <clipping_planes_pars_fragment>',
            `#include <clipping_planes_pars_fragment>
varying vec3 vRadarCutWorldPosition;
uniform vec2 radarCutawayCenter;
uniform float radarCutawayPlaneZ;
uniform float radarCutawayRadius;
uniform vec3 radarCutawayTarget;
uniform vec3 radarCutawayCamera;
uniform vec3 radarSightlineDirection;
uniform float radarSightlineLength;
uniform float radarSightlineNearRadius;
uniform float radarSightlineRadius;
uniform float radarSightlineFloorZ;`,
        )
        .replace(
            '#include <clipping_planes_fragment>',
            `#include <clipping_planes_fragment>
vec2 radarCutawayDelta = vRadarCutWorldPosition.xy - radarCutawayCenter;
bool radarInsideTargetCut = dot( radarCutawayDelta, radarCutawayDelta )
    < radarCutawayRadius * radarCutawayRadius
    && vRadarCutWorldPosition.z > radarCutawayPlaneZ;
vec3 radarSightlineOffsetFromCamera = vRadarCutWorldPosition - radarCutawayCamera;
float radarSightlineAlong = dot( radarSightlineOffsetFromCamera, radarSightlineDirection );
float radarSightlineT = clamp( radarSightlineAlong / max( radarSightlineLength, 0.001 ), 0.0, 1.0 );
float radarSightlineWidth = mix( radarSightlineNearRadius, radarSightlineRadius, radarSightlineT );
vec3 radarSightlineOffset = radarSightlineOffsetFromCamera - radarSightlineDirection * radarSightlineAlong;
bool radarInsideSightlineCut = radarSightlineAlong > 0.25
    && radarSightlineAlong < radarSightlineLength + 0.50
    && dot( radarSightlineOffset, radarSightlineOffset ) < radarSightlineWidth * radarSightlineWidth
    && vRadarCutWorldPosition.z > radarSightlineFloorZ;
if ( radarInsideTargetCut || radarInsideSightlineCut ) discard;`,
        );
}

function _createCutawayNormalMaterial() {
    const material = new THREE.MeshNormalMaterial({
        flatShading: true,
        side: THREE.DoubleSide,
        blending: THREE.NoBlending,
    });
    material.onBeforeCompile = shader => _injectRadarCutawayShader(shader);
    material.customProgramCacheKey = () => 'relink-radar-ssao-cutaway-v3';
    return material;
}

function _createStructureEdgePass(normalRenderTarget) {
    const pass = new ShaderPass({
        uniforms: {
            tDiffuse: { value: null },
            tNormal: { value: normalRenderTarget.texture },
            tDepth: { value: normalRenderTarget.depthTexture },
            radarEdgeResolution: { value: new THREE.Vector2(1, 1) },
            radarCameraNear: { value: 0.2 },
            radarCameraFar: { value: 50000 },
            radarProjectionInverse: { value: new THREE.Matrix4() },
            radarCameraWorld: { value: new THREE.Matrix4() },
            radarStructureEdgeColor: { value: new THREE.Color(0x2ac2d0) },
            radarStructureEdgeStrength: { value: 0.20 },
            radarCutawayActive: { value: 0 },
            radarCutawayCenter: { value: new THREE.Vector2() },
            radarCutawayPlaneZ: { value: 0 },
            radarCutawayRadius: { value: 12 },
            radarCutawayTarget: { value: new THREE.Vector3() },
            radarCutawayCamera: { value: new THREE.Vector3() },
            radarSightlineDirection: { value: new THREE.Vector3(0, 0, -1) },
            radarSightlineLength: { value: 1 },
            radarSightlineNearRadius: { value: 2 },
            radarSightlineRadius: { value: 3 },
            radarSightlineFloorZ: { value: 0 },
        },
        vertexShader: `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`,
        fragmentShader: `
#include <packing>
uniform sampler2D tDiffuse;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform vec2 radarEdgeResolution;
uniform float radarCameraNear;
uniform float radarCameraFar;
uniform mat4 radarProjectionInverse;
uniform mat4 radarCameraWorld;
uniform vec3 radarStructureEdgeColor;
uniform float radarStructureEdgeStrength;
uniform float radarCutawayActive;
uniform vec2 radarCutawayCenter;
uniform float radarCutawayPlaneZ;
uniform float radarCutawayRadius;
uniform vec3 radarCutawayTarget;
uniform vec3 radarCutawayCamera;
uniform vec3 radarSightlineDirection;
uniform float radarSightlineLength;
uniform float radarSightlineNearRadius;
uniform float radarSightlineRadius;
uniform float radarSightlineFloorZ;
varying vec2 vUv;

vec3 radarReadNormal( vec2 uv ) {
    return normalize( texture2D( tNormal, uv ).xyz * 2.0 - 1.0 );
}

float radarReadViewDepth( vec2 uv ) {
    float depth = texture2D( tDepth, uv ).x;
    return -perspectiveDepthToViewZ( depth, radarCameraNear, radarCameraFar );
}

vec3 radarReconstructWorld( vec2 uv, float depth ) {
    vec4 clip = vec4( uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
    vec4 view = radarProjectionInverse * clip;
    view /= max( view.w, 0.000001 );
    return ( radarCameraWorld * view ).xyz;
}

void main() {
    vec4 base = texture2D( tDiffuse, vUv );
    float centerDepth = texture2D( tDepth, vUv ).x;
    if ( centerDepth >= 0.999999 ) {
        gl_FragColor = base;
        return;
    }

    vec2 texel = 1.0 / max( radarEdgeResolution, vec2( 1.0 ) );
    vec2 uvL = vUv - vec2( texel.x, 0.0 );
    vec2 uvR = vUv + vec2( texel.x, 0.0 );
    vec2 uvD = vUv - vec2( 0.0, texel.y );
    vec2 uvU = vUv + vec2( 0.0, texel.y );
    vec3 nC = radarReadNormal( vUv );
    float normalDelta = max(
        max( 1.0 - dot( nC, radarReadNormal( uvL ) ), 1.0 - dot( nC, radarReadNormal( uvR ) ) ),
        max( 1.0 - dot( nC, radarReadNormal( uvD ) ), 1.0 - dot( nC, radarReadNormal( uvU ) ) )
    );
    float normalEdge = smoothstep( 0.045, 0.20, normalDelta );

    float zC = radarReadViewDepth( vUv );
    float zL = radarReadViewDepth( uvL );
    float zR = radarReadViewDepth( uvR );
    float zD = radarReadViewDepth( uvD );
    float zU = radarReadViewDepth( uvU );
    float depthLap = ( abs( zL + zR - 2.0 * zC ) + abs( zD + zU - 2.0 * zC ) ) / max( zC, 1.0 );
    float depthEdge = smoothstep( 0.002, 0.018, depthLap );
    float artificialEdgeMask = 0.0;
    if ( radarCutawayActive > 0.5 ) {
        vec3 worldPosition = radarReconstructWorld( vUv, centerDepth );
        float ringDistance = abs( length( worldPosition.xy - radarCutawayCenter ) - radarCutawayRadius );
        float ringMask = step( radarCutawayPlaneZ, worldPosition.z )
            * ( 1.0 - smoothstep( 0.35, 1.50, ringDistance ) );
        float targetInterior = 1.0 - step( radarCutawayRadius + 0.75,
            length( worldPosition.xy - radarCutawayCenter ) );
        float targetPlaneMask = targetInterior
            * ( 1.0 - smoothstep( 0.10, 0.75, abs( worldPosition.z - radarCutawayPlaneZ ) ) );
        vec3 sightlineOffsetFromCamera = worldPosition - radarCutawayCamera;
        float sightlineAlong = dot( sightlineOffsetFromCamera, radarSightlineDirection );
        float sightlineT = clamp( sightlineAlong / max( radarSightlineLength, 0.001 ), 0.0, 1.0 );
        float sightlineWidth = mix( radarSightlineNearRadius, radarSightlineRadius, sightlineT );
        vec3 sightlinePerpendicular = sightlineOffsetFromCamera
            - radarSightlineDirection * sightlineAlong;
        float sightlineRadialDistance = length( sightlinePerpendicular );
        float sightlineBoundary = abs( sightlineRadialDistance - sightlineWidth );
        float sightlineMask = step( 0.25, sightlineAlong )
            * step( sightlineAlong, radarSightlineLength + 0.50 )
            * step( radarSightlineFloorZ, worldPosition.z )
            * ( 1.0 - smoothstep( 0.25, 1.25, sightlineBoundary ) );
        float sightlineFloorMask = step( 0.25, sightlineAlong )
            * step( sightlineAlong, radarSightlineLength + 0.50 )
            * step( sightlineRadialDistance, sightlineWidth + 0.75 )
            * ( 1.0 - smoothstep( 0.10, 0.70, abs( worldPosition.z - radarSightlineFloorZ ) ) );
        artificialEdgeMask = max( max( ringMask, targetPlaneMask ),
            max( sightlineMask, sightlineFloorMask ) );
    }

    depthEdge *= 1.0 - artificialEdgeMask * 0.98;
    normalEdge *= 1.0 - artificialEdgeMask * 0.75;
    float edge = max( normalEdge, depthEdge );
    edge *= 1.0 - smoothstep( 700.0, 1800.0, zC );

    gl_FragColor = vec4( base.rgb + radarStructureEdgeColor * edge * radarStructureEdgeStrength, base.a );
}`,
    });
    pass.material.depthTest = false;
    pass.material.depthWrite = false;
    return pass;
}

function _ensureEnvironmentTexture() {
    if (environmentTexture || !renderer) return environmentTexture;
    try {
        const pmrem = new THREE.PMREMGenerator(renderer);
        const room = new RoomEnvironment(renderer);
        environmentRenderTarget = pmrem.fromScene(room, 0.04);
        environmentTexture = environmentRenderTarget.texture;
        room.dispose();
        pmrem.dispose();
    } catch (error) {
        console.warn('[Radar3D] 环境反射初始化失败，回退到基础光照:', error);
        environmentTexture = null;
    }
    return environmentTexture;
}

function _ensurePostProcessing() {
    if (composer || !renderer || !scene || !camera || renderer.capabilities.isWebGL2 === false) return composer;
    try {
        const size = renderer.getSize(new THREE.Vector2());
        composer = new EffectComposer(renderer);
        renderPass = new RenderPass(scene, camera);
        ssaoPass = new SSAOPass(scene, camera, size.x, size.y, 8);
        ssaoPlainNormalMaterial = ssaoPass.normalMaterial;
        ssaoPlainNormalMaterial.flatShading = true;
        ssaoPlainNormalMaterial.side = THREE.DoubleSide;
        ssaoPlainNormalMaterial.needsUpdate = true;
        ssaoCutawayNormalMaterial = _createCutawayNormalMaterial();
        const defaultSsaoOverrideVisibility = ssaoPass.overrideVisibility.bind(ssaoPass);
        ssaoPass.overrideVisibility = function() {
            defaultSsaoOverrideVisibility();
            this.scene.traverse(object => {
                if (object.isSprite || object.userData?.radarExcludeFromSsao ||
                    (object.isMesh && !object.userData?.radarMapChunk)) object.visible = false;
            });
        };
        ssaoPass.kernelRadius = 8;
        ssaoPass.minDistance = 0.0025;
        ssaoPass.maxDistance = 0.12;
        bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.08, 0.18, 0.95);
        structureEdgePass = _createStructureEdgePass(ssaoPass.normalRenderTarget);
        outputPass = new OutputPass();
        fxaaPass = new ShaderPass(FXAAShader);
        composer.addPass(renderPass);
        composer.addPass(ssaoPass);
        composer.addPass(bloomPass);
        composer.addPass(structureEdgePass);
        composer.addPass(outputPass);
        // Three.js r161 官方建议 FXAA 在 OutputPass 完成 LDR/sRGB 转换后执行。
        composer.addPass(fxaaPass);
    } catch (error) {
        console.warn('[Radar3D] SSAO 初始化失败，回退到直接渲染:', error);
        _disposePostProcessing();
    }
    return composer;
}

function _disposePostProcessing() {
    if (ssaoPass && ssaoPlainNormalMaterial) ssaoPass.normalMaterial = ssaoPlainNormalMaterial;
    ssaoPass?.dispose?.();
    ssaoCutawayNormalMaterial?.dispose?.();
    bloomPass?.dispose?.();
    structureEdgePass?.dispose?.();
    outputPass?.dispose?.();
    fxaaPass?.dispose?.();
    composer?.dispose?.();
    composer = null;
    renderPass = null;
    ssaoPass = null;
    ssaoPlainNormalMaterial = null;
    ssaoCutawayNormalMaterial = null;
    bloomPass = null;
    structureEdgePass = null;
    outputPass = null;
    fxaaPass = null;
}

function _disposeEnvironmentTexture() {
    if (scene?.environment === environmentTexture) scene.environment = null;
    environmentRenderTarget?.dispose?.();
    environmentRenderTarget = null;
    environmentTexture = null;
}

function _applyQualityToSceneObjects(profile) {
    if (!scene) return;
    scene.traverse(object => {
        if (!object?.userData?.radarLitSurface) return;
        const material = object.material;
        if (material?.isMeshStandardMaterial) {
            material.envMapIntensity = profile.environmentIntensity;
            material.emissiveIntensity = object.userData.radarEntitySurface ? profile.entityEmissive : 0;
            material.needsUpdate = true;
        }
        object.castShadow = !!profile.shadows && object.userData.radarShadowCaster !== false;
        object.receiveShadow = !!profile.shadows && object.userData.radarShadowReceiver !== false;
    });
    // 地图分块：开阴影时建筑既投影也受影；分块后阴影 pass 只画阴影框内的块
    if (mapMesh) for (const chunk of mapMesh.children) {
        chunk.castShadow = !!profile.shadows;
        chunk.receiveShadow = !!profile.shadows;
    }
    _requestShadowUpdate();
    if (gridHelper) {
        const materials = Array.isArray(gridHelper.material) ? gridHelper.material : [gridHelper.material];
        for (const material of materials) {
            material.transparent = true;
            material.opacity = profile.id === 'performance' ? 0.10 : 0.11;
        }
    }
}

function _getRadarMapMaterials(mesh = mapMesh) {
    if (!mesh) return [];
    const variants = mesh.userData?.radarMaterials;
    if (variants) return [...new Set([variants.plain, variants.cutaway].flat().filter(Boolean))];
    return mesh.material ? [mesh.material] : [];
}

function _disposeRadarMapMaterials(mesh) {
    for (const material of _getRadarMapMaterials(mesh)) material.dispose?.();
}

function _applyMapMaterialQuality(profile) {
    for (const material of _getRadarMapMaterials()) {
        if (!material?.isMeshStandardMaterial) continue;
        material.roughness = profile.roughness;
        material.metalness = profile.metalness;
        material.envMapIntensity = profile.environmentIntensity;
        const uniforms = material.userData.radarUniforms;
        if (uniforms) {
            uniforms.radarColorStrength.value = profile.colorStrength;
            uniforms.radarEdgeStrength.value = profile.edgeStrength;
            uniforms.radarContourStrength.value = profile.contourStrength;
            uniforms.radarWallHighlightStrength.value = profile.wallHighlightStrength;
            uniforms.radarCutTopStrength.value = profile.cutTopStrength;
            uniforms.radarDetailEnabled.value = profile.edgeStrength > 0 || profile.contourStrength > 0 ? 1 : 0;
            uniforms.radarGroundRoughness.value = profile.roughness;
            uniforms.radarWallRoughness.value = Math.min(1, profile.roughness + 0.10);
            uniforms.radarMetalness.value = profile.metalness;
            uniforms.radarContourSpacing.value = Math.max(
                material.userData.radarAdaptiveContour || 0,
                profile.contourSpacing,
            );
        }
        material.needsUpdate = true;
    }
    _applyMapViewStyle();
}

/* 写入当前地图风格的配色，并按镜头模式调整结构强调：第一视角下墙面占满画面，
   战术风格的墙体自发光与等高线会把整面墙刷成同一种亮青色、丢掉光照明暗，
   因此压低自发光、关掉等高线、略加强掠射角轮廓光。只改 uniform，不触发重编译。 */
function _applyMapViewStyle() {
    const profile = activeQualityProfile || RENDER_QUALITY_PROFILES[_resolvedRenderQualityId()];
    const fpv = cameraMode === CAMERA_MODES.FIRST_PERSON;
    const style = _mapStyle();
    for (const material of _getRadarMapMaterials()) {
        const u = material?.userData?.radarUniforms;
        if (!u) continue;
        u.radarGroundLow.value.setHex(style.groundLow);
        u.radarGroundHigh.value.setHex(style.groundHigh);
        u.radarWallLow.value.setHex(style.wallLow);
        u.radarWallHigh.value.setHex(style.wallHigh);
        u.radarEdgeColor.value.setHex(style.edge);
        u.radarWallHighlightStrength.value = profile.wallHighlightStrength * style.wallHighlight * (fpv ? 0.3 : 1);
        u.radarContourStrength.value = fpv ? 0 : profile.contourStrength * style.contour;
        u.radarEdgeStrength.value = profile.edgeStrength * style.edgeScale * (fpv ? 1.6 : 1);
        u.radarDetailEnabled.value = u.radarEdgeStrength.value > 0 || u.radarContourStrength.value > 0 ? 1 : 0;
    }
    _syncMapTexture();
}

function _applyRenderQuality() {
    if (!renderer || !scene) return _getRenderQualityState();
    const resolvedId = _resolvedRenderQualityId();
    const base = RENDER_QUALITY_PROFILES[resolvedId];
    const profile = { ...base, ssao:false, screenSpaceEdges:false }; // Solid-depth SSAO is inappropriate for transparent walls.
    profile.shadows = _shadowsWanted(base);
    profile.shadowMapSize = base.id === 'high' ? 2048 : 1024;
    if (renderer.capabilities.isWebGL2 === false) {
        profile.ssao = false;
        profile.bloom = false;
        profile.fxaa = false;
    }
    activeQualityProfile = profile;

    const dpr = Math.max(0.75, Number(window.devicePixelRatio || 1));
    renderer.setPixelRatio(Math.min(dpr, profile.pixelRatioCap));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = profile.exposure;
    renderer.shadowMap.enabled = !!profile.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // 阴影图静态缓存：只在阴影框跨格、场景变化或人物移动（约 10 Hz）时重画，见 _updateLightingRig
    renderer.shadowMap.autoUpdate = false;
    _requestShadowUpdate();

    if (ambient) ambient.intensity = profile.ambient;
    if (hemi) hemi.intensity = profile.hemisphere;
    if (dirLight) {
        dirLight.intensity = profile.keyLight;
        dirLight.castShadow = !!profile.shadows;
        if (profile.shadows && dirLight.shadow.mapSize.width !== profile.shadowMapSize) {
            dirLight.shadow.map?.dispose();
            dirLight.shadow.map = null;
            dirLight.shadow.mapSize.set(profile.shadowMapSize, profile.shadowMapSize);
        }
    }
    if (fillLight) fillLight.intensity = profile.fillLight;

    if (profile.environment) _ensureEnvironmentTexture();
    else _disposeEnvironmentTexture();
    scene.environment = profile.environment ? environmentTexture : null;
    if (profile.ssao || profile.bloom || profile.fxaa) _ensurePostProcessing();
    else _disposePostProcessing();
    if (composer) {
        composer.setPixelRatio(Math.min(dpr, profile.postPixelRatioCap));
        if (ssaoPass) ssaoPass.enabled = !!profile.ssao;
        if (bloomPass) bloomPass.enabled = !!profile.bloom;
        if (structureEdgePass) {
            structureEdgePass.enabled = !!profile.screenSpaceEdges && !!ssaoPass?.enabled;
            structureEdgePass.uniforms.radarStructureEdgeStrength.value = profile.screenEdgeStrength;
        }
        if (fxaaPass) fxaaPass.enabled = !!profile.fxaa && !!structureEdgePass?.enabled;
    }
    _applyQualityToSceneObjects(profile);
    _applyMapMaterialQuality(profile);
    _applyIndoorClarityRenderingState();
    resize();
    qualityMonitor.frames = 0;
    qualityMonitor.sampleStartedAt = 0;
    qualityMonitor.lastFrameAt = 0;
    qualityMonitor.warmupUntil = performance.now() + 6000;
    _applyStyleLights();
    _dispatchRenderQualityChanged();
    console.log(`[Radar3D] 画质 ${requestedRenderQuality} → ${profile.id}`);
    return _getRenderQualityState();
}

window.radar3dSetQuality = function(mode) {
    if (!RENDER_QUALITY_IDS.has(mode)) throw new Error(`未知 3D 画质模式: ${mode}`);
    requestedRenderQuality = mode;
    autoQualityCeiling = mode === 'auto' && currentMapTriangleCount > 700000
        ? 'balanced'
        : null;
    try { localStorage.setItem('relinkRadar3dQuality.v1', mode); } catch (_) {}
    return renderer ? _applyRenderQuality() : _getRenderQualityState();
};

window.radar3dGetQualityState = function() {
    return _getRenderQualityState();
};

// ============================================================================
//  初始化
// ============================================================================
function init() {
    renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x0b0f18, 1.0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;

    scene = new THREE.Scene();
    // fog 距离随场景规模, 现在 8-30k, 覆盖 3km 级地图
    scene.fog = new THREE.Fog(0x0b0f18, 8000, 30000);

    /* v698g5: FOV 55→75 缓解透视压缩感 — 小 FOV 相当于"长焦压缩", 前景物体会显得
       比实际大. 俯瞰视角用 70-80° 舒适, 太大会有鱼眼畸变. */
    camera = new THREE.PerspectiveCamera(75, 1, 0.2, 50000);
    camera.position.set(1000, 1000, 1000);
    camera.up.set(0, 0, 1);   // UE 世界 Z 是 up

    controls = new OrbitControls(camera, canvas);
    freeOrbitMinDistance = controls.minDistance;
    freeOrbitEnablePan = controls.enablePan;
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.target.set(0, 0, 0);
    // OrbitControls 默认按 world up = Y, 我们改成 Z, 但 controls 内部会跟着 camera.up 变

    /* v700x: 手机触屏优化 — 手指头旋转/缩放感觉太慢, 手机上放大灵敏度. */
    const isMobile = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
    if (isMobile) {
        controls.rotateSpeed = 1.6;   // 单指旋转灵敏度 (默认 1)
        controls.zoomSpeed   = 2.0;   // 双指 pinch (默认 1)
        controls.panSpeed    = 1.3;   // 双指 pan (默认 1)
        controls.dampingFactor = 0.15; // 稍强阻尼, 抵消加倍灵敏度带来的抖动
    }
    /* 手机 touch 映射: 单指 rotate, 双指 pan+dolly (OrbitControls 默认); 明确设一下防将来改动 */
    if (controls.touches) {
        controls.touches.ONE = THREE.TOUCH.ROTATE;
        controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    }

    // 光照 — 强烈方向光, 让建筑面明暗对比清晰; 环境光只填一点点色调
    ambient = new THREE.AmbientLight(0xffffff, 0.28);
    scene.add(ambient);
    hemi = new THREE.HemisphereLight(0x88aaff, 0x332211, 0.35);
    scene.add(hemi);
    dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
    dirLight.position.set(180, -220, 360);
    dirLight.shadow.bias = -0.0002;
    dirLight.shadow.normalBias = 0.055;
    dirLight.shadow.radius = 2;
    scene.add(dirLight);
    scene.add(dirLight.target);
    // 副方向光 (反向, 补暗侧)
    fillLight = new THREE.DirectionalLight(0x9fc8ff, 0.35);
    fillLight.position.set(-180, 120, 160);
    scene.add(fillLight);
    scene.add(fillLight.target);

    // 网格地板 (辅助定位) — 地图规模 3km, 网格盖 4km × 4km, 每 100m 一格
    gridHelper = new THREE.GridHelper(4000, 40, 0x334155, 0x1e293b);
    gridHelper.rotation.x = Math.PI / 2;
    gridHelper.position.z = 0;
    scene.add(gridHelper);

    // 无纹理的半透明地面 (可选)
    const groundGeo = new THREE.PlaneGeometry(4000, 4000);
    const groundMat = new THREE.MeshStandardMaterial({
        color: 0x0f1729,
        roughness: 1.0,
        metalness: 0.0,
        transparent: true,
        opacity: 0.15,
        side: THREE.DoubleSide,
    });
    groundMesh = new THREE.Mesh(groundGeo, groundMat);
    groundMesh.position.z = -0.1;
    groundMesh.userData.radarLitSurface = true;
    groundMesh.userData.radarShadowCaster = false;
    groundMesh.userData.radarShadowReceiver = true;
    scene.add(groundMesh);

    // 世界坐标轴 (调试用)
    const axes = new THREE.AxesHelper(50);
    axes.visible = false;
    scene.add(axes);

    // 建实体池
    buildPools();

    _applyRenderQuality();
    _applyMapStyle();

    // 小地图点击放大
    setupMinimapClick();

    // 大小同步
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('viewModeChanged', (e) => {
        qualityMonitor.frames = 0;
        qualityMonitor.sampleStartedAt = 0;
        qualityMonitor.lastFrameAt = 0;
        qualityMonitor.warmupUntil = performance.now() + 1500;
        // 切回 3D 时刷新 canvas 尺寸
        if (e.detail === '3d') requestAnimationFrame(resize);
    });
    document.addEventListener('visibilitychange', () => {
        qualityMonitor.frames = 0;
        qualityMonitor.sampleStartedAt = 0;
        qualityMonitor.lastFrameAt = 0;
        qualityMonitor.warmupUntil = performance.now() + 1500;
    });

    // 键盘: F = fit-to-players, A = fit-to-all (地图+玩家), Esc = 取消跟随
    window.addEventListener('keydown', (e) => {
        if (e.defaultPrevented) return;
        if (window.viewMode !== '3d') return;
        if (e.key === 'f' || e.key === 'F') fitToPlayers();
        if (e.key === 'a' || e.key === 'A') fitToAll();
        if (e.key === 'Escape' && cameraMode !== CAMERA_MODES.FREE) {
            _setFollowTarget(null);
            console.log('[Radar3D] 取消跟随 (Esc)');
        }
    });

    // URL query ?map=<name> 强制加载指定地图 (调试用, 无 provider 数据时也能看)
    const urlMap = new URLSearchParams(location.search).get('map');
    if (urlMap) {
        setTimeout(() => loadMap(urlMap), 500);
    }

    // 全局暴露 loadMap 供 console 调试: window.__loadMap('大坝')
    window.__loadMap = loadMap;

    _applyCameraModeControls();
    _syncFollowButton();
    _dispatchViewStateChanged();
    _dispatchIndoorClarityChanged();

    // 启动渲染循环
    renderer.setAnimationLoop(tick);
}

// ============================================================================
//  实体池
// ============================================================================
function makeHeadingMesh(style, occluded) {
    const geometry = style === 'line'
        ? new THREE.BoxGeometry(1.6, 0.10, 0.10)
        : new THREE.ConeGeometry(0.35, 1.2, 6);
    const material = new THREE.MeshBasicMaterial({
        color: occluded ? 0xff4058 : 0xffffff,
        depthTest: true,
        depthFunc: occluded ? THREE.GreaterDepth : THREE.LessEqualDepth,
        fog: !occluded,
        depthWrite: !occluded,
        transparent: occluded,
        opacity: occluded ? 0.78 : 1,
    });
    const mesh = new THREE.Mesh(geometry, material);
    if (style === 'arrow') mesh.rotation.z = -Math.PI / 2;
    mesh.renderOrder = occluded ? 1002 : 0;
    mesh.userData = {
        headingStyle: style,
        headingOccluded: occluded,
        radarExcludeFromSsao: occluded,
        radarLitSurface: !occluded,
        radarEntitySurface: !occluded,
    };
    return mesh;
}

function buildPlayerEntity() {
    const group = new THREE.Group();
    /* v698g5: 真人尺度 1.8m 胶囊 (radius=0.4 + length=1.0, 总高=1.8m).
       v700x: UE 传来的 z 是玩家 RootComponent 位置 = 胶囊 *中心* (脚底上方 ~0.9m),
              所以 mesh 本地 z 保持 0 让几何中心对齐 group.origin.
              以前 mesh.z=0.9 把整个人抬高了半个身位 → 头顶穿模. */
    const capsuleGeo = new THREE.CapsuleGeometry(0.4, 1.0, 6, 12);

    const capsuleMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, depthTest: true, transparent: false,
    });
    const capsule = new THREE.Mesh(capsuleGeo, capsuleMat);
    capsule.userData.radarLitSurface = true;
    capsule.userData.radarEntitySurface = true;
    capsule.rotation.x = Math.PI / 2;
    capsule.position.z = 0;
    group.add(capsule);

    const occMat = new THREE.MeshBasicMaterial({
        color: 0xff2233, depthTest: true, depthFunc: THREE.GreaterDepth, fog: false,
        depthWrite: false, transparent: true, opacity: 0.6,
    });
    const occCapsule = new THREE.Mesh(capsuleGeo, occMat);
    occCapsule.userData.radarExcludeFromSsao = true;
    occCapsule.rotation.x = Math.PI / 2;
    occCapsule.position.z = 0;
    occCapsule.renderOrder = 999;
    group.add(occCapsule);

    // 可见与掩体后各自渲染一套朝向；样式和锚点由设置切换。
    const headings = {
        arrow: { visible: makeHeadingMesh('arrow', false), occluded: makeHeadingMesh('arrow', true) },
        line: { visible: makeHeadingMesh('line', false), occluded: makeHeadingMesh('line', true) },
    };
    for (const pair of Object.values(headings)) group.add(pair.visible, pair.occluded);
    const cone = headings.arrow.visible; // compatibility alias for older diagnostics/tests

    /* v700x3: 侧边血条 (世界空间 mesh, 跟胶囊一起缩) */
    const hpBar = makeHpBar();
    hpBar.group.userData.radarExcludeFromSsao = true;
    /* hpBar.group 挂 root 下, group.position 已经在 makeHpBar 里设了 x=-0.55 */
    group.add(hpBar.group);

    /* 信息卡锚在脚底下方，避免遮住模型和准星。 */
    const sprite = makeInfoCardSprite();
    sprite.position.set(0, 0, -0.96);
    group.add(sprite);

    group.userData = { kind: 'player', poolIdx: -1 };

    return { root: group, capsule, occCapsule, cone, headings, sprite, hpBar };
}

function buildBossEntity() {
    const group = new THREE.Group();
    /* v700x: Boss 跟 AI 用同款方块几何 (1.7m 高), 只用橙色跟 AI 的灰色区分.
       之前是六棱柱 2.0m, 视觉噪音多. */
    const geo = new THREE.BoxGeometry(0.6, 0.6, 1.7);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff7043, depthTest: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.radarLitSurface = true;
    mesh.userData.radarEntitySurface = true;
    mesh.position.z = 0;
    group.add(mesh);
    const occMat = new THREE.MeshBasicMaterial({
        color: 0xffaa33, depthTest: true, depthFunc: THREE.GreaterDepth, fog: false,
        depthWrite: false, transparent: true, opacity: 0.6,
    });
    const occ = new THREE.Mesh(geo, occMat);
    occ.userData.radarExcludeFromSsao = true;
    occ.position.z = 0;
    occ.renderOrder = 999;
    group.add(occ);

    const hpBar = makeHpBar();
    hpBar.group.userData.radarExcludeFromSsao = true;
    hpBar.group.position.x = -0.55;
    group.add(hpBar.group);

    const sprite = makeInfoCardSprite();
    sprite.position.set(0, 0, -0.96);
    group.add(sprite);
    group.userData = { kind: 'boss', poolIdx: -1 };
    return { root: group, mesh, occ, sprite, hpBar };
}

function buildAIEntity() {
    const group = new THREE.Group();
    /* v698g5: AI 真人尺度小方块 (0.6×0.6×1.7m)
       v700x: 几何中心对齐 group.origin (UE 传来的 z 是 pawn 中心) */
    const geo = new THREE.BoxGeometry(0.6, 0.6, 1.7);
    const mat = new THREE.MeshBasicMaterial({ color: 0x64748b, depthTest: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.radarLitSurface = true;
    mesh.userData.radarEntitySurface = true;
    mesh.position.z = 0;
    group.add(mesh);
    const occMat = new THREE.MeshBasicMaterial({
        color: 0xa78bfa, depthTest: true, depthFunc: THREE.GreaterDepth, fog: false,
        depthWrite: false, transparent: true, opacity: 0.5,
    });
    const occ = new THREE.Mesh(geo, occMat);
    occ.userData.radarExcludeFromSsao = true;
    occ.position.z = 0;
    occ.renderOrder = 999;
    group.add(occ);

    /* v700x3: AI 也用侧边血条, 但不给 info sprite (AI 数量大不铺字) */
    const hpBar = makeHpBar();
    hpBar.group.userData.radarExcludeFromSsao = true;
    hpBar.group.position.x = -0.5;
    group.add(hpBar.group);

    const sprite = makeInfoCardSprite();
    sprite.position.set(0, 0, -0.96);
    sprite.visible = false;      // AI 默认不显示 info sprite
    group.add(sprite);
    group.userData = { kind: 'ai', poolIdx: -1 };
    return { root: group, mesh, occ, sprite, hpBar };
}

function buildItemEntity() {
    /* 物资 = group (菱形 + 名字 sprite). v700x: 加名字 sprite, 屏幕像素固定. */
    const group = new THREE.Group();
    const geo = new THREE.OctahedronGeometry(0.4, 0);
    const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, depthTest: false,
        transparent: true, opacity: 0.85,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.radarExcludeFromSsao = true;
    mesh.position.z = 0.5;
    mesh.renderOrder = 998;
    group.add(mesh);

    /* 名字 sprite (canvas 128×32, 屏幕像素固定 20px 高) */
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 40;
    const ctx = cv.getContext('2d');
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spMat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(spMat);
    sprite.position.set(0, 0, 1.1);
    sprite.scale.set(1.6, 0.25, 1);
    sprite.renderOrder = 999;
    sprite.userData = { canvas: cv, ctx, tex, key: '', baseW: 1.6, baseH: 0.25 };
    group.add(sprite);

    return { root: group, mesh, sprite };
}

function _drawItemLabel(sp, name, quality) {
    /* v700x3: 只显示名字, 不显示价格 (要看价格看右侧列表).
       名字长自动省略. */
    const key = `${name}|${quality}`;
    if (sp.userData.key === key) return;
    sp.userData.key = key;
    const ctx = sp.userData.ctx;
    const cv = ctx.canvas;
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);

    const label = name || '???';

    /* 品质色: 0灰 1白 2绿 3蓝 4紫 5金 6红 */
    const bgColors = ['rgba(107,114,128,0.9)', 'rgba(255,255,255,0.85)',
                      'rgba(34,197,94,0.9)', 'rgba(59,130,246,0.9)',
                      'rgba(168,85,247,0.9)', 'rgba(255,170,0,0.92)',
                      'rgba(239,68,68,0.9)'];
    const bg = bgColors[quality] || bgColors[0];

    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const tw = ctx.measureText(label).width;
    const padX = 8, padY = 4;
    const barW = Math.min(W - 4, tw + padX * 2);
    const barH = H - padY * 2;
    const x = (W - barW) / 2, y = padY;

    ctx.fillStyle = bg;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, barW, barH, barH / 2);
    else ctx.rect(x, y, barW, barH);
    ctx.fill();

    ctx.fillStyle = quality === 1 ? '#000' : '#fff';
    ctx.fillText(label, x + padX, H / 2);
    sp.userData.tex.needsUpdate = true;
}

function buildPools() {
    /* v700x self entity — 绿色胶囊, 头顶写"房主"字样, 相机默认跟随 */
    selfEntity = buildPlayerEntity();
    selfEntity.root.visible = false;
    /* 强绿色 (跟 2D 态势图自己的样式一致 #4ade80) */
    selfEntity.capsule.material.color.setHex(0x4ade80);
    for (const pair of Object.values(selfEntity.headings)) pair.visible.material.color.setHex(0x4ade80);
    if (selfEntity.occCapsule) selfEntity.occCapsule.material.color.setHex(0x22c55e);
    selfEntity.root.userData = { kind: 'self' };
    scene.add(selfEntity.root);

    for (let i = 0; i < POOL_SIZE.players; ++i) {
        const e = buildPlayerEntity();
        e.root.visible = false;
        e.root.userData.poolIdx = i;
        // 子 mesh 也标记 kind, 让 raycaster 从 hit 反查到 group
        e.capsule.userData = { kind: 'player', poolIdx: i };
        for (const pair of Object.values(e.headings)) {
            Object.assign(pair.visible.userData, { kind: 'player', poolIdx: i });
            Object.assign(pair.occluded.userData, { kind: 'player', poolIdx: i });
        }
        scene.add(e.root);
        POOL.players.push(e);
    }
    for (let i = 0; i < POOL_SIZE.bosses; ++i) {
        const e = buildBossEntity();
        e.root.visible = false;
        e.root.userData.poolIdx = i;
        e.mesh.userData = { kind: 'boss', poolIdx: i };
        scene.add(e.root);
        POOL.bosses.push(e);
    }
    for (let i = 0; i < POOL_SIZE.ais; ++i) {
        const e = buildAIEntity();
        e.root.visible = false;
        e.root.userData = { kind: 'ai', poolIdx: i };
        scene.add(e.root);
        POOL.ais.push(e);
    }
    for (let i = 0; i < POOL_SIZE.items; ++i) {
        const e = buildItemEntity();
        e.root.visible = false;
        scene.add(e.root);
        POOL.items.push(e);
    }
}

// ============================================================================
//  v700x3: 血条 + 信息卡 分离
//    A) HpBar (Group): 世界空间竖立血条, 贴在胶囊左侧, 长度=胶囊全高.
//       - 底 (灰) + 填充 (绿/黄/红), 高度按 hpRatio 从下往上填
//       - 不加 scale 修正, 跟胶囊一起随距离缩 (远了自然细/短)
//       - 用 depthTest:false + renderOrder 高, 保证不被墙挡
//    B) InfoCard (Sprite): 名字 / 干员 / 护甲 / 武器 (不含血条).
//       - Canvas 尺寸不再随 detail 变, 恒定 320x100
//       - scaleSprite 保持屏幕像素稳定 (远了不变小)
//    远距离 (detail 0) 只显示血条 mesh, sprite 不可见.
// ============================================================================

const HPBAR_W_M = 0.10;   // 世界空间血条宽度 10 cm
const HPBAR_H_M = 1.8;    // 高度对齐胶囊 1.8m (含端半球)

function makeHpBar() {
    const group = new THREE.Group();
    /* 底槽 (深灰) */
    const bgGeo = new THREE.PlaneGeometry(HPBAR_W_M, HPBAR_H_M);
    const bgMat = new THREE.MeshBasicMaterial({
        color: 0x0a0e17, depthTest: false, transparent: true, opacity: 0.85,
    });
    const bg = new THREE.Mesh(bgGeo, bgMat);
    bg.renderOrder = 998;
    group.add(bg);
    /* 填充 (颜色随血量变). 用 scale.y 从下往上填, 得先把 pivot 挪到底部 */
    const fillGeo = new THREE.PlaneGeometry(HPBAR_W_M * 0.75, HPBAR_H_M);
    fillGeo.translate(0, HPBAR_H_M / 2, 0);   // pivot 移到底端
    const fillMat = new THREE.MeshBasicMaterial({
        color: 0x22c55e, depthTest: false,
    });
    const fill = new THREE.Mesh(fillGeo, fillMat);
    fill.position.y = -HPBAR_H_M / 2;         // group 中心对齐胶囊中心
    fill.renderOrder = 999;
    group.add(fill);
    /* 群组位置: 贴胶囊左侧. 胶囊半径 0.4, 血条中心 x=-0.55 */
    group.position.x = -0.55;
    /* 让血条永远面向相机 (billboard) — 用 rotation.z=0, 靠 tick 里 lookAt 更新? 简化:
       胶囊已经跟 root 一起 rotation.z (yaw), 血条要抵消 yaw 保持面向东?
       更好: 让血条不继承 root.rotation. 独立挂在 scene, tick 每帧同步 root.position. */
    return { group, bg, fill };
}

/* 更新血条: ratio 0-1, 颜色随比例 */
function updateHpBar(hpBar, ratio) {
    if (!hpBar || !hpBar.group) return;
    const r = Math.max(0, Math.min(1, ratio));
    hpBar.fill.scale.y = Math.max(0.001, r);
    const col = r > 0.5 ? 0x22c55e : r > 0.25 ? 0xfacc15 : 0xef4444;
    hpBar.fill.material.color.setHex(col);
    hpBar.group.visible = true;
}

/* ============================================================================
   信息卡 (纯文字) — 名字 / 干员 / 护甲 / 武器. 不再画血条.
   scaleSprite 保持屏幕像素稳定 (远近都不缩).
============================================================================ */
function makeInfoCardSprite() {
    const cv = document.createElement('canvas');
    cv.width = 384; cv.height = 116;
    const ctx = cv.getContext('2d');
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({
        map: tex, depthTest: false, transparent: true,
    });
    const sp = new THREE.Sprite(mat);
    /* 基础世界尺寸会按自身距离转换为不同的屏幕尺寸。 */
    sp.scale.set(2.4, 0.725, 1);
    sp.center.set(0.5, 1.0);
    sp.renderOrder = 1000;
    sp.userData = {
        canvas: cv, ctx, tex, key: '', detail: 2,
        baseW: 2.4, baseH: 0.725, rangeM: 0,
    };
    return sp;
}

/* 染色后的装备图标按 (种类, 颜色) 缓存：信息卡随距离频繁重绘，不能每次新建离屏 canvas。 */
const _tintedIcons = new Map();
function _tintedCardIcon(kind, color) {
    const image = CARD_ICONS[kind];
    if (!image) return null;
    const key = kind + color;
    let off = _tintedIcons.get(key);
    if (!off) {
        off = document.createElement('canvas'); off.width = 28; off.height = 28;
        const ox = off.getContext('2d'); ox.drawImage(image, 0, 0, 28, 28);
        ox.globalCompositeOperation = 'source-atop'; ox.fillStyle = color; ox.fillRect(0, 0, 28, 28);
        _tintedIcons.set(key, off);
    }
    return off;
}

function drawInfoCard(ctx, info, detail) {
    const cv = ctx.canvas;
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    if (detail === 0) return;  // 远距离不画

    const colorHex = info.colorHex ?? 0xffffff;
    const cssColor = '#' + colorHex.toString(16).padStart(6, '0');
    const dim = !!info.dim;
    const outlined = (text, x, y, fill, font, align='center') => {
        if (!text) return;
        ctx.font = font; ctx.textBaseline = 'top'; ctx.textAlign = align;
        ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(0,0,0,.92)'; ctx.lineWidth = 5;
        ctx.strokeText(text, x, y); ctx.fillStyle = fill; ctx.fillText(text, x, y);
    };
    const distance = Number.isFinite(info.distanceM) ? `${Math.round(info.distanceM)}m` : '';
    let title = [info.name, distance].filter(Boolean).join(' · ');
    ctx.font = '700 28px system-ui, sans-serif';
    while (title.length > 2 && ctx.measureText(title).width > W - 12) title = title.slice(0, -2) + '…';
    const details = detail >= 2 ? [info.weapon, info.hpText].filter(Boolean).join('  ·  ') : '';
    /* 深色底板：只有描边的文字压在同色系地图（青色墙面 vs 青色队伍）上对比不够。
       透明度跟随 2D 的「信息条底色」设置，与 2D 信息条一致。 */
    const plate = Number.isFinite(info.plate) ? info.plate : 0.8;
    if (plate > 0 && (title || details)) {
        const titleW = ctx.measureText(title).width;
        ctx.font = '600 19px system-ui, sans-serif';
        const detailW = details ? ctx.measureText(details).width : 0;
        const equipW = detail >= 2 ? ((info.helmetLv ? 1 : 0) + (info.armorLv ? 1 : 0)) * 54 : 0;
        const w = Math.min(W - 4, Math.max(titleW, detailW, equipW) + 24);
        const h = detail >= 2 && (details || equipW) ? (equipW ? 108 : 70) : 38;
        ctx.fillStyle = `rgba(6,9,14,${(0.82 * plate).toFixed(3)})`;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(W / 2 - w / 2, 1, w, h, 9); else ctx.rect(W / 2 - w / 2, 1, w, h);
        ctx.fill();
        ctx.fillStyle = dim ? '#aeb7bd' : cssColor;     // 顶边一条身份色，远看也能分清是谁
        ctx.fillRect(W / 2 - w / 2 + 9, 1, w - 18, 3);
    }
    outlined(title, W / 2, 6, dim ? '#aeb7bd' : cssColor, '700 28px system-ui, sans-serif');

    if (detail >= 2) {
        outlined(details, W / 2, 43, '#e7eef2', '600 19px system-ui, sans-serif');
        const equipment = [];
        if (info.helmetLv) equipment.push(['helmet', Number(info.helmetLv), info.helmetDur]);
        if (info.armorLv) equipment.push(['armor', Number(info.armorLv), info.armorDur]);
        const width = equipment.length * 54;
        equipment.forEach(([kind, level, durability], index) => {
            const x = W / 2 - width / 2 + index * 54;
            const color = '#' + (EQUIP_COLORS[level] || EQUIP_COLORS[0]).toString(16).padStart(6, '0');
            const tinted = _tintedCardIcon(kind, color);
            if (tinted) ctx.drawImage(tinted, x, 75, 28, 28);
            const value = Array.isArray(durability) && durability[0] != null ? Math.round(durability[0]) : '';
            outlined(value === '' ? '' : String(value), x + 33, 79, color, '700 15px monospace', 'left');
        });
    }
}

function updateInfoCard(sprite, info, detail) {
    sprite.userData.rangeM = Number.isFinite(info.distanceM) ? info.distanceM : 0;
    sprite.userData.showsDistance = Number.isFinite(info.distanceM);
    const key = [
        detail,
        info.name, info.hpText, Math.round(info.distanceM || 0),
        info.weapon, info.armorLv, info.helmetLv, info.armorDur, info.helmetDur,
        info.colorHex, info.dim ? 1 : 0, info.plate,
    ].join('|');
    if (sprite.userData.key === key) return;
    sprite.userData.key = key;
    sprite.userData.detail = detail;
    drawInfoCard(sprite.userData.ctx, info, detail);
    sprite.userData.tex.needsUpdate = true;
    /* 远距离整卡隐藏 */
    sprite.visible = (detail > 0);
}

/* 3D 信息卡（名字/武器/血量/护甲）只在 CARD_RANGE_M 内显示：更远时卡片缩到读不出，
   第一视角下中距离的多张卡还会互相叠压。远处改由 HUD 用固定字号的单行名牌
   「名字 距离 + 细血条」承担。被跟随的目标始终显示完整卡片。 */
const CARD_RANGE_M = 80;
function _pickDetail(distM, kind, isFollowed) {
    if (isFollowed) return 2;
    if (kind === 'ai') return 0;   // AI 数量大，只给侧边血条与 HUD 标识
    return distM < CARD_RANGE_M ? 2 : 0;
}

/* 可见人物、掩体后剪影使用同一阵营色；阵亡通过透明度与姿态表达。 */
const _look = { visible: 0, occluded: 0, opacity: 0.5 };
function _modelColors(identity, enemyLike, dead, disp) {
    _look.visible = _look.occluded = identity;
    _look.opacity = dead ? .35 : .55;
    return _look;
}

/* 标签与 HUD 的距离：相对「观察者」的水平距离，与 2D 干员台口径一致。 */
function _viewerRange(p, tx, ty, tz) {
    const v = frameViewer;
    if (v) return Math.hypot(p.x - v.x, p.y - v.y) * UE_TO_M;
    const c = camera.position;
    return Math.hypot(c.x - tx, c.y - ty, c.z - tz);
}

// ============================================================================
//  帧更新
// ============================================================================
function updatePlayers(players) {
    while (POOL.players.length < (players?.length || 0)) {
        const entity = buildPlayerEntity(); entity.root.visible = false; scene.add(entity.root); POOL.players.push(entity);
    }
    POOL_SIZE.players = POOL.players.length;
    const disp = window.AppState?.display || {};
    const scale = Number(disp.charScale) || 1;
    let n = 0;
    if (players && Array.isArray(players)) {
        for (const p of players) {
            if (n >= POOL_SIZE.players) break;
            if (p.key === '__self') continue;
            const e = POOL.players[n++];
            if (e.root.userData.entityKey !== p.key) { e.root.visible = false; e.hudAlert = false; }
            e.root.userData.entityKey = p.key;
            e.root.userData.entityName = String(p.name || '');
            /* 目标位置 (立即读) — UE→three 手性转换 */
            const tx = ueToThreeX(p.x), ty = ueToThreeY(p.y), tz = ueToThreeZ(p.z);
            // The presenter owns replay interpolation; do not add per-pool lag here.
            if (!e.root.visible) {
                e.root.position.set(tx, ty, tz);
                e.root.visible = true;
            } else {
                e.root.position.x = tx;
                e.root.position.y = ty;
                e.root.position.z = tz;
            }
            // Use the same presented pose as XYZ.
            e.root.rotation.z = ueYawToThreeRotZ(p.yaw);

            // 与 HUD 使用同一观察者关系，避免模型和敌人标记互相矛盾。
            const isTeammate = !_isEnemyOfViewer(frameViewer, p, false);

            const color = p.kind === 'unknown' ? PALETTE.unknown : isTeammate ? PALETTE.mate : PALETTE.teams[0];
            const dead = p.alive === false;
            const look = _modelColors(color, !isTeammate, dead, disp);
            syncCharacterModel(e,disp.model3d,{hero:p.hero,quality:_resolvedRenderQualityId(),scale,visibleColor:look.visible,occludedColor:look.occluded,
                occludedOpacity:look.opacity,showHeading:disp.showCone !== false && Number.isFinite(p.yaw),
                directionStyle:disp.directionStyle3d,directionAnchor:disp.directionAnchor3d,
                helmetLv:p.helmetLv,armorLv:p.armorLv,bagLv:p.bagLv,gearColors:EQUIP_COLORS});
            animateCharacterModel(e,p,camera,performance.now(),renderer.domElement.clientHeight||900,_resolvedRenderQualityId());
            // 头顶信息卡 (名字 + 武器 + 血量 + 护甲)
            const nameParts = [];
            const lastKnown = (p._out_of_range || p.out_of_range) && !dead && !p.spawn_mark;
            if(lastKnown)nameParts.push('超距·最后位置');
            if (disp.showHero !== false && p.hero) nameParts.push(p.hero);
            if (disp.showName !== false && p.name) nameParts.push(p.displayName || p.name);
            const info = {
                name: nameParts.join(' '),
                colorHex: color,
                dim: dead || lastKnown,
                plate: disp.tagOpacity,
            };
            if (disp.showHealth !== false && p.maxHp > 0 && p.hp != null) {
                info.hpRatio = p.hp / p.maxHp;
                info.hpText = `${Math.round(p.hp)} / ${Math.round(p.maxHp)}`;
            }
            if (disp.showWeapon !== false && p.weapon) info.weapon = p.weapon;
            if (disp.showArmor !== false) {
                if (p.armorLv > 0) { info.armorLv = p.armorLv; info.armorDur = p.armorDur; }
                if (p.helmetLv > 0) { info.helmetLv = p.helmetLv; info.helmetDur = p.helmetDur; }
            }
            const rangeM = _viewerRange(p, tx, ty, tz);
            if (disp.showDistance !== false) info.distanceM = rangeM;
            const isFollowed = followTarget && followTarget.kind === 'player' && followTarget.name === p.name;
            const detail = _pickDetail(rangeM, 'player', isFollowed);
            updateInfoCard(e.sprite, info, detail);
            if (e.hpBar) {
                if (info.hpRatio != null) updateHpBar(e.hpBar, info.hpRatio);
                else e.hpBar.group.visible = false;
            }
            e.src = p; e.identityColor = color; e.modelScale = scale;
        }
    }
    for (let i = n; i < POOL_SIZE.players; ++i) POOL.players[i].root.visible = false;
}

function updateBosses(bosses) {
    while (POOL.bosses.length < (bosses?.length || 0)) {
        const entity = buildBossEntity(); entity.root.visible = false; scene.add(entity.root); POOL.bosses.push(entity);
    }
    POOL_SIZE.bosses = POOL.bosses.length;
    const disp = window.AppState?.display || {};
    let n = 0;
    if (bosses && Array.isArray(bosses)) {
        for (const b of bosses) {
            if (n >= POOL_SIZE.bosses) break;
            const e = POOL.bosses[n++];
            e.root.userData.entityKey = b.key;
            e.root.userData.entityName = String(b.name || '');
            const tx = ueToThreeX(b.x), ty = ueToThreeY(b.y), tz = ueToThreeZ(b.z);
            if (!e.root.visible) {
                e.root.position.set(tx, ty, tz);
                e.root.visible = true;
            } else {
                e.root.position.x = tx;
                e.root.position.y = ty;
                e.root.position.z = tz;
            }
            e.mesh.material.color.setHex(PALETTE.teams[0]);e.occ.material.color.setHex(PALETTE.teams[0]);
            const info = { name: b.displayName || b.name || 'BOSS', colorHex: PALETTE.teams[0] };
            if (disp.showHealth !== false && b.maxHp > 0 && b.hp != null) {
                info.hpRatio = b.hp / b.maxHp;
                info.hpText  = `${Math.round(b.hp)} / ${Math.round(b.maxHp)}`;
            }
            const camPos = camera.position;
            const distM = Math.hypot(camPos.x - tx, camPos.y - ty, camPos.z - tz);
            const local = window.AppState?.gameData?.local;
            const rangeM = local && Number.isFinite(local.x) && Number.isFinite(local.y)
                ? Math.hypot(b.x-local.x,b.y-local.y,(b.z||0)-(local.z||0))*UE_TO_M : distM;
            if (disp.showDistance !== false) info.distanceM = rangeM;
            const isFollowed = followTarget && followTarget.kind === 'boss' && followTarget.name === b.name;
            const detail = _pickDetail(rangeM, 'boss', isFollowed);
            updateInfoCard(e.sprite, info, detail);
            if (e.hpBar) {
                if (info.hpRatio != null) updateHpBar(e.hpBar, info.hpRatio);
                else e.hpBar.group.visible = false;
            }
        }
    }
    for (let i = n; i < POOL_SIZE.bosses; ++i) POOL.bosses[i].root.visible = false;
}

function updateAIs(ais) {
    while (POOL.ais.length < (ais?.length || 0)) {
        const entity = buildAIEntity(); entity.root.visible = false; scene.add(entity.root); POOL.ais.push(entity);
    }
    POOL_SIZE.ais = POOL.ais.length;
    const disp = window.AppState?.display || {};
    let n = 0;
    if (ais && Array.isArray(ais)) {
        for (const a of ais) {
            if (n >= POOL_SIZE.ais) break;
            const e = POOL.ais[n++];
            e.root.userData.entityKey = a.key;
            e.root.userData.entityName = String(a.name || '');
            const tx = ueToThreeX(a.x), ty = ueToThreeY(a.y), tz = ueToThreeZ(a.z);
            if (!e.root.visible) {
                e.root.position.set(tx, ty, tz);
                e.root.visible = true;
            } else {
                e.root.position.x = tx;
                e.root.position.y = ty;
                e.root.position.z = tz;
            }
            // v700x3: AI 只显示侧边血条, 不显示 info sprite
            const color = _isEnemyOfViewer(frameViewer, a, false) ? PALETTE.ai : PALETTE.mate;
            e.mesh.material.color.setHex(color);e.occ.material.color.setHex(color);
            e.src = a; e.identityColor = color; e.modelScale = 1;
            let hpRatio = null;
            if (disp.showHealth !== false && a.maxHp > 0 && a.hp != null) {
                hpRatio = a.hp / a.maxHp;
            }
            if (e.hpBar) {
                if (hpRatio != null) updateHpBar(e.hpBar, hpRatio);
                else e.hpBar.group.visible = false;
            }
        }
    }
    for (let i = n; i < POOL_SIZE.ais; ++i) POOL.ais[i].root.visible = false;
}

/* 物资标签是世界固定尺寸（远小近大），离镜头太近时会占满画面，直接不画。 */
const ITEM_HIDE_NEAR_CAMERA_M = 3;
function updateItems(items) {
    while (POOL.items.length < (items?.length || 0)) {
        const entity = buildItemEntity(); entity.root.visible = false; scene.add(entity.root); POOL.items.push(entity);
    }
    POOL_SIZE.items = POOL.items.length;
    const disp = window.AppState?.display || {};
    const minQ = disp.minQuality || 0;
    /* v700x3: 最低价过滤 (元). UI 里 minPrice 单位 w, 存 * 10000 后的元数 */
    const minPrice = disp.minPrice || 0;
    const camPos = camera.position;
    let n = 0;
    if (items && Array.isArray(items)) {
        for (const it of items) {
            if (n >= POOL_SIZE.items) break;
            const q = it.quality ?? it.q ?? 0;
            if (q < minQ) continue;
            /* 价格过滤 */
            if (minPrice > 0 && (!it.price || it.price < minPrice)) continue;
            /* 已销毁/无效物品 (name 为空或 ???): 服务端偶尔漏过滤这类, 前端兜底 */
            const nm = (it.displayName || it.name || '').trim();
            if (!nm || nm === '???') continue;
            const ix = ueToThreeX(it.x), iy = ueToThreeY(it.y), iz = ueToThreeZ(it.z);
            if (Math.hypot(ix - camPos.x, iy - camPos.y, iz - camPos.z) < ITEM_HIDE_NEAR_CAMERA_M) continue;
            const e = POOL.items[n++];
            e.root.visible = true;
            e.root.userData.entityKey = it.key;
            e.root.position.set(ix, iy, iz);
            e.mesh.material.color.setHex(qualityColor(q));
            if (e.sprite) _drawItemLabel(e.sprite, nm, q);
        }
    }
    for (let i = n; i < POOL_SIZE.items; ++i) POOL.items[i].root.visible = false;
}

/* v700x: 本人 (data.local) 位置更新. 跟 updatePlayers 结构一致 (lerp 位置/yaw). */
function updateSelf(local) {
    if (!selfEntity) return;
    if (!local || local.x == null) { selfEntity.root.visible = false; return; }

    const tx = ueToThreeX(local.x), ty = ueToThreeY(local.y), tz = ueToThreeZ(local.z);
    if (!selfEntity.root.visible) {
        selfEntity.root.position.set(tx, ty, tz);
        selfEntity.root.visible = true;
    } else {
        selfEntity.root.position.x += (tx - selfEntity.root.position.x) * (window.AppState?.gameData?.replay ? 1 : 0.25);
        selfEntity.root.position.y += (ty - selfEntity.root.position.y) * (window.AppState?.gameData?.replay ? 1 : 0.25);
        selfEntity.root.position.z += (tz - selfEntity.root.position.z) * (window.AppState?.gameData?.replay ? 1 : 0.25);
    }
    const targetYaw = ueYawToThreeRotZ(local.yaw);
    let dy = targetYaw - selfEntity.root.rotation.z;
    while (dy >  Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    selfEntity.root.rotation.z += dy * (window.AppState?.gameData?.replay ? 1 : 0.25);

    /* 头顶信息卡: 只显示 "我" + hero */
    const disp = window.AppState?.display || {};
    const scale = Number(disp.charScale) || 1;
    const color = _isEnemyOfViewer(frameViewer, local, true) ? PALETTE.teams[0] : PALETTE.self;
    const look = _modelColors(color, false, !!local.dead, disp);
    syncCharacterModel(selfEntity,disp.model3d,{hero:local.hero,quality:_resolvedRenderQualityId(),scale,visibleColor:look.visible,occludedColor:look.occluded,
        occludedOpacity:look.opacity,showHeading:disp.showCone !== false && Number.isFinite(local.yaw),
        directionStyle:disp.directionStyle3d,directionAnchor:disp.directionAnchor3d,gearColors:EQUIP_COLORS});
    animateCharacterModel(selfEntity,local,camera,performance.now(),renderer.domElement.clientHeight||900,_resolvedRenderQualityId());
    selfEntity.src = local; selfEntity.identityColor = color; selfEntity.modelScale = scale;
    const info = { name: disp.showName === false ? '' : '自己' + (local.hero ? ' ' + local.hero : ''), colorHex: color, plate: disp.tagOpacity };
    updateInfoCard(selfEntity.sprite,
        info,
        _pickDetail(camera.position.distanceTo(selfEntity.root.position), 'player',
                    followTarget && followTarget.kind === 'self'));
    /* 本人血条 (若有数据, local 没 hp 就不显示) */
    if (selfEntity.hpBar) {
        if (disp.showHealth !== false && local.maxHp > 0 && local.hp != null) {
            updateHpBar(selfEntity.hpBar, local.hp / local.maxHp);
        } else {
            selfEntity.hpBar.group.visible = false;
        }
    }
}

function _hideFirstPersonFollowedEntity() {
    if (cameraMode !== CAMERA_MODES.FIRST_PERSON || !followTarget) return;
    if (followTarget.kind === 'self') {
        if (selfEntity) selfEntity.root.visible = false;
        return;
    }
    const pool = followTarget.kind === 'player' ? POOL.players
               : followTarget.kind === 'boss'   ? POOL.bosses
               : followTarget.kind === 'ai'     ? POOL.ais : null;
    if (!pool) return;
    const entity = pool.find(entry => entry.root.userData.entityName === followTarget.name);
    if (entity) entity.root.visible = false;
}

function fitToPlayers() {
    const data = window.AppState?.gameData;
    if (!data || !data.players || data.players.length === 0) return;
    /* three world 里的 bbox — 直接过 ueToThree*, 之后不用再处理手性 */
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const p of data.players) {
        const tx = ueToThreeX(p.x), ty = ueToThreeY(p.y), tz = ueToThreeZ(p.z);
        minX = Math.min(minX, tx); maxX = Math.max(maxX, tx);
        minY = Math.min(minY, ty); maxY = Math.max(maxY, ty);
        minZ = Math.min(minZ, tz); maxZ = Math.max(maxZ, tz);
    }
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    const rx = maxX - minX;
    const ry = maxY - minY;
    const r = Math.max(rx, ry, 100) * 0.7 + 100;

    controls.target.set(cx, cy, cz);
    camera.position.set(cx + r * 0.7, cy - r * 0.7, cz + r * 0.8);
    camera.lookAt(cx, cy, cz);
    controls.update();
}

// A 键: 同时框住地图 + 玩家 — 帮助排查"玩家在哪"
function fitToAll() {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    // 地图 bbox
    if (mapBounds && !mapBounds.isEmpty()) {
        const bb = mapBounds;
        minX = Math.min(minX, bb.min.x); maxX = Math.max(maxX, bb.max.x);
        minY = Math.min(minY, bb.min.y); maxY = Math.max(maxY, bb.max.y);
        minZ = Math.min(minZ, bb.min.z); maxZ = Math.max(maxZ, bb.max.z);
    }
    // 玩家 (UE→three 坐标)
    const data = window.AppState?.gameData;
    if (data && data.players) {
        for (const p of data.players) {
            const x = ueToThreeX(p.x), y = ueToThreeY(p.y), z = ueToThreeZ(p.z);
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        }
    }
    if (!isFinite(minX)) return;
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    const rx = maxX - minX, ry = maxY - minY;
    const r = Math.max(rx, ry, 100) * 0.7 + 100;
    controls.target.set(cx, cy, cz);
    camera.position.set(cx + r * 0.7, cy - r * 0.7, cz + r * 0.8);
    controls.update();
    console.log(`[Radar3D] fitAll: bbox min(${minX.toFixed(0)},${minY.toFixed(0)},${minZ.toFixed(0)}) max(${maxX.toFixed(0)},${maxY.toFixed(0)},${maxZ.toFixed(0)})`);
}

// ============================================================================
//  3D 镜头状态机
//
//  free        : 不跟随，完全交给 OrbitControls。
//  thirdPerson : 只在进入/重置时放到目标后上方；之后保留用户旋转、缩放和偏移。
//  firstPerson : 相机锚定目标眼睛位置，OrbitControls 只负责产生自由观察方向。
// ============================================================================
const CAMERA_MODES = Object.freeze({
    FREE: 'free',
    THIRD_PERSON: 'thirdPerson',
    FIRST_PERSON: 'firstPerson',
});
const VALID_CAMERA_MODES = new Set(Object.values(CAMERA_MODES));
const THIRD_PERSON_CAMERA = Object.freeze({
    LOOK_HEIGHT: 0.9,
    INITIAL_DISTANCE: 30,
    INITIAL_PITCH: 0.88,
    MIN_USER_DISTANCE: 10,
    ANCHOR_LERP: 0.22,
});
const FIRST_PERSON_CAMERA = Object.freeze({
    EYE_HEIGHT: 0.68,
    LOOK_DISTANCE: 12,
    POSITION_LERP: 0.35,
    MIN_CONTROL_DISTANCE: 0.05,
});

let cameraMode = CAMERA_MODES.THIRD_PERSON;
let followTarget = null;   // { kind, name } | null
let followState = null;    // 当前目标的镜头内部状态

function _getIndoorClarityState() {
    return {
        enabled: indoorClarityEnabled,
        active: indoorClarityActive,
    };
}

function _dispatchIndoorClarityChanged() {
    window.dispatchEvent(new CustomEvent('radar3dIndoorClarityChanged', {
        detail: _getIndoorClarityState(),
    }));
}

function _applyIndoorClarityRenderingState() {
    if (indoorClarityActive && camera) {
        radarCutawayUniforms.radarCutawayCamera.value.copy(camera.position);
        const sightlineDirection = radarCutawayUniforms.radarSightlineDirection.value;
        sightlineDirection.copy(radarCutawayUniforms.radarCutawayTarget.value)
            .sub(radarCutawayUniforms.radarCutawayCamera.value);
        const sightlineLength = sightlineDirection.length();
        radarCutawayUniforms.radarSightlineLength.value = Math.max(sightlineLength, 0.001);
        if (sightlineLength > 0.001) sightlineDirection.multiplyScalar(1 / sightlineLength);
        else sightlineDirection.set(0, 0, -1);
    }
    const variants = mapMesh?.userData?.radarMaterials;
    if (mapMesh && variants) {
        const desiredMaterial = indoorClarityActive && variants.cutaway
            ? variants.cutaway
            : variants.plain;
        if (mapMesh.userData.activeMaterial !== desiredMaterial) {
            mapMesh.userData.activeMaterial = desiredMaterial;
            for (const chunk of mapMesh.children) chunk.material = desiredMaterial;
        }
    }
    if (ssaoPass) {
        const desiredNormalMaterial = indoorClarityActive && ssaoCutawayNormalMaterial
            ? ssaoCutawayNormalMaterial
            : (ssaoPlainNormalMaterial || ssaoPass.normalMaterial);
        if (ssaoPass.normalMaterial !== desiredNormalMaterial) {
            ssaoPass.normalMaterial = desiredNormalMaterial;
        }
    }
    if (structureEdgePass) {
        structureEdgePass.uniforms.radarCutawayActive.value = indoorClarityActive ? 1 : 0;
        structureEdgePass.uniforms.radarCutawayCenter.value.copy(radarCutawayUniforms.radarCutawayCenter.value);
        structureEdgePass.uniforms.radarCutawayPlaneZ.value = radarCutawayUniforms.radarCutawayPlaneZ.value;
        structureEdgePass.uniforms.radarCutawayRadius.value = radarCutawayUniforms.radarCutawayRadius.value;
        structureEdgePass.uniforms.radarCutawayTarget.value.copy(radarCutawayUniforms.radarCutawayTarget.value);
        structureEdgePass.uniforms.radarCutawayCamera.value.copy(radarCutawayUniforms.radarCutawayCamera.value);
        structureEdgePass.uniforms.radarSightlineDirection.value.copy(radarCutawayUniforms.radarSightlineDirection.value);
        structureEdgePass.uniforms.radarSightlineLength.value = radarCutawayUniforms.radarSightlineLength.value;
        structureEdgePass.uniforms.radarSightlineNearRadius.value = radarCutawayUniforms.radarSightlineNearRadius.value;
        structureEdgePass.uniforms.radarSightlineRadius.value = radarCutawayUniforms.radarSightlineRadius.value;
        structureEdgePass.uniforms.radarSightlineFloorZ.value = radarCutawayUniforms.radarSightlineFloorZ.value;
    }
}

function _setIndoorClarityActive(nextActive) {
    const next = !!nextActive;
    const changed = indoorClarityActive !== next;
    indoorClarityActive = next;
    _applyIndoorClarityRenderingState();
    if (changed) _dispatchIndoorClarityChanged();
    return changed;
}

function _updateIndoorClarityUniforms() {
    const variants = mapMesh?.userData?.radarMaterials;
    const eligible = !mapMesh?.userData.gatewayTransparentWalls && indoorClarityEnabled && cameraMode === CAMERA_MODES.THIRD_PERSON &&
        !!followTarget && !!variants?.cutaway;
    if (!eligible) {
        indoorClarityLastValidAt = 0;
        _setIndoorClarityActive(false);
        return _getIndoorClarityState();
    }

    const now = performance.now();
    const hit = _resolveFollowTargetData(followTarget);
    const validHit = hit && hit.x != null && hit.y != null && hit.z != null;
    if (!validHit) {
        if (indoorClarityActive && indoorClarityLastValidAt &&
            now - indoorClarityLastValidAt <= INDOOR_CLARITY_LOST_GRACE_MS) {
            _applyIndoorClarityRenderingState();
            return _getIndoorClarityState();
        }
        _setIndoorClarityActive(false);
        return _getIndoorClarityState();
    }

    const world = _worldPositionForTarget(hit);
    const desiredX = followState?.anchor?.x ?? world.x;
    const desiredY = followState?.anchor?.y ?? world.y;
    const desiredPlaneZ = world.z + INDOOR_CLARITY_HEIGHT_ABOVE_ROOT;
    const desiredTargetZ = world.z + INDOOR_CLARITY_TARGET_HEIGHT;
    const desiredSightlineFloorZ = world.z - 0.72;
    const orbitDistance = controls && camera
        ? camera.position.distanceTo(controls.target)
        : THIRD_PERSON_CAMERA.INITIAL_DISTANCE;
    const profile = activeQualityProfile || RENDER_QUALITY_PROFILES[_resolvedRenderQualityId()];
    const desiredRadius = THREE.MathUtils.clamp(
        orbitDistance * 0.33,
        profile.indoorCutRadiusMin,
        profile.indoorCutRadiusMax,
    );
    const sightlineDistance = camera
        ? Math.hypot(
            camera.position.x - desiredX,
            camera.position.y - desiredY,
            camera.position.z - desiredTargetZ,
        )
        : orbitDistance;
    const viewportHeight = renderer?.domElement?.clientHeight || canvas?.clientHeight || 900;
    const fovTan = Math.tan((camera?.fov || 75) * Math.PI / 360);
    const projectedSightlineRadius = 2 * profile.sightlinePixels / Math.max(viewportHeight, 1)
        * sightlineDistance * fovTan;
    const desiredSightlineRadius = THREE.MathUtils.clamp(
        projectedSightlineRadius,
        profile.sightlineRadiusMin,
        profile.sightlineRadiusMax,
    );
    const desiredSightlineNearRadius = Math.min(
        profile.sightlineNearRadius,
        desiredSightlineRadius * 0.75,
    );

    const center = radarCutawayUniforms.radarCutawayCenter.value;
    const target = radarCutawayUniforms.radarCutawayTarget.value;
    if (!indoorClarityActive || indoorClarityLastValidAt === 0) {
        center.set(desiredX, desiredY);
        target.set(desiredX, desiredY, desiredTargetZ);
        radarCutawayUniforms.radarCutawayPlaneZ.value = desiredPlaneZ;
        radarCutawayUniforms.radarCutawayRadius.value = desiredRadius;
        radarCutawayUniforms.radarSightlineNearRadius.value = desiredSightlineNearRadius;
        radarCutawayUniforms.radarSightlineRadius.value = desiredSightlineRadius;
        radarCutawayUniforms.radarSightlineFloorZ.value = desiredSightlineFloorZ;
    } else {
        center.x = THREE.MathUtils.lerp(center.x, desiredX, 0.25);
        center.y = THREE.MathUtils.lerp(center.y, desiredY, 0.25);
        target.x = center.x;
        target.y = center.y;
        target.z = THREE.MathUtils.lerp(target.z, desiredTargetZ, 0.25);
        radarCutawayUniforms.radarCutawayPlaneZ.value = THREE.MathUtils.lerp(
            radarCutawayUniforms.radarCutawayPlaneZ.value,
            desiredPlaneZ,
            0.25,
        );
        radarCutawayUniforms.radarCutawayRadius.value = THREE.MathUtils.lerp(
            radarCutawayUniforms.radarCutawayRadius.value,
            desiredRadius,
            0.16,
        );
        radarCutawayUniforms.radarSightlineRadius.value = THREE.MathUtils.lerp(
            radarCutawayUniforms.radarSightlineRadius.value,
            desiredSightlineRadius,
            0.16,
        );
        radarCutawayUniforms.radarSightlineNearRadius.value = THREE.MathUtils.lerp(
            radarCutawayUniforms.radarSightlineNearRadius.value,
            desiredSightlineNearRadius,
            0.16,
        );
        radarCutawayUniforms.radarSightlineFloorZ.value = THREE.MathUtils.lerp(
            radarCutawayUniforms.radarSightlineFloorZ.value,
            desiredSightlineFloorZ,
            0.25,
        );
    }
    indoorClarityLastValidAt = now;
    _setIndoorClarityActive(true);
    return _getIndoorClarityState();
}

window.radar3dSetIndoorClarity = function(enabled) {
    const previousEnabled = indoorClarityEnabled;
    const previousActive = indoorClarityActive;
    indoorClarityEnabled = !!enabled;
    try {
        localStorage.setItem(INDOOR_CLARITY_STORAGE_KEY, indoorClarityEnabled ? '1' : '0');
    } catch (_) {}
    const state = _updateIndoorClarityUniforms();
    if (previousEnabled !== indoorClarityEnabled && previousActive === indoorClarityActive) {
        _dispatchIndoorClarityChanged();
    }
    return state;
};

window.radar3dGetIndoorClarityState = function() {
    return _getIndoorClarityState();
};

function _targetLabel(target = followTarget) {
    if (!target) return '';
    if (target.kind === 'self') return '房主（你）';
    return String(target.name || target.kind || '目标');
}

function _getViewState() {
    const target = followTarget ? { kind: followTarget.kind, name: followTarget.name } : null;
    return {
        mode: cameraMode,
        target,
        targetLabel: _targetLabel(target),
        following: cameraMode !== CAMERA_MODES.FREE && !!target,
    };
}

function _dispatchViewStateChanged() {
    window.dispatchEvent(new CustomEvent('radar3dViewStateChanged', { detail: _getViewState() }));
}

function _syncFollowButton() {
    const btn = document.getElementById('followTargetBtn');
    if (!btn) return;
    const following = cameraMode !== CAMERA_MODES.FREE && !!followTarget;
    const icon = document.getElementById('followTargetIcon');
    const label = document.getElementById('followTargetLabel');
    btn.classList.toggle('active', following);
    btn.setAttribute('aria-pressed', following ? 'true' : 'false');
    btn.title = following ? '取消当前跟随' : '跟随房主';
    if (icon) icon.textContent = following ? '■' : '◎';
    if (label) label.textContent = following ? '取消跟随' : '跟随房主';
}

function _applyCameraModeControls() {
    if (!controls) return;
    controls.enableRotate = cameraMode !== CAMERA_MODES.FIRST_PERSON;
    controls.enablePan = cameraMode === CAMERA_MODES.FIRST_PERSON ? false : freeOrbitEnablePan;
    controls.minDistance = cameraMode === CAMERA_MODES.THIRD_PERSON
        ? Math.max(freeOrbitMinDistance, THIRD_PERSON_CAMERA.MIN_USER_DISTANCE)
        : cameraMode === CAMERA_MODES.FIRST_PERSON
            ? FIRST_PERSON_CAMERA.MIN_CONTROL_DISTANCE
            : freeOrbitMinDistance;
}

function _makeFollowState() {
    return {
        anchor: null,
        eye: null,
        lostSince: 0,
        needsCameraReset: true,
    };
}

/* ---------------------------------------------------------------- 地图风格
   real    ：写实白模（默认）。地形 GLB 只有几何、没有贴图和材质，最接近游戏原貌的
             做法是日光下的中性白模：天空渐变 + 与地平线同色的大气雾 + 太阳/天光，
             地表偏土绿、岩石与混凝土偏暖灰。人物队伍色在中性灰环境里最醒目。
   tactical：原先的深色青调「雷达」风格，墙体自发光与等高线强调结构轮廓。
   各项颜色都是 sRGB 十六进制；fogDist 按镜头模式给 [near, far]（米）。 */
const MAP_STYLES = {
    real: {
        // 地表偏暗的土绿，建筑立面与屋顶偏亮的混凝土灰：结构从地形里「立」出来
        groundLow: 0x59604c, groundHigh: 0x958f80, wallLow: 0x8d8a83, wallHigh: 0xbdb9b0, edge: 0x2b2f33,
        wallHighlight: 0, contour: 0, edgeScale: 0,
        sky: { zenith: 0x4c7db8, horizon: 0xc6d3dd, nadir: 0x8a877c },
        fog: 0xc2cfd9, clear: 0xc2cfd9,
        // 中性日光为主、天光补光压低，向光面与背光面拉开明暗，避免整体发灰发黄
        light: { ambient: 0.05, hemiSky: 0xd6e4f2, hemiGround: 0x5f5a50, hemi: 0.55,
                 sun: 0xfff7ec, key: 3.2, fill: 0.18, fillColor: 0xbfd6ff, exposure: 0.95 },
        fogDist: { firstPerson: [140, 1500], thirdPerson: [260, 2400], free: [2500, 14000] },
        // 官方底图投影：原色直贴地面/屋顶；墙只取少量色调。ao = bake AO 的混合强度
        mapTex: { strength: 1, tint: 0, wall: 0.22 }, ao: 0.85,
    },
    tactical: {
        groundLow: 0x0b2630, groundHigh: 0x3a6c72, wallLow: 0x07101d, wallHigh: 0x1d4055, edge: 0x2ac2d0,
        wallHighlight: 1, contour: 1, edgeScale: 1,
        sky: null, fog: 0x0b0f18, clear: 0x0b0f18, light: null,
        fogDist: { firstPerson: [90, 950], thirdPerson: [220, 1800], free: [8000, 30000] },
        // 战术风格也投影，但只取亮度映射到青色地面色阶：道路、地貌可辨，配色不被照片破坏
        mapTex: { strength: 0.85, tint: 1, wall: 0.10 }, ao: 0.6,
    },
};
let mapStyleId = 'real';
let skyDome = null;

function _mapStyle() { return MAP_STYLES[mapStyleId] || MAP_STYLES.real; }

// 天空穹顶：跟随相机的单位球，按视线方向的世界 z 分量插值天顶 / 地平线 / 地面色。
// 不写深度、最先绘制，永远在场景之后；不受雾影响。
function _ensureSkyDome() {
    if (skyDome || !scene) return skyDome;
    const material = new THREE.ShaderMaterial({
        uniforms: {
            skyZenith: { value: new THREE.Color() },
            skyHorizon: { value: new THREE.Color() },
            skyNadir: { value: new THREE.Color() },
        },
        vertexShader: `varying vec3 vSkyDir;
void main() {
    vSkyDir = normalize( position );
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`,
        fragmentShader: `uniform vec3 skyZenith;
uniform vec3 skyHorizon;
uniform vec3 skyNadir;
varying vec3 vSkyDir;
void main() {
    float h = normalize( vSkyDir ).z;
    vec3 c = h >= 0.0
        ? mix( skyHorizon, skyZenith, pow( clamp( h, 0.0, 1.0 ), 0.6 ) )
        : mix( skyHorizon, skyNadir, smoothstep( 0.0, 0.18, -h ) );
    gl_FragColor = vec4( c, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`,
        side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    });
    skyDome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
    skyDome.frustumCulled = false;
    skyDome.renderOrder = -1000;
    skyDome.raycast = () => {};
    skyDome.userData.radarExcludeFromSsao = true;
    scene.add(skyDome);
    return skyDome;
}

function _applyStyleLights() {
    const profile = activeQualityProfile || RENDER_QUALITY_PROFILES[_resolvedRenderQualityId()];
    const L = _mapStyle().light;
    if (ambient) ambient.intensity = L ? L.ambient : profile.ambient;
    if (hemi) {
        hemi.intensity = L ? L.hemi : profile.hemisphere;
        hemi.color.setHex(L ? L.hemiSky : 0x88aaff);
        hemi.groundColor.setHex(L ? L.hemiGround : 0x332211);
    }
    if (dirLight) { dirLight.intensity = L ? L.key : profile.keyLight; dirLight.color.setHex(L ? L.sun : 0xffffff); }
    if (fillLight) { fillLight.intensity = L ? L.fill : profile.fillLight; fillLight.color.setHex(L ? L.fillColor : 0x9fc8ff); }
    if (renderer) renderer.toneMappingExposure = L ? L.exposure : profile.exposure;
    // 开阴影后室内整片处于阴影里，只剩天光；适当抬高天光与补光，复盘时室内仍看得清
    if (profile.shadows) {
        if (hemi) hemi.intensity *= 1.4;
        if (fillLight) fillLight.intensity *= 2.0;
    }
}

function _applyMapStyle() {
    if (!scene || !renderer) return;
    const style = _mapStyle();
    scene.fog?.color.setHex(style.fog);
    renderer.setClearColor(style.clear, 1.0);
    if (style.sky) {
        const dome = _ensureSkyDome();
        dome.visible = true;
        dome.material.uniforms.skyZenith.value.setHex(style.sky.zenith);
        dome.material.uniforms.skyHorizon.value.setHex(style.sky.horizon);
        dome.material.uniforms.skyNadir.value.setHex(style.sky.nadir);
    } else if (skyDome) skyDome.visible = false;
    _applyStyleLights();
    _applyViewModeRendering();
}

/* 按镜头模式调整雾与裁剪面。跟随视角贴地看远处：距离雾提供纵深并压住远景噪声，
   同时收紧远裁剪面——地图对角线级的 far（上万米）配 0.2m near，远处深度精度
   不够，第一视角下大片墙面会 z-fighting 闪烁。俯视/自由模式保持全图可见。 */
let mapFarPlane = 50000;
const VIEW_CAMERA_FAR = { firstPerson: 2600, thirdPerson: 4500 };
function _applyViewModeRendering() {
    if (!scene || !camera) return;
    const [fogNear, fogFar] = _mapStyle().fogDist[cameraMode] || _mapStyle().fogDist.free;
    if (scene.fog && (scene.fog.near !== fogNear || scene.fog.far !== fogFar)) {
        scene.fog.near = fogNear; scene.fog.far = fogFar;
    }
    const near = cameraMode === CAMERA_MODES.FIRST_PERSON ? 0.1 : 0.2;
    const far = VIEW_CAMERA_FAR[cameraMode] ? Math.min(mapFarPlane, VIEW_CAMERA_FAR[cameraMode]) : mapFarPlane;
    if (camera.near !== near || camera.far !== far) {
        camera.near = near; camera.far = far;
        camera.updateProjectionMatrix();
    }
    applyGatewaySurfaceOpacity();
    _applyMapViewStyle();
}

function _commitViewState(mode, target) {
    cameraMode = VALID_CAMERA_MODES.has(mode) ? mode : CAMERA_MODES.THIRD_PERSON;
    followTarget = cameraMode === CAMERA_MODES.FREE ? null : (target || null);
    followState = followTarget ? _makeFollowState() : null;
    _applyViewModeRendering();
    _applyCameraModeControls();
    _syncFollowButton();
    _updateIndoorClarityUniforms();
    _dispatchViewStateChanged();
    return _getViewState();
}

function _defaultSelfTarget() {
    return window.AppState?.gameData?.local ? { kind: 'self', name: '__self__' } : null;
}

function _setFollowTarget(target) {
    if (!target) return _commitViewState(CAMERA_MODES.FREE, null);
    const mode = cameraMode === CAMERA_MODES.FREE ? CAMERA_MODES.THIRD_PERSON : cameraMode;
    return _commitViewState(mode, { kind: target.kind, name: target.name });
}

window.radar3dSetCameraMode = function(mode) {
    if (!VALID_CAMERA_MODES.has(mode)) throw new Error(`未知 3D 镜头模式: ${mode}`);
    if (mode === cameraMode && (mode === CAMERA_MODES.FREE || followTarget)) {
        return _getViewState();
    }
    const target = mode === CAMERA_MODES.FREE ? null : (followTarget || _defaultSelfTarget());
    return _commitViewState(mode, target);
};

window.radar3dGetViewState = function() {
    return _getViewState();
};

/* 桌面与手机共用：非自由模式点击即取消；自由模式点击后以第三人称跟随房主。 */
window.radar3dToggleHostFollow = function() {
    if (window.viewMode !== '3d') return;
    const following = cameraMode !== CAMERA_MODES.FREE && !!followTarget;
    if (following) {
        _commitViewState(CAMERA_MODES.FREE, null);
        console.log('[Radar3D] 取消跟随 (按钮)');
    } else {
        const mode = cameraMode === CAMERA_MODES.FREE ? CAMERA_MODES.THIRD_PERSON : cameraMode;
        _commitViewState(mode, _defaultSelfTarget());
        console.log(`[Radar3D] 开始 ${mode} 跟随房主 (按钮)`);
    }
};

function _resolveFollowTargetData(target = followTarget, data = window.AppState?.gameData) {
    if (!target || !data) return null;
    if (target.kind === 'self') return data.local || null;
    const listKey = target.kind === 'player' ? 'players'
                  : target.kind === 'boss'   ? 'bosses'
                  : target.kind === 'ai'     ? 'ais' : null;
    const list = listKey ? data[listKey] : null;
    const targetName = String(target.name ?? '');
    return Array.isArray(list)
        ? (list.find(entity => String(entity?.name ?? '') === targetName) || null)
        : null;
}

function _worldPositionForTarget(hit) {
    return new THREE.Vector3(ueToThreeX(hit.x), ueToThreeY(hit.y), ueToThreeZ(hit.z));
}

/* 第三人称只用该位姿初始化/重置，正常跟随不再根据目标 yaw 重算相机。 */
function _computeThirdPersonPose(world, yaw) {
    const target = world.clone();
    target.z += THIRD_PERSON_CAMERA.LOOK_HEIGHT;
    const horizontal = THIRD_PERSON_CAMERA.INITIAL_DISTANCE * Math.cos(THIRD_PERSON_CAMERA.INITIAL_PITCH);
    const vertical = THIRD_PERSON_CAMERA.INITIAL_DISTANCE * Math.sin(THIRD_PERSON_CAMERA.INITIAL_PITCH);
    const eye = new THREE.Vector3(
        target.x - Math.cos(yaw) * horizontal,
        target.y - Math.sin(yaw) * horizontal,
        target.z + vertical,
    );
    return { target, eye, horizontal, vertical };
}

function _resetThirdPersonCamera(hit) {
    const world = _worldPositionForTarget(hit);
    const pose = _computeThirdPersonPose(world, ueYawToThreeRotZ(hit.yaw));
    controls.target.copy(pose.target);
    camera.position.copy(pose.eye);
    followState.anchor = pose.target.clone();
    followState.needsCameraReset = false;
    controls.update();
}

/* 「第一视角高度」设置是离脚底的眼高（默认 1.6m）；UE 给的是胶囊中心（脚底上方约 0.9m）。
   以前把设置值直接加在中心上，眼睛实际在 2.5m，高出被跟随者头顶一截。 */
const CAPSULE_CENTER_ABOVE_FOOT_M = 0.9;
function _firstPersonEyeOffset() {
    const h = Number(window.AppState?.display?.eyeHeight);
    return Number.isFinite(h) && h > 0 ? h - CAPSULE_CENTER_ABOVE_FOOT_M : FIRST_PERSON_CAMERA.EYE_HEIGHT;
}

function _resetFirstPersonCamera(hit) {
    const eye = _worldPositionForTarget(hit);
    eye.z += _firstPersonEyeOffset();
    const direction = new THREE.Vector3(...aimDirection(Number(hit.yaw)||0,Number(hit.pitch)||0));
    camera.position.copy(eye);
    controls.target.copy(eye).addScaledVector(direction, FIRST_PERSON_CAMERA.LOOK_DISTANCE);
    camera.lookAt(controls.target);
    followState.eye = eye.clone();
    followState.needsCameraReset = false;
    controls.update();
}

/* 重置按当前模式执行：自由模式回总览；跟随模式回各自的标准初始位姿。 */
window.radar3dResetView = function() {
    if (!camera || !controls) return;

    const data = window.AppState?.gameData;
    if (cameraMode !== CAMERA_MODES.FREE && !followTarget) {
        const target = _defaultSelfTarget();
        if (target) _commitViewState(cameraMode, target);
    }
    const hit = _resolveFollowTargetData(followTarget, data);

    if (cameraMode !== CAMERA_MODES.FREE) {
        if (!hit || hit.x == null || hit.y == null || hit.z == null) return;
        followState = _makeFollowState();
        if (cameraMode === CAMERA_MODES.FIRST_PERSON) _resetFirstPersonCamera(hit);
        else _resetThirdPersonCamera(hit);
        console.log(`[Radar3D] 已重置 ${cameraMode} 视角`);
        return;
    }

    if (mapMesh || (Array.isArray(data?.players) && data.players.length > 0)) {
        fitToAll();
    } else if (data?.local?.x != null) {
        const cx = ueToThreeX(data.local.x);
        const cy = ueToThreeY(data.local.y);
        const cz = ueToThreeZ(data.local.z);
        controls.target.set(cx, cy, cz);
        camera.position.set(cx + 80, cy - 80, cz + 100);
        controls.update();
    } else {
        controls.target.set(0, 0, 0);
        camera.position.set(1000, 1000, 1000);
        controls.update();
    }
    console.log('[Radar3D] 已重置总览视角');
};

/* 单击列表 = 相机 target 跳到该实体世界位置 (一次性 focus, 不锁定跟随) */
window.radar3dFocus = function(kind, x, y, z, name) {
    if (window.viewMode !== '3d') return;
    const wx = ueToThreeX(x), wy = ueToThreeY(y), wz = ueToThreeZ(z);
    const delta = new THREE.Vector3(wx, wy, wz).sub(controls.target);
    controls.target.set(wx, wy, wz);
    camera.position.add(delta);
    controls.update();
    console.log(`[Radar3D] 单击聚焦 ${kind}: ${name}`);
};

/* 双击 = 持续跟随;再次双击已跟随目标 = 取消 */
window.radar3dFollow = function(kind, name) {
    if (window.viewMode !== '3d') return;
    if (cameraMode !== CAMERA_MODES.FREE && followTarget &&
        followTarget.kind === kind && followTarget.name === name) {
        _setFollowTarget(null);
        console.log('[Radar3D] 取消跟随');
        return;
    }
    _setFollowTarget({ kind, name });
    console.log(`[Radar3D] 开始跟随: ${kind} "${name}"`);
};

/* 每帧跟随核心；firstPerson 调用前需先让 controls.update() 吸收用户观察方向。 */
function updateFollow(controlsAlreadyUpdated = false) {
    if (cameraMode === CAMERA_MODES.FREE || !followTarget || !followState) return;
    const data = window.AppState?.gameData;
    if (!data) return;
    const hit = _resolveFollowTargetData(followTarget, data);
    if (!hit) {
        if (followState.lostSince === 0) followState.lostSince = performance.now();
        return;
    }
    followState.lostSince = 0;
    if (hit.x == null || hit.y == null || hit.z == null) return;

    if (cameraMode === CAMERA_MODES.FIRST_PERSON) {
        if (followState.needsCameraReset) {
            _resetFirstPersonCamera(hit);
            return;
        }
        if (!controlsAlreadyUpdated) controls.update();
        const direction = new THREE.Vector3();
        camera.getWorldDirection(direction);
        if (direction.lengthSq() < 1e-8) {
            const yaw = ueYawToThreeRotZ(hit.yaw);
            direction.set(Math.cos(yaw), Math.sin(yaw), 0);
        } else {
            direction.normalize();
        }
        if(Number.isFinite(hit.yaw)) direction.set(...aimDirection(hit.yaw,Number(hit.pitch)||0));
        const desiredEye = _worldPositionForTarget(hit);
        desiredEye.z += _firstPersonEyeOffset();
        if (!followState.eye) followState.eye = desiredEye.clone();
        else {
            const now = performance.now(), dt = Math.min(100, Math.max(0, now - (followState.eyeUpdatedAt ?? now - 16.67)));
            const tau = Number(window.AppState?.display?.fpvtau);
            const alpha = window.AppState?.gameData?.replay || tau === 0 ? 1 :
                Number.isFinite(tau) && tau > 0 ? 1 - Math.exp(-dt / tau) : FIRST_PERSON_CAMERA.POSITION_LERP;
            followState.eye.lerp(desiredEye, alpha);
        }
        followState.eyeUpdatedAt = performance.now();
        camera.position.copy(followState.eye);
        controls.target.copy(followState.eye).addScaledVector(direction, FIRST_PERSON_CAMERA.LOOK_DISTANCE);
        camera.lookAt(controls.target);
        return;
    }

    if (followState.needsCameraReset) {
        _resetThirdPersonCamera(hit);
        return;
    }
    const desiredAnchor = _worldPositionForTarget(hit);
    desiredAnchor.z += THIRD_PERSON_CAMERA.LOOK_HEIGHT;
    if (!followState.anchor) followState.anchor = desiredAnchor.clone();
    const nextAnchor = followState.anchor.clone().lerp(desiredAnchor, window.AppState?.gameData?.replay ? 1 : THIRD_PERSON_CAMERA.ANCHOR_LERP);
    const delta = nextAnchor.clone().sub(followState.anchor);
    followState.anchor.copy(nextAnchor);
    /* 平移相机与 Orbit target，不改两者相对向量：用户旋转、缩放、平移全部保留。 */
    camera.position.add(delta);
    controls.target.add(delta);
    if(window.AppState?.display?.followYaw && Number.isFinite(hit.yaw)) {
        const offset=camera.position.clone().sub(controls.target);
        const radius=Math.max(1,Math.hypot(offset.x,offset.y)), yaw=ueYawToThreeRotZ(hit.yaw);
        camera.position.set(controls.target.x-Math.cos(yaw)*radius,controls.target.y-Math.sin(yaw)*radius,controls.target.z+offset.z);
        camera.lookAt(controls.target);
    }
}

// ============================================================================
//  Loading overlay
// ============================================================================
function _showMapLoading(title, sub, progress) {
    const el = document.getElementById('mapLoadingOverlay');
    if (!el) return;
    el.style.display = 'block';
    document.getElementById('mapLoadingTitle').textContent = title;
    document.getElementById('mapLoadingSub').textContent = sub || '';
    const p = Math.max(0, Math.min(100, progress ?? 0));
    document.getElementById('mapLoadingBar').style.width = p + '%';
}
function _hideMapLoading() {
    const el = document.getElementById('mapLoadingOverlay');
    if (el) el.style.display = 'none';
}

// ============================================================================
//  IndexedDB 缓存 (world-space float32 三角形二进制)
//  Key = mapName. 存的东西: {name, tag, buffer(ArrayBuffer), size, savedAt}
//  tag 来自 server X-File-Tag / meta.fileTag, 服务端换 bin 就自动失效.
// ============================================================================
const IDB_DB_NAME = 'RadarMapCache';
const IDB_STORE   = 'maps';
const IDB_VERSION = 1;

function _openIDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_DB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE, { keyPath: 'name' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}
async function _idbGet(name) {
    try {
        const db = await _openIDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(name);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror   = () => reject(req.error);
        });
    } catch (e) {
        console.warn('[Radar3D] IndexedDB 读取失败:', e);
        return null;
    }
}
async function _idbPut(entry) {
    try {
        const db = await _openIDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
            tx.objectStore(IDB_STORE).put(entry);
        });
    } catch (e) {
        console.warn('[Radar3D] IndexedDB 写入失败:', e);
    }
}
/* 调试用: 手动清缓存 */
window.__clearMapCache = async function() {
    const db = await _openIDB();
    return new Promise((r) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.oncomplete = () => { console.log('[Radar3D] 缓存已清'); r(); };
        tx.objectStore(IDB_STORE).clear();
    });
};

// ============================================================================
//  地图碰撞几何加载 (from /api/map/<name>, 走 IndexedDB 缓存)
// ============================================================================

function _sampleMapHeightRange(positions) {
    const vertexCount = Math.floor(positions.length / 3);
    if (vertexCount === 0) return { low: 0, high: 20 };
    const sampleTarget = Math.min(8192, vertexCount);
    const samples = [];
    for (let i = 0; i < sampleTarget; i += 1) {
        const vertex = sampleTarget === 1
            ? 0
            : Math.floor(i * (vertexCount - 1) / (sampleTarget - 1));
        const z = positions[vertex * 3 + 2];
        if (Number.isFinite(z)) samples.push(z);
    }
    samples.sort((a, b) => a - b);
    if (samples.length === 0) return { low: 0, high: 20 };
    const low = samples[Math.floor((samples.length - 1) * 0.03)];
    const high = samples[Math.floor((samples.length - 1) * 0.97)];
    return { low, high: Math.max(low + 8, high) };
}

/* 底图纹理未就绪时绑定的 1×1 透明占位，避免着色器采样未绑定的 sampler。 */
let _blankMapTexture = null;
function _radarBlankMapTexture() {
    if (!_blankMapTexture) {
        _blankMapTexture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
        _blankMapTexture.needsUpdate = true;
    }
    return _blankMapTexture;
}

/* hasBake：几何带 bake 属性（Uint8 归一化，R = 半球 AO，G = 头顶天空可见度）。
   用 define 区分变体：无该属性时绝不能读 attribute（WebGL 默认值 0，整图会变黑）。 */
function _createRadarMapMaterial(zLow, zHigh, cutaway = false, hasBake = false) {
    const profile = activeQualityProfile || RENDER_QUALITY_PROFILES[_resolvedRenderQualityId()];
    const range = Math.max(8, zHigh - zLow);
    const adaptiveContour = THREE.MathUtils.clamp(
        2 ** Math.round(Math.log2(range / 20)),
        2,
        16,
    );
    const uniforms = {
        radarZLow: { value: zLow },
        radarZInvRange: { value: 1 / range },
        radarColorStrength: { value: profile.colorStrength },
        radarEdgeStrength: { value: profile.edgeStrength },
        radarContourStrength: { value: profile.contourStrength },
        radarWallHighlightStrength: { value: profile.wallHighlightStrength },
        radarCutTopStrength: { value: profile.cutTopStrength },
        radarDetailEnabled: { value: profile.edgeStrength > 0 || profile.contourStrength > 0 ? 1 : 0 },
        radarContourSpacing: { value: Math.max(adaptiveContour, profile.contourSpacing) },
        radarGroundRoughness: { value: profile.roughness },
        radarWallRoughness: { value: Math.min(1, profile.roughness + 0.10) },
        radarMetalness: { value: profile.metalness },
        radarUpView: { value: RADAR_WORLD_UP.clone() },
        radarLightView: { value: RADAR_WORLD_LIGHT_DIRECTION.clone() },
        radarGroundLow: { value: new THREE.Color(0x0b2630) },
        radarGroundHigh: { value: new THREE.Color(0x3a6c72) },
        radarWallLow: { value: new THREE.Color(0x07101d) },
        radarWallHigh: { value: new THREE.Color(0x1d4055) },
        radarEdgeColor: { value: new THREE.Color(0x2ac2d0) },
        // 官方底图投影：世界 XY → UV 的仿射矩阵（含 rotate），强度 0 时片元里整段跳过
        radarMapTex: { value: _radarBlankMapTexture() },
        radarMapUvMatrix: { value: new THREE.Matrix3() },
        radarMapStrength: { value: 0 },
        radarMapTint: { value: 0 },
        radarMapWallTint: { value: 0.22 },
        radarAoStrength: { value: 0.85 },
    };
    const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        metalness: profile.metalness,
        roughness: profile.roughness,
        envMapIntensity: profile.environmentIntensity,
        side: THREE.DoubleSide,
        flatShading: true,
    });
    if (hasBake) material.defines = { ...(material.defines || {}), RADAR_BAKE: '' };
    material.userData.radarUniforms = uniforms;
    material.userData.radarAdaptiveContour = adaptiveContour;
    material.userData.radarCutawayVariant = cutaway;
    material.userData.radarHasBake = hasBake;
    material.onBeforeCompile = shader => {
        if (cutaway) _injectRadarCutawayShader(shader);
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
            .replace(
                '#include <common>',
                `#include <common>
varying float vRadarHeight;
varying vec2 vRadarMapUv;
uniform mat3 radarMapUvMatrix;
#ifdef RADAR_BAKE
attribute vec2 bake;
varying vec2 vRadarBake;
#endif`,
            )
            .replace(
                '#include <begin_vertex>',
                `#include <begin_vertex>
vRadarHeight = position.z;
vRadarMapUv = ( radarMapUvMatrix * vec3( ( modelMatrix * vec4( transformed, 1.0 ) ).xy, 1.0 ) ).xy;
#ifdef RADAR_BAKE
vRadarBake = bake;
#endif`,
            );
        shader.fragmentShader = shader.fragmentShader
            .replace(
                '#include <common>',
                `#include <common>
varying float vRadarHeight;
uniform float radarZLow;
uniform float radarZInvRange;
uniform float radarColorStrength;
uniform float radarEdgeStrength;
uniform float radarContourStrength;
uniform float radarWallHighlightStrength;
uniform float radarCutTopStrength;
uniform float radarDetailEnabled;
uniform float radarContourSpacing;
uniform float radarGroundRoughness;
uniform float radarWallRoughness;
uniform float radarMetalness;
uniform vec3 radarUpView;
uniform vec3 radarLightView;
uniform vec3 radarGroundLow;
uniform vec3 radarGroundHigh;
uniform vec3 radarWallLow;
uniform vec3 radarWallHigh;
uniform vec3 radarEdgeColor;
varying vec2 vRadarMapUv;
uniform sampler2D radarMapTex;
uniform float radarMapStrength;
uniform float radarMapTint;
uniform float radarMapWallTint;
uniform float radarAoStrength;
#ifdef RADAR_BAKE
varying vec2 vRadarBake;
#endif`,
            )
            .replace(
                '#include <normal_fragment_maps>',
                `#include <normal_fragment_maps>
vec3 radarNormal = normalize( normal );
float radarUpness = abs( dot( radarNormal, radarUpView ) );
float radarHeight01 = clamp( ( vRadarHeight - radarZLow ) * radarZInvRange, 0.0, 1.0 );
float radarHorizontal = smoothstep( 0.34, 0.82, radarUpness );
float radarWallness = 1.0 - smoothstep( 0.22, 0.74, radarUpness );
vec3 radarGroundColor = mix( radarGroundLow, radarGroundHigh, radarHeight01 );
vec3 radarWallColor = mix( radarWallLow, radarWallHigh, radarHeight01 );
float radarSkyOpen = 1.0;
#ifdef RADAR_BAKE
radarSkyOpen = vRadarBake.y;   // 室内地板头顶不是天空：不印屋顶图案
#endif
if ( radarMapStrength > 0.0 ) {
    // 在 uniform 分支内无条件采样（保证 mip 导数），出界与未下载的瓦片靠 alpha 归零
    vec4 radarTile = texture2D( radarMapTex, vRadarMapUv );
    vec2 radarTileIn = step( vec2( 0.0 ), vRadarMapUv ) * step( vRadarMapUv, vec2( 1.0 ) );
    float radarMapK = radarMapStrength * radarTile.a * radarTileIn.x * radarTileIn.y * radarSkyOpen;
    // radarMapTint=1（战术风格）：只取底图亮度映射到本风格地面色阶，保留道路与地貌而不破坏配色
    float radarTileLuma = dot( radarTile.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
    vec3 radarTileStyled = mix( radarGroundLow, radarGroundHigh, clamp( radarTileLuma * 1.6, 0.0, 1.0 ) ) * 1.25;
    vec3 radarTileColor = mix( radarTile.rgb * 1.12, radarTileStyled, radarMapTint );
    radarGroundColor = mix( radarGroundColor, radarTileColor, radarMapK );
    radarWallColor = mix( radarWallColor, radarWallColor * ( 0.7 + 0.6 * radarTile.rgb ), radarMapK * radarMapWallTint );
}
vec3 radarSurfaceColor = mix( radarWallColor, radarGroundColor, radarHorizontal );
float radarOrientation = dot( radarNormal, radarLightView ) * 0.5 + 0.5;
radarSurfaceColor *= mix( 0.74, 1.02, radarOrientation );
float radarRoofAccent = smoothstep( 0.55, 1.0, radarHeight01 ) * smoothstep( 0.82, 0.97, radarUpness );
radarSurfaceColor += vec3( 0.006, 0.022, 0.026 ) * radarRoofAccent;
#ifdef RADAR_BAKE
radarSurfaceColor *= mix( 1.0, vRadarBake.x, radarAoStrength );
#endif
diffuseColor.rgb = mix( diffuseColor.rgb, radarSurfaceColor, radarColorStrength );
roughnessFactor = mix( radarWallRoughness, radarGroundRoughness, radarHorizontal );
metalnessFactor = radarMetalness;
float radarArchitectureFade = 1.0 - smoothstep( 800.0, 2200.0, length( vViewPosition ) );
totalEmissiveRadiance += radarEdgeColor * radarWallness * radarWallHighlightStrength * radarArchitectureFade;
${cutaway ? `float radarCutawayDistance = length( vRadarCutWorldPosition.xy - radarCutawayCenter );
float radarCutawayInterior = 1.0 - smoothstep( max( radarCutawayRadius - 2.0, 0.0 ), radarCutawayRadius, radarCutawayDistance );
float radarCutTopLine = ( 1.0 - smoothstep( 0.05, 0.65, abs( vRadarCutWorldPosition.z - radarCutawayPlaneZ ) ) )
    * radarWallness * radarCutawayInterior;
totalEmissiveRadiance += radarEdgeColor * radarCutTopLine * radarCutTopStrength;` : ''}
if ( radarDetailEnabled > 0.5 ) {
    float radarViewFacing = abs( dot( radarNormal, normalize( vViewPosition ) ) );
    float radarRim = pow( 1.0 - clamp( radarViewFacing, 0.0, 1.0 ), 2.2 );
    float radarContourCoord = ( vRadarHeight - radarZLow ) / max( radarContourSpacing, 0.001 );
    float radarContourPhase = abs( fract( radarContourCoord + 0.5 ) - 0.5 );
    float radarContourWidth = clamp( fwidth( radarContourCoord ) * 1.35, 0.0008, 0.15 );
    float radarContour = 1.0 - smoothstep( radarContourWidth, radarContourWidth * 2.25, radarContourPhase );
    float radarDetailFade = 1.0 - smoothstep( 700.0, 2100.0, length( vViewPosition ) );
    totalEmissiveRadiance += radarEdgeColor * radarDetailFade
        * ( radarRim * radarEdgeStrength + radarContour * radarContourStrength );
}`,
            );
        material.userData.radarShader = shader;
    };
    material.customProgramCacheKey = () => `relink-radar-map-style-v5-${cutaway ? 'cutaway' : 'plain'}-${hasBake ? 'bake' : 'nobake'}`;
    return material;
}

/* 通用: 从 ArrayBuffer (UE 世界坐标 cm) → three.js BufferGeometry + 材质 + fitToAll.
   loadMap 主入口和缓存命中路径都走这个函数, 保证一致. */
function _buildMapFromBuffer(name, buf) {
    const floats = new Float32Array(buf);
    const nTri = floats.length / 9;
    currentMapTriangleCount = nTri;
    console.log(`[Radar3D] 构建 ${name}: ${(buf.byteLength/1024/1024).toFixed(1)} MB, ${nTri} 三角形`);

    /* 缩放到米 (÷ 100) + UE 左手→three 右手: y 翻符号.
       顺便: 翻 y 会把三角形绕序翻转 → 法线朝向反了, 需要 swap 每三角形的
       顶点顺序 (v0,v1,v2 → v0,v2,v1) 让 computeVertexNormals 出正确朝向. */
    const scaled = new Float32Array(floats.length);
    for (let t = 0; t < nTri; ++t) {
        const src = t * 9;
        const dst = t * 9;
        scaled[dst + 0] =  floats[src + 0] * UE_TO_M;
        scaled[dst + 1] = -floats[src + 1] * UE_TO_M;
        scaled[dst + 2] =  floats[src + 2] * UE_TO_M;
        scaled[dst + 3] =  floats[src + 6] * UE_TO_M;
        scaled[dst + 4] = -floats[src + 7] * UE_TO_M;
        scaled[dst + 5] =  floats[src + 8] * UE_TO_M;
        scaled[dst + 6] =  floats[src + 3] * UE_TO_M;
        scaled[dst + 7] = -floats[src + 4] * UE_TO_M;
        scaled[dst + 8] =  floats[src + 5] * UE_TO_M;
    }

    // 旧版三角形流与 GLB 走同一条装图路径（分块、材质、阴影、底图投影）
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(scaled, 3));
    gatewayInstallGeometry(name, geo);
}

/* 新版 loadMap: 走 IndexedDB 缓存 + 服务端 fileTag 校验 + loading overlay.
   流程:
     1. 显示 loading "正在检查缓存"
     2. GET /api/map/<name>/meta 拿 fileTag
        - 服务端 404: 显示 "地图未找到" 2s 后隐藏
        - 服务端 5xx: 显示错误
     3. 查 IndexedDB
        - 命中 (tag 一致): 显示 "使用本地缓存" → 直接构建 → 完成
        - 未命中/tag 变了: 显示 "下载 XX MB..." → fetch 带 progress → 存缓存 → 构建 → 完成
     4. 出错: overlay 显红字, 3s 后隐藏, currentMapName 复位
*/
async function loadMap(name) {
    if (!name) return;
    if (currentMapName === name) return;
    if (mapLoading) return;
    /* 3D 权限防御 — 服务端 join_success 里下发. 前端防误触, 但真正的安全靠 server
       校验 mapToken (下面 fetch 时带上). */
    if (window.allow3d === false) {
        console.warn(`[Radar3D] 3D 未开通, 跳过地图加载: ${name}`);
        return;
    }
    /* map token: server 下发, 无 token 也没必要发请求 (server 会 403) */
    const tokenParam = window.mapToken ? `?token=${encodeURIComponent(window.mapToken)}` : '';
    if (!tokenParam) {
        console.warn(`[Radar3D] 未拿到 map token, 跳过地图加载: ${name}`);
        return;
    }
    /* 本地壳可通过 apiServer 连接中央授权服务；地图 meta/token 必须发给同一台服务。 */
    const apiBase = (window.AppState?.apiServer || '').replace(/\/+$/, '');
    const encodedName = encodeURIComponent(name);
    const metaUrl = `${apiBase}/api/map/${encodedName}/meta${tokenParam}`;
    const fallbackDownloadUrl = `${apiBase}/api/map/${encodedName}${tokenParam}`;

    mapLoading = true;
    currentMapName = name;
    console.log(`[Radar3D] 加载地图: ${name}`);

    try {
        _showMapLoading(`加载地图 ${name}`, '检查服务端...', 5);

        /* 1) 探 meta 拿 fileTag */
        let meta = null;
        try {
            const metaResp = await fetch(metaUrl, { credentials: 'omit', cache: 'no-store' });
            if (metaResp.ok) meta = await metaResp.json();
            else if (metaResp.status === 404) {
                console.warn(`[Radar3D] 地图 ${name} 未找到 (404)`);
                _showMapLoading(`地图 ${name} 未找到`, '服务端未配置这张 3D 地图', 100);
                setTimeout(_hideMapLoading, 2500);
                currentMapName = null;
                return;
            } else if (metaResp.status === 403) {
                console.warn(`[Radar3D] 3D 权限被服务端拒绝: ${name}`);
                _showMapLoading('3D 未授权', '您的授权码未开通 3D 模式', 100);
                setTimeout(_hideMapLoading, 2500);
                currentMapName = null;
                return;
            } else {
                throw new Error(`meta HTTP ${metaResp.status}`);
            }
        } catch (e) {
            console.warn('[Radar3D] meta 失败, 直接尝试 fetch:', e);
        }
        let serverTag = meta?.fileTag || '';
        const cacheKey = meta?.cacheKey || meta?.canonicalName || name;

        /* 2) 查 IndexedDB */
        _showMapLoading(`加载地图 ${name}`, '检查本地缓存...', 10);
        const cached = await _idbGet(cacheKey);
        const cachedSizeOk = !meta?.sizeBytes || cached?.buffer?.byteLength === Number(meta.sizeBytes);
        const cachedFormatOk = !!cached?.buffer && cached.buffer.byteLength % 36 === 0;
        if (cached && cached.tag && cached.tag === serverTag && cachedSizeOk && cachedFormatOk) {
            const mb = (cached.buffer.byteLength / 1024 / 1024).toFixed(1);
            _showMapLoading(`使用本地缓存`, `${cached.tris ?? '?'} 三角形, ${mb} MB`, 100);
            _buildMapFromBuffer(name, cached.buffer);
            setTimeout(_hideMapLoading, 500);
            return;
        }
        if (cached) console.log(`[Radar3D] 本地缓存 tag=${cached.tag}, 服务端 tag=${serverTag}, 缓存失效`);

        /* 3) 未命中或过期 → fetch, 带进度条 */
        _showMapLoading(`下载地图 ${name}`, meta?.tris ? `预计 ${meta.tris} 三角形` : '', 15);
        let downloadUrl = meta?.downloadUrl || fallbackDownloadUrl;
        let resp = await fetch(downloadUrl, { credentials: 'omit' });

        /* OSS/CDN 的 403 可能只是短时 URL 过期，不等于业务 3D 未授权。
           重新向业务服务取一次 meta；只有 meta 本身 403 才显示权限错误。 */
        if (resp.status === 403 && meta?.downloadUrl) {
            console.warn('[Radar3D] 模型下载 URL 被拒绝，刷新签名后重试一次');
            const refreshResp = await fetch(metaUrl, { credentials: 'omit', cache: 'no-store' });
            if (refreshResp.status === 403) {
                _showMapLoading('3D 未授权', '您的授权码未开通 3D 模式或已失效', 100);
                setTimeout(_hideMapLoading, 2500);
                currentMapName = null;
                return;
            }
            if (!refreshResp.ok) throw new Error(`刷新下载地址失败 HTTP ${refreshResp.status}`);
            meta = await refreshResp.json();
            serverTag = meta?.fileTag || serverTag;
            downloadUrl = meta?.downloadUrl || fallbackDownloadUrl;
            resp = await fetch(downloadUrl, { credentials: 'omit' });
        }
        if (!resp.ok) {
            if (resp.status === 404) {
                _showMapLoading(`地图 ${name} 未找到`, '服务端未配置这张 3D 地图', 100);
                setTimeout(_hideMapLoading, 2500);
                currentMapName = null;
                return;
            }
            if (resp.status === 403) {
                if (meta?.downloadUrl) {
                    throw new Error('OSS/CDN 拒绝下载，请检查签名有效期、CORS 和对象权限');
                } else {
                    _showMapLoading('3D 未授权', '您的授权码未开通 3D 模式', 100);
                    setTimeout(_hideMapLoading, 2500);
                    currentMapName = null;
                    return;
                }
            }
            throw new Error(`bin HTTP ${resp.status}`);
        }

        /* 流式进度 — Content-Length 可能没有 (chunked), 就 fallback */
        const totalStr = resp.headers.get('Content-Length');
        const declaredSize = Number(meta?.sizeBytes) || 0;
        const total = totalStr ? parseInt(totalStr, 10) : declaredSize;
        const respTag = resp.headers.get('X-File-Tag') || serverTag || '';
        const respTris = resp.headers.get('X-Tris') || (meta?.tris != null ? String(meta.tris) : null);
        let buf;
        if (resp.body && resp.body.getReader) {
            const reader = resp.body.getReader();
            const chunks = [];
            let received = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.length;
                const pct = total > 0 ? 15 + Math.min(80, (received / total) * 80) : 15;
                _showMapLoading(`下载地图 ${name}`,
                    `${(received/1024/1024).toFixed(1)} / ${total > 0 ? (total/1024/1024).toFixed(1) + ' MB' : '?'}`,
                    pct);
            }
            buf = new Uint8Array(received);
            let off = 0;
            for (const c of chunks) { buf.set(c, off); off += c.length; }
            buf = buf.buffer;
        } else {
            buf = await resp.arrayBuffer();
        }

        if (declaredSize > 0 && buf.byteLength !== declaredSize) {
            throw new Error(`地图文件不完整：收到 ${buf.byteLength} 字节，应为 ${declaredSize} 字节`);
        }
        if (buf.byteLength === 0 || buf.byteLength % 36 !== 0) {
            throw new Error(`地图格式错误：${buf.byteLength} 字节不是完整的 float32 三角形数据`);
        }

        _showMapLoading(`构建场景 ${name}`, `${respTris ?? '?'} 三角形`, 92);
        _buildMapFromBuffer(name, buf);

        /* 4) 写缓存 */
        _showMapLoading(`保存本地缓存`, `${(buf.byteLength/1024/1024).toFixed(1)} MB`, 98);
        await _idbPut({
            name: cacheKey, tag: respTag, buffer: buf,
            tris: respTris ? parseInt(respTris, 10) : null,
            savedAt: Date.now(),
        });
        _showMapLoading(`加载完成`, name, 100);
        setTimeout(_hideMapLoading, 400);
    } catch (e) {
        console.error(`[Radar3D] 加载地图 ${name} 失败:`, e);
        _showMapLoading(`加载失败`, String(e && e.message ? e.message : e), 100);
        setTimeout(_hideMapLoading, 3000);
        currentMapName = null;
    } finally {
        mapLoading = false;
    }
}

// ============================================================================
//  小地图 (3D 模式下画在左上角) — 直接 drawImage 2D mapCanvas.
//    map layer 一直在跑 renderFrame(), 即使 canvas 是 hidden, 内部像素仍
//    实时更新. 所以我们只需要 drawImage 到 minimap3d 就得到"2D 态势微缩版",
//    地图纹理/校准/头像/blip 全套自带, 不用维护两套渲染逻辑.
//    点击 minimap3d 弹全屏放大 (setupMinimapClick 已绑定).
// ============================================================================
function drawMinimap() {
    if (!minimapCtx) return;
    const cv = minimapCanvas;
    const ctx = minimapCtx;
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);

    /* 圆角裁剪, 保持"迷你地图"卡片观感 */
    ctx.save();
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, w, h, 8);
    else ctx.rect(0, 0, w, h);
    ctx.clip();

    const src = document.getElementById('radarCanvas');
    if (src && src.width > 0 && src.height > 0) {
        /* cover 模式 — 从 2D 态势图裁剪一个方块子区域填满 minimap.
           2D 画布是横宽 (1920x1080 typical), contain 后上下大黑边看不清.
           cover: 从画面中心裁一块方形 (edge=min(sw,sh)*0.7 缩小到约屏幕中心区域)
                  再画到 minimap 满框. 3D 的相机 target 是玩家位置, 玩家一般在 2D 地图中心,
                  所以裁中间正好覆盖玩家周边区域. */
        const sw = src.width, sh = src.height;
        const sEdge = Math.min(sw, sh) * 0.85;  // 中心 85% 方形
        const srcX = (sw - sEdge) / 2, srcY = (sh - sEdge) / 2;
        ctx.fillStyle = '#0a0e17';
        ctx.fillRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, srcX, srcY, sEdge, sEdge, 0, 0, w, h);
    } else {
        ctx.fillStyle = '#0a0e17';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#6b7a94';
        ctx.font = '12px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('2D 地图加载中...', w / 2, h / 2);
    }
    ctx.restore();

    /* 边框 + 右上角"点击放大"提示 */
    ctx.strokeStyle = 'rgba(0,240,255,0.3)';
    ctx.lineWidth = 1;
    if (ctx.roundRect) {
        ctx.beginPath(); ctx.roundRect(0.5, 0.5, w - 1, h - 1, 8); ctx.stroke();
    } else {
        ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    }
}

/* 点击 minimap3d 弹全屏放大. 用一个覆盖层显示原尺寸 radarCanvas 的 clone.
   为避免主 canvas 尺寸受影响, 用 CSS transform 放大而不是改元素尺寸. */
function setupMinimapClick() {
    if (!minimapCanvas) return;
    minimapCanvas.style.cursor = 'zoom-in';
    minimapCanvas.addEventListener('click', () => {
        const existing = document.getElementById('minimap3dFull');
        if (existing) { existing.remove(); return; }

        const overlay = document.createElement('div');
        overlay.id = 'minimap3dFull';
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0',
            background: 'rgba(10,14,23,0.9)',
            zIndex: '300',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            backdropFilter: 'blur(6px)',
        });

        const src = document.getElementById('radarCanvas');
        const canvas = document.createElement('canvas');
        /* 尺寸: 视窗 90%, 保持源比例 */
        const vw = window.innerWidth, vh = window.innerHeight;
        const maxW = vw * 0.9, maxH = vh * 0.86;
        const srcRatio = src.width / src.height;
        let cw = maxW, ch = maxW / srcRatio;
        if (ch > maxH) { ch = maxH; cw = maxH * srcRatio; }
        canvas.style.width  = cw + 'px';
        canvas.style.height = ch + 'px';
        canvas.width  = src.width;
        canvas.height = src.height;
        canvas.style.border = '1px solid rgba(0,240,255,0.35)';
        canvas.style.borderRadius = '8px';
        canvas.style.boxShadow = '0 10px 40px rgba(0,0,0,0.6)';
        canvas.style.cursor = 'grab';
        canvas.style.touchAction = 'none';   // 让 pinch/pan 不被浏览器默认吃掉
        canvas.addEventListener('click', (e) => e.stopPropagation());
        overlay.appendChild(canvas);

        const hint = document.createElement('div');
        hint.textContent = '拖动 · 滚轮缩放 · 空白处或 ESC 关闭';
        Object.assign(hint.style, {
            color: '#6b7a94', fontSize: '12px', marginTop: '12px',
            fontFamily: 'system-ui, sans-serif',
        });
        overlay.appendChild(hint);

        const ctx = canvas.getContext('2d');
        let rafId = 0;
        function paint() {
            const s = document.getElementById('radarCanvas');
            if (s && s.width > 0) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(s, 0, 0);
            }
            rafId = requestAnimationFrame(paint);
        }
        paint();

        /* v700x3: 通过 window.radarPanZoom API 转发 pan/zoom 到主 radarCanvas.
             overlay canvas display size (cw, ch) → 主 canvas 内部像素 src.width/height,
             ratio = src.width / cw. 拖动/缩放的鼠标屏幕像素乘 ratio 就是主 canvas 像素. */
        const api = window.radarPanZoom;
        if (!api) console.warn('[Radar3D] radarPanZoom API 未加载, minimap 放大无 pan/zoom');

        /* pointer events 统一鼠标+触屏, 内部区分单指/双指 */
        let dragging = false, lastX = 0, lastY = 0;
        let pinch = null;
        const pointers = new Map();

        function _ratios() {
            const rect = canvas.getBoundingClientRect();
            return {
                rx: src.width  / rect.width,
                ry: src.height / rect.height,
                rect,
            };
        }

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (!api) return;
            const { rx, ry, rect } = _ratios();
            /* 主 canvas 上的鼠标像素 */
            const mx = (e.clientX - rect.left) * rx;
            const my = (e.clientY - rect.top)  * ry;
            const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            api.zoom(zoomFactor, mx, my);
        }, { passive: false });

        canvas.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size === 1) {
                dragging = true;
                lastX = e.clientX; lastY = e.clientY;
                canvas.style.cursor = 'grabbing';
            } else if (pointers.size === 2) {
                dragging = false;
                const [a, b] = [...pointers.values()];
                pinch = {
                    dist: Math.hypot(a.x - b.x, a.y - b.y),
                    midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2,
                };
            }
        });

        canvas.addEventListener('pointermove', (e) => {
            if (!pointers.has(e.pointerId)) return;
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (!api) return;

            if (pointers.size === 1 && dragging) {
                const { rx, ry } = _ratios();
                const dx = (e.clientX - lastX) * rx;
                const dy = (e.clientY - lastY) * ry;
                lastX = e.clientX; lastY = e.clientY;
                api.pan(dx, dy);
            } else if (pointers.size === 2 && pinch) {
                const [a, b] = [...pointers.values()];
                const newDist = Math.hypot(a.x - b.x, a.y - b.y);
                const zoomFactor = newDist / Math.max(1, pinch.dist);
                const { rx, ry, rect } = _ratios();
                const midX = (a.x + b.x) / 2;
                const midY = (a.y + b.y) / 2;
                /* 缩放中心用双指中点 */
                const mx = (midX - rect.left) * rx;
                const my = (midY - rect.top)  * ry;
                api.zoom(zoomFactor, mx, my);
                pinch.dist = newDist;
                pinch.midX = midX;
                pinch.midY = midY;
            }
        });

        function _pointerEnd(e) {
            pointers.delete(e.pointerId);
            if (pointers.size < 2) pinch = null;
            if (pointers.size === 0) {
                dragging = false;
                canvas.style.cursor = 'grab';
            }
        }
        canvas.addEventListener('pointerup', _pointerEnd);
        canvas.addEventListener('pointercancel', _pointerEnd);

        /* 关闭 */
        const close = () => {
            cancelAnimationFrame(rafId);
            overlay.remove();
            document.removeEventListener('keydown', escHandler);
        };
        overlay.addEventListener('click', (e) => {
            /* 只在点击 overlay 空白区 (target === overlay) 才关 */
            if (e.target === overlay) close();
        });
        const escHandler = (e) => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', escHandler);

        document.body.appendChild(overlay);
    });
}

// ============================================================================
//  主循环 + 尺寸
// ============================================================================
function _syncSsaoCameraParameters() {
    if (!ssaoPass || !camera) return;
    const span = Math.max(1, camera.far - camera.near);
    const orbitDistance = controls
        ? camera.position.distanceTo(controls.target)
        : 30;
    const radius = THREE.MathUtils.clamp(orbitDistance * 0.03, 2, 14);
    ssaoPass.kernelRadius = radius;
    ssaoPass.minDistance = Math.max(1e-7, 0.05 / span);
    ssaoPass.maxDistance = Math.min(0.02, (radius * 2) / span);
    ssaoPass.ssaoMaterial.uniforms.cameraNear.value = camera.near;
    ssaoPass.ssaoMaterial.uniforms.cameraFar.value = camera.far;
    ssaoPass.depthRenderMaterial.uniforms.cameraNear.value = camera.near;
    ssaoPass.depthRenderMaterial.uniforms.cameraFar.value = camera.far;
    ssaoPass.ssaoMaterial.uniforms.cameraProjectionMatrix.value.copy(camera.projectionMatrix);
    ssaoPass.ssaoMaterial.uniforms.cameraInverseProjectionMatrix.value.copy(camera.projectionMatrixInverse);
    if (structureEdgePass) {
        structureEdgePass.uniforms.radarCameraNear.value = camera.near;
        structureEdgePass.uniforms.radarCameraFar.value = camera.far;
        structureEdgePass.uniforms.radarProjectionInverse.value.copy(camera.projectionMatrixInverse);
        camera.updateMatrixWorld();
        structureEdgePass.uniforms.radarCameraWorld.value.copy(camera.matrixWorld);
    }
}

function _updateMapShaderViewUniforms() {
    if (!mapMesh || !camera) return;
    camera.updateMatrixWorld();
    radarViewRotation.setFromMatrix4(camera.matrixWorldInverse);
    for (const material of _getRadarMapMaterials()) {
        const uniforms = material?.userData?.radarUniforms;
        if (!uniforms) continue;
        uniforms.radarUpView.value.copy(RADAR_WORLD_UP).applyMatrix3(radarViewRotation).normalize();
        uniforms.radarLightView.value.copy(RADAR_WORLD_LIGHT_DIRECTION).applyMatrix3(radarViewRotation).normalize();
    }
}

/* ---------------------------------------------------------------- 静态缓存阴影
   renderer.shadowMap.autoUpdate = false，阴影图只在以下时机重画：
     1) 阴影框中心离开当前位置超过框宽的 1/4，或框尺寸换档（按 1.25 倍分档）；
     2) 场景、材质、画质或墙体透明度变化（_requestShadowUpdate）；
     3) 框内有投影的人物移动，按 SHADOW_DYNAMIC_MS 节流。
   阴影相机中心在光源空间按 texel 对齐：光向固定，静态几何每次重画都落在同一批 texel 上，
   跨格重画时阴影边缘不会游动闪烁。分块后阴影 pass 只画阴影框内的块。 */
const SHADOW_DYNAMIC_MS = 100;
const SHADOW_LIGHT_DIR = new THREE.Vector3(1.05, -1.25, 1.90).normalize();
const SHADOW_LIGHT_DISTANCE = 700;
const _shadowCenter = new THREE.Vector3(), _shadowAhead = new THREE.Vector3(), _shadowSnap = new THREE.Vector3();

/* auto：高清档开；桌面平衡档也开（静态缓存 + 分块剔除后增量很小）；移动端平衡与流畅档关。 */
function _shadowsWanted(base) {
    if (shadowPref === 'on') return true;
    if (shadowPref === 'off') return false;
    return base.id === 'high' || (base.id === 'balanced' && !_isMobileGpuProfile());
}

function _requestShadowUpdate() {
    if (renderer?.shadowMap) renderer.shadowMap.needsUpdate = true;
}

function _placeShadowCamera(center, span) {
    const shadowCamera = dirLight.shadow.camera;
    if (!shadowRig.basisReady) {
        // 与 DirectionalLightShadow.updateMatrices 相同的朝向：相机在光源处看向目标，up 取相机默认
        const basis = new THREE.Matrix4().lookAt(SHADOW_LIGHT_DIR, new THREE.Vector3(), shadowCamera.up);
        shadowRig.right.setFromMatrixColumn(basis, 0);
        shadowRig.up.setFromMatrixColumn(basis, 1);
        shadowRig.basisReady = true;
    }
    const texel = 2 * span / Math.max(1, dirLight.shadow.mapSize.x);
    const r = center.dot(shadowRig.right), u = center.dot(shadowRig.up);
    _shadowSnap.copy(center)
        .addScaledVector(shadowRig.right, Math.round(r / texel) * texel - r)
        .addScaledVector(shadowRig.up, Math.round(u / texel) * texel - u);
    dirLight.target.position.copy(_shadowSnap);
    dirLight.position.copy(_shadowSnap).addScaledVector(SHADOW_LIGHT_DIR, SHADOW_LIGHT_DISTANCE);
    dirLight.target.updateMatrixWorld();
    dirLight.updateMatrixWorld();
    shadowCamera.left = -span; shadowCamera.right = span;
    shadowCamera.top = span; shadowCamera.bottom = -span;
    shadowCamera.near = 1; shadowCamera.far = SHADOW_LIGHT_DISTANCE * 2 + 400;
    shadowCamera.updateProjectionMatrix();
    shadowRig.center.copy(center);
    shadowRig.span = span;
    shadowRig.valid = true;
    _requestShadowUpdate();
}

/* 框内可见人物的位姿签名（5cm / 0.05rad 量化）；顺带给新建的人物模型补上 castShadow
   （人物模型可能在画质应用之后才创建）。 */
function _shadowCasterSignature() {
    let sig = 0, n = 0;
    const c = shadowRig.center, lim = shadowRig.span + 4;
    const visit = root => {
        if (!root?.visible) return;
        const p = root.position;
        if (Math.abs(p.x - c.x) > lim || Math.abs(p.y - c.y) > lim) return;
        n++;
        sig = (sig * 31 + Math.round(p.x * 20) * 3 + Math.round(p.y * 20) * 7
            + Math.round(p.z * 20) * 11 + Math.round(root.rotation.z * 20) * 13) % 1e15;
        root.traverse(o => { if (o.isMesh && o.userData.radarLitSurface && !o.castShadow) o.castShadow = true; });
    };
    if (selfEntity) visit(selfEntity.root);
    for (const e of POOL.players) visit(e.root);
    for (const e of POOL.bosses) visit(e.root);
    for (const e of POOL.ais) visit(e.root);
    return sig * 256 + n;
}

/* 诊断：按三维引擎同样的包围球-视锥测试，统计地图块在主相机 / 阴影相机里的可见量
   （与帧率无关，可在软件渲染下得到确定的数字）。draw call 按非空材质组估算。 */
const _cullFrustum = new THREE.Frustum(), _cullMatrix = new THREE.Matrix4();
function _mapCullStats(cam) {
    if (!mapMesh || !cam) return null;
    cam.updateMatrixWorld();
    _cullFrustum.setFromProjectionMatrix(_cullMatrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const [floorMat, wallMat] = _getRadarMapMaterials();
    let chunks = 0, triangles = 0, calls = 0;
    for (const chunk of mapMesh.children) {
        if (!_cullFrustum.intersectsObject(chunk)) continue;
        chunks++;
        for (const g of chunk.geometry.groups) {
            const mat = g.materialIndex === 0 ? floorMat : wallMat;
            if (!g.count || !mat?.visible) continue;
            calls++; triangles += g.count / 3;
        }
    }
    return { chunks, totalChunks: mapMesh.children.length, calls, triangles };
}

function _updateLightingRig() {
    if (!dirLight || !controls || !camera) return;
    const anchor = controls.target;
    const orbitDistance = camera.position.distanceTo(anchor);
    const fillSpan = THREE.MathUtils.clamp(orbitDistance * 1.8, 80, 220);
    if (fillLight) {
        fillLight.target.position.copy(anchor);
        fillLight.position.set(
            anchor.x - fillSpan * 0.8,
            anchor.y + fillSpan * 0.65,
            anchor.z + fillSpan * 0.9,
        );
    }
    if (!activeQualityProfile?.shadows || !renderer?.shadowMap.enabled) {
        // 无阴影时方向光只决定光向，跟随锚点即可
        dirLight.target.position.copy(anchor);
        dirLight.position.copy(anchor).addScaledVector(SHADOW_LIGHT_DIR, SHADOW_LIGHT_DISTANCE);
        shadowRig.valid = false;
        return;
    }
    // 阴影框半宽：第一视角固定、偏向视线前方；第三跟随随镜头距离；总览放大但设上限
    const raw = cameraMode === CAMERA_MODES.FIRST_PERSON ? 110
        : cameraMode === CAMERA_MODES.THIRD_PERSON ? THREE.MathUtils.clamp(orbitDistance * 1.8, 80, 220)
            : THREE.MathUtils.clamp(orbitDistance * 1.2, 120, 420);
    const span = Math.pow(1.25, Math.round(Math.log(raw) / Math.log(1.25)));
    _shadowCenter.copy(anchor);
    if (cameraMode === CAMERA_MODES.FIRST_PERSON) {
        camera.getWorldDirection(_shadowAhead);
        _shadowAhead.z = 0;
        if (_shadowAhead.lengthSq() > 1e-6) _shadowCenter.copy(camera.position).addScaledVector(_shadowAhead.normalize(), span * 0.55);
    }
    const cell = span * 0.25, c = shadowRig.center;
    if (!shadowRig.valid || span !== shadowRig.span || Math.abs(_shadowCenter.x - c.x) > cell
        || Math.abs(_shadowCenter.y - c.y) > cell || Math.abs(_shadowCenter.z - c.z) > cell) {
        _placeShadowCamera(_shadowCenter, span);
    }
    const now = performance.now();
    if (now - (shadowRig.sigAt || 0) >= SHADOW_DYNAMIC_MS) {
        shadowRig.sigAt = now;
        const sig = _shadowCasterSignature();
        if (sig !== shadowRig.casterSig) { shadowRig.casterSig = sig; _requestShadowUpdate(); }
    }
}

function _monitorAutoRenderQuality(now, active) {
    if (!active || document.hidden || requestedRenderQuality !== 'auto' || !mapMesh) {
        qualityMonitor.frames = 0;
        qualityMonitor.sampleStartedAt = 0;
        qualityMonitor.lastFrameAt = 0;
        return;
    }
    // 长帧也必须计入低帧率窗口；切换标签页的间隔由 visibilitychange 重置。
    qualityMonitor.lastFrameAt = now;
    if (now < qualityMonitor.warmupUntil) return;
    if (!qualityMonitor.sampleStartedAt) qualityMonitor.sampleStartedAt = now;
    qualityMonitor.frames += 1;
    const elapsed = now - qualityMonitor.sampleStartedAt;
    if (elapsed < 6000) return;
    const fps = qualityMonitor.frames * 1000 / elapsed;
    let downgrade = null;
    if (activeQualityProfile?.id === 'high' && fps < 31) downgrade = 'balanced';
    else if (activeQualityProfile?.id === 'balanced' && fps < 23) downgrade = 'performance';
    qualityMonitor.frames = 0;
    qualityMonitor.sampleStartedAt = now;
    if (!downgrade) return;
    autoQualityCeiling = downgrade;
    _applyRenderQuality();
    window.showRadarToast?.(`3D 帧率较低，已自动切换到${downgrade === 'balanced' ? '平衡' : '流畅'}画质`);
}

function resize() {
    if (!renderer) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (composer && activeQualityProfile) {
        const dpr = Math.max(0.75, Number(window.devicePixelRatio || 1));
        const postDpr = Math.min(dpr, activeQualityProfile.postPixelRatioCap);
        composer.setPixelRatio(postDpr);
        composer.setSize(w, h);
        if (fxaaPass) {
            fxaaPass.material.uniforms.resolution.value.set(
                1 / Math.max(1, w * postDpr),
                1 / Math.max(1, h * postDpr),
            );
        }
        if (ssaoPass) {
            const scale = activeQualityProfile.ssaoScale || 0.5;
            const ssaoWidth = Math.max(1, Math.ceil(w * postDpr * scale));
            const ssaoHeight = Math.max(1, Math.ceil(h * postDpr * scale));
            ssaoPass.setSize(ssaoWidth, ssaoHeight);
            if (structureEdgePass) {
                structureEdgePass.uniforms.radarEdgeResolution.value.set(ssaoWidth, ssaoHeight);
            }
            _syncSsaoCameraParameters();
        }
    }
}

/* ---------------------------------------------------------------- 观察者与 HUD
   「观察者」= 镜头正在跟随的人（第一/第三跟随），否则是自己。HUD 的距离、敌我和
   贴脸判定都以观察者为准：复盘时切到别人的第一视角，看到的是那个人面对的威胁。 */
let frameViewer = null;
function _resolveViewer(data) {
    const local = data?.local;
    const selfTeam = Number(local?.team) || 0;
    if (cameraMode !== CAMERA_MODES.FREE && followTarget && followTarget.kind !== 'self') {
        const hit = _resolveFollowTargetData(followTarget, data);
        if (hit && Number.isFinite(hit.x) && Number.isFinite(hit.y)) {
            const team = hit.kind === 'mate' ? (selfTeam || Number(hit.team) || 0) : (Number(hit.team) || 0);
            return { x: hit.x, y: hit.y, z: hit.z, key: hit.key, self: false, ai: hit.kind === 'ai', team, selfTeam };
        }
    }
    if (local && Number.isFinite(local.x) && Number.isFinite(local.y)) {
        return { x: local.x, y: local.y, z: local.z, key: '__self', self: true, ai: false, team: selfTeam, selfTeam };
    }
    return null;
}

let hud = null;
const hudItems = [];
let hudCount = 0;
const hudOpt = { foe: true, ray: false, box: false, warn: true, warnD: 150, warnR: 200, warnSz: 100,
    fontScale: 1, alertColor: PALETTE.alert, downColor: PALETTE.down };

function _hudPush(entity, isSelf, viewer, disp, alertD) {
    const src = entity.src;
    if (!entity.root.visible || !src) return;
    const key = isSelf ? '__self' : src.key;
    if (viewer && key === viewer.key) return;              // 观察者本人不画
    if (isSelf ? src.dead : src.alive === false) return;    // 阵亡由 3D 信息卡的暗色表达
    const enemy = _isEnemyOfViewer(viewer, src, isSelf);
    const dist = viewer ? Math.hypot(src.x - viewer.x, src.y - viewer.y) * UE_TO_M : null;
    const stale = !!(src._out_of_range || src.out_of_range || src.spawn_mark);
    // 与 2D 一致的滞回：进入用 alertD，退出用 1.25×alertD，阈值边缘不闪
    const alert = enemy && !stale && alertD > 0 && dist != null
        && dist <= (entity.hudAlert ? alertD * 1.25 : alertD);
    entity.hudAlert = alert;
    const it = hudItems[hudCount] || (hudItems[hudCount] = {});
    hudCount++;
    const pos = entity.root.position;
    it.x = pos.x; it.y = pos.y; it.z = pos.z;
    it.scale = entity.modelScale || 1;
    it.color = entity.identityColor ?? PALETTE.unknown;
    it.enemy = enemy; it.alert = alert; it.ai = src.kind === 'ai';
    it.down = src.status_key === 'down' || src.status_key === 'dying';
    it.spawn = !!src.spawn_mark; it.stale = stale; it.dist = dist;
    it.hp = disp.showHealth !== false && src.maxHp > 0 && Number.isFinite(src.hp)
        ? Math.max(0, Math.min(1, src.hp / src.maxHp)) : null;
    it.far = !it.ai && !entity.sprite?.visible;
    if (it.far) {
        const name = disp.showName !== false ? (isSelf ? '自己' : (src.hero || src.displayName || '')) : '';
        const d = disp.showDistance !== false && dist != null ? Math.round(dist) + 'm' : '';
        it.text = name && d ? name + ' ' + d : name || d;
    } else it.text = '';
}

function _drawHud(now, data) {
    if (!hud) return;
    const disp = window.AppState?.display || {};
    const h = disp.hud || {};
    hudOpt.foe = h.foe !== 0; hudOpt.ray = !!h.ray; hudOpt.box = !!h.box3d;
    hudOpt.warn = !!h.warn3d; hudOpt.warnD = Number(h.warnd) || 0;
    hudOpt.warnR = Number(h.warnr) || 200; hudOpt.warnSz = Number(h.warnsz) || 100;
    hudOpt.fontScale = Number(disp.fontScale) || 1;
    hudOpt.alertColor = PALETTE.alert; hudOpt.downColor = PALETTE.down;
    hudCount = 0;
    if (data) {
        const viewer = frameViewer, alertD = Number(h.alert) || 0;
        for (const e of POOL.players) if (e.root.visible) _hudPush(e, false, viewer, disp, alertD);
        if (selfEntity && data.local) _hudPush(selfEntity, true, viewer, disp, alertD);
        if (disp.showAIs !== false) for (const e of POOL.ais) if (e.root.visible) _hudPush(e, false, viewer, disp, alertD);
    }
    // 点位与雷达：开关、筛选与 2D 同一份偏好（adapter 经 display.hud 透传）
    const viewer = data ? frameViewer : null;
    hudExtra.poiCount = 0;
    if (poiLayer) {
        poiLayer.setLevel(h.poilevel);
        poiLayer.setVisible(h.poiexit !== 0);
        if (h.poiboxoff !== hudBoxOffRaw) { hudBoxOffRaw = h.poiboxoff; hudPoiOpt.boxOff = poiLayer.parseBoxOff(hudBoxOffRaw); }
        hudPoiOpt.exit = h.poiexit !== 0; hudPoiOpt.box = h.poibox !== 0;
        hudPoiOpt.boxD = Number.isFinite(Number(h.poiboxd)) ? Number(h.poiboxd) : 60;
        hudExtra.poiCount = poiLayer.collect(viewer, hudPoiOpt);
        hudExtra.pois = poiLayer.items;
    }
    const rd = hudExtra.radar;
    rd.on = h.radar3d !== 0 && !!viewer;
    if (rd.on) {
        rd.range = Number(h.radarr) || 150;
        rd.x = viewer.x * UE_TO_M; rd.y = -viewer.y * UE_TO_M;
        rd.z = Number.isFinite(viewer.z) ? viewer.z * UE_TO_M : null;
    }
    hud.draw(camera, hudItems, hudCount, hudOpt, now, hudExtra);
}

/* 点位图层随 HUD 一起创建：此时模块已求值完毕，可以安全地向 gateway 注册装图回调。 */
let poiLayer = null, hudBoxOffRaw = null;
const hudPoiOpt = { exit: true, box: true, boxD: 60, boxOff: null };
const hudExtra = { pois: null, poiCount: 0, radar: { on: false, range: 150, x: 0, y: 0, z: null } };
function _ensurePoiLayer() {
    if (poiLayer) return;
    poiLayer = createPoiLayer();
    gateway.onMapInstalled((name, mesh) => poiLayer.install(name, mesh, scene));
    if (mapMesh && currentMapName) poiLayer.install(currentMapName, mapMesh, scene);
}

/* 侧边血条是 XY 平面网格：在 Z 朝上的世界里它是平躺的，又关了深度测试，
   看上去是一条贯穿人物的黑线。每帧把它竖起来、转向镜头，并放在镜头视角下人物的左侧。 */
const _hpWorldQ = new THREE.Quaternion(), _hpRootInv = new THREE.Quaternion();
const _hpEuler = new THREE.Euler(0, 0, 0, 'ZXY'), _hpOffset = new THREE.Vector3();
function _billboardHpBar(entity, camPos) {
    const g = entity?.hpBar?.group;
    if (!g || !g.visible || !entity.root.visible) return;
    const p = entity.root.position;
    const theta = Math.atan2(camPos.y - p.y, camPos.x - p.x);   // 人物 → 镜头的水平方向
    _hpEuler.set(Math.PI / 2, 0, theta + Math.PI / 2, 'ZXY');   // 先竖起（长边朝上），再让正面朝镜头
    _hpWorldQ.setFromEuler(_hpEuler);
    _hpRootInv.copy(entity.root.quaternion).invert();           // 根节点只有绕 Z 的朝向
    g.quaternion.copy(_hpRootInv).multiply(_hpWorldQ);
    const off = 0.55 * (entity.modelScale || 1);
    g.position.copy(_hpOffset.set(Math.sin(theta) * off, -Math.cos(theta) * off, 0).applyQuaternion(_hpRootInv));
}

let gatewayLastSlow = 0, gatewaySlowData = null, gatewayFrameAt=0, gatewayFps=0, gatewayFrames=0, gatewayFpsAt=0;
function tick() {
    const active = window.viewMode === '3d';
    const frameAt=performance.now(), cap=Number(window.AppState?.display?.fpscap)||0;
    if (!active) {
        // 2D 模式下完全不做 3D 工作；以前仍每帧更新相机、跟随、光照与 shader uniform
        gatewayFps=0;gatewayFrames=0;gatewayFpsAt=frameAt;
        hud?.clear();
        return;
    }
    if(cap>0 && frameAt-gatewayFrameAt<1000/cap-0.5)return;
    gatewayFrameAt=frameAt;
    gatewayFrames++;if(frameAt-gatewayFpsAt>=1000){gatewayFps=gatewayFrames*1000/(frameAt-gatewayFpsAt);gatewayFrames=0;gatewayFpsAt=frameAt;}
    const data = window.AppState?.gameData;
    const frameCount = window.AppState?.frameCount ?? 0;
    const now = frameAt;
    frameViewer = data ? _resolveViewer(data) : null;
    if (data) {
        // Human replay poses are presented each animation frame by the adapter.
        const disp = window.AppState?.display || {};
        updatePlayers(disp.showPlayers === false ? [] : data.players);
        if (now - gatewayLastSlow >= 100 || gatewaySlowData !== data.slowRevision) {
            updateBosses(disp.showBosses === false ? [] : data.bosses);
            updateAIs(disp.showAIs === false ? [] : data.ais);
            updateItems(disp.showItems === false ? [] : data.items);
            gatewayLastSlow = now; gatewaySlowData = data.slowRevision;
        }
        /* v700x: 本人 (data.local) 单独更新, 相机默认跟随它 */
        updateSelf(data.local);
        /* thirdPerson/firstPerson 没有目标时自动回到房主；free 永不自动跟随。 */
        if (data.local && cameraMode !== CAMERA_MODES.FREE && !followTarget) {
            _setFollowTarget({ kind: 'self', name: '__self__' });
            console.log('[Radar3D] 默认跟随本人');
        }
        _hideFirstPersonFollowedEntity();
        // 地图切换只在 frame 变时判 (避免每帧字符串比较)
        if (frameCount !== lastFrameCount) {
            lastFrameCount = frameCount;
            if (data.map && data.map.name && data.map.name !== currentMapName) {
                loadMap(data.map.name);
            }
        }
    }
    // Finish pending controls updates before applying the authoritative first-person pose.
    if (cameraMode === CAMERA_MODES.FIRST_PERSON && followTarget) {
        controls.update();
        updateFollow(true);
    } else {
        updateFollow(false);
        // 相机始终更新 (即使切走了也保持状态)
        controls.update();
    }
    _updateIndoorClarityUniforms();
    _updateLightingRig();
    _updateMapShaderViewUniforms();
    if (activeQualityProfile?.ssao) _syncSsaoCameraParameters();
    if (active) {
        /* 人物标签的屏幕高度按“角色到自身的距离”衰减：近处清晰，远处小而不挡景。 */
        const canvasH = renderer.domElement.clientHeight || 900;
        const fovTan = Math.tan(camera.fov * 0.5 * Math.PI / 180);
        const camPos = camera.position;
        const scaleSprite = (sp) => {
            if (!sp || !sp.parent || !sp.parent.visible || !sp.visible) return;
            const baseW = sp.userData.baseW || 2.0;
            const baseH = sp.userData.baseH || 0.625;
            const wp = sp.parent.position;
            const dx = camPos.x - wp.x, dy = camPos.y - wp.y, dz = camPos.z - wp.z;
            const dist = Math.max(1, Math.sqrt(dx*dx + dy*dy + dz*dz));
            const range = Math.max(0, Number(sp.userData.rangeM) || 0);
            const labelPx = THREE.MathUtils.clamp(58 - range * 0.10, 18, 58)
                * (Number(window.AppState?.display?.fontScale) || 1);
            sp.userData.screenHeightPx = labelPx;
            const worldH = labelPx * 2 * dist * fovTan / canvasH;
            const s = Math.max(0.4, Math.min(30, worldH / baseH));
            sp.scale.set(baseW * s, baseH * s, 1);
        };
        for (const e of POOL.players) { scaleSprite(e.sprite); _billboardHpBar(e, camPos); }
        for (const e of POOL.bosses)  { scaleSprite(e.sprite); _billboardHpBar(e, camPos); }
        for (const e of POOL.ais)     { scaleSprite(e.sprite); _billboardHpBar(e, camPos); }
        /* v700x3: 物品名字 sprite 不走 scaleSprite, 保留世界固定尺寸(1.6m 宽),
           自然透视缩放 — 远了小近了大, 一堆物品不会挤成一片. */
        if (selfEntity) { scaleSprite(selfEntity.sprite); _billboardHpBar(selfEntity, camPos); }

        const usePostProcessing = composer && (
            ssaoPass?.enabled || bloomPass?.enabled ||
            structureEdgePass?.enabled || fxaaPass?.enabled
        );
        if (skyDome?.visible) skyDome.position.copy(camera.position);
        const shadowPass = renderer.shadowMap.enabled && renderer.shadowMap.needsUpdate;
        if (usePostProcessing) composer.render();
        else renderer.render(scene, camera);
        // 诊断：阴影图重画频率（r161 的 renderer.info 在阴影 pass 之后才清零，只反映主 pass；
        // 阴影 pass 的量见 stat().mapCull.shadow）
        if (shadowPass) { shadowRig.lastAt = frameAt; shadowRig.updates++; }
        if (frameAt - shadowRig.rateAt >= 2000) {
            shadowRig.rate = shadowRig.updates * 1000 / Math.max(1, frameAt - shadowRig.rateAt);
            shadowRig.updates = 0; shadowRig.rateAt = frameAt;
        }
        // HUD 必须在 render 之后：此时相机 matrixWorldInverse 才是本帧的
        _drawHud(frameAt, data);
        drawMinimap();
        _monitorAutoRenderQuality(performance.now(), active);
    }
}

// ============================================================================
//  启动
// ============================================================================

/* 地图装载完成的扩展点：POI、底图纹理等附加图层在这里拿到 mapMesh 再构建，
   不必改动装图流程本身。监听器异常只记录，不影响地图显示。 */
const mapInstalledListeners = [];
function _notifyMapInstalled(name) {
    for (const fn of mapInstalledListeners) {
        try { fn(name, mapMesh); } catch (error) { console.error('[Radar3D] 地图装载监听器失败', error); }
    }
}

/* ---------------------------------------------------------------- 官方底图投影 */
function _mapTexZoom() {
    const profile = activeQualityProfile || RENDER_QUALITY_PROFILES[_resolvedRenderQualityId()];
    return profile.id === 'performance' ? 3 : 4;
}

function _resetMapTexture(key) {
    mapTex.abort?.abort();
    mapTex.abort = null;
    for (const entry of mapTex.entries.values()) entry.texture?.dispose();
    mapTex.entries.clear();
    mapTex.pending.clear();
    mapTex.key = key;
}

// 优先用当前画质档的缩放级；还没下载完时先用已有的另一级
function _currentMapTexEntry() {
    const exact = mapTex.entries.get(_mapTexZoom());
    if (exact?.texture) return exact;
    for (const entry of mapTex.entries.values()) if (entry.texture) return entry;
    return null;
}

function _applyMapTextureUniforms() {
    const entry = mapTex.enabled ? _currentMapTexEntry() : null;
    const style = _mapStyle();
    const tex = style.mapTex || { strength: 0, tint: 0, wall: 0 };
    for (const material of _getRadarMapMaterials()) {
        const u = material?.userData?.radarUniforms;
        if (!u?.radarMapTex) continue;
        if (entry) {
            u.radarMapTex.value = entry.texture;
            u.radarMapUvMatrix.value.copy(entry.matrix);
            u.radarMapStrength.value = tex.strength;
        } else {
            u.radarMapTex.value = _radarBlankMapTexture();
            u.radarMapStrength.value = 0;
        }
        u.radarMapTint.value = tex.tint;
        u.radarMapWallTint.value = tex.wall;
        u.radarAoStrength.value = style.ao ?? 0.85;
    }
}

/* 应用当前纹理；缺当前缩放级时后台拼瓦片（同一图同一级只下载一次，失败也记下不重试）。 */
function _syncMapTexture() {
    _applyMapTextureUniforms();
    if (!mapTex.enabled || !mapTex.key || !mapBounds || !renderer || !mapMesh) return;
    const zoom = _mapTexZoom();
    if (mapTex.entries.has(zoom) || mapTex.pending.has(zoom)) return;
    const key = mapTex.key;
    if (!mapTex.abort) mapTex.abort = new AbortController();
    const signal = mapTex.abort.signal;
    const bounds = { minX: mapBounds.min.x, minY: mapBounds.min.y, maxX: mapBounds.max.x, maxY: mapBounds.max.y };
    const job = buildMapTexture(key, bounds, {
        zoom, signal, concurrency: 6,
        maxSize: Math.min(4096, renderer.capabilities.maxTextureSize || 4096),
        anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy?.() || 1),
    }).then(built => {
        if (signal.aborted || mapTex.key !== key) { built?.texture?.dispose(); return; }
        mapTex.entries.set(zoom, built?.texture ? built : { texture: null });
        if (built?.texture) console.log(`[Radar3D] 底图投影 ${key} z${built.zoom} ${built.size.join('×')} · 瓦片 ${built.loaded}/${built.tiles} · ${built.ms}ms`);
        else console.warn(`[Radar3D] 底图投影 ${key}：没有可用瓦片，保持原色`);
        _applyMapTextureUniforms();
    }).catch(error => {
        if (error?.name === 'AbortError' || mapTex.key !== key) return;
        mapTex.entries.set(zoom, { texture: null });
        console.warn('[Radar3D] 底图投影失败，保持原色:', error);
    }).finally(() => { if (mapTex.pending.get(zoom) === job) mapTex.pending.delete(zoom); });
    mapTex.pending.set(zoom, job);
}

/* ---------------------------------------------------------------- 地图装载（分块） */
function _disposeMapGroup(group) {
    if (!group) return;
    scene.remove(group);
    for (const chunk of group.children) chunk.geometry?.dispose();
    _disposeRadarMapMaterials(group);
}

/* 接管传入几何：缓冲区会转移到切块 Worker，调用方之后不得再读 geo 的数组。
   包围盒同步算出（fit 立即可用），分块完成后才替换旧地图并通知 onMapInstalled。
   返回 Promise（装好时 resolve）；失败只记录与提示，不抛出。 */
function gatewayInstallGeometry(name, geo) {
    const seq = ++mapInstallSeq;
    const position = geo.getAttribute('position');
    const nTri = (geo.index ? geo.index.count : position.count) / 3;
    currentMapTriangleCount = nTri;
    geo.computeBoundingBox();
    mapBounds = geo.boundingBox.clone();
    const heightRange = _sampleMapHeightRange(position.array);
    // 除 position / normal 外的逐顶点属性（如 bake）原样随块携带
    const extras = [];
    for (const [attrName, attr] of Object.entries(geo.attributes)) {
        if (attrName === 'position' || attrName === 'normal') continue;
        if (attr.isInterleavedBufferAttribute || !attr.array?.buffer) {
            console.warn(`[Radar3D] 地图属性 ${attrName} 为交错/非类型数组，分块时丢弃`);
            continue;
        }
        extras.push({ name: attrName, array: attr.array, itemSize: attr.itemSize, normalized: !!attr.normalized });
    }
    const meta = extras.map(a => ({ name: a.name, itemSize: a.itemSize, normalized: a.normalized }));
    if (mapTex.key !== name) _resetMapTexture(name);
    const t0 = performance.now();
    return buildMapChunksAsync(position.array, geo.index?.array || null, extras, { targetTriangles: 20000, maxChunks: 300 })
        .then(result => {
            if (seq !== mapInstallSeq) return;
            _installMapChunks(name, result, heightRange, meta, nTri);
            console.log(`[Radar3D] 地图 ${name}：${nTri} 面 → ${result.stats.chunks} 块（Uint16 ${result.stats.uint16Chunks}），`
                + `切块 ${result.stats.ms}ms，装图共 ${Math.round(performance.now() - t0)}ms`);
        })
        .catch(error => {
            if (seq !== mapInstallSeq) return;
            console.error('[Radar3D] 地图分块失败', error);
            window.showRadarToast?.('3D 地图构建失败：' + (error?.message || error));
        });
}

function _installMapChunks(name, result, heightRange, meta, nTri) {
    if (mapMesh) { _disposeMapGroup(mapMesh); mapMesh = null; }
    if (mapMeshWire) { scene.remove(mapMeshWire); mapMeshWire.geometry.dispose(); mapMeshWire.material.dispose(); mapMeshWire = null; }
    const hasBake = meta.some(a => a.name === 'bake' && a.itemSize === 2);
    const plainMaterial = _createRadarMapMaterial(heightRange.low, heightRange.high, false, hasBake);
    const wallMaterial = _createRadarMapMaterial(heightRange.low, heightRange.high, false, hasBake);
    wallMaterial.transparent = true; wallMaterial.opacity = 1 - gatewaySurfacePrefs.walltrans / 100; wallMaterial.depthWrite = false;
    wallMaterial.forceSinglePass = true;
    const materials = [plainMaterial, wallMaterial];
    // 地图材质是 flatShading，不需要真实顶点法线；但阴影 normalBias 会 normalize 法线，缺属性时
    // 是零向量 → NaN，地图收不到阴影。所以给常量朝上的 8 位法线，各块共用同一段内存。
    let maxVerts = 0;
    for (const c of result.chunks) maxVerts = Math.max(maxVerts, c.position.length / 3);
    const upNormal = new Int8Array(maxVerts * 3);
    for (let i = 2; i < upNormal.length; i += 3) upNormal[i] = 127;
    const group = new THREE.Group();
    group.name = 'radar-map';
    let floor = 0, wall = 0;
    for (const c of result.chunks) {
        const g = new THREE.BufferGeometry();
        const count = c.position.length / 3;
        g.setAttribute('position', new THREE.BufferAttribute(c.position, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(upNormal.subarray(0, count * 3), 3, true));
        for (const a of meta) g.setAttribute(a.name, new THREE.BufferAttribute(c.attributes[a.name], a.itemSize, a.normalized));
        g.setIndex(new THREE.BufferAttribute(c.index, 1));
        g.addGroup(0, c.floorCount, 0);
        g.addGroup(c.floorCount, c.wallCount, 1);
        g.boundingBox = new THREE.Box3(new THREE.Vector3(c.box[0], c.box[1], c.box[2]), new THREE.Vector3(c.box[3], c.box[4], c.box[5]));
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(c.sphere[0], c.sphere[1], c.sphere[2]), c.sphere[3]);
        const mesh = new THREE.Mesh(g, materials);
        mesh.matrixAutoUpdate = false;
        mesh.userData.radarMapChunk = true;
        group.add(mesh);
        floor += c.floorCount / 3; wall += c.wallCount / 3;
    }
    group.matrixAutoUpdate = false;
    group.updateMatrixWorld(true);
    mapMesh = group;
    mapMesh.userData.radarMaterials = { plain: materials };
    mapMesh.userData.activeMaterial = materials;
    mapMesh.userData.gatewayTransparentWalls = true;
    mapMesh.userData.surfaceCounts = { floor, wall };
    mapMesh.userData.chunkStats = result.stats;
    mapMesh.userData.hasBake = hasBake;
    applyGatewaySurfaceOpacity();
    scene.add(mapMesh);
    // 占位网格与半透明地面固定在 z=0，而地形高度常是负数：有地图时它们会悬在
    // 地面上空，第一视角抬头能看到网格线，还白白多一层全屏透明叠加。
    if (gridHelper) gridHelper.visible = false;
    if (groundMesh) groundMesh.visible = false;
    const bb = mapBounds;
    const rx = bb.max.x - bb.min.x, ry = bb.max.y - bb.min.y, rz = bb.max.z - bb.min.z;
    const diagonal = Math.hypot(rx, ry, rz);
    mapFarPlane = THREE.MathUtils.clamp(diagonal * 1.6 + 1000, 6000, 60000);
    _applyViewModeRendering();
    if (requestedRenderQuality === 'auto') {
        const nextCeiling = nTri > 700000 ? 'balanced' : null;
        if (autoQualityCeiling !== nextCeiling) {
            autoQualityCeiling = nextCeiling;
            _applyRenderQuality();
            if (nextCeiling) {
                window.showRadarToast?.('当前地图几何较复杂，自动使用平衡画质；可手动选择高画质');
            }
        }
    }
    _applyQualityToSceneObjects(activeQualityProfile || RENDER_QUALITY_PROFILES[_resolvedRenderQualityId()]);
    _applyMapMaterialQuality(activeQualityProfile || RENDER_QUALITY_PROFILES[_resolvedRenderQualityId()]);
    _applyMapStyle();
    _updateIndoorClarityUniforms();
    _syncSsaoCameraParameters();
    qualityMonitor.frames = 0;
    qualityMonitor.sampleStartedAt = 0;
    qualityMonitor.lastFrameAt = 0;
    qualityMonitor.warmupUntil = performance.now() + 8000;
    _syncMapTexture();
    _requestShadowUpdate();
    _notifyMapInstalled(name);
    // 地图异步完成只更新场景，不改任何镜头模式或用户当前视角。
    console.log(`[Radar3D] 地图 ${name} 已加入场景，高度色域 ${heightRange.low.toFixed(1)}~${heightRange.high.toFixed(1)}m`);
}

export const gateway = {
    inspect(){
        const entities=[];
        for(const [kind,pool] of Object.entries(POOL))for(const e of pool)if(e.root.visible)
            entities.push({kind,key:e.root.userData.entityKey,position:e.root.position.toArray(),yaw:e.root.rotation.z,label:e.sprite?.userData.key,
                labelRange:e.sprite?.userData.rangeM,labelShowsDistance:e.sprite?.userData.showsDistance,labelScreenHeight:e.sprite?.userData.screenHeightPx,labelScale:e.sprite?.scale.toArray(),labelPosition:e.sprite?.position.toArray(),
                model:e.modelStyle,customVisible:!!e.customModel?.root.visible,occludedModelVisible:!!e.customOccludedModel?.root.visible,
                operatorAsset:e.operatorAssetKey,characterDetail:e.characterDetail,operator:e.customModel?.inspect?.(),
                visibleColor:e.modelVisibleColor,occludedColor:e.modelOccludedColor,modelFootZ:e.modelFootZ,modelRenderedFootZ:e.modelRenderedFootZ,
                headingStyle:e.headingStyle,headingAnchor:e.headingAnchor,
                headingVisible:!!e.headings?.[e.headingStyle]?.visible.visible,
                headingOccluded:!!e.headings?.[e.headingStyle]?.occluded.visible,
                headingZ:e.headings?.[e.headingStyle]?.visible.position.z});
        const direction=new THREE.Vector3();camera?.getWorldDirection(direction);
        return {entities,self:selfEntity?.root.position.toArray(),camera:{mode:cameraMode,fov:camera?.fov,position:camera?.position.toArray(),direction:direction.toArray()},
            surfaces:{floorOpacity:_getRadarMapMaterials()[0]?.opacity,wallTransparency:gatewaySurfacePrefs.walltrans},
            walls:{cutout:indoorClarityActive,opacity:_getRadarMapMaterials()[1]?.opacity,depthWrite:_getRadarMapMaterials()[1]?.depthWrite,counts:mapMesh?.userData.surfaceCounts}};
    },
    init, resize, installGeometry: gatewayInstallGeometry, setPalette,
    onMapInstalled(fn) { if (typeof fn === 'function') mapInstalledListeners.push(fn); },
    setHud(canvas) { hud = canvas ? createHud(canvas) : null; _ensurePoiLayer(); },
    follow(kind,name){
        if(followTarget?.kind===kind && followTarget?.name===name && cameraMode!==CAMERA_MODES.FREE)return;
        _setFollowTarget({kind,name});
    },
    preferences(p){
        if (MAP_STYLES[p.mapstyle3d] && p.mapstyle3d !== mapStyleId) {
            mapStyleId = p.mapstyle3d;
            _applyMapStyle();
            _applyMapViewStyle();
        }
        for (const key of ['walltrans','floortrans','followwalltrans']) {
            if (Number.isFinite(p[key])) gatewaySurfacePrefs[key] = THREE.MathUtils.clamp(p[key], 0, 100);
        }
        applyGatewaySurfaceOpacity();
        if(camera && Number.isFinite(p.fov)){camera.fov=p.fov;camera.updateProjectionMatrix();}
        if (p.maptex3d !== undefined && (Number(p.maptex3d) !== 0) !== mapTex.enabled) {
            mapTex.enabled = Number(p.maptex3d) !== 0;
            _syncMapTexture();
        }
        if (['auto', 'on', 'off'].includes(p.shadow3d) && p.shadow3d !== shadowPref) {
            shadowPref = p.shadow3d;
            if (renderer) _applyRenderQuality();
        }
    },
    fit: fitToAll, top() { window.radar3dSetCameraMode('free');
        const target = controls.target; const distance = camera.position.distanceTo(target);
        camera.position.set(target.x, target.y - 0.01, target.z + Math.max(80, distance)); controls.update(); },
    stat() { return { fps: gatewayFps, tris: currentMapTriangleCount, players: POOL.players.filter(e => e.root.visible).length,
        playerKeys: POOL.players.filter(e => e.root.visible).map(e => e.root.userData.entityKey),
        humanPlayers: POOL.players.filter(e=>e.root.visible && !window.AppState?.gameData?.players.find(p=>p.key===e.root.userData.entityKey)?.is_bot).length,
        mapBounds: mapBounds?.clone(), renderCalls: renderer?.info.render.calls || 0,
        triangles: renderer?.info.render.triangles || 0,
        mapChunks: mapMesh?.userData.chunkStats || null, mapBake: !!mapMesh?.userData.hasBake,
        mapCull: { camera: _mapCullStats(camera), shadow: renderer?.shadowMap.enabled ? _mapCullStats(dirLight?.shadow.camera) : null },
        mapTexture: { enabled: mapTex.enabled, key: mapTex.key, zooms: [...mapTex.entries.entries()].map(([z, e]) => ({ zoom: z, ok: !!e.texture, size: e.size, loaded: e.loaded, tiles: e.tiles })) },
        shadow: { enabled: !!renderer?.shadowMap.enabled, pref: shadowPref, span: shadowRig.span, mapSize: dirLight?.shadow.mapSize.x || 0,
            updatesPerSec: Math.round(shadowRig.rate * 10) / 10 } }; }
};
