import test from 'node:test';
import assert from 'node:assert/strict';
import {addZone,addRack,log} from './model.js';
import {applyLayoutEdit,createSessionLog} from './layout-edit.js';

// The editor's draft history, reduced to what it does with History: each applied edit keeps the entries it logged,
// Undo/Redo take them out and put them back, a failed edit and Discard leave no trace.
function editor(s){
 const session=createSessionLog(()=>s),undo=[],redo=[],snap=()=>JSON.stringify({zones:s.zones,racks:s.racks});
 const restore=j=>{const v=JSON.parse(j);s.zones=v.zones;s.racks=v.racks;};let baseline;
 return {
  open(){baseline=snap();session.clear();undo.length=redo.length=0;},
  apply(fn){const before=snap(),top=s.history[0];try{fn();}catch{restore(before);session.forget(top);return false;}undo.push({snap:before,logs:session.take(top)});redo.length=0;return true;},
  undo(){const i=undo.pop();redo.push({snap:snap(),logs:i.logs});restore(i.snap);session.drop(i.logs);},
  redo(){const i=redo.pop();undo.push({snap:snap(),logs:i.logs});restore(i.snap);session.put(i.logs);},
  discard(){restore(baseline);session.discard();},
 };
}
const types=s=>s.history.map(e=>e.type+(e.detail?' · '+e.detail:''));

test('undo removes the entry of the edit it takes back, redo restores it',()=>{
 const s={zones:[],racks:[],boxes:[],history:[]};log(s,'Box received','B1');
 const ed=editor(s);ed.open();
 let zone;ed.apply(()=>{zone=addZone(s,{x:0,z:0,w:40,d:40});});
 let rack;ed.apply(()=>{rack=addRack(s,zone,10,10);});
 assert.deepEqual(types(s),[`Rack added · ${rack}`,`Zone created · Zone ${zone}`,'Box received · B1']);
 ed.undo();assert.deepEqual(types(s),[`Zone created · Zone ${zone}`,'Box received · B1']);assert.equal(s.racks.length,0);
 ed.redo();assert.deepEqual(types(s),[`Rack added · ${rack}`,`Zone created · Zone ${zone}`,'Box received · B1']);
});
test('discard removes every entry of the session, including «Layout updated · move» from the 3D tools',()=>{
 const s={zones:[],racks:[],boxes:[],history:[]};const zone=addZone(s,{x:0,z:0,w:40,d:40}),rack=addRack(s,zone,10,10);
 const before=types(s),ed=editor(s);ed.open();
 ed.apply(()=>{applyLayoutEdit(s,{type:'move',ids:[rack],dx:5,dz:0});log(s,'Layout updated','move');});
 ed.apply(()=>{addRack(s,zone,10,25);});
 // Something unrelated happens meanwhile (robots keep working while the editor is open).
 log(s,'Box stored','B9');
 ed.discard();
 assert.deepEqual(types(s),['Box stored · B9',...before]);
 assert.equal(s.racks.find(r=>r.id===rack).x,10);
});
test('a failed edit leaves no entry behind',()=>{
 const s={zones:[],racks:[],boxes:[],history:[]};const zone=addZone(s,{x:0,z:0,w:40,d:40});
 const before=types(s),ed=editor(s);ed.open();
 assert.equal(ed.apply(()=>{addRack(s,zone,10,10);addRack(s,zone,10,10);}),false);
 assert.deepEqual(types(s),before);assert.equal(s.racks.length,0);
});
