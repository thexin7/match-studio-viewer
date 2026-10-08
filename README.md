# Nova 实时雷达（前端）

浏览器端**实时雷达**：在对局进行中查看自己、队友、敌方目标与 AI 的位置、方向、高差、距离和血量，查看当前装备与已确认状态，筛选物资、容器和死亡盒，并在 2D 与 3D（自由 / 俯视 / 第一跟随 / 第三跟随）之间切换。

产品只提供实时雷达：没有播放、暂停、倍速、时间轴、录像、历史对局、战报或导播入口。服务端处于回放等非实时状态时，页面标注「非实时数据 · 不是当前对局」，不提供回放控制。

## 功能

- **实时状态**：连接中 / 等待对局 / 实时 / 数据停滞 / 连接异常 / 非实时数据六态，按请求结果、`live_active`、`status` 原值和快照内容变化判定；停滞和异常时画面降亮并注明「不是当前位置」。
- **2D 态势图**：Leaflet 瓦片、平滑标记、阵营色（友军绿、敌方红）、朝向锥与枪线、贴脸警戒圈、点位分级显示；实时位置、最后位置、出生点在视觉上区分。
- **目标 / 物资面板**：按我方、敌方各队、未知身份、AI 分组或按距离排序；每行给出当前武器、护具、血量（上限未知时只显示数值）、距离、高差与相对方位。物资页按类型、品质、距离 / 价值 / 品质筛选排序，死亡盒显示同步到的清单。
- **3D 场景**（需地形资产）：白模地形、干员模型、远近血量、屏外预警、朝向雷达；第一跟随底部观察条显示跟随对象的血量、当前装备、姿态与朝向时效。地形加载失败给出原因、重试与回到 2D。
- **手机**（≤ 760px）：单行顶栏、自己条 / 相机模式行、三档底部抽屉（收起 / 半展开 / 全屏）、44 px 浮动按钮、底部弹层式设置。
- **地图选择**：本人坐标落在唯一地图内即确认；本人位置缺失时用多数人物坐标推断；都没有时写明「未确认 · 沿用上次选择」。手动选择只覆盖当前会话。

## 快速开始

```bash
git clone https://github.com/thexin7/match-studio-viewer.git
cd match-studio-viewer
npm run dev          # http://127.0.0.1:5173
```

内置开发服务器提供**测试数据**（页面会显示「测试数据」横幅），只能验证界面表达，不能作为实时对局验收证据：

```bash
node dev/server.mjs --scenario live      # 默认：实时，20 Hz 快照，人物按确定性轨迹移动
node dev/server.mjs --scenario waiting   # 服务在线但没有对局
node dev/server.mjs --scenario stalled   # 实时数据冻结
node dev/server.mjs --scenario error     # /api/state 返回 503
node dev/server.mjs --scenario noself    # 本人坐标缺失
node dev/server.mjs --scenario nonlive   # 服务端处于回放
node dev/server.mjs --no-terrain         # 地形 404，验证 3D 失败与重试
node dev/server.mjs --port 5181 --upstream http://127.0.0.1:17912   # 用新界面看真实后端数据（只读转发）
```

运行中也可以切换：`GET /__dev/scenario?set=<情景>&terrain=0|1&session=<N>&map=<地图>`（`session` 模拟新会话，`map` 把样例平移到指定地图）。

## 测试与验收

```bash
npm test                                                       # 单元 / 回归测试（node:test）
node dev/states-smoke.mjs --url http://127.0.0.1:5173/         # 六种状态、本人位置缺失、3D 跟随与失败重试、新会话切图、面板与弹层；桌面 + 390px 手机
node dev/live-check.mjs --url <地址> --3d --hardware            # 状态时间线、错误、脚本/布局耗时、长任务、帧间隔、网络量、绘制次数
node dev/live-check.mjs --url <地址> --soak 7 --hardware        # 长时间切图与进出 3D，记录内存、DOM、监听器与 3D 资源
node dev/live-check.mjs --url <地址> --3d --hardware --trace     # 加录 Chrome trace：各线程忙碌时间、主线程事件耗时
node dev/fpv-check.mjs --url <地址> --hardware                  # 第一视角 / 第三跟随逐帧平滑度（速度、转向波动与停顿帧）
node dev/smoke.mjs --url http://127.0.0.1:5173/ --size 390x844  # 2D / 3D 冒烟
```

验收脚本默认使用 SwiftShader 软件渲染，帧率不代表真实 GPU；加 `--hardware` 走默认 GPU 路径。实时对局的验收必须在真实后端 `live_active=true` 时进行。

## 数据流

```
浏览器 ──轮询──▶ GET /api/state    当前快照（内容签名去掉随墙钟增长的年龄字段；不变即跳过，按快照间隔自适应）
         │       GET /api/status   只在打开「数据状态」详情时每秒读取
         │       GET /api/map      启动时读取地图目录
         └─静态─▶ index.html、ui/、m3d/、vendor/、avatars/、resources/
```

