import {validateLayoutAccess,createAccessCheck} from './layout-access.js';
import {sceneOperations} from './scene-operations.js';
import {zonePoints,contains,snapRack,polygonZone} from './zone-shape.js';
import {rackLevels,shelfBase} from './rack-levels.js';
import * as T from 'three';
import {warehouseShadowFrame} from './shadow-frustum.js';
import {addWarehouseRobots} from './warehouse-robots.js';
import {loadModel,fitted} from './warehouse-models.js';
import {docksOf,layoutObstacles} from './docks.js';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {rackParts} from './rack-geometry.js';
import {config,locations,occupancy,boxLayout,placement} from './storage.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
export function createScene(container,getBaseState,onPick,onDraw){
const getState=getBaseState;
// Studio look: a calm grey ground, light objects, soft light and soft shadows.
const GROUND='#eceef1';
const scene=new T.Scene();scene.background=new T.Color(GROUND);scene.fog=new T.Fog(GROUND,900,2200);
// The home view, fog and zoom limits follow the size of the layout (360 m for the small one).
const extent=(()=>{const z=getBaseState().zones;if(!z.length)return {cx:0,cz:0,size:360};const x0=Math.min(...z.map(a=>a.x)),x1=Math.max(...z.map(a=>a.x+a.w)),z0=Math.min(...z.map(a=>a.z)),z1=Math.max(...z.map(a=>a.z+a.d));return {cx:(x0+x1)/2,cz:(z0+z1)/2,size:Math.ceil(Math.max(360,x1-x0,z1-z0)/4)*4};})();
const homeOffset=new T.Vector3(.39,.92,1).multiplyScalar(extent.size);scene.fog.near=extent.size*2.5;scene.fog.far=extent.size*6;
const robotics=addWarehouseRobots(scene,getBaseState);
const operations=sceneOperations(scene,robotics,getBaseState);
const camera=new T.PerspectiveCamera(38,1,.3,extent.size*7.5);camera.position.set(extent.cx+homeOffset.x,homeOffset.y,extent.cz+homeOffset.z);
const renderer=new T.WebGLRenderer({antialias:true,logarithmicDepthBuffer:true});const MAX_RATIO=Math.min(devicePixelRatio,1.5);renderer.setPixelRatio(MAX_RATIO);container.append(renderer.domElement);renderer.outputColorSpace=T.SRGBColorSpace;renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;


const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.maxPolarAngle=Math.PI*.46;controls.minDistance=8;controls.maxDistance=extent.size*3;controls.target.set(extent.cx,0,extent.cz);controls.zoomToCursor=true;
scene.add(new T.HemisphereLight(0xf4f6fb,0x9aa0aa,1.9));
const sun=new T.DirectionalLight(0xfff4e6,2.3);sun.castShadow=true;const shadowResolution=Math.min(4096,renderer.capabilities.maxTextureSize);sun.shadow.mapSize.set(shadowResolution,shadowResolution);sun.shadow.bias=-.0004;sun.shadow.normalBias=.08;sun.shadow.radius=3;sun.shadow.camera.near=.5;sun.shadow.camera.far=900;scene.add(sun,sun.target);
const fillLight=new T.DirectionalLight(0xdfe7ff,.9);fillLight.position.set(-80,60,-40);scene.add(fillLight);
// Draw ground and its shadow in one opaque pass. Two near-coplanar planes
// lose depth precision at warehouse scale and flicker as the camera rotates.
const groundMaterial=new T.ShadowMaterial({color:GROUND,transparent:false,depthWrite:true,toneMapped:false});
groundMaterial.onBeforeCompile=shader=>{shader.fragmentShader=shader.fragmentShader.replace(
 'gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );',
 'gl_FragColor = vec4( color * (1.0 - 0.22 * (1.0 - getShadowMask())), 1.0 );'
);};
groundMaterial.customProgramCacheKey=()=> 'opaque-warehouse-ground-v1';
const floor=new T.Mesh(new T.PlaneGeometry(extent.size*12,extent.size*12),groundMaterial);floor.rotation.x=-Math.PI/2;floor.position.y=-.10;floor.receiveShadow=true;scene.add(floor);
// A dotted floor grid (a small dot every 4 m), like the studio floor of the Blender scene.
const dotCanvas=document.createElement('canvas');dotCanvas.width=dotCanvas.height=64;{const c=dotCanvas.getContext('2d');c.fillStyle='#a9aeb5';c.beginPath();c.arc(32,32,2.2,0,Math.PI*2);c.fill();}
const dotTexture=new T.CanvasTexture(dotCanvas);dotTexture.wrapS=dotTexture.wrapT=T.RepeatWrapping;dotTexture.repeat.set(extent.size,extent.size);dotTexture.anisotropy=renderer.capabilities.getMaxAnisotropy();
const grid=new T.Mesh(new T.PlaneGeometry(extent.size*4,extent.size*4),new T.MeshBasicMaterial({map:dotTexture,transparent:true,depthWrite:false,toneMapped:false}));grid.rotation.x=-Math.PI/2;grid.position.set(2,-.08,2);grid.renderOrder=2;grid.raycast=()=>{};scene.add(grid);
let lightingLayout='';
function updateLighting(s){const docks=layoutObstacles(s),key=JSON.stringify([s.racks.map(r=>[r.x,r.z,r.width,r.depth,r.height]),s.zones.map(z=>[z.x,z.z,z.w,z.d]),docks]);if(key===lightingLayout)return;lightingLayout=key;
 const frame=warehouseShadowFrame([...s.racks,...docks.map(d=>({...d,height:5}))],s.zones);sun.position.copy(frame.position);sun.target.position.copy(frame.target);
 for(const k of ['left','right','top','bottom','near','far'])sun.shadow.camera[k]=frame[k];sun.shadow.camera.updateProjectionMatrix();
}
let followedBox=null,following=null,inspectedId=null;const inspection=new T.Box3Helper(new T.Box3(),0x2f8fe6);inspection.material.depthTest=false;inspection.renderOrder=16;inspection.visible=false;scene.add(inspection);
let world=new T.Group(),detail=new T.Group(),selection=new T.Group();scene.add(world,detail,selection);let targets=[],mode='browse',start=null,down=null,anim=null,building=false,rackConfig=config();
const mat=(c)=>new T.MeshStandardMaterial({color:c,roughness:.8});
const geometry=new T.BoxGeometry(1,1,1),cartonGeometry=new RoundedBoxGeometry(1,1,1,1,.035);
// One palette for the whole scene (see PALETTE in warehouse-robots.js): light matte metal, white decks.
const materials={frame:new T.MeshStandardMaterial({color:'#c3c9cf',metalness:.25,roughness:.5}),beam:new T.MeshStandardMaterial({color:'#e2e5e9',metalness:.15,roughness:.55}),deck:new T.MeshStandardMaterial({color:'#f6f7f8',metalness:.05,roughness:.75}),brace:new T.MeshStandardMaterial({color:'#d2d7db',metalness:.25,roughness:.5}),hardware:mat('#9aa1a8'),box:mat('#ffffff'),tape:mat('#a87942')};
const layers={zones:true,robots:true,lanes:true,labels:true,zoneTags:true,dockTags:true};
const sharedGeometries=new Set(),sharedMaterials=new Set(Object.values(materials));
let cv=document.createElement('canvas');cv.width=128;cv.height=80;let ctx=cv.getContext('2d');ctx.fillStyle='#f4f4ed';ctx.fillRect(0,0,128,80);ctx.fillStyle='#8a9097';ctx.fillRect(9,10,58,6);ctx.fillRect(9,21,38,4);ctx.fillStyle='#39434b';for(let i=0;i<39;i++)ctx.fillRect(9+i*2.8,36,i%3===0?2:1,30);const labelTexture=new T.CanvasTexture(cv);materials.label=new T.MeshStandardMaterial({map:labelTexture,roughness:1});sharedMaterials.add(materials.label);
function mesh(g,x,y,z,w,h,d,m){let o=new T.Mesh(geometry,m);o.position.set(x,y,z);o.scale.set(w,h,d);g.add(o);return o;}
function release(c){c.parent?.remove(c);if(c.geometry&&c.geometry!==geometry&&c.geometry!==cartonGeometry&&!sharedGeometries.has(c.geometry))c.geometry.dispose();if(c.isInstancedMesh)c.dispose();if(c.material&&!sharedMaterials.has(c.material)){c.material.map?.dispose();c.material.dispose();}}
function clear(g){while(g.children.length)release(g.children[0]);}
function partTransform(obj,part,x=0,z=0){obj.quaternion.identity();if(part.from){let a=new T.Vector3(...part.from),b=new T.Vector3(...part.to),delta=b.clone().sub(a);obj.position.copy(a.add(b).multiplyScalar(.5));obj.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),delta.clone().normalize());obj.scale.set(part.thickness,delta.length(),part.thickness);}else {obj.position.set(...part.p);obj.scale.set(...part.size);}obj.position.x+=x;obj.position.z+=z;obj.updateMatrix();}
// Shelf boxes use the Blender carton (bevelled edges, tape, handling marks) once it has loaded: its parts become
// instanced batches over a unit cube centred on the origin, so every box is one matrix like the plain cube.
let cartonParts=null;
loadModel('box').then(model=>{if(!model)return;const wrap=fitted(model,{w:1,h:1,d:1});wrap.updateMatrixWorld(true);const parts=[];
 wrap.traverse(o=>{if(!o.isMesh)return;const g=o.geometry.clone().applyMatrix4(o.matrixWorld);g.translate(0,-.5,0);parts.push({geometry:g,material:o.material,cardboard:/cardboard/i.test(o.material.name)});});
 for(const part of parts){sharedMaterials.add(part.material);sharedGeometries.add(part.geometry);}cartonParts=parts;for(const z of zoneCargo.values())dropNear(z);select(current,false);});
