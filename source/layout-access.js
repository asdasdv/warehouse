import {createRouter} from './robot-routing.js';
const cache=new Map();
// Check the actual service point, never a nearby point across a blocked aisle.
export function inaccessibleRacks(racks){
 if(!racks.length)return new Set();const k=key(racks);if(cache.has(k))return cache.get(k);const router=createRouter(racks),reachable=router.reachableFrom({x:0,z:Math.max(...racks.map(r=>r.z+r.depth/2))+15});
 const result=new Set(racks.filter(r=>!reachable(router.port(r))).map(r=>r.id));if(cache.size>32)cache.delete(cache.keys().next().value);cache.set(k,result);return result;
}
const key=rs=>JSON.stringify(rs.map(r=>[r.id,r.x,r.z,r.width,r.depth,r.rotation||0]));
export function validateLayoutAccess(before,after){
 if(key(before)===key(after))return;
 const previouslyBlocked=inaccessibleRacks(before),blocked=inaccessibleRacks(after);
 const changed=new Set(after.filter(r=>{const old=before.find(o=>o.id===r.id);return !old||key([old])!==key([r]);}).map(r=>r.id));
 const newlyBlocked=[...blocked].filter(id=>changed.has(id)||!previouslyBlocked.has(id));
 if(newlyBlocked.length)throw Error('Robot access blocked: '+newlyBlocked.slice(0,5).join(', ')+'. Leave an open approach and a continuous aisle (6 m recommended for the current robot approach).');
}
