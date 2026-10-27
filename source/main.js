import './figma.css';
import {overviewHTML} from './phoenix-panel.js';
import {installHistoryPage} from './phoenix-history.js';
import {installInventoryPage} from './inventory-page.js';
import {installRobotPanels} from './robot-panels.js';
import {installBuilderTools} from './builder-tools.js';
import {validateLayoutAccess, inaccessibleRacks} from './layout-access.js';
import {applyLayoutEdit} from './layout-edit.js';
import {contains} from './zone-shape.js';
import {seed, products, addZone, addRack, updateRack, log} from './model.js';
import {templates, config, locations, validateConfig} from './storage.js';
import {createScene} from './scene.js';
import {placeChooser} from './choose-place.js';

// Concept demo: everything lives in memory and the robot simulation always runs.
// A reload starts the demo warehouse again.
const state = seed();
let selected = null, editing = false, undo = [], rackDraft = config(templates.standard);
let allZones = false, allRackBoxes = false, lastPanelHTML = '', occupancyOn = false;

const $ = s => document.querySelector(s);
const fmt = n => n.toLocaleString('en-US');
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const icon = name => `<img class="fg-ic" src="/assets/fg/${name}.svg" alt="">`;

$('#app').innerHTML = `<main>
 <div id="scene"></div>
 <div class="ph-topbar">
  <div class="ph-account"><button class="ph-avatar-btn" aria-label="View menu"><img src="/assets/fg/avatar-face.svg" alt=""></button></div>
  <nav class="ph-nav" aria-label="Main navigation">
   <button class="nav active" id="warehouse" title="Warehouse" aria-label="Warehouse">${icon('grid')}</button>
   <button class="nav" id="inventory" title="Inventory" aria-label="Inventory">${icon('cube')}</button>
   <div class="ph-search"><button type="button" id="phSearchButton" aria-label="Search warehouse">${icon('search')}</button><input id="search" placeholder="Search product, box or location…" autocomplete="off"><kbd>⌘K</kbd><div id="results" hidden></div></div>
   <button class="nav" data-robot-view="Live floor" title="Live floor" aria-label="Live floor">${icon('bolt')}</button>
   <button class="nav" id="historyAll" title="Activity history" aria-label="Activity history">${icon('clock')}</button>
  </nav>
  <div class="ph-actions"><button id="ship">Ship</button><button id="receive" class="primary">Receive</button></div>
 </div>
 <div id="viewMenu" hidden><button class="vm-row" data-vm="occ"><span>Occupancy</span><img id="vmSwitch" src="/assets/fg/switch-off.svg" alt=""></button>${['Zones', 'Robots', 'Labels'].map(name => `<button class="vm-row" data-vm="${name.toLowerCase()}" data-layer><span>${name}</span><img src="/assets/fg/switch-on.svg" alt=""></button>`).join('')}<div class="vm-div"></div><button class="vm-row" data-vm="edit"><span>Edit warehouse layout</span>${icon('open')}</button></div>
 <aside class="right card" id="overview"></aside>
 <div id="editor" hidden><div><strong>Build mode</strong><span id="modeHint"></span></div><button data-mode="browse" class="chosen">Select</button><button data-mode="zone">Rectangle</button><button data-mode="polygon">Custom zone</button><button id="finishZone" hidden>Close zone</button><button data-mode="rack">Place racks</button><button id="undo">Undo</button><button id="topView">Top view</button><button id="done">Finish building</button></div>
 <div id="buildInfo" hidden><span class="eyebrow">Warehouse builder</span><h2>Make room for what’s next.</h2><p>Draw zones, then place racks. Changes last until you reload the page.</p><span class="rack-cap">Rack catalog</span><div id="rackCatalog"></div><div id="buildSelection"></div></div>
 <div id="toast" role="status"></div>
 <dialog id="dialog"></dialog>
</main>`;

const scene = createScene($('#scene'), () => state, pick, draw);
const sim = scene.robotics;
const live = () => sim.dashboard(state);

function toast(text) {
  $('#toast').textContent = text; $('#toast').classList.add('visible');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('visible'), 4000);
}

