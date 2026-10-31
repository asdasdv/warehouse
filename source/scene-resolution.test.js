import test from 'node:test';
import assert from 'node:assert/strict';
import {createResolutionGovernor} from './scene.js';

// Frames on a vsync clock: `slowEvery` frames in a row take `slowTicks` refresh intervals each.
const drive = (g, state, seconds, hz, pattern = () => 1) => { const tick = 1000 / hz; for (let i = 0, n = seconds * hz; i < n; i++) { state.t += tick * pattern(i); state.ratio = g.frame(state.t, state.ratio, 1.5); } return state.ratio; };

test('at 60 Hz the resolution drops on slow frames and comes back once frames keep up', () => {
  const g = createResolutionGovernor(), s = {t: 0, ratio: 1.5};
  drive(g, s, 4, 60);
  assert.equal(s.ratio, 1.5);
  drive(g, s, 6, 60, () => 2); // 30 fps
  assert.equal(s.ratio, 1);
  drive(g, s, 20, 60);
  assert.ok(Math.abs(g.refresh - 1000 / 60) < .5);
  assert.equal(s.ratio, 1.5);
});

test('at 120 Hz it needs frames near 8 ms to step up', () => {
  const g = createResolutionGovernor(), s = {t: 0, ratio: 1};
  drive(g, s, 2, 120);
  drive(g, s, 20, 120, i => i % 2 ? 2 : 1); // ~80 fps: not slow, not near the refresh
  assert.equal(s.ratio, 1);
  drive(g, s, 20, 120);
  assert.equal(s.ratio, 1.5);
});

test('a step up that makes frames slow again waits longer before the next try', () => {
  const g = createResolutionGovernor(), s = {t: 0, ratio: 1}; let ups = 0;
  // Fast at ratio 1, slow above it: the governor should not flip every few seconds.
  for (let i = 0; i < 60 * 120; i++) { const before = s.ratio; s.t += 1000 / 60 * (s.ratio > 1 ? 2 : 1); s.ratio = g.frame(s.t, s.ratio, 1.5); if (s.ratio > before) ups++; }
  assert.ok(ups <= 5, `stepped up ${ups} times in 2 minutes`);
});
