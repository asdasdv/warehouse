import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {warehouseShadowFrame} from './shadow-frustum.js';
import {seed} from './model.js';
test('fixed light volume covers warehouse corners, tall racks and dock margins',()=>{
 const s=seed();s.racks.push({x:600,z:500,width:20,depth:10,height:80});
 const f=warehouseShadowFrame(s.racks,s.zones),c=new T.OrthographicCamera(f.left,f.right,f.top,f.bottom,f.near,f.far);c.position.copy(f.position);c.lookAt(f.target);c.updateMatrixWorld();
 for(const x of [f.bounds.min.x,f.bounds.max.x])for(const y of [f.bounds.min.y,f.bounds.max.y])for(const z of [f.bounds.min.z,f.bounds.max.z]){const p=new T.Vector3(x,y,z).project(c);assert.ok(Math.abs(p.x)<=1&&Math.abs(p.y)<=1&&Math.abs(p.z)<=1);}
 assert.deepEqual(warehouseShadowFrame(s.racks,s.zones),f);
 assert.ok(warehouseShadowFrame([],[]).far>0);
});
