import {ed} from './editor-icons.js';
import {zonePoints, contains, polygonZone, zoneArea, snapRack, fitsZone} from './zone-shape.js';
import {applyLayoutEdit, rowPositions} from './layout-edit.js';
import {validateLayoutAccess, inaccessibleRacks} from './layout-access.js';
import {addZone, addRack, colors, log} from './model.js';
import {config, locations} from './storage.js';
import {docksOf, dockRect, dockPort, snapDock, validateDocks} from './docks.js';

// Warehouse layout editor (Figma "Editor" screens 1–13): a flat 2D plan plus the 3D scene,
// a tool rail, the object list, an inspector and a draft that is saved or discarded as a whole.
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const fmt = n => n.toLocaleString('en-US');
const r1 = n => Math.round(n * 10) / 10;
const ROBOT_AISLE = 3.6; // robots need this much room between rack faces
const SVGNS = 'http://www.w3.org/2000/svg';

export function installLayoutEditor({getState, scene, builderTools, rackDraft, onChange, onSelect, onExit, toast}) {
  const main = document.querySelector('main');
  const root = document.createElement('div');
  root.id = 'layoutEditor'; root.hidden = true;
  root.innerHTML = `<header class="ed-bar"><div class="ed-left"><button class="ed-ib" data-cmd="undo" title="Undo (⌘Z)">${ed('undo')}</button><button class="ed-ib" data-cmd="redo" title="Redo (⇧⌘Z)">${ed('redo')}</button><i class="ed-div"></i><button class="ed-ib" data-cmd="snap" title="Snap to racks">${ed('snap')}</button></div>
    <div class="ed-seg"><button data-view="3D">3D</button><button data-view="2D">2D</button></div>
    <div class="ed-right"><button data-cmd="cancel">Cancel</button><button class="primary" data-cmd="save">Save</button></div></header>
    <svg id="edPlan" xmlns="${SVGNS}"></svg>
    <nav class="ed-rail" id="edRail"></nav><section class="ed-objects" id="edObjects"></section><div class="ed-flyout" id="edFlyout" hidden></div>
    <aside class="ed-inspector" id="edInspector"></aside><div class="ed-context" id="edContext" hidden></div><div class="ed-color" id="edColor" hidden></div>`;
  main.append(root);
  const $ = s => root.querySelector(s), svg = $('#edPlan');

  let open = false, view = '2D', tool = 'select', snap = true;
  let sel = null;               // {type:'zone', id} | {type:'racks', ids:Set} | {type:'dock', id}
  let baseline = null, baselineTop = null, undo = [], redo = [], error = '';
  let pending = null;           // new zone before "Create zone": {x,z,w,d} | {points}
  let poly = null;              // polygon being drawn: [{x,z}]
  let drag = null, hover = null, ruler = null, rowPreview = null, rowGap = 1, pointIndex = null, pointsStart = null;
  let newName = '', newColor = colors[0], report = null;
  const hidden = new Set(), expanded = new Set();
  let vb = null;                // viewBox {x, z, w, h} in metres

  // ---------- draft history ----------
  const snapshot = () => JSON.stringify({zones: getState().zones, racks: getState().racks, docks: docksOf(getState())});
  function restore(json) { const s = getState(), v = JSON.parse(json); s.zones = v.zones; s.racks = v.racks; if (v.docks) s.docks = v.docks; }
  // Layout events logged after `since` (the newest history entry back then) are dropped when their edit is thrown away.
  const LAYOUT_EVENTS = new Set(['Zone created', 'Rack added', 'Rack updated']);
  function dropLayoutLog(since) {
    const s = getState(), i = since ? s.history.indexOf(since) : s.history.length, head = i < 0 ? s.history : s.history.slice(0, i);
    s.history = [...head.filter(e => !LAYOUT_EVENTS.has(e.type)), ...(i < 0 ? [] : s.history.slice(i))];
  }
  // Every edit goes through here: it is validated, can be undone, and fails without changing anything.
  function apply(fn) {
    const before = snapshot(), top = getState().history[0];
    try { fn(); const was = JSON.parse(before), s = getState(); validateDocks(s); validateLayoutAccess(was.racks, s.racks, was.docks, docksOf(s)); }
    catch (e) { restore(before); dropLayoutLog(top); error = e.message; render(); return false; }
    undo.push(before); undo = undo.slice(-50); redo = []; error = ''; report = null;
    onChange(); render(); return true;
  }
  function step(from, to) {
    if (!from.length) return;
    to.push(snapshot()); restore(from.pop());
    if (sel?.type === 'zone' && !getState().zones.some(z => z.id === sel.id)) sel = null;
    if (sel?.type === 'racks') { sel.ids = new Set([...sel.ids].filter(id => getState().racks.some(r => r.id === id))); if (!sel.ids.size) sel = null; }
    error = ''; report = null; onChange(); render();
  }
  function changes() {
    const was = JSON.parse(baseline), s = getState(), out = {zones: [], racks: []};
    const count = (before, after, moved) => {
      const b = new Map(before.map(x => [x.id, x])), a = new Map(after.map(x => [x.id, x]));
      const added = after.filter(x => !b.has(x.id)).length, deleted = before.filter(x => !a.has(x.id)).length;
      const changed = after.filter(x => b.has(x.id) && moved(b.get(x.id), x)).length;
      return {added, changed, deleted};
    };
    const z = count(was.zones, s.zones, (p, q) => JSON.stringify(p) !== JSON.stringify(q));
    const r = count(was.racks, s.racks, (p, q) => p.x !== q.x || p.z !== q.z || (p.rotation || 0) !== (q.rotation || 0) || p.zone !== q.zone);
    const d = count(was.docks || [], docksOf(s), (p, q) => p.x !== q.x || p.z !== q.z || (p.rotation || 0) !== (q.rotation || 0));
    const words = (c, verb) => [c.added && `${c.added} added`, c.changed && `${c.changed} ${verb}`, c.deleted && `${c.deleted} deleted`].filter(Boolean).join(' · ');
    if (words(z, 'changed')) out.zones = words(z, 'changed');
    if (words(r, 'moved')) out.racks = words(r, 'moved');
    out.docks = d.changed ? `${d.changed} moved` : '';
    return out;
  }

  // ---------- view: plan coordinates are metres, x → right, z → down ----------
  function fit() {
    const s = getState(), ps = s.zones.flatMap(zonePoints).concat(s.racks.map(r => ({x: r.x, z: r.z})), docksOf(s).flatMap(d => { const b = dockRect(d); return [{x: b.x - b.width / 2, z: b.z - b.depth / 2}, {x: b.x + b.width / 2, z: b.z + b.depth / 2}]; }));
    if (!ps.length) { vb = {x: -50, z: -40, w: 100, h: 80}; return; }
    const minX = Math.min(...ps.map(p => p.x)), maxX = Math.max(...ps.map(p => p.x)), minZ = Math.min(...ps.map(p => p.z)), maxZ = Math.max(...ps.map(p => p.z));
    // Fit the plan into the space between the object list (left) and the inspector (right).
    const box = svg.getBoundingClientRect(), W = box.width || 1200, H = box.height || 800, left = 340, right = 316, pad = 40;
    const spanX = Math.max(10, maxX - minX), spanZ = Math.max(10, maxZ - minZ);
    const scale = Math.min((W - left - right - pad * 2) / spanX, (H - pad * 2) / spanZ);
    const offX = left + pad + (W - left - right - pad * 2 - spanX * scale) / 2, offZ = (H - spanZ * scale) / 2;
    vb = {x: minX - offX / scale, z: minZ - offZ / scale, w: W / scale, h: H / scale};
  }
  function toWorld(e) {
    const box = svg.getBoundingClientRect();
    return {x: vb.x + (e.clientX - box.left) / box.width * vb.w, z: vb.z + (e.clientY - box.top) / box.height * vb.h};
  }
  function toScreen(p) {
    const box = svg.getBoundingClientRect();
    return {x: (p.x - vb.x) / vb.w * box.width, y: (p.z - vb.z) / vb.h * box.height + box.top - root.getBoundingClientRect().top};
  }
  const px = () => vb.w / (svg.getBoundingClientRect().width || 1200); // metres per screen pixel

  // ---------- robot access ----------
  // Aisles are the gaps in front of rack faces (along each rack's depth axis).
  function accessReport() {
    const s = getState(), racks = s.racks, aisles = [];
    for (let i = 0; i < racks.length; i++) for (let j = i + 1; j < racks.length; j++) {
      const a = racks[i], b = racks[j], dx = Math.abs(a.x - b.x) - (a.width + b.width) / 2, dz = Math.abs(a.z - b.z) - (a.depth + b.depth) / 2;
      const facesZ = (a.rotation || 0) % 2 === 0;
      const gap = facesZ ? (dz >= 0 && dx < 0 ? dz : null) : (dx >= 0 && dz < 0 ? dx : null);
      if (gap === null || gap > 12) continue;
      const ox = facesZ ? [Math.max(a.x - a.width / 2, b.x - b.width / 2), Math.min(a.x + a.width / 2, b.x + b.width / 2)] : null;
      const oz = facesZ ? null : [Math.max(a.z - a.depth / 2, b.z - b.depth / 2), Math.min(a.z + a.depth / 2, b.z + b.depth / 2)];
      const mid = facesZ ? (a.z < b.z ? a.z + a.depth / 2 : b.z + b.depth / 2) + gap / 2 : (a.x < b.x ? a.x + a.width / 2 : b.x + b.width / 2) + gap / 2;
      aisles.push({a: a.id, b: b.id, gap, ok: gap >= ROBOT_AISLE, line: facesZ ? [{x: ox[0], z: mid}, {x: ox[1], z: mid}] : [{x: mid, z: oz[0]}, {x: mid, z: oz[1]}]});
    }
    const docks = docksOf(s), blocked = [...inaccessibleRacks(racks, docks)];
    const problems = [...aisles.filter(a => !a.ok).map(a => ({text: `Aisle between ${a.a} and ${a.b} is ${r1(a.gap)} m wide`, ids: [a.a, a.b]})),
      ...blocked.map(id => docks.some(d => d.id === id) ? {text: `${id} has no robot route to the other docks`, ids: [], dock: id} : {text: `Rack ${id} has no robot route to Dispatch`, ids: [id]})];
    return {aisles, blocked: new Set(blocked), problems, min: aisles.length ? Math.min(...aisles.map(a => a.gap)) : null};
  }

  // ---------- rendering ----------
  const el = (tag, attrs, parent) => { const n = document.createElementNS(SVGNS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); parent?.append(n); return n; };
  const pts = ps => ps.map(p => `${p.x},${p.z}`).join(' ');
  const zoneColor = z => z.color || colors[0];
  function drawPlan() {
    if (!vb) fit();
    svg.setAttribute('viewBox', `${vb.x} ${vb.z} ${vb.w} ${vb.h}`);
    svg.innerHTML = '';
    const s = getState(), k = px(), selIds = sel?.type === 'racks' ? sel.ids : new Set();
    const showAccess = tool === 'robot' && report;
    for (const z of s.zones) {
      if (hidden.has(z.id)) continue;
      const c = zoneColor(z), g = el('g', {'data-zone': z.id}, svg);
      el('polygon', {points: pts(zonePoints(z)), fill: c, 'fill-opacity': .16, stroke: c, 'stroke-opacity': .55, 'stroke-width': k, rx: 6 * k}, g);
      const top = zonePoints(z).reduce((a, p) => p.z < a.z || p.z === a.z && p.x < a.x ? p : a);
      el('circle', {cx: top.x + 8 * k, cy: top.z + 8 * k, r: 2.5 * k, fill: c}, g);
      const t = el('text', {x: top.x + 14 * k, y: top.z + 11.2 * k, 'font-size': 9 * k, fill: '#000'}, g); t.textContent = z.name;
      if (sel?.type === 'zone' && sel.id === z.id) {
        el('polygon', {points: pts(zonePoints(z)), fill: 'none', stroke: 'var(--accent-primary)', 'stroke-width': 1.5 * k}, svg);
        if (tool !== 'points') for (const p of zonePoints(z)) el('rect', {x: p.x - 3 * k, y: p.z - 3 * k, width: 6 * k, height: 6 * k, fill: '#fff', stroke: 'var(--accent-primary)', 'stroke-width': k}, svg);
      }
    }
    const mv = drag?.kind === 'move' ? drag : null;
    for (const r of s.racks) {
      const z = s.zones.find(z => z.id === r.zone);
      if (hidden.has(r.zone)) continue;
      const moving = mv && selIds.has(r.id), dx = moving ? mv.dx : 0, dz = moving ? mv.dz : 0;
      const bad = showAccess && report.blocked.has(r.id) || moving && !mv.valid;
      el('rect', {x: r.x - r.width / 2 + dx, y: r.z - r.depth / 2 + dz, width: r.width, height: r.depth, rx: 1.2 * k,
        fill: bad ? 'var(--status-danger-tertiary)' : selIds.has(r.id) ? 'var(--accent-secondary)' : '#fff',
        stroke: bad ? 'var(--status-danger)' : selIds.has(r.id) ? 'var(--accent-primary)' : 'rgba(0,0,0,.3)', 'stroke-width': (selIds.has(r.id) || bad ? 1.5 : .75) * k, 'data-rack': r.id}, svg);
      if (selIds.has(r.id) && selIds.size === 1 && !moving)
        for (const [hx, hz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) el('rect', {x: r.x + hx * r.width / 2 - 2.5 * k, y: r.z + hz * r.depth / 2 - 2.5 * k, width: 5 * k, height: 5 * k, fill: '#fff', stroke: 'var(--accent-primary)', 'stroke-width': k}, svg);
      void z;
    }
    // Docks: the belt footprint, its name and the point where the robot stops.
    for (const d of docksOf(s)) {
      const moving = drag?.kind === 'dock' && drag.id === d.id, at = moving ? {...d, ...drag.to} : d, b = dockRect(at), port = dockPort(at);
      const on = sel?.type === 'dock' && sel.id === d.id, bad = moving && !drag.valid || showAccess && report.blocked.has(d.id);
      const g = el('g', {'data-dock': d.id}, svg);
      el('rect', {x: b.x - b.width / 2, y: b.z - b.depth / 2, width: b.width, height: b.depth, rx: 1.2 * k, 'data-dock': d.id,
        fill: bad ? 'var(--status-danger-tertiary)' : on ? 'var(--accent-secondary)' : d.kind === 'inbound' ? '#e4efdd' : '#f4edd2',
        stroke: bad ? 'var(--status-danger)' : on ? 'var(--accent-primary)' : 'rgba(0,0,0,.35)', 'stroke-width': (on || bad ? 1.5 : .75) * k}, g);
      el('circle', {cx: port.x, cy: port.z, r: 1.3, fill: 'none', stroke: on ? 'var(--accent-primary)' : 'rgba(0,0,0,.35)', 'stroke-width': k, 'stroke-dasharray': `${2 * k} ${2 * k}`, 'data-dock': d.id}, g);
      const t = el('text', {x: b.x, y: b.z - b.depth / 2 - 4 * k, 'font-size': 9 * k, fill: '#000', 'text-anchor': 'middle'}, g); t.textContent = d.id;
    }
    if (showAccess) for (const a of report.aisles) {
      el('line', {x1: a.line[0].x, y1: a.line[0].z, x2: a.line[1].x, y2: a.line[1].z, stroke: a.ok ? 'var(--status-success-secondary)' : 'var(--status-danger)', 'stroke-width': 3 * k, 'stroke-linecap': 'round'}, svg);
      if (!a.ok) tag({x: (a.line[0].x + a.line[1].x) / 2, z: a.line[0].z - 8 * k}, `Aisle ${r1(a.gap)} m`, true);
    }
    // Drafts: new zone, polygon, edit points, row, ruler, marquee.
    if (pending) {
      const ps = pending.points || zonePoints(pending);
      el('polygon', {points: pts(ps), fill: newColor, 'fill-opacity': .16, stroke: 'var(--accent-primary)', 'stroke-width': 1.5 * k, 'stroke-dasharray': `${4 * k} ${3 * k}`}, svg);
      for (const p of ps) el('rect', {x: p.x - 3 * k, y: p.z - 3 * k, width: 6 * k, height: 6 * k, fill: '#fff', stroke: 'var(--accent-primary)', 'stroke-width': k}, svg);
      const b = pending.points ? polygonZone(pending.points) : pending;
      tag({x: b.x + b.w / 2, z: b.z + b.d / 2}, `${r1(b.w)} × ${r1(b.d)} m`);
    }
    if (poly?.length) {
      el('polyline', {points: pts(hover ? [...poly, hover] : poly), fill: 'none', stroke: 'var(--accent-primary)', 'stroke-width': 1.5 * k, 'stroke-dasharray': `${4 * k} ${3 * k}`}, svg);
      for (const p of poly) el('circle', {cx: p.x, cy: p.z, r: 3 * k, fill: '#fff', stroke: 'var(--accent-primary)', 'stroke-width': k}, svg);
    }
    if (tool === 'points' && sel?.type === 'zone') {
      const z = s.zones.find(z => z.id === sel.id), ps = drag?.kind === 'point' ? drag.next : zonePoints(z);
      el('polygon', {points: pts(ps), fill: 'none', stroke: 'var(--accent-primary)', 'stroke-width': 1.5 * k}, svg);
      ps.forEach((p, i) => el('circle', {cx: p.x, cy: p.z, r: (i === pointIndex ? 4.5 : 3.5) * k, fill: i === pointIndex ? 'var(--accent-primary)' : '#fff', stroke: 'var(--accent-primary)', 'stroke-width': 1.5 * k, 'data-point': i}, svg));
    }
    if (rowPreview) {
      const c = rackDraft();
      for (const q of rowPreview) el('rect', {x: q.x - c.width / 2, y: q.z - c.depth / 2, width: c.width, height: c.depth, rx: 1.2 * k, fill: 'var(--accent-secondary)', stroke: 'var(--accent-primary)', 'stroke-width': k}, svg);
      const last = rowPreview.at(-1); tag({x: last.x, z: last.z - c.depth / 2 - 8 * k}, `${rowPreview.length} ${rowPreview.length === 1 ? 'rack' : 'racks'}`);
    }
    if (ruler) {
      el('line', {x1: ruler.a.x, y1: ruler.a.z, x2: ruler.b.x, y2: ruler.b.z, stroke: 'var(--accent-primary)', 'stroke-width': 1.5 * k, 'stroke-dasharray': `${4 * k} ${3 * k}`}, svg);
      tag({x: (ruler.a.x + ruler.b.x) / 2, z: (ruler.a.z + ruler.b.z) / 2 - 8 * k}, `${r1(Math.hypot(ruler.b.x - ruler.a.x, ruler.b.z - ruler.a.z))} m`);
    }
    if (drag?.kind === 'marquee' && drag.end) {
      const x = Math.min(drag.p.x, drag.end.x), z = Math.min(drag.p.z, drag.end.z);
      el('rect', {x, y: z, width: Math.abs(drag.end.x - drag.p.x), height: Math.abs(drag.end.z - drag.p.z), fill: 'var(--accent-secondary)', 'fill-opacity': .4, stroke: 'var(--accent-primary)', 'stroke-width': k}, svg);
    }
  }
  // Canvas tag (Figma "Canvas tag"): dark label, red for warnings. Drawn in screen units.
  function tag(p, text, danger = false) {
    const k = px(), w = (text.length * 6 + 16) * k, h = 20 * k;
    el('rect', {x: p.x - w / 2, y: p.z - h / 2, width: w, height: h, rx: 7 * k, fill: danger ? 'var(--status-danger)' : '#111'}, svg);
    const t = el('text', {x: p.x, y: p.z + 3.8 * k, 'font-size': 11 * k, fill: '#fff', 'text-anchor': 'middle'}, svg); t.textContent = text;
  }

  const RAIL = [['select', 'select', 'Select (V)'], ['hand', 'hand', 'Hand (H)'], '|', ['zone', 'rect', 'Zone', true], ['row', 'rack', 'Place row (R)', true], '|', ['ruler', 'ruler', 'Measure (U)'], ['robot', 'robot', 'Robot access']];
  const ZONE_TOOLS = [['rect', 'rect', 'Rectangle', 'M'], ['polygon', 'polygon', 'Polygon', 'P'], ['points', 'points', 'Edit points', 'A']];
  function renderRail() {
    const zoneIcon = (ZONE_TOOLS.find(t => t[0] === tool) || ZONE_TOOLS[0])[1];
    $('#edRail').innerHTML = RAIL.map(t => t === '|' ? '<i class="ed-hdiv"></i>' : `<button class="ed-ib${(t[0] === 'zone' ? ZONE_TOOLS.some(z => z[0] === tool) : t[0] === tool) ? ' on' : ''}" data-tool="${t[0]}" title="${t[2]}">${ed(t[0] === 'zone' ? zoneIcon : t[1])}${t[3] ? '<em class="ed-marker"></em>' : ''}</button>`).join('');
    $('#edRail').querySelectorAll('[data-tool]').forEach(b => {
      b.onclick = () => b.dataset.tool === 'zone' ? toggleFlyout(b) : setTool(b.dataset.tool);
      b.oncontextmenu = e => { if (b.dataset.tool === 'zone') { e.preventDefault(); toggleFlyout(b); } };
    });
  }
  function toggleFlyout(btn) {
    const f = $('#edFlyout');
    if (!f.hidden) { f.hidden = true; return; }
    f.innerHTML = ZONE_TOOLS.map(([id, icon, label, key]) => `<button data-z="${id}" class="${tool === id ? 'on' : ''}">${ed(icon)}<span>${label}</span><small>${key}</small></button>`).join('');
    f.style.top = `${btn.offsetTop + $('#edRail').offsetTop}px`;
    f.hidden = false;
    f.querySelectorAll('[data-z]').forEach(b => b.onclick = () => { f.hidden = true; setTool(b.dataset.z); });
  }

  function renderObjects() {
    const s = getState();
    $('#edObjects').innerHTML = `<div class="ed-obj-head"><b>Objects</b><span>${s.zones.length} zones · ${s.racks.length} racks · ${docksOf(s).length} docks</span></div>${s.zones.map(z => {
      const racks = s.racks.filter(r => r.zone === z.id), open = expanded.has(z.id), on = sel?.type === 'zone' && sel.id === z.id;
      return `<div class="ed-obj${on ? ' on' : ''}" data-zone="${z.id}"><button class="tw" data-expand="${z.id}" style="transform:rotate(${open ? 0 : -90}deg)">${ed('chevronDown', 14)}</button><i style="background:${zoneColor(z)}"></i><span>${esc(z.name)}</span><small>${racks.length}</small><button class="eye${hidden.has(z.id) ? ' off' : ''}" data-eye="${z.id}">${ed('eye', 14)}</button></div>`
        + (open ? racks.map(r => `<div class="ed-obj rack${sel?.type === 'racks' && sel.ids.has(r.id) ? ' on' : ''}" data-rack="${r.id}">${ed('rack', 14)}<span>${esc(r.id)}</span><button class="eye${hidden.has(z.id) ? ' off' : ''}" data-eye="${z.id}">${ed('eye', 14)}</button></div>`).join('') : '');
    }).join('')}${docksOf(s).map(d => `<div class="ed-obj${sel?.type === 'dock' && sel.id === d.id ? ' on' : ''}" data-dock="${esc(d.id)}">${ed(d.kind === 'inbound' ? 'receiving' : 'dispatch', 14)}<span>${esc(d.id)}</span></div>`).join('')}`;
    const o = $('#edObjects');
    o.querySelectorAll('[data-expand]').forEach(b => b.onclick = e => { e.stopPropagation(); const id = b.dataset.expand; expanded.has(id) ? expanded.delete(id) : expanded.add(id); renderObjects(); });
    o.querySelectorAll('[data-eye]').forEach(b => b.onclick = e => { e.stopPropagation(); const id = b.dataset.eye; hidden.has(id) ? hidden.delete(id) : hidden.add(id); render(); });
    o.querySelectorAll('.ed-obj[data-zone]').forEach(r => r.onclick = () => choose({type: 'zone', id: r.dataset.zone}));
    o.querySelectorAll('.ed-obj[data-dock]').forEach(r => r.onclick = () => { choose({type: 'dock', id: r.dataset.dock}); centerOnDock(r.dataset.dock); render(); });
    o.querySelectorAll('.ed-obj[data-rack]').forEach(r => r.onclick = e => choose({type: 'racks', ids: new Set(e.shiftKey && sel?.type === 'racks' ? [...sel.ids, r.dataset.rack] : [r.dataset.rack])}));
  }

  // ---------- inspector ----------
  const section = (title, body) => `<div class="ed-sec"><div class="ed-sec-head"><b>${title}</b>${ed('chevronDown', 14)}</div>${body}</div>`;
  const prop = (label, value) => `<div class="ed-prop"><span>${label}</span><b>${value}</b></div>`;
  const input = (label, name, value, unit = '') => `<label class="ed-prop"><span>${label}</span><span class="ed-in"><input data-in="${name}" value="${esc(value)}">${unit ? `<em>${unit}</em>` : ''}</span></label>`;
  const colorRow = (hex) => `<div class="ed-prop"><span>Color</span><button class="ed-in ed-colorbtn" data-color><i style="background:${hex}"></i>${esc(hex.toUpperCase())}</button></div>`;
  const banner = () => error ? `<div class="ed-banner">${ed('warning')}<span>${esc(error)}</span></div>` : '';
  const head = (title, sub, actions = '') => `<div class="ed-ins-head"><div><b>${esc(title)}</b><small>${esc(sub)}</small></div><div>${actions}</div></div>`;
  // Rack positions are shown from the top-left corner of their zone.
  const zoneOrigin = r => { const z = getState().zones.find(z => z.id === r.zone); return z ? {x: z.x, z: z.z} : {x: 0, z: 0}; };
  const filled = racks => { const ids = new Set(racks.map(r => r.id)), used = new Set(getState().boxes.filter(b => ids.has(b.rack)).map(b => b.rack + '|' + b.location)); return used.size; };
  function inspectorHTML() {
    const s = getState();
    if (tool === 'robot') {
      report ||= accessReport();
      const r = report;
      return head('Robot access', r.problems.length ? `${r.problems.length} ${r.problems.length === 1 ? 'problem' : 'problems'} found` : 'All aisles are passable')
        + section('Summary', prop('Aisles checked', r.aisles.length) + prop('Passable', r.aisles.filter(a => a.ok).length) + prop('Min. width', r.min === null ? '—' : `${r1(r.min)} m`))
        + (r.problems.length ? section('Problems', r.problems.map((p, i) => `<div class="ed-problem">${ed('warning')}<span>${esc(p.text)}</span><button data-show="${i}">Show</button></div>`).join('')) : '')
        + `<button class="ed-btn" data-cmd="recheck">Check again</button>`;
    }
    if (pending || ['rect', 'polygon'].includes(tool)) {
      const b = pending ? (pending.points ? polygonZone(pending.points) : pending) : null;
      return head('New zone', b ? 'Drag on the floor to draw' : tool === 'polygon' ? 'Click to add corners · click the first corner to close' : 'Choose how to draw')
        + section('Appearance', input('Name', 'newName', newName) + colorRow(newColor))
        + (b ? section('Size', pending.points ? prop('Width', `${r1(b.w)} m`) + prop('Depth', `${r1(b.d)} m`) : input('Width', 'newW', r1(b.w), 'm') + input('Depth', 'newD', r1(b.d), 'm')) + prop('Area', `${fmt(Math.round(zoneArea(b)))} m²`)
          + `<div class="ed-actions"><button data-cmd="dropZone">Cancel</button><button class="primary" data-cmd="createZone">Create zone</button></div>` : '') + banner();
    }
    if (tool === 'row') {
      return head('Place row', 'Drag along the floor to place racks in a line')
        + section('Row', prop('Racks', rowPreview ? rowPreview.length : '—') + input('Gap', 'gap', rowGap, 'm') + prop('Rack', `${rackDraft().width} × ${rackDraft().depth} m · ${rackDraft().shelves} shelves`)) + banner();
    }
    if (tool === 'points' && sel?.type === 'zone') {
      const z = s.zones.find(z => z.id === sel.id), ps = zonePoints(z), p = ps[pointIndex];
      const perim = ps.reduce((n, a, i) => n + Math.hypot(ps[(i + 1) % ps.length].x - a.x, ps[(i + 1) % ps.length].z - a.z), 0);
      return head('Edit zone points', `${z.name} · ${ps.length} points`)
        + (p ? section(`Point ${pointIndex + 1}`, input('X', 'px', r1(p.x), 'm') + input('Y', 'pz', r1(p.z), 'm')) : '')
        + section('Zone', prop('Area', `${fmt(Math.round(zoneArea(z)))} m²`) + prop('Perimeter', `${Math.round(perim)} m`))
        + banner() + `<div class="ed-actions"><button data-cmd="resetPoints">Reset</button><button class="primary" data-cmd="donePoints">Done</button></div>`;
    }
    if (sel?.type === 'dock') {
      const d = docksOf(s).find(d => d.id === sel.id);
      return head(d.id, d.kind === 'inbound' ? 'Receiving dock' : 'Dispatch dock', `<button class="ed-ib" data-cmd="rotate" title="Rotate (R)">${ed('rotate')}</button>`)
        + section('Position', input('X', 'dx', r1(d.x), 'm') + input('Y', 'dz', r1(d.z), 'm') + `<label class="ed-prop"><span>Rotation</span><span class="ed-in"><select data-in="drot">${[0, 90, 180, 270].map(a => `<option ${((d.rotation || 0) * 90) === a ? 'selected' : ''}>${a}</option>`).join('')}</select><em>°</em></span></label>`)
        + section('Robots', prop('Stop point', 'Dashed circle on the plan')) + banner();
    }
    if (sel?.type === 'zone') {
      const z = s.zones.find(z => z.id === sel.id), racks = s.racks.filter(r => r.zone === z.id), rect = !z.points;
      return head(z.name, `Zone · ${racks.length} racks`, `<button class="ed-ib" data-cmd="dupZone" title="Duplicate">${ed('duplicate')}</button><button class="ed-ib" data-cmd="delete" title="Delete">${ed('trash')}</button>`)
        + section('Appearance', input('Name', 'name', z.name) + colorRow(zoneColor(z)))
        + section('Dimensions', (rect ? input('Width', 'w', r1(z.w), 'm') + input('Depth', 'd', r1(z.d), 'm') : prop('Width', `${r1(z.w)} m`) + prop('Depth', `${r1(z.d)} m`)) + prop('Area', `${fmt(Math.round(zoneArea(z)))} m²`))
        + section('Content', prop('Racks', racks.length) + prop('Locations', fmt(racks.reduce((n, r) => n + r.shelves * r.places, 0)))) + banner();
    }
    if (sel?.type === 'racks') {
      const racks = s.racks.filter(r => sel.ids.has(r.id)), zones = [...new Set(racks.map(r => s.zones.find(z => z.id === r.zone)?.name))].join(', ');
      const locs = racks.reduce((n, r) => n + locations(r).length, 0), actions = `<button class="ed-ib" data-cmd="rotate" title="Rotate (R)">${ed('rotate')}</button><button class="ed-ib" data-cmd="duplicate" title="Duplicate">${ed('duplicate')}</button><button class="ed-ib" data-cmd="delete" title="Delete">${ed('trash')}</button>`;
      if (racks.length === 1) {
        const r = racks[0];
        return head(`Rack ${r.id}`, zones, actions) + section('Info', prop('Locations', `${locs} · ${filled(racks)} filled`) + banner())
          + section('Position', input('X', 'x', r1(r.x - zoneOrigin(r).x), 'm') + input('Y', 'z', r1(r.z - zoneOrigin(r).z), 'm') + `<label class="ed-prop"><span>Rotation</span><span class="ed-in"><select data-in="rot">${[0, 90, 180, 270].map(d => `<option ${((r.rotation || 0) * 90) === d ? 'selected' : ''}>${d}</option>`).join('')}</select><em>°</em></span></label>`);
      }
      return head(`${racks.length} racks`, zones, actions) + section('Info', prop('Locations', `${locs} · ${filled(racks)} filled`)) + banner();
    }
    const r = report || accessReport();
    return head('Layout', 'Nothing selected') + section('Warehouse', prop('Zones', s.zones.length) + prop('Racks', s.racks.length) + prop('Locations', fmt(s.racks.reduce((n, r) => n + r.shelves * r.places, 0))))
      + section('Robot access', prop('Aisles', r.problems.length ? `${r.problems.length} ${r.problems.length === 1 ? 'problem' : 'problems'}` : 'All passable')) + banner();
  }
  function renderInspector() {
    const box = $('#edInspector');
    box.innerHTML = inspectorHTML();
    box.querySelectorAll('[data-cmd]').forEach(b => b.onclick = () => command(b.dataset.cmd));
    box.querySelectorAll('[data-show]').forEach(b => b.onclick = () => { const p = report.problems[Number(b.dataset.show)]; if (p.dock) { sel = {type: 'dock', id: p.dock}; centerOnDock(p.dock); } else { sel = {type: 'racks', ids: new Set(p.ids)}; centerOn(p.ids); } render(); });
    box.querySelectorAll('[data-in]').forEach(i => { i.onchange = () => edit(i.dataset.in, i.value); i.onkeydown = e => { if (e.key === 'Enter') i.blur(); }; });
    box.querySelector('[data-color]')?.addEventListener('click', e => openColor(e.currentTarget));
  }
  function edit(name, value) {
    const s = getState(), n = Number(value);
    if (name === 'newName') { newName = value; return; }
    if (name === 'gap') { rowGap = Math.max(1, n || 1); return render(); } // racks keep at least 1 m apart
    if (name === 'newW' || name === 'newD') { if (n >= 4) pending[name === 'newW' ? 'w' : 'd'] = n; return render(); }
    if (sel?.type === 'zone') {
      const z = s.zones.find(z => z.id === sel.id);
      if (name === 'name') return apply(() => { if (!value.trim()) throw Error('Enter a zone name.'); z.name = value.trim(); });
      if (name === 'w' || name === 'd') return apply(() => { if (!(n >= 4)) throw Error('Zones are at least 4 m on each side.'); applyLayoutEdit(s, {type: 'zone', id: z.id, points: zonePoints({...z, [name]: n})}); delete s.zones.find(x => x.id === z.id).points; Object.assign(s.zones.find(x => x.id === z.id), {[name]: n}); });
      if (name === 'px' || name === 'pz') return apply(() => { const ps = zonePoints(z).map(p => ({...p})); ps[pointIndex][name === 'px' ? 'x' : 'z'] = n; applyLayoutEdit(s, {type: 'zone', id: z.id, points: ps}); });
    }
    if (sel?.type === 'dock') {
      const d = docksOf(s).find(d => d.id === sel.id);
      if (name === 'dx' || name === 'dz') return apply(() => Object.assign(d, snapDock({x: name === 'dx' ? n : d.x, z: name === 'dz' ? n : d.z})));
      if (name === 'drot') return apply(() => { d.rotation = Math.round(n / 90) % 4; });
    }
    if (sel?.type === 'racks' && sel.ids.size === 1) {
      const r = s.racks.find(r => sel.ids.has(r.id));
      const o = zoneOrigin(r);
      if (name === 'x' || name === 'z') return apply(() => applyLayoutEdit(s, {type: 'move', ids: [r.id], dx: name === 'x' ? n + o.x - r.x : 0, dz: name === 'z' ? n + o.z - r.z : 0}));
      if (name === 'rot') { const turns = ((n / 90) - (r.rotation || 0) + 4) % 4; return apply(() => { for (let i = 0; i < turns; i++) applyLayoutEdit(s, {type: 'rotate', ids: [r.id]}); }); }
    }
  }
  function openColor(btn) {
    const box = $('#edColor'), current = sel?.type === 'zone' ? zoneColor(getState().zones.find(z => z.id === sel.id)) : newColor;
    box.innerHTML = `<div class="ed-swatches">${colors.map(c => `<button data-c="${c}" style="background:${c}" class="${c === current ? 'on' : ''}"></button>`).join('')}</div><label class="ed-hex"><input type="color" value="${current}"><input data-hex value="${current.toUpperCase()}" maxlength="7"></label>`;
    const r = btn.getBoundingClientRect(), host = root.getBoundingClientRect();
    box.style.top = `${r.bottom - host.top + 6}px`; box.style.left = `${r.right - host.left - 248}px`; box.hidden = false;
    const set = c => { if (!/^#[0-9a-f]{6}$/i.test(c)) return; if (sel?.type === 'zone') apply(() => { getState().zones.find(z => z.id === sel.id).color = c; }); else { newColor = c; render(); } box.hidden = true; };
    box.querySelectorAll('[data-c]').forEach(b => b.onclick = () => set(b.dataset.c));
    box.querySelector('input[type=color]').onchange = e => set(e.target.value);
    box.querySelector('[data-hex]').onchange = e => set(e.target.value.trim());
  }

  // ---------- context toolbar over the selection (2D) ----------
  function renderContext() {
    const c = $('#edContext');
    if (view !== '2D' || sel?.type !== 'racks' || drag || tool !== 'select') { c.hidden = true; return; }
    const racks = getState().racks.filter(r => sel.ids.has(r.id));
    if (!racks.length) { c.hidden = true; return; }
    const top = Math.min(...racks.map(r => r.z - r.depth / 2)), cx = (Math.min(...racks.map(r => r.x - r.width / 2)) + Math.max(...racks.map(r => r.x + r.width / 2))) / 2;
    const p = toScreen({x: cx, z: top});
    c.innerHTML = [['rotate', 'Rotate'], ['duplicate', 'Duplicate'], ['access', 'Check robot access', 'robot'], ['delete', 'Delete', 'trash']].map(([cmd, title, icon]) => `<button class="ed-ib" data-cmd="${cmd}" title="${title}">${ed(icon || cmd)}</button>`).join('');
    c.hidden = false; c.style.left = `${p.x - c.offsetWidth / 2}px`; c.style.top = `${p.y - 48}px`;
    c.querySelectorAll('[data-cmd]').forEach(b => b.onclick = () => command(b.dataset.cmd));
  }

  function render() {
    if (!open) return;
    root.dataset.view = view;
    root.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === view));
    $('[data-cmd=undo]').disabled = !undo.length; $('[data-cmd=redo]').disabled = !redo.length;
    $('[data-cmd=snap]').classList.toggle('on', snap);
    renderRail(); renderObjects(); renderInspector();
    if (view === '2D') drawPlan();
    renderContext();
  }

  // ---------- commands ----------
  const selectedRacks = () => sel?.type === 'racks' ? [...sel.ids] : [];
  function command(cmd) {
    const s = getState();
    if (cmd === 'undo') return step(undo, redo);
    if (cmd === 'redo') return step(redo, undo);
    if (cmd === 'snap') { snap = !snap; return render(); }
    if (cmd === 'save') return close(true);
    if (cmd === 'cancel') return cancel();
    if (cmd === 'recheck') { report = accessReport(); return render(); }
    if (cmd === 'access') { report = null; return setTool('robot'); }
    if (cmd === 'rotate' && sel?.type === 'dock') return apply(() => { const d = docksOf(s).find(d => d.id === sel.id); d.rotation = ((d.rotation || 0) + 1) % 4; });
    if (cmd === 'rotate' && selectedRacks().length) return apply(() => applyLayoutEdit(s, {type: 'rotate', ids: selectedRacks()}));
    if (cmd === 'duplicate' && selectedRacks().length) {
      const racks = s.racks.filter(r => sel.ids.has(r.id)), w = Math.max(...racks.map(r => r.x + r.width / 2)) - Math.min(...racks.map(r => r.x - r.width / 2)), d = Math.max(...racks.map(r => r.z + r.depth / 2)) - Math.min(...racks.map(r => r.z - r.depth / 2));
      const before = new Set(s.racks.map(r => r.id));
      for (const [dx, dz] of [[w + 1.5, 0], [0, d + 4], [-(w + 1.5), 0], [0, -(d + 4)]]) {
        const next = {...s, racks: s.racks.map(r => ({...r}))};
        try { applyLayoutEdit(next, {type: 'copy', ids: selectedRacks(), dx, dz}); validateDocks(next); validateLayoutAccess(s.racks, next.racks, docksOf(s)); } catch { continue; }
        apply(() => applyLayoutEdit(s, {type: 'copy', ids: selectedRacks(), dx, dz}));
        sel = {type: 'racks', ids: new Set(getState().racks.filter(r => !before.has(r.id)).map(r => r.id))};
        return render();
      }
      error = 'No free space next to the selection for a copy.'; return render();
    }
    if (cmd === 'delete') {
      if (sel?.type === 'zone') {
        const ids = new Set(s.racks.filter(r => r.zone === sel.id).map(r => r.id)), id = sel.id;
        if (s.boxes.some(b => ids.has(b.rack))) { error = 'Move or ship all boxes in this zone before deleting it.'; return render(); }
        if (apply(() => { s.racks = s.racks.filter(r => !ids.has(r.id)); s.zones = s.zones.filter(z => z.id !== id); })) sel = null;
        return render();
      }
      if (selectedRacks().length && apply(() => applyLayoutEdit(s, {type: 'delete', ids: selectedRacks()}))) { sel = null; render(); }
      return;
    }
    if (cmd === 'dupZone' && sel?.type === 'zone') {
      const z = s.zones.find(z => z.id === sel.id), all = s.zones.flatMap(zonePoints), dx = Math.ceil(Math.max(...all.map(p => p.x)) - Math.min(...zonePoints(z).map(p => p.x)) + 4);
      let id;
      if (apply(() => {
        id = addZone(s, {points: zonePoints(z).map(p => ({x: p.x + dx, z: p.z}))});
        Object.assign(s.zones.find(x => x.id === id), {name: `${z.name} copy`, color: z.color});
        for (const r of s.racks.filter(r => r.zone === z.id)) { const copy = addRack(s, id, r.x + dx, r.z, r); Object.assign(s.racks.find(x => x.id === copy), {rotation: r.rotation || 0, width: r.width, depth: r.depth}); }
      })) { sel = {type: 'zone', id}; fit(); render(); }
      return;
    }
    if (cmd === 'dropZone') { pending = null; poly = null; return render(); }
    if (cmd === 'createZone' && pending) {
      const shape = pending.points ? {points: pending.points} : {x: pending.x, z: pending.z, w: pending.w, d: pending.d};
      let id;
      if (apply(() => { id = addZone(s, shape); const name = newName.trim() || `Zone ${id}`; Object.assign(s.zones.find(z => z.id === id), {name, color: newColor}); const e = s.history.find(e => e.type === 'Zone created'); if (e) e.detail = name; })) {
        pending = null; poly = null; sel = {type: 'zone', id}; tool = 'select'; render();
      }
      return;
    }
    if (cmd === 'resetPoints' && sel?.type === 'zone' && pointsStart) return apply(() => applyLayoutEdit(s, {type: 'zone', id: sel.id, points: pointsStart}));
    if (cmd === 'donePoints') return setTool('select');
  }
  function centerOn(ids) {
    const racks = getState().racks.filter(r => ids.includes(r.id));
    if (!racks.length || view !== '2D') return;
    const x = racks.reduce((n, r) => n + r.x, 0) / racks.length, z = racks.reduce((n, r) => n + r.z, 0) / racks.length;
    vb.x = x - vb.w / 2; vb.z = z - vb.h / 2;
  }
  function centerOnDock(id) {
    const d = docksOf(getState()).find(d => d.id === id);
    if (d && view === '2D' && vb) { const b = dockRect(d); vb.x = b.x - vb.w / 2; vb.z = b.z - vb.h / 2; }
  }
  function nextZoneDefaults() {
    const s = getState(), used = new Set(s.zones.map(z => z.name));
    let i = 0; while (used.has(`Zone ${String.fromCharCode(65 + i)}`)) i++;
    newName = `Zone ${String.fromCharCode(65 + i)}`;
    newColor = colors.find(c => !s.zones.some(z => z.color === c)) || colors[s.zones.length % colors.length];
  }
  function setTool(t) {
    if (t === 'points' && sel?.type !== 'zone') { const z = getState().zones[0]; if (z) sel = {type: 'zone', id: z.id}; }
    tool = t; pending = t === 'rect' || t === 'polygon' ? pending : null; poly = t === 'polygon' ? poly : null;
    rowPreview = null; ruler = null; pointIndex = null; error = '';
    if (t === 'rect' || t === 'polygon') { if (!pending) nextZoneDefaults(); }
    if (t === 'points') pointsStart = zonePoints(getState().zones.find(z => z.id === sel.id)).map(p => ({...p}));
    if (t === 'robot') report = accessReport();
    $('#edFlyout').hidden = true;
    sync3D(); render();
  }
  // In 3D the scene's own builder handles pointer input; the chrome stays the same.
  function sync3D() {
    if (view !== '3D') return;
    if (tool === 'rect') scene.setMode('zone');
    else if (tool === 'polygon') scene.setMode('polygon');
    else builderTools.tool(tool === 'row' ? 'row' : tool === 'points' ? 'zone' : 'select');
  }
  function choose(s) { sel = s; if (tool !== 'points') tool = tool === 'robot' ? 'robot' : 'select'; error = ''; onSelect?.(s); render(); }

  // ---------- 2D pointer input ----------
  const rackAt = p => getState().racks.find(r => !hidden.has(r.zone) && Math.abs(p.x - r.x) <= r.width / 2 && Math.abs(p.z - r.z) <= r.depth / 2);
  const dockAt = p => docksOf(getState()).find(d => { const b = dockRect(d), q = dockPort(d); return Math.abs(p.x - b.x) <= b.width / 2 && Math.abs(p.z - b.z) <= b.depth / 2 || Math.hypot(p.x - q.x, p.z - q.z) < 1.5; });
  const zoneAt = p => getState().zones.find(z => !hidden.has(z.id) && contains(z, p));
  svg.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.button !== 1) return;
    $('#edFlyout').hidden = true; $('#edColor').hidden = true;
    const p = toWorld(e), round = q => ({x: Math.round(q.x), z: Math.round(q.z)});
    svg.setPointerCapture(e.pointerId);
    if (tool === 'hand' || e.button === 1 || space) { drag = {kind: 'pan', sx: e.clientX, sy: e.clientY, vb: {...vb}}; return; }
    if (tool === 'rect') { pending = null; drag = {kind: 'rect', p: round(p)}; return; }
    if (tool === 'polygon') {
      const q = round(p);
      if (poly?.length >= 3 && Math.hypot(q.x - poly[0].x, q.z - poly[0].z) < 10 * px()) { try { pending = polygonZone(poly); poly = null; } catch (err) { error = err.message; } return render(); }
      poly = [...(poly || []), q]; return render();
    }
    if (tool === 'row') { drag = {kind: 'row', p: round(p)}; return; }
    if (tool === 'ruler') { ruler = {a: p, b: p}; drag = {kind: 'ruler'}; return render(); }
    if (tool === 'points' && sel?.type === 'zone') {
      const ps = zonePoints(getState().zones.find(z => z.id === sel.id)), i = ps.findIndex(q => Math.hypot(q.x - p.x, q.z - p.z) < 8 * px());
      if (i >= 0) { pointIndex = i; drag = {kind: 'point', i, p, ps: ps.map(q => ({...q})), next: ps}; return render(); }
      const z = zoneAt(p); if (z && z.id !== sel.id) { sel = {type: 'zone', id: z.id}; pointsStart = zonePoints(z).map(q => ({...q})); pointIndex = null; }
      return render();
    }
    const dock = dockAt(p);
    if (dock) {
      sel = {type: 'dock', id: dock.id}; if (tool === 'robot') tool = 'select';
      drag = {kind: 'dock', id: dock.id, p, to: {x: dock.x, z: dock.z}, valid: true};
      error = ''; onSelect?.(null); return render();
    }
    const r = rackAt(p);
    if (r) {
      if (e.shiftKey) { const ids = new Set(sel?.type === 'racks' ? sel.ids : []); ids.has(r.id) ? ids.delete(r.id) : ids.add(r.id); sel = ids.size ? {type: 'racks', ids} : null; }
      else if (!(sel?.type === 'racks' && sel.ids.has(r.id))) sel = {type: 'racks', ids: new Set([r.id])};
      if (sel) drag = {kind: 'move', p, anchor: r, dx: 0, dz: 0, valid: true};
      if (tool === 'robot') tool = 'select';
      error = ''; onSelect?.(sel?.ids?.size === 1 ? {type: 'rack', id: r.id} : null); return render();
    }
    const z = zoneAt(p);
    if (e.shiftKey || !z) { if (!e.shiftKey) sel = null; drag = {kind: 'marquee', p}; return render(); }
    choose({type: 'zone', id: z.id});
  });
  svg.addEventListener('pointermove', e => {
    const p = toWorld(e);
    if (tool === 'polygon' && poly) { hover = {x: Math.round(p.x), z: Math.round(p.z)}; return drawPlan(); }
    if (!drag) return;
    if (drag.kind === 'pan') { const k = vb.w / svg.getBoundingClientRect().width; vb.x = drag.vb.x - (e.clientX - drag.sx) * k; vb.z = drag.vb.z - (e.clientY - drag.sy) * k; return drawPlan(); }
    if (drag.kind === 'rect') { const a = drag.p, b = {x: Math.round(p.x), z: Math.round(p.z)}; pending = {x: Math.min(a.x, b.x), z: Math.min(a.z, b.z), w: Math.abs(b.x - a.x), d: Math.abs(b.z - a.z)}; return drawPlan(); }
    if (drag.kind === 'row') { rowPreview = rowPositions(drag.p, p, rackDraft(), rowGap); return drawPlan(); }
    if (drag.kind === 'ruler') { ruler.b = p; return drawPlan(); }
    if (drag.kind === 'marquee') { drag.end = p; return drawPlan(); }
    if (drag.kind === 'point') { const dx = Math.round(p.x - drag.p.x), dz = Math.round(p.z - drag.p.z); drag.next = drag.ps.map((q, i) => i === drag.i ? {x: q.x + dx, z: q.z + dz} : q); return drawPlan(); }
    if (drag.kind === 'dock') {
      const d = docksOf(getState()).find(d => d.id === drag.id);
      drag.to = snapDock({x: d.x + p.x - drag.p.x, z: d.z + p.z - drag.p.z});
      const s = getState(), next = {...s, docks: docksOf(s).map(o => o.id === d.id ? {...o, ...drag.to} : o)};
      try { validateDocks(next); validateLayoutAccess(s.racks, s.racks, docksOf(s), next.docks); drag.valid = true; drag.why = ''; } catch (err) { drag.valid = false; drag.why = err.message; }
      return drawPlan();
    }
    if (drag.kind === 'move') {
      let dx = Math.round(p.x - drag.p.x), dz = Math.round(p.z - drag.p.z);
      if (snap && !e.altKey) { const a = drag.anchor, q = snapRack({racks: getState().racks.filter(r => !sel.ids.has(r.id))}, {x: a.x + dx, z: a.z + dz}, a); dx = q.x - a.x; dz = q.z - a.z; }
      drag.dx = dx; drag.dz = dz;
      const s = getState(), next = {...s, racks: s.racks.map(r => ({...r}))};
      try { applyLayoutEdit(next, {type: 'move', ids: [...sel.ids], dx, dz}); validateDocks(next); validateLayoutAccess(s.racks, next.racks, docksOf(s)); drag.valid = true; drag.why = ''; } catch (err) { drag.valid = false; drag.why = err.message; }
      $('#edContext').hidden = true; return drawPlan();
    }
  });
  svg.addEventListener('pointerup', () => {
    const d = drag; drag = null;
    if (!d) return;
    const s = getState();
    if (d.kind === 'rect') { if (pending && (pending.w < 4 || pending.d < 4)) { pending = null; error = 'Draw a zone at least 4 × 4 m.'; } return render(); }
    if (d.kind === 'row') {
      const qs = rowPreview || []; rowPreview = null;
      if (qs.length) apply(() => { for (const q of qs) addRack(s, s.zones.find(z => contains(z, q))?.id, q.x, q.z, rackDraft()); });
      return render();
    }
    if (d.kind === 'point') { apply(() => applyLayoutEdit(s, {type: 'zone', id: sel.id, points: d.next})); return; }
    if (d.kind === 'marquee' && d.end) {
      const x0 = Math.min(d.p.x, d.end.x), x1 = Math.max(d.p.x, d.end.x), z0 = Math.min(d.p.z, d.end.z), z1 = Math.max(d.p.z, d.end.z);
      const ids = new Set([...(sel?.type === 'racks' ? sel.ids : []), ...s.racks.filter(r => !hidden.has(r.zone) && r.x >= x0 && r.x <= x1 && r.z >= z0 && r.z <= z1).map(r => r.id)]);
      sel = ids.size ? {type: 'racks', ids} : null;
    }
    if (d.kind === 'dock') {
      const dock = docksOf(s).find(x => x.id === d.id);
      if (d.to.x === dock.x && d.to.z === dock.z) return render();
      if (!d.valid) { error = d.why; return render(); }
      apply(() => Object.assign(dock, d.to)); return;
    }
    if (d.kind === 'move' && (d.dx || d.dz)) { if (!d.valid) { error = d.why; return render(); } apply(() => applyLayoutEdit(s, {type: 'move', ids: [...sel.ids], dx: d.dx, dz: d.dz})); return; }
    render();
  });
  svg.addEventListener('dblclick', e => {
    if (tool !== 'points' || sel?.type !== 'zone') return;
    const p = toWorld(e), ps = zonePoints(getState().zones.find(z => z.id === sel.id)).map(q => ({...q}));
    let best = null;
    ps.forEach((a, i) => { const b = ps[(i + 1) % ps.length], dx = b.x - a.x, dz = b.z - a.z, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz))), q = {x: Math.round(a.x + t * dx), z: Math.round(a.z + t * dz)}, dist = Math.hypot(p.x - q.x, p.z - q.z); if (!best || dist < best.dist) best = {i, q, dist}; });
    if (best && best.dist < 10 * px()) { ps.splice(best.i + 1, 0, best.q); pointIndex = best.i + 1; apply(() => applyLayoutEdit(getState(), {type: 'zone', id: sel.id, points: ps})); }
  });
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const p = toWorld(e), k = Math.exp(e.deltaY * .0015), w = Math.min(2000, Math.max(20, vb.w * k)), f = w / vb.w;
    vb = {x: p.x - (p.x - vb.x) * f, z: p.z - (p.z - vb.z) * f, w, h: vb.h * f};
    drawPlan(); renderContext();
  }, {passive: false});
  let space = false;
  document.addEventListener('keydown', e => {
    if (!open || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || document.querySelector('#dialog')?.open) return;
    const k = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey;
    if (mod && k === 'z') { e.preventDefault(); return command(e.shiftKey ? 'redo' : 'undo'); }
    if (mod) return;
    if (e.key === ' ') { space = true; return; }
    if (e.key === 'Escape') { if (pending || poly) { pending = null; poly = null; } else if (tool !== 'select') { return setTool('select'); } else sel = null; return render(); }
    if (e.key === 'Enter' && poly?.length >= 3) { try { pending = polygonZone(poly); poly = null; } catch (err) { error = err.message; } return render(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel && sel.type !== 'dock') { e.preventDefault(); return command('delete'); }
    if (k === 'r' && (selectedRacks().length || sel?.type === 'dock')) return command('rotate');
    const keys = {v: 'select', h: 'hand', m: 'rect', p: 'polygon', a: 'points', r: 'row', u: 'ruler'};
    if (keys[k]) setTool(keys[k]);
  });
  document.addEventListener('keyup', e => { if (e.key === ' ') space = false; });
  window.addEventListener('resize', () => { if (open) render(); });
  document.addEventListener('pointerdown', e => {
    if (!open) return;
    if (!e.target.closest('#edColor, [data-color]')) $('#edColor').hidden = true;
    if (!e.target.closest('#edFlyout, [data-tool=zone]')) $('#edFlyout').hidden = true;
  });

  root.querySelector('.ed-bar').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.view) { view = b.dataset.view; builderTools.setEnabled(view === '3D'); if (view === '3D') sync3D(); else fit(); return render(); }
    if (b.dataset.cmd) command(b.dataset.cmd);
  });

  // ---------- open / save / cancel ----------
  function cancel() {
    const c = changes();
    if (!c.zones.length && !c.racks.length && !c.docks) return close(false);
    const d = document.querySelector('#dialog');
    d.className = '';
    d.innerHTML = `<div class="lc-dialog"><div class="lc-dlg-head"><h2>Discard changes?</h2><button type="button" class="icon" data-close aria-label="Close"><img class="fg-ic" src="/assets/fg/close.svg" alt=""></button></div><p class="lc-sub">Everything you did in this session will be lost:</p><div class="lc-details">${c.zones.length ? `<div><span>Zones</span><b>${c.zones}</b></div>` : ''}${c.racks.length ? `<div><span>Racks</span><b>${c.racks}</b></div>` : ''}${c.docks ? `<div><span>Docks</span><b>${c.docks}</b></div>` : ''}</div><button class="lc-danger" data-discard>Discard changes</button></div>`;
    d.querySelector('[data-close]').onclick = () => d.close();
    d.querySelector('[data-discard]').onclick = () => { d.close(); restore(baseline); dropLayoutLog(baselineTop); onChange(); close(false); };
    d.showModal();
  }
  function close(saved) {
    const c = changes();
    open = false; root.hidden = true; sel = null; pending = null; poly = null; report = null;
    onExit(saved);
    if (saved && (c.zones.length || c.racks.length || c.docks)) toast('Layout saved', [c.zones.length && `Zones: ${c.zones}`, c.racks.length && `Racks: ${c.racks}`, c.docks && `Docks: ${c.docks}`].filter(Boolean).join(' · '));
  }
  return {
    open() { open = true; root.hidden = false; baseline = snapshot(); baselineTop = getState().history[0]; undo = []; redo = []; error = ''; sel = null; tool = 'select'; view = '2D'; vb = null; report = null; builderTools.setEnabled(false); fit(); render(); requestAnimationFrame(() => { fit(); render(); }); },
    apply, render,
    get isOpen() { return open; },
    // Selections made in the 3D scene.
    select(s) {
      if (!open) return;
      sel = s?.type === 'zone' ? {type: 'zone', id: s.id} : s?.type === 'rack' ? {type: 'racks', ids: new Set([s.id])} : null;
      render();
    },
  };
}
