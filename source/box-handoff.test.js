import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {seed, products} from './model.js';
import {inventorySnapshot} from './inventory-page.js';
import {addWarehouseRobots} from './warehouse-robots.js';
globalThis.document = {createElement: () => ({getContext: () => ({fillRect() {}, fillText() {}})})};

const run = (sim, seconds) => { for (let i = 0; i < seconds * 10; i++) sim.update(.1); };
const ids = state => new Set(state.boxes.map(b => b.id));

test('the simulation keeps receiving, storing and shipping on its own', () => {
  const state = seed(), sim = addWarehouseRobots(new T.Scene(), () => state);
  const start = {received: state.today.received, shipped: state.today.shipped, onSite: sim.dashboard(state).onSite, time: new Date().toISOString()};
  for (let minute = 0; minute < 10; minute++) {
    run(sim, 60);
    const d = sim.dashboard(state);
    assert.equal(d.onSite, Object.values(d.counts).reduce((a, b) => a + b, 0));
    assert.equal(d.onSite, start.onSite + (state.today.received - start.received) - (state.today.shipped - start.shipped));
    assert.equal(inventorySnapshot(state, sim).boxes.length, d.onSite);
    assert.equal(ids(state).size, state.boxes.length, 'no box is on two shelves');
    assert.ok(sim.stations.every(s => s.queue.length <= 6));
  }
  assert.ok(sim.flow.received > 10, 'robots put boxes away');
  assert.ok(sim.flow.shipped > 10, 'orders keep shipping');
  assert.ok(sim.book.orders.length > 0, 'new orders keep arriving');
  const fresh = state.history.filter(e => e.time >= start.time);
  assert.ok(fresh.some(e => e.type === 'Put away') && fresh.some(e => e.type === 'Shipped'));
});

test('boxes leave the shelf on pickup and land at the drop pose', () => {
  const state = seed(), sim = addWarehouseRobots(new T.Scene(), () => state);
  let loads = 0, drops = 0;
  for (let i = 0; i < 2000; i++) {
    const before = sim.robots.map(r => ({r, stage: r.stage, task: r.task}));
    sim.update(.1);
    for (const {r, stage, task} of before) {
      if (r.task && r.stage === 'Loading' && r.timer > 0 && r.task.source) {
        loads++; assert.equal(state.boxes.includes(r.task.box), false); assert.equal(r.cargo.visible, true);
      }
      if (task?.target && stage === 'Unloading' && !r.task) {
        drops++; const b = state.boxes.find(b => b.id === task.box.id);
        assert.equal(b.rack, task.target.id); assert.equal(b.location, task.slot);
      }
    }
  }
  assert.ok(loads && drops);
});

test('Receive, Move and Ship from the UI become robot work', () => {
  const state = seed(), sim = addWarehouseRobots(new T.Scene(), () => state);
  sim.update(.1);
  const box = state.boxes.find(b => b.rack === state.racks[0].id), target = state.racks.at(-1);
  sim.requestMove(box.id, target.id);
  assert.equal(sim.boxInfo(box.id).status, 'Transfer queued');
  assert.throws(() => sim.requestMove(box.id, target.id), /busy/);
  const shipped = state.boxes.find(b => b.rack === state.racks[5].id);
  const order = sim.shipBox(shipped.id);
  sim.receive(products[4], 3, null);
  const before = state.serial;
  run(sim, 240);
  // Random demand may ship the box later, so check that the move itself happened.
  assert.ok(state.history.some(e => e.box === box.id && e.type === 'Moved' && e.to.startsWith(target.id)));
  assert.ok(order.shipped.includes(shipped.id));
  assert.equal(state.boxes.some(b => b.id === shipped.id), false);
  assert.ok(state.serial >= before + 3);
  assert.throws(() => sim.receive(products[4], 0), /1–48/);
});

test('layout changes re-plan robots instead of resetting the floor', () => {
  const state = seed(), sim = addWarehouseRobots(new T.Scene(), () => state);
  run(sim, 120);
  const delivered = sim.delivered, stock = sim.dashboard(state).onSite;
  for (const r of state.racks.filter(r => r.zone === 'H')) r.x += 2; // shift a zone's racks
  run(sim, 60);
  assert.ok(sim.delivered > delivered, 'work continues');
  assert.ok(Math.abs(sim.dashboard(state).onSite - stock) < 40, 'stock is not reset');
});
