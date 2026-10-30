import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';

// Blender exports in public/assets/models (metres, Y-up, origin on the floor).
// The scene keeps its simple meshes until a model arrives, so a missing file only costs the detail.
const cache = new Map();
export function loadModel(name) {
  if (typeof document === 'undefined') return Promise.resolve(null);
  if (!cache.has(name)) cache.set(name, new GLTFLoader().loadAsync(`${import.meta.env?.BASE_URL ?? '/'}assets/models/${name}.glb`)
    .then(gltf => {
      gltf.scene.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      return gltf.scene;
    })
    .catch(error => { console.warn(`Model ${name} did not load`, error); return null; }));
  return cache.get(name);
}

// A copy scaled so its bounding box fits `size` ({w, h, d}); geometry and materials stay shared.
export function fitted(model, size) {
  const copy = model.clone(true), box = new T.Box3().setFromObject(copy), s = box.getSize(new T.Vector3());
  copy.scale.set(size.w / s.x, size.h / s.y, size.d / s.z);
  copy.position.set(-(box.min.x + box.max.x) / 2 * copy.scale.x, -box.min.y * copy.scale.y, -(box.min.z + box.max.z) / 2 * copy.scale.z);
  const wrap = new T.Group(); wrap.add(copy); return wrap;
}
