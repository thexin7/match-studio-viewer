import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../ui/radar/model.js', import.meta.url), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(source, ctx);
const M = ctx.RadarModel;
const manifest = JSON.parse(fs.readFileSync(new URL('../m3d/manifest.json', import.meta.url), 'utf8')).maps;

test('health keeps unknown, unknown maximum and zero apart and never invents 100', () => {
  assert.equal(M.hpInfo(null).state, 'unknown');
  assert.equal(M.hpInfo(null).text, '血量未知');
  const nomax = M.hpInfo({ total: [95, null] });   // 真实后端 AI 样本
  assert.equal(nomax.state, 'nomax'); assert.equal(nomax.frac, null); assert.equal(nomax.short, '95/?');
  assert.match(nomax.text, /上限未知/);
  const zero = M.hpInfo({ total: [0, 100] });
  assert.equal(zero.state, 'zero'); assert.equal(zero.frac, 0); assert.equal(M.hpColorKey(zero), 'zero');
  const known = M.hpInfo({ total: [47.37, 100], max_source: 'operator_default' });
  assert.equal(known.text, '47.4/100'); assert.equal(known.maxSource, 'operator_default');
  assert.equal(M.hpColorKey(known), 'mid');
  // 只有部位数值、没有总量：总量仍是未知，不把部位相加
  assert.equal(M.hpInfo({ head: [40, 40], thorax: [50, 50] }).state, 'unknown');
  // 部位缺上限时不能用默认上限补齐
  assert.equal(M.hpWorstPart({ head: [20, null], thorax: [25, 50] }).k, 'thorax');
  assert.equal(M.hpWorstPart({ head: [20, null] }), null);
});

test('current weapon only comes from resolved curr_weapon, never the spawn loadout', () => {
  const ai = { weapon: '空手', curr_weapon: 'UZI', curr_weapon_status: 'resolved' };   // 真实后端样本
  assert.equal(M.weaponInfo(ai).text, 'UZI'); assert.equal(M.weaponInfo(ai).initial, '空手');
  const pending = M.weaponInfo({ weapon: 'M4A1', curr_weapon: null, curr_weapon_status: 'pending' });
  assert.equal(pending.kind, 'unresolved'); assert.equal(pending.model, null); assert.equal(pending.initial, 'M4A1');
  assert.equal(M.weaponInfo({ weapon: 'M4A1', curr_weapon_known: true, curr_weapon_status: 'empty' }).kind, 'unresolved');
  assert.equal(M.weaponInfo({ curr_weapon: '空手', curr_weapon_status: 'resolved' }).kind, 'empty');
  const unlisted = M.weaponInfo({ curr_weapon: '武器 18100000029', curr_weapon_id: 18100000029, curr_weapon_status: 'resolved' });
  assert.equal(unlisted.kind, 'unlisted'); assert.equal(unlisted.id, '18100000029');
  assert.equal(M.weaponInfo({ curr_weapon: '战术匕首', curr_weapon_status: 'resolved' }).kind, 'melee');
  assert.equal(M.weaponInfo({ curr_weapon: '台钓竿', curr_weapon_status: 'resolved' }).kind, 'rod');
  assert.equal(M.selfWeaponInfo({}).kind, 'unresolved');
  assert.equal(M.selfWeaponInfo({ self_weapon: 'MP5', self_weapon_status: 'resolved' }).text, 'MP5');
  assert.equal(M.selfWeaponInfo({ self_weapon: 'MP5', self_weapon_status: 'pending' }).kind, 'unresolved');
});

test('identity, position freshness and pose are only claimed with evidence', () => {
  assert.equal(M.identityOf({ kind: 'unknown', name: '未知玩家' }).kind, 'unknown');
  assert.equal(M.identityOf({ kind: 'player', name: 'x' }).kind, 'unresolved');
  assert.equal(M.identityOf({ kind: 'player', hero: '威龙' }).label, '威龙');
  assert.equal(M.freshnessOf({ kind: 'ai', spawn_mark: true, age_sec: 34.1 }).kind, 'spawn');
  assert.equal(M.freshnessOf({ kind: 'player', out_of_range: true }).kind, 'far');
  assert.equal(M.freshnessOf({ kind: 'player', out_of_range: false }).kind, 'live');
  assert.equal(M.poseLabel({ pose: { movement: 'swim' } }), '游泳');
  assert.equal(M.poseLabel({ pose: { crouched: true } }), '蹲伏');
  assert.equal(M.poseLabel({ pose: { prone: true } }), '趴下');
  assert.equal(M.poseLabel({ pose: { movement: 'fall' } }), '下落');
  assert.equal(M.poseLabel({ status_key: 'down', pose: { movement: 'swim' } }), '倒地');
  assert.equal(M.poseLabel({ dead: true }), '阵亡');
  // 速度不能单独证明游泳；持竿不等于抛竿
  assert.equal(M.poseLabel({ speed: 0.4 }), null);
  assert.equal(M.poseLabel({ curr_weapon: '台钓竿' }), null);
  assert.equal(M.selfPoseLabel({ self_life: { downed: true } }), '倒地');
  assert.equal(M.aimState({ self_aim_yaw: 10, self_aim_age_ms: 0 }).kind, 'fresh');
  assert.equal(M.aimState({ self_aim_yaw: 10, self_aim_age_ms: 600, self_yaw: 12 }).kind, 'stale');
  assert.equal(M.aimState({ self_yaw: 12 }).kind, 'body');
});

