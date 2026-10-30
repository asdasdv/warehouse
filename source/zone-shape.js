export const zonePoints=z=>z.points||[{x:z.x,z:z.z},{x:z.x+z.w,z:z.z},{x:z.x+z.w,z:z.z+z.d},{x:z.x,z:z.z+z.d}];
const cross=(a,b,c)=>(b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
const on=(p,a,b)=>Math.abs(cross(a,b,p))<1e-7&&p.x>=Math.min(a.x,b.x)-1e-7&&p.x<=Math.max(a.x,b.x)+1e-7&&p.z>=Math.min(a.z,b.z)-1e-7&&p.z<=Math.max(a.z,b.z)+1e-7;
const intersects=(a,b,c,d)=>cross(a,b,c)*cross(a,b,d)<-1e-9&&cross(c,d,a)*cross(c,d,b)<-1e-9;
export function contains(z,p){const ps=zonePoints(z);let inside=false;for(let i=0,j=ps.length-1;i<ps.length;j=i++){let a=ps[j],b=ps[i];if(on(p,a,b))return true;if((a.z>p.z)!==(b.z>p.z)&&p.x<(b.x-a.x)*(p.z-a.z)/(b.z-a.z)+a.x)inside=!inside;}return inside;}
export function zoneArea(z){const p=zonePoints(z);return Math.abs(p.reduce((n,a,i)=>{let b=p[(i+1)%p.length];return n+a.x*b.z-b.x*a.z;},0))/2;}
// One size rule for every zone: each side of its bounding box at least MIN_ZONE_SIDE m, and at least
// MIN_ZONE_AREA m² of floor (a 12 × 12 m square). Rectangles drawn in the editor, typed sizes and polygons all use it.
export const MIN_ZONE_SIDE=12,MIN_ZONE_AREA=MIN_ZONE_SIDE*MIN_ZONE_SIDE;
export const ZONE_SIZE_MESSAGE=`Zones are at least ${MIN_ZONE_SIDE} m on each side and ${MIN_ZONE_AREA} m².`;
export function checkZoneSize(z){if(!(z.w>=MIN_ZONE_SIDE&&z.d>=MIN_ZONE_SIDE&&zoneArea(z)>=MIN_ZONE_AREA-1e-9))throw Error(ZONE_SIZE_MESSAGE);return z;}
// A simple polygon only: no crossing edges, no corner touching another edge or corner, no zero-length edge and no
// edge folding back over its neighbour. Every edge pair is tested symmetrically, so the winding direction never matters.
export function polygonZone(points){if(points.length<3||points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.z)))throw Error('Add at least three corners.');const n=points.length,P=i=>points[(i+n)%n];
 for(let i=0;i<n;i++){const a=P(i),b=P(i+1);if(Math.hypot(b.x-a.x,b.z-a.z)<1e-7)throw Error('Zone corners must not repeat.');}
 for(let i=0;i<n;i++){const a=P(i),b=P(i+1),c=P(i+2);if(on(c,a,b)||on(a,b,c))throw Error('Zone edges cannot cross or touch.');}
 for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){if(j===i+1||i===0&&j===n-1)continue;const a=P(i),b=P(i+1),c=P(j),d=P(j+1);if(intersects(a,b,c,d)||on(a,c,d)||on(b,c,d)||on(c,a,b)||on(d,a,b))throw Error('Zone edges cannot cross or touch.');}
 let xs=points.map(p=>p.x),zs=points.map(p=>p.z);let z={points:points.map(p=>({...p})),x:Math.min(...xs),z:Math.min(...zs),w:Math.max(...xs)-Math.min(...xs),d:Math.max(...zs)-Math.min(...zs)};return checkZoneSize(z);}
export function fitsZone(z,x,y,c){const r={x:x-c.width/2,z:y-c.depth/2,w:c.width,d:c.depth},rp=zonePoints(r),ps=zonePoints(z);if(!rp.every(p=>contains(z,p)))return false;for(let i=0;i<ps.length;i++){let a=ps[i],b=ps[(i+1)%ps.length];if(a.x>r.x+1e-7&&a.x<r.x+r.w-1e-7&&a.z>r.z+1e-7&&a.z<r.z+r.d-1e-7)return false;for(let j=0;j<4;j++)if(intersects(a,b,rp[j],rp[(j+1)%4]))return false;}return true;}
export function zonesOverlap(a,b){const ap=zonePoints(a),bp=zonePoints(b);return ap.some(p=>contains(b,p))||bp.some(p=>contains(a,p))||ap.some((p,i)=>bp.some((q,j)=>intersects(p,ap[(i+1)%ap.length],q,bp[(j+1)%bp.length])));}
export function snapRack(s,p,c,enabled=true){let x=Math.round(p.x),z=Math.round(p.z);if(!enabled)return {x,z,snapped:false};let dx=.8,dz=.8,snapped=false;for(const r of s.racks){if(Math.hypot(r.x-p.x,r.z-p.z)>Math.max(c.width,c.depth,r.width,r.depth)*3)continue;for(const v of [r.x,r.x-r.width/2+c.width/2,r.x+r.width/2-c.width/2,r.x-(r.width+c.width)/2-1,r.x+(r.width+c.width)/2+1])if(Math.abs(v-p.x)<dx){dx=Math.abs(v-p.x);x=v;snapped=true;}for(const v of [r.z,r.z-r.depth/2+c.depth/2,r.z+r.depth/2-c.depth/2,r.z-(r.depth+c.depth)/2-1,r.z+(r.depth+c.depth)/2+1])if(Math.abs(v-p.z)<dz){dz=Math.abs(v-p.z);z=v;snapped=true;}}return {x,z,snapped};}
