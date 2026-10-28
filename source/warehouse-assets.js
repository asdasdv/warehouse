import * as T from 'three';
import models from './assets/warehouse-models.json' with {type:'json'};

// Shared normalized Blender geometry: one GPU allocation per material, not per box.
export const assetParts = Object.fromEntries(Object.entries(models).map(([key, asset]) => [key, asset.parts.map(part => {
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.Float32BufferAttribute(part.positions, 3));
  geometry.setAttribute('normal', new T.Float32BufferAttribute(part.normals, 3));
  geometry.setIndex(part.indices);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  const p = part.material;
  const material = new T.MeshStandardMaterial({color:new T.Color(...p.color), metalness:p.metalness, roughness:p.roughness,
    emissive:new T.Color(...(p.emissive || [0,0,0])), emissiveIntensity:Math.min(p.emissiveIntensity || 0, 2)});
  material.name=p.name;
  material.envMapIntensity=key==='robot'?1:.25;
  if(key==='pallet') {
    material.onBeforeCompile=shader=>{
      shader.vertexShader='varying vec3 timberPosition;\n'+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\ntimberPosition=position;');
      shader.fragmentShader='varying vec3 timberPosition;\n'+shader.fragmentShader;
      shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
        float phase=timberPosition.x*420.0+sin(timberPosition.z*22.0)*2.5;
        float grain=sin(phase)*(1.0-smoothstep(.7,3.0,fwidth(phase)));
        diffuseColor.rgb*=.94+.06*grain;`);
    };
    material.customProgramCacheKey=()=> 'blender-timber-v1';
  }
  return {geometry,material};
})]));
export const assetGeometries=new Set(Object.values(assetParts).flat().map(p=>p.geometry));
export const assetMaterials=new Set(Object.values(assetParts).flat().map(p=>p.material));
export function assetObject(key) {
  const group=new T.Group(); group.name=`Blender ${key}`;
  for(const part of assetParts[key]) {
    const mesh=new T.Mesh(part.geometry,part.material);mesh.castShadow=true;mesh.receiveShadow=true;group.add(mesh);
  }
  return group;
}
export function cartonObject(parent,x,y,z,w,h,d) {
  const group=assetObject('carton');group.position.set(x,y,z);group.scale.set(w,h,d);parent.add(group);return group;
}
export function robotObject(parent) {
  const group=assetObject('robot');
  // Preserve the router footprint and the existing 1.5-unit cargo support height.
  group.scale.set(2.6,1.5,3.2);group.position.y=.75;parent.add(group);return group;
}
