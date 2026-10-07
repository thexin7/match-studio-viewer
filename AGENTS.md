# Match Studio 查看器 — Agent 指南

> **范围：** 本仓库是**独立的浏览器 UI 项目**。开发、测试、交付所需的一切都在本仓库内完成。只依赖本文档描述的 HTTP API 与 `dev/fixtures/` 样例数据，**不要假设存在其它仓库或服务端实现**。

## 项目是什么

**Match Studio** 是一款**战术比赛回放查看器**，面向现代撤离类 FPS。定位类似 **电竞导播叠加层**、**训练室地图回放** 或 **Demo 分析工具**。

通过 HTTP 拉取 JSON 快照并渲染：

- **2D 态势地图**（Leaflet 瓦片 + 实体标记）
- 可选 **3D 场景**（Three.js + 地形 GLB，需资产文件）
- **干员侧栏**（按队伍 / 威胁分组）
- **物资与容器图层**
- **回放控制**（播放 / 暂停 / 跳转 / 倍速，回放模式时显示）

UI **轮询同源 REST 接口**，不直连游戏服务器。

## 目录结构

```
.
├── index.html              # 壳层：布局、内联样式（约 900 行）、主逻辑（约 2000 行）
├── map_catalog.json        # 地图元数据（边界、缩放、POI、瓦片 URL）
├── ui/
│   ├── dock.js             # 设置面板 Tab 布局
│   ├── shubao.css          # 主题覆盖
│   └── icons/
├── m3d/
│   ├── manifest.json       # 各地形 GLB 元数据（rev、bytes、place…）
│   ├── *.glb               # 地形白模（gitignore，约 380 MB，本地必备）
│   ├── r3d.js              # 旧 3D 引擎；当前只复用其中的 parseGLB
│   ├── korr-adapter.js     # 快照 → 3D 桥接 + 回放插值 + GLB 流式加载
│   ├── korr-renderer.js    # 当前 3D 引擎：地形、地图风格、相机模式、人物网格
│   ├── korr-hud.js         # 3D 战术 HUD：敌人标识、远距名牌、方框、连线、屏外预警箭头
│   ├── gateway-pose.js     # 姿态 / 瞄准展示（历史文件名，勿改引用）
│   └── character-models.js
├── avatars/                # 干员头像 PNG（文件名 = 干员代号）
├── vendor/                 # 内嵌 Leaflet + Three.js（除升级外勿改）
├── dev/
│   ├── server.mjs          # 本地静态服务 + 样例 API（人物按确定性轨迹移动、回放循环）
│   ├── smoke.mjs           # 无头 Chrome 冒烟 + 性能采样（2D / 3D 跟随 / 第一视角截图）
│   └── fixtures/           # 样例 state / status JSON
└── resources/              # 可选物品图标（运行时由外部目录提供）
```

## 数据流

1. 轮询 `GET /api/state`（实时约 20 Hz；回放暂停/跳转时走回放时钟）。
2. 轮询 `GET /api/status` 获取会话 / 回放元数据。
3. 启动时 `GET /api/map` 返回地图目录（边界、旋转、默认地图 key）。
4. 3D 地形从同源静态路径 `/m3d/<file>.glb?v=<rev>` 加载（见 `manifest.json`）。
5. 用户偏好存于 `localStorage`，前缀 `nr2_<key>`（遗留命名，迁移时需谨慎）。

## API 契约（不可破坏）

将 `/api/*` 视为**不透明契约**：UI 只依赖下列路径与 JSON 形状，不关心由谁实现。

### `GET /api/state`

| 字段 | 类型 | 含义 |
|------|------|------|
| `self` | `[x,y,z]` cm | 观察者 / 主视角玩家世界坐标 |
| `self_yaw`, `self_aim_yaw` | number | 朝向 / 瞄准（度，UE 约定） |
| `self_name`, `self_hp` | string / object | 主视角身份 |
| `live_active` | bool | `true` = 实时流，`false` = 回放或空闲 |
| `entities` | array | 所有可绘制单位（见下） |
| `flow`, `meta`, `cursor`, `status` | 杂项 | 会话 / 回放状态字段 |

**实体对象**（部分字段 —— 重构时须保留全部现有字段）：

```
key, kind, name, hero, is_bot,
world [x,y,z], rel [dx,dy,dz], yaw,
team, slot, dead, status, status_key,
hp, helmet, vest, helmet_dur, vest_dur,
bp, cr, weapon, curr_weapon, trail,
item_id, grade, price
```

