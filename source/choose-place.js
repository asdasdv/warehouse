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
// "Choose another place": zone → rack → cell. onPick({rack, loc}) closes the chooser.
export function placeChooser({dialog,state,product,qty=1,exclude,backLabel,onPick,onBack,instant=false}){
 const used=new Map(),idx=boxIndex(state);for(const b of state.boxes)used.set(b.rack,(used.get(b.rack)||0)+1);
 const free=racks=>racks.reduce((n,r)=>n+rackCapacity(r)-(used.get(r.id)||0),0);
 const color=zid=>state.zones.find(z=>z.id===zid)?.color||'var(--accent-primary)';
 let step='zone',zone=null,rack=null,choice=null;
 const frame=(back,title,sub,body)=>`<div class="lc-dialog"><div class="lc-dlg-top"><button type="button" class="lc-back" data-back><img class="fg-ic" src="/assets/fg/arrow-left.svg" alt="">${esc(back)}</button><button type="button" class="icon" data-close aria-label="Close">${icon('close')}</button></div><h2>${esc(title)}</h2><p class="lc-sub">${sub}</p>${body}</div>`;
 const option=(id,name,value,c)=>`<button type="button" class="lc-option" data-go="${esc(id)}"><i style="background:${c}"></i><span>${esc(name)}</span><em>${value}</em><img src="/assets/fg/chevron-right.svg" alt=""></button>`;
 function draw(){
  if(step==='zone'){
   const zones=state.zones.map(z=>({z,free:free(state.racks.filter(r=>r.zone===z.id))})).sort((a,b)=>b.free-a.free);
   dialog.innerHTML=frame(backLabel,'Choose a zone','Where should the boxes go? Sorted by free room.',`<div class="lc-options">${zones.map(({z,free})=>option(z.id,z.name,`${free} free`,z.color)).join('')}</div>`);
  }else if(step==='rack'){
   const z=state.zones.find(z=>z.id===zone),racks=state.racks.filter(r=>r.zone===zone).map(r=>({r,free:free([r])})).sort((a,b)=>b.free-a.free||a.r.id.localeCompare(b.r.id));
   dialog.innerHTML=frame('Zones',z?.name||zone,'Choose a rack · sorted by free room',`<div class="lc-options">${racks.map(({r,free})=>option(r.id,r.id,`${free} free`,z?.color)).join('')||'<p class="lc-empty">No racks in this zone.</p>'}</div>`);
  }else{
   const r=state.racks.find(r=>r.id===rack),occ=idx.get(r.id)||new Map(),c=color(r.zone);
   if(!choice){const best=bestAddress(state,r,product,exclude,idx);choice=best?.loc||null;}
   const cells=[];for(let s=r.shelves;s>=1;s--){cells.push(`<span class="s">S${s}</span>`);for(let p=1;p<=r.places;p++){const loc=`S${s}-P${p}`,bs=occ.get(loc)||[],room=cellRoom(state,r.id,loc,product,exclude,idx),same=bs.length&&bs[0].product===product;cells.push(`<button type="button" class="lc-cell${loc===choice?' chosen':''}${same?' same':''}" data-cell="${loc}" ${room?'':'disabled'} title="${loc} · ${bs.length?esc(bs[0].product):'empty'}">${Array.from({length:CELL_CAPACITY},(_,i)=>`<i class="${i<bs.length?'box':''}"></i>`).join('')}</button>`);}}
   const room=choice?cellRoom(state,r.id,choice,product,exclude,idx):0;
   dialog.innerHTML=frame('Racks',r.id,`Pick a cell · each cell holds ${CELL_CAPACITY} boxes`,`<div class="lc-grid" style="--cols:${r.places};--cell-color:${c}"><span></span>${Array.from({length:r.places},(_,i)=>`<span>P${i+1}</span>`).join('')}${cells.join('')}</div><div class="lc-legend" style="--cell-color:${c}"><span><i class="box"></i>box</span><span><i></i>free space</span></div>${choice?`<div class="lc-card"><div>${esc(r.id)} · ${choice}</div><em>${room} free · fits ${Math.min(room,qty)} ${Math.min(room,qty)===1?'box':'boxes'}</em></div>`:'<p class="lc-empty">No free cell for this component on this rack.</p>'}<button type="button" class="primary" id="usePlace" ${choice?'':'disabled'}>Use this place</button>`);
   // `instant`: picking a cell is the choice itself, with no confirm step.
   dialog.querySelectorAll('[data-cell]').forEach(b=>b.onclick=()=>{choice=b.dataset.cell;if(instant)onPick({rack:r.id,loc:choice});else draw();});
   dialog.querySelector('#usePlace').onclick=()=>onPick({rack:r.id,loc:choice});
  }
  dialog.querySelector('[data-close]').onclick=()=>dialog.close();
  dialog.querySelector('[data-back]').onclick=()=>{if(step==='zone')onBack();else{step=step==='cell'?'rack':'zone';choice=null;draw();}};
  dialog.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>{if(step==='zone'){zone=b.dataset.go;step='rack';}else{rack=b.dataset.go;step='cell';choice=null;}draw();});
 }
 draw();
}
