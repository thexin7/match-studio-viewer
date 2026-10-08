# Nova 实时雷达 — Agent 指南

## 产品定位：仅实时雷达

本仓库是 **Nova 实时雷达** 的浏览器前端：对局进行中查看自己、队友、敌方目标、AI、物资与容器的实时态势。

- 不是回放播放器、录像分析平台或电竞导播后台。正常界面不出现播放、暂停、快进、倍速、时间轴、录像选集、历史对局、战报、导播工作台或 OBS 配置。
- 服务端可能处于回放或其他非实时状态（`live_active` 不为 `true`）。页面只标注「非实时数据 · 不是当前对局」，不提供任何回放控制。
- `/api/ctrl`、`/api/studio`、`/api/select`、`/api/flows` 是服务端的历史兼容接口，前端不调用；不要把 `/api/ctrl` 当作控制对局的接口。原 `/studio` 控制台与 `/overlay` 叠加层已从本仓库删除。

## 当前优先级：实时对局、第一视角与干员显示

- 实时画面才是验收依据。样例数据、截图、回放快照与资源 HTTP 200 不能替代实时对局验收；缺少实时数据的项目列为未验证。
- 第一视角位于被跟随者眼位，采用有效的朝向和俯仰；轨道操作不改写眼位，换人不拖行，过期瞄准不残留。隐藏被跟随者模型时，血量与状态由页面底部的观察条显示。
- 按 `position_origin` 区分 MRA 网格原点与上行/出生根坐标。蓝图默认网格相对胶囊根 Z 为 -86 厘米；只在展示层归一化，不改写 API 原始坐标，不把上行根坐标当成眼位。眼高随原生姿态估算，头部角度不经过身体平滑。
- 实时人物位置与动作需要连续插值；检查走停、转身、瞬移、换局和重新进入画面，避免多重平滑累积延迟。
- 游泳、蹲伏、趴下、下落与倒地分开处理，以解析出的姿态字段为依据；速度只用于插值与动画混合。离线压缩只能折叠真正恒定的轨道。
- 近距离与远距离都显示血量数值和血条；LOD、远距名牌或窄屏名牌密度控制不能隐藏血量。未知血量与零血量必须区分，禁止补造满血。
- 电脑默认使用已有干员细节资源，手机使用轻量资源。地形自动降档不能无条件把电脑干员换成手机模型；未知身份保留通用模型，不冒充具体干员。
- 默认地图依据当前会话的有效证据：本人坐标落在唯一地图内为「本人坐标确认」，否则用多数人物坐标做「目标坐标推断」；都没有时明示「未确认 · 沿用上次选择」。手动选择只覆盖当前会话。
- 资源解码或场景构建失败必须传递到上层失败状态，3D 状态卡给出原因、重试与回到 2D；失败后不自动重载。
- 鱼竿、刀具、投掷物和未知装备不能显示为步枪；已确认持竿不等于已确认抛竿、中鱼或收杆。
- AI 也接入模型路径；出生点与最后位置的时效标记不能因替换模型消失。自动帧率按设备和场景设预算，保留用户显式选择高帧率的能力。

> **范围：** 本仓库是独立的浏览器 UI 项目，只依赖下文描述的同源 HTTP API。不要假设存在其它仓库或服务端实现；不要伪造接口。

## 目录结构

```
.
├── index.html              # 外壳：标记、图标、加载顺序（宿主注入 __MS_NO3D__）
├── ui/radar/
│   ├── model.js            # 数据表达模型（纯函数）：实时状态、血量、武器、身份、时效、姿态、计数、地图推断
│   ├── app.js              # 页面主程序：轮询、2D 绘制、列表、状态、弹层、抽屉、3D 接入
│   └── radar.css           # 全部样式（与 Figma「01 基础」变量同源）
├── ui/icons/               # 装备图标（头盔 / 护甲 / 背包 / 胸挂）
├── ui/models/              # 干员与装备模型资源
├── m3d/                    # 3D：korr-adapter（快照 → 3D）、korr-renderer（地形、相机、人物）、korr-hud（HUD）等
├── avatars/                # 干员头像（文件名 = 干员代号）
├── vendor/                 # Leaflet + Three.js（除升级外勿改）
├── dev/
│   ├── server.mjs          # 本地静态服务 + 样例 API 情景 / 上游转发
│   ├── states-smoke.mjs    # 状态与交互验收（桌面 + 390px 手机）
│   ├── live-check.mjs      # 真实后端检查与性能采样（各进程 CPU、trace、剖析）、长时间运行测试
│   ├── fpv-check.mjs       # 第一视角 / 第三跟随镜头逐帧平滑度检查
│   ├── smoke.mjs           # 2D / 3D 冒烟与基础性能采样
│   └── *.test.mjs          # node:test 单元与回归测试
└── tools/                  # 离线资源工具（地形打包、干员模型）
```