本仓库只包含浏览器客户端。任何在同源实现上述只读接口的数据源都可以驱动此 UI；字段契约与表达规则见 [AGENTS.md](./AGENTS.md)。

## 数据表达

- 界面上的计数是**当前快照里已知的目标**，不是全场人数。
- 血量 `hp.total=[当前, 上限]`：上限未知显示 `95/?` 且不画比例；`hp=null` 显示「血量未知」，与 0 血分开。
- 当前武器只认 `curr_weapon` 的解析结果；`weapon` 是出生携带，只在详情中作为「初始武器」出现。未解析时不放枪。
- 出生点处的 AI 显示出生点与年龄，不做移动插值、不触发贴脸、不计入最近实时敌人。
- 状态里的时间是客户端计时，不代表游戏网络延迟。

## 实时跟随与血量

第一视角的视线（上行位置 + 瞄准朝向）与身体走同一条按快照时间戳插值的时间线，跑跳时连续平滑，代价是比最新快照晚约一个快照间隔显示；视模晃动只按水平速度，腾空时收回并带竖直惯性。位置先按 `position_origin` 区分网格与胶囊根基准，再按基准眼高和原生动作的头高差定位，上行根坐标不是眼睛坐标。瞄准年龄超过 250 ms 时回落到身体朝向并明示「瞄准过期」；跟随他人时只有水平朝向。眼高是估算，不等同游戏摄像机。MP5 使用原生部件外观，匕首使用原生网格；其余枪械和手臂为通用示意，附件、皮肤、开火、后坐力与换弹动作没有同步。

解析出的姿态字段驱动游泳、蹲伏、趴下和下落；倒地独立处理。AI 使用通用步兵模型，位置时效标记保留。自动帧率为电脑实时 60 FPS、手机或无人物场景 30 FPS；隐藏页面停止 3D 工作，仍可手动选择更高帧率。

## 3D 地形模型

6 张地图的白模 GLB（约 380 MB）位于 `m3d/`，与 `manifest.json` 配套，在 `.gitignore` 中；无 GLB 时 2D 仍可用。地图目录包含零号大坝、长弓溪谷、航天基地、巴克什、潮汐监狱和 AZ3。只有零号大坝另有按难度划分的点位数据。

### 路由器部署的轻量地形

模型处理只在开发机执行；路由器继续提供静态文件，不需要 Node.js、WASM 简化器或新服务。

```bash
npm ci
node tools/terrain-pack/validate.mjs
node tools/terrain-pack/light.mjs --all
node --test dev/terrain-light.test.mjs
```

`validate.mjs` 使用 Khronos glTF-Validator，发现错误时退出码为 1。`light.mjs` 使用固定版本 meshoptimizer 离线生成 `packed_light`：锁定拓扑边界，以 50% 面数为目标、0.05 米算法误差为上限，同时考虑 AO / 天空可见度属性；每个产物都用浏览器解码器回读核对。自动、流畅、平衡档优先使用版本匹配的轻量包，高清档使用完整包；轻量包失败依次尝试完整 TPK 和原始 GLB。

### 地形接缝修复

2026-10-07 核对发现，五张地图原始 GLB 内 64×64、间距 2 米的高度网格存在 XY 行列转置（以大坝为例，共享边界点高度差中位数 16.94 米、最大 117.59 米；转置恢复后最大差 0.00129 米）。`tools/terrain-pack/repair.mjs` 只识别并修复规则高度网格，建筑几何与人物世界坐标保持原有语义；原 GLB 留存，新 GLB 使用独立文件名，manifest 的 `terrain_source` / `terrain_repair` 记录来源与修复统计。

| 地图 | 修复前共享边界最大高差 | 修复后 |
|---|---:|---:|
| 零号大坝 | 117.588 m | 0.00129 m |
| AZ3 | 49.046 m | 0.00281 m |
| 长弓溪谷 | 204.473 m | 0.00209 m |
| 潮汐监狱 | 99.031 m | 0.00200 m |
| 航天基地 | 40.674 m | 0.00139 m |

```bash
node tools/terrain-pack/repair.mjs daba
node tools/terrain-pack/cli.mjs daba --threads 12
node tools/terrain-pack/light.mjs daba
node --test dev/terrain-seams.test.mjs dev/terrain-worker.test.mjs dev/terrain-bake.test.mjs dev/terrain-light.test.mjs
```

浏览器把 TPK 下载、解压和解码放在 module Worker，换地图时终止旧任务；Worker 不可用时保留直接解码。地形接缝通过不等于每个游戏姿态的脚底高度都已验收；没有通过修改人物 Z 或吸附地面掩盖原始坐标差异。

## 技术栈

- 原生 JavaScript（普通脚本 + 3D 侧 ES modules + import map），无打包工具
- [Leaflet](https://leafletjs.com/) — 2D 地图；[Three.js](https://threejs.org/) — 3D 场景
- 设计稿：[Figma · 实时雷达](https://www.figma.com/design/LINb0twz3q3Ajdc7ZUG2C3)

## 许可证

MIT
