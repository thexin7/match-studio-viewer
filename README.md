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
