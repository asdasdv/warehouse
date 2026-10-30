import {validateLayoutAccess} from './layout-access.js';
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
const renderer=new T.WebGLRenderer({antialias:true,logarithmicDepthBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));container.append(renderer.domElement);renderer.outputColorSpace=T.SRGBColorSpace;renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;

const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.maxPolarAngle=Math.PI*.46;controls.minDistance=8;controls.maxDistance=extent.size*3;controls.target.set(extent.cx,0,extent.cz);
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
let following=null,inspectedId=null;const inspection=new T.Box3Helper(new T.Box3(),0xe0b600);inspection.material.depthTest=false;inspection.renderOrder=16;inspection.visible=false;scene.add(inspection);
let world=new T.Group(),detail=new T.Group(),selection=new T.Group();scene.add(world,detail,selection);let targets=[],mode='browse',start=null,down=null,anim=null,building=false,rackConfig=config();
const mat=(c)=>new T.MeshStandardMaterial({color:c,roughness:.8});
const geometry=new T.BoxGeometry(1,1,1),cartonGeometry=new RoundedBoxGeometry(1,1,1,1,.035);
const materials={frame:new T.MeshStandardMaterial({color:'#9ea6ad',metalness:.35,roughness:.45}),beam:new T.MeshStandardMaterial({color:'#d3d7db',metalness:.25,roughness:.5}),deck:new T.MeshStandardMaterial({color:'#eef0f2',metalness:.1,roughness:.7}),brace:new T.MeshStandardMaterial({color:'#bcc2c7',metalness:.35,roughness:.45}),hardware:mat('#6d757c'),box:mat('#ffffff'),tape:mat('#a87942')};
const layers={zones:true,robots:true,lanes:true,labels:true,zoneTags:true,dockTags:true};
const sharedMaterials=new Set(Object.values(materials));
let cv=document.createElement('canvas');cv.width=128;cv.height=80;let ctx=cv.getContext('2d');ctx.fillStyle='#f4f4ed';ctx.fillRect(0,0,128,80);ctx.fillStyle='#8a9097';ctx.fillRect(9,10,58,6);ctx.fillRect(9,21,38,4);ctx.fillStyle='#39434b';for(let i=0;i<39;i++)ctx.fillRect(9+i*2.8,36,i%3===0?2:1,30);const labelTexture=new T.CanvasTexture(cv);materials.label=new T.MeshStandardMaterial({map:labelTexture,roughness:1});sharedMaterials.add(materials.label);
function mesh(g,x,y,z,w,h,d,m){let o=new T.Mesh(geometry,m);o.position.set(x,y,z);o.scale.set(w,h,d);g.add(o);return o;}
function clear(g){while(g.children.length){let c=g.children[0];g.remove(c);if(c.geometry&&c.geometry!==geometry&&c.geometry!==cartonGeometry)c.geometry.dispose();if(c.isInstancedMesh)c.dispose();if(c.material&&!sharedMaterials.has(c.material)){c.material.map?.dispose();c.material.dispose();}}}
function partTransform(obj,part,x=0,z=0){obj.quaternion.identity();if(part.from){let a=new T.Vector3(...part.from),b=new T.Vector3(...part.to),delta=b.clone().sub(a);obj.position.copy(a.add(b).multiplyScalar(.5));obj.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),delta.clone().normalize());obj.scale.set(part.thickness,delta.length(),part.thickness);}else {obj.position.set(...part.p);obj.scale.set(...part.size);}obj.position.x+=x;obj.position.z+=z;obj.updateMatrix();}
// Shelf boxes use the Blender carton (bevelled edges, tape, handling marks) once it has loaded: its parts become
// instanced batches over a unit cube centred on the origin, so every box is one matrix like the plain cube.
let cartonParts=null;
loadModel('box').then(model=>{if(!model)return;const wrap=fitted(model,{w:1,h:1,d:1});wrap.updateMatrixWorld(true);const parts=[];
 wrap.traverse(o=>{if(!o.isMesh)return;const g=o.geometry.clone().applyMatrix4(o.matrixWorld);g.translate(0,-.5,0);parts.push({geometry:g,material:o.material,cardboard:/cardboard/i.test(o.material.name)});});
 for(const part of parts)sharedMaterials.add(part.material);cartonParts=parts;for(const z of zoneCargo.values())dropNear(z);select(current,false);});
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
  const chosen=p.box.id===selectedId||selectedLoc&&p.box.location===selectedLoc,color=chosen?new T.Color('#f1d63e'):shadeOf(p.box.id,cartonParts&&!simple?shades:fallbackShades);for(const m of cardboard)m.setColorAt(i,color);
  if(out.tape){obj.position.set(p.x,p.y+p.h/2+.003,p.z);obj.scale.set(p.w*.13,.006,p.d*.98);obj.updateMatrix();out.tape.setMatrixAt(i,obj.matrix);}
  if(simple)return;const f=frontOf(racks.get(p.box.rack)),across=f.nx?p.d:p.w,depth=f.nx?p.w:p.d;obj.position.set(p.x+f.nx*(depth/2+.008),p.y-p.h*.04,p.z+f.nz*(depth/2+.008));obj.rotation.set(0,f.angle,0);obj.scale.set(across*.46,p.h*.34,1);obj.updateMatrix();out.labels.setMatrixAt(i,obj.matrix);});
 for(const m of Object.values(out))group.add(m);return out;}