// A box keeps its shade for life: picked from its id, not from where it sits in the list (that shifted on every move).
const shades=['#ffffff','#f3ece2','#e8dccb','#f7f1e8'].map(c=>new T.Color(c)),fallbackShades=['#cba67a','#c09a6c','#d6b88f','#c8a274'].map(c=>new T.Color(c));
const shadeOf=(id,list)=>{let h=0;for(let i=0;i<id.length;i++)h=h*31+id.charCodeAt(i)|0;return list[Math.abs(h)%list.length];};
// The sticker goes on the face that looks into the aisle, whichever way the rack is turned.
const labelPlane=new T.PlaneGeometry(1,1);
function frontOf(rack){const t=((rack?.rotation||0)%4+4)%4;return t===0?{nx:0,nz:1,angle:0}:t===1?{nx:-1,nz:0,angle:-Math.PI/2}:t===2?{nx:0,nz:-1,angle:Math.PI}:{nx:1,nz:0,angle:Math.PI/2};}
function cargoMeshes(layout,group,selectedId=null,selectedLoc=null,closeUp=false,simple=false){let obj=new T.Object3D(),racks=new Map(getState().racks.map(r=>[r.id,r])),out={};
 const parts=!simple&&cartonParts||[{geometry:closeUp?cartonGeometry:geometry,material:materials.box,cardboard:true}];
 parts.forEach((part,k)=>{const m=new T.InstancedMesh(part.geometry,part.material,layout.length);m.castShadow=closeUp;m.receiveShadow=true;out[k?'part'+k:'body']=m;});
 const body=out.body,others=Object.values(out).filter(m=>m!==body);
 if(!cartonParts&&!simple){out.tape=new T.InstancedMesh(geometry,materials.tape,layout.length);out.tape.userData.fineDetail=true;}
 if(!simple){out.labels=new T.InstancedMesh(labelPlane,materials.label,layout.length);out.labels.userData.fineDetail=true;}
 const cardboard=Object.entries(out).filter(([k])=>k!=='tape'&&k!=='labels').filter((_,k)=>parts[k]?.cardboard).map(([,m])=>m);
 layout.forEach((p,i)=>{obj.rotation.set(0,0,0);obj.position.set(p.x,p.y,p.z);obj.scale.set(p.w,p.h,p.d);obj.updateMatrix();body.setMatrixAt(i,obj.matrix);for(const m of others)if(m!==out.tape&&m!==out.labels)m.setMatrixAt(i,obj.matrix);
  const chosen=p.box.id===selectedId||selectedLoc&&p.box.location===selectedLoc,color=chosen?new T.Color('#4ca8f8'):shadeOf(p.box.id,cartonParts&&!simple?shades:fallbackShades);for(const m of cardboard)m.setColorAt(i,color);
  if(out.tape){obj.position.set(p.x,p.y+p.h/2+.003,p.z);obj.scale.set(p.w*.13,.006,p.d*.98);obj.updateMatrix();out.tape.setMatrixAt(i,obj.matrix);}
  if(simple)return;const f=frontOf(racks.get(p.box.rack)),across=f.nx?p.d:p.w,depth=f.nx?p.w:p.d;obj.position.set(p.x+f.nx*(depth/2+.008),p.y-p.h*.04,p.z+f.nz*(depth/2+.008));obj.rotation.set(0,f.angle,0);obj.scale.set(across*.46,p.h*.34,1);obj.updateMatrix();out.labels.setMatrixAt(i,obj.matrix);});
 for(const m of Object.values(out))group.add(m);return out;}
