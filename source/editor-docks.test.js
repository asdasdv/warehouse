import test from 'node:test';
import assert from 'node:assert/strict';
import {seed} from './model.js';
import {docksOf, onSpine, snapDock, validateDocks, spineRects} from './docks.js';

// What the editor does while a dock is dragged: the dock follows the pointer along the conveyors (onSpine) or on the
// grid (snapDock), and validateDocks decides whether the preview is red and the drop refused.
const dragTo = (s, d, x, north = d.z < 0) => Object.assign(d, s.spine ? onSpine(s.spine, x, d.kind, north) : {...snapDock({x, z: d.z}), rotation: d.rotation || 0});

test('every seeded layout passes the dock checks', () => {
  for (const size of ['small', 'medium', 'large']) assert.doesNotThrow(() => validateDocks(seed(size)), size);
});
test('a dock cannot be dragged into the receiving or dispatch building', () => {
  const s = seed(), [recv] = docksOf(s), disp = docksOf(s).find(d => d.kind === 'outbound');
  dragTo(s, recv, s.spine.x1 - 8);
  assert.throws(() => validateDocks(s), /Receiving 1 is too close to the receiving building/);
  dragTo(s, recv, s.spine.x1 + 2);
  assert.throws(() => validateDocks(s), /too close to the receiving building/);
  dragTo(s, recv, -150);
  assert.doesNotThrow(() => validateDocks(s));
  dragTo(s, disp, s.spine.x2 - 2);
  assert.throws(() => validateDocks(s), /too close to the dispatch building/);
  dragTo(s, disp, s.spine.x2 + 30);
  assert.throws(() => validateDocks(s), /must sit along the conveyor/);
});
test('a dock off the conveyors is kept clear of the belt, its buildings, racks and other docks', () => {
  const s = seed(), d = docksOf(s)[0], belt = spineRects(s.spine)[0];
  Object.assign(d, {line: false, rotation: 0, x: belt.x, z: 8});
  assert.throws(() => validateDocks(s), /too close to the conveyor/);
  Object.assign(d, {x: s.spine.x2 + 7, z: 4});
  assert.throws(() => validateDocks(s), /too close to the dispatch building/);
  const rack = s.racks[0];
  Object.assign(d, {x: rack.x, z: rack.z});
  assert.throws(() => validateDocks(s), /too close to rack/);
});
test('docks on the conveyors cannot share a spot', () => {
  const s = seed(), [a, b] = docksOf(s);
  dragTo(s, a, b.x, b.z < 0);
  assert.throws(() => validateDocks(s), /overlaps/);
});
test('a typed position that is not a number is refused', () => {
  const s = seed(), d = docksOf(s)[0];
  Object.assign(d, {x: NaN});
  assert.throws(() => validateDocks(s), /valid position/);
});
