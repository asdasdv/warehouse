import * as T from 'three';

// Two shared batches, irrespective of pallet count. Only nearby pallets need
// separate boards and fork openings; the overview uses their outer silhouette.
export function palletLOD(placements, detailedGeometry, simpleGeometry, material) {
  const group=new T.Group(),near=new T.InstancedMesh(detailedGeometry,material,placements.length),far=new T.InstancedMesh(simpleGeometry,material,placements.length);
  group.add(near,far);
  for(const mesh of [near,far]){mesh.castShadow=true;mesh.receiveShadow=true;mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);}
  const dummy=new T.Object3D(),last=new T.Vector3(Infinity,Infinity,Infinity);
  let selected=null;
  group.updateLOD=(cameraPosition,rackId=null)=>{
    if(last.distanceToSquared(cameraPosition)<4&&selected===rackId)return false;
    last.copy(cameraPosition);selected=rackId;let n=0,f=0;
    for(const p of placements){
      dummy.position.set(...p.position);dummy.scale.set(...p.size);dummy.updateMatrix();
      const close=dummy.position.distanceToSquared(cameraPosition)<45*45||p.rack===rackId;
      (close?near:far).setMatrixAt(close?n++:f++,dummy.matrix);
    }
    near.count=n;far.count=f;
    for(const mesh of [near,far]){mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();}
    return true;
  };
  group.dispose=()=>{near.dispose();far.dispose();};
  return group;
}

// Reuse GPU buffers across stock movements; grow only when capacity is exhausted.
export function updateCargoBatch(previous,layout,geometry,material){
  let mesh=previous;
  if(!mesh||mesh.instanceMatrix.count<layout.length){
    mesh=new T.InstancedMesh(geometry,material,Math.max(64,Math.ceil(layout.length*1.2)));
    mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
  }
  mesh.count=layout.length;mesh.receiveShadow=true;
  const dummy=new T.Object3D();
  for(let i=0;i<layout.length;i++){
    const p=layout[i];dummy.position.set(p.x,p.y,p.z);dummy.scale.set(p.w,p.h,p.d);dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();
  return mesh;
}
