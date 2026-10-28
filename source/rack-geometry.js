import {rackLevels,palletHeight} from './rack-levels.js';
// One parametric construction for placed racks and placement previews.
// Dimensions and addresses stay in the inventory model; these are visual parts.
export function rackParts(r){
  if(r.rotation){const turns=r.rotation%4,local={...r,rotation:0,width:turns%2?r.depth:r.width,depth:turns%2?r.width:r.depth};
   const rotate=p=>{let [x,y,z]=p;for(let i=0;i<turns;i++)[x,z]=[-z,x];return [x,y,z];};
   return rackParts(local).map(p=>p.from?{...p,from:rotate(p.from),to:rotate(p.to)}:{...p,p:rotate(p.p),size:turns%2?[p.size[2],p.size[1],p.size[0]]:p.size});
  }

  const {base,gap}=rackLevels(r);
  const parts=[],w=r.width,d=r.depth,h=r.height;
  const add=(kind,x,y,z,sx,sy,sz)=>parts.push({kind,p:[x,y,z],size:[sx,sy,sz]});
  const brace=(a,b)=>parts.push({kind:'brace',from:a,to:b,thickness:.045});
  for(const x of [-w/2,w/2])for(const z of [-d/2,d/2]){
    // Open channel uprights, anchor plates and connection hardware.
    add('frame',x,h/2,z,.10,h,.16);
    add('frame',x+.075,h/2,z-.065,.07,h,.03);
    add('frame',x+.075,h/2,z+.065,.07,h,.03);
    add('frame',x,.035,z,.32,.07,.34);
    for(const dx of [-.105,.105])for(const dz of [-.11,.11])add('hardware',x+dx,.083,z+dz,.035,.025,.035);
    for(let s=0;s<r.shelves;s++){
      let y=base+s*gap+.16;
      for(const off of [0,.08,.16])if(y+off<h)add('hardware',x+.012,y+off,z+(z<0?-.086:.086),.035,.035,.012);
    }
  }
  for(let s=0;s<r.shelves;s++){
    let y=base+s*gap;
    for(const z of [-d/2,d/2])add('beam',0,y+.02,z,w,.18,.12);
    for(const x of [-w/2,w/2])add('beam',x,y+.025,0,.10,.17,d);
    // Thin steel deck with visible seams and individual storage bays.
    for(let p=0;p<r.places;p++){
      let cell=w/r.places,x=-w/2+(p+.5)*cell;
      add('pallet',x,y+.115+palletHeight(r)/2,0,cell*.94,palletHeight(r),d*.94);
      add('deck',x,y+.09,0,cell-.025,.05,Math.max(.1,d-.15));
      add('beam',x,y-.015,0,.06,.12,Math.max(.1,d-.2));
    }
  }
  // End-frame X bracing: front remains open for access.
  const segments=Math.max(1,Math.ceil(r.shelves/2));
  for(const x of [-w/2,w/2])for(let j=0;j<segments;j++){
    let low=.2+j*(h-.4)/segments,high=.2+(j+1)*(h-.4)/segments;
    brace([x,low,-d/2],[x,high,d/2]);brace([x,low,d/2],[x,high,-d/2]);
  }
  for(const x of [-w/2,w/2])add('beam',x,h-.05,0,.09,.10,d);
  return parts;
}
