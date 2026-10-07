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

## 导播控制台与透明叠加层

打开 `/studio` 使用 G 风格的导播控制台。原查看器 `/` 保留地图主界面，并提供控制台入口。

- 控制台支持观察对象、最近对手、2D / 3D 和相机模式、已有显示设置及回放控制。
- `/overlay?transparent=1` 是 OBS 浏览器源地址；`transparent=0` 显示检查透明区域的棋盘格。
- 角落、底栏、全屏地图使用 1920×1080；竖屏使用 1080×1920。切换横竖屏后，需要在 OBS 浏览器源属性中修改宽高。
- `/overlay/status`、`/overlay/alert`、`/overlay/radar`、`/overlay/threats`、`/overlay/observer`、`/overlay/ticker`、`/overlay/minimap` 可分别作为独立组件源。控制台可复制地址，并显示所需尺寸。
- 地址省略 `layout` 时跟随控制台；也可通过 `layout=corner|bar|vertical|map` 固定某个源的布局。

页面只显示接口中已有的数据。距离按 UE 厘米换算；方位相对于观察对象的朝向，缺少朝向时显示未知。附近对手按已有队伍信息区分；观察对象消失或数据断开后清空旧信息。接近提醒来自连续快照中的距离变化，回放跳转会重置提醒历史。人数表示已识别单位，不代表全场存活总人数。

本版没有 OBS 场景遥控、录制高光、后台全局热键、击杀播报和墙后判定。热键仅在控制台获得焦点时生效，输入控件保留原有按键行为。提示音需先在控制台手动开启。

宿主需实现 `GET/HEAD/POST /api/studio`：GET 返回带 `revision` 的共享控制状态和 `has3d` 能力；POST 提交 `revision` 与要变更的字段，版本冲突返回 409，无效字段返回 400。`prefs` 按字段合并。浏览器串行提交，并在一次版本冲突后读取新状态重试。设置保存在宿主当前进程会话中，重启宿主后重置；原查看器的本地偏好仍保留。不同浏览器/OBS 配置可共用控制状态，嵌入预览不会覆盖普通查看器的本地偏好。

独立开发服务器提供同样的共享控制接口。浏览器联调检查需要包含可用人物及附近对手的回放/样例数据：

```bash
node --test dev/studio.test.mjs dev/studio-api.test.mjs dev/maps.test.mjs dev/poll.test.mjs dev/quality.test.mjs dev/smoke.test.mjs
node dev/studio-smoke.mjs http://127.0.0.1:5173
```

设计依据：[Figma G · OBS 叠加层](https://www.figma.com/design/LINb0twz3q3Ajdc7ZUG2C3?node-id=36-655)。实际采用 G3 的面板/控件视觉、G1 的横屏安全区和 G4 的竖屏布局；按现有数据能力删减功能。导出图标保存在 `ui/studio/assets/`，不依赖临时 Figma URL。

## 数据流

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