// Layout edits redraw only the zones they touch: each zone's floor, rack parts and far-away blocks are kept
// (with a key of the zone's shape and its racks) and rebuilt when that key changes. Materials are shared, so a
// rebuild never disposes one and the shaders are never recompiled.
const zoneParts=new Map(),zoneFloorMaterials=new Map();let rackHits=null;
const rackKeyOf=r=>[r.id,r.x,r.z,r.width,r.depth,r.height,r.shelves,r.places,r.rotation||0].join(',');
function zoneFloorMaterial(color){let m=zoneFloorMaterials.get(color);if(!m){m=new T.MeshStandardMaterial({color:new T.Color('#f3f4f6').lerp(new T.Color(color),.62),roughness:.9});zoneFloorMaterials.set(color,m);sharedMaterials.add(m);}return m;}
function buildZoneParts(a,racks,zoneId){const meshes=[],dummy=new T.Object3D();
 if(a){let shape=new T.Shape(zonePoints(a).map(p=>new T.Vector2(p.x,-p.z)));let o=new T.Mesh(new T.ShapeGeometry(shape),zoneFloorMaterial(a.color));o.rotation.x=-Math.PI/2;o.position.y=.01;o.userData={type:'zone',id:a.id};o.receiveShadow=true;meshes.push(o);}
 if(!racks.length){zoneBlocks.delete(zoneId);return meshes;}
 // Rack parts are batched per zone (so zones out of view are culled) and per kind. Far away a zone shows one
 // block per rack instead, tinted by how full the rack is (see zoneLevel).
 const kinds={};for(const r of racks)for(const part of rackParts(r))(kinds[part.kind]??=[]).push({r,part});
 for(const [kind,items] of Object.entries(kinds)){let inst=new T.InstancedMesh(geometry,materials[kind],items.length);items.forEach(({r,part},i)=>{partTransform(dummy,part,r.x,r.z);inst.setMatrixAt(i,dummy.matrix);});
  // Only uprights and decks cast shadows: bolts, beams and braces add most of the triangles and little to the shadow.
  inst.castShadow=kind==='frame'||kind==='deck';inst.receiveShadow=true;inst.userData.partKind=kind;inst.userData.zone=zoneId;meshes.push(inst);}
 const block=new T.InstancedMesh(geometry,blockMaterial,racks.length);dummy.quaternion.identity();racks.forEach((r,i)=>{dummy.position.set(r.x,r.height/2,r.z);dummy.scale.set(r.width,r.height,r.depth);dummy.updateMatrix();block.setMatrixAt(i,dummy.matrix);block.setColorAt(i,blockEmpty);});
 block.castShadow=true;block.receiveShadow=true;block.userData={rackBlock:true,zone:zoneId};block.visible=false;meshes.push(block);zoneBlocks.set(zoneId,{mesh:block,racks:racks.map(r=>r.id)});
 return meshes;}
function rebuild(){clearHover();clear(detail);clear(selection);placeAccess.reset();const s=getState();updateLighting(s);
 const byZone=new Map(s.zones.map(a=>[a.id,[]]));for(const r of s.racks){if(!byZone.has(r.zone))byZone.set(r.zone,[]);byZone.get(r.zone).push(r);}
 for(const [id,entry] of zoneParts)if(!byZone.has(id)){for(const m of entry.meshes)release(m);zoneParts.delete(id);zoneBlocks.delete(id);}
 for(const [id,racks] of byZone){const a=s.zones.find(z=>z.id===id),key=JSON.stringify([a?zonePoints(a):null,a?.color,racks.map(rackKeyOf)]),entry=zoneParts.get(id);if(entry?.key===key)continue;
  if(entry)for(const m of entry.meshes)release(m);const meshes=buildZoneParts(a,racks,id);for(const m of meshes)world.add(m);zoneParts.set(id,{key,meshes});}
 // One invisible box per rack for picking; its instance i is rack ids[i].
 if(rackHits)release(rackHits);rackHits=new T.InstancedMesh(geometry,rackHitMaterial,Math.max(1,s.racks.length));rackHits.count=s.racks.length;const dummy=new T.Object3D();s.racks.forEach((r,i)=>{dummy.position.set(r.x,r.height/2,r.z);dummy.scale.set(r.width,r.height,r.depth);dummy.updateMatrix();rackHits.setMatrixAt(i,dummy.matrix);});rackHits.computeBoundingSphere();rackHits.userData={type:'racks',ids:s.racks.map(r=>r.id)};world.add(rackHits);
 targets=[...[...zoneParts.values()].flatMap(e=>e.meshes.filter(m=>m.userData.type==='zone')),rackHits];syncTags();
 rebuildCargo();}
// Every box on the shelves, one instanced batch. Rebuilt alone when robots move stock.
// Shelf boxes by distance, per zone: near (< NEAR) every box is drawn (the Blender carton with a sticker);
// mid (< MID) each shelf shows one kraft fill as long as its boxes; far, the zone's racks are single blocks tinted
// by how full they are, and nothing on the shelves is drawn. Only the changed zone is redrawn when robots move.
const cargoGroup=new T.Group();scene.add(cargoGroup);
const zoneCargo=new Map(),zoneBlocks=new Map(),zoneLevel=new Map(),NEAR=110,MID=380,zeroMatrix=new T.Matrix4().makeScale(0,0,0);let rackZone=new Map();
const blockMaterial=new T.MeshStandardMaterial({color:'#ffffff',roughness:.8}),blockEmpty=new T.Color('#eef0f2'),blockFull=new T.Color('#c9a274');
const rackHitMaterial=new T.MeshBasicMaterial({visible:false});
const fillMaterial=new T.MeshStandardMaterial({color:'#cba67a',roughness:.95});
// Built once and reused by every rebuild: disposing them would recompile their shaders on the next frame.
for(const m of [blockMaterial,rackHitMaterial,fillMaterial])sharedMaterials.add(m);
function disposeBatch(meshes){for(const m of Object.values(meshes||{})){m.parent?.remove(m);m.dispose();}}
function dropNear(z){disposeBatch(z.near);z.near=null;}
// Same boxes in the same places: a zone's cargo batches can stay as they are.
const samePose=(p,q)=>p.box.id===q.box.id&&p.box.location===q.box.location&&p.x===q.x&&p.y===q.y&&p.z===q.z&&p.w===q.w&&p.h===q.h&&p.d===q.d;
const sameLayout=(a,b)=>a.length===b.length&&a.every((p,i)=>samePose(p,b[i]));
// `reuse`: keep the zone's batches when its racks and boxes have not changed (a full refresh after a layout edit
// elsewhere); its centre and far-level tint are still brought up to date.
function buildZone(zoneId,rackIds,reuse=false){let z=zoneCargo.get(zoneId);const layout=robotics.posesOf(rackIds);
 if(reuse&&z?.mid&&z.rackIds.length===rackIds.length&&z.rackIds.every((id,i)=>id===rackIds[i])&&sameLayout(z.layout,layout)){zoneFrame(z);tintBlocks(z);return;}
 if(z){disposeBatch(z.mid);dropNear(z);}else{z={zone:zoneId,group:new T.Group(),center:new T.Vector3(),radius:0,userData:{}};cargoGroup.add(z.group);zoneCargo.set(zoneId,z);}
 z.rackIds=rackIds;z.layout=layout;z.indices=Object.fromEntries(rackIds.map(id=>[id,[]]));z.layout.forEach((p,i)=>z.indices[p.box.rack].push(i));
 z.userData={type:'boxes',shelfCargo:true,ids:z.layout.map(p=>p.box.id),racks:z.layout.map(p=>p.box.rack),layout:z.layout};
 zoneFrame(z);
 // Mid level: one fill per occupied shelf, the box spanning the boxes on it.
 const shelves=new Map();for(const p of z.layout){const k=p.box.rack+'|'+p.box.location.slice(0,p.box.location.indexOf('-'));let b=shelves.get(k);if(!b)shelves.set(k,b={rack:p.box.rack,box:new T.Box3()});b.box.expandByPoint(new T.Vector3(p.x-p.w/2,p.y-p.h/2,p.z-p.d/2)).expandByPoint(new T.Vector3(p.x+p.w/2,p.y+p.h/2,p.z+p.d/2));}
 const list=[...shelves.values()],mid=new T.InstancedMesh(geometry,fillMaterial,Math.max(1,list.length)),o=new T.Object3D(),c=new T.Vector3(),sz=new T.Vector3();
 z.midIndex={};list.forEach((b,i)=>{b.box.getCenter(c);b.box.getSize(sz);o.position.copy(c);o.scale.copy(sz);o.updateMatrix();mid.setMatrixAt(i,o.matrix);(z.midIndex[b.rack]??=[]).push(i);});
 mid.count=list.length;mid.receiveShadow=true;mid.raycast=()=>{};z.group.add(mid);z.mid={body:mid};
 tintBlocks(z);}
