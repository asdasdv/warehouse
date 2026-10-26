export function createOrderBook(){
 const orders=[];let serial=0;
 function create(product,quantity,priority='Normal',boxId=null){
  if(!product||!Number.isInteger(quantity)||quantity<1||quantity>100)throw Error('Choose a product and 1–100 boxes.');
  const o={id:`ORD-${++serial+1000}`,product,quantity,priority:priority==='Urgent'?'Urgent':'Normal',boxId,allocated:[],staged:[],shipped:[]};orders.push(o);return o;
 }
 function candidates(b){const specific=orders.find(o=>o.boxId===b.id);return orders.filter(o=>(!specific||o===specific)&&o.product===b.product&&(!o.boxId||o.boxId===b.id)&&o.allocated.length<o.quantity).sort((a,b)=>(b.priority==='Urgent')-(a.priority==='Urgent'));}
 return {orders,create,next:b=>candidates(b)[0],reserve(o,id){if(orders.some(x=>x.allocated.includes(id)))throw Error('Box already reserved.');if(o.allocated.length>=o.quantity)throw Error('Order fully allocated.');o.allocated.push(id);},stage(id){const o=orders.find(o=>o.allocated.includes(id));if(o&&!o.staged.includes(id))o.staged.push(id);},ship(id){const o=orders.find(o=>o.allocated.includes(id));if(o&&!o.shipped.includes(id))o.shipped.push(id);},forBox:id=>orders.find(o=>o.allocated.includes(id)||o.boxId===id),clear(){orders.length=0;},get pending(){return orders.reduce((n,o)=>n+o.quantity-o.allocated.length,0);}};
}
