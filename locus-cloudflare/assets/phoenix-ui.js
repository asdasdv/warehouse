// Phoenix UI glue: top-bar search pill, avatar → View menu popover
const ready=f=>{const t=setInterval(()=>{if(document.querySelector('.dock')&&document.querySelector('.rail')){clearInterval(t);f()}},50)};
ready(()=>{
  const rail=document.querySelector('.rail'),dock=document.querySelector('.dock'),search=dock.querySelector('#search');
  const bolt=rail.querySelector('[data-robot-view="Live floor"]');
  rail.insertBefore(dock,bolt);
  dock.addEventListener('click',()=>search.focus());
  search.placeholder='Search product, box or location…';

  const click=s=>()=>{document.querySelector(s)?.click();close()};
  const menu=document.createElement('div');menu.id='viewMenu';menu.hidden=true;
  menu.innerHTML=`<button class="vm-row" data-act="occ"><span>Occupancy</span><i class="vm-switch"></i></button><div class="vm-div"></div><button class="vm-row" data-act="edit"><span>Edit warehouse layout</span><i class="vm-open"></i></button><button class="vm-row" data-act="demo"><span>Demo scenarios</span></button>`;
  document.body.appendChild(menu);
  const sw=menu.querySelector('.vm-switch'),occ=()=>document.querySelector('#occupancyView');
  const sync=()=>sw.classList.toggle('on',occ()?.getAttribute('aria-pressed')==='true');
  function close(){menu.hidden=true}
  menu.querySelector('[data-act=occ]').onclick=()=>{occ()?.click();setTimeout(sync,50)};
  menu.querySelector('[data-act=edit]').onclick=click('#edit');
  menu.querySelector('[data-act=demo]').onclick=click('[data-robot-view="Scenarios"]');
  document.querySelector('.avatar').addEventListener('click',e=>{e.stopPropagation();sync();menu.hidden=!menu.hidden});
  document.addEventListener('click',e=>{if(!menu.contains(e.target))close()});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')close()});
});
