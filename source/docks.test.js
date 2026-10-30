import test from 'node:test';
import assert from 'node:assert/strict';
import {seed} from './model.js';
import {docksOf, dockRect, dockPort, validateDocks, spineRects} from './docks.js';
import {createRouter, laneDir} from './robot-routing.js';
import {validateLayoutAccess} from './layout-access.js';

test('default docks line both sides of the spine, clear of racks and each other', () => {
  const s = seed(), docks = docksOf(s);
  assert.equal(docks.length, 12);
  assert.equal(docks.filter(d => d.kind === 'inbound').length, 6);
  assert.doesNotThrow(() => validateDocks(s));
  for (const north of [true, false]) {
    const side = docks.filter(d => (d.z < s.spine.z) === north);
    assert.ok(side.some(d => d.kind === 'inbound') && side.some(d => d.kind === 'outbound'), 'each side has both dock kinds');
  }
  // The belt tail meets the spine; robots stop on the far side, in the corridor before the zones.
  for (const d of docks) { const r = dockRect(d); assert.ok(Math.abs(Math.abs(r.z - s.spine.z) - r.depth / 2 - 3.2) < .1 && Math.abs(dockPort(d).z - s.spine.z) === 20, d.id); }
});

test('the spine blocks robots except under its bridges', () => {
  const s = seed(), router = createRouter([], spineRects(s.spine));
  const path = router.route({x: -60, z: -20}, {x: -60, z: 20});
  assert.ok(path?.length);
  const crossing = path.find((p, i) => i && Math.sign(path[i - 1].z) !== Math.sign(p.z));
  assert.ok(s.spine.crossings.some(c => Math.abs(crossing.x - c) < 5), `crossed at x=${crossing.x}`);
});

test('a dock cannot be dropped onto a rack or another dock', () => {
  const s = seed(), docks = docksOf(s), rack = s.racks[0];
  Object.assign(docks[0], {x: rack.x, z: rack.z});
  assert.throws(() => validateDocks(s), /too close to rack/);
  Object.assign(docks[0], {x: docks[1].x, z: docks[1].z});
  assert.throws(() => validateDocks(s), /overlaps/);
});

test('a dock that walls off racks is refused', () => {
  const rack = {id: 'A', x: 0, z: 0, width: 6, depth: 4, rotation: 0}, dock = {id: 'Dispatch 1', kind: 'outbound', x: 0, z: 40, rotation: 0};
  assert.doesNotThrow(() => validateLayoutAccess([rack], [rack], [dock], [dock]));
  assert.throws(() => validateLayoutAccess([rack], [rack], [dock], [{...dock, x: 0, z: 6, rotation: 2}]), /Robot access blocked/);
});

test('robots route along one-way lanes and around docks', () => {
  assert.deepEqual([laneDir(0), laneDir(4), laneDir(8), laneDir(2), laneDir(-4)], [1, -1, 1, 0, -1]);
  const dock = {id: 'D', x: 0, z: 0, rotation: 0}, router = createRouter([], [dockRect(dock)]);
  const path = router.route({x: 0, z: -20}, {x: 0, z: 30}), rect = dockRect(dock);
  assert.ok(path?.length);
  for (const p of path) assert.ok(Math.abs(p.x - rect.x) > rect.width / 2 || Math.abs(p.z - rect.z) > rect.depth / 2, 'never through the dock');
  // Long straight runs follow the lane direction.
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (a.z === b.z && laneDir(a.z)) assert.equal(Math.sign(b.x - a.x), laneDir(a.z));
    if (a.x === b.x && laneDir(a.x) && Math.abs(a.z) > 12) assert.equal(Math.sign(b.z - a.z), laneDir(a.x));
  }
});
