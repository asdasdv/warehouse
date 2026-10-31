import './figma.css';
import './locus.css';
import {overviewHTML, allZonesHTML, allRacksHTML} from './phoenix-panel.js';
import {installHistoryPage} from './phoenix-history.js';
import {installInventoryPage} from './inventory-page.js';
import {installRobotPanels} from './robot-panels.js';
import {installTasksPanel} from './tasks-panel.js';
import {installBuilderTools} from './builder-tools.js';
import {installLayoutEditor} from './layout-editor.js';
import {docksOf} from './docks.js';
import {validateLayoutAccess} from './layout-access.js';
import {applyLayoutEdit} from './layout-edit.js';
import {contains} from './zone-shape.js';
import {seed, catalog, itemOf, addProduct, addZone, addRack, log} from './model.js';
import {templates, config, locations, CELL_CAPACITY} from './storage.js';
import {createScene} from './scene.js';
import {placeChooser, cellRoom, boxIndex, setLiveRoom} from './choose-place.js';
import {toggleSort, bindSort} from './table-sort.js';

// Concept demo: everything lives in memory and the robot simulation always runs.
// A reload starts the demo warehouse again.
const state = seed('medium');
let selected = null, editing = false, rackDraft = config(templates.standard);
let lastPanelHTML = '', occupancyOn = false;

const $ = s => document.querySelector(s);
const fmt = n => n.toLocaleString('en-US');
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const icon = name => `<img class="fg-ic" src="/assets/fg/${name}.svg" alt="">`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

$('#app').innerHTML = `<main>
 <div id="scene"></div>
 <div class="ph-topbar">
  <div class="ph-account"><button class="ph-gear" aria-label="View menu">${icon('gear')}</button></div>
  <nav class="ph-nav" aria-label="Main navigation">
   <button class="nav active" id="warehouse" title="Warehouse" aria-label="Warehouse">${icon('grid')}</button>
   <button class="nav" id="inventory" title="Inventory" aria-label="Inventory">${icon('cube')}</button>
   <div class="ph-search"><button type="button" id="phSearchButton" aria-label="Search warehouse">${icon('search')}</button><input id="search" placeholder="Search product, box or place…" autocomplete="off"><div id="results" hidden></div></div>
   <button class="nav" data-robot-view="Fleet" title="Fleet" aria-label="Fleet">${icon('bolt')}</button>
   <button class="nav" id="historyAll" title="History" aria-label="History">${icon('clock')}</button>
  </nav>
  <div class="ph-actions"><button id="receive">Receive</button><button id="ship" class="primary">Ship</button></div>
 </div>
 <div id="viewMenu" hidden><button class="vm-row" data-vm="occ" role="switch" aria-checked="false"><span>Occupancy</span><img id="vmSwitch" src="/assets/fg/switch-off.svg" alt=""></button>${[['Zones', 'zones'], ['Robots', 'robots'], ['Robot lanes', 'lanes'], ['Zone names', 'zoneTags'], ['Dock names', 'dockTags'], ['Robot names', 'labels']].map(([name, key]) => `<button class="vm-row" data-vm="${key}" data-layer role="switch" aria-checked="true"><span>${name}</span><img src="/assets/fg/switch-on.svg" alt=""></button>`).join('')}<div class="vm-div"></div><button class="vm-row" data-vm="edit"><span>Edit warehouse layout</span>${icon('open')}</button></div>
 <aside class="right card" id="overview"></aside>
 <div id="toast" role="status" popover="manual"></div>
 <div id="narrow" role="note"><b>Open Porter on a wider screen</b><span>The warehouse map, panels and dialogs need a window at least 900 px wide.</span></div>
 <dialog id="dialog" autofocus></dialog>
</main>`;

