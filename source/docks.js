// Receiving and dispatch docks: a short belt served by robots at the near end. With conveyors
// (`state.spine`) the far end joins the receiving loop or the dispatch line; without them it ends in a tunnel.
// A dock lives in `state.docks` as {id, kind, x, z, rotation}; (x, z) is the dock origin and
// `rotation` turns it in 90° steps like a rack. Station-local +z runs along the belt, away from the robot.
export const BELT_TOP = 1.5;                 // level with the robot deck
export const BELT_START = -5.9;              // hand-off end, just in front of the stopped robot
const CONVEYOR_LENGTH = 5.8 * BELT_TOP / .65; // conveyor.glb: «Dispatch hide» marker 5.8 m along, belt top 0.65 m
export const BELT_END = BELT_START + CONVEYOR_LENGTH;
export const PORT_Z = -8;                    // where the robot stops (station-local)
const HALF_WIDTH = 2.1, TAIL = BELT_END + 1.3;
const SNAP = 2;                              // docks sit on the robot grid so the robot stops square to the belt

export const DOCK_IDS = [['Receiving 1', 'inbound'], ['Receiving 2', 'inbound'], ['Dispatch 1', 'outbound'], ['Dispatch 2', 'outbound']];

// ---------- conveyors: receiving loop and dispatch line ----------
// `state.spine` = {x1, x2, crossings, loop: {north, south}, out}. Two separate systems run west → east
// through the middle of the building:
// - the receiving loop: boxes leave the receiving building (west of x1) onto the loop's north leg and
//   circulate until their receiving dock has room; receiving docks sit on the north side of the loop;
// - the dispatch line (z = out): dispatch docks on its south side push boxes onto it, and it carries them
//   into the dispatch building (east of x2).
// At each crossing every belt climbs onto a bridge so robots can drive underneath.
export const BELT_HALF = 1.1;      // half width of one belt
export const BRIDGE_LIFT = 3.6, BRIDGE_HALF = 5, RAMP = 8;
export const BUILDING = {length: 14, width: 12, height: 9};
const OUT_START = 10;              // the dispatch line starts this far east of x1
export function spineLift(spine, x) {
  let lift = 0;
  for (const c of spine.crossings || []) {
    const d = Math.abs(x - c);
    lift = Math.max(lift, d <= BRIDGE_HALF ? BRIDGE_LIFT : d < BRIDGE_HALF + RAMP ? BRIDGE_LIFT * (1 - (d - BRIDGE_HALF) / RAMP) : 0);
  }
  return lift;
}
// Profile break points between a and b, for drawing a belt as straight pieces.
export function spineBreaks(spine, a = spine.x1, b = spine.x2) {
  const xs = [a, b];
  for (const c of spine.crossings || []) xs.push(c - BRIDGE_HALF - RAMP, c - BRIDGE_HALF, c + BRIDGE_HALF, c + BRIDGE_HALF + RAMP);
  return [...new Set(xs.filter(x => x >= a && x <= b))].sort((p, q) => p - q);
}
// The receiving loop as a racetrack: straight legs from xa to xb joined by half circles.
// `at(u)` gives the point u metres along it, starting at the west end of the north leg and running east.
export function loopPath(spine) {
  const {north: N, south: S} = spine.loop, R = Math.abs(S - N) / 2, mid = (N + S) / 2;
  const xa = spine.x1 + R, xb = spine.x2 - R, L = xb - xa, length = 2 * L + 2 * Math.PI * R;
  function at(u) {
    u = ((u % length) + length) % length;
    if (u < L) return {x: xa + u, z: N, leg: 'north'};
    if ((u -= L) < Math.PI * R) { const t = u / R; return {x: xb + R * Math.sin(t), z: mid - R * Math.cos(t), leg: 'east'}; }
    if ((u -= Math.PI * R) < L) return {x: xb - u, z: S, leg: 'south'};
    const t = (u - L) / R; return {x: xa - R * Math.sin(t), z: mid + R * Math.cos(t), leg: 'west'};
  }
  return {xa, xb, R, mid, length, at};
}
export const outStart = spine => spine.x1 + OUT_START;
// What robots cannot drive through: the low parts of the belts and the two buildings.
export function spineRects(spine) {
  if (!spine) return [];
  const top = Math.min(spine.loop.north, spine.out) - BELT_HALF - .5, bottom = Math.max(spine.loop.south, spine.out) + BELT_HALF + .5;
  const open = (spine.crossings || []).map(c => [c - BRIDGE_HALF, c + BRIDGE_HALF]).sort((a, b) => a[0] - b[0]), out = [];
  let from = spine.x1;
  for (const [a, b] of [...open, [spine.x2, spine.x2]]) {
    if (a > from) out.push({id: 'Conveyor', x: (from + a) / 2, z: (top + bottom) / 2, width: a - from, depth: bottom - top});
    from = Math.max(from, b);
  }
  const mid = (spine.loop.north + spine.loop.south) / 2;
  out.push({id: 'Receiving building', x: spine.x1 - BUILDING.length / 2, z: mid, width: BUILDING.length, depth: BUILDING.width});
  out.push({id: 'Dispatch building', x: spine.x2 + BUILDING.length / 2, z: spine.out, width: BUILDING.length, depth: BUILDING.width});
  return out;
}
// Receiving docks sit north of the loop and face north; dispatch docks sit south of the dispatch line and face south.
// The dock's belt tail meets the edge of its conveyor.
export function onSpine(spine, x, kind) {
  const z = kind === 'inbound' ? spine.loop.north - BELT_HALF - TAIL : spine.out + BELT_HALF + TAIL;
  return {x: Math.round(x / SNAP) * SNAP, z: Math.round(z / SNAP) * SNAP, rotation: kind === 'inbound' ? 0 : 2};
}
export const dockNorth = (spine, d) => d.kind === 'inbound';
function spineDocks(spine) {
  const xs = spine.docks || [-150, -90, -30, 30, 90, 150];
  return [...xs.map((x, i) => ({id: `Receiving ${i + 1}`, kind: 'inbound', ...onSpine(spine, x, 'inbound')})),
    ...xs.map((x, i) => ({id: `Dispatch ${i + 1}`, kind: 'outbound', ...onSpine(spine, x, 'outbound')}))];
}

