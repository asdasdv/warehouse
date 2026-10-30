// Receiving and dispatch docks: a belt with a tunnel at the far end, served by robots at the near end.
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
