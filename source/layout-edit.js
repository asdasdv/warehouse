import {placement} from './storage.js';
import {contains,polygonZone,zonesOverlap,fitsZone} from './zone-shape.js';
export function applyLayoutEdit(s,a){
 const ids=new Set(a.ids||[]);
 if(a.type==='zone'){
  const old=s.zones.find(z=>z.id===a.id);if(!old)throw Error('Select a zone.');
  const next={...old,...polygonZone(a.points)};
  if(s.zones.some(z=>z.id!==old.id&&zonesOverlap(z,next)))throw Error('Zone overlaps another zone.');
  const outside=s.racks.filter(r=>r.zone===old.id&&!fitsZone(next,r.x,r.z,r));
  if(outside.length)throw Error('Outside new boundary: '+outside.map(r=>r.id).join(', '));
  Object.assign(old,next);return;
 }
 if(a.type==='delete'){
  if(s.boxes.some(b=>ids.has(b.rack)))throw Error('Move or ship boxes before deleting occupied racks.');
  s.racks=s.racks.filter(r=>!ids.has(r.id));return;
 }
 const racks=s.racks.filter(r=>ids.has(r.id));if(!racks.length)throw Error('Select racks first.');
 const cx=(Math.min(...racks.map(r=>r.x))+Math.max(...racks.map(r=>r.x)))/2,cz=(Math.min(...racks.map(r=>r.z))+Math.max(...racks.map(r=>r.z)))/2;
 const candidates=racks.map(r=>{const n={...r};if(a.type==='rotate'){n.x=cx-(r.z-cz);n.z=cz+(r.x-cx);n.width=r.depth;n.depth=r.width;n.rotation=((r.rotation||0)+1)%4;}else{n.x+=a.dx||0;n.z+=a.dz||0;}const zone=s.zones.find(z=>fitsZone(z,n.x,n.z,n));if(!zone)throw Error('Keep every rack inside a zone.');n.zone=zone.id;return n;});
 const others=s.racks.filter(r=>a.type==='copy'||!ids.has(r.id));
 for(const n of candidates){placement({...s,racks:others},n.zone,n.x,n.z,n);if(a.type==='copy'){let i=1;while([...others,...s.racks].some(r=>r.id===`${n.zone}-${String(i).padStart(2,'0')}`))i++;n.id=`${n.zone}-${String(i).padStart(2,'0')}`;}others.push(n);}
 if(a.type==='copy')s.racks.push(...candidates);else s.racks=s.racks.map(r=>candidates.find(n=>n.id===r.id)||r);
}
export function rowPositions(a,b,c,gap=1){const horizontal=Math.abs(b.x-a.x)>=Math.abs(b.z-a.z),step=(horizontal?c.width:c.depth)+gap,delta=horizontal?b.x-a.x:b.z-a.z,n=Math.min(100,Math.floor(Math.abs(delta)/step)+1);return Array.from({length:n},(_,i)=>({x:a.x+(horizontal?Math.sign(delta)*i*step:0),z:a.z+(horizontal?0:Math.sign(delta)*i*step)}));}
export function narrowPassages(racks){const out=[];for(let i=0;i<racks.length;i++)for(let j=i+1;j<racks.length;j++){let a=racks[i],b=racks[j],dx=Math.abs(a.x-b.x)-(a.width+b.width)/2,dz=Math.abs(a.z-b.z)-(a.depth+b.depth)/2;let gap=dx>=0&&dz<0?dx:dz>=0&&dx<0?dz:null;if(gap!==null&&gap<3.6)out.push({a:a.id,b:b.id,gap,x:(a.x+b.x)/2,z:(a.z+b.z)/2});}return out;}