// Same turn as three.js rotation.y = -rotation·π/2.
export function toWorld(d, lx, lz) {
  const k = ((d.rotation || 0) % 4 + 4) % 4;
  const [x, z] = k === 0 ? [lx, lz] : k === 1 ? [-lz, lx] : k === 2 ? [-lx, -lz] : [lz, -lx];
  return {x: d.x + x, z: d.z + z};
}
export const dockPort = d => toWorld(d, 0, PORT_Z);
// Axis-aligned footprint of the belt and tunnel (racks use the same {x, z, width, depth} shape).
export function dockRect(d) {
  const a = toWorld(d, -HALF_WIDTH, BELT_START), b = toWorld(d, HALF_WIDTH, TAIL);
  return {x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, width: Math.abs(a.x - b.x), depth: Math.abs(a.z - b.z)};
}

const snap = v => Math.round(v / SNAP) * SNAP;
// Below the zones, clear of the racks: receiving on the left, dispatch on the right.
export function defaultDocks(s) {
  if (s.spine) return spineDocks(s.spine);
  const racks = s.racks || [], zones = s.zones || [];
  const bottom = Math.max(0, ...racks.map(r => r.z + r.depth / 2), ...zones.map(z => z.z + z.d));
  const xs = racks.map(r => r.x), center = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0;
  const portZ = Math.ceil((bottom + 8) / 4) * 4;
  return DOCK_IDS.map(([id, kind], i) => ({id, kind, x: snap(center) + [-36, -18, 18, 36][i], z: portZ - PORT_Z, rotation: 0}));
}
export function docksOf(s) {
  if (!Array.isArray(s.docks) || !s.docks.length) s.docks = defaultDocks(s);
  return s.docks;
}
export function snapDock(p) { return {x: snap(p.x), z: snap(p.z)}; }

// Everything robots must drive around: docks plus the spine and its buildings.
export const layoutObstacles = s => [...docksOf(s).map(dockRect), ...spineRects(s.spine)];

const overlaps = (a, b, gap) => Math.abs(a.x - b.x) < (a.width + b.width) / 2 + gap && Math.abs(a.z - b.z) < (a.depth + b.depth) / 2 + gap;
// Docks keep a robot's width clear of racks and of each other, and their port must be open floor.
export function validateDocks(s) {
  const docks = docksOf(s);
  for (const d of docks) {
    const rect = dockRect(d), port = dockPort(d), portRect = {...port, width: 3, depth: 3};
    const rack = (s.racks || []).find(r => overlaps(rect, r, 1) || overlaps(portRect, r, .5));
    if (rack) throw Error(`${d.id} is too close to rack ${rack.id}.`);
    const other = docks.find(o => o !== d && (overlaps(rect, dockRect(o), 1) || overlaps(portRect, dockRect(o), .5)));
    if (other) throw Error(`${d.id} overlaps ${other.id}.`);
  }
}
