// Receiving and dispatch docks: a short belt served by robots at the near end. With conveyors
// (`state.spine`) the far end joins the receiving line or climbs to the dispatch line; without them it ends in a tunnel.
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

// ---------- conveyors: receiving line below, dispatch line above ----------
// `state.spine` = {x1, x2, crossings, docks: [{x, kind, north}]}. Two conveyors share the middle of the
// building along z = 0, one above the other, like a two-level distribution centre:
// - the receiving line (floor level, BELT_TOP) runs east from the receiving building (west of x1) to just past
//   the last receiving dock; boxes turn off it onto their dock's belt;
// - the dispatch line (overhead, UPPER) runs east from the first dispatch dock into the dispatch building
//   (east of x2); dispatch docks lift boxes up to it on an incline.
// Docks of both kinds sit on both sides. At each crossing the receiving line climbs onto a bridge so robots can
// drive under both lines.
export const BELT_HALF = 1.1;      // half width of one belt
export const UPPER = 7.5;          // dispatch line belt height
export const BRIDGE_LIFT = 3.6, BRIDGE_HALF = 5, RAMP = 8;
export const BUILDING = {length: 14, width: 12, height: 11};
export const INCLINE = 10;         // horizontal run of a dispatch dock's incline up to the dispatch line
const LINE_CLEAR = BELT_HALF + .2; // a dock's belt ends this far from the line axis
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
// Where each line starts and ends, from the docks that use it.
export function lineSpan(spine, docks) {
  const xs = kind => docks.filter(d => d.kind === kind).map(d => d.x);
  const recv = xs('inbound'), disp = xs('outbound');
  return {recvEnd: recv.length ? Math.max(...recv) + 8 : spine.x1 + 20, dispStart: disp.length ? Math.min(...disp) - 8 : spine.x2 - 20};
}
// What robots cannot drive through: the conveyors (except under the bridges) and the two buildings.
export function spineRects(spine) {
  if (!spine) return [];
  const half = BELT_HALF + .6, open = (spine.crossings || []).map(c => [c - BRIDGE_HALF, c + BRIDGE_HALF]).sort((a, b) => a[0] - b[0]), out = [];
  let from = spine.x1;
  for (const [a, b] of [...open, [spine.x2, spine.x2]]) {
    if (a > from) out.push({id: 'Conveyor', x: (from + a) / 2, z: 0, width: a - from, depth: half * 2});
    from = Math.max(from, b);
  }
  out.push({id: 'Receiving building', x: spine.x1 - BUILDING.length / 2, z: 0, width: BUILDING.length, depth: BUILDING.width});
  out.push({id: 'Dispatch building', x: spine.x2 + BUILDING.length / 2, z: 0, width: BUILDING.length, depth: BUILDING.width});
  return out;
}
// A dock beside the conveyors: north docks face north (rotation 0), south docks face south (rotation 2).
// Receiving docks end at the receiving line; dispatch docks sit further out to leave room for the incline.
export function onSpine(spine, x, kind, north) {
  const reach = TAIL + (kind === 'outbound' ? INCLINE : 0), z = Math.round((LINE_CLEAR + reach) / SNAP) * SNAP;
  return {x: Math.round(x / SNAP) * SNAP, z: north ? -z : z, rotation: north ? 0 : 2, line: true};
}
export const dockNorth = (spine, d) => d.z < 0;
// How far the dock's belt (and incline) reaches from its origin, along station-local z.
export const dockReach = d => d.line ? Math.abs(d.z) - LINE_CLEAR : TAIL;
function spineDocks(spine) {
  const counts = {inbound: 0, outbound: 0};
  return (spine.docks || []).map(({x, kind, north}) => ({id: `${kind === 'inbound' ? 'Receiving' : 'Dispatch'} ${++counts[kind]}`, kind, ...onSpine(spine, x, kind, north)}));
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
  const a = toWorld(d, -HALF_WIDTH, BELT_START), b = toWorld(d, HALF_WIDTH, dockReach(d));
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

// ---------- charging depots ----------
// Two depots at the sides of the building (west, north of the conveyors; east, south of them), away from the
// busy middle. Each is rows of charging bays along short aisles; robots charge there and the reserve waits there.
export const DEPOT = {aisles: 4, bays: 8, step: 4, aisleGap: 12};
export function chargingDepots(s) {
  const zones = s.zones || [];
  if (!zones.length) return [];
  const minX = Math.min(...zones.map(z => z.x)), maxX = Math.max(...zones.map(z => z.x + z.w));
  const w = DEPOT.bays * DEPOT.step, d = DEPOT.aisles * DEPOT.aisleGap, edge = s.spine ? Math.max(s.spine.x2 - maxX, minX - s.spine.x1) + BUILDING.length + 6 : 12;
  const at = (x0, z0, id) => {
    const bays = [], aisles = [];
    for (let k = 0; k < DEPOT.aisles; k++) {
      const z = z0 + DEPOT.aisleGap / 2 + k * DEPOT.aisleGap;
      aisles.push({x1: x0, x2: x0 + w, z});
      for (const side of [-1, 1]) for (let i = 0; i < DEPOT.bays; i++) bays.push({x: x0 + DEPOT.step / 2 + i * DEPOT.step, z: z + side * 4, face: side});
    }
    return {id, x: x0, z: z0, w, d, bays, aisles};
  };
  // Aligned to the 4 m lane grid: aisles lie on lanes (z ≡ 0 mod 4) and the posts sit between lanes
  // (x ≡ 2, z ≡ ±2.1), so robots driving the lanes pass between the posts, never through them.
  return [at(Math.floor((minX - edge - w) / 4) * 4, -26 - d, 'Charging west'), at(Math.ceil((maxX + edge) / 4) * 4, 26, 'Charging east')];
}
// Points along the depot aisles, for the lane network.
export const depotStops = depots => depots.flatMap(d => d.aisles.flatMap(a => [a.x1 - 6, (a.x1 + a.x2) / 2, a.x2 + 6].map(x => ({x, z: a.z}))));

// Everything robots must drive around: docks plus the spine and its buildings.
export const layoutObstacles = s => [...docksOf(s).map(dockRect), ...spineRects(s.spine)];
// Charging posts stand 2.1 m behind each bay's stop (see drawDepots).
export const POST = {back: 2.1, width: 1.1, depth: .35};
export const depotPosts = depots => depots.flatMap(d => d.bays.map(b => ({x: b.x, z: b.z + b.face * POST.back, width: POST.width, depth: POST.depth})));

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
