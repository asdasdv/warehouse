import test from 'node:test';
import assert from 'node:assert/strict';
import {addZone,addRack,checkZoneName,freeZoneName} from './model.js';
import {createSessionLog,deleteRacks,deleteZone} from './layout-edit.js';

// The 2D editor's draft, reduced to what it does with History (same rules as layout-editor.js apply/step/cancel).
function editor(s){
 const session=createSessionLog(()=>s),undo=[],redo=[],snap=()=>JSON.stringify({zones:s.zones,racks:s.racks});
 const restore=j=>{const v=JSON.parse(j);s.zones=v.zones;s.racks=v.racks;};const baseline=snap();session.clear();
 return {
  apply(fn){const before=snap(),top=s.history[0];try{fn();}catch(e){restore(before);session.forget(top);return e.message;}undo.push({snap:before,logs:session.take(top)});redo.length=0;return true;},
  undo(){const i=undo.pop();redo.push({snap:snap(),logs:i.logs});restore(i.snap);session.drop(i.logs);},
  redo(){const i=redo.pop();undo.push({snap:snap(),logs:i.logs});restore(i.snap);session.put(i.logs);},
  discard(){restore(baseline);session.discard();},
 };
}
const types=s=>s.history.map(e=>e.type+(e.detail?' · '+e.detail:''));
function layout(){const s={zones:[],racks:[],boxes:[],history:[]},zone=addZone(s,{x:0,z:0,w:40,d:40}),a=addRack(s,zone,10,10),b=addRack(s,zone,20,10);s.history=[];return {s,zone,a,b};}

test('deleting racks in 2D logs «Layout updated · delete» like the 3D tools; undo removes it, redo restores it',()=>{
 const {s,a,b}=layout(),ed=editor(s);
 assert.equal(ed.apply(()=>deleteRacks(s,[a,b])),true);
 assert.deepEqual(types(s),['Layout updated · delete']);assert.equal(s.racks.length,0);
 ed.undo();assert.deepEqual(types(s),[]);assert.equal(s.racks.length,2);
 ed.redo();assert.deepEqual(types(s),['Layout updated · delete']);
});
test('deleting a zone logs its name and rack count; discard drops the entry with the edit',()=>{
 const {s,zone}=layout(),ed=editor(s);
 ed.apply(()=>deleteZone(s,zone));
 assert.deepEqual(types(s),[`Layout updated · delete · Zone ${zone} · 2 racks`]);assert.equal(s.zones.length,0);assert.equal(s.racks.length,0);
 ed.discard();assert.deepEqual(types(s),[]);assert.equal(s.zones.length,1);assert.equal(s.racks.length,2);
});
test('a refused delete changes nothing and leaves no History entry',()=>{
 const {s,zone,a}=layout(),ed=editor(s);s.boxes.push({id:'BX-1',rack:a,location:'S1-P1',product:'x'});
 assert.match(ed.apply(()=>deleteZone(s,zone)),/Move or ship all boxes/);
 assert.match(ed.apply(()=>deleteRacks(s,[a])),/Move or ship boxes/);
 assert.deepEqual(types(s),[]);assert.equal(s.racks.length,2);assert.equal(s.zones.length,1);
});
test('zone names are required and unique ignoring case; a zone may keep its own name',()=>{
 const {s,zone}=layout();addZone(s,{x:40,z:0,w:20,d:20});
 assert.throws(()=>checkZoneName(s,'   '),/Enter a zone name/);
 assert.throws(()=>checkZoneName(s,`zone ${zone.toLowerCase()}`),/already exists/);
 assert.throws(()=>checkZoneName(s,` ZONE ${zone} `,'other'),/already exists/);
 assert.equal(checkZoneName(s,` Zone ${zone} `,zone),`Zone ${zone}`);
 assert.equal(checkZoneName(s,'Bulk'),'Bulk');
 assert.equal(freeZoneName(s,`zone ${zone}`),`zone ${zone} 2`);
 assert.equal(freeZoneName(s,`Zone ${zone}`,zone),`Zone ${zone}`);
});
