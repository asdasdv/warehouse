import {validateLayoutAccess} from './layout-access.js';
import {sceneOperations} from './scene-operations.js';
import {zonePoints,contains,snapRack,polygonZone} from './zone-shape.js';
import {rackLevels,shelfBase} from './rack-levels.js';
import * as T from 'three';
import {warehouseShadowFrame} from './shadow-frustum.js';
import {addWarehouseRobots} from './warehouse-robots.js';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {rackParts} from './rack-geometry.js';
import {config,locations,occupancy,boxLayout,placement} from './storage.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
export function createScene(container,getBaseState,onPick,onDraw){
const getState=getBaseState;
const scene=new T.Scene();scene.background=new T.Color('#f7f8f6');scene.fog=new T.Fog('#f7f8f6',600,1200);
const robotics=addWarehouseRobots(scene,getBaseState);
const operations=sceneOperations(scene,robotics,getBaseState);
const camera=new T.PerspectiveCamera(38,1,.1,1500);camera.position.set(150,260,290);
const renderer=new T.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));container.append(renderer.domElement);renderer.outputColorSpace=T.SRGBColorSpace;renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFShadowMap;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.maxPolarAngle=Math.PI*.46;controls.minDistance=8;controls.maxDistance=700;controls.target.set(0,0,0);
scene.add(new T.HemisphereLight(0xffffff,0xa4abb1,1.35));
const sun=new T.DirectionalLight(0xfffaf1,3.2);sun.castShadow=true;const shadowResolution=Math.min(2048,renderer.capabilities.maxTextureSize);sun.shadow.mapSize.set(shadowResolution,shadowResolution);sun.shadow.bias=-.0002;sun.shadow.normalBias=.025;sun.shadow.radius=3;sun.shadow.camera.near=.5;sun.shadow.camera.far=900;scene.add(sun,sun.target);
const fillLight=new T.DirectionalLight(0xdce8ff,1.1);fillLight.position.set(-80,60,-40);scene.add(fillLight);
// Draw ground and its shadow in one opaque pass. Two near-coplanar planes
// lose depth precision at warehouse scale and flicker as the camera rotates.
const groundMaterial=new T.ShadowMaterial({color:0xf7f8f6,transparent:false,depthWrite:true,toneMapped:false});
groundMaterial.onBeforeCompile=shader=>{shader.fragmentShader=shader.fragmentShader.replace(
 'gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );',
 'gl_FragColor = vec4( color * (1.0 - 0.32 * (1.0 - getShadowMask())), 1.0 );'
);};
groundMaterial.customProgramCacheKey=()=> 'opaque-warehouse-ground-v1';
const floor=new T.Mesh(new T.PlaneGeometry(1600,1600),groundMaterial);floor.rotation.x=-Math.PI/2;floor.position.y=-.10;floor.receiveShadow=true;scene.add(floor);
const grid=new T.GridHelper(800,160,0xdce1df,0xe9ece9);grid.position.y=-.08;grid.material.transparent=true;grid.material.opacity=.38;grid.material.depthWrite=false;grid.renderOrder=2;scene.add(grid);
let lightingLayout='';
function updateLighting(s){const key=JSON.stringify([s.racks.map(r=>[r.x,r.z,r.width,r.depth,r.height]),s.zones.map(z=>[z.x,z.z,z.w,z.d])]);if(key===lightingLayout)return;lightingLayout=key;
 const frame=warehouseShadowFrame(s.racks,s.zones);sun.position.copy(frame.position);sun.target.position.copy(frame.target);
 for(const k of ['left','right','top','bottom','near','far'])sun.shadow.camera[k]=frame[k];sun.shadow.camera.updateProjectionMatrix();
}
let following=null,inspectedId=null;const inspection=new T.Box3Helper(new T.Box3(),0xe0b600);inspection.material.depthTest=false;inspection.renderOrder=16;inspection.visible=false;scene.add(inspection);
let world=new T.Group(),detail=new T.Group(),selection=new T.Group();scene.add(world,detail,selection);let targets=[],mode='browse',start=null,down=null,anim=null,building=false,rackConfig=config();
const mat=(c)=>new T.MeshStandardMaterial({color:c,roughness:.8});
const geometry=new T.BoxGeometry(1,1,1),cartonGeometry=new RoundedBoxGeometry(1,1,1,1,.035);
const materials={frame:new T.MeshStandardMaterial({color:'#626d74',metalness:.45,roughness:.5}),beam:new T.MeshStandardMaterial({color:'#8f9a9f',metalness:.35,roughness:.58}),deck:new T.MeshStandardMaterial({color:'#c6cdce',metalness:.25,roughness:.75}),brace:new T.MeshStandardMaterial({color:'#919ca3',metalness:.5,roughness:.45}),hardware:mat('#39444c'),box:mat('#ffffff'),tape:mat('#a87942')};
// Keep the original materials intact so the comparison can switch instantly.
const originalRackMaterials={...materials};
let rasterStyle=true;
const rasterRackMaterials={};
for(const kind of ['frame','beam','deck','brace','hardware','box','tape']){
 const m=materials[kind].clone();
 // Preserve the original metallic palette, roughness and reflections.
 // Only the raster finish differs from the original materials.
 m.onBeforeCompile=shader=>{
 shader.uniforms.rasterPixelRatio={value:renderer.getPixelRatio()};
 shader.fragmentShader='uniform float rasterPixelRatio;\n'+shader.fragmentShader;
 shader.fragmentShader=shader.fragmentShader.replace('#include <colorspace_fragment>',`#include <colorspace_fragment>
 vec2 rasterCell=floor(gl_FragCoord.xy/(3.0*rasterPixelRatio));
 float checker=mod(rasterCell.x+rasterCell.y,2.0);
 float lum=dot(gl_FragColor.rgb,vec3(.2126,.7152,.0722));
 float strength=.55*(.32+.38*min(1.0,lum*2.0));
 vec3 paper=vec3(245.0,245.0,239.0)/255.0;
 gl_FragColor.rgb=checker<.5?mix(gl_FragColor.rgb,paper,strength):gl_FragColor.rgb*(1.0-.55*.13);
 `);
 };
 m.customProgramCacheKey=()=> 'locus-raster-v1';rasterRackMaterials[kind]=m;
}
function applyRackStyle(){for(const kind of Object.keys(rasterRackMaterials))materials[kind]=rasterStyle?rasterRackMaterials[kind]:originalRackMaterials[kind];}
applyRackStyle();
const sharedMaterials=new Set([...Object.values(originalRackMaterials),...Object.values(rasterRackMaterials)]);
let cv=document.createElement('canvas');cv.width=128;cv.height=80;let ctx=cv.getContext('2d');ctx.fillStyle='#f4f4ed';ctx.fillRect(0,0,128,80);ctx.fillStyle='#39434b';ctx.font='bold 12px Arial';ctx.fillText('LOCUS',9,17);ctx.font='7px Arial';ctx.fillText('COMPONENTS / STOCK',9,29);for(let i=0;i<39;i++)ctx.fillRect(9+i*2.8,39,i%3===0?2:1,25);const labelTexture=new T.CanvasTexture(cv);materials.label=new T.MeshStandardMaterial({map:labelTexture,roughness:1});sharedMaterials.add(materials.label);
function mesh(g,x,y,z,w,h,d,m){let o=new T.Mesh(geometry,m);o.position.set(x,y,z);o.scale.set(w,h,d);g.add(o);return o;}
function clear(g){while(g.children.length){let c=g.children[0];g.remove(c);if(c.geometry&&c.geometry!==geometry&&c.geometry!==cartonGeometry)c.geometry.dispose();if(c.isInstancedMesh)c.dispose();if(c.material&&!sharedMaterials.has(c.material)){c.material.map?.dispose();c.material.dispose();}}}
function partTransform(obj,part,x=0,z=0){obj.quaternion.identity();if(part.from){let a=new T.Vector3(...part.from),b=new T.Vector3(...part.to),delta=b.clone().sub(a);obj.position.copy(a.add(b).multiplyScalar(.5));obj.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),delta.clone().normalize());obj.scale.set(part.thickness,delta.length(),part.thickness);}else {obj.position.set(...part.p);obj.scale.set(...part.size);}obj.position.x+=x;obj.position.z+=z;obj.updateMatrix();}
function cargoMeshes(layout,group,selectedId=null,selectedLoc=null,closeUp=false){let obj=new T.Object3D(),body=new T.InstancedMesh(closeUp?cartonGeometry:geometry,materials.box,layout.length),tape=new T.InstancedMesh(geometry,materials.tape,layout.length),labels=new T.InstancedMesh(new T.PlaneGeometry(1,1),materials.label,layout.length);body.castShadow=closeUp;body.receiveShadow=true;
layout.forEach((p,i)=>{obj.position.set(p.x,p.y,p.z);obj.scale.set(p.w,p.h,p.d);obj.updateMatrix();body.setMatrixAt(i,obj.matrix);let chosen=p.box.id===selectedId||selectedLoc&&p.box.location===selectedLoc;body.setColorAt(i,new T.Color(chosen?'#f1d63e':i%4===0?'#b98249':i%3===0?'#d2a16a':'#c39157'));obj.position.set(p.x,p.y+p.h/2+.003,p.z);obj.scale.set(p.w*.13,.006,p.d*.98);obj.updateMatrix();tape.setMatrixAt(i,obj.matrix);obj.position.set(p.x+p.w*.14,p.y-p.h*.02,p.z+p.d/2+.006);obj.scale.set(p.w*.48,p.h*.35,1);obj.updateMatrix();labels.setMatrixAt(i,obj.matrix);});tape.userData.fineDetail=true;labels.userData.fineDetail=true;group.add(body,tape,labels);return {body,tape,labels};}
function label(text,x,z,color='#72796c'){let cv=document.createElement('canvas');cv.width=512;cv.height=96;let ctx=cv.getContext('2d');ctx.font='500 44px Arial';ctx.fillStyle=color;ctx.textAlign='center';ctx.fillText(text,256,64);let tx=new T.CanvasTexture(cv),sp=new T.Sprite(new T.SpriteMaterial({map:tx,depthTest:false,transparent:true}));sp.position.set(x,.6,z);sp.scale.set(18,3.4,1);sp.userData.label=true;world.add(sp);}
function rebuild(){clearHover();clear(world);clear(detail);clear(selection);targets=[];const s=getState();updateLighting(s);for(const a of s.zones){let m=new T.MeshBasicMaterial({color:a.color,transparent:true,opacity:.055,side:T.DoubleSide,depthWrite:false});let shape=new T.Shape(zonePoints(a).map(p=>new T.Vector2(p.x,-p.z)));let o=new T.Mesh(new T.ShapeGeometry(shape),m);o.rotation.x=-Math.PI/2;o.position.y=.015;o.userData={type:'zone',id:a.id};o.receiveShadow=true;o.renderOrder=3;world.add(o);targets.push(o);let outline=new T.LineLoop(new T.BufferGeometry().setFromPoints(zonePoints(a).map(p=>new T.Vector3(p.x,.035,p.z))),new T.LineBasicMaterial({color:a.color,transparent:true,opacity:.28}));world.add(outline);label(a.name,a.x+a.w/2,a.z+2);}
// Shared instance batches keep the whole warehouse interactive.
const batches={};for(const r of s.racks)for(const part of rackParts(r)){(batches[part.kind]??=[]).push({r,part});}
let dummy=new T.Object3D();for(const [kind,items] of Object.entries(batches)){let inst=new T.InstancedMesh(geometry,materials[kind],items.length);items.forEach(({r,part},i)=>{partTransform(dummy,part,r.x,r.z);inst.setMatrixAt(i,dummy.matrix);});inst.castShadow=true;inst.receiveShadow=true;inst.userData.partKind=kind;world.add(inst);}
let rackHits=new T.InstancedMesh(geometry,new T.MeshBasicMaterial({visible:false}),s.racks.length);dummy.quaternion.identity();s.racks.forEach((r,i)=>{dummy.position.set(r.x,r.height/2,r.z);dummy.scale.set(r.width,r.height,r.depth);dummy.updateMatrix();rackHits.setMatrixAt(i,dummy.matrix);});rackHits.userData={type:'racks'};world.add(rackHits);targets.push(rackHits);
rebuildCargo();}
// Every box on the shelves, one instanced batch. Rebuilt alone when robots move stock.
const cargoGroup=new T.Group();scene.add(cargoGroup);
function rebuildCargo(){clear(cargoGroup);targets=targets.filter(t=>!t.userData.shelfCargo);const s=getState(),layout=robotics.displayLayout(),indices=Object.fromEntries(s.racks.map(r=>[r.id,[]]));layout.forEach((p,i)=>indices[p.box.rack]?.push(i));
let cargo=cargoMeshes(layout,cargoGroup);for(let m of Object.values(cargo))m.userData={...m.userData,cargo:true,indices};Object.assign(cargo.body.userData,{type:'boxes',shelfCargo:true,ids:layout.map(p=>p.box.id),racks:layout.map(p=>p.box.rack),layout});shelfCargo=cargo.body;}
let shelfCargo=null;const hitBox=new T.Box3(),hitPoint=new T.Vector3();
// Instead of ray-testing every box in the warehouse, test only the boxes of the rack under the cursor.
function cargoHit(rid){if(!shelfCargo)return null;let best=null;for(const i of shelfCargo.userData.indices[rid]||[]){const p=shelfCargo.userData.layout[i];hitBox.min.set(p.x-p.w/2,p.y-p.h/2,p.z-p.d/2);hitBox.max.set(p.x+p.w/2,p.y+p.h/2,p.z+p.d/2);if(ray.ray.intersectBox(hitBox,hitPoint)){const distance=hitPoint.distanceTo(ray.ray.origin);if(!best||distance<best.distance)best={object:shelfCargo,instanceId:i,distance};}}return best;}
function rackBounds(r){return new T.Box3(new T.Vector3(r.x-r.width/2-.1,0,r.z-r.depth/2-.1),new T.Vector3(r.x+r.width/2+.1,r.height+.15,r.z+r.depth/2+.1));}
let current=null;
function select(sel,focus=true){current=sel;focus=focus&&!building;clear(detail);clear(selection);targets=targets.filter(t=>!t.userData.detail);let s=getState(),rid=sel?.type==='rack'?sel.id:sel?.type==='location'?sel.id.split('|')[0]:sel?.type==='box'?s.boxes.find(b=>b.id===sel.id)?.rack:null,r=s.racks.find(r=>r.id===rid);let a=sel?.type==='zone'?s.zones.find(a=>a.id===sel.id):null;
if(r){if(!building){let bs=s.boxes.filter(b=>b.rack===r.id),layout=boxLayout(r,bs),cargo=cargoMeshes(layout,detail,sel.id,sel.type==='location'?sel.id.split('|')[1]:null,true);cargo.body.userData={type:'boxes',ids:layout.map(p=>p.box.id),racks:layout.map(()=>r.id),detail:true};targets.push(cargo.body);
for(let batch of cargoGroup.children.filter(o=>o.userData.cargo)){for(let i of batch.userData.indices[r.id])batch.setMatrixAt(i,new T.Matrix4().makeScale(0,0,0));batch.instanceMatrix.needsUpdate=true;}
// Address plates sit on front crossbeams, like a real rack.
const turns=(r.rotation||0)%4,localWidth=turns%2?r.depth:r.width,localDepth=turns%2?r.width:r.depth;for(let sh=0;sh<r.shelves;sh++)for(let pl=0;pl<r.places;pl++){let canvas=document.createElement('canvas');canvas.width=192;canvas.height=48;let c=canvas.getContext('2d');c.fillStyle='#e8ebdf';c.fillRect(0,0,192,48);c.fillStyle='#303c43';c.font='bold 22px Arial';c.textAlign='center';c.fillText(`S${sh+1}–P${pl+1}`,96,32);let plate=new T.Mesh(new T.PlaneGeometry(Math.min(.65,localWidth/r.places*.65),.15),new T.MeshBasicMaterial({map:new T.CanvasTexture(canvas)}));let px=-localWidth/2+(pl+.5)*localWidth/r.places,pz=localDepth/2+.065;for(let t=0;t<turns;t++)[px,pz]=[-pz,px];plate.position.set(r.x+px,shelfBase(r,sh)+.025,r.z+pz);plate.rotation.y=-turns*Math.PI/2;detail.add(plate);}}
let outline=new T.Box3Helper(rackBounds(r),0xe2bd00);selection.add(outline);if(sel.type==='location'){let [,sh,pl]=/^S(\d+)-P(\d+)$/.exec(sel.id.split('|')[1]);let turns=(r.rotation||0)%4,lw=turns%2?r.depth:r.width,ld=turns%2?r.width:r.depth,cell=lw/r.places,gap=rackLevels(r).gap,highlight=new T.Mesh(geometry,new T.MeshBasicMaterial({color:0xffe000,transparent:true,opacity:.16,depthWrite:false}));let hx=-lw/2+(Number(pl)-.5)*cell,hz=0;for(let t=0;t<turns;t++)[hx,hz]=[-hz,hx];highlight.position.set(r.x+hx,rackLevels(r).base+(Number(sh)-.5)*gap,r.z+hz);highlight.scale.set(turns%2?ld:cell,gap,turns%2?cell:ld);selection.add(highlight);}if(focus){let size=Math.max(r.width,r.height,r.depth,4);fly(new T.Vector3(r.x,r.height*.4,r.z),new T.Vector3(size*1.7,size*1.3,size*2.2));}
}else if(a){let outline=new T.LineLoop(new T.BufferGeometry().setFromPoints(zonePoints(a).map(p=>new T.Vector3(p.x,.08,p.z))),new T.LineBasicMaterial({color:0xd2ad00}));selection.add(outline);if(focus)fly(new T.Vector3(a.x+a.w/2,0,a.z+a.d/2),new T.Vector3(a.w*.55,a.w*.9,a.w*.85));}else if(focus)home();}
function fly(target,offset){anim={start:performance.now(),p:camera.position.clone(),t:controls.target.clone(),end:target.clone().add(offset),target};}
function home(){following=null;fly(new T.Vector3(0,0,0),new T.Vector3(150,260,290));}
const ray=new T.Raycaster(),pointer=new T.Vector2();function cast(e){let rect=renderer.domElement.getBoundingClientRect();pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);ray.setFromCamera(pointer,camera);}
function ground(e){cast(e);let p=new T.Vector3();return ray.ray.intersectPlane(new T.Plane(new T.Vector3(0,1,0),0),p)?p:null;}
let preview=new T.Mesh(new T.PlaneGeometry(1,1),new T.MeshBasicMaterial({color:0xf4cf00,transparent:true,opacity:.3,side:T.DoubleSide}));preview.rotation.x=-Math.PI/2;preview.visible=false;scene.add(preview);
const hover=new T.Group();scene.add(hover);let hoverKey='',lastPointer=null;
const tooltip=document.createElement('div');tooltip.className='scene-tooltip';tooltip.hidden=true;container.append(tooltip);
const ghost=new T.Group();scene.add(ghost);const ghostMaterial=new T.MeshBasicMaterial({color:0x88a866,transparent:true,opacity:.45,depthWrite:false});
function updateGhost(){while(ghost.children.length)ghost.remove(ghost.children[0]);let obj=new T.Object3D();for(let part of rackParts(rackConfig)){if(part.kind==='hardware')continue;partTransform(obj,part);let m=new T.Mesh(geometry,ghostMaterial);m.position.copy(obj.position);m.quaternion.copy(obj.quaternion);m.scale.copy(obj.scale);ghost.add(m);}}
updateGhost();ghost.visible=false;
function clearHover(){clear(hover);hoverKey='';tooltip.hidden=true;}
function hit(e){cast(e);let hits=ray.intersectObjects(building?targets.filter(t=>!t.userData.detail):[...targets,...robotics.hits],false);let first=hits[0];if(first?.object.userData.type==='racks'){let rid=getState().racks[first.instanceId]?.id;let detailHit=hits.find(h=>h.object.userData.type==='boxes'&&h.object.userData.racks?.[h.instanceId]===rid)||cargoHit(rid);if(detailHit)first=detailHit;}return first;}
function identity(h){if(!h)return null;let d=h.object.userData;if(d.type==='boxes')return {type:'box',id:d.ids[h.instanceId]};if(d.type==='racks')return {type:'rack',id:getState().racks[h.instanceId].id};return {type:d.type,id:d.id};}
function placeInfo(e){let p=ground(e);if(!p)return null;let s=getState(),sn=snapRack(s,p,rackConfig,!e.altKey);p.x=sn.x;p.z=sn.z;let z=s.zones.find(z=>contains(z,p)),valid=true,reason='';try{placement(s,z?.id,p.x,p.z,rackConfig);validateLayoutAccess(s.racks,[...s.racks,{id:'preview-rack',zone:z?.id,x:p.x,z:p.z,...rackConfig}]);}catch(e){valid=false;reason=e.message;}return {p,valid,reason,snapped:sn.snapped};}
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
const sceneHidden=()=>document.body.classList.contains('inventory-mode')||document.body.classList.contains('history-mode');
renderer.setAnimationLoop(()=>{step(performance.now());if(sceneHidden())return;if(robotics.consumeVisualChange()){clearHover();rebuildCargo();select(current,false);}const ip=inspectedId?robotics.boxPose(inspectedId):null;inspection.visible=!!ip;if(ip)inspection.box.setFromCenterAndSize(new T.Vector3(ip.x,ip.y,ip.z),new T.Vector3(ip.w+.15,ip.h+.15,ip.d+.15));if(anim){let v=Math.min(1,(performance.now()-anim.start)/850),t=1-Math.pow(1-v,3);camera.position.lerpVectors(anim.p,anim.end,t);controls.target.lerpVectors(anim.t,anim.target,t);if(v===1)anim=null;}if(following&&!anim){const robot=robotics.robots.find(r=>r.id===following);if(robot?.active){const target=robot.g.position.clone().add(new T.Vector3(10,2,-6)),delta=target.clone().sub(controls.target);camera.position.add(delta);controls.target.copy(target);}else following=null;}controls.update();operations.update(.016);const distance=camera.position.distanceTo(controls.target);for(const o of [...world.children,...cargoGroup.children]){if(o.userData.fineDetail)o.visible=distance<140;if(o.userData.partKind==='hardware')o.visible=distance<100;if(o.userData.label)o.visible=distance<300;}for(const r of robotics.robots)for(const child of r.g.children)if(child.isSprite)child.visible=distance<180||robotics.selected===r.id;renderer.render(scene,camera);});
return {setOccupancy(v){operations.setOccupancy(v);},showOrder(id){operations.setOrder(id);robotics.select(null);if(id){const o=robotics.book.orders.find(o=>o.id===id),ps=o?.allocated.map(id=>robotics.boxPose(id)).filter(Boolean)||[];if(ps.length){const b=new T.Box3();ps.forEach(p=>b.expandByPoint(new T.Vector3(p.x,p.y,p.z)));const center=b.getCenter(new T.Vector3()),size=Math.max(30,b.getSize(new T.Vector3()).length());fly(center,new T.Vector3(size*.5,size,size*.7));}}},focusIssue(id){const st=robotics.stations.find(s=>s.id===id);if(st)fly(st.g.position.clone(),new T.Vector3(20,30,24));else{robotics.select(id);fly(robotics.focus(id),new T.Vector3(20,30,24));}},builderContext:{canvas:renderer.domElement,camera,ground,controls,scene,hit,identity,pick:onPick,mode:()=>mode,rackConfig:()=>rackConfig,setMode:m=>{mode=m;controls.mouseButtons.LEFT=null;clearHover();ghost.visible=false;}},robotics,finishZone,get rackStyle(){return rasterStyle?'raster':'original';},setRackStyle(value){rasterStyle=value==='raster';applyRackStyle();rebuild();},focusBox(id){following=null;inspectedId=id;robotics.select(null);const p=robotics.boxPose(id);if(p)fly(new T.Vector3(p.x,p.y,p.z),new T.Vector3(12,15,18));},get following(){return following;},followRobot(id){inspectedId=null;following=id;if(id){robotics.select(id);fly(robotics.focus(id).add(new T.Vector3(10,2,-6)),new T.Vector3(20,38,28));}},focusRobot(id){inspectedId=null;following=null;robotics.select(id);fly(robotics.focus(id).add(new T.Vector3(10,0,-6)),id?new T.Vector3(28,34,42):new T.Vector3(48,60,74));},rebuild,select,home,setRackConfig(c){rackConfig=config(c);updateGhost();ghost.visible=false;},
setBuilding(value){operations.setOrder(null);operations.setOccupancy(false);following=null;building=value;robotics.setBuilding(value);clearHover();if(value){clear(detail);targets=targets.filter(t=>!t.userData.detail);} },
topView(){let distance=camera.position.distanceTo(controls.target);fly(controls.target.clone(),new T.Vector3(0,distance,.01));},
setMode(m){mode=m;corners=[];drawCorners();start=null;down=null;preview.visible=false;ghost.visible=false;clearHover();controls.enabled=true;controls.mouseButtons.LEFT=m==='browse'?T.MOUSE.ROTATE:null;controls.mouseButtons.RIGHT=T.MOUSE.PAN;container.style.cursor=m==='browse'?'grab':'crosshair';},
zoom(n){camera.position.sub(controls.target).multiplyScalar(n).add(controls.target);}};
}
