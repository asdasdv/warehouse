import test from 'node:test';
import assert from 'node:assert/strict';
import {sortRows, toggleSort} from './table-sort.js';
test('numbers sort high-to-low first, text A→Z first, a second click flips; text sorts naturally', () => {
  assert.deepEqual(toggleSort({key: 'name', dir: 'asc'}, 'n'), {key: 'n', dir: 'desc'});
  let s = toggleSort({key: 'n', dir: 'desc'}, 'name', 'asc');
  assert.deepEqual(s, {key: 'name', dir: 'asc'});
  assert.deepEqual(toggleSort(s, 'name'), {key: 'name', dir: 'desc'});
  const rows = [{name: 'A-10', n: 2}, {name: 'A-2', n: 10}, {name: 'A-1', n: 5}];
  assert.deepEqual(sortRows(rows, s, (r, k) => r[k]).map(r => r.name), ['A-1', 'A-2', 'A-10']);
  assert.deepEqual(sortRows(rows, {key: 'n', dir: 'desc'}, (r, k) => r[k]).map(r => r.n), [10, 5, 2]);
});
