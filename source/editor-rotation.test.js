import test from 'node:test';
import assert from 'node:assert/strict';
import {addZone,addRack} from './model.js';
import {applyLayoutEdit} from './layout-edit.js';

const footprint=r=>({x:r.x,z:r.z,width:r.width,depth:r.depth});
const setup=()=>{const s={zones:[],racks:[],boxes:[],history:[]},zone=addZone(s,{x:0,z:0,w:40,d:40});
 // 6 × 4 m racks: the neighbour sits 1.5 m behind the first one along its depth.
 const id=addRack(s,zone,20,10),other=addRack(s,zone,20,15.5);return {s,id,other};};

test('a quarter turn next to a close neighbour is still refused',()=>{
 const {s,id}=setup();
 assert.throws(()=>applyLayoutEdit(s,{type:'rotate',ids:[id]}),/1 m between racks/);
 assert.throws(()=>applyLayoutEdit(s,{type:'rotate',ids:[id],turns:3}),/1 m between racks/);
});
test('a half turn validates only the final pose: same footprint, rotation 2',()=>{
 const {s,id,other}=setup(),r=s.racks.find(r=>r.id===id),before=footprint(r),neighbour=JSON.stringify(s.racks.find(r=>r.id===other));
 assert.doesNotThrow(()=>applyLayoutEdit(s,{type:'rotate',ids:[id],turns:2}));
 const after=s.racks.find(r=>r.id===id);
 assert.deepEqual(footprint(after),before);assert.equal(after.rotation,2);
 assert.equal(JSON.stringify(s.racks.find(r=>r.id===other)),neighbour);
});
test('turns are taken modulo four and default to one',()=>{
 const s={zones:[],racks:[],boxes:[],history:[]},zone=addZone(s,{x:0,z:0,w:40,d:40}),id=addRack(s,zone,20,20);
 const one={...s,racks:s.racks.map(r=>({...r}))},four={...s,racks:s.racks.map(r=>({...r}))};
 applyLayoutEdit(one,{type:'rotate',ids:[id]});applyLayoutEdit(four,{type:'rotate',ids:[id],turns:5});
 assert.deepEqual(one.racks,four.racks);
 const r=one.racks[0];assert.equal(r.rotation,1);assert.deepEqual([r.width,r.depth],[4,6]);
 applyLayoutEdit(one,{type:'rotate',ids:[id],turns:4});assert.deepEqual(one.racks,four.racks);
});
