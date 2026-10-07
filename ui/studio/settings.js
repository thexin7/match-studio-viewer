// Only preferences already consumed by the viewer are exposed here.
export const groups = [
  { name: '距离与预警', hint: '接近提醒、朝向雷达与 3D 标记', items: [
    ['alert', '接近距离', 'range', 80, 0, 300, 10, 'm'],
    ['alerttoast', '接近时显示警报', 'toggle', 1],
    ['warnd', '对手显示距离', 'range', 150, 0, 1000, 10, 'm'],
    ['radar3d', '朝向雷达', 'toggle', 1],
    ['radarr', '雷达量程', 'range', 150, 25, 1000, 25, 'm'],
    ['warn3d', '3D 屏外箭头', 'toggle', 1],
    ['ray', '3D 人物连线', 'toggle', 0],
    ['box3d', '3D 人物方框', 'toggle', 0],
  ] },
  { name: '人物与标记', hint: '队友、AI 单位、名字、装备与轨迹', items: [
    ['mate', '队友', 'toggle', 1], ['ai', 'AI 单位', 'toggle', 1], ['name', '干员名字', 'toggle', 1],
    ['wpn', '武器', 'toggle', 1], ['gear', '装备', 'toggle', 1], ['hp', '血量', 'toggle', 1],
    ['dist', '距离', 'toggle', 1], ['trail', '移动轨迹', 'toggle', 1],
    ['dotsize', '标记大小', 'range', 100, 50, 200, 10, '%'], ['fontsize', '标记字号', 'range', 100, 50, 200, 10, '%'],
  ] },
  { name: '物资与点位', hint: '物资品质、容器、撤离点与出生点', items: [
    ['loot', '物资上图', 'toggle', 1], ['box', '死亡盒', 'toggle', 1], ['container', '普通容器', 'toggle', 1],
    ['aibox', '人机盒子', 'toggle', 0], ['lootmin', '最低物资品质', 'range', 4, 1, 6, 1, '级'],
    ['poiexit', '撤离点', 'toggle', 1], ['poispawn', '出生点', 'toggle', 1], ['poibox', '高价值容器', 'toggle', 1],
  ] },
  { name: '3D 场景', hint: '底图、透明度、人物与相机', items: [
    ['mapstyle3d', '地图风格', 'select', 'real', [['real', '写实'], ['tactical', '战术']]],
    ['maptex3d', '官方底图投影', 'toggle', 1],
    ['walltrans', '总览墙体透明度', 'range', 78, 0, 100, 5, '%'], ['followwalltrans', '跟随墙体透明度', 'range', 0, 0, 100, 5, '%'],
    ['floortrans', '地面透明度', 'range', 0, 0, 100, 5, '%'],
    ['model3d', '人物模型', 'select', 'tactical', [['tactical', '战术'], ['mannequin', '简洁'], ['beacon', '信标'], ['capsule', '胶囊']]],
    ['charsize', '人物大小', 'range', 100, 50, 200, 10, '%'], ['fov', '视野 FOV', 'range', 58, 30, 120, 1, '°'],
    ['fpvheight', '视角高度', 'range', 1.6, .5, 3, .1, 'm'],
  ] },
  { name: '系统', hint: '3D 画质、阴影与帧率', items: [
    ['q3d', '渲染模式', 'select', 'auto', [['auto', '自动'], ['perf', '手机模式'], ['mid', '均衡'], ['high', '电脑模式']]],
    ['shadow3d', '建筑阴影', 'select', 'auto', [['auto', '自动'], ['on', '开启'], ['off', '关闭']]],
    ['fpscap', '帧率上限', 'select', 0, [[0, '无限制'], [30, '30 FPS'], [60, '60 FPS'], [120, '120 FPS']]],
    ['paneltheme', '查看器面板', 'select', 'dark', [['dark', '深色'], ['light', '浅色']]],
  ] },
];
