import {polygonZone,zonesOverlap} from './zone-shape.js';
import {config,locations,destination,placement,migrate,templates,CELL_CAPACITY,rackCapacity} from './storage.js';
// Demo catalog: SKU, product name and pieces per box.
export const catalog=[
 {sku:'ABB-S201-C10',name:'ABB S201 C10 circuit breaker',pcs:12},{sku:'ABB-S201-C16',name:'ABB S201 C16 circuit breaker',pcs:12},
 {sku:'SE-A9F74332',name:'Schneider iC60N C32 circuit breaker',pcs:6},{sku:'IEK-BA4729-C25',name:'IEK BA47-29 C25 circuit breaker',pcs:12},
 {sku:'SE-LC1D09',name:'Schneider TeSys LC1D09 contactor',pcs:10},{sku:'ABB-AF16-30',name:'ABB AF16-30-10 contactor',pcs:10},
 {sku:'FIN-4052-24',name:'Finder 40.52 relay, 24 V DC',pcs:20},{sku:'PHX-PLC-RSC',name:'Phoenix Contact PLC-RSC relay module',pcs:10},
 {sku:'WAG-221-413',name:'WAGO 221-413 terminal blocks',pcs:100},{sku:'WAG-2002-1201',name:'WAGO 2002-1201 terminal blocks',pcs:50},
 {sku:'MW-HDR60-24',name:'Mean Well HDR-60-24 power supply',pcs:4},{sku:'MW-NDR120-24',name:'Mean Well NDR-120-24 power supply',pcs:4},
 {sku:'SIE-6ES7214',name:'Siemens S7-1200 CPU 1214C',pcs:1},{sku:'SIE-6ES7221',name:'Siemens SM 1221 digital input module',pcs:2},
 {sku:'SE-XB4BA31',name:'Schneider XB4 green push button',pcs:20},{sku:'LAP-SKV-M20',name:'Lapp Skintop M20 cable gland',pcs:50}];
export const products=catalog.map(p=>p.name);
export const itemOf=name=>catalog.find(p=>p.name===name);
// A product created while receiving joins the catalog for the rest of the session.
export function addProduct(name,sku,pcs=1){name=name.trim();sku=sku.trim().toUpperCase();if(!name||!sku)throw Error('Enter a product name and SKU.');if(catalog.some(p=>p.name.toLowerCase()===name.toLowerCase()||p.sku===sku))throw Error('This product or SKU already exists.');catalog.push({sku,name,pcs});products.push(name);return name;}
// Zone colours from the Figma palette (zone/a … zone/h).
export const colors=['#82c0fa','#8cd88a','#f0c977','#f29b6c','#b587f9','#f17fb7','#86cade','#9294f0'];
// Demo warehouse from the Figma screens: 8 zones, 57 racks of 7 shelves × 4 cells, 2 boxes per cell.
export function seed(){const counts=[251,255,290,246,232,306,247,208],rackCounts=[8,7,7,8,6,7,7,7],zones=[],racks=[],boxes=[],flow={};let n=0;
 counts.forEach((count,i)=>{const id=String.fromCharCode(65+i),x=(i%4)*59-118,z=Math.floor(i/4)*33-33,nr=rackCounts[i];zones.push({id,name:`Zone ${id}`,x,z,w:56,d:30,color:colors[i]});
  const weights=Array.from({length:nr},(_,j)=>1+.16*Math.sin(j*1.7+i*2.3)),sum=weights.reduce((a,b)=>a+b,0);let left=count;
  for(let j=0;j<nr;j++){const rid=`${id}-${String(j+1).padStart(2,'0')}`,r={id:rid,zone:id,x:x+5+(j%7)*7.5,z:z+7+Math.floor(j/7)*15,...config(templates.standard)};racks.push(r);
   const qty=Math.min(rackCapacity(r),j===nr-1?left:Math.round(count*weights[j]/sum));left-=qty;const cells=locations(r);
   for(let k=0;k<qty;k++){const loc=cells[Math.floor(k/CELL_CAPACITY)],shelf=Number(loc.slice(1,loc.indexOf('-')));boxes.push({id:`BX-${String(10000+ ++n)}`,product:products[(i*5+j*3+shelf)%products.length],rack:rid,location:loc});}
   flow[rid]={in:Math.round(qty*(.06+.05*Math.abs(Math.sin(j+i)))),out:Math.round(qty*(.03+.04*Math.abs(Math.cos(j*2+i))))};}});
 const demo={version:2,zones,racks,boxes,serial:10000+n,flow,today:{received:184,putAway:178,moved:20,shipped:126},yesterday:{received:164,putAway:165,moved:18,shipped:130},history:[]};backstory(demo);return demo;}
