import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessCheck} from './layout-access.js';

function clock(){let t=0;const timers=[];return {now:()=>t,later:(fn,ms)=>{const h={at:t+ms,fn};timers.push(h);return h;},cancel:h=>{const i=timers.indexOf(h);if(i>=0)timers.splice(i,1);},
 advance(ms){t+=ms;for(const h of timers.filter(h=>h.at<=t)){timers.splice(timers.indexOf(h),1);h.fn();}},get pending(){return timers.length;}};}

test('drag access check runs once per snapped cell and at most every 100 ms',()=>{
 const c=clock(),check=createAccessCheck(100,c);let runs=0;const ok=()=>{runs++;},bad=()=>{runs++;throw Error('Robot access blocked: A');};
 assert.deepEqual(check.check('0,0',ok),{valid:true,why:''});assert.equal(runs,1);
 // Same cell again: cached, however often the pointer moves.
 for(let i=0;i<50;i++)check.check('0,0',ok);assert.equal(runs,1);
 // A new cell within 100 ms is deferred; later cells replace it, only the last one runs.
 c.advance(10);assert.equal(check.check('1,0',ok).pending,true);
 c.advance(10);let late=null;assert.equal(check.check('2,0',bad,(r,k)=>{late={r,k};}).pending,true);
 assert.equal(runs,1);c.advance(100);assert.equal(runs,2);
 assert.deepEqual(late,{r:{valid:false,why:'Robot access blocked: A'},k:'2,0'});
 assert.equal(check.check('2,0',bad).valid,false);assert.equal(runs,2);
 // After the wait a new cell is checked straight away.
 c.advance(200);assert.equal(check.check('3,0',ok).valid,true);assert.equal(runs,3);
 check.reset();c.advance(200);check.check('3,0',ok);assert.equal(runs,4);assert.equal(c.pending,0);
});