function rebuild(){clearHover();clear(world);clear(detail);clear(selection);targets=[];const s=getState();updateLighting(s);for(const a of s.zones){let m=new T.MeshStandardMaterial({color:new T.Color('#f3f4f6').lerp(new T.Color(a.color),.32),roughness:.9});let shape=new T.Shape(zonePoints(a).map(p=>new T.Vector2(p.x,-p.z)));let o=new T.Mesh(new T.ExtrudeGeometry(shape,{depth:.05,bevelEnabled:false}),m);o.rotation.x=-Math.PI/2;o.position.y=-.03;o.userData={type:'zone',id:a.id};o.receiveShadow=true;world.add(o);targets.push(o);}syncTags();
// Shared instance batches keep the whole warehouse interactive.
const batches={};for(const r of s.racks)for(const part of rackParts(r)){(batches[part.kind]??=[]).push({r,part});}
let dummy=new T.Object3D();for(const [kind,items] of Object.entries(batches)){let inst=new T.InstancedMesh(geometry,materials[kind],items.length);items.forEach(({r,part},i)=>{partTransform(dummy,part,r.x,r.z);inst.setMatrixAt(i,dummy.matrix);});inst.castShadow=true;inst.receiveShadow=true;inst.userData.partKind=kind;world.add(inst);}
let rackHits=new T.InstancedMesh(geometry,new T.MeshBasicMaterial({visible:false}),s.racks.length);dummy.quaternion.identity();s.racks.forEach((r,i)=>{dummy.position.set(r.x,r.height/2,r.z);dummy.scale.set(r.width,r.height,r.depth);dummy.updateMatrix();rackHits.setMatrixAt(i,dummy.matrix);});rackHits.userData={type:'racks'};world.add(rackHits);targets.push(rackHits);
rebuildCargo();}
// Every box on the shelves, one instanced batch. Rebuilt alone when robots move stock.
// Shelf boxes, one batch per zone so a robot move redraws one zone, not the warehouse. Each zone has a far
// level (plain cubes, always built) and a near level (the Blender carton with a sticker, built when the camera comes close).
const cargoGroup=new T.Group();scene.add(cargoGroup);
const zoneCargo=new Map(),NEAR=110,zeroMatrix=new T.Matrix4().makeScale(0,0,0);let rackZone=new Map();
function disposeBatch(meshes){for(const m of Object.values(meshes||{})){m.parent?.remove(m);m.dispose();}}
function dropNear(z){disposeBatch(z.near);z.near=null;}
function buildZone(zoneId,rackIds){let z=zoneCargo.get(zoneId);if(z){disposeBatch(z.far);dropNear(z);}else{z={zone:zoneId,group:new T.Group(),center:new T.Vector3()};cargoGroup.add(z.group);zoneCargo.set(zoneId,z);}
 z.rackIds=rackIds;z.layout=robotics.posesOf(rackIds);z.indices=Object.fromEntries(rackIds.map(id=>[id,[]]));z.layout.forEach((p,i)=>z.indices[p.box.rack].push(i));
 const zone=getState().zones.find(a=>a.id===zoneId);if(zone)z.center.set(zone.x+zone.w/2,3,zone.z+zone.d/2);
 z.far=cargoMeshes(z.layout,z.group,null,null,false,true);tagBatch(z,z.far);}
