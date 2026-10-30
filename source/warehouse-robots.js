import * as T from 'three';
import {locations, boxLayout, CELL_CAPACITY} from './storage.js';
import {products as catalog} from './model.js';
import {createOrderBook} from './order-book.js';
import {createRouter} from './robot-routing.js';
import {loadModel, fitted} from './warehouse-models.js';
import {BELT_TOP, BELT_START, BELT_END, BELT_HALF, BRIDGE_LIFT, BRIDGE_HALF, BUILDING, docksOf, dockPort, layoutObstacles, spineLift, spineBreaks, loopPath, outStart} from './docks.js';

// The simulation owns the inventory: robots change `state.boxes` directly.
// Boxes on shelves live in `state.boxes`; boxes at a dock or on a robot live in `held`.
// Nothing is saved — a reload starts the demo again.

const ROBOTS = 40;
const MIN_ACTIVE = 16;
const STATION_CAPACITY = 6;
const MAX_PER_ADDRESS = CELL_CAPACITY;
const HANDOFF_SECONDS = 1.5; // the robot stands still this long after a box swaps on or off it
// Driving: robots follow the lane grid, turn on the spot and keep a robot's length between each other.
const SPEED = 5, ACCEL = 3, TURN_RATE = 2.4; // m/s, m/s², rad/s
const CLEAR = 3.9;           // no two robots hold grid points closer than this (body length + a gap)
const PARK_AFTER = 2;        // seconds without work before a robot heads to its parking spot
// Each dock is a belt running away from the robot port (+z, station-local); see docks.js.
const CONVEYOR_SCALE = BELT_TOP / .65; // conveyor.glb belt top is 0.65 m
const ROBOT_SCALE = BELT_TOP / .665; // robot.glb deck height 0.665 m
const BELT_SPEED = 2.5;
const SPINE_SPEED = 6;       // main conveyors: fast enough to keep up, slow enough to stop at a transfer
const TRANSFER_SECONDS = .8; // a pop-up transfer pushes a box sideways between a main belt and a dock belt
const AGE_METRES = 60;       // outbound picking: one day older is worth this many metres of extra driving
// conveyor.glb: scanner portal 1.35 m from the hand-off end; lights hold their flash this long.
const SCANNER_Z = BELT_START + 1.35 * BELT_TOP / .65, FLASH = 1.2;
// Demand is tuned for the 24-zone spine warehouse (~40 robots); arrivals and orders come every few seconds.
const ARRIVAL_EVERY = {low: 1.8, normal: 2.6, high: 4.5}, ORDER_EVERY = 2.2, PENDING = {low: 15, normal: 30, high: 50};
const HISTORY_LIMIT = 300;
const KEEP_COMPLETED_ORDERS = 20;

const addressKey = (rack, loc) => rack + '|' + loc;
const pick = list => list[Math.floor(Math.random() * list.length)];

