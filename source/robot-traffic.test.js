import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {seed} from './model.js';
import {addWarehouseRobots} from './warehouse-robots.js';
import {dockRect} from './docks.js';
globalThis.document = {createElement: () => ({getContext: () => ({fillRect() {}, fillText() {}})})};

const inside = (p, r, pad) => Math.abs(p.x - r.x) < r.width / 2 + pad && Math.abs(p.z - r.z) < r.depth / 2 + pad;

test('robots keep apart, stay out of racks and docks, and do not jam', () => {
  const state = seed(), sim = addWarehouseRobots(new T.Scene(), () => state);
  sim.update(.1);
  const obstacles = [...state.racks, ...state.docks.map(dockRect)];
  let closest = Infinity, longestWait = 0;
  const waiting = new Map();
  for (let i = 0; i < 10 * 60 * 10; i++) {
    sim.update(.1);
    const active = sim.robots.filter(r => r.active).map(r => r.g.position);
    for (let a = 0; a < active.length; a++) for (let b = a + 1; b < active.length; b++)
      closest = Math.min(closest, Math.hypot(active[a].x - active[b].x, active[a].z - active[b].z));
    for (const r of sim.robots.filter(r => r.active)) {
      const hit = obstacles.find(o => inside(r.g.position, o, .3));
      assert.equal(hit, undefined, `${r.id} drove into ${hit?.id || 'a dock'} at ${r.g.position.x.toFixed(1)}, ${r.g.position.z.toFixed(1)}`);
      const w = r.status === 'Waiting for traffic' ? (waiting.get(r.id) || 0) + .1 : 0;
      waiting.set(r.id, w); longestWait = Math.max(longestWait, w);
    }
  }
  assert.ok(closest >= 3.5, `robots came ${closest.toFixed(2)} m apart`);
  assert.ok(longestWait < 30, `a robot waited ${longestWait.toFixed(1)} s for traffic`);
  assert.ok(sim.flow.received > 10 && sim.flow.shipped > 10, 'traffic rules still let work flow');
});