// Search fields (a magnifier + input) get a × once they hold text: it clears the text in one click.
// Fields are re-rendered often, so the button is added to any new field as it appears.
const clearIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.75 4.75l6.5 6.5M11.25 4.75l-6.5 6.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
function addClearButtons(root = document) {
  for (const box of root.querySelectorAll('.lc-input, .ph-search')) {
    if (box.querySelector(':scope > .lc-clear') || !box.querySelector('.fg-ic[src*="search"], .fg-ic[src*="search"]') || !box.querySelector('input')) continue;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'lc-clear'; b.tabIndex = -1; b.setAttribute('aria-label', 'Clear'); b.innerHTML = clearIcon;
    box.append(b);
  }
}
new MutationObserver(() => addClearButtons()).observe(document.body, {childList: true, subtree: true});
document.addEventListener('pointerdown', e => { if (e.target.closest('.lc-clear')) e.preventDefault(); }, true); // keep focus in the field
document.addEventListener('click', e => {
  const b = e.target.closest('.lc-clear'); if (!b) return;
  const input = b.parentElement.querySelector('input'); input.value = ''; input.dispatchEvent(new Event('input', {bubbles: true})); input.focus();
});
// Instant tooltips for anything with data-tip (zone bar segments); shown above the element, inside dialogs too.
{
  const tip = document.createElement('div'); tip.className = 'lc-tip'; tip.hidden = true; tip.setAttribute('popover', 'manual'); document.body.append(tip);
  document.addEventListener('pointerover', e => {
    const el = e.target.closest?.('[data-tip]');
    if (!el) { if (!tip.hidden) { tip.hidden = true; tip.hidePopover?.(); } return; }
    tip.textContent = el.dataset.tip; tip.hidden = false;
    if (tip.showPopover) { if (tip.matches(':popover-open')) tip.hidePopover(); tip.showPopover(); }
    const r = el.getBoundingClientRect(), w = tip.offsetWidth;
    tip.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`; tip.style.top = `${r.top - tip.offsetHeight - 6}px`;
  });  // A click (it may open another view) or a scroll hides it until the pointer reaches a tip again.
  const hide = () => { if (!tip.hidden) { tip.hidden = true; tip.hidePopover?.(); } };
  document.addEventListener('pointerdown', hide, true); document.addEventListener('scroll', hide, true);
}
// A click on the backdrop closes the dialog. Only when the press also started outside,
// so selecting text inside and releasing outside doesn't close it.
{
  const d = $('#dialog'), outside = e => { const r = d.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
  let pressedOutside = false;
  d.addEventListener('pointerdown', e => { pressedOutside = e.target === d && outside(e); });
  d.addEventListener('click', e => { if (pressedOutside && e.target === d && outside(e)) d.close(); pressedOutside = false; });
  // Soft blur at the top or bottom edge while content is cut off there.
  const edges = () => {
    const el = d.querySelector(':scope > .lc-dialog');
    d.classList.toggle('cut-top', !!el && el.scrollTop > 1);
    d.classList.toggle('cut-bottom', !!el && el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  };
  d.addEventListener('scroll', edges, {passive: true, capture: true});
  new MutationObserver(() => requestAnimationFrame(edges)).observe(d, {childList: true, subtree: true, attributes: true, attributeFilter: ['open']});
  addEventListener('resize', edges);
}
const scene = createScene($('#scene'), () => state, pick, draw);
const sim = scene.robotics;
const live = () => sim.dashboard(state);
setLiveRoom((rack, loc, product) => sim.cellRoom?.(rack, loc, product));

// Toasts: a title, one line of detail and an optional action ({label, run}). Up to three stack at once.
// The stack is a manual popover, so it sits in the top layer and stays visible over an open dialog.
function toast(title, text = '', action = null, {stay = false} = {}) {
  const stack = $('#toast'), el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div class="t"><b>${esc(title)}</b>${text ? `<small>${esc(text)}</small>` : ''}</div>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { dismiss(el); action.run(); };
  stack.append(el);
  while (stack.children.length > 3) stack.firstElementChild.remove();
  stack.classList.add('visible');
  if (stack.showPopover) { if (stack.matches(':popover-open')) stack.hidePopover(); stack.showPopover(); }
  requestAnimationFrame(() => el.classList.add('visible'));
  if (!stay) setTimeout(() => dismiss(el), action ? 6000 : 4000);
}
function dismiss(el) {
  el.classList.remove('visible');
  setTimeout(() => { el.remove(); const stack = $('#toast'); if (!stack.children.length) { stack.classList.remove('visible'); if (stack.matches(':popover-open')) stack.hidePopover(); } }, 200);
}
toast.clear = () => $('#toast').querySelectorAll('.toast').forEach(dismiss);

// ---------- layout changes ----------
const layoutSnapshot = () => JSON.stringify({zones: state.zones, racks: state.racks});
function commit(fn) {
  // While the layout editor is open, edits join its draft (undo, redo, save or discard).
  if (layoutEditor?.isOpen) return layoutEditor.apply(fn);
  const before = layoutSnapshot();
  try {
    fn();
    validateLayoutAccess(JSON.parse(before).racks, state.racks, docksOf(state), docksOf(state), state.spine);
  } catch (e) {
    Object.assign(state, JSON.parse(before));
    toast(e.message);
    if ($('#dialog').open && $('#error')) $('#error').textContent = e.message;
    return false;
  }
  refresh();
  return true;
}
// ---------- selection and right panel ----------
function exists(sel) {
  if (!sel) return true;
  if (sel.type === 'zone') return state.zones.some(z => z.id === sel.id);
  if (sel.type === 'rack') return state.racks.some(r => r.id === sel.id);
  if (sel.type === 'shelf') { const [rid, s] = sel.id.split('|'), r = state.racks.find(r => r.id === rid); return !!r && Number(s.slice(1)) <= r.shelves; }
  if (sel.type === 'location') { const [rid, loc] = sel.id.split('|'), r = state.racks.find(r => r.id === rid); return !!r && locations(r).includes(loc); }
  return state.boxes.some(b => b.id === sel.id);
}
// The 3D scene knows zones, racks, cells and boxes; a shelf shows its rack.
const sceneSel = s => s?.type === 'shelf' ? {type: 'rack', id: s.id.split('|')[0]} : s;
// «Pick on the map» in the place chooser: the dialog steps aside, the next rack (or a cell or box on it)
// clicked in 3D reopens the chooser on that rack's cells. Esc goes back to the chooser.
let mapPicker = null;
function pickOnMap(open) {
  $('#dialog').close(); mapPicker = open;
  toast('Click a rack on the map', 'Esc to go back to the list', null, {stay: true});
}
// Leaving for another section (Inventory, History, Fleet, Receive, Ship, the editor…) ends the pick: the hint goes,
// and Esc no longer brings the chooser back over that section.
document.addEventListener('click', e => { if (mapPicker && e.target.closest('.ph-topbar')) { mapPicker = null; toast.clear(); } }, true);
function pick(s) {
  if (mapPicker) {
    const rid = s?.type === 'rack' ? s.id : s?.type === 'location' || s?.type === 'shelf' ? s.id.split('|')[0] : s?.type === 'box' ? state.boxes.find(b => b.id === s.id)?.rack : null;
    if (!rid) return;
    const open = mapPicker; mapPicker = null; toast.clear(); return open(rid);
  }
  $('#results').hidden = true; historyPage?.close(); inventoryPage?.close();
  if (editing) { selected = s?.type === 'zone' || s?.type === 'rack' ? s : null; scene.select(sceneSel(selected), false); return layoutEditor.select(selected); }
  if (s?.type === 'box') return robotPanels.openBox(s.id);
  if (s?.type === 'robot') return robotPanels.open('Fleet', s.id);
  robotPanels.close(); setNav('warehouse');
  selected = s;
  scene.select(sceneSel(s), !editing); renderPanel();
}
function refresh() {
  if (!exists(selected)) selected = null;
  scene.rebuild(); scene.select(sceneSel(selected), false); renderPanel();
}
function bindPicks(root) {
  root.querySelectorAll('[data-pick]').forEach(el => {
    el.onclick = () => { if ($('#dialog').open) $('#dialog').close(); pick({type: el.dataset.pick, id: el.dataset.id}); };
    // Table rows aren't buttons: give them Tab and Enter/Space like one.
    if (el.tagName !== 'BUTTON') { el.tabIndex = 0; el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } }; }
  });
  root.querySelector('[data-root]')?.addEventListener('click', () => pick(null));
}
function renderPanel() {
  const view = $('#overview');
  if (!exists(selected)) selected = null;
  const scroll = view.scrollTop;
  const html = overviewHTML(live(), selected?.type === 'box' ? null : selected);
  if (html === lastPanelHTML) return;
  lastPanelHTML = html; view.innerHTML = html; view.classList.toggle('home', !selected);
  view.scrollTop = scroll;
  bindPicks(view);
  // Keep the 3D outline for the row still under the pointer after a re-render.
  const hovered = view.querySelector('.lc-row[data-pick]:hover');
  scene.preview(hovered ? {type: hovered.dataset.pick, id: hovered.dataset.id} : null);
  // Hovering a row outlines that zone, rack, shelf, cell or box in 3D.
  if (!view.dataset.hover) {
    view.dataset.hover = '1';
    view.addEventListener('pointerover', e => { const row = e.target.closest('.lc-row[data-pick]'); scene.preview(row ? {type: row.dataset.pick, id: row.dataset.id} : null); });
    view.addEventListener('pointerleave', () => scene.preview(null));
  }
  $('#allZones')?.addEventListener('click', () => tableDialog(sort => allZonesHTML(live(), sort), {key: 'fill', dir: 'desc'}));
  $('#allRacks')?.addEventListener('click', () => { const zone = selected.id; tableDialog(sort => allRacksHTML(live(), zone, sort), {key: 'stored', dir: 'desc'}); });
}
function tableDialog(html, sort) {
  const d = $('#dialog');
  // Re-sorting keeps the scroll position of the list.
  const draw = () => { const top = d.querySelector('.lc-dialog')?.scrollTop || 0;
    d.className = 'lc-wide'; d.innerHTML = `<div class="lc-dialog">${html(sort)}</div>`; d.querySelector('.lc-dialog').scrollTop = top;
    d.querySelector('[data-close]').onclick = () => d.close();
    bindPicks(d); bindSort(d, (k, f) => { sort = toggleSort(sort, k, f); draw(); }); };
  draw();
  if (!d.open) d.showModal();
}

// ---------- dialogs: Receive, Ship and Move hand work to the robots ----------
// Figma dialog frame: optional back link, title, body; returns the form.
function dialogFrame({title, back, body, onBack, onSubmit}) {
  const d = $('#dialog');
  d.className = '';
  d.innerHTML = `<form class="lc-dialog">${back ? `<div class="lc-dlg-top"><button type="button" class="lc-back" id="dlgBack"><img class="fg-ic" src="/assets/fg/arrow-left.svg" alt="">${esc(back)}</button><button type="button" class="icon" id="closeDialog" aria-label="Close">${icon('close')}</button></div><h2>${esc(title)}</h2>` : `<div class="lc-dlg-head"><h2>${esc(title)}</h2><button type="button" class="icon" id="closeDialog" aria-label="Close">${icon('close')}</button></div>`}${body}<p class="lc-error" id="error"></p></form>`;
  $('#closeDialog').onclick = () => d.close();
  if (back) $('#dlgBack').onclick = onBack;
  const form = d.querySelector('form');
  form.onsubmit = e => { e.preventDefault(); try { onSubmit(); } catch (err) { const f = err.field || fieldFor(form, err.message); if (f) fieldError(form, f, err.message); else $('#error').textContent = err.message; } };
  if (!d.open) d.showModal();
  return form;
}
// An error about one field shows under that field, and the field flashes a red outline.
const fieldErrorOf = (field, message) => Object.assign(Error(message), {field});
function fieldError(form, selector, message) {
  const box = form.querySelector(selector)?.closest('.lc-input, .lc-stepper'), field = box?.closest('.lc-field');
  if (!box) { $('#error').textContent = message; return; }
  let p = field.querySelector('.lc-field-error');
  if (!p) { p = document.createElement('p'); p.className = 'lc-field-error'; box.after(p); }
  p.textContent = message;
  box.classList.remove('invalid'); void box.offsetWidth; box.classList.add('invalid');
  const input = form.querySelector(selector);
  input.focus(); input.addEventListener('input', () => clearFieldError(form, selector), {once: true});
}
// Errors thrown by the model and the simulation don't name a field; match them to the field they are about.
// Only errors about the whole action (a box became busy, …) stay at the bottom of the dialog.
function fieldFor(form, message) {
  const has = sel => form.querySelector(sel) ? sel : null;
  if (/\d+–\d+ boxes/.test(message)) return has('[name=qty]');
  if (/name and SKU/.test(message)) return form.querySelector('#newName')?.value.trim() ? has('#newSku') : has('#newName');
  if (/already exists/.test(message)) return has('#newName');
  if (/product|component/i.test(message)) return has('#productInput') || has('#newName');
  return null;
}
const clearFieldError = (form, selector) => { const f = form.querySelector(selector)?.closest('.lc-field'); f?.querySelector('.lc-field-error')?.remove(); f?.querySelector('.invalid')?.classList.remove('invalid'); };
const zoneColor = rid => state.zones.find(z => z.id === state.racks.find(r => r.id === rid)?.zone)?.color || 'var(--accent-primary)';
const stepper = (value, max, of = false) => `<div class="lc-stepper"><button type="button" data-step="-1" aria-label="Fewer">${icon('minus')}</button>${of ? '<div class="lc-qty">' : ''}<input name="qty" type="number" min="1" max="${max}" value="${value}">${of ? '<span id="qtyOf"></span></div>' : ''}<button type="button" data-step="1" aria-label="More">${icon('plus')}</button></div>`;
function bindStepper(form, onChange) {
  const input = form.querySelector('[name=qty]');
  const clamp = () => { input.value = Math.max(1, Math.min(Number(input.max) || 1, Math.round(Number(input.value) || 1))); onChange(Number(input.value)); };
  const step = b => { input.value = Number(input.value) + Number(b.dataset.step); clamp(); };
  // Press: one step. Hold: after 0.4 s it keeps stepping, faster the longer it is held.
  form.querySelectorAll('[data-step]').forEach(b => {
    let timer = null;
    const stop = () => { clearTimeout(timer); timer = null; };
    b.onpointerdown = e => { if (e.button) return; e.preventDefault(); step(b); let delay = 400, n = 0;
      const again = () => { timer = setTimeout(() => { step(b); n++; delay = Math.max(40, 120 - n * 6); again(); }, delay); }; again(); };
    b.onpointerup = b.onpointerleave = b.onpointercancel = stop;
    b.onclick = e => { if (e.detail === 0) step(b); }; // keyboard (Enter/Space) still steps once
  });
  input.onchange = clamp;
}
// Product field with suggestions. list() returns product names; onCreate is optional ("Create new").
function productField(form, {value, list, onPick, onCreate, count}) {
  const input = form.querySelector('#productInput'), box = form.querySelector('#productSuggest');
  const show = () => {
    const q = input.value.trim().toLowerCase();
    const hits = list().filter(p => !q || p.toLowerCase().includes(q) || itemOf(p)?.sku.toLowerCase().includes(q));
    active = -1;
    // Ship shows how many boxes can go (count), on the right; Receive doesn't need it.
    // Counted once a second at most: typing re-filters the list on every key.
    if (count && (!counted || performance.now() - counted.at > 1000)) counted = {at: performance.now(), map: count()};
    const n = counted?.map;
    box.innerHTML = hits.map(p => `<button type="button" tabindex="-1" role="option" data-p="${esc(p)}"><span>${esc(p)}<small>SKU · ${esc(itemOf(p)?.sku || '—')}</small></span>${n ? `<em>${plural(n.get(p) || 0, 'box', 'boxes')}</em>` : ''}</button>`).join('') + (onCreate ? `<button type="button" class="create" id="createNew">Create new</button>` : '');
    // Nothing matches what was typed: the list stays open and says so, instead of vanishing.
    if (q && !hits.length) box.insertAdjacentHTML('afterbegin', `<p class="lc-suggest-empty">No products match “${esc(input.value.trim())}”</p>`);
    box.hidden = !box.innerHTML;
    // The list floats above the dialog (fixed), full field width, down to the bottom of the window; long lists scroll inside.
    const r = input.closest('.lc-input').getBoundingClientRect();
    Object.assign(box.style, {left: `${r.left}px`, top: `${r.bottom + 4}px`, width: `${r.width}px`, maxHeight: `${Math.max(200, innerHeight - r.bottom - 16)}px`});
    box.querySelectorAll('[data-p]').forEach(b => b.onmousedown = e => { e.preventDefault(); choose(b.dataset.p); });
    box.querySelector('#createNew')?.addEventListener('mousedown', e => { e.preventDefault(); onCreate(input.value.trim()); });
  };
  let active = -1, counted = null;
  const choose = p => { input.value = p; box.hidden = true; onPick(p); };
  // Arrows walk the list, Enter picks, Escape closes the list (not the dialog).
  input.onkeydown = e => {
    const items = [...box.querySelectorAll('[data-p], #createNew')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (box.hidden) show();
      if (!items.length) return;
      active = e.key === 'ArrowDown' ? (active + 1) % items.length : (active <= 0 ? items.length : active) - 1;
      items.forEach((b, i) => { b.classList.toggle('on', i === active); b.id = b.id || `suggest-${i}`; });
      if (items[active]) input.setAttribute('aria-activedescendant', items[active].id);
      items[active]?.scrollIntoView({block: 'nearest'});
    } else if (e.key === 'Enter' && !box.hidden && items[active]) {
      e.preventDefault();
      const b = items[active];
      if (b.id === 'createNew') onCreate(input.value.trim()); else choose(b.dataset.p);
    } else if (e.key === 'Escape' && !box.hidden) { e.preventDefault(); box.hidden = true; }
  };
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-controls', 'productSuggest'); box.setAttribute('role', 'listbox');
  new MutationObserver(() => input.setAttribute('aria-expanded', String(!box.hidden))).observe(box, {attributes: true, attributeFilter: ['hidden']});
  input.value = value || '';
  input.onfocus = show;
  // Editing the text drops the picked product until a name from the list is chosen again.
  input.oninput = () => { if (!list().includes(input.value)) onPick(''); show(); };
  input.onblur = () => setTimeout(() => { box.hidden = true; if (list().includes(input.value)) onPick(input.value); }, 150);
}
const productInput = placeholder => `<div class="lc-input">${icon('search')}<input id="productInput" placeholder="${placeholder}" autocomplete="off"></div><div class="lc-suggest" id="productSuggest" hidden></div>`;

// Where to put new boxes: the recommended cell, the next one on that rack, and the emptiest rack in that zone.
function receiveOptions(product, qty) {
  const cells = [], idx = boxIndex(state), rackRoom = new Map();
  for (const r of state.racks) {
    const occ = idx.get(r.id) || new Map();
    for (const loc of locations(r)) {
      const room = cellRoom(state, r.id, loc, product, null, idx);
      if (!room) continue;
      rackRoom.set(r.id, (rackRoom.get(r.id) || 0) + room);
      const same = !!occ.get(loc)?.length, [s, p] = loc.slice(1).split('-P').map(Number);
      const next = !same && [p - 1, p + 1].some(n => occ.get(`S${s}-P${n}`)?.[0]?.product === product);
      cells.push({rack: r.id, loc, room, score: (same ? 0 : next ? 1 : 2) + (room < qty ? 3 : 0)});
    }
  }
  cells.sort((a, b) => a.score - b.score || b.room - a.room || a.rack.localeCompare(b.rack));
  const zoneName = rid => state.zones.find(z => z.id === state.racks.find(r => r.id === rid)?.zone)?.name || 'this zone';
  // More boxes than a cell holds: suggest racks with room for all of them. The cell shown is where the robots
  // start; the rest go to the next free cells of the same rack.
  if (qty > CELL_CAPACITY) {
    const start = rid => cells.find(c => c.rack === rid);
    const racks = [...rackRoom].filter(([rid]) => start(rid)).sort((a, b) => (b[1] >= qty) - (a[1] >= qty) || start(a[0]).score - start(b[0]).score || b[1] - a[1]);
    if (!racks.length) return [];
    const fits = room => room >= qty ? `all ${qty} boxes fit on this rack` : `${room} of ${qty} boxes fit on this rack`;
    const [first] = racks, zone = state.racks.find(r => r.id === first[0]).zone;
    const out = [{...start(first[0]), rackWide: true, room: first[1], note: `Recommended · ${fits(first[1])}`}];
    const other = racks.find(([rid, room]) => rid !== first[0] && room >= qty && state.racks.find(r => r.id === rid).zone === zone);
    if (other) out.push({...start(other[0]), rackWide: true, room: other[1], note: `Also in ${zoneName(other[0])} · ${fits(other[1])}`});
    const roomiest = racks.filter(([rid]) => !out.some(o => o.rack === rid)).sort((a, b) => b[1] - a[1])[0];
    if (roomiest) out.push({...start(roomiest[0]), rackWide: true, room: roomiest[1], note: `Most free room · ${zoneName(roomiest[0])}`});
    return out;
  }
  const first = cells[0];
  if (!first) return [];
  const notes = ['Recommended · same product is in this cell', 'Recommended · same product is in the next cell', `Recommended · enough space for ${plural(qty, 'box', 'boxes')}`];
  const out = [{...first, note: notes[first.score] || 'Recommended'}];
  const second = cells.find(c => c.rack === first.rack && c !== first);
  if (second) out.push({...second, note: 'Next free cell on the same rack'});
  const zone = state.racks.find(r => r.id === first.rack).zone, used = new Map();
  for (const b of state.boxes) used.set(b.rack, (used.get(b.rack) || 0) + 1);
  const roomy = state.racks.filter(r => r.zone === zone && r.id !== first.rack).sort((a, b) => (used.get(a.id) || 0) - (used.get(b.id) || 0))
    .map(r => cells.find(c => c.rack === r.id)).find(Boolean);
  if (roomy) out.push({...roomy, note: `Rack with the most free room in ${zoneName(roomy.rack)}`});
  return out;
}
const placeOption = (c, chosen) => `<button type="button" class="lc-option${chosen ? ' chosen' : ''}" data-rack="${esc(c.rack)}" data-loc="${esc(c.loc)}"><i style="background:${zoneColor(c.rack)}"></i><span>${c.rackWide ? `${esc(c.rack)} · from ${esc(c.loc)}` : `${esc(c.rack)} · ${esc(c.loc)}`}<small>${esc(c.note)}</small></span><em>${c.room} free</em></button>`;
function placeList(container, options, getChoice, setChoice, qty = 1) {
  const c = getChoice();
  if (c && !options.some(o => o.rack === c.rack && o.loc === c.loc)) {
    // A chosen cell for more boxes than it holds: the robots start there and fill the rack's next free cells.
    const r = state.racks.find(r => r.id === c.rack), many = qty > CELL_CAPACITY && r;
    const room = many ? locations(r).reduce((n, loc) => n + cellRoom(state, r.id, loc, c.product), 0) : cellRoom(state, c.rack, c.loc, c.product);
    const note = many ? (room >= qty ? `Chosen place · all ${qty} boxes fit on this rack` : `Chosen place · ${room} of ${qty} boxes fit on this rack`) : 'Chosen place';
    options = [{...c, room, rackWide: !!many, note}, ...options.slice(0, 2)];
  }
  container.innerHTML = options.map(o => placeOption(o, c && o.rack === c.rack && o.loc === c.loc)).join('') || '<p class="lc-empty">No free cell for this component.</p>';
  container.querySelectorAll('[data-rack]').forEach(b => b.onclick = () => setChoice({rack: b.dataset.rack, loc: b.dataset.loc}));
}

function receivePhoenix(preset = {}) {
  if (!state.racks.length) return toast('Add a rack before receiving boxes.');
  // `picked`: the place came from the user (a row, the chooser or the panel), so it stays when the amount changes.
  let product = preset.product || '', qty = preset.qty || 2, choice = preset.choice || null, picked = !!preset.choice, isNew = !!preset.isNew;
  const parts = !preset.choice && selected?.type === 'location' ? selected.id.split('|') : null;
  if (parts) { choice = {rack: parts[0], loc: parts[1]}; picked = true; }
  const submitLabel = () => `${isNew ? 'Create & receive' : 'Receive'} ${plural(qty, 'box', 'boxes')}`;
  const form = dialogFrame({
    title: isNew ? 'New product' : 'Receive', back: isNew ? 'Receive' : null,
    onBack: () => receivePhoenix({qty}),
    body: isNew
      ? `<label class="lc-field"><span>Product name</span><div class="lc-input"><input id="newName" value="${esc(preset.name || '')}" placeholder="Product name" autocomplete="off"></div></label><label class="lc-field"><span>SKU</span><div class="lc-input"><input id="newSku" value="${esc(preset.sku || '')}" placeholder="Enter SKU" autocomplete="off"></div></label><div class="lc-field"><span>Boxes</span>${stepper(qty, 48)}</div><div class="lc-field"><div class="lc-field-head"><span>Location</span><button type="button" class="lc-text-btn" id="chooseOther">Choose another place</button></div><div class="lc-options" id="places"></div></div><button class="primary" type="submit" id="submitBtn">${submitLabel()}</button>`
      : `<div class="lc-field"><span>Product</span>${productInput('Search product or SKU')}</div><div class="lc-field"><span>Boxes</span>${stepper(qty, 48)}</div><div class="lc-field"><div class="lc-field-head"><span>Location</span><button type="button" class="lc-text-btn" id="chooseOther">Choose another place</button></div><div class="lc-options" id="places"></div></div><button class="primary" type="submit" id="submitBtn">${submitLabel()}</button>`,
    onSubmit: () => {
      if (isNew) product = addProduct(form.querySelector('#newName').value, form.querySelector('#newSku').value);
      if (!catalog.some(p => p.name === product)) throw fieldErrorOf(isNew ? '#newName' : '#productInput', 'Choose a product from the list or create a new one.');
      sim.receive(product, qty, choice);
      $('#dialog').close();
      toast(`${plural(qty, 'box', 'boxes')} received`, `Queued for robots · going to ${choice ? `${choice.rack} · ${choice.loc}` : 'storage'}`);
    }});
  const render = () => {
    const p = isNew ? '__new__' : product;
    if (choice && !cellRoom(state, choice.rack, choice.loc, p)) choice = null;
    const options = p ? receiveOptions(p, qty) : [];
    if (!choice && options[0]) choice = {rack: options[0].rack, loc: options[0].loc};
    // Before a product is picked the field is still there, empty, like an unfilled input.
    form.querySelector('#chooseOther').disabled = !p;
    if (!p) form.querySelector('#places').innerHTML = '<div class="lc-option lc-placeholder"><i></i><span>Choose a product first</span></div>';
    else placeList(form.querySelector('#places'), options, () => choice && {...choice, product: p}, c => { choice = c; picked = true; render(); }, qty);
    form.querySelector('#submitBtn').textContent = submitLabel();
  };
  if (!isNew) productField(form, {value: product, list: () => catalog.map(p => p.name), onPick: p => { if (p) clearFieldError(form, '#productInput'); if (p !== product) { product = p; choice = null; render(); } },
    onCreate: name => receivePhoenix({isNew: true, name, qty})});
  // Holding + or − changes the amount many times a second: the places are re-planned once it settles (150 ms).
  let replan = null;
  bindStepper(form, n => { qty = n; if (!picked) choice = null; form.querySelector('#submitBtn').textContent = submitLabel(); clearTimeout(replan); replan = setTimeout(render, 150); });
  form.querySelector('#chooseOther').onclick = () => {
    // Back from the chooser returns to the same receipt, including a place the user had already picked.
    const keep = {product, qty, isNew, name: form.querySelector('#newName')?.value, sku: form.querySelector('#newSku')?.value, choice: picked ? choice : null};
    if (!isNew && !product) return fieldError(form, '#productInput', 'Choose a product first.');
    const open = startRack => { if (!$('#dialog').open) $('#dialog').showModal();
      placeChooser({dialog: $('#dialog'), state, product: isNew ? '__new__' : product, qty, backLabel: isNew ? 'New product' : 'Receive', startRack,
        onPick: c => receivePhoenix({...keep, choice: c}), onBack: () => receivePhoenix(keep), onMap: () => pickOnMap(open)}); };
    open(null);
  };
  render();
}

function shipDialog(preset = {}) {
  let product = preset.product || '', qty = preset.qty || 1, station = preset.station || sim.dispatchStations()[0];
  const form = dialogFrame({title: 'Ship',
    body: `<div class="lc-field"><span>Product</span>${productInput('Search product or SKU')}</div><div class="lc-field"><span>Boxes</span>${stepper(qty, 1, true)}</div><label class="lc-field"><span>Take to</span><div class="lc-input"><select id="station">${sim.dispatchStations().map(s => `<option ${s === station ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div></label><button class="primary" type="submit" id="submitBtn"></button>`,
    onSubmit: () => {
      if (!product) throw fieldErrorOf('#productInput', 'Choose a product to ship.');
      sim.ship(product, qty, station);
      $('#dialog').close();
    }});
  const render = () => {
    const n = product ? sim.inStock(product) : 0, input = form.querySelector('[name=qty]');
    input.max = Math.max(1, n); if (qty > n && n) { qty = n; input.value = n; }
    // Stock sits in the Boxes field: «1 / 184».
    form.querySelector('#qtyOf').textContent = product ? `/ ${fmt(n)}` : '';
    input.style.width = `${String(input.value).length + .6}ch`;
    form.querySelector('#submitBtn').textContent = `Ship ${plural(qty, 'box', 'boxes')}`;
  };
  productField(form, {value: product, list: () => sim.products().sort(), count: () => new Map(sim.products().map(p => [p, sim.inStock(p)])), onPick: p => { if (p) clearFieldError(form, '#productInput'); if (p !== product) { product = p; render(); } }});
  bindStepper(form, n => { qty = n; render(); });
  form.querySelector('#station').onchange = e => { station = e.target.value; };
  render();
}

function shipBoxDialog(id) {
  const b = sim.boxInfo(id);
  if (!b?.actionable) return toast('This box is busy with robot work.');
  dialogFrame({title: 'Ship box',
    body: `<div class="lc-card"><div>${esc(b.id)} · 1 box<small>${esc(b.product)}</small></div><span class="lc-pill" style="background:${zoneColor(b.rack)}">${esc(b.rack)} · ${esc(b.location.split('-')[0])}</span></div><div class="lc-field"><span>Dispatch station</span><div class="lc-card"><div>Assigned automatically<small>A robot will collect this box and bring it to an available dispatch station</small></div></div></div><button class="primary" type="submit">Ship to dispatch</button>`,
    onSubmit: () => { sim.shipBox(id); $('#dialog').close(); }});
}

function movePhoenix(preset = {}) {
  let box = null;
  if (preset.box) box = state.boxes.find(b => b.id === preset.box);
  else if (selected?.type === 'box') box = state.boxes.find(b => b.id === selected.id);
  else if (selected?.type === 'location') { const [rack, loc] = selected.id.split('|'); box = state.boxes.find(b => b.rack === rack && b.location === loc && sim.boxInfo(b.id)?.actionable); }
  if (!box) return toast('Choose a box first.');
  if (!sim.boxInfo(box.id)?.actionable) return toast('This box is busy with robot work.');
  const from = state.racks.find(r => r.id === box.rack), exclude = {rack: box.rack, loc: box.location};
  const options = [], idx = boxIndex(state);
  for (const r of state.racks) for (const loc of locations(r)) {
    const room = cellRoom(state, r.id, loc, box.product, exclude, idx);
    if (room) options.push({rack: r.id, loc, room, dist: Math.hypot(r.x - from.x, r.z - from.z) + (r.id === box.rack ? 0 : 1)});
  }
  options.sort((a, b) => a.dist - b.dist);
  const best = options.slice(0, 1).map(o => ({...o, note: 'Recommended · closest free cell'}));
  const form = dialogFrame({title: 'Move box',
    body: `<div class="lc-field"><span>From</span><div class="lc-card"><i style="width:16px;height:16px;border-radius:4px;background:${zoneColor(box.rack)}"></i><div>${esc(box.product)}<small>${esc(box.id)} · ${esc(box.rack)} · ${esc(box.location)}</small></div><em>${itemOf(box.product)?.pcs || 1} pcs</em></div></div><div class="lc-field"><div class="lc-field-head"><span>To</span><button type="button" class="lc-text-btn" id="chooseOther">Choose another place</button></div><div class="lc-options" id="places"></div></div>`, onSubmit: () => {}});
  // Picking a place is the order itself: the robot is sent and the dialog closes, with no confirm step.
  const go = c => { try { sim.requestMove([box.id], c.rack, c.loc); $('#dialog').close(); } catch (e) { $('#dialog').close(); toast(e.message); } };
  const render = () => placeList(form.querySelector('#places'), best, () => null, go);
  const open = startRack => { if (!$('#dialog').open) $('#dialog').showModal();
    placeChooser({dialog: $('#dialog'), state, product: box.product, exclude, backLabel: 'Move box', instant: true, startRack,
      onPick: go, onBack: () => movePhoenix({box: box.id}), onMap: () => pickOnMap(open)}); };
  form.querySelector('#chooseOther').onclick = () => open(null);
  render();
}

// ---------- build mode ----------
function setMode(m) {
  scene.setMode(m);
  if (editing && m === 'browse') builderTools.select();
}
function toggleEdit(value) {
  // A toast's action (View history) would leave the editor half-open, so it goes away first.
  if (value) { robotPanels.close(); historyPage.close(); inventoryPage.close(); setOccupancy(false); toast.clear(); }
  editing = value;
  document.body.classList.toggle('building', value);
  $('#results').hidden = true;
  scene.setBuilding(value); setMode('browse'); builderTools.setEnabled(value);
  selected = null;
  if (value) layoutEditor.open();
  refresh();
}
function draw(type, p) {
  let id;
  const ok = commit(() => {
    if (type === 'zone') id = addZone(state, p);
    else id = addRack(state, state.zones.find(z => contains(z, p))?.id, p.x, p.z, rackDraft);
  });
  if (!ok) return false;
  selected = {type, id}; scene.select(selected, false);
  layoutEditor.select(selected);
  return true;
}
// ---------- pages ----------
// Only one section of the top bar is lit at a time.
const setNav = id => document.querySelectorAll('.ph-nav .nav').forEach(b => b.classList.toggle('active', b.id === id));
function showHistory(type) { if (editing) toggleEdit(false); $('#results').hidden = true; robotPanels.close(); inventoryPage.close(); historyPage.open(typeof type === 'string' ? type : 'All'); setNav('historyAll'); }
function showInventory(query) { if (editing) toggleEdit(false); $('#results').hidden = true; historyPage.close(); robotPanels.close(); inventoryPage.open(typeof query === 'string' ? query : undefined); }
function setOccupancy(on) {
  occupancyOn = on; scene.setOccupancy(on);
  $('#vmSwitch').src = `/assets/fg/switch-${on ? 'on' : 'off'}.svg`; $('[data-vm="occ"]').setAttribute('aria-checked', String(on));
}

const robotPanels = installRobotPanels(scene, () => { if (editing) toggleEdit(false); historyPage?.close(); inventoryPage?.close(); }, () => state,
  id => movePhoenix({box: id}), shipBoxDialog, {
    // Product card (from an Inventory row): receive or ship this product, or show every place of it on the map.
    onReceive: product => receivePhoenix({product}), onShip: product => shipDialog({product}),
    onClose: () => inventoryPage.markChosen(),
    onMap: product => { inventoryPage.close(); setNav('warehouse'); scene.showRacks([...new Set(state.boxes.filter(b => b.product === product).map(b => b.rack))]); }});
robotPanels.setPick(s => pick(s));
const historyPage = installHistoryPage({getState: live, onBox: id => { if (sim.boxInfo(id)) pick({type: 'box', id}); else toast(`${id} has left the warehouse`); }});
const inventoryPage = installInventoryPage({getState: () => state, sim, onShip: () => shipDialog(), onReceive: () => receivePhoenix(), onHistory: showHistory,
  onProduct: product => { robotPanels.openProduct(product); inventoryPage.markChosen(); }, chosen: () => robotPanels.product,
  onLocation: (kind, id) => { if (kind === 'stored') pick({type: 'rack', id}); else robotPanels.open('Fleet'); }});
const builderTools = installBuilderTools(scene.builderContext, () => state,
  a => commit(() => { applyLayoutEdit(state, a); log(state, 'Layout updated', a.type); }),
  points => commit(() => { for (const p of points) addRack(state, state.zones.find(z => contains(z, p))?.id, p.x, p.z, rackDraft); }));
installTasksPanel(sim, toast, {onHistory: () => showHistory('Shipped'), onBox: id => pick({type: 'box', id})});
const layoutEditor = installLayoutEditor({getState: () => state, scene, builderTools, rackDraft: () => rackDraft, toast,
  onChange: refresh, onSelect: s => { selected = s?.type === 'zone' || s?.type === 'rack' ? s : null; },
  onExit: () => { toggleEdit(false); pick(null); }});

// ---------- search ----------
// The top-bar search filters every box: it runs after a short pause in typing (80 ms), not on each key.
let searchTimer = null;
$('#search').oninput = e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(e.target.value), 80); };
function runSearch(value) {
  const q = value.trim().toLowerCase(), el = $('#results');
  el.hidden = !q;
  if (!q) return;
  const zoneOf = id => state.zones.find(z => z.id === id), rackZone = id => zoneOf(state.racks.find(r => r.id === id)?.zone);
  const hits = [
    ...state.zones.filter(z => z.name.toLowerCase().includes(q)).map(z => ({type: 'zone', id: z.id, label: z.name, sub: 'Zone', color: z.color})),
    ...state.racks.filter(r => r.id.toLowerCase().includes(q)).slice(0, 8).map(r => ({type: 'rack', id: r.id, label: r.id, sub: zoneOf(r.zone)?.name || 'Rack', color: zoneOf(r.zone)?.color})),
    ...sim.stations.filter(st => st.id.toLowerCase().includes(q)).slice(0, 6).map(st => ({type: 'dock', id: st.id, label: st.id, sub: st.kind === 'inbound' ? 'Receiving dock' : 'Dispatch dock'})),
    ...sim.robots.filter(r => r.id.toLowerCase().includes(q)).slice(0, 5).map(r => ({type: 'robot', id: r.id, label: r.id, sub: r.active ? (r.task ? r.status : 'Idle') : 'In reserve · charging'})),
    // A product is one row (it opens Inventory filtered to it), not a box per shelf.
    ...catalog.filter(p => `${p.name} ${p.sku}`.toLowerCase().includes(q)).slice(0, 6).map(p => ({type: 'product', id: p.name, label: p.name, sub: `SKU ${p.sku}`, value: `${fmt(sim.inStock(p.name))} in stock`})),
    // Boxes match by id: on shelves, at docks and on robots.
    ...[...state.boxes.filter(b => b.id.toLowerCase().includes(q)).slice(0, 8).map(b => ({type: 'box', id: b.id, label: b.id, sub: b.product, value: `${b.rack} · ${b.location.split('-')[0]}`, color: rackZone(b.rack)?.color})),
      ...sim.heldBoxes().filter(h => h.box.id.toLowerCase().includes(q)).slice(0, 4).map(h => ({type: 'box', id: h.box.id, label: h.box.id, sub: h.box.product, value: h.kind === 'transit' ? 'On a robot' : h.place}))],
  ].slice(0, 15);
  el.innerHTML = hits.length ? hits.map(h => `<button class="ph-row" data-type="${h.type}" data-id="${esc(h.id)}"><i style="background:${h.color || 'var(--accent-primary)'}"></i><span>${esc(h.label)}<small>${esc(h.sub)}</small></span>${h.value ? `<em>${esc(h.value)}</em>` : ''}</button>`).join('') : '<p>No results. Try “A-01”, “WAGO” or “Dispatch”.</p>';
  el.querySelectorAll('button').forEach(b => b.onclick = () => {
    const {type, id} = b.dataset;
    // Picking a result puts the search back to the magnifier.
    el.hidden = true; $('#search').value = ''; $('#search').blur(); searchWrap.classList.remove('is-open');
    if (type === 'product') return showInventory(id);
    if (type === 'dock') { pick(null); return scene.focusIssue(id); }
    pick({type, id});
  });
};
const searchWrap = $('.ph-search');
// The button only opens the field: focus goes straight to the input, and while open the magnifier
// is the field's icon (out of the Tab order).
$('#phSearchButton').onmousedown = e => e.preventDefault();
$('#phSearchButton').onclick = () => { searchWrap.classList.add('is-open'); $('#search').focus(); };
new MutationObserver(() => { $('#phSearchButton').tabIndex = searchWrap.classList.contains('is-open') ? -1 : 0; }).observe(searchWrap, {attributes: true, attributeFilter: ['class']});
$('#search').addEventListener('focus', () => searchWrap.classList.add('is-open'));
$('#search').addEventListener('blur', () => setTimeout(() => { if (!$('#search').value) searchWrap.classList.remove('is-open'); }, 180));
// A click anywhere outside the search puts it back to the magnifier: the text is cleared and the results close.
document.addEventListener('pointerdown', e => {
  if (searchWrap.contains(e.target) || !searchWrap.classList.contains('is-open')) return;
  $('#search').value = ''; $('#results').hidden = true; searchWrap.classList.remove('is-open'); $('#search').blur();
});

