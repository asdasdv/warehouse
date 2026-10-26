import * as T from 'three';
import {locations,boxLayout} from './storage.js';
import {createOrderBook} from './order-book.js';
import {flowPolicy} from './flow-policy.js';
import {createRouter} from './robot-routing.js';
export function addWarehouseRobots(scene,getState,onSelect){
 const group=new T.Group();scene.add(group);const robots=[],hits=[],stations=[],events=[];let paused=false,suspended=false,selected=null,bounds='',layout=null,delivered=0,router,serial=0;const reserved=new Set(),virtualLocations=new Map(),virtualSlots=new Map(),inTransit=new Set();let visualDirty=false;
 const poses=new Map(), destinationClaims=new Map();
 let revision=0,arrived=0;const activity=[];
 function record(type,b,detail){revision++;activity.unshift({id:`sim-${revision}`,type,detail:`${b.id} · ${b.product} · ${detail}`,time:new Date().toISOString()});activity.splice(200);}

 let inventoryKey='',syncElapsed=1;let occupiedAt=new Map();
 const incoming=new Map(),storedTimes=new Map();let elapsed=0,arrivalClock=0,arrivalSerial=0,received=0,shipped=0,autoInbound=true;
 const book=createOrderBook(),transfers=[];let bulkRemaining=0,obstruction=null,obstacleMesh=null;
 const stationCapacity=6;
 function routingRacks(){return [...getState().racks,...(obstruction?[obstruction]:[])];}
 function reroute(){router=createRouter(routingRacks());for(const r of robots){if(!r.task)continue;const from=r.task.source?router.port(r.task.source):r.task.sourceStation.port;r.task.carry=router.route(from,r.task.destination);if(['To pickup','Transporting'].includes(r.stage)){r.path=router.route(r.g.position,r.stage==='To pickup'?from:r.task.destination)||[];r.index=0;r.routeBlocked=!r.path.length;}}}
 function scenario(name){
  if(name==='Large delivery'){bulkRemaining+=24;log('Scenario · 24 inbound boxes queued');}
  if(name==='Shipping peak'){for(const product of [...new Set(getState().boxes.map(b=>b.product))].slice(0,3))book.create(product,12,'Urgent');log('Scenario · 3 urgent orders');}
  if(name==='Blocked aisle'&&!obstruction){const r=robots.find(r=>r.task&&r.path?.length>r.index+4);if(!r)throw Error('Wait until a robot has a route.');const p=r.path.slice(r.index+4).find(p=>robots.every(x=>!x.active||Math.hypot(x.g.position.x-p.x,x.g.position.z-p.z)>7));if(!p)throw Error('No clear stretch of aisle available yet.');obstruction={x:p.x,z:p.z,width:5,depth:3};obstacleMesh=box(group,p.x,.6,p.z,5,1.2,3,new T.MeshStandardMaterial({color:'#e69a48'}));reroute();log('Scenario · aisle closed, routes recalculated');}
  if(name==='Robot unavailable'){const r=robots.find(r=>r.active&&!r.unavailable);if(r){r.unavailable=true;log(`${r.id} unavailable · current load held safely`);}}
  if(name==='Restore'){bulkRemaining=0;obstruction=null;if(obstacleMesh){group.remove(obstacleMesh);obstacleMesh.material.dispose();obstacleMesh=null;}for(const r of robots)r.unavailable=false;reroute();log('Scenario obstacles cleared; robots restored');}
 }
 function boxInfo(id){const b=allBoxes().find(b=>b.id===id);if(!b)return null;const r=robots.find(r=>r.task?.box.id===id),o=book.forBox(id),p=poses.get(id),v=virtualLocations.get(id);return {...b,rack:p?.box.rack||v||b.rack,location:p?.box.location||virtualSlots.get(id)||b.location,status:o?.shipped.includes(id)?'Shipped':inTransit.has(id)?'In transit':v==='dispatch'?'At dispatch':v==='receiving'?'Receiving':transfers.some(t=>t.id===id&&t.status==='Queued')?'Transfer queued':reserved.has(id)||o&&o.shipped.length<o.quantity?'Reserved':'Stored',robot:r?.id,order:o?.id,destination:r?.to||transfers.find(t=>t.id===id&&t.status!=='Done')?.rackId,actionable:poses.has(id)&&!reserved.has(id)&&!transfers.some(t=>t.id===id&&t.status!=='Done')&&!o};}
 function requestMove(id,rackId){const info=boxInfo(id),rack=getState().racks.find(r=>r.id===rackId);if(!info?.actionable||!rack||rackId===info.rack)throw Error('Choose an available box and a different rack.');transfers.push({id,rackId,status:'Queued'});log(`${id} · transfer requested to ${rackId}`);}

 let policy=flowPolicy(0,0,0),balanceClock=2;
 function balance(){
  const addresses=new Set([...poses.values(),...destinationClaims.values()].filter(p=>p.box.rack!=='dispatch').map(p=>p.box.rack+'|'+p.box.location));
  const waiting=stations.filter(s=>s.kind==='inbound').reduce((n,s)=>n+s.queue.filter(q=>!reserved.has(q.box.id)).length,0);
  const next=flowPolicy(addresses.size,getState().racks.reduce((n,r)=>n+r.shelves*r.places,0),waiting,policy.mode);
  if(next.mode!==policy.mode)log(`Flow · ${next.mode}`);policy=next;
  robots.forEach((r,i)=>{
   const bottleneck=robots.filter(r=>r.status==='Waiting for traffic'||r.status==='Waiting for station'||r.routeBlocked).length>=2;const wanted=i<Math.min(robots.length,bottleneck?4:Math.max(policy.fleetTarget,book.pending>=12?6:4)+robots.filter(r=>r.unavailable).length)&&!r.unavailable;
   if(wanted&&!r.active){r.active=true;r.status='Idle';r.retry=0;log(`${r.id} joined the fleet`);}
   if(!wanted&&r.active&&!r.task&&!r.charging&&!r.unavailable){r.active=false;r.status='Standby';r.cargo.visible=false;log(`${r.id} returned to standby`);}
   r.g.visible=r.active;
  });
 }

 function allBoxes(){return [...getState().boxes,...incoming.values()];}
 function queuePose(st,index,b){return {box:b,x:st.g.position.x+(index%3-1)*2.5,y:.95,z:st.g.position.z+(Math.floor(index/3)-.5)*2.7,w:b.renderSize?.w||1.6,h:b.renderSize?.h||1.4,d:b.renderSize?.d||1.8};}
 function addArrival(){
  const st=stations.filter(s=>s.kind==='inbound'&&s.ready&&s.queue.length<stationCapacity).sort((a,b)=>a.queue.length-b.queue.length)[0];
  if(!st)return false;
  const catalog=[...new Set(getState().boxes.map(b=>b.product))];
  const b={id:`IN-${String(++arrivalSerial).padStart(6,'0')}`,product:catalog[(arrivalSerial-1)%Math.max(1,catalog.length)]||'Circuit breakers',rack:'receiving',location:st.id};
  const rack=getState().racks[0];if(rack){const p=boxLayout(rack,Array.from({length:4},()=>({...b,location:locations(rack)[0]})))[0];b.renderSize={w:p.w,h:p.h,d:p.d};}
  incoming.set(b.id,b);virtualLocations.set(b.id,'receiving');
  const slot=Array.from({length:stationCapacity},(_,i)=>i).find(i=>!st.queue.some(q=>q.slot===i));
  const pose=queuePose(st,slot,b);pose.y=.24+pose.h/2;const mesh=box(st.g,pose.x-st.g.position.x,pose.y,pose.z-st.g.position.z,pose.w,pose.h,pose.d,boxMat);
  box(mesh,0,.51,0,.12,.02,1.01,silver);
  st.queue.push({box:b,slot,pose,mesh,age:0,arrived:true});arrived++;record('Received',b,st.id);log(`${b.id} arrived · ${st.id}`);return true;
 }
 function updateDocks(dt){
  if(paused)return;elapsed+=dt;
  if(bulkRemaining>0&&addArrival())bulkRemaining--;
  arrivalClock+=dt;if(autoInbound&&policy.acceptArrivals&&arrivalClock>=policy.arrivalInterval){arrivalClock=0;addArrival();}
  for(const st of stations){if(!st.ready)continue;for(const q of [...st.queue]){
   if(!q.arrived)continue;q.age+=dt;
   if(st.kind==='inbound'){q.mesh.position.z=q.pose.z-st.g.position.z+Math.max(0,1-q.age)*6;continue;}
   if(q.age>18){q.mesh.position.z=q.pose.z-st.g.position.z+Math.min(1,(q.age-18)/3)*9;}
   if(q.age>=21){st.g.remove(q.mesh);st.queue.splice(st.queue.indexOf(q),1);shipped++;record('Shipped',q.box,st.id);book.ship(q.box.id);incoming.delete(q.box.id);storedTimes.delete(q.box.id);log(`${q.box.id} shipped · ${st.id}`);}
  }}
 }

 function syncPoses(){
  const s=getState(),key=JSON.stringify([s.racks,s.boxes.map(b=>[b.id,b.rack,b.location])]);
  if(key===inventoryKey)return;inventoryKey=key;
  revision++;arrived=0;activity.length=0;book.clear();transfers.length=0;poses.clear();incoming.clear();storedTimes.clear();elapsed=0;arrivalClock=0;received=0;shipped=0;delivered=0;
  for(const st of stations){for(const q of st.queue)st.g.remove(q.mesh);st.queue=[];}
  virtualLocations.clear();virtualSlots.clear();inTransit.clear();reserved.clear();destinationClaims.clear();
  for(const r of robots){r.task=null;r.cargo.visible=false;}
  const groups=new Map();for(const b of s.boxes){const k=b.rack+'|'+b.location;if(!groups.has(k))groups.set(k,[]);if(groups.get(k).length<4)groups.get(k).push(b);}
  for(const rack of s.racks){const bs=[...groups.values()].flat().filter(b=>b.rack===rack.id);for(const p of boxLayout(rack,bs))poses.set(p.box.id,p);}
  for(const product of [...new Set(s.boxes.map(b=>b.product))].slice(0,3))book.create(product,8,'Normal');
  visualDirty=true;
 }
 function destinationPose(rack,loc,b){
  // Fixed four positions per address: removing a box never repacks its neighbours.
  let candidates=boxLayout(rack,Array.from({length:4},(_,i)=>({...b,id:'slot-'+i,location:loc})));
  const occupied=occupiedAt.get(rack.id+'|'+loc)||[];
  const size=poses.get(b.id)||b.renderSize;
  if(size){if(candidates.some(p=>size.w>p.w+.01||size.h>p.h+.01||size.d>p.d+.01))candidates=boxLayout(rack,[{...b,location:loc}]);for(const p of candidates){if(size.w>p.w+.01||size.h>p.h+.01||size.d>p.d+.01)return null;p.y=p.y-p.h/2+size.h/2;p.w=size.w;p.h=size.h;p.d=size.d;}}
  return candidates.find(p=>!occupied.some(o=>Math.abs(o.x-p.x)<(o.w+p.w)/2&&Math.abs(o.z-p.z)<(o.d+p.d)/2));
 }
 function transferPose(r,t){
  const p=r.stage==='Loading'?r.task.pickup:r.task.drop;
  const shelf=new T.Vector3(p.x,p.y,p.z),deck=r.g.localToWorld(new T.Vector3(0,1.5+p.h/2,0));
  const v=t*t*(3-2*t);
  const world=r.stage==='Loading'?shelf.lerp(deck,v):deck.lerp(shelf,v);
  r.cargo.position.copy(r.g.worldToLocal(world));r.cargo.scale.set(p.w,p.h,p.d);
  r.cargo.quaternion.copy(r.g.quaternion).invert();
 }

 const geo=new T.BoxGeometry(1,1,1),yellow=new T.MeshStandardMaterial({color:'#f1cf22',roughness:.55}),black=new T.MeshStandardMaterial({color:'#313b3d'}),silver=new T.MeshStandardMaterial({color:'#a6b1af'}),boxMat=new T.MeshStandardMaterial({color:'#c39157',roughness:.95}),green=new T.MeshBasicMaterial({color:'#66cdb0'});
 function box(parent,x,y,z,w,h,d,material){let m=new T.Mesh(geo,material);m.position.set(x,y,z);m.scale.set(w,h,d);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
 function label(parent,text,x,y,z){let c=document.createElement('canvas');c.width=512;c.height=96;let t=c.getContext('2d');t.fillStyle='#fafbf5';t.fillRect(0,0,512,96);t.fillStyle='#30372f';t.font='500 42px Arial';t.textAlign='center';t.fillText(text,256,62);let sp=new T.Sprite(new T.SpriteMaterial({map:new T.CanvasTexture(c),depthTest:true,toneMapped:false}));sp.scale.set(5.5,1.05,1);sp.position.set(x,y,z);parent.add(sp);return sp;}
 for(let i=0;i<8;i++){let g=new T.Group(),id=`AMR-0${i+1}`;group.add(g);let body=box(g,0,.7,0,2.6,1.1,3.4,yellow);box(g,0,1.35,0,2.3,.22,2.8,black);for(let x of [-1.2,1.2])for(let z of [-1,1])box(g,x,.35,z,.35,.65,.8,black);box(g,0,1.58,1.35,.6,.25,.35,green);box(g,0,3,-1.1,.25,5.2,.3,silver);let cargo=box(g,0,2.1,0,1.7,1.3,1.9,boxMat);box(cargo,0,.51,0,.12,.02,1.01,silver);label(g,id,0,4,0);let hit=box(g,0,1.7,0,3.1,3.5,3.8,new T.MeshBasicMaterial({visible:false}));hit.userData={type:'robot',id};hits.push(hit);robots.push({id,g,cargo,active:i<4,phase:i*7,status:'Idle',battery:92-i*5,paused:false,chargeNext:false,charging:false,cycles:0,product:'Circuit breakers',boxId:`DEMO-BOX-${i+1}`,mission:`MOVE-${1001+i}`});}
 for(let i=0;i<4;i++){const g=new T.Group(),kind=i<2?'inbound':'outbound',id=`${i<2?'Receiving':'Dispatch'} ${i%2+1}`;group.add(g);
 const tint=new T.MeshStandardMaterial({color:i<2?'#d6e5ce':'#e9dfb3',roughness:1});
 const pad=box(g,0,.12,0,12,.24,9,tint);box(g,0,.18,7,12,.12,5,silver);
 const title=label(g,id,0,3.8,5);title.scale.set(9,1.5,1);
 stations.push({g,pad,title,ready:true,id,kind,queue:[]});}

 const pickupMarker=new T.Mesh(new T.BoxGeometry(1,1,1),new T.MeshBasicMaterial({color:'#ffd900',wireframe:true,depthTest:false}));
 const dropMarker=new T.Mesh(new T.BoxGeometry(1,1,1),new T.MeshBasicMaterial({color:'#6c9ee8',wireframe:true,depthTest:false}));pickupMarker.renderOrder=15;dropMarker.renderOrder=15;group.add(pickupMarker,dropMarker);
 const line=new T.Line(new T.BufferGeometry(),new T.LineBasicMaterial({color:'#baa51a',transparent:true,opacity:.6}));group.add(line);
 function configure(){let s=getState(),key=JSON.stringify(s.racks.map(r=>[r.id,r.x,r.z,r.width,r.depth,r.rotation]));if(key===bounds)return;bounds=key;router=createRouter(routingRacks());let edge=s.racks.length?Math.max(...s.racks.map(r=>r.z+r.depth/2)):30;let xs=s.racks.map(r=>r.x),center=xs.length?(Math.min(...xs)+Math.max(...xs))/2:0;layout={x:center-27,z:edge+10};reserved.clear();robots.forEach((r,i)=>{r.task=null;r.path=[];r.cargo.visible=false;let p=router.point({x:layout.x+(i%4)*18,z:layout.z-(i>=4?6:0)});if(p)r.g.position.set(p.x,0,p.z);if(i<4){stations[i].g.position.set(layout.x+i*18,0,layout.z+6);stations[i].port={x:layout.x+i*18,z:layout.z};}});for(let i=0;i<4;i++)addArrival();log('Receiving and dispatch connected to current rack layout');}

 function log(text){events.unshift(text);events.splice(30);}
 function assign(r){
  const s=getState(),boxes=allBoxes();if(!s.racks.length)return;
  occupiedAt=new Map();for(const p of [...poses.values(),...destinationClaims.values()]){const k=p.box.rack+'|'+p.box.location;if(!occupiedAt.has(k))occupiedAt.set(k,[]);occupiedAt.get(k).push(p);}
  const productsAt=new Map();for(const b of boxes){const k=(virtualLocations.get(b.id)||b.rack)+'|'+(virtualSlots.get(b.id)||b.location);if(!productsAt.has(k))productsAt.set(k,new Set());productsAt.get(k).add(b.product);}
  for(const p of destinationClaims.values()){const k=p.box.rack+'|'+p.box.location;if(!productsAt.has(k))productsAt.set(k,new Set());productsAt.get(k).add(p.box.product);}
  function place(b,start=0,only=null){for(let i=0;i<s.racks.length;i++){const target=s.racks[(start+i)%s.racks.length];if(only&&target.id!==only)continue;const slot=locations(target).find(loc=>![...(productsAt.get(target.id+'|'+loc)||[])].some(p=>p!==b.product)&&destinationPose(target,loc,b));if(slot)return {target,slot,drop:destinationPose(target,slot,b)};}return null;}
  function start(b,source,sourceStation,target,slot,pickup,drop,outStation=null,outSlot=null,order=null,transfer=null){
   const from=source?router.port(source):sourceStation.port,to=target?router.port(target):outStation.port;
   const eligible=robots.filter(x=>x.active&&!x.task&&!x.paused&&!x.charging&&!x.unavailable).map(x=>({r:x,path:router.route(x.g.position,from)})).filter(x=>x.path).sort((a,b)=>a.path.length-b.path.length||a.r.id.localeCompare(b.r.id));
   if(eligible[0]?.r!==r)return false;
   const path=eligible[0].path,carry=router.route(from,to);if(!path||!carry)return false;
   drop.box={...b,rack:target?.id||'dispatch',location:slot};
   if(order)book.reserve(order,b.id);if(transfer)transfer.status='In progress';
   reserved.add(b.id);destinationClaims.set(b.id,drop);
   let output=null;if(outStation){const mesh=box(outStation.g,drop.x-outStation.g.position.x,drop.y,drop.z-outStation.g.position.z,drop.w,drop.h,drop.d,boxMat);mesh.visible=false;output={box:b,slot:outSlot,pose:drop,mesh,age:0,arrived:false};outStation.queue.push(output);}
   r.task={order,transfer,source,sourceStation,target,outStation,output,slot,box:b,carry,destination:to,pickup,drop,kind:sourceStation?'Inbound':target?'Transfer':'Outbound'};
   r.product=b.product;r.boxId=b.id;r.mission=`${sourceStation?'IN':target?'MOVE':'OUT'}-${++serial}`;
   r.from=source?source.id+' / '+(virtualSlots.get(b.id)||b.location):sourceStation.id;r.to=target?target.id+' / '+slot:outStation.id;
   r.routeBlocked=false;r.path=path;r.index=0;r.stage='To pickup';r.status=r.stage;r.timer=0;r.cargo.visible=false;log(`${r.mission} · ${b.id} · ${r.from} → ${r.to}`);return true;
  }
  // Alternate receiving and outgoing work; full shelves naturally give priority to shipping.
  if(!book.orders.some(o=>o.priority==='Urgent'&&o.allocated.length<o.quantity)&&(serial%4<policy.inboundShare||poses.size===0)){for(const st of stations.filter(s=>s.kind==='inbound'&&s.ready))for(const q of st.queue){if(q.age<1||reserved.has(q.box.id))continue;const dest=place(q.box,(arrivalSerial*17)%s.racks.length);if(dest&&start(q.box,null,st,dest.target,dest.slot,q.pose,dest.drop))return;}}
  for(const transfer of transfers.filter(t=>t.status==='Queued')){const b=boxes.find(b=>b.id===transfer.id),pickup=poses.get(transfer.id);if(!b||!pickup)continue;const source=s.racks.find(x=>x.id===pickup.box.rack),dest=place(b,0,transfer.rackId);if(dest&&start(b,source,null,dest.target,dest.slot,pickup,dest.drop,null,null,null,transfer))return;}
  const available=boxes.filter(b=>poses.has(b.id)&&!reserved.has(b.id)&&!transfers.some(t=>t.id===b.id&&t.status!=='Done')&&book.next(b)).sort((a,b)=>{
   const priority=(book.next(b).priority==='Urgent')-(book.next(a).priority==='Urgent');if(priority)return priority;
   const pa=poses.get(a.id),pb=poses.get(b.id);return Math.hypot(pa.x-r.g.position.x,pa.z-r.g.position.z)-Math.hypot(pb.x-r.g.position.x,pb.z-r.g.position.z);
  });
  for(let trial=0;trial<Math.min(40,available.length);trial++){
   const b=available[trial],pickup={...poses.get(b.id)},source=s.racks.find(x=>x.id===pickup.box.rack);if(!source)continue;
   const st=stations.filter(s=>s.kind==='outbound'&&s.ready&&s.queue.length<stationCapacity).sort((a,b)=>a.queue.length-b.queue.length)[0];if(!st)break;
   const slot=Array.from({length:stationCapacity},(_,i)=>i).find(i=>!st.queue.some(q=>q.slot===i));
   const drop=queuePose(st,slot,b);drop.w=pickup.w;drop.h=pickup.h;drop.d=pickup.d;drop.y=.24+pickup.h/2;
   if(start(b,source,null,null,null,pickup,drop,st,slot,book.next(b)))return;
  }
  // If dispatch is full, still let available robots clear receiving.
  for(const st of stations.filter(s=>s.kind==='inbound'&&s.ready))for(const q of st.queue){if(q.age<1||reserved.has(q.box.id))continue;const dest=place(q.box,(arrivalSerial*17)%s.racks.length);if(dest&&start(q.box,null,st,dest.target,dest.slot,q.pose,dest.drop))return;}
  r.status=book.pending&&stations.filter(s=>s.kind==='outbound').every(s=>!s.ready||s.queue.length>=stationCapacity)?'Waiting for dispatch capacity':book.pending?'Waiting for stock or route':'Waiting for work';
 }

 function move(r,dt){if(r.routeBlocked){r.status='Route blocked';return false;}let p=r.path[r.index];if(!p)return true;let dx=p.x-r.g.position.x,dz=p.z-r.g.position.z,d=Math.hypot(dx,dz);if(d<.08){r.index++;return r.index>=r.path.length;}let step=Math.min(d,dt*9),nx=r.g.position.x+dx/d*step,nz=r.g.position.z+dz/d*step;
 if(robots.some(o=>o.active&&o!==r&&Math.hypot(o.g.position.x-nx,o.g.position.z-nz)<3.7)){r.status='Waiting for traffic';r.wait=(r.wait||0)+dt;if(r.wait>2+robots.indexOf(r)){r.wait=0;let obstacles=robots.filter(o=>o.active&&o!==r).map(o=>({x:o.g.position.x,z:o.g.position.z,width:3,depth:3}));let detour=createRouter([...routingRacks(),...obstacles]).route(r.g.position,r.path.at(-1));if(detour){r.path=detour;r.index=0;}}return false;}
 r.g.rotation.y=Math.atan2(dx,dz);r.g.position.set(nx,0,nz);return false;}
 function update(dt){syncElapsed+=dt;if(syncElapsed>=.5){syncPoses();syncElapsed=0;}configure();group.visible=!suspended;if(suspended)return;if(!paused){balanceClock+=dt;if(balanceClock>=2){balance();balanceClock=0;}}updateDocks(dt);for(let r of robots){if(r.unavailable){r.status='Unavailable';continue;}if(!r.active){r.status='Standby';continue;}if(paused||r.paused){r.status=r.paused?'Paused':r.status;continue;}if(r.charging){r.status='Charging';r.battery=Math.min(100,r.battery+dt*3);if(r.battery===100)r.charging=false;continue;}if(!r.task){r.retry=(r.retry||0)-dt;if(r.retry<=0){assign(r);r.retry=1;}continue;}if((r.task.outStation&&!r.task.outStation.ready)||(r.task.sourceStation&&!r.task.sourceStation.ready&&['To pickup','Loading'].includes(r.stage))){r.status='Waiting for station';continue;}r.status=r.stage;r.battery=Math.max(15,r.battery-dt*.005);
 if(r.stage==='To pickup'||r.stage==='Transporting'){if(move(r,dt)){r.stage=r.stage==='To pickup'?'Loading':'Unloading';r.timer=0;}}
 else {
 if(r.stage==='Loading'&&r.timer===0){record('Picked up',r.task.box,`${r.from} → ${r.to} · ${r.id}`);inTransit.add(r.boxId);poses.delete(r.boxId);if(r.task.sourceStation){const st=r.task.sourceStation,q=st.queue.find(q=>q.box.id===r.boxId);if(q){st.g.remove(q.mesh);st.queue.splice(st.queue.indexOf(q),1);}}visualDirty=true;r.cargo.visible=true;}
 r.timer+=dt;transferPose(r,Math.min(1,r.timer/3));
 if(r.timer>=3){if(r.stage==='Loading'){
  r.stage='Transporting';r.path=r.task.carry||[];r.routeBlocked=!r.task.carry;r.index=0;
  r.cargo.position.set(0,1.5+r.task.pickup.h/2,0);r.cargo.quaternion.identity();
 }else{
  record(r.task.output?'Ready for dispatch':r.task.sourceStation?'Stored':'Moved',r.task.box,`${r.to} · ${r.id}`);
  if(r.task.output){book.stage(r.boxId);r.task.output.arrived=true;r.task.output.mesh.visible=true;r.task.output.age=0;}
  else {poses.set(r.boxId,r.task.drop);if(r.task.sourceStation){received++;storedTimes.set(r.boxId,elapsed);}}
  inTransit.delete(r.boxId);visualDirty=true;virtualLocations.set(r.boxId,r.task.target?.id||'dispatch');if(r.task.slot)virtualSlots.set(r.boxId,r.task.slot);
  if(r.task.transfer)r.task.transfer.status='Done';
  destinationClaims.delete(r.boxId);reserved.delete(r.boxId);log(`${r.boxId} delivered · ${r.to}`);r.cycles++;delivered++;r.task=null;r.cargo.visible=false;
  if(r.chargeNext){r.charging=true;r.chargeNext=false;}
 }}
 }
 }
 let r=robots.find(r=>r.id===selected);for(const [marker,p] of [[pickupMarker,r?.task?.pickup],[dropMarker,r?.task?.drop]]){marker.visible=!!p;if(p){marker.position.set(p.x,p.y,p.z);marker.scale.set(p.w+0.15,p.h+0.15,p.d+0.15);}}pickupMarker.visible=!!r?.task&&r.stage==='To pickup';line.visible=!!r?.task;if(r?.task){line.geometry.dispose();line.geometry=new T.BufferGeometry().setFromPoints([r.g.position.clone().setY(.3),...r.path.slice(r.index).map(p=>new T.Vector3(p.x,.3,p.z))]);}}
 function select(id){selected=id;onSelect?.(id);}
 return {locationInfo(rid,loc){const r=getState().racks.find(r=>r.id===rid),pending=robots.filter(x=>x.task?.target?.id===rid&&x.task.slot===loc);return {incoming:pending.length,robots:pending.map(x=>x.id),reachable:!!(r&&router&&stations[0]&&router.route(stations[0].port,router.port(r)))};},resolveIssue(id){const st=stations.find(s=>s.id===id);if(st){st.ready=true;return;}const r=robots.find(r=>r.id===id);if(r){r.unavailable=false;r.paused=false;reroute();}},get hits(){return hits.filter(h=>robots.find(r=>r.id===h.userData.id)?.active);},robots,stations,events,update,select,get revision(){return revision;},dashboard(s){
 const view=this.visualState(s),receiving=stations.filter(x=>x.kind==='inbound').reduce((n,x)=>n+x.queue.length,0),dispatch=stations.filter(x=>x.kind==='outbound').reduce((n,x)=>n+x.queue.filter(q=>q.arrived).length,0);
 return {...view,onSite:s.boxes.length+arrived-shipped,counts:{stored:view.boxes.length,receiving,transit:inTransit.size,dispatch},today:{...s.today,received:s.today.received+arrived,shipped:s.today.shipped+shipped},history:[...activity,...s.history]};
 },book,scenario,boxInfo,requestMove,boxPose(id){const p=poses.get(id);if(p)return p;const r=robots.find(r=>r.task?.box.id===id&&inTransit.has(id));if(r){const v=r.cargo.getWorldPosition(new T.Vector3());return {...r.task.pickup,x:v.x,y:v.y,z:v.z};}return stations.flatMap(s=>s.queue).find(q=>q.box.id===id&&q.arrived)?.pose;},orderStatus(o){if(o.shipped.length===o.quantity)return 'Completed';if(o.allocated.length===o.quantity)return 'In progress';if(![...poses.values()].some(p=>p.box.product===o.product&&!reserved.has(p.box.id)&&(!o.boxId||p.box.id===o.boxId)))return 'Waiting for matching stock';if(stations.filter(s=>s.kind==='outbound').every(s=>!s.ready||s.queue.length>=stationCapacity))return 'Waiting for dispatch space';if(obstruction)return 'Aisle closed · route planning';return 'Waiting for an available robot';},get racks(){return getState().racks;},displayLayout(){if(!inventoryKey)syncPoses();return [...poses.values()];},visualState(s){return {...s,boxes:[...s.boxes,...incoming.values()].filter(b=>virtualLocations.get(b.id)!=='receiving'&&!inTransit.has(b.id)&&virtualLocations.get(b.id)!=='dispatch').map(b=>{let id=virtualLocations.get(b.id);return id?{...b,rack:id,location:virtualSlots.get(b.id)||b.location}:b;})};},consumeVisualChange(){let v=visualDirty;visualDirty=false;return v;},get flow(){return {waiting:stations.filter(s=>s.kind==='inbound').reduce((n,s)=>n+s.queue.length,0),outgoing:stations.filter(s=>s.kind==='outbound').reduce((n,s)=>n+s.queue.filter(q=>q.arrived).length,0),received,shipped,autoInbound,policy,bulkRemaining,blockedAisle:!!obstruction,unavailable:robots.filter(r=>r.unavailable).length,bottleneck:robots.some(r=>r.routeBlocked)?'Route blocked':robots.filter(r=>r.status==='Waiting for traffic').length>=2?'Traffic congestion':stations.filter(s=>s.kind==='outbound').every(s=>!s.ready||s.queue.length>=stationCapacity)?'Dispatch capacity':'None',activeRobots:robots.filter(r=>r.active).length};},addArrival(){configure();return addArrival();},toggleInbound(){autoInbound=!autoInbound;},get delivered(){return delivered;},get paused(){return paused;},toggle(){paused=!paused;},setBuilding(v){suspended=v;},focus(id){configure();let r=robots.find(r=>r.id===id);return r?r.g.position.clone():new T.Vector3(layout.x+24,0,layout.z+13);},command(id,action){let r=robots.find(r=>r.id===id);if(!r)return;if(action==='pause')r.paused=!r.paused;if(action==='charge')r.chargeNext=true;log(`${id} · ${action==='charge'?'Charging queued after delivery':r.paused?'Paused':'Resumed'}`);},get selected(){return selected;}};
}
