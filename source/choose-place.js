import {occupancy,locations} from './storage.js';
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// "Choose a place" modal: search + zone chips + racks sorted by free places.
// pick(rack) resolves to the first compatible address in the rack (same component, else empty).
export function bestAddress(state,rack,product,exclude){const occ=occupancy(state,rack.id);let empty=null;for(const loc of locations(rack)){if(exclude&&exclude.rack===rack.id&&exclude.loc===loc)continue;const bs=occ.get(loc)||[];if(bs.length&&bs[0].product===product)return {rack:rack.id,loc};if(!bs.length&&!empty)empty={rack:rack.id,loc};}return empty;}
export function placeChooser({dialog,state,product,exclude,onPick,onBack,onMap}){
 let zone=state.zones[0]?.id||'all',query='';
 const free=r=>r.shelves*r.places-occupancy(state,r.id).size;
 const racks=()=>state.racks.filter(r=>(zone==='all'||r.zone===zone)&&(!query||r.id.toLowerCase().includes(query))).map(r=>({r,free:free(r)})).sort((a,b)=>b.free-a.free||a.r.id.localeCompare(b.r.id));
 const color=r=>state.zones.find(z=>z.id===r.zone)?.color||'#82c0fa';
 const draw=()=>{const list=racks(),z=state.zones.find(z=>z.id===zone);
  dialog.innerHTML=`<form><div class="title"><h2>Choose a place</h2><button type="button" class="icon" id="closeDialog" aria-label="Close"><img class="fg-ic" src="/assets/fg/close.svg" alt=""></button></div><label class="fg-search"><img src="/assets/fg/search.svg" alt=""><input id="placeSearch" placeholder="Search rack or address, e.g. R-04" value="${esc(query)}" autocomplete="off"></label><div class="fg-zones"><button type="button" class="fg-chip ${zone==='all'?'chosen':''}" data-zone="all">All</button>${state.zones.map(z=>`<button type="button" class="fg-chip ${zone===z.id?'chosen':''}" data-zone="${esc(z.id)}">${esc(z.id)}</button>`).join('')}</div><span class="ph-field-label">${z?esc(z.name):'All zones'} · sorted by free places</span><div class="fg-racks">${list.map(({r,free})=>`<button type="button" class="ph-row" data-rack="${esc(r.id)}"><i style="background:${color(r)}"></i><span>${esc(r.id)}</span><em>${free} free</em></button>`).join('')||'<p class="helper">No racks match.</p>'}</div><p class="form-error" id="error"></p><button type="button" class="outline wide" id="pickOnMap">Pick on the map</button></form>`;
  dialog.querySelector('#closeDialog').onclick=onBack;
  dialog.querySelectorAll('[data-zone]').forEach(b=>b.onclick=()=>{zone=b.dataset.zone;draw();});
  const input=dialog.querySelector('#placeSearch');input.oninput=()=>{query=input.value.trim().toLowerCase();const pos=input.selectionStart;draw();const n=dialog.querySelector('#placeSearch');n.focus();n.setSelectionRange(pos,pos);};
  dialog.querySelectorAll('[data-rack]').forEach(b=>b.onclick=()=>{const r=state.racks.find(x=>x.id===b.dataset.rack),c=bestAddress(state,r,product,exclude);if(!c){dialog.querySelector('#error').textContent=`${r.id} has no compatible free address.`;return;}onPick(c);});
  dialog.querySelector('#pickOnMap').onclick=onMap;
 };
 draw();
}