function tagBatch(z,meshes){Object.assign(meshes.body.userData,{type:'boxes',shelfCargo:true,ids:z.layout.map(p=>p.box.id),racks:z.layout.map(p=>p.box.rack),layout:z.layout});}
function rebuildCargo(change={all:true}){const s=getState();
 if(change.all){for(const z of zoneCargo.values()){disposeBatch(z.far);dropNear(z);cargoGroup.remove(z.group);}zoneCargo.clear();rackZone=new Map(s.racks.map(r=>[r.id,r.zone]));
  const byZone=new Map();for(const r of s.racks){if(!byZone.has(r.zone))byZone.set(r.zone,[]);byZone.get(r.zone).push(r.id);}for(const [id,ids] of byZone)buildZone(id,ids);}
 else{const zones=new Set([...change.racks].map(id=>rackZone.get(id)).filter(Boolean));for(const id of zones)buildZone(id,zoneCargo.get(id)?.rackIds||s.racks.filter(r=>r.zone===id).map(r=>r.id));}
 hideSelectedCargo();}
// Near or far per zone, by camera distance; the near level is made the first time it is needed.
function updateCargoDetail(){for(const z of zoneCargo.values()){const near=camera.position.distanceTo(z.center)<NEAR;
 if(near&&!z.near){z.near=cargoMeshes(z.layout,z.group);tagBatch(z,z.near);hideSelectedCargo(z);}
 for(const m of Object.values(z.far))m.visible=!near;if(z.near)for(const m of Object.values(z.near))m.visible=near;}}
// Boxes of the selected rack are drawn by the close-up view instead, so they are hidden in the batches.
let hiddenRack=null;
function hideSelectedCargo(only=null){if(!hiddenRack)return;const z=zoneCargo.get(rackZone.get(hiddenRack));if(!z||only&&only!==z)return;
 for(const set of [z.far,z.near])for(const m of Object.values(set||{})){for(const i of z.indices[hiddenRack]||[])m.setMatrixAt(i,zeroMatrix);m.instanceMatrix.needsUpdate=true;}}
