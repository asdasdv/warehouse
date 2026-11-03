import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {seed} from './model.js';
import {addWarehouseRobots} from './warehouse-robots.js';
globalThis.document = {createElement: () => ({getContext: () => ({fillRect() {}, fillText() {}})})};

const run = (sim, seconds, until = () => false) => { for (let i = 0; i < seconds * 10 && !until(); i++) sim.update(.1); };
// Points of a robot's remaining path that are off the lanes; a route may leave them only to get onto them.
const offLanes = (sim, r) => r.path.slice(r.index).filter(p => !sim.router.onLanes(p)).length;

test('after a layout change, robots already on a trip get back onto the new lanes once they are laid', () => {
  const state = seed('small'), sim = addWarehouseRobots(new T.Scene(), () => state);
  run(sim, 10, () => sim.robots.some(r => r.home));
  run(sim, 60, () => sim.robots.filter(r => r.task && r.path.length > 10).length >= 6);
  const onTrip = sim.robots.filter(r => r.task && r.path.length > 10);
  assert.ok(onTrip.length >= 6, `${onTrip.length} robots on a trip`);
  // The layout editor replaces the rack list: the last rack goes, so the lane network is rebuilt.
  state.racks = state.racks.slice(0, -1);
  run(sim, 1);
  assert.ok(sim.networkPending, 'the network is being rebuilt');
  run(sim, 120, () => !sim.networkPending);
  assert.ok(!sim.networkPending, 'the network was rebuilt');
  const still = onTrip.filter(r => r.task && r.path.length > r.index + 10);
  assert.ok(still.length >= 3, `${still.length} of them are still on their trip`);
  for (const r of still) assert.ok(offLanes(sim, r) <= 4, `${r.id} has ${offLanes(sim, r)} path points off the lanes`);
});
