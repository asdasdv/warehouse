import test from 'node:test';
import assert from 'node:assert/strict';
import {pageButtons} from './pager.js';
const labels = (c, n) => pageButtons(c, n).match(/>([^<]+)</g).map(x => x.slice(1, -1));
test('pager shows first, last and the neighbours of the current page', () => {
  assert.deepEqual(labels(0, 3), ['1', '2', '3']);
  assert.deepEqual(labels(9, 24), ['1', '…', '9', '10', '11', '…', '24']);
  assert.deepEqual(labels(23, 24), ['1', '…', '23', '24']);
});