function zoneFrame(z){const zone=getState().zones.find(a=>a.id===z.zone);if(zone){z.center.set(zone.x+zone.w/2,3,zone.z+zone.d/2);z.radius=Math.hypot(zone.w,zone.d)/2;}}
// Far level: rack blocks tinted by fill.
function tintBlocks(z){const blocks=zoneBlocks.get(z.zone);if(blocks){const s=getState(),racks=new Map(s.racks.map(r=>[r.id,r]));blocks.racks.forEach((id,i)=>{const r=racks.get(id),cap=r?locations(r).length*2:1;blocks.mesh.setColorAt(i,blockEmpty.clone().lerp(blockFull,Math.min(1,(z.indices[id]?.length||0)/cap)));});if(blocks.mesh.instanceColor)blocks.mesh.instanceColor.needsUpdate=true;}}
function tagBatch(z,meshes){Object.assign(meshes.body.userData,z.userData);}
function rebuildCargo(change={all:true}){const s=getState();
 if(change.all){rackZone=new Map(s.racks.map(r=>[r.id,r.zone]));
  const byZone=new Map();for(const r of s.racks){if(!byZone.has(r.zone))byZone.set(r.zone,[]);byZone.get(r.zone).push(r.id);}
  // Zones that lost all their racks (or were deleted) drop their cargo; the others are redrawn only if their boxes changed.
  for(const [id,z] of zoneCargo)if(!byZone.has(id)){disposeBatch(z.mid);dropNear(z);cargoGroup.remove(z.group);zoneCargo.delete(id);}
  for(const [id,ids] of byZone)buildZone(id,ids,true);}
 else for(const id of change.racks){const z=rackZone.get(id);if(z)dirtyZones.add(z);}
 hideSelectedCargo();}
// Robots touch a few zones every second. Changed zones wait in a queue and are rebuilt nearest first,
// a few milliseconds per frame, also while Inventory or History covers the scene, so leaving them has nothing to catch up on.
const dirtyZones=new Set();
function rebuildDirtyZones(budgetMs){if(!dirtyZones.size)return false;const s=getState(),t0=performance.now();
 const order=[...dirtyZones].sort((a,b)=>(zoneCargo.get(a)?camera.position.distanceTo(zoneCargo.get(a).center):0)-(zoneCargo.get(b)?camera.position.distanceTo(zoneCargo.get(b).center):0));
 for(const id of order){dirtyZones.delete(id);buildZone(id,zoneCargo.get(id)?.rackIds||s.racks.filter(r=>r.zone===id).map(r=>r.id));if(performance.now()-t0>budgetMs)break;}
 hideSelectedCargo();return true;}
// Level of detail per zone from the camera's distance to the zone's edge: 0 near, 1 mid, 2 far.
// Near cartons are made the first time a zone comes close, and dropped again once it is far.
function updateCargoDetail(){for(const z of zoneCargo.values()){const d=Math.max(0,camera.position.distanceTo(z.center)-z.radius),level=d<NEAR?0:d<MID?1:2;zoneLevel.set(z.zone,level);
 if(level===0&&!z.near){z.near=cargoMeshes(z.layout,z.group);tagBatch(z,z.near);hideSelectedCargo(z);}
 if(level===2&&z.near)dropNear(z);
 z.mid.body.visible=level===1;if(z.near)for(const m of Object.values(z.near))m.visible=level===0;}}
// Boxes of the selected rack are drawn by the close-up view instead, so they are hidden in the batches.
let hiddenRack=null;
function hideSelectedCargo(only=null){if(!hiddenRack)return;const z=zoneCargo.get(rackZone.get(hiddenRack));if(!z||only&&only!==z)return;
 for(const m of Object.values(z.near||{})){for(const i of z.indices[hiddenRack]||[])m.setMatrixAt(i,zeroMatrix);m.instanceMatrix.needsUpdate=true;}
 for(const i of z.midIndex?.[hiddenRack]||[])z.mid.body.setMatrixAt(i,zeroMatrix);z.mid.body.instanceMatrix.needsUpdate=true;}