## 数据流与节奏

1. 启动读 `GET /api/map`（地图目录），然后串行轮询 `GET /api/state`。
2. **接收**：在正文字符串上计算内容签名（`bodySignature`），去掉只随墙钟增长的字段（`pose_age_ms`、`age_sec`、`self_aim_age_ms`、`meta`）；签名不变就不解析、不重绘、不算新数据。按服务端快照间隔自适应安排下一次请求；长时间无变化时退避（实时流上限 100 ms，等待 / 非实时上限 400 ms），后台标签页 1 s。
3. **判定**：`createLiveMonitor` 记录成功、失败与内容变化；状态胶囊、横幅、观察条每 250 ms 刷新。
4. **插值**：2D 标记由 `smStep` 平滑（最多 60 Hz，3D 小地图 30 Hz）；3D 由 `PosePresenter` 按快照时间戳插值（见「性能约定」）。
5. **列表**：目标页最多 5 Hz、物资页最多 2.5 Hz，只渲染可见分页；距离、方位、血量按行增量更新。
6. `GET /api/status` 只在打开「数据状态」详情时每秒读取。
7. 3D 关闭小地图（或手机）时不维护 2D 标记，2D 地图不绘制；进入 3D 时清掉 2D 信息堆。
8. 偏好存于 `localStorage`，前缀 `nr2_<key>`（历史命名，改名需要迁移方案）。

## API 契约（不可破坏，按实际响应为准）

### `GET /api/state`

| 字段 | 含义 |
|------|------|
| `status` | 原样显示，不推断枚举。真实后端见过 `waiting`、`replay` |
| `live_active` | `true` 才可能是实时；否则为等待或非实时 |
| `session`、`epoch`、`flow`、`local`、`remote` | 会话身份：变化即新会话，重置跟随目标与地图判断 |
| `timestampMs`、`cursor` | 快照时间 / 游标（不作为客户端延迟） |
| `self` | 本人 `[x,y,z]`，UE 厘米；可能为 `null` |
| `self_name`、`self_hero`、`self_hp`、`self_life` | 本人身份、血量（`total=[当前, 上限或 null]`）、生命状态 |
| `self_weapon`、`self_weapon_status`、`self_weapon_id` | 当前持有，只认 `resolved` |
| `self_yaw`、`self_aim_yaw`、`self_pitch`、`self_aim_age_ms` | 朝向；瞄准年龄 ≤ 250 ms 才用作头部朝向 |
| `self_up_loc`、`self_position_origin`、`self_pose` | 上行根坐标、坐标基准、姿态 |
| `entities` | 目标、AI、物资、容器、死亡盒（见下） |

实体字段（重构时保留全部现有字段）：`key, kind, name, hero, team, is_bot, world, rel, yaw, position_origin, hp, dead, life_state, status_key, pose, weapon（出生携带）, curr_weapon, curr_weapon_known, curr_weapon_status, curr_weapon_id, helmet, vest, helmet_dur, vest_dur, bp, cr, spawn_mark, age_sec, out_of_range, pose_age_ms, trail, item_id, grade, price, stack_count, pickup_status, contents …`

`kind`：`self | mate | player | ai | box | loot | container | unknown`。

### `GET /api/status`

`rates`、`counts`、`transport`、`stats`、`error`、`semanticComplete` 等。只用于数据状态详情与诊断；服务进程在线不代表有对局数据。

### `GET /api/map`

地图目录：`default`、`maps[]`（`key, name, bounds, rotate, width, height, centerX, centerY, bj, tileUrl, tileSize, maxNativeZoom, poi`）。

静态资源：`/ui/`、`/vendor/`、`/avatars/`、`/m3d/`、`/resources/`。不假设 WebSocket、SSE、增量订阅、账号、历史查询、击杀/伤害/弹药事件或向游戏发送指令的能力。

## 数据表达规则（`ui/radar/model.js`）

- 血量：`hp.total=[当前, 上限]`。上限未知只显示数值（如 `95/?`），不画比例、不补 100；`hp=null` 为「血量未知」，与 `0` 严格区分；部位上限缺失时不用默认值补齐。
- 当前武器只认 `curr_weapon` 的解析结果；`weapon` 是出生携带，只在详情里作为「初始武器」出现。未解析显示「武器未解析」，3D 不放枪；名称表未收录显示「武器名称未收录 #ID」。
- 身份：已知干员用头像与对应模型；`kind=unknown` 或缺干员时显示「身份未解析 / 干员未解析」并用通用表现。
- 位置时效：实时（实心）、最后位置（空心）、出生点（虚线 + 年龄）、超距（降透明）。出生点与超距目标不触发贴脸、不计入「最近实时敌人」、不做移动插值。
- 计数写成「已知」，不代表全场人数。
- 时间均为客户端计时，不叫游戏网络延迟。

