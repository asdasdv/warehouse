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
// A large fulfilment-centre layout: two conveyor systems run west→east through the middle — a receiving
// loop (fed by the receiving building at the west end) and a dispatch line (into the dispatch building at
// the east end) — and 24 zones line both sides, racks facing the conveyors.
// Docks alternate kinds along the conveyors, offset between the two sides, so every stretch of the
// building has a receiving and a dispatch dock nearby on each side.
const dockPlan=xs=>[...xs.map((x,i)=>({x,kind:i%2?'outbound':'inbound',north:true})),...xs.map((x,i)=>({x,kind:i%2?'inbound':'outbound',north:false}))];
export const LAYOUTS={
 // A plain grid: the test layout.
 small:{zone:{w:56,d:30},cols:6,step:59,x0:-176,rows:[-103,-70,40,73],rackRows:2,perRow:7,
  spine:{x1:-186,x2:186,crossings:[-120,-60,0,60,120],docks:dockPlan([-150,-90,-30,30,90,150])}},
 // The demo: zones of different sizes and layouts in three bands on each side of the conveyors.
 large:{varied:true,x0:-345,x1:345,corridor:40,seed:20261030,
  spine:{x1:-366,x2:366,crossings:[-270,-210,-150,-90,-30,30,90,150,210,270],docks:dockPlan([-300,-240,-180,-120,-60,0,60,120,180,240,300])}}};
export const SPINE=LAYOUTS.small.spine;
const zoneId=i=>i<26?String.fromCharCode(65+i):String.fromCharCode(65+Math.floor(i/26)-1)+String.fromCharCode(65+i%26);
function fillRacks(zoneRacks,zi,boxes,flow,fill,next){for(const [j,r] of zoneRacks.entries()){const qty=Math.min(rackCapacity(r),Math.round(rackCapacity(r)*fill*(1+.16*Math.sin(j*1.7+zi*2.3)))),cells=locations(r);
 for(let k=0;k<qty;k++){const loc=cells[Math.floor(k/CELL_CAPACITY)],shelf=Number(loc.slice(1,loc.indexOf('-')));boxes.push({id:`BX-${String(10000+next())}`,product:products[(zi*5+j*3+shelf)%products.length],rack:r.id,location:loc});}
 flow[r.id]={in:Math.round(qty*(.06+.05*Math.abs(Math.sin(j+zi)))),out:Math.round(qty*(.03+.04*Math.abs(Math.cos(j*2+zi))))};}}
// Racks for one varied zone. Rows face the conveyors (with uneven lengths and the odd cross aisle);
// "column" zones turn the racks to face the side aisles instead. Every rack keeps an 11 m aisle on both faces.
function zoneRacks(zone,north,rnd){const t=rnd()<.3?templates.large:templates.standard,c=config(t),out=[],gap=1.5,aisle=11;
 if(rnd()<.3){// columns: racks turned 90°, fronts to the west and backs to the east
  const fw=c.depth,fd=c.width;for(let cx=zone.x+6+fw/2;cx+fw/2<=zone.x+zone.w-6;cx+=fw+aisle){const max=Math.floor((zone.d-12+gap)/(fd+gap)),n=Math.max(2,Math.round(max*(.55+.45*rnd())));
   const z0=zone.z+6+(max-n)*(fd+gap)*(north?1:0);for(let k=0;k<n;k++)out.push({...c,width:fw,depth:fd,rotation:1,x:cx,z:z0+fd/2+k*(fd+gap)});}
  return out;}
 const rot=north?0:2;for(let oz=6;oz+c.depth+5<=zone.d;oz+=c.depth+aisle){const max=Math.floor((zone.w-12+gap)/(c.width+gap)),n=Math.max(3,Math.round(max*(.5+.5*rnd())));
  // A long row sometimes gets a cross aisle; short rows start at a random point along the zone.
  const split=n>9&&rnd()<.5?Math.floor(n*(.35+.3*rnd())):-1,span=n*(c.width+gap)+(split>0?8:0),x0=zone.x+6+rnd()*Math.max(0,zone.w-12-span);
  for(let k=0;k<n;k++){const x=x0+c.width/2+k*(c.width+gap)+(split>0&&k>=split?8:0);out.push({...c,rotation:rot,x,z:zone.z+oz+c.depth/2});}}
 return out;}
