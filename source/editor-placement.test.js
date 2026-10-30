import test from 'node:test';
import assert from 'node:assert/strict';
import {seed,addZone,addRack} from './model.js';
import {applyLayoutEdit} from './layout-edit.js';
import {keepoutAt,layoutKeepouts} from './storage.js';
import {docksOf,dockRect} from './docks.js';

const large=()=>{const s=seed('large');docksOf(s);return s;};

test('the seeded layout keeps every rack clear of conveyors, docks and buildings',()=>{
 const s=large();
 assert.ok(layoutKeepouts(s).some(k=>k.id==='the conveyor'));
 assert.deepEqual(s.racks.filter(r=>keepoutAt(s,r.x,r.z,r)).map(r=>r.id),[]);
});
test('racks cannot be placed, moved, rotated or duplicated onto the conveyor',()=>{
 const s=large();
 // A zone drawn across the conveyor between two docks (x = -60 and 0).
 const zone=addZone(s,{x:-50,z:-30,w:40,d:60});
 assert.throws(()=>addRack(s,zone,-30,0),/conveyor/);
 assert.throws(()=>addRack(s,zone,-30,4),/conveyor/);
 const id=addRack(s,zone,-30,5.5);
 // Moving onto the belt, turning it so its long side reaches the belt, or copying it onto the belt all fail.
 assert.throws(()=>applyLayoutEdit(s,{type:'move',ids:[id],dx:0,dz:-5}),/conveyor/);
 assert.throws(()=>applyLayoutEdit(s,{type:'rotate',ids:[id]}),/conveyor/);
 assert.throws(()=>applyLayoutEdit(s,{type:'copy',ids:[id],dx:0,dz:-5.5}),/conveyor/);
 assert.doesNotThrow(()=>applyLayoutEdit(s,{type:'move',ids:[id],dx:0,dz:10}));
});
test('racks keep clear of a dock belt and its robot port',()=>{
 const s=large(),d=docksOf(s).find(d=>d.id==='Receiving 1'),b=dockRect(d);
 const zone=addZone(s,{x:d.x-20,z:-35,w:40,d:32});
 assert.throws(()=>addRack(s,zone,b.x,b.z),/Receiving 1/);
 assert.throws(()=>addRack(s,zone,d.x,-20),/Receiving 1/);   // robot port at z = -18
 assert.ok(addRack(s,zone,d.x-12,-25));
});
test('racks keep clear of the receiving and dispatch buildings',()=>{
 const s=large(),x=s.spine.x1-7;
 const zone=addZone(s,{x:x-20,z:-30,w:40,d:26});
 assert.throws(()=>addRack(s,zone,x,-8),/receiving building/);
});