`kind` 枚举：`self | mate | player | ai | box | loot | container | unknown`

### 回放控制

`GET /api/ctrl?pause=1|0&seek=<ms>&speed=<float>` —— 仅在回放模式下有效。

### 其他端点

- `/api/flows`、`/api/select?run=&flow=` —— 多会话选择（诊断 UI）
- 静态资源：`/ui/`、`/vendor/`、`/avatars/`、`/m3d/`、`/resources/`

## UI 布局原则

地图是**唯一主界面**；所有控件悬浮其上，且可收起让位。

| 区域 | 作用 |
|------|------|
| 顶部 **战况岛** | 一眼看剩余对手、倒地、阵亡；展开看详情 |
| 右侧 **干员台** | 按队伍/威胁分组的干员 + 下方物资列表 |
| 左侧 **功能坞** | 设置，纵向 Tab（显示 / 3D / 物资 / 预警） |
| 底部 **回放条** | 回放模式：播放/暂停、跳转、倍速 |
| **视图切换** | 2D 地图 ↔ 3D 场景；相机：自由、俯视、第一跟随、第三跟随 |

移动端（`max-width: 900px`）：侧栏退化为底部抽屉；触控优先的大点击区域。

## 已知前端债务（按优先级）

重构明确欢迎。

### P0 — 结构

1. **`index.html` 巨石**（约 2900 行）：拆为 `ui/styles/`、`ui/app/` 模块、精简壳层。
2. **双 CSS 体系**：内联 `<style>` + `shubao.css` → 单一 `:root` 设计变量 + 单一组件样式表。
3. **无构建步骤**：原生 ES module + import map；非必要勿上 webpack。

### P1 — 可维护性

4. 内联游戏表（`BAG_LV`、`RIG_LV`、`BAG_CAP` 等）→ `/resources/catalog.json`。
5. 2D 内联 vs 3D 模块化边界不一致 —— 应对齐。
6. 注释遗留措辞 —— 用 *查看器 / 态势图 / 回放 UI*；勿盲目重命名 DOM id 或 API 字段。

### P2 — 打磨

7. 无障碍：dock Tab 已有 ARIA；扩展到干员行、视图切换、回放条。
8. 主题系统：明暗已有但样式分散 —— 集中管理。

## 坐标与渲染

- 世界坐标为 **UE 厘米**。地图投影用 `MAP_INFO`（center、rotate、width/height、`bj` 比例）。
- 3D：`x = ue_x/100`，高度 = `ue_z/100`，深度 = `ue_y/100`。
- 朝向：UE 风格 —— +X 为 0°，向 +Y 增大；3D 绕 **−Y** 轴旋转。
- 2D 标记在快照间做平滑插值（`SM_TAU`）；3D 回放插值在 `gateway-pose.js` 的 `PosePresenter`，相机状态机在 `korr-renderer.js`（`updateFollow`）。
- 勿在未测卡顿的情况下去掉池化 Map（`_rc`、`opRows`、`lootRows`、`infos`）。
- 2D 每个干员只挂两个 Leaflet marker：主体标记 + 信息堆（`updInfo`：敌人标识 / 信息条 / 装备 / 血条），偏移用 CSS `--mks` 计算，不要回到逐条 marker + 离屏测宽。
- 色板只有一份：`index.html` 的 `TEAM_COLORS` / `C_*`，通过 `create({palette})` 下发给 3D。不要在 3D 里另起色板。
- 3D 敌我、距离、贴脸都以「观察者」为准：跟随某人时是被跟随者，否则是自己（`_resolveViewer`）。
- 3D 墙体透明度：自由/俯视用 `walltrans`，第一/第三跟随用 `followwalltrans`；不透明度 ≥50% 的墙写深度，墙后人物走「掩体后」x 光剪影（该遍材质 `fog:false`）。
- 地图风格 `mapstyle3d`：`real`（写实白模：天空穹顶、大气雾、日光）/ `tactical`（深色青调）。配色与雾距在 `MAP_STYLES`。
- 地形材质是 `flatShading`，不需要真实顶点法线；装图时只放一个常量朝上的 8 位 normal 属性（不能删掉：阴影 normalBias 会 normalize 法线，缺属性得到 NaN，地图收不到阴影）。

## 本地开发

只需 **Node 18+**：

```bash
npm run dev   # http://127.0.0.1:5173
```