export function addWarehouseRobots(scene, getState) {
  const group = new T.Group();
  scene.add(group);

  const robots = [], stations = [], events = [], hits = [];
  const book = createOrderBook();
  const transfers = []; // user moves: {id, rack, loc, status}
  const backlog = [];   // arrivals waiting for dock space: {product, target}
  let receiptSeq = 0;
  const held = new Map();     // box id -> {box, where: receiving|transit|dispatch, place}
  const reserved = new Set(); // shelf boxes promised to a robot
  const claims = new Map();   // address -> {product, count} for boxes on their way
  const finished = [];        // user tasks completed since the UI last looked: {kind, box, place, robot}

  const targetStock = getState().boxes.length;
  let router = null, rackKey = null, anchor = {x: 0, z: 0};
  let suspended = false, selected = null;
  let revision = 0, cargoDirty = true, serial = 0;
  let stored = 0, shipped = 0, delivered = 0;
  let layoutClock = 1, arrivalClock = 0, orderClock = 4, balanceClock = 2;

  // ---------- events and history ----------
  function note(text) { events.unshift(text); events.splice(30); }
  function history(type, box, from, to) {
    const s = getState();
    s.history.unshift({type, box: box.id, product: box.product, from, to,
      detail: `${box.id} · ${box.product} · ${from} → ${to}`, time: new Date().toISOString()});
    if (s.history.length > HISTORY_LIMIT) s.history.length = HISTORY_LIMIT;
    if (type === 'Put away') s.today.putAway = (s.today.putAway || 0) + 1;
    if (type === 'Moved') s.today.moved = (s.today.moved || 0) + 1;
    revision++;
  }
  function countFlow(rack, way) { const f = getState().flow; if (f) (f[rack] ||= {in: 0, out: 0})[way]++; }
  function inventoryChanged(rackId) { revision++; cargoDirty = true; dirtyRacks.add(rackId); }

  // ---------- shelf poses (one layout for the whole scene, rebuilt per changed rack) ----------
  let poses = [], poseById = new Map(), posesDirty = true;
  const rackPoses = new Map(), dirtyRacks = new Set();
  function refreshPoses() {
    if (!posesDirty && !dirtyRacks.size) return;
    const s = getState();
    if (posesDirty) { rackPoses.clear(); for (const r of s.racks) dirtyRacks.add(r.id); }
    const racks = new Map(s.racks.map(r => [r.id, r])), byRack = new Map([...dirtyRacks].map(id => [id, []]));
    for (const b of s.boxes) byRack.get(b.rack)?.push(b);
    for (const id of dirtyRacks) {
      for (const p of rackPoses.get(id) || []) if (poseById.get(p.box.id) === p) poseById.delete(p.box.id);
      const r = racks.get(id);
      if (!r) { rackPoses.delete(id); continue; }
      const list = boxLayout(r, byRack.get(id));
      rackPoses.set(id, list);
      for (const p of list) poseById.set(p.box.id, p);
    }
    if (posesDirty) for (const id of [...poseById.keys()]) if (!racks.has(poseById.get(id).box.rack)) poseById.delete(id);
    poses = s.racks.flatMap(r => rackPoses.get(r.id) || []);
    posesDirty = false; dirtyRacks.clear();
  }
  const poseOf = id => { refreshPoses(); return poseById.get(id); };

  // ---------- address occupancy (kept up to date as robots pick and drop) ----------
  let addressMap = null;
  function addresses() {
    if (!addressMap) {
      addressMap = new Map();
      for (const b of getState().boxes) addressAdd(b);
    }
    return addressMap;
  }
  function addressAdd(b) {
    const k = addressKey(b.rack, b.location), a = addressMap.get(k);
    if (a) a.count++; else addressMap.set(k, {product: b.product, count: 1});
  }
  function addressRemove(b) {
    const k = addressKey(b.rack, b.location), a = addressMap?.get(k);
    if (a && --a.count <= 0) addressMap.delete(k);
  }
  function load(rack, loc) {
    const k = addressKey(rack.id, loc);
    return {here: addresses().get(k), coming: claims.get(k)};
  }
  function fits(rack, loc, product) {
    const {here, coming} = load(rack, loc);
    if (here && here.product !== product || coming && coming.product !== product) return false;
    return (here?.count || 0) + (coming?.count || 0) < MAX_PER_ADDRESS;
  }
  // Same component first (fewest boxes), otherwise an empty address. Starts at a random rack to spread work.
  function place(box, want = null, strict = false) {
    const s = getState();
    if (want?.rack) {
      const r = s.racks.find(r => r.id === want.rack);
      if (r) {
        const loc = want.loc && locations(r).includes(want.loc) && fits(r, want.loc, box.product)
          ? want.loc : locations(r).find(l => fits(r, l, box.product));
        if (loc && (!strict || !want.loc || loc === want.loc)) return {rack: r, loc};
      }
      if (strict) return null;
    }
    let best = null, score = Infinity;
    const racks = s.racks;
    const start = Math.floor(Math.random() * Math.max(1, racks.length));
    for (let i = 0; i < racks.length && score > 1; i++) {
      const r = racks[(start + i) % racks.length];
      for (const loc of locations(r)) {
        if (!fits(r, loc, box.product)) continue;
        const {here, coming} = load(r, loc), n = (here?.count || 0) + (coming?.count || 0);
        const value = n ? n : MAX_PER_ADDRESS / 2;
        if (value < score) { score = value; best = {rack: r, loc}; }
      }
    }
    return best;
  }
  function claim(rack, loc, product) {
    const k = addressKey(rack.id, loc), c = claims.get(k);
    if (c) c.count++; else claims.set(k, {product, count: 1});
  }
  function unclaim(rack, loc) {
    const k = addressKey(rack.id, loc), c = claims.get(k);
    if (c && --c.count <= 0) claims.delete(k);
  }
  function shelfDrop(rack, loc, box, size) {
    const s = getState(), {coming} = load(rack, loc);
    const list = s.boxes.filter(b => b.rack === rack.id && b.location === loc);
    for (let i = 0; i < (coming?.count || 0); i++) list.push({...box, id: 'claim-' + i, location: loc});
    list.push({...box, location: loc});
    const p = boxLayout(rack, list).at(-1);
    if (size) { p.y = p.y - p.h / 2 + size.h / 2; p.w = size.w; p.h = size.h; p.d = size.d; }
    return p;
  }

  // ---------- 3D helpers ----------
  const geo = new T.BoxGeometry(1, 1, 1);
  const yellow = new T.MeshStandardMaterial({color: '#f1cf22', roughness: .55}), black = new T.MeshStandardMaterial({color: '#313b3d'});
  const silver = new T.MeshStandardMaterial({color: '#a6b1af'}), boxMat = new T.MeshStandardMaterial({color: '#c39157', roughness: .95});
  const green = new T.MeshBasicMaterial({color: '#66cdb0'});
  function box(parent, x, y, z, w, h, d, material) {
    const m = new T.Mesh(geo, material);
    m.position.set(x, y, z); m.scale.set(w, h, d); m.castShadow = true; m.receiveShadow = true;
    parent.add(m); return m;
  }
  // A box on a robot or a belt: a unit carton scaled to the box size, so `scale` keeps working like a plain cube.
  let cartonModel = null;
  function cartonContent() {
    if (cartonModel) { const m = cartonModel.clone(true); m.position.y -= .5; return m; }
    const c = new T.Group(); box(c, 0, 0, 0, 1, 1, 1, boxMat); box(c, 0, .51, 0, .12, .02, 1.01, silver); return c;
  }
  function carton(parent, x, y, z, w, h, d) {
    const c = new T.Group(); c.add(cartonContent());
    c.position.set(x, y, z); c.scale.set(w, h, d); parent.add(c); return c;
  }
  function label(parent, text, x, y, z) {
    const c = document.createElement('canvas'); c.width = 512; c.height = 96;
    const t = c.getContext('2d');
    t.font = '500 40px Inter, Arial, sans-serif'; t.textAlign = 'center';
    const w = Math.min(500, (t.measureText?.(text).width ?? 200) + 56);
    t.fillStyle = 'rgba(255,255,255,.88)'; t.beginPath?.(); t.roundRect?.(256 - w / 2, 14, w, 68, 34); t.fill?.();
    t.fillStyle = '#4a5058'; t.fillText(text, 256, 62);
    const tex = new T.CanvasTexture(c); tex.colorSpace = T.SRGBColorSpace;
    const sp = new T.Sprite(new T.SpriteMaterial({map: tex, depthTest: true, transparent: true, toneMapped: false}));
    sp.scale.set(5.5, 1.05, 1); sp.position.set(x, y, z); parent.add(sp); return sp;
  }

  for (let i = 0; i < ROBOTS; i++) {
    const g = new T.Group(), id = `AMR-${String(i + 1).padStart(2, '0')}`;
    const body = new T.Group();
    group.add(g); g.add(body);
    box(body, 0, .7, 0, 2.6, 1.1, 3.4, yellow); box(body, 0, 1.35, 0, 2.3, .22, 2.8, black);
    for (const x of [-1.2, 1.2]) for (const z of [-1, 1]) box(body, x, .35, z, .35, .65, .8, black);
    box(body, 0, 1.58, 1.35, .6, .25, .35, green); box(body, 0, 3, -1.1, .25, 5.2, .3, silver);
    const cargo = carton(g, 0, 2.1, 0, 1.7, 1.3, 1.9); cargo.visible = false;
    label(g, id, 0, 4, 0);
    const hit = box(g, 0, 1.7, 0, 3.1, 3.5, 3.8, new T.MeshBasicMaterial({visible: false}));
    hit.userData = {type: 'robot', id}; hits.push(hit);
    robots.push({id, g, body, cargo, active: i < MIN_ACTIVE, status: 'Idle', battery: 92 - (i * 7) % 55, paused: false, chargeNext: false,
      charging: false, cycles: 0, task: null, path: [], index: 0, retry: i * .3, product: '', boxId: '', mission: '',
      at: null, ahead: [], speed: 0, wait: 0, idle: 0, home: null});
  }
  // Belt surface: a striped texture that scrolls with the belt.
  function beltTexture() {
    const c = document.createElement('canvas'); c.width = 16; c.height = 64;
    const t = c.getContext('2d');
    t.fillStyle = '#4b5459'; t.fillRect(0, 0, 16, 64); t.fillStyle = '#626c71'; t.fillRect(0, 0, 16, 10);
    const tex = new T.CanvasTexture(c);
    tex.wrapS = tex.wrapT = T.RepeatWrapping; tex.repeat.set(1, (BELT_END - BELT_START + 1) / 1.2);
    return tex;
  }
  const frameMat = new T.MeshStandardMaterial({color: '#aab2b8', roughness: .45, metalness: .35});
  const tunnelMat = new T.MeshStandardMaterial({color: '#e9ecef', roughness: .8});
  for (const {id, kind} of docksOf(getState())) {
    const g = new T.Group(), body = new T.Group();
    group.add(g); g.add(body);
    const length = BELT_END - BELT_START + 1, mid = (BELT_END + BELT_START) / 2;
    const tex = beltTexture();
    box(body, 0, BELT_TOP - .06, mid, 2.2, .12, length, new T.MeshStandardMaterial({map: tex, roughness: .9}));
    for (const x of [-1.25, 1.25]) {
      box(body, x, BELT_TOP - .05, mid, .3, .4, length, frameMat);
      for (let z = BELT_START; z <= BELT_END; z += 3) box(body, x, (BELT_TOP - .25) / 2, z, .25, BELT_TOP - .25, .25, frameMat);
    }
    // Without a spine a tunnel hides boxes as they leave (dispatch) or before they appear (receiving).
    if (!getState().spine) {
      box(body, -1.7, 2, BELT_END - .5, .4, 4, 3, tunnelMat); box(body, 1.7, 2, BELT_END - .5, .4, 4, 3, tunnelMat);
      box(body, 0, 3.8, BELT_END - .5, 3.8, .4, 3, tunnelMat); box(body, 0, 2, BELT_END + 1, 3.8, 4, .2, tunnelMat);
    }
    label(g, id, 0, 4.9, BELT_START + 2).scale.set(9, 1.5, 1);
    stations.push({g, body, id, kind, ready: true, queue: [], port: {x: 0, z: 0}, tex});
  }
  // Blender models replace the simple shapes once they load (see public/assets/models/README.md).
  loadModel('robot').then(model => {
    if (!model) return;
    for (const r of robots) {
      r.body.clear();
      const m = model.clone(true); m.scale.setScalar(ROBOT_SCALE); r.body.add(m);
      // Each robot drives its own LEDs: front/rear show what it is doing, the sides are turn signals.
      // The model faces +z; facing that way +x is the robot's left.
      const leds = {main: null, left: null, right: null};
      m.traverse(o => {
        if (!o.isMesh || !/LED/.test(o.name)) return;
        const key = /front.rear/.test(o.name) ? 'main' : o.position.x > 0 ? 'left' : 'right';
        leds[key] ||= o.material.clone();
        o.material = leds[key];
      });
      r.leds = leds.main ? leds : null;
    }
  });
  loadModel('conveyor').then(model => {
    if (!model) return;
    for (const st of stations) {
      st.body.clear();
      const m = model.clone(true); m.scale.setScalar(CONVEYOR_SCALE);
      m.rotation.y = -Math.PI / 2; m.position.z = BELT_START; // the model runs along +x from the hand-off end
      st.body.add(m);
      // The scanner strip and the portal light flash as boxes pass; the rollers turn with the belt.
      // (GLTFLoader turns spaces in node names into underscores.)
      st.rollers = [];
      m.traverse(o => {
        if (!o.isMesh) return;
        if (/^Status.strip$/.test(o.name)) o.material = st.scanMat = o.material.clone();
        if (/^Portal.status$/.test(o.name)) o.material = st.portalMat = o.material.clone();
        if (o.name.startsWith('Roller')) st.rollers.push(o);
        // On conveyors the dock belt ends at a transfer, not in the model's dispatch tunnel.
        if (getState().spine && /^Dispatch_(rear|side|roof)/.test(o.name)) o.visible = false;
        // Calm palette: the model's dark blue-grey frame becomes light metal like the racks.
        if (/blue grey frame/.test(o.material.name)) o.material.color.set('#a4adb4');
      });
    }
  });
  loadModel('box').then(model => {
    if (!model) return;
    cartonModel = fitted(model, {w: 1, h: 1, d: 1});
    for (const r of robots) { r.cargo.clear(); r.cargo.add(cartonContent()); }
  });
  const pickupMarker = new T.Mesh(geo, new T.MeshBasicMaterial({color: '#ffd900', wireframe: true, depthTest: false}));
  const dropMarker = new T.Mesh(geo, new T.MeshBasicMaterial({color: '#6c9ee8', wireframe: true, depthTest: false}));
  pickupMarker.renderOrder = dropMarker.renderOrder = 15;
  const routeLine = new T.Line(new T.BufferGeometry(), new T.LineBasicMaterial({color: '#baa51a', transparent: true, opacity: .6}));
  group.add(pickupMarker, dropMarker, routeLine);

  // ---------- conveyors: receiving loop and dispatch line ----------
  // Boxes leave the receiving building onto the loop and circulate until their dock has room; dispatch
  // docks push boxes onto the dispatch line, which carries them into the dispatch building. Both climb
  // onto bridges where robots cross underneath (see docks.js).
  const spineGroup = new T.Group(), spineItems = new T.Group(); group.add(spineGroup, spineItems);
  const spineTextures = [], yellowMat = new T.MeshStandardMaterial({color: '#e9c84a', roughness: .6});
  const beltMat = new T.MeshStandardMaterial({color: '#555e63', roughness: .9});
  let spine = null, spineKey = null, loop = null;
  function spineTexture(length, dir) {
    const c = document.createElement('canvas'); c.width = 64; c.height = 16;
    const t = c.getContext('2d');
    t.fillStyle = '#4b5459'; t.fillRect(0, 0, 64, 16); t.fillStyle = '#626c71'; t.fillRect(0, 0, 10, 16);
    const tex = new T.CanvasTexture(c);
    tex.wrapS = tex.wrapT = T.RepeatWrapping; tex.repeat.set(length / 1.2, 1); spineTextures.push({tex, dir});
    return tex;
  }
  function piece(x0, x1, y0, y1, z, height, depth, material) {
    const len = Math.hypot(x1 - x0, y1 - y0), m = box(spineGroup, (x0 + x1) / 2, (y0 + y1) / 2, z, len, height, depth, material);
    m.rotation.z = Math.atan2(y1 - y0, x1 - x0); return m;
  }
  // A straight belt along x at z, following the bridge profile, with rails and legs.
  function straightBelt(sp, from, to, z, dir, legs) {
    const xs = spineBreaks(sp, from, to), y = x => BELT_TOP + spineLift(sp, x);
    for (let i = 1; i < xs.length; i++) {
      const a = xs[i - 1], b = xs[i];
      piece(a, b, y(a) - .06, y(b) - .06, z, .12, BELT_HALF * 2, new T.MeshStandardMaterial({map: spineTexture(b - a, dir), roughness: .9}));
      for (const rail of [-1.25, 1.25]) piece(a, b, y(a) - .05, y(b) - .05, z + rail, .4, .3, frameMat);
    }
    for (let x = from + 1; x < to; x += 4) {
      if ((sp.crossings || []).some(c => Math.abs(x - c) < BRIDGE_HALF + .5)) continue;
      for (const side of [-1, 1]) legs.push({x, z: z + side * 1.25, h: y(x) - .25});
    }
  }
  // A half circle joining the loop legs, drawn as short flat pieces.
  function loopEnd(cx, mid, R, east) {
    const n = 14, k = (R + 1.25) / R;
    for (let i = 0; i < n; i++) {
      const p = t => ({x: cx + (east ? 1 : -1) * R * Math.sin(t), z: mid - R * Math.cos(t)});
      const a = p(Math.PI * i / n), b = p(Math.PI * (i + 1) / n), len = Math.hypot(b.x - a.x, b.z - a.z), angle = -Math.atan2(b.z - a.z, b.x - a.x);
      box(spineGroup, (a.x + b.x) / 2, BELT_TOP - .06, (a.z + b.z) / 2, len + .05, .12, BELT_HALF * 2, beltMat).rotation.y = angle;
      const ox = (a.x + b.x) / 2 - cx, oz = (a.z + b.z) / 2 - mid;
      box(spineGroup, cx + ox * k, BELT_TOP - .05, mid + oz * k, len * k + .05, .4, .3, frameMat).rotation.y = angle;
    }
  }
  function drawSpine(sp) {
    spineGroup.traverse(o => { if (o.isMesh && o.material?.map) o.material.map.dispose(); });
    spineGroup.clear(); spineTextures.length = 0;
    loop = sp ? loopPath(sp) : null;
    if (!sp) return;
    const {north: N, south: S} = sp.loop, legs = [];
    straightBelt(sp, sp.x1, loop.xa, N, 1, legs);           // infeed from the receiving building
    straightBelt(sp, loop.xa, loop.xb, N, 1, legs);         // loop, north leg: east
    straightBelt(sp, loop.xa, loop.xb, S, -1, legs);        // loop, south leg: back west
    loopEnd(loop.xb, loop.mid, loop.R, true); loopEnd(loop.xa, loop.mid, loop.R, false);
    straightBelt(sp, outStart(sp), sp.x2, sp.out, 1, legs); // dispatch line: east into the dispatch building
    box(spineGroup, outStart(sp) - .2, BELT_TOP - .1, sp.out, .4, .5, BELT_HALF * 2 + .6, frameMat);
    // Bridges: portal posts at each end and a yellow beam over the robot passage.
    const top = Math.min(N, sp.out) - 1.6, bottom = Math.max(S, sp.out) + 1.6;
    for (const c of sp.crossings || []) {
      box(spineGroup, c, BELT_TOP + BRIDGE_LIFT - .45, (top + bottom) / 2, BRIDGE_HALF * 2, .3, bottom - top, yellowMat);
      for (const e of [-BRIDGE_HALF, BRIDGE_HALF]) {
        box(spineGroup, c + e, BELT_TOP + BRIDGE_LIFT - .45, (top + bottom) / 2, .4, .4, bottom - top + .4, frameMat);
        for (const z of [top, bottom]) legs.push({x: c + e, z, h: BELT_TOP + BRIDGE_LIFT - .45});
      }
    }
    const legMesh = new T.InstancedMesh(geo, frameMat, legs.length), o = new T.Object3D();
    legs.forEach((l, i) => { o.position.set(l.x, l.h / 2, l.z); o.scale.set(.25, l.h, .25); o.updateMatrix(); legMesh.setMatrixAt(i, o.matrix); });
    legMesh.castShadow = true; spineGroup.add(legMesh);
    // The two buildings: boxes come out of receiving onto the loop and disappear into dispatch.
    for (const [x, z, name] of [[sp.x1 - BUILDING.length / 2, loop.mid, 'Receiving'], [sp.x2 + BUILDING.length / 2, sp.out, 'Dispatch']]) {
      building(x, z, name);
      // A doorway with a light strip over it where the belt goes through the wall.
      const face = name === 'Receiving' ? x + BUILDING.length / 2 + .05 : x - BUILDING.length / 2 - .05, door = name === 'Receiving' ? N : sp.out;
      box(spineGroup, face, BELT_TOP + 2.6, door, .1, .35, 3.4, doorMats[name === 'Receiving' ? 'receiving' : 'dispatch']);
      box(spineGroup, face, BELT_TOP + 1.1, door, .08, 2.4, 3, new T.MeshStandardMaterial({color: '#2b3133', roughness: .9}));
    }
  }
  // Pop-up transfers: where a dock belt meets a main belt, a patch of cross rollers rises out of the main
  // belt and pushes the box sideways onto the dock belt (receiving) or off it onto the main belt (dispatch).
  const transferGroup = new T.Group(); group.add(transferGroup);
  const crossRoller = new T.CylinderGeometry(.07, .07, 2.1, 10).rotateX(Math.PI / 2);
  const bridgeRoller = new T.CylinderGeometry(.07, .07, 2.2, 10).rotateZ(Math.PI / 2);
  const rollerMat = new T.MeshStandardMaterial({color: '#b8c1c4', roughness: .35, metalness: .6});
  const plateMat = new T.MeshStandardMaterial({color: '#2a3033', roughness: .8});
  function drawTransfers() {
    transferGroup.clear();
    if (!spine) return;
    for (const st of stations) {
      const z = st.kind === 'inbound' ? spine.loop.north : spine.out, g = new T.Group();
      g.position.set(st.g.position.x, 0, z); transferGroup.add(g);
      box(g, 0, BELT_TOP + .01, 0, 2.8, .02, BELT_HALF * 2, plateMat);
      for (const x of [-1.4, 1.4]) box(g, x, BELT_TOP + .02, 0, .1, .04, BELT_HALF * 2, yellowMat);
      const lift = new T.Group(); g.add(lift);
      st.crossRollers = [];
      for (let i = 0; i < 8; i++) {
        const m = new T.Mesh(crossRoller, rollerMat); m.position.set(-1.2 + i * 2.4 / 7, BELT_TOP + .02, 0); m.castShadow = true;
        lift.add(m); st.crossRollers.push(m);
      }
      st.lift = lift; st.pop = 0;
      // A few rollers bridge the end of the dock belt (where the model's tunnel was) to the main belt edge.
      const edge = Math.abs(z - st.g.position.z) - BELT_HALF, last = 7.75;
      for (let lz = last + .35; lz < edge; lz += .35) {
        const at = st.g.localToWorld(new T.Vector3(0, BELT_TOP - .07, lz)), m = new T.Mesh(bridgeRoller, rollerMat);
        m.position.copy(at); transferGroup.add(m);
      }
      for (const x of [-1.2, 1.2]) {
        const a = st.g.localToWorld(new T.Vector3(x, BELT_TOP - .15, (last + edge) / 2));
        box(transferGroup, a.x, a.y, a.z, .12, .25, edge - last, frameMat).rotation.y = st.g.rotation.y;
      }
    }
  }
  // Moves a box in a straight slide (with a small hop as the rollers rise), then calls `done`.
  function transfer(st, q, to, done) {
    const from = q.mesh.getWorldPosition(new T.Vector3());
    if (q.mesh.parent !== spineItems) { q.mesh.parent.remove(q.mesh); spineItems.add(q.mesh); q.mesh.rotation.set(0, 0, 0); }
    q.mesh.position.copy(from);
    q.move = {t: 0, from, to, done}; st.popping = TRANSFER_SECONDS; st.portalFlash = FLASH;
  }
  function stepTransfer(st, q, dt) {
    const m = q.move;
    m.t = Math.min(1, m.t + dt / TRANSFER_SECONDS);
    const k = m.t * m.t * (3 - 2 * m.t);
    q.mesh.position.lerpVectors(m.from, m.to, k); q.mesh.position.y += Math.sin(Math.PI * m.t) * .12;
    if (m.t >= 1) { q.move = null; m.done(); }
  }
  // ---------- buildings and lamps ----------
  const cladding = (() => {
    if (typeof document === 'undefined') return tunnelMat;
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const t = c.getContext('2d'); t.fillStyle = '#eef0f2'; t.fillRect(0, 0, 64, 64); t.fillStyle = '#dde1e5'; t.fillRect(0, 0, 3, 64);
    const tex = new T.CanvasTexture(c); tex.wrapS = tex.wrapT = T.RepeatWrapping; tex.repeat.set(BUILDING.length / 1.2, 1); tex.colorSpace = T.SRGBColorSpace;
    return new T.MeshStandardMaterial({map: tex, roughness: .85});
  })();
  const windowMat = new T.MeshStandardMaterial({color: '#ffd59a', emissive: '#ffbf66', emissiveIntensity: 1.4, roughness: .4});
  const panelMat = new T.MeshStandardMaterial({color: '#273449', roughness: .3, metalness: .4});
  const plinthMat = new T.MeshStandardMaterial({color: '#f1f2f4', roughness: .9});
  function building(x, z, name) {
    const {length: L, width: W, height: H} = BUILDING;
    box(spineGroup, x, .06, z, L + 3, .12, W + 3, plinthMat);
    box(spineGroup, x, H / 2, z, L, H, W, cladding);
    box(spineGroup, x, H + .25, z, L + .2, .5, W + .2, tunnelMat);                 // parapet
    box(spineGroup, x, H + .05, z, L - .6, .1, W - .6, new T.MeshStandardMaterial({color: '#d5d9de', roughness: .9}));
    for (const side of [-1, 1]) for (let wx = -L / 2 + 1.5; wx <= L / 2 - 1.5; wx += 2.2)
      box(spineGroup, x + wx, H * .62, z + side * (W / 2 + .03), 1.3, .9, .06, windowMat);
    // Solar panels on the roof, in rows tilted towards the light.
    const rows = 4, cols = 6, pw = (L - 2) / cols, pd = (W - 2) / rows;
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      const m = box(spineGroup, x - L / 2 + 1 + (i + .5) * pw, H + .45, z - W / 2 + 1 + (j + .5) * pd, pw - .15, .06, pd - .3, panelMat);
      m.rotation.x = -.18;
    }
    label(spineGroup, name, x, H + 3, z).scale.set(10, 1.9, 1);
  }
  // A street-style lamp beside each dock, with a warm pool of light on the floor.
  const lampGroup = new T.Group(); group.add(lampGroup);
  const poolTex = (() => {
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const t = c.getContext('2d'), g = t.createRadialGradient?.(64, 64, 0, 64, 64, 64);
    if (!g) return null;
    g.addColorStop(0, 'rgba(255,214,150,.42)'); g.addColorStop(.55, 'rgba(255,214,150,.12)'); g.addColorStop(1, 'rgba(255,214,150,0)');
    t.fillStyle = g; t.fillRect(0, 0, 128, 128);
    return new T.CanvasTexture(c);
  })();
  const poolMat = new T.MeshBasicMaterial({map: poolTex, transparent: true, depthWrite: false, toneMapped: false});
  const poleMat = new T.MeshStandardMaterial({color: '#c9ced3', roughness: .5, metalness: .4});
  const lampMat = new T.MeshStandardMaterial({color: '#fff3dd', emissive: '#ffcf85', emissiveIntensity: 2.5});
  const poolGeo = new T.PlaneGeometry(14, 14).rotateX(-Math.PI / 2);
  function drawLamps() {
    lampGroup.clear();
    for (const st of stations) {
      const side = st.port.x + 4.5, out = st.kind === 'inbound' ? -1 : 1;
      box(lampGroup, side, 3, st.port.z, .14, 6, .14, poleMat);
      box(lampGroup, side - .5 * out * 0, 6, st.port.z, .8, .12, .3, poleMat);
      box(lampGroup, side - .2, 5.9, st.port.z, .5, .08, .22, lampMat);
      const pool = new T.Mesh(poolGeo, poolMat); pool.position.set(st.port.x + 2, .06, st.port.z); pool.renderOrder = 2; pool.raycast = () => {};
      lampGroup.add(pool);
    }
  }
  // Where a box u metres along the receiving path is: negative u is the infeed from the building door.
  const loopPoint = u => u < 0 ? {x: loop.xa + u, z: spine.loop.north, leg: 'infeed'} : loop.at(u);
  // A dock's belt has room for one more box at its far end.
  const spurFree = (st, q) => !st.queue.some(o => o !== q && (o.move || !o.onSpine && o.arrived && o.mesh.position.z > BELT_END - (q.local.d + .4)));

  // ---------- docks ----------
  const freeSlot = st => Array.from({length: STATION_CAPACITY}, (_, i) => i).find(i => !st.queue.some(q => q.slot === i));
  function stationPose(st, q) {
    if (q.onSpine) { const p = q.mesh.position; return {...q.local, box: q.box, x: p.x, y: p.y, z: p.z}; }
    const local = q.local, p = st.g.localToWorld(new T.Vector3(local.x, local.y, q.mesh ? q.mesh.position.z : local.z));
    const turned = (st.rotation || 0) % 2;
    return {...local, box: q.box, x: p.x, z: p.z, w: turned ? local.d : local.w, d: turned ? local.w : local.d};
  }
  // Every box is handed over at the robot end of the belt; `slot` only counts dock capacity.
  function localPose(slot, size) {
    return {x: 0, y: BELT_TOP + size.h / 2, z: BELT_START, w: size.w, h: size.h, d: size.d};
  }
  function arrivalSize() {
    const rack = getState().racks[0];
    if (!rack) return {w: 1.6, h: 1.4, d: 1.8};
    const p = boxLayout(rack, Array.from({length: CELL_CAPACITY}, (_, i) => ({id: 'size-' + i, product: '', location: locations(rack)[0]})))[0];
    return {w: p.w, h: p.h, d: p.d};
  }
  function arrive(item) {
    const st = stations.filter(s => s.kind === 'inbound' && s.ready && s.queue.length < STATION_CAPACITY)
      .sort((a, b) => a.queue.length - b.queue.length)[0];
    if (!st) return false;
    const s = getState();
    const b = {id: `BX-${++s.serial}`, product: item.product, rack: 'receiving', location: st.id, receivedAt: new Date().toISOString(), doc: `inv. ${2060 + Math.floor(s.serial / 12) % 900}`};
    const slot = freeSlot(st), local = localPose(slot, arrivalSize());
    // Rides in along the spine from the receiving building, or out of the dock's tunnel.
    if (spine) doorFlash.receiving = FLASH;
    const mesh = spine ? carton(spineItems, spine.x1, local.y, spine.loop.north, local.w, local.h, local.d) : carton(st.g, local.x, local.y, BELT_END, local.w, local.h, local.d);
    const q = {box: b, slot, local, mesh, age: 0, arrived: true, atFront: false, onSpine: !!spine, u: spine ? -(loop.xa - spine.x1) : 0, target: item.target || null, user: item.user || null, taken: false};
    st.queue.push(q);
    held.set(b.id, {box: b, where: 'receiving', place: st.id});
    s.today.received++;
    history('Received', b, 'Supplier', st.id);
    return true;
  }
  function updateDocks(dt) {
    while (backlog.length && arrive(backlog[0])) backlog.shift();
    for (const st of stations) {
      if (!st.ready) continue;
      // Receiving: boxes queue up nose to tail towards the robot end. Dispatch: boxes ride off into the tunnel.
      let moving = false, ahead = BELT_START;
      for (const q of [...st.queue]) {
        if (!q.arrived) continue;
        q.age += dt;
        const p = q.mesh.position;
        if (q.onSpine) { rideSpine(st, q, dt); continue; }
        const was = p.z;
        if (st.kind === 'inbound') {
          // Keep a gap behind the box ahead; a box that would overlap waits out of sight behind the tunnel.
          const stop = ahead;
          if (p.z > stop) { p.z = Math.max(stop, p.z - dt * BELT_SPEED); moving = true; if (was > SCANNER_Z && p.z <= SCANNER_Z) st.scanFlash = FLASH; }
          else if (p.z < stop) p.z = stop;
          ahead = p.z + q.local.d + .4;
          q.mesh.visible = p.z <= BELT_END;
          q.atFront = p.z === BELT_START;
          continue;
        }
        p.z += dt * BELT_SPEED; moving = true;
        if (was < SCANNER_Z && p.z >= SCANNER_Z) st.scanFlash = FLASH;
        if (p.z >= BELT_END) {
          st.portalFlash = FLASH;
          if (spine) { p.z = BELT_END; q.onSpine = true; transfer(st, q, new T.Vector3(st.g.position.x, q.local.y + spineLift(spine, st.g.position.x), spine.out), () => {}); }
          else ship(st, q);
        }
      }
      if (moving) st.tex.offset.y += (st.kind === 'inbound' ? -1 : 1) * dt * BELT_SPEED / 1.2;
      st.moving = moving;
    }
    for (const {tex, dir} of spineTextures) tex.offset.x -= dir * dt * SPINE_SPEED / 1.2;
  }
  function ship(st, q) {
    q.mesh.parent?.remove(q.mesh); st.queue.splice(st.queue.indexOf(q), 1); held.delete(q.box.id);
    shipped++; getState().today.shipped++; book.ship(q.box.id);
    history('Shipped', q.box, st.id, 'Customer');
    pruneOrders();
    if (spine) doorFlash.dispatch = FLASH;
  }
  // Receiving: boxes go round the loop and turn onto their dock's belt as they pass it, if it has room;
  // otherwise they go round again. Dispatch: boxes ride the dispatch line into the dispatch building.
  function rideSpine(st, q, dt) {
    const p = q.mesh.position;
    if (q.move) return stepTransfer(st, q, dt);
    if (st.kind === 'outbound') {
      p.x += dt * SPINE_SPEED; p.z = spine.out; p.y = q.local.y + spineLift(spine, p.x);
      if (p.x >= spine.x2) ship(st, q);
      return;
    }
    const was = loopPoint(q.u);
    q.u += dt * SPINE_SPEED;
    if (q.u >= loop.length) q.u -= loop.length;
    const at = loopPoint(q.u), x = st.g.position.x;
    if (was.leg === 'north' && at.leg === 'north' && was.x < x && at.x >= x && spurFree(st, q)) {
      // Stop over the transfer, then slide sideways onto the dock belt.
      p.set(x, q.local.y + spineLift(spine, x), at.z);
      transfer(st, q, st.g.localToWorld(new T.Vector3(0, q.local.y, BELT_END)), () => {
        spineItems.remove(q.mesh); st.g.add(q.mesh); q.mesh.position.set(0, q.local.y, BELT_END); q.onSpine = false;
      });
      return;
    }
    p.set(at.x, q.local.y + spineLift(spine, at.x), at.z);
  }
  function pruneOrders() {
    const done = book.orders.filter(o => o.shipped.length >= o.quantity);
    for (const o of done.slice(0, Math.max(0, done.length - KEEP_COMPLETED_ORDERS))) book.orders.splice(book.orders.indexOf(o), 1);
  }

  // ---------- demand: arrivals and orders never stop ----------
  function stockedProducts() { return [...new Set([...addresses().values()].map(a => a.product))]; }
  function generateDemand(dt) {
    const stock = getState().boxes.length + held.size;
    const low = stock < targetStock * .98, high = stock > targetStock * 1.02;
    arrivalClock += dt;
    if (arrivalClock >= ARRIVAL_EVERY[low ? 'low' : high ? 'high' : 'normal']) {
      arrivalClock = 0;
      if (backlog.length < STATION_CAPACITY * stations.filter(s => s.kind === 'inbound').length) backlog.push({product: pick(catalog)});
    }
    orderClock += dt;
    if (orderClock >= ORDER_EVERY) {
      orderClock = 0;
      const stockList = stockedProducts();
      if (stockList.length && book.pending < PENDING[high ? 'high' : low ? 'low' : 'normal']) {
        const o = book.create(pick(stockList), 1 + Math.floor(Math.random() * 5), Math.random() < .15 ? 'Urgent' : 'Normal');
        note(`${o.id} · ${o.quantity} × ${o.product}${o.priority === 'Urgent' ? ' · urgent' : ''}`);
      }
    }
  }

  // ---------- layout changes ----------
  // Floor markings: lane lines with arrows on one-way runs, and a bay at each parking spot.
  const laneGroup = new T.Group(); group.add(laneGroup);
  const laneMat = new T.MeshBasicMaterial({color: '#ffffff', transparent: true, opacity: .75, depthWrite: false, toneMapped: false});
  const bayMat = new T.MeshBasicMaterial({color: '#ffffff', transparent: true, opacity: .55, depthWrite: false, toneMapped: false});
  const flat = new T.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const arrowGeo = new T.ShapeGeometry(new T.Shape([new T.Vector2(.55, 0), new T.Vector2(-.35, .45), new T.Vector2(-.35, -.45)])).rotateX(-Math.PI / 2);
  function instanced(geometry, material, items) {
    const m = new T.InstancedMesh(geometry, material, Math.max(1, items.length)), o = new T.Object3D();
    items.forEach((it, i) => { o.position.set(it.x, .05, it.z); o.rotation.set(0, it.angle || 0, 0); o.scale.set(it.sx || 1, 1, it.sz || 1); o.updateMatrix(); m.setMatrixAt(i, o.matrix); });
    m.count = items.length; m.renderOrder = 3; m.raycast = () => {};
    laneGroup.add(m);
  }
  function drawLanes(segments, spots) {
    for (const m of laneGroup.children) m.dispose();
    laneGroup.clear();
    const strips = [], arrows = [], bays = [];
    for (const g of segments) {
      const horizontal = g.z1 === g.z2, len = Math.hypot(g.x2 - g.x1, g.z2 - g.z1);
      strips.push({x: (g.x1 + g.x2) / 2, z: (g.z1 + g.z2) / 2, sx: horizontal ? len + .14 : .14, sz: horizontal ? .14 : len + .14});
      if (!g.dir) continue;
      for (let t = 4; t < len - 1; t += 8) arrows.push({x: g.x1 + (g.x2 - g.x1) * t / len, z: g.z1 + (g.z2 - g.z1) * t / len,
        angle: horizontal ? (g.dir > 0 ? 0 : Math.PI) : (g.dir > 0 ? -Math.PI / 2 : Math.PI / 2)});
    }
    for (const p of spots) for (const [dx, dz, sx, sz] of [[-1.6, 0, .16, 3.8], [1.6, 0, .16, 3.8], [0, -1.9, 3.36, .16], [0, 1.9, 3.36, .16]]) bays.push({x: p.x + dx, z: p.z + dz, sx, sz});
    instanced(flat, laneMat, strips); instanced(arrowGeo, laneMat, arrows); instanced(flat, bayMat, bays);
  }
  let routeKey = null;
  function checkLayout() {
    const s = getState(), docks = docksOf(s);
    const k = JSON.stringify(s.racks.map(r => [r.id, r.x, r.z, r.width, r.depth, r.height, r.shelves, r.places, r.rotation || 0]));
    if (k !== rackKey) { rackKey = k; posesDirty = true; cargoDirty = true; revision++; }
    // Routes are rebuilt once the layout editor closes, not on every edit while it is open.
    const rk = k + JSON.stringify(docks) + JSON.stringify(s.spine || null);
    if (rk === routeKey || suspended && routeKey !== null) return;
    const first = routeKey === null;
    routeKey = rk;
    const sk = JSON.stringify(s.spine || null);
    if (sk !== spineKey) { spineKey = sk; spine = s.spine || null; drawSpine(spine); }
    for (const st of stations) {
      const d = docks.find(d => d.id === st.id) || {x: 0, z: 0, rotation: 0};
      st.g.position.set(d.x, 0, d.z); st.g.rotation.y = -(d.rotation || 0) * Math.PI / 2; st.rotation = d.rotation || 0;
      st.g.updateMatrixWorld(true);
      st.port = dockPort(d);
    }
    router = createRouter(s.racks, layoutObstacles(s));
    const segments = router.buildNetwork(stations.map(st => st.port), s.racks.map(router.port));
    const near = {x: stations.reduce((n, st) => n + st.port.x, 0) / stations.length, z: stations.reduce((n, st) => n + st.port.z, 0) / stations.length};
    // Parking is spread along the docks so idle robots wait close to where work appears.
    const spots = router.parking(ROBOTS, stations.map(st => st.port), stations.map(st => st.port));
    robots.forEach((r, i) => { r.home = spots[i] || null; });
    drawLanes(segments, spots);
    drawTransfers();
    drawLamps();
    anchor = near;
    if (first) {
      robots.forEach((r, i) => {
        const p = r.home || router.point({x: near.x + (i - ROBOTS / 2) * 4, z: near.z - 8});
        if (p) { r.g.position.set(p.x, 0, p.z); r.at = {x: p.x, z: p.z}; r.g.rotation.y = spine && p.z > spine.out ? 0 : Math.PI; }
      });
      for (let i = 0; i < stations.length * 2; i++) backlog.push({product: pick(catalog)});
      note('Receiving and dispatch connected to the rack layout');
    } else {
      for (const r of robots) { if (r.task) replan(r); else if (r.path.length) { r.path = []; r.index = 0; } }
      note('Layout changed · routes recalculated');
    }
  }
  const isLoaded = r => r.stage === 'Transporting' || r.stage === 'Unloading' || r.stage === 'Loading' && r.timer > 0;
  function replan(r) {
    const t = r.task, s = getState(), loaded = isLoaded(r);
    if (t.source && !loaded) {
      t.source = s.racks.find(x => x.id === t.source.id);
      if (!t.source) return cancel(r);
    }
    if (t.target) {
      const rack = s.racks.find(x => x.id === t.target.id);
      unclaim(t.target, t.slot);
      const dest = rack && locations(rack).includes(t.slot) ? {rack, loc: t.slot} : place(t.box);
      if (!dest) { if (!loaded) return cancel(r); r.routeBlocked = true; return; }
      t.target = dest.rack; t.slot = dest.loc;
      t.drop = shelfDrop(dest.rack, dest.loc, t.box, t.pickup);
      claim(dest.rack, dest.loc, t.box.product);
      r.to = `${dest.rack.id} / ${dest.loc}`;
    }
    if (!loaded) t.pickup = t.source ? {...poseOf(t.box.id)} : stationPose(t.sourceStation, t.queueItem);
    if (t.output) t.drop = stationPose(t.outStation, t.output);
    route(r);
  }
  function route(r) {
    const t = r.task;
    const from = t.source ? router.port(t.source) : t.sourceStation.port, to = t.target ? router.port(t.target) : t.outStation.port;
    t.carry = router.route(from, to);
    if (r.stage === 'To pickup' || r.stage === 'Transporting') {
      setPath(r, router.route(origin(r), r.stage === 'To pickup' ? from : to) || []);
      r.routeBlocked = !r.path.length;
    }
  }
  function cancel(r) {
    const t = r.task;
    reserved.delete(t.box.id);
    if (t.target) unclaim(t.target, t.slot);
    if (t.order && t.order.allocated.includes(t.box.id)) t.order.allocated.splice(t.order.allocated.indexOf(t.box.id), 1);
    if (t.transfer) t.transfer.status = 'Queued';
    if (t.queueItem) t.queueItem.taken = false;
    if (t.output) { t.outStation.g.remove(t.output.mesh); t.outStation.queue.splice(t.outStation.queue.indexOf(t.output), 1); }
    r.task = null; r.cargo.visible = false; r.path = []; r.routeBlocked = false;
  }

  // ---------- task assignment ----------
  function start(r, t) {
    const from = t.source ? router.port(t.source) : t.sourceStation.port, to = t.target ? router.port(t.target) : t.outStation.port;
    const path = router.route(origin(r), from), carry = router.route(from, to);
    if (!path || !carry) return false;
    if (t.source) reserved.add(t.box.id);
    if (t.queueItem) t.queueItem.taken = true;
    if (t.target) claim(t.target, t.slot, t.box.product);
    if (t.order) book.reserve(t.order, t.box.id);
    if (t.transfer) t.transfer.status = 'In progress';
    if (t.outStation) {
      const slot = freeSlot(t.outStation), local = localPose(slot, t.pickup);
      const mesh = carton(t.outStation.g, local.x, local.y, local.z, local.w, local.h, local.d);
      mesh.visible = false;
      t.output = {box: t.box, slot, local, mesh, age: 0, arrived: false};
      t.outStation.queue.push(t.output);
      t.drop = stationPose(t.outStation, t.output);
    }
    t.carry = carry;
    t.kind = t.sourceStation ? 'Inbound' : t.target ? 'Transfer' : 'Outbound';
    r.task = t; r.product = t.box.product; r.boxId = t.box.id;
    r.mission = `${t.sourceStation ? 'IN' : t.target ? 'MOVE' : 'OUT'}-${++serial}`;
    r.from = t.source ? `${t.source.id} / ${t.box.location}` : t.sourceStation.id;
    r.to = t.target ? `${t.target.id} / ${t.slot}` : t.outStation.id;
    r.routeBlocked = false; setPath(r, path); r.idle = 0; r.stage = 'To pickup'; r.status = r.stage; r.timer = 0; r.cargo.visible = false;
    note(`${r.mission} · ${t.box.id} · ${r.from} → ${r.to}`);
    return true;
  }
  function inboundJob(r) {
    // Only the box waiting at the robot end of a belt can be picked up.
    const near = st => Math.abs(st.port.x - r.g.position.x) + Math.abs(st.port.z - r.g.position.z);
    for (const st of stations.filter(s => s.kind === 'inbound' && s.ready).sort((a, b) => near(a) - near(b))) for (const q of st.queue.slice(0, 1)) {
      if (!q.atFront || q.taken) continue;
      const pickup = stationPose(st, q), dest = place(q.box, q.target);
      if (dest && start(r, {box: q.box, sourceStation: st, queueItem: q, target: dest.rack, slot: dest.loc, pickup,
        drop: shelfDrop(dest.rack, dest.loc, q.box, pickup)})) return true;
    }
    return false;
  }
  function transferJob(r) {
    const s = getState();
    for (const transfer of transfers.filter(t => t.status === 'Queued')) {
      const b = s.boxes.find(b => b.id === transfer.id);
      if (!b || reserved.has(b.id)) { if (!b) transfer.status = 'Done'; continue; }
      // The chosen cell may have filled up since the request: use another cell on that rack, else give the move up.
      const dest = place(b, transfer, true) || place(b, {rack: transfer.rack}, true);
      if (!dest) { transfer.status = 'Done'; finished.push({kind: 'MoveFailed', box: b, place: transfer.rack}); note(`Move cancelled · ${b.id} · ${transfer.rack} is full`); continue; }
      const pickup = {...poseOf(b.id)}, source = s.racks.find(x => x.id === b.rack);
      if (source && dest && start(r, {box: b, source, target: dest.rack, slot: dest.loc, transfer, pickup,
        drop: shelfDrop(dest.rack, dest.loc, b, pickup)})) return true;
    }
    return false;
  }
  function outboundJob(r) {
    const st = stations.filter(s => s.kind === 'outbound' && s.ready && s.queue.length < STATION_CAPACITY).sort((a, b) => a.queue.length - b.queue.length)[0];
    if (!st) return false;
    const s = getState(), busy = new Set(transfers.filter(t => t.status !== 'Done').map(t => t.id));
    const promised = new Set(book.orders.map(o => o.boxId).filter(Boolean));
    const open = book.orders.filter(o => o.allocated.length < o.quantity)
      .sort((a, b) => (b.priority === 'Urgent') - (a.priority === 'Urgent'));
    for (const order of open) {
      // Older stock first, like a WMS rotating inventory, weighed against the drive: each day of age is
      // worth AGE_METRES of travel. (Pure nearest-first kept every robot in the zone next to Dispatch,
      // pure FIFO sent them across the whole building.)
      let best = null, score = Infinity;
      const now = Date.now();
      for (const b of s.boxes) {
        if (reserved.has(b.id) || busy.has(b.id) || b.product !== order.product) continue;
        if (order.boxId ? b.id !== order.boxId : promised.has(b.id)) continue;
        const p = poseOf(b.id); if (!p) continue;
        const days = b.receivedAt ? (now - Date.parse(b.receivedAt)) / 864e5 : 0;
        const value = Math.abs(p.x - r.g.position.x) + Math.abs(p.z - r.g.position.z) - days * AGE_METRES;
        if (value < score) { score = value; best = b; }
      }
      if (!best) continue;
      const source = s.racks.find(x => x.id === best.rack);
      // The user's chosen dispatch dock, else the nearest open one.
      const pose = poseOf(best.id), open = stations.filter(x => x.kind === 'outbound' && x.ready && x.queue.length < STATION_CAPACITY);
      const cost = x => Math.abs(x.port.x - pose.x) + Math.abs(x.port.z - pose.z) + x.queue.length * 8;
      const wanted = open.find(x => x.id === order.station) || open.sort((a, b) => cost(a) - cost(b))[0] || st;
      if (start(r, {box: best, source, outStation: wanted, order, pickup: {...pose}})) return true;
    }
    return false;
  }
  const waitingInbound = () => stations.filter(s => s.kind === 'inbound').reduce((n, s) => n + s.queue.filter(q => !q.taken).length, 0);
  const dispatchFull = () => stations.filter(s => s.kind === 'outbound').every(s => !s.ready || s.queue.length >= STATION_CAPACITY);
  function assign(r) {
    if (!getState().racks.length || !router) return;
    const urgent = book.orders.some(o => o.priority === 'Urgent' && o.allocated.length < o.quantity);
    // User moves first, then alternate receiving and shipping per robot; a full dock or an urgent order jumps the line.
    const inboundFirst = !urgent && (waitingInbound() >= STATION_CAPACITY * 1.5 || r.cycles % 2 === 0);
    const jobs = inboundFirst ? [transferJob, inboundJob, outboundJob] : [transferJob, outboundJob, inboundJob];
    for (const job of jobs) if (job(r)) return;
    r.status = book.pending ? (dispatchFull() ? 'Waiting for dispatch capacity' : 'Waiting for stock or route') : 'Waiting for work';
  }
  function balance() {
    const demand = waitingInbound() + book.pending + transfers.filter(t => t.status === 'Queued').length;
    const wanted = Math.min(ROBOTS, MIN_ACTIVE + Math.floor(demand / 4));
    robots.forEach((r, i) => {
      if (i < wanted && !r.active) { r.active = true; r.status = 'Idle'; r.retry = 0; note(`${r.id} joined the fleet`); }
      if (i >= wanted && r.active && !r.task && !r.charging && parked(r)) { r.active = false; r.status = 'Standby'; r.cargo.visible = false; note(`${r.id} returned to standby`); }
      r.g.visible = r.active;
    });
  }

  // ---------- lights and small motions (purely visual) ----------
  const LIGHT = {ready: '#22b8ff', green: '#2fe37a', amber: '#ffae1a', red: '#ff3b30', blue: '#3d6bff', white: '#ffffff'};
  const doorMats = {receiving: new T.MeshStandardMaterial({color: '#20262a', emissive: LIGHT.ready, emissiveIntensity: .6}),
    dispatch: new T.MeshStandardMaterial({color: '#20262a', emissive: LIGHT.ready, emissiveIntensity: .6})};
  const doorFlash = {receiving: 0, dispatch: 0};
  let clock = 0;
  function light(mat, color, strength) {
    if (!mat) return;
    if (mat.userData.lit !== color) { mat.emissive.set(color); mat.color.set(color); mat.userData.lit = color; }
    mat.emissiveIntensity = strength;
  }
  const blink = hz => Math.sin(clock * Math.PI * 2 * hz) > 0;
  // Expanding rings on the floor where a box changes hands.
  const pulses = [], ringGeo = new T.RingGeometry(.85, 1, 40).rotateX(-Math.PI / 2);
  function pulse(at, color) {
    if (typeof document === 'undefined') return;
    const m = new T.Mesh(ringGeo, new T.MeshBasicMaterial({color, transparent: true, depthWrite: false, toneMapped: false}));
    m.position.set(at.x, .07, at.z); m.renderOrder = 4; m.raycast = () => {};
    group.add(m); pulses.push({m, age: 0});
  }
  // A charging pad glows under each robot while it charges at its parking spot.
  const padGeo = new T.CircleGeometry(2.2, 40).rotateX(-Math.PI / 2);
  for (const r of robots) {
    r.pad = new T.Mesh(padGeo, new T.MeshBasicMaterial({color: LIGHT.blue, transparent: true, opacity: 0, depthWrite: false, toneMapped: false}));
    r.pad.position.y = .06; r.pad.renderOrder = 4; r.pad.visible = false; r.pad.raycast = () => {}; r.g.add(r.pad);
    r.pitch = 0; r.turnDir = 0; r.accel = 0;
  }
  function updateLights(dt) {
    clock += dt;
    for (const p of [...pulses]) {
      p.age += dt;
      const k = p.age / .9;
      p.m.scale.setScalar(1 + k * 3); p.m.material.opacity = Math.max(0, 1 - k);
      if (k >= 1) { group.remove(p.m); p.m.material.dispose(); pulses.splice(pulses.indexOf(p), 1); }
    }
    for (const r of robots) {
      if (!r.active) continue;
      // Lean back when speeding up, dip the nose when braking.
      r.pitch += (Math.max(-.05, Math.min(.05, -r.accel * .012)) - r.pitch) * Math.min(1, dt * 8);
      r.body.rotation.x = r.pitch;
      const charging = r.charging && !r.task && parked(r);
      r.pad.visible = charging;
      if (charging) r.pad.material.opacity = .18 + .17 * Math.sin(clock * 2.5);
      if (!r.leds) continue;
      const handoff = r.task && (r.stage === 'Loading' || r.stage === 'Unloading');
      const [color, strength] = r.paused ? [LIGHT.amber, blink(1) ? 2.5 : .2]
        : r.status === 'Waiting for traffic' || r.status === 'Route blocked' ? [LIGHT.red, 2.5]
        : charging ? [LIGHT.blue, .6 + 1.6 * (.5 + .5 * Math.sin(clock * 2.5))]
        : r.task && isLoaded(r) ? [LIGHT.green, blink(2) ? 3 : .5]
        : r.task ? [LIGHT.ready, 2]
        : [LIGHT.ready, .6];
      light(r.leds.main, color, strength);
      for (const side of ['left', 'right']) {
        const turning = r.turnDir && (side === 'left') === (r.turnDir > 0);
        if (turning) light(r.leds[side], LIGHT.amber, blink(3) ? 3 : .1);
        else if (handoff) light(r.leds[side], LIGHT.white, 2.5);
        else light(r.leds[side], color, strength * .6);
      }
    }
    for (const st of stations) {
      st.scanFlash = Math.max(0, (st.scanFlash || 0) - dt); st.portalFlash = Math.max(0, (st.portalFlash || 0) - dt);
      light(st.scanMat, st.scanFlash ? LIGHT.green : LIGHT.ready, st.scanFlash ? 4 : 1.2);
      const full = st.queue.length >= STATION_CAPACITY;
      light(st.portalMat, !st.ready ? LIGHT.red : st.portalFlash ? LIGHT.green : full ? LIGHT.amber : LIGHT.ready,
        !st.ready ? (blink(1.5) ? 3 : .3) : st.portalFlash ? 4 : full ? 2.2 : 1.2);
      // The transfer's cross rollers rise and spin while a box crosses.
      if (st.lift) {
        st.popping = Math.max(0, (st.popping || 0) - dt);
        st.pop += ((st.popping ? 1 : 0) - st.pop) * Math.min(1, dt * 10);
        st.lift.position.y = st.pop * .07;
        if (st.popping) for (const o of st.crossRollers) o.rotation.z -= (st.kind === 'inbound' ? -1 : 1) * dt * 20;
      }
      // Rollers turn while the belt moves: inbound towards the robot, outbound away from it.
      if (st.moving && st.rollers) for (const o of st.rollers) o.rotateY((st.kind === 'inbound' ? 1 : -1) * dt * BELT_SPEED / .14);
    }
    for (const k of ['receiving', 'dispatch']) {
      doorFlash[k] = Math.max(0, doorFlash[k] - dt);
      light(doorMats[k], doorFlash[k] ? LIGHT.green : LIGHT.ready, doorFlash[k] ? 4 : .8);
    }
  }

  // ---------- robot motion ----------
  // Traffic works like a block system: a robot only drives onto a grid point it holds, and it can only
  // take a point that is at least CLEAR away from every point another robot holds. Robots therefore
  // never overlap, queue behind each other on a lane and take turns at crossings.
  const same = (a, b) => a && b && Math.abs(a.x - b.x) < .01 && Math.abs(a.z - b.z) < .01;
  const holds = r => r.at ? [r.at, ...r.ahead] : r.ahead;
  // Where a new route starts: the point the robot is committed to, else where it stands.
  const origin = r => r.ahead[0] || r.at || r.g.position;
  function blocker(r, p) {
    for (const o of robots) if (o !== r) for (const q of holds(o)) if (Math.hypot(q.x - p.x, q.z - p.z) < CLEAR) return o;
    return null;
  }
  function take(r, p) {
    if (holds(r).some(q => same(q, p))) return true;
    if (blocker(r, p)) return false;
    r.ahead.push({x: p.x, z: p.z}); return true;
  }
  // A new route keeps the point the robot is already driving to and lets go of the rest.
  function setPath(r, path) {
    r.ahead.splice(1);
    r.path = path; r.index = 0; r.wait = 0;
  }
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  function move(r, dt) {
    if (r.routeBlocked) { r.status = 'Route blocked'; r.speed = 0; return false; }
    const p = r.path[r.index];
    if (!p) return true;
    if (!take(r, p)) { r.speed = 0; return waitForTraffic(r, dt); }
    r.wait = 0;
    const pos = r.g.position, dx = p.x - pos.x, dz = p.z - pos.z, d = Math.hypot(dx, dz);
    if (d < .01) {
      pos.set(p.x, 0, p.z);
      r.detourTried = false;
      r.ahead = r.ahead.filter(q => !same(q, p)); r.at = {x: p.x, z: p.z};
      r.index++;
      return r.index >= r.path.length;
    }
    // Turn on the spot first, then drive.
    const diff = wrap(Math.atan2(dx, dz) - r.g.rotation.y);
    r.turnDir = Math.abs(diff) > .01 ? Math.sign(diff) : 0;
    if (Math.abs(diff) > .01) {
      r.g.rotation.y = wrap(r.g.rotation.y + Math.sign(diff) * Math.min(Math.abs(diff), TURN_RATE * dt));
      if (Math.abs(diff) > .3) { r.speed = 0; return false; }
    }
    // Look ahead along the straight: hold the next points early so the robot does not stop at each one,
    // and brake in time for a turn, the end of the route or a point it could not get.
    let room = d, last = p;
    for (let i = r.index + 1; i < r.path.length && room < 6; i++) {
      const q = r.path[i];
      if (Math.abs(Math.atan2(q.x - last.x, q.z - last.z) - Math.atan2(dx, dz)) > .01 || !take(r, q)) break;
      room += Math.hypot(q.x - last.x, q.z - last.z); last = q;
    }
    const before = r.speed;
    r.speed = Math.max(.4, Math.min(SPEED, r.speed + ACCEL * dt, Math.sqrt(2 * ACCEL * room)));
    r.accel = dt ? (r.speed - before) / dt : 0;
    const stepLen = Math.min(d, r.speed * dt);
    pos.set(pos.x + dx / d * stepLen, 0, pos.z + dz / d * stepLen);
    return false;
  }
  // Stuck behind someone: first look for a way around the robots in the way, then step aside.
  function waitForTraffic(r, dt) {
    r.turnDir = 0; r.accel = 0;
    r.status = 'Waiting for traffic'; r.wait += dt;
    const patience = 3 + robots.indexOf(r) % 4;
    if (r.wait < patience || r.wait < patience * 2 && r.detourTried) return false;
    const goal = r.path.at(-1), others = robots.filter(o => o !== r).flatMap(o => holds(o).map(q => ({...q, r: CLEAR})));
    if (!r.detourTried) {
      r.detourTried = true;
      const detour = router.route(origin(r), goal, others);
      if (detour) { setPath(r, detour); r.wait = patience * .5; }
      return false;
    }
    // Still stuck (two robots facing each other): back off to any free neighbouring point and replan from there.
    r.detourTried = false; r.wait = 0;
    const here = origin(r);
    for (const [ox, oz] of [[2, 0], [-2, 0], [0, 2], [0, -2]].sort(() => Math.random() - .5)) {
      const q = router.point({x: here.x + ox, z: here.z + oz});
      if (!q || same(q, here) || Math.hypot(q.x - here.x, q.z - here.z) > 2.1 || blocker(r, q)) continue;
      const rest = router.route(q, goal);
      if (rest) { setPath(r, [q, ...rest]); return false; }
    }
    return false;
  }
  // Hand-offs are instant swaps: the box leaves the shelf or belt and appears on the robot deck (and back).
  function pickUp(r) {
    const t = r.task, s = getState();
    if (t.source) {
      const i = s.boxes.indexOf(t.box);
      if (i >= 0) s.boxes.splice(i, 1);
      addresses(); addressRemove(t.box); countFlow(t.box.rack, 'out');
      reserved.delete(t.box.id);
      inventoryChanged(t.box.rack);
    } else {
      const st = t.sourceStation;
      st.g.remove(t.queueItem.mesh); st.queue.splice(st.queue.indexOf(t.queueItem), 1);
    }
    held.set(t.box.id, {box: t.box, where: 'transit', place: `${r.id} · In transit`, robot: r.id});
    pulse(r.g.position, LIGHT.amber);
    r.cargo.position.set(0, 1.5 + t.pickup.h / 2, 0); r.cargo.quaternion.identity();
    r.cargo.scale.set(t.pickup.w, t.pickup.h, t.pickup.d);
    r.cargo.visible = true;
  }
  function putDown(r) {
    const t = r.task, s = getState();
    if (t.output) {
      t.output.arrived = true; t.output.mesh.visible = true; t.output.age = 0;
      held.set(t.box.id, {box: t.box, where: 'dispatch', place: t.outStation.id});
      book.stage(t.box.id);
      if (t.order.user) finished.push({kind: 'Ship', box: t.box, place: t.outStation.id, robot: r.id});
      revision++;
    } else {
      unclaim(t.target, t.slot);
      const from = t.sourceStation ? t.sourceStation.id : `${t.box.rack} / ${t.box.location}`;
      t.box.rack = t.target.id; t.box.location = t.slot;
      s.boxes.push(t.box); held.delete(t.box.id);
      addresses(); addressAdd(t.box); countFlow(t.target.id, 'in');
      if (t.sourceStation) stored++;
      if (t.transfer || t.queueItem?.user) finished.push({kind: t.transfer ? 'Move' : 'Receive', box: t.box, place: `${t.target.id} · ${t.slot}`, robot: r.id});
      if (t.transfer) t.transfer.status = 'Done';
      history(t.sourceStation ? 'Put away' : 'Moved', t.box, from, `${t.target.id} / ${t.slot}`);
      inventoryChanged(t.target.id);
    }
    note(`${t.box.id} delivered · ${r.to}`);
    pulse(r.g.position, LIGHT.green);
    r.cycles++; delivered++; r.task = null; r.cargo.visible = false;
    r.retry = HANDOFF_SECONDS; // stand at the drop point for a moment before the next job
    if (r.chargeNext || r.battery < 25) { r.charging = true; r.chargeNext = false; }
  }
  const parked = r => !r.home || same(r.at, r.home) && !r.ahead.length;
  // No job: look for work every second; after a short wait drive to the parking spot (chargers are there),
  // so an idle robot never stands on a lane.
  function idle(r, dt) {
    if (r.charging && parked(r)) {
      r.status = 'Charging'; r.battery = Math.min(100, r.battery + dt * 3);
      if (r.battery === 100) r.charging = false;
      return;
    }
    if (!r.charging) {
      r.retry -= dt;
      if (r.retry <= 0) { r.retry = 1; if (r.battery < 25) r.charging = true; else assign(r); }
      if (r.task) return;
    }
    r.idle += dt;
    if (parked(r) || r.idle < PARK_AFTER && !r.charging) { r.speed = 0; return; }
    if (!r.path.length || !same(r.path.at(-1), r.home)) setPath(r, router.route(origin(r), r.home) || []);
    if (move(r, dt)) { r.path = []; r.index = 0; }
    if (r.charging) r.status = 'Charging';
  }
  function updateRobot(r, dt) {
    if (!r.active) { r.status = 'Standby'; return; }
    if (r.paused) { r.status = 'Paused'; r.speed = 0; return; }
    if (!r.task) return idle(r, dt);
    const t = r.task;
    if (t.outStation && !t.outStation.ready || t.sourceStation && !t.sourceStation.ready && r.stage === 'To pickup') { r.status = 'Waiting for station'; return; }
    r.status = r.stage; r.battery = Math.max(5, r.battery - dt * .02);
    if (r.stage === 'To pickup' || r.stage === 'Transporting') {
      if (move(r, dt)) { r.stage = r.stage === 'To pickup' ? 'Loading' : 'Unloading'; r.timer = 0; }
      return;
    }
    if (r.stage === 'Unloading') { putDown(r); return; }
    if (r.timer === 0) pickUp(r);
    r.timer += dt;
    if (r.timer < HANDOFF_SECONDS) return;
    r.stage = 'Transporting'; setPath(r, t.carry || []); r.routeBlocked = !t.carry;
  }
  function updateMarkers() {
    const r = robots.find(r => r.id === selected), task = r?.task;
    pickupMarker.visible = !!task && r.stage === 'To pickup';
    dropMarker.visible = !!task;
    for (const [marker, p] of [[pickupMarker, task?.pickup], [dropMarker, task?.drop]])
      if (p) { marker.position.set(p.x, p.y, p.z); marker.scale.set(p.w + .15, p.h + .15, p.d + .15); }
    routeLine.visible = !!task;
    if (task) {
      routeLine.geometry.dispose();
      routeLine.geometry = new T.BufferGeometry().setFromPoints([r.g.position.clone().setY(.3), ...r.path.slice(r.index).map(p => new T.Vector3(p.x, .3, p.z))]);
    }
  }

  function update(dt) {
    layoutClock += dt;
    if (layoutClock >= .25) { layoutClock = 0; checkLayout(); }
    group.visible = !suspended;
    if (suspended) return;
    balanceClock += dt;
    if (balanceClock >= 2) { balanceClock = 0; balance(); }
    generateDemand(dt);
    updateDocks(dt);
    for (const r of robots) updateRobot(r, dt);
    updateMarkers();
    updateLights(dt);
  }

  // ---------- read-only views for the UI ----------
  function boxInfo(id) {
    const s = getState(), shelf = s.boxes.find(b => b.id === id), h = held.get(id);
    const b = shelf || h?.box;
    if (!b) return null;
    const robot = robots.find(r => r.task?.box.id === id), order = book.forBox(id);
    const transfer = transfers.find(t => t.id === id && t.status !== 'Done');
    const status = h ? {receiving: 'Receiving', transit: 'In transit', dispatch: 'At dispatch'}[h.where]
      : reserved.has(id) || order ? 'Reserved' : transfer ? 'Transfer queued' : 'Stored';
    return {...b, rack: shelf ? b.rack : h.place, location: shelf ? b.location : '', status, robot: robot?.id, order: order?.id,
      actionable: !!shelf && !reserved.has(id) && !transfer && !order};
  }
  return {
    robots, stations, events, book, update,
    get hits() { return hits.filter(h => robots.find(r => r.id === h.userData.id)?.active); },
    get revision() { return revision; },
    get selected() { return selected; },
    get delivered() { return delivered; },
    select(id) { selected = id; },
    setBuilding(v) { suspended = v; },
    setLanesVisible(v) { laneGroup.visible = v; },
    consumeVisualChange() { const v = cargoDirty; cargoDirty = false; return v; },
    displayLayout() { checkLayout(); refreshPoses(); return poses; },
    products: stockedProducts,
    boxInfo,
    dashboard(s = getState()) {
      const counts = {stored: s.boxes.length, receiving: 0, transit: 0, dispatch: 0};
      for (const h of held.values()) counts[h.where]++;
      return {...s, onSite: s.boxes.length + held.size, counts};
    },
    heldBoxes() { return [...held.values()].map(h => ({box: h.box, kind: h.where, place: h.place})); },
    boxPose(id) {
      const p = poseOf(id);
      if (p) return p;
      const r = robots.find(r => r.task?.box.id === id && isLoaded(r));
      if (r) { const v = r.cargo.getWorldPosition(new T.Vector3()); return {...r.task.pickup, x: v.x, y: v.y, z: v.z}; }
      for (const st of stations) { const q = st.queue.find(q => q.box.id === id && q.arrived); if (q) return stationPose(st, q); }
      return null;
    },
    orderStatus(o) {
      if (o.shipped.length >= o.quantity) return 'Completed';
      if (o.allocated.length >= o.quantity) return 'In progress';
      if (!getState().boxes.some(b => b.product === o.product && !reserved.has(b.id) && (!o.boxId || b.id === o.boxId))) return 'Waiting for matching stock';
      if (dispatchFull()) return 'Waiting for dispatch space';
      return 'Waiting for an available robot';
    },
    // User actions become robot work.
    receive(product, qty, target = null) {
      if (!catalog.includes(product) || !Number.isInteger(qty) || qty < 1 || qty > 48) throw Error('Choose a component and 1–48 boxes.');
      // User receipts go ahead of the simulated supplier arrivals still waiting for dock space.
      const at = backlog.findIndex(x => !x.user), items = Array.from({length: qty}, () => ({product, target, user: true, id: `RCV-${++receiptSeq}`}));
      backlog.splice(at < 0 ? backlog.length : at, 0, ...items);
      note(`Inbound · ${qty} × ${product}${target ? ` → ${target.rack} / ${target.loc}` : ''}`);
    },
    requestMove(ids, rack, loc = null) {
      ids = [].concat(ids);
      if (!getState().racks.some(r => r.id === rack)) throw Error('Choose a destination rack.');
      for (const id of ids) if (!boxInfo(id)?.actionable) throw Error(`${id} is busy — choose another box.`);
      for (const id of ids) transfers.push({id, rack, loc, status: 'Queued'});
      note(`Move requested · ${ids.length} → ${rack}${loc ? ' / ' + loc : ''}`);
    },
    shipBox(id) {
      const b = boxInfo(id);
      if (!b?.actionable) throw Error('Box is no longer available.');
      return Object.assign(book.create(b.product, 1, 'Normal', id), {user: true});
    },
    // Ship from the top bar: robots bring the nearest boxes of a product to the chosen dispatch station.
    ship(product, qty, station = null) {
      const free = getState().boxes.filter(b => b.product === product && boxInfo(b.id)?.actionable).length;
      if (!Number.isInteger(qty) || qty < 1 || qty > free) throw Error(`Choose 1–${free} boxes.`);
      return Object.assign(book.create(product, qty, 'Normal'), {user: true, station});
    },
    inStock(product) { return getState().boxes.filter(b => b.product === product && boxInfo(b.id)?.actionable).length; },
    dispatchStations() { return stations.filter(s => s.kind === 'outbound').map(s => s.id); },
    // Work the user asked for, one card per box: what the robot is doing right now.
    tasks() {
      const out = [], s = getState();
      for (const r of robots) {
        const t = r.task;
        if (!t || !(t.transfer || t.order?.user || t.queueItem?.user)) continue;
        const kind = t.transfer ? 'Move' : t.order ? 'Ship' : 'Receive', to = t.target ? `${t.target.id} · ${t.slot}` : t.outStation.id;
        const step = r.stage === 'To pickup' ? 0 : r.stage === 'Loading' ? 1 : 2;
        const from = t.source ? `${t.source.id} · ${t.box.location}` : t.sourceStation.id;
        const text = step === 0 ? `${r.id} is on its way to ${from}${t.sourceStation ? ` for ${t.box.id}` : ''}`
          : step === 1 ? `${r.id} is loading the box` : `${r.id} is taking the box to ${to}`;
        out.push({id: t.box.id, kind, to, robot: r.id, step, text, cancellable: !isLoaded(r)});
      }
      for (const tr of transfers.filter(t => t.status === 'Queued')) out.push({id: tr.id, kind: 'Move', to: `${tr.rack}${tr.loc ? ' · ' + tr.loc : ''}`, step: -1, text: 'Waiting for a free robot', cancellable: true});
      for (const o of book.orders.filter(o => o.user)) for (let i = o.allocated.length; i < o.quantity; i++) out.push({id: `${o.id}#${i}`, kind: 'Ship', to: o.station || 'Dispatch', step: -1, text: 'Waiting for a free robot', cancellable: true});
      for (const st of stations) for (const q of st.queue) if (q.user && !q.taken) out.push({id: q.box.id, kind: 'Receive', to: q.target ? `${q.target.rack} · ${q.target.loc}` : 'storage', step: -1, text: `${q.box.id} is waiting at ${st.id}`, cancellable: true});
      for (const q of backlog) if (q.user) out.push({id: q.id, kind: 'Receive', to: q.target ? `${q.target.rack} · ${q.target.loc}` : 'storage', step: -1, text: `${q.product} · waiting for dock space`, cancellable: true});
      return out;
    },
    cancelTask(id) {
      const s = getState(), r = robots.find(r => r.task?.box.id === id);
      if (r) { if (isLoaded(r)) throw Error('The robot already has this box.'); const t = r.task; cancel(r); if (t.order) id = `${t.order.id}#`; }
      const tr = transfers.find(t => t.id === id && t.status !== 'Done');
      if (tr) { tr.status = 'Done'; note(`Move cancelled · ${id}`); return; }
      const order = book.orders.find(o => o.user && (id.startsWith(o.id + '#') || o.boxId === id));
      if (order) { order.quantity--; if (order.quantity <= order.allocated.length && !order.allocated.length) book.orders.splice(book.orders.indexOf(order), 1); note(`Shipment cancelled · ${order.id}`); return; }
      const waiting = backlog.findIndex(q => q.user && q.id === id);
      if (waiting >= 0) { backlog.splice(waiting, 1); note(`Receipt cancelled · ${id}`); return; }
      for (const st of stations) {
        const q = st.queue.find(q => q.box.id === id && q.user);
        if (!q) continue;
        q.mesh.parent?.remove(q.mesh); st.queue.splice(st.queue.indexOf(q), 1); held.delete(id); s.today.received--;
        history('Receipt cancelled', q.box, st.id, 'Supplier');
        return;
      }
    },
    takeFinished() { return finished.splice(0); },
    addArrival() { backlog.push({product: pick(catalog)}); },
    get flow() {
      return {
        waiting: stations.filter(s => s.kind === 'inbound').reduce((n, s) => n + s.queue.length, 0),
        outgoing: stations.filter(s => s.kind === 'outbound').reduce((n, s) => n + s.queue.filter(q => q.arrived).length, 0),
        received: stored, shipped, backlog: backlog.length,
        activeRobots: robots.filter(r => r.active).length,
        bottleneck: robots.some(r => r.routeBlocked) ? 'Route blocked'
          : robots.filter(r => r.status === 'Waiting for traffic').length >= 2 ? 'Traffic congestion'
          : dispatchFull() ? 'Dispatch capacity' : 'None',
      };
    },
    focus(id) {
      checkLayout();
      const r = robots.find(r => r.id === id);
      return r ? r.g.position.clone() : new T.Vector3(anchor.x, 0, anchor.z);
    },
    command(id, action) {
      const r = robots.find(r => r.id === id);
      if (!r) return;
      if (action === 'pause') r.paused = !r.paused;
      if (action === 'charge') r.chargeNext = true;
      note(`${id} · ${action === 'charge' ? 'Charging after delivery' : r.paused ? 'Paused' : 'Resumed'}`);
    },
    resolveIssue(id) {
      const st = stations.find(s => s.id === id);
      if (st) { st.ready = true; return; }
      const r = robots.find(r => r.id === id);
      if (r) { r.paused = false; if (r.task) route(r); }
    },
  };
}
