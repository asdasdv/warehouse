// Shared vertical layout for steelwork, cargo, labels and robot handoffs.
export function rackLevels(r){
 const base=Math.min(.35,.2+r.height*.02);
 return {base,gap:(r.height-base)/r.shelves};
}
export function shelfBase(r,index){const {base,gap}=rackLevels(r);return base+index*gap;}
