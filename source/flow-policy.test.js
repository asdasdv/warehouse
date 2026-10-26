import test from 'node:test';
import assert from 'node:assert/strict';
import {flowPolicy} from './flow-policy.js';
test('empty storage favours receiving; full storage favours shipping',()=>{
 const low=flowPolicy(20,100,0),high=flowPolicy(90,100,0);
 assert.equal(low.mode,'Prioritize receiving');assert.ok(low.arrivalInterval<high.arrivalInterval);assert.ok(low.inboundShare>high.inboundShare);
 assert.equal(flowPolicy(99,100,0).acceptArrivals,false);
 assert.equal(flowPolicy(0,0,0).acceptArrivals,false);
});
test('hysteresis prevents switching modes near thresholds and queue recruits reserves',()=>{
 assert.equal(flowPolicy(80,100,0,'Prioritize shipping').mode,'Prioritize shipping');
 assert.equal(flowPolicy(70,100,0,'Prioritize shipping').mode,'Balanced');
 assert.equal(flowPolicy(55,100,0,'Prioritize receiving').mode,'Prioritize receiving');
 assert.equal(flowPolicy(65,100,0,'Prioritize receiving').mode,'Balanced');
 assert.equal(flowPolicy(60,100,10).fleetTarget,8);
 assert.equal(flowPolicy(60,100,6).fleetTarget,6);
 assert.equal(flowPolicy(60,100,0).fleetTarget,4);
});
