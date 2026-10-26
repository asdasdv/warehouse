import * as T from 'three';
export function sceneOperations(scene,sim,getState){
 const group=new T.Group(),heat=new T.Group();scene.add(group,heat);let orderId=null,occupancy=false,elapsed=1;
 const dispose=g=>{while(g.children.length){let o=g.children[0];g.remove(o);o.geometry?.dispose();o.material?.dispose();}};
 function outline(p,color){const h=new T.Box3Helper(new T.Box3(new T.Vector3(p.x-p.w/2,p.y-p.h/2,p.z-p.d/2),new T.Vector3(p.x+p.w/2,p.y+p.h/2,p.z+p.d/2)),color);h.material.depthTest=false;h.renderOrder=25;group.add(h);}
 function update(dt){elapsed+=dt;if(elapsed<.5)return;elapsed=0;if(!occupancy&&!orderId)return;dispose(group);dispose(heat);const s=sim.visualState(getState());
 if(occupancy){const counts=new Map();for(const b of s.boxes){if(!counts.has(b.rack))counts.set(b.rack,new Set());counts.get(b.rack).add(b.location);}for(const r of s.racks){const ratio=(counts.get(r.id)?.size||0)/(r.shelves*r.places),color=ratio>=1?0xc99055:ratio>.75?0xe2bc4d:0x67b3a1;let m=new T.Mesh(new T.BoxGeometry(r.width+.3,.12,r.depth+.3),new T.MeshBasicMaterial({color,transparent:true,opacity:.85,depthWrite:false}));m.position.set(r.x,r.height+.2,r.z);heat.add(m);}}
 const o=sim.book.orders.find(o=>o.id===orderId);if(!o)return;
 for(const id of o.allocated){if(o.shipped.includes(id))continue;const p=sim.boxPose(id);if(p)outline(p,0xe4b800);}
 for(const r of sim.robots.filter(r=>r.task?.order?.id===orderId)){outline({x:r.g.position.x,y:1.6,z:r.g.position.z,w:3,h:3.2,d:4},0x1d9aaf);const points=[r.g.position.clone().setY(.4),...r.path.slice(r.index).map(p=>new T.Vector3(p.x,.4,p.z))];if(r.stage==='To pickup')points.push(...(r.task.carry||[]).map(p=>new T.Vector3(p.x,.4,p.z)));const line=new T.Line(new T.BufferGeometry().setFromPoints(points),new T.LineBasicMaterial({color:0x1d9aaf,depthTest:false}));line.renderOrder=24;group.add(line);outline(r.task.drop,0x1d9aaf);}
 }
 return {update,setOrder(id){orderId=id;elapsed=1;if(!id)dispose(group);},setOccupancy(v){occupancy=v;elapsed=1;if(!v)dispose(heat);},get occupancy(){return occupancy;}};
}
