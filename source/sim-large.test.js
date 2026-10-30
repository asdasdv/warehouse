import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {seed} from './model.js';
import {addWarehouseRobots} from './warehouse-robots.js';
globalThis.document = {createElement: () => ({getContext: () => ({fillRect() {}, fillText() {}})})};

// The demo runs on the large seed (35 zones, ~1200 racks, ~45k boxes). User work must not wait behind the
// background demand: a robot within ~30 s, done within a couple of minutes; and the stock holds its level.
test('large seed: user receive, ship and move are served promptly and stock holds', () => {
  const state = seed('large'), sim = addWarehouseRobots(new T.Scene(), () => state);
  let t = 0;
  const step = () => { sim.update(.1); t += .1; };
  while (sim.robots.every(r => !r.home) && t < 60) step();
  for (let i = 0; i < 600; i++) step(); // a minute of background work first
  const stock = sim.dashboard(state).onSite;

  sim.receive(state.boxes[5000].product, 2);
  const order = sim.ship(state.boxes[20000].product, 2, 'Dispatch 2');
  // A move to a rack in the next zone along.
  const box = state.boxes.find(b => sim.boxInfo(b.id)?.actionable && b.rack.startsWith('C-'));
  const from = state.racks.find(r => r.id === box.rack), to = state.racks.filter(r => r.zone !== from.zone)
    .sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z))[0];
  sim.requestMove(box.id, to.id);

  const t0 = t, first = {}, done = {Receive: [], Ship: [], Move: []};
  let drift = 0;
  for (let i = 0; t - t0 < 540; i++) {
    step();
    for (const k of sim.tasks()) if (k.step >= 0) first[k.kind] ??= t - t0;
    for (const f of sim.takeFinished()) done[f.kind]?.push(t - t0);
    if (i % 50 === 0) drift = Math.max(drift, Math.abs(sim.dashboard(state).onSite / stock - 1));
  }
  const report = JSON.stringify({first, done, drift}, (k, v) => typeof v === 'number' ? +v.toFixed(3) : v);
  // The received boxes first ride the receiving line to their dock (up to ~20 s), so they get 45 s.
  assert.ok(first.Receive <= 45 && first.Ship <= 30 && first.Move <= 30, `a robot came late: ${report}`);
  assert.equal(done.Receive.length, 2, `receipts not put away: ${report}`);
  assert.equal(done.Ship.length, 2, `shipment not delivered: ${report}`);
  assert.equal(done.Move.length, 1, `move not done: ${report}`);
  assert.ok(Math.max(...done.Receive, ...done.Ship, ...done.Move) <= 180, `user work took too long: ${report}`);
  assert.ok(order.shipped.length === 2 && order.allocated.length <= order.quantity);
  assert.ok(drift < .02, `stock drifted ${(drift * 100).toFixed(2)}%: ${report}`);
  assert.ok(sim.stations.filter(s => s.kind === 'inbound').every(s => s.queue.filter(q => !q.user && !q.taken).length <= 2), 'background leaves room on the receiving docks');
  console.log('large seed', report);
});
