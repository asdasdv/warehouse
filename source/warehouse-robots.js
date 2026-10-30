import * as T from 'three';
import {locations, boxLayout, CELL_CAPACITY} from './storage.js';
import {products as catalog} from './model.js';
import {createOrderBook} from './order-book.js';
import {createRouter} from './robot-routing.js';
import {loadModel, fitted} from './warehouse-models.js';
import {mergeByMaterial} from './merge-meshes.js';
import {BELT_TOP, BELT_START, BELT_END, BELT_HALF, BRIDGE_LIFT, BRIDGE_HALF, BUILDING, UPPER, docksOf, dockPort, dockReach, layoutObstacles, spineLift, spineBreaks, lineSpan} from './docks.js';

// The simulation owns the inventory: robots change `state.boxes` directly.
// Boxes on shelves live in `state.boxes`; boxes at a dock or on a robot live in `held`.
// Nothing is saved — a reload starts the demo again.

// Fleet size and demand are set for 312 racks and grow with the warehouse (see `scale` below).
const BASE_RACKS = 312, BASE_ROBOTS = 40, BASE_ACTIVE = 16, ROBOTS_PER_DOCK = 5;
const RESLOT_SHARE = .25;    // at most this share of the fleet does internal moves (reslotting) when there is no other work
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
const PICK_SAMPLE = 12;      // outbound picking: how many of a product's boxes are weighed against each other
// conveyor.glb: scanner portal 1.35 m from the hand-off end; lights hold their flash this long.
const SCANNER_Z = BELT_START + 1.35 * BELT_TOP / .65, FLASH = 1.2;
// Demand is tuned for the 24-zone spine warehouse (~40 robots); arrivals and orders come every few seconds.
const ARRIVAL_EVERY = {low: 1.8, normal: 2.6, high: 4.5}, ORDER_EVERY = 2.2, PENDING = {low: 15, normal: 30, high: 50};
const HISTORY_LIMIT = 300;
const KEEP_COMPLETED_ORDERS = 20;

const addressKey = (rack, loc) => rack + '|' + loc;
const pick = list => list[Math.floor(Math.random() * list.length)];

