import test from 'node:test';
import assert from 'node:assert/strict';
import {polygonZone,contains,fitsZone,snapRack,zoneArea} from './zone-shape.js';
import {addZone,addRack} from './model.js';
const points=[{x:0,z:0},{x:30,z:0},{x:30,z:10},{x:10,z:10},{x:10,z:30},{x:0,z:30}];
test('concave zones reject racks in the cutout and crossing the inner corner',()=>{
 const zone=polygonZone(points);assert.equal(zoneArea(zone),500);
 assert.ok(contains(zone,{x:5,z:25}));assert.ok(!contains(zone,{x:20,z:20}));
 assert.ok(fitsZone(zone,5,20,{width:6,depth:4}));
 assert.ok(!fitsZone(zone,10,10,{width:6,depth:4}));
 assert.ok(!fitsZone(zone,25,20,{width:6,depth:4}));
 const s={zones:[],racks:[],history:[]};const id=addZone(s,zone);
 assert.throws(()=>addRack(s,id,20,20));assert.ok(addRack(s,id,5,20));
 assert.deepEqual(JSON.parse(JSON.stringify(s)).zones[0].points,points);
});
test('self intersecting contours are rejected',()=>assert.throws(()=>polygonZone([{x:0,z:0},{x:20,z:20},{x:0,z:20},{x:20,z:0}])));
test('magnet aligns neighbours with a one metre gap and Alt bypasses it',()=>{
 const s={racks:[{x:0,z:0,width:6,depth:4}]},c={width:6,depth:4};
 const p=snapRack(s,{x:7.4,z:.4},c);assert.equal(p.x,7);assert.equal(p.z,0);assert.ok(p.snapped);
 assert.equal(snapRack(s,{x:7.4,z:.4},c,false).snapped,false);
});
