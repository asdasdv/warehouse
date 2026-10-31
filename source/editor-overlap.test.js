import test from 'node:test';
import assert from 'node:assert/strict';
import {zonesOverlap} from './zone-shape.js';
import {addZone} from './model.js';
import {applyLayoutEdit} from './layout-edit.js';

// Zones may sit edge to edge or corner to corner; only a real overlap of floor area is refused.
const rect=(x,z,w,d)=>({x,z,w,d});
const poly=points=>({points});
const L=poly([{x:0,z:0},{x:30,z:0},{x:30,z:12},{x:12,z:12},{x:12,z:30},{x:0,z:30}]);

test('rectangles sharing an edge or only a corner do not overlap',()=>{
 const a=rect(0,0,20,20);
 for(const b of [rect(20,0,20,20),rect(0,20,20,20),rect(-20,5,20,12),rect(20,20,20,20),rect(-20,-20,20,20),rect(20,-5,15,40)]){
  assert.equal(zonesOverlap(a,b),false,JSON.stringify(b));assert.equal(zonesOverlap(b,a),false,JSON.stringify(b));}
});
test('rectangles with any common area overlap, including identical, nested and cross-shaped',()=>{
 const a=rect(0,0,20,20);
 for(const b of [rect(19,0,20,20),rect(0,0,20,20),rect(5,5,5,5),rect(-5,-5,30,30),rect(0,0,10,20),rect(5,-10,5,40),rect(10,10,20,20)]){
  assert.equal(zonesOverlap(a,b),true,JSON.stringify(b));assert.equal(zonesOverlap(b,a),true,JSON.stringify(b));}
});
test('polygons touching along an edge, part of an edge or a corner do not overlap',()=>{
 // The rectangle fills the L's cut-out, sharing both inner edges.
 for(const b of [rect(12,12,18,18),rect(30,0,12,12),poly([{x:30,z:0},{x:50,z:0},{x:40,z:20}]),poly([{x:0,z:30},{x:12,z:30},{x:6,z:50}]),rect(30,12,12,12)]){
  assert.equal(zonesOverlap(L,b),false,JSON.stringify(b));assert.equal(zonesOverlap(b,L),false,JSON.stringify(b));}
 // Either winding.
 assert.equal(zonesOverlap(poly([...L.points].reverse()),rect(12,12,18,18)),false);
});
test('polygons with common area overlap',()=>{
 for(const b of [rect(11,11,18,18),poly([{x:20,z:5},{x:40,z:5},{x:30,z:20}]),rect(2,2,4,4),poly([{x:0,z:0},{x:30,z:0},{x:30,z:12},{x:12,z:12},{x:12,z:30},{x:0,z:30}]),poly([{x:-10,z:-10},{x:40,z:-10},{x:40,z:40},{x:-10,z:40}])]){
  assert.equal(zonesOverlap(L,b),true,JSON.stringify(b));assert.equal(zonesOverlap(b,L),true,JSON.stringify(b));}
 // A triangle whose edge passes exactly through the L's inner corner still overlaps.
 assert.equal(zonesOverlap(L,poly([{x:6,z:18},{x:18,z:6},{x:20,z:20}])),true);
});
test('zones can be drawn and reshaped edge to edge, never into each other',()=>{
 const s={zones:[],racks:[],boxes:[],history:[]};
 const a=addZone(s,rect(0,0,20,20));
 assert.doesNotThrow(()=>addZone(s,rect(20,0,20,20)));
 assert.doesNotThrow(()=>addZone(s,{points:[{x:0,z:20},{x:20,z:20},{x:10,z:40}]}));
 assert.throws(()=>addZone(s,rect(39,0,20,20)),/overlap/);
 // Stretch A back to its neighbour's edge: fine; one metre further: refused.
 assert.throws(()=>applyLayoutEdit(s,{type:'zone',id:a,points:[{x:0,z:0},{x:21,z:0},{x:21,z:20},{x:0,z:20}]}),/overlaps/);
 assert.doesNotThrow(()=>applyLayoutEdit(s,{type:'zone',id:a,points:[{x:-5,z:0},{x:20,z:0},{x:20,z:20},{x:-5,z:20}]}));
});
