import test from 'node:test';
import assert from 'node:assert/strict';
import {boxLayout,templates} from './storage.js';
import {rackParts} from './rack-geometry.js';
import {shelfBase} from './rack-levels.js';
const boxes=n=>Array.from({length:n},(_,i)=>({id:String(i),location:'S1-P1'}));
test('carton dimensions are stable across differently occupied addresses',()=>{
 const r={...templates.standard,x:0,z:0};
 const one=boxLayout(r,boxes(1))[0];
 for(const count of [2,4,7,14])for(const pose of boxLayout(r,boxes(count))){
  for(const key of ['w','h','d'])assert.equal(pose[key],one[key]);
  assert.ok(Math.abs(pose.d/pose.w-1.2)<1e-8);
 }
});
test('dense and rotated loads fit shelves without overlapping cartons',()=>{
 for(const template of Object.values(templates))for(const rotation of [0,1,2,3])for(const count of [1,14,32]){
  const r={...template,rotation,x:0,z:0},poses=boxLayout(r,boxes(count));
  for(let i=0;i<poses.length;i++){
   const a=poses[i];assert.ok(a.y+a.h/2<shelfBase(r,1));
   assert.ok(Math.abs(a.x)+a.w/2<r.width/2);assert.ok(Math.abs(a.z)+a.d/2<r.depth/2);
   for(const b of poses.slice(i+1))assert.ok(Math.abs(a.x-b.x)>=(a.w+b.w)/2-1e-7||Math.abs(a.y-b.y)>=(a.h+b.h)/2-1e-7||Math.abs(a.z-b.z)>=(a.d+b.d)/2-1e-7);
  }
 }
});
test('pallet bottoms are separated from steel deck tops',()=>{
 for(const r of Object.values(templates)){
  const parts=rackParts(r),decks=parts.filter(p=>p.kind==='deck'),pallets=parts.filter(p=>p.kind==='pallet');
  pallets.forEach((p,i)=>assert.ok(p.p[1]-p.size[1]/2-(decks[i].p[1]+decks[i].size[1]/2)>.01));
 }
});
