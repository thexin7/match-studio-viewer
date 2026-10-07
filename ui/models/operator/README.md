# 移动端干员资源

运行时使用从本地游戏导出的 17 名干员原始网格。按干员名匹配默认外观；威龙采用带头盔的 `M_Dragon_008_Body_3P_HD`，保留头盔、面罩和装备轮廓。逐个资源的路径、哈希、面数和体积见 `mobile-manifest.json`。

- 无贴图、无 UV；每人 6 个顶点色块、一个材质、一套共享骨架。
- 近景不超过 3500 个三角形；远景不超过 1300 个。少数复杂发型保留略多的轮廓面。
- 电脑版是独立的 `.desktop.glb`，近景上限 24000 面、保留更密的走跑动画采样，使用简单 PBR 光照。继续采用无贴图的六色配色；手机不会为了电脑细节下载大模型。
- 几何和材质在实例间共享；每个干员独立播放基础姿态。走跑按收到的位置变化推算，不代表完整游戏动作或皮肤同步。
- 根骨骼的水平位移被移除，网络坐标决定人物位置。
- 同时只加载一个模型。HTTP 服务直接发送预生成的 `.glb.gz`，路由器不进行实时模型转换或压缩。
- `*.glb` 和 `*.glb.gz` 为本地生成物，不加入源码 Git；原游戏资产不属于本仓库的 MIT 代码许可。

## 离线生成

CUE4Parse 1.2.2.202610 导出原始 GLB、材质 JSON、纹理和骨骼动作；输入工作目录包含 `exported/`、`operators.json`、`motion-map.json`。

```text
python tools/prepare-game-operators.py <工作目录>
blender --background --factory-startup --disable-autoexec --python-exit-code 1 --python tools/build-game-operators.py -- <工作目录>/prepared ui/models/operator
blender --background --factory-startup --disable-autoexec --python-exit-code 1 --python tools/build-game-operators.py -- <工作目录>/prepared ui/models/operator --desktop
python tools/compact-game-operators.py ui/models/operator
python tools/catalog-game-operators.py <工作目录>/operators.json
node --test dev/operator-assets.test.mjs
```

离线准备与压缩脚本使用 Pillow；Blender 4.5 执行减面、重新绑定和动画导出。生成后用 glTF Validator 与 `dev/operator-preview.html?hero=威龙` 检查，再测试实际地图中的多人、朝向、倒地和距离切换。

手机模式使用 30 FPS、较早的几何简化和较低的动画更新频率；电脑模式使用 60 FPS，并提高细节保留距离。独立查看器保存本机的模式、阴影和帧率偏好；控制台与 OBS 嵌入视图继续使用共享设置。

阵营识别统一为友军绿色、敌方红色；未确认身份仍为中性灰色。手机版直接以阵营色绘制，电脑版保留简化原色并叠加阵营色轮廓；同一干员的不同实例具有独立着色，仍共享网格数据。
