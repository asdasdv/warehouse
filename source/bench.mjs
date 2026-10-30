// Simulation benchmark without 3D: start-up time and time per frame.
// Usage: npm run bench -- small|large [simSeconds]
import * as T from 'three';
import {seed} from './model.js';
globalThis.document = {createElement: () => ({getContext: () => ({fillRect() {}, fillText() {}})})};
const {addWarehouseRobots} = await import('./warehouse-robots.js');
const size = process.argv[2] || 'small', secs = Number(process.argv[3] || 120);
const state = seed(size);
let t0 = performance.now();
const sim = addWarehouseRobots(new T.Scene(), () => state);
sim.update(.1);
const init = performance.now() - t0;
t0 = performance.now(); let worst = 0;
for (let i = 0; i < secs * 60; i++) { const a = performance.now(); sim.update(1 / 60); worst = Math.max(worst, performance.now() - a); }
const per = (performance.now() - t0) / (secs * 60);
const waiting = sim.robots.filter(r => r.active && r.status === 'Waiting for traffic').length;
console.log(JSON.stringify({size, racks: state.racks.length, boxes: state.boxes.length, robots: sim.robots.length, initMs: Math.round(init), frameMs: +per.toFixed(2), worstFrameMs: Math.round(worst), flow: sim.flow, waiting}));
