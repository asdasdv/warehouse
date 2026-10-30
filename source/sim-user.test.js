import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {seed} from './model.js';
import {CELL_CAPACITY} from './storage.js';
import {addWarehouseRobots} from './warehouse-robots.js';
globalThis.document = {createElement: () => ({getContext: () => ({fillRect() {}, fillText() {}})})};

const run = (sim, seconds, until = () => false) => { for (let i = 0; i < seconds * 10 && !until(); i++) sim.update(.1); };
const setup = () => { const state = seed(), sim = addWarehouseRobots(new T.Scene(), () => state); run(sim, 5, () => sim.robots.some(r => r.home)); return {state, sim}; };
const productWith = (state, sim, n) => [...new Set(state.boxes.map(b => b.product))].find(p => sim.inStock(p) >= n);

test('cancelling a shipment a robot has just taken cancels the trip, or refuses once the box is on board', () => {
  const {state, sim} = setup(), product = productWith(state, sim, 2);
  const a = sim.ship(product, 1), card = sim.tasks().find(t => t.id.startsWith(a.id + '#')).id;
  run(sim, 30, () => a.allocated.length);
  const r = sim.robots.find(r => r.task?.order === a);
  assert.equal(r.stage, 'To pickup');
  sim.cancelTask(card); // the card was drawn before the robot took the box
  assert.equal(r.task, null);
  assert.equal(sim.book.orders.includes(a), false);

  const b = sim.ship(product, 1), card2 = sim.tasks().find(t => t.id.startsWith(b.id + '#')).id;
  run(sim, 300, () => sim.robots.some(r => r.task?.order === b && r.stage === 'Transporting'));
  assert.throws(() => sim.cancelTask(card2), /The robot already has this box/);
  assert.ok(b.quantity >= b.allocated.length && b.quantity === 1);
  run(sim, 300, () => b.shipped.length);
  assert.equal(sim.orderStatus(b), 'Completed');
});

test('a shipment keeps to the chosen dispatch dock and waits for space there', () => {
  const {state, sim} = setup(), product = productWith(state, sim, 1);
  sim.stations.find(s => s.id === 'Dispatch 2').ready = false;
  const o = sim.ship(product, 1, 'Dispatch 2');
  run(sim, 30);
  assert.equal(o.allocated.length, 0);
  assert.ok(sim.tasks().some(t => t.kind === 'Ship' && t.text === 'Waiting for space at Dispatch 2'));
  sim.resolveIssue('Dispatch 2');
  const done = [];
  run(sim, 300, () => { done.push(...sim.takeFinished().filter(f => f.kind === 'Ship')); return done.length; });
  assert.deepEqual(done.map(f => f.place), ['Dispatch 2']);
});

test('cellRoom counts boxes in the cell and boxes robots are bringing', () => {
  const {state, sim} = setup();
  const b = state.boxes.find(b => state.boxes.filter(x => x.rack === b.rack && x.location === b.location).length === 1);
  const other = state.boxes.find(x => x.product !== b.product).product;
  assert.equal(sim.cellRoom(b.rack, b.location, b.product), CELL_CAPACITY - 1);
  assert.equal(sim.cellRoom(b.rack, b.location, other), 0);
  assert.equal(sim.cellRoom(b.rack, 'S99-P99', b.product), 0);
  run(sim, 120, () => sim.robots.some(r => r.task?.target));
  const t = sim.robots.find(r => r.task?.target).task;
  const here = state.boxes.filter(x => x.rack === t.target.id && x.location === t.slot).length;
  assert.ok(sim.cellRoom(t.target.id, t.slot, t.box.product) <= CELL_CAPACITY - here - 1, 'the cell a robot is bringing a box to has less room');
});

test('a receipt for a full cell goes to the nearest free cell on that rack', () => {
  const {state, sim} = setup();
  const count = (rack, loc) => state.boxes.filter(b => b.rack === rack && b.location === loc).length;
  const full = state.boxes.find(b => count(b.rack, b.location) === CELL_CAPACITY && state.boxes.filter(x => x.rack === b.rack).length < 40);
  sim.receive(full.product, 1, {rack: full.rack, loc: full.location});
  const done = [];
  run(sim, 400, () => { done.push(...sim.takeFinished()); return done.some(f => f.kind === 'Receive'); });
  const f = done.find(f => f.kind === 'Receive');
  assert.ok(f, 'the box was put away');
  assert.equal(done.some(f => f.kind === 'ReceiveRedirected'), false);
  assert.ok(f.place.startsWith(full.rack + ' · ') && f.place !== `${full.rack} · ${full.location}`, f.place);
  assert.equal(typeof f.box.id, 'string'); assert.match(f.robot, /^AMR-/);
  assert.equal(count(full.rack, full.location), CELL_CAPACITY);
});

test('a failing route worker falls back to building the network on the main thread', async () => {
  const warned = [], warn = console.warn;
  console.warn = (...a) => warned.push(a);
  globalThis.window = {};
  globalThis.Worker = class { postMessage() { setTimeout(() => this.onerror({message: 'worker crashed', preventDefault() {}}), 0); } terminate() {} };
  try {
    const state = seed(), sim = addWarehouseRobots(new T.Scene(), () => state);
    sim.update(.1);
    await new Promise(r => setTimeout(r, 10));
    run(sim, 30, () => sim.robots.some(r => r.home));
    assert.ok(sim.robots.some(r => r.home), 'the network was built anyway');
    run(sim, 60);
    assert.ok(sim.delivered > 0, 'robots keep working');
    assert.equal(warned.filter(a => /Route worker/.test(a[0])).length, 1);
  } finally { console.warn = warn; delete globalThis.window; delete globalThis.Worker; }
});