const hitBox=new T.Box3(),hitPoint=new T.Vector3();
// Instead of ray-testing every box in the warehouse, test only the boxes of the rack under the cursor.
// Only near a zone are boxes drawn one by one (mid: shelf fills, far: rack blocks), so only there can a box be hit;
// further away the hit stays on the rack. The hit object is always the near batch, a real InstancedMesh.
function cargoHit(rid){const z=zoneCargo.get(rackZone.get(rid));if(!z||(zoneLevel.get(z.zone)??0)!==0||!z.near?.body)return null;const body=z.near.body;let best=null;for(const i of z.indices[rid]||[]){const p=z.layout[i];hitBox.min.set(p.x-p.w/2,p.y-p.h/2,p.z-p.d/2);hitBox.max.set(p.x+p.w/2,p.y+p.h/2,p.z+p.d/2);if(ray.ray.intersectBox(hitBox,hitPoint)){const distance=hitPoint.distanceTo(ray.ray.origin);if(!best||distance<best.distance)best={object:body,instanceId:i,distance};}}return best;}
function rackBounds(r){return new T.Box3(new T.Vector3(r.x-r.width/2-.1,0,r.z-r.depth/2-.1),new T.Vector3(r.x+r.width/2+.1,r.height+.15,r.z+r.depth/2+.1));}
let current=null;
// When the selection leaves a rack, its zone is redrawn so the rack's boxes come back.
function releaseHidden(sel){if(!hiddenRack)return;const s=getState(),rid=sel?.type==='rack'?sel.id:sel?.type==='location'?sel.id.split('|')[0]:sel?.type==='box'?robotics.boxInfo(sel.id)?.rack:null;if(rid===hiddenRack)return;const zone=rackZone.get(hiddenRack);hiddenRack=null;if(zone)buildZone(zone,zoneCargo.get(zone)?.rackIds||s.racks.filter(r=>r.zone===zone).map(r=>r.id));}
function select(sel,focus=true){current=sel;if(focus)followedBox=null;focus=focus&&!building;clear(detail);clear(selection);releaseHidden(sel);targets=targets.filter(t=>!t.userData.detail);let s=getState(),rid=sel?.type==='rack'?sel.id:sel?.type==='location'?sel.id.split('|')[0]:sel?.type==='box'?s.boxes.find(b=>b.id===sel.id)?.rack:null,r=s.racks.find(r=>r.id===rid);let a=sel?.type==='zone'?s.zones.find(a=>a.id===sel.id):null;
if(r){if(!building){let bs=s.boxes.filter(b=>b.rack===r.id),layout=boxLayout(r,bs),cargo=cargoMeshes(layout,detail,sel.id,sel.type==='location'?sel.id.split('|')[1]:null,true);cargo.body.userData={type:'boxes',ids:layout.map(p=>p.box.id),racks:layout.map(()=>r.id),detail:true};targets.push(cargo.body);
if(hiddenRack!==r.id){const was=hiddenRack;hiddenRack=r.id;if(was&&rackZone.get(was)!==rackZone.get(r.id))buildZone(rackZone.get(was),zoneCargo.get(rackZone.get(was))?.rackIds||[]);}hideSelectedCargo();
// Address plates sit on front crossbeams, like a real rack.
const turns=(r.rotation||0)%4,localWidth=turns%2?r.depth:r.width,localDepth=turns%2?r.width:r.depth;for(let sh=0;sh<r.shelves;sh++)for(let pl=0;pl<r.places;pl++){let canvas=document.createElement('canvas');canvas.width=192;canvas.height=48;let c=canvas.getContext('2d');c.fillStyle='#e8ebdf';c.fillRect(0,0,192,48);c.fillStyle='#303c43';c.font='bold 22px Arial';c.textAlign='center';c.fillText(`S${sh+1}–P${pl+1}`,96,32);let plate=new T.Mesh(new T.PlaneGeometry(Math.min(.65,localWidth/r.places*.65),.15),new T.MeshBasicMaterial({map:new T.CanvasTexture(canvas)}));let px=-localWidth/2+(pl+.5)*localWidth/r.places,pz=localDepth/2+.065;for(let t=0;t<turns;t++)[px,pz]=[-pz,px];plate.position.set(r.x+px,shelfBase(r,sh)+.025,r.z+pz);plate.rotation.y=-turns*Math.PI/2;detail.add(plate);}}
let outline=new T.Box3Helper(rackBounds(r),0x2f8fe6);selection.add(outline);if(sel.type==='location'){let [,sh,pl]=/^S(\d+)-P(\d+)$/.exec(sel.id.split('|')[1]);let turns=(r.rotation||0)%4,lw=turns%2?r.depth:r.width,ld=turns%2?r.width:r.depth,cell=lw/r.places,gap=rackLevels(r).gap,highlight=new T.Mesh(geometry,new T.MeshBasicMaterial({color:0x4ca8f8,transparent:true,opacity:.16,depthWrite:false}));let hx=-lw/2+(Number(pl)-.5)*cell,hz=0;for(let t=0;t<turns;t++)[hx,hz]=[-hz,hx];highlight.position.set(r.x+hx,rackLevels(r).base+(Number(sh)-.5)*gap,r.z+hz);highlight.scale.set(turns%2?ld:cell,gap,turns%2?cell:ld);selection.add(highlight);}if(focus){let size=Math.max(r.width,r.height,r.depth,4);fly(new T.Vector3(r.x,r.height*.4,r.z),new T.Vector3(size*1.7,size*1.3,size*2.2));}
}else if(a){let outline=new T.LineLoop(new T.BufferGeometry().setFromPoints(zonePoints(a).map(p=>new T.Vector3(p.x,.08,p.z))),new T.LineBasicMaterial({color:0x2f8fe6}));selection.add(outline);// Picking a zone flies to it, unless the view is already close up inside that zone (e.g. a missed click on a box there).
 if(focus){const off=new T.Vector3(a.w*.55,a.w*.9,a.w*.85),t=controls.target,inside=contains(a,{x:t.x,z:t.z});if(!inside||camera.position.distanceTo(t)>off.length()*1.05)fly(new T.Vector3(a.x+a.w/2,0,a.z+a.d/2),off);}}}
function fly(target,offset){anim={start:performance.now(),p:camera.position.clone(),t:controls.target.clone(),end:target.clone().add(offset),target};}
function home(){following=null;followedBox=null;fly(new T.Vector3(extent.cx,0,extent.cz),homeOffset);}
const ray=new T.Raycaster(),pointer=new T.Vector2();function cast(e){let rect=renderer.domElement.getBoundingClientRect();pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);ray.setFromCamera(pointer,camera);}
function ground(e){cast(e);let p=new T.Vector3();return ray.ray.intersectPlane(new T.Plane(new T.Vector3(0,1,0),0),p)?p:null;}
let preview=new T.Mesh(new T.PlaneGeometry(1,1),new T.MeshBasicMaterial({color:0x4ca8f8,transparent:true,opacity:.3,side:T.DoubleSide}));preview.rotation.x=-Math.PI/2;preview.visible=false;scene.add(preview);
const hover=new T.Group();scene.add(hover);let hoverKey='',lastPointer=null;
const tooltip=document.createElement('div');tooltip.className='scene-tooltip';tooltip.hidden=true;container.append(tooltip);
const ghost=new T.Group();scene.add(ghost);const ghostMaterial=new T.MeshBasicMaterial({color:0x88a866,transparent:true,opacity:.45,depthWrite:false});
function updateGhost(){while(ghost.children.length)ghost.remove(ghost.children[0]);let obj=new T.Object3D();for(let part of rackParts(rackConfig)){if(part.kind==='hardware')continue;partTransform(obj,part);let m=new T.Mesh(geometry,ghostMaterial);m.position.copy(obj.position);m.quaternion.copy(obj.quaternion);m.scale.copy(obj.scale);ghost.add(m);}}
updateGhost();ghost.visible=false;
function clearHover(){clear(hover);hoverKey='';tooltip.hidden=true;}
// Panel hover: outline the zone, rack, shelf, cell or box under the pointer in the side panel.
function partBounds(sel){const s=getState();if(sel.type==='zone'){const z=s.zones.find(z=>z.id===sel.id);return z&&new T.Box3(new T.Vector3(z.x,.04,z.z),new T.Vector3(z.x+z.w,.2,z.z+z.d));}
 if(sel.type==='box'){const p=robotics.boxPose(sel.id);return p&&new T.Box3().setFromCenterAndSize(new T.Vector3(p.x,p.y,p.z),new T.Vector3(p.w+.15,p.h+.15,p.d+.15));}
 const [rid,part]=sel.id.split('|'),r=s.racks.find(r=>r.id===rid);if(!r)return null;if(sel.type==='rack')return rackBounds(r);
 const [sh,pl]=part.split('-'),n=Number(sh.slice(1)),{base,gap}=rackLevels(r),y0=base+(n-1)*gap;
 if(!pl)return new T.Box3(new T.Vector3(r.x-r.width/2-.05,y0,r.z-r.depth/2-.05),new T.Vector3(r.x+r.width/2+.05,y0+gap,r.z+r.depth/2+.05));
 const turns=(r.rotation||0)%4,lw=turns%2?r.depth:r.width,ld=turns%2?r.width:r.depth,cell=lw/r.places;let hx=-lw/2+(Number(pl.slice(1))-.5)*cell,hz=0;for(let t=0;t<turns;t++)[hx,hz]=[-hz,hx];
 return new T.Box3().setFromCenterAndSize(new T.Vector3(r.x+hx,y0+gap/2,r.z+hz),new T.Vector3(turns%2?ld:cell,gap,turns%2?cell:ld));}
