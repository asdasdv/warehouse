import {occupancy,locations,CELL_CAPACITY,rackCapacity} from './storage.js';
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=n=>`<img class="fg-ic" src="/assets/fg/${n}.svg" alt="">`;
// Free room in a cell for this product: 0 when another component is stored there.
// Boxes by rack and cell, built once per dialog: looking cells up one by one in state.boxes took seconds.
export function boxIndex(state){const idx=new Map();for(const b of state.boxes){let m=idx.get(b.rack);if(!m)idx.set(b.rack,m=new Map());let l=m.get(b.location);if(!l)m.set(b.location,l=[]);l.push(b);}return idx;}
export function cellRoom(state,rackId,loc,product,exclude,idx){const bs=(idx?idx.get(rackId)?.get(loc):occupancy(state,rackId).get(loc))||[];if(exclude&&exclude.rack===rackId&&exclude.loc===loc)return 0;if(bs.length&&bs[0].product!==product)return 0;return Math.min(CELL_CAPACITY-bs.length,liveRoom?.(rackId,loc,product)??Infinity);}
// The simulation also knows about boxes already on their way to a cell; set from main.js.
let liveRoom=null;export function setLiveRoom(fn){liveRoom=fn;}
export function bestAddress(state,rack,product,exclude,idx){let empty=null;for(const loc of locations(rack)){const room=cellRoom(state,rack.id,loc,product,exclude,idx);if(!room)continue;if(room<CELL_CAPACITY)return {rack:rack.id,loc};if(!empty)empty={rack:rack.id,loc};}return empty;}
// "Choose another place", three windows: zones (chips, search) → racks of a zone → cells of a rack.
// onPick({rack, loc}) closes the chooser. onMap: pick the rack in the 3D view instead; startRack opens window 3 for it.
export function placeChooser({dialog,state,product,qty=1,exclude,backLabel,onPick,onBack,onMap,startRack=null,instant=false}){
 const used=new Map(),idx=boxIndex(state);for(const b of state.boxes)used.set(b.rack,(used.get(b.rack)||0)+1);
 const free=racks=>racks.reduce((n,r)=>n+rackCapacity(r)-(used.get(r.id)||0),0);
 const zoneOf=zid=>state.zones.find(z=>z.id===zid),color=zid=>zoneOf(zid)?.color||'var(--accent-primary)';
 let step=startRack?'cell':'zone',zone=startRack?state.racks.find(r=>r.id===startRack)?.zone:null,rack=startRack,choice=null,query='';
 const frame=(back,title,body)=>`<div class="lc-dialog"><div class="lc-dlg-top"><button type="button" class="lc-back" data-back><img class="fg-ic" src="/assets/fg/arrow-left.svg" alt="">${esc(back)}</button><button type="button" class="icon" data-close aria-label="Close">${icon('close')}</button></div><h2>${esc(title)}</h2>${body}</div>`;
 const option=(attr,name,value,c)=>`<button type="button" class="lc-option" ${attr}><i style="background:${c}"></i><span>${esc(name)}</span><em>${value}</em><img src="/assets/fg/chevron-right.svg" alt=""></button>`;
 // Search: racks by id, or a full address (“A-04 S5-P3”) straight to its cell.
 function results(){const q=query.trim().toUpperCase().replace(/\s*[·|]\s*/,' ');const addr=/^([A-Z]+-\d+)\s+(S\d+-P\d+)$/.exec(q),out=[];
  if(addr){const r=state.racks.find(r=>r.id===addr[1]);if(r&&locations(r).includes(addr[2]))out.push(option(`data-rack="${esc(r.id)}" data-loc="${addr[2]}"`,`${r.id} · ${addr[2]}`,`${cellRoom(state,r.id,addr[2],product,exclude,idx)} free`,color(r.zone)));}
  for(const r of state.racks.filter(r=>r.id.includes(q.split(' ')[0])).slice(0,8))out.push(option(`data-rack="${esc(r.id)}"`,r.id,`${free([r])} free`,color(r.zone)));
  return `<div class="lc-options">${out.join('')||'<p class="lc-empty">No rack or address like that.</p>'}</div>`;}
 function draw(){
  if(step==='zone'){
   const chips=state.zones.map(z=>`<button type="button" class="lc-chip" data-zone="${esc(z.id)}" style="--zone:${z.color}" title="${esc(z.name)} · ${free(state.racks.filter(r=>r.zone===z.id))} free">${esc(z.name.replace(/^Zone\s+/,''))}</button>`).join('');
   dialog.innerHTML=frame(backLabel,'Choose a place',`<div class="lc-input">${icon('search')}<input id="placeSearch" placeholder="Search rack or address, e.g. A-04" autocomplete="off" value="${esc(query)}"></div><div id="placeBody">${query?results():`<div class="lc-field"><span>Zones</span><div class="lc-chips">${chips}</div></div>`}</div>${onMap?'<button type="button" class="lc-outline" id="pickOnMap">Pick on the map</button>':''}`);
   const input=dialog.querySelector('#placeSearch');
   input.oninput=()=>{query=input.value;const pos=input.selectionStart;draw();const n=dialog.querySelector('#placeSearch');n.focus();n.setSelectionRange(pos,pos);};
   dialog.querySelector('#pickOnMap')?.addEventListener('click',onMap);
  }else if(step==='rack'){
   const z=zoneOf(zone),racks=state.racks.filter(r=>r.zone===zone).map(r=>({r,free:free([r])})).sort((a,b)=>b.free-a.free||a.r.id.localeCompare(b.r.id));
   dialog.innerHTML=frame('Zones',z?.name||zone,`<div class="lc-options">${racks.map(({r,free})=>option(`data-rack="${esc(r.id)}"`,r.id,`${free} free`,z?.color)).join('')||'<p class="lc-empty">No racks in this zone.</p>'}</div>`);
  }else{
   const r=state.racks.find(r=>r.id===rack),occ=idx.get(r.id)||new Map(),c=color(r.zone);
   if(!choice){const best=bestAddress(state,r,product,exclude,idx);choice=best?.loc||null;}
   // A cell with room is a white outlined button; a full one is grey and dimmed. Occupied places are filled
   // with the zone colour, free places are dashed outlines.
   const cells=[];for(let s=r.shelves;s>=1;s--){cells.push(`<span class="s">S${s}</span>`);for(let p=1;p<=r.places;p++){const loc=`S${s}-P${p}`,bs=occ.get(loc)||[],room=cellRoom(state,r.id,loc,product,exclude,idx);cells.push(`<button type="button" class="lc-cell${loc===choice?' chosen':''}${room?'':' full'}" data-cell="${loc}" ${room?'':'disabled'} title="${loc} · ${bs.length?esc(bs[0].product):'empty'}">${Array.from({length:CELL_CAPACITY},(_,i)=>`<i class="${i<bs.length?'occ':''}"></i>`).join('')}</button>`);}}
   const room=choice?cellRoom(state,r.id,choice,product,exclude,idx):0;
   dialog.innerHTML=frame(zoneOf(r.zone)?.name||'Racks',r.id,`<div class="lc-grid" style="--cols:${r.places};--cell-color:${c}"><span></span>${Array.from({length:r.places},(_,i)=>`<span>P${i+1}</span>`).join('')}${cells.join('')}</div><div class="lc-legend" style="--cell-color:${c}"><span><i class="occ"></i>Occupied</span><span><i></i>Free</span></div>${choice?`<div class="lc-card"><div>${esc(r.id)} · ${choice}</div><em>${room} free · fits ${Math.min(room,qty)} ${Math.min(room,qty)===1?'box':'boxes'}</em></div>`:'<p class="lc-empty">No free cell for this component on this rack.</p>'}<button type="button" class="primary" id="usePlace" ${choice?'':'disabled'}>Use this place</button>`);
   // `instant`: picking a cell is the choice itself, with no confirm step.
   dialog.querySelectorAll('[data-cell]').forEach(b=>b.onclick=()=>{choice=b.dataset.cell;if(instant)onPick({rack:r.id,loc:choice});else draw();});
   dialog.querySelector('#usePlace').onclick=()=>onPick({rack:r.id,loc:choice});
  }
  dialog.querySelector('[data-close]').onclick=()=>dialog.close();
  dialog.querySelector('[data-back]').onclick=()=>{if(step==='zone')onBack();else{step=step==='cell'&&zone?'rack':'zone';choice=null;draw();}};
  dialog.querySelectorAll('[data-zone]').forEach(b=>b.onclick=()=>{zone=b.dataset.zone;step='rack';draw();});
  dialog.querySelectorAll('[data-rack]').forEach(b=>b.onclick=()=>{rack=b.dataset.rack;zone=state.racks.find(r=>r.id===rack)?.zone;step='cell';choice=b.dataset.loc||null;draw();});
 }
 draw();
}
