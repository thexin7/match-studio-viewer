import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Only a held-weapon marker: the feed does not contain attachment geometry.
let geometry, material;
export function createOperatorRifle(occludedMaterial) {
  if (!geometry) {
    const parts = [
      [[.43,.055,.075],[.12,0,.07]],
      [[.23,.045,.09],[-.21,0,.05]],
      [[.26,.018,.018],[.455,0,.078]],
      [[.045,.035,.12],[-.035,0,-.015]],
      [[.075,.045,.16],[.105,0,-.045]],
    ].map(([size,position]) => new THREE.BoxGeometry(...size).translate(...position));
    geometry = mergeGeometries(parts,false);
    for (const part of parts) part.dispose();
    material = new THREE.MeshLambertMaterial({color:0x202724,transparent:true,depthWrite:true});
  }
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(geometry,material);mesh.renderOrder=1002;
  mesh.userData={radarLitSurface:true,radarEntitySurface:true};root.add(mesh);
  const shell = new THREE.Mesh(geometry,occludedMaterial);shell.renderOrder=1001;
  shell.userData.radarExcludeFromSsao=true;root.add(shell);
  return root;
}
export const RIFLE_RIGHT_GRIP = [-.02,0,-.07];
