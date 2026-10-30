import {createRouter} from './robot-routing.js';
import {dockPort,dockRect,spineRects} from './docks.js';
const cache=new Map();
// Check the actual service point, never a nearby point across a blocked aisle.
// With docks the robots start from the first dock, and every other dock must be reachable too (reported by dock id).
export function inaccessibleRacks(racks,docks=[],spine=null){
 if(!racks.length&&!docks.length)return new Set();const k=key(racks)+JSON.stringify(docks.map(d=>[d.id,d.x,d.z,d.rotation||0]))+JSON.stringify(spine);if(cache.has(k))return cache.get(k);
 const router=createRouter(racks,[...docks.map(dockRect),...spineRects(spine)]),from=docks.length?dockPort(docks[0]):{x:0,z:Math.max(...racks.map(r=>r.z+r.depth/2))+15},reachable=router.reachableFrom(from);
 const result=new Set([...racks.filter(r=>!router.ports(r).some(reachable)).map(r=>r.id),...docks.filter(d=>!reachable(dockPort(d))).map(d=>d.id)]);if(cache.size>32)cache.delete(cache.keys().next().value);cache.set(k,result);return result;
}
const key=rs=>JSON.stringify(rs.map(r=>[r.id,r.x,r.z,r.width,r.depth,r.rotation||0]));
const dockKey=d=>JSON.stringify([d.x,d.z,d.rotation||0]);
export function validateLayoutAccess(before,after,docksBefore=[],docksAfter=docksBefore,spine=null){
 if(key(before)===key(after)&&JSON.stringify(docksBefore)===JSON.stringify(docksAfter))return;
 const previouslyBlocked=inaccessibleRacks(before,docksBefore,spine),blocked=inaccessibleRacks(after,docksAfter,spine);
 const changed=new Set([...after.filter(r=>{const old=before.find(o=>o.id===r.id);return !old||key([old])!==key([r]);}).map(r=>r.id),
  ...docksAfter.filter(d=>{const old=docksBefore.find(o=>o.id===d.id);return !old||dockKey(old)!==dockKey(d);}).map(d=>d.id)]);
 // A moved dock can also cut off racks that did not move: those show up as newly blocked.
 const newlyBlocked=[...blocked].filter(id=>changed.has(id)||!previouslyBlocked.has(id));
 if(newlyBlocked.length)throw Error('Robot access blocked: '+newlyBlocked.slice(0,5).join(', ')+'. Leave an open approach and a continuous aisle (6 m recommended for the current robot approach).');
}
// Live feedback while dragging: the robot-access check builds a router over the whole warehouse, far too slow to run
// on every pointermove. It runs once per snapped position (`key`, remembered until `reset`), at most once per `wait` ms; a position
// reached sooner is checked when the wait is over and reported through `onLate`. Until then `check` answers
// {pending: true} (treat as valid: the drop itself is always fully validated).
export function createAccessCheck(wait=100,{now=()=>performance.now(),later=setTimeout,cancel=clearTimeout}={}){
 const seen=new Map();let last=-Infinity,timer=null,queued=null;
 const run=(k,fn)=>{last=now();let result;try{fn();result={valid:true,why:''};}catch(e){result={valid:false,why:e.message};}seen.set(k,result);return result;};
 return {
  check(k,fn,onLate){
   if(seen.has(k))return seen.get(k);
   if(queued?.k===k){queued.fn=fn;queued.onLate=onLate;return {valid:true,why:'',pending:true};}
   const t=now();if(timer!==null){cancel(timer);timer=null;}
   if(t-last>=wait){queued=null;return run(k,fn);}
   queued={k,fn,onLate};timer=later(()=>{timer=null;const q=queued;queued=null;if(q){const r=run(q.k,q.fn);q.onLate?.(r,q.k);}},wait-(t-last));
   return {valid:true,why:'',pending:true};
  },
  reset(){if(timer!==null)cancel(timer);timer=null;queued=null;seen.clear();},
 };
}
