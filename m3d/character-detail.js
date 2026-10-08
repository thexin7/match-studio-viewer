import { OPERATOR_MODELS } from './operator-catalog.js?v=1.3.0';
export { OPERATOR_MODELS };

export function isEnemyOfViewer(viewer, source, isSelf = false) {
  if (!source || isSelf && (!viewer || viewer.self)) return false;
  if (!viewer || viewer.self) return source.kind === 'player' || source.kind === 'ai';
  if (source.key === viewer.key) return false;
  if (viewer.ai) return source.kind !== 'ai';
  if (source.kind === 'ai') return true;
  const team = isSelf ? viewer.selfTeam
    : source.kind === 'mate' ? (viewer.selfTeam || Number(source.team) || 0) : (Number(source.team) || 0);
  return !(viewer.team > 0 && team === viewer.team);
}

export function operatorDefinition(hero, catalog = OPERATOR_MODELS) {
  const key = typeof hero === 'string' ? hero.trim() : '';
  return key && Object.hasOwn(catalog, key) ? catalog[key] : null;
}

// CSS pixels account for zoom, field of view and viewport size. Separate enter /
// leave thresholds keep camera movement from flickering between representations.
export function characterDetail(pixels, previous = -1, quality = 'balanced') {
  const threshold=quality==='performance' ? (previous===0?64:80) : quality==='high' ? (previous===0?28:36) : (previous===0?40:56);
  if (pixels >= threshold) return 0;
  if (pixels >= (previous === 2 ? 17 : 11)) return 1;
  return 2;
}
