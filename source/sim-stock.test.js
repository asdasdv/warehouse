import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {seed, products} from './model.js';
import {addWarehouseRobots} from './warehouse-robots.js';
globalThis.document = {createElement: () => ({getContext: () => ({fillRect() {}, fillText() {}})})};

test('inStock agrees with boxInfo().actionable and is cheap over every product', () => {
  const state = seed('medium'), sim = addWarehouseRobots(new T.Scene(), () => state);
  for (let i = 0; i < 300; i++) sim.update(.1); // robots reserve and carry boxes
  const all = [...new Set(state.boxes.map(b => b.product))];
  for (const p of all.slice(0, 40)) assert.equal(sim.inStock(p), state.boxes.filter(b => b.product === p && sim.boxInfo(b.id)?.actionable).length, p);
  const t0 = performance.now(); for (const p of products) sim.inStock(p); const ms = performance.now() - t0;
  console.log(`inStock x${products.length}: ${ms.toFixed(1)} ms`); assert.ok(ms < 50, `inStock over ${products.length} products took ${ms.toFixed(1)} ms`);
});

test('a shipment card beyond the free stock waits for stock, not for a robot', () => {
  const state = seed(), sim = addWarehouseRobots(new T.Scene(), () => state);
  const product = [...new Set(state.boxes.map(b => b.product))].find(p => sim.inStock(p) >= 1), n = sim.inStock(product);
  const a = sim.ship(product, n), b = Object.assign(sim.book.create(product, 1, 'Normal'), {user: true});
  const cards = sim.tasks().filter(t => t.kind === 'Ship');
  assert.ok(cards.filter(t => t.id.startsWith(a.id + '#')).every(t => t.text !== 'Waiting for stock'));
  assert.equal(cards.find(t => t.id.startsWith(b.id + '#')).text, 'Waiting for stock');
});
