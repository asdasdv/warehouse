import {occupancy} from './storage.js';
const fmt=n=>n.toLocaleString('en-US');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function capacitySummary(state,racks=state.racks){const total=racks.reduce((n,r)=>n+r.shelves*r.places,0),used=racks.reduce((n,r)=>n+occupancy(state,r.id).size,0);return {total,used,free:total-used};}
function numbers(s){return `<div class="ph-total">${fmt(s.total)} <span>Total locations</span></div><div class="ph-pair"><div><span>Used</span><strong>${fmt(s.used)}</strong></div><div><span>Free</span><strong>${fmt(s.free)}</strong></div></div>`;}
function item(name,value,type,id,color='#4ca8f8',subtitle=''){return `<button class="ph-row" data-pick="${type}" data-id="${esc(id)}"><i style="background:${color}"></i><span>${esc(name)}${subtitle?`<small>${esc(subtitle)}</small>`:''}</span><em>${value}</em></button>`;}
export function overviewHTML(state,sel,allZones=false){
 if(sel&&!['zone','rack','location'].includes(sel.type))return null;
 const racks=sel?.type==='zone'?state.racks.filter(r=>r.zone===sel.id):sel?.type==='rack'?state.racks.filter(r=>r.id===sel.id):sel?.type==='location'?state.racks.filter(r=>r.id===sel.id.split('|')[0]):state.racks;
 const cap=capacitySummary(state,racks),z=state.zones.find(z=>z.id===(sel?.type==='zone'?sel.id:racks[0]?.zone));
 let out='<section class="ph-card">';
 if(!sel){
 const zones=state.zones.map(z=>({...z,...capacitySummary(state,state.racks.filter(r=>r.zone===z.id))})).sort((a,b)=>(b.used/(b.total||1))-(a.used/(a.total||1)));
 out+=`<span class="ph-caption">Warehouse</span>${numbers(cap)}<div class="ph-zonebar">${zones.map(z=>`<span style="flex:${z.total||.001};background:${z.color}" title="${esc(z.name)} · ${fmt(z.used)} / ${fmt(z.total)} locations"></span>`).join('')}</div><div class="ph-caption ph-section">${allZones?'All zones':'Fullest zones'}</div><div class="ph-list">${zones.slice(0,allZones?zones.length:5).map(z=>item(z.name,`${fmt(z.used)} / ${fmt(z.total)}`,'zone',z.id,z.color)).join('')}</div><button class="ph-wide" id="allZones">${allZones?'Show fullest zones':'See all zones'}</button></section><section class="ph-card ph-today">${[['Received today',state.today.received],['Shipped today',state.today.shipped],['Moved today',state.history.filter(e=>e.type==='Moved'&&new Date(e.time).toDateString()===new Date().toDateString()).length],['Unplaced',state.counts.receiving]].map(([label,value],i)=>`<button data-stat="${i}" class="${i===3&&value?'ph-danger':''}"><span>${label}</span><strong>${fmt(value)}</strong><small>${i===2?'operations':'boxes'}</small></button>`).join('')}</section>`;
 }else if(sel.type==='zone'){
 out+=`<button class="breadcrumb" data-root>Warehouse ›</button><span class="ph-caption">${esc(z?.name||sel.id)}</span>${numbers(cap)}<div class="ph-caption ph-section">Racks · ${racks.length}</div><div class="ph-list">${racks.map(r=>{const c=capacitySummary(state,[r]);return item(r.id,`${c.used} / ${c.total}`,'rack',r.id,z?.color);}).join('')}</div></section><button class="primary ph-wide" id="showSelected">Show on map</button>`;
 }else if(sel.type==='rack'){
 const bs=state.boxes.filter(b=>b.rack===sel.id);
 out+=`<button class="breadcrumb" data-pick="zone" data-id="${esc(z?.id||'')}">Warehouse › ${esc(z?.name||'')} ›</button><span class="ph-caption">${esc(sel.id)}</span>${numbers(cap)}<div class="ph-caption ph-section">${fmt(bs.length)} boxes</div><div class="ph-list ph-boxes">${bs.slice(0,5).map(b=>item(b.product,esc(b.location),'box',b.id,z?.color,b.id)).join('')}</div><button class="ph-wide" id="allRackBoxes">See all boxes</button><details><summary>Storage addresses</summary><div class="location-grid" style="--cols:${racks[0]?.places||4}">${racks[0]?Array.from({length:racks[0].shelves},(_,i)=>Array.from({length:racks[0].places},(_,j)=>{let loc=`S${i+1}-P${j+1}`;return `<button data-pick="location" data-id="${esc(sel.id+'|'+loc)}">${loc}</button>`;}).join('')).join(''):''}</div></details></section>`;
 }else if(sel.type==='location'){
 const [rid,loc]=sel.id.split('|'),bs=state.boxes.filter(b=>b.rack===rid&&b.location===loc);
 out+=`<button class="breadcrumb" data-pick="rack" data-id="${esc(rid)}">Warehouse › ${esc(z?.name||'')} › ${esc(rid)} ›</button><span class="ph-caption">${esc(loc)}</span><div class="ph-total">${fmt(bs.length)} <span>Boxes at this address</span></div><h3 class="ph-address-product">${esc(bs[0]?.product||'Empty address')}</h3><p class="ph-address-note">${bs.length?'Same component only':'Ready for a component'} · Robot access available</p><div class="ph-caption ph-section">Boxes</div><div class="ph-list ph-boxes">${bs.map(b=>item(b.product,b.id,'box',b.id,z?.color,b.location)).join('')||'<p class="helper">No boxes here yet.</p>'}</div></section><div class="ph-sticky-actions"><button id="moveSelection" ${!bs.length?'disabled':''}>Move</button><button id="receiveHere" class="primary">Receive</button></div>`;
 }
 return out;
}