let panelSel=null;
function outlinePart(sel){panelSel=sel;clearHover();const bounds=sel&&partBounds(sel);if(!bounds)return;hoverKey='panel';const line=new T.Box3Helper(bounds,0x2f8fe6);line.material.depthTest=false;line.renderOrder=10;hover.add(line);const fill=new T.Mesh(geometry,new T.MeshBasicMaterial({color:0x4ca8f8,transparent:true,opacity:.32,depthWrite:false}));bounds.getCenter(fill.position);bounds.getSize(fill.scale);hover.add(fill);}
function hit(e){cast(e);let hits=ray.intersectObjects(building?targets.filter(t=>!t.userData.detail):[...targets,...(layers.robots?robotics.hits:[])],false);let first=hits[0];if(first?.object.userData.type==='racks'){let rid=first.object.userData.ids?.[first.instanceId];let detailHit=hits.find(h=>h.object.userData.type==='boxes'&&h.object.userData.racks?.[h.instanceId]===rid)||cargoHit(rid);if(detailHit)first=detailHit;}return first;}
// What a ray hit stands for, whatever kind of object it is; null when it stands for nothing pickable.
function identity(h){if(!h?.object)return null;let d=h.object.userData||{},id=null;if(d.type==='boxes'){id=d.ids?.[h.instanceId];return id==null?null:{type:'box',id};}if(d.type==='racks'){id=d.ids?.[h.instanceId];return id==null?null:{type:'rack',id};}return d.type&&d.id!=null?{type:d.type,id:d.id}:null;}
// The outline around a hovered box: from its instance when the hit is an instanced batch, otherwise from its pose.
function boxBounds(h,id,out){if(typeof h.object.getMatrixAt==='function'&&h.instanceId!=null){const m=new T.Matrix4();h.object.getMatrixAt(h.instanceId,m);return out.setFromCenterAndSize(new T.Vector3(),new T.Vector3(1.08,1.08,1.08)).applyMatrix4(m).applyMatrix4(h.object.matrixWorld);}
 const p=robotics.boxPose(id);return p?out.setFromCenterAndSize(new T.Vector3(p.x,p.y,p.z),new T.Vector3(p.w+.08,p.h+.08,p.d+.08)):out.setFromObject(h.object);}
// The robot-access part of the preview check runs once per snapped spot, at most every 100 ms (createAccessCheck);
// a click still goes through the full validation. `onLate` repaints the preview when a deferred check finishes.
const placeAccess=createAccessCheck(100);let placeKey='';
function placeInfo(e,onLate){let p=ground(e);if(!p)return null;let s=getState(),sn=snapRack(s,p,rackConfig,!e.altKey);p.x=sn.x;p.z=sn.z;let z=s.zones.find(z=>contains(z,p)),valid=true,reason='';const key=[p.x,p.z,rackConfig.width,rackConfig.depth,s.racks.length].join(',');placeKey=key;
 try{placement(s,z?.id,p.x,p.z,rackConfig);const r=placeAccess.check(key,()=>validateLayoutAccess(s.racks,[...s.racks,{id:'preview-rack',zone:z?.id,x:p.x,z:p.z,...rackConfig}],docksOf(s),docksOf(s),s.spine),late=>{if(placeKey===key)onLate?.({p,valid:late.valid,reason:late.why,snapped:sn.snapped});});valid=r.valid;reason=r.why;}catch(e){valid=false;reason=e.message;}return {p,valid,reason,snapped:sn.snapped};}