// ---------- layout changes (with session undo) ----------
const layoutSnapshot = () => JSON.stringify({zones: state.zones, racks: state.racks});
function commit(fn) {
  const before = layoutSnapshot();
  try {
    fn();
    validateLayoutAccess(JSON.parse(before).racks, state.racks);
  } catch (e) {
    Object.assign(state, JSON.parse(before));
    toast(e.message);
    if ($('#dialog').open && $('#error')) $('#error').textContent = e.message;
    return false;
  }
  undo.push(before); undo = undo.slice(-10);
  refresh();
  return true;
}
function undoLast() {
  if (!undo.length) return toast('Nothing to undo.');
  const prev = JSON.parse(undo.at(-1)), racks = new Map(prev.racks.map(r => [r.id, r]));
  if (state.boxes.some(b => !racks.has(b.rack) || !locations(racks.get(b.rack)).includes(b.location)))
    return toast('Can’t undo: robots already stored boxes where this change would remove space.');
  undo.pop();
  state.zones = prev.zones; state.racks = prev.racks; selected = null;
  refresh(); toast('Last change undone.');
}

// ---------- selection and right panel ----------
function exists(sel) {
  if (!sel) return true;
  if (sel.type === 'zone') return state.zones.some(z => z.id === sel.id);
  if (sel.type === 'rack') return state.racks.some(r => r.id === sel.id);
  if (sel.type === 'location') { const [rid, loc] = sel.id.split('|'), r = state.racks.find(r => r.id === rid); return !!r && locations(r).includes(loc); }
  return state.boxes.some(b => b.id === sel.id);
}
function pick(s) {
  $('#results').hidden = true; historyPage?.close(); inventoryPage?.close();
  if (s?.type === 'box' && !editing) return robotPanels.openBox(s.id);
  if (s?.type === 'robot') return robotPanels.open('Live floor', s.id);
  robotPanels.close(); $('#inventory').classList.remove('active');
  selected = s;
  scene.select(s, !editing); renderPanel(); renderBuildSelection();
}
function refresh() {
  if (!exists(selected)) selected = null;
  scene.rebuild(); scene.select(selected, false); renderPanel(); renderBuildSelection();
}
function renderPanel() {
  const view = $('#overview');
  if (!exists(selected)) selected = null;
  const panelScroll = view.scrollTop, listScroll = view.querySelector('.ph-list')?.scrollTop || 0, gridOpen = view.querySelector('details')?.open;
  const html = overviewHTML(live(), selected?.type === 'box' ? null : selected, allZones, allRackBoxes, inaccessibleRacks(state.racks));
  if (html === lastPanelHTML) return;
  lastPanelHTML = html; view.innerHTML = html; view.classList.toggle('home', !selected);
  view.scrollTop = panelScroll;
  if (view.querySelector('.ph-list')) view.querySelector('.ph-list').scrollTop = listScroll;
  if (view.querySelector('details')) view.querySelector('details').open = !!gridOpen;
  $('#allZones')?.addEventListener('click', () => { allZones = !allZones; renderPanel(); });
  $('#allRackBoxes')?.addEventListener('click', () => { allRackBoxes = !allRackBoxes; renderPanel(); });
  $('#showSelected')?.addEventListener('click', () => scene.select(selected, true));
  view.querySelectorAll('[data-stat]').forEach(b => b.onclick = () => b.dataset.stat === '3' ? (inventoryPage.open(), inventoryPage.showUnplaced()) : showHistory(['Received', 'Shipped', 'Moved'][Number(b.dataset.stat)]));
  view.querySelectorAll('[data-pick]').forEach(el => el.onclick = () => pick({type: el.dataset.pick, id: el.dataset.id}));
  view.querySelector('[data-root]')?.addEventListener('click', () => pick(null));
  $('#moveSelection')?.addEventListener('click', movePhoenix);
  $('#receiveHere')?.addEventListener('click', () => receivePhoenix());
}

