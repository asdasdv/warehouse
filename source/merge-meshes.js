import * as T from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';

// Fewer draw calls: the meshes under `root` that share a material become one mesh each.
// `keep(mesh)` leaves a mesh alone (animated parts). Merged meshes are added to `root`, in its space.
export function mergeByMaterial(root, keep = () => false, {castShadow = true} = {}) {
  root.updateMatrixWorld(true);
  const toRoot = new T.Matrix4().copy(root.matrixWorld).invert(), groups = new Map(), merged = [];
  root.traverse(o => {
    if (!o.isMesh || o.isInstancedMesh || keep(o) || !o.visible) return;
    if (!groups.has(o.material)) groups.set(o.material, []);
    groups.get(o.material).push(o);
  });
  for (const [material, meshes] of groups) {
    const geometries = meshes.map(m => {
      let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      g.applyMatrix4(new T.Matrix4().multiplyMatrices(toRoot, m.matrixWorld));
      return g;
    });
    // Only attributes every piece has can be merged.
    const names = Object.keys(geometries[0].attributes).filter(n => geometries.every(g => g.attributes[n]));
    for (const g of geometries) { for (const n of Object.keys(g.attributes)) if (!names.includes(n)) g.deleteAttribute(n); g.morphAttributes = {}; }
    const geometry = mergeGeometries(geometries, false);
    for (const g of geometries) g.dispose();
    if (!geometry) continue;
    for (const m of meshes) m.parent.remove(m);
    const mesh = new T.Mesh(geometry, material);
    mesh.castShadow = castShadow; mesh.receiveShadow = true;
    root.add(mesh); merged.push(mesh);
  }
  // Empty groups left behind are dropped too.
  const empty = [];
  root.traverse(o => { if (o !== root && !o.isMesh && !o.isSprite && !o.children.length) empty.push(o); });
  for (const o of empty) o.parent?.remove(o);
  return merged;
}
