import {pageButtons} from './pager.js';
import {sortHead, sortRows, toggleSort, bindSort} from './table-sort.js';
const esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function installHistoryPage({getState,onClose,onBox}){
  const page=document.createElement('section');
  page.id='historyPage';page.hidden=true;document.querySelector('main').append(page);
  let filter='All',query='',typed='',index=0,sort={key:'time',dir:'desc'};
  const tabs=['All','Received','Put away','Shipped','Moved','System'];
  function cells(e){if(e.box)return {box:e.box,product:e.product,route:`${e.from} → ${e.to}`};let parts=e.detail.split(' · '),box=/^(BX|IN|OUT)-\d+$/.test(parts[0])?parts.shift():'—',rest=parts.join(' · '),product,route;if(rest.includes(' → ')){[product,route]=rest.split(' → ');}else{product=parts.shift()||rest;route=parts.join(' · ')||'—';}return {box,product,route};}
  function kind(e){return tabs.includes(e.type)?e.type:'System';}
  function visible(){const events=getState().history||[];return events.filter(e=>(filter==='All'||kind(e)===filter)&&`${e.type} ${e.detail}`.toLowerCase().includes(query));}
  const value=(e,k)=>k==='time'?Date.parse(e.time):k==='event'?e.type:cells(e)[k];
  function render(){if(page.hidden)return;const events=getState().history||[],rows=sortRows(visible(),sort,value),pages=Math.max(1,Math.ceil(rows.length/10));index=Math.min(index,pages-1);
    page.innerHTML=`<div class="ph-history-head"><h1>History</h1></div><div class="ph-history-tools"><div class="ph-history-tabs">${tabs.map(t=>`<button data-filter="${t}" class="${filter===t?'active':''}">${t} <small>${t==='All'?events.length:events.filter(e=>kind(e)===t).length}</small></button>`).join('')}</div><label class="lc-input ph-history-search"><img class="fg-ic" src="/assets/fg/search.svg" alt=""><input id="historySearch" type="search" placeholder="Search box, product or place…" value="${esc(typed)}" aria-label="Search history"></label></div><table class="ph-history-table ph-history-fixed"><colgroup><col style="width:160px"><col style="width:140px"><col style="width:140px"><col><col style="width:300px"></colgroup><thead><tr>${sortHead('Time','time',sort)}${sortHead('Event','event',sort,'','asc')}${sortHead('Box','box',sort,'','asc')}${sortHead('Product','product',sort,'','asc')}${sortHead('From → to','route',sort,'','asc')}</tr></thead><tbody>${rows.slice(index*10,index*10+10).map(e=>{const c=cells(e),box=/^BX-\d+$/.test(c.box)?c.box:'';return `<tr${box?` data-box="${box}" tabindex="0"`:''}><td class="sub">${new Date(e.time).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).replace(',',' ·')}</td><td>${esc(e.type)}</td><td class="sub">${esc(c.box)}</td><td>${esc(c.product)}</td><td class="sub">${esc(c.route)}</td></tr>`;}).join('')||'<tr class="lc-empty-row"><td colspan="5">No matching events yet</td></tr>'}</tbody></table>${pages>1?`<div class="ph-history-foot"><span>Showing ${rows.length?index*10+1:0}–${Math.min((index+1)*10,rows.length)} of ${rows.length} events</span><div><button id="historyPrev" ${index===0?'disabled':''}>‹</button>${pageButtons(index,pages)}<button id="historyNext" ${index>=pages-1?'disabled':''}>›</button></div></div>`:''}`;
    bindSort(page,(k,f)=>{sort=toggleSort(sort,k,f);index=0;render();});
    // A row about a box opens that box (on the map, or its last state if it has left).
    page.querySelectorAll('tr[data-box]').forEach(tr=>{tr.onclick=()=>onBox?.(tr.dataset.box);tr.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onBox?.(tr.dataset.box);}};});
    page.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;index=0;render();});page.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>{index=+b.dataset.page;render();});page.querySelector('#historySearch').oninput=e=>{typed=e.target.value;query=typed.trim().toLowerCase();index=0;const pos=e.target.selectionStart;render();const input=page.querySelector('#historySearch');input.focus();input.setSelectionRange(pos,pos);};page.querySelector('#historyPrev')?.addEventListener('click',()=>{index--;render();});page.querySelector('#historyNext')?.addEventListener('click',()=>{index++;render();});
  }
  function open(type='All'){filter=tabs.includes(type)?type:'All';index=0;page.hidden=false;document.body.classList.add('history-mode');render();}
  function close(){page.hidden=true;document.body.classList.remove('history-mode');onClose?.();}
  setInterval(()=>{if(!page.hidden&&!page.contains(document.activeElement))render();},2000);
  return {open,close,render,isOpen:()=>!page.hidden};
}
