import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {assetParts,robotObject,cartonObject} from './warehouse-assets.js';
import {rackParts} from './rack-geometry.js';
import {boxLayout,templates} from './storage.js';
import {shelfBase,palletHeight,palletBaseOffset} from './rack-levels.js';

test('Blender meshes have valid indexed triangles and normalized complete bounds',()=>{
 for(const [name,parts] of Object.entries(assetParts)) {
  const bounds=new T.Box3();
  for(const {geometry:g} of parts){
   assert.equal(g.index.count%3,0);assert.equal(g.attributes.normal.count,g.attributes.position.count);
   for(const index of g.index.array)assert.ok(index<g.attributes.position.count);
   for(const value of g.attributes.position.array)assert.ok(Number.isFinite(value));
   bounds.union(g.boundingBox);
  }
  for(const axis of ['x','y','z']){assert.ok(Math.abs(bounds.min[axis]+.5)<1e-5,name);assert.ok(Math.abs(bounds.max[axis]-.5)<1e-5,name);}
 }
});
test('cartons sit on pallet tops and remain below the next shelf',()=>{
 for(const template of Object.values(templates))for(const rotation of [0,1,2,3]){
  const r={...template,x:0,z:0,rotation};
  const parts=rackParts(r),pallets=parts.filter(p=>p.kind==='pallet');
  assert.equal(pallets.length,r.shelves*r.places);
  for(let shelf=1;shelf<=r.shelves;shelf++){
   const pose=boxLayout(r,[{id:'test',location:`S${shelf}-P1`}])[0];
   assert.ok(Math.abs(pose.y-pose.h/2-(shelfBase(r,shelf-1)+palletBaseOffset+palletHeight(r)))<1e-7);
   assert.ok(pose.y+pose.h/2<shelfBase(r,shelf));
  }
 }
});
test('robot cargo rests on the platform and clones share the Blender resources',()=>{
 const parent=new T.Group(),robot=robotObject(parent),box=cartonObject(parent,0,2,0,1,1,1),copy=cartonObject(parent,0,2,0,1,1,1);
 parent.updateMatrixWorld(true);
 const platform=new T.Box3().setFromObject(robot),cargo=new T.Box3().setFromObject(box);
 assert.ok(Math.abs(platform.max.y-cargo.min.y)<1e-6);
 box.children.forEach((part,i)=>{assert.equal(part.geometry,copy.children[i].geometry);assert.equal(part.material,copy.children[i].material);});
 assert.ok(assetParts.robot.some(p=>p.material.emissiveIntensity>0));
});
