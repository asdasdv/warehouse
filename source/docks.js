// Receiving and dispatch docks: a short belt served by robots at the near end. On a warehouse with a
// conveyor spine (`state.spine`) the far end joins the spine; without one it ends in a tunnel.
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

// ---------- conveyor spine ----------
// {x1, x2, z, crossings}: two parallel belts running west (x1, receiving building) → east (x2, dispatch building).
// At each crossing the spine climbs onto a bridge so robots can drive underneath.
export const SPINE_HALF = 3;       // half width of the spine footprint
export const SPINE_BELT = 1.3;     // belt centre offset from the spine axis (north belt at -, south at +)
export const BRIDGE_LIFT = 3.6, BRIDGE_HALF = 5, RAMP = 8;
export const BUILDING = {length: 14, width: 12, height: 9};
const DOCK_OFFSET = 12;            // dock origin from the spine axis: the belt tail meets the spine edge
export function spineLift(spine, x) {
  let lift = 0;
  for (const c of spine.crossings || []) {
    const d = Math.abs(x - c);
    lift = Math.max(lift, d <= BRIDGE_HALF ? BRIDGE_LIFT : d < BRIDGE_HALF + RAMP ? BRIDGE_LIFT * (1 - (d - BRIDGE_HALF) / RAMP) : 0);
  }
  return lift;
}
// Profile break points along the spine, for drawing the belts as straight pieces.
export function spineBreaks(spine) {
  const xs = [spine.x1, spine.x2];
  for (const c of spine.crossings || []) xs.push(c - BRIDGE_HALF - RAMP, c - BRIDGE_HALF, c + BRIDGE_HALF, c + BRIDGE_HALF + RAMP);
  return [...new Set(xs.filter(x => x >= spine.x1 && x <= spine.x2))].sort((a, b) => a - b);
}
// What robots cannot drive through: the low parts of the spine and the two end buildings.
export function spineRects(spine) {
  if (!spine) return [];
  const open = (spine.crossings || []).map(c => [c - BRIDGE_HALF, c + BRIDGE_HALF]).sort((a, b) => a[0] - b[0]), out = [];
  let from = spine.x1;
  for (const [a, b] of [...open, [spine.x2, spine.x2]]) {
    if (a > from) out.push({id: 'Conveyor', x: (from + a) / 2, z: spine.z, width: a - from, depth: SPINE_HALF * 2});
    from = Math.max(from, b);
  }
  out.push({id: 'Receiving building', x: spine.x1 - BUILDING.length / 2, z: spine.z, width: BUILDING.length, depth: BUILDING.width});
  out.push({id: 'Dispatch building', x: spine.x2 + BUILDING.length / 2, z: spine.z, width: BUILDING.length, depth: BUILDING.width});
  return out;
}
// Docks sit beside the spine: north docks face north (rotation 0), south docks face south (rotation 2).
export function onSpine(spine, x, north) {
  return {x: Math.round(x / SNAP) * SNAP, z: spine.z + (north ? -DOCK_OFFSET : DOCK_OFFSET), rotation: north ? 0 : 2};
}
export const dockNorth = (spine, d) => d.z < spine.z;
function spineDocks(spine) {
  const xs = [-150, -90, -30, 30, 90, 150], docks = [];
  let inbound = 0, outbound = 0;
  for (const north of [true, false]) xs.forEach((x, i) => {
    const kind = (i + (north ? 0 : 1)) % 2 ? 'outbound' : 'inbound';
    const id = kind === 'inbound' ? `Receiving ${++inbound}` : `Dispatch ${++outbound}`;
    docks.push({id, kind, ...onSpine(spine, x, north)});
  });
  return docks;
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
