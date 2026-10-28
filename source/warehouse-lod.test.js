import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {palletLOD,updateCargoBatch} from './warehouse-lod.js';
import {assetParts} from './warehouse-assets.js';
import {seed} from './model.js';
import {rackParts} from './rack-geometry.js';
import {boxLayout} from './storage.js';

test('pallet detail is local and a selected rack keeps its fork openings',()=>{
 const cube=new T.BoxGeometry(),mat=new T.MeshBasicMaterial(),lod=palletLOD([
 {rack:'A',position:[0,0,0],size:[1,1,1]},{rack:'B',position:[200,0,0],size:[1,1,1]}],assetParts.pallet[0].geometry,cube,mat);
 assert.equal(lod.updateLOD(new T.Vector3(0,20,0)),true);
 assert.deepEqual(lod.children.map(m=>m.count),[1,1]);
 assert.equal(lod.updateLOD(new T.Vector3(0,20,0)),false);
 lod.updateLOD(new T.Vector3(0,20,0),'B');assert.deepEqual(lod.children.map(m=>m.count),[2,0]);
 lod.updateLOD(new T.Vector3(0,200,0));assert.deepEqual(lod.children.map(m=>m.count),[0,2]);
 lod.dispose();cube.dispose();mat.dispose();
});
test('cargo updates reuse buffers and refresh bounds without ghost instances',()=>{
 const g=new T.BoxGeometry(),mat=new T.MeshBasicMaterial(),pose={x:0,y:1,z:0,w:1,h:1,d:1};
 const first=updateCargoBatch(null,[pose,pose],g,mat),buffer=first.instanceMatrix;
 const next=updateCargoBatch(first,[{...pose,x:100}],g,mat);
 assert.equal(next,first);assert.equal(next.instanceMatrix,buffer);assert.equal(next.count,1);
 assert.ok(next.boundingSphere.center.x>99);
 const empty=updateCargoBatch(next,[],g,mat);assert.equal(empty.count,0);
 const grown=updateCargoBatch(empty,Array.from({length:100},()=>pose),g,mat);assert.notEqual(grown,empty);assert.equal(grown.count,100);
 first.dispose();grown.dispose();g.dispose();mat.dispose();
});
test('full warehouse overview removes at least 90 percent of pallet and carton triangles',()=>{
 const state=seed(),pallets=state.racks.flatMap(r=>rackParts(r)).filter(p=>p.kind==='pallet').length;
 const boxes=state.racks.flatMap(r=>boxLayout(r,state.boxes.filter(b=>b.rack===r.id))).length;
 const triangles=key=>assetParts[key].reduce((n,p)=>n+p.geometry.index.count/3,0);
 const before=pallets*triangles('pallet')+boxes*(assetParts.carton[0].geometry.index.count/3),after=(pallets+boxes)*12;
 assert.ok(after<before*.1);
 console.log(JSON.stringify({boxes,pallets,assetTrianglesBefore:before,assetTrianglesOverview:after,reductionPercent:Math.round(100*(1-after/before))}));
});
