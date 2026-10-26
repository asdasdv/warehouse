import test from 'node:test';import assert from 'node:assert/strict';
import {inaccessibleRacks,validateLayoutAccess} from './layout-access.js';
const rack=(id,x,z)=>({id,x,z,width:6,depth:4,rotation:0});
test('blocks a new rack that occupies the pickup approach of an existing rack',()=>{const a=rack('A',0,0),b=rack('B',0,5);assert.equal(inaccessibleRacks([a]).size,0);assert.ok(inaccessibleRacks([a,b]).has('A'));assert.throws(()=>validateLayoutAccess([a],[a,b]),/Robot access blocked/);});
test('open aisle permits access while an existing bad layout can be repaired',()=>{const a=rack('A',0,0),b=rack('B',0,5);assert.doesNotThrow(()=>validateLayoutAccess([a,b],[a,{...b,z:12}]));assert.doesNotThrow(()=>validateLayoutAccess([a,b],[a,b]));});
test('rotated racks reserve approach on their actual front side',()=>{const a={...rack('A',0,0),rotation:1};assert.ok(inaccessibleRacks([a,rack('B',-7,0)]).has('A'));});
