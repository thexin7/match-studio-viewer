# Match Studio Viewer

浏览器端**战术比赛回放查看器**，适用于撤离类 FPS。在 2D 态势地图上展示会话遥测，可选 Three.js 3D 场景、干员列表、物资图层与回放控制条。

面向训练室复盘、导播叠加层、Demo 分析等场景。

## 功能

- **2D 态势地图** — Leaflet 瓦片、平滑标记、队伍色、距离环
- **3D 场景**（需地形 GLB）— 自由 / 俯视 / 跟随相机
- **干员台** — 按队伍与威胁距离分组
- **物资与容器** — 可过滤的地图图层与品质着色
- **回放模式** — 播放、暂停、跳转、倍速
- **移动端** — 可折叠抽屉、大触控区域

## 快速开始

在任意目录克隆本仓库即可：

```bash
git clone https://github.com/thexin7/match-studio-viewer.git
cd match-studio-viewer
npm run dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。内置开发服务器用 `dev/fixtures/` 模拟全部 `/api/*`，**无需任何外部服务**。

### 3D 地形模型

6 张地图的白模 GLB（约 380 MB）位于 `m3d/`，与 `manifest.json` 配套。文件在 `.gitignore` 中，完整开发环境需本地具备这些资产；无 GLB 时 2D 仍可用。

地图目录包含零号大坝、长弓溪谷、航天基地、巴克什、潮汐监狱和 AZ3。功能台的「切换地图」及移动端底栏的「地图」入口共用同一目录，切换时同时更新 2D 底图、3D 地形和点位。

六张地图均有目录点位；目前只有零号大坝另有按难度划分的点位数据，其他地图使用各自目录中的撤离点和容器，不套用大坝难度数据。

多地图验证（需要对应地形资产，`--url` 指向待测服务）：

```bash
node --test dev/maps.test.mjs dev/poll.test.mjs dev/quality.test.mjs dev/smoke.test.mjs
node dev/poi-check.mjs
node dev/smoke.mjs --url http://127.0.0.1:5173/ --map az3 --quality perf --size 390x844
```

### 路由器部署的轻量地形

模型处理只在开发机执行。路由器继续提供静态文件，不需要 Node.js、WASM 简化器或新的服务。

```bash
npm ci
node tools/terrain-pack/validate.mjs
node tools/terrain-pack/light.mjs --all
node --test dev/terrain-light.test.mjs
```

`validate.mjs` 使用 Khronos glTF-Validator，发现错误时退出码为 1。现有原始 GLB 的 int16 POSITION 存在 4 字节对齐规范问题；报告不会静默忽略这些错误。该校验不判断地形拼接的视觉质量。

`light.mjs` 使用固定版本 meshoptimizer 离线生成 `packed_light`：锁定拓扑边界，以 50% 面数为目标、0.05 米算法误差为上限，同时考虑 AO/天空可见度属性。保留的顶点坐标不移动，烘焙数据随顶点重排；每个产物都用浏览器解码器回读核对。受边界和属性约束，实际面数不保证达到 50%。

自动、流畅、平衡档优先使用版本匹配的轻量包；高清档使用完整包。轻量包下载失败会依次尝试完整 TPK 和原始 GLB。更换 GLB 或重新烘焙后，需要重新生成轻量包。原始 GLB、完整包均保留；轻量处理不会自动修复原地形中的拼接接缝。

## 架构

```
浏览器 UI  ──轮询──▶  GET /api/state
              │        GET /api/status
              │        GET /api/map
              └──静态──▶  index.html, ui/, m3d/, vendor/, avatars/
```

本仓库**只包含浏览器客户端**。任何在同源实现 `/api/*` 契约的数据源都可以驱动此 UI。

## API 概览

| 端点 | 作用 |
|------|------|
| `GET /api/state` | 当前比赛快照（实体、主视角、回放游标） |
| `GET /api/status` | 会话 / 回放元数据 |
| `GET /api/map` | 地图目录（边界、旋转、瓦片 URL） |
| `GET /api/ctrl?pause=&seek=&speed=` | 回放控制（仅回放模式） |

完整契约与重构说明见 [AGENTS.md](./AGENTS.md)。

## 技术栈

- 原生 JavaScript（ES modules + import map）
- [Leaflet](https://leafletjs.com/) — 2D 地图
- [Three.js](https://threejs.org/) — 3D 场景
- 开发无需 bundler

## 许可证

MIT
