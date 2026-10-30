import {sortHead, sortRows} from './table-sort.js';
import {CELL_CAPACITY,rackCapacity,locations} from './storage.js';
import {itemOf} from './model.js';
const fmt=n=>n.toLocaleString('en-US');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const chev='<img src="/assets/fg/chevron-right.svg" alt="">';
// Capacity is counted in boxes: every cell holds CELL_CAPACITY boxes.
export function stock(state,racks=state.racks){const ids=new Set(racks.map(r=>r.id)),stored=state.boxes.filter(b=>ids.has(b.rack)).length,total=racks.reduce((n,r)=>n+rackCapacity(r),0);return {stored,total,free:total-stored,pct:total?Math.round(stored/total*100):0};}
const pctDelta=(now,before)=>{if(!before)return '';const d=Math.round((now-before)/before*100);return d>0?`+${d}%`:d<0?`−${-d}%`:'0%';};
const absDelta=(now,before)=>before==null?'':now-before>0?`+${now-before}`:now-before<0?`−${before-now}`:'0';
export const zoneOf=(state,rid)=>state.zones.find(z=>z.id===state.racks.find(r=>r.id===rid)?.zone);
export function flowOf(state,racks){return racks.reduce((f,r)=>{const x=state.flow?.[r.id];if(x){f.in+=x.in;f.out+=x.out;}return f;},{in:0,out:0});}
// Progress bar: the fill width is the share; colour is the tone.
export const bar=(pct,color='var(--accent-primary)',cls='')=>`<div class="lc-bar ${cls}"><i style="width:${Math.min(100,pct)}%;background:${color}"></i></div>`;
function hero(s,label='boxes stored'){return `<div class="lc-hero"><b>${fmt(s.stored)}</b><span>${label}</span></div><div class="lc-fill">${bar(s.pct)}<p>of ${fmt(s.total)} · ${fmt(s.free)} free · ${s.pct}% full</p></div>`;}
function crumb(parts){return `<div class="lc-crumb">${parts.map((p,i)=>{const last=i===parts.length-1,inner=last?`<span>${esc(p.label)}</span>`:p.root?`<button data-root>${esc(p.label)}</button>`:`<button data-pick="${p.type}" data-id="${esc(p.id)}">${esc(p.label)}</button>`;return (i?chev:'')+inner;}).join('')}</div>`;}
const head=(left,right)=>`<div class="lc-list-head"><span>${left}</span><span>${right}</span></div>`;
function row(name,value,type,id,color,sub=''){return `<button class="lc-row" data-pick="${type}" data-id="${esc(id)}"><i style="background:${color}"></i><span>${esc(name)}${sub?`<small>${esc(sub)}</small>`:''}</span><em>${value}</em></button>`;}
function zoneBar(state,zones,free){return `<div class="lc-zonebar">${zones.map(z=>`<span style="flex:${z.s.stored||.001};background:${z.color}" title="${esc(z.name)} · ${fmt(z.s.stored)} stored"></span>`).join('')}<span class="free" style="flex:${free||.001}" title="Free · ${fmt(free)}"></span></div>`;}
export function zonesByFill(state){return state.zones.map(z=>({...z,s:stock(state,state.racks.filter(r=>r.zone===z.id))})).sort((a,b)=>b.s.stored/(b.s.total||1)-a.s.stored/(a.s.total||1));}
// sel: null (warehouse) | zone | rack | shelf ("A-01|S3") | location ("A-01|S3-P2")
export function overviewHTML(state,sel){
 if(sel&&!['zone','rack','shelf','location'].includes(sel.type))return null;
 if(!sel){
  const s=stock(state),zones=zonesByFill(state),t=state.today,y=state.yesterday||{};
  const stats=[['Received today',t.received,pctDelta(t.received,y.received),'Received'],['Put away today',t.putAway||0,pctDelta(t.putAway||0,y.putAway),'Put away'],['Moved today',t.moved||0,absDelta(t.moved||0,y.moved),'Moved'],['Shipped today',t.shipped,pctDelta(t.shipped,y.shipped),'Shipped']];
  return `${hero(s)}<div class="lc-stats">${stats.map(([label,n,d,type])=>`<div class="lc-stat"><span>${label}</span><div><b>${fmt(n)}</b><small>${d}</small></div></div>`).join('')}</div><div class="lc-group">${head('Fullest zones','Stored / capacity')}${zoneBar(state,zones,s.free)}<div class="lc-rows">${zones.slice(0,5).map(z=>row(z.name,`${fmt(z.s.stored)} / ${fmt(z.s.total)}`,'zone',z.id,z.color)).join('')}<button class="lc-outline" id="allZones">See all ${zones.length} zones</button></div></div>`;
 }
 const [rid,part]=sel.type==='zone'?[null,null]:sel.id.split('|'),rack=state.racks.find(r=>r.id===rid);
 const z=sel.type==='zone'?state.zones.find(z=>z.id===sel.id):zoneOf(state,rid),color=z?.color||'var(--accent-primary)';
 if(sel.type==='zone'){
  const racks=state.racks.filter(r=>r.zone===sel.id).map(r=>({r,s:stock(state,[r])})).sort((a,b)=>b.s.stored-a.s.stored);
  return `${crumb([{label:'Warehouse',root:true},{label:z?.name||sel.id}])}${hero(stock(state,racks.map(x=>x.r)))}<div class="lc-group">${head(`Racks · ${racks.length}`,'Stored / capacity')}<div class="lc-rows">${racks.slice(0,5).map(({r,s})=>row(r.id,`${s.stored} / ${s.total}`,'rack',r.id,color)).join('')}${racks.length>5?`<button class="lc-outline" id="allRacks">See all ${racks.length} racks</button>`:''}</div></div>`;
 }
 if(!rack)return null;
 const at=state.boxes.filter(b=>b.rack===rack.id),trail=[{label:'Warehouse',root:true},{label:z?.name||'',type:'zone',id:z?.id||''}];
 if(sel.type==='rack'){
  const shelves=Array.from({length:rack.shelves},(_,i)=>rack.shelves-i).map(n=>({n,stored:at.filter(b=>b.location.startsWith(`S${n}-`)).length}));
  return `${crumb([...trail,{label:rack.id}])}${hero(stock(state,[rack]))}<div class="lc-group">${head(`Shelves · ${rack.shelves}`,'Stored / capacity')}<div class="lc-rows">${shelves.map(s=>row(`S${s.n}`,`${s.stored} / ${rack.places*CELL_CAPACITY}`,'shelf',`${rack.id}|S${s.n}`,color)).join('')}</div></div>`;
 }
 if(sel.type==='shelf'){
  const cells=locations(rack).filter(l=>l.startsWith(part+'-')),stored=at.filter(b=>cells.includes(b.location)).length,total=cells.length*CELL_CAPACITY;
  return `${crumb([...trail,{label:rack.id,type:'rack',id:rack.id},{label:part}])}${hero({stored,total,free:total-stored,pct:Math.round(stored/total*100)})}<div class="lc-group">${head(`Cells · ${cells.length}`,'Stored / capacity')}<div class="lc-rows">${cells.map(l=>row(l.split('-')[1],`${at.filter(b=>b.location===l).length} / ${CELL_CAPACITY}`,'location',`${rack.id}|${l}`,color)).join('')}</div></div>`;
 }
 const [shelf,place]=part.split('-'),here=at.filter(b=>b.location===part);
 return `${crumb([...trail,{label:rack.id,type:'rack',id:rack.id},{label:shelf,type:'shelf',id:`${rack.id}|${shelf}`},{label:place}])}${hero({stored:here.length,total:CELL_CAPACITY,free:CELL_CAPACITY-here.length,pct:Math.round(here.length/CELL_CAPACITY*100)})}<div class="lc-group">${head(`Boxes · ${here.length}`,'Quantity')}<div class="lc-rows">${here.map(b=>row(b.product,`${itemOf(b.product)?.pcs||1} pcs`,'box',b.id,color,b.id)).join('')||'<p class="lc-empty">This cell is empty.</p>'}</div></div>`;
}
// "All zones" / "Zone A · all racks" tables.
// Rows are {name, count, s, f, …}; every column sorts (see table-sort.js).
const tableValue=(x,k)=>k==='name'?x.name:k==='count'?x.count:k==='stored'?x.s.stored:k==='fill'?x.s.stored/(x.s.total||1):k==='free'?x.s.free:x.f.in+x.f.out;
function table(items,first,firstLabel,sort){return `<table class="lc-table"><colgroup><col style="width:190px"><col style="width:80px"><col style="width:150px"><col style="width:200px"><col style="width:90px"><col style="width:122px"></colgroup><thead><tr>${sortHead(firstLabel,'name',sort,'','asc')}${sortHead(first,'count',sort)}${sortHead('Stored / capacity','stored',sort)}${sortHead('Fill','fill',sort)}${sortHead('Free','free',sort)}${sortHead('Today','today',sort)}</tr></thead><tbody>${sortRows(items,sort,tableValue).map(tableRow).join('')}</tbody></table>`;}
function tableRow(x){return `<tr data-pick="${x.type}" data-id="${esc(x.id)}"><td><span class="lc-name"><i style="background:${x.color}"></i>${esc(x.name)}</span></td><td class="muted">${x.count}</td><td>${fmt(x.s.stored)} / ${fmt(x.s.total)}</td><td><span class="lc-fillcell">${bar(x.s.pct,x.color,'sm')}${x.s.pct}%</span></td><td class="muted">${fmt(x.s.free)}</td><td class="muted">+${x.f.in} / −${x.f.out}</td></tr>`;}
export function allZonesHTML(state,sort={key:'fill',dir:'desc'}){
 const s=stock(state),zones=zonesByFill(state);
 return `<div class="lc-modal-head"><h2>All zones <small>${zones.length}</small></h2><button type="button" class="lc-close" data-close aria-label="Close"><img class="fg-ic" src="/assets/fg/close.svg" alt=""></button></div><div class="lc-summary"><p>${fmt(s.stored)} of ${fmt(s.total)} boxes used · ${fmt(s.free)} free</p>${zoneBar(state,zones,s.free)}</div>${table(zones.map(z=>{const racks=state.racks.filter(r=>r.zone===z.id);return {type:'zone',id:z.id,name:z.name,color:z.color,count:racks.length,s:z.s,f:flowOf(state,racks)};}),'Racks','Zone',sort)}`;
}
export function allRacksHTML(state,zoneId,sort={key:'stored',dir:'desc'}){
 const z=state.zones.find(z=>z.id===zoneId),racks=state.racks.filter(r=>r.zone===zoneId).map(r=>({r,s:stock(state,[r])})).sort((a,b)=>b.s.stored-a.s.stored),s=stock(state,racks.map(x=>x.r));
 return `<div class="lc-modal-head"><h2>${esc(z?.name||zoneId)} <small>${racks.length} racks</small></h2><button type="button" class="lc-close" data-close aria-label="Close"><img class="fg-ic" src="/assets/fg/close.svg" alt=""></button></div><div class="lc-summary"><p>${fmt(s.stored)} of ${fmt(s.total)} boxes used · ${fmt(s.free)} free</p></div>${table(racks.map(({r,s})=>({type:'rack',id:r.id,name:r.id,color:z?.color,count:r.shelves,s,f:flowOf(state,[r])})),'Shelves','Rack',sort)}`;
}
