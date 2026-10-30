import test from 'node:test';import assert from 'node:assert/strict';
import {inaccessibleRacks,validateLayoutAccess} from './layout-access.js';
const rack=(id,x,z)=>({id,x,z,width:6,depth:4,rotation:0});
// Racks are served from either face, so only racks closing both faces cut a rack off.
test('blocks a new rack that closes the last open face of an existing rack',()=>{const a=rack('A',0,0),b=rack('B',0,5),c=rack('C',0,-5);assert.equal(inaccessibleRacks([a]).size,0);assert.equal(inaccessibleRacks([a,b]).size,0);assert.ok(inaccessibleRacks([a,b,c]).has('A'));assert.throws(()=>validateLayoutAccess([a,b],[a,b,c]),/Robot access blocked/);});
test('open aisle permits access while an existing bad layout can be repaired',()=>{const a=rack('A',0,0),b=rack('B',0,5);assert.doesNotThrow(()=>validateLayoutAccess([a,b],[a,{...b,z:12}]));assert.doesNotThrow(()=>validateLayoutAccess([a,b],[a,b]));});
test('rotated racks are served from their actual faces',()=>{const a={...rack('A',0,0),rotation:1};assert.equal(inaccessibleRacks([a,rack('B',0,-7)]).size,0);assert.ok(inaccessibleRacks([a,rack('B',-7,0),rack('C',7,0)]).has('A'));});