export function addWarehouseRobots(scene, getState) {
  const scale = Math.max(1, getState().racks.length / BASE_RACKS);
  // More robots than the docks can serve only stand in queues, so the fleet is also capped at ROBOTS_PER_DOCK.
  const ROBOTS = Math.min(Math.round(BASE_ROBOTS * scale), docksOf(getState()).length * ROBOTS_PER_DOCK), MIN_ACTIVE = Math.round(ROBOTS * BASE_ACTIVE / BASE_ROBOTS);
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
  // The 3D view redraws only the racks whose boxes changed (`visualRacks`), or everything after a layout change.
  let visualAll = true; const visualRacks = new Set();
  function inventoryChanged(rackId) { revision++; cargoDirty = true; dirtyRacks.add(rackId); visualRacks.add(rackId); }

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

  // ---------- box index: shelf boxes by id and by product (kept up to date as robots pick and drop) ----------
  // Rebuilt if `state.boxes` is replaced or changes length behind the simulation's back.
  let boxIndex = null, indexedArray = null, indexedLength = -1;
  function index() {
    const s = getState();
    if (!boxIndex || indexedArray !== s.boxes || indexedLength !== s.boxes.length) {
      boxIndex = {byId: new Map(), byProduct: new Map()};
      for (const b of s.boxes) indexAdd(b);
      indexedArray = s.boxes; indexedLength = s.boxes.length;
    }
    return boxIndex;
  }
  function indexAdd(b) {
    boxIndex.byId.set(b.id, b);
    let set = boxIndex.byProduct.get(b.product);
    if (!set) boxIndex.byProduct.set(b.product, set = new Set());
    set.add(b);
  }
  function indexRemove(b) { boxIndex.byId.delete(b.id); boxIndex.byProduct.get(b.product)?.delete(b); }
  const boxesOf = product => index().byProduct.get(product) || [];

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
    t.fillStyle = '#626a6f'; t.fillRect(0, 0, 16, 64); t.fillStyle = '#737c81'; t.fillRect(0, 0, 16, 10);
    const tex = new T.CanvasTexture(c);
    tex.wrapS = tex.wrapT = T.RepeatWrapping; tex.repeat.set(1, (BELT_END - BELT_START + 1) / 1.2);
    return tex;
  }
  // One palette for every model (racks use the same in scene.js): white and light matte metal, dark belts
  // and robot tops, one safety yellow. Blender models are recoloured to it by material name.
  const PALETTE = {white: '#f3f4f6', metal: '#c3c9cf', steel: '#d5d9dd', dark: '#3b4248', belt: '#6b7378', rubber: '#4a5055', yellow: '#e9c84a'};
  const frameMat = new T.MeshStandardMaterial({color: PALETTE.metal, roughness: .5, metalness: .25});
  const MODEL_COLOURS = [[/brushed steel/, 'steel'], [/silver enclosure|tunnel|ceramic/, 'white'], [/blue grey frame/, 'metal'], [/rubber|tyre/, 'rubber'], [/graphite/, 'dark'], [/safety yellow/, 'yellow']];
  const recoloured = new WeakSet();
  function recolour(material) {
    if (!material || recoloured.has(material)) return;
    recoloured.add(material);
    const hit = MODEL_COLOURS.find(([re]) => re.test(material.name || ''));
    if (hit) { material.color.set(PALETTE[hit[1]]); material.metalness = Math.min(material.metalness ?? 0, .3); }
  }
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
      m.traverse(o => { if (o.isMesh) recolour(o.material); });
      // One mesh per material instead of sixteen parts.
      for (const mesh of mergeByMaterial(m)) if (Object.values(leds).includes(mesh.material)) mesh.castShadow = false;
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
      const rollers = [];
      m.traverse(o => {
        if (!o.isMesh) return;
        if (/^Status.strip$/.test(o.name)) o.material = st.scanMat = o.material.clone();
        if (/^Portal.status$/.test(o.name)) o.material = st.portalMat = o.material.clone();
        if (o.name.startsWith('Roller')) rollers.push(o);
        // On conveyors the dock belt ends at a transfer, not in the model's dispatch tunnel.
        if (getState().spine && /^Dispatch_(rear|side|roof)/.test(o.name)) o.visible = false;
        recolour(o.material);
      });
      // The 59 rollers become one instanced mesh (they spin together); everything else that does not
      // light up is merged per material: ~10 meshes per dock instead of ~170.
      m.updateMatrixWorld(true);
      if (rollers.length) {
        const toModel = new T.Matrix4().copy(m.matrixWorld).invert(), inst = new T.InstancedMesh(rollers[0].geometry, rollers[0].material, rollers.length);
        st.rollerBase = rollers.map(o => new T.Matrix4().multiplyMatrices(toModel, o.matrixWorld));
        st.rollerBase.forEach((mat, i) => inst.setMatrixAt(i, mat)); inst.castShadow = true; inst.receiveShadow = true;
        for (const o of rollers) o.parent.remove(o);
        m.add(inst); st.rollers = inst; st.rollerAngle = 0;
      }
      mergeByMaterial(m, o => o.material === st.scanMat || o.material === st.portalMat);
    }
  });
  loadModel('box').then(model => {
    if (!model) return;
    cartonModel = fitted(model, {w: 1, h: 1, d: 1});
    for (const r of robots) { r.cargo.clear(); r.cargo.add(cartonContent()); }
  });
  const ROBOT_NEAR = 150;
  const proxyBody = new T.InstancedMesh(geo, new T.MeshStandardMaterial({color: PALETTE.dark, roughness: .6}), ROBOTS);
  const proxyLoad = new T.InstancedMesh(geo, new T.MeshStandardMaterial({color: '#c9a274', roughness: .9}), ROBOTS);
  const proxyObj = new T.Object3D();
  for (const m of [proxyBody, proxyLoad]) { m.count = 0; m.frustumCulled = false; m.raycast = () => {}; group.add(m); }
  const pickupMarker = new T.Mesh(geo, new T.MeshBasicMaterial({color: '#ffd900', wireframe: true, depthTest: false}));
  const dropMarker = new T.Mesh(geo, new T.MeshBasicMaterial({color: '#6c9ee8', wireframe: true, depthTest: false}));
  pickupMarker.renderOrder = dropMarker.renderOrder = 15;
  const routeLine = new T.Line(new T.BufferGeometry(), new T.LineBasicMaterial({color: '#baa51a', transparent: true, opacity: .6}));
  group.add(pickupMarker, dropMarker, routeLine);

  // ---------- conveyors: receiving line below, dispatch line above ----------
  // Boxes leave the receiving building on the floor-level receiving line and turn off it at their dock.
  // Dispatch docks lift boxes up an incline onto the overhead dispatch line, which carries them into the
  // dispatch building. Robots drive under both where the receiving line climbs a bridge (see docks.js).
  const spineGroup = new T.Group(), spineItems = new T.Group(); group.add(spineGroup, spineItems);
  const spineTextures = [], yellowMat = new T.MeshStandardMaterial({color: PALETTE.yellow, roughness: .6});
  const beltMat = new T.MeshStandardMaterial({color: PALETTE.belt, roughness: .9});
  let spine = null, spineKey = null, span = null;
  // One belt material per direction; each belt piece carries its length in its UVs, so all pieces merge.
  const beltMats = {};
  function beltMaterial(dir) {
    if (beltMats[dir]) return beltMats[dir];
    let map = null;
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas'); c.width = 64; c.height = 16;
      const t = c.getContext('2d');
      t.fillStyle = '#626a6f'; t.fillRect(0, 0, 64, 16); t.fillStyle = '#737c81'; t.fillRect(0, 0, 10, 16);
      map = new T.CanvasTexture(c); map.wrapS = map.wrapT = T.RepeatWrapping; spineTextures.push({tex: map, dir});
    }
    return beltMats[dir] = new T.MeshStandardMaterial({map, roughness: .9});
  }
  function piece(x0, x1, y0, y1, z, height, depth, material) {
    const len = Math.hypot(x1 - x0, y1 - y0), m = box(spineGroup, (x0 + x1) / 2, (y0 + y1) / 2, z, len, height, depth, material);
    m.rotation.z = Math.atan2(y1 - y0, x1 - x0); return m;
  }
  // A belt between two points of any slope, for the dispatch inclines.
  function beam(parent, a, b, width, height, material) {
    const d = new T.Vector3().subVectors(b, a), m = new T.Mesh(geo, material);
    m.position.addVectors(a, b).multiplyScalar(.5); m.scale.set(width, height, d.length());
    m.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), d.normalize()); m.castShadow = m.receiveShadow = true;
    parent.add(m); return m;
  }
  // A straight belt along x at z with rails and legs: on the floor following the bridges, or overhead at `height`.
  function straightBelt(sp, from, to, z, legs, height = null) {
    const xs = height === null ? spineBreaks(sp, from, to) : [from, to], y = x => height ?? BELT_TOP + spineLift(sp, x);
    for (let i = 1; i < xs.length; i++) {
      const a = xs[i - 1], b = xs[i];
      const belt = piece(a, b, y(a) - .06, y(b) - .06, z, .12, BELT_HALF * 2, beltMaterial(1));
      belt.geometry = geo.clone(); const uv = belt.geometry.attributes.uv;
      for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) * Math.hypot(b - a, y(b) - y(a)) / 1.2);
      for (const rail of [-1.25, 1.25]) piece(a, b, y(a) - .05, y(b) - .05, z + rail, .4, .3, frameMat);
    }
    // Overhead legs stand outside the floor belt; no legs in a robot passage.
    const step = height === null ? 4 : 8, off = height === null ? 1.25 : 1.75;
    for (let x = from + 1; x < to; x += step) {
      if ((sp.crossings || []).some(c => Math.abs(x - c) < BRIDGE_HALF + .5)) continue;
      for (const side of [-1, 1]) legs.push({x, z: z + side * off, h: y(x) - .25});
      if (height !== null) box(spineGroup, x, height - .35, z, .25, .2, off * 2 + .25, frameMat);
    }
  }
  function drawSpine(sp) {
    spineGroup.traverse(o => { if (o.isMesh && o.geometry !== geo) o.geometry.dispose(); });
    spineGroup.clear();
    if (!sp) return;
    span = lineSpan(sp, docksOf(getState()));
    const legs = [];
    straightBelt(sp, sp.x1, span.recvEnd, 0, legs);                 // receiving line, floor level
    box(spineGroup, span.recvEnd + .2, BELT_TOP - .1, 0, .4, .5, BELT_HALF * 2 + .6, frameMat);
    straightBelt(sp, span.dispStart, sp.x2, 0, legs, UPPER);        // dispatch line, overhead
    box(spineGroup, span.dispStart - .2, UPPER - .1, 0, .4, .5, BELT_HALF * 2 + .6, frameMat);
    // Bridges: portal posts at each end and a yellow beam over the robot passage.
    for (const c of sp.crossings || []) {
      box(spineGroup, c, BELT_TOP + BRIDGE_LIFT - .45, 0, BRIDGE_HALF * 2, .3, 3.2, yellowMat);
      for (const e of [-BRIDGE_HALF, BRIDGE_HALF]) {
        box(spineGroup, c + e, BELT_TOP + BRIDGE_LIFT - .45, 0, .4, .4, 3.6, frameMat);
        for (const z of [-1.6, 1.6]) legs.push({x: c + e, z, h: UPPER - .25});
      }
    }
    const legMesh = new T.InstancedMesh(geo, frameMat, legs.length), o = new T.Object3D();
    legs.forEach((l, i) => { o.position.set(l.x, l.h / 2, l.z); o.scale.set(.25, l.h, .25); o.updateMatrix(); legMesh.setMatrixAt(i, o.matrix); });
    legMesh.castShadow = true; spineGroup.add(legMesh);
    // The two buildings, each with a lit doorway where its line goes through the wall.
    for (const [x, name, doorY] of [[sp.x1 - BUILDING.length / 2, 'Receiving', BELT_TOP], [sp.x2 + BUILDING.length / 2, 'Dispatch', UPPER]]) {
      building(x, 0, name);
      const face = name === 'Receiving' ? x + BUILDING.length / 2 + .05 : x - BUILDING.length / 2 - .05;
      box(spineGroup, face, doorY + 2.6, 0, .1, .35, 3.4, doorMats[name === 'Receiving' ? 'receiving' : 'dispatch']);
      box(spineGroup, face, doorY + 1.1, 0, .08, 2.4, 3, doorwayMat);
    }
    // Hundreds of belt pieces, rails, walls and panels end up as one mesh per material.
    mergeByMaterial(spineGroup);
  }
  const doorwayMat = new T.MeshStandardMaterial({color: '#2b3133', roughness: .9});
  // Where a dock meets its line: receiving docks get a pop-up transfer in the receiving line (a patch of cross
  // rollers that rises and pushes the box sideways onto the dock belt); dispatch docks get an incline up to
  // the dispatch line.
  const transferGroup = new T.Group(); group.add(transferGroup);
  const crossRoller = new T.CylinderGeometry(.07, .07, 2.1, 10).rotateX(Math.PI / 2);
  const bridgeRoller = new T.CylinderGeometry(.07, .07, 2.2, 10).rotateZ(Math.PI / 2);
  const rollerMat = new T.MeshStandardMaterial({color: '#b8c1c4', roughness: .35, metalness: .6});
  const plateMat = new T.MeshStandardMaterial({color: '#2a3033', roughness: .8});
  const LAST_ROLLER = 7.75; // conveyor.glb: the last roller, station-local z
  function drawTransfers() {
    transferGroup.clear();
    if (!spine) return;
    for (const st of stations) {
      const reach = dockReach(st.dock), world = (x, y, z) => st.g.localToWorld(new T.Vector3(x, y, z));
      if (st.kind === 'inbound') {
        const g = new T.Group(); g.position.set(st.g.position.x, spineLift(spine, st.g.position.x), 0); transferGroup.add(g);
        box(g, 0, BELT_TOP + .01, 0, 2.8, .02, BELT_HALF * 2, plateMat);
        for (const x of [-1.4, 1.4]) box(g, x, BELT_TOP + .02, 0, .1, .04, BELT_HALF * 2, yellowMat);
        const lift = new T.Group(); g.add(lift);
        for (let i = 0; i < 8; i++) { const m = new T.Mesh(crossRoller, rollerMat); m.position.set(-1.2 + i * 2.4 / 7, BELT_TOP + .02, 0); m.castShadow = true; lift.add(m); }
        st.lift = lift; st.pop = 0; lift.userData.lift = true;
        // A few rollers bridge the end of the dock belt (where the model's tunnel was) to the line.
        for (let lz = LAST_ROLLER + .35; lz < reach; lz += .35) { const m = new T.Mesh(bridgeRoller, rollerMat); m.position.copy(world(0, BELT_TOP - .07, lz)); transferGroup.add(m); }
        for (const x of [-1.2, 1.2]) beam(transferGroup, world(x, BELT_TOP - .15, LAST_ROLLER), world(x, BELT_TOP - .15, reach), .12, .25, frameMat);
        continue;
      }
      // Dispatch: a short flat run, then the incline up to the overhead line, with a guard rail each side.
      st.lift = null;
      const flatEnd = LAST_ROLLER + 1, top = world(0, UPPER - .06, reach), bottom = world(0, BELT_TOP - .06, flatEnd);
      beam(transferGroup, world(0, BELT_TOP - .06, LAST_ROLLER), bottom, BELT_HALF * 2, .12, beltMat);
      beam(transferGroup, bottom, top, BELT_HALF * 2, .12, beltMat);
      for (const x of [-1.25, 1.25]) beam(transferGroup, world(x, BELT_TOP + .1, flatEnd), world(x, UPPER + .1, reach), .25, .35, frameMat);
      for (let k = 1; k < 4; k++) {
        const lz = flatEnd + (reach - flatEnd) * k / 4, h = BELT_TOP + (UPPER - BELT_TOP) * k / 4;
        for (const x of [-1.25, 1.25]) beam(transferGroup, world(x, 0, lz), world(x, h - .2, lz), .2, .2, frameMat);
      }
      const g = new T.Group(); g.position.set(st.g.position.x, 0, 0); transferGroup.add(g);
      for (const x of [-1.4, 1.4]) box(g, x, UPPER + .02, 0, .1, .04, BELT_HALF * 2, yellowMat);
    }
    // Static parts merged per material; each pop-up lift stays its own (merged) mesh so it can rise.
    mergeByMaterial(transferGroup, o => o.parent?.userData.lift);
    for (const st of stations) if (st.lift) mergeByMaterial(st.lift);
  }
  // Moves a box straight to `to` in `seconds` (with a small hop for a pop-up transfer), then calls `done`.
  function transfer(st, q, to, done, seconds = TRANSFER_SECONDS, hop = true) {
    const from = q.mesh.getWorldPosition(new T.Vector3());
    if (q.mesh.parent !== spineItems) { q.mesh.parent.remove(q.mesh); spineItems.add(q.mesh); q.mesh.rotation.set(0, 0, 0); }
    q.mesh.position.copy(from);
    q.move = {t: 0, from, to, done, seconds, hop}; if (hop) st.popping = TRANSFER_SECONDS; st.portalFlash = FLASH;
  }
  function stepTransfer(st, q, dt) {
    const m = q.move;
    m.t = Math.min(1, m.t + dt / m.seconds);
    const k = m.hop ? m.t * m.t * (3 - 2 * m.t) : m.t;
    q.mesh.position.lerpVectors(m.from, m.to, k); if (m.hop) q.mesh.position.y += Math.sin(Math.PI * m.t) * .12;
    if (m.t >= 1) { q.move = null; m.done(); }
  }
  // ---------- buildings ----------
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
  }
  // A dock's belt has room for one more box at its far end.
  const spurFree = (st, q) => !st.queue.some(o => o !== q && (o.move || !o.onSpine && o.arrived && o.mesh.position.z > BELT_END - (q.local.d + .4)));
  // Receiving line: boxes ride nose to tail towards their dock; at the dock they wait for room, then turn off.
  function updateReceivingLine(dt) {
    const line = [];
    for (const st of stations) if (st.kind === 'inbound' && st.ready) for (const q of st.queue) if (q.onSpine && !q.move) line.push({st, q});
    line.sort((a, b) => b.q.mesh.position.x - a.q.mesh.position.x);
    let ahead = Infinity;
    for (const {st, q} of line) {
      const p = q.mesh.position, target = st.g.position.x, stop = Math.min(target, ahead - (q.local.w + .6));
      if (p.x < stop) p.x = Math.min(stop, p.x + dt * SPINE_SPEED);
      p.y = q.local.y + spineLift(spine, p.x); p.z = 0; ahead = p.x;
      if (Math.abs(p.x - target) < .01 && spurFree(st, q)) {
        transfer(st, q, st.g.localToWorld(new T.Vector3(0, q.local.y, BELT_END)), () => {
          spineItems.remove(q.mesh); st.g.add(q.mesh); q.mesh.position.set(0, q.local.y, BELT_END); q.onSpine = false;
        });
        ahead = Infinity; // the turned-off box no longer holds up the ones behind it
      }
    }
  }

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
    const mesh = spine ? carton(spineItems, spine.x1, local.y, 0, local.w, local.h, local.d) : carton(st.g, local.x, local.y, BELT_END, local.w, local.h, local.d);
    const q = {box: b, slot, local, mesh, age: 0, arrived: true, atFront: false, onSpine: !!spine, target: item.target || null, user: item.user || null, taken: false};
    st.queue.push(q);
    held.set(b.id, {box: b, where: 'receiving', place: st.id});
    s.today.received++;
    history('Received', b, 'Supplier', st.id);
    return true;
  }
  function updateDocks(dt) {
    while (backlog.length && arrive(backlog[0])) backlog.shift();
    if (spine) updateReceivingLine(dt);
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
          // Up the incline onto the overhead dispatch line.
          if (spine) { p.z = BELT_END; q.onSpine = true; const top = new T.Vector3(st.g.position.x, UPPER + q.local.h / 2, 0); transfer(st, q, top, () => {}, top.distanceTo(q.mesh.getWorldPosition(new T.Vector3())) / BELT_SPEED, false); }
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
  // Boxes on a conveyor: mid-transfer, or riding the overhead dispatch line into the dispatch building.
  // (The receiving line moves its boxes together, in updateReceivingLine.)
  function rideSpine(st, q, dt) {
    const p = q.mesh.position;
    if (q.move) return stepTransfer(st, q, dt);
    if (st.kind !== 'outbound') return;
    p.x += dt * SPINE_SPEED; p.y = UPPER + q.local.h / 2; p.z = 0;
    if (p.x >= spine.x2) ship(st, q);
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
    if (arrivalClock >= ARRIVAL_EVERY[low ? 'low' : high ? 'high' : 'normal'] / scale) {
      arrivalClock = 0;
      if (backlog.length < STATION_CAPACITY * stations.filter(s => s.kind === 'inbound').length) backlog.push({product: pick(catalog)});
    }
    orderClock += dt;
    if (orderClock >= ORDER_EVERY / scale) {
      orderClock = 0;
      const stockList = stockedProducts();
      if (stockList.length && book.pending < PENDING[high ? 'high' : low ? 'low' : 'normal'] * scale) {
        const o = book.create(pick(stockList), 1 + Math.floor(Math.random() * 5), Math.random() < .15 ? 'Urgent' : 'Normal');
        note(`${o.id} · ${o.quantity} × ${o.product}${o.priority === 'Urgent' ? ' · urgent' : ''}`);
      }
    }
  }

  // ---------- layout changes ----------
  // Floor markings: lane lines with arrows on one-way runs, and a bay at each parking spot.
  const laneGroup = new T.Group(); group.add(laneGroup);
  // Opaque, so crossing lines do not add up where they overlap.
  // Drawn a little above the zone plinths and pulled towards the camera in depth: at a distance the two surfaces
  // are too close for the depth buffer and the lines flickered.
  const laneMat = new T.MeshBasicMaterial({color: '#f7f8fa', depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4});
  const bayMat = laneMat;
  const flat = new T.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const arrowGeo = new T.ShapeGeometry(new T.Shape([new T.Vector2(.55, 0), new T.Vector2(-.35, .45), new T.Vector2(-.35, -.45)])).rotateX(-Math.PI / 2);
  function instanced(geometry, material, items) {
    const m = new T.InstancedMesh(geometry, material, Math.max(1, items.length)), o = new T.Object3D();
    items.forEach((it, i) => { o.position.set(it.x, .09, it.z); o.rotation.set(0, it.angle || 0, 0); o.scale.set(it.sx || 1, 1, it.sz || 1); o.updateMatrix(); m.setMatrixAt(i, o.matrix); });
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
  let routeKey = null, networkJob = null, networkId = 0, networkPending = false;
  // The lane network is built in a worker in the browser (it takes a second or two on a large layout);
  // without workers (tests) it is built a step per frame. Robots route without it until it is ready.
  const worker = typeof Worker !== 'undefined' && typeof window !== 'undefined' ? new Worker(new URL('./network-worker.js', import.meta.url), {type: 'module'}) : null;
  if (worker) worker.onmessage = e => { if (e.data.id === networkId) { router.setNetwork(e.data.network); networkReady(e.data.segments); } };
  function buildNetwork(hubs, stops, racks, obstacles) {
    networkId++; networkPending = true;
    if (worker) { networkJob = null; worker.postMessage({id: networkId, racks, obstacles, hubs, stops}); return; }
    networkJob = router.networkSteps(hubs, stops);
  }
  function stepNetwork(budgetMs) {
    const t0 = performance.now();
    while (networkJob && performance.now() - t0 < budgetMs) {
      const step = networkJob.next();
      if (!step.done) { if (budgetMs === Infinity) return; continue; }
      networkJob = null; networkReady(step.value);
    }
  }
  // Parking is spread along the docks so idle robots wait close to where work appears.
  // Robots take no work until the network is ready, so they never set off across the floor without lanes.
  function networkReady() {
    // Parking (and charging) bays are spread over the building: beside the docks and beside every zone.
    const zoneSpots = getState().zones.map(z => ({x: z.x + z.w / 2, z: z.z + z.d / 2}));
    const spots = router.parking(ROBOTS, [...stations.map(st => st.port), ...zoneSpots], stations.map(st => st.port));
    robots.forEach((r, i) => { r.home = spots[i] || null; });
    // The short way into each parking bay becomes part of the network: drawn, and kept to.
    for (const spot of spots) router.connect(spot);
    drawLanes(router.segments(), spots);
    networkPending = false;
  }
  function checkLayout() {
    const s = getState(), docks = docksOf(s);
    const k = JSON.stringify(s.racks.map(r => [r.id, r.x, r.z, r.width, r.depth, r.height, r.shelves, r.places, r.rotation || 0]));
    if (k !== rackKey) { rackKey = k; posesDirty = true; cargoDirty = true; visualAll = true; revision++; }
    // Routes are rebuilt once the layout editor closes, not on every edit while it is open.
    const rk = k + JSON.stringify(docks) + JSON.stringify(s.spine || null);
    if (rk === routeKey || suspended && routeKey !== null) return;
    const first = routeKey === null;
    routeKey = rk;
    for (const st of stations) {
      const d = docks.find(d => d.id === st.id) || {x: 0, z: 0, rotation: 0};
      st.g.position.set(d.x, 0, d.z); st.g.rotation.y = -(d.rotation || 0) * Math.PI / 2; st.rotation = d.rotation || 0;
      st.g.updateMatrixWorld(true);
      st.port = dockPort(d); st.dock = d;
    }
    // The lines' ends follow the docks, so the conveyors are redrawn when docks move.
    const sk = JSON.stringify(s.spine || null) + JSON.stringify(docks);
    if (sk !== spineKey) { spineKey = sk; spine = s.spine || null; drawSpine(spine); }
    const obstacles = layoutObstacles(s);
    router = createRouter(s.racks, obstacles);
    buildNetwork(stations.map(st => st.port), s.racks.flatMap(router.ports), s.racks, obstacles);
    const near = {x: stations.reduce((n, st) => n + st.port.x, 0) / stations.length, z: stations.reduce((n, st) => n + st.port.z, 0) / stations.length};
    drawTransfers();
    anchor = near;
    if (first) {
      // Until parking spots exist (they need the lane network) robots wait in the corridors beside the docks.
      const lane = spine ? Math.max(...stations.map(st => Math.abs(st.port.z))) + 5 : 0;
      robots.forEach((r, i) => {
        const p = r.home || router.point(spine ? {x: spine.x1 + 20 + (i >> 1) * 8, z: i % 2 ? lane : -lane} : {x: near.x + (i - ROBOTS / 2) * 4, z: near.z - 8});
        if (p) { r.g.position.set(p.x, 0, p.z); r.at = {x: p.x, z: p.z}; r.g.rotation.y = spine && p.z > 0 ? 0 : Math.PI; }
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
  // A rack is served from whichever face is closer to where the robot comes from.
  const facesFrom = (rack, p) => router.ports(rack).sort((a, b) => Math.abs(a.x - p.x) + Math.abs(a.z - p.z) - Math.abs(b.x - p.x) - Math.abs(b.z - p.z));
  // The stop points of a task, and the two legs between them; the other face is tried when one has no route.
  function plan(r, t) {
    const at = origin(r);
    for (const from of t.source ? facesFrom(t.source, at) : [t.sourceStation.port]) {
      const path = router.route(at, from);
      if (!path) continue;
      for (const to of t.target ? facesFrom(t.target, from) : [t.outStation.port]) {
        const carry = router.route(from, to);
        if (carry) return {from, to, path, carry};
      }
    }
    return null;
  }
  function route(r) {
    const t = r.task, loaded = isLoaded(r);
    // Once loaded only the drop end can change.
    const legs = loaded ? (() => { const from = r.g.position, to = t.target ? facesFrom(t.target, from)[0] : t.outStation.port; return {from, to, carry: router.route(from, to)}; })() : plan(r, t);
    if (!legs) { t.carry = null; r.routeBlocked = true; return; }
    const {from, to} = legs;
    t.carry = legs.carry || null;
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
    const legs = plan(r, t);
    if (!legs) return false;
    const {path, carry} = legs;
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
      const b = index().byId.get(transfer.id);
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
      // worth AGE_METRES of travel. Only a random handful of the product's boxes is compared, so one robot
      // fetches from next door and another from the far end of the building.
      let best = null, score = Infinity;
      const now = Date.now(), all = boxesOf(order.product), list = order.boxId ? [index().byId.get(order.boxId)].filter(Boolean) : [...all];
      const pool = list.length <= PICK_SAMPLE ? list : Array.from({length: PICK_SAMPLE}, () => list[Math.floor(Math.random() * list.length)]);
      for (const b of pool) {
        if (reserved.has(b.id) || busy.has(b.id)) continue;
        if (!order.boxId && promised.has(b.id)) continue;
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
  // Internal move: a box goes from one rack to a rack in another zone (consolidation, as real warehouses do
  // between rushes). Keeps robots busy all over the building instead of waiting around the docks.
  function reslotJob(r) {
    if (Math.random() > .5 || robots.filter(o => o.task?.reslot).length >= ROBOTS * RESLOT_SHARE) return false;
    const s = getState();
    if (!s.racks.length) return false;
    refreshPoses();
    for (let attempt = 0; attempt < 4; attempt++) {
      const source = s.racks[Math.floor(Math.random() * s.racks.length)], poses = rackPoses.get(source.id) || [];
      if (!poses.length) continue;
      const box = poses[Math.floor(Math.random() * poses.length)].box;
      if (!boxInfo(box.id)?.actionable) continue;
      const dest = place(box);
      if (!dest || dest.rack.zone === source.zone) continue;
      const pickup = {...poseOf(box.id)};
      if (start(r, {box, source, target: dest.rack, slot: dest.loc, pickup, drop: shelfDrop(dest.rack, dest.loc, box, pickup), reslot: true})) return true;
    }
    return false;
  }
  function assign(r) {
    if (!getState().racks.length || !router || networkPending) return;
    const urgent = book.orders.some(o => o.priority === 'Urgent' && o.allocated.length < o.quantity);
    // User moves first, then alternate receiving and shipping per robot; a full dock or an urgent order jumps the line.
    const inboundFirst = !urgent && (waitingInbound() >= STATION_CAPACITY * 1.5 || r.cycles % 2 === 0);
    const jobs = inboundFirst ? [transferJob, inboundJob, outboundJob] : [transferJob, outboundJob, inboundJob];
    for (const job of jobs) if (job(r)) return;
    if (reslotJob(r)) return;
    r.status = book.pending ? (dispatchFull() ? 'Waiting for dispatch capacity' : 'Waiting for stock or route') : 'Waiting for work';
  }
  function balance() {
    const demand = waitingInbound() + book.pending + transfers.filter(t => t.status === 'Queued').length;
    const wanted = Math.min(ROBOTS, MIN_ACTIVE + Math.floor(demand / 4));
    robots.forEach((r, i) => {
      if (i < wanted && !r.active) { r.active = true; r.status = 'Idle'; r.retry = 0; note(`${r.id} joined the fleet`); }
      if (i >= wanted && r.active && !r.task && !r.charging && parked(r)) { r.active = false; r.status = 'Standby'; r.cargo.visible = false; note(`${r.id} returned to standby`); }
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
  // A charging pad glows under each robot while it charges at its parking spot.
  const padGeo = new T.CircleGeometry(2.2, 40).rotateX(-Math.PI / 2);
  for (const r of robots) {
    r.pad = new T.Mesh(padGeo, new T.MeshBasicMaterial({color: LIGHT.blue, transparent: true, opacity: 0, depthWrite: false, toneMapped: false}));
    r.pad.position.y = .06; r.pad.renderOrder = 4; r.pad.visible = false; r.pad.raycast = () => {}; r.g.add(r.pad);
    r.pitch = 0; r.turnDir = 0; r.accel = 0;
  }
  const rollerSpin = new T.Matrix4(), rollerMatrix = new T.Matrix4();
  function updateLights(dt) {
    clock += dt;
    for (const r of robots) {
      if (!r.active) {
        r.pitch = 0; r.body.rotation.x = 0; r.pad.visible = false;
        if (r.leds) for (const k of ['main', 'left', 'right']) light(r.leds[k], LIGHT.ready, .25);
        continue;
      }
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
      // The transfer's cross rollers rise while a box crosses.
      if (st.lift) {
        st.popping = Math.max(0, (st.popping || 0) - dt);
        st.pop += ((st.popping ? 1 : 0) - st.pop) * Math.min(1, dt * 10);
        st.lift.position.y = st.pop * .07;
      }
      // Rollers turn while the belt moves: inbound towards the robot, outbound away from it.
      if (st.moving && st.rollers) {
        st.rollerAngle += (st.kind === 'inbound' ? 1 : -1) * dt * BELT_SPEED / .14;
        const spin = rollerSpin.makeRotationY(st.rollerAngle);
        st.rollerBase.forEach((mat, i) => st.rollers.setMatrixAt(i, rollerMatrix.multiplyMatrices(mat, spin)));
        st.rollers.instanceMatrix.needsUpdate = true;
      }
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
  // Held points in CLEAR-sized cells, so a check looks at nearby robots only, not the whole fleet.
  // Rebuilt every frame; points let go of during the frame stay until then, which only makes robots wait.
  const holdGrid = new Map(), cellKey = (x, z) => (Math.floor(x / CLEAR) + 4096) * 8192 + Math.floor(z / CLEAR) + 4096;
  function addHold(o, q) { const k = cellKey(q.x, q.z); let list = holdGrid.get(k); if (!list) holdGrid.set(k, list = []); list.push(o, q); }
  function rebuildHolds() { holdGrid.clear(); for (const o of robots) for (const q of holds(o)) addHold(o, q); }
  function blocker(r, p) {
    const cx = Math.floor(p.x / CLEAR), cz = Math.floor(p.z / CLEAR);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const list = holdGrid.get((cx + dx + 4096) * 8192 + cz + dz + 4096);
      if (list) for (let i = 0; i < list.length; i += 2) if (list[i] !== r && Math.hypot(list[i + 1].x - p.x, list[i + 1].z - p.z) < CLEAR) return list[i];
    }
    return null;
  }
  function take(r, p) {
    if (holds(r).some(q => same(q, p))) return true;
    if (blocker(r, p)) return false;
    const q = {x: p.x, z: p.z}; r.ahead.push(q); addHold(r, q); return true;
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
      index();
      const i = s.boxes.indexOf(t.box);
      if (i >= 0) { s.boxes.splice(i, 1); indexRemove(t.box); indexedLength = s.boxes.length; }
      addresses(); addressRemove(t.box); countFlow(t.box.rack, 'out');
      reserved.delete(t.box.id);
      inventoryChanged(t.box.rack);
    } else {
      const st = t.sourceStation;
      st.g.remove(t.queueItem.mesh); st.queue.splice(st.queue.indexOf(t.queueItem), 1);
    }
    held.set(t.box.id, {box: t.box, where: 'transit', place: `${r.id} · In transit`, robot: r.id});
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
      index(); s.boxes.push(t.box); indexAdd(t.box); indexedLength = s.boxes.length; held.delete(t.box.id);
      addresses(); addressAdd(t.box); countFlow(t.target.id, 'in');
      if (t.sourceStation) stored++;
      if (t.transfer || t.queueItem?.user) finished.push({kind: t.transfer ? 'Move' : 'Receive', box: t.box, place: `${t.target.id} · ${t.slot}`, robot: r.id});
      if (t.transfer) t.transfer.status = 'Done';
      history(t.sourceStation ? 'Put away' : 'Moved', t.box, from, `${t.target.id} / ${t.slot}`);
      inventoryChanged(t.target.id);
    }
    note(`${t.box.id} delivered · ${r.to}`);
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
  // Standby robots stay on the floor: they drive to their parking spot (straight after loading the page they
  // wait in the corridors) and stand there until the fleet needs them, so no robot ever pops in or out.
  function standby(r, dt) {
    r.status = 'Standby';
    if (parked(r)) { r.speed = 0; return; }
    if (!r.path.length || !same(r.path.at(-1), r.home)) setPath(r, router.route(origin(r), r.home) || []);
    if (move(r, dt)) { r.path = []; r.index = 0; }
    r.status = 'Standby';
  }
  function updateRobot(r, dt) {
    if (!r.active) return standby(r, dt);
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
    if (networkJob) stepNetwork(6);
    balanceClock += dt;
    if (balanceClock >= 2) { balanceClock = 0; balance(); }
    generateDemand(dt);
    updateDocks(dt);
    rebuildHolds();
    for (const r of robots) updateRobot(r, dt);
    updateMarkers();
    updateLights(dt);
  }

  // ---------- read-only views for the UI ----------
  function boxInfo(id) {
    const shelf = index().byId.get(id), h = held.get(id);
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
    // Robots further than ROBOT_NEAR are drawn as one instanced batch of simple shapes, not as models.
    updateDetail(camera, show) {
      let bodies = 0, loads = 0;
      for (const r of robots) {
        const far = show && camera.distanceTo(r.g.position) > ROBOT_NEAR;
        r.body.visible = !far; if (r.cargo.children[0]) r.cargo.children[0].visible = !far;
        if (!far) continue;
        proxyObj.position.set(r.g.position.x, .75, r.g.position.z); proxyObj.rotation.set(0, r.g.rotation.y, 0); proxyObj.scale.set(2.7, 1.5, 3.2); proxyObj.updateMatrix();
        proxyBody.setMatrixAt(bodies++, proxyObj.matrix);
        if (r.cargo.visible) { proxyObj.position.y = 1.5 + r.cargo.scale.y / 2; proxyObj.scale.copy(r.cargo.scale); proxyObj.updateMatrix(); proxyLoad.setMatrixAt(loads++, proxyObj.matrix); }
      }
      proxyBody.count = bodies; proxyLoad.count = loads;
      proxyBody.instanceMatrix.needsUpdate = proxyLoad.instanceMatrix.needsUpdate = true;
    },
    // Names drawn as HTML tags over the 3D view: docks and the two buildings.
    mapTags() {
      const out = stations.map(st => ({key: st.id, text: st.id, kind: 'dock', x: st.g.position.x, y: 5, z: st.g.position.z}));
      if (spine) out.push({key: 'Receiving building', text: 'Receiving', kind: 'building', x: spine.x1 - BUILDING.length / 2, y: BUILDING.height + 3, z: 0},
        {key: 'Dispatch building', text: 'Dispatch', kind: 'building', x: spine.x2 + BUILDING.length / 2, y: BUILDING.height + 3, z: 0});
      return out;
    },
    // What the 3D view must redraw since it last asked: null, or {all} / {racks: Set of rack ids}.
    consumeVisualChange() {
      if (!cargoDirty) return null;
      const change = visualAll ? {all: true} : {racks: new Set(visualRacks)};
      cargoDirty = false; visualAll = false; visualRacks.clear();
      return change;
    },
    posesOf(rackIds) { refreshPoses(); return rackIds.flatMap(id => rackPoses.get(id) || []); },
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
      if (![...boxesOf(o.product)].some(b => !reserved.has(b.id) && (!o.boxId || b.id === o.boxId))) return 'Waiting for matching stock';
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
      const free = [...boxesOf(product)].filter(b => boxInfo(b.id)?.actionable).length;
      if (!Number.isInteger(qty) || qty < 1 || qty > free) throw Error(`Choose 1–${free} boxes.`);
      return Object.assign(book.create(product, qty, 'Normal'), {user: true, station});
    },
    inStock(product) { return [...boxesOf(product)].filter(b => boxInfo(b.id)?.actionable).length; },
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