export function seed(size='small'){const L=LAYOUTS[size],zones=[],racks=[],boxes=[],flow={};let n=0;const next=()=>++n;
 if(!L.varied){L.rows.forEach((rowZ,ri)=>{const north=rowZ<0;for(let c=0;c<L.cols;c++){const i=ri*L.cols+c,id=zoneId(i),x=c*L.step+L.x0,z=rowZ,full=L.rackRows*L.perRow,nr=full-(i*5)%3*L.rackRows/2;
  zones.push({id,name:`Zone ${id}`,x,z,w:L.zone.w,d:L.zone.d,color:colors[i%colors.length]});
  // North racks face south (+z), south racks face north, so every rack front looks towards the conveyors.
  const zr=[];for(let j=0;j<nr;j++){const r={id:`${id}-${String(j+1).padStart(2,'0')}`,zone:id,x:x+5+(j%L.perRow)*7.5,z:z+(north?7:8)+Math.floor(j/L.perRow)*15,...config(templates.standard),rotation:north?0:2};racks.push(r);zr.push(r);}
  fillRacks(zr,i,boxes,flow,.5+.06*((i*7)%5),next);}});}
 else{// Deterministic random: the same warehouse on every reload.
  let st=L.seed;const rnd=()=>{st=st+0x6D2B79F5|0;let t=Math.imul(st^st>>>15,1|st);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};
  let zi=0;for(const north of [true,false]){let from=L.corridor;for(let band=0;band<3;band++){let deepest=0;
   for(let x=L.x0;x<L.x1-60;){let w=Math.round(70+rnd()*80);if(L.x1-(x+w+10)<70)w=L.x1-x;const d=Math.round(48+rnd()*36),id=zoneId(zi);
    const zone={id,name:`Zone ${id}`,x,z:north?-(from+d):from,w,d,color:colors[zi%colors.length]};zones.push(zone);
    const zr=zoneRacks(zone,north,rnd).map((r,j)=>({id:`${id}-${String(j+1).padStart(2,'0')}`,zone:id,...r}));racks.push(...zr);
    fillRacks(zr,zi,boxes,flow,.45+.35*rnd(),next);deepest=Math.max(deepest,d);x+=w+10;zi++;}
   from+=deepest+10;}}}
 const k=size==='large'?4:1,demo={version:2,zones,racks,boxes,serial:10000+n,flow,spine:structuredClone(L.spine),today:{received:1104*k,putAway:1068*k,moved:120*k,shipped:756*k},yesterday:{received:984*k,putAway:990*k,moved:108*k,shipped:780*k},history:[]};
 backstory(demo);return demo;}
// Give the demo a past: every box has a receipt date and document, and today already has a few hours of activity.
// A fixed random seed keeps the story the same on every reload.
function backstory(s,now=Date.now()){let r=1234567;const rnd=()=>{r=r+0x6D2B79F5|0;let t=Math.imul(r^r>>>15,1|r);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;},pick=a=>a[Math.floor(rnd()*a.length)];
 const day=new Date(now);day.setHours(7,0,0,0);let start=day.getTime();if(now-start<3600e3)start=now-8*3600e3;
 for(const b of s.boxes){const ago=1+Math.floor(rnd()*13),t=new Date(now-ago*86400e3);t.setHours(7+Math.floor(rnd()*10),Math.floor(rnd()*60),0,0);b.receivedAt=t.toISOString();b.doc=`inv. ${1000+ago*17+Math.floor(rnd()*17)}`;}
 const events=[],at=t=>new Date(Math.min(t,now-60e3)).toISOString(),add=(type,box,from,to,t)=>events.push({type,box:box.id,product:box.product,from,to,detail:`${box.id} · ${box.product} · ${from} → ${to}`,time:at(t)});
 let shipped=new Set();for(let i=0;i<110;i++){const t=start+rnd()*(now-start),roll=rnd(),box=pick(s.boxes);if(shipped.has(box.id))continue;
  if(roll<.5){const st=`Receiving ${1+Math.floor(rnd()*6)}`;box.receivedAt=at(t);box.doc=`inv. ${2000+Math.floor(rnd()*60)}`;add('Received',box,'Supplier',st,t);add('Put away',box,st,`${box.rack} / ${box.location}`,t+(4+rnd()*14)*60e3);}
  else if(roll<.85){shipped.add(box.id);add('Shipped',box,`Dispatch ${1+Math.floor(rnd()*6)}`,'Customer',t);}
  else if(roll<.96){const from=`S${1+Math.floor(rnd()*7)}-P${1+Math.floor(rnd()*4)}`;if(from!==box.location)add('Moved',box,`${box.rack} / ${from}`,`${box.rack} / ${box.location}`,t);}
  else events.push({type:'System',detail:pick(['AMR-06 joined the fleet','AMR-07 returned to standby','Receiving 2 back online','AMR-03 finished charging']),time:at(t)});}
 // Shipped boxes have left the shelves.
 s.boxes=s.boxes.filter(b=>!shipped.has(b.id));s.history=events.sort((a,b)=>b.time.localeCompare(a.time)).slice(0,300);}