// ---------- dialogs: Receive and Move hand work to the robots ----------
function modal(title, body, onSubmit) {
  const d = $('#dialog');
  d.innerHTML = `<form><div class="title"><h2>${title}</h2><button type="button" class="icon" id="closeDialog" aria-label="Close">${icon('close')}</button></div>${body}<p class="form-error" id="error"></p></form>`;
  $('#closeDialog').onclick = () => d.close();
  d.querySelector('form').onsubmit = e => { e.preventDefault(); onSubmit?.(new FormData(e.target)); };
  if (!d.open) d.showModal();
}
function addressMap() {
  const m = new Map();
  for (const b of state.boxes) { const k = b.rack + '|' + b.location, a = m.get(k); if (a) a.count++; else m.set(k, {product: b.product, count: 1}); }
  return m;
}
const zoneColor = rid => state.zones.find(z => z.id === state.racks.find(r => r.id === rid)?.zone)?.color || '#82c0fa';
function placeButton(c, note) {
  return `<button type="button" class="ph-place-option" data-rack="${esc(c.rack)}" data-loc="${esc(c.loc)}"><i style="background:${zoneColor(c.rack)}"></i><span><strong>${esc(c.rack)} · ${esc(c.loc)}</strong><small>${note}</small></span><em>${c.count ? c.count + (c.count === 1 ? ' box' : ' boxes') : 'Empty'}</em></button>`;
}
function bindPlaces(container, getChoice, setChoice) {
  container.querySelectorAll('button').forEach(b => {
    const c = getChoice();
    b.classList.toggle('chosen', c?.rack === b.dataset.rack && c.loc === b.dataset.loc);
    b.onclick = () => setChoice({rack: b.dataset.rack, loc: b.dataset.loc});
  });
}

function receivePhoenix(preset = {}) {
  if (!state.racks.length) return toast('Add a rack before receiving boxes.');
  const parts = selected?.type === 'location' ? selected.id.split('|') : null;
  let choice = preset.choice || (parts ? {rack: parts[0], loc: parts[1]} : null);
  modal('Receive boxes', `<div class="ph-receive"><label>Product<select name="product" id="receiptProduct">${products.map(p => `<option>${esc(p)}</option>`).join('')}</select></label><label>Boxes<input name="qty" type="number" min="1" max="48" value="1" required></label><span class="ph-field-label">Place</span><div id="receiptSuggestions"></div><button type="button" class="ph-wide" id="chooseOther">Choose another place</button><p class="helper">Boxes arrive at Receiving; robots put them away.</p><button class="primary wide" type="submit">Confirm receipt</button></div>`, fd => {
    const qty = Number(fd.get('qty')), product = fd.get('product');
    try { sim.receive(product, qty, choice); } catch (e) { $('#error').textContent = e.message; return; }
    $('#dialog').close();
    toast(`${qty} ${qty === 1 ? 'box' : 'boxes'} arriving at Receiving · robots will store ${choice ? `at ${choice.rack} / ${choice.loc}` : 'them'}`);
  });
  const suggestions = () => {
    const product = $('#receiptProduct').value, map = addressMap(), candidates = [];
    for (const rack of state.racks) for (const loc of locations(rack)) {
      const a = map.get(rack.id + '|' + loc);
      if (a && a.product !== product) continue;
      candidates.push({rack: rack.id, loc, count: a?.count || 0});
    }
    candidates.sort((a, b) => (b.count > 0) - (a.count > 0) || a.count - b.count || a.rack.localeCompare(b.rack));
    if (choice && !candidates.some(c => c.rack === choice.rack && c.loc === choice.loc)) choice = null;
    if (!choice) choice = candidates[0] || null;
    const list = candidates.slice(0, 3);
    if (choice && !list.some(c => c.rack === choice.rack && c.loc === choice.loc)) list.unshift(candidates.find(c => c.rack === choice.rack && c.loc === choice.loc));
    return list.slice(0, 3);
  };
  const render = () => {
    const box = $('#receiptSuggestions');
    box.innerHTML = suggestions().map((c, i) => placeButton(c, i === 0 ? `Recommended · ${c.count ? 'same product is here' : 'free address'}` : c.count ? 'Same product is here' : 'Free address')).join('') || '<p class="helper">No compatible storage address.</p>';
    bindPlaces(box, () => choice, c => { choice = c; render(); });
  };
  if (preset.product) $('#receiptProduct').value = preset.product;
  if (preset.qty) $('#dialog [name=qty]').value = preset.qty;
  $('#receiptProduct').onchange = () => { choice = null; render(); };
  $('#chooseOther').onclick = () => {
    const keep = {product: $('#receiptProduct').value, qty: $('#dialog [name=qty]').value, choice};
    placeChooser({dialog: $('#dialog'), state, product: keep.product, onPick: c => receivePhoenix({...keep, choice: c}), onBack: () => receivePhoenix(keep),
      onMap: () => { $('#dialog').close(); toast('Select an address on the map, then press Receive.'); }});
  };
  render();
}

