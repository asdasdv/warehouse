import * as T from 'three';

// Camera flights between two views. The look-at point glides in a straight line, the viewing direction turns along an
// arc and the distance changes in log space, so zooming in from far away feels even rather than rushing at the end.
// Long hops pull back a little in the middle (like a map's fly-to), so the viewer keeps sight of where they're going.

const easeInOut = v => v < .5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2;

export function flight(fromPos, fromTarget, toPos, toTarget, now, track = null) {
  const r0 = Math.max(1e-3, fromPos.distanceTo(fromTarget)), r1 = Math.max(1e-3, toPos.distanceTo(toTarget));
  const travel = fromTarget.distanceTo(toTarget), reach = Math.max(r0, r1);
  const d0 = fromPos.clone().sub(fromTarget).divideScalar(r0), d1 = toPos.clone().sub(toTarget).divideScalar(r1);
  const turn = d0.angleTo(d1);
  // Longer hops, bigger zooms and bigger turns take longer, within 0.6–1.6 s.
  const duration = Math.min(1600, Math.max(600, 600 + 380 * Math.log2(1 + travel / reach) + 260 * Math.abs(Math.log(r1 / r0)) + 180 * turn));
  return {start: now, duration, fromTarget: fromTarget.clone(), toTarget: toTarget.clone(),
    r0, r1, rotation: new T.Quaternion().setFromUnitVectors(d0, d1), d0, lift: Math.min(.5, Math.max(0, travel / reach - .5) * .35), track};
}

// Where the camera is at `now`; `done` once the flight has landed. A tracked target (a moving robot or box) is
// re-read every frame, so the flight lands on where it is now rather than where it was at take-off.
export function sample(f, now, outPos, outTarget) {
  const v = Math.min(1, (now - f.start) / f.duration), e = easeInOut(v);
  const end = f.track?.() || f.toTarget;
  outTarget.lerpVectors(f.fromTarget, end, e);
  const dir = f.d0.clone().applyQuaternion(new T.Quaternion().slerp(f.rotation, e));
  const r = f.r0 * Math.pow(f.r1 / f.r0, e) * (1 + f.lift * Math.sin(Math.PI * e));
  outPos.copy(outTarget).addScaledVector(dir, r);
  return v === 1;
}
