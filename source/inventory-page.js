import {pageButtons} from './pager.js';
import {sortHead, sortRows, toggleSort, bindSort} from './table-sort.js';
import {itemOf} from './model.js';
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),fmt=n=>n.toLocaleString('en-US');
const icon=n=>`<img class="fg-ic" src="/assets/fg/${n}.svg" alt="">`;
export function inventorySnapshot(state,sim){
 const live=sim.dashboard(state),boxes=live.boxes.map(b=>({...b,place:`${b.rack} · ${b.location}`,kind:'stored'}));
 for(const h of sim.heldBoxes())boxes.push({...h.box,rack:'',place:h.place,kind:h.kind});
 return {live,boxes};
}
const DAY=86400e3;
const age=b=>{const t=Date.parse(b.receivedAt||0),start=new Date().setHours(0,0,0,0);return t>=start?'Today':t>=start-6*DAY?'Last 7 days':'Older';};
// Filters: Zone, Rack, Shelf, Product, SKU, Received date. Each keeps a set of chosen values.
const KEYS=['Zone','Rack','Shelf','Product','SKU','Received date'];
export function installInventoryPage({getState,sim,onShip,onReceive,onHistory,onLocation}){
 const el=document.createElement('section');el.id='inventoryPage';el.className='lc-inv';el.hidden=true;document.querySelector('main').append(el);
 let sort={key:'boxes',dir:'desc'},active=false,query='',page=0,popover=null,popQuery='',hovering=false;const others=[];const filters=new Map(),size=50;
 // Rack → zone, rebuilt once per render: looking it up box by box over 1 200 racks made Inventory slow to open.
 let rackZone=new Map();const zoneOfRack=(st,rid)=>rackZone.get(rid);
 function value(st,b,key){const stored=b.kind===undefined||b.kind==='stored';if(key==='Zone')return stored?zoneOfRack(st,b.rack)?.id:null;if(key==='Rack')return stored?b.rack:null;if(key==='Shelf')return stored?b.location.split('-')[0]:null;if(key==='Product')return b.product;if(key==='SKU')return itemOf(b.product)?.sku||null;return age(b);}
 const matches=(st,b,skip)=>[...filters].every(([k,set])=>k===skip||!set.size||set.has(value(st,b,k)));
 const label=(st,key,v)=>key==='Zone'?(st.zones.find(z=>z.id===v)?.name||v):v;
 function token(st,key,set){const vals=[...set],z=key==='Zone'&&vals.length===1?st.zones.find(x=>x.id===vals[0]):null;return `<span class="lc-token"><button data-open="${key}">${key}</button><span>is</span><button data-open="${key}">${z?`<i style="background:${z.color}"></i>${esc(z.id)}`:vals.length===1?esc(vals[0]):`${vals.length} values`}</button><button class="x" data-remove="${key}" aria-label="Remove filter">${icon('close')}</button></span>`;}
 function popHTML(st,boxes){
  if(!popover)return '';
  if(popover==='add'){const keys=KEYS.filter(k=>!filters.has(k)&&k.toLowerCase().includes(popQuery));return `<div class="lc-pop" id="invPop"><div class="lc-pop-search">${icon('search')}<input id="popSearch" placeholder="Filter by…" value="${esc(popQuery)}"></div>${keys.map(k=>`<button data-add="${k}">${k}</button>`).join('')||'<p class="lc-empty">No more filters.</p>'}</div>`;}
  const set=filters.get(popover)||new Set(),counts=new Map();for(const b of boxes){if(!matches(st,b,popover))continue;const v=value(st,b,popover);if(v!=null)counts.set(v,(counts.get(v)||0)+1);}
  const vals=[...counts].filter(([v])=>label(st,popover,v).toLowerCase().includes(popQuery)).sort((a,b)=>String(a[0]).localeCompare(String(b[0]),'en',{numeric:true}));
  return `<div class="lc-pop wide" id="invPop"><div class="lc-pop-search">${icon('search')}<input id="popSearch" placeholder="${esc(popover)}" value="${esc(popQuery)}"></div><div class="lc-pop-list">${vals.map(([v,n])=>{const z=popover==='Zone'?st.zones.find(x=>x.id===v):null;return `<button data-toggle="${esc(v)}" class="${set.has(v)?'on':''}"><span class="lc-check">${set.has(v)?'✓':''}</span>${z?`<i style="background:${z.color}"></i>`:''}<span class="v">${esc(label(st,popover,v))}</span><small>${fmt(n)}</small></button>`;}).join('')||'<p class="lc-empty">No values.</p>'}</div></div>`;
 }
 function render(inPlace=false){
  if(!active)return;const st=getState(),live=sim.dashboard(st),boxes=st.boxes;
  {const zones=new Map(st.zones.map(z=>[z.id,z]));rackZone=new Map(st.racks.map(r=>[r.id,zones.get(r.zone)]));}
  const located=[...filters.keys()].some(k=>['Zone','Rack','Shelf'].includes(k)&&filters.get(k).size);
  const anyFilter=[...filters.values()].some(v=>v.size),hit=!anyFilter&&!query?boxes:boxes.filter(b=>(!anyFilter||matches(st,b))&&(!query||`${b.product} ${itemOf(b.product)?.sku||''} ${b.id} ${b.rack} · ${b.location}`.toLowerCase().includes(query)));
  const groups=new Map();for(const b of hit){if(!groups.has(b.product))groups.set(b.product,[]);groups.get(b.product).push(b);}
  // Location sorts by how many places (rack · shelf) the product is spread over.
  const value=([p,bs],k)=>k==='sku'?itemOf(p)?.sku||'':k==='product'?p:k==='boxes'?bs.length:new Set(bs.map(b=>b.rack+'|'+b.location.split('-')[0])).size;
  const rows=sortRows([...groups].sort((a,b)=>a[0].localeCompare(b[0])),sort,value),pages=Math.max(1,Math.ceil(rows.length/size));page=Math.min(page,pages-1);
  // Daily numbers follow the filters: location filters use per-rack flow, others the history.
  const today=new Date().toDateString(),racks=new Set(hit.map(b=>b.rack)),products=new Set(hit.map(b=>b.product));
  const flowIn=[...racks].reduce((n,r)=>n+(st.flow?.[r]?.in||0),0),flowOut=[...racks].reduce((n,r)=>n+(st.flow?.[r]?.out||0),0);
  const histCount=type=>st.history.filter(e=>e.type===type&&new Date(e.time).toDateString()===today&&products.has(e.product)).length;
  const filtered=[...filters.values()].some(v=>v.size),y=st.yesterday||{},pct=(a,b)=>!b?'':(a>=b?'+':'−')+Math.abs(Math.round((a-b)/b*100))+'%';
  const metrics=filtered?[['Boxes stored',hit.length,''],['Received today',located?flowIn:histCount('Received'),''],['Shipped today',located?flowOut:histCount('Shipped'),'']]
   :[['Boxes on site',live.onSite??boxes.length,''],['Received today',live.today.received,pct(live.today.received,y.received)],['Shipped today',live.today.shipped,pct(live.today.shipped,y.shipped)]];
  const pill=b=>{const z=zoneOfRack(st,b.rack),[s]=b.location.split('-'),text=filters.get('Rack')?.size?b.location:`${b.rack} · ${s}`;return {key:text,zone:z,html:`<button class="lc-loc" data-rack="${esc(b.rack)}" style="background:${z?.color||'var(--accent-primary)'}">${esc(text)}</button>`};};
  const byRack=filters.get('Rack')?.size,locCell=bs=>{const seen=new Map();for(const b of bs){const key=byRack?b.location:`${b.rack} · ${b.location.split('-')[0]}`;if(!seen.has(key))seen.set(key,pill(b));}const list=[...seen.values()],shown=filters.get('Rack')?.size?3:2,rest=list.slice(shown);if(rest.length)others.push(rest);return list.slice(0,shown).map(p=>p.html).join('')+(rest.length?`<span class="more" tabindex="0" role="button" aria-haspopup="dialog" data-more="${others.length-1}">+${rest.length} ${rest.length===1?'place':'places'}</span>`:'');};
  others.length=0;
  const st0=page*size;
  const html=`<div class="ph-history-head"><h1>Inventory</h1></div><div class="lc-inv-metrics">${metrics.map(([t,n,d],i)=>`<div class="lc-stat"><span>${t}</span><div><b>${fmt(n)}</b><small>${d}</small></div></div>`).join('')}</div>
  <div class="lc-filters"><div class="lc-input lc-inv-search">${icon('search')}<input id="invSearch" placeholder="Search product, SKU or box…" value="${esc(query)}" aria-label="Search inventory"></div>${[...filters].map(([k,s])=>s.size?token(st,k,s):`<span class="lc-token"><button data-open="${k}">${k}</button><span>is</span><button data-open="${k}">any</button><button class="x" data-remove="${k}" aria-label="Remove filter">${icon('close')}</button></span>`).join('')}<button class="lc-add${filters.size?' icon-only':''}" data-open="add" aria-label="Add filter">${icon('plus')}${filters.size?'':'<span>Filter</span>'}</button>${filters.size>1?'<button class="lc-clear" id="invClear">Clear</button>':''}${popHTML(st,boxes)}</div>
  <table class="ph-history-table lc-inv-table"><colgroup><col style="width:160px"><col><col style="width:80px"><col style="width:390px"></colgroup><thead><tr>${sortHead('SKU','sku',sort,'','asc')}${sortHead('Product','product',sort,'','asc')}${sortHead('Boxes','boxes',sort,'num')}${sortHead('Location','location',sort)}</tr></thead><tbody>${rows.slice(st0,st0+size).map(([p,bs])=>`<tr><td class="sub">${esc(itemOf(p)?.sku||'—')}</td><td>${esc(p)}</td><td class="num">${fmt(bs.length)}</td><td class="lc-locs">${locCell(bs)}</td></tr>`).join('')||'<tr class="lc-empty-row"><td colspan="4">No matching stock<small>Try another search or remove a filter</small></td></tr>'}</tbody></table>
  ${pages>1?`<div class="ph-history-foot"><span>Showing ${st0+1}–${Math.min(st0+size,rows.length)} of ${fmt(rows.length)} products</span><div><button id="invPrev" ${page===0?'disabled':''}>‹</button>${pageButtons(page,pages)}<button id="invNext" ${page>=pages-1?'disabled':''}>›</button></div></div>`:''}`;
  if(inPlace&&patch(html))return;
  el.innerHTML=html;bind();
 }
 // "+N places" popover (Figma popover/Other places): the remaining places grouped by zone.
 const tip=document.createElement('div');tip.className='lc-places';tip.hidden=true;document.querySelector('main').append(tip);
 let hideTimer=null;
 function showPlaces(anchor,rest){
  clearTimeout(hideTimer);hovering=true;const zones=new Map();for(const p of rest){const k=p.zone?.id||'';if(!zones.has(k))zones.set(k,{z:p.zone,items:[]});zones.get(k).items.push(p.html);}
  tip.innerHTML=`<b>Also stored in ${rest.length} ${rest.length===1?'place':'places'}</b>${[...zones.values()].map(({z,items})=>`<div><small>${esc(z?.name||'Other')} · ${items.length}</small><div class="lc-places-row">${items.join('')}</div></div>`).join('')}`;
  tip.hidden=false;const r=anchor.getBoundingClientRect(),host=document.querySelector('main').getBoundingClientRect();
  tip.style.left=`${Math.min(r.left-host.left,host.width-tip.offsetWidth-12)}px`;
  // Open on the side with more room; a long list scrolls inside the popover.
  const spaceBelow=host.bottom-r.bottom-14,spaceAbove=r.top-host.top-52-14,down=spaceBelow>=Math.min(tip.scrollHeight,240)||spaceBelow>=spaceAbove;
  tip.style.maxHeight=`${Math.max(160,down?spaceBelow:spaceAbove)}px`;
  tip.style.top=`${down?r.bottom-host.top+6:r.top-host.top-6-Math.min(tip.scrollHeight,spaceAbove)}px`;
  tip.querySelectorAll('[data-rack]').forEach(b=>b.onclick=()=>{hidePlaces(true);close();onLocation('stored',b.dataset.rack);});
  anchor.onmouseleave=()=>hidePlaces();
 }
 function hidePlaces(now){clearTimeout(hideTimer);hideTimer=setTimeout(()=>{tip.hidden=true;hovering=false;},now?0:150);}
 tip.onmouseenter=()=>clearTimeout(hideTimer);tip.onmouseleave=()=>hidePlaces();
 tip.addEventListener('focusout',e=>{if(!tip.contains(e.relatedTarget))hidePlaces();});tip.addEventListener('keydown',e=>{if(e.key==='Escape')hidePlaces(true);});
 function keepFocus(sel,fn){const input=el.querySelector(sel),pos=input?.selectionStart;fn();const n=el.querySelector(sel);if(n){n.focus();n.setSelectionRange(pos,pos);}}
 function bind(){
  // The «+N places» list opens on hover, on focus and on Enter/Space; Escape closes it (bindRows).
  bindSort(el,(k,f)=>{sort=toggleSort(sort,k,f);page=0;render();});
  el.querySelectorAll('[data-open]').forEach(b=>b.onclick=e=>{e.stopPropagation();const k=b.dataset.open;popover=popover===k?null:k;popQuery='';render();el.querySelector('#popSearch')?.focus();});
  el.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{filters.delete(b.dataset.remove);popover=null;page=0;render();});
  el.querySelectorAll('[data-add]').forEach(b=>b.onclick=e=>{e.stopPropagation();filters.set(b.dataset.add,new Set());popover=b.dataset.add;popQuery='';render();});
  el.querySelectorAll('[data-toggle]').forEach(b=>b.onclick=e=>{e.stopPropagation();const set=filters.get(popover),v=b.dataset.toggle;set.has(v)?set.delete(v):set.add(v);page=0;render();});
  const pop=el.querySelector('#invPop'),anchor=popover&&(popover==='add'?el.querySelector('[data-open="add"]'):[...el.querySelectorAll(`.lc-token [data-open="${popover}"]`)].pop());
  if(pop&&anchor){pop.style.left=`${anchor.offsetLeft}px`;pop.style.top=`${anchor.offsetTop+anchor.offsetHeight+6}px`;}
  el.querySelector('#popSearch')?.addEventListener('input',e=>{popQuery=e.target.value.toLowerCase();keepFocus('#popSearch',render);});
  el.querySelector('#invPop')?.addEventListener('click',e=>e.stopPropagation());
  el.querySelector('#invClear')?.addEventListener('click',()=>{filters.clear();page=0;render();});
  el.querySelector('#invSearch').oninput=e=>{query=e.target.value.trim().toLowerCase();page=0;keepFocus('#invSearch',render);};
  el.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>{page=+b.dataset.page;render();});
  el.querySelector('#invPrev')?.addEventListener('click',()=>{page--;render();});el.querySelector('#invNext')?.addEventListener('click',()=>{page++;render();});
  bindRows();
 }
 function bindRows(){
  el.querySelectorAll('[data-more]').forEach(m=>{const open=()=>showPlaces(m,others[Number(m.dataset.more)]);m.onmouseenter=open;m.onfocus=open;m.onblur=()=>{if(!tip.contains(document.activeElement))hidePlaces();};
   m.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();tip.querySelector('[data-rack]')?.focus();}if(e.key==='Escape')hidePlaces(true);};});
  el.querySelectorAll('[data-rack]').forEach(b=>b.onclick=()=>{close();onLocation('stored',b.dataset.rack);});
 }
 // Live refresh changes only what changed: the numbers on top and the rows whose text moved. Rebuilding the
 // whole page every 1.5 s dropped the row under the cursor and felt like the table lagging.
 function patch(html){
  const t=document.createElement('div');t.innerHTML=html;
  // The × that main.js adds to search fields isn't part of the rendered markup, so it is left out of the comparison.
  const markup=n=>{if(!n)return '';const c=n.cloneNode(true);c.querySelectorAll('.lc-clear').forEach(x=>x.remove());return c.outerHTML;};
  const same=sel=>markup(el.querySelector(sel))===markup(t.querySelector(sel));
  if(!same('.lc-filters')||!same('.ph-history-foot'))return false;
  const was=[...el.querySelectorAll('tbody tr')],now=[...t.querySelectorAll('tbody tr')];if(was.length!==now.length)return false;
  const m=el.querySelector('.lc-inv-metrics'),n=t.querySelector('.lc-inv-metrics');if(m&&n&&m.innerHTML!==n.innerHTML)m.innerHTML=n.innerHTML;
  was.forEach((r,i)=>{if(r.innerHTML!==now[i].innerHTML)r.innerHTML=now[i].innerHTML;});
  bindRows();return true;
 }
 document.addEventListener('click',e=>{if(active&&popover&&!e.target.closest('#invPop')){popover=null;render();}});
 function close(){active=false;popover=null;tip.hidden=true;hovering=false;el.hidden=true;document.body.classList.remove('inventory-mode');}
 setInterval(()=>{if(active&&!hovering&&!popover&&!el.contains(document.activeElement))render(true);},1500);
 return {close,open(q){if(q!==undefined){query=q.toLowerCase();page=0;}active=true;el.hidden=false;document.body.classList.add('inventory-mode');document.querySelectorAll('.ph-nav .nav').forEach(b=>b.classList.toggle('active',b.id==='inventory'));render();}};
}