function movePhoenix(preset = {}) {
  const at = (rack, loc) => state.boxes.filter(b => b.rack === rack && b.location === loc);
  let first = null;
  if (selected?.type === 'box') first = state.boxes.find(b => b.id === selected.id);
  else if (selected?.type === 'location') { const [rack, loc] = selected.id.split('|'); first = at(rack, loc)[0]; }
  else if (selected?.type === 'rack') first = state.boxes.find(b => b.rack === selected.id);
  if (!first) return toast('Choose a box or an occupied address first.');
  const source = at(first.rack, first.location).filter(b => sim.boxInfo(b.id)?.actionable);
  if (!source.length) return toast('These boxes are already busy with robot work.');
  if (selected?.type === 'box' && source.includes(first)) source.splice(source.indexOf(first), 1), source.unshift(first);
  const from = state.racks.find(r => r.id === first.rack), map = addressMap(), candidates = [];
  for (const r of state.racks) for (const loc of locations(r)) {
    const a = map.get(r.id + '|' + loc);
    if (r.id === first.rack && loc === first.location || a && a.product !== first.product) continue;
    candidates.push({rack: r.id, loc, count: a?.count || 0, dist: Math.hypot(r.x - from.x, r.z - from.z)});
  }
  candidates.sort((a, b) => a.dist - b.dist || a.count - b.count);
  let choice = preset.choice || candidates[0] || null;
  modal('Move boxes', `<div class="ph-receive"><span class="ph-field-label">From</span><div class="ph-place-option"><i></i><span><strong>${esc(first.product)}</strong><small>${esc(first.rack)} · ${esc(first.location)}</small></span><em>${source.length} available</em></div><label>Boxes to move<input name="qty" type="number" min="1" max="${source.length}" value="1" required></label><span class="ph-field-label">To</span><div id="moveSuggestions"></div><button type="button" class="ph-wide" id="chooseOther">Choose another place</button><button class="primary wide" type="submit">Confirm move</button></div>`, fd => {
    const qty = Number(fd.get('qty'));
    if (!choice || !Number.isInteger(qty) || qty < 1 || qty > source.length) { $('#error').textContent = 'Select a destination and a valid number of boxes.'; return; }
    try { sim.requestMove(source.slice(0, qty).map(b => b.id), choice.rack, choice.loc); } catch (e) { $('#error').textContent = e.message; return; }
    $('#dialog').close();
    toast(`Robots will move ${qty} ${qty === 1 ? 'box' : 'boxes'} to ${choice.rack} / ${choice.loc}`);
  });
  const render = () => {
    const box = $('#moveSuggestions');
    const shown = choice && !(candidates[0]?.rack === choice.rack && candidates[0]?.loc === choice.loc)
      ? [{...choice, count: map.get(choice.rack + '|' + choice.loc)?.count || 0}] : candidates.slice(0, 1);
    box.innerHTML = shown.map(c => placeButton(c, `Recommended · ${c.count ? 'same product is here' : 'closest free address'}`)).join('') || '<p class="helper">No compatible destination.</p>';
    bindPlaces(box, () => choice, c => { choice = c; render(); });
  };
  if (preset.qty) $('#dialog [name=qty]').value = preset.qty;
  $('#chooseOther').onclick = () => {
    const keep = {qty: $('#dialog [name=qty]').value, choice};
    placeChooser({dialog: $('#dialog'), state, product: first.product, exclude: {rack: first.rack, loc: first.location},
      onPick: c => movePhoenix({...keep, choice: c}), onBack: () => movePhoenix(keep),
      onMap: () => { $('#dialog').close(); toast('Select a destination address on the map, then press Move.'); }});
  };
  render();
}