function showPlace(info,e){ghost.visible=true;ghost.position.set(info.p.x,0,info.p.z);ghostMaterial.color.set(info.valid?(info.snapped?0x47adbe:0x80a45c):0xd46c56);tooltip.hidden=false;tooltip.textContent=info.valid?(info.snapped?'Aligned · Click to place':'Click to place'):info.reason;tooltip.style.left=(e.offsetX+18)+'px';tooltip.style.top=(e.offsetY-30)+'px';}
let corners=[];const draftLine=new T.Line(new T.BufferGeometry(),new T.LineBasicMaterial({color:0xb89a00,depthTest:false}));draftLine.renderOrder=20;scene.add(draftLine);
function drawCorners(cursor){const ps=[...corners];if(cursor)ps.push(cursor);if(ps.length>1)ps.push(ps[0]);draftLine.geometry.dispose();draftLine.geometry=new T.BufferGeometry().setFromPoints(ps.map(p=>new T.Vector3(p.x,.2,p.z)));}
function finishZone(){try{const z=polygonZone(corners);if(onDraw('zone',z)===false)return;corners=[];drawCorners();tooltip.hidden=true;}catch(e){tooltip.textContent=e.message;tooltip.hidden=false;tooltip.style.left='40%';tooltip.style.top='100px';}}
document.addEventListener('keydown',e=>{if(mode!=='polygon'||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;if(e.key==='Enter'){e.preventDefault();finishZone();}if(e.key==='Backspace'||e.key==='Delete'){e.preventDefault();e.stopImmediatePropagation();corners.pop();drawCorners();}});

function showHover(e){if(mode!=='browse'||down)return;let h=hit(e),sel=identity(h);if(!sel){clearHover();container.style.cursor='grab';return;}let key=sel.type+sel.id;if(key!==hoverKey){clearHover();hoverKey=key;let s=getState(),bounds=new T.Box3();if(sel.type==='zone'){let z=s.zones.find(z=>z.id===sel.id);if(!z){clearHover();return;}bounds.set(new T.Vector3(z.x,.04,z.z),new T.Vector3(z.x+z.w,.2,z.z+z.d));tooltip.textContent=z.name;}else if(sel.type==='rack'){let r=s.racks.find(r=>r.id===sel.id);if(!r){clearHover();return;}bounds.copy(rackBounds(r));tooltip.textContent='Rack '+r.id;}else if(sel.type==='box'){boxBounds(h,sel.id,bounds);tooltip.textContent=sel.id;}else{bounds.setFromObject(h.object);tooltip.textContent=sel.id;}let line=new T.Box3Helper(bounds,0xb39a00);line.material.depthTest=false;line.renderOrder=10;hover.add(line);let fill=new T.Mesh(geometry,new T.MeshBasicMaterial({color:0x4ca8f8,transparent:true,opacity:.16,depthWrite:false}));bounds.getCenter(fill.position);bounds.getSize(fill.scale);hover.add(fill);}tooltip.hidden=false;tooltip.style.left=Math.min(e.offsetX+18,container.clientWidth-160)+'px';tooltip.style.top=Math.max(10,e.offsetY-36)+'px';container.style.cursor='pointer';}
renderer.domElement.addEventListener('pointerdown',e=>{if(e.button!==0)return;down={x:e.clientX,y:e.clientY};clearHover();if(mode==='zone'){start=ground(e);renderer.domElement.setPointerCapture(e.pointerId);}});
renderer.domElement.addEventListener('pointermove',e=>{lastPointer=e;if(mode==='polygon'){let p=ground(e);if(p)drawCorners({x:Math.round(p.x),z:Math.round(p.z)});return;}if(mode==='rack'){let info=placeInfo(e,late=>{if(mode==='rack')showPlace(late,e);});if(info)showPlace(info,e);}else if(start&&mode==='zone'){let p=ground(e);if(p){preview.visible=true;preview.position.set((p.x+start.x)/2,.2,(p.z+start.z)/2);preview.scale.set(Math.abs(p.x-start.x),Math.abs(p.z-start.z),1);}}else showHover(e);});
renderer.domElement.addEventListener('pointerleave',()=>{clearHover();ghost.visible=false;});
renderer.domElement.addEventListener('pointercancel',()=>{down=null;start=null;preview.visible=false;});
renderer.domElement.addEventListener('pointerup',e=>{if(e.button!==0)return;let origin=down;down=null;if(mode==='zone'&&start){let p=ground(e);if(p)onDraw('zone',{x:Math.min(start.x,p.x),z:Math.min(start.z,p.z),w:Math.abs(p.x-start.x),d:Math.abs(p.z-start.z)});start=null;preview.visible=false;return;}if(!origin||Math.hypot(e.clientX-origin.x,e.clientY-origin.y)>6)return;if(mode==='polygon'){let p=ground(e);if(p){let q={x:Math.round(p.x),z:Math.round(p.z)};if(corners.length>=3&&Math.hypot(q.x-corners[0].x,q.z-corners[0].z)<1.5)finishZone();else{corners.push(q);drawCorners();}}return;}if(mode==='rack'){let info=placeInfo(e);if(info)onDraw('rack',info.p);return;}onPick(identity(hit(e)));});
controls.addEventListener('start',()=>{anim=null;following=null;followedBox=null;});
// Orbit around the floor point under the cursor (where the drag started), not the middle of the screen.
// OrbitControls turns the camera about its target; each frame that turn is replayed about the pivot instead.
let pivot=null;const floorPlane=new T.Plane(new T.Vector3(0,1,0),0),orbitTurn=new T.Quaternion(),before={cam:new T.Vector3(),target:new T.Vector3()};
renderer.domElement.addEventListener('pointerdown',e=>{pivot=null;if(e.button!==0||controls.mouseButtons.LEFT!==T.MOUSE.ROTATE)return;cast(e);const p=new T.Vector3();if(ray.ray.intersectPlane(floorPlane,p))pivot=p;});
renderer.domElement.addEventListener('wheel',()=>{pivot=null;},{passive:true});
function orbitAboutPivot(){if(!pivot||anim||following)return;const a=before.cam.clone().sub(before.target).normalize(),b=camera.position.clone().sub(controls.target).normalize();if(a.distanceToSquared(b)<1e-12)return;
 // Undo the turn about the target, then make it about the pivot; the target goes back onto the floor along the view.
 const sa=new T.Spherical().setFromVector3(a),sb=new T.Spherical().setFromVector3(b);
 // As a turn about the vertical, then a tilt about the horizontal axis: no roll, so the pivot stays put on screen.
 orbitTurn.setFromAxisAngle(new T.Vector3(Math.cos(sb.theta),0,-Math.sin(sb.theta)),sb.phi-sa.phi).multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),sb.theta-sa.theta));camera.position.copy(before.cam).sub(pivot).applyQuaternion(orbitTurn).add(pivot);const t=before.target.clone().sub(pivot).applyQuaternion(orbitTurn).add(pivot);
 const dir=t.clone().sub(camera.position).normalize(),hitT=new T.Vector3();if(dir.y<-1e-3&&new T.Ray(camera.position,dir).intersectPlane(floorPlane,hitT))controls.target.copy(hitT);else controls.target.copy(t);camera.lookAt(controls.target);}
new ResizeObserver(()=>{let w=container.clientWidth,h=container.clientHeight;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();}).observe(container);
// The simulation runs on wall-clock time, not frames: it catches up in 0.1 s steps (capped at 30 s), and keeps going from a timer while the tab is hidden and rAF is paused.
let simTime=performance.now();function step(now){let dt=Math.min(30,(now-simTime)/1000);simTime=now;while(dt>1e-6){const h=Math.min(.1,dt);robotics.update(h);dt-=h;}}
setInterval(()=>{if(document.hidden)step(performance.now());},1000);
// Inventory and History cover the scene, so skip drawing it; the cargo flag keeps until the scene is back and is rebuilt once.
// Map tags: zone and dock names as HTML over the 3D view (crisp text on a blurred white plate).
const tagLayer=document.createElement('div');tagLayer.className='map-tags';container.append(tagLayer);const tags=new Map(),tagPoint=new T.Vector3();
function syncTags(){const s=getState(),want=[...s.zones.map(a=>({key:'zone:'+a.id,text:a.name,kind:'zone',color:a.color,x:a.x+a.w/2,y:.3,z:a.z+a.d/2})),...robotics.mapTags().map(t=>({...t,key:'dock:'+t.key})),
  // Robot names follow their robots; HTML keeps them sharp at any zoom (the old canvas sprites blurred).
  ...robotics.robots.filter(r=>r.active).map(r=>({key:'robot:'+r.id,text:r.id,kind:'robot',x:r.g.position.x,y:4,z:r.g.position.z}))];const keys=new Set(want.map(t=>t.key));
 for(const [k,t] of tags)if(!keys.has(k)){t.el.remove();tags.delete(k);}
 for(const t of want){let o=tags.get(t.key);if(!o){const el=document.createElement('div');el.className='map-tag tag-'+t.kind;tagLayer.append(el);o={el};tags.set(t.key,o);}const html=(t.color?`<i style="background:${t.color}"></i>`:'')+`<span>${t.text.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'})[c])}</span>`;if(o.html!==html){o.el.innerHTML=html;o.html=html;}Object.assign(o,t);}}
// Docks move when the layout changes, so positions are refreshed every frame (cheap: ~40 tags).
// Dock names only show from close enough; from further away they pile up on top of each other.
const DOCK_TAG_RANGE=Math.max(260,extent.size*.6);
function placeTags(){syncTags();const w=renderer.domElement.clientWidth,h=renderer.domElement.clientHeight;tagLayer.hidden=building;if(building)return;
 for(const t of tags.values()){const on=t.kind==='zone'?layers.zoneTags&&layers.zones:t.kind==='robot'?layers.robots&&layers.labels&&(camera.position.distanceTo(tagPoint.set(t.x,t.y,t.z))<180||robotics.selected===t.text):layers.dockTags&&(t.kind==='building'||camera.position.distanceTo(tagPoint.set(t.x,t.y,t.z))<DOCK_TAG_RANGE);tagPoint.set(t.x,t.y,t.z).project(camera);const show=on&&tagPoint.z<1&&Math.abs(tagPoint.x)<1.1&&Math.abs(tagPoint.y)<1.1;
  if(!show){if(t.shown!==false){t.el.style.display='none';t.shown=false;}continue;}if(t.shown!==true){t.el.style.display='';t.shown=true;}t.el.style.transform=`translate(${((tagPoint.x+1)/2*w).toFixed(1)}px,${((1-tagPoint.y)/2*h).toFixed(1)}px) translate(-50%,-50%)`;}}
