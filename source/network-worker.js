import {createRouter} from './robot-routing.js';

// Builds the lane network off the main thread: the same router as the simulation's, the same inputs,
// and the result (edges + floor segments) posted back to be applied with router.setNetwork.
// A failure is posted back too, so the simulation can build the network itself instead.
self.onmessage = e => {
  const {id, racks, obstacles, area, hubs, stops} = e.data;
  try {
    const router = createRouter(racks, obstacles, area), segments = router.buildNetwork(hubs, stops);
    self.postMessage({id, network: router.networkData(), segments});
  } catch (err) { self.postMessage({id, error: String(err?.stack || err)}); }
};
