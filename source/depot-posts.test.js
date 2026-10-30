import test from 'node:test';
import assert from 'node:assert/strict';
import {seed} from './model.js';
import {chargingDepots, depotPosts, layoutObstacles} from './docks.js';
import {createRouter} from './robot-routing.js';

test('charging posts sit off the lanes: routes between bays and across the depot never pass through a post', () => {
  for (const size of ['small', 'large']) {
  const s = seed(size), depots = chargingDepots(s), posts = depotPosts(depots);
  const area = depots.flatMap(d => [{x: d.x - 10, z: d.z - 10}, {x: d.x + d.w + 10, z: d.z + d.d + 10}]);
  const router = createRouter(s.racks, layoutObstacles(s), area);
  const bays = depots[0].bays, a = bays.find(b => b.face === 1), b = bays.find(b => b.face === -1 && b.z > a.z + 4);
  const last = bays.filter(b => b.face === -1).at(-1);
  for (const path of [router.route(a, b), router.route(a, last)]) {
  assert.ok(path?.length, 'the other aisles are still reachable');
  const inside = (p, r) => Math.abs(p.x - r.x) < r.width / 2 + 1 && Math.abs(p.z - r.z) < r.depth / 2 + 1;
  for (let i = 1; i < path.length; i++) for (let t = 0; t <= 1; t += .1) {
    const p = {x: path[i - 1].x + (path[i].x - path[i - 1].x) * t, z: path[i - 1].z + (path[i].z - path[i - 1].z) * t};
    assert.ok(!posts.some(r => inside(p, r)), `${size}: path crosses a post at ${p.x},${p.z}`);
  }
  }
  }
});