// ---------- build mode ----------
function rackFields(c) {
  const fields = [['width', 'Width (m)'], ['depth', 'Depth (m)'], ['height', 'Height (m)'], ['shelves', 'Shelves'], ['places', 'Locations / shelf']];
  return `<label>Template<select id="templateChoice"><option value="custom">Custom</option>${Object.entries(templates).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join('')}</select></label><div class="rack-fields">${fields.map(([k, label]) => {
    const whole = k === 'shelves' || k === 'places';
    return `<label>${label}<input name="${k}" type="number" min="1" max="${whole ? 12 : 20}" step="${whole ? 1 : .1}" value="${c[k]}" required></label>`;
  }).join('')}</div><p class="helper" id="locationTotal">${c.shelves * c.places} storage locations.</p>`;
}
function configureRack(id = null) {
  const r = id ? state.racks.find(r => r.id === id) : rackDraft;
  modal(id ? 'Configure ' + esc(id) : 'Rack to place', rackFields(config(r)) + `<p class="helper">${id ? 'Empty locations before removing them.' : 'These settings apply to new racks you place.'}</p><button class="primary wide">${id ? 'Save rack' : 'Use this rack'}</button>`, fd => {
    const c = Object.fromEntries(['width', 'depth', 'height', 'shelves', 'places'].map(k => [k, Number(fd.get(k))]));
    try {
      validateConfig(c);
      if (id) { if (!commit(() => updateRack(state, id, c))) return; }
      else { rackDraft = c; scene.setRackConfig(c); renderCatalog(); }
      $('#dialog').close();
    } catch (e) { $('#error').textContent = e.message; }
  });
  const total = () => $('#locationTotal').textContent = Number($('#dialog [name="shelves"]').value) * Number($('#dialog [name="places"]').value) + ' storage locations.';
  $('#templateChoice').onchange = e => {
    const t = templates[e.target.value];
    if (t) { for (const k of ['width', 'depth', 'height', 'shelves', 'places']) $('#dialog').querySelector(`[name="${k}"]`).value = t[k]; total(); }
  };
  $('#dialog').querySelectorAll('input').forEach(el => el.oninput = total);
}
function renderCatalog() {
  $('#rackCatalog').innerHTML = `${Object.entries(templates).map(([k, t]) => `<button data-template="${k}" class="fg-tmpl ${['width', 'depth', 'height', 'shelves', 'places'].every(p => rackDraft[p] === t[p]) ? 'chosen' : ''}"><i></i><span>${t.label}</span><em>${t.width} × ${t.depth} × ${t.height} m</em></button>`).join('')}<button id="draftConfigure" class="outline">Customize dimensions</button>`;
  $('#rackCatalog').querySelectorAll('[data-template]').forEach(b => b.onclick = () => { rackDraft = config(templates[b.dataset.template]); scene.setRackConfig(rackDraft); renderCatalog(); });
  $('#draftConfigure').onclick = () => configureRack();
}
const hints = {
  polygon: 'Click corners · Enter to close · Backspace undo corner · Esc cancel',
  zone: 'Drag on empty ground · Right-drag to pan · Scroll to zoom',
  rack: 'Click repeatedly to place · Snap to neighbours · Alt disables snap · Red = blocked',
  browse: 'Select an object to inspect or remove it.',
};
function setMode(m) {
  scene.setMode(m);
  if (editing && m === 'browse') builderTools.select();
  $('#finishZone').hidden = m !== 'polygon';
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('chosen', b.dataset.mode === m));
  $('#modeHint').textContent = hints[m];
}
function renderBuildSelection() {
  const s = selected, el = $('#buildSelection');
  if (!editing || !s || !['zone', 'rack'].includes(s.type)) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="build-object"><strong>${s.type === 'zone' ? esc(state.zones.find(z => z.id === s.id)?.name || s.id) : 'Rack ' + esc(s.id)}</strong><p>Selected on the plan</p>${s.type === 'zone' ? '<button id="buildRename">Rename</button>' : '<button id="buildConfigure">Configure rack</button>'}<button id="buildDelete">Remove empty object</button></div>`;
  $('#buildConfigure')?.addEventListener('click', () => configureRack(s.id));
  $('#buildRename')?.addEventListener('click', renameZone);
  $('#buildDelete')?.addEventListener('click', removeSelected);
}
function toggleEdit(value) {
  if (value) { robotPanels.close(); historyPage.close(); inventoryPage.close(); setOccupancy(false); }
  editing = value;
  document.body.classList.toggle('building', value);
  $('#editor').hidden = !value; $('#buildInfo').hidden = !value; $('#results').hidden = true;
  scene.setBuilding(value); setMode('browse'); builderTools.setEnabled(value);
  if (selected && !['zone', 'rack'].includes(selected.type)) selected = null;
  refresh();
}
function draw(type, p) {
  let id;
  const ok = commit(() => {
    if (type === 'zone') id = addZone(state, p);
    else id = addRack(state, state.zones.find(z => contains(z, p))?.id, p.x, p.z, rackDraft);
  });
  if (!ok) return false;
  selected = {type, id}; scene.select(selected, false); renderBuildSelection();
  toast(type === 'zone' ? 'Zone created. Draw another or choose Place racks.' : 'Rack placed. Click to place the next one.');
  return true;
}
function removeSelected() {
  const s = selected;
  const racks = s.type === 'zone' ? new Set(state.racks.filter(r => r.zone === s.id).map(r => r.id)) : new Set([s.id]);
  if (state.boxes.some(b => racks.has(b.rack))) return toast('Move or ship all boxes before deleting this layout object.');
  modal('Remove ' + (s.type === 'zone' ? 'zone' : 'rack'), `<p>Remove ${esc(s.id)}${s.type === 'zone' ? ' and its empty racks' : ''}? You can undo this change.</p><button class="danger wide" type="submit">Remove</button>`, () => {
    commit(() => {
      state.racks = state.racks.filter(r => !racks.has(r.id));
      if (s.type === 'zone') state.zones = state.zones.filter(z => z.id !== s.id);
      log(state, 'Layout updated', `Removed ${s.id}`); selected = null;
    });
    $('#dialog').close();
  });
}
function renameZone() {
  const id = selected.id, z = state.zones.find(z => z.id === id);
  modal('Rename zone', `<label>Name<input name="name" value="${esc(z.name)}" maxlength="40" required></label><button class="primary wide">Save name</button>`, fd => {
    const name = fd.get('name').trim();
    if (!name) return;
    commit(() => { state.zones.find(z => z.id === id).name = name; });
    $('#dialog').close();
  });
}

// ---------- pages ----------
function showHistory(type) { if (editing) toggleEdit(false); robotPanels.close(); inventoryPage.close(); historyPage.open(typeof type === 'string' ? type : 'All'); }
function showInventory() { if (editing) toggleEdit(false); historyPage.close(); robotPanels.close(); inventoryPage.open(); }
function setOccupancy(on) {
  occupancyOn = on; scene.setOccupancy(on);
  $('#vmSwitch').src = `/assets/fg/switch-${on ? 'on' : 'off'}.svg`;
}

const robotPanels = installRobotPanels(scene, () => { if (editing) toggleEdit(false); historyPage?.close(); inventoryPage?.close(); }, () => state,
  id => { selected = {type: 'box', id}; movePhoenix(); });
const historyPage = installHistoryPage({getState: live});
const inventoryPage = installInventoryPage({getState: () => state, sim, onShip: () => robotPanels.open('Orders'), onReceive: () => receivePhoenix(), onHistory: showHistory,
  onLocation: (kind, id) => { if (kind === 'stored') pick({type: 'rack', id}); else robotPanels.open(kind === 'transit' ? 'Fleet' : 'Live floor'); }});
const builderTools = installBuilderTools(scene.builderContext, () => state,
  a => commit(() => { applyLayoutEdit(state, a); log(state, 'Layout updated', a.type); }),
  points => commit(() => { for (const p of points) addRack(state, state.zones.find(z => contains(z, p))?.id, p.x, p.z, rackDraft); }));

// ---------- search ----------
$('#search').oninput = e => {
  const q = e.target.value.trim().toLowerCase(), el = $('#results');
  el.hidden = !q;
  if (!q) return;
  const zoneOf = id => state.zones.find(z => z.id === id), rackZone = id => zoneOf(state.racks.find(r => r.id === id)?.zone);
  const heldPlace = {receiving: 'Dock', transit: 'On robot', dispatch: 'Dispatch'};
  // Boxes still at the dock or on a robot come first, marked red like in Inventory.
  const hits = [
    ...state.zones.filter(z => z.name.toLowerCase().includes(q)).map(z => ({type: 'zone', id: z.id, label: z.name, sub: 'Zone', color: z.color})),
    ...state.racks.filter(r => r.id.toLowerCase().includes(q)).slice(0, 8).map(r => ({type: 'rack', id: r.id, label: r.id, sub: zoneOf(r.zone)?.name || 'Rack', color: zoneOf(r.zone)?.color})),
    ...sim.heldBoxes().filter(h => `${h.box.id} ${h.box.product}`.toLowerCase().includes(q)).map(h => ({held: h.kind, id: h.box.id, label: h.box.product, sub: h.box.id, value: heldPlace[h.kind], color: 'var(--danger)'})),
    ...state.boxes.filter(b => `${b.id} ${b.product}`.toLowerCase().includes(q)).slice(0, 15).map(b => ({type: 'box', id: b.id, label: b.product, sub: b.id, value: `${b.rack} · ${b.location}`, color: rackZone(b.rack)?.color})),
  ].slice(0, 15);
  el.innerHTML = hits.length ? hits.map(h => `<button class="ph-row" ${h.held ? `data-held="${h.held}"` : `data-type="${h.type}"`} data-id="${esc(h.id)}"><i style="background:${h.color || 'var(--brand)'}"></i><span>${esc(h.label)}<small>${esc(h.sub)}</small></span>${h.value ? `<em>${esc(h.value)}</em>` : ''}</button>`).join('') : '<p>No results. Try “A-01” or “Circuit”.</p>';
  el.querySelectorAll('button').forEach(b => b.onclick = () => b.dataset.held ? robotPanels.open(b.dataset.held === 'transit' ? 'Fleet' : 'Live floor') : pick({type: b.dataset.type, id: b.dataset.id}));
};
const searchWrap = $('.ph-search');
$('#phSearchButton').onclick = () => { $('#search').focus(); searchWrap.classList.add('is-open'); };
$('#search').addEventListener('focus', () => searchWrap.classList.add('is-open'));
$('#search').addEventListener('blur', () => setTimeout(() => { if (!$('#search').value) searchWrap.classList.remove('is-open'); }, 180));

// ---------- controls ----------
$('#receive').onclick = () => { inventoryPage.close(); receivePhoenix(); };
$('#ship').onclick = () => { inventoryPage.close(); robotPanels.open('Orders'); };
$('#warehouse').onclick = () => pick(null);
$('#inventory').onclick = showInventory;
$('#historyAll').onclick = showHistory;
$('#topView').onclick = () => scene.topView();
$('#done').onclick = () => toggleEdit(false);
$('#undo').onclick = undoLast;
$('#finishZone').onclick = () => scene.finishZone();
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
$('.ph-nav').addEventListener('click', e => { const b = e.target.closest('button'); if (b && b.id !== 'inventory') inventoryPage.close(); }, true);

const viewMenu = $('#viewMenu');
$('.ph-avatar-btn').addEventListener('click', e => { e.stopPropagation(); viewMenu.hidden = !viewMenu.hidden; });
viewMenu.addEventListener('click', e => {
  const b = e.target.closest('[data-vm]');
  if (!b) return;
  if (b.dataset.vm === 'occ') return setOccupancy(!occupancyOn);
  if (b.hasAttribute('data-layer')) {
    const on = !scene.layer(b.dataset.vm);
    scene.setLayer(b.dataset.vm, on);
    b.querySelector('img').src = `/assets/fg/switch-${on ? 'on' : 'off'}.svg`;
    return;
  }
  viewMenu.hidden = true;
  toggleEdit(true);
});
document.addEventListener('click', e => { if (!viewMenu.hidden && !viewMenu.contains(e.target)) viewMenu.hidden = true; });
document.addEventListener('keydown', e => {
  if (!editing && (e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); $('#search').focus(); }
  if (e.key === 'Escape') { $('#results').hidden = true; viewMenu.hidden = true; if (editing) setMode('browse'); }
});

scene.setRackConfig(rackDraft);
renderCatalog();
refresh();

// The panel follows the simulation.
let seenRevision = -1;
setInterval(() => {
  if (editing || sim.revision === seenRevision) return;
  seenRevision = sim.revision;
  renderPanel();
}, 500);
