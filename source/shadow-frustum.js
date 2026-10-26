import * as T from 'three';
// Fit in light space once per layout. Camera orbit/zoom must not move the shadow texels.
export function warehouseShadowFrame(racks,zones=[]){
 const bounds=new T.Box3();
 for(const r of racks){bounds.expandByPoint(new T.Vector3(r.x-r.width/2,0,r.z-r.depth/2));bounds.expandByPoint(new T.Vector3(r.x+r.width/2,r.height,r.z+r.depth/2));}
 for(const z of zones){bounds.expandByPoint(new T.Vector3(z.x,0,z.z));bounds.expandByPoint(new T.Vector3(z.x+z.w,0,z.z+z.d));}
 if(bounds.isEmpty())bounds.set(new T.Vector3(-30,0,-30),new T.Vector3(30,12,30));
 bounds.expandByVector(new T.Vector3(45,2,45));
 const target=bounds.getCenter(new T.Vector3()),distance=bounds.getSize(new T.Vector3()).length()*1.5;
 const position=target.clone().add(new T.Vector3(-.7,1.5,.8).normalize().multiplyScalar(distance));
 const lightCamera=new T.PerspectiveCamera();lightCamera.position.copy(position);lightCamera.lookAt(target);lightCamera.updateMatrixWorld();
 const local=new T.Box3();
 for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z])local.expandByPoint(new T.Vector3(x,y,z).applyMatrix4(lightCamera.matrixWorldInverse));
 return {position,target,bounds,left:local.min.x-2,right:local.max.x+2,bottom:local.min.y-2,top:local.max.y+2,near:Math.max(.1,-local.max.z-5),far:-local.min.z+5};
}
