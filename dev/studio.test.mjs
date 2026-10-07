import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveHUD, defaultStudio, ProximityEvents, replayInfo } from '../ui/studio/model.js';

const unit = (key, x, team = 2) => ({ key, kind: 'player', world: [x, 0, 0], team, name: key, yaw: 0 });
const snapshot = { self: [0, 0, 0], self_name: '观察者', self_team: 1, self_yaw: 0, entities: [unit('near', 5700), unit('far', 20000), unit('mate', 500, 1)] };
test('distance uses centimeters, excludes allies and never invents health or occlusion', () => {
  const hud = deriveHUD(snapshot, defaultStudio());
  assert.equal(hud.threats.length, 1);
  assert.equal(hud.threats[0].distance, 57);
  assert.equal(hud.threats[0].direction, '前');
  assert.equal(hud.observer.health, null);
  assert.equal(hud.threats[0].occluded, undefined);
});
test('observing an opponent rebases distance, direction and teams', () => {
  const hud = deriveHUD(snapshot, { ...defaultStudio(), observer: 'near' });
  assert.ok(hud.threats.some(e => e.key === '__self' && e.distance === 57));
  assert.ok(!hud.threats.some(e => e.key === 'far'));
  assert.equal(hud.threats.find(e => e.key === '__self').direction, '后');
});
test('alert distance and radar range are independent of the opponent-list filter', () => {
  const hud = deriveHUD(snapshot, { ...defaultStudio(), prefs: { alert: 80, warnd: 30, radarr: 150 } });
  assert.equal(hud.threats.length, 0);
  assert.equal(hud.nearby.length, 1);
  assert.equal(hud.opponents[0].distance, 57);
});
test('missing observation target does not silently use another player', () => {
  assert.equal(deriveHUD(snapshot, { ...defaultStudio(), observer: 'gone' }).observer, null);
  assert.deepEqual(deriveHUD({ ...snapshot, self: null }, defaultStudio()).threats, []);
});
test('replay controls accept host seconds and fixture milliseconds without guessing units', () => {
  assert.equal(replayInfo({ replay: { position: 120, duration: 500 } }).position, 120);
  assert.equal(replayInfo({ replay: { positionMs: 120000, durationMs: 500000 } }).duration, 500);
  assert.equal(replayInfo({ replay: {} }).position, null);
});
test('a confirmed dead observer cannot produce live proximity information', () => {
  assert.equal(deriveHUD({ ...snapshot, self_life: { dead: true } }, defaultStudio()).observer, null);
});
test('dead, stale, non-character and nonfinite positions cannot trigger proximity alerts', () => {
  const entities = [{ ...unit('dead', 100), dead: true }, { ...unit('stale', 100), out_of_range: true }, { ...unit('box', 100), kind: 'box' }, unit('bad', NaN)];
  assert.equal(deriveHUD({ ...snapshot, entities }, defaultStudio()).threats.length, 0);
});
test('proximity history resets on observer/session/rewind and does not invent initial entry events', () => {
  const events = new ProximityEvents();
  const settings = defaultStudio();
  const far = { ...snapshot, flow: 'one', replay: { position: 20 }, entities: [unit('enemy', 20000)] };
  events.update(far, settings, 0);
  const close = { ...far, replay: { position: 21 }, entities: [unit('enemy', 5700)] };
  assert.equal(events.update(close, settings, 1000).length, 1);
  assert.equal(events.update(close, settings, 2000).length, 1);
  assert.equal(events.update({ ...close, replay: { position: 1 } }, settings, 3000).length, 0);
  assert.equal(events.update({ ...close, flow: 'two' }, settings, 4000).length, 0);
  assert.equal(events.update({ ...close, flow: 'two', replay: { position: 200 } }, settings, 4100).length, 0, 'forward seek');
});