## 实时状态

| 状态 | 判定 |
|------|------|
| 连接中 | 尚未收到任何成功响应 |
| 连接异常 | 最近一次请求失败（超时 5 s、HTTP 非 2xx、断网），保留最后画面并降亮 |
| 实时 | `live_active=true` 且 3 s 内内容签名有变化 |
| 数据停滞 | `live_active=true` 但 ≥ 3 s 内容无变化，画面降亮并标注最后位置 |
| 等待对局 | 响应成功但无本人坐标也无实体（如 `status=waiting`） |
| 非实时数据 | 响应成功、有数据，但 `live_active` 不为 `true`（如 `status=replay`） |

局部状态：本人位置未解析（距离与方位不可用、第一跟随自己不可用）、无可显示目标（不代表附近没有敌人）、3D 加载中 / 失败。开发样例带 `dev_fixture:true`，页面显示「测试数据」。

## 界面布局

- **桌面**：地图铺满。顶栏左为状态胶囊（点开看数据状态详情）与地图（含确认来源），右为 2D/3D、图层、设置。右侧「目标 / 物资」面板可收成窄轨；左下自己卡；2D 有图例与地图控制；3D 底部相机条（自由 / 俯视 / 第一跟随 / 第三跟随 + 跟随对象 + 重置），第一跟随时上方观察条。
- **手机（≤ 760px）**：顶栏单行（状态、地图、2D/3D、设置）；2D 第二行自己条，3D 第二行相机模式；底部抽屉三档（收起 / 半展开 / 全屏），分页为目标、物资、图层；44 px 浮动按钮在抽屉之上；弹层与设置为底部抽屉。
- 设计稿：Figma「Match Studio 查看器 · UI 重设计」<https://www.figma.com/design/LINb0twz3q3Ajdc7ZUG2C3>（00 封面 / 01 基础 / 02 组件 / 03 桌面 / 04 手机 / 05 状态与数据表达 / 06 实测截图）。

## 坐标与渲染

- 世界坐标为 **UE 厘米**。地图投影用 `MAP_INFO`（center、rotate、width/height、`bj`）。
- 3D：`x = ue_x/100`，高度 = `ue_z/100`，深度 = `ue_y/100`。朝向：UE 风格，+X 为 0°，向 +Y 增大；3D 绕 −Y 旋转。
- 2D 标记平滑 `SM_TAU`；3D 插值在 `gateway-pose.js` 的 `PosePresenter`，相机状态机在 `korr-renderer.js`（`updateFollow`）。
- 第三人称防穿墙（`_avoidFollowCameraCollision`）只缩短本帧渲染位置，下一帧控制器更新前由 `_restoreFollowCamera` 还原；求交走 `map-raycast.js`，不要换回 `Mesh.raycast`。
- 勿在未测卡顿的情况下去掉缓存与池化（`_rc`、`opRows`、`lootRows`、`infos`、3D 实体池）。
- 2D 每个人物只挂两个 Leaflet marker：主体标记 + 信息堆（`updInfo`）。
- 色板只有一份：`app.js` 的 `TEAM_COLORS` / `C_*` / `GRADE_COL`，通过 `create({palette})` 下发给 3D；与 Figma 变量集合「R 实时雷达」同值。
- 3D 敌我、距离、贴脸以观察者为准（`_resolveViewer`）；页面列表的距离与方位相对自己。
- 墙体透明度：自由 / 俯视用 `walltrans`，跟随用 `followwalltrans`；不透明度 ≥ 50% 的墙写深度，墙后人物走 x 光剪影。
- 地图风格 `mapstyle3d`：`real`（写实白模）/ `tactical`。地形材质 `flatShading`，保留常量朝上的 8 位 normal 属性（阴影 normalBias 依赖）。
- HUD 不再画第一视角观察卡（由页面观察条显示）；窄屏远距名牌文字最多 6 个，其余保留标识、血条或血量数值。

## 性能约定

用户机器可能是 144–300 Hz 高刷屏：任何按刷新率运行的东西都会被放大数倍。改动前后用 `dev/live-check.mjs` 看各进程 CPU（`cpuPercent`），用 `dev/fpv-check.mjs` 看镜头平滑度。

