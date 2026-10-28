import {fitsZone} from './zone-shape.js';
import {rackLevels,palletHeight,palletBaseOffset} from './rack-levels.js';
// Storage locations are addresses, not a promise of physical box capacity.
export const templates={small:{label:'Small',width:3,depth:1.5,height:3,shelves:3,places:3},standard:{label:'Standard',width:6,depth:4,height:7.3,shelves:5,places:4},large:{label:'Large',width:9,depth:4,height:8,shelves:6,places:6}};
export function config(r={}){return {width:r.width??6,depth:r.depth??4,height:r.height??7.3,shelves:r.shelves??5,places:r.places??4};}
export function locations(r){let a=[];for(let s=1;s<=r.shelves;s++)for(let p=1;p<=r.places;p++)a.push(`S${s}-P${p}`);return a;}
export function validateConfig(r){for(let k of ['width','depth','height'])if(!Number.isFinite(r[k])||r[k]<1||r[k]>20)throw Error('Dimensions must be between 1 and 20 m.');for(let k of ['shelves','places'])if(!Number.isInteger(r[k])||r[k]<1||r[k]>12)throw Error('Use 1–12 shelves and 1–12 locations per shelf.');if(r.height/r.shelves<.3||r.width/r.places<.2)throw Error('Each shelf needs at least 0.3 m height and each location 0.2 m width.');}
export function placement(s,zone,x,z,c,ignore=null){validateConfig(c);let a=s.zones.find(a=>a.id===zone);if(!a||!fitsZone(a,x,z,c))throw Error('Place the whole rack inside a zone.');if(s.racks.some(r=>r.id!==ignore&&Math.abs(r.x-x)<(config(r).width+c.width)/2+1&&Math.abs(r.z-z)<(config(r).depth+c.depth)/2+1))throw Error('Leave at least 1 m between racks.');}
export function occupancy(s,rack){let out=new Map();for(let b of s.boxes)if(b.rack===rack){if(!out.has(b.location))out.set(b.location,[]);out.get(b.location).push(b);}return out;}
export function destination(s,rack,location,product,ignore=[]){let r=s.racks.find(r=>r.id===rack);if(!r||!locations(r).includes(location))throw Error('Choose a valid storage location.');let skip=new Set(ignore);if(s.boxes.some(b=>b.rack===rack&&b.location===location&&!skip.has(b.id)&&b.product!==product))throw Error('This location contains a different component. Choose an empty location or one with the same component.');}
export function migrate(input){let s=structuredClone(input);if(s.version===2)return s;if(s.version!==1)throw Error('Unsupported backup version.');for(let r of s.racks){Object.assign(r,config(r));delete r.capacity;let bs=s.boxes.filter(b=>b.rack===r.id),groups=new Map();for(let b of bs){if(!groups.has(b.product))groups.set(b.product,[]);groups.get(b.product).push(b);}if(groups.size>r.shelves*r.places)throw Error('Too many component types in a legacy rack.');let ids=locations(r),cursor=0,left=groups.size;for(let group of groups.values()){let n=Math.min(group.length,Math.floor((ids.length-cursor)/left));group.forEach((b,i)=>b.location=ids[cursor+i%n]);cursor+=n;left--;}}s.version=2;return s;}
// A stable carton grid per rack template. Occupancy changes positions, not shape.
// Reserve room for the seeded 14 cartons per address; larger loads get more cells.
export function cartonGrid(r,count=14){
 const width=r.width/r.places*.88,depth=r.depth*.88;
 const height=Math.max(.04,rackLevels(r).gap-palletBaseOffset-palletHeight(r)-.04);
 let best=null;
 for(let cols=1;cols<=Math.min(count,32);cols++)for(let layers=1;layers<=Math.min(count,32);layers++){
  const rows=Math.ceil(count/(cols*layers));
  const scale=Math.min(width/cols,depth/(rows*1.2),height/(layers*.85));
  if(!best||scale>best.scale)best={cols,rows,layers,scale};
 }
 return {...best,w:best.scale*.94,d:best.scale*1.2*.94,h:best.scale*.85*.94};
}
export function boxLayout(r,boxes){
 if(r.rotation){const turns=r.rotation%4,local={...r,rotation:0,x:0,z:0,width:turns%2?r.depth:r.width,depth:turns%2?r.width:r.depth};return boxLayout(local,boxes).map(p=>{let x=p.x,z=p.z;for(let i=0;i<turns;i++)[x,z]=[-z,x];return {...p,x:r.x+x,z:r.z+z,w:turns%2?p.d:p.w,d:turns%2?p.w:p.d};});}
 const groups=new Map();for(const b of boxes){if(!groups.has(b.location))groups.set(b.location,[]);groups.get(b.location).push(b);}
 const out=[],cell=r.width/r.places,{base,gap}=rackLevels(r);
 const grid=cartonGrid(r,Math.max(14,...Array.from(groups.values(),bs=>bs.length)));
 for(const [loc,bs] of groups){
  const [,sh,pl]=/^S(\d+)-P(\d+)$/.exec(loc);
  bs.forEach((b,i)=>{
   const col=i%grid.cols,row=Math.floor(i/grid.cols)%grid.rows,layer=Math.floor(i/(grid.cols*grid.rows));
   out.push({box:b,x:r.x-r.width/2+(Number(pl)-.5)*cell+(col-(grid.cols-1)/2)*grid.scale,
    z:r.z+(row-(grid.rows-1)/2)*grid.scale*1.2,
    y:base+(Number(sh)-1)*gap+palletBaseOffset+palletHeight(r)+layer*grid.h+grid.h/2,
    w:grid.w,d:grid.d,h:grid.h});
  });
 }
 return out;
}
