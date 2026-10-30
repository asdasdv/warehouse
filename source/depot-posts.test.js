import test from 'node:test';
import assert from 'node:assert/strict';
import {seed} from './model.js';
import {chargingDepots, depotPosts, layoutObstacles} from './docks.js';
import {createRouter} from './robot-routing.js';

test('routes between charging bays go round the charging posts, never through them', () => {
  const s = seed('small'), depots = chargingDepots(s), posts = depotPosts(depots);
  const area = depots.flatMap(d => [{x: d.x - 10, z: d.z - 10}, {x: d.x + d.w + 10, z: d.z + d.d + 10}]);
  const router = createRouter(s.racks, [...layoutObstacles(s), ...posts], area);
  const bays = depots[0].bays, a = bays.find(b => b.face === 1), b = bays.find(b => b.face === -1 && b.z > a.z + 4);
  const path = router.route(a, b);
  assert.ok(path?.length, 'the next aisle is still reachable');
  const inside = (p, r) => Math.abs(p.x - r.x) < r.width / 2 + 1 && Math.abs(p.z - r.z) < r.depth / 2 + 1;
  for (let i = 1; i < path.length; i++) for (let t = 0; t <= 1; t += .1) {
    const p = {x: path[i - 1].x + (path[i].x - path[i - 1].x) * t, z: path[i - 1].z + (path[i].z - path[i - 1].z) * t};
    assert.ok(!posts.some(r => inside(p, r)), `path crosses a post at ${p.x},${p.z}`);
  }
});