// Adaptive resolution: when frames stay slow (under ~45 fps) the render resolution steps down to 1x,
// and steps back up when there is room.
let frameClock=performance.now(),frameAvg=16,ratioClock=0;
function adaptResolution(){const now=performance.now(),dt=Math.min(100,now-frameClock);frameClock=now;frameAvg+=(dt-frameAvg)*.05;ratioClock+=dt;if(ratioClock<2000)return;ratioClock=0;
 const r=renderer.getPixelRatio();if(frameAvg>22&&r>1){renderer.setPixelRatio(Math.max(1,r-.25));}else if(frameAvg<12&&r<MAX_RATIO){renderer.setPixelRatio(Math.min(MAX_RATIO,r+.25));}}
const sceneHidden=()=>document.body.classList.contains('inventory-mode')||document.body.classList.contains('history-mode');
renderer.setAnimationLoop(()=>{step(performance.now());const change=robotics.consumeVisualChange();if(change)rebuildCargo(change);const rebuilt=rebuildDirtyZones(4);if(sceneHidden())return;if(change?.all||rebuilt){clearHover();if(change?.all||current)select(current,false);if(panelSel)outlinePart(panelSel);}updateCargoDetail();const ip=inspectedId?robotics.boxPose(inspectedId):null;inspection.visible=!!ip;if(ip)inspection.box.setFromCenterAndSize(new T.Vector3(ip.x,ip.y,ip.z),new T.Vector3(ip.w+.15,ip.h+.15,ip.d+.15));if(anim){let v=Math.min(1,(performance.now()-anim.start)/850),t=1-Math.pow(1-v,3);camera.position.lerpVectors(anim.p,anim.end,t);controls.target.lerpVectors(anim.t,anim.target,t);if(v===1)anim=null;}// A picked box is followed wherever it goes: at the dock, on a robot, onto its shelf. Dragging the view stops it.
if(followedBox&&!anim){const p=robotics.boxPose(followedBox);if(p){const target=controls.target.clone().lerp(new T.Vector3(p.x,p.y,p.z),.2),delta=target.clone().sub(controls.target);camera.position.add(delta);controls.target.copy(target);}else followedBox=null;}
if(following&&!anim){const robot=robotics.robots.find(r=>r.id===following);if(robot?.active){const target=robot.g.position.clone().add(new T.Vector3(10,2,-6)),delta=target.clone().sub(controls.target);camera.position.add(delta);controls.target.copy(target);}else following=null;}before.cam.copy(camera.position);before.target.copy(controls.target);controls.update();orbitAboutPivot();operations.update(.016);const distance=camera.position.distanceTo(controls.target);for(const o of [...world.children,...cargoGroup.children]){if(o.userData.fineDetail)o.visible=distance<140;if(o.userData.partKind){const lvl=zoneLevel.get(o.userData.zone)??0,k=o.userData.partKind;o.visible=lvl<2&&(k==='hardware'?lvl===0&&distance<100:k==='brace'?distance<260:k==='beam'?distance<380:true);}if(o.userData.rackBlock)o.visible=(zoneLevel.get(o.userData.zone)??0)===2;if(o.userData.label)o.visible=layers.labels&&distance<300;if(o.userData.type==='zone'||o.userData.zoneOutline)o.visible=layers.zones;}robotics.updateDetail(camera.position,layers.robots);for(const r of robotics.robots){r.g.visible=layers.robots;for(const child of r.g.children)if(child.isSprite)child.visible=false;}placeTags();adaptResolution();renderer.render(scene,camera);});
return {setOccupancy(v){operations.setOccupancy(v);},layer(name){return layers[name];},setLayer(name,on){layers[name]=on;if(name==='lanes')robotics.setLanesVisible(on);},showOrder(id){operations.setOrder(id);robotics.select(null);if(id){const o=robotics.book.orders.find(o=>o.id===id),ps=o?.allocated.map(id=>robotics.boxPose(id)).filter(Boolean)||[];if(ps.length){const b=new T.Box3();ps.forEach(p=>b.expandByPoint(new T.Vector3(p.x,p.y,p.z)));const center=b.getCenter(new T.Vector3()),size=Math.max(30,b.getSize(new T.Vector3()).length());fly(center,new T.Vector3(size*.5,size,size*.7));}}},focusIssue(id){const st=robotics.stations.find(s=>s.id===id);if(st)fly(st.g.position.clone(),new T.Vector3(20,30,24));else{robotics.select(id);fly(robotics.focus(id),new T.Vector3(20,30,24));}},builderContext:{canvas:renderer.domElement,camera,ground,controls,scene,hit,identity,pick:onPick,mode:()=>mode,rackConfig:()=>rackConfig,setMode:m=>{mode=m;controls.mouseButtons.LEFT=null;clearHover();ghost.visible=false;}},robotics,finishZone,focusBox(id){following=null;inspectedId=id;followedBox=id;robotics.select(null);const p=robotics.boxPose(id);if(p)fly(new T.Vector3(p.x,p.y,p.z),new T.Vector3(12,15,18));},get following(){return following;},followRobot(id){inspectedId=null;followedBox=null;following=id;if(id){robotics.select(id);fly(robotics.focus(id).add(new T.Vector3(10,2,-6)),new T.Vector3(20,38,28));}},focusRobot(id){inspectedId=null;followedBox=null;following=null;robotics.select(id);fly(robotics.focus(id).add(new T.Vector3(10,0,-6)),id?new T.Vector3(28,34,42):new T.Vector3(48,60,74));},rebuild,select,preview:outlinePart,home,setRackConfig(c){rackConfig=config(c);updateGhost();ghost.visible=false;},
setBuilding(value){operations.setOrder(null);operations.setOccupancy(false);following=null;building=value;robotics.setBuilding(value);clearHover();if(value){clear(detail);targets=targets.filter(t=>!t.userData.detail);} },
topView(){let distance=camera.position.distanceTo(controls.target);fly(controls.target.clone(),new T.Vector3(0,distance,.01));},
setMode(m){mode=m;corners=[];drawCorners();start=null;down=null;preview.visible=false;ghost.visible=false;clearHover();controls.enabled=true;controls.mouseButtons.LEFT=m==='browse'?T.MOUSE.ROTATE:null;controls.mouseButtons.RIGHT=T.MOUSE.PAN;container.style.cursor=m==='browse'?'grab':'crosshair';},
zoom(n){camera.position.sub(controls.target).multiplyScalar(n).add(controls.target);}};
}
