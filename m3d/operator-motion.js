const clamp = x => Math.max(0, Math.min(1, x));
export function hasHeldWeapon(source) {
  return typeof source?.weapon === 'string' && source.weapon.trim() !== '' && !/空手|未知|未识别|none|unarmed/i.test(source.weapon);
}
export function operatorState(source) {
  if (source?.dead || source?.alive === false) return 'Death';
  if (source?.status_key === 'down' || source?.status_key === 'dying') return 'Crouch';
  return 'moving';
}
export function locomotionWeights(speed, forward = 1, left = 0) {
  const moving = clamp(speed / 1.8), run = clamp((speed - 2.2) / 2), sprint = clamp((speed - 4.5) / 2);
  const walk = moving * (1 - run), sum = Math.abs(forward) + Math.abs(left) || 1;
  return { Idle: 1-moving, Walk: walk*Math.max(0,forward)/sum, Backward: walk*Math.max(0,-forward)/sum,
    Left: walk*Math.max(0,left)/sum, Right: walk*Math.max(0,-left)/sum, Run: moving*run*(1-sprint), Sprint: moving*run*sprint };
}
export const animationStep = (distance, quality) => quality==='high'
  ? distance < 60 ? 1/60 : distance < 160 ? 1/24 : 1/12
  : distance < 60 ? 1/30 : distance < 160 ? 1/12 : 1/8;