test('counts are known targets and the nearest enemy must be a live position', () => {
  const ents = [
    { kind: 'player', rel: [3300, 0, 0] },
    { kind: 'player', rel: [1000, 0, 0], out_of_range: true },
    { kind: 'player', rel: [800, 0, 0], dead: true },
    { kind: 'player', rel: [900, 0, 0], status_key: 'down' },
    { kind: 'ai', rel: [300, 0, 0], spawn_mark: true },
    { kind: 'mate', rel: [200, 0, 0] }, { kind: 'unknown', rel: [500, 0, 0] }, { kind: 'box' },
  ];
  const c = M.countsOf(ents);
  assert.deepEqual([c.players, c.alive, c.down, c.dead, c.mates, c.ai, c.unknown, c.boxes], [4, 2, 1, 1, 1, 1, 1, 1]);
  const foe = M.nearestFoe(ents, 0);
  assert.equal(foe.d, 9); assert.equal(foe.dir, '前');
  assert.equal(M.nearestFoe([{ kind: 'ai', rel: [100, 0, 0], spawn_mark: true }], 0), null);
  assert.equal(M.bearingOf({ rel: [0, 1000, 0] }, 0), '右');
  assert.equal(M.bearingOf({ rel: [-1000, 0, 0] }, 0), '后');
  assert.equal(M.bearingOf({ rel: [1000, 0, 0] }, NaN), '');
  assert.equal(M.heightTxt(-10.4), '↓10m'); assert.equal(M.heightTxt(0.2), '同层');
});

test('map inference uses own position first and needs a clear majority of characters otherwise', () => {
  assert.equal(M.inferSnapshotMap({ self: [335449, -774915.4, -16003.9] }, manifest), 'daba');   // 真实后端快照
  const pts = [[369599, -763773.5, -16963.7], [330907.2, -773857.4, -17047], [358517.8, -774390.6, -19310.8]];
  assert.equal(M.inferEntitiesMap({ self: null, entities: pts.map(world => ({ kind: 'player', world })) }, manifest), 'daba');
  assert.equal(M.inferEntitiesMap({ self: null, entities: pts.slice(0, 2).map(world => ({ kind: 'player', world })) }, manifest), null);
  assert.equal(M.inferEntitiesMap({ self: null, entities: [...pts, [0, 0, 0], [1e9, 1e9, 0]].map(world => ({ kind: 'player', world })) }, manifest), null);
});

test('live status follows request results, live_active and content changes without inventing enums', () => {
  const mon = M.createLiveMonitor();
  assert.equal(mon.state(0).key, 'connecting');
  mon.fail(new Error('HTTP 503'), 100);
  assert.equal(mon.state(200).key, 'error');
  const waiting = { cursor: { live: false, seq: 0 }, entities: [], live_active: false, self: null, status: 'waiting' };   // 真实后端空闲态
  mon.ok(waiting, true, 1000);
  assert.equal(mon.state(1100).key, 'waiting');
  const live = { live_active: true, self: [1, 2, 3], entities: [{ kind: 'player' }] };
  for (let t = 2000; t <= 3000; t += 50) mon.ok(live, true, t);
  const s = mon.state(3010);
  assert.equal(s.key, 'live'); assert.ok(s.rate >= 10, 'rate counts content changes'); assert.equal(s.selfOk, true);
  mon.ok(null, false, 4000); mon.ok(null, false, 5000);
  assert.equal(mon.state(5900).key, 'live');
  assert.equal(mon.state(6100).key, 'stalled', 'no new content for 3 s');
  mon.fail(new Error('timeout'), 6200);
  const err = mon.state(6300);
  assert.equal(err.key, 'error'); assert.match(err.detail, /最近成功/);
  mon.ok({ live_active: false, status: 'replay', self: [1, 2, 3], entities: [{ kind: 'player' }] }, true, 7000);
  const nonlive = mon.state(7100);
  assert.equal(nonlive.key, 'nonlive'); assert.match(nonlive.detail, /replay/);
  mon.ok({ live_active: true, self: null, entities: [] }, true, 8000);
  assert.equal(mon.state(8100).selfOk, false);
});
