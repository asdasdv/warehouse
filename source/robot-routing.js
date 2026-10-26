// Grid routing around rack footprints, inflated for the transporter's body.
export function createRouter(racks){
 const step=2,margin=1.8;
 const minX=Math.floor((Math.min(0,...racks.map(r=>r.x-r.width/2))-20)/step)*step,minZ=Math.floor((Math.min(0,...racks.map(r=>r.z-r.depth/2))-20)/step)*step;
 const maxX=Math.max(0,...racks.map(r=>r.x+r.width/2))+20,maxZ=Math.max(0,...racks.map(r=>r.z+r.depth/2))+35;
 const w=Math.ceil((maxX-minX)/step)+1,h=Math.ceil((maxZ-minZ)/step)+1,blocked=new Uint8Array(w*h);
 for(const r of racks){let x0=Math.max(0,Math.ceil((r.x-r.width/2-margin-minX)/step)),x1=Math.min(w-1,Math.floor((r.x+r.width/2+margin-minX)/step)),z0=Math.max(0,Math.ceil((r.z-r.depth/2-margin-minZ)/step)),z1=Math.min(h-1,Math.floor((r.z+r.depth/2+margin-minZ)/step));for(let z=z0;z<=z1;z++)for(let x=x0;x<=x1;x++)blocked[z*w+x]=1;}
 const point=i=>({x:minX+(i%w)*step,z:minZ+Math.floor(i/w)*step});
 function nearest(p){let x=Math.round((p.x-minX)/step),z=Math.round((p.z-minZ)/step);for(let d=0;d<5;d++)for(let dz=-d;dz<=d;dz++)for(let dx=-d;dx<=d;dx++){let a=x+dx,b=z+dz;if(a>=0&&a<w&&b>=0&&b<h&&!blocked[b*w+a])return b*w+a;}return -1;}
 function route(from,to){let a=nearest(from),b=nearest(to);if(a<0||b<0)return null;let prev=new Int32Array(w*h).fill(-1),q=new Int32Array(w*h),head=0,tail=1;q[0]=a;prev[a]=a;while(head<tail){let i=q[head++];if(i===b)break;for(let n of [i%w?i-1:-1,i%w<w-1?i+1:-1,i-w,i+w])if(n>=0&&n<w*h&&!blocked[n]&&prev[n]===-1){prev[n]=i;q[tail++]=n;}}if(prev[b]<0)return null;let path=[];for(let i=b;;i=prev[i]){path.push(point(i));if(i===a)break;}return path.reverse();}
 function reachableFrom(origin){
 const seen=new Uint8Array(w*h),q=new Int32Array(w*h);let start=nearest(origin),head=0,tail=0;if(start>=0){q[tail++]=start;seen[start]=1;}
 while(head<tail){const i=q[head++];for(const n of [i%w?i-1:-1,i%w<w-1?i+1:-1,i-w,i+w])if(n>=0&&n<w*h&&!blocked[n]&&!seen[n]){seen[n]=1;q[tail++]=n;}}
 return p=>{if(racks.some(r=>Math.abs(p.x-r.x)<=r.width/2+margin&&Math.abs(p.z-r.z)<=r.depth/2+margin))return false;const x=Math.round((p.x-minX)/step),z=Math.round((p.z-minZ)/step);if(x<0||x>=w||z<0||z>=h||!seen[z*w+x])return false;const cell=point(z*w+x);for(let t=0;t<=1;t+=.1){let px=p.x+(cell.x-p.x)*t,pz=p.z+(cell.z-p.z)*t;if(racks.some(r=>Math.abs(px-r.x)<=r.width/2+margin&&Math.abs(pz-r.z)<=r.depth/2+margin))return false;}return true;};
 }
 return {route,reachableFrom,port:r=>{const t=(r.rotation||0)%4;return t===1?{x:r.x-r.width/2-3,z:r.z}:t===2?{x:r.x,z:r.z-r.depth/2-3}:t===3?{x:r.x+r.width/2+3,z:r.z}:{x:r.x,z:r.z+r.depth/2+3};},point:p=>{let i=nearest(p);return i<0?null:point(i);},blocked};
}
