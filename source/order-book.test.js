import test from 'node:test';
import assert from 'node:assert/strict';
import {createOrderBook} from './order-book.js';
test('orders require matching stock and track staging separately from shipping',()=>{
 const book=createOrderBook(),normal=book.create('Motors',2),urgent=book.create('Motors',1,'Urgent');
 assert.equal(book.next({id:'B',product:'Cable'}),undefined);
 assert.equal(book.next({id:'B',product:'Motors'}),urgent);
 book.reserve(urgent,'B');assert.throws(()=>book.reserve(normal,'B'));
 book.stage('B');book.stage('B');assert.equal(urgent.staged.length,1);assert.equal(urgent.shipped.length,0);
 book.ship('B');book.ship('B');assert.equal(urgent.shipped.length,1);assert.equal(book.pending,2);
});
test('explicit box request cannot be consumed by a generic order',()=>{
 const book=createOrderBook();book.create('Motors',4,'Urgent');const specific=book.create('Motors',1,'Normal','B');
 assert.equal(book.next({id:'B',product:'Motors'}),specific);
 assert.throws(()=>book.create('Motors',0));assert.throws(()=>book.create('Motors',1.5));
});
