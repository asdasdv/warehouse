import {itemOf} from './model.js';
// Right-hand panels driven by the simulation: a box card and the robot fleet.
export function installRobotPanels(scene,beforeOpen,getState=()=>null,onMove=()=>{},onShip=()=>{},product={}){
 const sim=scene.robotics;let page=null,id=null,boxId=null,productName=null,reveal=false;
 const el=document.createElement('aside');el.id='robotPanel';el.hidden=true;document.querySelector('main').append(el);
 const esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const icon=n=>`<img class="fg-ic" src="/assets/fg/${n}.svg" alt="">`,chev='<img src="/assets/fg/chevron-right.svg" alt="">';
 const when=t=>new Date(t).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).replace(',',' ·');
 function open(name,robot){if(name!=='Product')beforeOpen();page=name==='Box'||name==='Product'?name:'Fleet';document.body.classList.toggle('product-open',page==='Product');if(robot){id=robot;reveal=true;}document.body.classList.add('robot-mode');el.hidden=false;lightNav();// Opening Fleet keeps the view where it is; only picking a robot moves the camera.
 if(robot)scene.followRobot(robot);last='';render();}
 function close(){scene.followRobot(null);page=null;document.body.classList.remove('product-open');el.hidden=true;document.body.classList.remove('robot-mode');lightNav();}
 // One lit section in the top bar: Fleet for the fleet, Warehouse for a box card or the map.
 function lightNav(){const inv=document.body.classList.contains('inventory-mode');document.querySelectorAll('.ph-nav .nav').forEach(b=>b.classList.toggle('active',page==='Fleet'?b.hasAttribute('data-robot-view'):inv?b.id==='inventory':b.id==='warehouse'));}
 function boxHTML(){
  const b=sim.boxInfo(boxId),st=getState(),rack=st?.racks.find(x=>x.id===b?.rack),zone=st?.zones.find(z=>z.id===rack?.zone),item=itemOf(b?.product);
  if(!b)return `<div class="lc-crumb"><button data-close>Warehouse</button></div><p>This box has left the warehouse.</p>`;
  let events=st?sim.dashboard(st).history.filter(e=>e.box===boxId).map(e=>({...e,detail:e.from?`${e.from} → ${e.to}`:e.detail})):[];
  // Boxes from before today: show how they arrived, from their receipt date and document.
  if(b.receivedAt&&!events.some(e=>e.type==='Received')){const t=Date.parse(b.receivedAt);events.push({type:'Received',detail:`Dock · ${b.doc||'—'}`,time:b.receivedAt});if(!events.some(e=>e.type==='Put away')&&b.location)events.push({type:'Put away',detail:`Dock → ${b.rack} · ${b.location.split('-')[0]}`,time:new Date(t+12*60e3).toISOString()});}
  events=events.sort((x,y)=>y.time.localeCompare(x.time)).slice(0,5);
  const [shelf,place]=(b.location||'').split('-'),parts=rack?[[zone?.name,'zone',zone?.id],[rack.id,'rack',rack.id],[shelf,'shelf',`${rack.id}|${shelf}`],[place,'location',`${rack.id}|${b.location}`]]:[[b.rack]];
  const detail=(k,v)=>`<div><span>${k}</span><b>${esc(v)}</b></div>`;
  return `<div class="lc-crumb"><button data-close>Warehouse</button>${parts.filter(p=>p[0]).map(([label,type,pid])=>`${chev}<button ${type?`data-pick="${type}" data-id="${esc(pid)}"`:''}>${esc(label)}</button>`).join('')}${chev}<span>${esc(b.id)}</span></div><h3 class="lc-box-id">${esc(b.id)}</h3><div class="lc-details">${detail('Name',b.product)}${detail('SKU',item?.sku||'—')}${detail('Quantity',item?`${item.pcs} pcs · 1 box`:'1 box')}${detail('Received',b.receivedAt?when(b.receivedAt):'—')}${detail('Document',b.doc||'—')}${detail('Place',b.location?`${b.rack} · ${b.location}`:b.rack)}${b.status!=='Stored'?detail('Status',b.robot?`${b.status} · ${b.robot}`:b.status):''}</div><div class="lc-group"><div class="lc-list-head"><span>History · ${events.length}</span><span>Date</span></div><div class="lc-history">${events.map(e=>`<div><span>${esc(e.type)}<small>${esc(e.detail)}</small></span><span>${when(e.time)}</span></div>`).join('')||'<p class="lc-empty">No events for this box yet.</p>'}</div></div><div class="lc-spacer"></div><div class="lc-actions"><button id="moveBox" ${b.actionable?'':'disabled'}>Move</button><button id="shipBox" class="primary" ${b.actionable?'':'disabled'}>Ship</button></div>`;
 }
 // Product card (a row of Inventory): what there is, where it lies by zone, its latest events, and Receive / Ship it.
 function productHTML(){
  const st=getState(),item=itemOf(productName),boxes=st?.boxes.filter(b=>b.product===productName)||[],held=sim.heldBoxes().filter(h=>h.box.product===productName);
  const rackZone=new Map((st?.racks||[]).map(r=>[r.id,r.zone])),zones=new Map();
  for(const b of boxes){const z=rackZone.get(b.rack);if(!zones.has(z))zones.set(z,{n:0,racks:new Map()});const e=zones.get(z);e.n++;e.racks.set(b.rack,(e.racks.get(b.rack)||0)+1);}
  const cells=new Set(boxes.map(b=>b.rack+'|'+b.location)).size,racks=new Set(boxes.map(b=>b.rack)).size;
  const events=st?sim.dashboard(st).history.filter(e=>e.product===productName).slice(0,3):[];
  const lastIn=boxes.reduce((t,b)=>b.receivedAt>t?b.receivedAt:t,''),lastOut=st?.history.find(e=>e.product===productName&&e.type==='Shipped')?.time;
  const detail=(k,v)=>`<div><span>${k}</span><b>${esc(v)}</b></div>`,plural=(n,w)=>`${n.toLocaleString('en-US')} ${w}${n===1?'':w==='box'?'es':'s'}`;
  const zoneRows=[...zones].sort((a,b)=>b[1].n-a[1].n).map(([zid,e])=>{const z=st.zones.find(z=>z.id===zid),top=[...e.racks].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([r])=>r).join(' · ')+(e.racks.size>3?` · +${e.racks.size-3}`:'');
   return `<button class="lc-row" data-pick="zone" data-id="${esc(zid)}"><i style="background:${z?.color||'var(--accent-primary)'}"></i><span>${esc(z?.name||zid)}<small>${esc(top)}</small></span><em>${plural(e.n,'box')}</em></button>`;}).join('');
  return `<div class="lc-crumb"><button data-inventory>Inventory</button>${chev}<span>${esc(productName)}</span></div><h3 class="lc-product-name">${esc(productName)}</h3><div class="lc-details">${detail('SKU',item?.sku||'—')}${detail('Boxes',(boxes.length+held.length).toLocaleString('en-US'))}${detail('On shelves',`${boxes.length.toLocaleString('en-US')} · in ${plural(cells,'cell')} on ${plural(racks,'rack')}`)}${detail('In work',held.length?`${held.length} · on robots and at docks`:'None')}${detail('Last received',lastIn?when(lastIn):'—')}${detail('Last shipped',lastOut?when(lastOut):'—')}</div>`
   +`<div class="lc-group"><div class="lc-list-head"><span>Where it is · ${plural(zones.size,'zone')}</span>${boxes.length?'<button type="button" class="lc-text-btn" id="productMap">Show on map</button>':''}</div><div class="lc-rows">${zoneRows||'<p class="lc-empty">Not on the shelves right now.</p>'}</div></div>`
   +`<div class="lc-group"><div class="lc-list-head"><span>History · ${events.length}</span><span>Date</span></div><div class="lc-history">${events.map(e=>`<div><span>${esc(e.type)}<small>${esc(e.from?`${e.from} → ${e.to}`:e.detail)}</small></span><span>${when(e.time)}</span></div>`).join('')||'<p class="lc-empty">No events for this product today.</p>'}</div></div>`
   +`<div class="lc-spacer"></div><div class="lc-actions"><button id="productReceive">Receive</button><button id="productShip" class="primary" ${boxes.length?'':'disabled'}>Ship</button></div>`;
 }
 // Battery: a small cell filled to the charge, green from 50%, yellow from 25%, red below.
 const battery=v=>{const p=Math.round(v),k=p>=50?'ok':p>=25?'mid':'low';return `<span class="lc-batt ${k}" title="Battery"><i><i style="width:${p}%"></i></i>${p}%</span>`;};
 function fleetHTML(){
  // Only robots that are on the floor; standby robots are parked off the map until demand grows.
  // The list holds the robots on the floor. A reserve robot (charging in a depot) picked on the map shows on top.
  const active=sim.robots.filter(r=>r.active),picked=sim.robots.find(r=>r.id===id&&!r.active),robots=picked?[picked,...active]:active,busy=active.filter(r=>r.task).length,reserve=sim.robots.length-active.length;
  const status=r=>!r.active?'In reserve · charging':r.task||r.charging||r.paused?r.status:'Idle';
  return `<div class="lc-title"><h2>Fleet</h2><button id="closeRobots" class="icon" aria-label="Close">${icon('close')}</button></div><div class="lc-group"><div class="lc-list-head"><span>Robots · ${active.length}</span><span>${busy} on tasks · ${active.length-busy} idle${reserve?` · ${reserve} in reserve`:''}</span></div><div class="lc-rows">${robots.map(r=>{const short=x=>String(x||'').replace(/^Receiving \d+$/,'Dock').split(' / ')[0],t=r.task,task=t?`${esc(r.mission)} · ${esc(short(r.from))} → ${esc(short(r.to))}`:'No task';
   // Figma "Robot row / C · Stage": three fixed lines, the bar shows to pickup → loading → carrying.
   const step=!t?-1:r.stage==='To pickup'?0:r.stage==='Loading'?1:2;
   return `<button class="lc-robot${r.id===id?' chosen':''}" data-rid="${r.id}"><div class="l1"><b>${r.id}</b><span>${task}</span></div><div class="lc-robot-steps">${[0,1,2].map(k=>`<i class="${k<=step?'on':''}"></i>`).join('')}</div><div class="l3"><span>${esc(status(r))}</span>${battery(r.battery)}</div></button>`;}).join('')}</div></div>`;
 }
 let last='';
 // Live updates change the text inside the robot cards in place: rebuilding the cards every
 // half second restarted their hover state, so a card under the cursor kept flashing.
 function patch(html){if(page!=='Fleet')return false;const t=document.createElement('div');t.innerHTML=html;const was=[...el.querySelectorAll('[data-rid]')],now=[...t.querySelectorAll('[data-rid]')];
  if(!was.length||was.length!==now.length||was.some((r,i)=>r.dataset.rid!==now[i].dataset.rid))return false;
  was.forEach((r,i)=>{if(r.className!==now[i].className)r.className=now[i].className;if(r.innerHTML!==now[i].innerHTML)r.innerHTML=now[i].innerHTML;});
  const head=el.querySelector('.lc-list-head'),next=t.querySelector('.lc-list-head');if(head&&next&&head.innerHTML!==next.innerHTML)head.innerHTML=next.innerHTML;return true;}
 // A robot picked on the map may be far down the list: its card is scrolled to the middle of the panel once.
 function showChosen(){if(!reveal||page!=='Fleet')return;const c=el.querySelector('.lc-robot.chosen');if(!c)return;reveal=false;const box=el.getBoundingClientRect(),r=c.getBoundingClientRect();
  if(r.top<box.top||r.bottom>box.bottom)el.scrollTo({top:el.scrollTop+r.top-box.top-(box.height-r.height)/2,behavior:'smooth'});}
 function render(){draw();showChosen();}
 function draw(){if(!page)return;
  if(page==='Product'&&!productName){close();return;}
  // A box that has left the warehouse (shipped, cancelled) closes its card and goes back to the warehouse view.
  if(page==='Box'&&!sim.boxInfo(boxId)){close();onPick(null);return;}el.classList.toggle('box-panel',page==='Box'||page==='Product');const html=page==='Box'?boxHTML():page==='Product'?productHTML():fleetHTML();if(html===last)return;if(patch(html)){last=html;return;}last=html;const scroll=el.scrollTop;el.innerHTML=html;el.scrollTop=scroll;
  el.querySelector('#shipBox')?.addEventListener('click',()=>onShip(boxId));
  el.querySelector('#moveBox')?.addEventListener('click',()=>onMove(boxId));
  el.querySelector('#closeRobots')?.addEventListener('click',close);
  el.querySelector('[data-inventory]')?.addEventListener('click',()=>{productName=null;close();product.onClose?.();});
  el.querySelector('#productReceive')?.addEventListener('click',()=>product.onReceive?.(productName));
  el.querySelector('#productShip')?.addEventListener('click',()=>product.onShip?.(productName));
  el.querySelector('#productMap')?.addEventListener('click',()=>product.onMap?.(productName));
  el.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>{close();onPick(null);});
  el.querySelectorAll('[data-pick]').forEach(b=>b.onclick=()=>{close();onPick({type:b.dataset.pick,id:b.dataset.id});});
  el.querySelectorAll('[data-rid]').forEach(b=>b.onclick=()=>{id=b.dataset.rid;scene.followRobot(id);last='';render();});}
 let onPick=()=>{};
 function openProduct(name){productName=name;last='';open('Product');}
 function openBox(value){boxId=value;open('Box');scene.focusBox(value);}
 document.querySelectorAll('[data-robot-view]').forEach(b=>b.onclick=()=>page==='Fleet'?close():open('Fleet'));
 setInterval(render,500);
 return {open,close,openBox,openProduct,get product(){return page==='Product'?productName:null;},setPick(fn){onPick=fn;},get page(){return page;}};
}
