import test from 'node:test';
import assert from 'node:assert/strict';
import {polygonZone,zoneArea,MIN_ZONE_SIDE,MIN_ZONE_AREA} from './zone-shape.js';
import {addZone} from './model.js';
import {applyLayoutEdit} from './layout-edit.js';

const reversed=ps=>[...ps].reverse();
const both=(ps,fn)=>{fn(ps);fn(reversed(ps));for(let k=1;k<ps.length;k++)fn([...ps.slice(k),...ps.slice(0,k)]);};

test('a corner touching another edge is rejected in either winding and from any start corner',()=>{
 // (20,0) sits on the edge (0,0)–(40,0): the contour pinches there.
 const touching=[{x:0,z:0},{x:40,z:0},{x:40,z:40},{x:20,z:40},{x:20,z:0},{x:0,z:40}];
 both(touching,ps=>assert.throws(()=>polygonZone(ps),/cross or touch/));
});
test('two corners meeting (figure eight) and crossing edges are rejected both ways',()=>{
 const eight=[{x:0,z:0},{x:20,z:0},{x:20,z:20},{x:40,z:20},{x:40,z:40},{x:20,z:40},{x:20,z:20},{x:0,z:20}];
 both(eight,ps=>assert.throws(()=>polygonZone(ps)));
 const bow=[{x:0,z:0},{x:30,z:30},{x:0,z:30},{x:30,z:0}];
 both(bow,ps=>assert.throws(()=>polygonZone(ps),/cross or touch/));
});
test('repeated corners and edges folding back are rejected',()=>{
 assert.throws(()=>polygonZone([{x:0,z:0},{x:30,z:0},{x:30,z:0},{x:30,z:30},{x:0,z:30}]),/repeat/);
 both([{x:0,z:0},{x:30,z:0},{x:20,z:0},{x:20,z:30},{x:0,z:30}],ps=>assert.throws(()=>polygonZone(ps)));
});
test('valid concave and convex zones pass in either winding',()=>{
 const L=[{x:0,z:0},{x:30,z:0},{x:30,z:12},{x:12,z:12},{x:12,z:30},{x:0,z:30}];
 both(L,ps=>assert.equal(zoneArea(polygonZone(ps)),30*12+12*18));
 // A straight run through a middle corner is fine.
 both([{x:0,z:0},{x:15,z:0},{x:30,z:0},{x:30,z:30},{x:0,z:30}],ps=>assert.doesNotThrow(()=>polygonZone(ps)));
});
test('one minimum zone size everywhere: 12 m sides and 144 m²',()=>{
 assert.equal(MIN_ZONE_SIDE,12);assert.equal(MIN_ZONE_AREA,144);
 const rect=(w,d)=>[{x:0,z:0},{x:w,z:0},{x:w,z:d},{x:0,z:d}];
 assert.doesNotThrow(()=>polygonZone(rect(12,12)));
 assert.throws(()=>polygonZone(rect(11,40)),/12 m/);
 assert.throws(()=>polygonZone(rect(40,11)),/12 m/);
 // 12 × 12 box but only 72 m²: a triangle needs more room.
 assert.throws(()=>polygonZone([{x:0,z:0},{x:12,z:0},{x:0,z:12}]),/144/);
 assert.doesNotThrow(()=>polygonZone([{x:0,z:0},{x:17,z:0},{x:0,z:17}]));
 const s={zones:[],racks:[],boxes:[],history:[]};
 assert.throws(()=>addZone(s,{x:0,z:0,w:11,d:30}));
 assert.throws(()=>addZone(s,{points:rect(11,30)}));
 const id=addZone(s,{x:0,z:0,w:12,d:12});
 // Reshaping an existing zone follows the same rule.
 assert.throws(()=>applyLayoutEdit(s,{type:'zone',id,points:rect(12,10)}),/12 m/);
 assert.doesNotThrow(()=>applyLayoutEdit(s,{type:'zone',id,points:rect(20,12)}));
});
