const esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function installHistoryPage({getState,onClose}){
  const page=document.createElement('section');
  page.id='historyPage';page.hidden=true;document.querySelector('main').append(page);
  let filter='All',query='',index=0;
  const tabs=['All','Received','Put away','Shipped','Moved','System'];
  function visible(){const events=getState().history||[];return events.filter(e=>(filter==='All'||e.type===filter)&&`${e.type} ${e.detail}`.toLowerCase().includes(query));}
  function render(){if(page.hidden)return;const events=getState().history||[],rows=visible(),pages=Math.max(1,Math.ceil(rows.length/10));index=Math.min(index,pages-1);
    page.innerHTML=`<div class="ph-history-head"><h1>History</h1><p>Every recorded warehouse change</p></div><div class="ph-history-tools"><div class="ph-history-tabs">${tabs.map(t=>`<button data-filter="${t}" class="${filter===t?'active':''}">${t} <small>${t==='All'?events.length:events.filter(e=>e.type===t).length}</small></button>`).join('')}</div><input id="historySearch" type="search" placeholder="Search event or place…" value="${esc(query)}" aria-label="Search history"></div><div class="ph-history-table"><div class="ph-history-row ph-history-labels"><span>Time</span><span>Event</span><span>Details</span></div>${rows.slice(index*10,index*10+10).map(e=>`<div class="ph-history-row"><time>${new Date(e.time).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</time><strong>${esc(e.type)}</strong><span>${esc(e.detail)}</span></div>`).join('')||'<div class="ph-history-empty">No matching events yet.</div>'}</div><div class="ph-history-foot"><span>Showing ${rows.length?index*10+1:0}–${Math.min((index+1)*10,rows.length)} of ${rows.length} events</span><div><button id="historyPrev" ${index===0?'disabled':''}>‹</button><b>${index+1} / ${pages}</b><button id="historyNext" ${index>=pages-1?'disabled':''}>›</button></div></div>`;
    page.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;index=0;render();});page.querySelector('#historySearch').oninput=e=>{query=e.target.value.toLowerCase();index=0;const pos=e.target.selectionStart;render();const input=page.querySelector('#historySearch');input.focus();input.setSelectionRange(pos,pos);};page.querySelector('#historyPrev').onclick=()=>{index--;render();};page.querySelector('#historyNext').onclick=()=>{index++;render();};
  }
  function open(type='All'){filter=tabs.includes(type)?type:'All';index=0;page.hidden=false;document.body.classList.add('history-mode');render();}
  function close(){page.hidden=true;document.body.classList.remove('history-mode');onClose?.();}
  return {open,close,render,isOpen:()=>!page.hidden};
}
