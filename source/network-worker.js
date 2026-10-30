import {createRouter} from './robot-routing.js';

// Builds the lane network off the main thread: the same router as the simulation's, the same inputs,
// and the result (edges + floor segments) posted back to be applied with router.setNetwork.
self.onmessage = e => {
  const {id, racks, obstacles, hubs, stops} = e.data, router = createRouter(racks, obstacles);
  const segments = router.buildNetwork(hubs, stops);
  self.postMessage({id, network: router.networkData(), segments});
};