// ---------- controls ----------
$('#receive').onclick = () => receivePhoenix();
$('#ship').onclick = () => shipDialog();
$('#warehouse').onclick = () => pick(null);
$('#inventory').onclick = showInventory;
$('#historyAll').onclick = showHistory;
// Going to another section or to a search result closes Inventory; opening the search field doesn't.
$('.ph-nav').addEventListener('click', e => { const b = e.target.closest('.nav, #results .ph-row'); if (b && b.id !== 'inventory' && b.dataset.type !== 'product') inventoryPage.close(); }, true);

const viewMenu = $('#viewMenu');
$('.ph-gear').addEventListener('click', e => { e.stopPropagation(); viewMenu.hidden = !viewMenu.hidden; });
viewMenu.addEventListener('click', e => {
  const b = e.target.closest('[data-vm]');
  if (!b) return;
  if (b.dataset.vm === 'occ') return setOccupancy(!occupancyOn);
  if (b.hasAttribute('data-layer')) {
    const on = !scene.layer(b.dataset.vm);
    scene.setLayer(b.dataset.vm, on);
    b.querySelector('img').src = `/assets/fg/switch-${on ? 'on' : 'off'}.svg`; b.setAttribute('aria-checked', String(on));
    return;
  }
  viewMenu.hidden = true;
  toggleEdit(true);
});
document.addEventListener('click', e => { if (!viewMenu.hidden && !viewMenu.contains(e.target)) viewMenu.hidden = true; });
document.addEventListener('keydown', e => {
  if (!editing && (e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); $('#search').focus(); }
  if (e.key === 'Escape' && mapPicker) { const open = mapPicker; mapPicker = null; toast.clear(); return open(null); }
  if (e.key === 'Escape') { $('#results').hidden = true; viewMenu.hidden = true; if (editing) setMode('browse'); }
});

scene.setRackConfig(rackDraft);
refresh();

// The panel follows the simulation.
let seenRevision = -1;
setInterval(() => {
  if (editing || sim.revision === seenRevision) return;
  seenRevision = sim.revision;
  renderPanel();
}, 500);
