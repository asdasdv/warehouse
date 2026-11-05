import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {flight, sample} from './camera-flight.js';

const V = (x, y, z) => new T.Vector3(x, y, z);

test('a flight starts where the camera is, lands exactly on the view asked for, and eases at both ends', () => {
  const f = flight(V(0, 50, 50), V(0, 0, 0), V(110, 20, 30), V(100, 0, 0), 0);
  const p = V(), t = V();
  sample(f, 0, p, t);
  assert.ok(p.distanceTo(V(0, 50, 50)) < 1e-6 && t.length() < 1e-6);
  const early = V(), late = V();
  sample(f, f.duration * .05, early, t); const startStep = t.length();
  sample(f, f.duration * .5, late, t); const midStep = t.length() - startStep;
  assert.ok(startStep < midStep / 10, 'slow start');
  assert.equal(sample(f, f.duration, p, t), true);
  assert.ok(p.distanceTo(V(110, 20, 30)) < 1e-6 && t.distanceTo(V(100, 0, 0)) < 1e-6);
});

test('long hops take longer than short ones, within bounds', () => {
  const near = flight(V(0, 20, 20), V(0, 0, 0), V(5, 20, 20), V(5, 0, 0), 0);
  const far = flight(V(0, 20, 20), V(0, 0, 0), V(900, 20, 20), V(900, 0, 0), 0);
  assert.ok(near.duration >= 600 && far.duration <= 1600 && far.duration > near.duration);
});

test('a tracked target is followed during the flight', () => {
  let robot = V(50, 0, 0);
  const f = flight(V(0, 30, 30), V(0, 0, 0), V(70, 30, 30), V(50, 0, 0), 0, () => robot);
  robot = V(80, 0, 0);
  const p = V(), t = V();
  sample(f, f.duration, p, t);
  assert.ok(t.distanceTo(V(80, 0, 0)) < 1e-6);
});