export function receive(s,rack,product,qty,location){if(!Number.isInteger(qty)||qty<1||qty>10000||typeof product!=='string'||!product.trim())throw Error('Enter a component and 1–10,000 whole boxes.');destination(s,rack,location,product,[],qty);for(let i=0;i<qty;i++)s.boxes.push({id:`BX-${++s.serial}`,product,rack,location});s.today.received+=qty;log(s,'Received',`${product} · ${rack} / ${location} · ${qty} boxes`);}
export function transact(s,ids,type,target,targetLocation){let wanted=new Set(ids),selected=s.boxes.filter(b=>wanted.has(b.id));if(!selected.length||selected.length!==wanted.size)throw Error('Select existing boxes.');let source=[...new Set(selected.map(b=>`${b.rack} / ${b.location}`))].join(', ');if(type==='Moved'){if(new Set(selected.map(b=>b.product)).size!==1)throw Error('Move one component type at a time.');destination(s,target,targetLocation,selected[0].product,ids,selected.length);if(selected.every(b=>b.rack===target&&b.location===targetLocation))throw Error('Choose a different location.');selected.forEach(b=>{b.rack=target;b.location=targetLocation;});}else if(type==='Shipped'){s.boxes=s.boxes.filter(b=>!wanted.has(b.id));s.today.shipped+=selected.length;}else throw Error('Unknown operation');log(s,type,`${selected.length} ${selected.length===1?'box':'boxes'} · ${source}${target?' → '+target+' / '+targetLocation:''}`);}
export function log(s,type,detail){s.history.unshift({type,detail,time:new Date().toISOString()});s.history=s.history.slice(0,300);}
export function addZone(s,z){if(z.points)z=polygonZone(z.points);if(!z.points&&(z.w<12||z.d<12))throw Error('Draw a zone at least 12 × 12 m.');if(s.zones.some(a=>zonesOverlap(z,a)))throw Error('Zones cannot overlap. Draw in an empty area.');let i=1;while(s.zones.some(a=>a.id===`N${i}`))i++;s.zones.push({...z,id:`N${i}`,name:`Zone N${i}`,color:colors[s.zones.length%colors.length]});log(s,'Zone created',`Zone N${i}`);return `N${i}`;}
export function addRack(s,zone,x,z,settings={}){let c=config(settings);placement(s,zone,x,z,c);let i=1;while(s.racks.some(r=>r.id===`${zone}-${String(i).padStart(2,'0')}`))i++;let id=`${zone}-${String(i).padStart(2,'0')}`;s.racks.push({id,zone,x,z,...c});log(s,'Rack added',id);return id;}
export function updateRack(s,id,settings){let r=s.racks.find(r=>r.id===id);if(!r)throw Error('Rack not found.');let c=config(settings);placement(s,r.zone,r.x,r.z,c,id);let valid=new Set(locations(c));if(s.boxes.some(b=>b.rack===id&&!valid.has(b.location)))throw Error('Some locations you are removing still contain boxes. Move those boxes first.');Object.assign(r,c);delete r.capacity;log(s,'Rack updated',`${id} · ${c.shelves} shelves · ${c.places} locations per shelf`);}
