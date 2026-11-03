import test from 'node:test';
import assert from 'node:assert/strict';
import {rowsAligned} from './inventory-page.js';
import {stock, countByRack, zonesByFill} from './phoenix-panel.js';
import {rackCapacity} from './storage.js';
// Rows stand in for <tr data-product> elements: only dataset.product matters to the check.
const tr = p => ({dataset: {product: p}});
test('inventory live patch only reuses rows that still show the same product in the same order', () => {
  assert.equal(rowsAligned([tr('Bolt'), tr('Nut')], [tr('Bolt'), tr('Nut')]), true);
  assert.equal(rowsAligned([tr('Bolt'), tr('Nut')], [tr('Nut'), tr('Bolt')]), false, 'a re-sort must rebuild the table');
  assert.equal(rowsAligned([tr('Bolt'), tr('Nut')], [tr('Bolt')]), false, 'a different row count must rebuild the table');
  assert.equal(rowsAligned([], []), true);
});
// stock() counts through one boxes-per-rack map; the numbers must match the plain per-rack filter it replaced.
const state = {
  zones: [{id: 'A', name: 'Zone A'}, {id: 'B', name: 'Zone B'}],
  racks: [{id: 'A-01', zone: 'A', shelves: 2, places: 2}, {id: 'A-02', zone: 'A', shelves: 2, places: 2}, {id: 'B-01', zone: 'B', shelves: 1, places: 2}],
  boxes: [{id: 'BX-1', rack: 'A-01'}, {id: 'BX-2', rack: 'A-01'}, {id: 'BX-3', rack: 'A-02'}, {id: 'BX-4', rack: 'B-01'}, {id: 'BX-5', rack: ''}],
};
const naive = racks => { const ids = new Set(racks.map(r => r.id)), stored = state.boxes.filter(b => ids.has(b.rack)).length, total = racks.reduce((n, r) => n + rackCapacity(r), 0); return {stored, total, free: total - stored, pct: total ? Math.round(stored / total * 100) : 0}; };
test('stock() with a shared per-rack count matches the per-rack filter', () => {
  const counts = countByRack(state);
  assert.deepEqual([...counts], [['A-01', 2], ['A-02', 1], ['B-01', 1], ['', 1]]);
  assert.deepEqual(stock(state), naive(state.racks));
  assert.deepEqual(stock(state, state.racks, counts), naive(state.racks));
  for (const r of state.racks) assert.deepEqual(stock(state, [r], counts), naive([r]));
  assert.deepEqual(stock(state, [], counts), {stored: 0, total: 0, free: 0, pct: 0});
  assert.deepEqual(zonesByFill(state, counts).map(z => [z.id, z.s]), zonesByFill(state).map(z => [z.id, z.s]));
});