// Give the demo a past: every box has a receipt date and document, and today already has a few hours of activity.
// A fixed random seed keeps the story the same on every reload.
function backstory(s,now=Date.now()){let r=1234567;const rnd=()=>{r=r+0x6D2B79F5|0;let t=Math.imul(r^r>>>15,1|r);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;},pick=a=>a[Math.floor(rnd()*a.length)];
 const day=new Date(now);day.setHours(7,0,0,0);let start=day.getTime();if(now-start<3600e3)start=now-8*3600e3;
 for(const b of s.boxes){const ago=1+Math.floor(rnd()*13),t=new Date(now-ago*86400e3);t.setHours(7+Math.floor(rnd()*10),Math.floor(rnd()*60),0,0);b.receivedAt=t.toISOString();b.doc=`inv. ${1000+ago*17+Math.floor(rnd()*17)}`;}
 const events=[],at=t=>new Date(Math.min(t,now-60e3)).toISOString(),add=(type,box,from,to,t)=>events.push({type,box:box.id,product:box.product,from,to,detail:`${box.id} · ${box.product} · ${from} → ${to}`,time:at(t)});
 let shipped=new Set();for(let i=0;i<110;i++){const t=start+rnd()*(now-start),roll=rnd(),box=pick(s.boxes);if(shipped.has(box.id))continue;
  if(roll<.5){const st=`Receiving ${1+Math.floor(rnd()*2)}`;box.receivedAt=at(t);box.doc=`inv. ${2000+Math.floor(rnd()*60)}`;add('Received',box,'Supplier',st,t);add('Put away',box,st,`${box.rack} / ${box.location}`,t+(4+rnd()*14)*60e3);}
  else if(roll<.85){shipped.add(box.id);add('Shipped',box,`Dispatch ${1+Math.floor(rnd()*2)}`,'Customer',t);}
  else if(roll<.96){const from=`S${1+Math.floor(rnd()*7)}-P${1+Math.floor(rnd()*4)}`;if(from!==box.location)add('Moved',box,`${box.rack} / ${from}`,`${box.rack} / ${box.location}`,t);}
  else events.push({type:'System',detail:pick(['AMR-06 joined the fleet','AMR-07 returned to standby','Receiving 2 back online','AMR-03 finished charging']),time:at(t)});}
 // Shipped boxes have left the shelves.
 s.boxes=s.boxes.filter(b=>!shipped.has(b.id));s.history=events.sort((a,b)=>b.time.localeCompare(a.time)).slice(0,300);}
export function receive(s,rack,product,qty,location){if(!Number.isInteger(qty)||qty<1||qty>10000||typeof product!=='string'||!product.trim())throw Error('Enter a component and 1–10,000 whole boxes.');destination(s,rack,location,product,[],qty);for(let i=0;i<qty;i++)s.boxes.push({id:`BX-${String(++s.serial).padStart(6,'0')}`,product,rack,location});s.today.received+=qty;log(s,'Received',`${product} · ${rack} / ${location} · ${qty} boxes`);}
export function transact(s,ids,type,target,targetLocation){let wanted=new Set(ids),selected=s.boxes.filter(b=>wanted.has(b.id));if(!selected.length||selected.length!==wanted.size)throw Error('Select existing boxes.');let source=[...new Set(selected.map(b=>`${b.rack} / ${b.location}`))].join(', ');if(type==='Moved'){if(new Set(selected.map(b=>b.product)).size!==1)throw Error('Move one component type at a time.');destination(s,target,targetLocation,selected[0].product,ids,selected.length);if(selected.every(b=>b.rack===target&&b.location===targetLocation))throw Error('Choose a different location.');selected.forEach(b=>{b.rack=target;b.location=targetLocation;});}else if(type==='Shipped'){s.boxes=s.boxes.filter(b=>!wanted.has(b.id));s.today.shipped+=selected.length;}else throw Error('Unknown operation');log(s,type,`${selected.length} ${selected.length===1?'box':'boxes'} · ${source}${target?' → '+target+' / '+targetLocation:''}`);}
export function log(s,type,detail){s.history.unshift({type,detail,time:new Date().toISOString()});s.history=s.history.slice(0,300);}
export function addZone(s,z){if(z.points)z=polygonZone(z.points);if(!z.points&&(z.w<12||z.d<12))throw Error('Draw a zone at least 12 × 12 m.');if(s.zones.some(a=>zonesOverlap(z,a)))throw Error('Zones cannot overlap. Draw in an empty area.');let i=1;while(s.zones.some(a=>a.id===`N${i}`))i++;s.zones.push({...z,id:`N${i}`,name:`Zone N${i}`,color:colors[s.zones.length%colors.length]});log(s,'Zone created',`Zone N${i}`);return `N${i}`;}
export function addRack(s,zone,x,z,settings={}){let c=config(settings);placement(s,zone,x,z,c);let i=1;while(s.racks.some(r=>r.id===`${zone}-${String(i).padStart(2,'0')}`))i++;let id=`${zone}-${String(i).padStart(2,'0')}`;s.racks.push({id,zone,x,z,...c});log(s,'Rack added',id);return id;}
export function updateRack(s,id,settings){let r=s.racks.find(r=>r.id===id);if(!r)throw Error('Rack not found.');let c=config(settings);placement(s,r.zone,r.x,r.z,c,id);let valid=new Set(locations(c));if(s.boxes.some(b=>b.rack===id&&!valid.has(b.location)))throw Error('Some locations you are removing still contain boxes. Move those boxes first.');Object.assign(r,c);delete r.capacity;log(s,'Rack updated',`${id} · ${c.shelves} shelves · ${c.places} locations per shelf`);}
