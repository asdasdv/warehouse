// Grid routing around rack (and dock) footprints, inflated for the transporter's body.
// Robots drive on lanes: every 4 m line of the 2 m grid is a one-way lane, neighbouring lanes run
// in opposite directions (like a road with two carriageways). Off-lane steps are allowed but cost more,
// so they are only used for the last metres to a rack face or where an aisle has no lane.
const STEP = 2, MARGIN = 1.8, LANE = 4;
// Integer costs (per 2 m step) so the search can use a bucket queue.
const FORWARD = 5, BACKWARD = 30, OFF_LANE = 15, TURN = 10, OFF_NETWORK = 2, BUCKETS = 128;
const mod = (a, n) => ((a % n) + n) % n;
// Direction of travel on a lane: +1 / -1 along the axis, 0 when the line is not a lane.
export const laneDir = v => mod(v, LANE) ? 0 : mod(v / LANE, 2) ? -1 : 1;

export function createRouter(racks, obstacles = []) {
  const all = [...racks, ...obstacles];
  const minX = Math.floor((Math.min(0, ...all.map(r => r.x - r.width / 2)) - 20) / LANE) * LANE;
  const minZ = Math.floor((Math.min(0, ...all.map(r => r.z - r.depth / 2)) - 20) / LANE) * LANE;
  const maxX = Math.max(0, ...all.map(r => r.x + r.width / 2)) + 20, maxZ = Math.max(0, ...all.map(r => r.z + r.depth / 2)) + 35;
  const w = Math.ceil((maxX - minX) / STEP) + 1, h = Math.ceil((maxZ - minZ) / STEP) + 1, N = w * h, blocked = new Uint8Array(N);
  for (const r of all) {
    const x0 = Math.max(0, Math.ceil((r.x - r.width / 2 - MARGIN - minX) / STEP)), x1 = Math.min(w - 1, Math.floor((r.x + r.width / 2 + MARGIN - minX) / STEP));
    const z0 = Math.max(0, Math.ceil((r.z - r.depth / 2 - MARGIN - minZ) / STEP)), z1 = Math.min(h - 1, Math.floor((r.z + r.depth / 2 + MARGIN - minZ) / STEP));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) blocked[z * w + x] = 1;
  }
  const point = i => ({x: minX + (i % w) * STEP, z: minZ + Math.floor(i / w) * STEP});
  function nearest(p) {
    const x = Math.round((p.x - minX) / STEP), z = Math.round((p.z - minZ) / STEP);
    for (let d = 0; d < 5; d++) {
      let best = -1, bestD = Infinity;
      for (let dz = -d; dz <= d; dz++) for (let dx = -d; dx <= d; dx++) {
        const a = x + dx, b = z + dz;
        if (a < 0 || a >= w || b < 0 || b >= h || blocked[b * w + a]) continue;
        const q = point(b * w + a), dd = Math.hypot(q.x - p.x, q.z - p.z);
        if (dd < bestD) { bestD = dd; best = b * w + a; }
      }
      if (best >= 0) return best;
    }
    return -1;
  }
  // Neighbours in direction order: 0 +x, 1 -x, 2 +z, 3 -z.
  const neighbour = (i, d) => d === 0 ? (i % w < w - 1 ? i + 1 : -1) : d === 1 ? (i % w ? i - 1 : -1) : d === 2 ? (i + w < N ? i + w : -1) : (i >= w ? i - w : -1);
  let network = null;
  function edgeCost(i, n, d) {
    const p = point(i), along = d < 2 ? laneDir(p.z) : laneDir(p.x), sign = d % 2 ? -1 : 1;
    const c = !along ? OFF_LANE : along === sign ? FORWARD : BACKWARD;
    return network && !network.has(i * N + n) ? Math.round(c * OFF_NETWORK) : c;
  }

  // Search over (node, heading) so turns cost extra and paths stay straight; Dial's bucket queue.
  // With a goal it is A* (Manhattan distance at the cheapest step cost). `reverse` searches the
  // reversed graph: from a goal back to every node, so one search gives all routes *into* that goal.
  const OPP = [1, 0, 3, 2];
  function search(a, goal, avoid, reverse = false) {
    const S = N * 5, dist = new Int32Array(S).fill(0x7fffffff), prev = new Int32Array(S).fill(-1);
    const g = goal >= 0 ? point(goal) : null;
    const h = goal >= 0 ? i => { const q = point(i); return FORWARD * (Math.abs(q.x - g.x) + Math.abs(q.z - g.z)) / STEP; } : () => 0;
    const buckets = Array.from({length: BUCKETS}, () => []);
    const start = a * 5 + 4; dist[start] = 0; buckets[h(a) % BUCKETS].push(start);
    let pending = 1;
    for (let c = h(a); pending; c++) {
      const bucket = buckets[c % BUCKETS];
      while (bucket.length) {
        const s = bucket.pop(); pending--;
        const i = (s / 5) | 0, from = s % 5;
        if (dist[s] + h(i) !== c) continue;
        if (i === goal) return {s, prev};
        for (let d = 0; d < 4; d++) {
          // Forward: i → n heading d. Reverse: the original edge n → i, heading d.
          const n = neighbour(i, reverse ? OPP[d] : d);
          if (n < 0 || blocked[n] || avoid?.[n] && n !== goal) continue;
          const next = n * 5 + d, cost = dist[s] + (reverse ? edgeCost(n, i, d) : edgeCost(i, n, d)) + (from < 4 && from !== d ? TURN : 0);
          if (cost < dist[next]) { dist[next] = cost; prev[next] = s; buckets[(cost + h(n)) % BUCKETS].push(next); pending++; }
        }
      }
    }
    return {s: -1, prev, dist};
  }
  const unwind = (s, prev) => { const path = []; for (; s >= 0; s = prev[s]) path.push(point((s / 5) | 0)); return path.reverse(); };
  // `avoid` lists points (other robots) whose surroundings the route must not cross.
  function route(from, to, avoid = null) {
    const a = nearest(from), b = nearest(to);
    if (a < 0 || b < 0) return null;
    if (a === b) return [point(a)];
    let mask = null;
    if (avoid?.length) {
      mask = new Uint8Array(N);
      for (const p of avoid) {
        const x0 = Math.max(0, Math.ceil((p.x - p.r - minX) / STEP)), x1 = Math.min(w - 1, Math.floor((p.x + p.r - minX) / STEP));
        const z0 = Math.max(0, Math.ceil((p.z - p.r - minZ) / STEP)), z1 = Math.min(h - 1, Math.floor((p.z + p.r - minZ) / STEP));
        for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) { const q = point(z * w + x); if (Math.hypot(q.x - p.x, q.z - p.z) < p.r) mask[z * w + x] = 1; }
      }
      mask[a] = 0;
    }
    const {s, prev} = search(a, b, mask);
    return s < 0 ? null : unwind(s, prev);
  }

  // The lane network: routes from every hub (docks) to every stop (rack faces) and back.
  // Robots prefer it; it is also what the floor markings show.
  // Hubs are laid one at a time and later routes prefer lanes already laid, so traffic
  // bundles onto a few main lanes instead of covering the floor.
  function buildNetwork(hubs, stops) {
    const hubIds = [...new Set(hubs.map(nearest).filter(i => i >= 0))];
    const ids = [...new Set([...hubIds, ...stops.map(nearest).filter(i => i >= 0)])], used = new Set();
    network = used;
    for (const a of hubIds) for (const reverse of [false, true]) {
      const {prev, dist} = search(a, -1, null, reverse);
      for (const b of ids) {
        if (b === a) continue;
        let best = -1;
        for (let d = 0; d < 5; d++) if (dist[b * 5 + d] < (best < 0 ? Infinity : dist[best])) best = b * 5 + d;
        // Forward chains run target → source (add prev → s); reverse chains already run in travel order (add s → prev).
        for (let s = best; s >= 0 && prev[s] >= 0; s = prev[s]) {
          const u = (prev[s] / 5) | 0, v = (s / 5) | 0;
          used.add(reverse ? v * N + u : u * N + v);
        }
      }
    }
    return segments();
  }
  // Network edges merged into straight runs: {x1, z1, x2, z2, dir} with dir +1/-1 along the run or 0 for two-way.
  function segments() {
    const runs = [], edges = new Map();
    for (const e of network || []) {
      const i = Math.floor(e / N), n = e % N, lo = Math.min(i, n), k = lo * N + Math.max(i, n);
      edges.set(k, (edges.get(k) || 0) | (n > i ? 1 : 2));
    }
    for (const horizontal of [true, false]) {
      const lines = new Map();
      for (const [k, bits] of edges) {
        const lo = Math.floor(k / N), hi = k % N;
        if ((hi - lo === 1) !== horizontal) continue;
        const p = point(lo), line = horizontal ? p.z : p.x;
        if (!lines.has(line)) lines.set(line, []);
        lines.get(line).push({at: horizontal ? p.x : p.z, dir: bits === 3 ? 0 : bits === 1 ? 1 : -1});
      }
      for (const [line, list] of lines) {
        list.sort((a, b) => a.at - b.at);
        let run = null;
        for (const e of list) {
          if (run && run.end === e.at && run.dir === e.dir) { run.end += STEP; continue; }
          if (run) runs.push(run);
          run = {line, start: e.at, end: e.at + STEP, dir: e.dir, horizontal};
        }
        if (run) runs.push(run);
      }
    }
    return runs.map(r => r.horizontal ? {x1: r.start, z1: r.line, x2: r.end, z2: r.line, dir: r.dir} : {x1: r.line, z1: r.start, x2: r.line, z2: r.end, dir: r.dir});
  }
  // Free spots beside the network (a robot there never blocks a lane), spread round the `near` points.
  function parking(count, near, keepAway = []) {
    if (!network) return [];
    const nears = [].concat(near), onNet = new Uint8Array(N);
    for (const e of network) { onNet[Math.floor(e / N)] = 1; onNet[e % N] = 1; }
    const netPoints = [], candidates = [];
    for (let i = 0; i < N; i++) if (onNet[i]) netPoints.push(point(i));
    const cell = new Map(), key = (x, z) => Math.floor(x / 8) + ',' + Math.floor(z / 8);
    for (const q of netPoints) { const k = key(q.x, q.z); if (!cell.has(k)) cell.set(k, []); cell.get(k).push(q); }
    for (let i = 0; i < N; i++) {
      if (blocked[i] || onNet[i]) continue;
      const p = point(i);
      if (keepAway.some(q => Math.hypot(q.x - p.x, q.z - p.z) < 8)) continue;
      let gap = Infinity;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++)
        for (const q of cell.get(key(p.x + dx * 8, p.z + dz * 8)) || []) gap = Math.min(gap, Math.hypot(q.x - p.x, q.z - p.z));
      if (gap >= 4 && gap <= 6) candidates.push(p);
    }
    const lists = nears.map(n => candidates.map(c => ({...c, d: Math.hypot(c.x - n.x, c.z - n.z)})).sort((a, b) => a.d - b.d)), spots = [];
    const free = c => spots.every(s => Math.hypot(s.x - c.x, s.z - c.z) >= 4);
    for (let round = 0; spots.length < count && round < count; round++)
      for (const list of lists) { const c = list.find(free); if (c && spots.length < count) spots.push({x: c.x, z: c.z}); }
    return spots;
  }

  function reachableFrom(origin) {
    const seen = new Uint8Array(N), q = new Int32Array(N); let start = nearest(origin), head = 0, tail = 0;
    if (start >= 0) { q[tail++] = start; seen[start] = 1; }
    while (head < tail) { const i = q[head++]; for (let d = 0; d < 4; d++) { const n = neighbour(i, d); if (n >= 0 && !blocked[n] && !seen[n]) { seen[n] = 1; q[tail++] = n; } } }
    const inside = (x, z) => all.some(r => Math.abs(x - r.x) <= r.width / 2 + MARGIN && Math.abs(z - r.z) <= r.depth / 2 + MARGIN);
    return p => {
      if (inside(p.x, p.z)) return false;
      const x = Math.round((p.x - minX) / STEP), z = Math.round((p.z - minZ) / STEP);
      if (x < 0 || x >= w || z < 0 || z >= h || !seen[z * w + x]) return false;
      const cell = point(z * w + x);
      for (let t = 0; t <= 1; t += .1) if (inside(p.x + (cell.x - p.x) * t, p.z + (cell.z - p.z) * t)) return false;
      return true;
    };
  }
  const port = r => { const t = (r.rotation || 0) % 4; return t === 1 ? {x: r.x - r.width / 2 - 3, z: r.z} : t === 2 ? {x: r.x, z: r.z - r.depth / 2 - 3} : t === 3 ? {x: r.x + r.width / 2 + 3, z: r.z} : {x: r.x, z: r.z + r.depth / 2 + 3}; };
  return {route, reachableFrom, port, buildNetwork, parking, point: p => { const i = nearest(p); return i < 0 ? null : point(i); }, blocked};
}
