import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {seed} from './model.js';
import {inventorySnapshot} from './inventory-page.js';
import {addWarehouseRobots} from './warehouse-robots.js';
globalThis.document={createElement:()=>({getContext:()=>({fillRect(){},fillText(){}})})};
test('box handoffs preserve identity and vacant shelf positions',()=>{
 const state=seed(),originalCount=state.boxes.length,sim=addWarehouseRobots(new T.Scene(),()=>state);
 let loading=0,delivery=0,relocation=0;
 for(let i=0;i<2600;i++){
  const before=sim.robots.map(r=>({r,stage:r.stage,task:r.task}));
  sim.update(.1);
  for(const {r,stage,task} of before){
   if(r.task&&r.stage==='Loading'&&r.timer>0){
    loading++;assert.equal(sim.displayLayout().some(p=>p.box.id===r.boxId),false);
    assert.equal(sim.visualState(state).boxes.some(b=>b.id===r.boxId),false);
    assert.equal(r.cargo.visible,true);
   }
   if(task&&stage==='Unloading'&&!r.task){
    delivery++;assert.equal(r.cargo.visible,false);
    if(task.target){relocation++;const p=sim.displayLayout().find(p=>p.box.id===task.box.id);assert.equal(p.box.rack,task.target.id);assert.equal(p.x,task.drop.x);}
   }
  }
 }
 assert.ok(loading);assert.ok(delivery);assert.ok(relocation);
 assert.equal(state.boxes.length,originalCount);
});

test('continuous receiving, storage and shipping with bounded queues and pause',()=>{
 const state=seed(),original=JSON.stringify(state),sim=addWarehouseRobots(new T.Scene(),()=>state);
 let sawNewOnShelf=false,sawNewOutbound=false,newOrder=null;
 for(let i=0;i<6000;i++){
  sim.update(.1);
  if(i%100===0){
   const fresh=sim.displayLayout().find(p=>p.box.id.startsWith('IN-')&&sim.boxInfo(p.box.id)?.actionable);sawNewOnShelf ||= !!fresh;if(fresh&&!newOrder)newOrder=sim.book.create(fresh.box.product,1,'Urgent',fresh.box.id);
   sawNewOutbound ||= sim.stations.some(s=>s.kind==='outbound'&&s.queue.some(q=>q.box.id.startsWith('IN-')));
   assert.ok(sim.stations.every(s=>s.queue.length<=6));
   const d=sim.dashboard(state);
   assert.equal(d.onSite,Object.values(d.counts).reduce((a,b)=>a+b,0));
   assert.equal(d.onSite,state.boxes.length+(d.today.received-state.today.received)-(d.today.shipped-state.today.shipped));
   assert.equal(d.boxes.length,d.counts.stored);
   assert.equal(inventorySnapshot(state,sim).boxes.length,d.onSite);
   assert.ok(d.history.length>=state.history.length);

  }
 }
 assert.ok(sim.flow.received>0);assert.ok(sim.flow.shipped>0);assert.ok(sawNewOnShelf);assert.ok(sawNewOutbound);
 sim.toggle();const paused=JSON.stringify(sim.flow);for(let i=0;i<300;i++)sim.update(.1);assert.equal(JSON.stringify(sim.flow),paused);
 assert.equal(JSON.stringify(state),original);
});

test('manual transfer and reversible scenarios do not invent shipping orders',()=>{
 const state=seed();state.racks=state.racks.slice(0,6);state.racks.forEach((r,i)=>{r.x=i*18;r.z=0;});state.boxes=state.boxes.filter(b=>b.rack===state.racks[0].id).slice(0,4);
 const sim=addWarehouseRobots(new T.Scene(),()=>state);sim.displayLayout();sim.book.clear();
 const id=state.boxes[0].id,target=state.racks[5].id;sim.requestMove(id,target);
 for(let i=0;i<1400;i++)sim.update(.1);
 assert.equal(sim.boxInfo(id).rack,target);assert.equal(sim.flow.shipped,0);
 sim.scenario('Large delivery');assert.equal(sim.flow.bulkRemaining,24);
 sim.scenario('Robot unavailable');assert.equal(sim.flow.unavailable,1);
 sim.scenario('Shipping peak');assert.equal(sim.book.orders[0].priority,'Urgent');
 for(let i=0;i<15;i++)sim.update(.1);
 sim.scenario('Blocked aisle');assert.equal(sim.flow.blockedAisle,true);
 sim.scenario('Restore');assert.equal(sim.flow.blockedAisle,false);assert.equal(sim.flow.unavailable,0);assert.equal(sim.flow.bulkRemaining,0);
});