- **帧节拍**：3D 渲染循环不用 `setAnimationLoop`，由 `_scheduleLoop` 按帧率上限排程（定时器睡到到期前约 1.5 个刷新周期，再用 rAF 逐周期逼近）；2D 模式与后台页停掉循环。2D 平滑 `smStep` 同一做法。不要再加常驻 rAF 循环。
- **CSS**：地图上不放无限循环动画；血条、方位箭头等随数据高频变化的属性不加 `transition`（否则每次更新都按刷新率连跑一段动画）。
- **2D 标记**：z-index 按类别固定（`L.Marker` 补丁，不按屏幕 y 每帧重算）；物资、箱子、POI 用 `flat:true`（2D 平移，不各占合成层）；视野外和亚像素差距的点直接落到目标。跟随平移走 `followPan`（只挪地图面板，`moveend` 合并为最多每 250 ms 一次），不要逐帧 `panTo`。贴脸警戒圈是 DOM 标记，不放回 Canvas。
- **3D 插值**：`PosePresenter` 按后端 `timestampMs`（缺失时用到达时刻）缓冲快照，呈现时刻 = 当前 − 最小到达延迟 − (快照间隔 + 抖动余量)，在两帧之间按时间比例插值；本人身体、第一视角视线（上行位置 + 瞄准朝向）与真人玩家共用这条时间线。第一视角因此多约一个快照间隔的显示延迟，换来跑跳时不再按快照频率顿挫。
- **诊断钩子**：页面里置 `window.__msFrameLog = []` 后，渲染器逐帧追加 `[时刻, 相机 x, y, z, 视线 x, y, z]`；平时为空，不产生开销。

## 本地开发与验收

只需 **Node 18+**（测试脚本的 glob 写法需要 Node 21+ 或 bash）。

```bash
npm run dev                                   # http://127.0.0.1:5173，默认「实时」样例情景（测试数据）
node dev/server.mjs --scenario stalled        # 情景：live / waiting / stalled / error / noself / nonlive
node dev/server.mjs --no-terrain              # 地形 404，验证 3D 失败与重试
node dev/server.mjs --port 5181 --upstream http://127.0.0.1:17912   # 新界面 + 真实后端数据（只读转发）
npm test                                      # node:test 全部单元 / 回归测试
node dev/states-smoke.mjs --url http://127.0.0.1:5173/   # 状态与交互验收，桌面 + 390px 手机，输出 JSON 与截图
node dev/live-check.mjs --url <真实地址> --3d --hardware  # 真实后端检查与性能采样
node dev/live-check.mjs --url http://127.0.0.1:5173/ --soak 7 --hardware   # 长时间切图 / 切 2D-3D 的资源增长
node dev/live-check.mjs --url http://127.0.0.1:5173/ --3d --hardware --trace --profile   # 各进程 CPU + 主线程事件 + JS 热点
node dev/fpv-check.mjs --url http://127.0.0.1:5173/ --hardware   # 第一视角 / 第三跟随逐帧速度与转向波动（样例本人边跑边跳）
```

无头 Chrome 的 rAF 不跟显示器同步（本机约 300 Hz），`cpuPercent` 里浏览器进程约 19% 是无头模式自身的底数；页面开销看 `renderer` + `gpu`。`--frames` 会自带一个 rAF 循环，测 CPU 时不要开。

运行中切换样例：`GET /__dev/scenario?set=<情景>&terrain=0|1&session=<N>&map=<key>`。改 JS/CSS 后硬刷新；模块 URL 改动后 bump `?v=`（3D 链：`app.js` → `korr-adapter.js` → `korr-renderer.js` → `korr-hud.js` / `character-models.js`，改下游要逐级 bump）。部署时宿主在投递 `index.html` 前替换 `__MS_NO3D__`（`0` 或 `1`）。

## 编辑规则

### 应当

- 保留 `/api/*` 字段名与语义；每个界面指标都能指向字段或明确的前端计算。
- 小步、可 review 的 diff；同时测 2D、3D、桌面与约 390px 手机。
- 静态资源改动后 bump 缓存参数。

### 禁止

- 在本仓库添加服务端或原生代码。
- 在正常界面加入回放 / 导播 / 录像能力，或调用 `/api/ctrl`、`/api/studio`。
- 无迁移方案地重命名 `localStorage` 键。
- 编辑 `vendor/three/**`（版本升级除外）。
- 未经明确要求引入 React / Vue 或打包工具。
- 用样例数据或截图宣称实时验收通过。

## 质量门槛

- [ ] `npm test` 通过；`dev/states-smoke.mjs` 通过（桌面 + 手机）
- [ ] 空闲与实时轮询无新增 console 报错
- [ ] 2D 标记平滑、3D 第一视角相机无回归（`dev/fpv-check.mjs` 第一视角水平速度变异系数 < 0.2、无停顿帧）；偏好读写正常
- [ ] 真实后端实测（`dev/live-check.mjs`），未覆盖的场景列为未验证

---

*最后更新：2026-10-08 — 定位改为「仅实时雷达」，界面重做；高刷屏帧节拍与第一视角插值优化。*

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