`dev/server.mjs` 提供静态文件与样例版 `/api/*`。改 JS/CSS 后硬刷新（`Ctrl+Shift+R`）；模块 URL 改动后记得 bump `?v=`（3D 模块链：`index.html` → `korr-adapter.js` → `korr-renderer.js` → `korr-hud.js` / `character-models.js`，改下游要逐级 bump）。

冒烟与性能采样（需本机 Chrome/Edge，dev 服务先启动）：

```bash
node dev/smoke.mjs --url http://127.0.0.1:5173/ --seconds 6   # 输出 JSON；有页面异常/console.error 时退出码 1
node dev/smoke.mjs --size 390x844                               # 移动端视口
```

部署时，宿主可在投递 `index.html` 前注入 `__MS_NO3D__`（`0` 或 `1`）：无地形 GLB 时为 `1` 以隐藏 3D 入口。本地 dev server 会做同样替换。

## 编辑规则

### 应当

- 保留 `/api/state` 字段名与语义。
- 优先**小步、可 review 的 diff**，除非任务明确要求结构化拆分。
- 沿用视觉语言：暗色玻璃面板、`--accent` 蓝、语义色（`--ally`、`--danger`、`--warn`、`--loot`）。
- 同时测 **纯 2D** 与 **3D** 路径；测移动端断点。
- 静态资源改动后 bump 缓存破坏 query（`?v=…`）。

### 禁止

- 在本仓库添加服务端或原生代码 —— 保持纯浏览器项目。
- 无迁移方案地重命名 `localStorage` 键。
- 编辑 `vendor/three/**`（版本升级除外）。
- 无替代方案地删除回放控件或诊断面板。
- 未经明确要求引入 React/Vue。

## 建议重构顺序

接到「整理前端」类任务时，按此顺序：

1. 从 `index.html` 抽出 CSS → `ui/styles/viewer.css`；删掉内联重复规则。
2. 纯函数（颜色、距离、格式化）→ `ui/app/constants.js` + `ui/app/format.js`。
3. 轮询循环 + 快照分发 → `ui/app/engine.js`。
4. Leaflet 图层 → `ui/app/map2d.js`。
5. 干员台/物资 DOM → `ui/app/roster.js`。
6. 在 `index.html` 用 `<script type="module">` 入口串联。
7. 以上完成后再考虑 TypeScript 或 bundler。

## 质量门槛

合格的改动应满足：

- [ ] Chrome 桌面 + 移动端视口（约 390px 宽）可用
- [ ] 2D 标记平滑、3D 第一视角相机无回归
- [ ] 偏好读写正常（`PREF` / `setPref`）
- [ ] 空闲轮询无新增 console 报错
- [ ] 结构性改动应减少 `index.html` 行数

---

*最后更新：2026-10-07 — 纯前端 Agent 范围。*

## 地形打包与烘焙（`tools/terrain-pack/`）

离线把 `m3d/*.glb` 打成 `.tpk`（MSTP v1：块内 int16 差分 + 首次使用索引变长码 + gzip，约为 GLB 的 1/3～2/5），
并烘焙逐顶点 `bake`（R = AO，1 = 无遮挡；G = 头顶天空可见度，1 = 头顶是天空）。纯 Node 内置模块（zlib、worker_threads），零依赖。

```bash
node tools/terrain-pack/cli.mjs --help
node tools/terrain-pack/cli.mjs daba                    # 单张：打包 + 烘焙 + 回读校验 + 追加 manifest 的 packed 字段
node tools/terrain-pack/cli.mjs --all                   # 全部地图（daba 约 40s / 32 线程，其余按面数线性估计）
node tools/terrain-pack/cli.mjs daba --no-bake --no-manifest --out-dir /tmp/tpk   # 只看压缩率
```

- 产物 `.tpk` 与 GLB 同目录，已被 `.gitignore`（`*.tpk`）忽略；manifest 只追加 `maps.<key>.packed`，不改其它字段。
- 客户端 `korr-adapter.js` 的 `setMap()`：manifest 有 `packed` 且 `packed.src_rev` 与当前 GLB `rev` 一致时先加载 `.tpk`（`m3d/terrain-packed.js` 解码，原生 `DecompressionStream`），任何失败都回退原 GLB。
- 交给 `gateway.installGeometry` 的几何多一个 `bake` 属性（Uint8、normalized、itemSize 2）；没有 `bake` 时渲染照旧。
- 换了 GLB 必须重跑本工具，否则 `src_rev` 不符会自动回退 GLB（不会用到过期包）。
