import * as T from 'three';
import {locations, boxLayout} from './storage.js';
import {products as catalog} from './model.js';
import {createOrderBook} from './order-book.js';
import {createRouter} from './robot-routing.js';

// The simulation owns the inventory: robots change `state.boxes` directly.
// Boxes on shelves live in `state.boxes`; boxes at a dock or on a robot live in `held`.
// Nothing is saved — a reload starts the demo again.

const ROBOTS = 8;
const MIN_ACTIVE = 4;
const STATION_CAPACITY = 6;
const MAX_PER_ADDRESS = 16;
const HANDOFF_SECONDS = 3;
const DISPATCH_SECONDS = 21;
const SPEED = 9;
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
  const held = new Map();     // box id -> {box, where: receiving|transit|dispatch, place}
  const reserved = new Set(); // shelf boxes promised to a robot
  const claims = new Map();   // address -> {product, count} for boxes on their way

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
    revision++;
  }
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
    const start = Math.floor(Math.random() * Math.max(1, s.racks.length));
    for (let i = 0; i < s.racks.length && score > 1; i++) {
      const r = s.racks[(start + i) % s.racks.length];
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
  function label(parent, text, x, y, z) {
    const c = document.createElement('canvas'); c.width = 512; c.height = 96;
    const t = c.getContext('2d');
    t.fillStyle = '#fafbf5'; t.fillRect(0, 0, 512, 96); t.fillStyle = '#30372f'; t.font = '500 42px Arial'; t.textAlign = 'center'; t.fillText(text, 256, 62);
    const sp = new T.Sprite(new T.SpriteMaterial({map: new T.CanvasTexture(c), depthTest: true, toneMapped: false}));
    sp.scale.set(5.5, 1.05, 1); sp.position.set(x, y, z); parent.add(sp); return sp;
  }

  for (let i = 0; i < ROBOTS; i++) {
    const g = new T.Group(), id = `AMR-0${i + 1}`;
    group.add(g);
    box(g, 0, .7, 0, 2.6, 1.1, 3.4, yellow); box(g, 0, 1.35, 0, 2.3, .22, 2.8, black);
    for (const x of [-1.2, 1.2]) for (const z of [-1, 1]) box(g, x, .35, z, .35, .65, .8, black);
    box(g, 0, 1.58, 1.35, .6, .25, .35, green); box(g, 0, 3, -1.1, .25, 5.2, .3, silver);
    const cargo = box(g, 0, 2.1, 0, 1.7, 1.3, 1.9, boxMat); box(cargo, 0, .51, 0, .12, .02, 1.01, silver); cargo.visible = false;
    label(g, id, 0, 4, 0);
    const hit = box(g, 0, 1.7, 0, 3.1, 3.5, 3.8, new T.MeshBasicMaterial({visible: false}));
    hit.userData = {type: 'robot', id}; hits.push(hit);
    robots.push({id, g, cargo, active: i < MIN_ACTIVE, status: 'Idle', battery: 92 - i * 5, paused: false, chargeNext: false,
      charging: false, cycles: 0, task: null, path: [], index: 0, retry: i * .3, product: '', boxId: '', mission: ''});
  }
  for (let i = 0; i < 4; i++) {
    const g = new T.Group(), kind = i < 2 ? 'inbound' : 'outbound', id = `${i < 2 ? 'Receiving' : 'Dispatch'} ${i % 2 + 1}`;
    group.add(g);
    box(g, 0, .12, 0, 12, .24, 9, new T.MeshStandardMaterial({color: i < 2 ? '#d6e5ce' : '#e9dfb3', roughness: 1}));
    box(g, 0, .18, 7, 12, .12, 5, silver);
    label(g, id, 0, 3.8, 5).scale.set(9, 1.5, 1);
    stations.push({g, id, kind, ready: true, queue: [], port: {x: 0, z: 0}});
  }
  const pickupMarker = new T.Mesh(geo, new T.MeshBasicMaterial({color: '#ffd900', wireframe: true, depthTest: false}));
  const dropMarker = new T.Mesh(geo, new T.MeshBasicMaterial({color: '#6c9ee8', wireframe: true, depthTest: false}));
  pickupMarker.renderOrder = dropMarker.renderOrder = 15;
  const routeLine = new T.Line(new T.BufferGeometry(), new T.LineBasicMaterial({color: '#baa51a', transparent: true, opacity: .6}));
  group.add(pickupMarker, dropMarker, routeLine);

  // ---------- docks ----------
  const freeSlot = st => Array.from({length: STATION_CAPACITY}, (_, i) => i).find(i => !st.queue.some(q => q.slot === i));
  function stationPose(st, q) {
    const local = q.local;
    return {...local, box: q.box, x: st.g.position.x + local.x, z: st.g.position.z + local.z};
  }
  function localPose(slot, size) {
    return {x: (slot % 3 - 1) * 2.5, y: .24 + size.h / 2, z: (Math.floor(slot / 3) - .5) * 2.7, w: size.w, h: size.h, d: size.d};
  }
  function arrivalSize() {
    const rack = getState().racks[0];
    if (!rack) return {w: 1.6, h: 1.4, d: 1.8};
    const p = boxLayout(rack, Array.from({length: 4}, (_, i) => ({id: 'size-' + i, product: '', location: locations(rack)[0]})))[0];
    return {w: p.w, h: p.h, d: p.d};
  }
  function arrive(item) {
    const st = stations.filter(s => s.kind === 'inbound' && s.ready && s.queue.length < STATION_CAPACITY)
      .sort((a, b) => a.queue.length - b.queue.length)[0];
    if (!st) return false;
    const s = getState();
    const b = {id: `BX-${String(++s.serial).padStart(6, '0')}`, product: item.product, rack: 'receiving', location: st.id, receivedAt: new Date().toISOString(), doc: `inv. ${2060 + Math.floor(s.serial / 12) % 900}`};
    const slot = freeSlot(st), local = localPose(slot, arrivalSize());
    const mesh = box(st.g, local.x, local.y, local.z, local.w, local.h, local.d, boxMat);
    box(mesh, 0, .51, 0, .12, .02, 1.01, silver);
    const q = {box: b, slot, local, mesh, age: 0, arrived: true, target: item.target || null, taken: false};
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
      for (const q of [...st.queue]) {
        if (!q.arrived) continue;
        q.age += dt;
        if (st.kind === 'inbound') { q.mesh.position.z = q.local.z + Math.max(0, 1 - q.age) * 6; continue; }
        if (q.age > DISPATCH_SECONDS - 3) q.mesh.position.z = q.local.z + Math.min(1, (q.age - DISPATCH_SECONDS + 3) / 3) * 9;
        if (q.age >= DISPATCH_SECONDS) {
          st.g.remove(q.mesh); st.queue.splice(st.queue.indexOf(q), 1); held.delete(q.box.id);
          shipped++; getState().today.shipped++; book.ship(q.box.id);
          history('Shipped', q.box, st.id, 'Customer');
          pruneOrders();
        }
      }
    }
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
    if (arrivalClock >= (low ? 7 : high ? 16 : 10)) {
      arrivalClock = 0;
      if (backlog.length < STATION_CAPACITY) backlog.push({product: pick(catalog)});
    }
    orderClock += dt;
    if (orderClock >= 8) {
      orderClock = 0;
      const stockList = stockedProducts();
      if (stockList.length && book.pending < (high ? 10 : low ? 3 : 6)) {
        const o = book.create(pick(stockList), 1 + Math.floor(Math.random() * 5), Math.random() < .15 ? 'Urgent' : 'Normal');
        note(`${o.id} · ${o.quantity} × ${o.product}${o.priority === 'Urgent' ? ' · urgent' : ''}`);
      }
    }
  }

  // ---------- layout changes ----------
  function checkLayout() {
    const s = getState();
    const k = JSON.stringify(s.racks.map(r => [r.id, r.x, r.z, r.width, r.depth, r.height, r.shelves, r.places, r.rotation || 0]));
    if (k === rackKey) return;
    const first = rackKey === null;
    rackKey = k; posesDirty = true; cargoDirty = true; revision++;
    router = createRouter(s.racks);
    const edge = s.racks.length ? Math.max(...s.racks.map(r => r.z + r.depth / 2)) : 30;
    const xs = s.racks.map(r => r.x), center = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0;
    anchor = {x: center - 27, z: edge + 10};
    stations.forEach((st, i) => { st.g.position.set(anchor.x + i * 18, 0, anchor.z + 6); st.port = {x: anchor.x + i * 18, z: anchor.z}; });
    if (first) {
      robots.forEach((r, i) => { const p = router.point({x: anchor.x + (i % 4) * 18, z: anchor.z - (i >= 4 ? 6 : 0)}); if (p) r.g.position.set(p.x, 0, p.z); });
      for (let i = 0; i < 4; i++) backlog.push({product: pick(catalog)});
      note('Receiving and dispatch connected to the rack layout');
    } else {
      for (const r of robots) if (r.task) replan(r);
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
      r.path = router.route(r.g.position, r.stage === 'To pickup' ? from : to) || [];
      r.index = 0; r.routeBlocked = !r.path.length;
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
    const path = router.route(r.g.position, from), carry = router.route(from, to);
    if (!path || !carry) return false;
    if (t.source) reserved.add(t.box.id);
    if (t.queueItem) t.queueItem.taken = true;
    if (t.target) claim(t.target, t.slot, t.box.product);
    if (t.order) book.reserve(t.order, t.box.id);
    if (t.transfer) t.transfer.status = 'In progress';
    if (t.outStation) {
      const slot = freeSlot(t.outStation), local = localPose(slot, t.pickup);
      const mesh = box(t.outStation.g, local.x, local.y, local.z, local.w, local.h, local.d, boxMat);
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
    r.routeBlocked = false; r.path = path; r.index = 0; r.stage = 'To pickup'; r.status = r.stage; r.timer = 0; r.cargo.visible = false;
    note(`${r.mission} · ${t.box.id} · ${r.from} → ${r.to}`);
    return true;
  }
  function inboundJob(r) {
    for (const st of stations.filter(s => s.kind === 'inbound' && s.ready)) for (const q of st.queue) {
      if (q.age < 1 || q.taken) continue;
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
      const pickup = {...poseOf(b.id)}, source = s.racks.find(x => x.id === b.rack), dest = place(b, transfer, true);
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
      let best = null, distance = Infinity;
      for (const b of s.boxes) {
        if (reserved.has(b.id) || busy.has(b.id) || b.product !== order.product) continue;
        if (order.boxId ? b.id !== order.boxId : promised.has(b.id)) continue;
        const p = poseOf(b.id); if (!p) continue;
        const d = Math.hypot(p.x - r.g.position.x, p.z - r.g.position.z);
        if (d < distance) { distance = d; best = b; }
      }
      if (!best) continue;
      const source = s.racks.find(x => x.id === best.rack);
      if (start(r, {box: best, source, outStation: st, order, pickup: {...poseOf(best.id)}})) return true;
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
      if (i >= wanted && r.active && !r.task && !r.charging) { r.active = false; r.status = 'Standby'; r.cargo.visible = false; note(`${r.id} returned to standby`); }
      r.g.visible = r.active;
    });
  }

  // ---------- robot motion ----------
  function move(r, dt) {
    if (r.routeBlocked) { r.status = 'Route blocked'; return false; }
    const p = r.path[r.index];
    if (!p) return true;
    const dx = p.x - r.g.position.x, dz = p.z - r.g.position.z, d = Math.hypot(dx, dz);
    if (d < .08) { r.index++; return r.index >= r.path.length; }
    const step = Math.min(d, dt * SPEED), nx = r.g.position.x + dx / d * step, nz = r.g.position.z + dz / d * step;
    if (robots.some(o => o.active && o !== r && Math.hypot(o.g.position.x - nx, o.g.position.z - nz) < 3.7)) {
      r.status = 'Waiting for traffic'; r.wait = (r.wait || 0) + dt;
      if (r.wait > 2 + robots.indexOf(r)) {
        r.wait = 0;
        const others = robots.filter(o => o.active && o !== r).map(o => ({x: o.g.position.x, z: o.g.position.z, width: 3, depth: 3}));
        const detour = createRouter([...getState().racks, ...others]).route(r.g.position, r.path.at(-1));
        if (detour) { r.path = detour; r.index = 0; }
      }
      return false;
    }
    r.wait = 0;
    r.g.rotation.y = Math.atan2(dx, dz); r.g.position.set(nx, 0, nz);
    return false;
  }
  function transferPose(r, t) {
    const p = r.stage === 'Loading' ? r.task.pickup : r.task.drop;
    const shelf = new T.Vector3(p.x, p.y, p.z), deck = r.g.localToWorld(new T.Vector3(0, 1.5 + r.task.pickup.h / 2, 0));
    const v = t * t * (3 - 2 * t), world = r.stage === 'Loading' ? shelf.lerp(deck, v) : deck.lerp(shelf, v);
    r.cargo.position.copy(r.g.worldToLocal(world)); r.cargo.scale.set(r.task.pickup.w, r.task.pickup.h, r.task.pickup.d);
    r.cargo.quaternion.copy(r.g.quaternion).invert();
  }
  function pickUp(r) {
    const t = r.task, s = getState();
    if (t.source) {
      const i = s.boxes.indexOf(t.box);
      if (i >= 0) s.boxes.splice(i, 1);
      addresses(); addressRemove(t.box);
      reserved.delete(t.box.id);
      inventoryChanged(t.box.rack);
    } else {
      const st = t.sourceStation;
      st.g.remove(t.queueItem.mesh); st.queue.splice(st.queue.indexOf(t.queueItem), 1);
    }
    held.set(t.box.id, {box: t.box, where: 'transit', place: `${r.id} · In transit`, robot: r.id});
    r.cargo.visible = true;
  }
  function putDown(r) {
    const t = r.task, s = getState();
    if (t.output) {
      t.output.arrived = true; t.output.mesh.visible = true; t.output.age = 0;
      held.set(t.box.id, {box: t.box, where: 'dispatch', place: t.outStation.id});
      book.stage(t.box.id);
      revision++;
    } else {
      unclaim(t.target, t.slot);
      const from = t.sourceStation ? t.sourceStation.id : `${t.box.rack} / ${t.box.location}`;
      t.box.rack = t.target.id; t.box.location = t.slot;
      s.boxes.push(t.box); held.delete(t.box.id);
      addresses(); addressAdd(t.box);
      if (t.sourceStation) stored++;
      if (t.transfer) t.transfer.status = 'Done';
      history(t.sourceStation ? 'Put away' : 'Moved', t.box, from, `${t.target.id} / ${t.slot}`);
      inventoryChanged(t.target.id);
    }
    note(`${t.box.id} delivered · ${r.to}`);
    r.cycles++; delivered++; r.task = null; r.cargo.visible = false;
    if (r.chargeNext || r.battery < 25) { r.charging = true; r.chargeNext = false; }
  }
  function updateRobot(r, dt) {
    if (!r.active) { r.status = 'Standby'; return; }
    if (r.paused) { r.status = 'Paused'; return; }
    if (r.charging) {
      r.status = 'Charging'; r.battery = Math.min(100, r.battery + dt * 3);
      if (r.battery === 100) r.charging = false;
      return;
    }
    if (!r.task) {
      r.retry -= dt;
      if (r.retry <= 0) { r.retry = 1; if (r.battery < 25) r.charging = true; else assign(r); }
      return;
    }
    const t = r.task;
    if (t.outStation && !t.outStation.ready || t.sourceStation && !t.sourceStation.ready && r.stage === 'To pickup') { r.status = 'Waiting for station'; return; }
    r.status = r.stage; r.battery = Math.max(5, r.battery - dt * .02);
    if (r.stage === 'To pickup' || r.stage === 'Transporting') {
      if (move(r, dt)) { r.stage = r.stage === 'To pickup' ? 'Loading' : 'Unloading'; r.timer = 0; }
      return;
    }
    if (r.stage === 'Loading' && r.timer === 0) pickUp(r);
    r.timer += dt;
    transferPose(r, Math.min(1, r.timer / HANDOFF_SECONDS));
    if (r.timer < HANDOFF_SECONDS) return;
    if (r.stage === 'Loading') {
      r.stage = 'Transporting'; r.path = t.carry || []; r.routeBlocked = !t.carry; r.index = 0;
      r.cargo.position.set(0, 1.5 + t.pickup.h / 2, 0); r.cargo.quaternion.identity();
    } else putDown(r);
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
      for (let i = 0; i < qty; i++) backlog.push({product, target});
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
      return book.create(b.product, 1, 'Normal', id);
    },
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
      return r ? r.g.position.clone() : new T.Vector3(anchor.x + 24, 0, anchor.z + 13);
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