const hitBox=new T.Box3(),hitPoint=new T.Vector3();
// Instead of ray-testing every box in the warehouse, test only the boxes of the rack under the cursor.
function cargoHit(rid){const z=zoneCargo.get(rackZone.get(rid));if(!z)return null;const body=(z.near||z.far).body;let best=null;for(const i of z.indices[rid]||[]){const p=z.layout[i];hitBox.min.set(p.x-p.w/2,p.y-p.h/2,p.z-p.d/2);hitBox.max.set(p.x+p.w/2,p.y+p.h/2,p.z+p.d/2);if(ray.ray.intersectBox(hitBox,hitPoint)){const distance=hitPoint.distanceTo(ray.ray.origin);if(!best||distance<best.distance)best={object:body,instanceId:i,distance};}}return best;}
function rackBounds(r){return new T.Box3(new T.Vector3(r.x-r.width/2-.1,0,r.z-r.depth/2-.1),new T.Vector3(r.x+r.width/2+.1,r.height+.15,r.z+r.depth/2+.1));}
let current=null;
// When the selection leaves a rack, its zone is redrawn so the rack's boxes come back.
function releaseHidden(sel){if(!hiddenRack)return;const s=getState(),rid=sel?.type==='rack'?sel.id:sel?.type==='location'?sel.id.split('|')[0]:sel?.type==='box'?robotics.boxInfo(sel.id)?.rack:null;if(rid===hiddenRack)return;const zone=rackZone.get(hiddenRack);hiddenRack=null;if(zone)buildZone(zone,zoneCargo.get(zone)?.rackIds||s.racks.filter(r=>r.zone===zone).map(r=>r.id));}
function select(sel,focus=true){current=sel;focus=focus&&!building;clear(detail);clear(selection);releaseHidden(sel);targets=targets.filter(t=>!t.userData.detail);let s=getState(),rid=sel?.type==='rack'?sel.id:sel?.type==='location'?sel.id.split('|')[0]:sel?.type==='box'?s.boxes.find(b=>b.id===sel.id)?.rack:null,r=s.racks.find(r=>r.id===rid);let a=sel?.type==='zone'?s.zones.find(a=>a.id===sel.id):null;
if(r){if(!building){let bs=s.boxes.filter(b=>b.rack===r.id),layout=boxLayout(r,bs),cargo=cargoMeshes(layout,detail,sel.id,sel.type==='location'?sel.id.split('|')[1]:null,true);cargo.body.userData={type:'boxes',ids:layout.map(p=>p.box.id),racks:layout.map(()=>r.id),detail:true};targets.push(cargo.body);
if(hiddenRack!==r.id){const was=hiddenRack;hiddenRack=r.id;if(was&&rackZone.get(was)!==rackZone.get(r.id))buildZone(rackZone.get(was),zoneCargo.get(rackZone.get(was))?.rackIds||[]);}hideSelectedCargo();
// Address plates sit on front crossbeams, like a real rack.
const turns=(r.rotation||0)%4,localWidth=turns%2?r.depth:r.width,localDepth=turns%2?r.width:r.depth;for(let sh=0;sh<r.shelves;sh++)for(let pl=0;pl<r.places;pl++){let canvas=document.createElement('canvas');canvas.width=192;canvas.height=48;let c=canvas.getContext('2d');c.fillStyle='#e8ebdf';c.fillRect(0,0,192,48);c.fillStyle='#303c43';c.font='bold 22px Arial';c.textAlign='center';c.fillText(`S${sh+1}–P${pl+1}`,96,32);let plate=new T.Mesh(new T.PlaneGeometry(Math.min(.65,localWidth/r.places*.65),.15),new T.MeshBasicMaterial({map:new T.CanvasTexture(canvas)}));let px=-localWidth/2+(pl+.5)*localWidth/r.places,pz=localDepth/2+.065;for(let t=0;t<turns;t++)[px,pz]=[-pz,px];plate.position.set(r.x+px,shelfBase(r,sh)+.025,r.z+pz);plate.rotation.y=-turns*Math.PI/2;detail.add(plate);}}
let outline=new T.Box3Helper(rackBounds(r),0xe2bd00);selection.add(outline);if(sel.type==='location'){let [,sh,pl]=/^S(\d+)-P(\d+)$/.exec(sel.id.split('|')[1]);let turns=(r.rotation||0)%4,lw=turns%2?r.depth:r.width,ld=turns%2?r.width:r.depth,cell=lw/r.places,gap=rackLevels(r).gap,highlight=new T.Mesh(geometry,new T.MeshBasicMaterial({color:0xffe000,transparent:true,opacity:.16,depthWrite:false}));let hx=-lw/2+(Number(pl)-.5)*cell,hz=0;for(let t=0;t<turns;t++)[hx,hz]=[-hz,hx];highlight.position.set(r.x+hx,rackLevels(r).base+(Number(sh)-.5)*gap,r.z+hz);highlight.scale.set(turns%2?ld:cell,gap,turns%2?cell:ld);selection.add(highlight);}if(focus){let size=Math.max(r.width,r.height,r.depth,4);fly(new T.Vector3(r.x,r.height*.4,r.z),new T.Vector3(size*1.7,size*1.3,size*2.2));}
}else if(a){let outline=new T.LineLoop(new T.BufferGeometry().setFromPoints(zonePoints(a).map(p=>new T.Vector3(p.x,.08,p.z))),new T.LineBasicMaterial({color:0xd2ad00}));selection.add(outline);if(focus)fly(new T.Vector3(a.x+a.w/2,0,a.z+a.d/2),new T.Vector3(a.w*.55,a.w*.9,a.w*.85));}else if(focus)home();}
function fly(target,offset){anim={start:performance.now(),p:camera.position.clone(),t:controls.target.clone(),end:target.clone().add(offset),target};}
function home(){following=null;fly(new T.Vector3(extent.cx,0,extent.cz),homeOffset);}
const ray=new T.Raycaster(),pointer=new T.Vector2();function cast(e){let rect=renderer.domElement.getBoundingClientRect();pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);ray.setFromCamera(pointer,camera);}
function ground(e){cast(e);let p=new T.Vector3();return ray.ray.intersectPlane(new T.Plane(new T.Vector3(0,1,0),0),p)?p:null;}
let preview=new T.Mesh(new T.PlaneGeometry(1,1),new T.MeshBasicMaterial({color:0xf4cf00,transparent:true,opacity:.3,side:T.DoubleSide}));preview.rotation.x=-Math.PI/2;preview.visible=false;scene.add(preview);
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
function outlinePart(sel){panelSel=sel;clearHover();const bounds=sel&&partBounds(sel);if(!bounds)return;hoverKey='panel';const line=new T.Box3Helper(bounds,0xe2bd00);line.material.depthTest=false;line.renderOrder=10;hover.add(line);const fill=new T.Mesh(geometry,new T.MeshBasicMaterial({color:0xffdc00,transparent:true,opacity:.32,depthWrite:false}));bounds.getCenter(fill.position);bounds.getSize(fill.scale);hover.add(fill);}
function hit(e){cast(e);let hits=ray.intersectObjects(building?targets.filter(t=>!t.userData.detail):[...targets,...(layers.robots?robotics.hits:[])],false);let first=hits[0];if(first?.object.userData.type==='racks'){let rid=getState().racks[first.instanceId]?.id;let detailHit=hits.find(h=>h.object.userData.type==='boxes'&&h.object.userData.racks?.[h.instanceId]===rid)||cargoHit(rid);if(detailHit)first=detailHit;}return first;}
function identity(h){if(!h)return null;let d=h.object.userData;if(d.type==='boxes')return {type:'box',id:d.ids[h.instanceId]};if(d.type==='racks')return {type:'rack',id:getState().racks[h.instanceId].id};return {type:d.type,id:d.id};}
function placeInfo(e){let p=ground(e);if(!p)return null;let s=getState(),sn=snapRack(s,p,rackConfig,!e.altKey);p.x=sn.x;p.z=sn.z;let z=s.zones.find(z=>contains(z,p)),valid=true,reason='';try{placement(s,z?.id,p.x,p.z,rackConfig);validateLayoutAccess(s.racks,[...s.racks,{id:'preview-rack',zone:z?.id,x:p.x,z:p.z,...rackConfig}],docksOf(s),docksOf(s),s.spine);}catch(e){valid=false;reason=e.message;}return {p,valid,reason,snapped:sn.snapped};}
let corners=[];const draftLine=new T.Line(new T.BufferGeometry(),new T.LineBasicMaterial({color:0xb89a00,depthTest:false}));draftLine.renderOrder=20;scene.add(draftLine);
function drawCorners(cursor){const ps=[...corners];if(cursor)ps.push(cursor);if(ps.length>1)ps.push(ps[0]);draftLine.geometry.dispose();draftLine.geometry=new T.BufferGeometry().setFromPoints(ps.map(p=>new T.Vector3(p.x,.2,p.z)));}
function finishZone(){try{const z=polygonZone(corners);if(onDraw('zone',z)===false)return;corners=[];drawCorners();tooltip.hidden=true;}catch(e){tooltip.textContent=e.message;tooltip.hidden=false;tooltip.style.left='40%';tooltip.style.top='100px';}}
document.addEventListener('keydown',e=>{if(mode!=='polygon'||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;if(e.key==='Enter'){e.preventDefault();finishZone();}if(e.key==='Backspace'){e.preventDefault();corners.pop();drawCorners();}});

function showHover(e){if(mode!=='browse'||down)return;let h=hit(e),sel=identity(h);if(!sel){clearHover();container.style.cursor='grab';return;}let key=sel.type+sel.id;if(key!==hoverKey){clearHover();hoverKey=key;let s=getState(),bounds=new T.Box3();if(sel.type==='zone'){let z=s.zones.find(z=>z.id===sel.id);bounds.set(new T.Vector3(z.x,.04,z.z),new T.Vector3(z.x+z.w,.2,z.z+z.d));tooltip.textContent=z.name;}else if(sel.type==='rack'){let r=s.racks.find(r=>r.id===sel.id);bounds.copy(rackBounds(r));tooltip.textContent='Rack '+r.id;}else if(sel.type==='robot'){bounds.setFromObject(h.object);tooltip.textContent=sel.id;}else{let m=new T.Matrix4();h.object.getMatrixAt(h.instanceId,m);bounds.setFromCenterAndSize(new T.Vector3(),new T.Vector3(1.08,1.08,1.08)).applyMatrix4(m).applyMatrix4(h.object.matrixWorld);tooltip.textContent=sel.id;}let line=new T.Box3Helper(bounds,0xb39a00);line.material.depthTest=false;line.renderOrder=10;hover.add(line);let fill=new T.Mesh(geometry,new T.MeshBasicMaterial({color:0xffdc00,transparent:true,opacity:.16,depthWrite:false}));bounds.getCenter(fill.position);bounds.getSize(fill.scale);hover.add(fill);}tooltip.hidden=false;tooltip.style.left=Math.min(e.offsetX+18,container.clientWidth-160)+'px';tooltip.style.top=Math.max(10,e.offsetY-36)+'px';container.style.cursor='pointer';}
renderer.domElement.addEventListener('pointerdown',e=>{if(e.button!==0)return;down={x:e.clientX,y:e.clientY};clearHover();if(mode==='zone'){start=ground(e);renderer.domElement.setPointerCapture(e.pointerId);}});
renderer.domElement.addEventListener('pointermove',e=>{lastPointer=e;if(mode==='polygon'){let p=ground(e);if(p)drawCorners({x:Math.round(p.x),z:Math.round(p.z)});return;}if(mode==='rack'){let info=placeInfo(e);if(info){ghost.visible=true;ghost.position.set(info.p.x,0,info.p.z);ghostMaterial.color.set(info.valid?(info.snapped?0x47adbe:0x80a45c):0xd46c56);tooltip.hidden=false;tooltip.textContent=info.valid?(info.snapped?'Aligned · Click to place':'Click to place'):info.reason;tooltip.style.left=(e.offsetX+18)+'px';tooltip.style.top=(e.offsetY-30)+'px';}}else if(start&&mode==='zone'){let p=ground(e);if(p){preview.visible=true;preview.position.set((p.x+start.x)/2,.2,(p.z+start.z)/2);preview.scale.set(Math.abs(p.x-start.x),Math.abs(p.z-start.z),1);}}else showHover(e);});
renderer.domElement.addEventListener('pointerleave',()=>{clearHover();ghost.visible=false;});
renderer.domElement.addEventListener('pointercancel',()=>{down=null;start=null;preview.visible=false;});
renderer.domElement.addEventListener('pointerup',e=>{if(e.button!==0)return;let origin=down;down=null;if(mode==='zone'&&start){let p=ground(e);if(p)onDraw('zone',{x:Math.min(start.x,p.x),z:Math.min(start.z,p.z),w:Math.abs(p.x-start.x),d:Math.abs(p.z-start.z)});start=null;preview.visible=false;return;}if(!origin||Math.hypot(e.clientX-origin.x,e.clientY-origin.y)>6)return;if(mode==='polygon'){let p=ground(e);if(p){let q={x:Math.round(p.x),z:Math.round(p.z)};if(corners.length>=3&&Math.hypot(q.x-corners[0].x,q.z-corners[0].z)<1.5)finishZone();else{corners.push(q);drawCorners();}}return;}if(mode==='rack'){let info=placeInfo(e);if(info)onDraw('rack',info.p);return;}onPick(identity(hit(e)));});
controls.addEventListener('start',()=>{anim=null;following=null;});
new ResizeObserver(()=>{let w=container.clientWidth,h=container.clientHeight;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();}).observe(container);
// The simulation runs on wall-clock time, not frames: it catches up in 0.1 s steps (capped at 30 s), and keeps going from a timer while the tab is hidden and rAF is paused.
let simTime=performance.now();function step(now){let dt=Math.min(30,(now-simTime)/1000);simTime=now;while(dt>1e-6){const h=Math.min(.1,dt);robotics.update(h);dt-=h;}}
setInterval(()=>{if(document.hidden)step(performance.now());},1000);
// Inventory and History cover the scene, so skip drawing it; the cargo flag keeps until the scene is back and is rebuilt once.
// Map tags: zone and dock names as HTML over the 3D view (crisp text on a blurred white plate).
const tagLayer=document.createElement('div');tagLayer.className='map-tags';container.append(tagLayer);const tags=new Map(),tagPoint=new T.Vector3();
function syncTags(){const s=getState(),want=[...s.zones.map(a=>({key:'zone:'+a.id,text:a.name,kind:'zone',color:a.color,x:a.x+a.w/2,y:.3,z:a.z+a.d/2})),...robotics.mapTags().map(t=>({...t,key:'dock:'+t.key}))];const keys=new Set(want.map(t=>t.key));
 for(const [k,t] of tags)if(!keys.has(k)){t.el.remove();tags.delete(k);}
 for(const t of want){let o=tags.get(t.key);if(!o){const el=document.createElement('div');el.className='map-tag tag-'+t.kind;tagLayer.append(el);o={el};tags.set(t.key,o);}const html=(t.color?`<i style="background:${t.color}"></i>`:'')+`<span>${t.text.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'})[c])}</span>`;if(o.html!==html){o.el.innerHTML=html;o.html=html;}Object.assign(o,t);}}
// Docks move when the layout changes, so positions are refreshed every frame (cheap: ~40 tags).
// Dock names only show from close enough; from further away they pile up on top of each other.
const DOCK_TAG_RANGE=Math.max(260,extent.size*.6);
function placeTags(){syncTags();const w=renderer.domElement.clientWidth,h=renderer.domElement.clientHeight;tagLayer.hidden=building;if(building)return;
 for(const t of tags.values()){const on=t.kind==='zone'?layers.zoneTags&&layers.zones:layers.dockTags&&(t.kind==='building'||camera.position.distanceTo(tagPoint.set(t.x,t.y,t.z))<DOCK_TAG_RANGE);tagPoint.set(t.x,t.y,t.z).project(camera);const show=on&&tagPoint.z<1&&Math.abs(tagPoint.x)<1.1&&Math.abs(tagPoint.y)<1.1;
  if(!show){if(t.shown!==false){t.el.style.display='none';t.shown=false;}continue;}if(t.shown!==true){t.el.style.display='';t.shown=true;}t.el.style.transform=`translate(${((tagPoint.x+1)/2*w).toFixed(1)}px,${((1-tagPoint.y)/2*h).toFixed(1)}px) translate(-50%,-50%)`;}}
const sceneHidden=()=>document.body.classList.contains('inventory-mode')||document.body.classList.contains('history-mode');
renderer.setAnimationLoop(()=>{step(performance.now());if(sceneHidden())return;const change=robotics.consumeVisualChange();if(change){clearHover();rebuildCargo(change);if(change.all||current)select(current,false);if(panelSel)outlinePart(panelSel);}updateCargoDetail();const ip=inspectedId?robotics.boxPose(inspectedId):null;inspection.visible=!!ip;if(ip)inspection.box.setFromCenterAndSize(new T.Vector3(ip.x,ip.y,ip.z),new T.Vector3(ip.w+.15,ip.h+.15,ip.d+.15));if(anim){let v=Math.min(1,(performance.now()-anim.start)/850),t=1-Math.pow(1-v,3);camera.position.lerpVectors(anim.p,anim.end,t);controls.target.lerpVectors(anim.t,anim.target,t);if(v===1)anim=null;}if(following&&!anim){const robot=robotics.robots.find(r=>r.id===following);if(robot?.active){const target=robot.g.position.clone().add(new T.Vector3(10,2,-6)),delta=target.clone().sub(controls.target);camera.position.add(delta);controls.target.copy(target);}else following=null;}controls.update();operations.update(.016);const distance=camera.position.distanceTo(controls.target);for(const o of [...world.children,...cargoGroup.children]){if(o.userData.fineDetail)o.visible=distance<140;if(o.userData.partKind==='hardware')o.visible=distance<100;if(o.userData.label)o.visible=layers.labels&&distance<300;if(o.userData.type==='zone'||o.userData.zoneOutline)o.visible=layers.zones;}robotics.updateDetail(camera.position,layers.robots);for(const r of robotics.robots){r.g.visible=r.active&&layers.robots;for(const child of r.g.children)if(child.isSprite)child.visible=layers.labels&&(distance<180||robotics.selected===r.id);}placeTags();renderer.render(scene,camera);});
return {setOccupancy(v){operations.setOccupancy(v);},layer(name){return layers[name];},setLayer(name,on){layers[name]=on;if(name==='lanes')robotics.setLanesVisible(on);},showOrder(id){operations.setOrder(id);robotics.select(null);if(id){const o=robotics.book.orders.find(o=>o.id===id),ps=o?.allocated.map(id=>robotics.boxPose(id)).filter(Boolean)||[];if(ps.length){const b=new T.Box3();ps.forEach(p=>b.expandByPoint(new T.Vector3(p.x,p.y,p.z)));const center=b.getCenter(new T.Vector3()),size=Math.max(30,b.getSize(new T.Vector3()).length());fly(center,new T.Vector3(size*.5,size,size*.7));}}},focusIssue(id){const st=robotics.stations.find(s=>s.id===id);if(st)fly(st.g.position.clone(),new T.Vector3(20,30,24));else{robotics.select(id);fly(robotics.focus(id),new T.Vector3(20,30,24));}},builderContext:{canvas:renderer.domElement,camera,ground,controls,scene,hit,identity,pick:onPick,mode:()=>mode,rackConfig:()=>rackConfig,setMode:m=>{mode=m;controls.mouseButtons.LEFT=null;clearHover();ghost.visible=false;}},robotics,finishZone,focusBox(id){following=null;inspectedId=id;robotics.select(null);const p=robotics.boxPose(id);if(p)fly(new T.Vector3(p.x,p.y,p.z),new T.Vector3(12,15,18));},get following(){return following;},followRobot(id){inspectedId=null;following=id;if(id){robotics.select(id);fly(robotics.focus(id).add(new T.Vector3(10,2,-6)),new T.Vector3(20,38,28));}},focusRobot(id){inspectedId=null;following=null;robotics.select(id);fly(robotics.focus(id).add(new T.Vector3(10,0,-6)),id?new T.Vector3(28,34,42):new T.Vector3(48,60,74));},rebuild,select,preview:outlinePart,home,setRackConfig(c){rackConfig=config(c);updateGhost();ghost.visible=false;},
setBuilding(value){operations.setOrder(null);operations.setOccupancy(false);following=null;building=value;robotics.setBuilding(value);clearHover();if(value){clear(detail);targets=targets.filter(t=>!t.userData.detail);} },
topView(){let distance=camera.position.distanceTo(controls.target);fly(controls.target.clone(),new T.Vector3(0,distance,.01));},
setMode(m){mode=m;corners=[];drawCorners();start=null;down=null;preview.visible=false;ghost.visible=false;clearHover();controls.enabled=true;controls.mouseButtons.LEFT=m==='browse'?T.MOUSE.ROTATE:null;controls.mouseButtons.RIGHT=T.MOUSE.PAN;container.style.cursor=m==='browse'?'grab':'crosshair';},
zoom(n){camera.position.sub(controls.target).multiplyScalar(n).add(controls.target);}};
}
